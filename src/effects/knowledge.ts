import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { canonicalize, digestOfString } from '../protocols/json';
import { parseFrontmatter } from '../schema/frontmatter';
import { NoteMetadataSchema, RecallFeedbackSchema, RecallRequestSchema, type NoteMetadata } from '../schema/knowledge';

export class KnowledgeError extends Error { constructor(readonly code: string) { super(code); } }
export type KnowledgeNote = { path: string; digest: string; metadata: NoteMetadata; body: string;
  audit: KnowledgeFinding[]; sourceFormat: 'hendoos-v1' | 'legacy-vault' };
export type KnowledgeFinding = { code: string; path: string; detail?: string };
export type KnowledgeAudit = { schema: 'hendoos.knowledge-audit/v1'; status: 'complete' | 'incomplete';
  root: string; notes: KnowledgeNote[]; findings: KnowledgeFinding[];
  inventory: { scanned: number; supported: number; unsupported: number; derivedExcluded: number } };
const LIMITS = Object.freeze({ files: 4096, fileBytes: 1024 * 1024, bodyBytes: 512 * 1024, pageSize: 100 });
const injection = /(?:ignore (?:all |the )?(?:previous|prior) instructions|system prompt|developer message|you are (?:chatgpt|an ai|an agent)|execute (?:this|the following) command)/i;
const secrets = [/[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
  /\b(?:gh[pousr]_|github_pat_|sk-(?:ant-)?|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/];
const isInside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..'); };

type FileInventory = { source: string[]; unsupported: string[]; derivedExcluded: number };
const portable = (value: string) => value.split(sep).join('/');
const derivedRoot = (rel: string) => rel === '90-Indexes' || rel.startsWith('90-Indexes/') || rel === '95-Views' || rel.startsWith('95-Views/');
const supportedRoot = (rel: string) => ['01-Projects/', '03-Decisions/', '04-Lessons/', '06-Sessions/', '30-Archive/Sessions/'].some(prefix => rel.startsWith(prefix));
const supportFile = (rel: string) => (!rel.includes('/') || supportedRoot(rel)) && !/(?:^|\/)(?:README|_template|_index|_triggers)\.md$/i.test(rel);

async function markdownFiles(root: string): Promise<FileInventory> {
  const source: string[] = [], unsupported: string[] = [], queue = [root]; let derivedExcluded = 0;
  while (queue.length) {
    const current = queue.shift()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.hendoos' || entry.name.startsWith('.hendoos-')) continue;
      const path = join(current, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new KnowledgeError('symlink-in-knowledge-root');
      const rel = portable(relative(root, path));
      if (entry.isDirectory()) {
        if (derivedRoot(rel)) {
          const count = async (dir: string): Promise<number> => { let total = 0; for (const child of await readdir(dir, { withFileTypes: true })) {
            const childPath = join(dir, child.name); if (child.isDirectory()) total += await count(childPath); else if (child.isFile() && child.name.endsWith('.md')) total++;
          } return total; };
          derivedExcluded += await count(path);
        } else queue.push(path);
      } else if (entry.isFile() && entry.name.endsWith('.md')) (supportFile(rel) ? source : unsupported).push(path);
      if (source.length + unsupported.length + derivedExcluded + queue.length > LIMITS.files) throw new KnowledgeError('knowledge-file-limit');
    }
  }
  return { source: source.sort((a, b) => a.localeCompare(b, 'en')),
    unsupported: unsupported.sort((a, b) => a.localeCompare(b, 'en')), derivedExcluded };
}

const stringValue = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;
const slug = (value: string) => value.toLocaleLowerCase().normalize('NFKD').replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96) || 'legacy-note';
const legacyKind = (rel: string): NoteMetadata['kind'] => rel.startsWith('01-Projects/') ? 'project' : rel.startsWith('03-Decisions/') ? 'decision' :
  rel.startsWith('04-Lessons/') ? 'lesson' : 'session';
const legacyLifecycle = (value: unknown): NoteMetadata['lifecycle'] => {
  const status = stringValue(value)?.toLocaleLowerCase();
  if (status === 'superseded') return 'superseded';
  if (['archived', 'retired', 'cancelled', 'canceled', 'completed', 'historical'].includes(status ?? '')) return 'archived';
  return 'active';
};
const legacyDate = (data: Record<string, unknown>, rel: string) => {
  for (const value of [data.updated, data.date, data.created]) if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  return rel.match(/(?:^|\/)(\d{4}-\d{2}-\d{2})/)?.[1] ?? '1970-01-01';
};
const scanText = (body: string) => body.replace(/```[\s\S]*?```/g, '').split('\n').filter(line => !/^\s*>/.test(line)).join('\n');
const findingsFor = (body: string, path: string): KnowledgeFinding[] => {
  const scan = scanText(body), out: KnowledgeFinding[] = [];
  if (injection.test(scan)) out.push({ code: 'prompt-injection', path });
  if (secrets.some(rule => rule.test(scan))) out.push({ code: 'possible-secret', path });
  return out;
};

function adaptLegacy(rel: string, data: Record<string, unknown>, body: string): NoteMetadata {
  const kind = legacyKind(rel), base = rel.slice(rel.lastIndexOf('/') + 1).replace(/\.md$/i, '');
  const project = slug(stringValue(data.project)?.replace(/^\[\[|\]\]$/g, '') ?? (kind === 'project' ? base : 'shared'));
  const harnessValue = stringValue(data.harness)?.toLocaleLowerCase();
  const harness: NoteMetadata['harness'] = harnessValue === 'codex' || harnessValue === 'hermes' ? [harnessValue] : ['all'];
  const learned = stringValue(data.learned_by)?.slice(0, 64);
  const lifecycle = legacyLifecycle(data.status);
  const title = (stringValue(data.title) ?? base).slice(0, 240);
  const tokens = [...new Set((title + ' ' + (Array.isArray(data.tags) ? data.tags.join(' ') : '')).toLocaleLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? [])].slice(0, 32);
  const acceptedDecision = kind === 'decision' && lifecycle === 'active' && ['accepted', 'active'].includes(stringValue(data.status)?.toLocaleLowerCase() ?? 'active');
  return { schema: 'hendoos.note/v1', id: slug(base), kind, title,
    scope: kind === 'project' ? [`project:${slug(base)}`] : (project === 'shared' ? ['shared'] : ['shared', `project:${project}`]),
    harness, lifecycle, updated: legacyDate(data, rel), provenance: [`legacy-vault:${rel}`], source_refs: [],
    ...(learned ? { learned_by: learned } : {}), ...(kind === 'lesson' ? { triggers: tokens.length ? tokens : ['legacy'] } : {}),
    trust: acceptedDecision ? 'trusted' : kind === 'session' ? 'untrusted' : 'trusted',
    origins: acceptedDecision ? ['operator'] : kind === 'session' ? ['agent-summary', 'legacy-unknown'] : ['legacy-unknown'],
    authority: acceptedDecision ? 'instructional' : kind === 'session' ? 'evidence' : 'reference' };
}

export async function auditKnowledge(root: string): Promise<KnowledgeAudit> {
  const canonicalRoot = await realpath(root), notes: KnowledgeNote[] = [], findings: KnowledgeFinding[] = [];
  const ids = new Map<string, string>();
  const files = await markdownFiles(canonicalRoot);
  for (const path of files.unsupported) findings.push({ code: 'unsupported-class', path: portable(relative(canonicalRoot, path)) });
  for (const path of files.source) {
    const rel = relative(canonicalRoot, path).split(sep).join('/');
    const info = await stat(path);
    if (!info.isFile() || info.size > LIMITS.fileBytes) { findings.push({ code: 'unsupported-file', path: rel }); continue; }
    let source: string, hadBom = false;
    try {
      const bytes = await readFile(path); hadBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
      source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    }
    catch { findings.push({ code: 'unreadable-or-invalid-utf8', path: rel }); continue; }
    const parsed = parseFrontmatter(source);
    if (!parsed.ok || !parsed.value.hasFrontmatter || parsed.value.data === null) {
      findings.push({ code: hadBom ? 'bom-without-valid-frontmatter' : 'missing-or-malformed-frontmatter', path: rel });
      findings.push(...findingsFor(source, rel));
      continue;
    }
    const strict = NoteMetadataSchema.safeParse(parsed.value.data);
    let metadata: NoteMetadata, sourceFormat: KnowledgeNote['sourceFormat'];
    if (strict.success) { metadata = strict.data; sourceFormat = 'hendoos-v1'; }
    else if ((parsed.value.data as Record<string, unknown>).schema === 'hendoos.note/v1') {
      findings.push({ code: 'invalid-note-metadata', path: rel }); continue;
    } else {
      try { metadata = adaptLegacy(rel, parsed.value.data as Record<string, unknown>, parsed.value.body); sourceFormat = 'legacy-vault'; }
      catch { findings.push({ code: 'invalid-note-metadata', path: rel }); continue; }
    }
    if (Buffer.byteLength(parsed.value.body) > LIMITS.bodyBytes) { findings.push({ code: 'note-body-limit', path: rel }); continue; }
    const previous = ids.get(metadata.id);
    if (previous) { findings.push({ code: 'duplicate-note-id', path: rel, detail: previous }); continue; }
    ids.set(metadata.id, rel);
    const noteFindings = findingsFor(parsed.value.body, rel); findings.push(...noteFindings);
    notes.push({ path: rel, digest: digestOfString(parsed.value.source), metadata, body: parsed.value.body, audit: noteFindings, sourceFormat });
  }
  for (const note of notes) for (const reference of note.metadata.source_refs) {
    if (/^https:\/\//.test(reference)) continue;
    const target = resolve(canonicalRoot, reference);
    if (!isInside(canonicalRoot, target)) findings.push({ code: 'reference-outside-root', path: note.path, detail: reference });
    else try { await stat(target); } catch { findings.push({ code: 'missing-reference', path: note.path, detail: reference }); }
  }
  const blocking = findings.some(finding => !['unsupported-class'].includes(finding.code));
  return { schema: 'hendoos.knowledge-audit/v1', status: blocking ? 'incomplete' : 'complete',
    root: canonicalRoot, notes: notes.sort((a, b) => a.metadata.id.localeCompare(b.metadata.id)), findings,
    inventory: { scanned: files.source.length + files.unsupported.length, supported: notes.length,
      unsupported: files.unsupported.length, derivedExcluded: files.derivedExcluded } };
}

const inScope = (note: KnowledgeNote, project: string, harness: 'codex' | 'hermes') =>
  note.metadata.lifecycle === 'active' &&
  (note.metadata.scope.includes('all') || note.metadata.scope.includes('shared') || note.metadata.scope.includes(`project:${project}`)) &&
  (note.metadata.harness.includes('all') || note.metadata.harness.includes(harness));

export function recallKnowledge(audit: KnowledgeAudit, input: unknown): object {
  const request = RecallRequestSchema.parse(input);
  const scoped = audit.notes.filter(note => inScope(note, request.project, request.harness));
  const projects = scoped.filter(note => note.metadata.kind === 'project' && note.metadata.scope.includes(`project:${request.project}`));
  const words = (value: string) => (value.toLocaleLowerCase().match(/[a-z0-9][a-z0-9_-]{2,}/g) ?? []).map(token => token.replace(/(?:ing|ed|es|s)$/i, ''));
  const triggerSet = new Set(request.triggers.flatMap(words));
  const decisions = scoped.filter(note => note.metadata.kind === 'decision');
  const lessons = scoped.filter(note => note.metadata.kind === 'lesson' &&
    (request.listAll || note.metadata.critical || note.metadata.triggers!.some(value => words(value).some(token => triggerSet.has(token)))));
  const ordered = [...projects, ...decisions, ...lessons].sort((a, b) => {
    const rank = (note: KnowledgeNote) => note.metadata.kind === 'project' ? 0 : note.metadata.kind === 'decision' ? 1 : note.metadata.critical ? 2 : 3;
    return rank(a) - rank(b) || a.metadata.id.localeCompare(b.metadata.id);
  });
  const start = (request.page - 1) * request.pageSize;
  const page = ordered.slice(start, start + request.pageSize).map(note => ({ id: note.metadata.id, kind: note.metadata.kind,
    title: note.metadata.title, path: note.path, digest: note.digest, scope: note.metadata.scope, lifecycle: note.metadata.lifecycle,
    trust: note.metadata.trust, origins: note.metadata.origins ?? ['legacy-unknown'], authority: note.metadata.authority ?? 'reference',
    audit: note.audit, instructional: note.metadata.trust === 'trusted' && (note.metadata.authority ?? 'reference') === 'instructional' && note.audit.length === 0,
    triggers: note.metadata.triggers ?? [], critical: !!note.metadata.critical }));
  return { schema: 'hendoos.recall/v1', status: page.length ? 'not-loaded' : 'not-found', project: request.project,
    harness: request.harness, tracker: request.tracker ?? null, total: ordered.length, page: request.page,
    pageSize: request.pageSize, hasMore: start + page.length < ordered.length, auditStatus: audit.status,
    unsupported: audit.inventory.unsupported, candidates: page };
}

export function readKnowledgeNote(audit: KnowledgeAudit, id: string, expectedDigest: string): object {
  const note = audit.notes.find(value => value.metadata.id === id);
  if (!note) return { schema: 'hendoos.recall-read/v1', status: 'not-found', id };
  if (note.digest !== expectedDigest) return { schema: 'hendoos.recall-read/v1', status: 'changed', id, digest: note.digest };
  return { schema: 'hendoos.recall-read/v1', status: 'loaded', id, digest: note.digest, metadata: note.metadata,
    audit: note.audit, source: { path: note.path, format: note.sourceFormat },
    instructional: note.metadata.trust === 'trusted' && (note.metadata.authority ?? 'reference') === 'instructional' && note.audit.length === 0,
    body: note.body };
}

export function recordRecallFeedback(input: unknown): object {
  return { schema: 'hendoos.recall-feedback/v1', ...RecallFeedbackSchema.parse(input) };
}

type IndexPage = { path: string; markdown: string; digest: string };
export type KnowledgeIndexSet = { schema: 'hendoos.knowledge-index-set/v1'; digest: string; sourceDigest: string; pages: IndexPage[] };
export function knowledgeSourceDigest(audit: KnowledgeAudit): string {
  return digestOfString(canonicalize(audit.notes.map(note => ({ path: note.path, digest: note.digest }))));
}
export function generateKnowledgeIndexes(audit: KnowledgeAudit, pageSize = 100, options: { allowIncomplete?: boolean } = {}): KnowledgeIndexSet {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > LIMITS.pageSize) throw new KnowledgeError('invalid-page-size');
  if (audit.status !== 'complete' && !options.allowIncomplete) throw new KnowledgeError('knowledge-audit-incomplete');
  const groups: Array<{ name: string; notes: KnowledgeNote[] }> = [];
  for (const kind of ['project', 'lesson', 'session'] as const) groups.push({ name: kind, notes: audit.notes.filter(note => note.metadata.kind === kind) });
  for (const harness of ['codex', 'hermes'] as const) groups.push({ name: `harness-${harness}`, notes: audit.notes.filter(note => note.metadata.harness.includes('all') || note.metadata.harness.includes(harness)) });
  const pages: IndexPage[] = [];
  for (const group of groups) {
    const ordered = [...group.notes].sort((a, b) => a.metadata.updated.localeCompare(b.metadata.updated) || a.metadata.id.localeCompare(b.metadata.id));
    const count = Math.max(1, Math.ceil(ordered.length / pageSize));
    for (let page = 1; page <= count; page++) {
      const selected = ordered.slice((page - 1) * pageSize, page * pageSize);
      const lines = ['---', 'schema: hendoos.knowledge-index/v1', `kind: ${group.name}`, `page: ${page}`, `pages: ${count}`,
        `count: ${selected.length}`, '---', '', `# ${group.name} index`, ''];
      for (const note of selected) lines.push(`- [${note.metadata.id}](${note.path}) | ${note.metadata.updated} | ${note.metadata.title.replaceAll('|', '&#124;')}`);
      const markdown = lines.join('\n') + '\n';
      pages.push({ path: `${group.name}-${String(page).padStart(4, '0')}.md`, markdown, digest: digestOfString(markdown) });
    }
  }
  const sourceDigest = knowledgeSourceDigest(audit);
  const digest = digestOfString(canonicalize({ sourceDigest, pages: pages.map(page => ({ path: page.path, digest: page.digest })) }));
  return { schema: 'hendoos.knowledge-index-set/v1', digest, sourceDigest, pages };
}

async function writeExclusive(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await file.writeFile(body); await file.sync(); } finally { await file.close(); }
}

