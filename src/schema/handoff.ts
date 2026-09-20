import { z } from 'zod';

const token = z.string().min(1).max(160);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const path = z.string().min(1).max(4096).refine(value => !value.startsWith('/') && !value.startsWith('~') && !value.split('/').includes('..'));
export const HandoffSchema = z.strictObject({
  schema: z.literal('hendoos.handoff/v1'), id: token, parentId: token, childId: token,
  status: z.enum(['complete', 'incomplete', 'blocked', 'denied', 'stalled', 'timed-out', 'cancelled', 'parent-interrupted']),
  owner: token, summary: z.string().min(1).max(4000), artifact: z.strictObject({ path, digest }).nullable(),
  blockers: z.array(z.string().min(1).max(1000)).max(50), outOfScopePaths: z.array(path).max(100),
  evidence: z.array(z.string().min(1).max(1000)).max(100),
  processes: z.array(z.strictObject({ id: token, disposition: z.enum(['none', 'exited', 'terminated', 'surviving-owned', 'surviving-external']) })).max(100),
}).superRefine((value, ctx) => {
  if (value.status === 'complete' && (!value.artifact || value.blockers.length || value.outOfScopePaths.length))
    ctx.addIssue({ code: 'custom', message: 'complete handoff requires one artifact and no blockers or out-of-scope edits' });
  if (value.processes.some(process => process.disposition === 'surviving-owned') && value.status === 'complete')
    ctx.addIssue({ code: 'custom', message: 'owned surviving process prevents completion' });
});
export type Handoff = z.infer<typeof HandoffSchema>;
