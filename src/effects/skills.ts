import { constants } from 'node:fs';
import { mkdir, open, readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { digestOfString } from '../protocols/json';
import { SkillManifestSchema, type DiscoveryCandidate, type SkillManifest } from '../schema/skills';

export class SkillError extends Error { constructor(readonly code: string) { super(code); } }
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel !== '' && !rel.startsWith('..' + sep) && rel !== '..' && !isAbsolute(rel); };

async function regular(path: string): Promise<void> {
  const info = await stat(path);
  if (!info.isFile() || info.size > 1024 * 1024) throw new SkillError('unsupported-skill-file');
}

export async function loadSkillManifest(root: string): Promise<SkillManifest> {
  const canonicalRoot = await realpath(root);
  const manifestPath = join(canonicalRoot, 'skills', 'manifest.json');
  await regular(manifestPath);
  let value: unknown;
  try { value = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { throw new SkillError('invalid-manifest-json'); }
  const parsed = SkillManifestSchema.safeParse(value);
  if (!parsed.success) throw new SkillError('invalid-skill-manifest');
  for (const skill of parsed.data.skills) {
    const packageRoot = resolve(canonicalRoot, skill.path);
    if (!inside(canonicalRoot, packageRoot)) throw new SkillError('noncanonical-path');
    for (const file of skill.files) {
      const path = resolve(packageRoot, file);
      if (!inside(packageRoot, path)) throw new SkillError('noncanonical-file');
      await regular(path);
    }
    const body = await readFile(join(packageRoot, 'SKILL.md'), 'utf8');
    const metadataText = body.replaceAll('\r\n', '\n');
    if (!metadataText.startsWith('---\n') || !metadataText.includes(`\nname: ${skill.name}\n`) || !metadataText.includes(`\nversion: ${skill.version}\n`)) {
      throw new SkillError('package-metadata-mismatch');
    }
  }
  return parsed.data;
}

export async function catalogSkills(root: string): Promise<{ schema: 'hendoos.skill-catalog/v1'; digest: string; skills: object[] }> {
  const manifest = await loadSkillManifest(root);
  const skills = [];
  for (const skill of manifest.skills) {
    const files = [];
    for (const file of skill.files) {
      const body = await readFile(join(root, skill.path, file), 'utf8');
      files.push({ path: file, digest: digestOfString(body), bytes: Buffer.byteLength(body) });
    }
    skills.push({ ...skill, files });
  }
  const digest = digestOfString(JSON.stringify(skills));
  return { schema: 'hendoos.skill-catalog/v1', digest, skills };
}

async function atomicReplace(path: string, body: string): Promise<void> {
  const parent = dirname(path); await mkdir(parent, { recursive: true });
  const temporary = join(parent, `.hendoos-${crypto.randomUUID()}.tmp`);
  const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await file.writeFile(body); await file.sync(); await rename(temporary, path); }
  finally { await file.close(); await rm(temporary, { force: true }); }
}

type SkillWrite = { output: string; relativePath: string; source: string; digest: string; body: string;
  base: 'absent' | 'owned'; baseDigest: string | null };
export type SkillPlan = { schema: 'hendoos.skill-plan/v1'; root: string; target: string; harness: 'codex' | 'hermes';
  catalogDigest: string; statePath: string; stateBase: string | null; writes: SkillWrite[];
  conflicts: Array<{ path: string; reason: string }>; retained: Array<{ path: string; reason: string }>;
  rendered: Array<{ name: string; path: string; digest: string }> };

