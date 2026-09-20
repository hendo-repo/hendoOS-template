import { lstat, readFile, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { digestOfString } from '../protocols/json';
import { HandoffSchema } from '../schema/handoff';

export class HandoffError extends Error { constructor(readonly code: string) { super(code); } }
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== '..' && !rel.startsWith('..' + sep); };

export async function acceptHandoff(root: string, input: unknown, options: {
  expectedOwner: string; verifyArtifact: (body: string) => boolean | Promise<boolean>;
}): Promise<object> {
  const handoff = HandoffSchema.parse(input);
  if (handoff.status !== 'complete') throw new HandoffError(`handoff-${handoff.status}`);
  if (handoff.owner !== options.expectedOwner) throw new HandoffError('handoff-owner-mismatch');
  const canonicalRoot = await realpath(root), artifact = resolve(canonicalRoot, handoff.artifact!.path);
  if (!inside(canonicalRoot, artifact)) throw new HandoffError('handoff-artifact-outside-root');
  const info = await lstat(artifact); if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new HandoffError('handoff-artifact-not-regular');
  const body = await readFile(artifact, 'utf8'); if (digestOfString(body) !== handoff.artifact!.digest) throw new HandoffError('handoff-artifact-changed');
  if (!await options.verifyArtifact(body)) throw new HandoffError('handoff-semantic-verification-failed');
  return { schema: 'hendoos.handoff-acceptance/v1', status: 'accepted', id: handoff.id, owner: handoff.owner,
    artifact: handoff.artifact, evidence: handoff.evidence, processDispositions: handoff.processes };
}
