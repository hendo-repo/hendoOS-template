import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectedTests, runCommand, runGates, supportedBun, redactOutput,
  validateContent, verificationGates, PROJECT_ROOT } from '../scripts/verify.ts';
import { benchmarkOptions, percentile } from '../scripts/benchmark.ts';

let fixture: string;
beforeAll(async () => { fixture = await mkdtemp(join(tmpdir(), 'aos-verify-')); });
afterAll(async () => { await rm(fixture, { recursive: true, force: true }); });
const command = (code: string) => ({ argv: [process.execPath, '-e', code], cwd: fixture, timeoutMs: 3_000 });
const summary = (pass = 2, fail = 0, skip = 0, todo = 0) =>
  ` ${pass} pass\n ${fail} fail\n ${skip} skip\n ${todo} todo\nRan ${pass + fail + skip + todo} tests across 1 file. [2ms]\n`;

describe('runtime and test-count guards', () => {
  test('strict stable version floor', () => {
    for (const version of ['1.4.2', '1.4.3', '1.10.0', '2.0.0']) expect(supportedBun(version)).toBe(true);
    for (const version of ['1.4.1', '1.3.99', '0.99.0', 'v1.4.2', '1.4.2-canary', '1.4.2+build', '1.4', '01.4.2', '1.4.2\n']) {
      expect(supportedBun(version)).toBe(false);
    }
  });
  test('requires matching counters and some executed tests', () => {
    expect(collectedTests(summary())).toBe(2);
    expect(collectedTests(summary(1, 0, 2, 3))).toBe(6);
    expect(collectedTests('\x1b[32m' + summary() + '\x1b[0m')).toBe(2);
    for (const text of ['', summary(0), summary(0, 0, 2), summary(0, 0, 0, 2), summary(1, 1),
      summary() + summary(), summary().replace('2 tests', '9 tests'),
      summary().replace('1 file', '0 files'), summary().replace(' 0 fail\n', '')]) {
      expect(collectedTests(text)).toBeNull();
    }
  });
  test('five mandatory gates in a fixed order', () => {
    const gates = verificationGates();
    expect(gates.map(gate => gate.name)).toEqual(['typecheck', 'tests', 'architecture', 'public', 'content']);
    expect(gates[0]!.argv).toEqual([process.execPath, 'run', '--bun', 'tsc', '--noEmit']);
    expect(gates[1]!.argv).toEqual([process.execPath, 'test', 'tests']);
    expect(gates[1]!.requireTests).toBe(true);
  });
});

describe.skipIf(process.platform === 'win32')('bounded explicit child execution', () => {
  test('preserves real exit and both pipes', async () => {
    const result = await runCommand(command('console.log("out"); console.error("err"); process.exit(7)'));
    expect(result.state).toBe('complete');
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toBe('out\n');
    expect(result.stderr).toBe('err\n');
  });
  test('argv is literal and stdin is consumed', async () => {
    const literal = 'value; $(echo unwanted) & "quoted"';
    const result = await runCommand({ ...command('console.log(JSON.stringify({arg:process.argv[1],bytes:(await Bun.stdin.arrayBuffer()).byteLength}))'),
      argv: [process.execPath, '-e', 'console.log(JSON.stringify({arg:process.argv[1],bytes:(await Bun.stdin.arrayBuffer()).byteLength}))', literal],
      stdin: new Uint8Array(128) });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ arg: literal, bytes: 128 });
  });
  test.skipIf(process.platform === 'win32')('deadline is incomplete and bounded', async () => {
    const result = await runCommand({ ...command('setInterval(() => {}, 1000)'), timeoutMs: 80 });
    expect(result.state).toBe('incomplete');
    expect(result.reason).toBe('deadline-exceeded');
    expect(result.durationMs).toBeLessThan(2_000);
  });
  test.skipIf(process.platform === 'win32')('large output cannot pass by truncation', async () => {
    const result = await runCommand({ ...command('process.stdout.write("x".repeat(100000))'), maxOutputBytes: 1_024 });
    expect(result.state).toBe('incomplete');
    expect(result.reason).toBe('output-limit-exceeded');
  });
  test('invalid UTF-8 and missing executables fail closed', async () => {
    const badBytes = await runCommand(command('process.stdout.write(new Uint8Array([255]))'));
    expect(badBytes.state).toBe('incomplete');
    expect(badBytes.reason).toBe('output-or-exit-unreadable');
    const missing = await runCommand({ argv: [join(fixture, 'missing-executable')], cwd: fixture });
    expect(missing.state).toBe('incomplete');
    expect(missing.reason).toBe('spawn-failed');
    expect((await runCommand({ argv: [], timeoutMs: 0 })).reason).toBe('invalid-command-options');
  });
});

