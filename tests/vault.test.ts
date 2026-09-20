import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareVaultInventories, inventoryVault } from '../src/effects/vault';
import { runVaultCli } from '../src/edges/vault';

const roots: string[] = [];
const root = () => { const value = mkdtempSync(join(tmpdir(), 'hendoos-vault-')); roots.push(value); return value; };
const put = (base: string, path: string, body: string | Uint8Array) => { mkdirSync(join(base, path, '..'), { recursive: true }); writeFileSync(join(base, path), body); };
afterEach(() => { for (const value of roots.splice(0)) rmSync(value, { recursive: true, force: true }); });

describe('vault inventory', () => {
  test('binds file bytes and modes while reporting links, examples, local config, and binaries without secret values', async () => {
    const value = root();
    put(value, 'README.md', '# Vault\n[[note]] ![[asset.png]] [web](https://example.invalid)\n');
    put(value, 'note.md', 'token: sk-' + 'a'.repeat(30)); put(value, 'asset.png', new Uint8Array([0, 1, 2]));
    put(value, 'local.env.bak', 'TOKEN=private\n'); chmodSync(join(value, 'note.md'), 0o600);
    const report = await inventoryVault(value);
    expect(report.counts).toMatchObject({ files: 4, markdown: 2, attachments: 1, binaries: 1, links: 2, embeds: 1, externalLinks: 1 });
    expect(report.findings.map(item => item.code)).toEqual(expect.arrayContaining(['credential-provider', 'local-config']));
    expect(JSON.stringify(report)).not.toContain('sk-' + 'a'.repeat(30));
    const observedMode = statSync(join(value, 'note.md')).mode & 0o777;
    expect(report.entries.find(item => item.path === 'note.md')?.mode).toBe(observedMode);
    if (process.platform !== 'win32') expect(observedMode).toBe(0o600);
  });
  test('detects unresolved links, case collisions, conflict copies, and symlinks', async () => {
    const value = root(); put(value, 'source.md', '[[definitely-absent]]\n'); put(value, 'note - copy.md', 'copy\n');
    put(value, 'A.md', 'upper\n'); put(value, 'a.md', 'lower\n'); symlinkSync('source.md', join(value, 'alias.md'));
    const report = await inventoryVault(value); const codes = report.findings.map(item => item.code);
    expect(codes).toEqual(expect.arrayContaining(['unresolved-link', 'conflict-copy', 'symlink']));
    const distinctCaseEntries = report.entries.filter(item => /^(?:A|a)\.md$/.test(item.path)).length === 2;
    if (distinctCaseEntries) expect(codes).toContain('case-or-unicode-collision');
  });
  test('exclusions are exact prefixes and comparison exposes every difference', async () => {
    const source = root(); const target = root();
    put(source, 'keep.md', 'same\n'); put(source, 'local/secret.md', 'omit\n'); cpSync(join(source, 'keep.md'), join(target, 'keep.md'));
    const expected = await inventoryVault(source, ['local']); const actual = await inventoryVault(target);
    expect(compareVaultInventories(expected, actual)).toMatchObject({ status: 'identical', missing: [], added: [], changed: [] });
    put(target, 'keep.md', 'changed\n'); put(target, 'extra.md', 'extra\n');
    expect(compareVaultInventories(expected, await inventoryVault(target))).toMatchObject({ status: 'different', added: ['extra.md'], changed: ['keep.md'] });
  });
  test('CLI writes an inventory and rejects relative roots', async () => {
    const value = root(), output = join(root(), 'report.json'); put(value, 'note.md', '# Note\n');
    expect(await runVaultCli(['inventory', '--root', value, '--output', output])).toBe(0);
    expect(JSON.parse(await Bun.file(output).text()).schema).toBe('hendoos.vault-inventory/v1');
    expect(await runVaultCli(['inventory', '--root', 'relative'])).toBe(2);
  });
});
