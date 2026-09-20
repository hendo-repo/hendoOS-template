/**
 * Non-disruptive shadow contract for the native hook adapter.
 *
 * These tests assert the *distinguishable* shadow output and, above all, the
 * absence of native authority. They exercise the exact shim the generated
 * registration names, in disposable roots, and cover the three shadow cases:
 * would-allow, would-deny, and indeterminate (malformed input / failed runtime).
 *
 * Asserted on every case:
 *
 * - No `permissionDecision` or `permissionDecisionReason` field exists anywhere
 *   in the reply, so the host cannot read allow, deny or ask from this adapter.
 * - The exit status is never the vendor's blocking `2`: a completed shadow run
 *   exits `0`, a failed one exits `1` with a diagnostic on stderr.
 * - The report is explicit — `schema: aos.shadow/v1`, `provisional: true`,
 *   `enforcement: false`, `nonDisruptive: true` — and carries exactly one
 *   `verdict` of `would-allow` / `would-deny` / `indeterminate`.
 * - An infrastructure failure is `indeterminate`. It is never relabelled as a
 *   policy permission or as a policy refusal.
 */
import { afterEach, expect, test as bunTest } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HARNESS_PROTOCOL, hookReply } from '../src/protocols/harness';
import { renderHarness, type RenderOptions } from '../src/effects/render';
import { install } from '../src/effects/install';

// The native adapter renders a POSIX shim and is intentionally unsupported on Windows.
const test = process.platform === 'win32' ? bunTest.skip : bunTest;

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const sourceRoot = await realpath(resolve('.'));
const bunPath = await realpath(process.execPath);
const sourceRevision = 'a'.repeat(40);
const facts = [{ key: 'verification', availability: 'available' as const, freshness: 'fresh' as const,
  completeness: 'complete' as const, result: 'present' as const, reasons: [], value: true }];
const config: RenderOptions['config'] = { version: 1, protocol: HARNESS_PROTOCOL, schemaVersion: 1,
  composeVersion: 1, contentGeneration: 4, configRevision: 'aos-runtime-default/1',
  checkerRevision: 'aos-policy/1', sourceRevision, timeoutMs: 5000, syntheticObservations: facts };
const DENY_ALL = { version: 1 as const, revision: 'aos-runtime-default/1', checkerRevision: 'aos-policy/1' as const,
  totalByteBudget: 65536, gateFailure: 'closed' as const, rules: [{ id: 'deny-all', decision: 'deny' as const }] };
const event = { hook_event_name: 'PreToolUse', session_id: 'shadow-session', tool_use_id: 'shadow-call',
  transcript_path: '/unused/transcript.jsonl', cwd: '/unused/project', tool_name: 'Edit',
  tool_input: { file_path: '/unused/project/file.ts', old_string: 'old', new_string: 'new' } };
