#!/usr/bin/env bun
import { z } from 'zod';
import { catalogSkills, renderSkills } from '../effects/skills';
import { auditKnowledge, generateKnowledgeIndexes, publishKnowledgeIndexes, readKnowledgeNote, recallKnowledge, recordRecallFeedback } from '../effects/knowledge';
import { runCloseout } from '../effects/closeout';

const absolute = z.string().min(1).max(4096).refine(value => value.startsWith('/'));
const request = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('skills-catalog'), root: absolute }),
  z.strictObject({ action: z.literal('skills-render'), root: absolute, target: absolute, harness: z.enum(['codex', 'hermes']) }),
  z.strictObject({ action: z.literal('knowledge-audit'), root: absolute }),
  z.strictObject({ action: z.literal('recall'), root: absolute, request: z.unknown() }),
  z.strictObject({ action: z.literal('read-note'), root: absolute, id: z.string(), digest: z.string() }),
  z.strictObject({ action: z.literal('recall-feedback'), request: z.unknown() }),
  z.strictObject({ action: z.literal('indexes-publish'), root: absolute, output: absolute, pageSize: z.number().int().optional() }),
  z.strictObject({ action: z.literal('closeout'), root: absolute, state: absolute, request: z.unknown() }),
]);

async function boundedStdin(): Promise<string> {
  const reader = Bun.stdin.stream().getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.length;
      if (total > 1024 * 1024) throw new Error('request-limit');
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export async function executeWorkingLoop(input: unknown): Promise<object> {
  const parsed = request.parse(input);
  if (parsed.action === 'skills-catalog') return catalogSkills(parsed.root);
  if (parsed.action === 'skills-render') return renderSkills(parsed.root, parsed.target, parsed.harness);
  if (parsed.action === 'knowledge-audit') return auditKnowledge(parsed.root);
  if (parsed.action === 'recall') return recallKnowledge(await auditKnowledge(parsed.root), parsed.request);
  if (parsed.action === 'read-note') return readKnowledgeNote(await auditKnowledge(parsed.root), parsed.id, parsed.digest);
  if (parsed.action === 'recall-feedback') return recordRecallFeedback(parsed.request as never);
  if (parsed.action === 'indexes-publish') {
    const generated = generateKnowledgeIndexes(await auditKnowledge(parsed.root), parsed.pageSize);
    return publishKnowledgeIndexes(parsed.output, generated);
  }
  return runCloseout(parsed.root, parsed.state, parsed.request);
}

export async function main(args: string[]): Promise<number> {
  if (args.length || process.stdin.isTTY) {
    await Bun.stderr.write('Usage: JSON request on stdin.\n'); return 2;
  }
  try {
    const value = JSON.parse(await boundedStdin());
    await Bun.stdout.write(JSON.stringify(await executeWorkingLoop(value)) + '\n');
    return 0;
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'working-loop-failed';
    await Bun.stdout.write(JSON.stringify({ schema: 'hendoos.working-loop/v1', status: 'incomplete', reason }) + '\n');
    return 1;
  }
}

if (import.meta.main) process.exitCode = await main(Bun.argv.slice(2));
