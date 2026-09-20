/**
 * Real subprocess tests for the source-checkout management CLI (`src/edges/manage.ts`).
 *
 * Every test spawns the CLI as a child process with an explicit request file or
 * stdin, in a temporary tree. Nothing here touches a real configuration
 * directory, a home directory, a live harness, or the repository working tree:
 * the fixture renders into temporary stage/target/state roots and the CLI is
 * driven only through its documented JSON request contract.
 *
 * Coverage: help, render, install, drift (clean and drifted), uninstall,
 * stdin input, and invalid input (unknown command, unknown field, malformed
 * JSON, relative path, bad deadline, unknown flag, missing request file).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HARNESS_PROTOCOL } from '../src/protocols/harness';

const REPO = resolve(import.meta.dir, '..');
const CLI = join(REPO, 'src/edges/manage.ts');
const BUN = process.execPath;
const OWNER = 'manage-fixture-owner';

let base = '';
let sourceRoot = '';
let stageRoot = '';
let targetRoot = '';
let stateRoot = '';
let rendered: {
  manifest: unknown;
  modes: Record<string, number>;
  shimPath: string;
} = { manifest: null, modes: {}, shimPath: '' };

interface ChildResult { stdout: string; stderr: string; code: number }

async function runCli(args: string[], stdin?: string): Promise<ChildResult> {
  const child = Bun.spawn([BUN, CLI, ...args], {
    cwd: REPO,
    stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
    stdout: 'pipe', stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  return { stdout, stderr, code };
}

/** Stdout must be exactly one JSON value; anything else is a protocol failure. */
function body(result: ChildResult): Record<string, unknown> {
  const lines = result.stdout.split('\n').filter(line => line !== '');
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0]!) as Record<string, unknown>;
}

