import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const roots: string[] = [];
const temp = (name: string) => { const value = mkdtempSync(join(tmpdir(), `hendoos-${name}-`)); roots.push(value); return value; };
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]) {
  return Bun.spawnSync(['git', '-c', 'user.name=Vault Fixture', '-c', 'user.email=vault-fixture@users.noreply.github.com', ...args],
    { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, stdout: 'pipe', stderr: 'pipe' });
}
function ok(cwd: string, ...args: string[]) {
  const result = git(cwd, ...args);
  if (!result.success) throw new Error(`${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
function put(root: string, path: string, body: string) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), body); }

function fixture() {
  const bare = temp('vault-remote'); ok(bare, 'init', '--bare', '--initial-branch=main');
  const seed = temp('vault-seed'); ok(seed, 'init', '--initial-branch=main'); put(seed, 'vault/shared.md', 'base\n');
  ok(seed, 'add', '.'); ok(seed, 'commit', '-m', 'seed'); ok(seed, 'remote', 'add', 'origin', bare); ok(seed, 'push', '-u', 'origin', 'main');
  const a = temp('vault-a'), b = temp('vault-b'); ok(dirname(a), 'clone', bare, a); ok(dirname(b), 'clone', bare, b);
  return { bare, a, b };
}

describe('vault Git replication protocol', () => {
  test('disjoint session writes reconcile through fetch and an explicit merge', () => {
    const { bare, a, b } = fixture();
    put(a, 'vault/30-Archive/Sessions/a.md', 'session a\n'); ok(a, 'add', '.'); ok(a, 'commit', '-m', 'session a'); ok(a, 'push');
    put(b, 'vault/30-Archive/Sessions/b.md', 'session b\n'); ok(b, 'add', '.'); ok(b, 'commit', '-m', 'session b');
    ok(b, 'fetch', 'origin'); ok(b, 'merge', '--no-edit', 'origin/main'); ok(b, 'push');
    const restored = temp('vault-restored'); ok(dirname(restored), 'clone', bare, restored);
    expect(readFileSync(join(restored, 'vault/30-Archive/Sessions/a.md'), 'utf8')).toBe('session a\n');
    expect(readFileSync(join(restored, 'vault/30-Archive/Sessions/b.md'), 'utf8')).toBe('session b\n');
  });

  test('same-note edits remain a visible conflict and are never auto-resolved', () => {
    const { a, b } = fixture();
    put(a, 'vault/shared.md', 'writer a\n'); ok(a, 'add', '.'); ok(a, 'commit', '-m', 'writer a'); ok(a, 'push');
    put(b, 'vault/shared.md', 'writer b\n'); ok(b, 'add', '.'); ok(b, 'commit', '-m', 'writer b'); ok(b, 'fetch', 'origin');
    const merge = git(b, 'merge', '--no-edit', 'origin/main');
    expect(merge.success).toBe(false);
    expect(ok(b, 'status', '--porcelain')).toContain('UU vault/shared.md');
    expect(readFileSync(join(b, 'vault/shared.md'), 'utf8')).toContain('<<<<<<< HEAD');
  });

  test('rejected/offline pushes retain the local commit and recover without force', () => {
    const { bare, a } = fixture();
    put(a, 'vault/offline.md', 'offline work\n'); ok(a, 'add', '.'); ok(a, 'commit', '-m', 'offline work');
    const head = ok(a, 'rev-parse', 'HEAD'), remoteBefore = ok(bare, 'rev-parse', 'refs/heads/main');
    ok(a, 'remote', 'set-url', 'origin', join(temp('missing-parent'), 'missing.git'));
    expect(git(a, 'push', 'origin', 'main').success).toBe(false);
    expect(ok(a, 'rev-parse', 'HEAD')).toBe(head);
    expect(ok(bare, 'rev-parse', 'refs/heads/main')).toBe(remoteBefore);
    ok(a, 'remote', 'set-url', 'origin', bare); ok(a, 'fetch', 'origin'); ok(a, 'push', 'origin', 'main');
    expect(ok(bare, 'rev-parse', 'refs/heads/main')).toBe(head);
  });
});
