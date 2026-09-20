/** Native knowledge stays here. Contract: https://code.claude.com/docs/en/hooks
 * Retrieved 2026-09-19; PreToolUse command hooks only; no live certification. */
import { z } from 'zod';
import { isAbsolute } from 'node:path';
import { JsonValueSchema, TokenSchema } from './validation';
import { digestOfJson, type Json } from './json';
import { OperationSchema, OwnerConfigSchema, SourceRevisionSchema, type Operation } from '../schema/operation';
import type { RuntimeOutcome } from './service';

export const HARNESS_PROTOCOL = 'claude-code-pre-tool-use/1';
export const REGISTRATION_PATH = 'settings.json';
export const HOOK_OUTPUT_LIMIT = 16384;
/**
 * Non-blocking incomplete exit.
 *
 * The vendor's blocking exit `2` is deliberately never used: this adapter is a
 * read-only shadow observer, so no code path may change the outcome of the
 * action it observes. A failure before or during shadow evaluation is reported
 * as an honest incomplete diagnostic (stderr, plus an `indeterminate` report)
 * and the host proceeds exactly as if no hook had run. Exit `2` is reserved for
 * enforcement, which this adapter does not implement.
 */
export const FAILURE_EXIT = 1;
export const SHADOW_REPORT_SCHEMA = 'aos.shadow/v1';
const Id = TokenSchema.refine(x => x.length <= 128);
export const AbsolutePathSchema = z.string().min(1).refine(x => isAbsolute(x) &&
  !/[\u0000-\u001f\u007f]/.test(x) && !x.split('/').some(p => p === '.' || p === '..'));
const SyntheticObservationSchema = z.strictObject({
  key: Id, availability: z.enum(['available', 'unavailable']), freshness: z.enum(['fresh', 'stale', 'unknown']),
  completeness: z.enum(['complete', 'partial', 'unknown']), result: z.enum(['present', 'empty', 'no-work', 'unknown']),
  reasons: z.array(Id).max(8).default([]), value: JsonValueSchema.optional(),
}).superRefine((observation, ctx) => {
  const current = observation.availability === 'available' && observation.freshness === 'fresh' &&
    observation.completeness === 'complete' && observation.result === 'present';
  if (current && observation.value === undefined) ctx.addIssue({ code: 'custom', message: 'current complete observation requires value' });
  if (observation.result !== 'present' && observation.value !== undefined) ctx.addIssue({ code: 'custom', message: 'only present observations carry values' });
});
export const HookConfigSchema = z.strictObject({
  version: z.literal(1), protocol: z.literal(HARNESS_PROTOCOL),
  schemaVersion: z.literal(1), composeVersion: z.literal(1), contentGeneration: z.int().nonnegative(),
  ownerId: Id, configRevision: Id, checkerRevision: z.literal('aos-policy/1'), sourceRevision: SourceRevisionSchema,
  statePath: AbsolutePathSchema, contentRoot: AbsolutePathSchema,
  timeoutMs: z.int().min(1).max(30000),
  ownerPolicy: OwnerConfigSchema.optional(),
  syntheticObservations: z.array(SyntheticObservationSchema).max(256).default([]),
});
export type HookConfig = z.infer<typeof HookConfigSchema>;

// Additional native metadata is ignored. In particular it can never supply facts,
// owner configuration, evidence, runtime paths, or an operation envelope.
const NativeInput = z.object({
  hook_event_name: z.literal('PreToolUse'), session_id: Id,
  transcript_path: z.string().min(1).max(8192), cwd: AbsolutePathSchema,
  tool_name: z.enum(['Edit', 'Write']), tool_use_id: Id,
  tool_input: z.record(z.string(), JsonValueSchema),
});
export function nativeOperation(input: unknown, config: HookConfig): Operation {
  JsonValueSchema.parse(input);
  const event = NativeInput.parse(input);
  // A digest of untrusted context is an identity binding, never verified evidence.
  const subjectDigest = digestOfJson(event as unknown as Json);
  return OperationSchema.parse({
    version: 1, schemaVersion: config.schemaVersion, composeVersion: config.composeVersion,
    contentGeneration: config.contentGeneration, requestId: event.tool_use_id,
    sessionId: event.session_id, ownerId: config.ownerId, nonce: subjectDigest,
    command: 'gate', scenarioId: 'pre-edit-kernel-plus-declared-reference', subjectDigest,
    configRevision: config.configRevision, checkerRevision: config.checkerRevision, sourceRevision: config.sourceRevision,
    timeoutMs: config.timeoutMs, observations: config.syntheticObservations.map(o => ({ ...o,
      provenance: { kind: 'synthetic', source: 'explicit-hook-fixture', subjectDigest,
        configRevision: config.configRevision, checkerRevision: config.checkerRevision, sourceRevision: config.sourceRevision },
    })),
  });
}

