/**
 * Versioned render payload assembly.
 *
 * A payload is assembled from ordered ordered *segments* and split into exactly two
 * regions by construction:
 *
 * ```
 * text = staticPrefix + dynamicSuffix
 * ```
 *
 * `staticPrefix` contains only the segments the caller marked static (harness/global
 * instructions); `dynamicSuffix` contains only the segments marked dynamic (event,
 * state, index contributions). Because the regions are built by concatenation and
 * never by a shared layout pass:
 *
 * - adding, removing or editing a dynamic segment cannot change `staticPrefix`,
 *   `staticHash`, or any static segment's byte range — verified by the
 *   `payload/prefix-invariance` scenario.
 * - `hash` covers the whole payload; `bytes` is the UTF-8 byte sum of the two regions.
 *
 * `sourceMap` records, for every segment, where it starts (`line`/`column`, 0-based)
 * and its offset/length in the payload — the evidence that makes a downstream
 * failure traceable to a source id.
 *
 * Purity: no I/O, no clock, no randomness, no import-time work. Segment text is
 * stored verbatim (callers normalize newlines before calling); no trimming, folding
 * or truncation happens here.
 */
import { z } from 'zod';
import { aosError, type AosError } from './error';
import { digestOfString } from './json';
import { outcome, type Outcome } from './outcome';
import { byteLength } from './text';
import { TokenSchema, RelativePathSchema, UniqueTokensSchema, DigestSchema, safeParse } from './validation';

/**
 * Wire schema for a payload segment. Exported so callers that accept segments
 * from JSON can validate them before they reach the composer.
 */
export const JSON_PAYLOAD_SEGMENT_SCHEMA = z.strictObject({
  id: TokenSchema,
  text: z.string(),
  sourceIds: UniqueTokensSchema.optional(),
  sourcePath: RelativePathSchema.optional(),
});

export const VersionedPayloadInputSchema = z.strictObject({
  staticSegments: z.array(JSON_PAYLOAD_SEGMENT_SCHEMA).optional(),
  dynamicSegments: z.array(JSON_PAYLOAD_SEGMENT_SCHEMA).optional(),
  version: z.literal(1).optional(), schemaVersion: z.literal(1).optional(), composeVersion: z.literal(1).optional(),
  budget: z.int().nonnegative().nullable().optional(), mustFireIds: UniqueTokensSchema.optional(),
});

/** Payload layout version. Bump only with a documented consumer migration. */
export const VERSIONED_PAYLOAD_VERSION = 1;
export const SUPPORTED_PAYLOAD_VERSIONS: readonly number[] = [1];

/** Version of the *content schema* the payload was composed from. */
export const PAYLOAD_SCHEMA_VERSION = 1;
/** Version of the composer that produced the payload. Bumped by `compose`. */
export const PAYLOAD_COMPOSE_VERSION = 1;

export type SegmentRegion = 'static' | 'dynamic';

export interface PayloadSegment {
  /** Stable segment id. Unique across the whole payload; generic (never vendor-named). */
  id: string;
  text: string;
  /** Content ids this segment was rendered from; empty for framework-owned text. */
  sourceIds?: readonly string[];
  /** Normalized repo-relative source path of the primary source id, when known. */
  sourcePath?: string;
}

export interface SourceMapEntry {
  id: string;
  region: SegmentRegion;
  /** 0-based line of the segment start in `text`. */
  line: number;
  /** 0-based column of the segment start in `text`. */
  column: number;
  /** UTF-8 byte offset of the segment start in `text`. */
  byteOffset: number;
  /** UTF-8 byte length of the segment. */
  byteLength: number;
  sourceIds: readonly string[];
  /** Repo-relative source file for the primary source id; null for framework text. */
  sourcePath: string | null;
}

export interface VersionedPayload {
  version: number;
  /** Content schema version the payload was composed from. */
  schemaVersion: number;
  /** Composer version that produced the payload. */
  composeVersion: number;
  /** `staticPrefix + dynamicSuffix`. */
  text: string;
  /** UTF-8 byte length of the whole payload. */
  bytes: number;
  /** Whole-payload byte budget the payload was checked against, or null. */
  budget: number | null;
  /** Scenario must-fire id set the payload was validated against, sorted. */
  mustFireIds: readonly string[];
  staticPrefix: string;
  dynamicSuffix: string;
  /** `sha256:<hex>` of `text`. */
  hash: string;
  /** `sha256:<hex>` of `staticPrefix` — invariant under dynamic-only changes. */
  staticHash: string;
  /** `sha256:<hex>` of `dynamicSuffix`. */
  dynamicHash: string;
  sourceMap: readonly SourceMapEntry[];
  /** True when the payload carries no segments at all. */
  empty: boolean;
  /** True when the caller supplied no dynamic segments. */
  dynamicEmpty: boolean;
}

