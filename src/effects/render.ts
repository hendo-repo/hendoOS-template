/** Stage an isolated, self-contained delivery. The installer alone writes target artifacts. */
import { lstat, mkdir, readdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { AbsolutePathSchema, HARNESS_PROTOCOL, REGISTRATION_PATH, HookConfigSchema,
  registration, hookReply } from '../protocols/harness';
import { JsonValueSchema } from '../protocols/validation';
import { InstallManifestSchema, type InstallManifest, type InstallOutputEntry } from '../schema/install';
import { readFileDigest, validateRoots } from './paths';
import { loadContent, readBoundedFile } from '../edges/content';

const OptionsSchema = z.strictObject({
  sourceRoot: AbsolutePathSchema, stageRoot: AbsolutePathSchema, targetRoot: AbsolutePathSchema,
  statePath: AbsolutePathSchema, bunPath: AbsolutePathSchema,
  owner: z.string().min(1).max(128), generation: z.int().positive(),
  config: HookConfigSchema.omit({ statePath: true, contentRoot: true, ownerId: true }),
});
export type RenderOptions = z.input<typeof OptionsSchema>;
export interface RenderedHarness {
  sourceRoot: string; stageRoot: string; targetRoot: string; owner: string;
  manifest: InstallManifest; modes: Record<string, number>;
  bunPath: string; shimPath: string; configPath: string;
}
function quote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }
const MAX_SETTINGS_BYTES = 256 * 1024;
const managedPath = ['hooks', 'PreToolUse'] as const;
function sha(bytes: string | Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}
function commandOf(value: unknown): string | undefined {
  if (!isRecord(value) || !Array.isArray(value.hooks) || value.hooks.length !== 1) return undefined;
  const hook = value.hooks[0];
  return isRecord(hook) && typeof hook.command === 'string' ? hook.command : undefined;
}
async function mergeRegistration(path: string, shimPath: string): Promise<{
  bytes: string; baseDigest: string | null; itemDigest: string;
}> {
  let base: Record<string, unknown> = {};
  let baseDigest: string | null = null;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_SETTINGS_BYTES) {
      throw new Error('settings must be a bounded unaliased regular file');
    }
    const bytes = await readFile(path);
    baseDigest = sha(bytes);
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isRecord(parsed)) throw new Error('settings root must be an object');
    base = parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('existing settings cannot be safely merged');
  }
  const hooksValue = base.hooks;
  if (hooksValue !== undefined && !isRecord(hooksValue)) throw new Error('existing settings hooks must be an object');
  const hooks = hooksValue === undefined ? {} : { ...hooksValue };
  const listValue = hooks.PreToolUse;
  if (listValue !== undefined && !Array.isArray(listValue)) throw new Error('existing PreToolUse hooks must be an array');
  const list = listValue === undefined ? [] : [...listValue];
  const matching = list.map((value, index) => ({ value, index })).filter(({ value }) => commandOf(value) === shimPath);
  if (matching.length > 1) throw new Error('duplicate managed registration conflict');
  if (matching.length === 1) list.splice(matching[0]!.index, 1);
  const item = registration(shimPath).hooks.PreToolUse[0]!;
  list.push(item);
  hooks.PreToolUse = list;
  const merged = { ...base, hooks };
  return { bytes: JSON.stringify(merged, null, 2) + '\n', baseDigest, itemDigest: sha(JSON.stringify(item)) };
}
async function digest(root: string, path: string): Promise<string> {
  const result = await readFileDigest(root, path);
  if (!result.ok) throw new Error('source or staged asset unavailable');
  return result.value;
}
async function inventory(root: string, dir: string): Promise<string[]> {
  const result: string[] = [];
  const stat = await lstat(join(root, dir));
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid source directory');
  for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) result.push(...await inventory(root, path));
    else if (entry.isFile()) result.push(path);
    else throw new Error('source links refused');
  }
  return result.sort();
}
export async function renderHarness(input: RenderOptions): Promise<RenderedHarness> {
  JsonValueSchema.parse(input);
  const o = OptionsSchema.parse(input);
  if (process.platform === 'win32') throw new Error('POSIX shim required');
  const roots = [o.sourceRoot, o.stageRoot, o.targetRoot, dirname(o.statePath)];
  for (let a = 0; a < roots.length; a++) for (let b = a + 1; b < roots.length; b++) {
    if (!(await validateRoots(roots[a]!, roots[b]!)).ok) throw new Error('roots must be existing, disjoint, and unaliased');
  }
  if ((await readdir(o.stageRoot)).length) throw new Error('stage must be empty');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { const s = await lstat(o.statePath + suffix); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error('state alias'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const bunPath = await realpath(o.bunPath);
  AbsolutePathSchema.parse(bunPath);
  if (!(await lstat(bunPath)).isFile()) throw new Error('runtime must be a file');
  await access(bunPath, constants.X_OK);
  // Resolve explicitly supplied Bun; never consult PATH or a home directory.
  const probe = Bun.spawn([bunPath, '--version'], { env: { PATH: '' }, stdin: 'ignore', stdout: 'pipe', stderr: 'ignore' });
  const probeTimer = setTimeout(() => probe.kill(), 2000);
  const probeReader = probe.stdout.getReader();
  try {
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    while (true) {
      const part = await probeReader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 128) throw new Error('runtime version output limit');
      chunks.push(part.value);
    }
    const version = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    if (await probe.exited !== 0 || version.trim() !== Bun.version) throw new Error('runtime version differs from renderer');
  } finally { clearTimeout(probeTimer); probe.kill(); await probeReader.cancel(); probeReader.releaseLock(); await probe.exited; }
  const content = await loadContent(join(o.sourceRoot, 'content'));
  if (content.generation !== o.config.contentGeneration) throw new Error('content generation mismatch');
  const configPath = join(o.targetRoot, 'aos-hook/config.json');
  const shimPath = join(o.targetRoot, 'aos-hook/run');
  const bundlePath = join(o.targetRoot, 'aos-hook/hook.js');
  const launchPath = join(o.targetRoot, 'aos-hook/launch.js');
  const config = HookConfigSchema.parse({ ...o.config, ownerId: o.owner,
    statePath: o.statePath, contentRoot: join(o.targetRoot, 'aos-hook/content') });
  const settings = await mergeRegistration(join(o.targetRoot, REGISTRATION_PATH), shimPath);
  const sourcePaths = [...await inventory(o.sourceRoot, 'src'),
    ...await inventory(o.sourceRoot, 'content'), ...await inventory(o.sourceRoot, 'node_modules/zod'),
    'package.json', 'bun.lock', 'LICENSE', 'NOTICE'];
  const sources = await Promise.all(sourcePaths.map(async path => ({ path, digest: await digest(o.sourceRoot, path) })));
  const build = await Bun.build({ entrypoints: [join(o.sourceRoot, 'src/edges/hook.ts')],
    target: 'bun', format: 'esm', packages: 'bundle', sourcemap: 'none', minify: true });
  if (!build.success || build.outputs.length !== 1) throw new Error('hook bundle failed');
  const failure = hookReply();
  // Only shell builtins, then exec an absolute executable. No shell core logic.
  const shim = `#!/bin/sh\nif [ ! -x ${quote(bunPath)} ] || [ ! -r ${quote(bundlePath)} ] || [ ! -r ${quote(launchPath)} ] || [ ! -r ${quote(configPath)} ]; then\n  printf '%s' ${quote(failure.stdout)}\n  printf '%s\\n' 'AOS shadow assets unavailable; no decision emitted.' >&2\n  exit ${failure.exitCode}\nfi\nexec ${quote(bunPath)} ${quote(launchPath)} --config ${quote(configPath)}\n`;
  // Catch module-load failure before the edge can establish its own boundary.
  const launch = `try {\n  const { main } = await import('./hook.js');\n  process.exitCode = await main(Bun.argv.slice(2));\n} catch {\n  await Bun.stdout.write(${JSON.stringify(failure.stdout)});\n  await Bun.stderr.write('AOS shadow module unavailable; no decision emitted.\\n');\n  process.exitCode = ${failure.exitCode};\n}\n`;
  const files = new Map<string, string>([
    [REGISTRATION_PATH, settings.bytes],
    ['aos-hook/run', shim], ['aos-hook/hook.js', await build.outputs[0]!.text()],
    ['aos-hook/launch.js', launch],
    ['aos-hook/config.json', JSON.stringify(config, null, 2) + '\n'],
    ['aos-hook/LICENSE', await readBoundedFile(join(o.sourceRoot, 'LICENSE'))],
    ['aos-hook/NOTICE', await readBoundedFile(join(o.sourceRoot, 'NOTICE'))],
    ['aos-hook/dependency-LICENSE', await readBoundedFile(join(o.sourceRoot, 'node_modules/zod/LICENSE'))],
  ]);
  // Installed content is independent of the checkout and dependency tree.
  for (const path of sourcePaths.filter(p => /^content\/(membership\.manifest\.json|(?:kernel|reference)\/[^/]+\.md)$/.test(p))) {
    files.set(`aos-hook/${path}`, await readBoundedFile(join(o.sourceRoot, path)));
  }
  for (const source of sources) if (await digest(o.sourceRoot, source.path) !== source.digest) throw new Error('source changed during render');
  const modes: Record<string, number> = {};
  for (const [path, bytes] of files) {
    const destination = join(o.stageRoot, path);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    modes[path] = path === 'aos-hook/run' ? 0o755 : 0o600;
  }
  // Validate actual staged content before handing the manifest to the installer.
  await loadContent(join(o.stageRoot, 'aos-hook/content'));
  const outputs: InstallOutputEntry[] = await Promise.all([...files.keys()].map(async path => path === REGISTRATION_PATH
    ? { path, digest: await digest(o.stageRoot, path), ownership: 'managed-json-item' as const,
      baseDigest: settings.baseDigest, jsonPath: [...managedPath], itemDigest: settings.itemDigest }
    : { path, digest: await digest(o.stageRoot, path), ownership: 'framework-file' as const }));
  const manifest = InstallManifestSchema.parse({ schemaVersion: 1, owner: o.owner, generation: o.generation,
    harness: HARNESS_PROTOCOL, sourceRevision: o.config.sourceRevision, sources, outputs });
  return { sourceRoot: o.sourceRoot, stageRoot: o.stageRoot, targetRoot: o.targetRoot, owner: o.owner,
    manifest, modes, bunPath, shimPath, configPath };
}
