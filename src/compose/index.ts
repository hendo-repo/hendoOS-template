/** Pure context compiler. Kernel prefix depends only on harness and corpus.
 * Scenario activation and explicitly requested reference prose form the suffix.
 * Both all-content and kernel-only membership expectations are caller-owned.
 */
import { sortErrors, type AosError } from '../protocols/error';
import { aosError } from '../protocols/error';
import { digestOfString } from '../protocols/json';
import { outcome, type Outcome } from '../protocols/outcome';
import {
  buildActivation,
  type ActivationEvent,
  type ActivationResult,
  type ActivationState,
} from '../schema/activation';
import {
  ActivationEventSchema,
  ActivationStateSchema,
  ComposeIndexSchema,
  jsonTypeName,
  StaticBlockSchema,
  parseOrErrors,
} from '../schema/runtime';
import type { ContentDocument, ContentTier } from '../schema/content';
import { z } from 'zod';
import { normalizeRelativePath } from '../protocols/paths';
import { byteLength } from '../protocols/text';
import {
  PAYLOAD_COMPOSE_VERSION,
  PAYLOAD_SCHEMA_VERSION,
  composeVersionedPayload,
  type ComposeVersionedPayloadInput,
  type PayloadSegment,
  type VersionedPayload,
  VersionedPayloadSchema,
} from '../protocols/payload';
import { renderDocument, renderStaticBlock, type RenderedDocument } from './render';

/** A framework-owned text block that is always part of the static prefix. */
export interface StaticBlock {
  id: string;
  text: string;
}

export interface ComposeIndex {
  /** Compiled corpus. Order is irrelevant — activation sorts by id and tier. */
  documents: readonly ContentDocument[];
  /** Framework-owned blocks rendered before any content. Order IS significant. */
  staticBlocks?: readonly StaticBlock[];
  /** Optional whole-payload byte budget. Overrun is an error, not a truncation. */
  totalByteBudget?: number;
  /**
   * The exact activated-id set this scenario must fire. Required for a successful
   * compose: an edge that omits it fails with `membership-mismatch`.
   */
  mustFireIds?: readonly string[];
  /** Independently authored exact activated kernel set. Required for success. */
  mustFireKernelIds?: readonly string[];
}

export interface ComposeDiagnostics {
  /** Harness targeted by the query. */
  harness: string;
  event: string;
  /** State keys considered, sorted. */
  stateKeys: readonly string[];
  /** Ids that activated (kernel then reference, id ascending). */
  activatedIds: readonly string[];
  kernelIds: readonly string[];
  referenceIds: readonly string[];
  /** Activated kernel content declared these reference ids. */
  declaredReferenceIds: readonly string[];
  /** Declared reference ids that resolve to no document in the index. */
  missingDeclaredReferenceIds: readonly string[];
  /** References dropped because no activated kernel declared them. */
  unresolvedReferenceIds: readonly string[];
  /** Documents that do not target this harness. */
  untargetedIds: readonly string[];
  /** Ids that activated but were dropped for a reason (currently: unresolved reference). */
  droppedIds: readonly string[];
  /** Ids in `mustFireIds` that did not activate. */
  mustFireMissingIds: readonly string[];
  /** Ids that activated but were not in `mustFireIds`. */
  mustFireExtraIds: readonly string[];
  /** True when a `mustFireIds` set was supplied at all. */
  mustFireDeclared: boolean;
  /** Per-entry byte figures, in output order. */
  entryBytes: readonly { id: string; bytes: number; budget: number | null }[];
  documentCount: number;
  staticBlockCount: number;
  totalBytes: number;
  budget: number | null;
  /** Content schema version the payload was composed from. */
  schemaVersion: number;
  /** Composer version that produced the payload. */
  composeVersion: number;
  /** True when the index has no documents. */
  indexEmpty: boolean;
  /** True when nothing activated. */
  selectionEmpty: boolean;
  /** True when no content activated and no reference prose was requested. */
  dynamicEmpty: boolean;
  /** `sha256:<hex>` over the ordered dynamic id list. */
  activationDigest: string;
}

export interface ComposedPayload {
  /** Versioned payload: `text`, `bytes`, `staticPrefix`, `dynamicSuffix`, hashes, sources. */
  payload: VersionedPayload;
  /** Rendered kernel entries followed by explicitly requested references. */
  entries: readonly RenderedDocument[];
  activation: ActivationResult;
  diagnostics: ComposeDiagnostics;
}