export const SourceMapEntrySchema = z.strictObject({
  id: TokenSchema, region: z.enum(['static', 'dynamic']),
  line: z.int().nonnegative(), column: z.int().nonnegative(),
  byteOffset: z.int().nonnegative(), byteLength: z.int().nonnegative(),
  sourceIds: UniqueTokensSchema, sourcePath: RelativePathSchema.nullable(),
});
export const VersionedPayloadSchema = z.strictObject({
  version: z.literal(1), schemaVersion: z.literal(1), composeVersion: z.literal(1),
  text: z.string(), bytes: z.int().nonnegative(), budget: z.int().nonnegative().nullable(),
  mustFireIds: UniqueTokensSchema, staticPrefix: z.string(), dynamicSuffix: z.string(),
  hash: DigestSchema, staticHash: DigestSchema, dynamicHash: DigestSchema,
  sourceMap: z.array(SourceMapEntrySchema), empty: z.boolean(), dynamicEmpty: z.boolean(),
}).refine(p => p.text === p.staticPrefix + p.dynamicSuffix && p.bytes === byteLength(p.text)
  && p.hash === digestOfString(p.text) && p.staticHash === digestOfString(p.staticPrefix)
  && p.dynamicHash === digestOfString(p.dynamicSuffix), 'payload bytes or hashes do not match text')
  .refine(p => {
    const seen = new Set<string>();
    let offset = 0;
    let dynamic = false;
    const bytes = new TextEncoder().encode(p.text);
    for (const entry of p.sourceMap) {
      if (seen.has(entry.id) || entry.byteOffset !== offset) return false;
      seen.add(entry.id);
      if (entry.region === 'dynamic') dynamic = true;
      if (dynamic && entry.region === 'static') return false;
      if (entry.region === 'static' && offset + entry.byteLength > byteLength(p.staticPrefix)) return false;
      if (entry.region === 'dynamic' && offset < byteLength(p.staticPrefix)) return false;
      const prefix = new TextDecoder().decode(bytes.slice(0, offset));
      const lines = prefix.split('\n');
      if (entry.line !== lines.length - 1 || entry.column !== lines[lines.length - 1]!.length) return false;
      offset += entry.byteLength;
    }
    return offset === p.bytes && p.empty === (p.sourceMap.length === 0)
      && p.dynamicEmpty === !p.sourceMap.some(e => e.region === 'dynamic');
  }, 'source map does not cover payload regions');

export interface ComposeVersionedPayloadInput {
  staticSegments?: readonly PayloadSegment[];
  dynamicSegments?: readonly PayloadSegment[];
  /** Defaults to `VERSIONED_PAYLOAD_VERSION`. */
  version?: number;
  /** Defaults to `PAYLOAD_SCHEMA_VERSION`. */
  schemaVersion?: number;
  /** Defaults to `PAYLOAD_COMPOSE_VERSION`. */
  composeVersion?: number;
  budget?: number | null;
  mustFireIds?: readonly string[];
}

