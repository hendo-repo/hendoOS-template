#!/usr/bin/env bun
import { constants } from 'node:fs';
import { mkdir, open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CodexHookConfigSchema, codexHookReply, observeCodexEvent } from '../protocols/codex-harness';

async function boundedStdin(): Promise<string> {
  const reader = Bun.stdin.stream().getReader(), chunks: Uint8Array[] = []; let total = 0;
  try { while (true) { const part = await reader.read(); if (part.done) break; total += part.value.length;
    if (total > 256 * 1024) throw new Error('input-limit'); chunks.push(part.value); } }
  finally { reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

async function writeReceipt(root: string, event: unknown, observation: ReturnType<typeof observeCodexEvent>): Promise<string> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const id = crypto.randomUUID(), path = join(root, `${id}.json`);
  const input = event as { session_id?: unknown; turn_id?: unknown; tool_use_id?: unknown };
  const receipt = { schema: 'hendoos.codex-hook-receipt/v1', id, observedAt: new Date().toISOString(),
    sessionId: typeof input.session_id === 'string' ? input.session_id : null,
    turnId: typeof input.turn_id === 'string' ? input.turn_id : null,
    toolUseId: typeof input.tool_use_id === 'string' ? input.tool_use_id : null, observation };
  const file = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  try { await file.writeFile(JSON.stringify(receipt, null, 2) + '\n'); await file.sync(); } finally { await file.close(); }
  return id;
}

export async function main(args: string[]): Promise<number> {
  if (args.length !== 2 || args[0] !== '--config') { await Bun.stderr.write('Usage: codex-hook --config <path>\n'); return 2; }
  try {
    const config = CodexHookConfigSchema.parse(JSON.parse(await readFile(args[1]!, 'utf8')));
    const event = JSON.parse(await boundedStdin());
    const observation = observeCodexEvent(event, config);
    const receiptId = await writeReceipt(config.receiptRoot, event, observation);
    const reply = codexHookReply(observation);
    await Bun.stdout.write(reply.stdout);
    if (observation.verdict === 'indeterminate') await Bun.stderr.write(`hendoOS observation indeterminate; receipt ${receiptId}.\n`);
    return reply.exitCode;
  } catch {
    const reply = codexHookReply(); await Bun.stdout.write(reply.stdout);
    await Bun.stderr.write('hendoOS hook unavailable; no permission decision emitted.\n'); return reply.exitCode;
  }
}

if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
