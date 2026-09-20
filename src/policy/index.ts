/**
 * `policy` — deny / allow / indeterminate over observed facts.
 *
 * ```ts
 * const verdict = evaluatePolicy(event, facts, rules);
 * ```
 *
 * ## Decisions
 *
 * - `deny` — at least one rule matched and denied. Always wins.
 * - `allow` — no rule denied, and at least one rule matched and allowed.
 * - `indeterminate` — nothing matched, or a required observation is missing/stale.
 *   **Indeterminate is not safe.** Callers must treat it as a stop, never as a pass.
 *
 * ## Fail-closed evaluation order
 *
 * 1. A rule whose `when` cannot be evaluated (missing or stale observation) yields an
 *    `indeterminate` contribution and is removed from the running set.
 * 2. If any contributing rule denied → `deny`.
 * 3. Else if at least one contributing rule allowed AND every rule's observations were
 *    fresh → `allow`. A single stale/missing observation anywhere downgrades an
 *    otherwise-allowing result to `indeterminate`, because an allow granted on an
 *    incomplete view is exactly the failure mode this module exists to prevent.
 * 4. Else `indeterminate`.
 *
 * ## Evidence binding
 *
 * Every verdict carries evidence: the `subjectDigest` the decision was made about,
 * the `configRevision`, the `checkerRevision`, the ordered rule ids that contributed,
 * and the exact observations consulted. A verdict without evidence is not a verdict —
 * `evidence.complete` says whether every observation was fresh, and the caller can
 * always re-derive the decision from the evidence alone.
 *
 * ## Purity
 *
 * No I/O, no clock, no randomness, no import-time work. `evaluatePolicy` never reads
 * an environment variable, a network, or a filesystem — facts are supplied by the
 * caller, which is what makes a verdict reproducible and auditable.
 */
import { aosError, sortErrors, type AosError } from '../protocols/error';
import { digestOfJson, isDigest, type Json } from '../protocols/json';
import { outcome, type Outcome } from '../protocols/outcome';
import { isPathUnder } from '../protocols/paths';
import { PolicyEventRuntimeSchema, PolicyFactsRuntimeSchema, PolicyContextRuntimeSchema, PolicyRulesRuntimeSchema, PolicyRuleRuntimeSchema, parseOrErrors } from '../schema/runtime';
import { safeParse } from '../protocols/validation';
import { ANY_HARNESS, type ContentDocument } from '../schema/content';

export type PolicyDecision = 'deny' | 'allow' | 'indeterminate';

/** Freshness of a single observed fact. Only `fresh` is usable as evidence. */
export type ObservationStatus = 'fresh' | 'missing' | 'stale' | 'unavailable';

export interface PolicyEvent {
  /** Event id, e.g. `pre-edit`. Generic — never a vendor event name. */
  id: string;
  /** Harness id. Generic opaque string. */
  harness: string;
  /** Optional intent, e.g. `edit`, `delete`, `publish`. */
  intent?: string;
}

/** One observed fact. `value` is only meaningful when `status === 'fresh'`. */
export interface Observation {
  key: string;
  status: ObservationStatus;
  value?: Json;
  /** Optional note explaining a non-fresh status. Never trust-bearing. */
  detail?: string;
}

export interface PolicyFacts {
  /** Digest of the subject the decision is about (e.g. the content digest). Required. */
  subjectDigest: string;
  /** Observed facts. Duplicate keys are rejected. */
  observations: readonly Observation[];
  /** Paths the action would touch, normalized relative. */
  paths?: readonly string[];
  /** Caller-supplied JSON data used for content scope; it grants no authority. */
  context?: { [key: string]: Json };
}

/** A single match condition. All present fields must hold (AND). */
export interface PolicyCondition {
  event?: string;
  harness?: string;
  intent?: string;
  /** Observation key that must be present and equal to `equals`. */
  observation?: string;
  equals?: Json;
  /** Observation key that must be present and truthy. */
  truthy?: string;
  /** Fact path that must sit at or under this normalized relative prefix. */
  pathPrefix?: string;
}

