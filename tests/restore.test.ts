import { afterAll, expect, test as bunTest } from 'bun:test';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { renderHarness } from '../src/effects/render';
import { checkDrift } from '../src/effects/drift';
import { install, uninstall, CONTROL_DIR, CONTROL_COORDINATION_PATH } from '../src/effects/install';
import { HARNESS_PROTOCOL } from '../src/protocols/harness';

const test = process.platform === 'win32' ? bunTest.skip : bunTest;
const REPO = resolve(import.meta.dir, '..');
let cleanup = '';
afterAll(async () => { if (cleanup) await rm(cleanup, { recursive: true, force: true }); });

test('a declared payload restores a disposable home and degrades honestly without external access', async () => {
  cleanup = await mkdtemp(join(await realpath(tmpdir()), 'aos-restore-proof-'));
  const sourceRoot = join(cleanup, 'source');
  const stageRoot = join(cleanup, 'stage');
  const targetRoot = join(cleanup, 'harness home with spaces');
  const stateRoot = join(cleanup, 'runtime-state');
  await Promise.all([mkdir(sourceRoot), mkdir(stageRoot), mkdir(targetRoot), mkdir(stateRoot)]);

  // Source payload and dependency material are deliberately separate steps.
  for (const path of ['src', 'content', 'package.json', 'bun.lock', 'LICENSE', 'NOTICE']) {
    await cp(join(REPO, path), join(sourceRoot, path), { recursive: true });
  }
  const dependency = Bun.spawn([process.execPath, 'install', '--frozen-lockfile', '--offline', '--ignore-scripts'], {
    cwd: sourceRoot, env: { ...process.env, CI: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe',
  });
  const [dependencyOut, dependencyErr, dependencyCode] = await Promise.all([
    new Response(dependency.stdout).text(), new Response(dependency.stderr).text(), dependency.exited,
  ]);
  expect(`${dependencyOut}\n${dependencyErr}`).not.toContain('error:');
  expect(dependencyCode).toBe(0);

  const operatorSettings = { theme: 'dark', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
    { type: 'command', command: '/operator/check' },
  ] }] } };
  await writeFile(join(targetRoot, 'settings.json'), JSON.stringify(operatorSettings, null, 2) + '\n');
  const membership = JSON.parse(await readFile(join(sourceRoot, 'content/membership.manifest.json'), 'utf8')) as { generation: number };
  const sourceRevision = '4'.repeat(40);
  const rendered = await renderHarness({
    sourceRoot, stageRoot, targetRoot, statePath: join(stateRoot, 'coordination.sqlite'), bunPath: process.execPath,
    owner: 'restore-proof', generation: 1,
    config: { version: 1, protocol: HARNESS_PROTOCOL, schemaVersion: 1, composeVersion: 1,
      contentGeneration: membership.generation, configRevision: 'aos-runtime-default/1', checkerRevision: 'aos-policy/1',
      sourceRevision, timeoutMs: 5000, syntheticObservations: [{ key: 'verification', availability: 'unavailable',
        freshness: 'stale', completeness: 'partial', result: 'unknown',
        reasons: ['vault-unavailable', 'tracker-unavailable', 'authentication-expired', 'network-unavailable'] }] },
  });
  const installed = await install({ sourceRoot, stageRoot, targetRoot, owner: rendered.owner,
    manifest: rendered.manifest, modes: rendered.modes });
  expect(installed.status).toBe('installed');

  const drift = await checkDrift({ sourceRoot, targetRoot, owner: rendered.owner, manifest: rendered.manifest,
    expectedGeneration: 1, expectedSourceRevision: sourceRevision, targetName: 'disposable-restore' });
  expect(drift.status).toBe('clean');
  expect(drift.freshness.status).toBe('fresh');
  expect(drift.consistency.status).toBe('consistent');
  for (const output of rendered.manifest.outputs) {
    const bytes = await readFile(join(targetRoot, output.path));
    expect(`sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`).toBe(output.digest);
    if (process.platform !== 'win32') expect((await lstat(join(targetRoot, output.path))).mode & 0o7777)
      .toBe(rendered.modes[output.path]!);
  }

  // The installed payload remains runnable without checkout, stage, network,
  // tracker, vault, or authentication. Missing evidence stays indeterminate.
  await rm(sourceRoot, { recursive: true }); await rm(stageRoot, { recursive: true });
  const event = { hook_event_name: 'PreToolUse', session_id: 'restore-session', tool_use_id: 'restore-call',
    tool_name: 'Edit', tool_input: { file_path: '/tmp/dummy' }, cwd: '/tmp', transcript_path: '/tmp/none' };
  const hook = Bun.spawn([rendered.shimPath], { cwd: cleanup, env: { PATH: '' },
    stdin: Buffer.from(JSON.stringify(event)), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, , code] = await Promise.all([new Response(hook.stdout).text(), new Response(hook.stderr).text(), hook.exited]);
  expect(code).toBe(1);
  const shadow = JSON.parse(JSON.parse(stdout).hookSpecificOutput.additionalContext);
  expect(shadow.verdict).toBe('indeterminate');

  const started = performance.now();
  const removed = await uninstall({ targetRoot, owner: rendered.owner, expectedGeneration: 1 });
  const recoveryMs = performance.now() - started;
  expect(removed.status).toBe('removed');
  expect(recoveryMs).toBeLessThan(10_000);
  expect(JSON.parse(await readFile(join(targetRoot, 'settings.json'), 'utf8'))).toEqual(operatorSettings);
  expect((await readdir(targetRoot)).sort()).toEqual([CONTROL_DIR, 'settings.json']);
  expect(await lstat(join(targetRoot, CONTROL_COORDINATION_PATH))).toBeDefined();
  expect((await readdir(stateRoot)).sort()).toContain('coordination.sqlite');
}, 180_000);
