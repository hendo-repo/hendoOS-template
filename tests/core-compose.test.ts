/**
 * Core compose + schema regression tests.
 *
 * Contract under test: `compose` must put framework and activated-kernel content
 * in the static prefix and volatile event/state metadata in the dynamic suffix;
 * it must validate the exact `mustFireIds` for the scenario; it must detect a
 * declared reference that does not resolve; and it must fail closed (not throw)
 * on malformed runtime input.
 */
import { describe, expect, test } from 'bun:test';
import { compose, type ComposeIndex } from '../src/compose/index';
import { composeVersionedPayload, VERSIONED_PAYLOAD_VERSION } from '../src/protocols/payload';
import { byteLength, normalizeNewlines } from '../src/protocols/text';
import {
  buildContentCorpus,
  buildContentManifest,
  compileContentDocument,
  compareContentManifest,
  evaluateMembership,
  normalizeRelativePath,
  type ContentDocument,
  type ContentSourceFile,
  type MembershipManifest,
} from '../src/schema/index';

const FRONT = (id: string, tier: string, event: string, extra = ''): string =>
  [
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
  ].join('\n') + extra;

const KERNEL_A = FRONT('kernel-a', 'kernel', 'session-start', '# Kernel A\n\nLoad-bearing rule.\n\nReferences: ref-a\n');
const KERNEL_B = FRONT('kernel-b', 'kernel', 'session-start', '# Kernel B\n\nAnother rule.\n');
const REF_A = FRONT('ref-a', 'reference', 'session-start', '# Ref A\n\nDepth.\n');
const REF_ORPHAN = FRONT('ref-orphan', 'reference', 'session-start', '# Ref Orphan\n\nNobody declared me.\n');
const OTHER_HARNESS = FRONT('other-kernel', 'kernel', 'session-start') .replace('[default]', '[other]');

function sources(): ContentSourceFile[] {
  return [
    { path: 'content/kernel/kernel-a.md', text: KERNEL_A },
    { path: 'content/kernel/kernel-b.md', text: KERNEL_B },
    { path: 'content/reference/ref-a.md', text: REF_A },
  ];
}

function corpusDocuments(files: readonly ContentSourceFile[]): ContentDocument[] {
  const compiled = buildContentCorpus(files);
  return [...compiled.value.documents];
}

const FRAMEWORK_BLOCK = { id: 'framework-rules', text: '<!-- aos:static -->\nFRAMEWORK RULES\n' };

const MEMBERSHIP: MembershipManifest = {
  version: 1,
  owner: 'test',
  generation: 1,
  scenarios: [
    {
      id: 'session-start',
      harness: 'default',
      event: 'session-start',
      expectedIds: ['kernel-a', 'kernel-b', 'ref-a'],
      expectedKernelIds: ['kernel-a', 'kernel-b'],
      expectedStaticIds: ['kernel-a', 'kernel-b'],
    },
  ],
};

function indexWith(documents: readonly ContentDocument[]): ComposeIndex {
  return { documents, staticBlocks: [FRAMEWORK_BLOCK], mustFireKernelIds: ['kernel-a', 'kernel-b'],
    mustFireStaticIds: ['kernel-a', 'kernel-b'] };
}

