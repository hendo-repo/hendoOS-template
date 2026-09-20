/**
 * Core policy regression tests.
 *
 * These are written against the *contract* in `src/policy/index.ts`: no error may
 * coexist with `decision: 'allow'` / `safe: true`, and a rule that is out of scope
 * for the query event must not downgrade the verdict.
 */
import { describe, expect, test } from 'bun:test';
import {
  POLICY_CHECKER_REVISION,
  evaluatePolicy,
  observe,
  validatePolicyRules,
  type Observation,
  type PolicyEvent,
  type PolicyFacts,
  type PolicyRule,
} from '../src/policy/index';

const SUBJECT = `sha256:${'a'.repeat(64)}`;
const OTHER_SUBJECT = `sha256:${'b'.repeat(64)}`;
const CONTEXT = { configRevision: 'cfg-1', checkerRevision: POLICY_CHECKER_REVISION };

function facts(observations: readonly Observation[], extra: Partial<PolicyFacts> = {}): PolicyFacts {
  return { subjectDigest: SUBJECT, observations, ...extra };
}

const EVENT: PolicyEvent = { id: 'pre-edit', harness: 'default', intent: 'edit' };

const allowAll: PolicyRule = { id: 'allow-all', decision: 'allow' };

describe('policy: allow is withheld whenever anything is wrong', () => {
  test('a missing required observation on another rule withholds allow', () => {
    const rules: PolicyRule[] = [
      { id: 'a-needs-token', decision: 'allow', requires: ['publish-token'] },
      allowAll,
    ];
    const verdict = evaluatePolicy(EVENT, facts([]), rules, CONTEXT).value;

    expect(verdict.decision).not.toBe('allow');
    expect(verdict.safe).toBe(false);
    expect(verdict.evidence.indeterminateBy).toContain('a-needs-token');
  });

  test('a missing required observation withholds allow even when facts.observations is empty', () => {
    const rules: PolicyRule[] = [{ id: 'a-needs-token', decision: 'allow', requires: ['nope'] }];
    const result = evaluatePolicy(EVENT, facts([]), rules, CONTEXT);

    expect(result.ok).toBe(false);
    expect(result.value.decision).toBe('indeterminate');
    expect(result.value.safe).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test('a stale observation on another rule withholds allow', () => {
    const rules: PolicyRule[] = [
      allowAll,
      { id: 'b-needs-fresh', decision: 'allow', requires: ['scan'] },
    ];
    const verdict = evaluatePolicy(
      EVENT,
      facts([observe('scan', 'stale', { ran: true }, 'scan is 3 days old')]),
      rules,
      CONTEXT,
    ).value;

    expect(verdict.decision).toBe('indeterminate');
    expect(verdict.safe).toBe(false);
    expect(verdict.evidence.complete).toBe(false);
  });

  test('a malformed rule withholds allow from a valid one', () => {
    const rules = [
      allowAll,
      { id: 'broken', decision: 'sometimes' as PolicyRule['decision'] },
    ] as PolicyRule[];
    const result = evaluatePolicy(EVENT, facts([observe('x', 'fresh', true)]), rules, CONTEXT);

    expect(result.value.decision).not.toBe('allow');
    expect(result.value.safe).toBe(false);
    expect(result.ok).toBe(false);
    expect(result.value.ruleErrors.length).toBeGreaterThan(0);
  });

  test('a duplicate rule id withholds allow', () => {
    const rules: PolicyRule[] = [
      { id: 'dup', decision: 'allow' },
      { id: 'dup', decision: 'allow' },
    ];
    const result = evaluatePolicy(EVENT, facts([]), rules, CONTEXT);

    expect(result.value.decision).not.toBe('allow');
    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'policy-duplicate-rule-id')).toBe(true);
  });

  test('a malformed subject digest withholds allow', () => {
    const result = evaluatePolicy(
      EVENT,
      { subjectDigest: 'not-a-digest', observations: [observe('x', 'fresh', 1)] },
      [allowAll],
      CONTEXT,
    );

    expect(result.value.decision).not.toBe('allow');
    expect(result.value.safe).toBe(false);
    expect(result.ok).toBe(false);
  });

  test('a malformed rule set never becomes an implicit allow', () => {
    const rules = [{ id: '', decision: 'allow' } as PolicyRule];
    const result = evaluatePolicy(EVENT, facts([]), rules, CONTEXT);

    expect(result.value.decision).toBe('indeterminate');
    expect(result.value.safe).toBe(false);
  });
});

