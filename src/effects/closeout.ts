import { constants } from 'node:fs';
import { mkdir, mkdtemp, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { canonicalize, digestOfString } from '../protocols/json';
import { parseTrackerIdentifier, parseTrackerPrefixes } from '../schema/tracker';
import { auditKnowledge, generateKnowledgeIndexes, publishKnowledgeIndexes } from './knowledge';

const path = z.string().min(1).max(4096).refine(value => !value.startsWith('/') && !value.startsWith('~') && !value.split('/').includes('..'));
const text = z.string().min(1).max(20_000);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const trackerReceipt = z.strictObject({ issue: z.string(), state: z.string().min(1).max(64),
  updateDigest: digest, readbackDigest: digest, observedAt: z.string().datetime() })
  .refine(value => value.updateDigest === value.readbackDigest, 'tracker-readback-mismatch');
export const CloseoutRequestSchema = z.strictObject({
  schema: z.literal('hendoos.closeout-request/v1'), closeoutId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,95}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), projectId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,95}$/),
  projectReference: path, expectedProjectDigest: digest, issuePrefixes: z.string(), tracker: trackerReceipt,
  why: text, what: text, currentState: text, evidence: z.array(text).min(1).max(100),
  learnedBy: z.enum(['codex', 'hermes']), writePolicy: z.literal('propose'),
  proposedLessons: z.array(text).max(50), proposedDecisions: z.array(text).max(50),
});
export type CloseoutRequest = z.infer<typeof CloseoutRequestSchema>;
export class CloseoutError extends Error { constructor(readonly code: string) { super(code); } }
const inside = (root: string, value: string) => { const rel = relative(root, value); return rel === '' || (!rel.startsWith('..' + sep) && rel !== '..'); };

async function atomicReplace(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.hendoos-${crypto.randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await file.writeFile(body); await file.sync(); await rename(temporary, path); }
  finally { await file.close(); await rm(temporary, { force: true }); }
}

async function visibleFailure(stateRoot: string, id: string, requestDigest: string, code: string, stage: string): Promise<void> {
  const path = join(stateRoot, 'closeouts', `${id}.failed.json`);
  await atomicReplace(path, JSON.stringify({ schema: 'hendoos.closeout-failure/v1', id, requestDigest, code, stage,
    recoverable: true }, null, 2) + '\n');
}

function updateProject(source: string, request: CloseoutRequest): string {
  const marker = `<!-- hendoos-closeout:${request.closeoutId} -->`;
  if (source.includes(marker)) return source;
  const parsed = source.replace(/^\uFEFF/, '');
  if (!/^updated:\s*\d{4}-\d{2}-\d{2}\s*$/m.test(parsed)) throw new CloseoutError('project-updated-field-missing');
  const updated = parsed.replace(/^updated:\s*\d{4}-\d{2}-\d{2}\s*$/m, `updated: ${request.date}`);
  return updated.trimEnd() + `\n\n${marker}\n## Closeout ${request.date}\n\n` +
    `- Issue: ${request.tracker.issue}\n- State: ${request.tracker.state}\n- Why: ${request.why}\n- What: ${request.what}\n` +
    `- Current state: ${request.currentState}\n- Evidence:\n${request.evidence.map(value => `  - ${value}`).join('\n')}\n`;
}

function sessionNote(request: CloseoutRequest): string {
  const list = (values: string[]) => values.length ? values.map(value => `- ${value}`).join('\n') : '- none';
  return `---\nschema: hendoos.note/v1\nid: session-${request.closeoutId}\nkind: session\ntitle: "${request.tracker.issue} closeout"\n` +
    `scope: [project:${request.projectId}]\nharness: [all]\nlifecycle: active\nupdated: ${request.date}\n` +
    `provenance: [closeout:${request.closeoutId}, tracker:${request.tracker.issue}]\nsource_refs: [${request.projectReference}]\n` +
    `learned_by: ${request.learnedBy}\ntrust: untrusted\norigins: [operator, agent-summary, tool, inferred]\nauthority: evidence\n---\n\n# ${request.tracker.issue} closeout\n\n` +
    `## Why\n\n${request.why}\n\n## What\n\n${request.what}\n\n## Current state\n\n${request.currentState}\n\n` +
    `## Evidence\n\n${list(request.evidence)}\n\n## Proposed lessons\n\n${list(request.proposedLessons)}\n\n` +
    `## Proposed decisions\n\n${list(request.proposedDecisions)}\n\n## Tracker readback\n\n` +
    `- Issue: ${request.tracker.issue}\n- State: ${request.tracker.state}\n- Observed: ${request.tracker.observedAt}\n`;
}

export type CloseoutOptions = { afterProjectRead?: () => void | Promise<void>;
  failAfter?: 'project-write' | 'session-write' | 'index-publication' };

async function acquireLock(path: string): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await file.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + '\n'); await file.sync();
      return async () => { await file.close(); await rm(path, { force: true }); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const owner = JSON.parse(await readFile(path, 'utf8')) as { pid?: number };
        if (owner.pid && owner.pid !== process.pid) {
          try { process.kill(owner.pid, 0); } catch { await rm(path, { force: true }); continue; }
        }
      } catch { /* malformed or concurrently removed locks remain busy until the next check */ }
      if (Date.now() >= deadline) throw new CloseoutError('closeout-lock-busy');
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
    }
  }
}

