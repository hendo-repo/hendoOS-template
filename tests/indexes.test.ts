/**
 * Bounded generated-index tests.
 *
 * Every case runs against a real SQLite file in a temporary workspace: no
 * in-memory doubles and no ambient home, vault, or content discovery. The CLI
 * cases spawn an actual source-checkout subprocess of `src/edges/indexes.ts`.
 */
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { INDEX_LIMITS, IndexError, IndexStore, parseIndexJson, type IndexReport } from '../src/state/indexes.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
/** `realpathSync` because the CLI refuses an aliased database or output parent. */
function workspace(): string { const dir = realpathSync(mkdtempSync(join(tmpdir(), 'aos-indexes-'))); dirs.push(dir); return dir; }
const dbPath = (dir: string) => join(dir, 'state.sqlite');
const memory = (id: string, extra: Record<string, unknown> = {}) =>
  ({ kind: 'memory', id, reference: `notes/${id}.md`, title: `Note ${id}`, updatedAt: '2026-01-02T03:04:05.000Z', status: 'active' as const, ...extra });
const session = (id: string, extra: Record<string, unknown> = {}) =>
  ({ kind: 'session', id, reference: `sessions/${id}.md`, title: `Session ${id}`, updatedAt: '2026-02-03T04:05:06.000Z',
    status: 'completed' as const, startedAt: '2026-02-01T00:00:00.000Z', ...extra });
const batch = (owner: string, entries: unknown[]) => ({ version: 1, owner, entries });
const options = (owner: string, kind: 'memory' | 'session', extra: Record<string, unknown> = {}) =>
  ({ owner, kind, maxBytes: INDEX_LIMITS.maxBytes, maxLineBytes: INDEX_LIMITS.maxLineBytes, ...extra });
const BYTES = (value: string) => Buffer.byteLength(value, 'utf8');

/** Run `fn`, require an `IndexError`, and return its code. */
function refusalCode(fn: () => unknown): string {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(IndexError);
    return (error as IndexError).code;
  }
  throw new Error('expected an IndexError refusal');
}
function complete(report: IndexReport) {
  expect(report.status).toBe('complete');
  expect(report.artifact).not.toBeNull();
  return report.artifact as NonNullable<IndexReport['artifact']>;
}
function seed(path: string, owner: string, entries: unknown[]) {
  const store = new IndexStore(path, 'write');
  try { return store.import(batch(owner, entries)); } finally { store.close(); }
}

// ---------------------------------------------------------------- persistence

test('imported metadata persists across close, reopen, and a second handle', () => {
  const path = dbPath(workspace());
  expect(seed(path, 'owner_a', [memory('alpha'), session('run_one')])).toEqual({ inserted: 2, replayed: 0 });
  expect(statSync(path).size).toBeGreaterThan(0);
  const first = new IndexStore(path, 'read');
  const second = new IndexStore(path, 'read');
  try {
    expect(first.check({ owner: 'owner_a', kind: 'memory' })).toMatchObject({ status: 'complete', count: 1 });
    expect(second.check({ owner: 'owner_a', kind: 'session' })).toMatchObject({ status: 'complete', count: 1 });
  } finally { first.close(); second.close(); }
  // Exact replay through a fresh writer is idempotent, not duplicated.
  const writer = new IndexStore(path, 'write');
  try {
    expect(writer.import(batch('owner_a', [memory('alpha'), session('run_one')]))).toEqual({ inserted: 0, replayed: 2 });
    expect(writer.check({ owner: 'owner_a', kind: 'memory' }).count).toBe(1);
  } finally { writer.close(); }
});

test('owner and kind namespaces stay isolated', () => {
  const path = dbPath(workspace());
  seed(path, 'owner_a', [memory('shared'), session('shared')]);
  seed(path, 'owner_b', [memory('shared')]);
  const store = new IndexStore(path, 'read');
  try {
    for (const [owner, kind, count] of [['owner_a', 'memory', 1], ['owner_a', 'session', 1], ['owner_b', 'memory', 1], ['owner_b', 'session', 0]] as const) {
      const report = store.generate(options(owner, kind));
      expect(report.count).toBe(count);
      if (count === 1) expect(complete(report).markdown).toContain(`owner: "${owner}"`);
    }
    // An unknown owner is an explicit empty scope, never a silent success.
    const empty = store.generate(options('owner_c', 'memory'));
    expect(empty).toMatchObject({ status: 'empty', count: 0, artifact: null });
    expect(empty.reason).toContain('empty-owner-scope');
  } finally { store.close(); }
});

