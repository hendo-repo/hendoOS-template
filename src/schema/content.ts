/**
 * Content document schema — the runtime-validated contract for compiled content.
 *
 * Frontmatter is MANDATORY and strictly validated with Zod. The six required keys
 * are `id`, `version`, `tier`, `target_harnesses`, `byte_budget`,
 * `activation_conditions`; any additional key is rejected (`.strict()`), so a typo
 * fails the build instead of silently disabling a rule.
 *
 * The compiled `ContentDocument` is the *only* shape the rest of the core sees:
 * a generic id (harness-neutral string), a parsed activation-condition list, a
 * byte budget, the verbatim body, and the source digest. Nothing vendor-specific
 * survives this boundary.
 *
 * Purity: no I/O, no clock, no randomness, no import-time work.
 */
import { z } from 'zod';
import { ContentIdSchema, TokenSchema, HarnessSchema, safeParse } from '../protocols/validation';
import { aosError, type AosError } from '../protocols/error';
import { digestOfString, type Json } from '../protocols/json';
import { outcome, type Outcome } from '../protocols/outcome';
import { normalizeRelativePath } from '../protocols/paths';
import { assertByteBudget, byteLength, normalizeNewlines } from '../protocols/text';
import { parseFrontmatter } from './frontmatter';

/** `kernel` content carries load-bearing rules; `reference` content carries depth. */
export const CONTENT_TIERS = ['kernel', 'reference'] as const;
export type ContentTier = (typeof CONTENT_TIERS)[number];

/** Wildcard harness id matching every harness in an activation test. */
export const ANY_HARNESS = '*';

export const ActivationConditionSchema = z.strictObject({
  /** Harness ids this condition fires for; `*` (ANY_HARNESS) matches all. */
  harnesses: z.array(HarnessSchema).min(1),
  /** Event type, e.g. `session-start`, `pre-edit`. Generic, never a vendor event name. */
  event: TokenSchema,
  /** Optional state key required for the condition to fire. */
  state: TokenSchema.optional(),
});

export const ContentFrontmatterSchema = z.strictObject({
  id: ContentIdSchema,
  version: z.int().positive(),
  tier: z.enum(CONTENT_TIERS),
  target_harnesses: z.array(HarnessSchema).min(1),
  byte_budget: z.int().positive(),
  activation_conditions: z.array(ActivationConditionSchema).min(1),
  summary: z.string().min(1).optional(),
});

export type ActivationCondition = z.infer<typeof ActivationConditionSchema>;
export type ContentFrontmatter = z.infer<typeof ContentFrontmatterSchema>;

export interface ContentDocument {
  id: string;
  version: number;
  tier: ContentTier;
  targetHarnesses: readonly string[];
  byteBudget: number;
  activationConditions: readonly ActivationCondition[];
  summary: string | null;
  /** Body verbatim, newline-normalized, never trimmed. */
  body: string;
  /** Normalized repo-relative source path (safe-path validated). */
  sourcePath: string;
  /** UTF-8 bytes of the whole source document (frontmatter included). */
  bytes: number;
  /** `sha256:<hex>` of the whole source document. */
  digest: string;
}

/** Render a Zod issue list into an `AosError` and a JSON-safe detail list. */
export function zodIssuesToErrors(
  issues: readonly { path: readonly PropertyKey[]; message: string; code?: string }[],
  init: { path?: string | null; id?: string | null; code?: AosError['code'] } = {},
): AosError[] {
  const details = issues.map((issue) => ({
    path: issue.path.map((part) => String(part)).join('.'),
    message: issue.message,
  }));
  return [
    aosError(init.code ?? 'frontmatter-schema-invalid', describeSchemaFailure(details), {
      details: { issues: details },
      path: init.path ?? null,
      id: init.id ?? null,
    }),
  ];
}

function describeSchemaFailure(details: readonly { path: string; message: string }[]): string {
  if (details.length === 0) return 'frontmatter failed schema validation';
  const first = details[0] as { path: string; message: string };
  const where = first.path === '' ? '<root>' : first.path;
  return `frontmatter failed schema validation at \`${where}\`: ${first.message} (${details.length} issue${details.length === 1 ? '' : 's'})`;
}

/**
 * Compile one source file into a `ContentDocument`. Pure.
 *
 * Failure modes (all returned, never thrown): unsafe `sourcePath`, missing or
 * malformed frontmatter, schema violations, empty body, byte-budget overrun.
 */
