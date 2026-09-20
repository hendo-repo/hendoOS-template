/** Strict, vendor-neutral operation wire contract. Synthetic evidence is shadow-only. */
import { z } from 'zod';
import { ContentIdSchema, DigestSchema, JsonValueSchema, TokenSchema } from '../protocols/validation';
import { PolicyRuleRuntimeSchema, PolicyRulesRuntimeSchema } from './runtime';
const Id = TokenSchema.refine(value => value.length <= 128, 'identifier too long');
export const SourceRevisionSchema = z.string().regex(/^[a-f0-9]{40}$/, 'source revision must be one exact git commit');
export const ObservationSchema = z.strictObject({
  key: Id,
  availability: z.enum(['available', 'unavailable']),
  freshness: z.enum(['fresh', 'stale', 'unknown']),
  completeness: z.enum(['complete', 'partial', 'unknown']),
  result: z.enum(['present', 'empty', 'no-work', 'unknown']),
  reasons: z.array(Id).max(8).default([]),
  value: JsonValueSchema.optional(),
  provenance: z.strictObject({ kind: z.literal('synthetic'), source: Id, subjectDigest: DigestSchema,
    configRevision: Id, checkerRevision: z.literal('aos-policy/1'), sourceRevision: SourceRevisionSchema }),
}).superRefine((observation, ctx) => {
  const current = observation.availability === 'available' && observation.freshness === 'fresh' &&
    observation.completeness === 'complete' && observation.result === 'present';
  if (current && observation.value === undefined) ctx.addIssue({ code: 'custom', message: 'current complete observation requires value' });
  if (observation.result !== 'present' && observation.value !== undefined) ctx.addIssue({ code: 'custom', message: 'only present observations carry values' });
});
export const ProjectConfigSchema = z.strictObject({ totalByteBudget: z.int().positive().max(262144).optional() });
/**
 * Condition and scope families the shared runtime can actually supply. The
 * runtime evaluates one scenario event (`id` plus the literal `default` harness)
 * and explicit synthetic observations. Its fact payload has no `paths` and no
 * `context`, and its event carries no `intent`, so a rule conditioned on
 * `when.intent`, `when.pathPrefix`, or scoped by `contentIds` could never match.
 * Accepting such a rule would silently drop a deny instead of failing closed, so
 * it is refused at this owner-configuration boundary.
 *
 * This list is exhaustive against `PolicyConditionRuntimeSchema`:
 * `event`, `harness`, `observation`, `equals`, and `truthy` are supplied by the
 * runtime, while `intent` and `pathPrefix` are not. Against
 * `PolicyRuleRuntimeSchema`, `contentIds` is not supplied either. The broader
 * pure policy schema keeps every one of them for callers that do provide those
 * facts or scopes.
 */
const UNSUPPORTED_RUNTIME_RULE_KEYS: ReadonlyMap<string, string> = new Map([
  ['contentIds', 'runtime cannot supply the contentIds rule scope'],
  ['intent', 'runtime cannot supply the intent condition'],
  ['pathPrefix', 'runtime cannot supply the pathPrefix condition'],
]);
/** Rejection paths are positional and messages are fixed: no rule content is echoed. */
function unsupportedRuntimeRuleIssues(
  rules: readonly z.infer<typeof PolicyRuleRuntimeSchema>[],
): { path: (string | number)[]; message: string }[] {
  const issues: { path: (string | number)[]; message: string }[] = [];
  rules.forEach((rule, index) => {
    const scopes: [string, unknown][] = [['contentIds', rule.contentIds],
      ['intent', rule.when?.intent], ['pathPrefix', rule.when?.pathPrefix]];
    for (const [key, value] of scopes) {
      if (value === undefined) continue;
      issues.push({ path: key === 'contentIds' ? [index, key] : [index, 'when', key],
        message: UNSUPPORTED_RUNTIME_RULE_KEYS.get(key)! });
    }
  });
  return issues;
}
export const OwnerRulesSchema = PolicyRulesRuntimeSchema
  .refine(rules => rules.length <= 256 && new Set(rules.map(r => r.id)).size === rules.length, 'invalid rule inventory')
  .check(ctx => {
    for (const issue of unsupportedRuntimeRuleIssues(ctx.value)) {
      ctx.issues.push({ code: 'custom', path: issue.path, message: issue.message, input: ctx.value });
    }
  });
export const OwnerConfigSchema = z.strictObject({
  version: z.literal(1), revision: Id, checkerRevision: z.literal('aos-policy/1'),
  totalByteBudget: z.int().positive().max(262144), gateFailure: z.literal('closed'),
  rules: OwnerRulesSchema,
});
export const OperationSchema = z.strictObject({
  version: z.literal(1), schemaVersion: z.literal(1), composeVersion: z.literal(1),
  contentGeneration: z.int().nonnegative(), requestId: Id, sessionId: Id, ownerId: Id, nonce: Id,
  command: z.enum(['orient', 'gate', 'closeout', 'reference']), scenarioId: Id,
  subjectDigest: DigestSchema, configRevision: Id, checkerRevision: z.literal('aos-policy/1'),
  sourceRevision: SourceRevisionSchema,
  referenceId: ContentIdSchema.optional(),
  observations: z.array(ObservationSchema).max(256).refine(values => new Set(values.map(v => v.key)).size === values.length, 'duplicate observation'),
  projectConfig: ProjectConfigSchema.optional(), timeoutMs: z.int().min(1).max(30000).default(5000),
}).refine(op => op.command === 'reference' ? op.referenceId !== undefined : op.referenceId === undefined, 'referenceId is required only for reference');
export type Operation = z.infer<typeof OperationSchema>;
export type RuntimeObservation = z.infer<typeof ObservationSchema>;
export type OwnerConfig = z.infer<typeof OwnerConfigSchema>;