export const COMPOSE_VERSION = PAYLOAD_COMPOSE_VERSION;
export const COMPOSE_SCHEMA_VERSION = PAYLOAD_SCHEMA_VERSION;

const REFERENCES_LINE = /^references:\s*(.*)$/i;
const REFERENCE_SEPARATOR = /[,\s]+/;

/** Render the volatile event/state metadata block. Deterministic, content-free. */
export function renderContextBlock(
  event: ActivationEvent,
  stateKeys: readonly string[],
  activatedIds: readonly string[],
): string {
  const lines = [
    `<!-- aos:context event=${event.id} harness=${event.harness} state=${stateKeys.join(',')} -->`,
    `<!-- aos:activated ids=${activatedIds.join(',')} -->`,
  ];
  return `${lines.join('\n')}\n`;
}

/**
 * Extract reference ids a kernel body declares, via `References: a, b` lines.
 * Deterministic: returns a sorted, deduplicated list. Pure.
 */
export function declaredReferences(body: string): string[] {
  const found = new Set<string>();
  for (const line of body.split('\n')) {
    const match = REFERENCES_LINE.exec(line.trim());
    if (!match) continue;
    const rest = (match[1] ?? '').replace(/<!--.*?-->/g, '').trim();
    if (rest === '' || /^(none|n\/a)\.?$/i.test(rest)) continue;
    for (const token of rest.split(REFERENCE_SEPARATOR)) {
      const id = token.trim().replace(/[.,;]$/, '');
      if (id !== '') found.add(id);
    }
  }
  return [...found].sort();
}

/** An empty, well-formed payload used when the input never reached composition. */
function emptyPayload(): VersionedPayload {
  return composeVersionedPayload({}).value;
}

/**
 * Compose a render payload for one `(event, state, index)`. Pure, deterministic,
 * no I/O. See the module header for the full contract.
 */
