#!/usr/bin/env bun
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_RULES, ENV_VARS, configuredLiteralRegex, parseLiteralList,
  scanPublicRepo, exitCodeFor, trackerPrefixRegex, configuredTrackerPrefixes } from './check-public.ts';
import { buildActivation, buildContentCorpus, evaluateMembership, validateMembershipManifest,
  type AosErrorCode, type ContentSourceFile } from '../src/schema/index.ts';
import { compose } from '../src/compose/index.ts';
import { parsePublicExportManifest } from './export-public.ts';

export const MIN_BUN = '1.4.2';
export const PROJECT_ROOT = fileURLToPath(new URL('../', import.meta.url));

export function supportedBun(version: string): boolean {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) return false;
  const actual = version.split('.').map(Number);
  const floor = MIN_BUN.split('.').map(Number);
  if (!actual.every(Number.isSafeInteger)) return false;
  for (let i = 0; i < 3; i++) {
    if (actual[i]! !== floor[i]!) return actual[i]! > floor[i]!;
  }
  return true;
}

export interface CommandSpec {
  argv: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: Uint8Array;
  timeoutMs?: number;
  maxOutputBytes?: number;
}
export interface CommandResult {
  state: 'complete' | 'incomplete';
  exitCode: number | null;
  stdout: string;
  stderr: string;
  reason?: string;
  durationMs: number;
}

/** Bound BOTH exit and pipe draining. Never infer success from captured text. */
export async function runCommand(spec: CommandSpec): Promise<CommandResult> {
  const started = performance.now();
  const timeoutMs = spec.timeoutMs ?? 120_000;
  const maxBytes = spec.maxOutputBytes ?? 8 * 1024 * 1024;
  const result: CommandResult = { state: 'incomplete', exitCode: null, stdout: '', stderr: '', durationMs: 0 };
  if (!spec.argv.length || !spec.argv.every(a => typeof a === 'string' && !a.includes('\0')) ||
      !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    return { ...result, reason: 'invalid-command-options' };
  }
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn({ cmd: spec.argv, cwd: spec.cwd ?? PROJECT_ROOT,
      env: { ...process.env, ...spec.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdin: spec.stdin ?? 'ignore', stdout: 'pipe', stderr: 'pipe' });
  } catch {
    return { ...result, reason: 'spawn-failed', durationMs: performance.now() - started };
  }
  const stdout = child.stdout as ReadableStream<Uint8Array>;
  const stderr = child.stderr as ReadableStream<Uint8Array>;
  const readers = [stdout.getReader(), stderr.getReader()];
  let bytes = 0;
  let settled = false;
  let timer: ReturnType<typeof setTimeout>;
  const completion = new Promise<void>(resolve => {
    const finish = (reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reason) {
        result.reason = reason;
        try { child.kill('SIGKILL'); } catch { /* Already exited. */ }
        for (const reader of readers) void reader!.cancel().catch(() => {});
      } else result.state = 'complete';
      resolve();
    };
    timer = setTimeout(() => finish('deadline-exceeded'), timeoutMs);
    const drain = async (index: number, key: 'stdout' | 'stderr') => {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const reader = readers[index]!;
      while (!settled) {
        const chunk = await reader.read();
        if (settled) return;
        if (chunk.done) { result[key] += decoder.decode(); return; }
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) { finish('output-limit-exceeded'); return; }
        result[key] += decoder.decode(chunk.value, { stream: true });
      }
    };
    void Promise.all([drain(0, 'stdout'), drain(1, 'stderr'), child.exited.then(code => {
      if (!settled) result.exitCode = code;
    })]).then(() => finish(), () => finish('output-or-exit-unreadable'));
  });
  await completion;
  result.durationMs = performance.now() - started;
  return result;
}