async function validateDraft(state: string, request: CloseoutRequest, project: string, session: string): Promise<void> {
  const root = await mkdtemp(join(state, '.hendoos-closeout-stage-'));
  try {
    const projectPath = join(root, request.projectReference), sessionPath = join(root, '30-Archive', 'Sessions', `${request.date}-${request.closeoutId}.md`);
    await mkdir(dirname(projectPath), { recursive: true }); await mkdir(dirname(sessionPath), { recursive: true });
    await atomicReplace(projectPath, project); await atomicReplace(sessionPath, session);
    const audit = await auditKnowledge(root);
    if (audit.notes.length !== 2 || audit.findings.some(finding => finding.code !== 'unsupported-class')) throw new CloseoutError('invalid-closeout-draft');
  } finally { await rm(root, { recursive: true, force: true }); }
}

export async function runCloseout(knowledgeRoot: string, stateRoot: string, input: unknown, options: CloseoutOptions = {}): Promise<object> {
  const parsed = CloseoutRequestSchema.safeParse(input);
  if (!parsed.success) throw new CloseoutError('invalid-closeout-request');
  const request = parsed.data, requestDigest = digestOfString(canonicalize(request));
  const prefixes = parseTrackerPrefixes(request.issuePrefixes);
  if (!parseTrackerIdentifier(request.tracker.issue, prefixes)) throw new CloseoutError('tracker-prefix-refused');
  const knowledge = resolve(knowledgeRoot), state = resolve(stateRoot);
  const projectPath = resolve(knowledge, request.projectReference);
  if (!inside(knowledge, projectPath) || knowledge === state || inside(knowledge, state) || inside(state, knowledge)) throw new CloseoutError('root-boundary');
  const receiptPath = join(state, 'closeouts', `${request.closeoutId}.json`);
  const initialProject = await readFile(projectPath, 'utf8');
  await options.afterProjectRead?.();
  const release = await acquireLock(join(state, 'closeouts', `.project-${request.projectId}.lock`));
  let stage = 'admission';
  try {
    try {
      const prior = JSON.parse(await readFile(receiptPath, 'utf8')) as { requestDigest?: string; status?: string };
      if (prior.requestDigest !== requestDigest) throw new CloseoutError('closeout-id-conflict');
      if (prior.status === 'complete') return { ...prior, replayed: true };
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error; }
    await mkdir(join(state, 'closeouts'), { recursive: true });
    await atomicReplace(receiptPath, JSON.stringify({ schema: 'hendoos.closeout-receipt/v1', status: 'pending',
      id: request.closeoutId, requestDigest, stage }, null, 2) + '\n');
    const projectSource = await readFile(projectPath, 'utf8');
    if (projectSource !== initialProject && !projectSource.includes(`<!-- hendoos-closeout:${request.closeoutId} -->`)) throw new CloseoutError('newer-project-writer');
    const currentDigest = digestOfString(projectSource);
    const nextProject = updateProject(projectSource, request), nextDigest = digestOfString(nextProject);
    if (currentDigest !== request.expectedProjectDigest && currentDigest !== nextDigest) throw new CloseoutError('newer-project-writer');
    const sessionPath = join(knowledge, '30-Archive', 'Sessions', `${request.date}-${request.closeoutId}.md`);
    const session = sessionNote(request);
    await validateDraft(state, request, nextProject, session);
    stage = 'project-write';
    if (currentDigest !== nextDigest) await atomicReplace(projectPath, nextProject);
    if (options.failAfter === stage) throw new CloseoutError('injected-closeout-failure');
    stage = 'session-write';
    try {
      const existing = await readFile(sessionPath, 'utf8');
      if (existing !== session) throw new CloseoutError('session-log-conflict');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(dirname(sessionPath), { recursive: true });
      const file = await open(sessionPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      try { await file.writeFile(session); await file.sync(); } finally { await file.close(); }
    }
    if (options.failAfter === stage) throw new CloseoutError('injected-closeout-failure');
    if (await readFile(projectPath, 'utf8') !== nextProject || await readFile(sessionPath, 'utf8') !== session) throw new CloseoutError('post-write-readback-mismatch');
    const audit = await auditKnowledge(knowledge);
    const changedPaths = new Set([request.projectReference, relative(knowledge, sessionPath).split(sep).join('/')]);
    if (audit.findings.some(finding => changedPaths.has(finding.path))) throw new CloseoutError('post-write-knowledge-audit');
    const generated = generateKnowledgeIndexes(audit, 100, { allowIncomplete: true });
    stage = 'index-publication';
    const publication = await publishKnowledgeIndexes(join(knowledge, '90-Indexes', '.generated'), generated, { sourceRoot: knowledge });
    if (options.failAfter === stage) throw new CloseoutError('injected-closeout-failure');
    stage = 'final-receipt';
    const receipt = { schema: 'hendoos.closeout-receipt/v1', status: 'complete', id: request.closeoutId,
      requestDigest, projectDigest: nextDigest, sessionReference: relative(knowledge, sessionPath).split(sep).join('/'),
      tracker: request.tracker, indexDigest: generated.digest, publication };
    await atomicReplace(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    await rm(join(state, 'closeouts', `${request.closeoutId}.failed.json`), { force: true });
    return { ...receipt, replayed: false };
  } catch (error) {
    const code = error instanceof CloseoutError ? error.code : 'closeout-io-failure';
    await visibleFailure(state, request.closeoutId, requestDigest, code, stage);
    throw error;
  } finally { await release(); }
}
