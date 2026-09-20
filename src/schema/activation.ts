/**
 * Activation — turning `(event, state, index)` into a structured, ordered set of
 * content ids. Pure, deterministic, no I/O.
 *
 * ## Matching rule
 *
 * A content document activates when ANY of its `activation_conditions` fires. A
 * condition fires when all three hold:
 *
 * 1. `harnesses` contains the query harness, or contains `'*'` (ANY_HARNESS).
 * 2. `event` equals the query event id.
 * 3. the condition has no `state`, OR `state` is present in the query state key set.
 *
 * A document whose `target_harnesses` does not include the query harness (and does
 * not contain `'*'`) is *targeted elsewhere*: it never activates, and it is reported
 * separately in `untargetedIds` so a harness with no content is visibly distinct from
 * a harness whose content merely failed to fire.
 *
 * ## Ordering
 *
 * `kernel` entries first, then `reference`, each ascending by content id. Order is a
 * pure function of the entry set — never of document input order — so two runs over
 * different orderings produce identical output.
 */
import { aosError, type AosError } from '../protocols/error';
import { outcome, type Outcome } from '../protocols/outcome';
import { digestOfString } from '../protocols/json';
import { z } from 'zod';
import { safeParse } from '../protocols/validation';
import { ANY_HARNESS, type ContentDocument, type ContentTier } from './content';
import {
  ActivationEventSchema,
  ActivationStateSchema,
  ContentDocumentRuntimeSchema,
} from './runtime';

/** A well-formed empty activation, used as the product when the query is malformed. */
function emptyActivation(): ActivationResult {
  return {
    event: { id: '', harness: '' },
    stateKeys: [],
    entries: [],
    ids: [],
    kernelIds: [],
    referenceIds: [],
    targetedIds: [],
    untargetedIds: [],
    empty: true,
    digest: digestOfString(''),
  };
}

/** A structured activation query. */
export interface ActivationEvent {
  /** Event type id, e.g. `session-start`. Generic — never a vendor event name. */
  id: string;
  /** Harness id. Generic opaque string; the core never interprets it. */
  harness: string;
}

export interface ActivationState {
  /** State keys currently active (e.g. `first-action`, `pivot`). Sorted internally. */
  keys?: readonly string[];
  /** Explicit reference prose requested by this query. */
  referenceIds?: readonly string[];
}

export interface ActivationEntry {
  id: string;
  tier: ContentTier;
  sourcePath: string;
  /** Indices of the document's `activation_conditions` that fired, ascending. */
  matchedConditions: readonly number[];
  /** Human-readable match rationale, deterministic. */
  reason: string;
}

export interface ActivationResult {
  event: ActivationEvent;
  /** Sorted, deduplicated state keys actually considered. */
  stateKeys: readonly string[];
  /** Activated entries in output order (kernel first, then reference; id ascending). */
  entries: readonly ActivationEntry[];
  ids: readonly string[];
  kernelIds: readonly string[];
  referenceIds: readonly string[];
  /** Ids of documents this harness targets, whether or not their conditions fired. */
  targetedIds: readonly string[];
  /** Ids of documents that do not target this harness at all. */
  untargetedIds: readonly string[];
  /** True when nothing activated. Explicit, never inferred from an empty list alone. */
  empty: boolean;
  /** `sha256:<hex>` over the ordered id list — the activation fingerprint. */
  digest: string;
}

/** Harness ids declared anywhere in the corpus, sorted. */
export function declaredHarnesses(documents: readonly ContentDocument[]): string[] {
  const set = new Set<string>();
  for (const document of documents) {
    for (const harness of document.targetHarnesses) set.add(harness);
    for (const condition of document.activationConditions) {
      for (const harness of condition.harnesses) set.add(harness);
    }
  }
  return [...set].sort();
}

function targets(document: ContentDocument, harness: string): boolean {
  return document.targetHarnesses.includes(ANY_HARNESS) || document.targetHarnesses.includes(harness);
}

function conditionFires(
  condition: { harnesses: readonly string[]; event: string; state?: string },
  event: ActivationEvent,
  stateKeys: readonly string[],
): boolean {
  const harnessMatches =
    condition.harnesses.includes(ANY_HARNESS) || condition.harnesses.includes(event.harness);
  if (!harnessMatches) return false;
  if (condition.event !== event.id) return false;
  if (condition.state !== undefined && !stateKeys.includes(condition.state)) return false;
  return true;
}