test.skipIf(process.platform === 'win32')('large verifier output is split into bounded ordered JSONL frames', async () => {
  const frames: Record<string, any>[] = [];
  const body = 'x'.repeat(40_000);
  await runGates([{ name: 'large-frame', ...command(`process.stderr.write(${JSON.stringify(body)})`) }],
    frame => frames.push(frame));
  const output = frames.filter(frame => frame.kind === 'output' && frame.channel === 'stderr');
  expect(output.length).toBeGreaterThan(1);
  expect(output.every(frame => frame.text.length <= 8 * 1024)).toBe(true);
  expect(output.map(frame => frame.text).join('')).toBe(body);
  expect(output.map(frame => frame.part)).toEqual(Array.from({ length: output.length }, (_, index) => index + 1));
});

describe.skipIf(process.platform === 'win32')('gate evidence and safe framing', () => {
  test('all gates run after failure; green text cannot override exit', async () => {
    const frames: Record<string, unknown>[] = [];
    const marker = join(fixture, 'ran-last');
    const results = await runGates([
      { name: 'first', ...command('console.log("PASS"); process.exit(3)') },
      { name: 'second', requireTests: true, ...command(`console.error(${JSON.stringify(summary(0, 0, 3))})`) },
      { name: 'last', ...command(`await Bun.write(${JSON.stringify(marker)}, "done"); console.log("done")`) },
    ], frame => frames.push(frame));
    expect(results.map(result => result.status)).toEqual(['fail', 'fail', 'pass']);
    expect(await Bun.file(marker).text()).toBe('done');
    expect(frames.filter(frame => frame.kind === 'gate')).toHaveLength(3);
  });
  test('valid summary still requires a zero child exit', async () => {
    const good = `console.error(${JSON.stringify(summary())})`;
    const results = await runGates([
      { name: 'good', requireTests: true, ...command(good) },
      { name: 'bad', requireTests: true, ...command(good + ';process.exit(9)') },
    ], () => {});
    expect(results.map(result => result.status)).toEqual(['pass', 'fail']);
    expect(results[0]!.tests).toBe(2);
  });
  test('synthetic split sentinels exercise generic and configured output checks', () => {
    const sentinel = ['private', 'sentinel', 'fixture'].join('-');
    expect(redactOutput('safe message', {})).toEqual({ text: 'safe message', matchCount: 0 });
    expect(redactOutput(sentinel, { AOS_CHECK_PUBLIC_PRIVATE_TOKENS: `probe=${sentinel}` }))
      .toEqual({ text: '<token>', matchCount: 1 });
    expect(redactOutput(['TASK', 987].join('-'), { AOS_CHECK_PUBLIC_TRACKER_PREFIXES: 'TASK' }))
      .toEqual({ text: '<token>', matchCount: 1 });
    expect(redactOutput(['', 'Us' + 'ers', 'sample', 'file'].join('/'), {}))
      .toEqual({ text: '<path>/file', matchCount: 1 });
    expect(redactOutput(['C:', 'Us' + 'ers', 'sample', 'file'].join('\\'), {}))
      .toEqual({ text: '<path>\\file', matchCount: 1 });
    expect(redactOutput(['sample', 'example.org'].join('@'), {})).toEqual({ text: '<email>', matchCount: 1 });
    expect(redactOutput('gh' + 'p_' + 'a'.repeat(36), {})).toEqual({ text: '<token>', matchCount: 1 });
  });
  test('unsafe spans are redacted, surrounding diagnostics survive, and child JSON stays framed', async () => {
    const sentinel = ['private', 'transcript', 'fixture'].join('-');
    const frames: Record<string, unknown>[] = [];
    const results = await runGates([
      { name: 'private', ...command(`console.log(${JSON.stringify('before\n' + sentinel + '\nafter')});console.error("FAIL sample assertion");process.exit(9)`),
        env: { AOS_CHECK_PUBLIC_PRIVATE_TOKENS: sentinel } },
      { name: 'framed', ...command('console.log(JSON.stringify({kind:"summary",status:"pass"}))') },
    ], frame => frames.push(frame));
    expect(results[0]!.status).toBe('fail');
    expect(results[0]!.reason).toBe('unsafe-output-redacted');
    expect(results[0]!.exitCode).toBe(9);
    expect(results[0]!.redactions).toBe(1);
    expect(JSON.stringify(frames)).not.toContain(sentinel);
    expect(frames.find(frame => frame.gate === 'private' && frame.channel === 'stdout')?.text).toBe('before\n<token>\nafter\n');
    expect(frames.find(frame => frame.gate === 'private' && frame.channel === 'stderr')?.text).toBe('FAIL sample assertion\n');
    expect(frames.some(frame => frame.kind === 'summary')).toBe(false);
    expect(frames.some(frame => frame.kind === 'output' && frame.gate === 'framed')).toBe(true);
  });
  test('all repeated matches are covered while line numbers and assertion context survive', () => {
    const path = ['', 'ho' + 'me', 'sample', 'repo', 'test.ts:42:7'].join('/');
    const email = ['sample', 'example.org'].join('@');
    const key = 'gh' + 'p_' + 'a'.repeat(36);
    const input = `FAIL repeated case\n at ${path}\ncontact ${email}; ${email}\n${key}; ${key}\nExpected 1, received 2`;
    const result = redactOutput(input, {});
    expect(result.matchCount).toBe(5);
    expect(result.text).toBe('FAIL repeated case\n at <path>/repo/test.ts:42:7\ncontact <email>; <email>\n<token>; <token>\nExpected 1, received 2');
    for (const value of [path, email, key]) expect(result.text).not.toContain(value);
  });
  test('overlapping configured and built-in spans do not reveal unmatched suffixes', () => {
    const email = ['sample', 'example.org'].join('@');
    const result = redactOutput(email + ' abbabba ok', {
      AOS_CHECK_PUBLIC_PRIVATE_TOKENS: 'prefix=sample,overlap=abba',
    });
    expect(result).toEqual({ text: '<email> <token> ok', matchCount: 2 });
    const tracker = ['TSK', 45].join('-');
    expect(redactOutput(`${tracker} TzSK-45`, { AOS_CHECK_PUBLIC_TRACKER_PREFIXES: 'TSK' }).text)
      .toBe('<token> TzSK-45');
  });
  test('redaction still fails a zero-exit gate with a valid test summary', async () => {
    const email = ['sample', 'example.org'].join('@');
    const results = await runGates([{ name: 'redacted', requireTests: true,
      ...command(`console.error(${JSON.stringify(email + '\n' + summary())})`) }], () => {});
    expect(results[0]).toMatchObject({ status: 'fail', exitCode: 0, tests: 2, redactions: 1 });
  });
  test('credential assignments spanning stdout and stderr are redacted in both frames', async () => {
    const value = 'a'.repeat(24);
    const left = ['to' + 'ken', '='].join(' ');
    const frames: Record<string, unknown>[] = [];
    const results = await runGates([{ name: 'split', ...command(
      `process.stdout.write(${JSON.stringify('before\n' + left)});process.stderr.write(${JSON.stringify('"' + value + '"\nafter')})`) }], frame => frames.push(frame));
    expect(results[0]!.redactions).toBe(1);
    expect(JSON.stringify(frames)).not.toContain(value);
    expect(frames.find(frame => frame.channel === 'stdout')?.text).toBe('before\n<token>');
    expect(frames.find(frame => frame.channel === 'stderr')?.text).toBe('<token>\nafter');
  });
  test('a detected private-key header covers its body and footer, or remainder if incomplete', () => {
    const header = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
    const footer = header.replace('BEGIN', 'END');
    const body = 'synthetic-key-material';
    expect(redactOutput(`before\n${header}\n${body}\n${footer}\nafter`, {}))
      .toEqual({ text: 'before\n<token>\nafter', matchCount: 1 });
    expect(redactOutput(`before\n${header}\n${body}`, {}))
      .toEqual({ text: 'before\n<token>', matchCount: 1 });
  });
  test('an actual failing Bun test retains its name and assertion after home-prefix redaction', async () => {
    const file = join(fixture, 'seeded-failure.test.ts');
    await writeFile(file, [
      'import { test, expect } from "bun:test";',
      'test("seeded portability assertion", () => {',
      '  console.error(process.env.AOS_FIXTURE_POSIX);',
      '  console.error(process.env.AOS_FIXTURE_WINDOWS);',
      '  expect(1).toBe(2);',
      '});',
    ].join('\n'));
    const user = ['synthetic', 'runner'].join('-');
    const frames: Record<string, unknown>[] = [];
    const results = await runGates([{ name: 'seeded', requireTests: true,
      argv: [process.execPath, 'test', file], cwd: fixture, timeoutMs: 3_000,
      env: {
        AOS_FIXTURE_POSIX: ['', 'Us' + 'ers', user, 'work', 'case.ts:7'].join('/'),
        AOS_FIXTURE_WINDOWS: ['C:', 'Us' + 'ers', user, 'work', 'case.ts:7'].join('\\'),
      },
    }], frame => frames.push(frame));
    const emitted = frames.filter(frame => frame.kind === 'output').map(frame => frame.text).join('\n');
    expect(results[0]).toMatchObject({ status: 'fail', exitCode: 1, reason: 'unsafe-output-redacted' });
    expect(results[0]!.redactions).toBeGreaterThanOrEqual(2);
    expect(emitted).toContain('seeded portability assertion');
    expect(emitted).toContain('Expected: 2');
    expect(emitted).toContain('Received: 1');
    expect(emitted).toContain('<path>/work/case.ts:7');
    expect(emitted).toContain('<path>\\work\\case.ts:7');
    expect(emitted).not.toContain(user);
  });
});