/** The three shadow observations. None of them is a native permission decision. */
export type ShadowVerdict = 'would-allow' | 'would-deny' | 'indeterminate';

/**
 * Explicitly distinguishable shadow report carried in `additionalContext`.
 *
 * `would-allow` and `would-deny` describe what the *shadow policy engine*
 * would have decided for the supplied synthetic evidence; they are labels on an
 * observation, never an instruction to the host. `indeterminate` means the
 * shadow evaluation could not complete — malformed input, an invalid envelope,
 * a mismatched handshake, unavailable assets/state, a deadline, or a refused
 * runtime. Every failure is `indeterminate`: infrastructure failure is never
 * converted into a policy permission or a policy refusal.
 */
export interface ShadowReport {
  schema: typeof SHADOW_REPORT_SCHEMA;
  provisional: true; enforcement: false;
  /** The shadow verdict. A string label, never a native decision field. */
  verdict: ShadowVerdict;
  /** Always true: this adapter never decides, permits, or blocks the observed tool. */
  nonDisruptive: true;
  /** Machine-readable reason the verdict is `indeterminate`; absent otherwise. */
  incompleteReason?: string;
  /** Present only for a completed shadow evaluation. */
  evidence?: {
    requestId: string; requestDigest: string; subjectDigest: string; payloadHash: string;
    byteTiers: { kernel: number; reference: number; framework: number; total: number };
    /** False for a completed evaluation that stopped short of a verdict. */
    complete: boolean;
  };
  /** Composed shadow context, present only for a completed shadow evaluation. */
  composition?: string;
}

/**
 * Encode one shadow execution as a vendor-neutral, no-decision response.
 *
 * The returned object contains **no `permissionDecision`** field at all: the
 * host receives an `additionalContext` diagnostic and nothing that could be
 * read as `allow`, `deny`, `ask`, or a blocking exit status. The exit status is
 * `0` for a completed shadow evaluation and `1` when it could not complete —
 * the same non-blocking convention as the runtime CLI, where process status
 * reports execution failure and never the policy decision. The blocking exit
 * `2` is not produced by any path. A report that would exceed the hook output
 * limit is refused with an exception rather than truncated; the caller degrades
 * that to the same non-blocking incomplete exit.
 */
export function hookReply(result?: RuntimeOutcome): { stdout: string; exitCode: number } {
  const complete = result?.status === 'complete';
  let report: ShadowReport;
  if (complete && result.receipt) {
    // One decision engine: the verdict is the shared receipt's gate verdict.
    const engine = result.receipt.gateVerdict;
    report = { schema: SHADOW_REPORT_SCHEMA, provisional: true, enforcement: false, nonDisruptive: true,
      verdict: engine === 'allow' ? 'would-allow' : engine === 'deny' ? 'would-deny' : 'indeterminate',
      evidence: { requestId: result.receipt.requestId, requestDigest: result.receipt.requestDigest,
        subjectDigest: result.receipt.subjectDigest, payloadHash: result.receipt.payloadHash,
        byteTiers: result.receipt.byteTiers, complete: true },
      composition: result.core?.composition.value.payload.text };
  } else if (result?.receipt) {
    // A receipt exists but the run did not complete: still shadow-only, still no decision.
    report = { schema: SHADOW_REPORT_SCHEMA, provisional: true, enforcement: false, nonDisruptive: true,
      verdict: 'indeterminate', incompleteReason: result.reason ?? result.status,
      evidence: { requestId: result.receipt.requestId, requestDigest: result.receipt.requestDigest,
        subjectDigest: result.receipt.subjectDigest, payloadHash: result.receipt.payloadHash,
        byteTiers: result.receipt.byteTiers, complete: false } };
  } else {
    report = { schema: SHADOW_REPORT_SCHEMA, provisional: true, enforcement: false, nonDisruptive: true,
      verdict: 'indeterminate', incompleteReason: result?.reason ?? 'invalid-or-unavailable' };
  }
  const stdout = JSON.stringify({ hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    // Diagnostics only. `permissionDecision` is intentionally absent so the host
    // applies its own permission flow unchanged.
    additionalContext: JSON.stringify(report),
  } }) + '\n';
  if (Buffer.byteLength(stdout) > HOOK_OUTPUT_LIMIT) throw new Error('hook output limit');
  // Exit reports shadow execution only: 0 complete, 1 incomplete. Never the
  // vendor's blocking exit 2, which would change the host's decision.
  return { stdout, exitCode: complete ? 0 : FAILURE_EXIT };
}

export function registration(shimPath: string) {
  AbsolutePathSchema.parse(shimPath);
  // Native placeholders are expanded even in exec form; refuse ambiguity.
  if (shimPath.includes('${')) throw new Error('native path placeholder not supported');
  return { hooks: { PreToolUse: [{ matcher: 'Edit|Write', hooks: [{
    type: 'command', command: shimPath, args: [], timeout: 35,
  }] }] } };
}
