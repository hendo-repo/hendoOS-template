/**
 * Seeded-defect gate test — the shipped corpus and its membership manifest.
 *
 * Proves four defect classes actually fail the gate (structural, reference,
 * budget, membership), each against a passing control, plus the shipped
 * `content/` corpus and `membership.manifest.json` evaluating exactly.
 */
import { describe, expect, test } from 'bun:test';
import { compose } from '../src/compose/index';
import { buildContentCorpus, evaluateMembership } from '../src/schema/index';
import {
  BUDGET_DEFECT,
  HEALTHY_EVENT,
  HEALTHY_MUST_FIRE,
  HEALTHY_SOURCES,
  MEMBERSHIP_DEMOTED,
  MEMBERSHIP_EXTRA,
  REFERENCE_MISSING,
  REFERENCE_ORPHAN,
  STRUCTURAL_DEFECT,
  STRUCTURAL_UNKNOWN_KEY,
  corpusIndex as baseCorpusIndex,
} from './fixtures/seeded-defects';
import type { ContentSourceFile } from '../src/schema/index';

function documentsOf(sources: readonly ContentSourceFile[]) {
  const compiled = buildContentCorpus(sources);
  return { compiled, documents: [...compiled.value.documents] };
}

// Expectations are fixture-authored and remain fixed when the corpus mutates.
const corpusIndex = (...args: Parameters<typeof baseCorpusIndex>) => ({
  ...baseCorpusIndex(...args), mustFireKernelIds: ['seeded-kernel'], mustFireStaticIds: ['seeded-kernel'],
});

describe('seeded defects: control passes', () => {
  test('the unseeded control composes clean', () => {
    const { documents } = documentsOf(HEALTHY_SOURCES);
    const result = compose(HEALTHY_EVENT, { keys: [] }, corpusIndex(documents, HEALTHY_MUST_FIRE));

    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.value.payload.staticPrefix).toContain('seeded-kernel');
    expect(result.value.payload.text).not.toContain('Nobody declared me');
  });
});

describe('seeded defects: structural', () => {
  test('a schema-violating source fails the corpus build', () => {
    const { compiled } = documentsOf([...HEALTHY_SOURCES, STRUCTURAL_DEFECT]);
    expect(compiled.ok).toBe(false);
    expect(compiled.errors.some((e) => e.code === 'frontmatter-schema-invalid')).toBe(true);
    expect(compiled.value.rejectedPaths).toContain('content/kernel/broken-shape.md');
  });

  test('an unknown frontmatter key fails closed rather than being ignored', () => {
    const { compiled } = documentsOf([...HEALTHY_SOURCES, STRUCTURAL_UNKNOWN_KEY]);
    expect(compiled.ok).toBe(false);
    expect(compiled.errors.some((e) => e.code === 'frontmatter-schema-invalid')).toBe(true);
  });

  test('a structural defect cannot be composed into a valid payload', () => {
    const { compiled, documents } = documentsOf([...HEALTHY_SOURCES, STRUCTURAL_DEFECT]);
    // The corpus build rejects it, so it never reaches composition...
    expect(compiled.ok).toBe(false);
    expect(documents.some((doc) => doc.id === 'broken-shape')).toBe(false);
    // ...and a compose over what did compile cannot contain it.
    const result = compose(HEALTHY_EVENT, { keys: [] }, corpusIndex(documents, HEALTHY_MUST_FIRE));
    expect(result.value.payload.staticPrefix).not.toContain('broken-shape');
    expect(result.ok).toBe(true);
  });
});

describe('seeded defects: reference', () => {
  test('an activated reference no kernel declares is dropped and reported', () => {
    const { documents } = documentsOf([...HEALTHY_SOURCES, REFERENCE_ORPHAN]);
    const result = compose(
      HEALTHY_EVENT,
      { keys: [] },
      corpusIndex(documents, [...HEALTHY_MUST_FIRE, 'orphan-recipes']),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'reference-unresolved')).toBe(true);
    expect(result.value.payload.text).not.toContain('Nobody declared me');
  });

  test('a declared reference with no document in the index is reported', () => {
    const { documents } = documentsOf([...HEALTHY_SOURCES, REFERENCE_MISSING]);
    const result = compose(
      HEALTHY_EVENT,
      { keys: [] },
      corpusIndex(documents, [...HEALTHY_MUST_FIRE, 'declares-ghost']),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'reference-declared-missing')).toBe(true);
    expect(result.value.diagnostics.missingDeclaredReferenceIds).toContain('ghost-recipes');
  });
});

