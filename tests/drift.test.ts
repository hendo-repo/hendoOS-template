import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDrift, checkDriftTargets, type CheckDriftOptions } from '../src/effects/drift';
import { readFileDigest, validateRoots } from '../src/effects/paths';
import { InstallManifestSchema, type InstallManifest } from '../src/schema/install';

const digest = (bytes: string | Uint8Array) => `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture(): Promise<CheckDriftOptions & { manifest: InstallManifest; base: string }> {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'aos-drift-'));
  temporary.push(base);
  const sourceRoot = join(base, 'source');
  const targetRoot = join(base, 'target');
  await mkdir(sourceRoot);
  await mkdir(targetRoot);
  await writeFile(join(sourceRoot, 'input.md'), 'source\n');
  await writeFile(join(targetRoot, 'output.md'), 'output\n');
  return { base, sourceRoot, targetRoot, owner: 'fixture', manifest: {
    schemaVersion: 1, owner: 'fixture', generation: 1, harness: 'example',
    sources: [{ path: 'input.md', digest: digest('source\n') }],
    outputs: [{ path: 'output.md', digest: digest('output\n') }],
  } };
}

// Only API fields cross the strict boundary; fixture metadata is never accepted.
function options(f: Awaited<ReturnType<typeof fixture>>, override: Partial<CheckDriftOptions> = {}): CheckDriftOptions {
  return { sourceRoot: f.sourceRoot, targetRoot: f.targetRoot, owner: f.owner, manifest: f.manifest, ...override };
}

async function snapshot(root: string): Promise<unknown[]> {
  const entries: unknown[] = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name);
    const info = await lstat(path);
    entries.push([name, info.mode, info.ino, info.size, info.mtimeMs, info.ctimeMs,
      info.isDirectory() ? await snapshot(path) : (await readFile(path)).toString('hex')]);
  }
  return entries;
}

describe('install manifest runtime boundary', () => {
  test('accepts a generic strict versioned manifest', async () => {
    const f = await fixture();
    expect(InstallManifestSchema.safeParse(f.manifest).success).toBe(true);
  });
  test.each(['../escape', '/absolute', 'C:/absolute', './output.md', 'a//b', 'a/../b', 'a\\b',
    '__proto__', 'x/constructor', 'prototype/x', 'toString', 'a\n', 'a.', 'a ', 'NUL', '~home', 'e\u0301'])('rejects unsafe path %j', async (path) => {
    const f = await fixture();
    f.manifest.outputs[0]!.path = path;
    expect(InstallManifestSchema.safeParse(f.manifest).success).toBe(false);
  });
  test.each(['duplicate', 'case', 'ancestor', 'component'])('rejects %s conflicts', async (variant) => {
    const f = await fixture();
    const paths = variant === 'duplicate' ? ['a', 'a'] : variant === 'case' ? ['a', 'A']
      : variant === 'ancestor' ? ['a', 'a/b'] : ['Dir/a', 'dir/b'];
    for (const field of ['sources', 'outputs'] as const) {
      expect(InstallManifestSchema.safeParse({ ...f.manifest, [field]: paths.map((path) => ({ path, digest: digest('x') })) }).success).toBe(false);
    }
  });
  test('rejects unknown keys, empty lists, invalid ownership, generation, digest and JSON', async () => {
    const f = await fixture();
    for (const manifest of [null, [], '{broken', {}, { ...f.manifest, unknown: true },
      { ...f.manifest, schemaVersion: 2 }, { ...f.manifest, generation: 0 },
      { ...f.manifest, generation: 1.5 }, { ...f.manifest, owner: '  ' },
      { ...f.manifest, sources: [] }, { ...f.manifest, outputs: [] },
      { ...f.manifest, outputs: [{ ...f.manifest.outputs[0], digest: `${digest('output\n')}\n` }] },
      { ...f.manifest, outputs: [{ ...f.manifest.outputs[0], extra: true }] },
    ]) {
      const report = await checkDrift(options(f, { manifest }));
      expect(report.status).toBe('indeterminate');
      expect(report.checked).toBe(0);
      expect(report.issues[0]!.kind).toBe('malformed');
    }
    expect((await checkDrift(null as unknown as CheckDriftOptions)).status).toBe('indeterminate');
  });
  test('rejects inherited and accessor fields without executing getters or exposing rejected keys', async () => {
    const f = await fixture();
    expect(InstallManifestSchema.safeParse(Object.create(f.manifest)).success).toBe(false);
    let accessed = false;
    const malicious = { ...f.manifest, get generation() { accessed = true; return 1; } };
    expect(InstallManifestSchema.safeParse(malicious).success).toBe(false);
    expect(accessed).toBe(false);
    const report = await checkDrift(options(f, { manifest: { ...f.manifest, 'private-secret-key': 'private-secret-value' } }));
    expect(report.status).toBe('indeterminate');
    expect(JSON.stringify(report)).not.toContain('private-secret');
  });
});

describe('read-only drift', () => {
  test('clean means both inventories checked, with byte and metadata snapshot proof', async () => {
    const f = await fixture();
    const before = await snapshot(f.base);
    const report = await checkDrift(options(f));
    expect(report).toEqual({ status: 'clean', checked: 2, skipped: 0, issues: [], coverage: {
      sources: { expected: 1, checked: 1, skipped: 0 }, outputs: { expected: 1, checked: 1, skipped: 0 },
    } });
    expect(await snapshot(f.base)).toEqual(before);
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
  test.each(['missing-output', 'missing-source', 'modified', 'stale'])('detects %s without repair', async (variant) => {
    const f = await fixture();
    const source = variant.endsWith('source') || variant === 'stale';
    const path = join(source ? f.sourceRoot : f.targetRoot, source ? 'input.md' : 'output.md');
    if (variant.startsWith('missing')) await rm(path);
    else await writeFile(path, 'changed-secret-sentinel');
    const before = await snapshot(f.base);
    const report = await checkDrift(options(f));
    expect(report.status).toBe('drift');
    expect(report.checked).toBe(2);
    expect(report.issues[0]!.kind).toBe(variant === 'stale' ? 'stale' : variant === 'modified' ? 'modified' : 'missing');
    expect(JSON.stringify(report)).not.toContain('changed-secret-sentinel');
    expect(await snapshot(f.base)).toEqual(before);
  });
  test('binary SHA256 hashes bytes without decoding', async () => {
    const f = await fixture();
    const bytes = new Uint8Array([0, 255, 254, 10, 128]);
    await writeFile(join(f.targetRoot, 'output.md'), bytes);
    f.manifest.outputs[0]!.digest = digest(bytes);
    expect((await checkDrift(options(f))).status).toBe('clean');
  });
  test('compares the supplied independent manifest even if target manifest is replaced', async () => {
    const f = await fixture();
    await writeFile(join(f.targetRoot, 'output.md'), 'altered');
    await writeFile(join(f.targetRoot, 'manifest.json'), JSON.stringify({ ...f.manifest, outputs: [{ path: 'output.md', digest: digest('altered') }] }));
    expect((await checkDrift(options(f))).issues[0]!.kind).toBe('modified');
  });
  test('owner mismatch skips coverage; generation mismatch in either direction is stale', async () => {
    const f = await fixture();
    const wrong = await checkDrift(options(f, { owner: 'other' }));
    expect(wrong.status).toBe('indeterminate');
    expect(wrong.issues[0]!.kind).toBe('ownership');
    expect(wrong.skipped).toBe(2);
    f.manifest.generation = 2;
    for (const expectedGeneration of [1, 3]) {
      const report = await checkDrift(options(f, { expectedGeneration }));
      expect(report.status).toBe('drift');
      expect(report.issues[0]!.kind).toBe('stale');
    }
  });
  test('unset or absent explicit target never gives a fresh-install green', async () => {
    const f = await fixture();
    for (const targetRoot of ['', join(f.base, 'absent')]) expect((await checkDrift(options(f, { targetRoot }))).status).toBe('indeterminate');
  });
  test('one unreadable entry dominates known drift', async () => {
    const f = await fixture();
    await rm(join(f.targetRoot, 'output.md'));
    await mkdir(join(f.targetRoot, 'output.md'));
    await writeFile(join(f.sourceRoot, 'input.md'), 'stale');
    const report = await checkDrift(options(f));
    expect(report.status).toBe('indeterminate');
    expect(report.checked).toBe(1);
    expect(report.skipped).toBe(1);
    expect(report.issues.map((issue) => issue.kind)).toEqual(['stale', 'unreadable']);
  });
  test.skipIf(process.platform === 'win32')('permission denial becomes unreadable', async () => {
    const f = await fixture();
    const path = join(f.targetRoot, 'output.md');
    await chmod(path, 0);
    try {
      const report = await checkDrift(options(f));
      // Root can bypass mode bits; that environment cannot prove this control.
      if (process.getuid?.() === 0) expect(report.status).toBe('clean');
      else { expect(report.status).toBe('indeterminate'); expect(report.issues[0]!.kind).toBe('unreadable'); }
    } finally { await chmod(path, 0o600); }
  });
  test('aggregate preserves drift and incomplete coverage, including empty sets', async () => {
    const f = await fixture();
    expect((await checkDriftTargets([])).status).toBe('indeterminate');
    expect((await checkDriftTargets([options(f)])).status).toBe('clean');
    const partial = await checkDriftTargets([options(f), options(f, { targetRoot: join(f.base, 'absent') })]);
    expect(partial.status).toBe('indeterminate');
    expect(partial.checked).toBe(2);
    expect(partial.skipped).toBe(2);
    await writeFile(join(f.targetRoot, 'output.md'), 'changed');
    expect((await checkDriftTargets([options(f)])).status).toBe('drift');
    expect((await checkDriftTargets([options(f), options(f, { manifest: {} })])).status).toBe('indeterminate');
  });
});

describe('filesystem safety primitives', () => {
  test('allows siblings and rejects overlap, physical aliases, and traversal', async () => {
    const f = await fixture();
    expect((await validateRoots(f.sourceRoot, f.targetRoot)).ok).toBe(true);
    await mkdir(join(f.sourceRoot, 'nested'));
    for (const [source, target] of [[f.sourceRoot, f.sourceRoot], [f.sourceRoot, join(f.sourceRoot, 'nested')],
      [join(f.sourceRoot, 'nested'), f.sourceRoot], [f.sourceRoot, `${f.sourceRoot}/../target`],
      [f.sourceRoot, f.sourceRoot.toUpperCase()], ['relative', f.targetRoot]]) {
      expect((await validateRoots(source!, target!)).ok).toBe(false);
    }
    await symlink(f.sourceRoot, join(f.base, 'alias'));
    expect((await validateRoots(f.sourceRoot, join(f.base, 'alias'))).ok).toBe(false);
  });
  test.each(['source-root', 'target-root', 'root-ancestor', 'source-file', 'target-file', 'file-component', 'dangling'])('rejects %s symlinks', async (variant) => {
    const f = await fixture();
    let input = options(f);
    if (variant.endsWith('root')) {
      const root = variant === 'source-root' ? f.sourceRoot : f.targetRoot;
      const alias = join(f.base, 'alias');
      await symlink(root, alias);
      input = options(f, variant === 'source-root' ? { sourceRoot: alias } : { targetRoot: alias });
    } else if (variant === 'root-ancestor') {
      await symlink(f.base, join(f.base, 'alias'));
      input = options(f, { targetRoot: join(f.base, 'alias', 'target') });
    } else if (variant === 'file-component') {
      await symlink(f.sourceRoot, join(f.targetRoot, 'nested'));
      f.manifest.outputs[0]!.path = 'nested/input.md';
    } else {
      const path = variant === 'source-file' ? join(f.sourceRoot, 'input.md') : join(f.targetRoot, 'output.md');
      await rm(path);
      await symlink(variant === 'dangling' ? join(f.base, 'absent') : join(f.base, 'source'), path);
    }
    const report = await checkDrift(input);
    expect(report.status).toBe('indeterminate');
    expect(report.issues.some((issue) => issue.code === 'symlink')).toBe(true);
  });
  test('digest helper rejects escaping paths and non-directory components', async () => {
    const f = await fixture();
    expect((await readFileDigest(f.sourceRoot, '../target/output.md')).ok).toBe(false);
    expect((await readFileDigest(f.sourceRoot, 'input.md/child')).ok).toBe(false);
    expect(await readFileDigest(f.sourceRoot, 'input.md')).toEqual({ ok: true, value: digest('source\n') });
  });
});
