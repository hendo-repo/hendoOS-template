/**
 * Scenario-scoped reference declarations + fenced-heading anchors.
 *
 * Contract under test: the set of reference ids a *requested* reference may
 * resolve against is declared by the kernels **activated for the selected
 * scenario** — a kernel that targets this harness but does not activate must not
 * authorize its declared references. The static prefix stays invariant: every
 * kernel that targets the harness is still shipped, activated or not.
 *
 * Second contract: heading anchors in local Markdown links are computed from
 * prose only, so a `# heading` line inside a fenced code block is not an anchor.
 *
 * Every positive assertion has a failing control and vice versa: the same corpus
 * that refuses the request while the declaring kernel is dormant accepts it once
 * that kernel activates, and the false anchor is paired with a real one.
 */
import { describe, expect, test } from 'bun:test';
import { compose, type ComposeIndex } from '../src/compose/index';
import {
  buildContentCorpus,
  type ContentDocument,
  type ContentSourceFile,
} from '../src/schema/index';

const FENCE = '```';

function front(id: string, tier: string, event: string, body: string): string {
  return [
    '---',
    `id: ${id}`,
    'version: 1',
    `tier: ${tier}`,
    'target_harnesses: [default]',
    'byte_budget: 4096',
    'activation_conditions:',
    '  - harnesses: [default]',
    `    event: ${event}`,
    '---',
    '',
    body,
  ].join('\n') + '\n';
}

/**
 * Two kernels targeting one harness: `kernel-live` activates on `task-start`,
 * `kernel-dormant` only on `session-end`. `depth` is a reference that only ever
 * enters a payload when explicitly requested. `declarer` picks which kernel
 * carries the declaration, so the dormancy of the declarer is the only variable.
 */
function documents(declaration: string, depthBody = '# Depth\n\nDepth body.\n', declarer: 'kernel-live' | 'kernel-dormant' = 'kernel-dormant'): ContentDocument[] {
  const liveBody = declarer === 'kernel-live' ? `# Kernel Live\n\nRule body.\n\n${declaration}\n` : '# Kernel Live\n\nRule body.\n';
  const dormantBody = declarer === 'kernel-dormant' ? `# Kernel Dormant\n\n${declaration}\n` : '# Kernel Dormant\n\nDormant body.\n';
  const sources: ContentSourceFile[] = [
    {
      path: 'content/kernel/kernel-live.md',
      text: front('kernel-live', 'kernel', 'task-start', liveBody),
    },
    {
      path: 'content/kernel/kernel-dormant.md',
      text: front('kernel-dormant', 'kernel', 'session-end', dormantBody),
    },
    {
      path: 'content/reference/depth.md',
      text: front('depth', 'reference', 'depth-load', depthBody),
    },
  ];
  const compiled = buildContentCorpus(sources);
  expect(compiled.ok).toBe(true);
  return [...compiled.value.documents];
}

function indexFor(docs: readonly ContentDocument[], mustFireIds: string[]): ComposeIndex {
  return {
    documents: docs,
    staticBlocks: [{ id: 'framework-rules', text: '<!-- aos:static -->\nFRAMEWORK RULES\n' }],
    mustFireIds,
    mustFireKernelIds: mustFireIds,
    mustFireStaticIds: docs.filter((document) => document.tier === 'kernel').map((document) => document.id).sort(),
  };
}

/** Only the dormant kernel declares `depth`, and it must not run in this scenario. */
function dormantScenario(declaration: string) {
  const docs = documents(declaration);
  return compose(
    { id: 'task-start', harness: 'default' },
    { referenceIds: ['depth'] },
    indexFor(docs, ['kernel-live']),
  );
}

/** The declaring kernel is activated for this scenario, so the request may resolve. */
function activatedScenario(declaration: string) {
  const docs = documents(declaration);
  return compose(
    { id: 'session-end', harness: 'default' },
    { referenceIds: ['depth'] },
    indexFor(docs, ['kernel-dormant']),
  );
}