/** A rule. Rules are pure data — no callbacks, so a rule set is serializable. */
export interface PolicyRule {
  id: string;
  decision: Exclude<PolicyDecision, 'indeterminate'>;
  /** All present fields must hold; absent `when` is unconditional, empty is invalid. */
  when?: PolicyCondition;
  /** Observation keys this rule requires. Missing/stale → indeterminate contribution. */
  requires?: readonly string[];
  /** Content ids this rule is scoped to; empty/absent means all content. */
  contentIds?: readonly string[];
  reason?: string;
}

/** One rule's contribution to the verdict. */
export interface RuleContribution {
  ruleId: string;
  /** `indeterminate` when a required observation was missing/stale. */
  decision: PolicyDecision;
  matched: boolean;
  reason: string;
  /** Observation keys consulted, with their status. */
  observations: readonly { key: string; status: ObservationStatus; used: boolean }[];
}

export interface PolicyEvidence {
  subjectDigest: string;
  configRevision: string;
  checkerRevision: string;
  event: string;
  harness: string;
  intent: string | null;
  /** Ordered rule ids that contributed (matched or blocked). */
  ruleIds: readonly string[];
  /** Every observation consulted, sorted by key. */
  observations: readonly { key: string; status: ObservationStatus; value: Json }[];
  /** Rule ids that matched and denied. */
  deniedBy: readonly string[];
  /** Rule ids that matched and allowed. */
  allowedBy: readonly string[];
  /** Rule ids that could not be evaluated (missing/stale observation). */
  indeterminateBy: readonly string[];
  /** True when every rule's required observations were fresh. */
  complete: boolean;
  /** True when the verdict came from a fully fresh observation set. */
  basedOnFreshObservations: boolean;
  /** `sha256:<hex>` over the canonical evidence payload — the audit handle. */
  digest: string;
}

export interface PolicyVerdict {
  decision: PolicyDecision;
  /** True only for `allow`. Never infer safety from an `ok` outcome flag alone. */
  safe: boolean;
  reasons: readonly string[];
  evidence: PolicyEvidence;
  contributions: readonly RuleContribution[];
  /** Non-empty when the rule set itself is malformed. */
  ruleErrors: readonly AosError[];
}

/** Configuration for the checker revision + config revision stamped into evidence. */
export interface PolicyContext {
  configRevision: string;
  checkerRevision: string;
}

export const POLICY_CHECKER_REVISION = 'aos-policy/1';

function factValue(facts: PolicyFacts, key: string): Observation | undefined {
  let found: Observation | undefined;
  for (const observation of facts.observations) {
    if (observation.key === key) found = observation;
  }
  return found;
}

/**
 * Scope-only evaluation: the condition fields that can rule a rule out *before*
 * any observation is consulted (`event`, `harness`, `intent`, `contentIds`,
 * `pathPrefix`). A rule that fails scope contributes `matched: false` and is
 * never downgraded to indeterminate, because its required observations were
 * never in question.
 */
function scopeMatches(
  condition: PolicyCondition,
  rule: PolicyRule,
  event: PolicyEvent,
  facts: PolicyFacts,
): boolean {
  if (condition.event !== undefined && condition.event !== event.id) return false;
  if (condition.harness !== undefined && condition.harness !== event.harness) return false;
  if (condition.intent !== undefined && condition.intent !== (event.intent ?? '')) return false;

  const scopeIds = rule.contentIds ?? [];
  if (scopeIds.length > 0) {
    const subjectIsContent = facts.context?.contentId;
    if (!(typeof subjectIsContent === 'string' && scopeIds.includes(subjectIsContent))) return false;
  }

  if (condition.pathPrefix !== undefined) {
    const prefix = condition.pathPrefix;
    const paths = facts.paths ?? [];
    if (paths.length === 0 || !paths.some((path) => isPathUnder(path, prefix))) return false;
  }
  return true;
}

