#!/usr/bin/env bun
import { MIN_BUN, runCommand, supportedBun } from './verify.ts';

export function percentile(values: readonly number[], fraction: number): number {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0) ||
      !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) throw new Error('invalid-percentile-input');
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;
}

export interface BenchmarkOptions { samples: number; label: string; argv?: string[]; stdinFile?: string; mode: 'fresh' | 'rpc'; interventions: number }
export function benchmarkOptions(args: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = { samples: 30, label: 'runtime-only', mode: 'fresh', interventions: 0 };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) throw new Error('duplicate-option');
    seen.add(arg);
    const value = args[++i];
    if (!value) throw new Error('missing-option-value');
    if (arg === '--samples') {
      if (!/^\d+$/.test(value)) throw new Error('invalid-sample-count');
      options.samples = Number(value);
    } else if (arg === '--label') {
      if (!/^[a-z][a-z0-9-]{0,47}$/.test(value)) throw new Error('invalid-label');
      options.label = value;
    } else if (arg === '--command-json') {
      const argv: unknown = JSON.parse(value);
      if (!Array.isArray(argv) || !argv.length || argv.some(a => typeof a !== 'string' || a.includes('\0')) || !argv[0]) {
        throw new Error('invalid-command-argv');
      }
      options.argv = argv as string[];
    } else if (arg === '--stdin-file') options.stdinFile = value;
    else if (arg === '--mode') {
      if (!['fresh', 'rpc'].includes(value)) throw new Error('invalid-mode');
      options.mode = value as 'fresh' | 'rpc';
    } else if (arg === '--interventions') {
      if (!/^\d+$/.test(value)) throw new Error('invalid-interventions');
      options.interventions = Number(value);
    }
    else throw new Error('unknown-option');
  }
  if (!Number.isSafeInteger(options.samples) || options.samples < 20 || options.samples > 10_000) throw new Error('samples-must-be-20-to-10000');
  if (options.argv && options.label === 'runtime-only') throw new Error('cli-command-needs-label');
  if (!options.argv && (options.label !== 'runtime-only' || options.stdinFile)) throw new Error('runtime-options-conflict');
  if (options.mode === 'rpc' && (!options.argv || !options.stdinFile)) throw new Error('rpc-needs-command-and-operation');
  if (!Number.isSafeInteger(options.interventions) || options.interventions < 0 || options.interventions > 10_000) throw new Error('invalid-interventions');
  return options;
}

function contextTiers(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const object = value as Record<string, any>;
  return object.receipt?.byteTiers ?? object.result?.structuredContent?.receipt?.byteTiers;
}

async function benchmarkRpc(options: BenchmarkOptions, operationBytes: Uint8Array): Promise<Record<string, unknown>> {
  const operation = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(operationBytes)) as Record<string, unknown>;
  const child = Bun.spawn(options.argv!, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const writer = child.stdin;
  const reader = child.stdout.getReader();
  let pending = '';
  const nextLine = async (): Promise<string> => {
    while (true) {
      const split = pending.indexOf('\n');
      if (split >= 0) { const line = pending.slice(0, split); pending = pending.slice(split + 1); return line; }
      const chunk = await reader.read();
      if (chunk.done) throw new Error('rpc-ended-before-response');
      pending += new TextDecoder().decode(chunk.value, { stream: true });
    }
  };
  const send = async (value: unknown) => { writer.write(JSON.stringify(value) + '\n'); await writer.flush(); };
  await send({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'aos-benchmark', version: '1' } } });
  const initialized = JSON.parse(await nextLine());
  if (initialized.id !== 'init' || initialized.error) throw new Error('rpc-initialize-failed');
  await send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const timings: number[] = [], stdoutBytes: number[] = [];
  let byteTiers: unknown;
  try {
    for (let index = 0; index < options.samples; index++) {
      const request: Record<string, unknown> = { ...operation, requestId: `benchmark-${index}`, nonce: `benchmark-${index}` };
      const frame = { jsonrpc: '2.0', id: index, method: 'tools/call', params: { name: request.command, arguments: request } };
      const start = performance.now();
      await send(frame);
      const line = await nextLine();
      timings.push(performance.now() - start);
      stdoutBytes.push(Buffer.byteLength(line));
      const response = JSON.parse(line);
      if (response.error || response.result?.isError) throw new Error('rpc-operation-failed');
      byteTiers ??= contextTiers(response);
    }
  } finally {
    writer.end(); reader.releaseLock();
  }
  const stderr = await new Response(child.stderr).text();
  if (await child.exited !== 0 || stderr) throw new Error('rpc-child-incomplete-or-failed');
  return { schema: 'aos.benchmark/v1', status: 'complete', label: options.label, mode: 'rpc-amortized',
    runtime: `Bun ${Bun.version}`, platform: process.platform, arch: process.arch, samples: timings.length,
    elapsedMs: { p50: percentile(timings, 0.5), p95: percentile(timings, 0.95) },
    stdoutBytes: { p50: percentile(stdoutBytes, 0.5), p95: percentile(stdoutBytes, 0.95) },
    sourceInputBytes: operationBytes.byteLength, contextByteTiers: byteTiers, interventions: options.interventions,
    method: 'One persistent MCP stdio process; each sample measures one complete tools/call round trip after initialize.',
    caveat: 'OS caches and the runtime process are warm. This is amortized RPC latency, not cold CLI startup.' };
}