describe('compose: two-zone payload', () => {
  test('kernel content is fixed in the static prefix; only event metadata is dynamic', () => {
    const documents = corpusDocuments(sources());
    const result = compose({ id: 'session-start', harness: 'default' }, { keys: [] }, indexWith(documents));
    const { payload, diagnostics } = result.value;

    expect(payload.staticPrefix).toContain('FRAMEWORK RULES');
    expect(payload.staticPrefix).toContain('kernel-a');
    expect(payload.staticPrefix).toContain('kernel-b');
    expect(payload.dynamicSuffix).not.toContain('# Kernel A');
    expect(payload.text).toBe(payload.staticPrefix + payload.dynamicSuffix);
    expect(payload.bytes).toBe(byteLength(payload.text));
    expect(diagnostics.kernelIds.every((id) => payload.staticPrefix.includes(id))).toBe(true);
  });

  test('the static prefix is byte-identical across differing event/state queries', () => {
    const documents = corpusDocuments(sources());
    const first = compose({ id: 'session-start', harness: 'default' }, { keys: [] }, indexWith(documents)).value;
    const second = compose(
      { id: 'session-start', harness: 'default' },
      { keys: ['first-action', 'pivot'] },
      indexWith(documents),
    ).value;

    expect(first.payload.staticHash).toBe(second.payload.staticHash);
    expect(first.payload.staticPrefix).toBe(second.payload.staticPrefix);
    expect(first.payload.dynamicHash).not.toBe(second.payload.dynamicHash);
  });

  test('an unrelated event omits dormant procedures from the prefix', () => {
    const documents = corpusDocuments(sources());
    const result = compose(
      { id: 'ordinary-question', harness: 'default' },
      {},
      {
        documents,
        staticBlocks: [FRAMEWORK_BLOCK],
        mustFireIds: [],
        mustFireKernelIds: [],
        mustFireStaticIds: [],
      },
    );

    expect(result.value.payload.staticPrefix).toContain('FRAMEWORK RULES');
    expect(result.value.payload.staticPrefix).not.toContain('kernel-a');
    expect(result.value.payload.staticPrefix).not.toContain('kernel-b');
    expect(result.value.diagnostics.staticIds).toEqual([]);
  });

  test('dynamic suffix carries the event/state metadata, not content bodies', () => {
    const documents = corpusDocuments(sources());
    const result = compose({ id: 'session-start', harness: 'default' }, { keys: ['pivot'] }, indexWith(documents));
    const dynamic = result.value.payload.dynamicSuffix;

    expect(dynamic).toContain('event=session-start');
    expect(dynamic).toContain('pivot');
    expect(dynamic.length).toBeLessThan(result.value.payload.staticPrefix.length);
  });

  test('reference content is only shipped when an activated kernel declares it', () => {
    const documents = corpusDocuments([...sources(), { path: 'content/reference/ref-orphan.md', text: REF_ORPHAN }]);
    const result = compose({ id: 'session-start', harness: 'default' }, { keys: [] }, indexWith(documents));

    expect(result.value.diagnostics.declaredReferenceIds).toEqual(['ref-a']);
    expect(result.value.diagnostics.unresolvedReferenceIds).toEqual(['ref-orphan']);
    expect(result.errors.some((e) => e.code === 'reference-unresolved')).toBe(true);
    expect(result.value.payload.text).not.toContain('# Ref A');
    expect(result.value.payload.text).not.toContain('Nobody declared me');
    expect(result.ok).toBe(false);
  });
});

describe('compose: mustFireIds membership', () => {
  test('a demoted must-fire kernel id fails the compose', () => {
    const documents = corpusDocuments(sources());
    const result = compose(
      { id: 'session-start', harness: 'default' },
      { keys: [] },
      { ...indexWith(documents), mustFireIds: ['kernel-a', 'kernel-b', 'ref-a', 'kernel-ghost'] },
    );

    expect(result.ok).toBe(false);
    expect(result.value.diagnostics.mustFireMissingIds).toEqual(['kernel-ghost']);
    expect(result.errors.some((e) => e.code === 'membership-mismatch')).toBe(true);
  });

  test('an unexpected activation fails the compose', () => {
    const documents = corpusDocuments(sources());
    const result = compose(
      { id: 'session-start', harness: 'default' },
      { keys: [] },
      { ...indexWith(documents), mustFireIds: ['kernel-a', 'kernel-b'] },
    );

    expect(result.ok).toBe(false);
    expect(result.value.diagnostics.mustFireExtraIds).toEqual(['ref-a']);
    expect(result.errors.some((e) => e.code === 'membership-mismatch')).toBe(true);
  });

  test('an exact must-fire set passes', () => {
    const documents = corpusDocuments(sources());
    const result = compose(
      { id: 'session-start', harness: 'default' },
      { keys: [] },
      { ...indexWith(documents), mustFireIds: ['kernel-a', 'kernel-b', 'ref-a'] },
    );

    expect(result.value.diagnostics.mustFireMissingIds).toEqual([]);
    expect(result.value.diagnostics.mustFireExtraIds).toEqual([]);
    expect(result.ok).toBe(true);
  });

  test('the shipped membership manifest evaluates exactly (not an empty success)', () => {
    const documents = corpusDocuments(sources());
    const evaluation = evaluateMembership(MEMBERSHIP, documents);
    expect(evaluation.value.exact).toBe(true);
    expect(evaluation.value.results[0]?.actualIds).toEqual(['kernel-a', 'kernel-b', 'ref-a']);
  });

  test('an empty corpus can never produce a successful compose', () => {
    const result = compose({ id: 'session-start', harness: 'default' }, { keys: [] }, { documents: [] });
    expect(result.ok).toBe(false);
    expect(result.value.payload.text === '' || result.value.diagnostics.selectionEmpty).toBe(true);
    expect(result.errors.some((e) => e.code === 'empty-index')).toBe(true);
  });
});

