#!/usr/bin/env bun
/** Source-checkout management boundary. All artifact writes belong to effects. */
import { z } from 'zod';
import { AbsolutePathSchema, HookConfigSchema, HARNESS_PROTOCOL } from '../protocols/harness';
import { JsonValueSchema } from '../protocols/validation';
import { InstallManifestSchema, isInstallPath } from '../schema/install';
import { renderHarness, type RenderOptions } from '../effects/render';
import { install, uninstall, recoverInstall } from '../effects/install';
import { checkDrift } from '../effects/drift';
import { inspectCompatibility } from '../effects/doctor';
import { loadContent, readBoundedFile, MAX_SOURCE_BYTES } from './content';

const owner = z.string().refine(value => value.trim().length > 0);
const generation = z.int().positive();
const target = { targetRoot: AbsolutePathSchema, owner };
const manifest = { sourceRoot: AbsolutePathSchema, ...target, manifest: InstallManifestSchema,
  expectedGeneration: generation.optional() };
const schemas = {
  install: z.strictObject({ ...manifest, stageRoot: AbsolutePathSchema,
    modes: z.record(z.string().refine(isInstallPath), z.int().min(0).max(0o777)
      .refine(mode => (mode & 0o400) !== 0)).optional() }),
  uninstall: z.strictObject({ ...target, expectedGeneration: generation.optional() }),
  recover: z.strictObject({ ...target, assumeDead: z.boolean().optional() }),
  drift: z.strictObject({ ...manifest, expectedSourceRevision: z.string().min(1).max(256).optional(),
    targetName: z.string().min(1).max(128).optional() }),
  doctor: z.strictObject({ contentRoot: AbsolutePathSchema, config: HookConfigSchema.optional(),
    targetRoot: AbsolutePathSchema.optional() }),
};
const commands = ['render', 'install', 'uninstall', 'recover', 'drift', 'doctor'];
const help = {
  usage: 'bun src/edges/manage.ts COMMAND [--request FILE] [--input-timeout-ms 1..30000]',
  commands, protocol: HARNESS_PROTOCOL,
  input: 'One strict JSON options object from FILE or stdin through EOF; 256 KiB maximum; default input deadline 5000 ms.',
  output: 'One JSON value, including help and errors. Diagnostics use stderr.',
  requestFields: {
    render: ['sourceRoot', 'stageRoot', 'targetRoot', 'statePath', 'bunPath', 'owner', 'generation', 'config'],
    install: ['sourceRoot', 'stageRoot', 'targetRoot', 'owner', 'manifest', 'modes?', 'expectedGeneration?'],
    uninstall: ['targetRoot', 'owner', 'expectedGeneration?'],
    recover: ['targetRoot', 'owner', 'assumeDead?'],
    drift: ['sourceRoot', 'targetRoot', 'owner', 'manifest', 'expectedGeneration?', 'expectedSourceRevision?', 'targetName?'],
    doctor: ['contentRoot', 'config?', 'targetRoot?'],
  },
  limits: ['Explicit absolute paths; no home discovery.', 'Render stages only; inspect its manifest before a separate install.',
    'No test failpoints or force option. Recovery ignores PID diagnostics only with explicit assumeDead: true.',
    'Input deadline does not cancel effects after input is read.',
    'Doctor reads content and optional inline hook configuration; it does not test live harnesses or operational state.',
    'Uninstall retains separate operational state and the stable installer coordination file.'],
  exitCodes: { '0': 'Completed effect, clean drift, or supplied doctor checks complete.',
    '1': 'Invalid, refused, partial, rolled-back, interrupted, drifted or indeterminate.' },
};

