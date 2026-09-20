import { z } from 'zod';

export const REQUIRED_SPINE_SKILLS = Object.freeze(['session-agent', 'closeout', 'self-audit'] as const);
const skillName = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const relativePath = z.string().regex(/^(?![./]|.*(?:^|\/)\.\.?\/)(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/);
const upstream = z.strictObject({
  repository: z.string().url(), revision: z.string().regex(/^[0-9a-f]{40}$/),
  path: relativePath, license: z.literal('MIT'),
});
export const SkillRecordSchema = z.strictObject({
  name: skillName, version: z.string().regex(/^[1-9][0-9]*\.[0-9]+\.[0-9]+$/),
  source: z.literal('hendoos-canonical'), path: relativePath,
  files: z.array(relativePath).min(1), harnesses: z.array(z.enum(['codex', 'hermes'])).min(1), upstream,
});
export const SkillManifestSchema = z.strictObject({
  schema: z.literal('hendoos.skills/v1'), required: z.array(skillName).min(1),
  skills: z.array(SkillRecordSchema).min(1),
}).superRefine((value, ctx) => {
  const required = [...value.required].sort();
  const fixed = [...REQUIRED_SPINE_SKILLS].sort();
  if (JSON.stringify(required) !== JSON.stringify(fixed)) ctx.addIssue({ code: 'custom', message: 'required-set-mismatch' });
  const names = new Set<string>(), paths = new Set<string>();
  for (const [index, skill] of value.skills.entries()) {
    if (names.has(skill.name)) ctx.addIssue({ code: 'custom', path: ['skills', index, 'name'], message: 'duplicate-skill' });
    if (paths.has(skill.path)) ctx.addIssue({ code: 'custom', path: ['skills', index, 'path'], message: 'duplicate-path' });
    if (skill.path !== `skills/${skill.name}`) ctx.addIssue({ code: 'custom', path: ['skills', index, 'path'], message: 'noncanonical-path' });
    if (new Set(skill.files).size !== skill.files.length) ctx.addIssue({ code: 'custom', path: ['skills', index, 'files'], message: 'duplicate-file' });
    if (new Set(skill.harnesses).size !== skill.harnesses.length) ctx.addIssue({ code: 'custom', path: ['skills', index, 'harnesses'], message: 'duplicate-harness' });
    names.add(skill.name); paths.add(skill.path);
  }
  for (const name of value.required) if (!names.has(name)) ctx.addIssue({ code: 'custom', message: `missing-required:${name}` });
  for (const name of names) if (!value.required.includes(name)) ctx.addIssue({ code: 'custom', message: `unexpected-skill:${name}` });
});
export type SkillManifest = z.infer<typeof SkillManifestSchema>;

export const DiscoveryCandidateSchema = z.strictObject({
  name: skillName, source: z.enum(['canonical', 'repo', 'parent', 'user', 'app-managed']),
  path: z.string().min(1).max(4096), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/), trusted: z.boolean(),
});
export type DiscoveryCandidate = z.infer<typeof DiscoveryCandidateSchema>;
export type DiscoveryResult = { status: 'selected' | 'missing' | 'untrusted' | 'collision'; name: string;
  invocation: 'normal' | 'slash'; selected: DiscoveryCandidate | null; candidates: DiscoveryCandidate[] };

/** Fail visible on every shadowing/collision case; do not emulate a host's silent first-wins rule. */
export function resolveDiscovery(name: string, invocation: 'normal' | 'slash', input: unknown): DiscoveryResult {
  const candidates = z.array(DiscoveryCandidateSchema).parse(input).filter(candidate => candidate.name === name);
  if (!candidates.length) return { status: 'missing', name, invocation, selected: null, candidates };
  const trusted = candidates.filter(candidate => candidate.trusted);
  if (!trusted.length) return { status: 'untrusted', name, invocation, selected: null, candidates };
  const identities = new Set(trusted.map(candidate => `${candidate.source}\0${candidate.path}\0${candidate.digest}`));
  if (identities.size !== 1 || trusted.length !== 1) return { status: 'collision', name, invocation, selected: null, candidates };
  return { status: 'selected', name, invocation, selected: trusted[0]!, candidates };
}
