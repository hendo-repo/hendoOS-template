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
      const { readFileDigest } = await import(${JSON.stringify(modulePath)});
      console.log(JSON.stringify(await readFileDigest(${JSON.stringify(root)}, 'source.bin')));
    `;
    const child = Bun.spawn([process.execPath, '-e', script], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe('');
    expect(exit).toBe(0);
    const hash = new Bun.CryptoHasher('sha256').update(text).digest('hex');
    expect(JSON.parse(stdout)).toEqual({ ok: true, value: `sha256:${hash}` });
  } finally { await rm(root, { recursive: true, force: true }); }
});
