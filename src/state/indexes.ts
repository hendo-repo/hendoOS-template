/** Generated indexes contain pointer metadata only; referenced prose stays plaintext. */
import { Database } from 'bun:sqlite';
import { z } from 'zod';
import { canonicalize, digestOfString } from '../protocols/json';

export const INDEX_LIMITS = Object.freeze({ entries: 256, requestBytes: 262144, frameBytes: 4096,
  maxBytes: 131072, maxLineBytes: 4096, timeoutMs: 5000 });
export class IndexError extends Error {
  constructor(readonly code: string) { super(code); }
}
const bytes = (value: string) => Buffer.byteLength(value, 'utf8');
const token = z.string().max(64).regex(/^[a-z0-9][a-z0-9_-]*(?![\s\S])/);
const timestamp = z.string().refine(value => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
  Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
const reference = z.string().max(240).refine(value => value.split('/').every(segment =>
  /^[a-z0-9][a-z0-9._-]*(?![\s\S])/.test(segment) && !segment.endsWith('.') &&
  !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/.test(segment)));
const title = z.string().min(1).max(240).refine(value => value.trim() === value &&
  value.normalize('NFC') === value && !/[\p{C}\p{Zl}\p{Zp}]/u.test(value) && bytes(value) <= 512);
const common = { id: token, reference, title, updatedAt: timestamp };
export const IndexEntrySchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('memory'), status: z.enum(['active', 'stale', 'unavailable']) }),
  z.strictObject({ ...common, kind: z.literal('session'), status: z.enum(['active', 'blocked', 'completed', 'abandoned']),
    startedAt: timestamp }).refine(entry => entry.startedAt <= entry.updatedAt),
]);
export const ImportIndexSchema = z.strictObject({ version: z.literal(1), owner: token,
  entries: z.array(IndexEntrySchema).min(1).max(INDEX_LIMITS.entries) });
export const IndexScopeSchema = z.strictObject({ owner: token, kind: z.enum(['memory', 'session']) });
export const GenerateIndexSchema = IndexScopeSchema.extend({
  maxBytes: z.int().min(1).max(INDEX_LIMITS.maxBytes),
  maxLineBytes: z.int().min(1).max(INDEX_LIMITS.maxLineBytes),
});
export type IndexEntry = z.infer<typeof IndexEntrySchema>;
export type IndexScope = z.infer<typeof IndexScopeSchema>;
export type IndexReport = { schema: 'aos.index/v1'; status: 'complete' | 'empty' | 'incomplete';
  reason: string; count: number; artifact: null | { markdown: string; digest: string; bytes: number; maxLineBytes: number } };

/** Bound inspection before schema parsing. Never invoke getters or toJSON. */
export function parseIndexInput<T>(schema: z.ZodType<T>, input: unknown): T {
  let nodes = 0;
  function visit(value: unknown, depth: number): void {
    if (++nodes > 10000 || depth > 8) throw new IndexError('input-complexity');
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (typeof value === 'string' && value.length <= INDEX_LIMITS.requestBytes) return;
    if (typeof value !== 'object' || value === null) throw new IndexError('plain-data-required');
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null && !(Array.isArray(value) && proto === Array.prototype)) {
      throw new IndexError('plain-data-required');
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) throw new IndexError('plain-data-required');
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (Array.isArray(value) && key === 'length') continue;
      if (!descriptor.enumerable || !('value' in descriptor)) throw new IndexError('plain-data-required');
      visit(descriptor.value, depth + 1);
    }
    if (Array.isArray(value) && (value.length > 10000 || Object.keys(value).length !== value.length)) {
      throw new IndexError('plain-data-required');
    }
  }
  try {
    visit(input, 0);
    const result = schema.safeParse(input);
    if (!result.success) throw new IndexError('invalid-input');
    if (bytes(JSON.stringify(result.data)) > INDEX_LIMITS.requestBytes) throw new IndexError('input-bytes');
    return result.data;
  } catch (error) {
    if (error instanceof IndexError) throw error;
    throw new IndexError('invalid-input');
  }
}