export function compose(
  event: unknown,
  state: unknown,
  index: unknown,
): Outcome<ComposedPayload> {
  const errors: AosError[] = [];

  // --- 1. Runtime validation of every input boundary -------------------------
  // Malformed input must fail closed with a named error, never a TypeError.
  const eventParse = parseOrErrors(ActivationEventSchema, event, {
    label: 'compose event',
    code: 'invalid-input-shape',
  });
  const stateParse = parseOrErrors(ActivationStateSchema, state, {
    label: 'compose state',
    code: 'invalid-input-shape',
  });
  const indexParse = parseOrErrors(ComposeIndexSchema, index, {
    label: 'compose index',
    code: 'invalid-input-shape',
  });

  errors.push(...(eventParse.ok ? [] : eventParse.errors));
  errors.push(...(stateParse.ok ? [] : stateParse.errors));
  errors.push(...(indexParse.ok ? [] : indexParse.errors));

  if (!eventParse.ok || !stateParse.ok || !indexParse.ok) {
    const activation = buildActivation({ id: '', harness: '' }, { keys: [] }, []);
    const payload = emptyPayload();
    return outcome(
      {
        payload,
        entries: [],
        activation: activation.value,
        diagnostics: emptyDiagnostics(eventParse.ok ? eventParse.value : { id: '', harness: '' }, payload),
      },
      errors,
      true,
    );
  }

  const queryEvent: ActivationEvent = eventParse.value;
  const queryState: ActivationState = stateParse.value;
  const parsedIndex = indexParse.value;
  const documents = parsedIndex.documents;
  const staticBlocks = parsedIndex.staticBlocks ?? [];
  const budget = parsedIndex.totalByteBudget ?? null;
  const mustFireIds = parsedIndex.mustFireIds;

  // --- 2. Activation ---------------------------------------------------------
  const activation = buildActivation(
    { id: queryEvent.id, harness: queryEvent.harness },
    { keys: queryState.keys ?? [] },
    documents,
  );
  errors.push(...activation.errors);

  const allById = new Map<string, ContentDocument>();
  for (const doc of documents) {
    allById.set(doc.id, doc);
  }

  const activatedDocs = activation.value.ids
    .map((id) => allById.get(id))
    .filter((doc): doc is ContentDocument => doc !== undefined);

  // The prefix contains every kernel document for this harness, sorted by id.
  // Reference prose is emitted only for explicit state.referenceIds requests, and
  // only for references declared by a kernel *activated for this scenario*.
  const targeted = documents.filter(doc => doc.targetHarnesses.includes('*') || doc.targetHarnesses.includes(queryEvent.harness));
  const kernels = targeted.filter(doc => doc.tier === 'kernel').sort((a, b) => a.id < b.id ? -1 : 1);
  const activatedKernelIds = new Set(activation.value.kernelIds);
  const declaredReferenceIds = new Set<string>();
  const missingDeclaredReferenceIds: string[] = [];
  for (const doc of targeted) {
    const authorizes = doc.tier === 'kernel' && activatedKernelIds.has(doc.id);
    for (const id of declaredReferences(doc.body)) {
      if (authorizes) declaredReferenceIds.add(id);
      if (!targeted.some(target => target.id === id)) {
        missingDeclaredReferenceIds.push(id);
        errors.push(aosError('reference-declared-missing', 'declared content reference is unavailable', { id, path: doc.sourcePath }));
      }
    }
    for (const link of markdownLinks(doc.body)) {
      const resolved = resolveMarkdownLink(doc, link, targeted);
      if (!resolved) {
        errors.push(aosError('reference-declared-missing', 'Markdown reference does not resolve in this harness corpus', { path: doc.sourcePath, id: doc.id }));
      } else if (authorizes && resolved.tier === 'reference') {
        declaredReferenceIds.add(resolved.id);
      }
    }
  }
  const unresolvedReferenceIds: string[] = [];
  const droppedIds: string[] = [];
  for (const doc of activatedDocs) {
    if (doc.tier === 'reference' && !declaredReferenceIds.has(doc.id)) {
      unresolvedReferenceIds.push(doc.id);
      droppedIds.push(doc.id);
      errors.push(aosError('reference-unresolved', 'activated reference has no kernel declaration', { id: doc.id, path: doc.sourcePath }));
    }
  }
  const references: ContentDocument[] = [];
  for (const id of [...(queryState.referenceIds ?? [])].sort()) {
    const doc = targeted.find(candidate => candidate.id === id && candidate.tier === 'reference');
    if (!doc || !declaredReferenceIds.has(id)) {
      errors.push(aosError('reference-unresolved', 'requested reference is unavailable or undeclared', { id }));
      droppedIds.push(id);
    } else references.push(doc);
  }
  const included = [...kernels, ...references];

  // --- 4. Membership gate ----------------------------------------------------
  const mustFireDeclared = Array.isArray(mustFireIds);
  const expectedIds = [...new Set(mustFireIds ?? [])].sort();
  const actualIds = [...activation.value.ids];
  const actualSet = new Set(actualIds);
  const expectedSet = new Set(expectedIds);
  const mustFireMissingIds = expectedIds.filter((id) => !actualSet.has(id));
  const mustFireExtraIds = actualIds.filter((id) => !expectedSet.has(id));

  if (!mustFireDeclared) {
    errors.push(
      aosError('membership-mismatch', 'compose requires an explicit `mustFireIds` set for the scenario', {
        details: { event: queryEvent.id, harness: queryEvent.harness, actual: actualIds },
      }),
    );
  } else if (mustFireMissingIds.length > 0 || mustFireExtraIds.length > 0) {
    errors.push(
      aosError('membership-mismatch', 'activated id set does not match `mustFireIds`', {
        details: {
          event: queryEvent.id,
          harness: queryEvent.harness,
          missing: mustFireMissingIds,
          extra: mustFireExtraIds,
          expected: expectedIds,
          actual: actualIds,
        },
      }),
    );
  }

  const expectedKernelIds = parsedIndex.mustFireKernelIds;
  if (expectedKernelIds === undefined || JSON.stringify([...expectedKernelIds].sort()) !== JSON.stringify([...activation.value.kernelIds].sort())) {
    errors.push(aosError('membership-mismatch', 'activated kernel set does not match explicit mustFireKernelIds', {
      details: { expected: expectedKernelIds ?? null, actual: [...activation.value.kernelIds] },
    }));
  }

  // --- 5. Per-entry budget re-check -----------------------------------------
  const entries: RenderedDocument[] = included.map(renderDocument);
  const entryBytes = included.map((doc) => ({
    id: doc.id,
    bytes: byteLength(doc.body),
    budget: doc.byteBudget,
  }));

  for (const doc of targeted) {
    const actual = Math.max(byteLength(doc.body), doc.bytes);
    if (actual > doc.byteBudget) {
      const alreadyReported = activation.errors.some(
        (e) => e.code === 'byte-budget-exceeded' && e.id === doc.id,
      );
      if (!alreadyReported) {
        errors.push(
          aosError('byte-budget-exceeded', `content \`${doc.id}\` body exceeds its byte budget`, {
            details: { actual, budget: doc.byteBudget, over: actual - doc.byteBudget, measure: 'source-or-body-bytes' },
            path: doc.sourcePath,
            id: doc.id,
          }),
        );
      }
    }
  }

  // --- 6. Two-zone assembly --------------------------------------------------
  // Static zone: framework blocks and all targeted kernels.
  // Dynamic zone: requested references and event/state metadata.
  const staticSegments: PayloadSegment[] = staticBlocks.map((block) => {
    const rendered = renderStaticBlock(block.id, block.text);
    return { id: `static:${block.id}`, text: rendered.text, sourceIds: [] };
  });
  for (const entry of entries.filter(entry => entry.tier === 'kernel')) {
    const doc = included.find((candidate) => candidate.id === entry.id);
    staticSegments.push({
      id: `content:${entry.id}`,
      text: entry.text,
      sourceIds: [entry.id],
      ...(doc ? { sourcePath: doc.sourcePath } : {}),
    });
  }

  const dynamicSegments: PayloadSegment[] = [
    ...references.map(doc => ({ id: `content:${doc.id}`, text: renderDocument(doc).text, sourceIds: [doc.id], sourcePath: doc.sourcePath })),
    {
      id: 'context:event',
      text: renderContextBlock(queryEvent, activation.value.stateKeys, actualIds),
      sourceIds: [],
    },
  ];

  const payloadInput: ComposeVersionedPayloadInput = {
    staticSegments,
    dynamicSegments,
    schemaVersion: PAYLOAD_SCHEMA_VERSION,
    composeVersion: COMPOSE_VERSION,
    budget,
    mustFireIds: expectedIds,
  };
  const versioned = composeVersionedPayload(payloadInput);
  errors.push(...versioned.errors);

  if (budget !== null && versioned.value.bytes > budget) {
    errors.push(
      aosError('byte-budget-exceeded', `composed payload exceeds the index byte budget`, {
        details: {
          actual: versioned.value.bytes,
          budget,
          over: versioned.value.bytes - budget,
          measure: 'payload-bytes',
        },
      }),
    );
  }

  const sortedErrors = sortErrors(errors);
  const payload = versioned.value;

  const diagnostics: ComposeDiagnostics = {
    harness: queryEvent.harness,
    event: queryEvent.id,
    stateKeys: [...activation.value.stateKeys],
    activatedIds: actualIds,
    kernelIds: [...activation.value.kernelIds],
    referenceIds: included.filter((doc) => doc.tier === 'reference').map((doc) => doc.id),
    declaredReferenceIds: [...declaredReferenceIds].sort(),
    missingDeclaredReferenceIds,
    unresolvedReferenceIds: unresolvedReferenceIds.sort(),
    untargetedIds: [...activation.value.untargetedIds],
    droppedIds: droppedIds.sort(),
    mustFireMissingIds,
    mustFireExtraIds,
    mustFireDeclared,
    entryBytes,
    documentCount: documents.length,
    staticBlockCount: staticBlocks.length,
    totalBytes: payload.bytes,
    budget,
    schemaVersion: payload.schemaVersion,
    composeVersion: payload.composeVersion,
    indexEmpty: documents.length === 0,
    selectionEmpty: activation.value.empty,
    dynamicEmpty: activation.value.empty && references.length === 0,
    activationDigest: digestOfString(included.map((doc) => doc.id).join('\n')),
  };

  const result: ComposedPayload = {
    payload,
    entries,
    activation: activation.value,
    diagnostics,
  };

  const degraded =
    sortedErrors.length > 0 || documents.length === 0 || diagnostics.dynamicEmpty;
  return outcome(result, sortedErrors, degraded);
}

