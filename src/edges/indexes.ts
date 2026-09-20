/** Single bounded request; no discovery, reference reads, or implicit destination. */
import { constants } from 'node:fs';
import { open, lstat, realpath, link, unlink } from 'node:fs/promises';
import { dirname, join, parse, resolve, sep } from 'node:path';
import { z } from 'zod';
import { INDEX_LIMITS, IndexError, IndexStore, GenerateIndexSchema, IndexScopeSchema,
  ImportIndexSchema, parseIndexInput, parseIndexJson } from '../state/indexes';

const pathSchema = z.string().min(1).max(4096).refine(value => !/[\u0000-\u001f]/.test(value) &&
  !value.startsWith(':') && !value.startsWith('file:') && !value.startsWith('~'));
export const IndexRequestSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('import'), database: pathSchema, batch: ImportIndexSchema }),
  z.strictObject({ action: z.literal('generate'), database: pathSchema, output: pathSchema, options: GenerateIndexSchema }),
  z.strictObject({ action: z.literal('check'), database: pathSchema, scope: IndexScopeSchema }),
]);
const checkTime = (deadline: number) => { if (performance.now() >= deadline) throw new IndexError('timeout'); };
const pathKey = (value: string) => process.platform === 'win32'
  ? resolve(value).replace(/^\\\\\?\\/, '').replaceAll('\\', '/').toLowerCase()
  : resolve(value);
const samePath = (left: string, right: string) => pathKey(left) === pathKey(right);

async function explicitParent(parent: string, code: 'database-parent-alias' | 'output-parent-alias'): Promise<void> {
  if (process.platform !== 'win32') {
    if (!samePath(await realpath(parent), parent)) throw new IndexError(code);
    return;
  }
  // Windows realpath may return a namespaced or canonicalized path even when
  // no alias exists. Inspect every existing component without following a
  // reparse-point symlink instead of comparing path spellings.
  let current = parse(parent).root;
  for (const part of parent.slice(current.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new IndexError(code);
  }
}

async function readRequest(path: string, deadline: number): Promise<string> {
  if (path !== '-') {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > INDEX_LIMITS.requestBytes) throw new IndexError('input-file-limit');
      const buffer = Buffer.alloc(INDEX_LIMITS.requestBytes + 1);
      let total = 0;
      while (total < buffer.length) {
        checkTime(deadline);
        const part = await file.read(buffer, total, buffer.length - total, null);
        if (!part.bytesRead) break;
        total += part.bytesRead;
      }
      if (total > INDEX_LIMITS.requestBytes) throw new IndexError('input-bytes');
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, total));
    } finally { await file.close(); }
  }
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const timer = setTimeout(() => { void reader.cancel(); }, Math.max(1, deadline - performance.now()));
  try {
    while (true) {
      const part = await reader.read();
      checkTime(deadline);
      if (part.done) break;
      total += part.value.length;
      if (total > INDEX_LIMITS.requestBytes) throw new IndexError('input-bytes');
      chunks.push(part.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { clearTimeout(timer); await reader.cancel(); reader.releaseLock(); }
}

async function explicitDatabase(path: string): Promise<string> {
  const absolute = resolve(path);
  await explicitParent(dirname(absolute), 'database-parent-alias');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try {
      const stat = await lstat(absolute + suffix);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new IndexError('database-alias');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return absolute;
}

/** Atomic create-only publication: a complete temporary inode is linked without replacement. */
async function publish(path: string, markdown: string, deadline: number): Promise<void> {
  const absolute = resolve(path), parent = dirname(absolute);
  await explicitParent(parent, 'output-parent-alias');
  const temporary = join(parent, `.aos-index-${crypto.randomUUID()}.tmp`);
  const file = await open(temporary, 'wx', 0o600);
  try {
    await file.writeFile(markdown, 'utf8');
    await file.sync();
    checkTime(deadline);
    try { await link(temporary, absolute); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new IndexError('output-exists');
      throw error;
    }
  } finally { await file.close(); await unlink(temporary); }
}

export async function main(args: string[]): Promise<number> {
  let store: IndexStore | undefined;
  try {
    if ((args.length !== 2 && args.length !== 4) || args[0] !== '--request' ||
        (args.length === 4 && args[2] !== '--timeout-ms')) throw new IndexError('usage');
    const timeout = args.length === 4 ? Number(args[3]) : INDEX_LIMITS.timeoutMs;
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000) throw new IndexError('timeout-limit');
    const deadline = performance.now() + timeout;
    const request = parseIndexInput(IndexRequestSchema, parseIndexJson(await readRequest(args[1]!, deadline)));
    checkTime(deadline);
    const database = await explicitDatabase(request.database);
    checkTime(deadline);
    store = new IndexStore(database, request.action === 'import' ? 'write' : 'read');
    let result: object, code = 0;
    if (request.action === 'import') {
      result = { schema: 'aos.index-cli/v1', status: 'complete', action: 'import', ...store.import(request.batch, deadline) };
    } else {
      const report = request.action === 'generate' ? store.generate(request.options) : store.check(request.scope);
      checkTime(deadline);
      if (request.action === 'generate' && report.artifact) await publish(request.output, report.artifact.markdown, deadline);
      const { artifact, ...metadata } = report;
      result = { ...metadata, action: request.action,
        artifact: artifact ? { digest: artifact.digest, bytes: artifact.bytes, maxLineBytes: artifact.maxLineBytes } : null };
      if (report.status !== 'complete') {
        code = 1;
        await Bun.stderr.write(`Index incomplete: ${report.reason}.\n`);
      }
    }
    const frame = JSON.stringify(result) + '\n';
    if (Buffer.byteLength(frame) > INDEX_LIMITS.frameBytes) throw new IndexError('frame-limit');
    await Bun.stdout.write(frame);
    return code;
  } catch (error) {
    const reason = error instanceof IndexError ? error.code : 'io-or-state-error';
    await Bun.stderr.write(`Index refused: ${reason}. Usage: --request <file|-> [--timeout-ms 1..10000].\n`);
    await Bun.stdout.write(JSON.stringify({ schema: 'aos.index-cli/v1', status: 'incomplete', reason, artifact: null }) + '\n');
    return 1;
  } finally { store?.close(); }
}
if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
