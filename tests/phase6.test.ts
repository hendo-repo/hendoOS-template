import { describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { codexHookReply, CodexHookConfigSchema, observeCodexEvent } from '../src/protocols/codex-harness';
import { renderCodexHarness } from '../src/effects/codex-render';
import { install } from '../src/effects/install';
import { acceptHandoff } from '../src/effects/handoff';
import { digestOfString } from '../src/protocols/json';
import { HarnessSurfaceMatrixSchema } from '../src/schema/harness-proof';

const ROOT = join(import.meta.dir, '..'), temp = () => realpathSync(mkdtempSync(join(tmpdir(), 'hendoos-phase6-')));
const config = (workspaceRoot: string, receiptRoot: string, mode: 'shadow' | 'enforce' = 'shadow') => CodexHookConfigSchema.parse({
  version: 1, protocol: 'codex-pre-tool-use/1', mode, workspaceRoot, receiptRoot,
  protectedPaths: [join(workspaceRoot, 'protected.txt')], sourceRevision: 'a'.repeat(40),
});

describe('Phase 6 accepted-artifact handoff boundary', () => {
  const handoff = (status: string, digest: string) => ({ schema: 'hendoos.handoff/v1', id: 'handoff-1', parentId: 'parent-1',
    childId: 'child-1', status, owner: 'phase6-owner', summary: 'Produced the requested artifact.',
    artifact: status === 'complete' ? { path: 'artifact.txt', digest } : null, blockers: [], outOfScopePaths: [],
    evidence: ['fixture'], processes: [{ id: 'child-process', disposition: status === 'complete' ? 'exited' : 'terminated' }] });

  test('requires schema, exact artifact identity, ownership, and independent semantics', async () => {
    const root = temp(), body = 'EXPECTED=42\n'; writeFileSync(join(root, 'artifact.txt'), body);
    const accepted = await acceptHandoff(root, handoff('complete', digestOfString(body)), { expectedOwner: 'phase6-owner',
      verifyArtifact: value => value === body }) as any;
    expect(accepted.status).toBe('accepted');
    await expect(acceptHandoff(root, handoff('complete', 'sha256:' + 'f'.repeat(64)), { expectedOwner: 'phase6-owner', verifyArtifact: () => true }))
      .rejects.toMatchObject({ code: 'handoff-artifact-changed' });
    await expect(acceptHandoff(root, handoff('complete', digestOfString(body)), { expectedOwner: 'wrong', verifyArtifact: () => true }))
      .rejects.toMatchObject({ code: 'handoff-owner-mismatch' });
    await expect(acceptHandoff(root, handoff('complete', digestOfString(body)), { expectedOwner: 'phase6-owner', verifyArtifact: () => false }))
      .rejects.toMatchObject({ code: 'handoff-semantic-verification-failed' });
  });

  test('denial, stall, timeout, cancellation, and interruption remain explicit non-acceptance', async () => {
    const root = temp();
    for (const status of ['denied', 'stalled', 'timed-out', 'cancelled', 'parent-interrupted']) {
      await expect(acceptHandoff(root, handoff(status, 'sha256:' + 'a'.repeat(64)), { expectedOwner: 'phase6-owner', verifyArtifact: () => true }))
        .rejects.toMatchObject({ code: `handoff-${status}` });
    }
  });
});
const event = (workspace: string, command: string, tool = 'apply_patch') => ({ hook_event_name: 'PreToolUse', session_id: 'session-1',
  turn_id: 'turn-1', tool_use_id: 'tool-1', transcript_path: null, cwd: workspace, model: 'fixture', permission_mode: 'dontAsk',
  tool_name: tool, tool_input: { command } });

describe('Phase 6 Codex observation and opt-in enforcement', () => {
  test('surface claims are versioned and independently scoped', () => {
    const matrix = HarnessSurfaceMatrixSchema.parse(JSON.parse(readFileSync(join(ROOT, 'config/harness-surfaces.json'), 'utf8')));
    expect(matrix.rows.some(row => row.harness === 'codex' && row.version === '0.155.1' && row.surface === 'cli-exec')).toBe(true);
    expect(matrix.rows.find(row => row.harness === 'cursor' && row.surface === 'cloud')?.observation).toBe('unsupported');
  });
  test('shadow is byte-stable and never emits a native decision', () => {
    const workspace = temp(), receipts = temp(), cfg = config(workspace, receipts, 'shadow');
    const observed = observeCodexEvent(event(workspace, '*** Begin Patch\n*** Update File: protected.txt\n*** End Patch'), cfg);
    expect(observed.verdict).toBe('deny');
    const first = codexHookReply(observed), second = codexHookReply(observed);
    expect(first).toEqual(second); expect(first.exitCode).toBe(0); expect(first.stdout).not.toContain('permissionDecision');
  });

  test('enforcement denies only proven path violations; supported positive and indeterminate paths never grant allow', () => {
    const workspace = temp(), receipts = temp(), cfg = config(workspace, receipts, 'enforce');
    const denied = JSON.parse(codexHookReply(observeCodexEvent(event(workspace,
      '*** Begin Patch\n*** Update File: protected.txt\n*** End Patch'), cfg)).stdout);
    expect(denied.hookSpecificOutput.permissionDecision).toBe('deny');
    const proceed = JSON.parse(codexHookReply(observeCodexEvent(event(workspace,
      '*** Begin Patch\n*** Add File: allowed.txt\n*** End Patch'), cfg)).stdout);
    expect(proceed.hookSpecificOutput.permissionDecision).toBeUndefined();
    const indeterminate = JSON.parse(codexHookReply(observeCodexEvent(event(workspace, 'echo unsafe', 'Bash'), cfg)).stdout);
    expect(indeterminate.hookSpecificOutput.permissionDecision).toBeUndefined();
    expect(JSON.parse(indeterminate.hookSpecificOutput.additionalContext).verdict).toBe('indeterminate');
  });

  test.skipIf(process.platform === 'win32')('rendered owned hook records the actual inner handler and degrades without authorizing when assets disappear', async () => {
    const stage = temp(), target = temp(), workspace = temp(), receipts = temp();
    writeFileSync(join(workspace, 'protected.txt'), 'sentinel'); mkdirSync(join(workspace, '.git'));
    const rendered = await renderCodexHarness({ sourceRoot: ROOT, stageRoot: stage, targetRoot: target, bunPath: process.execPath,
      owner: 'phase6-test', generation: 1, config: config(workspace, receipts, 'enforce') });
    const report = await install({ sourceRoot: rendered.sourceRoot, stageRoot: rendered.stageRoot, targetRoot: rendered.targetRoot,
      owner: rendered.owner, manifest: rendered.manifest, modes: rendered.modes });
    expect(['installed', 'updated']).toContain(report.status);
    const run = (value: object) => Bun.spawnSync([rendered.shimPath], { cwd: workspace, env: { PATH: '' }, stdin: Buffer.from(JSON.stringify(value)), stdout: 'pipe', stderr: 'pipe' });
    const denied = run(event(workspace, '*** Begin Patch\n*** Update File: protected.txt\n*** End Patch'));
    expect(denied.exitCode).toBe(0); expect(JSON.parse(denied.stdout.toString()).hookSpecificOutput.permissionDecision).toBe('deny');
    const receipt = JSON.parse(readFileSync(join(receipts, readdirSync(receipts)[0]!), 'utf8'));
    expect(receipt.observation.tool).toBe('apply_patch'); expect(receipt.observation.verdict).toBe('deny');
    expect(readFileSync(join(workspace, 'protected.txt'), 'utf8')).toBe('sentinel');
    rmSync(join(target, 'hendoos-codex-hook/hook.js'));
    const failed = run(event(workspace, '*** Begin Patch\n*** Add File: allowed.txt\n*** End Patch'));
    expect(failed.exitCode).toBe(1); expect(failed.stdout.toString()).not.toContain('permissionDecision');
  });
});