function conditionMatches(
  condition: PolicyCondition,
  event: PolicyEvent,
  facts: PolicyFacts,
): { matched: boolean; consulted: string[] } {
  const consulted: string[] = [];
  if (condition.observation !== undefined) {
    consulted.push(condition.observation);
    const observation = factValue(facts, condition.observation);
    if (!observation || observation.status !== 'fresh') return { matched: false, consulted };
    if (!jsonEqual(observation.value ?? null, condition.equals ?? null)) {
      return { matched: false, consulted };
    }
  }
  if (condition.truthy !== undefined) {
    consulted.push(condition.truthy);
    const observation = factValue(facts, condition.truthy);
    if (!observation || observation.status !== 'fresh') return { matched: false, consulted };
    const value = observation.value;
    const truthy = value === true || (typeof value === 'string' && value !== '') ||
      (typeof value === 'number' && value !== 0) || (Array.isArray(value) && value.length > 0);
    if (!truthy) return { matched: false, consulted };
  }
  return { matched: true, consulted };
}

function jsonEqual(a: Json, b: Json): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((entry, index) => jsonEqual(entry, b[index] as Json));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a) && !Array.isArray(b)) {
    const ak = Object.keys(a).sort();
    const bk = Object.keys(b).sort();
    if (ak.length !== bk.length || ak.join(',') !== bk.join(',')) return false;
    return ak.every((key) =>
      jsonEqual((a as { [k: string]: Json })[key] as Json, (b as { [k: string]: Json })[key] as Json),
    );
  }
  return false;
}

/** Validate every nested rule before any evaluation. */
export function validatePolicyRules(rules: unknown): AosError[] {
  if (!Array.isArray(rules)) return [aosError('policy-malformed-rule', 'policy rules must be an array')];
  const errors: AosError[] = [];
  const seen = new Set<string>();
  for (const raw of rules) {
    const parsed = parseOrErrors(PolicyRuleRuntimeSchema, raw, { label: 'policy rule', code: 'policy-rule-shape-invalid' });
    if (!parsed.ok) { errors.push(...parsed.errors); continue; }
    if (seen.has(parsed.value.id)) errors.push(aosError('policy-duplicate-rule-id', 'duplicate rule id', { id: parsed.value.id }));
    seen.add(parsed.value.id);
  }
  return sortErrors(errors);
}

/**
 * Evaluate a policy rule set against observed facts. Pure, deterministic, no I/O.
 *
 * See the module header for the evaluation order and fail-closed semantics.
 */
