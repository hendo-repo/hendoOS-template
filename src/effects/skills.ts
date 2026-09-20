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

/** Render into an explicit disposable/install staging root; never discovers or mutates a home. */
export async function renderSkills(root: string, target: string, harness: 'codex' | 'hermes'): Promise<object> {
  const catalog = await catalogSkills(root);
  const destination = resolve(target, '.agents', 'skills');
  const targetRoot = resolve(target);
  if (!inside(targetRoot, destination)) throw new SkillError('invalid-target');
  const rendered: { name: string; path: string; digest: string }[] = [];
  for (const record of catalog.skills as Array<{ name: string; path: string; harnesses: string[]; files: Array<{ path: string; digest: string }> }>) {
    if (!record.harnesses.includes(harness)) continue;
    for (const file of record.files) {
      const output = join(destination, record.name, file.path);
      await mkdir(dirname(output), { recursive: true });
      const body = await readFile(join(root, record.path, file.path), 'utf8');
      await atomicReplace(output, body);
    }
    rendered.push({ name: record.name, path: join(destination, record.name, 'SKILL.md'), digest: record.files[0]!.digest });
  }
  await atomicReplace(join(targetRoot, '.hendoos', `skills-${harness}.json`), JSON.stringify({
    schema: 'hendoos.skill-render/v1', harness, catalogDigest: catalog.digest, rendered,
  }, null, 2) + '\n');
  return { harness, catalogDigest: catalog.digest, rendered };
}

export async function candidate(path: string, name: string, source: DiscoveryCandidate['source'], trusted: boolean): Promise<DiscoveryCandidate> {
  await regular(path);
  const body = await readFile(path, 'utf8');
  return { name, source, path: resolve(path), digest: digestOfString(body), trusted };
}
