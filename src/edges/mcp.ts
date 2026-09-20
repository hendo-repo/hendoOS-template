/** Newline-delimited MCP stdio; all diagnostics belong on stderr. */
import { z } from 'zod';
import { OperationSchema } from '../schema/operation';
import { JsonValueSchema } from '../protocols/validation';
import { RuntimeService, MAX_INPUT_BYTES, MAX_OUTPUT_BYTES } from '../protocols/service';
const RpcId = z.union([z.string().max(128), z.number().int()]);
const Message = z.strictObject({ jsonrpc: z.literal('2.0'), id: RpcId.optional(), method: z.string().min(1).max(128), params: z.record(z.string(), JsonValueSchema).optional() });
const Initialize = z.object({ protocolVersion: z.literal('2025-06-18'), capabilities: z.record(z.string(), JsonValueSchema), clientInfo: z.object({ name: z.string(), version: z.string() }) });
const emptyParams = z.strictObject({});
const commands = ['orient', 'gate', 'closeout', 'reference'] as const;
export async function serve(service: RuntimeService, input: ReadableStream<Uint8Array> = Bun.stdin.stream(), output: (text: string) => Promise<unknown> = text => Bun.stdout.write(text)): Promise<number> {
  let initialized = false;
  let ready = false;
  let failed = false;
  let count = 0;
  const pending = new Map<string | number, { abort: AbortController; promise: Promise<void> }>();
  const send = async (body: unknown) => {
    const text = JSON.stringify(body) + '\n';
    if (Buffer.byteLength(text) > MAX_OUTPUT_BYTES * 2 + 65536) throw new Error('RPC output limit exceeded');
    await output(text);
  };
  const error = async (id: string | number | null, code: number, message: string) => {
    failed = true;
    await send({ jsonrpc: '2.0', id, error: { code, message } });
  };
  const result = (id: string | number, value: unknown) => send({ jsonrpc: '2.0', id, result: value });
  async function dispatch(line: string): Promise<void> {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { await error(null, -32700, 'Parse error'); return; }
    const parsed = Message.safeParse(raw);
    if (!parsed.success) { await error(null, -32600, 'Invalid Request'); return; }
    const message = parsed.data;
    if (message.id === undefined) {
      if (message.method === 'notifications/initialized' && initialized) ready = true;
      if (message.method === 'notifications/cancelled') {
        const cancellation = z.object({ requestId: RpcId }).safeParse(message.params);
        if (cancellation.success) pending.get(cancellation.data.requestId)?.abort.abort();
      }
      return; // Notifications, including unknown ones, never receive responses.
    }
    const { id, method } = message;
    const params = message.params ?? {};
    if (pending.has(id)) { await error(id, -32600, 'Request ID already in flight'); return; }
    if (method === 'initialize') {
      const init = Initialize.safeParse(params);
      if (initialized || !init.success) { await error(id, -32602, 'Invalid initialize parameters or protocol version'); return; }
      const experimental = init.data.capabilities.experimental;
      const aos = experimental && typeof experimental === 'object' && !Array.isArray(experimental) ? experimental.aos : undefined;
      if (aos !== undefined) {
        const handshake = z.strictObject({ version: z.literal(1), schemaVersion: z.literal(1), composeVersion: z.literal(1),
          contentGeneration: z.literal(service.handshake.contentGeneration), sourceRevision: z.literal(service.handshake.sourceRevision) }).safeParse(aos);
        if (!handshake.success) { await error(id, -32602, 'AOS version/content handshake mismatch'); return; }
      }
      initialized = true;
      await result(id, { protocolVersion: '2025-06-18', capabilities: { tools: {}, resources: {}, experimental: { aos: service.handshake } },
        serverInfo: { name: 'aos-shadow-runtime', version: '0.1.0' }, instructions: 'PROVISIONAL shadow results. No live enforcement.' });
      return;
    }
    if (method === 'ping') { await result(id, {}); return; }
    if (!ready) { await error(id, -32002, 'Server not initialized'); return; }
    if (method === 'tools/list') {
      if (!emptyParams.safeParse(params).success) { await error(id, -32602, 'Invalid params'); return; }
      const schema = z.toJSONSchema(OperationSchema, { unrepresentable: 'any' });
      await result(id, { tools: commands.map(name => ({ name, description: `Provisional ${name} operation through the shared core`,
        inputSchema: { ...schema, properties: { ...schema.properties, command: { const: name, type: 'string' } } } })) });
    } else if (method === 'resources/list') {
      if (!emptyParams.safeParse(params).success) { await error(id, -32602, 'Invalid params'); return; }
      await result(id, { resources: service.resources });
    } else if (method === 'resources/read') {
      const read = z.strictObject({ uri: z.string().max(256) }).safeParse(params);
      const text = read.success ? service.readResource(read.data.uri) : undefined;
      if (text === undefined || !read.success) { await error(id, -32602, 'Unknown reference URI'); return; }
      await result(id, { contents: [{ uri: read.data.uri, mimeType: 'text/markdown', text }] });
    } else if (method === 'tools/call') {
      const call = z.strictObject({ name: z.enum(commands), arguments: JsonValueSchema }).safeParse(params);
      if (!call.success || !OperationSchema.safeParse(call.data.arguments).success || (call.data.arguments as { command: string }).command !== call.data.name) {
        await error(id, -32602, 'Invalid tool arguments'); return;
      }
      if (pending.size >= 16) { await error(id, -32000, 'Too many in-flight operations'); return; }
      const abort = new AbortController();
      const promise = service.execute(call.data.arguments, { signal: abort.signal }).then(async outcome => {
        if (outcome.status !== 'complete') failed = true;
        await result(id, { content: [{ type: 'text', text: JSON.stringify(outcome) }], structuredContent: outcome, isError: outcome.status !== 'complete' });
      }).catch(async () => { await error(id, -32603, 'Internal error'); }).finally(() => { pending.delete(id); });
      pending.set(id, { abort, promise });
    } else await error(id, -32601, 'Method not found');
  }
  const reader = input.getReader();
  let buffer = new Uint8Array(0);
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      const merged = new Uint8Array(buffer.length + chunk.value.length);
      merged.set(buffer); merged.set(chunk.value, buffer.length);
      let start = 0;
      for (let offset = 0; offset < merged.length; offset++) {
        if (merged[offset] !== 10) continue;
        if (offset - start > MAX_INPUT_BYTES || ++count > 10000) { await error(null, -32600, 'Connection input limit exceeded'); await reader.cancel(); return 1; }
        const bytes = merged.subarray(start, offset);
        start = offset + 1;
        let line: string;
        try { line = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
        catch { await error(null, -32700, 'Invalid UTF-8 JSON frame'); continue; }
        try { await dispatch(line); }
        catch { await error(null, -32603, 'Internal error'); }
      }
      buffer = merged.slice(start);
      if (buffer.length > MAX_INPUT_BYTES) { await error(null, -32600, 'Frame input limit exceeded'); await reader.cancel(); return 1; }
    }
    if (buffer.length) await error(null, -32700, 'Unterminated JSON frame');
    await Promise.all([...pending.values()].map(p => p.promise));
    return failed ? 1 : 0;
  } finally {
    for (const p of pending.values()) p.abort.abort();
    await Promise.all([...pending.values()].map(p => p.promise));
    reader.releaseLock();
  }
}