/** Assemble a versioned payload from static + dynamic segments. Pure. */
export function composeVersionedPayload(
  rawInput: unknown = {},
): Outcome<VersionedPayload> {
  const parsed = safeParse(VersionedPayloadInputSchema, rawInput);
  if (!parsed.success) {
    return outcome(composeVersionedPayload({}).value, [aosError('invalid-input-shape', 'payload input failed validation')], true);
  }
  const input = parsed.data;
  const version = input.version ?? VERSIONED_PAYLOAD_VERSION;
  const schemaVersion = input.schemaVersion ?? PAYLOAD_SCHEMA_VERSION;
  const composeVersion = input.composeVersion ?? PAYLOAD_COMPOSE_VERSION;
  const staticSegments = input.staticSegments ?? [];
  const dynamicSegments = input.dynamicSegments ?? [];
  const budget = input.budget ?? null;
  const mustFireIds = [...new Set(input.mustFireIds ?? [])].sort();
  const errors: AosError[] = [];

  if (!SUPPORTED_PAYLOAD_VERSIONS.includes(version)) {
    errors.push(
      aosError('unsupported-version', `unsupported payload version ${String(version)}`, {
        details: { version, supported: [...SUPPORTED_PAYLOAD_VERSIONS] },
      }),
    );
  }

  const seen = new Set<string>();
  for (const [region, segments] of [
    ['static', staticSegments],
    ['dynamic', dynamicSegments],
  ] as const) {
    for (const raw of segments) {
      const segment = raw as Partial<PayloadSegment> | null;
      if (!segment || typeof segment !== 'object' || typeof segment.text !== 'string') {
        errors.push(
          aosError('internal-invariant', 'payload segment must be an object with string `text`', {
            details: { region },
          }),
        );
        continue;
      }
      if (typeof segment.id !== 'string' || segment.id.trim() === '') {
        errors.push(
          aosError('internal-invariant', 'payload segment id must be non-empty', { details: { region } }),
        );
        continue;
      }
      if (seen.has(segment.id)) {
        errors.push(
          aosError('internal-invariant', `duplicate payload segment id ${segment.id}`, {
            details: { id: segment.id, region },
            id: segment.id,
          }),
        );
        continue;
      }
      seen.add(segment.id);
    }
  }

  const staticPrefix = join(staticSegments);
  const dynamicSuffix = join(dynamicSegments);
  const text = staticPrefix + dynamicSuffix;

  if (budget !== null && byteLength(text) > budget) errors.push(aosError('byte-budget-exceeded', 'payload exceeds byte budget', { details: { actual: byteLength(text), budget } }));
  return outcome(
    {
      version,
      schemaVersion,
      composeVersion,
      text,
      bytes: byteLength(staticPrefix) + byteLength(dynamicSuffix),
      budget,
      mustFireIds,
      staticPrefix,
      dynamicSuffix,
      hash: digestOfString(text),
      staticHash: digestOfString(staticPrefix),
      dynamicHash: digestOfString(dynamicSuffix),
      sourceMap: buildSourceMap(text, staticSegments, dynamicSegments),
      empty: staticSegments.length === 0 && dynamicSegments.length === 0,
      dynamicEmpty: dynamicSegments.length === 0,
    },
    errors,
    staticSegments.length === 0 || dynamicSegments.length === 0 || errors.length > 0,
  );
}

function join(segments: readonly PayloadSegment[]): string {
  let out = '';
  for (const segment of segments) out += segment.text;
  return out;
}

function buildSourceMap(
  text: string,
  staticSegments: readonly PayloadSegment[],
  dynamicSegments: readonly PayloadSegment[],
): SourceMapEntry[] {
  const entries: SourceMapEntry[] = [];
  let offset = 0;
  let line = 0;
  let lineStart = 0;

  const push = (region: SegmentRegion, segments: readonly PayloadSegment[]): void => {
    for (const segment of segments) {
      entries.push({
        id: segment.id,
        region,
        line,
        column: offset - lineStart,
        byteOffset: byteLength(text.slice(0, offset)),
        byteLength: byteLength(segment.text),
        sourceIds: [...(segment.sourceIds ?? [])],
        sourcePath: segment.sourcePath ?? null,
      });
      for (let index = 0; index < segment.text.length; index += 1) {
        if (segment.text.charCodeAt(index) === 10) {
          line += 1;
          lineStart = offset + index + 1;
        }
      }
      offset += segment.text.length;
    }
  };

  push('static', staticSegments);
  push('dynamic', dynamicSegments);
  return entries;
}

/** Look up one segment's map entry. */
export function sourceMapEntry(
  payload: VersionedPayload,
  id: string,
): SourceMapEntry | undefined {
  return payload.sourceMap.find((entry) => entry.id === id);
}

/** Slice the payload back to exactly one segment's bytes, using the source map. */
export function segmentText(payload: VersionedPayload, id: string): string | undefined {
  const entry = sourceMapEntry(payload, id);
  if (!entry) return undefined;
  const start = entry.byteOffset;
  const end = start + entry.byteLength;
  const bytes = new TextEncoder().encode(payload.text);
  return new TextDecoder().decode(bytes.slice(start, end));
}
