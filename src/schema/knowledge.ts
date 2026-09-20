import { z } from 'zod';

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,95}$/);
const title = z.string().min(1).max(240);
const date = z.string().refine(value => /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(value + 'T00:00:00Z')));
const item = z.string().min(1).max(512);
const scope = z.string().regex(/^(?:all|shared|project:[a-z0-9][a-z0-9_-]{0,95})$/);
export const NoteMetadataSchema = z.strictObject({
  schema: z.literal('hendoos.note/v1'), id, kind: z.enum(['project', 'lesson', 'session', 'decision', 'observation']),
  title, scope: z.array(scope).min(1), harness: z.array(z.enum(['all', 'codex', 'hermes'])).min(1),
  lifecycle: z.enum(['active', 'superseded', 'archived']), updated: date,
  provenance: z.array(item).min(1), source_refs: z.array(item), learned_by: z.string().max(64).optional(),
  triggers: z.array(item).optional(), critical: z.boolean().optional(), trust: z.enum(['trusted', 'untrusted']),
}).superRefine((value, ctx) => {
  if (new Set(value.scope).size !== value.scope.length) ctx.addIssue({ code: 'custom', path: ['scope'], message: 'duplicate-scope' });
  if (new Set(value.harness).size !== value.harness.length) ctx.addIssue({ code: 'custom', path: ['harness'], message: 'duplicate-harness' });
  if (value.harness.includes('all') && value.harness.length !== 1) ctx.addIssue({ code: 'custom', path: ['harness'], message: 'all-harness-alias' });
  if (value.kind === 'lesson' && (!value.triggers || !value.triggers.length)) ctx.addIssue({ code: 'custom', path: ['triggers'], message: 'lesson-triggers-required' });
  if (value.kind !== 'lesson' && value.triggers) ctx.addIssue({ code: 'custom', path: ['triggers'], message: 'triggers-only-on-lessons' });
  if (value.kind === 'observation' && value.trust !== 'untrusted') ctx.addIssue({ code: 'custom', path: ['trust'], message: 'observation-must-be-untrusted' });
});
export type NoteMetadata = z.infer<typeof NoteMetadataSchema>;

export const RecallRequestSchema = z.strictObject({
  project: id, harness: z.enum(['codex', 'hermes']), triggers: z.array(item).max(64),
  page: z.int().min(1).default(1), pageSize: z.int().min(1).max(100).default(25), listAll: z.boolean().default(false),
  tracker: z.strictObject({ issue: z.string().regex(/^[A-Z][A-Z0-9]*-[1-9][0-9]*$/),
    state: z.string().min(1).max(64), observedAt: z.string().datetime() }).optional(),
});
export type RecallRequest = z.infer<typeof RecallRequestSchema>;
export const RecallFeedbackSchema = z.strictObject({ noteId: id,
  result: z.enum(['loaded', 'not-loaded', 'misunderstood', 'loaded-but-ignored']), detail: z.string().min(1).max(1000) });
export type RecallFeedback = z.infer<typeof RecallFeedbackSchema>;
