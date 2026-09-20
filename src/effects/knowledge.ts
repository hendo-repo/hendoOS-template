import { constants } from 'node:fs';
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { canonicalize, digestOfString } from '../protocols/json';
import { parseFrontmatter } from '../schema/frontmatter';
import { NoteMetadataSchema, RecallFeedbackSchema, RecallRequestSchema, type NoteMetadata } from '../schema/knowledge';

export class KnowledgeError extends Error { constructor(readonly code: string) { super(code); } }
export type KnowledgeNote = { path: string; digest: string; metadata: NoteMetadata; body: string };
export type KnowledgeFinding = { code: string; path: string; detail?: string };
export type KnowledgeAudit = { schema: 'hendoos.knowledge-audit/v1'; status: 'complete' | 'incomplete';
  root: string; notes: KnowledgeNote[]; findings: KnowledgeFinding[] };
const LIMITS = Object.freeze({ files: 4096, fileBytes: 1024 * 1024, bodyBytes: 512 * 1024, pageSize: 100 });
const injection = /(?:ignore (?:all |the )?(?:previous|prior) instructions|system prompt|developer message|you are (?:chatgpt|an ai|an agent)|execute (?:this|the following) command)/i;
const secrets = [/[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/,
  /\b(?:gh[pousr]_|github_pat_|sk-(?:ant-)?|xox[baprs]-)[A-Za-z0-9_-]{16,}\b/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/];
const isInside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..'); };

async function markdownFiles(root: string): Promise<string[]> {
  const out: string[] = [], queue = [root];
  while (queue.length) {
    const current = queue.shift()!;
    for (const entry of await readdir(current, { withFileTypes: true })) {
      if (entry.name === '.git' || entry.name === '.hendoos' || entry.name.startsWith('.hendoos-')) continue;
      const path = join(current, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new KnowledgeError('symlink-in-knowledge-root');
      if (entry.isDirectory()) queue.push(path);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(path);
      if (out.length + queue.length > LIMITS.files) throw new KnowledgeError('knowledge-file-limit');
    }
  }
  return out.sort((a, b) => a.localeCompare(b, 'en'));
}

export async function auditKnowledge(root: string): Promise<KnowledgeAudit> {
  const canonicalRoot = await realpath(root), notes: KnowledgeNote[] = [], findings: KnowledgeFinding[] = [];
  const ids = new Map<string, string>();
  for (const path of await markdownFiles(canonicalRoot)) {
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
      if (injection.test(source)) findings.push({ code: 'prompt-injection', path: rel });
      if (secrets.some(rule => rule.test(source))) findings.push({ code: 'possible-secret', path: rel });
      continue;
    }
    const metadata = NoteMetadataSchema.safeParse(parsed.value.data);
    if (!metadata.success) { findings.push({ code: 'invalid-note-metadata', path: rel }); continue; }
    if (Buffer.byteLength(parsed.value.body) > LIMITS.bodyBytes) { findings.push({ code: 'note-body-limit', path: rel }); continue; }
    const previous = ids.get(metadata.data.id);
    if (previous) { findings.push({ code: 'duplicate-note-id', path: rel, detail: previous }); continue; }
    ids.set(metadata.data.id, rel);
    if (injection.test(parsed.value.body)) findings.push({ code: 'prompt-injection', path: rel });
    if (secrets.some(rule => rule.test(parsed.value.body))) findings.push({ code: 'possible-secret', path: rel });
    notes.push({ path: rel, digest: digestOfString(parsed.value.source), metadata: metadata.data, body: parsed.value.body });
  }
  for (const note of notes) for (const reference of note.metadata.source_refs) {
    if (/^https:\/\//.test(reference)) continue;
    const target = resolve(canonicalRoot, reference);
    if (!isInside(canonicalRoot, target)) findings.push({ code: 'reference-outside-root', path: note.path, detail: reference });
    else try { await stat(target); } catch { findings.push({ code: 'missing-reference', path: note.path, detail: reference }); }
  }
  return { schema: 'hendoos.knowledge-audit/v1', status: findings.length ? 'incomplete' : 'complete',
    root: canonicalRoot, notes: notes.sort((a, b) => a.metadata.id.localeCompare(b.metadata.id)), findings };
}

const inScope = (note: KnowledgeNote, project: string, harness: 'codex' | 'hermes') =>
  note.metadata.lifecycle === 'active' &&
  (note.metadata.scope.includes('all') || note.metadata.scope.includes('shared') || note.metadata.scope.includes(`project:${project}`)) &&
  (note.metadata.harness.includes('all') || note.metadata.harness.includes(harness));

export function recallKnowledge(audit: KnowledgeAudit, input: unknown): object {
  const request = RecallRequestSchema.parse(input);
  const scoped = audit.notes.filter(note => inScope(note, request.project, request.harness));
  const projects = scoped.filter(note => note.metadata.kind === 'project' && note.metadata.scope.includes(`project:${request.project}`));
  const triggerSet = new Set(request.triggers.map(value => value.toLocaleLowerCase()));
  const lessons = scoped.filter(note => note.metadata.kind === 'lesson' &&
    (request.listAll || note.metadata.critical || note.metadata.triggers!.some(value => triggerSet.has(value.toLocaleLowerCase()))));
  const ordered = [...projects, ...lessons].sort((a, b) => {
    const rank = (note: KnowledgeNote) => note.metadata.kind === 'project' ? 0 : note.metadata.critical ? 1 : 2;
    return rank(a) - rank(b) || a.metadata.id.localeCompare(b.metadata.id);
  });
  const start = (request.page - 1) * request.pageSize;
  const page = ordered.slice(start, start + request.pageSize).map(note => ({ id: note.metadata.id, kind: note.metadata.kind,
    title: note.metadata.title, path: note.path, digest: note.digest, triggers: note.metadata.triggers ?? [], critical: !!note.metadata.critical }));
  return { schema: 'hendoos.recall/v1', status: page.length ? 'not-loaded' : 'not-found', project: request.project,
    harness: request.harness, tracker: request.tracker ?? null, total: ordered.length, page: request.page,
    pageSize: request.pageSize, hasMore: start + page.length < ordered.length, candidates: page };
}

export function readKnowledgeNote(audit: KnowledgeAudit, id: string, expectedDigest: string): object {
  const note = audit.notes.find(value => value.metadata.id === id);
  if (!note) return { schema: 'hendoos.recall-read/v1', status: 'not-found', id };
  if (note.digest !== expectedDigest) return { schema: 'hendoos.recall-read/v1', status: 'changed', id, digest: note.digest };
  return { schema: 'hendoos.recall-read/v1', status: 'loaded', id, digest: note.digest, metadata: note.metadata, body: note.body };
}

export function recordRecallFeedback(input: unknown): object {
  return { schema: 'hendoos.recall-feedback/v1', ...RecallFeedbackSchema.parse(input) };
}

type IndexPage = { path: string; markdown: string; digest: string };
export function generateKnowledgeIndexes(audit: KnowledgeAudit, pageSize = 100): { schema: 'hendoos.knowledge-index-set/v1'; digest: string; pages: IndexPage[] } {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > LIMITS.pageSize) throw new KnowledgeError('invalid-page-size');
  if (audit.status !== 'complete') throw new KnowledgeError('knowledge-audit-incomplete');
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
  const digest = digestOfString(canonicalize(pages.map(page => ({ path: page.path, digest: page.digest }))));
  return { schema: 'hendoos.knowledge-index-set/v1', digest, pages };
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
export async function publishKnowledgeIndexes(outputRoot: string, generated: ReturnType<typeof generateKnowledgeIndexes>): Promise<object> {
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
  const manifest = JSON.stringify({ schema: generated.schema, digest: generated.digest,
    pages: generated.pages.map(page => ({ path: page.path, digest: page.digest })) }, null, 2) + '\n';
  const manifestPath = join(generation, 'manifest.json');
  try { await writeExclusive(manifestPath, manifest); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(manifestPath, 'utf8') !== manifest) throw error; }
  await mkdir(root, { recursive: true });
  await atomicPointer(join(root, 'CURRENT'), generated.digest + '\n');
  return { schema: 'hendoos.knowledge-publish/v1', status: 'complete', digest: generated.digest,
    generation, pages: generated.pages.length };
}
