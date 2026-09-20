import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ARTIFACT_SIZE_CEILING, readFileDigest } from '../src/effects/paths';

// Literal so the RED run fails meaningfully instead of erroring on a missing export.
const EXPECTED_CEILING = 16 * 1024 * 1024;

const digest = (bytes: string | Uint8Array) => `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
const temporary: string[] = [];
afterEach(async () => { for (const path of temporary.splice(0)) await rm(path, { recursive: true, force: true }); });

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'aos-bounds-'));
  temporary.push(root);
  return root;
}

/** Sparse file of `size` zero bytes; truncate extends without writing the payload. */
async function sparse(root: string, name: string, size: number): Promise<void> {
  await writeFile(join(root, name), '');
  await truncate(join(root, name), size);
}

describe('artifact read bounds', () => {
  test('exports a conservative positive artifact ceiling', () => {
    expect(Number.isSafeInteger(ARTIFACT_SIZE_CEILING)).toBe(true);
    expect(ARTIFACT_SIZE_CEILING).toBe(EXPECTED_CEILING);
  });

  test('ordinary files keep the unchanged digest', async () => {
    const root = await fixture();
    const bytes = new Uint8Array([0, 255, 254, 10, 128]);
    await writeFile(join(root, 'small.bin'), bytes);
    expect(await readFileDigest(root, 'small.bin')).toEqual({ ok: true, value: digest(bytes) });
  });

  test('refuses an oversized file before allocating its bytes', async () => {
    const root = await fixture();
    await sparse(root, 'huge.bin', EXPECTED_CEILING + 1);
    const result = await readFileDigest(root, 'huge.bin');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unreadable');
    // Diagnostic must stay bounded and must not echo the file name.
    expect(result.message).not.toContain('huge.bin');
    expect(result.message.length).toBeLessThan(120);
  });

  test('accepts a file exactly at the ceiling and hashes it in bounded chunks', async () => {
    const root = await fixture();
    await sparse(root, 'boundary.bin', EXPECTED_CEILING);
    const hasher = new Bun.CryptoHasher('sha256');
    const zeros = new Uint8Array(1024 * 1024);
    for (let offset = 0; offset < EXPECTED_CEILING; offset += zeros.length) hasher.update(zeros);
    expect(await readFileDigest(root, 'boundary.bin')).toEqual({ ok: true, value: `sha256:${hasher.digest('hex')}` });
  });
});