describe('compose: reference declarations are scenario-scoped', () => {
  test('a dormant kernel\'s `References:` line does not authorize a requested reference', () => {
    const result = dormantScenario('References: depth');

    expect(result.value.diagnostics.declaredReferenceIds).toEqual([]);
    expect(result.value.diagnostics.droppedIds).toContain('depth');
    expect(result.errors.some((error) => error.code === 'reference-unresolved')).toBe(true);
    expect(result.value.payload.text).not.toContain('Depth body.');
    expect(result.ok).toBe(false);
  });

  test('a dormant kernel\'s Markdown link does not authorize a requested reference', () => {
    const result = dormantScenario('[Depth](../reference/depth.md)');

    // The link itself resolves in the corpus; only the declaring kernel is dormant.
    expect(result.errors.every((error) => error.code === 'reference-unresolved')).toBe(true);
    expect(result.value.diagnostics.declaredReferenceIds).toEqual([]);
    expect(result.errors.some((error) => error.code === 'reference-unresolved')).toBe(true);
    expect(result.value.payload.text).not.toContain('Depth body.');
    expect(result.ok).toBe(false);
  });

  test('the same request resolves once the declaring kernel activates', () => {
    const result = activatedScenario('References: depth');

    expect(result.value.diagnostics.declaredReferenceIds).toEqual(['depth']);
    expect(result.value.diagnostics.droppedIds).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.value.payload.dynamicSuffix).toContain('Depth body.');
    expect(result.ok).toBe(true);
  });

  test('the static prefix still ships every targeted kernel, activated or not', () => {
    const dormant = dormantScenario('References: depth').value;
    const activated = activatedScenario('References: depth').value;

    for (const payload of [dormant.payload, activated.payload]) {
      expect(payload.staticPrefix).toContain('kernel-live');
      expect(payload.staticPrefix).toContain('kernel-dormant');
      expect(payload.staticPrefix).toContain('FRAMEWORK RULES');
      expect(payload.dynamicSuffix).not.toContain('Rule body.');
    }
    // Prefix bytes depend on harness + corpus only, never on which kernel activated.
    expect(dormant.payload.staticHash).toBe(activated.payload.staticHash);
    expect(dormant.payload.staticPrefix).toBe(activated.payload.staticPrefix);
  });
});

describe('compose: heading anchors ignore fenced code', () => {
  const FENCED_ONLY = ['# Real Heading', '', `${FENCE}text`, '# Fenced Heading', FENCE, '', 'Done.'].join('\n');

  /** The link lives in the *activated* kernel, so only the anchor can decide the outcome. */
  function anchorScenario(fragment: string, depthBody: string) {
    const docs = documents('[Depth](../reference/depth.md#' + fragment + ')', depthBody, 'kernel-live');
    return compose(
      { id: 'task-start', harness: 'default' },
      { referenceIds: ['depth'] },
      indexFor(docs, ['kernel-live']),
    );
  }

  test('a heading inside a fence is not a resolvable anchor', () => {
    const result = anchorScenario('fenced-heading', FENCED_ONLY);

    expect(result.errors.some((error) => error.code === 'reference-declared-missing')).toBe(true);
    expect(result.value.diagnostics.declaredReferenceIds).toEqual([]);
    expect(result.value.payload.text).not.toContain('# Real Heading');
  });

  test('a real heading outside the fence still resolves (control)', () => {
    const result = anchorScenario('real-heading', FENCED_ONLY);

    expect(result.errors).toEqual([]);
    expect(result.value.diagnostics.declaredReferenceIds).toEqual(['depth']);
    expect(result.value.payload.dynamicSuffix).toContain('# Real Heading');
    expect(result.ok).toBe(true);
  });

  test.each(['```', '~~~'])('an unterminated %s fence hides headings through EOF', (marker) => {
    const result = anchorScenario('hidden-heading', ['# Real Heading', '', marker, '# Hidden Heading'].join('\n'));
    expect(result.errors.some((error) => error.code === 'reference-declared-missing')).toBe(true);
    expect(result.value.diagnostics.declaredReferenceIds).toEqual([]);
  });

  test.each(['```', '~~~'])('an unterminated %s fence cannot declare references through EOF', (marker) => {
    const docs = documents([marker, 'References: depth'].join('\n'));
    const result = compose({ id: 'task-start', harness: 'default' }, { referenceIds: ['depth'] }, indexFor(docs, ['kernel-live']));
    expect(result.errors.some((error) => error.code === 'reference-unresolved')).toBe(true);
    expect(result.value.diagnostics.declaredReferenceIds).toEqual([]);
  });
});
