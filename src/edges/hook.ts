/** One bounded native request, translated by the protocol into the shared service. */
import { dirname } from 'node:path';
import { lstat, realpath } from 'node:fs/promises';
import { HookConfigSchema, nativeOperation, hookReply } from '../protocols/harness';
import { RuntimeService, MAX_INPUT_BYTES } from '../protocols/service';
import { StateStore } from '../state/store';
import { loadContent, readBoundedFile } from './content';
import { validateRoots } from '../effects/paths';

async function input(deadline: number): Promise<unknown> {
  const reader = Bun.stdin.stream().getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let expired = false;
  const timer = setTimeout(() => { expired = true; void reader.cancel(); }, Math.max(1, deadline - performance.now()));
  try {
    while (true) {
      const part = await reader.read();
      if (expired) throw new Error('input deadline');
      if (part.done) break;
      length += part.value.byteLength;
      if (length > MAX_INPUT_BYTES) throw new Error('input limit');
      chunks.push(part.value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { clearTimeout(timer); await reader.cancel(); reader.releaseLock(); }
}

/**
 * Read-only shadow observer for one bounded native `PreToolUse` request.
 *
 * Non-disruptive contract: this process never permits, denies, asks, or blocks
 * the observed tool. It evaluates the shared `RuntimeService` against explicit
 * synthetic observations, reports `would-allow` / `would-deny` /
 * `indeterminate` as a diagnostic, and exits `0` only when the shadow run
 * completed — an incomplete run exits `1`, never the vendor's blocking `2`.
 * Failures are reported honestly — stderr plus an `indeterminate` verdict — and
 * never converted into a permission or a refusal. The vendor's blocking exit `2`
 * is not used anywhere in this file.
 */
export async function main(args: string[]): Promise<number> {
  let state: StateStore | undefined;
  // Covers setup and input wait too; the synchronous core remains cooperative.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    if (args.length !== 2 || args[0] !== '--config') throw new Error('explicit config required');
    const configPath = args[1]!;
    if (await realpath(configPath) !== configPath) throw new Error('config alias');
    const config = HookConfigSchema.parse(JSON.parse(await readBoundedFile(configPath)));
    const deadline = performance.now() + config.timeoutMs;
    const abort = new AbortController();
    timer = setTimeout(() => abort.abort(), config.timeoutMs);
    const separation = await validateRoots(dirname(config.statePath), config.contentRoot);
    if (!separation.ok || !(await validateRoots(dirname(config.statePath), dirname(configPath))).ok) throw new Error('state separation');
    // A state symlink (including SQLite sidecars) is not an isolated state file.
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { const s = await lstat(config.statePath + suffix); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1) throw new Error('state alias'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    const operation = nativeOperation(await input(deadline), config);
    const content = await loadContent(config.contentRoot);
    if (performance.now() >= deadline) abort.abort();
    state = new StateStore(config.statePath);
    const service = new RuntimeService({ state, content, config: config.ownerPolicy });
    const result = await service.execute(operation, { signal: abort.signal });
    const reply = hookReply(result);
    // Incomplete shadow runs stay visible without changing the host's decision.
    if (result.status !== 'complete') await Bun.stderr.write(`AOS shadow ${result.status}; no decision emitted.\n`);
    await Bun.stdout.write(reply.stdout);
    return reply.exitCode;
  } catch {
    const reply = hookReply();
    await Bun.stderr.write('AOS shadow unavailable (input, assets, or runtime); no decision emitted.\n');
    await Bun.stdout.write(reply.stdout);
    return reply.exitCode;
  } finally { if (timer) clearTimeout(timer); state?.close(); }
}
if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
