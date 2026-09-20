import { afterEach, expect, test as bunTest } from 'bun:test';
import { chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HARNESS_PROTOCOL, HookConfigSchema, nativeOperation, registration, hookReply } from '../src/protocols/harness';
import { renderHarness, type RenderOptions } from '../src/effects/render';
import { install, uninstall } from '../src/effects/install';
import { install as installWithFaults, uninstall as uninstallWithFaults,
  recoverInstall as recoverWithFaults } from '../src/effects/install-testing';
import { StateStore } from '../src/state/store';
import { RuntimeService, DEFAULT_CONFIG } from '../src/protocols/service';
import { loadContent } from '../src/edges/content';

// The native adapter renders a POSIX shim and is intentionally unsupported on Windows.
const test = process.platform === 'win32' ? bunTest.skip : bunTest;

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sourceRoot = await realpath(resolve('.'));
const bunPath = await realpath(process.execPath);
const sourceRevision = 'a'.repeat(40);
const facts = [{ key: 'verification', availability: 'available' as const, freshness: 'fresh' as const,
  completeness: 'complete' as const, result: 'present' as const, reasons: [], value: true }];
const config = { version: 1 as const, protocol: HARNESS_PROTOCOL as typeof HARNESS_PROTOCOL, schemaVersion: 1 as const,
  composeVersion: 1 as const, contentGeneration: 4, configRevision: 'aos-runtime-default/1',
  checkerRevision: 'aos-policy/1' as const, sourceRevision, timeoutMs: 5000, syntheticObservations: facts };
const event = { hook_event_name: 'PreToolUse', session_id: 'test-session', tool_use_id: 'test-call',
  transcript_path: '/unused/transcript.jsonl', cwd: '/unused/project', tool_name: 'Edit',
  tool_input: { file_path: '/unused/project/file.ts', old_string: 'old', new_string: 'new' } };
async function setup() {
  const base = await mkdtemp(join(await realpath(tmpdir()), "aos hook '$() ` ; "));
  roots.push(base);
  const stageRoot = join(base, 'stage'); const targetRoot = join(base, 'home'); const stateRoot = join(base, 'state');
  await Promise.all([mkdir(stageRoot), mkdir(targetRoot), mkdir(stateRoot)]);
  const options: RenderOptions = { sourceRoot, stageRoot, targetRoot, statePath: join(stateRoot, 'runtime.sqlite'),
    bunPath, owner: 'test-owner', generation: 1, config };
  return { base, options };
}
async function run(command: string[], text: string | Uint8Array, cwd: string) {
  const child = Bun.spawn(command, { cwd, env: { PATH: '', HOME: cwd },
    stdin: typeof text === 'string' ? new TextEncoder().encode(text) : text, stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code, json: JSON.parse(stdout) };
  } finally { clearTimeout(timer); }
}
async function direct(extra: Record<string, unknown> = {}) {
  const f = await setup();
  const path = join(f.options.targetRoot, 'config.json');
  await writeFile(path, JSON.stringify({ ...config, ownerId: f.options.owner,
    contentRoot: join(sourceRoot, 'content'), statePath: f.options.statePath, ...extra }));
  return { ...f, command: [bunPath, join(sourceRoot, 'src/edges/hook.ts'), '--config', path] };
}
/**
 * The shadow response contract, asserted on every native reply.
 *
 * `hookSpecificOutput` carries no `permissionDecision` and no
 * `permissionDecisionReason` — not even the strings — so no case can be read by
 * the host as allow, deny or ask. The only payload is an explicit shadow
 * diagnostic labelled `provisional`, `enforcement: false` and non-disruptive.
 */