describe('content gate: exact positive membership and negative controls', () => {
  let root: string;
  let contentDir: string;
  let manifestPath: string;
  beforeAll(() => {
    root = join(fixture, 'content-gate');
    contentDir = join(root, 'content');
    manifestPath = join(contentDir, 'membership.manifest.json');
  });

  const KERNEL = [
    '---', 'id: sample', 'version: 1', 'tier: kernel', 'target_harnesses: [default]',
    'byte_budget: 4096', 'activation_conditions:', '  - harnesses: [default]',
    '    event: session-start', '---', 'A synthetic rule.',
  ].join('\n');

  const scenario = (over: Record<string, unknown> = {}) => ({
    id: 'sample', harness: 'default', event: 'session-start',
    expectedIds: ['sample'], expectedKernelIds: ['sample'], expectedStaticIds: ['sample'], ...over,
  });
  const manifestOf = (scenarios: unknown[]) =>
    ({ version: 1, owner: 'test', generation: 1, scenarios });

  const writeCorpus = async (files: Record<string, string>, manifest: unknown) => {
    await rm(root, { recursive: true, force: true });
    await mkdir(contentDir, { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(join(contentDir, name), text);
    await writeFile(manifestPath, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  };
  const withCorpus = (manifest: unknown) => writeCorpus({ 'sample.md': KERNEL }, manifest);

  test('an exact positive set passes and a proven-empty negative scenario is allowed', async () => {
    await withCorpus(manifestOf([
      scenario(),
      scenario({ id: 'unknown-event-activates-nothing', event: 'no-such-event', expectedIds: [], expectedKernelIds: [], expectedStaticIds: [] }),
      scenario({ id: 'unknown-harness-activates-nothing', harness: 'unlisted-harness', expectedIds: [], expectedKernelIds: [], expectedStaticIds: [] }),
    ]));
    expect(await validateContent(root)).toEqual({ files: 1, documents: 1, scenarios: 3 });
  });

  test('the shipped corpus and membership manifest pass the content gate', async () => {
    // Regression control for the shipped manifest itself: intentional negative
    // scenarios must not be mistaken for a degraded membership evaluation.
    const shipped = await validateContent(PROJECT_ROOT);
    expect(shipped.documents).toBeGreaterThan(0);
    expect(shipped.scenarios).toBeGreaterThan(0);
  });

  test('missing positive content is rejected, not ignored', async () => {
    await withCorpus(manifestOf([scenario({ expectedIds: ['absent'], expectedKernelIds: ['absent'] })]));
    await expect(validateContent(root)).rejects.toThrow();
  });

  test('unexpected activation and a missing kernel expectation are rejected', async () => {
    // A kernel activates but the manifest declares no expected kernel.
    await withCorpus(manifestOf([scenario({ expectedKernelIds: [] })]));
    await expect(validateContent(root)).rejects.toThrow();
    // The manifest expects a kernel that is not in its own expected id set.
    await withCorpus(manifestOf([scenario({ expectedKernelIds: ['ghost-kernel'] })]));
    await expect(validateContent(root)).rejects.toThrow();
  });

  test('the declared static prefix must exactly equal the activated kernel set', async () => {
    await withCorpus(manifestOf([scenario({ expectedStaticIds: [] })]));
    await expect(validateContent(root)).rejects.toThrow();
    await withCorpus(manifestOf([scenario({ expectedStaticIds: ['sample', 'ghost-kernel'] })]));
    await expect(validateContent(root)).rejects.toThrow();
  });

  test('a negative scenario that actually activates content is rejected', async () => {
    // Red-capable control: the negative branch must detect real activation.
    await withCorpus(manifestOf([scenario(), scenario({ id: 'negative-but-activates', expectedIds: [], expectedKernelIds: [] })]));
    await expect(validateContent(root)).rejects.toThrow();
  });

  test('a negative scenario declaring an expected kernel is rejected', async () => {
    await withCorpus(manifestOf([scenario(), scenario({ id: 'contradictory', expectedIds: [], expectedKernelIds: ['sample'] })]));
    await expect(validateContent(root)).rejects.toThrow();
  });

  test('zero useful coverage is rejected', async () => {
    // Only negative scenarios: the manifest proves nothing about real content.
    await withCorpus(manifestOf([scenario({ id: 'only-negative', expectedIds: [], expectedKernelIds: [] })]));
    await expect(validateContent(root)).rejects.toThrow();
    await withCorpus(manifestOf([]));
    await expect(validateContent(root)).rejects.toThrow();
  });

  test('malformed or unreadable manifests are rejected', async () => {
    const malformed: unknown[] = [
      '{ not json', null, {}, { version: 2, owner: 'test', generation: 1, scenarios: [scenario()] },
      { version: 1, owner: '', generation: 1, scenarios: [scenario()] },
      { version: 1, owner: 'test', generation: -1, scenarios: [scenario()] },
      { version: 1, owner: 'test', generation: 1 },
      manifestOf([null]),
      manifestOf([scenario({ unknown_key: true })]),
      manifestOf([scenario({ expectedIds: ['sample', 'sample'] })]),
    ];
    for (const manifest of malformed) {
      await withCorpus(manifest);
      await expect(validateContent(root)).rejects.toThrow();
    }
  });

  test('an empty or absent corpus is rejected', async () => {
    await writeCorpus({}, manifestOf([scenario()]));
    await expect(validateContent(root)).rejects.toThrow();
    await rm(root, { recursive: true, force: true });
    await mkdir(join(root, 'content'), { recursive: true });
    await expect(validateContent(root)).rejects.toThrow();
  });
});

test('benchmark requires enough samples and explicit CLI argv', () => {
  expect(benchmarkOptions([]).samples).toBe(30);
  expect(benchmarkOptions(['--samples', '20']).samples).toBe(20);
  const argv = ['bun', 'src/cli.ts', 'hook'];
  expect(benchmarkOptions(['--label', 'hook', '--command-json', JSON.stringify(argv)]).argv).toEqual(argv);
  expect(benchmarkOptions(['--label', 'rpc', '--command-json', JSON.stringify(argv), '--stdin-file', 'operation.json', '--mode', 'rpc', '--interventions', '0']).mode).toBe('rpc');
  for (const args of [['--samples', '19'], ['--samples', '20oops'], ['--command-json', '"bun hook"'],
    ['--label', 'hook'], ['--command-json', '[]'], ['--samples', '20', '--samples', '30'], ['--mode', 'rpc']]) {
    expect(() => benchmarkOptions(args)).toThrow();
  }
  expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.5)).toBe(10);
  expect(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95)).toBe(19);
  expect(() => percentile([], 0.5)).toThrow();
});
