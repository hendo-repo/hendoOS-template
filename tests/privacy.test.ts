import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { scanPublicRepo, runCli, RULES, ENV_VARS, enumeratePublishCandidates, gitEnv } from '../scripts/check-public.ts';
import { scanArchitecture, runArchitectureCli, ARCH_RULES } from '../scripts/check-architecture.ts';

const roots: string[] = [];
const env = gitEnv(process.env);
const workspace = resolve(import.meta.dir, '..');
function git(root: string, ...args: string[]) {
  const result = Bun.spawnSync(['git', '-C', root, ...args], { env, stdout: 'pipe', stderr: 'pipe' });
  if (!result.success) throw Error('fixture git failed: ' + result.stderr.toString());
  return result.stdout.toString().trim();
}
function temp() { const root = mkdtempSync(join(tmpdir(), 'aos-gate-')); roots.push(root); return root; }
function repo() { const root = temp(); git(root, 'init', '-q'); return root; }
function put(root: string, path: string, text: string | Uint8Array) {
  mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text);
}
function privacy(root: string) { return scanPublicRepo({ root, env }); }
function rules(report: { findings: { ruleId: string }[]; errors: { ruleId: string }[] }) {
  return [...report.findings, ...report.errors].map(f => f.ruleId);
}
const home = () => '/' + ['Us', 'ers'].join('') + '/' + crypto.randomUUID() + '/private';
const email = () => crypto.randomUUID() + '@' + 'fixture.invalid';
const key = () => ['gh', 'p_'].join('') + 'X'.repeat(36);
const tracker = () => ['SYN', 'TH'].join('');
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('public gate, real Git/filesystem controls', () => {
  test('clean unborn repository has coverage and explicitly unverified metadata', () => {
    const root = repo(); put(root, 'README.md', 'Public project guidance.\n');
    const report = privacy(root);
    expect(report.result).toBe('pass'); expect(report.stats.scanned).toBe(1);
    expect(report.history.state).toBe('unborn'); expect(report.history.commits).toBe(0);
    expect(report.notices.join(' ')).toContain('not been checked');
  });
  test('scanner, tests and entrypoints pass their own policy without exemptions', () => {
    const root = repo();
    for (const path of ['scripts/check-public.ts', 'scripts/check-architecture.ts', 'tests/privacy.test.ts', 'AGENTS.md', 'CLAUDE.md', '.gitignore']) {
      put(root, path, readFileSync(join(workspace, path)));
    }
    const report = privacy(root);
    expect(report.findings).toEqual([]); expect(report.errors).toEqual([]);
    expect(report.stats.scanned).toBe(6); expect(report.result).toBe('pass');
  });
  test.each([
    ['home', home, RULES.HOME_PATH],
    ['windows home', () => 'C:\\' + ['Us', 'ers'].join('') + '\\' + crypto.randomUUID(), RULES.HOME_PATH],
    ['email', email, RULES.EMAIL], ['credential', key, RULES.CRED_GITHUB_TOKEN],
    ['pem', () => ['-----BEGIN ', 'PRIVATE', ' KEY-----'].join(''), RULES.CRED_PRIVATE_KEY],
  ])('rejects synthetic %s in docs and tests', (_name, token, rule) => {
    const root = repo();
    const value = (token as () => string)();
    put(root, 'docs/note.md', value); put(root, 'tests/fixture.txt', value);
    const report = privacy(root);
    expect(report.result).toBe('fail');
    expect(report.findings.filter(f => f.ruleId === rule).map(f => f.path).sort()).toEqual(['docs/note.md', 'tests/fixture.txt']);
    expect(JSON.stringify(report)).not.toContain(value);
  });
  test('parent environment literals and prefixes add strictness without exposing content', () => {
    const root = repo(); const token = crypto.randomUUID(); const prefix = tracker();
    put(root, 'README.md', token + '\n' + prefix + '-12345678');
    const result = runCli(['--root', root, '--json'], { ...env,
      [ENV_VARS.PRIVATE_TOKENS]: 'identity=' + token,
      [ENV_VARS.TRACKER_PREFIXES]: prefix });
    expect(result.code).toBe(1); expect(rules(result.report!)).toContain(RULES.PRIVATE_TOKEN);
    expect(rules(result.report!)).toContain(RULES.TRACKER_REF); expect(result.stdout).not.toContain(token);
  });
  test('configured private identities catch separator variants and trackers use the shared exact grammar', () => {
    const root = repo();
    const identity = 'Private' + crypto.randomUUID().replaceAll('-', '') + 'Identity';
    const tracker = 'FixturePrivate';
    const splitIdentity = identity.replace(/([a-z0-9])([A-Z])/g, '$1/$2').toLowerCase();
    put(root, 'docs/' + splitIdentity + '.md', 'reference ' + tracker.toLowerCase() + '-42');
    const report = scanPublicRepo({ root, env, privateTokens: [identity], trackerPrefixes: [tracker] });
    expect(rules(report)).toContain(RULES.PATH_PRIVATE_TOKEN);
    expect(rules(report)).toContain(RULES.TRACKER_REF);
    expect(JSON.stringify(report)).not.toContain(identity);
  });
  // Win32 forbids control characters in file names, so this real-filesystem
  // regression can only be constructed on POSIX. The scanner itself remains
  // enabled on Windows for every representable path.
  test.skipIf(process.platform === 'win32')('detects private file names and newline paths with NUL enumeration', () => {
    const root = repo(); const token = crypto.randomUUID(); const name = 'docs/' + token + '\nfile.md';
    put(root, name, 'Public text');
    expect(enumeratePublishCandidates(root, env).paths).toContain(name);
    expect(rules(scanPublicRepo({ root, env, privateTokens: [token] }))).toContain(RULES.PATH_PRIVATE_TOKEN);
  });
  test('zero files and invalid work trees fail closed', () => {
    expect(rules(privacy(repo()))).toContain(RULES.ZERO_COVERAGE);
    expect(runCli(['--root', temp()], env).code).toBe(2);
  });
  test('a corrupt index makes enumeration fail, not pass', () => {
    const root = repo(); put(root, 'README.md', 'Public'); put(root, '.git/index', 'broken index');
    const report = privacy(root);
    expect(report.result).toBe('fail'); expect(report.fatal).toBe(true);
    expect(rules(report)).toContain(RULES.ENUMERATION);
  });
  test('tracked files still scan when ignored; ignored docs and tests cannot evade scanning', () => {
    const root = repo(); put(root, 'tracked.txt', home()); git(root, 'add', 'tracked.txt');
    put(root, '.gitignore', 'tracked.txt\ndocs/\ntests/\n');
    put(root, 'docs/note.md', key()); put(root, 'tests/fixture.ts', email());
    const report = privacy(root);
    expect(report.stats.scanned).toBe(4);
    expect(rules(report)).toContain(RULES.HOME_PATH);
    expect(rules(report)).toContain(RULES.CRED_GITHUB_TOKEN);
    expect(rules(report)).toContain(RULES.EMAIL);
    expect(rules(report)).toContain(RULES.IGNORE_DOC_EXEMPT);
  });
  test('ambient Git redirection and global exclusions cannot hide candidates', () => {
    const root = repo(); const other = repo(); const config = temp();
    put(root, 'README.md', home()); put(config, 'exclude', '*.md\n');
    put(config, 'config', '[core]\nexcludesFile = ' + join(config, 'exclude') + '\n');
    const report = scanPublicRepo({ root, env: { ...env, GIT_DIR: join(other, '.git'),
      GIT_CONFIG_GLOBAL: join(config, 'config'), GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'core.excludesFile', GIT_CONFIG_VALUE_0: join(config, 'exclude') } });
    expect(rules(report)).toContain(RULES.HOME_PATH);
  });
  test('rejects unreadable coverage: deleted tracked files, symlinks and invalid text', () => {
    const root = repo(); put(root, 'gone.txt', 'Public'); git(root, 'add', 'gone.txt'); rmSync(join(root, 'gone.txt'));
    put(root, 'binary.dat', new Uint8Array([0, 255])); put(root, 'wide.txt', new Uint8Array([255, 254, 65, 0]));
    symlinkSync('gone.txt', join(root, 'link'));
    const report = privacy(root);
    for (const rule of [RULES.UNREADABLE, RULES.BINARY, RULES.UTF16, RULES.SYMLINK]) expect(rules(report)).toContain(rule);
    expect(report.result).toBe('fail');
  });
  test('a zero finding cap cannot suppress matches', () => {
    const root = repo(); put(root, 'README.md', key());
    expect(scanPublicRepo({ root, env, maxFindingsPerRulePerFile: 0 }).result).toBe('fail');
  });
  test('broken HEAD is unavailable, not unborn', () => {
    const root = repo(); put(root, 'README.md', 'Public'); put(root, '.git/HEAD', 'f'.repeat(40) + '\n');
    const report = privacy(root);
    expect(report.history.state).toBe('unavailable'); expect(rules(report)).toContain(RULES.HISTORY);
  });
  test('commit identity and message are scanned using synthetic Git objects', () => {
    const root = repo(); put(root, 'README.md', 'Public');
    const identity = email(); const privateText = crypto.randomUUID(); const prefix = tracker();
    // Build fixture objects only; never commit or update this workspace.
    const tree = git(root, 'mktree');
    const body = `tree ${tree}\nauthor Fixture <${identity}> 1 +0000\ncommitter Fixture <${identity}> 1 +0000\n\n${privateText}\n${prefix}-42\n`;
    const object = Bun.spawnSync(['git', '-C', root, 'hash-object', '-t', 'commit', '-w', '--stdin'], { env, stdin: Buffer.from(body) });
    expect(object.exitCode).toBe(0);
    git(root, 'update-ref', 'HEAD', object.stdout.toString().trim());
    const report = scanPublicRepo({ root, env, privateTokens: [privateText], trackerPrefixes: [prefix] });
    expect(report.history.state).toBe('scanned'); expect(report.history.commits).toBe(1);
    expect(report.findings.some(f => f.scope === 'commit-identity' && f.ruleId === RULES.EMAIL)).toBe(true);
    expect(report.findings.some(f => f.scope === 'commit-message' && f.ruleId === RULES.PRIVATE_TOKEN)).toBe(true);
    expect(rules(report)).toContain(RULES.TRACKER_REF);
    expect(JSON.stringify(report)).not.toContain(identity);
    // An unborn branch must still scan other refs.
    git(root, 'branch', 'fixture-history'); git(root, 'symbolic-ref', 'HEAD', 'refs/heads/new-branch');
    expect(scanPublicRepo({ root, env }).history.commits).toBe(1);
  });
  test('tree-only source validation explicitly skips history without weakening file scans', () => {
    const root = repo(); const identity = email();
    put(root, 'README.md', 'Public project guidance.\n');
    git(root, 'add', 'README.md');
    git(root, '-c', 'user.name=Fixture', '-c', `user.email=${identity}`, 'commit', '-qm', 'fixture');
    const full = scanPublicRepo({ root, env });
    expect(full.history.state).toBe('scanned');
    expect(rules(full)).toContain(RULES.EMAIL);
    put(root, 'docs/note.md', key());
    const treeOnly = scanPublicRepo({ root, env, skipHistory: true });
    expect(treeOnly.history).toEqual({ state: 'skipped', commits: 0 });
    expect(rules(treeOnly)).not.toContain(RULES.EMAIL);
    expect(rules(treeOnly)).toContain(RULES.CRED_GITHUB_TOKEN);
  });
});

