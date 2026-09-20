/**
 * Runtime validation schemas for every public input boundary.
 *
 * Types are erased at runtime; a caller that ships JavaScript, JSON, or a
 * hand-rolled index can hand the pure core a shape that has never been checked.
 * Everything crossing a boundary is therefore parsed through the Zod schemas
 * here, and a parse failure becomes an `AosError` list — never a `TypeError`.
 *
 * Purity: no I/O, no clock, no import-time work.
 */
import { z } from 'zod';
import { aosError, type AosError } from '../protocols/error';
import { TokenSchema, HarnessSchema, ContentIdSchema, DigestSchema, RelativePathSchema, UniqueTokensSchema, JsonValueSchema, safeParse } from '../protocols/validation';
export { VersionedPayloadInputSchema } from '../protocols/payload';

const NON_EMPTY = TokenSchema;
const DIGEST = DigestSchema;
const RELATIVE_PATH = RelativePathSchema;

export const ActivationEventSchema = z.strictObject({
  id: NON_EMPTY,
  harness: NON_EMPTY,
});

export const ActivationStateSchema = z.strictObject({
  keys: UniqueTokensSchema.optional(),
  referenceIds: UniqueTokensSchema.optional(),
});

export const ActivationConditionRuntimeSchema = z.strictObject({
  harnesses: z.array(HarnessSchema).min(1),
  event: NON_EMPTY,
  state: NON_EMPTY.optional(),
});

export const ContentDocumentRuntimeSchema = z.strictObject({
  id: ContentIdSchema,
  version: z.int().positive(),
  tier: z.enum(['kernel', 'reference']),
  targetHarnesses: z.array(HarnessSchema).min(1),
  byteBudget: z.int().positive(),
  activationConditions: z.array(ActivationConditionRuntimeSchema).min(1),
  summary: z.string().nullable(),
  body: z.string().refine(body => body.trim().length > 0, "empty content body"),
  sourcePath: RELATIVE_PATH,
  bytes: z.int().nonnegative(),
  digest: DIGEST,
});

export const StaticBlockSchema = z.strictObject({
  id: NON_EMPTY,
  text: z.string(),
});

export const ComposeIndexSchema = z.strictObject({
  documents: z.array(ContentDocumentRuntimeSchema).refine(docs => new Set(docs.map(d => d.id)).size === docs.length && new Set(docs.map(d => d.sourcePath)).size === docs.length, "duplicate content id or source path"),
  staticBlocks: z.array(StaticBlockSchema).optional(),
  totalByteBudget: z.int().positive().optional(),
  mustFireIds: UniqueTokensSchema.optional(),
  mustFireKernelIds: UniqueTokensSchema.optional(),
  mustFireStaticIds: UniqueTokensSchema.optional(),
});

export const PolicyEventRuntimeSchema = ActivationEventSchema.extend({ intent: NON_EMPTY.optional() });
export const ObservationRuntimeSchema = z.strictObject({
  key: NON_EMPTY,
  status: z.enum(['fresh', 'missing', 'stale', 'unavailable']),
  value: JsonValueSchema.optional(),
  detail: z.string().optional(),
}).refine(o => o.status !== 'fresh' || o.value !== undefined, 'fresh observation requires a JSON value');
export const PolicyFactsRuntimeSchema = z.strictObject({
  subjectDigest: DIGEST,
  observations: z.array(ObservationRuntimeSchema).refine(obs => new Set(obs.map(o => o.key)).size === obs.length, 'duplicate observation key'),
  paths: z.array(RELATIVE_PATH).optional(),
  context: z.record(z.string(), JsonValueSchema).optional(),
});
export const PolicyConditionRuntimeSchema = z.strictObject({
  event: NON_EMPTY.optional(), harness: NON_EMPTY.optional(), intent: NON_EMPTY.optional(),
  observation: NON_EMPTY.optional(), equals: JsonValueSchema.optional(),
  truthy: NON_EMPTY.optional(), pathPrefix: RELATIVE_PATH.optional(),
}).refine(c => Object.values(c).some(v => v !== undefined), 'empty condition')
  .refine(c => c.equals === undefined || c.observation !== undefined, 'equals needs observation');
export const PolicyRuleRuntimeSchema = z.strictObject({
  id: NON_EMPTY, decision: z.enum(['allow', 'deny']),
  when: PolicyConditionRuntimeSchema.optional(),
  requires: UniqueTokensSchema.optional(), contentIds: UniqueTokensSchema.optional(),
  reason: z.string().min(1).optional(),
});
export const PolicyRulesRuntimeSchema = z.array(PolicyRuleRuntimeSchema);
export const PolicyContextRuntimeSchema = z.strictObject({
  configRevision: NON_EMPTY,
  checkerRevision: z.literal('aos-policy/1'),
});
/** Core-only configuration; adapters own installation and persistence settings. */
export const CoreConfigSchema = z.strictObject({
  version: z.literal(1), revision: NON_EMPTY,
  totalByteBudget: z.int().positive(),
  checkerRevision: z.literal('aos-policy/1'),
});
export type CoreConfig = z.infer<typeof CoreConfigSchema>;
export const ContentManifestRuntimeSchema = z.strictObject({
  version: z.literal(1), owner: NON_EMPTY, generation: z.int().nonnegative(),
  sources: z.array(z.strictObject({ path: RELATIVE_PATH, digest: DIGEST, id: ContentIdSchema })),
});
export const MembershipScenarioRuntimeSchema = z.strictObject({
  id: NON_EMPTY, harness: NON_EMPTY, event: NON_EMPTY,
  stateKeys: UniqueTokensSchema.optional(),
  expectedIds: UniqueTokensSchema,
  expectedKernelIds: UniqueTokensSchema,
  expectedStaticIds: UniqueTokensSchema,
});
export const MembershipManifestRuntimeSchema = z.strictObject({
  version: z.literal(1), owner: NON_EMPTY, generation: z.int().nonnegative(),
  scenarios: z.array(MembershipScenarioRuntimeSchema),
});

/**
 * Parse `value` with `schema`. On success returns the typed value; on failure
 * returns an `AosError` list describing only the failing paths — never the value.
 */
export function parseOrErrors<T>(
  schema: z.ZodType<T>,
  value: unknown,
  init: { code?: AosError['code']; id?: string | null; path?: string | null; label: string },
): { ok: true; value: T } | { ok: false; errors: AosError[] } {
  const parsed = safeParse(schema, value);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join('.'),
    message: issue.message,
  }));
  return {
    ok: false,
    errors: [
      aosError(init.code ?? 'invalid-input-shape', `${init.label} failed runtime validation`, {
        details: { issues, received: jsonTypeName(value) },
        id: init.id ?? null,
        path: init.path ?? null,
      }),
    ],
  };
}

/** JSON-safe type name for a rejected input (never echoes content). */
export function jsonTypeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