/** Diagnostics for input that never reached composition. Pure. */
function emptyDiagnostics(event: ActivationEvent, payload: VersionedPayload): ComposeDiagnostics {
  return {
    harness: event.harness,
    event: event.id,
    stateKeys: [],
    activatedIds: [],
    kernelIds: [],
    referenceIds: [],
    declaredReferenceIds: [],
    missingDeclaredReferenceIds: [],
    unresolvedReferenceIds: [],
    untargetedIds: [],
    droppedIds: [],
    mustFireMissingIds: [],
    mustFireExtraIds: [],
    mustFireDeclared: false,
    entryBytes: [],
    documentCount: 0,
    staticBlockCount: 0,
    totalBytes: payload.bytes,
    budget: null,
    schemaVersion: payload.schemaVersion,
    composeVersion: payload.composeVersion,
    indexEmpty: true,
    selectionEmpty: true,
    dynamicEmpty: true,
    activationDigest: digestOfString(''),
  };
}

/** Re-split an existing composition with a different static block set. Pure. */
export function recomposeWithStaticBlocks(
  composed: ComposedPayload,
  staticBlocks: readonly StaticBlock[],
): Outcome<VersionedPayload> {
  const payloadCheck = parseOrErrors(VersionedPayloadSchema, composed?.payload, { label: 'recompose payload' });
  const blocksCheck = parseOrErrors(z.array(StaticBlockSchema), staticBlocks, { label: 'recompose blocks' });
  if (!payloadCheck.ok || !blocksCheck.ok) return outcome(emptyPayload(), [...(payloadCheck.ok ? [] : payloadCheck.errors), ...(blocksCheck.ok ? [] : blocksCheck.errors)], true);
  const sourceSegments = payloadCheck.value.sourceMap
    .filter(entry => entry.region === 'dynamic' || entry.id.startsWith('content:'))
    .map(entry => ({ entry, segment: {
      id: entry.id,
      text: new TextDecoder().decode(new TextEncoder().encode(payloadCheck.value.text).slice(entry.byteOffset, entry.byteOffset + entry.byteLength)),
      sourceIds: [...entry.sourceIds],
      ...(entry.sourcePath === null ? {} : { sourcePath: entry.sourcePath }),
    } }));
  const input: ComposeVersionedPayloadInput = {
    staticSegments: [
      ...blocksCheck.value.map(block => ({ id: `static:${block.id}`, text: block.text, sourceIds: [] })),
      ...sourceSegments.filter(s => s.entry.region === 'static').map(s => s.segment),
    ],
    dynamicSegments: [
      ...sourceSegments.filter(s => s.entry.region === 'dynamic').map(s => s.segment),
    ],
    schemaVersion: payloadCheck.value.schemaVersion,
    composeVersion: payloadCheck.value.composeVersion,
    budget: payloadCheck.value.budget,
    mustFireIds: payloadCheck.value.mustFireIds,
  };
  return composeVersionedPayload(input);
}

