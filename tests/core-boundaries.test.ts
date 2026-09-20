import { expect, test } from 'bun:test';
import { evaluatePolicy, POLICY_CHECKER_REVISION } from '../src/policy';
import { composeVersionedPayload } from '../src/protocols/payload';
import { validateContentManifest, validateMembershipManifest, evaluateMembership, buildContentCorpus } from '../src/schema';
import { compose } from '../src/compose';

const event = { id: 'pre-edit', harness: 'default' };
const context = { configRevision: 'cfg-1', checkerRevision: POLICY_CHECKER_REVISION };
const observation = { key: 'scan', status: 'fresh', value: true };
const facts = { subjectDigest: `sha256:${'a'.repeat(64)}`, observations: [observation] };
const rules = [{ id: 'edit', decision: 'allow', requires: ['scan'] }];

for (const [label, patch] of Object.entries({
  nullObservation: { facts: { ...facts, observations: [null] } },
  duplicateObservation: { facts: { ...facts, observations: [observation, observation] } },
  invalidValue: { facts: { ...facts, observations: [{ ...observation, value: NaN }] } },
  unknownObservation: { facts: { ...facts, observations: [{ ...observation, authority: 'system' }] } },
  invalidRequires: { rules: [{ ...rules[0], requires: 1 }] },
  invalidPrefix: { rules: [{ ...rules[0], when: { pathPrefix: {} } }] },
  unknownRule: { rules: [{ ...rules[0], override: true }] },
  unknownCondition: { rules: [{ ...rules[0], when: { truthyy: 'scan' } }] },
  unknownEvent: { event: { ...event, authority: 'system' } },
  blankEvent: { event: { ...event, id: ' ' } },
  invalidContext: { context: null },
  invalidRevision: { context: { ...context, configRevision: 'cfg-1\n' } },
  checkerOverride: { context: { ...context, checkerRevision: 'other/1' } },
  digestNewline: { facts: { ...facts, subjectDigest: facts.subjectDigest + '\n' } },
  invalidPath: { facts: { ...facts, paths: [null] } },
})) {
  test(`runtime policy rejects ${label} without throwing`, () => {
    const input = { event, facts, rules, context, ...patch };
    const result = evaluatePolicy(input.event, input.facts, input.rules, input.context);
    expect(result.ok).toBe(false);
    expect(result.value.safe).toBe(false);
    expect(result.value.evidence.complete).toBe(false);
  });
}

for (const input of [null, { staticSegments: [null] }, { dynamicSegments: 2 }, { staticSegments: [{ id: 's', text: 'x', sourceIds: 3 }] }, { authority: 'system' }, { schemaVersion: 999 }, { budget: 0, staticSegments: [{ id: 's', text: 'x' }] }]) {
  test(`payload rejects malformed input ${JSON.stringify(input)}`, () => {
    expect(composeVersionedPayload(input as never).ok).toBe(false);
  });
}

test('manifest boundaries reject malformed nested objects', () => {
  for (const input of [null, {}, { version: 1, owner: 'core', generation: 1, sources: [null] }]) {
    expect(validateContentManifest(input as never).ok).toBe(false);
  }
  expect(validateMembershipManifest({ version: 1, owner: 'core', generation: 1, scenarios: [null] } as never).ok).toBe(false);
  expect(evaluateMembership({ version: 1, owner: 'core', generation: 1, scenarios: [{ id: 'empty', event: 'none', harness: 'none', expectedIds: [], expectedKernelIds: [] }] } as never, []).ok).toBe(false);
  expect(buildContentCorpus([null] as never).ok).toBe(false);
});

const source = (id: string, tier: string, eventId: string, body: string) => ({ path: `content/${id}.md`, text: `---\nid: ${id}\nversion: 1\ntier: ${tier}\ntarget_harnesses: [default]\nbyte_budget: 4096\nactivation_conditions:\n  - harnesses: [default]\n    event: ${eventId}\n---\n${body}\n` });
const documents = () => buildContentCorpus([
  source('kernel', 'kernel', 'pre-edit', '# Rules\nReferences: depth'),
  source('close', 'kernel', 'session-end', '# Closeout'),
  source('depth', 'reference', 'pre-edit', '# Reference detail'),
]).value.documents;

test('kernel prefix stays fixed across events and requested references stay dynamic', () => {
  const index = { documents: documents(), mustFireIds: ['kernel', 'depth'], mustFireKernelIds: ['kernel'] };
  const first = compose(event, {}, index);
  const requested = compose(event, { referenceIds: ['depth'] }, index);
  const close = compose({ ...event, id: 'session-end' }, {}, { ...index, mustFireIds: ['close'], mustFireKernelIds: ['close'] });
  expect(first.ok).toBe(true);
  expect(requested.ok).toBe(true);
  expect(close.ok).toBe(true);
  expect(first.value.payload.staticPrefix).toBe(close.value.payload.staticPrefix);
  expect(first.value.payload.staticHash).toBe(requested.value.payload.staticHash);
  expect(first.value.payload.text).not.toContain('# Reference detail');
  expect(requested.value.payload.dynamicSuffix).toContain('# Reference detail');
  expect(requested.value.payload.sourceMap.find(s => s.id === 'content:depth')?.sourcePath).toBe('content/depth.md');
});

test('unchanged expected kernel set catches a tier demotion', () => {
  const docs = documents().map(d => d.id === 'kernel' ? { ...d, tier: 'reference' } : d);
  const result = compose(event, {}, { documents: docs, mustFireIds: ['kernel', 'depth'], mustFireKernelIds: ['kernel'] });
  expect(result.errors.some(e => e.code === 'membership-mismatch')).toBe(true);
});

