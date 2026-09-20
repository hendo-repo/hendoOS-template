/**
 * `src/schema` — public interface (the first of three documented contract surfaces).
 *
 * Everything a consumer needs from the schema layer is re-exported here. Import
 * from `src/schema` (or `src/schema/index.ts`); never reach into a sibling module's
 * internals. Types and functions are plain exports — no classes, no singletons, no
 * module-level state, and this module performs no I/O at import time.
 *
 * ## The three exported functions a consumer actually calls
 *
 * 1. `buildContentCorpus(files)` — compile sources into validated content documents.
 * 2. `buildActivation(event, state, documents)` — structured activation for one
 *    `(event, state)` query.
 * 3. `evaluateMembership(manifest, documents)` — exact scenario-set check; also
 *    `compareContentManifest(manifest, corpus)` for digest drift.
 *
 * Everything else here is a type, a Zod schema, or a helper those three build on.
 */
export {
  ANY_HARNESS,
  CONTENT_TIERS,
  ActivationConditionSchema,
  ContentFrontmatterSchema,
  buildContentCorpus,
  compileContentDocument,
  contentDocumentToJson,
  serializeFrontmatter,
  zodIssuesToErrors,
  type ActivationCondition,
  type ContentCorpus,
  type ContentDocument,
  type ContentFrontmatter,
  type ContentSourceFile,
  type ContentTier,
} from './content';

export {
  activatedIds,
  buildActivation,
  declaredHarnesses,
  type ActivationEntry,
  type ActivationEvent,
  type ActivationResult,
  type ActivationState,
} from './activation';

export {
  CONTENT_MANIFEST_VERSION,
  MEMBERSHIP_MANIFEST_VERSION,
  buildContentManifest,
  compareContentManifest,
  evaluateMembership,
  manifestDigest,
  validateContentManifest,
  validateMembershipManifest,
  type ContentManifest,
  type ManifestComparison,
  type ManifestSourceEntry,
  type MembershipEvaluation,
  type MembershipManifest,
  type MembershipScenario,
  type ScenarioEvaluation,
} from './manifest';

export {
  parseFrontmatter,
  type FrontmatterParseResult,
  type ParsedFrontmatter,
} from './frontmatter';

/**
 * Runtime boundary schemas. Types are erased; anything crossing a public
 * boundary is parsed through these so a malformed input fails closed with an
 * `AosError` instead of a `TypeError`.
 */
export {
  ActivationEventSchema,
  ActivationStateSchema,
  ContentDocumentRuntimeSchema,
  ContentManifestRuntimeSchema,
  ComposeIndexSchema,
  MembershipManifestRuntimeSchema,
  MembershipScenarioRuntimeSchema,
  ObservationRuntimeSchema,
  PolicyEventRuntimeSchema,
  PolicyFactsRuntimeSchema,
  PolicyConditionRuntimeSchema,
  PolicyRuleRuntimeSchema,
  PolicyRulesRuntimeSchema,
  PolicyContextRuntimeSchema,
  CoreConfigSchema,
  type CoreConfig,
  StaticBlockSchema,
  VersionedPayloadInputSchema,
  jsonTypeName,
  parseOrErrors,
} from './runtime';

/**
 * Protocol primitives re-exported for convenience: `Outcome`, `AosError` and `Json`
 * are the vocabulary of every public signature below, so a consumer of the schema
 * layer does not have to import a second path to type-check its own wrapper.
 */
export { aosError, hasError, isAosError, sortErrors, type AosError, type AosErrorCode, type AosErrorSeverity } from '../protocols/error';
export { canonicalize, digestOfJson, digestOfString, sha256Hex, type Json } from '../protocols/json';
export { outcome, type Outcome } from '../protocols/outcome';
export { normalizeRelativePath, isPathUnder, type PathResult } from '../protocols/paths';
export { byteLength, normalizedByteLength } from '../protocols/text';
export {
  JSON_PAYLOAD_SEGMENT_SCHEMA,
  VersionedPayloadSchema,
  SourceMapEntrySchema,
  PAYLOAD_COMPOSE_VERSION,
  PAYLOAD_SCHEMA_VERSION,
  SUPPORTED_PAYLOAD_VERSIONS,
  VERSIONED_PAYLOAD_VERSION,
  composeVersionedPayload,
  sourceMapEntry,
  type PayloadSegment,
  type SegmentRegion,
  type SourceMapEntry,
  type VersionedPayload,
} from '../protocols/payload';