/** Narrow a JSON value to its type name for error reporting. Re-exported for tests. */
export { jsonTypeName };

export type { ContentTier };

/** Local inline links, images and reference-style definitions in starter Markdown. */
function markdownLinks(body: string): string[] {
  const prose = stripFencedCode(body).replace(/`[^`]*`/g, '');
  const links = [
    ...[...prose.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^\s)]+)(?:\s+[^)]*)?\)/g)].map(m => m[1]!),
    ...[...prose.matchAll(/^\s*\[[^\]]+\]:\s*(<[^>]+>|\S+)/gm)].map(m => m[1]!),
  ];
  return links.map(link => link.replace(/^<|>$/g, '')).filter(link => !/^[a-z][a-z0-9+.-]*:/i.test(link));
}

/** Fenced code is not prose: headings and links inside a fence do not count. Pure. */
function stripFencedCode(body: string): string {
  return body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '');
}

function resolveMarkdownLink(source: ContentDocument, link: string, documents: readonly ContentDocument[]): ContentDocument | undefined {
  let decoded: string;
  try { decoded = decodeURIComponent(link); } catch { return undefined; }
  const [path, fragment] = decoded.split('#');
  if (path?.startsWith('/') || path?.includes('\\') || path?.includes('?')) return undefined;
  const parts = source.sourcePath.split('/').slice(0, -1);
  if (path) for (const part of path.split('/')) {
    if (part === '..') { if (parts.length === 0) return undefined; parts.pop(); }
    else if (part !== '.' && part !== '') parts.push(part);
  }
  const targetPath = path ? parts.join('/') : source.sourcePath;
  const safe = normalizeRelativePath(targetPath);
  if (!safe.ok) return undefined;
  const target = documents.find(doc => doc.sourcePath === safe.path);
  if (!target || !fragment) return target;
  const headings = [...stripFencedCode(target.body).matchAll(/^#{1,6}\s+(.+)$/gm)].map(m => m[1]!.trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-'));
  return headings.includes(fragment) ? target : undefined;
}