async function atomicPointer(path: string, body: string): Promise<void> {
  const temporary = join(dirname(path), `.hendoos-${crypto.randomUUID()}.tmp`);
  await writeExclusive(temporary, body);
  try { await rename(temporary, path); } finally { await rm(temporary, { force: true }); }
}

/** Immutable generation plus one atomic CURRENT pointer prevents mixed-page readers. */
export async function publishKnowledgeIndexes(outputRoot: string, generated: ReturnType<typeof generateKnowledgeIndexes>,
  options: { sourceRoot?: string } = {}): Promise<object> {
  const root = resolve(outputRoot), generationId = generated.digest.replace(':', '-');
  const generation = join(root, 'generations', generationId);
  await mkdir(generation, { recursive: true });
  for (const page of generated.pages) {
    const path = join(generation, page.path);
    try { await writeExclusive(path, page.markdown); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || digestOfString(await readFile(path, 'utf8')) !== page.digest) throw error;
    }
  }
  if (options.sourceRoot) {
    const current = await auditKnowledge(options.sourceRoot);
    if (knowledgeSourceDigest(current) !== generated.sourceDigest) throw new KnowledgeError('stale-source-snapshot');
  }
  const manifest = JSON.stringify({ schema: generated.schema, digest: generated.digest, sourceDigest: generated.sourceDigest,
    pages: generated.pages.map(page => ({ path: page.path, digest: page.digest })) }, null, 2) + '\n';
  const manifestPath = join(generation, 'manifest.json');
  try { await writeExclusive(manifestPath, manifest); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(manifestPath, 'utf8') !== manifest) throw error; }
  await mkdir(root, { recursive: true });
  await atomicPointer(join(root, 'CURRENT'), generated.digest + '\n');
  return { schema: 'hendoos.knowledge-publish/v1', status: 'complete', digest: generated.digest,
    sourceDigest: generated.sourceDigest, generation, pages: generated.pages.length };
}