export function compileContentDocument(
  sourcePath: unknown,
  source: unknown,
): Outcome<ContentDocument | null> {
  const errors: AosError[] = [];

  if (typeof sourcePath !== 'string' || typeof source !== 'string') return outcome(null, [aosError('invalid-input-shape', 'source path and text must be strings')], true);
  const safePath = normalizeRelativePath(sourcePath);
  if (!safePath.ok) {
    errors.push(safePath.error);
    return outcome(null, errors, true);
  }
  const path = safePath.path;

  const parsed = parseFrontmatter(source);
  errors.push(...parsed.errors);
  if (!parsed.ok) return outcome(null, errors, true);

  if (!parsed.value.hasFrontmatter || parsed.value.data === null) {
    errors.push(
      aosError('frontmatter-missing', 'content source has no frontmatter block', { path }),
    );
    return outcome(null, errors, true);
  }

  const validated = safeParse(ContentFrontmatterSchema, parsed.value.data);
  if (!validated.success) {
    errors.push(...zodIssuesToErrors(validated.error.issues, { path }));
    return outcome(null, errors, true);
  }
  const frontmatter = validated.data;

  if (parsed.value.body.trim() === '') {
    errors.push(
      aosError('content-body-empty', 'content body is empty (frontmatter-only document)', {
        path,
        id: frontmatter.id,
      }),
    );
  }

  const document: ContentDocument = {
    id: frontmatter.id,
    version: frontmatter.version,
    tier: frontmatter.tier,
    targetHarnesses: Object.freeze([...frontmatter.target_harnesses]),
    byteBudget: frontmatter.byte_budget,
    activationConditions: Object.freeze(
      frontmatter.activation_conditions.map((condition) => ({
        harnesses: Object.freeze([...condition.harnesses]) as unknown as string[],
        event: condition.event,
        ...(condition.state === undefined ? {} : { state: condition.state }),
      })),
    ),
    summary: frontmatter.summary ?? null,
    body: parsed.value.body,
    sourcePath: path,
    bytes: byteLength(parsed.value.source),
    digest: digestOfString(parsed.value.source),
  };

  const budgetError = assertByteBudget(parsed.value.source, document.byteBudget, path);
  if (budgetError) errors.push({ ...budgetError, id: document.id });

  return outcome(document, errors, errors.length > 0);
}

export interface ContentSourceFile {
  path: string;
  text: string;
}

export interface ContentCorpus {
  documents: readonly ContentDocument[];
  byId: ReadonlyMap<string, ContentDocument>;
  /** Ids that appeared in more than one source, in first-seen order. */
  duplicateIds: readonly string[];
  /** Source paths rejected before parsing, in input order. */
  rejectedPaths: readonly string[];
}

/**
 * Compile a set of source files into a corpus, deterministically.
 *
 * Order: sources are processed in input order but the corpus is sorted by content
 * id, so two runs over the same set in different orders yield identical corpora.
 * Duplicate ids are an error and only the first (by id order) document is kept.
 */
export function buildContentCorpus(input: unknown): Outcome<ContentCorpus> {
  const parsed = safeParse(z.array(z.strictObject({ path: z.string(), text: z.string() })), input);
  if (!parsed.success) return outcome({ documents: [], byId: new Map(), duplicateIds: [], rejectedPaths: [] }, [aosError('invalid-input-shape', 'content sources failed validation')], true);
  const files = parsed.data;
  const errors: AosError[] = [];
  const documents: ContentDocument[] = [];
  const rejectedPaths: string[] = [];

  const sourcePaths = new Set<string>();
  for (const file of files) {
    const normalized = normalizeRelativePath(file.path);
    if (normalized.ok && sourcePaths.has(normalized.path)) errors.push(aosError('internal-invariant', 'duplicate content source path', { path: normalized.path }));
    if (normalized.ok) sourcePaths.add(normalized.path);
    const compiled = compileContentDocument(file.path, file.text);
    errors.push(...compiled.errors);
    if (compiled.value) documents.push(compiled.value);
    else rejectedPaths.push(file.path);
  }

  documents.sort(
    (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || (a.sourcePath < b.sourcePath ? -1 : 1),
  );

  const byId = new Map<string, ContentDocument>();
  const duplicateIds: string[] = [];
  const kept: ContentDocument[] = [];
  for (const document of documents) {
    if (byId.has(document.id)) {
      duplicateIds.push(document.id);
      errors.push(
        aosError('duplicate-content-id', `content id \`${document.id}\` appears in more than one source`, {
          details: { id: document.id, sources: [byId.get(document.id)?.sourcePath ?? '?', document.sourcePath] },
          id: document.id,
          path: document.sourcePath,
        }),
      );
      continue;
    }
    byId.set(document.id, document);
    kept.push(document);
  }

  return outcome({ documents: kept, byId, duplicateIds, rejectedPaths }, errors, rejectedPaths.length > 0);
}

/** Serialize a document's frontmatter back to canonical YAML text (for tests/audits). */
export function serializeFrontmatter(document: {
  id: string;
  version: number;
  tier: ContentTier;
  targetHarnesses: readonly string[];
  byteBudget: number;
  activationConditions: readonly ActivationCondition[];
  summary?: string | null;
}): string {
  const lines = ['---'];
  lines.push(`id: ${document.id}`);
  lines.push(`version: ${document.version}`);
  lines.push(`tier: ${document.tier}`);
  lines.push(`target_harnesses: [${document.targetHarnesses.join(', ')}]`);
  lines.push(`byte_budget: ${document.byteBudget}`);
  if (document.summary) lines.push(`summary: ${document.summary}`);
  lines.push('activation_conditions:');
  for (const condition of document.activationConditions) {
    lines.push(`  - harnesses: [${condition.harnesses.join(', ')}]`);
    lines.push(`    event: ${condition.event}`);
    if (condition.state) lines.push(`    state: ${condition.state}`);
  }
  lines.push('---');
  return lines.join('\n');
}

/** Narrow a JSON value to the wire form of a content document (audit output). */
export function contentDocumentToJson(document: ContentDocument): Json {
  return {
    id: document.id,
    version: document.version,
    tier: document.tier,
    target_harnesses: [...document.targetHarnesses],
    byte_budget: document.byteBudget,
    bytes: document.bytes,
    digest: document.digest,
    source_path: document.sourcePath,
    summary: document.summary,
    activation_conditions: document.activationConditions.map((condition) => ({
      harnesses: [...condition.harnesses],
      event: condition.event,
      ...(condition.state === undefined ? {} : { state: condition.state }),
    })),
  };
}

export { normalizeNewlines };
