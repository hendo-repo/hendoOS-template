/** Stage an isolated Codex hook delivery; the lifecycle installer owns target mutation. */
import { constants } from 'node:fs';
import { access, lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { CodexHookConfigSchema, CODEX_HARNESS_PROTOCOL, codexHookReply, codexRegistration } from '../protocols/codex-harness';
import { AbsolutePathSchema } from '../protocols/harness';
import { InstallManifestSchema, type InstallManifest, type InstallOutputEntry } from '../schema/install';
import { readFileDigest, validateRoots } from './paths';

const OptionsSchema = z.strictObject({
  sourceRoot: AbsolutePathSchema, stageRoot: AbsolutePathSchema, targetRoot: AbsolutePathSchema, bunPath: AbsolutePathSchema,
  owner: z.string().min(1).max(128), generation: z.int().positive(), config: CodexHookConfigSchema,
});
export type CodexRenderOptions = z.input<typeof OptionsSchema>;
export type RenderedCodexHarness = { sourceRoot: string; stageRoot: string; targetRoot: string; owner: string;
  manifest: InstallManifest; modes: Record<string, number>; shimPath: string; configPath: string };
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const sha = (value: string | Uint8Array) => `sha256:${new Bun.CryptoHasher('sha256').update(value).digest('hex')}`;
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const commandOf = (value: unknown) => isRecord(value) && Array.isArray(value.hooks) && value.hooks.length === 1 &&
  isRecord(value.hooks[0]) && typeof value.hooks[0].command === 'string' ? value.hooks[0].command : undefined;

async function mergeHooks(path: string, command: string): Promise<{ bytes: string; baseDigest: string | null; itemDigest: string }> {
  let base: Record<string, unknown> = {}, baseDigest: string | null = null;
  try {
    const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 256 * 1024) throw new Error();
    const bytes = await readFile(path); baseDigest = sha(bytes); const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (!isRecord(parsed)) throw new Error(); base = parsed;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('existing hooks cannot be safely merged'); }
  const hooks = base.hooks === undefined ? {} : isRecord(base.hooks) ? { ...base.hooks } : (() => { throw new Error('invalid hooks root'); })();
  const current = hooks.PreToolUse === undefined ? [] : Array.isArray(hooks.PreToolUse) ? [...hooks.PreToolUse] : (() => { throw new Error('invalid PreToolUse list'); })();
  const matches = current.map((value, index) => ({ value, index })).filter(({ value }) => commandOf(value) === command);
  if (matches.length > 1) throw new Error('duplicate managed hook'); if (matches.length === 1) current.splice(matches[0]!.index, 1);
  const item = codexRegistration(command).hooks.PreToolUse[0]!; current.push(item); hooks.PreToolUse = current;
  return { bytes: JSON.stringify({ ...base, description: typeof base.description === 'string' ? base.description : 'Codex hooks', hooks }, null, 2) + '\n',
    baseDigest, itemDigest: sha(JSON.stringify(item)) };
}
async function digest(root: string, path: string) { const result = await readFileDigest(root, path); if (!result.ok) throw new Error('asset unavailable'); return result.value; }
async function inventory(root: string, dir: string): Promise<string[]> {
  const out: string[] = []; for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`; if (entry.isDirectory()) out.push(...await inventory(root, path)); else if (entry.isFile()) out.push(path); else throw new Error('source links refused');
  } return out.sort();
}

export async function renderCodexHarness(input: CodexRenderOptions): Promise<RenderedCodexHarness> {
  const o = OptionsSchema.parse(input); if (process.platform === 'win32') throw new Error('POSIX shim required');
  for (const [a, b] of [[o.sourceRoot, o.stageRoot], [o.sourceRoot, o.targetRoot], [o.stageRoot, o.targetRoot]])
    if (!(await validateRoots(a!, b!)).ok) throw new Error('roots must be existing, disjoint, and unaliased');
  if ((await readdir(o.stageRoot)).length) throw new Error('stage must be empty');
  const bunPath = await realpath(o.bunPath); await access(bunPath, constants.X_OK);
  const configPath = join(o.targetRoot, 'hendoos-codex-hook/config.json'), shimPath = join(o.targetRoot, 'hendoos-codex-hook/run');
  const bundlePath = join(o.targetRoot, 'hendoos-codex-hook/hook.js'), launchPath = join(o.targetRoot, 'hendoos-codex-hook/launch.js');
  const hooks = await mergeHooks(join(o.targetRoot, 'hooks.json'), shimPath);
  const build = await Bun.build({ entrypoints: [join(o.sourceRoot, 'src/edges/codex-hook.ts')], target: 'bun', format: 'esm', packages: 'bundle', minify: true });
  if (!build.success || build.outputs.length !== 1) throw new Error('codex hook bundle failed');
  const fallback = codexHookReply();
  const shim = `#!/bin/sh\nif [ ! -x ${quote(bunPath)} ] || [ ! -r ${quote(bundlePath)} ] || [ ! -r ${quote(launchPath)} ] || [ ! -r ${quote(configPath)} ]; then\n  printf '%s' ${quote(fallback.stdout)}\n  printf '%s\\n' 'hendoOS Codex hook unavailable; no decision emitted.' >&2\n  exit 1\nfi\nexec ${quote(bunPath)} ${quote(launchPath)} --config ${quote(configPath)}\n`;
  const launch = `try { const { main } = await import('./hook.js'); process.exitCode = await main(Bun.argv.slice(2)); } catch { await Bun.stdout.write(${JSON.stringify(fallback.stdout)}); await Bun.stderr.write('hendoOS Codex hook unavailable; no decision emitted.\\n'); process.exitCode = 1; }\n`;
  const files = new Map<string, string>([['hooks.json', hooks.bytes], ['hendoos-codex-hook/run', shim],
    ['hendoos-codex-hook/hook.js', await build.outputs[0]!.text()], ['hendoos-codex-hook/launch.js', launch],
    ['hendoos-codex-hook/config.json', JSON.stringify(o.config, null, 2) + '\n'],
    ['hendoos-codex-hook/LICENSE', await readFile(join(o.sourceRoot, 'LICENSE'), 'utf8')],
    ['hendoos-codex-hook/NOTICE', await readFile(join(o.sourceRoot, 'NOTICE'), 'utf8')]]);
  const sourcePaths = [...await inventory(o.sourceRoot, 'src'), ...await inventory(o.sourceRoot, 'node_modules/zod'), 'package.json', 'bun.lock', 'LICENSE', 'NOTICE'];
  const sources = await Promise.all(sourcePaths.map(async path => ({ path, digest: await digest(o.sourceRoot, path) })));
  const modes: Record<string, number> = {};
  for (const [path, body] of files) { const destination = join(o.stageRoot, path); await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, body, { flag: 'wx', mode: 0o600 }); modes[path] = path.endsWith('/run') ? 0o755 : 0o600; }
  for (const source of sources) if (await digest(o.sourceRoot, source.path) !== source.digest) throw new Error('source changed during render');
  const outputs: InstallOutputEntry[] = await Promise.all([...files.keys()].map(async path => path === 'hooks.json'
    ? { path, digest: await digest(o.stageRoot, path), ownership: 'managed-json-item' as const, baseDigest: hooks.baseDigest,
      jsonPath: ['hooks', 'PreToolUse'], itemDigest: hooks.itemDigest }
    : { path, digest: await digest(o.stageRoot, path), ownership: 'framework-file' as const }));
  const manifest = InstallManifestSchema.parse({ schemaVersion: 1, owner: o.owner, generation: o.generation,
    harness: CODEX_HARNESS_PROTOCOL, sourceRevision: o.config.sourceRevision, sources, outputs });
  return { sourceRoot: o.sourceRoot, stageRoot: o.stageRoot, targetRoot: o.targetRoot, owner: o.owner, manifest, modes, shimPath, configPath };
}
