/**
 * Input-safety regression for the staged installer.
 *
 * These cases guard two failure modes that are refused *before* any target byte
 * or control file is touched:
 *
 * - caller-supplied data that is too deeply nested (or cyclic, or carries
 *   accessors) must produce a `refused` report, never an escaping exception or a
 *   stack overflow, and a getter must never run;
 * - a control lock whose record cannot describe a real process (a zero PID) is
 *   malformed and is refused, never treated as a live or abandoned owner.
 *
 * A plain, ordinary install is asserted in the same file so a validator that
 * simply refuses everything cannot pass this suite.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CONTROL_DIR, CONTROL_LOCK_PATH, install, recoverInstall, type InstallOptions, type InstallReport } from '../src/effects/install';

const digest = (bytes: string) => `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;

const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

const SOURCE_BYTES = { 'inputs/kernel.md': 'kernel source\n' };
const OUTPUT_BYTES = { 'kernel.md': 'rendered kernel v1\n', 'nested/reference.md': 'rendered reference v1\n' };

interface Fixture {
  base: string; sourceRoot: string; targetRoot: string; stageRoot: string; owner: string;
  manifest: Record<string, unknown>;
  options(override?: Partial<InstallOptions>): InstallOptions;
}

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'aos-install-safety-'));
  temporary.push(base);
  const sourceRoot = join(base, 'source'), targetRoot = join(base, 'target'), stageRoot = join(base, 'stage');
  await Promise.all([mkdir(sourceRoot), mkdir(targetRoot), mkdir(stageRoot)]);
  const owner = 'safety-owner';
  for (const [path, text] of Object.entries(SOURCE_BYTES)) {
    await mkdir(join(sourceRoot, path, '..'), { recursive: true });
    await writeFile(join(sourceRoot, path), text);
  }
  for (const [path, text] of Object.entries(OUTPUT_BYTES)) {
    await mkdir(join(stageRoot, path, '..'), { recursive: true });
    await writeFile(join(stageRoot, path), text);
  }
  const manifest: Record<string, unknown> = {
    schemaVersion: 1, owner, generation: 1, harness: 'example',
    sources: Object.entries(SOURCE_BYTES).map(([path, text]) => ({ path, digest: digest(text) })),
    outputs: Object.entries(OUTPUT_BYTES).map(([path, text]) => ({ path, digest: digest(text) })),
  };
  return { base, sourceRoot, targetRoot, stageRoot, owner, manifest,
    options: (override = {}) => ({ sourceRoot, targetRoot, stageRoot, manifest: structuredClone(manifest), owner, ...override }) };
}

/** Wrap a leaf in `depth` object layers without recursion. */
function nest(depth: number, leaf: unknown, key = 'next'): unknown {
  let current = leaf;
  for (let index = 0; index < depth; index++) current = { [key]: current };
  return current;
}

function hasCode(report: InstallReport, code: string): boolean {
  return report.issues.some((issue) => issue.code === code);
}

const controlDirAbsent = async (targetRoot: string) => (await lstat(join(targetRoot, CONTROL_DIR)).catch(() => null)) === null;

describe('installer input safety', () => {
  test('installs an ordinary manifest as the positive control', async () => {
    const f = await fixture();
    const report = await install(f.options());
    expect(report.status).toBe('installed');
    expect(report.generation).toBe(1);
    expect(report.mutations.applied).toBe(Object.keys(OUTPUT_BYTES).length);
    expect(report.issues).toEqual([]);
  });

  test('refuses deeply nested manifests without overflowing the stack', async () => {
    const f = await fixture();
    // 10000 exceeds the shared JSON validator's nesting bound; 200000 is well past
    // the recursion budget that made the previous walk throw RangeError.
    for (const depth of [10000, 200000]) {
      const before = await controlDirAbsent(f.targetRoot);
      const report = await install(f.options({ manifest: { ...f.manifest, extra: nest(depth, 'leaf') } }));
      expect(report.status).toBe('refused');
      expect(hasCode(report, 'malformed-manifest')).toBe(true);
      expect(report.mutations.applied).toBe(0);
      expect(before && await controlDirAbsent(f.targetRoot)).toBe(true);
    }
  });

  test('refuses cyclic manifests', async () => {
    const f = await fixture();
    const cyclic: Record<string, unknown> = { ...f.manifest };
    cyclic.self = cyclic;
    const report = await install(f.options({ manifest: cyclic }));
    expect(report.status).toBe('refused');
    expect(hasCode(report, 'malformed-manifest')).toBe(true);
    expect(report.mutations.applied).toBe(0);
  });

  test('refuses manifests carrying accessors and never executes a getter', async () => {
    const f = await fixture();
    // Depth 50 stays inside the nesting bound, so the walk really does reach the
    // descriptor: this asserts accessor detection itself, not the depth refusal.
    let shallowAccessed = false;
    const shallow = nest(50, { get boom() { shallowAccessed = true; return 'leaked'; } }, 'hold');
    const shallowReport = await install(f.options({ manifest: { ...f.manifest, extra: shallow } }));
    expect(shallowReport.status).toBe('refused');
    expect(hasCode(shallowReport, 'malformed-manifest')).toBe(true);
    expect(shallowAccessed).toBe(false);
    expect(shallowReport.mutations.applied).toBe(0);

    let deepAccessed = false;
    const deep = nest(200000, { get boom() { deepAccessed = true; return 'leaked'; } }, 'hold');
    const deepReport = await install(f.options({ manifest: { ...f.manifest, extra: deep } }));
    expect(deepReport.status).toBe('refused');
    expect(hasCode(deepReport, 'malformed-manifest')).toBe(true);
    expect(deepAccessed).toBe(false);
    expect(deepReport.mutations.applied).toBe(0);
  });

  test('refuses deeply nested option values without overflowing the stack', async () => {
    const f = await fixture();
    const report = await install(f.options({ modes: nest(200000, 0o600, 'modes') as InstallOptions['modes'] }));
    expect(report.status).toBe('refused');
    expect(hasCode(report, 'invalid-options')).toBe(true);
    expect(report.mutations.applied).toBe(0);
  });

  test('refuses a control lock recorded with a zero PID instead of taking it over', async () => {
    const f = await fixture();
    await mkdir(join(f.targetRoot, CONTROL_DIR), { recursive: true });
    await writeFile(join(f.targetRoot, CONTROL_LOCK_PATH), JSON.stringify({
      schemaVersion: 1, nonce: 'a'.repeat(32), owner: f.owner, generation: 1, operation: 'install', pid: 0 }));

    const report = await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true });
    expect(report.status).toBe('refused');
    expect(hasCode(report, 'control-invalid')).toBe(true);
    expect(hasCode(report, 'live-lock')).toBe(false);
    expect(report.recoveryRequired).toBe(true);
    expect(report.mutations.applied).toBe(0);
    // The malformed marker is left in place: it is evidence, not a reclaimable lock.
    expect(await lstat(join(f.targetRoot, CONTROL_LOCK_PATH)).then(() => true, () => false)).toBe(true);
  });
});
