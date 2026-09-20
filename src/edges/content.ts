/** Explicit starter-root loader. No ambient homes, recursive corpus discovery or symlinks. */
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildContentCorpus, evaluateMembership, type ContentDocument, type MembershipManifest } from '../schema/index';
import { MembershipManifestRuntimeSchema } from '../schema/runtime';
import { digestOfJson, type Json } from '../protocols/json';
export const MAX_SOURCE_BYTES = 262144;
export interface LoadedContent { generation: number; digest: string; documents: readonly ContentDocument[]; membership: MembershipManifest }
export async function readBoundedFile(path: string, max = MAX_SOURCE_BYTES): Promise<string> {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error('source is not a bounded regular file');
  const bytes = await readFile(path);
  if (bytes.byteLength > max) throw new Error('source byte limit exceeded');
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}
export async function loadContent(root: string): Promise<LoadedContent> {
  if (!root) throw new Error('explicit content root required');
  const base = resolve(root);
  if (await realpath(base) !== base) throw new Error('content root must not traverse symlinks');
  const membership = MembershipManifestRuntimeSchema.parse(JSON.parse(await readBoundedFile(join(base, 'membership.manifest.json'))));
  if (!membership.scenarios.length || membership.scenarios.length > 128 || new Set(membership.scenarios.map(s => s.id)).size !== membership.scenarios.length) throw new Error('invalid membership scenarios');
  const files: { path: string; text: string }[] = [];
  let bytes = 0;
  for (const tier of ['kernel', 'reference']) {
    const dir = join(base, tier);
    const stat = await lstat(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid starter tier directory');
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.length > 128) throw new Error('source count limit exceeded');
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isFile() || !/^[a-z0-9][a-z0-9._-]*\.md$/.test(entry.name)) throw new Error('starter sources must be regular markdown files');
      const text = await readBoundedFile(join(dir, entry.name));
      bytes += Buffer.byteLength(text);
      if (bytes > 1048576) throw new Error('corpus byte limit exceeded');
      files.push({ path: `content/${tier}/${entry.name}`, text });
    }
  }
  const corpus = buildContentCorpus(files);
  if (!corpus.ok || !corpus.value.documents.length) throw new Error('starter content invalid or empty');
  // Every scenario checks activated ids and the exact static prefix inventory.
  // Empty activation scenarios remain valid manifest controls, not successful
  // runtime queries.
  for (const scenario of membership.scenarios) {
    const evaluation = evaluateMembership({ ...membership, scenarios: [scenario] }, corpus.value.documents);
    const membershipMismatch = evaluation.errors.some(error => error.code === 'membership-mismatch');
    const expectedEmptyDegradation = scenario.expectedIds.length === 0 && evaluation.value.results[0]?.actualIds.length === 0;
    if (membershipMismatch || (!evaluation.ok && !expectedEmptyDegradation)) throw new Error('starter membership mismatch');
  }
  return { generation: membership.generation, documents: corpus.value.documents, membership,
    digest: digestOfJson({ membership, sources: corpus.value.documents.map(d => ({ id: d.id, digest: d.digest })) } as unknown as Json) };
}