/** Bun's terminal summary must agree with its counters and include executed tests. */
export function collectedTests(output: string): number | null {
  const clean = output.replace(/\x1b\[[0-9;]*m/g, '').replace(/\r/g, '');
  const counts = (name: string) => [...clean.matchAll(new RegExp(`^\\s*(\\d+) ${name}\\s*$`, 'gm'))];
  const pass = counts('pass'), fail = counts('fail'), skip = counts('skip'), todo = counts('todo');
  const ran = [...clean.matchAll(/^Ran (\d+) tests? across (\d+) files?\.[^\n]*$/gm)];
  if (pass.length !== 1 || fail.length !== 1 || skip.length > 1 || todo.length > 1 || ran.length !== 1) return null;
  const passed = Number(pass[0]![1]), failed = Number(fail[0]![1]);
  const skipped = Number(skip[0]?.[1] ?? 0), todos = Number(todo[0]?.[1] ?? 0);
  const total = Number(ran[0]![1]), files = Number(ran[0]![2]);
  if (![passed, failed, skipped, todos, total, files].every(Number.isSafeInteger) ||
      passed < 1 || failed !== 0 || files < 1 || total !== passed + failed + skipped + todos) return null;
  return total;
}

type Redaction = { start: number; end: number; replacement: '<token>' | '<path>' | '<email>' };

/** Match original bytes before replacement so overlapping rules cannot expose a suffix. */
function outputRedactions(text: string, env: Record<string, string | undefined>): Redaction[] {
  const spans: Redaction[] = [];
  for (const { value } of parseLiteralList(env[ENV_VARS.PRIVATE_TOKENS])) {
    const configured = configuredLiteralRegex(value);
    const overlapping = new RegExp(`(?=(${configured.source}))`, configured.flags);
    for (const match of text.matchAll(overlapping))
      spans.push({ start: match.index!, end: match.index! + match[1]!.length, replacement: '<token>' });
  }
  const collect = (re: RegExp, replacement: Redaction['replacement'], capture = 0, privateKey = false) => {
    for (const match of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
      const value = match[capture]!;
      const start = match.index! + match[0].length - value.length;
      let end = start + value.length;
      // The scanner recognizes a key header. Emitting the remaining key would leak
      // its material, so cover its matching footer too (or EOF if unterminated).
      if (privateKey) {
        const footer = value.replace('BEGIN', 'END');
        const close = text.indexOf(footer, end);
        end = close < 0 ? text.length : close + footer.length;
      }
      spans.push({ start, end, replacement });
    }
  };
  for (const { value } of configuredTrackerPrefixes(env[ENV_VARS.TRACKER_PREFIXES])) {
    collect(trackerPrefixRegex(value), '<token>');
  }
  for (const { re, label } of CREDENTIAL_RULES) collect(re, '<token>', 0, label === 'private-key-block');
  const home = ['Us' + 'ers', 'ho' + 'me'].join('|');
  collect(new RegExp(`(?:^|[^A-Za-z0-9.])(/(?:${home})/[^/\\s]+)`, 'g'), '<path>', 1);
  collect(new RegExp(`[A-Za-z]:\\\\${'Us' + 'ers'}\\\\[^\\\\\\s]+`, 'g'), '<path>');
  collect(/[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, '<email>');
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Redaction[] = [];
  for (const span of spans) {
    const prior = merged.at(-1);
    if (prior && span.start < prior.end) prior.end = Math.max(prior.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

/** Project combined-transcript spans back onto a pipe without exposing cross-pipe matches. */
function replaceOutput(text: string, spans: Redaction[], offset = 0): string {
  const chunks: string[] = [];
  let cursor = 0;
  for (const span of spans) {
    const start = Math.max(0, span.start - offset), end = Math.min(text.length, span.end - offset);
    if (end <= start) continue;
    chunks.push(text.slice(cursor, start), span.replacement);
    cursor = end;
  }
  chunks.push(text.slice(cursor));
  return chunks.join('');
}

/** Fixed placeholders and the number of disjoint redacted spans; no matched values or labels. */
export function redactOutput(text: string, env: Record<string, string | undefined> = process.env): { text: string; matchCount: number } {
  const spans = outputRedactions(text, env);
  return { text: replaceOutput(text, spans), matchCount: spans.length };
}

export interface GateSpec extends CommandSpec { name: string; requireTests?: boolean }
export interface GateResult { name: string; status: 'pass' | 'fail' | 'incomplete'; exitCode: number | null; tests: number | null; redactions: number; reason?: string }
type Emit = (frame: Record<string, unknown>) => void;
const OUTPUT_FRAME_CHARS = 8 * 1024;

/** Keep each JSONL record below conservative Windows/GitHub log-line limits. */
function emitOutput(emit: Emit, gate: string, channel: 'stdout' | 'stderr', text: string): void {
  const count = Math.ceil(text.length / OUTPUT_FRAME_CHARS);
  for (let index = 0; index < count; index++) emit({ schema: 'aos.verify/v1', kind: 'output', gate, channel,
    part: index + 1, parts: count, text: text.slice(index * OUTPUT_FRAME_CHARS, (index + 1) * OUTPUT_FRAME_CHARS) });
}

export async function runGates(gates: GateSpec[], emit: Emit): Promise<GateResult[]> {
  const results: GateResult[] = [];
  for (const gate of gates) {
    emit({ schema: 'aos.verify/v1', kind: 'start', gate: gate.name });
    const child = await runCommand(gate);
    const output = child.stdout + '\n' + child.stderr;
    const spans = outputRedactions(output, { ...process.env, ...gate.env });
    const tests = gate.requireTests ? collectedTests(output) : null;
    const status = child.state !== 'complete' ? 'incomplete' :
      child.exitCode !== 0 || spans.length > 0 || (gate.requireTests && tests === null) ? 'fail' : 'pass';
    for (const channel of ['stdout', 'stderr'] as const) {
      if (child[channel]) emitOutput(emit, gate.name, channel,
        replaceOutput(child[channel], spans, channel === 'stdout' ? 0 : child.stdout.length + 1));
    }
    const reason = child.reason ?? (spans.length > 0 ? 'unsafe-output-redacted' :
      child.exitCode !== 0 ? 'child-failed' : gate.requireTests && tests === null ? 'invalid-or-empty-test-summary' : undefined);
    const result: GateResult = { name: gate.name, status, exitCode: child.exitCode, tests, redactions: spans.length, reason };
    results.push(result);
    emit({ schema: 'aos.verify/v1', kind: 'gate', ...result, durationMs: child.durationMs });
  }
  return results;
}

export async function loadContentFiles(root: string): Promise<ContentSourceFile[]> {
  const files: ContentSourceFile[] = [];
  async function walk(relative: string): Promise<void> {
    const entries = await readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const path = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('content-symlink');
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith('.md')) {
        if (!entry.isFile()) throw new Error('content-not-regular');
        files.push({ path, text: new TextDecoder('utf-8', { fatal: true }).decode(await Bun.file(join(root, path)).arrayBuffer()) });
      }
    }
  }
  await walk('content');
  if (!files.length) throw new Error('empty-content');
  return files;
}

/**
 * Activation-level codes that prove a query failed closed because nothing fired
 * (`empty-selection`) or nothing targets the harness (`unknown-harness`).
 */
const NON_ACTIVATION_CODES: ReadonlySet<AosErrorCode> = new Set<AosErrorCode>([
  'empty-selection',
  'unknown-harness',
]);

/**
 * Validate the shipped corpus and membership manifest for the content gate.
 *
 * Semantics, in both directions:
 *
 * - **Positive scenarios** (`expectedIds` non-empty) must match exactly: every
 *   expected id activates, no unexpected id activates, and the activated kernel
 *   set equals `expectedKernelIds`, and the exact static-prefix content set
 *   equals `expectedStaticIds`. A manifest expectation with no matching
 *   content, a demotion, or an extra activation is a failure — never ignored.
 * - **Negative scenarios** (`expectedIds` empty) must prove no activation:
 *   nothing activates, no kernel activates, and a `compose` over the scenario
 *   fails closed with an explicit empty-selection/unknown-harness error rather
 *   than a green result. A negative scenario with an expected kernel id is
 *   self-contradictory and rejected.
 * - **Coverage**: at least one positive scenario is required, so an all-empty
 *   manifest cannot pass by proving nothing.
 *
 * A degraded corpus, an unreadable or structurally malformed manifest, and an
 * empty scenario list all fail. Runtime empty-context behaviour is unchanged:
 * an empty corpus cannot reach composition here.
 */
export async function validateContent(root: string): Promise<{ files: number; documents: number; scenarios: number }> {
  const files = await loadContentFiles(root);
  const corpus = buildContentCorpus(files);
  if (!corpus.ok || corpus.degraded || !corpus.value.documents.length) throw new Error('content-invalid');
  const documents = corpus.value.documents;

  let raw: unknown;
  try {
    raw = await Bun.file(join(root, 'content/membership.manifest.json')).json();
  } catch {
    throw new Error('membership-manifest-unreadable');
  }
  const structural = validateMembershipManifest(raw);
  if (!structural.ok || structural.degraded) throw new Error('membership-manifest-malformed');
  const manifest = structural.value;
  const scenarios = [...manifest.scenarios];
  if (!scenarios.length) throw new Error('membership-empty');

  const positive = scenarios.filter((scenario) => scenario.expectedIds.length > 0);
  const negative = scenarios.filter((scenario) => scenario.expectedIds.length === 0);
  // Zero useful coverage: a manifest of only negative scenarios proves nothing.
  if (!positive.length) throw new Error('membership-no-positive-coverage');

  for (const scenario of positive) {
    // An activated kernel id is by definition also an activated id.
    if (scenario.expectedKernelIds.some((id) => !scenario.expectedIds.includes(id))) {
      throw new Error('membership-kernel-not-in-expected-ids');
    }
    if (scenario.expectedKernelIds.some((id) => !scenario.expectedStaticIds.includes(id))) {
      throw new Error('membership-kernel-not-in-static-prefix');
    }
    const evaluation = evaluateMembership({ ...manifest, scenarios: [scenario] }, documents);
    const result = evaluation.value.results[0];
    if (!evaluation.ok || evaluation.degraded || !result || !result.exact ||
        result.missingIds.length > 0 || result.extraIds.length > 0) {
      throw new Error('membership-positive-mismatch');
    }
  }

  for (const scenario of negative) {
    if (scenario.expectedKernelIds.length) throw new Error('membership-negative-expects-kernel');
    const event = { id: scenario.event, harness: scenario.harness };
    const state = { keys: [...(scenario.stateKeys ?? [])] };
    const activation = buildActivation(event, state, documents);
    if (!activation.value.empty || activation.value.ids.length || activation.value.kernelIds.length) {
      throw new Error('membership-negative-activated');
    }
    // Fail-closed compose: the negative scenario must not compose green, and its
    // refusal must name the activation failure rather than pass silently.
    const composed = compose(event, state, { documents, mustFireIds: [], mustFireKernelIds: [],
      mustFireStaticIds: scenario.expectedStaticIds });
    if (composed.ok) throw new Error('membership-negative-compose-green');
    if (!composed.errors.some((error) => NON_ACTIVATION_CODES.has(error.code))) {
      throw new Error('membership-negative-compose-silent');
    }
  }

  return { files: files.length, documents: documents.length, scenarios: scenarios.length };
}

export function verificationGates(): GateSpec[] {
  return [
    { name: 'typecheck', argv: [process.execPath, 'run', '--bun', 'tsc', '--noEmit'] },
    { name: 'tests', argv: [process.execPath, 'test', 'tests'], requireTests: true, timeoutMs: 300_000 },
    { name: 'architecture', argv: [process.execPath, 'scripts/check-architecture.ts'] },
    { name: 'public', argv: [process.execPath, 'scripts/verify.ts', '--public'] },
    { name: 'content', argv: [process.execPath, 'scripts/verify.ts', '--content'] },
  ];
}

if (import.meta.main) {
  const emit: Emit = frame => console.log(JSON.stringify(frame));
  if (!supportedBun(Bun.version)) {
    emit({ schema: 'aos.verify/v1', kind: 'summary', status: 'fail', reason: `stable Bun >= ${MIN_BUN} required` });
    process.exit(1);
  }
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--public') {
    try {
      // This wrapper validates the current source tree. Private-repository CI
      // can check out a provider-created pull-request merge commit whose
      // identity is outside the exported tree and cannot be made public-safe.
      // Export staging and the standalone public scanner still inspect history.
      const manifest = parsePublicExportManifest(await readFile(join(PROJECT_ROOT, 'public-export.manifest.json'), 'utf8'));
      const report = scanPublicRepo({ root: PROJECT_ROOT, skipHistory: true, includePaths: manifest.files });
      // Report evidence without echoing the checkout path or matched private data.
      emit({ schema: 'aos.public/v1', status: report.result, stats: report.stats,
        history: { state: report.history.state, commits: report.history.commits },
        rules: [...new Set([...report.findings, ...report.errors].map(finding => finding.ruleId))].sort() });
      process.exitCode = exitCodeFor(report);
    } catch {
      emit({ schema: 'aos.public/v1', status: 'fail', reason: 'public-scan-incomplete' });
      process.exitCode = 1;
    }
  } else if (args.length === 1 && args[0] === '--content') {
    try { emit({ schema: 'aos.content/v1', status: 'pass', ...await validateContent(PROJECT_ROOT) }); }
    catch { emit({ schema: 'aos.content/v1', status: 'fail', reason: 'content-or-membership-invalid' }); process.exitCode = 1; }
  } else if (args.length) {
    emit({ schema: 'aos.verify/v1', kind: 'summary', status: 'fail', reason: 'usage: bun scripts/verify.ts [--content|--public]' });
    process.exitCode = 1;
  } else {
    const gates = verificationGates();
    const results = await runGates(gates, emit);
    const ok = results.length === 5 && results.every(result => result.status === 'pass');
    emit({ schema: 'aos.verify/v1', kind: 'summary', status: ok ? 'pass' : 'fail', required: gates.length,
      passed: results.filter(result => result.status === 'pass').length, runtime: `Bun ${Bun.version}` });
    process.exitCode = ok ? 0 : 1;
  }
}