let requestCounter = 0;
async function requestFile(value: unknown): Promise<string> {
  const path = join(base, `request-${requestCounter++}.json`);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

async function renderOptions(): Promise<Record<string, unknown>> {
  const membership = JSON.parse(await readFile(join(sourceRoot, 'content/membership.manifest.json'), 'utf8')) as { generation: number };
  return {
    sourceRoot, stageRoot, targetRoot: join(base, 'render-target'),
    statePath: join(stateRoot, 'state.sqlite'), bunPath: BUN, owner: OWNER, generation: 1,
    config: { version: 1, protocol: HARNESS_PROTOCOL, schemaVersion: 1, composeVersion: 1,
      contentGeneration: membership.generation, configRevision: 'aos-runtime-default/1',
      checkerRevision: 'aos-policy/1', sourceRevision: 'a'.repeat(40), timeoutMs: 5000 },
  };
}

beforeAll(async () => {
  base = await mkdtemp(join(await realpath(tmpdir()), 'aos-manage-'));
  sourceRoot = join(base, 'source');
  stageRoot = join(base, 'stage');
  targetRoot = join(base, 'target');
  stateRoot = join(base, 'state');
  await Promise.all([mkdir(sourceRoot), mkdir(stageRoot), mkdir(targetRoot), mkdir(stateRoot),
    mkdir(join(base, 'render-target'))]);
  // The renderer reads a self-contained build tree: src, content, dependency
  // license files and the pinned package metadata. No ambient home is consulted.
  for (const path of ['src', 'content', 'package.json', 'bun.lock', 'LICENSE', 'NOTICE', 'node_modules/zod']) {
    await cp(join(REPO, path), join(sourceRoot, path), { recursive: true });
  }
  // The first harness adapter emits a POSIX shell shim. Portable management
  // input validation remains covered below on Windows.
  if (process.platform === 'win32') return;
  const request = await requestFile(await renderOptions());
  const result = await runCli(['render', '--request', request]);
  expect(result.code).toBe(0);
  rendered = body(result) as typeof rendered;
}, 180_000);

afterAll(async () => {
  if (base) await rm(base, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')('management CLI contract', () => {
  test('--help is runnable and returns one JSON document naming every command', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    const help = body(result);
    expect(help.commands).toEqual(['render', 'install', 'uninstall', 'recover', 'drift', 'doctor']);
    expect(String(help.usage)).toContain('src/edges/manage.ts');
    // The hook contract is the only vendor surface; no vendor name is invented.
    expect(help.protocol).toBe(HARNESS_PROTOCOL);
  });

  test('render stages bytes without writing into the target and reports a manifest', async () => {
    expect(rendered.manifest).toBeTruthy();
    const outputs = (rendered.manifest as { outputs: { path: string }[] }).outputs.map(entry => entry.path).sort();
    expect(outputs).toContain('settings.json');
    expect(outputs).toContain('aos-hook/run');
    expect(await readdir(join(base, 'render-target'))).toEqual([]);
    const staged = (await readdir(stageRoot)).sort();
    expect(staged).toContain('settings.json');
    expect(staged).toContain('aos-hook');
    // The staged shim is executable; every other staged artifact stays private.
    expect(rendered.modes['aos-hook/run']).toBe(0o755);
    expect(rendered.modes['settings.json']).toBe(0o600);
    const owned = (rendered.manifest as { outputs: { path: string; ownership?: string }[] }).outputs;
    expect(owned.every(entry => entry.ownership === (entry.path === 'settings.json' ? 'managed-json-item' : 'framework-file'))).toBe(true);
  });

  test('install applies the inspected stage and reports installed with exit 0', async () => {
    const request = await requestFile({ sourceRoot, stageRoot, targetRoot, owner: OWNER,
      manifest: rendered.manifest, modes: rendered.modes });
    const result = await runCli(['install', '--request', request]);
    expect(result.code).toBe(0);
    const report = body(result);
    expect(report.status).toBe('installed');
    expect(report.operation).toBe('install');
    expect(report.recoveryRequired).toBe(false);
    expect((report.counts as { added: number }).added).toBeGreaterThan(0);
    expect(await readdir(targetRoot)).toContain('settings.json');
    expect(await readFile(join(targetRoot, 'settings.json'), 'utf8')).toContain('PreToolUse');
  });

  test('drift against the installed target is clean and exits 0', async () => {
    const request = await requestFile({ sourceRoot, targetRoot, owner: OWNER, manifest: rendered.manifest });
    const result = await runCli(['drift', '--request', request]);
    expect(result.code).toBe(0);
    const report = body(result);
    expect(report.status).toBe('clean');
    expect(report.skipped).toBe(0);
    expect(report.checked).toBeGreaterThan(0);
  });

  test('drift on a modified installed file reports drift with a nonzero exit', async () => {
    const installed = join(targetRoot, 'aos-hook/config.json');
    const original = await readFile(installed, 'utf8');
    await writeFile(installed, original.replace(/"timeoutMs":\s*\d+/, '"timeoutMs": 1234'));
    const request = await requestFile({ sourceRoot, targetRoot, owner: OWNER, manifest: rendered.manifest });
    const result = await runCli(['drift', '--request', request]);
    expect(result.code).toBe(1);
    expect(body(result).status).toBe('drift');
    await writeFile(installed, original);
  });

  test('drift reads a request from stdin when --request is omitted', async () => {
    const result = await runCli(['drift'], JSON.stringify({ sourceRoot, targetRoot, owner: OWNER, manifest: rendered.manifest }));
    expect(result.code).toBe(0);
    expect(body(result).status).toBe('clean');
  });

  test('uninstall removes owned artifacts and retains the coordination file', async () => {
    const request = await requestFile({ targetRoot, owner: OWNER });
    const result = await runCli(['uninstall', '--request', request]);
    expect(result.code).toBe(0);
    const report = body(result);
    expect(report.status).toBe('removed');
    expect(report.recoveryRequired).toBe(false);
    expect(await readdir(targetRoot)).not.toContain('settings.json');
    // Residual gap: the stable coordination inode intentionally survives uninstall.
    expect(await readdir(join(targetRoot, '.aos'))).toContain('coordination.sqlite');
  });

  test('uninstall with no ownership state is a documented no-op, not a disguised failure', async () => {
    const empty = join(base, 'empty-target');
    await mkdir(empty);
    const request = await requestFile({ targetRoot: empty, owner: OWNER });
    const result = await runCli(['uninstall', '--request', request]);
    // `unchanged` is a completed uninstall outcome: there was nothing owned to
    // remove. The no-state diagnostic still has to be reported, and the CLI must
    // not silently report `removed` for work it never did.
    expect(result.code).toBe(0);
    const report = body(result);
    expect(report.status).toBe('unchanged');
    expect((report.issues as { code: string }[]).map(issue => issue.code)).toContain('no-state');
  });

  test('uninstall by a different owner is refused and leaves artifacts untouched', async () => {
    const owned = join(base, 'owned-target');
    await mkdir(owned);
    const installRequest = await requestFile({ sourceRoot, stageRoot, targetRoot: owned, owner: OWNER,
      manifest: rendered.manifest, modes: rendered.modes });
    expect((await runCli(['install', '--request', installRequest])).code).toBe(0);
    const result = await runCli(['uninstall'], JSON.stringify({ targetRoot: owned, owner: 'other-owner' }));
    expect(result.code).toBe(1);
    const report = body(result);
    expect(report.status).toBe('refused');
    expect((report.issues as { code: string }[]).map(issue => issue.code)).toContain('ownership-mismatch');
    expect(await readdir(owned)).toContain('settings.json');
  });

  test('recover on a target with no pending work is a completed no-op', async () => {
    const result = await runCli(['recover'], JSON.stringify({ targetRoot, owner: OWNER }));
    expect(result.code).toBe(0);
    expect(body(result).status).toBe('recovered');
  });

  test('doctor is read-only and explicitly enumerates what it does not check', async () => {
    const compatibilityRoot = join(base, 'doctor-target'); await mkdir(compatibilityRoot);
    await writeFile(join(compatibilityRoot, '.verified'), 'true\n');
    const result = await runCli(['doctor'], JSON.stringify({ contentRoot: join(sourceRoot, 'content'), targetRoot: compatibilityRoot }));
    expect(result.code).toBe(0);
    const report = body(result);
    expect(report.status).toBe('complete');
    expect(report.enforcement).toBe(false);
    expect(report.provisional).toBe(true);
    expect(report.unchecked as string[]).toContain('live harness');
    expect((report.runtime as { name: string }).name).toBe('Bun');
    expect(report.compatibility).toMatchObject({ status: 'foreign-markers', authorization: 'none', collision: false });
  });
});

describe('management CLI input boundary', () => {
  test('unknown command fails with JSON-only stdout and a nonzero exit', async () => {
    const result = await runCli(['explode']);
    expect(result.code).toBe(1);
    expect(result.stderr).not.toBe('');
    const report = body(result);
    expect(report.status).toBe('refused');
    expect((report.error as { code: string }).code).toBe('management-failed');
  });

  test('unknown request fields fail rather than being ignored', async () => {
    const request = await requestFile({ targetRoot, owner: OWNER, force: true });
    const result = await runCli(['uninstall', '--request', request]);
    expect(result.code).toBe(1);
    expect(body(result).status).toBe('refused');
  });

  test('malformed JSON and relative paths fail closed', async () => {
    const malformed = await runCli(['drift', '--request', await requestFile('{not json')]);
    expect(malformed.code).toBe(1);
    expect(body(malformed).status).toBe('refused');
    const relative = await runCli(['uninstall', '--request', await requestFile({ targetRoot: 'relative/target', owner: OWNER })]);
    expect(relative.code).toBe(1);
    expect(body(relative).status).toBe('refused');
  });

  test('invalid flags and deadlines fail before any effect runs', async () => {
    const request = await requestFile({ targetRoot, owner: OWNER });
    for (const args of [
      ['uninstall', '--request', request, '--force'],
      ['uninstall', '--request', request, '--input-timeout-ms', '0'],
      ['uninstall', '--request', request, '--input-timeout-ms', '60001'],
      ['uninstall', '--request', request, '--request', request],
      ['uninstall', '--request'],
    ]) {
      const result = await runCli(args);
      expect(result.code).toBe(1);
      expect(body(result).status).toBe('refused');
    }
  });

  test('a missing request file fails closed without touching the target', async () => {
    const missing = join(base, 'absent-request.json');
    const result = await runCli(['uninstall', '--request', missing]);
    expect(result.code).toBe(1);
    expect(body(result).status).toBe('refused');
    expect(await readdir(targetRoot)).not.toContain('settings.json');
  });

  test('install without a matching manifest is refused, never reported as success', async () => {
    const fresh = join(base, 'second-target');
    await mkdir(fresh);
    const request = await requestFile({ sourceRoot, stageRoot, targetRoot: fresh, owner: OWNER,
      manifest: { ...(rendered.manifest as Record<string, unknown>), owner: 'different-owner' } });
    const result = await runCli(['install', '--request', request]);
    expect(result.code).toBe(1);
    const report = body(result);
    expect(report.status).toBe('refused');
    expect(await readdir(fresh)).toEqual([]);
  });
});
