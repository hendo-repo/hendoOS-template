import { z } from 'zod';
import { relative, resolve, sep } from 'node:path';
import { AbsolutePathSchema, HOOK_OUTPUT_LIMIT } from './harness';
import { SourceRevisionSchema } from '../schema/operation';
import { digestOfJson, type Json } from './json';

export const CODEX_HARNESS_PROTOCOL = 'codex-pre-tool-use/1';
const Id = z.string().min(1).max(160).regex(/^[^\u0000-\u001f\u007f]+$/);
export const CodexHookConfigSchema = z.strictObject({
  version: z.literal(1), protocol: z.literal(CODEX_HARNESS_PROTOCOL), mode: z.enum(['shadow', 'enforce']).default('shadow'),
  workspaceRoot: AbsolutePathSchema, receiptRoot: AbsolutePathSchema, protectedPaths: z.array(AbsolutePathSchema).max(100),
  sourceRevision: SourceRevisionSchema,
}).superRefine((value, ctx) => {
  const root = resolve(value.workspaceRoot);
  for (const [index, path] of value.protectedPaths.entries()) {
    const rel = relative(root, resolve(path));
    if (rel === '..' || rel.startsWith('..' + sep)) ctx.addIssue({ code: 'custom', path: ['protectedPaths', index], message: 'protected path outside workspace' });
  }
  const receiptRel = relative(root, resolve(value.receiptRoot));
  if (receiptRel === '' || (!receiptRel.startsWith('..' + sep) && receiptRel !== '..')) ctx.addIssue({ code: 'custom', path: ['receiptRoot'], message: 'receipt root must be outside workspace' });
});
export type CodexHookConfig = z.infer<typeof CodexHookConfigSchema>;

export const CodexPreToolUseSchema = z.object({
  hook_event_name: z.literal('PreToolUse'), session_id: Id, turn_id: Id.optional(), tool_use_id: Id.optional(),
  transcript_path: z.string().max(8192).nullable().optional(), cwd: AbsolutePathSchema, model: z.string().max(160).optional(),
  permission_mode: z.string().max(64).optional(), tool_name: Id,
  tool_input: z.record(z.string(), z.unknown()),
});
export type CodexPreToolUse = z.infer<typeof CodexPreToolUseSchema>;

export type CodexObservation = { schema: 'hendoos.codex-observation/v1'; mode: 'shadow' | 'enforce';
  verdict: 'proceed' | 'deny' | 'indeterminate'; reason: string; tool: string; paths: string[];
  eventDigest: string; sourceRevision: string };

const patchHeader = /^\*\*\* (?:Add|Update|Delete) File:\s*(.+?)\s*$/gm;
const moveHeader = /^\*\*\* Move to:\s*(.+?)\s*$/gm;
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === '' || (rel !== '..' && !rel.startsWith('..' + sep)); };

export function observeCodexEvent(input: unknown, config: CodexHookConfig): CodexObservation {
  const event = CodexPreToolUseSchema.parse(input);
  const eventDigest = digestOfJson(event as unknown as Json);
  if (event.tool_name !== 'apply_patch') return { schema: 'hendoos.codex-observation/v1', mode: config.mode,
    verdict: 'indeterminate', reason: 'unsupported-tool-policy', tool: event.tool_name, paths: [], eventDigest, sourceRevision: config.sourceRevision };
  const command = event.tool_input.command;
  if (typeof command !== 'string' || Buffer.byteLength(command) > 256 * 1024) return { schema: 'hendoos.codex-observation/v1', mode: config.mode,
    verdict: 'indeterminate', reason: 'malformed-patch-input', tool: event.tool_name, paths: [], eventDigest, sourceRevision: config.sourceRevision };
  const names = [...command.matchAll(patchHeader), ...command.matchAll(moveHeader)].map(match => match[1]!.trim());
  if (!names.length) return { schema: 'hendoos.codex-observation/v1', mode: config.mode,
    verdict: 'indeterminate', reason: 'no-patch-targets', tool: event.tool_name, paths: [], eventDigest, sourceRevision: config.sourceRevision };
  const root = resolve(config.workspaceRoot), protectedSet = new Set(config.protectedPaths.map(path => resolve(path)));
  const resolved = names.map(name => resolve(event.cwd, name));
  const violation = resolved.some(path => !inside(root, path) || protectedSet.has(path));
  const paths = resolved.map(path => inside(root, path) ? relative(root, path).split(sep).join('/') || '.' : '<outside-workspace>');
  return { schema: 'hendoos.codex-observation/v1', mode: config.mode, verdict: violation ? 'deny' : 'proceed',
    reason: violation ? 'path-policy-violation' : 'supported-paths-within-workspace', tool: event.tool_name,
    paths: [...new Set(paths)].sort(), eventDigest, sourceRevision: config.sourceRevision };
}

export function codexHookReply(observation?: CodexObservation): { stdout: string; exitCode: number } {
  const report = observation ?? { schema: 'hendoos.codex-observation/v1', mode: 'shadow', verdict: 'indeterminate',
    reason: 'invalid-or-unavailable', tool: 'unknown', paths: [], eventDigest: 'unavailable', sourceRevision: 'unavailable' };
  const hookSpecificOutput: Record<string, unknown> = { hookEventName: 'PreToolUse',
    additionalContext: JSON.stringify(report) };
  if (observation?.mode === 'enforce' && observation.verdict === 'deny') {
    hookSpecificOutput.permissionDecision = 'deny';
    hookSpecificOutput.permissionDecisionReason = 'hendoOS path policy denied this tool call.';
  }
  const stdout = JSON.stringify({ hookSpecificOutput }) + '\n';
  if (Buffer.byteLength(stdout) > HOOK_OUTPUT_LIMIT) throw new Error('hook output limit');
  return { stdout, exitCode: observation ? 0 : 1 };
}

export function codexRegistration(command: string) {
  if (!command || /[\u0000-\u001f\u007f]/.test(command)) throw new Error('invalid hook command');
  return { description: 'hendoOS Codex path-policy adapter', hooks: { PreToolUse: [{ matcher: '^apply_patch$|^Bash$', hooks: [{
    type: 'command', command, timeout: 30, statusMessage: 'Checking hendoOS path policy', additionalContextLimit: 1200,
  }] }] } };
}