/** Each sample includes a new process, input consumption, output drain, and exit. */
export async function benchmark(options: BenchmarkOptions): Promise<Record<string, unknown>> {
  if (!supportedBun(Bun.version)) throw new Error(`stable Bun >= ${MIN_BUN} required`);
  const inputs = options.argv
    ? [options.stdinFile ? new Uint8Array(await Bun.file(options.stdinFile).arrayBuffer()) : new Uint8Array()]
    : [0, 4_096, 65_536, 262_144].map(bytes => new Uint8Array(bytes).fill(120));
  const argv = options.argv ?? [process.execPath, '-e', 'console.log(JSON.stringify({bytes:(await Bun.stdin.arrayBuffer()).byteLength}))'];
  if (options.mode === 'rpc') return benchmarkRpc(options, inputs[0]!);
  const tiers: Record<string, unknown>[] = [];
  for (const input of inputs) {
    const timings: number[] = [], stdoutBytes: number[] = [], stderrBytes: number[] = [];
    let byteTiers: unknown;
    for (let i = 0; i < options.samples; i++) {
      const result = await runCommand({ argv, stdin: input, timeoutMs: 30_000 });
      if (result.state !== 'complete' || result.exitCode !== 0) throw new Error('benchmark-child-incomplete-or-failed');
      if (!options.argv && JSON.parse(result.stdout).bytes !== input.byteLength) throw new Error('runtime-input-not-consumed');
      timings.push(result.durationMs);
      stdoutBytes.push(new TextEncoder().encode(result.stdout).byteLength);
      stderrBytes.push(new TextEncoder().encode(result.stderr).byteLength);
      try { byteTiers ??= contextTiers(JSON.parse(result.stdout)); } catch { /* generic runtime-only child */ }
    }
    tiers.push({ inputBytes: input.byteLength, samples: timings.length,
      elapsedMs: { p50: percentile(timings, 0.5), p95: percentile(timings, 0.95) },
      stdoutBytes: { p50: percentile(stdoutBytes, 0.5), p95: percentile(stdoutBytes, 0.95) },
      stderrBytes: { p50: percentile(stderrBytes, 0.5), p95: percentile(stderrBytes, 0.95) }, contextByteTiers: byteTiers });
  }
  return { schema: 'aos.benchmark/v1', status: 'complete', label: options.label,
    mode: options.argv ? 'fresh-cli' : 'runtime-only', runtime: `Bun ${Bun.version}`,
    platform: process.platform, arch: process.arch, tiers,
    interventions: options.interventions,
    method: 'Fresh process per sample; includes spawn, stdin, pipe draining, and child exit. Nearest-rank percentiles.',
    caveat: 'OS caches may be warm. CLI success is exit-status evidence only; validate behavior separately. No legacy speedup claim.' };
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await benchmark(benchmarkOptions(process.argv.slice(2))), null, 2)); }
  catch {
    console.log(JSON.stringify({ schema: 'aos.benchmark/v1', status: 'incomplete',
      reason: 'invalid-options-runtime-or-child-failure',
      usage: 'bun scripts/benchmark.ts [--samples 30] [--label NAME --command-json JSON_ARRAY [--stdin-file FILE] [--mode fresh|rpc] [--interventions N]]' }));
    process.exitCode = 1;
  }
}
