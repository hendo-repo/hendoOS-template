#!/usr/bin/env bun
/** Permanent source-checkout fallback. Explicit paths only; never changes live homes. */
import { RuntimeService, MAX_INPUT_BYTES } from '../protocols/service';
import { StateStore } from '../state/store';
import { loadContent, readBoundedFile } from './content';
import { serve } from './mcp';
const HELP = `AOS provisional shadow runtime
Usage: bun src/edges/cli.ts COMMAND --state PATH --content ROOT [options]
Commands: orient, gate, closeout, reference, receipts, serve
orient/gate/reference: one strict operation JSON on stdin, or --request FILE.
receipts: --owner ID --session ID [--limit 1..100].
serve: MCP 2025-06-18 stdio, newline JSON-RPC; initialize then notifications/initialized.
Options: --source-revision COMMIT (required); --config FILE (owner JSON policy); --input-timeout-ms 1..30000 (default 5000).
--help needs no state or content. Paths must be explicit. No ambient config is read.
Output is JSON; diagnostics go to stderr. PROVISIONAL: never live enforcement.
Exit 0 = completed operation (allow OR deny); exit 1 = invalid/incomplete/unavailable.
`;
async function readInput(timeout: number): Promise<string> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel(); }, timeout);
  try {
    while (true) {
      const chunk = await reader.read();
      if (expired) throw new Error('input deadline exceeded');
      if (chunk.done) break;
      bytes += chunk.value.length;
      if (bytes > MAX_INPUT_BYTES) throw new Error('input limit exceeded');
      chunks.push(chunk.value);
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
  } finally { clearTimeout(timer); await reader.cancel(); reader.releaseLock(); }
}
export async function main(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--help') { await Bun.stdout.write(HELP); return 0; }
  let store: StateStore | undefined;
  const serving = args[0] === 'serve';
  try {
    const command = args[0];
    if (!command || !['orient', 'gate', 'closeout', 'reference', 'receipts', 'serve'].includes(command)) throw new Error('invalid command');
    const flags = new Map<string, string>();
    const accepted = new Set(['--state', '--content', '--source-revision', '--config', '--request', '--owner', '--session', '--limit', '--input-timeout-ms']);
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i]!; const value = args[i + 1];
      if (!accepted.has(key) || !value || value.startsWith('--') || flags.has(key)) throw new Error('invalid options');
      flags.set(key, value);
    }
    if (!flags.get('--state') || !flags.get('--content') || !/^[a-f0-9]{40}$/.test(flags.get('--source-revision') ?? '')) throw new Error('explicit state, content and exact source revision required');
    const specific = command === 'receipts' ? ['--owner', '--session', '--limit'] : command === 'serve' ? [] : ['--request', '--input-timeout-ms'];
    for (const key of flags.keys()) if (!['--state', '--content', '--source-revision', '--config', ...specific].includes(key)) throw new Error('option not valid for command');
    const content = await loadContent(flags.get('--content')!);
    const config = flags.has('--config') ? JSON.parse(await readBoundedFile(flags.get('--config')!)) : undefined;
    store = new StateStore(flags.get('--state')!);
    const service = new RuntimeService({ state: store, content, sourceRevision: flags.get('--source-revision')!, config });
    if (command === 'serve') return await serve(service);
    if (command === 'receipts') {
      const owner = flags.get('--owner'); const session = flags.get('--session');
      if (!owner || !session || owner.length > 128 || session.length > 128) throw new Error('explicit owner and session required');
      await Bun.stdout.write(JSON.stringify({ receipts: store.receipts(owner, session, Number(flags.get('--limit') ?? 100)) }) + '\n');
      return 0;
    }
    const timeout = Number(flags.get('--input-timeout-ms') ?? 5000);
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000) throw new Error('invalid input timeout');
    const text = flags.has('--request') ? await readBoundedFile(flags.get('--request')!, MAX_INPUT_BYTES) : await readInput(timeout);
    const input = JSON.parse(text) as unknown;
    if (!input || typeof input !== 'object' || (input as { command?: string }).command !== command) throw new Error('command/envelope mismatch');
    const result = await service.execute(input);
    await Bun.stdout.write(JSON.stringify(result) + '\n');
    return result.status === 'complete' ? 0 : 1;
  } catch {
    await Bun.stderr.write('AOS request failed: invalid input, configuration, content or unavailable runtime.\n');
    await Bun.stdout.write(JSON.stringify(serving ? { jsonrpc: '2.0', id: null, error: { code: -32603, message: 'Runtime unavailable' } }
      : { error: { code: 'runtime-unavailable', message: 'Invalid input, configuration, content or unavailable runtime' }, provisional: true, enforcement: false }) + '\n');
    return 1;
  } finally { store?.close(); }
}
if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