describe('architecture gate', () => {
  test('pure primitives and benign directory names are allowed', () => {
    const root = repo();
    put(root, 'src/compose/index.ts', "import { x } from '../protocols/json'; import { y } from '../state/value'; export const z = x + y;");
    put(root, 'src/protocols/json.ts', "export const x = new Bun.CryptoHasher('sha256').update('x').digest('hex');");
    put(root, 'src/state/value.ts', 'export const y = 1;');
    expect(scanArchitecture({ root, env }).result).toBe('pass');
  });
  test('comments, types, and literal examples do not count as ambient operations', () => {
    const root = repo();
    put(root, 'src/compose/index.ts', '// Date.now() fetch()\nimport type { Stats } from "node:fs";\nexport const help = "Bun.file() Math.random()";');
    expect(scanArchitecture({ root, env }).result).toBe('pass');
  });
  test.each([
    ['filesystem', 'import { readFileSync } from "node:fs";', ARCH_RULES.PURE_IMPORT],
    ['bare filesystem', 'import "fs";', ARCH_RULES.PURE_IMPORT],
    ['dynamic import', 'import("node:fs");', ARCH_RULES.PURE_IMPORT],
    ['clock', 'export const x = Date.now();', ARCH_RULES.PURE_AMBIENT],
    ['random', 'export const x = Math.random();', ARCH_RULES.PURE_AMBIENT],
    ['crypto', 'export const x = crypto.randomUUID();', ARCH_RULES.PURE_AMBIENT],
    ['network', 'fetch("https://fixture.invalid");', ARCH_RULES.PURE_AMBIENT],
    ['Bun IO', 'Bun.file("input.txt");', ARCH_RULES.PURE_AMBIENT],
    ['computed member', 'globalThis["fetch"]("https://fixture.invalid");', ARCH_RULES.PURE_AMBIENT],
    ['subprocess', 'import "node:child_process";', ARCH_RULES.SUBPROCESS_MODULE],
    ['shell', 'Bun.$`echo example`;', ARCH_RULES.SHELL_DOLLAR],
    ['shell alias', 'import { $ as shell } from "bun";', ARCH_RULES.SHELL_DOLLAR],
    ['runtime', 'Bun.spawn(["python3", "task.py"]);', ARCH_RULES.SUBPROCESS_LANG],
    ['vendor sdk', 'import Client from "openai";', ARCH_RULES.VENDOR_IMPORT],
    ['vendor url', 'export const url = "https://api.openai.com/v1";', ARCH_RULES.VENDOR_LITERAL],
  ])('rejects %s', (_name, text, rule) => {
    const root = repo(); put(root, 'src/policy/index.ts', text);
    expect(rules(scanArchitecture({ root, env }))).toContain(rule);
  });
  test('follows relative helpers so renaming an effect module cannot hide it', () => {
    const root = repo(); put(root, 'src/compose/index.ts', 'export { x } from "../protocols/text";');
    put(root, 'src/protocols/text.ts', 'export const x = Date.now();');
    expect(rules(scanArchitecture({ root, env }))).toContain(ARCH_RULES.PURE_AMBIENT);
  });
  test('vendor SDK and IO at the protocol edge; schema libraries are allowed', () => {
    const root = repo(); put(root, 'src/protocols/client.ts', 'import Client from "openai"; import "node:fs";');
    put(root, 'src/schema/content.ts', 'import { z } from "zod";');
    expect(scanArchitecture({ root, env }).result).toBe('pass');
  });
  test('empty source coverage, corrupt enumeration, invalid syntax and symlinks fail closed', () => {
    const root = repo(); put(root, 'README.md', 'Public');
    expect(rules(scanArchitecture({ root, env }))).toContain(ARCH_RULES.ZERO_COVERAGE);
    put(root, 'src/compose/index.ts', 'export const = ;');
    expect(rules(scanArchitecture({ root, env }))).toContain(ARCH_RULES.SOURCE);
    put(root, '.git/index', 'broken index');
    expect(rules(scanArchitecture({ root, env }))).toContain(ARCH_RULES.ENUMERATION);
    rmSync(join(root, '.git/index')); rmSync(join(root, 'src/compose/index.ts'));
    symlinkSync('../../README.md', join(root, 'src/compose/index.ts'));
    expect(rules(scanArchitecture({ root, env }))).toContain(ARCH_RULES.SOURCE);
  });
});

test('both real CLI help commands work and missing values return usage errors', () => {
  for (const script of ['check-public', 'check-architecture']) {
    const result = Bun.spawnSync([process.execPath, 'scripts/' + script + '.ts', '--help'], { cwd: workspace, env });
    expect(result.exitCode).toBe(0); expect(result.stdout.toString()).toContain('usage:');
  }
  expect(runCli(['--root'], env).code).toBe(2);
  expect(runArchitectureCli(['--root'], env).code).toBe(2);
});