async function readInput(file: string | undefined, timeout: number): Promise<string> {
  const reader = file === undefined ? Bun.stdin.stream().getReader() : undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const reading = file !== undefined ? readBoundedFile(file, MAX_SOURCE_BYTES) : (async () => {
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      while (true) {
        const chunk = await reader!.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > MAX_SOURCE_BYTES) throw new Error('input byte limit');
        chunks.push(chunk.value);
      }
      return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    })();
    return await Promise.race([reading, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('input deadline')), timeout);
    })]);
  } finally {
    clearTimeout(timer);
    if (reader) { await reader.cancel(); reader.releaseLock(); }
  }
}

export async function main(args: string[]): Promise<number> {
  try {
    if (args.length === 1 && args[0] === '--help') {
      await Bun.stdout.write(JSON.stringify(help) + '\n'); return 0;
    }
    const command = args[0];
    if (!command || !commands.includes(command)) throw new Error('unknown command');
    const flags = new Map<string, string>();
    for (let i = 1; i < args.length; i += 2) {
      const key = args[i]!; const value = args[i + 1];
      if (!['--request', '--input-timeout-ms'].includes(key) || !value ||
          value.startsWith('--') || flags.has(key)) throw new Error('invalid options');
      flags.set(key, value);
    }
    const time = flags.get('--input-timeout-ms') ?? '5000';
    if (!/^[1-9][0-9]*$/.test(time) || Number(time) > 30000) throw new Error('invalid deadline');
    const file = flags.get('--request');
    if (file !== undefined) AbsolutePathSchema.parse(file);
    const input: unknown = JSON.parse(await readInput(file, Number(time)));
    JsonValueSchema.parse(input);
    let result: unknown;
    let complete = false;
    switch (command) {
      case 'render':
        // The renderer owns and strictly validates its options schema.
        result = await renderHarness(input as RenderOptions); complete = true; break;
      case 'install': {
        const report = await install(schemas.install.parse(input)); result = report;
        complete = ['installed', 'unchanged'].includes(report.status) && !report.recoveryRequired; break;
      }
      case 'uninstall': {
        const report = await uninstall(schemas.uninstall.parse(input)); result = report;
        complete = ['removed', 'unchanged'].includes(report.status) && !report.recoveryRequired; break;
      }
      case 'recover': {
        const report = await recoverInstall(schemas.recover.parse(input)); result = report;
        complete = ['recovered', 'unchanged'].includes(report.status) && !report.recoveryRequired; break;
      }
      case 'drift': {
        const report = await checkDrift(schemas.drift.parse(input)); result = report;
        complete = report.status === 'clean' && report.skipped === 0; break;
      }
      case 'doctor': {
        const options = schemas.doctor.parse(input);
        const content = await loadContent(options.contentRoot);
        const config = options.config;
        if (config && (config.contentGeneration !== content.generation || config.contentRoot !== options.contentRoot ||
            (config.ownerPolicy && (config.ownerPolicy.revision !== config.configRevision ||
             config.ownerPolicy.checkerRevision !== config.checkerRevision)))) throw new Error('configuration mismatch');
        const compatibility = options.targetRoot ? await inspectCompatibility(options.targetRoot) : 'not-requested';
        result = { status: 'complete', scope: 'read-only runtime/content/config/compatibility diagnostics',
          runtime: { name: 'Bun', version: Bun.version, platform: process.platform, arch: process.arch },
          content: { generation: content.generation, documents: content.documents.length, digest: content.digest },
          config: config ? 'validated' : 'not-requested', compatibility,
          unchecked: ['live harness', 'operational state', 'target ownership', 'runtime executable availability', 'system health'],
          provisional: true, enforcement: false };
        complete = true; break;
      }
    }
    await Bun.stdout.write(JSON.stringify(result) + '\n');
    return complete ? 0 : 1;
  } catch {
    await Bun.stderr.write('AOS management request failed: invalid input or unavailable operation.\n');
    await Bun.stdout.write(JSON.stringify({ status: 'refused', error: { code: 'management-failed',
      message: 'Invalid input or unavailable operation; inspect staged files and effect evidence before retrying.' } }) + '\n');
    return 1;
  }
}
if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
