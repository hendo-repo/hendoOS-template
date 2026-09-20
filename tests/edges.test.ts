import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DEFAULT_CONFIG } from '../src/protocols/service';
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const digest = `sha256:${'a'.repeat(64)}`;
const sourceRevision = 'a'.repeat(40);
function op(extra: Record<string, unknown> = {}) {
  return { version: 1, schemaVersion: 1, composeVersion: 1, contentGeneration: 3, requestId: 'request', sessionId: 'session', ownerId: 'owner', nonce: 'nonce',
    command: 'gate', scenarioId: 'pre-edit-kernel-plus-declared-reference', subjectDigest: digest,
    configRevision: DEFAULT_CONFIG.revision, checkerRevision: 'aos-policy/1', sourceRevision,
    observations: [{ key: 'verification', availability: 'available', freshness: 'fresh', completeness: 'complete', result: 'present', reasons: [], value: true,
      provenance: { kind: 'synthetic', source: 'test', subjectDigest: digest, configRevision: DEFAULT_CONFIG.revision, checkerRevision: 'aos-policy/1', sourceRevision } }], ...extra };
}
function setup() { const dir = mkdtempSync(join(tmpdir(), 'aos-edge-')); dirs.push(dir); return dir; }
async function run(dir: string, command: string, input: string, extra: string[] = []) {
  const child = Bun.spawn([process.execPath, 'src/edges/cli.ts', command, '--state', join(dir, 'state.sqlite'), '--content', resolve('content'), '--source-revision', sourceRevision, ...extra],
    { stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
}
const request = (id: number, method: string, params?: unknown) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const init = request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
const initialized = { jsonrpc: '2.0', method: 'notifications/initialized' };
const wire = (...messages: unknown[]) => messages.map(x => JSON.stringify(x)).join('\n') + '\n';
test('CLI malformed JSON and missing options fail with JSON-only stdout', async () => {
  const result = await run(setup(), 'gate', '{bad');
  expect(result.code).toBe(1); expect(JSON.parse(result.stdout).error).toBeDefined();
  const child = Bun.spawn([process.execPath, 'src/edges/cli.ts', 'gate'], { stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).toBe(1); expect(JSON.parse(await new Response(child.stdout).text()).error).toBeDefined();
});
test('help is runnable without homes/config/state', async () => {
  const child = Bun.spawn([process.execPath, 'src/edges/cli.ts', '--help'], { stdout: 'pipe', stderr: 'pipe' });
  expect(await child.exited).toBe(0);
  const text = await new Response(child.stdout).text();
  for (const command of ['orient', 'gate', 'closeout', 'reference', 'receipts', 'serve']) expect(text).toContain(command);
});
test('CLI and MCP return exact same core and replayed receipt', async () => {
  const dir = setup();
  const cli = await run(dir, 'gate', JSON.stringify(op()));
  expect(cli.code).toBe(0);
  const rpc = await run(dir, 'serve', wire(init, initialized, request(2, 'tools/call', { name: 'gate', arguments: op() })));
  expect(rpc.code).toBe(0); expect(rpc.stderr).toBe('');
  const lines = rpc.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(lines).toHaveLength(2);
  expect(lines.find(line => line.id === 2).result.structuredContent).toEqual(JSON.parse(cli.stdout));
});
test('stdio handshake, discovery, resource reads and notifications are standard JSON-RPC', async () => {
  const result = await run(setup(), 'serve', wire(request(0, 'tools/list'), init, initialized,
    { jsonrpc: '2.0', method: 'notifications/unknown' }, request(2, 'tools/list'), request(3, 'resources/list'),
    request(4, 'resources/read', { uri: 'aos://reference/verification-recipes' }), request(5, 'no-method'),
    request(6, 'resources/read', { uri: 'aos://reference/../../secret' })));
  const messages = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(messages).toHaveLength(7);
  expect(messages.find(m => m.id === 0).error.code).toBe(-32002);
  expect(messages.find(m => m.id === 1).result.protocolVersion).toBe('2025-06-18');
  expect(messages.find(m => m.id === 2).result.tools.map((t: { name: string }) => t.name)).toEqual(['orient', 'gate', 'closeout', 'reference']);
  expect(messages.find(m => m.id === 3).result.resources).toHaveLength(1);
  expect(messages.find(m => m.id === 4).result.contents[0].text).toContain('verification');
  expect(messages.find(m => m.id === 5).error.code).toBe(-32601);
  expect(messages.find(m => m.id === 6).error.code).toBe(-32602);
  expect(result.code).toBe(1);
});
test('malformed stdio framing produces parse errors; valid notifications get no reply', async () => {
  const result = await run(setup(), 'serve', '{bad}\n' + wire(init, initialized) + JSON.stringify(request(4, 'tools/list')));
  const messages = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(messages).toHaveLength(3); expect(messages[0].error.code).toBe(-32700);
  expect(messages[2].error.code).toBe(-32700); expect(result.code).toBe(1);
});
test('request cancellation reaches actual pending operation and never allows', async () => {
  const result = await run(setup(), 'serve', wire(init, initialized,
    request(2, 'tools/call', { name: 'gate', arguments: op() }),
    { jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2, reason: 'test' } }));
  const messages = result.stdout.trim().split('\n').map(line => JSON.parse(line));
  expect(messages).toHaveLength(2);
  const outcome = messages.find(m => m.id === 2).result.structuredContent;
  expect(outcome.status).toBe('incomplete'); expect(outcome.receipt.gateVerdict).toBe('indeterminate');
  expect(outcome.reason).toBe('cancelled'); expect(result.code).toBe(1);
});
test('policy deny has successful process status; unavailable service never emits allow', async () => {
  const dir = setup();
  writeFileSync(join(dir, 'owner.json'), JSON.stringify({ ...DEFAULT_CONFIG, rules: [{ id: 'deny-all', decision: 'deny' }] }));
  const denied = await run(dir, 'gate', JSON.stringify(op()), ['--config', join(dir, 'owner.json')]);
  expect(denied.code).toBe(0); expect(JSON.parse(denied.stdout).receipt.gateVerdict).toBe('deny');
  const unavailable = await run(setup(), 'gate', JSON.stringify(op()), ['--config', join(dir, 'absent.json')]);
  expect(unavailable.code).toBe(1); expect(JSON.parse(unavailable.stdout).error).toBeDefined();
});
test('version/content mismatch and oversize frames refuse', async () => {
  const result = await run(setup(), 'serve', wire({ ...init, params: { ...init.params as object, protocolVersion: 'bogus' } }));
  expect(JSON.parse(result.stdout).error.code).toBe(-32602);
  const large = await run(setup(), 'serve', 'x'.repeat(262145) + '\n');
  expect(large.code).toBe(1); expect(JSON.parse(large.stdout).error).toBeDefined();
  const wrong = await run(setup(), 'gate', JSON.stringify(op({ contentGeneration: 999 })));
  expect(wrong.code).toBe(1); expect(JSON.parse(wrong.stdout).status).toBe('refused');
});
test('orient, reference and receipts are runnable source-checkout commands', async () => {
  const dir = setup();
  const orient = await run(dir, 'orient', JSON.stringify(op({ command: 'orient', scenarioId: 'session-start-default' })));
  expect(orient.code).toBe(0); expect(JSON.parse(orient.stdout).core.composition.value.diagnostics.harness).toBe('default');
  const reference = await run(dir, 'reference', JSON.stringify(op({ command: 'reference', requestId: 'reference', referenceId: 'verification-recipes' })));
  expect(reference.code).toBe(0); expect(JSON.parse(reference.stdout).receipt.byteTiers.reference).toBeGreaterThan(0);
  const receipts = await run(dir, 'receipts', '', ['--owner', 'owner', '--session', 'session']);
  expect(receipts.code).toBe(0); expect(JSON.parse(receipts.stdout).receipts).toHaveLength(2);
});
test('input deadline closes real stdin wait without spawning children', async () => {
  const dir = setup();
  const child = Bun.spawn([process.execPath, 'src/edges/cli.ts', 'gate', '--state', join(dir, 'state.sqlite'), '--content', resolve('content'), '--source-revision', sourceRevision, '--input-timeout-ms', '10'],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const code = await child.exited;
  expect(code).toBe(1);
  expect(JSON.parse(await new Response(child.stdout).text()).enforcement).toBe(false);
  await new Response(child.stderr).text();
});
test('AOS initialize generation mismatch refuses before tools are available', async () => {
  const result = await run(setup(), 'serve', wire({ ...init, params: { ...init.params as object,
    capabilities: { experimental: { aos: { version: 1, schemaVersion: 1, composeVersion: 1, contentGeneration: 0, sourceRevision } } } } }));
  expect(JSON.parse(result.stdout).error.code).toBe(-32602); expect(result.code).toBe(1);
});
test('independent CLI and RPC executions compute equal packages', async () => {
  const cli = await run(setup(), 'gate', JSON.stringify(op()));
  const rpc = await run(setup(), 'serve', wire(init, initialized, request(2, 'tools/call', { name: 'gate', arguments: op() })));
  const a = JSON.parse(cli.stdout);
  const b = rpc.stdout.trim().split('\n').map(line => JSON.parse(line)).find(m => m.id === 2).result.structuredContent;
  expect(a.core).toEqual(b.core);
  expect({ ...a.receipt, timestamp: null }).toEqual({ ...b.receipt, timestamp: null });
});