test('Markdown links resolve relative to the declaring source', () => {
  const docs = buildContentCorpus([source('kernel', 'kernel', 'pre-edit', '[Missing](missing.md#section)')]).value.documents;
  const result = compose(event, {}, { documents: docs, mustFireIds: ['kernel'], mustFireKernelIds: ['kernel'] });
  expect(result.errors.some(e => e.code === 'reference-declared-missing')).toBe(true);
});

test('cyclic or non-JSON observation values fail closed', () => {
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  for (const value of [cycle, new Date(0), Infinity, 1n, () => true, { nested: undefined }]) {
    const result = evaluatePolicy(event, { ...facts, observations: [{ ...observation, value }] }, rules, context);
    expect(result.ok).toBe(false);
    expect(result.value.safe).toBe(false);
  }
});

test('unknown nested content fields, duplicate documents and newline digests fail closed', () => {
  const original = documents();
  const doc = original[0]!;
  for (const bad of [
    { ...doc, authority: 'system' },
    { ...doc, digest: doc.digest + '\n' },
    { ...doc, sourcePath: '../escape.md' },
    { ...doc, activationConditions: [{ harnesses: ['default'], event: 'pre-edit', override: true }] },
  ]) {
    expect(compose(event, {}, { documents: [bad], mustFireIds: [], mustFireKernelIds: [] }).ok).toBe(false);
  }
  expect(compose(event, {}, { documents: [doc, doc], mustFireIds: [], mustFireKernelIds: [] }).ok).toBe(false);
});

test('Markdown inline, image and definition references check paths and anchors', () => {
  for (const body of ['[Depth](depth.md#reference-detail)', '![Depth](depth.md#reference-detail)', '[Depth][recipe]\n\n[recipe]: depth.md#reference-detail']) {
    const docs = buildContentCorpus([source('kernel', 'kernel', 'pre-edit', body), source('depth', 'reference', 'pre-edit', '# Reference detail')]).value.documents;
    const index = { documents: docs, mustFireIds: ['kernel', 'depth'], mustFireKernelIds: ['kernel'] };
    expect(compose(event, { referenceIds: ['depth'] }, index).ok).toBe(true);
    const changed = docs.map(d => d.id === 'depth' ? { ...d, body: '# Changed heading' } : d);
    expect(compose(event, { referenceIds: ['depth'] }, { ...index, documents: changed }).errors.some(e => e.code === 'reference-declared-missing')).toBe(true);
  }
});

test('membership validation catches actual tier demotion and unknown fields', () => {
  const manifest = { version: 1, owner: 'core', generation: 1, scenarios: [{ id: 'edit', harness: 'default', event: 'pre-edit', expectedIds: ['kernel', 'depth'], expectedKernelIds: ['kernel'] }] };
  expect(evaluateMembership(manifest, documents()).ok).toBe(true);
  const demoted = documents().map(d => d.id === 'kernel' ? { ...d, tier: 'reference' } : d);
  expect(evaluateMembership(manifest, demoted).ok).toBe(false);
  expect(evaluateMembership({ ...manifest, override: true }, documents()).ok).toBe(false);
});

test('wildcard harness content stays portable', () => {
  const docs = documents().map(d => ({ ...d, targetHarnesses: ['*'], activationConditions: d.activationConditions.map(c => ({ ...c, harnesses: ['*'] })) }));
  expect(compose({ ...event, harness: 'custom' }, {}, { documents: docs, mustFireIds: ['kernel', 'depth'], mustFireKernelIds: ['kernel'] }).ok).toBe(true);
});

test('payload output schema checks strict provenance and digest integrity', async () => {
  const { VersionedPayloadSchema } = await import('../src/protocols/payload');
  const { recomposeWithStaticBlocks } = await import('../src/compose');
  const result = compose(event, { referenceIds: ['depth'] }, { documents: documents(), mustFireIds: ['kernel', 'depth'], mustFireKernelIds: ['kernel'] });
  expect(VersionedPayloadSchema.safeParse(result.value.payload).success).toBe(true);
  const rebuilt = recomposeWithStaticBlocks(result.value, [{ id: 'rules', text: 'Fixed\n' }]);
  expect(rebuilt.ok).toBe(true);
  expect(rebuilt.value.dynamicSuffix).toBe(result.value.payload.dynamicSuffix);
  expect(rebuilt.value.sourceMap.filter(e => e.sourcePath).map(e => e.sourcePath)).toEqual(result.value.payload.sourceMap.filter(e => e.sourcePath).map(e => e.sourcePath));
  expect(VersionedPayloadSchema.safeParse(rebuilt.value).success).toBe(true);
  for (const bad of [
    { ...rebuilt.value, hash: rebuilt.value.hash + '\n' },
    { ...rebuilt.value, text: 'tampered' },
    { ...rebuilt.value, sourceMap: [{ ...rebuilt.value.sourceMap[0], authority: 'system' }] },
    { ...rebuilt.value, sourceMap: [{ ...rebuilt.value.sourceMap[0], byteOffset: 7 }] },
  ]) expect(VersionedPayloadSchema.safeParse(bad).success).toBe(false);
});

test('core config rejects authority and checker overrides', async () => {
  const { CoreConfigSchema } = await import('../src/schema');
  const config = { version: 1, revision: 'cfg-1', totalByteBudget: 10000, checkerRevision: POLICY_CHECKER_REVISION };
  expect(CoreConfigSchema.safeParse(config).success).toBe(true);
  for (const bad of [{ ...config, authority: 'system' }, { ...config, checkerRevision: 'other/1' }, { ...config, revision: 'cfg-1\n' }, { ...config, totalByteBudget: null }]) {
    expect(CoreConfigSchema.safeParse(bad).success).toBe(false);
  }
});