test('independent writers on one file keep disjoint batches and a closed writer cannot import', () => {
  const path = dbPath(workspace());
  const first = new IndexStore(path, 'write');
  const second = new IndexStore(path, 'write');
  try {
    expect(first.import(batch('owner_a', [memory('alpha')]))).toEqual({ inserted: 1, replayed: 0 });
    expect(second.import(batch('owner_a', [memory('beta')]))).toEqual({ inserted: 1, replayed: 0 });
    expect(second.check({ owner: 'owner_a', kind: 'memory' }).count).toBe(2);
  } finally { first.close(); second.close(); }
  const readOnly = new IndexStore(path, 'read');
  try {
    expect(refusalCode(() => readOnly.import(batch('owner_a', [memory('gamma')])))).toBe('read-only');
    expect(readOnly.check({ owner: 'owner_a', kind: 'memory' }).count).toBe(2);
  } finally { readOnly.close(); }
});

// -------------------------------------------------------------- determinism

test('generation is byte-deterministic and ordered by identifier, not insertion order', () => {
  const path = dbPath(workspace());
  seed(path, 'owner_a', [memory('charlie'), memory('alpha'), memory('bravo')]);
  const render = () => {
    const store = new IndexStore(path, 'read');
    try { return complete(store.generate(options('owner_a', 'memory'))); } finally { store.close(); }
  };
  const first = render(), second = render();
  expect(first.markdown).toBe(second.markdown);
  expect(first.digest).toBe(second.digest);
  expect(first.bytes).toBe(BYTES(first.markdown));
  const order = [...first.markdown.matchAll(/^## (\w+)$/gm)].map(match => match[1]);
  expect(order).toEqual(['alpha', 'bravo', 'charlie']);
  // Declared status and reference are metadata, never verified claims.
  expect(first.markdown).toContain('References and completion claims are not verified.');
});

test('session entries carry both timestamps; memory entries do not', () => {
  const path = dbPath(workspace());
  seed(path, 'owner_a', [session('run_one')]);
  const store = new IndexStore(path, 'read');
  try {
    const markdown = complete(store.generate(options('owner_a', 'session'))).markdown;
    expect(markdown).toContain('- Started: 2026-02-01T00:00:00.000Z');
    expect(markdown).toContain('- Updated: 2026-02-03T04:05:06.000Z');
    expect(markdown).not.toContain('- Started: 2026-01-02T03:04:05.000Z');
  } finally { store.close(); }
});

// --------------------------------------------------- rejection: entry fields

test('malformed identifiers, references, statuses, and timestamps are refused', () => {
  const path = dbPath(workspace());
  const store = new IndexStore(path, 'write');
  const cases: Array<[string, unknown, string?]> = [
    ['id-uppercase', memory('Alpha')],
    ['id-space', memory('a b')],
    ['id-empty', memory('')],
    ['id-control', memory('alpha\u0000')],
    ['reference-escape', memory('alpha', { reference: '../secrets.md' })],
    ['reference-absolute', memory('alpha', { reference: '/etc/passwd' })],
    ['reference-dot-segment', memory('alpha', { reference: 'notes/./alpha.md' })],
    ['reference-uppercase', memory('alpha', { reference: 'Notes/Alpha.md' })],
    ['reference-reserved', memory('alpha', { reference: 'con.md' })],
    ['reference-trailing-dot', memory('alpha', { reference: 'notes/alpha.' })],
    ['reference-query', memory('alpha', { reference: 'notes/alpha.md?x=1' })],
    ['reference-backslash', memory('alpha', { reference: 'notes\\alpha.md' })],
    ['reference-scheme', memory('alpha', { reference: 'file:///etc/passwd' })],
    ['status-unknown', memory('alpha', { status: 'verified' })],
    ['status-number', memory('alpha', { status: 1 })],
    ['timestamp-offset', memory('alpha', { updatedAt: '2026-01-02T03:04:05.000+00:00' })],
    ['timestamp-date-only', memory('alpha', { updatedAt: '2026-01-02' })],
    ['timestamp-impossible', memory('alpha', { updatedAt: '2026-02-31T00:00:00.000Z' })],
    ['session-order', session('run_one', { startedAt: '2026-02-04T00:00:00.000Z' })],
    ['unknown-field', memory('alpha', { note: 'extra' })],
    // A dropped field leaves a non-plain value behind, refused before schema parsing.
    ['missing-field', { ...memory('alpha'), title: undefined }, 'plain-data-required'],
    ['undefined-input', undefined, 'plain-data-required'],
    ['null-input', null, 'invalid-input'],
  ];
  try {
    for (const [label, entry, expected] of cases) {
      expect(`${label}:${refusalCode(() => store.import(batch('owner_a', [entry])))}`).toBe(`${label}:${expected ?? 'invalid-input'}`);
    }
    expect(store.check({ owner: 'owner_a', kind: 'memory' })).toMatchObject({ status: 'empty', count: 0 });
  } finally { store.close(); }
});

test('titles and owner tokens reject structure, control, and decomposition', () => {
  const path = dbPath(workspace());
  const store = new IndexStore(path, 'write');
  try {
    for (const title of ['', ' padded', 'trailing ', 'line\nbreak', 'tab\there', 'zero\u200bwidth', 'nul\u0000byte', 'line\u2028separator', 'e\u0301']) {
      expect(`${title.replace(/[^\x20-\x7e]/g, '#')}:${refusalCode(() => store.import(batch('owner_a', [memory('alpha', { title })])))}`)
        .toBe(`${title.replace(/[^\x20-\x7e]/g, '#')}:invalid-input`);
    }
    expect(refusalCode(() => store.import(batch('Owner_A', [memory('alpha')])))).toBe('invalid-input');
    expect(refusalCode(() => store.import(batch('owner_a', [memory('alpha', { title: 'e\u0301' })])))).toBe('invalid-input');
    // A single-field violation refuses the whole batch and stores nothing.
    expect(store.check({ owner: 'owner_a', kind: 'memory' })).toMatchObject({ status: 'empty', count: 0 });
  } finally { store.close(); }
});

test('oversized fields, entry counts, and request bodies are refused before storage', () => {
  const path = dbPath(workspace());
  const store = new IndexStore(path, 'write');
  try {
    expect(refusalCode(() => store.import(batch('owner_a', [memory('alpha', { title: 'x'.repeat(241) })])))).toBe('invalid-input');
    expect(refusalCode(() => store.import(batch('owner_a', [memory('alpha', { reference: `notes/${'a'.repeat(240)}.md` })])))).toBe('invalid-input');
    expect(refusalCode(() => store.import(batch('owner_a', [])))).toBe('invalid-input');
    expect(refusalCode(() => store.import(batch('owner_a', [memory('a'.repeat(65))])))).toBe('invalid-input');
    const tooMany = Array.from({ length: INDEX_LIMITS.entries + 1 }, (_value, index) => memory(`e${index}`));
    expect(refusalCode(() => store.import(batch('owner_a', tooMany)))).toBe('invalid-input');
    expect(store.check({ owner: 'owner_a', kind: 'memory' }).count).toBe(0);
  } finally { store.close(); }
});

test('duplicate identifiers and reused references inside one batch are refused', () => {
  const path = dbPath(workspace());
  const store = new IndexStore(path, 'write');
  try {
    expect(refusalCode(() => store.import(batch('owner_a', [memory('alpha'), memory('alpha')])))).toBe('duplicate-entry');
    expect(refusalCode(() => store.import(batch('owner_a',
      [memory('alpha'), memory('bravo', { reference: 'notes/alpha.md' })])))).toBe('duplicate-entry');
    // Distinct namespaces are not duplicates.
    expect(store.import(batch('owner_a', [memory('alpha'), session('alpha')]))).toEqual({ inserted: 2, replayed: 0 });
  } finally { store.close(); }
});

test('changed payloads and reused references across batches are conflicts', () => {
  const path = dbPath(workspace());
  const store = new IndexStore(path, 'write');
  try {
    store.import(batch('owner_a', [memory('alpha')]));
    expect(refusalCode(() => store.import(batch('owner_a', [memory('alpha', { title: 'Rewritten' })])))).toBe('entry-conflict');
    expect(refusalCode(() => store.import(batch('owner_a', [memory('bravo', { reference: 'notes/alpha.md' })])))).toBe('entry-conflict');
    expect(store.check({ owner: 'owner_a', kind: 'memory' }).count).toBe(1);
  } finally { store.close(); }
});

test('only plain data is accepted: accessors, prototypes, and non-finite numbers refuse', () => {
  const path = dbPath(workspace());
  const store = new IndexStore(path, 'write');
  const withGetter = { ...memory('alpha'), get reference() { return 'notes/alpha.md'; } };
  class Entry { kind = 'memory'; id = 'alpha'; reference = 'notes/alpha.md'; title = 'Alpha'; status = 'active'; updatedAt = '2026-01-02T03:04:05.000Z'; }
  const cyclic: Record<string, unknown> = batch('owner_a', [memory('alpha')]);
  cyclic.self = cyclic;
  try {
    for (const [label, input, expected] of [
      ['getter', batch('owner_a', [withGetter])],
      ['class-instance', batch('owner_a', [new Entry()])],
      ['date-instance', batch('owner_a', [memory('alpha', { updatedAt: new Date() as unknown as string })])],
      ['nan', batch('owner_a', [memory('alpha', { updatedAt: Number.NaN as unknown as string })])],
      // Cycles and accessors are caught by the pre-parse structure pass.
      ['cyclic', cyclic, 'input-complexity'],
      ['getter-cycle', { version: 1, owner: 'owner_a', entries: [withGetter] }, 'plain-data-required'],
      ['array-holes', { version: 1, owner: 'owner_a', entries: new Array(2) }],
      ['map', batch('owner_a', [memory('alpha', { title: new Map() as unknown as string })])],
    ] as Array<[string, unknown, string?]>) {
      expect(`${label}:${refusalCode(() => store.import(input))}`).toBe(`${label}:${expected ?? 'plain-data-required'}`);
    }
    expect(refusalCode(() => store.import(null))).toBe('invalid-input');
    expect(store.check({ owner: 'owner_a', kind: 'memory' }).count).toBe(0);
  } finally { store.close(); }
});

test('JSON text with duplicate keys or excess depth is refused', () => {
  const path = dbPath(workspace());
  const store = new IndexStore(path, 'write');
  try {
    expect(refusalCode(() => store.import(parseIndexJson('{"version":1,"owner":"owner_a","owner":"owner_b","entries":[]}'))))
      .toBe('duplicate-json-key');
    expect(refusalCode(() => parseIndexJson('['.repeat(10) + ']'.repeat(10)))).toBe('input-complexity');
    expect(refusalCode(() => parseIndexJson('{"bad":'))).toBe('invalid-json');
    expect(refusalCode(() => parseIndexJson('{'.repeat(9)))).toBe('invalid-json');
    expect(refusalCode(() => parseIndexJson('x'.repeat(INDEX_LIMITS.requestBytes + 1)))).toBe('input-bytes');
    expect(refusalCode(() => store.check({ owner: 'owner_a', kind: 'memory', extra: 1 }))).toBe('invalid-input');
  } finally { store.close(); }
});

// ------------------------------------------------ rejection: scopes and state

test('invalid scopes, limits, database paths, and modes are refused', () => {
  const dir = workspace();
  for (const [label, run] of [
    ['memory-database', () => new IndexStore(':memory:')],
    ['file-uri', () => new IndexStore('file:/tmp/state.sqlite')],
    ['empty-path', () => new IndexStore('')],
    ['control-path', () => new IndexStore(`${dir}/sta\u0000te.sqlite`)],
    ['bad-mode', () => new IndexStore(join(dir, 'state.sqlite'), 'append' as 'read')],
  ] as Array<[string, () => unknown]>) {
    expect(`${label}:${refusalCode(run)}`).toBe(`${label}:explicit-database-required`);
  }
  const store = new IndexStore(dbPath(dir), 'write');
  try {
    expect(refusalCode(() => store.check({ owner: 'owner_a', kind: 'notes' }))).toBe('invalid-input');
    expect(refusalCode(() => store.generate(options('owner_a', 'memory', { maxBytes: 0 })))).toBe('invalid-input');
    expect(refusalCode(() => store.generate(options('owner_a', 'memory', { maxLineBytes: INDEX_LIMITS.maxLineBytes + 1 })))).toBe('invalid-input');
    expect(refusalCode(() => store.generate({ owner: 'owner_a', kind: 'memory' }))).toBe('invalid-input');
  } finally { store.close(); }
});

// ------------------------------------------------------------- bounds/output

test('the entry ceiling fails closed with no artifact instead of a dropped prefix', () => {
  const path = dbPath(workspace());
  const exactly = INDEX_LIMITS.entries;
  seed(path, 'owner_a', Array.from({ length: exactly }, (_value, index) => memory(`e${String(index).padStart(3, '0')}`)));
  seed(path, 'owner_a', [memory('zzz_overflow')]);
  const store = new IndexStore(path, 'read');
  try {
    const report = store.generate(options('owner_a', 'memory'));
    expect(report).toMatchObject({ schema: 'aos.index/v1', status: 'incomplete', artifact: null, count: exactly + 1 });
    expect(report.reason).toContain('entry-limit');
    expect(report.reason).toContain('paging or on-demand');
    const bounded = new IndexStore(dbPath(workspace()), 'write');
    try {
      bounded.import(batch('owner_b', Array.from({ length: exactly }, (_value, index) => memory(`e${String(index).padStart(3, '0')}`))));
      expect(bounded.check({ owner: 'owner_b', kind: 'memory' })).toMatchObject({ status: 'complete', count: exactly });
    } finally { bounded.close(); }
  } finally { store.close(); }
});

test('byte and line ceilings are exact and fail closed on overflow', () => {
  const path = dbPath(workspace());
  seed(path, 'owner_a', [memory('alpha', { title: 'Line length probe '.repeat(12).trim() })]);
  const store = new IndexStore(path, 'read');
  try {
    const artifact = complete(store.generate(options('owner_a', 'memory')));
    expect(complete(store.generate(options('owner_a', 'memory', { maxBytes: artifact.bytes, maxLineBytes: artifact.maxLineBytes }))).bytes)
      .toBe(artifact.bytes);
    const overBytes = store.generate(options('owner_a', 'memory', { maxBytes: artifact.bytes - 1 }));
    expect(overBytes).toMatchObject({ status: 'incomplete', artifact: null, count: 1 });
    expect(overBytes.reason).toContain('output-limit');
    const overLine = store.generate(options('owner_a', 'memory', { maxLineBytes: artifact.maxLineBytes - 1 }));
    expect(overLine).toMatchObject({ status: 'incomplete', artifact: null, count: 1 });
    // Every emitted line is within the ceiling that produced a complete artifact.
    for (const line of artifact.markdown.split('\n')) expect(BYTES(line)).toBeLessThanOrEqual(artifact.maxLineBytes);
  } finally { store.close(); }
});

test('stored payloads that no longer match their row fail closed, never partially', () => {
  const path = dbPath(workspace());
  seed(path, 'owner_a', [memory('alpha'), memory('bravo')]);
  const raw = new Database(path, { create: true, strict: true });
  try {
    raw.query(`UPDATE aos_index_entries_v1 SET payload=? WHERE owner='owner_a' AND id='bravo'`).run('{"junk":true}');
  } finally { raw.close(); }
  const store = new IndexStore(path, 'read');
  try {
    const report = store.generate(options('owner_a', 'memory'));
    expect(report).toMatchObject({ status: 'incomplete', artifact: null, count: 2 });
    expect(report.reason).toBe('malformed-state');
    expect(store.check({ owner: 'owner_a', kind: 'memory' })).toMatchObject({ status: 'incomplete', artifact: null });
  } finally { store.close(); }
  // A payload that disagrees with its indexed reference is malformed as well.
  const tampered = dbPath(workspace());
  seed(tampered, 'owner_a', [memory('alpha')]);
  const second = new Database(tampered, { create: true, strict: true });
  try {
    const payload = JSON.stringify({ kind: 'memory', id: 'alpha', reference: 'notes/other.md', title: 'Note alpha',
      updatedAt: '2026-01-02T03:04:05.000Z', status: 'active' });
    second.query(`UPDATE aos_index_entries_v1 SET payload=? WHERE owner='owner_a' AND id='alpha'`).run(payload);
  } finally { second.close(); }
  const reader = new IndexStore(tampered, 'read');
  try { expect(reader.generate(options('owner_a', 'memory')).reason).toBe('malformed-state'); } finally { reader.close(); }
});

test('a payload beyond the stored size bound is rejected by the schema, not truncated', () => {
  const path = dbPath(workspace());
  seed(path, 'owner_a', [memory('alpha')]);
  const raw = new Database(path, { create: true, strict: true });
  let refused = '';
  try {
    const oversized = JSON.stringify({ ...memory('alpha'), title: 'x'.repeat(5000) });
    try { raw.query(`UPDATE aos_index_entries_v1 SET payload=? WHERE owner='owner_a' AND id='alpha'`).run(oversized); }
    catch (error) { refused = String(error); }
  } finally { raw.close(); }
  expect(refused).not.toBe('');
  const store = new IndexStore(path, 'read');
  try { expect(store.generate(options('owner_a', 'memory')).status).toBe('complete'); } finally { store.close(); }
});

test('generated Markdown cannot be turned into structure or links by metadata', () => {
  const path = dbPath(workspace());
  const hostile = 'x ](https://host.invalid) <script>alert(1)</script> `code` --- # heading ![img](x)';
  seed(path, 'owner_a', [memory('alpha', { title: hostile }), memory('bravo', { title: 'Plain **bold** [link](x)' })]);
  const store = new IndexStore(path, 'read');
  try {
    const { markdown } = complete(store.generate(options('owner_a', 'memory')));
    expect(markdown).not.toContain('<script>');
    expect(markdown).not.toContain('](https://host.invalid)');
    expect(markdown).not.toContain('**bold**');
    expect(markdown).not.toContain('![img]');
    expect(markdown).not.toContain('`code`');
    expect(markdown).not.toContain(hostile);
    expect(markdown).not.toContain('<');
    expect(markdown).not.toContain('>');
    // Frontmatter stays a fixed, quoted shape regardless of metadata content.
    const frontmatter = markdown.split('---\n')[1]?.trimEnd().split('\n') ?? [];
    expect(frontmatter.map(line => line.split(':')[0])).toEqual(['schema', 'generated_by', 'owner', 'kind', 'status', 'count', 'source_digest']);
    expect(markdown.match(/^---$/gm)).toHaveLength(2);
    // Titles stay visible and readable: escaping must not drop the entry.
    expect(markdown).toContain('- Title:');
    expect(markdown).toContain('&#91;link&#93;');
  } finally { store.close(); }
});

// ------------------------------------------------------------ import deadline

test('a passed deadline aborts an import with no partial writes', () => {
  const path = dbPath(workspace());
  const store = new IndexStore(path, 'write');
  try {
    expect(refusalCode(() => store.import(batch('owner_a', [memory('alpha'), memory('bravo')]), 0))).toBe('timeout');
    expect(store.check({ owner: 'owner_a', kind: 'memory' })).toMatchObject({ status: 'empty', count: 0 });
  } finally { store.close(); }
  const verify = new IndexStore(path, 'read');
  try { expect(verify.check({ owner: 'owner_a', kind: 'memory' }).count).toBe(0); } finally { verify.close(); }
});

test('a conflict in the middle of a batch rolls the whole batch back', () => {
  const path = dbPath(workspace());
  seed(path, 'owner_a', [memory('alpha')]);
  const store = new IndexStore(path, 'write');
  try {
    expect(refusalCode(() => store.import(batch('owner_a', [memory('bravo'), memory('alpha', { title: 'Changed' })]))))
      .toBe('entry-conflict');
    const ids = store.generate(options('owner_a', 'memory'));
    expect(ids.count).toBe(1);
    expect(ids.artifact?.markdown).not.toContain('bravo');
  } finally { store.close(); }
  seed(path, 'owner_a', [memory('bravo')]);
  const reopened = new IndexStore(path, 'read');
  try { expect(reopened.check({ owner: 'owner_a', kind: 'memory' }).count).toBe(2); } finally { reopened.close(); }
});

// ------------------------------------------------------------------ CLI edge

interface Run { code: number; stdout: string; stderr: string; json: Record<string, unknown> }
async function cli(dir: string, request: unknown, extra: string[] = []): Promise<Run> {
  const file = join(dir, `request-${crypto.randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(request));
  const child = Bun.spawn([process.execPath, 'src/edges/indexes.ts', '--request', file, ...extra],
    { cwd: resolve('.'), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { code, stdout, stderr, json: JSON.parse(stdout) as Record<string, unknown> };
}
const tempFiles = (dir: string) => readdirSync(dir).filter(name => name.startsWith('.aos-index-'));

test('source-checkout CLI imports, generates, checks, and reports complete results', async () => {
  const dir = workspace();
  const database = dbPath(dir), output = join(dir, 'memory.md');
  const imported = await cli(dir, { action: 'import', database, batch: batch('owner_a', [memory('alpha'), memory('bravo')]) });
  expect(imported.code).toBe(0);
  expect(imported.json).toMatchObject({ schema: 'aos.index-cli/v1', status: 'complete', action: 'import', inserted: 2, replayed: 0 });
  expect(imported.stderr).toBe('');
  expect(BYTES(imported.stdout)).toBeLessThanOrEqual(INDEX_LIMITS.frameBytes);

  const generated = await cli(dir, { action: 'generate', database, output, options: options('owner_a', 'memory') });
  expect(generated.code).toBe(0);
  const artifact = generated.json.artifact as { digest: string; bytes: number; maxLineBytes: number };
  const published = readFileSync(output, 'utf8');
  expect(artifact.bytes).toBe(BYTES(published));
  expect(artifact.bytes).toBe(statSync(output).size);
  expect(published.startsWith('---\n')).toBe(true);
  expect(tempFiles(dir)).toEqual([]);
  // Ownership: a create-only link, private mode, single link, no leftover temp.
  const stat = statSync(output);
  expect(stat.isFile()).toBe(true);
  expect(stat.nlink).toBe(1);
  if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);

  const checked = await cli(dir, { action: 'check', database, scope: { owner: 'owner_a', kind: 'memory' } });
  expect(checked.code).toBe(0);
  expect(checked.json).toMatchObject({ action: 'check', status: 'complete', count: 2, artifact: null });

  // stdin framing is equivalent to the file form.
  const child = Bun.spawn([process.execPath, 'src/edges/indexes.ts', '--request', '-'],
    { cwd: resolve('.'), stdin: new TextEncoder().encode(JSON.stringify({ action: 'check', database, scope: { owner: 'owner_a', kind: 'session' } })),
      stdout: 'pipe', stderr: 'pipe' });
  const [out, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(1);
  expect(JSON.parse(out)).toMatchObject({ action: 'check', status: 'empty', reason: 'empty-owner-scope; completeness unknown' });
});

test('CLI refuses to overwrite an unowned output and preserves it byte for byte', async () => {
  const dir = workspace();
  const database = dbPath(dir), output = join(dir, 'memory.md');
  await cli(dir, { action: 'import', database, batch: batch('owner_a', [memory('alpha')]) });
  const first = await cli(dir, { action: 'generate', database, output, options: options('owner_a', 'memory') });
  expect(first.code).toBe(0);
  const before = readFileSync(output);
  const foreign = join(dir, 'owned.md');
  writeFileSync(foreign, 'Hand-written note. Not generated.\n');
  const foreignBefore = readFileSync(foreign);

  const clash = await cli(dir, { action: 'generate', database, output, options: options('owner_a', 'memory') });
  expect(clash.code).toBe(1);
  expect(clash.json).toMatchObject({ status: 'incomplete', artifact: null, reason: 'output-exists' });
  expect(clash.stderr).toContain('Index refused: output-exists');
  expect(readFileSync(output)).toEqual(before);

  const unowned = await cli(dir, { action: 'generate', database, output: foreign, options: options('owner_a', 'memory') });
  expect(unowned.code).toBe(1);
  expect(unowned.json.reason).toBe('output-exists');
  expect(readFileSync(foreign)).toEqual(foreignBefore);
  expect(tempFiles(dir)).toEqual([]);
});

test('concurrent index publishers elect one winner and refuse the stale writer', async () => {
  const dir = workspace();
  const database = dbPath(dir), output = join(dir, 'memory.md');
  await cli(dir, { action: 'import', database, batch: batch('owner_a', [memory('alpha'), memory('bravo')]) });

  const request = { action: 'generate', database, output, options: options('owner_a', 'memory') };
  const results = await Promise.all([cli(dir, request), cli(dir, request)]);
  expect(results.map(result => result.code).sort()).toEqual([0, 1]);
  expect(results.find(result => result.code === 1)?.json.reason).toBe('output-exists');

  const winner = results.find(result => result.code === 0)!;
  const artifact = winner.json.artifact as { digest: string; bytes: number };
  const published = readFileSync(output, 'utf8');
  expect(artifact.bytes).toBe(BYTES(published));
  expect(published).toContain('## alpha');
  expect(published).toContain('## bravo');
  expect(tempFiles(dir)).toEqual([]);
});

test('CLI leaves no artifact when output limits or input validation fail', async () => {
  const dir = workspace();
  const database = dbPath(dir), bounded = join(dir, 'bounded.md'), invalid = join(dir, 'invalid.md');
  await cli(dir, { action: 'import', database, batch: batch('owner_a', [memory('alpha', { title: 'Probe '.repeat(40).trim() })]) });
  writeFileSync(invalid, 'Pre-existing file. Preserve me.\n');
  const invalidBefore = readFileSync(invalid);

  const overflow = await cli(dir, { action: 'generate', database, output: bounded, options: options('owner_a', 'memory', { maxBytes: 64 }) });
  expect(overflow.code).toBe(1);
  expect(overflow.json).toMatchObject({ status: 'incomplete', artifact: null, count: 1 });
  expect(String(overflow.json.reason)).toContain('output-limit');
  expect(overflow.stderr).toContain('Index incomplete');
  expect(existsSync(bounded)).toBe(false);
  expect(tempFiles(dir)).toEqual([]);

  const malformed = await cli(dir, { action: 'generate', database, output: invalid, options: { ...options('owner_a', 'memory'), surprise: true } });
  expect(malformed.code).toBe(1);
  expect(malformed.json).toMatchObject({ status: 'incomplete', artifact: null, reason: 'invalid-input' });
  expect(readFileSync(invalid)).toEqual(invalidBefore);
  expect(tempFiles(dir)).toEqual([]);
  expect(readdirSync(dir).some(name => name.includes('surprise'))).toBe(false);
});

test('CLI bounds request size, timeout, and usage with JSON-only stdout', async () => {
  const dir = workspace();
  const database = dbPath(dir);
  const oversized = join(dir, 'oversized.json');
  writeFileSync(oversized, JSON.stringify({ action: 'check', database, scope: { owner: 'owner_a', kind: 'memory' }, pad: 'x'.repeat(INDEX_LIMITS.requestBytes) }));
  const child = Bun.spawn([process.execPath, 'src/edges/indexes.ts', '--request', oversized], { cwd: resolve('.'), stdout: 'pipe', stderr: 'pipe' });
  const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(code).toBe(1);
  expect(JSON.parse(out)).toMatchObject({ status: 'incomplete', reason: 'input-file-limit', artifact: null });
  expect(err).toContain('Index refused');

  const huge = Bun.spawn([process.execPath, 'src/edges/indexes.ts', '--request', '-'],
    { cwd: resolve('.'), stdin: new TextEncoder().encode('x'.repeat(INDEX_LIMITS.requestBytes + 16)), stdout: 'pipe', stderr: 'pipe' });
  const [hugeOut, , hugeCode] = await Promise.all([new Response(huge.stdout).text(), new Response(huge.stderr).text(), huge.exited]);
  expect(hugeCode).toBe(1);
  expect(JSON.parse(hugeOut).reason).toBe('input-bytes');

  const missing = await cli(dir, { action: 'check', database, scope: { owner: 'owner_a', kind: 'memory' } });
  expect(missing.code).toBe(1);
  expect(['io-or-state-error', 'invalid-input']).toContain(missing.json.reason as string);

  const noArgs = Bun.spawn([process.execPath, 'src/edges/indexes.ts'], { cwd: resolve('.'), stdout: 'pipe', stderr: 'pipe' });
  const [noArgsOut, , noArgsCode] = await Promise.all([new Response(noArgs.stdout).text(), new Response(noArgs.stderr).text(), noArgs.exited]);
  expect(noArgsCode).toBe(1);
  expect(JSON.parse(noArgsOut).reason).toBe('usage');

  await cli(dir, { action: 'import', database, batch: batch('owner_a', [memory('alpha')]) });
  for (const timeout of ['0', '10001', 'later']) {
    const bounded = await cli(dir, { action: 'check', database, scope: { owner: 'owner_a', kind: 'memory' } }, ['--timeout-ms', timeout]);
    expect(bounded.code).toBe(1);
    expect(bounded.json.reason).toBe('timeout-limit');
  }
  const valid = await cli(dir, { action: 'check', database, scope: { owner: 'owner_a', kind: 'memory' } }, ['--timeout-ms', '10000']);
  expect(valid.code).toBe(0);
});

test('CLI refuses aliased database parents, links, and symlinked outputs', async () => {
  const dir = workspace();
  const database = dbPath(dir);
  await cli(dir, { action: 'import', database, batch: batch('owner_a', [memory('alpha')]) });
  const aliasDir = join(dir, 'alias');
  const { symlinkSync, mkdirSync } = await import('node:fs');
  mkdirSync(aliasDir);
  symlinkSync(dir, join(aliasDir, 'link'));
  const aliased = await cli(dir, { action: 'check', database: join(aliasDir, 'link', 'state.sqlite'), scope: { owner: 'owner_a', kind: 'memory' } });
  expect(aliased.code).toBe(1);
  expect(aliased.json.reason).toBe('database-parent-alias');
  // An output that is already a symlink is never followed or replaced.
  const output = join(dir, 'link.md');
  const target = join(dir, 'real.md');
  writeFileSync(target, 'target content\n');
  symlinkSync(target, output);
  const refused = await cli(dir, { action: 'generate', database, output, options: options('owner_a', 'memory') });
  expect(refused.code).toBe(1);
  expect(['output-parent-alias', 'output-exists']).toContain(refused.json.reason as string);
  expect(readFileSync(target, 'utf8')).toBe('target content\n');
});