describe('compose: malformed runtime input fails closed', () => {
  test('no TypeError on malformed event/state/index', () => {
    const documents = corpusDocuments(sources());
    const cases: [unknown, unknown, unknown][] = [
      [null, { keys: [] }, indexWith(documents)],
      [{ id: 1, harness: 2 }, { keys: [] }, indexWith(documents)],
      [{ id: 'session-start', harness: 'default' }, { keys: 'no' }, indexWith(documents)],
      [{ id: 'session-start', harness: 'default' }, { keys: [1, 2] }, indexWith(documents)],
      [{ id: 'session-start', harness: 'default' }, { keys: [] }, null],
      [{ id: 'session-start', harness: 'default' }, { keys: [] }, { documents: 'nope' }],
      [{ id: 'session-start', harness: 'default' }, { keys: [] }, { documents: [null] }],
      [{ id: 'session-start', harness: 'default' }, { keys: [] }, { documents, staticBlocks: [{}] }],
      [{ id: 'session-start', harness: 'default' }, { keys: [] }, { documents, totalByteBudget: -1 }],
    ];

    for (const [event, state, index] of cases) {
      let thrown: unknown = null;
      let result: ReturnType<typeof compose> | null = null;
      try {
        result = compose(event as never, state as never, index as never);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeNull();
      expect(result?.ok).toBe(false);
      expect((result?.errors.length ?? 0) > 0).toBe(true);
    }
  });

  test('a malformed document in the index is reported as an error, not thrown', () => {
    const documents = corpusDocuments(sources());
    const broken = { id: 'broken', tier: 'kernel' } as unknown as ContentDocument;
    const result = compose(
      { id: 'session-start', harness: 'default' },
      { keys: [] },
      { documents: [...documents, broken], staticBlocks: [FRAMEWORK_BLOCK] },
    );

    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});

describe('compose: payload carries contracts and provenance', () => {
  test('payload exposes schema/compose version, budget, must-fire ids, hash and source map', () => {
    const documents = corpusDocuments(sources());
    const result = compose(
      { id: 'session-start', harness: 'default' },
      { keys: [] },
      { ...indexWith(documents), totalByteBudget: 100_000, mustFireIds: ['kernel-a', 'kernel-b', 'ref-a'] },
    );
    const { payload, diagnostics } = result.value;

    expect(payload.version).toBe(VERSIONED_PAYLOAD_VERSION);
    expect(payload.schemaVersion).toBeGreaterThan(0);
    expect(payload.composeVersion).toBeGreaterThan(0);
    expect(payload.budget).toBe(100_000);
    expect(payload.mustFireIds).toEqual(['kernel-a', 'kernel-b', 'ref-a']);
    expect(/^sha256:[a-f0-9]{64}$/.test(payload.hash)).toBe(true);
    expect(payload.sourceMap.length).toBeGreaterThan(0);
    expect(payload.sourceMap.some((entry) => entry.region === 'static')).toBe(true);
    expect(diagnostics.totalBytes).toBe(payload.bytes);
  });
});

describe('compose: determinism', () => {
  test('two calls with equal inputs are deep-equal and byte-identical', () => {
    const documents = corpusDocuments(sources());
    const index = indexWith(documents);
    const a = compose({ id: 'session-start', harness: 'default' }, { keys: ['pivot'] }, index);
    const b = compose({ id: 'session-start', harness: 'default' }, { keys: ['pivot'] }, index);
    expect(a.value).toEqual(b.value);
    expect(a.value.payload.text).toBe(b.value.payload.text);
  });

  test('document input order does not change the payload', () => {
    const documents = corpusDocuments(sources());
    const shuffled = [...documents].reverse();
    const a = compose({ id: 'session-start', harness: 'default' }, { keys: [] }, indexWith(documents));
    const b = compose({ id: 'session-start', harness: 'default' }, { keys: [] }, indexWith(shuffled));
    expect(a.value.payload.text).toBe(b.value.payload.text);
  });
});

describe('schema: compile / manifest / path contracts', () => {
  test('compiling a malformed source returns errors rather than throwing', () => {
    const cases = [
      '---\nid: Bad_Id\nversion: 1\ntier: kernel\ntarget_harnesses: [d]\nbyte_budget: 10\nactivation_conditions:\n  - harnesses: [d]\n    event: e\n---\nbody\n',
      '---\nid: x\nversion: 1\ntier: kernel\ntarget_harnesses: [d]\nbyte_budget: 10\nactivation_conditions:\n  - harnesses: [d]\n    event: e\n---\n',
      'no frontmatter at all\n',
      '---\nid: x\nversion: 1\ntier: kernel\ntarget_harnesses: [d]\nbyte_budget: 10\nactivation_conditions:\n  - harnesses: [d]\n    event: e\nunexpected_key: 1\n---\nbody\n',
    ];
    for (const text of cases) {
      let thrown: unknown = null;
      try {
        const result = compileContentDocument('content/kernel/x.md', text);
        expect(result.ok).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeNull();
    }
  });

  test('a valid source round-trips to a document with a digest', () => {
    const result = compileContentDocument('content/kernel/kernel-a.md', KERNEL_A);
    expect(result.ok).toBe(true);
    expect(result.value?.id).toBe('kernel-a');
    expect(result.value?.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.value?.body.startsWith('# Kernel A')).toBe(true);
  });

  test('manifest comparison catches a digest change and generation regression', () => {
    const documents = corpusDocuments(sources());
    const corpus = buildContentCorpus(sources()).value;
    const manifest = buildContentManifest('test', 2, corpus);
    expect(compareContentManifest(manifest, corpus).value.exact).toBe(true);

    const tampered = {
      ...manifest,
      generation: 1,
      sources: manifest.sources.map((source, i) =>
        i === 0 ? { ...source, digest: `sha256:${'0'.repeat(64)}` } : source,
      ),
    };
    const comparison = compareContentManifest(tampered, corpus, 3);
    expect(comparison.value.exact).toBe(false);
    expect(comparison.value.changed.length).toBe(1);
    expect(comparison.value.generationRegression).toBe(true);
  });

  test('evaluateMembership fails on an unexpected extra id', () => {
    const documents = corpusDocuments(sources());
    const mismatched: MembershipManifest = {
      ...MEMBERSHIP,
      scenarios: [{ ...MEMBERSHIP.scenarios[0]!, expectedIds: ['kernel-a'] }],
    };
    const evaluation = evaluateMembership(mismatched, documents);
    expect(evaluation.value.exact).toBe(false);
    expect(evaluation.value.results[0]?.extraIds).toEqual(['kernel-b', 'ref-a']);
    expect(evaluation.ok).toBe(false);
  });

  test('unsafe paths are rejected without echoing the input', () => {
    for (const bad of ['/etc/passwd', '~/x', 'a/../../b', 'C:\\x', 'a\u0000b']) {
      const result = normalizeRelativePath(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(JSON.stringify(result.error)).not.toContain('/etc/passwd');
        expect(JSON.stringify(result.error)).not.toContain('C:\\');
      }
    }
    const good = normalizeRelativePath('./content//kernel/a.md');
    expect(good.ok && good.path === 'content/kernel/a.md').toBe(true);
  });

  test('payload keeps static prefix invariant when only dynamic segments change', () => {
    const base = composeVersionedPayload({
      staticSegments: [{ id: 'static:framework', text: 'FIXED\n', sourceIds: [] }],
      dynamicSegments: [{ id: 'content:a', text: 'a\n', sourceIds: ['a'] }],
    });
    const changed = composeVersionedPayload({
      staticSegments: [{ id: 'static:framework', text: 'FIXED\n', sourceIds: [] }],
      dynamicSegments: [
        { id: 'content:a', text: 'a\n', sourceIds: ['a'] },
        { id: 'content:b', text: 'b\n', sourceIds: ['b'] },
      ],
    });
    expect(base.value.staticPrefix).toBe(changed.value.staticPrefix);
    expect(base.value.staticHash).toBe(changed.value.staticHash);
    expect(base.value.hash).not.toBe(changed.value.hash);
    expect(base.value.text).toBe(normalizeNewlines(base.value.staticPrefix + base.value.dynamicSuffix));
  });
});
