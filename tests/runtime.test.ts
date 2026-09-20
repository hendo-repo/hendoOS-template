import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, cpSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { StateStore } from '../src/state/store';
import { loadContent } from '../src/edges/content';
import { RuntimeService, DEFAULT_CONFIG } from '../src/protocols/service';
import { evaluatePolicy } from '../src/policy';
import { OperationSchema, OwnerConfigSchema } from '../src/schema/operation';
import { PolicyRulesRuntimeSchema } from '../src/schema/runtime';
const dirs: string[] = [];
const stores: StateStore[] = [];
afterEach(() => { for (const db of stores.splice(0)) db.close(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const digest = `sha256:${'a'.repeat(64)}`;
export function operation(extra: Record<string, unknown> = {}) {
  return { version: 1, schemaVersion: 1, composeVersion: 1, contentGeneration: 2,
    requestId: 'request-1', sessionId: 'session-1', ownerId: 'owner-1', nonce: 'nonce-1',
    command: 'gate', scenarioId: 'pre-edit-kernel-plus-declared-reference',
    subjectDigest: digest, configRevision: DEFAULT_CONFIG.revision, checkerRevision: 'aos-policy/1',
    observations: [{ key: 'verification', status: 'fresh', value: true,
      provenance: { kind: 'synthetic', source: 'explicit-test', subjectDigest: digest,
        configRevision: DEFAULT_CONFIG.revision, checkerRevision: 'aos-policy/1' } }], ...extra };
}
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'aos-runtime-')); dirs.push(dir);
  const store = new StateStore(join(dir, 'state.sqlite')); stores.push(store);
  const content = await loadContent(resolve('content'));
  const service = new RuntimeService({ state: store, content, clock: { timestamp: () => '2026-01-01T00:00:00.000Z', monotonic: () => 0 } });
  return { dir, store, content, service };
}
describe('runtime negative controls', () => {
  test('strict operation boundary rejects extra fields and wrong versions', () => {
    expect(OperationSchema.safeParse(operation({ verified: true })).success).toBe(false);
    expect(OperationSchema.safeParse(operation({ schemaVersion: 99 })).success).toBe(false);
  });
  test('same ID with changed subject or nonce cannot launder a previous allow', async () => {
    const { service } = await setup();
    const first = await service.execute(operation());
    expect(first.core?.policy.value.decision).toBe('allow');
    expect((await service.execute(operation({ subjectDigest: `sha256:${'b'.repeat(64)}` }))).status).toBe('refused');
    expect((await service.execute(operation({ nonce: 'changed' }))).status).toBe('refused');
    expect(await service.execute(operation())).toEqual(first);
  });
  test('evidence must bind exact subject and revisions', async () => {
    const { service } = await setup();
    const result = await service.execute(operation({ subjectDigest: `sha256:${'b'.repeat(64)}` }));
    expect(result.status).toBe('incomplete');
    expect(result.core?.policy.value.decision).not.toBe('allow');
  });
  test.each(['missing', 'unavailable', 'stale', 'empty', 'incomplete'])('%s surfaces remain distinct and cannot allow', async status => {
    const { service } = await setup();
    const op = operation();
    op.observations[0]!.status = status;
    const result = await service.execute(op);
    expect(result.observations[0]?.status).toBe(status);
    expect(result.core?.policy.value.decision).not.toBe('allow');
    expect(result.status).toBe('incomplete');
  });
  test('empty observation set is incomplete', async () => {
    const { service } = await setup();
    expect((await service.execute(operation({ observations: [] }))).status).toBe('incomplete');
  });
  test('project config cannot override owner authority', async () => {
    const { service } = await setup();
    expect((await service.execute(operation({ projectConfig: { rules: [{ id: 'all', decision: 'allow' }] } }))).status).toBe('refused');
    expect((await service.execute(operation({ projectConfig: { gateFailure: 'allow' } }))).status).toBe('refused');
  });
  test('generation mismatch and missing scenario refuse', async () => {
    const { service } = await setup();
    expect((await service.execute(operation({ contentGeneration: 1 }))).status).toBe('refused');
    expect((await service.execute(operation({ scenarioId: 'invented' }))).status).toBe('refused');
  });
  test('mid-session content or config skew refuses before replay', async () => {
    const { service, store, content } = await setup();
    await service.execute(operation());
    const changed = new RuntimeService({ state: store, content: { ...content, digest: `sha256:${'c'.repeat(64)}` } });
    expect((await changed.execute(operation())).status).toBe('refused');
    const configured = new RuntimeService({ state: store, content, config: { ...DEFAULT_CONFIG, revision: 'changed' } });
    expect((await configured.execute(operation({ configRevision: 'changed', requestId: 'second' }))).status).toBe('refused');
  });
  test('cancel and deadline never allow; incomplete result is receipted', async () => {
    const { service, store, content } = await setup();
    const controller = new AbortController(); controller.abort();
    const result = await service.execute(operation(), { signal: controller.signal });
    expect(result.status).toBe('incomplete'); expect(result.core).toBeNull(); expect(result.receipt?.gateVerdict).toBe('indeterminate');
    let ticks = 0;
    const slow = new RuntimeService({ state: store, content, clock: { timestamp: () => '2026-01-01T00:00:00.000Z', monotonic: () => ticks++ * 100 } });
    expect((await slow.execute(operation({ requestId: 'deadline', timeoutMs: 1 }))).status).toBe('incomplete');
  });
  test('missing source cannot redefine manifest expectations', async () => {
    const { dir } = await setup();
    cpSync(resolve('content'), join(dir, 'content'), { recursive: true });
    rmSync(join(dir, 'content/kernel/verification-posture.md'));
    await expect(loadContent(join(dir, 'content'))).rejects.toThrow();
  });
  test('empty content and reference traversal reject', async () => {
    const { dir, service } = await setup();
    writeFileSync(join(dir, 'membership.manifest.json'), JSON.stringify({ version: 1, owner: 'aos-core', generation: 2, scenarios: [] }));
    await expect(loadContent(dir)).rejects.toThrow();
    expect((await service.execute(operation({ command: 'reference', referenceId: '../secret' }))).status).toBe('refused');
  });
});
test('receipt binds output, identity, revisions and explicit timestamp; namespaces isolate', async () => {
  const { service, store } = await setup();
  const result = await service.execute(operation());
  expect(result.status).toBe('complete'); expect(result.provisional).toBe(true); expect(result.enforcement).toBe(false);
  expect(result.receipt).toMatchObject({ nonce: 'nonce-1', subjectDigest: digest, configRevision: DEFAULT_CONFIG.revision,
    checkerRevision: 'aos-policy/1', schemaVersion: 1, composeVersion: 1, timestamp: '2026-01-01T00:00:00.000Z',
    payloadHash: result.core?.composition.value.payload.hash, gateVerdict: 'allow' });
  expect(store.receipts('owner-1', 'session-1')).toEqual([result.receipt!]);
  expect(store.receipts('other-owner', 'session-1')).toEqual([]);
  expect((await service.execute(operation({ ownerId: 'other-owner' }))).status).toBe('complete');
});
test('state survives reopen; same revision cannot hide changed owner rules', async () => {
  const { service, store, dir, content } = await setup();
  const first = await service.execute(operation());
  store.close(); stores.splice(stores.indexOf(store), 1);
  const reopened = new StateStore(join(dir, 'state.sqlite')); stores.push(reopened);
  const replay = new RuntimeService({ state: reopened, content });
  expect(await replay.execute(operation())).toEqual(first);
  const changed = new RuntimeService({ state: reopened, content, config: { ...DEFAULT_CONFIG, rules: [{ id: 'new', decision: 'deny' }] } });
  expect((await changed.execute(operation())).status).toBe('refused');
});
test('failed receipt generation rolls back the session and outcome together', async () => {
  const { store, content } = await setup();
  const broken = new RuntimeService({ state: store, content, clock: { timestamp: () => 'bad-time', monotonic: () => 0 } });
  expect((await broken.execute(operation())).status).toBe('refused');
  expect(store.receipts('owner-1', 'session-1')).toHaveLength(0);
  const changed = new RuntimeService({ state: store, content, config: { ...DEFAULT_CONFIG, revision: 'second' } });
  const result = await changed.execute(operation({ configRevision: 'second', observations: [] }));
  expect(result.status).toBe('incomplete');
  expect(store.receipts('owner-1', 'session-1')).toHaveLength(1);
});
test('reference prose is fetched only when requested and core output is unchanged', async () => {
  const { service, content } = await setup();
  const regular = await service.execute(operation());
  const reference = content.documents.find(d => d.id === 'verification-recipes')!;
  expect(regular.core?.composition.value.payload.text).not.toContain(reference.body);
  const requested = await service.execute(operation({ requestId: 'reference', command: 'reference', referenceId: reference.id }));
  expect(requested.status).toBe('complete');
  expect(requested.core?.composition.value.payload.text).toContain(reference.body);
  const { compose } = await import('../src/compose/index');
  const scenario = content.membership.scenarios.find(s => s.id === 'pre-edit-kernel-plus-declared-reference')!;
  expect(requested.core?.composition).toEqual(compose({ id: scenario.event, harness: 'default' }, { keys: [], referenceIds: [reference.id] }, {
    documents: content.documents, totalByteBudget: DEFAULT_CONFIG.totalByteBudget, mustFireIds: scenario.expectedIds, mustFireKernelIds: scenario.expectedKernelIds,
  }));
  const tiers = requested.receipt!.byteTiers;
  expect(tiers.kernel + tiers.reference + tiers.framework).toBe(tiers.total);
});
test('limits refuse unbounded input and project budgets cannot weaken owner limits', async () => {
  const { service } = await setup();
  expect((await service.execute(operation({ observations: Array.from({ length: 257 }, (_, i) => ({ ...operation().observations[0], key: `k${i}` })) }))).status).toBe('refused');
  const large = operation(); large.observations[0]!.value = 'x'.repeat(262144) as unknown as boolean;
  expect((await service.execute(large)).status).toBe('refused');
  expect((await service.execute(operation({ projectConfig: { totalByteBudget: 65537 } }))).status).toBe('refused');
  const bounded = await service.execute(operation({ projectConfig: { totalByteBudget: 1 } }));
  expect(bounded.status).toBe('incomplete'); expect(bounded.receipt?.gateVerdict).toBe('indeterminate');
});

