#!/usr/bin/env bun
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { REQUIRED_SPINE_SKILLS } from '../src/schema/skills';
import { renderSkills } from '../src/effects/skills';

const root = resolve(import.meta.dir, '..');
const binaries = {
  codex: process.env.HENDOOS_CODEX_BINARY,
  hermes: process.env.HENDOOS_HERMES_BINARY,
  hermesPython: process.env.HENDOOS_HERMES_PYTHON,
  hermesRoot: process.env.HENDOOS_HERMES_AGENT_ROOT,
};

function requireAbsolute(name: keyof typeof binaries): string {
  const value = binaries[name];
  if (!value || !value.startsWith('/')) throw new Error(`missing-absolute-${name}`);
  return value;
}

async function run(command: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const child = Bun.spawn(command, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (code !== 0) throw new Error(`subprocess-failed:${command[0]}:${code}:${stderr.slice(0, 1000)}`);
  return stdout;
}

async function codexSkills(binary: string, cwd: string): Promise<Array<{ name: string; path: string }>> {
  const child = Bun.spawn([binary, 'app-server', '--stdio'], { cwd, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const input = [
    { id: 1, method: 'initialize', params: { clientInfo: { name: 'hendoos-proof', version: '1' }, capabilities: {} } },
    { id: 2, method: 'skills/list', params: { cwds: [cwd], forceReload: true } },
  ].map(value => JSON.stringify(value)).join('\n') + '\n';
  child.stdin.write(input); await child.stdin.flush();
  const reader = child.stdout.getReader(), decoder = new TextDecoder();
  let buffer = '', result: any;
  const deadline = Date.now() + 15_000;
  while (!result && Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('codex-proof-timeout')), 15_000)),
    ]);
    if (next.done) break;
    buffer += decoder.decode(next.value, { stream: true });
    const lines = buffer.split('\n'); buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const value = JSON.parse(line);
      if (value.id === 2) result = value.result;
    }
  }
  child.kill(); await child.exited; reader.releaseLock();
  if (!result) throw new Error('codex-skills-list-missing');
  const rows = Array.isArray(result.data) ? result.data : Array.isArray(result.skills) ? result.skills : [];
  const skills = rows.flatMap((entry: any) => Array.isArray(entry.skills) ? entry.skills : [entry]);
  return skills.map((skill: any) => ({ name: String(skill.name), path: String(skill.path ?? skill.skillPath ?? '') }));
}

function exact(rows: Array<{ name: string; path: string }>, project: string): Array<{ name: string; path: string }> {
  const selected = rows.filter(row => (REQUIRED_SPINE_SKILLS as readonly string[]).includes(row.name));
  for (const name of REQUIRED_SPINE_SKILLS) {
    const matches = selected.filter(row => row.name === name && row.path === join(project, '.agents', 'skills', name, 'SKILL.md'));
    if (matches.length !== 1) throw new Error(`unexpected-discovery:${name}:${JSON.stringify(selected)}`);
  }
  return selected.sort((a, b) => a.name.localeCompare(b.name));
}

async function main(): Promise<void> {
  const codex = requireAbsolute('codex'), hermes = requireAbsolute('hermes');
  const hermesPython = requireAbsolute('hermesPython'), hermesRoot = requireAbsolute('hermesRoot');
  const scratch = await mkdtemp(join(tmpdir(), 'hendoos-skills-proof-'));
  let report: object | undefined;
  try {
    const project = join(scratch, 'project'), child = join(project, 'nested'), hermesHome = join(scratch, 'hermes-home');
    await mkdir(child, { recursive: true }); await run(['git', 'init', '-q'], project);
    await renderSkills(root, project, 'codex'); await renderSkills(root, project, 'hermes');
    const first = exact(await codexSkills(codex, child), project);
    const resumed = exact(await codexSkills(codex, child), project);
    if (JSON.stringify(first) !== JSON.stringify(resumed)) throw new Error('codex-resume-drift');

    const hermesEnv = { HERMES_HOME: hermesHome };
    const before = await run([hermes, 'skills', 'list', '--source', 'local'], project, hermesEnv);
    if (REQUIRED_SPINE_SKILLS.some(name => before.includes(name))) throw new Error('hermes-untrusted-loaded');
    await run([hermes, 'skills', 'trust', project], project, hermesEnv);
    const source = `import json\nfrom agent.skill_commands import scan_skill_commands, build_skill_invocation_message\n` +
      `cmds=scan_skill_commands()\nout={}\n` +
      `for n in ${JSON.stringify(REQUIRED_SPINE_SKILLS)}:\n k='/' + n\n v=cmds.get(k)\n out[n]={'path': v.get('skill_md_path') if v else None, 'loaded': bool(build_skill_invocation_message(k, 'proof'))}\n` +
      `print(json.dumps(out, sort_keys=True))\n`;
    const slash = JSON.parse(await run([hermesPython, '-c', source], project,
      { ...hermesEnv, PYTHONPATH: hermesRoot }));
    for (const name of REQUIRED_SPINE_SKILLS) {
      if (slash[name]?.path !== join(project, '.agents', 'skills', name, 'SKILL.md') || slash[name]?.loaded !== true) {
        throw new Error(`hermes-slash-selection:${name}`);
      }
    }
    const catalog = JSON.parse(await readFile(join(project, '.hendoos', 'skills-hermes.json'), 'utf8'));
    report = { schema: 'hendoos.harness-skill-proof/v1', status: 'complete',
      catalogDigest: catalog.catalogDigest, codex: { discovery: first, resumeStable: true },
      hermes: { untrustedExcluded: true, slash }, temporaryRootRemoved: true };
  } finally { await rm(scratch, { recursive: true, force: true }); }
  console.log(JSON.stringify(report));
}

await main();