/** JSON.parse checks grammar; the token pass additionally rejects duplicate object keys. */
export function parseIndexJson(text: string): unknown {
  if (bytes(text) > INDEX_LIMITS.requestBytes) throw new IndexError('input-bytes');
  try {
    const value: unknown = JSON.parse(text);
    const stack: (Set<string> | null)[] = [];
    const tokens = text.match(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? [];
    for (let i = 0; i < tokens.length; i++) {
      const part = tokens[i]!;
      if (part === '{' || part === '[') {
        stack.push(part === '{' ? new Set() : null);
        if (stack.length > 8) throw new IndexError('input-complexity');
      } else if (part === '}' || part === ']') stack.pop();
      else if (part.startsWith('"') && tokens[i + 1] === ':') {
        const keys = stack.at(-1);
        const key = JSON.parse(part) as string;
        if (!keys || keys.has(key)) throw new IndexError('duplicate-json-key');
        keys.add(key);
      }
    }
    return value;
  } catch (error) {
    if (error instanceof IndexError) throw error;
    throw new IndexError('invalid-json');
  }
}

type Row = { owner: string; kind: string; id: string; reference: string; payload: string | null };
const incomplete = (reason: string, count: number): IndexReport =>
  ({ schema: 'aos.index/v1', status: 'incomplete', reason, count, artifact: null });
// Encode punctuation as entities: metadata cannot become links, HTML, or Markdown structure.
const literal = (value: string) => value.replace(/[!-/:-@\[-`{-~]/g, char => `&#${char.charCodeAt(0)};`);

export class IndexStore {
  private readonly db: Database;
  constructor(path: string, private readonly mode: 'read' | 'write' = 'read') {
    if (typeof path !== 'string' || !path || path.length > 4096 || /[\u0000-\u001f]/.test(path) ||
        path.startsWith(':') || path.startsWith('file:') || !['read', 'write'].includes(mode)) {
      throw new IndexError('explicit-database-required');
    }
    this.db = new Database(path, mode === 'read' ? { readonly: true, strict: true } : { create: true, strict: true });
    try {
      this.db.exec('PRAGMA busy_timeout=100');
      if (mode === 'read') this.db.exec('PRAGMA query_only=ON');
      else this.db.exec(`CREATE TABLE IF NOT EXISTS aos_index_entries_v1 (
        owner TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('memory','session')),
        id TEXT NOT NULL, reference TEXT NOT NULL,
        payload TEXT NOT NULL CHECK(length(CAST(payload AS BLOB)) <= 4096),
        PRIMARY KEY(owner,kind,id), UNIQUE(owner,kind,reference)
      )`);
    } catch (error) { this.db.close(); throw error; }
  }

  /** Immutable import: exact replays succeed; changed IDs/reused references conflict atomically. */
  import(input: unknown, deadline = Infinity): { inserted: number; replayed: number } {
    if (this.mode !== 'write') throw new IndexError('read-only');
    const batch = parseIndexInput(ImportIndexSchema, input);
    const ids = new Set<string>(), references = new Set<string>();
    for (const entry of batch.entries) {
      const id = `${entry.kind}/${entry.id}`, ref = `${entry.kind}/${entry.reference}`;
      if (ids.has(id) || references.has(ref)) throw new IndexError('duplicate-entry');
      ids.add(id); references.add(ref);
    }
    return this.db.transaction(() => {
      let inserted = 0, replayed = 0;
      for (const entry of batch.entries) {
        if (performance.now() >= deadline) throw new IndexError('timeout');
        const payload = canonicalize(entry);
        const previous = this.db.query(`SELECT payload,reference FROM aos_index_entries_v1 WHERE owner=? AND kind=? AND id=?`)
          .get(batch.owner, entry.kind, entry.id) as { payload: string; reference: string } | null;
        if (previous) {
          if (previous.payload !== payload || previous.reference !== entry.reference) throw new IndexError('entry-conflict');
          replayed++;
        } else {
          try {
            this.db.query('INSERT INTO aos_index_entries_v1(owner,kind,id,reference,payload) VALUES(?,?,?,?,?)')
              .run(batch.owner, entry.kind, entry.id, entry.reference, payload);
          } catch { throw new IndexError('entry-conflict'); }
          inserted++;
        }
      }
      if (performance.now() >= deadline) throw new IndexError('timeout');
      return { inserted, replayed };
    }).immediate();
  }

  private entries(scope: IndexScope): IndexEntry[] | IndexReport {
    // One statement is a snapshot. Read one sentinel, never publish a selected prefix.
    const rows = this.db.query(`SELECT owner,kind,id,reference,
      CASE WHEN length(CAST(payload AS BLOB)) <= 4096 THEN payload ELSE NULL END AS payload
      FROM aos_index_entries_v1 WHERE owner=? AND kind=? ORDER BY id COLLATE BINARY LIMIT ?`)
      .all(scope.owner, scope.kind, INDEX_LIMITS.entries + 1) as Row[];
    if (rows.length > INDEX_LIMITS.entries) return incomplete('entry-limit; use explicit paging or on-demand lookup', rows.length);
    const entries: IndexEntry[] = [], refs = new Set<string>(), ids = new Set<string>();
    for (const row of rows) {
      try {
        if (!row.payload) throw new IndexError('malformed-state');
        const entry = parseIndexInput(IndexEntrySchema, parseIndexJson(row.payload));
        if (row.owner !== scope.owner || entry.kind !== scope.kind || row.kind !== entry.kind || row.id !== entry.id ||
            row.reference !== entry.reference || refs.has(entry.reference) || ids.has(entry.id) || canonicalize(entry) !== row.payload) {
          throw new IndexError('malformed-state');
        }
        refs.add(entry.reference); ids.add(entry.id); entries.push(entry);
      } catch { return incomplete('malformed-state', rows.length); }
    }
    return entries;
  }

  /** Read-only metadata invariants for one explicit owner/kind, not reference existence or truth. */
  check(input: unknown): IndexReport {
    const scope = parseIndexInput(IndexScopeSchema, input);
    const entries = this.entries(scope);
    if (!Array.isArray(entries)) return entries;
    return { schema: 'aos.index/v1', status: entries.length ? 'complete' : 'empty',
      reason: entries.length ? 'metadata-invariants-only' : 'empty-owner-scope; completeness unknown',
      count: entries.length, artifact: null };
  }

  generate(input: unknown): IndexReport {
    const options = parseIndexInput(GenerateIndexSchema, input);
    const entries = this.entries(options);
    if (!Array.isArray(entries)) return entries;
    if (!entries.length) return { schema: 'aos.index/v1', status: 'empty',
      reason: 'empty-owner-scope; completeness unknown', count: 0, artifact: null };
    const sourceDigest = digestOfString(canonicalize({ owner: options.owner, kind: options.kind, entries }));
    const lines = ['---', 'schema: aos.index/v1', 'generated_by: aos-indexes-v1',
      `owner: "${options.owner}"`, `kind: ${options.kind}`, 'status: complete', `count: ${entries.length}`,
      `source_digest: ${sourceDigest}`, '---', '', `# ${options.kind === 'memory' ? 'Memory' : 'Session'} index`, '',
      'Imported metadata only. References and completion claims are not verified.',
      'References are relative to the explicitly chosen knowledge root.', ''];
    for (const entry of entries) {
      lines.push(`## ${entry.id}`, '', `- Title: ${literal(entry.title)}`,
        `- Reference: [${entry.reference}](${entry.reference})`, `- Declared status: ${entry.status}`,
        `- Updated: ${entry.updatedAt}`);
      if (entry.kind === 'session') lines.push(`- Started: ${entry.startedAt}`);
      lines.push('');
    }
    const markdown = lines.join('\n');
    const size = bytes(markdown), maxLine = Math.max(...lines.map(bytes));
    if (size > options.maxBytes || maxLine > options.maxLineBytes) return incomplete('output-limit; use explicit paging or on-demand lookup', entries.length);
    return { schema: 'aos.index/v1', status: 'complete', reason: 'all-scoped-metadata', count: entries.length,
      artifact: { markdown, digest: digestOfString(markdown), bytes: size, maxLineBytes: maxLine } };
  }
  close(): void { this.db.close(); }
}