/**
 * Build the structured activation for one `(event, state, index)` query. Pure.
 *
 * Errors: unknown harness (no document targets it) and empty selection (nothing
 * activated) are reported explicitly — an empty result is never silently valid.
 */
export function buildActivation(
  event: unknown,
  state: unknown,
  documents: unknown,
): Outcome<ActivationResult> {
  const errors: AosError[] = [];

  // Runtime validation: a malformed query fails closed with a named error.
  const eventParse = safeParse(ActivationEventSchema, event);
  const stateParse = safeParse(ActivationStateSchema, state);
  const documentsParse = safeParse(z.array(ContentDocumentRuntimeSchema).refine(docs => new Set(docs.map(d => d.id)).size === docs.length && new Set(docs.map(d => d.sourcePath)).size === docs.length, 'duplicate content'), documents);
  if (!eventParse.success || !stateParse.success || !documentsParse.success) {
    for (const [label, result] of [
      ['activation event', eventParse],
      ['activation state', stateParse],
      ['activation documents', documentsParse],
    ] as const) {
      if (result.success) continue;
      errors.push(
        aosError('invalid-input-shape', `${label} failed runtime validation`, {
          details: {
            issues: result.error.issues.map((issue) => ({
              path: issue.path.map((part) => String(part)).join('.'),
              message: issue.message,
            })),
          },
        }),
      );
    }
    return outcome(emptyActivation(), errors, true);
  }

  const queryEvent: ActivationEvent = eventParse.data;
  const queryState: ActivationState = stateParse.data;
  const queryDocuments: readonly ContentDocument[] = documentsParse.data;
  const stateKeys = [...new Set(queryState.keys ?? [])].sort();
  const entries: ActivationEntry[] = [];
  const targetedIds: string[] = [];
  const untargetedIds: string[] = [];

  if (queryEvent.id.trim() === '' || queryEvent.harness.trim() === '') {
    errors.push(
      aosError('internal-invariant', 'activation event id and harness must be non-empty', {
        details: { event: queryEvent.id, harness: queryEvent.harness },
      }),
    );
  }

  const sorted = [...queryDocuments].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  for (const document of sorted) {
    if (!targets(document, queryEvent.harness)) {
      untargetedIds.push(document.id);
      continue;
    }
    targetedIds.push(document.id);
    const matchedConditions: number[] = [];
    document.activationConditions.forEach((condition, index) => {
      if (conditionFires(condition, queryEvent, stateKeys)) matchedConditions.push(index);
    });
    if (matchedConditions.length === 0) continue;
    entries.push({
      id: document.id,
      tier: document.tier,
      sourcePath: document.sourcePath,
      matchedConditions,
      reason: `harness=${queryEvent.harness} event=${queryEvent.id} state=[${stateKeys.join(',')}] conditions=${matchedConditions.join(',')}`,
    });
  }

  const tierRank = (tier: ContentTier): number => (tier === 'kernel' ? 0 : 1);
  const ordered = entries.sort(
    (a, b) =>
      tierRank(a.tier) - tierRank(b.tier) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
      (a.sourcePath < b.sourcePath ? -1 : 1),
  );

  if (queryDocuments.length === 0) {
    errors.push(
      aosError('empty-index', 'activation ran against an empty content index', {
        details: { harness: queryEvent.harness, event: queryEvent.id },
      }),
    );
  } else if (targetedIds.length === 0) {
    errors.push(
      aosError('unknown-harness', `no content targets harness \`${queryEvent.harness}\``, {
        details: { harness: queryEvent.harness, declared: declaredHarnesses(queryDocuments) },
      }),
    );
  } else if (ordered.length === 0) {
    errors.push(
      aosError('empty-selection', 'no content activated for this event and state', {
        details: { harness: queryEvent.harness, event: queryEvent.id, stateKeys, targeted: targetedIds },
      }),
    );
  }

  const ids = ordered.map((entry) => entry.id);
  const result: ActivationResult = {
    event: { id: queryEvent.id, harness: queryEvent.harness },
    stateKeys,
    entries: ordered,
    ids,
    kernelIds: ordered.filter((entry) => entry.tier === 'kernel').map((entry) => entry.id),
    referenceIds: ordered.filter((entry) => entry.tier === 'reference').map((entry) => entry.id),
    targetedIds,
    untargetedIds,
    empty: ordered.length === 0,
    digest: digestOfString(ids.join('\n')),
  };

  return outcome(result, errors, errors.length > 0);
}

/** Convenience: the activation id list only. */
export function activatedIds(result: ActivationResult): string[] {
  return [...result.ids];
}
