#!/usr/bin/env bun
import { MIN_BUN, runCommand, supportedBun } from './verify.ts';

export function percentile(values: readonly number[], fraction: number): number {
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0) ||
      !Number.isFinite(fraction) || fraction <= 0 || fraction > 1) throw new Error('invalid-percentile-input');
  return [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1]!;
}

export interface BenchmarkOptions { samples: number; label: string; argv?: string[]; stdinFile?: string }
export function benchmarkOptions(args: string[]): BenchmarkOptions {
  const options: BenchmarkOptions = { samples: 30, label: 'runtime-only' };
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
    else throw new Error('unknown-option');
  }
  if (!Number.isSafeInteger(options.samples) || options.samples < 20 || options.samples > 10_000) throw new Error('samples-must-be-20-to-10000');
  if (options.argv && options.label === 'runtime-only') throw new Error('cli-command-needs-label');
  if (!options.argv && (options.label !== 'runtime-only' || options.stdinFile)) throw new Error('runtime-options-conflict');
  return options;
}

/** Each sample includes a new process, input consumption, output drain, and exit. */
export async function benchmark(options: BenchmarkOptions): Promise<Record<string, unknown>> {
  if (!supportedBun(Bun.version)) throw new Error(`stable Bun >= ${MIN_BUN} required`);
  const inputs = options.argv
    ? [options.stdinFile ? new Uint8Array(await Bun.file(options.stdinFile).arrayBuffer()) : new Uint8Array()]
    : [0, 4_096, 65_536, 262_144].map(bytes => new Uint8Array(bytes).fill(120));
  const argv = options.argv ?? [process.execPath, '-e', 'console.log(JSON.stringify({bytes:(await Bun.stdin.arrayBuffer()).byteLength}))'];
  const tiers: Record<string, unknown>[] = [];
  for (const input of inputs) {
    const timings: number[] = [], stdoutBytes: number[] = [], stderrBytes: number[] = [];
    for (let i = 0; i < options.samples; i++) {
      const result = await runCommand({ argv, stdin: input, timeoutMs: 30_000 });
      if (result.state !== 'complete' || result.exitCode !== 0) throw new Error('benchmark-child-incomplete-or-failed');
      if (!options.argv && JSON.parse(result.stdout).bytes !== input.byteLength) throw new Error('runtime-input-not-consumed');
      timings.push(result.durationMs);
      stdoutBytes.push(new TextEncoder().encode(result.stdout).byteLength);
      stderrBytes.push(new TextEncoder().encode(result.stderr).byteLength);
    }
    tiers.push({ inputBytes: input.byteLength, samples: timings.length,
      elapsedMs: { p50: percentile(timings, 0.5), p95: percentile(timings, 0.95) },
      stdoutBytes: { p50: percentile(stdoutBytes, 0.5), p95: percentile(stdoutBytes, 0.95) },
      stderrBytes: { p50: percentile(stderrBytes, 0.5), p95: percentile(stderrBytes, 0.95) } });
  }
  return { schema: 'aos.benchmark/v1', status: 'complete', label: options.label,
    mode: options.argv ? 'cli-command' : 'runtime-only', runtime: `Bun ${Bun.version}`,
    platform: process.platform, arch: process.arch, tiers,
    method: 'Fresh process per sample; includes spawn, stdin, pipe draining, and child exit. Nearest-rank percentiles.',
    caveat: 'OS caches may be warm. CLI success is exit-status evidence only; validate behavior separately. No legacy speedup claim.' };
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await benchmark(benchmarkOptions(process.argv.slice(2))), null, 2)); }
  catch {
    console.log(JSON.stringify({ schema: 'aos.benchmark/v1', status: 'incomplete',
      reason: 'invalid-options-runtime-or-child-failure',
      usage: 'bun scripts/benchmark.ts [--samples 30] [--label hook --command-json JSON_ARRAY [--stdin-file FILE]]' }));
    process.exitCode = 1;
  }
}
