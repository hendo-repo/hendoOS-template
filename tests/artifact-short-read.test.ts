import { expect, test } from 'bun:test';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Real descriptor reads may return fewer bytes than requested. Limit each read in
// an isolated child so module mocking cannot affect any other test in the suite.
test('digest advances by actual bytes after short descriptor reads', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'aos-short-read-'));
  try {
    const text = 'short reads must preserve every byte across multiple chunks';
    await writeFile(join(root, 'source.bin'), text);
    const modulePath = import.meta.resolve('../src/effects/paths');
    const script = `
      import { mock } from 'bun:test';
      import * as fs from 'node:fs/promises';
      const originalOpen = fs.open;
      mock.module('node:fs/promises', () => ({ ...fs, open: async (...args) => {
        const handle = await originalOpen(...args);
        const read = handle.read.bind(handle);
        handle.read = (buffer, offset, length, position) => read(buffer, offset, Math.min(length, 7), position);
        return handle;
      }}));
      const { readFileDigest, readVerifiedFile } = await import(${JSON.stringify(modulePath)});
      const digest = 'sha256:' + new Bun.CryptoHasher('sha256').update(${JSON.stringify(text)}).digest('hex');
      const verified = await readVerifiedFile(${JSON.stringify(root)}, 'source.bin', digest);
      console.log(JSON.stringify({ hashed: await readFileDigest(${JSON.stringify(root)}, 'source.bin'),
        verified: verified.ok ? new TextDecoder().decode(verified.value) : verified }));
    `;
    const child = Bun.spawn([process.execPath, '-e', script], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe('');
    expect(exit).toBe(0);
    const hash = new Bun.CryptoHasher('sha256').update(text).digest('hex');
    expect(JSON.parse(stdout)).toEqual({ hashed: { ok: true, value: `sha256:${hash}` }, verified: text });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('verified reads refuse path replacement between descriptor open and close', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'aos-verified-race-'));
  try {
    const original = 'verified bytes';
    await writeFile(join(root, 'source.bin'), original);
    const modulePath = import.meta.resolve('../src/effects/paths');
    const script = `
      import { mock } from 'bun:test';
      import * as fs from 'node:fs/promises';
      const originalOpen = fs.open;
      mock.module('node:fs/promises', () => ({ ...fs, open: async (...args) => {
        const handle = await originalOpen(...args);
        const read = handle.read.bind(handle);
        let replaced = false;
        handle.read = async (...readArgs) => {
          if (!replaced) { replaced = true; await fs.rename(${JSON.stringify(join(root, 'source.bin'))}, ${JSON.stringify(join(root, 'old.bin'))}); await fs.writeFile(${JSON.stringify(join(root, 'source.bin'))}, 'attacker bytes'); }
          return read(...readArgs);
        };
        return handle;
      }}));
      const { readVerifiedFile } = await import(${JSON.stringify(modulePath)});
      const digest = 'sha256:' + new Bun.CryptoHasher('sha256').update(${JSON.stringify(original)}).digest('hex');
      console.log(JSON.stringify(await readVerifiedFile(${JSON.stringify(root)}, 'source.bin', digest)));
    `;
    const child = Bun.spawn([process.execPath, '-e', script], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(''); expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, code: 'changed' });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('verified reads fail closed when the descriptor cannot be closed', async () => {
  const root = await mkdtemp(join(await realpath(tmpdir()), 'aos-verified-close-'));
  try {
    const text = 'close verification';
    await writeFile(join(root, 'source.bin'), text);
    const modulePath = import.meta.resolve('../src/effects/paths');
    const script = `
      import { mock } from 'bun:test';
      import * as fs from 'node:fs/promises';
      const originalOpen = fs.open;
      mock.module('node:fs/promises', () => ({ ...fs, open: async (...args) => {
        const handle = await originalOpen(...args);
        handle.close = async () => { throw Object.assign(new Error('close failed'), { code: 'EIO' }); };
        return handle;
      }}));
      const { readVerifiedFile } = await import(${JSON.stringify(modulePath)});
      const digest = 'sha256:' + new Bun.CryptoHasher('sha256').update(${JSON.stringify(text)}).digest('hex');
      console.log(JSON.stringify(await readVerifiedFile(${JSON.stringify(root)}, 'source.bin', digest)));
    `;
    const child = Bun.spawn([process.execPath, '-e', script], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(stderr).toBe(''); expect(exit).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ ok: false, code: 'unreadable' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