describe('seeded defects: budget', () => {
  test('a body over its declared byte budget is reported, never silently truncated', () => {
    const { documents } = documentsOf([...HEALTHY_SOURCES, BUDGET_DEFECT]);
    const result = compose(
      HEALTHY_EVENT,
      { keys: [] },
      corpusIndex(documents, [...HEALTHY_MUST_FIRE, 'over-budget']),
    );

    expect(result.ok).toBe(false);
    expect(result.errors.some((e) => e.code === 'byte-budget-exceeded')).toBe(true);
    // The body is still rendered so the failure is inspectable.
    expect(result.value.payload.text).toContain('xxxx');
  });
});

describe('seeded defects: membership', () => {
  test('a demoted must-fire kernel id fails the gate', () => {
    const { documents } = documentsOf(HEALTHY_SOURCES);
    const result = compose(HEALTHY_EVENT, { keys: [] }, corpusIndex(documents, MEMBERSHIP_DEMOTED));

    expect(result.ok).toBe(false);
    expect(result.value.diagnostics.mustFireMissingIds).toContain('ghost-kernel');
    expect(result.errors.some((e) => e.code === 'membership-mismatch')).toBe(true);
  });

  test('an unexpected activation fails the gate', () => {
    const { documents } = documentsOf(HEALTHY_SOURCES);
    const result = compose(HEALTHY_EVENT, { keys: [] }, corpusIndex(documents, MEMBERSHIP_EXTRA));

    expect(result.ok).toBe(false);
    expect(result.value.diagnostics.mustFireExtraIds).toEqual(['seeded-recipes']);
  });

  test('omitting mustFireIds fails the gate instead of passing silently', () => {
    const { documents } = documentsOf(HEALTHY_SOURCES);
    const result = compose(HEALTHY_EVENT, { keys: [] }, corpusIndex(documents));

    expect(result.ok).toBe(false);
    expect(result.value.diagnostics.mustFireDeclared).toBe(false);
    expect(result.errors.some((e) => e.code === 'membership-mismatch')).toBe(true);
  });
});

describe('shipped corpus: content/ and membership.manifest.json', () => {
  test('the shipped manifest passes active scenarios and degrades three negative scenarios', async () => {
    const { loadContentFiles, loadMembershipManifest } = await import('./fixtures/load-corpus');
    const files = await loadContentFiles();
    expect(files.length).toBeGreaterThan(0);

    const compiled = buildContentCorpus(files);
    expect(compiled.ok).toBe(true);

    const manifest = await loadMembershipManifest();
    const evaluation = evaluateMembership(manifest, compiled.value.documents);

    expect(manifest.scenarios.length).toBeGreaterThan(0);
    expect(evaluation.value.mismatchCount).toBe(3);
    expect(evaluation.value.exact).toBe(false);
    expect(evaluation.ok).toBe(false);
    expect(evaluation.value.results.filter(result => !result.exact).map(result => result.scenarioId).sort()).toEqual([
      'task-pivot-without-state-activates-nothing', 'unknown-event-activates-nothing', 'unknown-harness-activates-nothing',
    ]);
  });

  test('shipped scenarios enforce compose membership and expose empty scenarios', async () => {
    const { loadContentFiles, loadMembershipManifest } = await import('./fixtures/load-corpus');
    const files = await loadContentFiles();
    const compiled = buildContentCorpus(files);
    const manifest = await loadMembershipManifest();

    for (const scenario of manifest.scenarios) {
      const result = compose(
        { id: scenario.event, harness: scenario.harness },
        { keys: [...(scenario.stateKeys ?? [])] },
        { documents: compiled.value.documents, mustFireIds: scenario.expectedIds, mustFireKernelIds: scenario.expectedKernelIds, mustFireStaticIds: scenario.expectedStaticIds },
      );
      // The only tolerated degradation is "nothing activated" being reported as
      // empty-selection; a membership mismatch is never tolerated.
      const membershipErrors = result.errors.filter((e) => e.code === 'membership-mismatch');
      expect({ scenario: scenario.id, membershipErrors }).toEqual({ scenario: scenario.id, membershipErrors: [] });
      expect(result.value.diagnostics.mustFireMissingIds).toEqual([]);
      expect(result.value.diagnostics.mustFireExtraIds).toEqual([]);
      expect(result.ok).toBe(scenario.expectedIds.length > 0);
      expect(result.degraded).toBe(scenario.expectedIds.length === 0);
    }
  });
});
