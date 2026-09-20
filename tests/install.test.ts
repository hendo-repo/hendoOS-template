import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { CONTROL_DIR, CONTROL_COORDINATION_PATH, CONTROL_JOURNAL_PATH, CONTROL_LOCK_PATH, CONTROL_STATE_PATH, install, recoverInstall, uninstall,
  type Failpoints, type InstallReport, type InstallOptions } from '../src/effects/install';
import { InstallManifestSchema, type InstallManifest } from '../src/schema/install';

const digest = (bytes: string | Uint8Array) => `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

const SOURCE_BYTES: Record<string, string> = {
  'inputs/kernel.md': 'kernel source\n',
  'inputs/reference.md': 'reference source\n',
};
const OUTPUT_BYTES: Record<string, string> = {
  'kernel.md': 'rendered kernel v1\n',
  'nested/reference.md': 'rendered reference v1\n',
};

interface Fixture {
  base: string; sourceRoot: string; targetRoot: string; stageRoot: string;
  manifest: InstallManifest; owner: string;
  /** Rewrite the stage bytes and return a matching manifest. */
  restage(outputs: Record<string, string>, generation: number, sources?: Record<string, string>): Promise<InstallManifest>;
}

async function fixture(): Promise<Fixture> {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'aos-install-'));
  temporary.push(base);
  const sourceRoot = join(base, 'source');
  const targetRoot = join(base, 'target');
  const stageRoot = join(base, 'stage');
  await Promise.all([mkdir(sourceRoot), mkdir(targetRoot), mkdir(stageRoot)]);
  const owner = 'fixture-owner';

  for (const [path, text] of Object.entries(SOURCE_BYTES)) {
    await mkdir(join(sourceRoot, path, '..'), { recursive: true });
    await writeFile(join(sourceRoot, path), text);
  }
  for (const [path, text] of Object.entries(OUTPUT_BYTES)) {
    await mkdir(join(stageRoot, path, '..'), { recursive: true });
    await writeFile(join(stageRoot, path), text);
  }

  const build = (outputs: Record<string, string>, generation: number, sources = SOURCE_BYTES): InstallManifest => ({
    schemaVersion: 1, owner, generation, harness: 'example',
    sources: Object.entries(sources).map(([path, text]) => ({ path, digest: digest(text) })),
    outputs: Object.entries(outputs).map(([path, text]) => ({ path, digest: digest(text) })),
  });

  const restage = async (outputs: Record<string, string>, generation: number, sources?: Record<string, string>) => {
    for (const path of Object.keys(OUTPUT_BYTES)) await rm(join(stageRoot, path), { force: true });
    for (const [path, text] of Object.entries(outputs)) {
      await mkdir(join(stageRoot, path, '..'), { recursive: true });
      await writeFile(join(stageRoot, path), text);
    }
    const next = build(outputs, generation, sources);
    if (!InstallManifestSchema.safeParse(next).success) throw new Error('fixture manifest invalid');
    return next;
  };

  const manifest = build(OUTPUT_BYTES, 1);
  if (!InstallManifestSchema.safeParse(manifest).success) throw new Error('fixture manifest invalid');
  return { base, sourceRoot, targetRoot, stageRoot, manifest, owner, restage };
}

// Only documented API fields cross the boundary; fixture metadata stays out.
function installOptions(f: Fixture, override: Partial<InstallOptions> = {}): InstallOptions {
  return { sourceRoot: f.sourceRoot, targetRoot: f.targetRoot, stageRoot: f.stageRoot,
    manifest: structuredClone(f.manifest), owner: f.owner, ...override };
}

async function snapshot(root: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    const info = await lstat(path);
    // Exclusion now needs one permanent inode. Compare every other byte and mode;
    // separate tests assert its exact name, inode stability and no sidecar residue.
    if (name === 'coordination.sqlite' && basename(root) === CONTROL_DIR) continue;
    const contents = info.isDirectory() ? await snapshot(path) : (await readFile(path)).toString('hex');
    if (name === CONTROL_DIR && Array.isArray(contents) && contents.length === 0) continue;
    entries.push([name, info.mode, name === CONTROL_DIR && info.isDirectory() ? (contents as unknown[]).length : info.size, contents]);
  }
  return entries;
}

function codes(report: InstallReport): string[] {
  return report.issues.map((issue) => issue.code).sort();
}

function hasCode(report: InstallReport, code: string): boolean {
  return report.issues.some((issue) => issue.code === code);
}

/** Completed transactions retain stable exclusion and, when owned, state. */
async function expectCleanControl(targetRoot: string): Promise<void> {
  const entries = await readdir(join(targetRoot, CONTROL_DIR)).catch(() => []);
  expect(entries.filter(name => !['state.json', 'coordination.sqlite'].includes(name))).toEqual([]);
  if (entries.length) expect(entries).toContain('coordination.sqlite');
}

function crashAfter(at: Failpoints['at'], mode: Failpoints['mode'] = 'crash'): Failpoints {
  return { at, mode };
}

// ---------------------------------------------------------------------------
// Option, manifest and root boundary
// ---------------------------------------------------------------------------

describe('install input boundary', () => {
  test('rejects malformed manifests and unknown keys without echoing rejected key names', async () => {
    const f = await fixture();
    const before = await snapshot(f.base);
    for (const manifest of [null, [], '{broken', {}, { ...f.manifest, schemaVersion: 2 },
      { ...f.manifest, generation: 0 }, { ...f.manifest, sources: [] }, { ...f.manifest, outputs: [] },
      { ...f.manifest, sources: [{ path: '../escape', digest: digest('x') }] },
      { ...f.manifest, outputs: [{ path: 'a', digest: 'sha256:short' }] },
    ]) {
      const report = await install(installOptions(f, { manifest }));
      expect(report.status).toBe('refused');
      expect(hasCode(report, 'malformed-manifest')).toBe(true);
      expect(report.mutations.applied).toBe(0);
    }
    const secret = await install(installOptions(f, { manifest: { ...f.manifest, 'private-secret-key': 'private-secret-value' } }));
    expect(hasCode(secret, 'malformed-manifest')).toBe(true);
    expect(JSON.stringify(secret)).not.toContain('private-secret');
    expect(await snapshot(f.base)).toEqual(before);
  });

  test('rejects accessor manifests without executing getters and inherited objects', async () => {
    const f = await fixture();
    let accessed = false;
    const malicious = { ...f.manifest, get generation() { accessed = true; return 1; } };
    expect((await install(installOptions(f, { manifest: malicious }))).status).toBe('refused');
    expect(accessed).toBe(false);
    expect((await install(installOptions(f, { manifest: Object.create(f.manifest) }))).status).toBe('refused');
  });

  test('rejects a mismatched owner, a wrong expected generation and any reserved control path', async () => {
    const f = await fixture();
    const mismatch = await install(installOptions(f, { owner: 'other' }));
    expect(hasCode(mismatch, 'owner-mismatch')).toBe(true);
    expect(mismatch.mutations.applied).toBe(0);

    expect(hasCode(await install(installOptions(f, { expectedGeneration: 2 })), 'generation-mismatch')).toBe(true);

    for (const path of ['.aos', '.aos/state.json', '.aos/staging/x.md']) {
      const manifest = { ...f.manifest, outputs: [{ path, digest: digest('x') }] };
      const report = await install(installOptions(f, { manifest }));
      expect(hasCode(report, 'reserved-path')).toBe(true);
      expect(report.mutations.applied).toBe(0);
    }
  });

  test('rejects symlinked roots, overlapping roots and unset roots before any mutation', async () => {
    const f = await fixture();
    const before = await snapshot(f.targetRoot);
    await symlink(f.targetRoot, join(f.base, 'alias'));
    for (const override of [
      { targetRoot: join(f.base, 'alias') }, { targetRoot: f.sourceRoot }, { targetRoot: f.stageRoot },
      { sourceRoot: f.targetRoot }, { stageRoot: f.sourceRoot }, { stageRoot: join(f.base, 'absent') },
      { targetRoot: '' }, { targetRoot: relative(f.base, f.targetRoot) }, { targetRoot: `${f.targetRoot}/../target` },
    ]) {
      const report = await install(installOptions(f, override));
      expect(report.status).toBe('refused');
      expect(hasCode(report, 'root-invalid')).toBe(true);
      expect(report.mutations.applied).toBe(0);
    }
    expect(await snapshot(f.targetRoot)).toEqual(before);
    expect(await lstat(join(f.targetRoot, CONTROL_DIR)).catch(() => null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Clean, repeat, upgrade
// ---------------------------------------------------------------------------

describe('install lifecycle', () => {
  test('clean install writes every output, records ownership, and leaves no control residue', async () => {
    const f = await fixture();
    const report = await install(installOptions(f));
    expect(report.status).toBe('installed');
    expect(report.atomicity).toBe('per-file-link');
    expect(report.recoveryRequired).toBe(false);
    expect(report.issues).toEqual([]);
    expect(report.counts).toMatchObject({ sourcesChecked: 2, outputsVerified: 2, planned: 2, added: 2, replaced: 0, removed: 0 });
    expect(report.mutations).toEqual({ applied: 2, rolledBack: 0 });
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe('rendered kernel v1\n');
    expect(await readFile(join(f.targetRoot, 'nested/reference.md'), 'utf8')).toBe('rendered reference v1\n');
    await expectCleanControl(f.targetRoot);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });

  test('repeat install of identical bytes is unchanged and rewrites no artifact', async () => {
    const f = await fixture();
    await install(installOptions(f));
    const before = await snapshot(f.targetRoot);
    const report = await install(installOptions(f));
    expect(report.status).toBe('unchanged');
    expect(report.mutations).toEqual({ applied: 0, rolledBack: 0 });
    expect(report.counts.added).toBe(0);
    expect(report.counts.replaced).toBe(0);
    expect(await snapshot(f.targetRoot)).toEqual(before);
    await expectCleanControl(f.targetRoot);
  });

  test('upgrade replaces changed outputs, removes stale ones, and preserves user files left unknown', async () => {
    const f = await fixture();
    await install(installOptions(f));
    // A user-owned file with no manifest entry and no ownership record.
    await writeFile(join(f.targetRoot, 'user-notes.md'), 'mine\n');
    await mkdir(join(f.targetRoot, 'user-dir'));
    await writeFile(join(f.targetRoot, 'user-dir/keep.txt'), 'keep\n');

    const next = await f.restage({ 'kernel.md': 'rendered kernel v2\n' }, 2);
    const report = await install(installOptions(f, { manifest: next, expectedGeneration: 1 }));
    expect(report.status).toBe('installed');
    expect(report.generation).toBe(2);
    expect(report.counts).toMatchObject({ added: 0, replaced: 1, removed: 1 });
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe('rendered kernel v2\n');
    // 'nested/reference.md' was owned and unmodified, so the stale entry is removed.
    expect(await lstat(join(f.targetRoot, 'nested/reference.md')).catch(() => null)).toBeNull();
    // User content is untouched and never claimed.
    expect(await readFile(join(f.targetRoot, 'user-notes.md'), 'utf8')).toBe('mine\n');
    expect(await readFile(join(f.targetRoot, 'user-dir/keep.txt'), 'utf8')).toBe('keep\n');
    expect(report.residue).toEqual([]);
    await expectCleanControl(f.targetRoot);
  });

  test('refuses changed bytes at the same generation and never regresses the target', async () => {
    const f = await fixture();
    await install(installOptions(f));
    const older = await f.restage({ 'kernel.md': 'rendered kernel v0\n' }, 1);
    const before = await snapshot(f.targetRoot);
    const report = await install(installOptions(f, { manifest: older, expectedGeneration: 1 }));
    expect(report.status).toBe('refused');
    expect(hasCode(report, 'generation-mismatch')).toBe(true);
    expect(await snapshot(f.targetRoot)).toEqual(before);
    await expectCleanControl(f.targetRoot);
  });
});

// ---------------------------------------------------------------------------
// Source and stage verification before mutation
// ---------------------------------------------------------------------------

describe('verify before mutate', () => {
  test('source mutation and digest mismatch refuse with zero target writes', async () => {
    const f = await fixture();
    await writeFile(join(f.sourceRoot, 'inputs/kernel.md'), 'tampered\n');
    const before = await snapshot(f.targetRoot);
    const report = await install(installOptions(f));
    expect(report.status).toBe('refused');
    expect(hasCode(report, 'source-modified')).toBe(true);
    expect(report.counts.sourcesChecked).toBe(1);
    expect(report.mutations.applied).toBe(0);
    expect(await readdir(f.targetRoot)).toEqual([]);
    expect(await snapshot(f.targetRoot)).toEqual(before);
    await expectCleanControl(f.targetRoot);
  });

  test('staged byte mutation and manifest hash mismatch refuse before any target write', async () => {
    const f = await fixture();
    await writeFile(join(f.stageRoot, 'kernel.md'), 'stage tampered\n');
    const before = await snapshot(f.targetRoot);
    const report = await install(installOptions(f));
    expect(report.status).toBe('refused');
    expect(hasCode(report, 'stage-modified')).toBe(true);
    expect(report.counts.outputsVerified).toBe(1);
    expect(report.mutations.applied).toBe(0);
    expect(await readdir(f.targetRoot)).toEqual([]);
    expect(await snapshot(f.targetRoot)).toEqual(before);
    await expectCleanControl(f.targetRoot);
  });

  test('a missing source or stage entry is reported precisely and blocks the install', async () => {
    const f = await fixture();
    await rm(join(f.sourceRoot, 'inputs/reference.md'));
    expect(hasCode(await install(installOptions(f)), 'source-missing')).toBe(true);
    await writeFile(join(f.sourceRoot, 'inputs/reference.md'), 'reference source\n');
    await rm(join(f.stageRoot, 'nested/reference.md'));
    expect(hasCode(await install(installOptions(f)), 'stage-missing')).toBe(true);
    await expectCleanControl(f.targetRoot);
  });

  test('a symlinked source or staged file is refused rather than followed', async () => {
    const f = await fixture();
    for (const [root, path] of [[f.sourceRoot, 'inputs/kernel.md'], [f.stageRoot, 'kernel.md']] as const) {
      await rm(join(root, path));
      await symlink(join(f.base, 'elsewhere'), join(root, path));
      const report = await install(installOptions(f));
      expect(report.status).toBe('refused');
      expect(report.issues.some((issue) => issue.pathCode === 'symlink')).toBe(true);
      expect(report.mutations.applied).toBe(0);
      await rm(join(root, path));
      await writeFile(join(root, path), path.startsWith('inputs/') ? SOURCE_BYTES[path]! : OUTPUT_BYTES[path]!);
    }
    await expectCleanControl(f.targetRoot);
  });
});

// ---------------------------------------------------------------------------
// Ownership, conflicts and stale files
// ---------------------------------------------------------------------------

describe('ownership and conflicts', () => {
  test('refuses an unowned collision and preserves the user file', async () => {
    const f = await fixture();
    await writeFile(join(f.targetRoot, 'kernel.md'), 'user content\n');
    const report = await install(installOptions(f));
    expect(report.status).toBe('refused');
    expect(hasCode(report, 'target-unowned')).toBe(true);
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe('user content\n');
    // The refusal is whole-transaction: the other output was not written either.
    expect(await lstat(join(f.targetRoot, 'nested/reference.md')).catch(() => null)).toBeNull();
    expect(report.mutations.applied).toBe(0);
    await expectCleanControl(f.targetRoot);
  });

  test('refuses a locally modified owned file and reports it rather than overwriting', async () => {
    const f = await fixture();
    await install(installOptions(f));
    await writeFile(join(f.targetRoot, 'kernel.md'), 'locally edited\n');
    const next = await f.restage({ 'kernel.md': 'rendered kernel v2\n', 'nested/reference.md': 'rendered reference v1\n' }, 2);
    const report = await install(installOptions(f, { manifest: next, expectedGeneration: 1 }));
    expect(report.status).toBe('refused');
    expect(hasCode(report, 'target-modified')).toBe(true);
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe('locally edited\n');
    expect(report.mutations.applied).toBe(0);
    await expectCleanControl(f.targetRoot);
  });

  test('refuses to take over a target owned by a different owner', async () => {
    const f = await fixture();
    await install(installOptions(f));
    const before = await snapshot(f.targetRoot);
    const report = await install(installOptions(f, { owner: 'rival-owner', manifest: { ...f.manifest, owner: 'rival-owner' } }));
    expect(report.status).toBe('refused');
    expect(hasCode(report, 'ownership-mismatch')).toBe(true);
    expect(await snapshot(f.targetRoot)).toEqual(before);
    await expectCleanControl(f.targetRoot);
  });

  test('preserves a user-modified stale file and retains its ownership record', async () => {
    const f = await fixture();
    await install(installOptions(f));
    await writeFile(join(f.targetRoot, 'nested/reference.md'), 'user changed this\n');
    const next = await f.restage({ 'kernel.md': 'rendered kernel v1\n' }, 2);
    const report = await install(installOptions(f, { manifest: next, expectedGeneration: 1 }));
    expect(hasCode(report, 'stale-preserved')).toBe(true);
    expect(report.residue).toEqual(['nested/reference.md']);
    expect(report.counts.preserved).toBe(1);
    expect(await readFile(join(f.targetRoot, 'nested/reference.md'), 'utf8')).toBe('user changed this\n');
    // Ownership is retained, so a later uninstall still treats it as ours-but-modified.
    const state = JSON.parse(await readFile(join(f.targetRoot, CONTROL_STATE_PATH), 'utf8'));
    expect(state.entries.map((entry: { path: string }) => entry.path)).toContain('nested/reference.md');
    await expectCleanControl(f.targetRoot);
  });

  test('refuses when a manifest path is an unreadable directory in the target', async () => {
    const f = await fixture();
    await mkdir(join(f.targetRoot, 'kernel.md'));
    const report = await install(installOptions(f));
    expect(report.status).toBe('refused');
    expect(hasCode(report, 'target-not-file')).toBe(true);
    expect(await lstat(join(f.targetRoot, 'kernel.md'))).toMatchObject({});
    expect(report.mutations.applied).toBe(0);
    await expectCleanControl(f.targetRoot);
  });

  test('re-creates a previously owned file deleted by the user', async () => {
    const f = await fixture();
    await install(installOptions(f));
    await rm(join(f.targetRoot, 'kernel.md'));
    const report = await install(installOptions(f));
    expect(report.status).toBe('installed');
    expect(report.counts.added).toBe(1);
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe('rendered kernel v1\n');
    await expectCleanControl(f.targetRoot);
  });
});

// ---------------------------------------------------------------------------
// Concurrency, staging and swap failures, recovery
// ---------------------------------------------------------------------------

describe('failure injection and recovery', () => {
  test('a held lock serializes competing installers; only one mutates', async () => {
    const f = await fixture();
    const [first, second] = await Promise.all([
      install(installOptions(f)),
      install(installOptions(f)),
    ]);
    const reports = [first, second];
    const winners = reports.filter((report) => report.status === 'installed');
    const losers = reports.filter((report) => report.status === 'refused');
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(1);
    expect(hasCode(losers[0]!, 'lock-held')).toBe(true);
    expect(losers[0]!.mutations.applied).toBe(0);
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe('rendered kernel v1\n');
    await expectCleanControl(f.targetRoot);
  });

  test('competing uninstall and install never interleave', async () => {
    const f = await fixture();
    await install(installOptions(f));
    const [removal, upgrade] = await Promise.all([
      uninstall({ targetRoot: f.targetRoot, owner: f.owner }),
      install(installOptions(f)),
    ]);
    const refused = [removal, upgrade].filter((report) => report.status === 'refused');
    expect(refused.length).toBe(1);
    expect(hasCode(refused[0]!, 'lock-held')).toBe(true);
    expect(refused[0]!.mutations.applied).toBe(0);
    await expectCleanControl(f.targetRoot);
  });

  test.each(['after-plan', 'after-backup', 'after-place'] as const)('abort at %s rolls the whole transaction back', async (at) => {
    const f = await fixture();
    const before = await snapshot(f.targetRoot);
    const report = await install(installOptions(f, { failpoints: { at, mode: 'abort' } }));
    expect(report.status).toBe('rolled-back');
    expect(report.mutations.rolledBack).toBe(report.mutations.applied);
    expect(await snapshot(f.targetRoot)).toEqual(before);
    expect(hasCode(report, 'failpoint-abort')).toBe(true);
    await expectCleanControl(f.targetRoot);
    // The target is usable again: the same install now succeeds.
    expect((await install(installOptions(f))).status).toBe('installed');
  });

  test('abort before the ownership state is written restores the prior state file', async () => {
    const f = await fixture();
    await install(installOptions(f));
    const next = await f.restage({ 'kernel.md': 'rendered kernel v2\n' }, 2);
    const before = await snapshot(f.targetRoot);
    const report = await install(installOptions(f, { manifest: next, expectedGeneration: 1,
      failpoints: crashAfter('after-place', 'abort') }));
    expect(report.status).toBe('rolled-back');
    expect(await snapshot(f.targetRoot)).toEqual(before);
    expect(JSON.parse(await readFile(join(f.targetRoot, CONTROL_STATE_PATH), 'utf8')).generation).toBe(1);
    await expectCleanControl(f.targetRoot);
  });

  test.each(['after-plan', 'after-backup', 'after-place', 'before-state', 'after-state'] as const)(
    'crash at %s leaves an unresolved journal and a recoverable target', async (at) => {
      const f = await fixture();
      const before = await snapshot(f.targetRoot);
      const report = await install(installOptions(f, { failpoints: { at, mode: 'crash' } }));
      expect(report.status).toBe('interrupted');
      expect(report.recoveryRequired).toBe(true);
      expect(hasCode(report, 'crash-injected')).toBe(true);
      // The journal is deliberately left on disk: a crash does not clean up.
      expect(await lstat(join(f.targetRoot, CONTROL_JOURNAL_PATH))).toMatchObject({});
      // A second install refuses until recovery happens.
      expect(hasCode(await install(installOptions(f)), 'recovery-required')).toBe(true);

      const recovered = await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true });
      expect(recovered.status).toBe('recovered');
      await expectCleanControl(f.targetRoot);
      if (at === 'after-state') {
        expect(hasCode(recovered, 'recovered-forward')).toBe(true);
        expect((await install(installOptions(f))).status).toBe('unchanged');
      } else {
        expect(await snapshot(f.targetRoot)).toEqual(before);
        expect((await install(installOptions(f))).status).toBe('installed');
      }
    });

  test('recovery after a committed-but-unfinalized transaction finishes forward', async () => {
    const f = await fixture();
    const report = await install(installOptions(f, { failpoints: { at: 'after-state', mode: 'crash' } }));
    expect(report.status).toBe('interrupted');
    const recovered = await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true });
    expect(recovered.status).toBe('recovered');
    expect(hasCode(recovered, 'recovered-forward')).toBe(true);
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe('rendered kernel v1\n');
    expect(JSON.parse(await readFile(join(f.targetRoot, CONTROL_STATE_PATH), 'utf8')).generation).toBe(1);
    await expectCleanControl(f.targetRoot);
  });

  test('recovery rolls back an interrupted uninstall', async () => {
    const f = await fixture();
    await install(installOptions(f));
    const report = await uninstall({ targetRoot: f.targetRoot, owner: f.owner,
      failpoints: { at: 'after-place', mode: 'crash' } });
    expect(report.status).toBe('interrupted');
    const recovered = await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true });
    expect(recovered.status).toBe('recovered');
    expect(hasCode(recovered, 'recovered-back')).toBe(true);
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe('rendered kernel v1\n');
    await expectCleanControl(f.targetRoot);
  });

  test('recovery refuses a live lock, a foreign lock and an unreadable journal', async () => {
    const f = await fixture();
    // Live lock from this process.
    await mkdir(join(f.targetRoot, CONTROL_DIR), { recursive: true });
    await writeFile(join(f.targetRoot, CONTROL_LOCK_PATH), JSON.stringify({
      schemaVersion: 1, nonce: 'a'.repeat(32), owner: f.owner, generation: 1, operation: 'install', pid: process.pid }));
    const live = await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner });
    expect(hasCode(live, 'live-lock')).toBe(true);
    expect(live.recoveryRequired).toBe(true);

    // A lock whose owner is someone else is never taken over.
    await writeFile(join(f.targetRoot, CONTROL_LOCK_PATH), JSON.stringify({
      schemaVersion: 1, nonce: 'a'.repeat(32), owner: 'rival-owner', generation: 1, operation: 'install', pid: 1 }));
    expect(hasCode(await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true }), 'ownership-mismatch')).toBe(true);

    // A malformed journal is refused, never interpreted.
    await rm(join(f.targetRoot, CONTROL_LOCK_PATH));
    await writeFile(join(f.targetRoot, CONTROL_JOURNAL_PATH), '{"seq":1,"phase":"begin"}\n');
    const malformed = await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner });
    expect(malformed.status).toBe('refused');
    expect(hasCode(malformed, 'journal-malformed')).toBe(true);
    expect(malformed.mutations.rolledBack).toBe(0);
    await rm(join(f.targetRoot, CONTROL_DIR), { recursive: true, force: true });
  });

  test('recovery with no pending transaction is a no-op, and a lock-only crash releases the lock', async () => {
    const f = await fixture();
    expect((await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner })).status).toBe('recovered');
    await mkdir(join(f.targetRoot, CONTROL_DIR), { recursive: true });
    await writeFile(join(f.targetRoot, CONTROL_LOCK_PATH), JSON.stringify({
      schemaVersion: 1, nonce: 'b'.repeat(32), owner: f.owner, generation: 1, operation: 'install', pid: 999999 }));
    const report = await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner });
    expect(report.status).toBe('recovered');
    expect(hasCode(report, 'recovered-back')).toBe(true);
    await expectCleanControl(f.targetRoot);
  });

  test('reports partial rather than success when a placed path cannot be rolled back', async () => {
    const f = await fixture();
    const report = await install(installOptions(f, { failpoints: { at: 'after-place', mode: 'abort' } }));
    expect(['rolled-back', 'partial']).toContain(report.status);
    expect(report.status).not.toBe('installed');
  });

  test('a failpoint abort after the ownership state is written reports a rollback, not a success', async () => {
    const f = await fixture();
    await install(installOptions(f));
    const next = await f.restage({ 'kernel.md': 'rendered kernel v3\n' }, 2);
    const report = await install(installOptions(f, { manifest: next, expectedGeneration: 1,
      failpoints: { at: 'after-state', mode: 'abort' } }));
    expect(report.status).toBe('rolled-back');
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe('rendered kernel v1\n');
    expect(JSON.parse(await readFile(join(f.targetRoot, CONTROL_STATE_PATH), 'utf8')).generation).toBe(1);
    await expectCleanControl(f.targetRoot);
  });
});

// ---------------------------------------------------------------------------
// Uninstall
// ---------------------------------------------------------------------------

describe('uninstall preservation', () => {
  test('removes every owned unchanged artifact and nothing else', async () => {
    const f = await fixture();
    await install(installOptions(f));
    await writeFile(join(f.targetRoot, 'user-file.md'), 'mine\n');
    await mkdir(join(f.targetRoot, 'nested-user'));
    await writeFile(join(f.targetRoot, 'nested-user/keep.txt'), 'keep\n');
    const report = await uninstall({ targetRoot: f.targetRoot, owner: f.owner });
    expect(report.status).toBe('removed');
    expect(report.counts.removed).toBe(2);
    expect(report.residue).toEqual([]);
    expect(await lstat(join(f.targetRoot, 'kernel.md')).catch(() => null)).toBeNull();
    expect(await lstat(join(f.targetRoot, 'nested/reference.md')).catch(() => null)).toBeNull();
    expect(await readFile(join(f.targetRoot, 'user-file.md'), 'utf8')).toBe('mine\n');
    expect(await readFile(join(f.targetRoot, 'nested-user/keep.txt'), 'utf8')).toBe('keep\n');
    await expectCleanControl(f.targetRoot);
  });

  test('preserves a user-modified artifact, reports it as residue and keeps a partial status', async () => {
    const f = await fixture();
    await install(installOptions(f));
    await writeFile(join(f.targetRoot, 'kernel.md'), 'user edited\n');
    const report = await uninstall({ targetRoot: f.targetRoot, owner: f.owner });
    expect(report.status).toBe('partial');
    expect(report.residue).toEqual(['kernel.md']);
    expect(report.counts.preserved).toBe(1);
    expect(hasCode(report, 'target-modified')).toBe(true);
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe('user edited\n');
    // The unmodified artifact is still removed and the residue stays owned.
    expect(await lstat(join(f.targetRoot, 'nested/reference.md')).catch(() => null)).toBeNull();
    const state = JSON.parse(await readFile(join(f.targetRoot, CONTROL_STATE_PATH), 'utf8'));
    expect(state.entries.map((entry: { path: string }) => entry.path)).toEqual(['kernel.md']);
    await expectCleanControl(f.targetRoot);
  });

  test('uninstall of an unowned target is a no-op and never deletes unknown files', async () => {
    const f = await fixture();
    await writeFile(join(f.targetRoot, 'kernel.md'), 'someone else\n');
    const before = await snapshot(f.targetRoot);
    const report = await uninstall({ targetRoot: f.targetRoot, owner: f.owner });
    expect(report.status).toBe('unchanged');
    expect(hasCode(report, 'no-state')).toBe(true);
    expect(await snapshot(f.targetRoot)).toEqual(before);
    await expectCleanControl(f.targetRoot);
  });

  test('refuses an uninstall by a different owner', async () => {
    const f = await fixture();
    await install(installOptions(f));
    const before = await snapshot(f.targetRoot);
    const report = await uninstall({ targetRoot: f.targetRoot, owner: 'rival-owner' });
    expect(report.status).toBe('refused');
    expect(hasCode(report, 'ownership-mismatch')).toBe(true);
    expect(await snapshot(f.targetRoot)).toEqual(before);
    await expectCleanControl(f.targetRoot);
  });

  test('refuses a wrong expected generation and an unset or symlinked target root', async () => {
    const f = await fixture();
    await install(installOptions(f));
    expect(hasCode(await uninstall({ targetRoot: f.targetRoot, owner: f.owner, expectedGeneration: 9 }), 'generation-mismatch')).toBe(true);
    for (const targetRoot of ['', join(f.base, 'absent'), relative(f.base, f.targetRoot)]) {
      const report = await uninstall({ targetRoot, owner: f.owner });
      expect(report.status).toBe('refused');
      expect(hasCode(report, 'root-invalid')).toBe(true);
    }
    await symlink(f.targetRoot, join(f.base, 'alias'));
    expect(hasCode(await uninstall({ targetRoot: join(f.base, 'alias'), owner: f.owner }), 'root-invalid')).toBe(true);
    await expectCleanControl(f.targetRoot);
  });

  test('uninstall refuses while an interrupted journal is pending', async () => {
    const f = await fixture();
    await install(installOptions(f));
    const crashed = await uninstall({ targetRoot: f.targetRoot, owner: f.owner,
      failpoints: { at: 'after-place', mode: 'crash' } });
    expect(crashed.status).toBe('interrupted');
    const blocked = await uninstall({ targetRoot: f.targetRoot, owner: f.owner });
    expect(blocked.recoveryRequired).toBe(true);
    expect(hasCode(blocked, 'recovery-required')).toBe(true);
    await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true });
    await expectCleanControl(f.targetRoot);
  });

  test('a second uninstall after a clean removal is unchanged', async () => {
    const f = await fixture();
    await install(installOptions(f));
    expect((await uninstall({ targetRoot: f.targetRoot, owner: f.owner })).status).toBe('removed');
    const again = await uninstall({ targetRoot: f.targetRoot, owner: f.owner });
    expect(again.status).toBe('unchanged');
    await expectCleanControl(f.targetRoot);
  });
});

// ---------------------------------------------------------------------------
// Isolation from the real environment
// ---------------------------------------------------------------------------

describe('environment isolation', () => {
  test('every mutation stays inside the supplied temporary target root', async () => {
    const f = await fixture();
    await install(installOptions(f));
    // Nothing was created outside base except base itself; base holds all three roots.
    const entries = (await readdir(f.base)).sort();
    expect(entries).toEqual(['source', 'stage', 'target']);
    await uninstall({ targetRoot: f.targetRoot, owner: f.owner });
    expect((await readdir(f.base)).sort()).toEqual(['source', 'stage', 'target']);
    expect(await readdir(f.targetRoot)).toEqual([CONTROL_DIR]);
  });

  test('reports are JSON-safe and never expose roots, owners, digests or file content', async () => {
    const f = await fixture();
    await install(installOptions(f));
    await writeFile(join(f.targetRoot, 'kernel.md'), 'sentinel-private-content');
    const report = await install(installOptions(f, { manifest: await f.restage({ 'kernel.md': 'rendered kernel v2\n' }, 2), expectedGeneration: 1 }));
    const text = JSON.stringify(report);
    expect(text).not.toContain('sentinel-private-content');
    expect(text).not.toContain(f.base);
    expect(text).not.toContain(f.owner);
    expect(text).not.toContain('sha256:');
    expect(JSON.parse(text)).toEqual(report);
  });

  test.skipIf(process.platform === 'win32')('a permission-denied target is reported without mutating anything', async () => {
    if (process.getuid?.() === 0) return; // Root bypasses mode bits; this control is unprovable.
    const f = await fixture();
    await chmod(f.targetRoot, 0o500);
    try {
      const report = await install(installOptions(f));
      expect(report.status).toBe('refused');
      expect(hasCode(report, 'permission-denied')).toBe(true);
      expect(report.mutations.applied).toBe(0);
    } finally { await chmod(f.targetRoot, 0o700); }
  });
});

// Invalid runtime inputs use an explicit boundary cast, never a cast on valid calls.
describe('strict runtime API', () => {
  test('rejects unknown, inherited, accessor and mistyped options without mutation', async () => {
    const f = await fixture();
    let accessed = 0;
    const invalid: unknown[] = [null, [], {}, { ...installOptions(f), extra: true },
      { ...installOptions(f), owner: 7 }, { ...installOptions(f), expectedGeneration: 0 },
      { ...installOptions(f), expectedGeneration: 1.5 }, { ...installOptions(f), expectedGeneration: NaN },
      { ...installOptions(f), failpoints: { at: 'unknown', mode: 'abort' } },
      { ...installOptions(f), failpoints: { at: 'after-plan', mode: 'unknown' } },
      { ...installOptions(f), failpoints: { at: 'after-plan', mode: 'abort', extra: true } },
      { ...installOptions(f), get owner() { accessed++; return f.owner; } },
      { ...installOptions(f), failpoints: { get at() { accessed++; return 'after-plan'; }, mode: 'abort' } },
      Object.create(installOptions(f))];
    for (const options of invalid) {
      const report = await install(options as InstallOptions);
      expect(report.status).toBe('refused');
      expect(hasCode(report, 'invalid-options')).toBe(true);
    }
    expect(accessed).toBe(0);
    expect(await readdir(f.targetRoot)).toEqual([]);
    expect(hasCode(await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner,
      assumeDead: 'yes' } as unknown as Parameters<typeof recoverInstall>[0]), 'invalid-options')).toBe(true);
    expect(hasCode(await uninstall({ targetRoot: f.targetRoot, owner: f.owner,
      expectedGeneration: -1 }), 'invalid-options')).toBe(true);
  });

  test('rejects nested manifest array accessors without running them', async () => {
    const f = await fixture();
    let accessed = false;
    const outputs = [...f.manifest.outputs];
    Object.defineProperty(outputs, '0', { get() { accessed = true; return f.manifest.outputs[0]; } });
    const report = await install(installOptions(f, { manifest: { ...f.manifest, outputs } }));
    expect(hasCode(report, 'malformed-manifest')).toBe(true);
    expect(accessed).toBe(false);
  });

  test('expected generation refers to installed state and lower generations are refused', async () => {
    const f = await fixture();
    expect(hasCode(await install(installOptions(f, { expectedGeneration: 1 })), 'generation-mismatch')).toBe(true);
    expect((await install(installOptions(f))).status).toBe('installed');
    const next = await f.restage({ 'kernel.md': 'second generation\n' }, 2);
    expect((await install(installOptions(f, { manifest: next, expectedGeneration: 1 }))).status).toBe('installed');
    const old = await f.restage(OUTPUT_BYTES, 1);
    const before = await snapshot(f.targetRoot);
    expect(hasCode(await install(installOptions(f, { manifest: old, expectedGeneration: 2 })), 'generation-regression')).toBe(true);
    expect(await snapshot(f.targetRoot)).toEqual(before);
  });
});

const installerUrl = new URL('../src/effects/install.ts', import.meta.url).href;
async function childOperation(operation: 'install' | 'uninstall' | 'recoverInstall', options: unknown, kill = false) {
  const script = `const api = await import(${JSON.stringify(installerUrl)});
    ${kill ? "process.exit = () => { process.kill(process.pid, 'SIGKILL'); throw new Error('kill failed'); };" : ''}
    const options = JSON.parse(await Bun.stdin.text());
    console.log(JSON.stringify(await api[${JSON.stringify(operation)}](options)));`;
  const child = Bun.spawn([process.execPath, '-e', script], {
    stdin: Buffer.from(JSON.stringify(options)), stdout: 'pipe', stderr: 'pipe',
  });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code, stdout, stderr, signal: child.signalCode };
}

const crashBoundaries = ['after-lock', 'after-journal', 'after-plan', 'after-stage', 'after-backup-link',
  'after-backup', 'after-move-link', 'after-place-link', 'after-place', 'before-state', 'after-state-write', 'after-state'] as const;

describe.skipIf(process.platform === 'win32')('real process termination and recovery', () => {
  test.each([...crashBoundaries])('SIGKILL at %s during upgrade preserves a recoverable transaction', async at => {
    const f = await fixture();
    expect((await install(installOptions(f))).status).toBe('installed');
    const before = await snapshot(f.targetRoot);
    const next = await f.restage({ 'kernel.md': 'upgraded\n', 'new/deep/asset.md': 'new\n' }, 2);
    const child = await childOperation('install', installOptions(f, { manifest: next, expectedGeneration: 1,
      failpoints: { at, mode: 'exit' } }), true);
    expect(child.signal).toBe('SIGKILL');
    expect(child.stdout).toBe('');
    expect(child.stderr).toBe('');
    const recovery = await childOperation('recoverInstall', { targetRoot: f.targetRoot, owner: f.owner });
    expect(recovery.code).toBe(0);
    const report: InstallReport = JSON.parse(recovery.stdout);
    expect(report.status).toBe('recovered');
    expect(report.recoveryRequired).toBe(false);
    await expectCleanControl(f.targetRoot);
    if (at === 'after-state') {
      expect(hasCode(report, 'recovered-forward')).toBe(true);
      expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe('upgraded\n');
      expect(await readFile(join(f.targetRoot, 'new/deep/asset.md'), 'utf8')).toBe('new\n');
      expect(await lstat(join(f.targetRoot, 'nested')).catch(() => null)).toBeNull();
    } else expect(await snapshot(f.targetRoot)).toEqual(before);
  });

  test.each(['after-lock', 'after-journal', 'after-plan', 'after-backup-link', 'after-backup', 'after-place',
    'before-state', 'after-state-write', 'after-state'] as const)('SIGKILL at %s during uninstall recovers without residue', async at => {
    const f = await fixture();
    await install(installOptions(f));
    const before = await snapshot(f.targetRoot);
    const child = await childOperation('uninstall', { targetRoot: f.targetRoot, owner: f.owner,
      failpoints: { at, mode: 'exit' } }, true);
    expect(child.signal).toBe('SIGKILL');
    const recovery = await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner });
    expect(recovery.status).toBe('recovered');
    if (at === 'after-state') expect(await readdir(f.targetRoot)).toEqual([CONTROL_DIR]);
    else expect(await snapshot(f.targetRoot)).toEqual(before);
  });

  test('a real process lock blocks installers, uninstallers and forced recovery until death', async () => {
    const f = await fixture();
    // Pause synchronously at a library boundary while its OS lock is held.
    const script = `const { install } = await import(${JSON.stringify(installerUrl)});
      process.exit = () => { console.log('locked'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
      await install(JSON.parse(await Bun.stdin.text()));`;
    const child = Bun.spawn([process.execPath, '-e', script], { stdin: Buffer.from(JSON.stringify(installOptions(f,
      { failpoints: { at: 'after-plan', mode: 'exit' } }))), stdout: 'pipe', stderr: 'pipe' });
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('locked');
      reader.releaseLock();
      for (const report of [await install(installOptions(f)),
        await uninstall({ targetRoot: f.targetRoot, owner: f.owner }),
        await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true })]) {
        expect(report.status).toBe('refused');
        expect(hasCode(report, 'lock-held')).toBe(true);
      }
    } finally { child.kill('SIGKILL'); await child.exited; }
    const results = await Promise.all([
      childOperation('recoverInstall', { targetRoot: f.targetRoot, owner: f.owner }),
      childOperation('recoverInstall', { targetRoot: f.targetRoot, owner: f.owner }),
    ]);
    const reports: InstallReport[] = results.map(result => JSON.parse(result.stdout));
    expect(reports.some(report => report.status === 'recovered')).toBe(true);
    expect(reports.every(report => report.status === 'recovered' || hasCode(report, 'lock-held'))).toBe(true);
    expect(await readdir(f.targetRoot)).toEqual([CONTROL_DIR]);
  });
});

async function pending(f: Fixture, at: Failpoints['at'] = 'after-place', upgrade = false) {
  if (upgrade) await install(installOptions(f));
  const manifest = upgrade ? await f.restage({ 'kernel.md': 'replacement\n' }, 2) : f.manifest;
  const report = await install(installOptions(f, { manifest, failpoints: { at, mode: 'crash' } }));
  expect(report.status).toBe('interrupted');
  const records = (await readFile(join(f.targetRoot, CONTROL_JOURNAL_PATH), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  return { records, nonce: records[0].nonce as string };
}

async function rewriteJournal(f: Fixture, records: unknown[]) {
  await writeFile(join(f.targetRoot, CONTROL_JOURNAL_PATH), records.map(record => JSON.stringify(record)).join('\n') + '\n');
}

describe('hostile and damaged recovery evidence', () => {
  test('rollback preserves edits to a newly placed file and retains evidence', async () => {
    const f = await fixture();
    await pending(f);
    await writeFile(join(f.targetRoot, 'kernel.md'), 'user edit after interruption\n');
    const report = await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true });
    expect(report.status).toBe('partial');
    expect(report.recoveryRequired).toBe(true);
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe('user edit after interruption\n');
    expect(await lstat(join(f.targetRoot, CONTROL_JOURNAL_PATH))).toBeDefined();
  });

  test('rollback refuses replacement files even when their bytes equal the staged digest', async () => {
    const f = await fixture();
    await pending(f);
    await rm(join(f.targetRoot, 'kernel.md'));
    await writeFile(join(f.targetRoot, 'kernel.md'), OUTPUT_BYTES['kernel.md']!);
    expect((await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true })).status).toBe('partial');
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe(OUTPUT_BYTES['kernel.md']!);
  });

  test('rollback never overwrites a user file that appeared after backup', async () => {
    const f = await fixture();
    await pending(f, 'after-backup', true);
    await writeFile(join(f.targetRoot, 'kernel.md'), 'new user file\n');
    expect((await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true })).status).toBe('partial');
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe('new user file\n');
  });

  test('corrupt backups are preserved and never restored', async () => {
    const f = await fixture();
    const { nonce } = await pending(f, 'after-backup', true);
    const backup = join(f.targetRoot, `.aos/backup/${nonce}/kernel.md`);
    await writeFile(backup, 'corrupt backup\n');
    const report = await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true });
    expect(report.status).toBe('partial');
    expect(await lstat(join(f.targetRoot, 'kernel.md')).catch(() => null)).toBeNull();
    expect(await readFile(backup, 'utf8')).toBe('corrupt backup\n');
  });

  test.each(['target', 'ancestor', 'backup', 'state', 'journal', 'lock', 'control'] as const)(
    'refuses a symlink replacement at %s without touching the referent', async location => {
      const f = await fixture();
      const { nonce } = await pending(f, 'after-place', true);
      const external = join(f.sourceRoot, 'sentinel');
      await writeFile(external, 'do not touch\n');
      let victim = join(f.targetRoot, 'kernel.md');
      let referent = external;
      if (location === 'ancestor') { victim = join(f.targetRoot, 'nested'); referent = f.sourceRoot; }
      if (location === 'backup') victim = join(f.targetRoot, `.aos/backup/${nonce}/kernel.md`);
      if (location === 'state') victim = join(f.targetRoot, CONTROL_STATE_PATH);
      if (location === 'journal') victim = join(f.targetRoot, CONTROL_JOURNAL_PATH);
      if (location === 'lock') victim = join(f.targetRoot, CONTROL_LOCK_PATH);
      if (location === 'control') { victim = join(f.targetRoot, CONTROL_DIR); referent = f.sourceRoot; }
      await rm(victim, { recursive: true, force: true });
      await symlink(referent, victim);
      const report = await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true });
      expect(['refused', 'partial']).toContain(report.status);
      expect(await readFile(external, 'utf8')).toBe('do not touch\n');
      expect((await lstat(victim)).isSymbolicLink()).toBe(true);
    });

  test.each(['nonce', 'backup-path', 'owner', 'operation', 'entry-digest', 'reserved-state', 'duplicate', 'phase', 'traversal', 'created-dir'] as const)(
    'forged journal %s is refused before target mutation', async variant => {
      const f = await fixture();
      const { records } = await pending(f, 'after-backup', true);
      const plan = records[2];
      if (variant === 'nonce') plan.nonce = 'f'.repeat(32);
      if (variant === 'backup-path') plan.entries[0].backup = 'user-file.md';
      if (variant === 'owner') plan.priorState.owner = 'rival';
      if (variant === 'operation') plan.operation = 'uninstall';
      if (variant === 'entry-digest') plan.entries[0].digest = digest('forged');
      if (variant === 'reserved-state') plan.priorState.entries[0].path = '.aos/lock';
      if (variant === 'duplicate') plan.entries.push(plan.entries[0]);
      if (variant === 'phase') records.push({ seq: records.length + 1, phase: 'finalized' });
      if (variant === 'traversal') plan.entries[0].path = '../outside';
      if (variant === 'created-dir') plan.createdDirs.push('user-directory');
      await rewriteJournal(f, records);
      const before = await snapshot(f.targetRoot);
      const report = await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true });
      expect(report.status).toBe('refused');
      expect(hasCode(report, 'journal-malformed')).toBe(true);
      expect(await snapshot(f.targetRoot)).toEqual(before);
    });

  test('a forged add cannot delete an unowned matching file without staged inode proof', async () => {
    const f = await fixture();
    await pending(f, 'after-plan');
    await writeFile(join(f.targetRoot, 'kernel.md'), OUTPUT_BYTES['kernel.md']!);
    const report = await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true });
    expect(report.status).toBe('partial');
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe(OUTPUT_BYTES['kernel.md']!);
  });

  test('unknown scratch files survive cleanup and retry recovery is idempotent', async () => {
    const f = await fixture();
    const { nonce } = await pending(f);
    const unknown = join(f.targetRoot, `.aos/staging/${nonce}/user-data`);
    await writeFile(unknown, 'user data\n');
    expect((await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true })).status).toBe('partial');
    expect(await readFile(unknown, 'utf8')).toBe('user data\n');
    expect(await lstat(join(f.targetRoot, CONTROL_JOURNAL_PATH))).toBeDefined();
    await rm(unknown); // User resolves the conflict; installer must not delete it.
    expect((await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true })).status).toBe('recovered');
    expect(await readdir(f.targetRoot)).toEqual([CONTROL_DIR]);
  });

  test('foreign nonce, missing lock and torn journal never trigger destructive recovery', async () => {
    for (const variant of ['nonce', 'missing', 'torn']) {
      const f = await fixture();
      await pending(f);
      if (variant === 'nonce') {
        const lock = JSON.parse(await readFile(join(f.targetRoot, CONTROL_LOCK_PATH), 'utf8'));
        await writeFile(join(f.targetRoot, CONTROL_LOCK_PATH), JSON.stringify({ ...lock, nonce: 'e'.repeat(32) }));
      } else if (variant === 'missing') await rm(join(f.targetRoot, CONTROL_LOCK_PATH));
      else await writeFile(join(f.targetRoot, CONTROL_JOURNAL_PATH), '{"seq":');
      const before = await snapshot(f.targetRoot);
      const report = await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true });
      expect(report.status).toBe('refused');
      expect(await snapshot(f.targetRoot)).toEqual(before);
    }
  });

  test('forward recovery preserves user changes made after commit and reports incomplete work', async () => {
    const f = await fixture();
    await pending(f, 'after-state');
    await writeFile(join(f.targetRoot, 'kernel.md'), 'post-commit edit\n');
    const report = await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true });
    expect(report.status).toBe('partial');
    expect(report.recoveryRequired).toBe(true);
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe('post-commit edit\n');
  });

  test('uninstall removes only directories it created and preserves user directory contents', async () => {
    const f = await fixture();
    await mkdir(join(f.targetRoot, 'nested')); // Pre-existing user directory.
    await install(installOptions(f));
    expect((await uninstall({ targetRoot: f.targetRoot, owner: f.owner })).status).toBe('removed');
    expect((await readdir(f.targetRoot)).sort()).toEqual([CONTROL_DIR, 'nested']);
    expect(await readdir(join(f.targetRoot, 'nested'))).toEqual([]);
    await rm(join(f.targetRoot, 'nested'), { recursive: true });
    await install(installOptions(f));
    await writeFile(join(f.targetRoot, 'nested/user-file'), 'keep');
    await uninstall({ targetRoot: f.targetRoot, owner: f.owner });
    expect(await readFile(join(f.targetRoot, 'nested/user-file'), 'utf8')).toBe('keep');
  });

  test('cross-generation aliases and case-folded control paths are refused', async () => {
    const f = await fixture();
    await install(installOptions(f));
    const alias = await f.restage({ 'Kernel.md': 'new\n' }, 2);
    const report = await install(installOptions(f, { manifest: alias }));
    expect(report.status).toBe('refused');
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe(OUTPUT_BYTES['kernel.md']!);
    const reservedManifest = { ...f.manifest, outputs: [{ path: '.AOS/lock', digest: digest('x') }] };
    expect(hasCode(await install(installOptions(f, { manifest: reservedManifest })), 'reserved-path')).toBe(true);
  });

  test('an output named state.json cannot collide with the ownership scratch file', async () => {
    const f = await fixture();
    const manifest = await f.restage({ 'state.json': 'artifact\n' }, 1);
    expect((await install(installOptions(f, { manifest }))).status).toBe('installed');
    expect(await readFile(join(f.targetRoot, 'state.json'), 'utf8')).toBe('artifact\n');
    expect((await uninstall({ targetRoot: f.targetRoot, owner: f.owner })).status).toBe('removed');
    expect(await readdir(f.targetRoot)).toEqual([CONTROL_DIR]);
  });
});

describe('recovery decision and retained ownership', () => {
  test('a durable rollback decision after state commit survives another interruption', async () => {
    const f = await fixture();
    const { records } = await pending(f, 'after-state');
    records.push({ seq: records.length + 1, phase: 'rolling-back' });
    await rewriteJournal(f, records);
    const result = await childOperation('recoverInstall', { targetRoot: f.targetRoot, owner: f.owner, assumeDead: true });
    const report: InstallReport = JSON.parse(result.stdout);
    expect(report.status).toBe('recovered');
    expect(hasCode(report, 'recovered-back')).toBe(true);
    expect(await readdir(f.targetRoot)).toEqual([CONTROL_DIR]);
  });

  test('repeat with modified stale ownership stays partial and keeps the old digest', async () => {
    const f = await fixture();
    await install(installOptions(f));
    await writeFile(join(f.targetRoot, 'nested/reference.md'), 'local reference');
    const next = await f.restage({ 'kernel.md': OUTPUT_BYTES['kernel.md']! }, 2);
    expect((await install(installOptions(f, { manifest: next }))).status).toBe('partial');
    const repeated = await install(installOptions(f, { manifest: next }));
    expect(repeated.status).toBe('partial');
    expect(repeated.recoveryRequired).toBe(false);
    expect(repeated.residue).toEqual(['nested/reference.md']);
    const state = JSON.parse(await readFile(join(f.targetRoot, CONTROL_STATE_PATH), 'utf8'));
    expect(state.entries.find((entry: { path: string }) => entry.path === 'nested/reference.md').digest)
      .toBe(digest(OUTPUT_BYTES['nested/reference.md']!));
    expect((await uninstall({ targetRoot: f.targetRoot, owner: f.owner })).status).toBe('partial');
    expect((await uninstall({ targetRoot: f.targetRoot, owner: f.owner })).status).toBe('partial');
    expect(await readFile(join(f.targetRoot, 'nested/reference.md'), 'utf8')).toBe('local reference');
  });

  test('state from before directory provenance remains compatible and preserves unknown directories', async () => {
    const f = await fixture();
    await install(installOptions(f));
    const state = JSON.parse(await readFile(join(f.targetRoot, CONTROL_STATE_PATH), 'utf8'));
    delete state.directories;
    await writeFile(join(f.targetRoot, CONTROL_STATE_PATH), JSON.stringify(state));
    expect((await uninstall({ targetRoot: f.targetRoot, owner: f.owner })).status).toBe('removed');
    expect((await readdir(f.targetRoot)).sort()).toEqual([CONTROL_DIR, 'nested']);
    expect(await readdir(join(f.targetRoot, 'nested'))).toEqual([]);
  });
});

test('lock-only interruption blocks install and uninstall until recovery', async () => {
  const f = await fixture();
  const interrupted = await install(installOptions(f, { failpoints: { at: 'after-lock', mode: 'crash' } }));
  expect(interrupted.status).toBe('interrupted');
  for (const report of [await install(installOptions(f)), await uninstall({ targetRoot: f.targetRoot, owner: f.owner })]) {
    expect(report.status).toBe('refused');
    expect(report.recoveryRequired).toBe(true);
    expect(hasCode(report, 'lock-held')).toBe(true);
  }
  expect((await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true })).status).toBe('recovered');
  expect(await readdir(f.targetRoot)).toEqual([CONTROL_DIR]);
});

// Permission intent belongs to the installer options, not the shared build schema.
const permissionMode = async (path: string) => (await lstat(path)).mode & 0o7777;

describe.skipIf(process.platform === 'win32')('explicit executable modes and conservative permission ownership', () => {
  test('installs executable shims with exact modes despite umask, then executes them', async () => {
    const f = await fixture();
    const manifest = await f.restage({ 'hooks/check': '#!/usr/bin/env bun\nconsole.log("hook-ran");\n', 'private.txt': 'private\n' }, 1);
    const child = Bun.spawn([process.execPath, '-e', `process.umask(0o077);
      const { install } = await import(${JSON.stringify(installerUrl)});
      console.log(JSON.stringify(await install(JSON.parse(await Bun.stdin.text()))));`], {
      stdin: Buffer.from(JSON.stringify(installOptions(f, { manifest, modes: { 'hooks/check': 0o755 } }))), stdout: 'pipe', stderr: 'pipe',
    });
    expect(await child.exited).toBe(0);
    expect(JSON.parse(await new Response(child.stdout).text()).status).toBe('installed');
    expect(await new Response(child.stderr).text()).toBe('');
    const shim = join(f.targetRoot, 'hooks/check');
    expect(await permissionMode(shim)).toBe(0o755);
    expect(await permissionMode(join(f.targetRoot, 'private.txt'))).toBe(0o600);
    const run = Bun.spawn([shim], { env: { ...process.env, PATH: `${join(process.execPath, '..')}:${process.env.PATH ?? ''}` }, stdout: 'pipe', stderr: 'pipe' });
    expect(await run.exited).toBe(0);
    expect(await new Response(run.stdout).text()).toBe('hook-ran\n');
    const state = JSON.parse(await readFile(join(f.targetRoot, CONTROL_STATE_PATH), 'utf8'));
    expect(state.entries.find((entry: { path: string }) => entry.path === 'hooks/check')).toEqual({ path: 'hooks/check', digest: manifest.outputs[0]!.digest, mode: 0o755 });
    const before = await lstat(shim);
    expect((await install(installOptions(f, { manifest }))).status).toBe('unchanged');
    expect((await lstat(shim)).ino).toBe(before.ino);
    expect(await permissionMode(shim)).toBe(0o755);
    expect((await uninstall({ targetRoot: f.targetRoot, owner: f.owner })).status).toBe('removed');
    await expectCleanControl(f.targetRoot);
  });

  test.each([0o400, 0o444, 0o500, 0o600, 0o640, 0o644, 0o700, 0o750, 0o755])('honors exact portable mode %i', async mode => {
    const f = await fixture();
    expect((await install(installOptions(f, { modes: { 'kernel.md': mode } }))).status).toBe('installed');
    expect(await permissionMode(join(f.targetRoot, 'kernel.md'))).toBe(mode);
    expect((await uninstall({ targetRoot: f.targetRoot, owner: f.owner })).status).toBe('removed');
  });

  test('mode-only changes require a generation upgrade and replace only the owned inode', async () => {
    const f = await fixture();
    await install(installOptions(f));
    const artifact = join(f.targetRoot, 'kernel.md');
    const before = await lstat(artifact);
    expect(hasCode(await install(installOptions(f, { modes: { 'kernel.md': 0o755 } })), 'generation-mismatch')).toBe(true);
    expect((await lstat(artifact)).ino).toBe(before.ino);
    const manifest = { ...f.manifest, generation: 2 };
    expect((await install(installOptions(f, { manifest, modes: { 'kernel.md': 0o755 } }))).status).toBe('installed');
    expect(await permissionMode(artifact)).toBe(0o755);
    expect((await lstat(artifact)).ino).not.toBe(before.ino);
    expect(await readFile(artifact, 'utf8')).toBe(OUTPUT_BYTES['kernel.md']!);
  });

  test.each([true, false])('preserves user mode changes during uninstall and upgrade (stale=%s)', async stale => {
    const f = await fixture();
    await install(installOptions(f, { modes: { 'kernel.md': 0o755 } }));
    const artifact = join(f.targetRoot, 'kernel.md');
    await chmod(artifact, 0o700);
    const manifest = await f.restage(stale ? { 'other.txt': 'other' } : { 'kernel.md': 'changed' }, 2);
    const upgraded = await install(installOptions(f, { manifest }));
    expect(upgraded.status).toBe(stale ? 'partial' : 'refused');
    expect((await uninstall({ targetRoot: f.targetRoot, owner: f.owner })).status).toBe('partial');
    expect(await permissionMode(artifact)).toBe(0o700);
    expect(await readFile(artifact, 'utf8')).toBe(OUTPUT_BYTES['kernel.md']!);
    const state = JSON.parse(await readFile(join(f.targetRoot, CONTROL_STATE_PATH), 'utf8'));
    expect(state.entries.find((entry: { path: string }) => entry.path === 'kernel.md').mode).toBe(0o755);
  });

  test.each(['after-place', 'after-state'] as const)('recovery preserves permission edits at %s', async at => {
    const f = await fixture();
    expect((await install(installOptions(f, { modes: { 'kernel.md': 0o755 }, failpoints: { at, mode: 'crash' } }))).status).toBe('interrupted');
    await chmod(join(f.targetRoot, 'kernel.md'), 0o700);
    expect((await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true })).status).toBe('partial');
    expect(await permissionMode(join(f.targetRoot, 'kernel.md'))).toBe(0o700);
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe(OUTPUT_BYTES['kernel.md']!);
  });

  test('rollback refuses a backup whose mode was changed', async () => {
    const f = await fixture();
    const { records } = await pending(f, 'after-backup', true);
    await chmod(join(f.targetRoot, records[2].entries[0].backup), 0o755);
    expect((await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true })).status).toBe('partial');
    expect(await permissionMode(join(f.targetRoot, records[2].entries[0].backup))).toBe(0o755);
  });

  test('legacy hash-only state remains readable without inferring permission ownership', async () => {
    const f = await fixture();
    await install(installOptions(f));
    const state = JSON.parse(await readFile(join(f.targetRoot, CONTROL_STATE_PATH), 'utf8'));
    state.entries.forEach((entry: { mode?: number }) => { delete entry.mode; });
    await writeFile(join(f.targetRoot, CONTROL_STATE_PATH), JSON.stringify(state));
    await chmod(join(f.targetRoot, 'kernel.md'), 0o755);
    expect((await install(installOptions(f))).status).toBe('unchanged');
    const manifest = { ...f.manifest, generation: 2 };
    expect((await install(installOptions(f, { manifest, modes: { 'kernel.md': 0o700 } }))).status).toBe('refused');
    expect((await uninstall({ targetRoot: f.targetRoot, owner: f.owner })).status).toBe('partial');
    expect(await permissionMode(join(f.targetRoot, 'kernel.md'))).toBe(0o755);
    expect(await readFile(join(f.targetRoot, 'kernel.md'), 'utf8')).toBe(OUTPUT_BYTES['kernel.md']!);
  });

  test('rejects nonportable modes, unrelated paths and accessor maps before any write', async () => {
    const f = await fixture();
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, 'kernel.md', { enumerable: true, get() { getterCalls++; return 0o755; } });
    for (const modes of [{ 'kernel.md': -1 }, { 'kernel.md': 0o4755 }, { 'kernel.md': 0o1000 }, { 'kernel.md': 0 },
      { 'kernel.md': 0o200 }, { 'kernel.md': 1.5 }, { 'kernel.md': '0755' }, { '../outside': 0o755 },
      { '.aos/state.json': 0o755 }, { 'Kernel.md': 0o755 }, { 'user.txt': 0o755 }, accessor]) {
      expect(hasCode(await install(installOptions(f, { modes: modes as Record<string, number> })), 'invalid-options')).toBe(true);
    }
    expect(getterCalls).toBe(0);
    expect(await readdir(f.targetRoot)).toEqual([]);
  });

  test('never chmods source files, stage files, unowned collisions or unrelated hard links', async () => {
    const f = await fixture();
    const source = join(f.sourceRoot, 'inputs/kernel.md'), stage = join(f.stageRoot, 'kernel.md'), user = join(f.targetRoot, 'kernel.md');
    await chmod(stage, 0o700);
    await writeFile(user, 'user');
    await chmod(user, 0o640);
    const sourceMode = await permissionMode(source);
    expect((await install(installOptions(f, { modes: { 'kernel.md': 0o755 } }))).status).toBe('refused');
    expect(await permissionMode(source)).toBe(sourceMode);
    expect(await permissionMode(stage)).toBe(0o700);
    expect(await permissionMode(user)).toBe(0o640);
    expect(await readFile(user, 'utf8')).toBe('user');
    await rm(user);
    await install(installOptions(f));
    const outside = join(f.sourceRoot, 'user-link');
    await link(user, outside);
    const manifest = { ...f.manifest, generation: 2 };
    expect((await install(installOptions(f, { manifest, modes: { 'kernel.md': 0o755 } }))).status).toBe('installed');
    expect(await permissionMode(outside)).toBe(0o600);
    expect(await permissionMode(user)).toBe(0o755);
  });
});

describe('portable exclusion and interrupted recovery', () => {
  test('coordination inode survives repeats, refusals, uninstall and recovery with no sidecars', async () => {
    const f = await fixture();
    await install(installOptions(f));
    const coordination = join(f.targetRoot, CONTROL_COORDINATION_PATH);
    const before = await lstat(coordination);
    for (const operation of [() => install(installOptions(f)), () => uninstall({ targetRoot: f.targetRoot, owner: 'rival' }),
      () => uninstall({ targetRoot: f.targetRoot, owner: f.owner }), () => recoverInstall({ targetRoot: f.targetRoot, owner: f.owner })]) {
      await operation();
      const after = await lstat(coordination);
      expect([after.ino, after.dev, after.mode, after.size]).toEqual([before.ino, before.dev, before.mode, before.size]);
      await expectCleanControl(f.targetRoot);
    }
    expect(await readdir(join(f.targetRoot, CONTROL_DIR))).toEqual(['coordination.sqlite']);
  });

  test.skipIf(process.platform === 'win32').each(['after-state-unlink', 'after-place-link'] as const)('SIGKILL at %s preserves exact prior modes and state', async at => {
    const f = await fixture();
    await install(installOptions(f, { modes: { 'kernel.md': 0o755 } }));
    const before = await snapshot(f.targetRoot);
    const manifest = await f.restage({ 'kernel.md': 'next' }, 2);
    const killed = await childOperation('install', installOptions(f, { manifest, modes: { 'kernel.md': 0o700 }, failpoints: { at, mode: 'exit' } }), true);
    expect(killed.signal).toBe('SIGKILL');
    expect((await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner })).status).toBe('recovered');
    expect(await snapshot(f.targetRoot)).toEqual(before);
  });

  test.skipIf(process.platform === 'win32').each(['after-recovery-decision', 'after-rollback-unlink', 'after-restore-link', 'after-state-unlink', 'before-cleanup', 'after-cleanup-file', 'after-cleanup-journal'] as const)(
    'recovery killed at %s can be retried in a fresh process', async at => {
      const f = await fixture();
      await install(installOptions(f, { modes: { 'kernel.md': 0o755 } }));
      const before = await snapshot(f.targetRoot);
      const manifest = await f.restage({ 'kernel.md': 'next' }, 2);
      const killed = await childOperation('install', installOptions(f, { manifest, modes: { 'kernel.md': 0o700 }, failpoints: { at: 'after-place', mode: 'exit' } }), true);
      expect(killed.signal).toBe('SIGKILL');
      const recovery = await childOperation('recoverInstall', { targetRoot: f.targetRoot, owner: f.owner, failpoints: { at, mode: 'exit' } }, true);
      expect(recovery.signal).toBe('SIGKILL');
      const retried = await childOperation('recoverInstall', { targetRoot: f.targetRoot, owner: f.owner });
      expect(retried.code).toBe(0);
      expect(JSON.parse(retried.stdout).status).toBe('recovered');
      expect(await snapshot(f.targetRoot)).toEqual(before);
      await expectCleanControl(f.targetRoot);
    });

  test.skipIf(process.platform === 'win32')('an active recovery excludes installers and other recoveries even with stale marker PIDs', async () => {
    const f = await fixture();
    const dead = await childOperation('install', installOptions(f, { failpoints: { at: 'after-place', mode: 'exit' } }), true);
    expect(dead.signal).toBe('SIGKILL');
    const script = `const { recoverInstall } = await import(${JSON.stringify(installerUrl)});
      process.exit = () => { console.log('recovering'); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); };
      await recoverInstall(JSON.parse(await Bun.stdin.text()));`;
    const child = Bun.spawn([process.execPath, '-e', script], { stdin: Buffer.from(JSON.stringify({ targetRoot: f.targetRoot, owner: f.owner,
      failpoints: { at: 'after-recovery-decision', mode: 'exit' } })), stdout: 'pipe', stderr: 'pipe' });
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('recovering');
      reader.releaseLock();
      const before = await snapshot(f.targetRoot);
      const results = await Promise.all([
        childOperation('install', installOptions(f)),
        childOperation('uninstall', { targetRoot: f.targetRoot, owner: f.owner }),
        childOperation('recoverInstall', { targetRoot: f.targetRoot, owner: f.owner, assumeDead: true }),
      ]);
      for (const result of results) expect(hasCode(JSON.parse(result.stdout), 'lock-held')).toBe(true);
      expect(await snapshot(f.targetRoot)).toEqual(before);
    } finally { child.kill('SIGKILL'); await child.exited; }
    expect((await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner })).status).toBe('recovered');
  });

  test.skipIf(process.platform === 'win32').each(['after-move-link', 'after-state-unlink'] as const)('exclusive publication preserves a destination created at %s', async at => {
    const f = await fixture();
    const gate = join(f.base, 'resume');
    const script = `const { install } = await import(${JSON.stringify(installerUrl)});
      const { existsSync } = await import('node:fs');
      const options = JSON.parse(await Bun.stdin.text());
      process.exit = () => {
        console.log('ready');
        while (!existsSync(${JSON.stringify(gate)})) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      };
      console.log(JSON.stringify(await install(options)));`;
    const child = Bun.spawn([process.execPath, '-e', script], { stdin: Buffer.from(JSON.stringify(installOptions(f,
      { failpoints: { at, mode: 'exit' } }))), stdout: 'pipe', stderr: 'pipe' });
    const victim = join(f.targetRoot, at === 'after-move-link' ? 'kernel.md' : CONTROL_STATE_PATH);
    try {
      const reader = child.stdout.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toContain('ready');
      await writeFile(victim, 'user appeared');
      await writeFile(gate, 'resume');
      expect(await child.exited).toBe(0);
      let output = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output += new TextDecoder().decode(chunk.value);
      }
      reader.releaseLock();
      expect(JSON.parse(output).status).toBe('partial');
      expect(await new Response(child.stderr).text()).toBe('');
    } finally { child.kill('SIGKILL'); await child.exited; }
    expect(await readFile(victim, 'utf8')).toBe('user appeared');
    expect((await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner })).status).toBe('partial');
    expect(await readFile(victim, 'utf8')).toBe('user appeared');
  });

  test('a forged journal mode inconsistent with next ownership is refused', async () => {
    const f = await fixture();
    const { records } = await pending(f);
    records[2].entries[0].mode = 0o755;
    await rewriteJournal(f, records);
    const before = await snapshot(f.targetRoot);
    expect(hasCode(await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true }), 'journal-malformed')).toBe(true);
    expect(await snapshot(f.targetRoot)).toEqual(before);
  });
});

describe('coordination evidence boundaries', () => {
  test.each(['symlink', 'hardlink', 'directory', 'corrupt'] as const)('refuses %s coordination evidence without touching its referent', async kind => {
    const f = await fixture();
    await mkdir(join(f.targetRoot, CONTROL_DIR));
    const coordination = join(f.targetRoot, CONTROL_COORDINATION_PATH);
    const outside = join(f.sourceRoot, 'user-data');
    await writeFile(outside, 'keep this data');
    if (kind === 'symlink') await symlink(outside, coordination);
    if (kind === 'hardlink') await link(outside, coordination);
    if (kind === 'directory') await mkdir(coordination);
    if (kind === 'corrupt') await writeFile(coordination, 'not a database');
    expect((await install(installOptions(f))).status).toBe('refused');
    expect(await readFile(outside, 'utf8')).toBe('keep this data');
    expect(await lstat(join(f.targetRoot, 'kernel.md')).catch(() => null)).toBeNull();
    expect(await lstat(join(f.targetRoot, CONTROL_LOCK_PATH)).catch(() => null)).toBeNull();
  });

  test('a legacy interrupted plan with no mode evidence is preserved for manual recovery', async () => {
    const f = await fixture();
    const { records } = await pending(f);
    const plan = records[2];
    plan.entries.forEach((entry: { mode?: number }) => { delete entry.mode; });
    plan.nextState.entries.forEach((entry: { mode?: number }) => { delete entry.mode; });
    await rewriteJournal(f, records);
    const before = await snapshot(f.targetRoot);
    expect((await recoverInstall({ targetRoot: f.targetRoot, owner: f.owner, assumeDead: true })).status).toBe('partial');
    expect(await snapshot(f.targetRoot)).toEqual(before);
  });

  test('aborting in the state publication gap restores prior bytes and executable modes', async () => {
    const f = await fixture();
    await install(installOptions(f, { modes: { 'kernel.md': 0o755 } }));
    const before = await snapshot(f.targetRoot);
    const manifest = await f.restage({ 'kernel.md': 'new' }, 2);
    expect((await install(installOptions(f, { manifest, modes: { 'kernel.md': 0o700 },
      failpoints: { at: 'after-state-unlink', mode: 'abort' } }))).status).toBe('rolled-back');
    expect(await snapshot(f.targetRoot)).toEqual(before);
  });
});
