import { z } from 'zod';

const claim = z.enum(['verified', 'non-model-verified', 'unverified', 'unsupported']);
export const HarnessSurfaceMatrixSchema = z.strictObject({
  schema: z.literal('hendoos.harness-surface-matrix/v1'), reviewedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  rows: z.array(z.strictObject({ harness: z.enum(['claude', 'codex', 'hermes', 'cursor']), version: z.string().min(1),
    surface: z.enum(['cli-exec', 'interactive-tui', 'desktop', 'ide', 'headless-cli', 'child', 'cloud']),
    installation: claim, discovery: claim, instructionDelivery: claim, observation: claim, enforcement: claim,
    modelProof: z.boolean(), rationale: z.string().min(1).max(1000), evidence: z.array(z.string().min(1).max(1000)).max(20),
  })).min(1),
}).superRefine((value, ctx) => {
  const keys = new Set<string>(); value.rows.forEach((row, index) => { const key = `${row.harness}:${row.version}:${row.surface}`;
    if (keys.has(key)) ctx.addIssue({ code: 'custom', path: ['rows', index], message: 'duplicate surface row' }); keys.add(key); });
});