/** Render + install into disposable roots; return the exact registered command. */
async function delivered(overrides: Partial<RenderOptions['config']> = {}) {
  const base = await mkdtemp(join(await realpath(tmpdir()), 'aos-shadow-'));
  roots.push(base);
  const stageRoot = join(base, 'stage'); const targetRoot = join(base, 'home'); const stateRoot = join(base, 'state');
  await Promise.all([mkdir(stageRoot), mkdir(targetRoot), mkdir(stateRoot)]);
  const rendered = await renderHarness({ sourceRoot, stageRoot, targetRoot, statePath: join(stateRoot, 'runtime.sqlite'),
    bunPath, owner: 'shadow-owner', generation: 1, config: { ...config, ...overrides } });
  const installed = await install({ sourceRoot, stageRoot: rendered.stageRoot, targetRoot: rendered.targetRoot,
    owner: rendered.owner, manifest: rendered.manifest, modes: rendered.modes });
  expect(installed.status).toBe('installed');
  const settings = JSON.parse(await Bun.file(join(targetRoot, 'settings.json')).text());
  const handler = settings.hooks.PreToolUse[0].hooks[0];
  expect(handler.args).toEqual([]); expect(handler.command).toBe(rendered.shimPath);
  return { base, shimPath: rendered.shimPath, command: [handler.command, ...handler.args] as string[] };
}
async function run(command: string[], text: string, cwd: string) {
  const child = Bun.spawn(command, { cwd, env: { PATH: '', HOME: cwd },
    stdin: new TextEncoder().encode(text), stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill(), 10000);
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    return { stdout, stderr, code };
  } finally { clearTimeout(timer); }
}
/** Parse, then assert the non-authorizing surface on the raw bytes and the report. */
function report(result: Awaited<ReturnType<typeof run>>) {
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  expect(output.hookEventName).toBe('PreToolUse');
  expect(Object.keys(output).sort()).toEqual(['additionalContext', 'hookEventName']);
  expect(output.permissionDecision).toBeUndefined();
  expect(output.permissionDecisionReason).toBeUndefined();
  expect(result.stdout).not.toContain('permissionDecision');
  expect(result.code).not.toBe(2);
  expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(16384);
  const parsed = JSON.parse(output.additionalContext);
  expect(parsed.schema).toBe('aos.shadow/v1');
  expect(parsed.provisional).toBe(true);
  expect(parsed.enforcement).toBe(false);
  expect(parsed.nonDisruptive).toBe(true);
  expect(['would-allow', 'would-deny', 'indeterminate']).toContain(parsed.verdict);
  return parsed;
}
test('would-allow shadow case: distinguishable verdict, no native permit, exit 0', async () => {
  const f = await delivered();
  const result = await run(f.command, JSON.stringify(event), f.base);
  const parsed = report(result);
  expect(parsed.verdict).toBe('would-allow'); expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(parsed.evidence.complete).toBe(true);
  expect(parsed.evidence.byteTiers.total).toBeGreaterThan(0);
  expect(typeof parsed.composition).toBe('string');
  // `would-allow` is an observation label, not authorization: the receipt that
  // produced it is still provisional with enforcement off.
  expect(parsed.evidence.requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
});
test('would-deny shadow case: distinguishable verdict, still no native denial of the tool', async () => {
  const f = await delivered({ ownerPolicy: DENY_ALL });
  const result = await run(f.command, JSON.stringify(event), f.base);
  const parsed = report(result);
  expect(parsed.verdict).toBe('would-deny'); expect(result.code).toBe(0);
  expect(result.stderr).toBe('');
  expect(parsed).not.toHaveProperty('incompleteReason');
});
test('failed runtime shadow case: indeterminate with honest diagnostics, never a permit', async () => {
  const f = await delivered();
  // Corrupt the shadow runtime bundle: the startup boundary reports, never permits.
  await writeFile(join(f.shimPath, '..', 'hook.js'), 'this is invalid javascript !!!');
  const result = await run([f.shimPath], JSON.stringify(event), f.base);
  const parsed = report(result);
  expect(parsed.verdict).toBe('indeterminate'); expect(result.code).toBe(1);
  expect(result.stderr).not.toBe('');
  expect(parsed).not.toHaveProperty('evidence');
  expect(parsed).not.toHaveProperty('composition');
});
test('malformed events report indeterminate diagnostics and never a blocking status', async () => {
  const f = await delivered();
  for (const text of ['{', '{}\n{}\n', '', JSON.stringify({ ...event, tool_name: 'Bash' })]) {
    const result = await run(f.command, text, f.base);
    expect(report(result).verdict).toBe('indeterminate');
    expect(result.code).toBe(1); expect(result.stderr).not.toBe('');
  }
});
test('incomplete shadow evidence is indeterminate, never inferred permission either way', async () => {
  const f = await delivered({ syntheticObservations: [] });
  const result = await run(f.command, JSON.stringify(event), f.base);
  const parsed = report(result);
  expect(parsed.verdict).toBe('indeterminate'); expect(result.code).toBe(1);
  expect(parsed.incompleteReason).toBe('observations or policy incomplete');
  // A receipt exists, and it is explicitly marked as not reaching a verdict.
  expect(parsed.evidence.complete).toBe(false);
  expect(parsed).not.toHaveProperty('composition');
});
test('in-process encoding assigns zero native authority to a synthetic allow or an absent runtime', () => {
  const receipt = { version: 1 as const, requestId: 'r', sessionId: 's', ownerId: 'o', nonce: 'n',
    requestDigest: 'sha256:' + 'a'.repeat(64), payloadHash: 'sha256:' + 'b'.repeat(64), schemaVersion: 1 as const,
    composeVersion: 1 as const, contentGeneration: 4, contentDigest: 'sha256:' + 'c'.repeat(64),
    subjectDigest: 'sha256:' + 'd'.repeat(64), configRevision: 'aos-runtime-default/1',
    configDigest: 'sha256:' + 'e'.repeat(64), checkerRevision: 'aos-policy/1' as const,
    sourceRevision,
    timestamp: '2026-01-01T00:00:00.000Z', byteTiers: { kernel: 0, reference: 0, framework: 0, total: 0 },
    gateVerdict: 'allow' as const, provisional: true as const,
    trace: { command: 'gate' as const, scenarioId: 'pre-edit-kernel-plus-declared-reference', outcomeStatus: 'complete' as const,
      reason: null, compositionCodes: [], policyDecision: 'allow' as const, allowedBy: [], deniedBy: [], indeterminateBy: [], observations: [] } };
  const complete = hookReply({ status: 'complete', provisional: true, enforcement: false, reason: null,
    observations: [], core: null, receipt });
  expect(complete.exitCode).toBe(0);
  const allow = JSON.parse(complete.stdout).hookSpecificOutput;
  expect(allow.permissionDecision).toBeUndefined();
  expect(JSON.parse(allow.additionalContext).verdict).toBe('would-allow');
  const failed = hookReply();
  expect(failed.exitCode).toBe(1);
  expect(failed.exitCode).not.toBe(2);
  const failedOutput = JSON.parse(failed.stdout).hookSpecificOutput;
  expect(failedOutput.permissionDecision).toBeUndefined();
  const failedReport = JSON.parse(failedOutput.additionalContext);
  expect(failedReport.verdict).toBe('indeterminate');
  expect(failedReport.incompleteReason).toBe('invalid-or-unavailable');
});