function shadow(result: Awaited<ReturnType<typeof run>>) {
  expect(result.json.hookSpecificOutput.hookEventName).toBe('PreToolUse');
  expect(Object.keys(result.json.hookSpecificOutput).sort()).toEqual(['additionalContext', 'hookEventName']);
  expect(result.stdout).not.toContain('permissionDecision');
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16384);
  const report = JSON.parse(result.json.hookSpecificOutput.additionalContext);
  expect(report.schema).toBe('aos.shadow/v1');
  expect(report.provisional).toBe(true); expect(report.enforcement).toBe(false);
  expect(report.nonDisruptive).toBe(true);
  return report;
}
test('native context cannot inject facts; shared service allow stays a shadow observation', async () => {
  const f = await direct();
  const forged = { ...event, observations: [{ key: 'verification', status: 'fresh', value: true }], ownerId: 'intruder', command: 'reference' };
  const result = await run(f.command, JSON.stringify(forged), f.base);
  const report = shadow(result); expect(result.code).toBe(0); expect(result.stderr).toBe('');
  // One decision engine: the shadow label mirrors the shared receipt's verdict.
  expect(report.verdict).toBe('would-allow');
  const state = new StateStore(f.options.statePath);
  try {
    const receipts = state.receipts('test-owner', event.session_id, 10);
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;
    expect(receipt.gateVerdict).toBe('allow');
    expect(receipt.byteTiers.total).toBeGreaterThan(0);
    expect(receipt.byteTiers.total).toBeLessThanOrEqual(65536);
    expect(report.evidence.requestDigest).toBe(receipt.requestDigest);
    expect(report.evidence.payloadHash).toBe(receipt.payloadHash);
    expect(report.evidence.complete).toBe(true);
    const parsed = HookConfigSchema.parse({ ...config, ownerId: 'test-owner', contentRoot: join(sourceRoot, 'content'), statePath: f.options.statePath });
    const op = nativeOperation(forged, parsed);
    expect(op.observations[0]!.provenance.kind).toBe('synthetic');
    const replay = await new RuntimeService({ state, content: await loadContent(parsed.contentRoot), sourceRevision }).execute(op);
    expect(replay.receipt).toEqual(receipt);
    expect(replay.enforcement).toBe(false);
    expect(report.composition).toBe(replay.core?.composition.value.payload.text);
    expect(Buffer.byteLength(report.composition)).toBe(receipt.byteTiers.total);
    // Oversized context cannot escape the protocol's output limit.
    replay.core!.composition.value.payload.text = 'x'.repeat(16384);
    expect(() => hookReply(replay)).toThrow('output limit');
  } finally { state.close(); }
});
test('shadow deny completes with exit 0; missing evidence is indeterminate, never a permit', async () => {
  const f = await direct({ ownerPolicy: { ...DEFAULT_CONFIG, rules: [{ id: 'deny-all', decision: 'deny' }] } });
  const result = await run(f.command, JSON.stringify(event), f.base);
  const denied = shadow(result); expect(result.code).toBe(0);
  expect(denied.verdict).toBe('would-deny');
  // Absent evidence is incomplete observation, not a policy permission either way.
  const missing = await direct({ syntheticObservations: [] });
  const out = await run(missing.command, JSON.stringify({ ...event, observations: facts }), missing.base);
  const absent = shadow(out); expect(out.code).toBe(1); expect(out.stderr).not.toBe('');
  expect(absent.verdict).toBe('indeterminate');
  expect(absent.incompleteReason).toBe('observations or policy incomplete');
  expect(absent).not.toHaveProperty('permissionDecision');
});
test('malformed, multi-document, oversized and invalid UTF-8 framing stay non-blocking and indeterminate', async () => {
  const f = await direct();
  for (const text of ['{', '{}\n{}\n', '', 'x'.repeat(262145), new Uint8Array([255]), JSON.stringify({ ...event, hook_event_name: 'Unknown' })]) {
    const result = await run(f.command, text, f.base);
    const report = shadow(result);
    // Honest diagnostics, but exit 1 (non-blocking), never the vendor's exit 2.
    expect(result.code).toBe(1); expect(result.stderr).not.toBe('');
    expect(report.verdict).toBe('indeterminate');
  }
});
test('invalid versions, generation, and unavailable assets/state stay indeterminate', async () => {
  for (const extra of [{ version: 2 }, { schemaVersion: 2 }, { composeVersion: 2 }, { contentGeneration: 999 },
    { contentRoot: '/missing-source-assets' }, { statePath: '/missing-parent/runtime.sqlite' }]) {
    const f = await direct(extra);
    const result = await run(f.command, JSON.stringify(event), f.base);
    const report = shadow(result);
    expect(result.code).toBe(1);
    expect(report.verdict).toBe('indeterminate');
  }
});
test('stdin deadline terminates an actual subprocess with open stdin without blocking the host', async () => {
  const f = await direct({ timeoutMs: 20 });
  const child = Bun.spawn(f.command, { env: { PATH: '' }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 5000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1); expect(stderr).not.toBe('');
    const output = JSON.parse(stdout).hookSpecificOutput;
    expect(output.permissionDecision).toBeUndefined();
    expect(JSON.parse(output.additionalContext).verdict).toBe('indeterminate');
  } finally { clearTimeout(timer); child.stdin.end(); }
});
test('render/install invokes real registered shim with empty PATH and hostile path characters; uninstall owns only artifacts', async () => {
  const f = await setup();
  // Resolve a caller-supplied executable path containing metacharacters, not PATH.
  const executable = join(f.base, "runtime ' $() ` ;");
  await cp(bunPath, executable); await chmod(executable, 0o755);
  const executableAlias = join(f.base, 'runtime-alias'); await symlink(executable, executableAlias);
  await writeFile(join(f.options.targetRoot, 'legacy-verified'), 'ignored marker');
  const rendered = await renderHarness({ ...f.options, bunPath: executableAlias });
  expect(rendered.bunPath).toBe(executable);
  const installed = await install({ sourceRoot, stageRoot: rendered.stageRoot, targetRoot: rendered.targetRoot,
    owner: rendered.owner, manifest: rendered.manifest, modes: rendered.modes });
  expect(installed.status).toBe('installed');
  expect((await lstat(rendered.shimPath)).mode & 0o777).toBe(0o755);
  const settings = JSON.parse(await readFile(join(rendered.targetRoot, 'settings.json'), 'utf8'));
  const handler = settings.hooks.PreToolUse[0].hooks[0];
  expect(handler.args).toEqual([]); expect(handler.command).toBe(rendered.shimPath);
  const result = await run([handler.command, ...handler.args], JSON.stringify(event), f.base);
  const report = shadow(result); expect(result.code).toBe(0);
  expect(report.verdict).toBe('would-allow');
  await rm(executable);
  const absentRuntime = await run([handler.command], JSON.stringify(event), f.base);
  const failed = shadow(absentRuntime);
  expect(absentRuntime.code).toBe(1);
  expect(failed.verdict).toBe('indeterminate');
  const removed = await uninstall({ targetRoot: rendered.targetRoot, owner: rendered.owner });
  expect(removed.status).toBe('removed');
  expect(await readFile(join(rendered.targetRoot, 'legacy-verified'), 'utf8')).toBe('ignored marker');
  expect(await readdir(rendered.targetRoot)).not.toContain('settings.json');
  expect(await lstat(f.options.statePath)).toBeDefined();
});
test('managed registration preserves existing settings and hooks across install, upgrade and uninstall', async () => {
  const f = await setup(); const path = join(f.options.targetRoot, 'settings.json');
  const original = '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/operator/hook"}]}]},"unrelated":true}\n';
  await writeFile(path, original);
  const rendered = await renderHarness(f.options);
  // Render is a plan: it reads the shared document but does not mutate it.
  expect(await readFile(path, 'utf8')).toBe(original);
  const installed = await install({ sourceRoot, stageRoot: rendered.stageRoot, targetRoot: rendered.targetRoot,
    owner: rendered.owner, manifest: rendered.manifest, modes: rendered.modes });
  expect(installed.status).toBe('installed');
  let settings = JSON.parse(await readFile(path, 'utf8'));
  expect(settings.unrelated).toBe(true);
  expect(settings.hooks.PreToolUse.map((item: { matcher: string }) => item.matcher)).toEqual(['Bash', 'Edit|Write']);

  // An operator edit after install is folded into the next reviewed generation.
  settings.operatorAdded = { retained: true };
  await writeFile(path, JSON.stringify(settings, null, 2) + '\n');
  const nextStage = join(f.base, 'stage-next'); await mkdir(nextStage);
  const next = await renderHarness({ ...f.options, stageRoot: nextStage, generation: 2 });
  const upgraded = await install({ sourceRoot, stageRoot: next.stageRoot, targetRoot: next.targetRoot,
    owner: next.owner, manifest: next.manifest, modes: next.modes, expectedGeneration: 1 });
  expect(upgraded.status).toBe('installed');
  const removed = await uninstall({ targetRoot: next.targetRoot, owner: next.owner, expectedGeneration: 2 });
  expect(removed.status).toBe('removed');
  settings = JSON.parse(await readFile(path, 'utf8'));
  expect(settings.operatorAdded).toEqual({ retained: true });
  expect(settings.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ type: 'command', command: '/operator/hook' }] }]);

  await expect(renderHarness({ ...f.options, merge: {} } as RenderOptions)).rejects.toThrow();
  expect(() => registration('/temporary/${PLACEHOLDER}/run')).toThrow();
}, 15_000);
test('managed settings adoption and removal recover through the shared transaction journal', async () => {
  const f = await setup(); const path = join(f.options.targetRoot, 'settings.json');
  const original = '{"operator":true,"hooks":{"PreToolUse":[]}}\n'; await writeFile(path, original);
  const rendered = await renderHarness(f.options);
  const interrupted = await installWithFaults({ sourceRoot, stageRoot: rendered.stageRoot,
    targetRoot: rendered.targetRoot, owner: rendered.owner, manifest: rendered.manifest, modes: rendered.modes,
    failpoints: { at: 'after-place', mode: 'crash' } });
  expect(interrupted.status).toBe('interrupted');
  const firstRecovery = await recoverWithFaults({ targetRoot: rendered.targetRoot, owner: rendered.owner, assumeDead: true });
  expect(firstRecovery.status).toBe('recovered');
  expect(await readFile(path, 'utf8')).toBe(original);

  expect((await install({ sourceRoot, stageRoot: rendered.stageRoot, targetRoot: rendered.targetRoot,
    owner: rendered.owner, manifest: rendered.manifest, modes: rendered.modes })).status).toBe('installed');
  const settings = JSON.parse(await readFile(path, 'utf8'));
  settings.operatorAfterInstall = true;
  await writeFile(path, JSON.stringify(settings, null, 2) + '\n');
  const removing = await uninstallWithFaults({ targetRoot: rendered.targetRoot, owner: rendered.owner,
    failpoints: { at: 'after-place', mode: 'crash' } });
  expect(removing.status).toBe('interrupted');
  expect((await recoverWithFaults({ targetRoot: rendered.targetRoot, owner: rendered.owner, assumeDead: true })).status).toBe('recovered');
  expect(JSON.parse(await readFile(path, 'utf8')).operatorAfterInstall).toBe(true);
  expect((await uninstall({ targetRoot: rendered.targetRoot, owner: rendered.owner })).status).toBe('removed');
  const final = JSON.parse(await readFile(path, 'utf8'));
  expect(final.operator).toBe(true); expect(final.operatorAfterInstall).toBe(true);
  expect(final.hooks.PreToolUse).toEqual([]);
}, 15_000);
test('source/target/stage/state overlap and symlink aliases refuse before staging', async () => {
  const f = await setup();
  for (const changed of [{ targetRoot: sourceRoot }, { stageRoot: f.options.targetRoot },
    { statePath: join(f.options.targetRoot, 'state.sqlite') }, { bunPath: 'bun' }]) {
    await expect(renderHarness({ ...f.options, ...changed })).rejects.toThrow();
  }
  const alias = join(f.base, 'alias'); await symlink(f.options.targetRoot, alias);
  await expect(renderHarness({ ...f.options, targetRoot: alias })).rejects.toThrow();
  expect(await readdir(f.options.stageRoot)).toEqual([]);
});
test('legacy markers do not replace absent observations', async () => {
  const f = await direct({ syntheticObservations: [] });
  await writeFile(join(f.base, '.verified'), 'true');
  await writeFile(join(f.base, 'session-agent-complete'), 'true');
  const result = await run(f.command, JSON.stringify(event), f.base);
  expect(shadow(result).verdict).toBe('indeterminate'); expect(result.code).toBe(1);
});
test('installed bundle survives removal of source and stage; edited registration is preserved on uninstall', async () => {
  const f = await setup(); const isolatedSource = join(f.base, 'source');
  await mkdir(isolatedSource);
  for (const path of ['src', 'content', 'node_modules/zod', 'package.json', 'bun.lock', 'LICENSE', 'NOTICE']) {
    await mkdir(join(isolatedSource, path, '..'), { recursive: true });
    await cp(join(sourceRoot, path), join(isolatedSource, path), { recursive: true });
  }
  const rendered = await renderHarness({ ...f.options, sourceRoot: isolatedSource });
  const report = await install({ sourceRoot: isolatedSource, stageRoot: rendered.stageRoot,
    targetRoot: rendered.targetRoot, owner: rendered.owner, manifest: rendered.manifest, modes: rendered.modes });
  expect(report.status).toBe('installed');
  await rm(isolatedSource, { recursive: true }); await rm(rendered.stageRoot, { recursive: true });
  const result = await run([rendered.shimPath], JSON.stringify(event), f.base);
  expect(shadow(result).verdict).toBe('would-allow'); expect(result.code).toBe(0);
  const path = join(rendered.targetRoot, 'settings.json');
  const edited = '{"userEdit":true}\n'; await writeFile(path, edited);
  const removed = await uninstall({ targetRoot: rendered.targetRoot, owner: rendered.owner });
  expect(removed.status).toBe('partial'); expect(await readFile(path, 'utf8')).toBe(edited);
});
test('bundle load failure is contained by the installed startup boundary', async () => {
  const f = await setup(); const rendered = await renderHarness(f.options);
  const report = await install({ sourceRoot, stageRoot: rendered.stageRoot, targetRoot: rendered.targetRoot,
    owner: rendered.owner, manifest: rendered.manifest, modes: rendered.modes });
  expect(report.status).toBe('installed');
  await writeFile(join(rendered.targetRoot, 'aos-hook/hook.js'), 'this is invalid javascript !!!');
  const result = await run([rendered.shimPath], JSON.stringify(event), f.base);
  expect(shadow(result).verdict).toBe('indeterminate'); expect(result.code).toBe(1);
});