export function evaluatePolicy(
  event: unknown,
  facts: unknown,
  rules: unknown,
  context: unknown = { configRevision: 'unversioned', checkerRevision: POLICY_CHECKER_REVISION },
): Outcome<PolicyVerdict> {
  const inputErrors: AosError[] = [];
  const eventResult = parseOrErrors(PolicyEventRuntimeSchema, event, { label: 'policy event' });
  const factsResult = parseOrErrors(PolicyFactsRuntimeSchema, facts, { label: 'policy facts' });
  const contextResult = parseOrErrors(PolicyContextRuntimeSchema, context, { label: 'policy context' });
  for (const result of [eventResult, factsResult, contextResult]) if (!result.ok) inputErrors.push(...result.errors);
  const parsedEvent: PolicyEvent = eventResult.ok ? eventResult.value : { id: '', harness: '' };
  const parsedFacts: PolicyFacts = factsResult.ok ? factsResult.value : { subjectDigest: '', observations: [] };
  const parsedContext: PolicyContext = contextResult.ok ? contextResult.value : { configRevision: 'invalid', checkerRevision: POLICY_CHECKER_REVISION };
  const rulesResult = safeParse(PolicyRulesRuntimeSchema, rules);
  const ruleErrors = validatePolicyRules(rules);
  // Invalid inputs never reach condition evaluation or evidence serialization.
  const ruleList: PolicyRule[] = rulesResult.success && ruleErrors.length === 0 && inputErrors.length === 0 ? rulesResult.data : [];
  const contributions: RuleContribution[] = [];

  for (const rule of ruleList) {
    const consultedKeys = new Set<string>(rule.requires ?? []);
    const condition = rule.when;
    if (condition?.observation !== undefined) consultedKeys.add(condition.observation);
    if (condition?.truthy !== undefined) consultedKeys.add(condition.truthy);

    const consulted = [...consultedKeys].sort().map((key) => {
      const observation = factValue(parsedFacts, key);
      return { key, status: (observation?.status ?? 'missing') as ObservationStatus, used: false };
    });

    // 1. Scope first: a rule that cannot apply to this query is not "unevaluable".
    //    Its required observations were never in question, so it must not downgrade
    //    another rule's allow to indeterminate. `contentIds` is scope on its own,
    //    with or without a `when` clause.
    const inScope = scopeMatches(condition ?? {}, rule, parsedEvent, parsedFacts);
    if (!inScope) {
      contributions.push({
        ruleId: rule.id,
        decision: rule.decision,
        matched: false,
        reason: `out of scope (${describeCondition(condition)})`,
        observations: consulted,
      });
      continue;
    }

    // 2. Required observations must all be fresh, else this rule cannot be evaluated.
    const missingKeys = [...consultedKeys].sort().filter((key) => {
      const observation = factValue(parsedFacts, key);
      return !observation || observation.status !== 'fresh';
    });
    if (missingKeys.length > 0) {
      contributions.push({
        ruleId: rule.id,
        decision: 'indeterminate',
        matched: false,
        reason: `required observations not fresh: ${missingKeys.join(', ')}`,
        observations: consulted.map((entry) =>
          missingKeys.includes(entry.key) ? { ...entry, used: true } : entry,
        ),
      });
      continue;
    }

    const match = condition
      ? conditionMatches(condition, parsedEvent, parsedFacts)
      : { matched: true, consulted: [] };
    const matchedKeys = new Set(match.consulted);
    contributions.push({
      ruleId: rule.id,
      decision: rule.decision,
      matched: match.matched,
      reason: match.matched
        ? rule.reason ?? `matched (${describeCondition(condition)})`
        : `did not match (${describeCondition(condition)})`,
      observations: consulted.map((entry) =>
        matchedKeys.has(entry.key) ? { ...entry, used: true } : entry,
      ),
    });
  }

  const sortedContributions = [...contributions].sort((a, b) =>
    a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0,
  );

  const deniedBy = sortedContributions.filter((c) => c.matched && c.decision === 'deny').map((c) => c.ruleId);
  const allowedBy = sortedContributions.filter((c) => c.matched && c.decision === 'allow').map((c) => c.ruleId);
  const indeterminateBy = sortedContributions
    .filter((c) => c.decision === 'indeterminate')
    .map((c) => c.ruleId);

  const observations = [...parsedFacts.observations]
    .map((observation) => ({
      key: observation.key,
      status: observation.status,
      value: observation.value ?? null,
    }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const observationsComplete =
    inputErrors.length === 0 && ruleErrors.length === 0 && observations.length > 0 && observations.every((observation) => observation.status === 'fresh');

  let decision: PolicyDecision;
  const reasons: string[] = [];
  // A malformed rule set or malformed input can never produce an allow: fail closed.
  const subjectDigestValid = isDigest(parsedFacts.subjectDigest);
  const allowBlocked =
    inputErrors.length > 0 ||
    ruleErrors.length > 0 ||
    indeterminateBy.length > 0 ||
    !subjectDigestValid;
  if (deniedBy.length > 0) {
    decision = 'deny';
    reasons.push(`denied by rule(s): ${deniedBy.join(', ')}`);
  } else if (allowedBy.length > 0 && allowBlocked) {
    decision = 'indeterminate';
    reasons.push(
      `allow withheld: rule(s) ${allowedBy.join(', ')} matched but the evaluation was incomplete`,
    );
  } else if (allowedBy.length > 0 && observationsComplete) {
    decision = 'allow';
    reasons.push(`allowed by rule(s): ${allowedBy.join(', ')}`);
  } else if (allowedBy.length > 0) {
    decision = 'indeterminate';
    reasons.push(
      `allow withheld: rule(s) ${allowedBy.join(', ')} matched but the observation set is not fully fresh`,
    );
  } else {
    decision = 'indeterminate';
    reasons.push(
      ruleList.length === 0 ? 'no policy rules were supplied' : 'no policy rule matched the observed event',
    );
  }
  if (indeterminateBy.length > 0) {
    reasons.push(`rule(s) not evaluable: ${indeterminateBy.join(', ')}`);
  }
  if (ruleList.length === 0) {
    // An empty rule set is explicitly indeterminate, never an implicit allow.
    reasons.push('empty rule set is never an implicit allow');
  }

  const evidenceBase = {
    subjectDigest: parsedFacts.subjectDigest,
    configRevision: parsedContext.configRevision,
    checkerRevision: parsedContext.checkerRevision,
    event: parsedEvent.id,
    harness: parsedEvent.harness,
    intent: parsedEvent.intent ?? null,
    ruleIds: sortedContributions.map((c) => c.ruleId),
    observations,
    deniedBy,
    allowedBy,
    indeterminateBy,
    decision,
    observationsComplete,
    reason: reasons[0] ?? '',
  };

  const errors: AosError[] = [...inputErrors, ...ruleErrors];
  if (!subjectDigestValid) {
    errors.push(
      aosError('policy-indeterminate', 'subject digest must be `sha256:<64 hex>`', {
        details: { subjectDigest: parsedFacts.subjectDigest },
      }),
    );
  }
  if (indeterminateBy.length > 0 && decision !== 'deny') {
    errors.push(
      aosError('policy-indeterminate', 'policy could not be evaluated on fully fresh observations', {
        details: { indeterminateBy, decision },
      }),
    );
  }
  if (decision === 'indeterminate') {
    errors.push(
      aosError('policy-indeterminate', reasons[0] ?? 'policy result is indeterminate', {
        details: { allowedBy, deniedBy, indeterminateBy },
      }),
    );
  }

  const verdict: PolicyVerdict = {
    decision,
    safe: decision === 'allow',
    reasons,
    evidence: {
      ...evidenceBase,
      basedOnFreshObservations: observationsComplete,
      complete: observationsComplete && indeterminateBy.length === 0,
      digest: digestOfJson(evidenceBase),
    },
    contributions: sortedContributions,
    ruleErrors,
  };

  return outcome(verdict, errors, decision !== 'allow' || errors.length > 0);
}

function describeCondition(condition: PolicyCondition | undefined): string {
  if (!condition) return 'unconditional';
  const parts: string[] = [];
  if (condition.event !== undefined) parts.push(`event=${condition.event}`);
  if (condition.harness !== undefined) parts.push(`harness=${condition.harness}`);
  if (condition.intent !== undefined) parts.push(`intent=${condition.intent}`);
  if (condition.observation !== undefined) {
    parts.push(`observation.${condition.observation}==${JSON.stringify(condition.equals ?? null)}`);
  }
  if (condition.truthy !== undefined) parts.push(`observation.${condition.truthy} is truthy`);
  if (condition.pathPrefix !== undefined) parts.push(`pathPrefix=${condition.pathPrefix}`);
  return parts.length === 0 ? 'unconditional' : parts.join(' AND ');
}

/** Build an observation from a possibly-absent value. Convenience for callers. */
export function observe(key: string, status: ObservationStatus, value?: Json, detail?: string): Observation {
  return {
    key,
    status,
    ...(value === undefined ? {} : { value }),
    ...(detail === undefined ? {} : { detail }),
  };
}

export { ANY_HARNESS, type ContentDocument };