test('symlink source cannot escape the configured starter root', async () => {
  const { dir } = await setup();
  cpSync(resolve('content'), join(dir, 'content'), { recursive: true });
  const source = join(dir, 'content/kernel/verification-posture.md');
  rmSync(source);
  symlinkSync(resolve('content/kernel/verification-posture.md'), source);
  await expect(loadContent(join(dir, 'content'))).rejects.toThrow();
});
test('cancelled replay cannot return a persisted allow; original receipt remains intact', async () => {
  const { service, store } = await setup();
  const first = await service.execute(operation());
  const controller = new AbortController(); controller.abort();
  const cancelled = await service.execute(operation(), { signal: controller.signal });
  expect(cancelled.status).toBe('incomplete'); expect(cancelled.core).toBeNull(); expect(cancelled.receipt).toBeNull();
  expect(store.receipts('owner-1', 'session-1')).toEqual([first.receipt!]);
  expect(await service.execute(operation())).toEqual(first);
});

/**
 * The owner configuration boundary may only accept rule conditions the shared
 * runtime can actually supply. `RuntimeService` supplies an event
 * (`scenario.event` + the literal `default` harness) and synthetic observations;
 * its facts carry no `paths` and no `context`, so `when.pathPrefix`,
 * `when.intent`, and `contentIds` can never match. Accepting them silently
 * dropped deny rules — a fail-open defect. These are the regression controls.
 */