async function optionalBody(path: string): Promise<string | null> {
  try { await regular(path); return await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}

/** Plan an ownership-aware render without mutating the target. */
export async function planSkills(root: string, target: string, harness: 'codex' | 'hermes'): Promise<SkillPlan> {
  const catalog = await catalogSkills(root);
  const destination = resolve(target, '.agents', 'skills');
  const targetRoot = resolve(target);
  if (!inside(targetRoot, destination)) throw new SkillError('invalid-target');
  const statePath = join(targetRoot, '.hendoos', `skills-${harness}.json`), stateBase = await optionalBody(statePath);
  let prior: { catalogDigest?: string; outputs?: Array<{ path: string; digest: string }>; rendered?: Array<{ path: string; digest: string }> } | null = null;
  if (stateBase !== null) {
    try { prior = JSON.parse(stateBase); } catch { throw new SkillError('invalid-skill-state'); }
    if (!prior || !Array.isArray(prior.outputs ?? prior.rendered)) throw new SkillError('invalid-skill-state');
  }
  const owned = new Map((prior?.outputs ?? prior?.rendered ?? []).map(value => [resolve(value.path), value.digest]));
  const peerOwned = new Map<string, string>();
  for (const peer of ['codex', 'hermes'] as const) if (peer !== harness) {
    const body = await optionalBody(join(targetRoot, '.hendoos', `skills-${peer}.json`));
    if (body !== null) try {
      const value = JSON.parse(body) as { outputs?: Array<{ path: string; digest: string }>; rendered?: Array<{ path: string; digest: string }> };
      for (const output of value.outputs ?? value.rendered ?? []) peerOwned.set(resolve(output.path), output.digest);
    } catch { /* an unrelated invalid peer record cannot grant ownership */ }
  }
  const rendered: SkillPlan['rendered'] = [], writes: SkillWrite[] = [], conflicts: SkillPlan['conflicts'] = [];
  const expected = new Set<string>();
  for (const record of catalog.skills as Array<{ name: string; path: string; harnesses: string[]; files: Array<{ path: string; digest: string }> }>) {
    if (!record.harnesses.includes(harness)) continue;
    for (const file of record.files) {
      const output = join(destination, record.name, file.path);
      const body = await readFile(join(root, record.path, file.path), 'utf8');
      expected.add(resolve(output));
      const current = await optionalBody(output), currentDigest = current === null ? null : digestOfString(current);
      const priorDigest = owned.get(resolve(output));
      const peerDigest = peerOwned.get(resolve(output));
      if (current !== null && (!priorDigest || currentDigest !== priorDigest) && (!peerDigest || currentDigest !== peerDigest || currentDigest !== file.digest)) conflicts.push({ path: output,
        reason: priorDigest || peerDigest ? 'edited-managed-skill' : 'unmanaged-name-collision' });
      writes.push({ output, relativePath: relative(targetRoot, output).split(sep).join('/'), source: join(root, record.path, file.path),
        digest: file.digest, body, base: current === null ? 'absent' : 'owned', baseDigest: currentDigest });
    }
    rendered.push({ name: record.name, path: join(destination, record.name, 'SKILL.md'), digest: record.files[0]!.digest });
  }
  const retained = [...owned.entries()].filter(([path]) => !expected.has(path)).map(([path]) => ({ path, reason: 'no-longer-expected-retained' }));
  return { schema: 'hendoos.skill-plan/v1', root: resolve(root), target: targetRoot, harness, catalogDigest: catalog.digest,
    statePath, stateBase, writes, conflicts, retained, rendered };
}

export async function applySkillPlan(plan: SkillPlan, options: { failAfterWrites?: number } = {}): Promise<object> {
  if (plan.conflicts.length) throw new SkillError('skill-render-conflict');
  if ((await catalogSkills(plan.root)).digest !== plan.catalogDigest) throw new SkillError('skill-source-changed');
  if (await optionalBody(plan.statePath) !== plan.stateBase) throw new SkillError('skill-target-changed');
  for (const write of plan.writes) {
    const current = await optionalBody(write.output), digest = current === null ? null : digestOfString(current);
    if (digest !== write.baseDigest) throw new SkillError('skill-target-changed');
  }
  const backups = new Map<string, string | null>(plan.writes.map(write => [write.output, null]));
  for (const write of plan.writes) backups.set(write.output, await optionalBody(write.output));
  const outputs = plan.writes.map(write => ({ path: write.output, relativePath: write.relativePath, digest: write.digest }));
  const state = JSON.stringify({ schema: 'hendoos.skill-render/v2', harness: plan.harness, catalogDigest: plan.catalogDigest,
    outputs, rendered: plan.rendered, retained: plan.retained }, null, 2) + '\n';
  let written = 0;
  try {
    for (const write of plan.writes) {
      await atomicReplace(write.output, write.body); written++;
      if (options.failAfterWrites === written) throw new SkillError('injected-skill-install-failure');
    }
    await atomicReplace(plan.statePath, state);
  } catch (error) {
    for (const [path, body] of [...backups.entries()].reverse()) {
      if (body === null) await rm(path, { force: true }); else await atomicReplace(path, body);
    }
    if (plan.stateBase === null) await rm(plan.statePath, { force: true }); else await atomicReplace(plan.statePath, plan.stateBase);
    throw error;
  }
  return { schema: 'hendoos.skill-render/v2', status: 'complete', harness: plan.harness,
    catalogDigest: plan.catalogDigest, rendered: plan.rendered, retained: plan.retained };
}

/** Ownership-aware plan/apply convenience for explicit project roots. */
export async function renderSkills(root: string, target: string, harness: 'codex' | 'hermes'): Promise<object> {
  return applySkillPlan(await planSkills(root, target, harness));
}

export async function candidate(path: string, name: string, source: DiscoveryCandidate['source'], trusted: boolean): Promise<DiscoveryCandidate> {
  await regular(path);
  const body = await readFile(path, 'utf8');
  return { name, source, path: resolve(path), digest: digestOfString(body), trusted };
}