describe('policy: a clean allow is still reachable', () => {
  test('fresh observations plus a matching rule allow', () => {
    const rules: PolicyRule[] = [
      { id: 'allow-edits', decision: 'allow', when: { event: 'pre-edit' }, requires: ['scan'] },
    ];
    const result = evaluatePolicy(
      EVENT,
      facts([observe('scan', 'fresh', { clean: true })]),
      rules,
      CONTEXT,
    );

    expect(result.ok).toBe(true);
    expect(result.value.decision).toBe('allow');
    expect(result.value.safe).toBe(true);
    expect(result.value.evidence.complete).toBe(true);
    expect(result.value.evidence.basedOnFreshObservations).toBe(true);
    expect(/^sha256:[a-f0-9]{64}$/.test(result.value.evidence.digest)).toBe(true);
  });

  test('deny always wins over allow', () => {
    const rules: PolicyRule[] = [
      { id: 'a-allow', decision: 'allow' },
      { id: 'b-deny', decision: 'deny', when: { intent: 'edit' } },
    ];
    const result = evaluatePolicy(EVENT, facts([observe('k', 'fresh', 1)]), rules, CONTEXT);

    expect(result.value.decision).toBe('deny');
    expect(result.value.safe).toBe(false);
    expect(result.value.evidence.deniedBy).toEqual(['b-deny']);
  });
});

describe('policy: scope is evaluated before required observations', () => {
  test('required observations of an out-of-scope event do not downgrade allow', () => {
    const rules: PolicyRule[] = [
      {
        id: 'publish-needs-token',
        decision: 'allow',
        when: { event: 'pre-publish' },
        requires: ['publish-token'],
      },
      { id: 'edit-allow', decision: 'allow', when: { event: 'pre-edit' }, requires: ['scan'] },
    ];
    const result = evaluatePolicy(EVENT, facts([observe('scan', 'fresh', { clean: true })]), rules, CONTEXT);

    expect(result.value.decision).toBe('allow');
    expect(result.ok).toBe(true);
    expect(result.value.evidence.indeterminateBy).toEqual([]);
    const outOfScope = result.value.contributions.find((c) => c.ruleId === 'publish-needs-token');
    expect(outOfScope?.matched).toBe(false);
    expect(outOfScope?.decision).not.toBe('indeterminate');
  });

  test('required observations of a rule scoped to other content do not downgrade allow', () => {
    const rules: PolicyRule[] = [
      { id: 'other-content', decision: 'allow', contentIds: ['other'], requires: ['other-scan'] },
      { id: 'mine', decision: 'allow', requires: ['scan'] },
    ];
    const result = evaluatePolicy(
      EVENT,
      facts([observe('scan', 'fresh', true)], { context: { contentId: 'mine' } }),
      rules,
      CONTEXT,
    );

    expect(result.value.decision).toBe('allow');
    expect(result.ok).toBe(true);
  });

  test('an out-of-scope deny rule does not deny', () => {
    const rules: PolicyRule[] = [
      { id: 'publish-deny', decision: 'deny', when: { event: 'pre-publish' } },
      { id: 'edit-allow', decision: 'allow', when: { event: 'pre-edit' }, requires: ['scan'] },
    ];
    const result = evaluatePolicy(EVENT, facts([observe('scan', 'fresh', { clean: true })]), rules, CONTEXT);

    expect(result.value.decision).toBe('allow');
    expect(result.value.evidence.deniedBy).toEqual([]);
  });
});