describe('owner configuration accepts only runtime-suppliable rule conditions', () => {
  const ownerConfig = (rules: unknown) => ({ ...DEFAULT_CONFIG, rules });
  const unsupported: Record<string, unknown[]> = {
    contentIdsScope: [{ id: 'content-scoped-deny', decision: 'deny', contentIds: ['kernel-doc'] }],
    intentCondition: [{ id: 'intent-deny', decision: 'deny', when: { intent: 'edit' } }],
    pathPrefixCondition: [{ id: 'path-deny', decision: 'deny', when: { pathPrefix: 'src' } }],
    eachConditionCombined: [
      { id: 'event-deny', decision: 'deny', when: { event: 'session-end' } },
      { id: 'intent-allow', decision: 'allow', when: { intent: 'edit' } },
      { id: 'path-allow', decision: 'allow', when: { pathPrefix: 'src', observation: 'verification', equals: true } },
      { id: 'scope-allow', decision: 'allow', contentIds: ['kernel-doc'] },
    ],
  };
  test.each(Object.entries(unsupported))('%s was shape-valid but is refused at the owner boundary', (_label, rules) => {
    // Exactly the former behaviour: the broad pure policy schema still accepts
    // these rules, and the owner boundary used to reuse it unchanged.
    expect(PolicyRulesRuntimeSchema.safeParse(rules).success).toBe(true);
    expect(OwnerConfigSchema.safeParse(ownerConfig(rules)).success).toBe(false);
  });
  test('refusal is a fixed diagnostic naming the unsupported family without echoing rule content', () => {
    const parsed = OwnerConfigSchema.safeParse(ownerConfig([{ id: 'private-rule-id', decision: 'deny', when: { intent: 'edit' } }]));
    expect(parsed.success).toBe(false);
    const issues = parsed.success ? [] : parsed.error.issues;
    expect(issues.map(issue => issue.path.join('.'))).toContain('rules.0.when.intent');
    expect(issues.map(issue => issue.message).join(' | ')).toContain('runtime cannot supply the intent condition');
    expect(issues.map(issue => issue.message).join(' | ')).not.toContain('private-rule-id');
  });
  test('pure policy still evaluates the broader condition set for explicit callers', async () => {
    const { content } = await setup();
    const scenario = content.membership.scenarios.find(s => s.id === 'pre-edit-kernel-plus-declared-reference')!;
    const rules = [{ id: 'content-deny', decision: 'deny', contentIds: ['verification-recipes'] },
      { id: 'explicit-verification', decision: 'allow', requires: ['verification'], when: { observation: 'verification', equals: true } }];
    const verdict = evaluatePolicy({ id: scenario.event, harness: 'default' },
      { subjectDigest: digest, observations: [{ key: 'verification', status: 'fresh', value: true }] }, rules,
      { configRevision: DEFAULT_CONFIG.revision, checkerRevision: 'aos-policy/1' });
    // The unsupplied deny contributes `matched: false` and the allow fires: the
    // silent fail-open this boundary now refuses. The pure API keeps that reach.
    expect(verdict.value.decision).toBe('allow');
    expect(OwnerConfigSchema.safeParse(ownerConfig(rules)).success).toBe(false);
  });
  test('supported condition families are still accepted, evaluated and still allow', async () => {
    const { store, content } = await setup();
    const rules = [
      { id: 'deny-other-event', decision: 'deny', when: { event: 'session-end' } },
      { id: 'deny-other-harness', decision: 'deny', when: { harness: 'other' } },
      { id: 'deny-other-state', decision: 'deny', when: { event: 'session-start' }, requires: ['state'] },
      { id: 'explicit-verification', decision: 'allow', requires: ['verification'],
        when: { observation: 'verification', equals: true, truthy: 'verification' }, reason: 'explicit fresh evidence' },
    ];
    expect(OwnerConfigSchema.safeParse(ownerConfig(rules)).success).toBe(true);
    const config = ownerConfig(rules);
    const service = new RuntimeService({ state: store, content, config });
    const result = await service.execute(operation({ configRevision: config.revision }));
    expect(result.receipt?.gateVerdict).toBe('allow');
    // Supported scope conditions are genuinely evaluated: each deny is out of
    // scope (event/harness), so it must not downgrade the allow to indeterminate.
    const contributions = result.core!.policy.value.contributions;
    for (const id of ['deny-other-event', 'deny-other-harness', 'deny-other-state']) {
      expect(contributions.find(c => c.ruleId === id)?.matched).toBe(false);
    }
    // Default owner configuration is unchanged and still constructs.
    expect(OwnerConfigSchema.safeParse(DEFAULT_CONFIG).success).toBe(true);
  });
  test('rule inventory limits and duplicate ids still refuse', () => {
    expect(OwnerConfigSchema.safeParse(ownerConfig([{ id: 'dup', decision: 'deny' }, { id: 'dup', decision: 'allow' }])).success).toBe(false);
    expect(OwnerConfigSchema.safeParse(ownerConfig(Array.from({ length: 257 }, (_, i) => ({ id: `rule-${i}`, decision: 'deny' })))).success).toBe(false);
  });
  test('RuntimeService refuses an unsupported owner rule before any state is written', async () => {
    const { store, content } = await setup();
    expect(() => new RuntimeService({ state: store, content,
      config: ownerConfig([{ id: 'content-deny', decision: 'deny', contentIds: ['kernel-doc'] }]) })).toThrow(/contentIds/);
    expect(store.receipts('owner-1', 'session-1')).toEqual([]);
  });
  test('CLI owner config path refuses the same unsupported rule with exit 1', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'aos-owner-config-')); dirs.push(dir);
    writeFileSync(join(dir, 'owner.json'), JSON.stringify(ownerConfig([{ id: 'path-deny', decision: 'deny', when: { pathPrefix: 'src' } }])));
    const child = Bun.spawn([process.execPath, 'src/edges/cli.ts', 'gate', '--state', join(dir, 'state.sqlite'),
      '--content', resolve('content'), '--config', join(dir, 'owner.json')],
      { stdin: new TextEncoder().encode(JSON.stringify(operation())), stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code).toBe(1);
    const reported = JSON.parse(stdout) as { error?: { code?: string } };
    expect(reported.error?.code).toBe('runtime-unavailable');
    expect(stderr).toContain('AOS request failed');
  });
});

/**
 * `projectConfig` is per-operation data, but its digest is part of the session
 * pin. A session therefore keeps one stable owner+project configuration: a
 * mid-session variation refuses before replay instead of re-deciding.
 */
test('a session pins project configuration: mid-session variation refuses', async () => {
  const { service } = await setup();
  const first = await service.execute(operation());
  expect(first.status).toBe('complete');
  const varied = await service.execute(operation({ requestId: 'second', projectConfig: { totalByteBudget: 32768 } }));
  expect(varied.status).toBe('refused');
  expect(varied.reason).toBe('session generation/config skew');
  expect(varied.receipt).toBeNull();
  expect(await service.execute(operation())).toEqual(first);
});
