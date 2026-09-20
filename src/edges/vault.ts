#!/usr/bin/env bun
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { compareVaultInventories, inventoryVault, type VaultInventory } from '../effects/vault';

const usage = 'usage: bun src/edges/vault.ts inventory --root ABSOLUTE [--exclude PATH]... [--output FILE]\n' +
  '       bun src/edges/vault.ts compare --left FILE --right FILE [--output FILE]\n';

function args(argv: string[]) {
  const values = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]!;
    if (!key.startsWith('--') || !argv[i + 1] || argv[i + 1]!.startsWith('--')) throw new Error('usage');
    const list = values.get(key) ?? []; list.push(argv[++i]!); values.set(key, list);
  }
  return values;
}

async function emit(value: object, output?: string) {
  const body = JSON.stringify(value, null, 2) + '\n';
  if (output) { await mkdir(dirname(output), { recursive: true }); await writeFile(output, body, { mode: 0o600 }); }
  else process.stdout.write(body);
}

export async function runVaultCli(argv: string[]): Promise<number> {
  if (!argv.length || argv.includes('--help') || argv.includes('-h')) { process.stdout.write(usage); return argv.length ? 0 : 2; }
  try {
    const command = argv[0]!, parsed = args(argv.slice(1)), output = parsed.get('--output')?.[0];
    if (command === 'inventory') {
      const root = parsed.get('--root')?.[0]; if (!root) throw new Error('usage');
      await emit(await inventoryVault(root, parsed.get('--exclude') ?? []), output); return 0;
    }
    if (command === 'compare') {
      const left = parsed.get('--left')?.[0], right = parsed.get('--right')?.[0]; if (!left || !right) throw new Error('usage');
      const result = compareVaultInventories(JSON.parse(await readFile(left, 'utf8')) as VaultInventory,
        JSON.parse(await readFile(right, 'utf8')) as VaultInventory);
      await emit(result, output); return (result as { status: string }).status === 'identical' ? 0 : 1;
    }
    throw new Error('usage');
  } catch (error) { process.stderr.write(error instanceof Error && error.message !== 'usage' ? `${error.message}\n` : usage); return 2; }
}

if (import.meta.main) process.exit(await runVaultCli(process.argv.slice(2)));