describe('policy: malformed input fails closed without throwing', () => {
  test('non-object facts, rules and event are rejected, not crashed', () => {
    const cases: readonly [unknown, unknown, unknown][] = [
      [EVENT, null, [allowAll]],
      [EVENT, undefined, [allowAll]],
      [EVENT, { subjectDigest: SUBJECT, observations: 'nope' }, [allowAll]],
      [null, facts([]), [allowAll]],
      [{ id: 42, harness: {} }, facts([]), [allowAll]],
      [EVENT, facts([]), null],
      [EVENT, facts([]), [{ decision: 'allow' }, 7, 'x']],
    ];

    for (const [event, factInput, ruleInput] of cases) {
      let thrown: unknown = null;
      let result: ReturnType<typeof evaluatePolicy> | null = null;
      try {
        result = evaluatePolicy(
          event as PolicyEvent,
          factInput as PolicyFacts,
          ruleInput as PolicyRule[],
          CONTEXT,
        );
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeNull();
      expect(result?.ok).toBe(false);
      expect(result?.value.decision).not.toBe('allow');
      expect(result?.value.safe).toBe(false);
      expect((result?.errors.length ?? 0) > 0).toBe(true);
    }
  });

  test('a rule list of the wrong element type is reported, not thrown', () => {
    const result = evaluatePolicy(EVENT, facts([]), [null as unknown as PolicyRule], CONTEXT);
    expect(result.ok).toBe(false);
    expect(result.value.decision).not.toBe('allow');
  });
});

describe('policy: determinism and evidence', () => {
  test('two runs over equal inputs are deep-equal', () => {
    const rules: PolicyRule[] = [
      { id: 'b', decision: 'allow', when: { event: 'pre-edit' } },
      { id: 'a', decision: 'allow', when: { event: 'pre-edit' } },
    ];
    const input = facts([observe('zz', 'fresh', 2), observe('aa', 'fresh', 1)]);
    const first = evaluatePolicy(EVENT, input, rules, CONTEXT).value;
    const second = evaluatePolicy(EVENT, input, rules, CONTEXT).value;

    expect(first).toEqual(second);
    expect(first.evidence.ruleIds).toEqual(['a', 'b']);
    expect(first.evidence.observations.map((o) => o.key)).toEqual(['aa', 'zz']);
  });

  test('empty rule set is explicitly indeterminate', () => {
    const result = evaluatePolicy(EVENT, facts([observe('k', 'fresh', 1)]), [], CONTEXT);
    expect(result.value.decision).toBe('indeterminate');
    expect(result.value.safe).toBe(false);
    expect(result.ok).toBe(false);
  });

  test('validatePolicyRules reports shape errors and sorts them', () => {
    const errors = validatePolicyRules([
      { id: 'ok-rule', decision: 'allow' },
      { id: 'ok-rule', decision: 'allow' },
      { id: 'bad-path', decision: 'allow', when: { pathPrefix: '/abs' } },
    ]);
    expect(errors.map((e) => e.code)).toContain('policy-duplicate-rule-id');
    expect(errors.map((e) => e.code)).toContain('policy-rule-shape-invalid');
    const sorted = [...errors].map((e) => `${e.code}|${e.id ?? ''}`);
    expect(sorted).toEqual([...sorted].sort());
  });

  test('a truthy observation gates an allow', () => {
    const rules: PolicyRule[] = [{ id: 'needs-flag', decision: 'allow', when: { truthy: 'flag' } }];
    expect(evaluatePolicy(EVENT, facts([observe('flag', 'fresh', false)]), rules, CONTEXT).value.decision).toBe(
      'indeterminate',
    );
    expect(evaluatePolicy(EVENT, facts([observe('flag', 'fresh', true)]), rules, CONTEXT).value.decision).toBe(
      'allow',
    );
  });

  test('a path-prefix rule scopes by fact path', () => {
    const rules: PolicyRule[] = [
      { id: 'src-only', decision: 'allow', when: { pathPrefix: 'src' }, requires: [] },
    ];
    const live = observe('scan', 'fresh', { clean: true });
    const touching = evaluatePolicy(EVENT, facts([live], { paths: ['src/policy/index.ts'] }), rules, CONTEXT);
    const elsewhere = evaluatePolicy(EVENT, facts([live], { paths: ['docs/x.md'] }), rules, CONTEXT);

    expect(touching.value.decision).toBe('allow');
    expect(elsewhere.value.decision).toBe('indeterminate');
  });

  test('a rule set with no observations at all can never allow', () => {
    const rules: PolicyRule[] = [{ id: 'allow-all', decision: 'allow', requires: [] }];
    const result = evaluatePolicy(EVENT, facts([]), rules, CONTEXT);

    expect(result.value.decision).toBe('indeterminate');
    expect(result.value.safe).toBe(false);
    expect(result.value.evidence.complete).toBe(false);
  });

  test('verdicts do not carry the raw fact subject as a path', () => {
    const result = evaluatePolicy(
      EVENT,
      { subjectDigest: OTHER_SUBJECT, observations: [observe('scan', 'fresh', null)] },
      [allowAll],
      CONTEXT,
    );
    expect(result.value.evidence.subjectDigest).toBe(OTHER_SUBJECT);
    expect(result.errors.every((e) => e.path === null || !e.path.includes('/'))).toBe(true);
  });
});
