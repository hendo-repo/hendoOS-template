import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCompatibility } from '../src/effects/doctor';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root(): Promise<string> {
  const value = await mkdtemp(join(await realpath(tmpdir()), 'aos-doctor-')); roots.push(value); return value;
}

test('foreign marker shapes are classified but never authorize Bun', async () => {
  const target = await root();
  await writeFile(join(target, '.verified'), 'true\n');
  await writeFile(join(target, 'legacy-verified'), 'expired\n');
  await mkdir(join(target, 'session-agent-complete'));
  const before = JSON.stringify((await readdir(target)).sort());
  const report = await inspectCompatibility(target);
  expect(report).toEqual({ status: 'foreign-markers', bunState: 'absent', authorization: 'none', collision: false,
    foreign: [
      { name: '.verified', state: 'valid-looking' },
      { name: 'legacy-verified', state: 'stale-looking' },
      { name: 'session-agent-complete', state: 'malformed' },
    ] });
  expect(JSON.stringify((await readdir(target)).sort())).toBe(before);
});

test('doctor reports Bun/legacy coexistence without treating either marker family as authority', async () => {
  const target = await root();
  await writeFile(join(target, '.verified'), 'true\n');
  await mkdir(join(target, '.aos'));
  await writeFile(join(target, '.aos/state.json'), '{"schemaVersion":1,"owner":"fixture","generation":1,"harness":"example","entries":[]}\n');
  const report = await inspectCompatibility(target);
  expect(report.status).toBe('coexistence');
  expect(report.bunState).toBe('present');
  expect(report.collision).toBe(true);
  expect(report.authorization).toBe('none');
  expect(await readFile(join(target, '.verified'), 'utf8')).toBe('true\n');
});

test('malformed Bun state is diagnosed and still grants no authority', async () => {
  const target = await root(); await mkdir(join(target, '.aos'));
  await writeFile(join(target, '.aos/state.json'), '{"schemaVersion":1}\n');
  expect(await inspectCompatibility(target)).toEqual({ status: 'clear', bunState: 'malformed',
    foreign: [], authorization: 'none', collision: false });
});
