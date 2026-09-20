/** Shared runtime: edges supply explicit input; the existing pure core makes decisions. */
import { compose, type ComposedPayload } from '../compose/index';
import { evaluatePolicy, type PolicyVerdict } from '../policy/index';
import { OperationSchema, OwnerConfigSchema, type Operation, type OwnerConfig, type RuntimeObservation } from '../schema/operation';
import { digestOfJson, digestOfString, type Json } from './json';
import { JsonValueSchema, safeParse } from './validation';
import type { Outcome } from './outcome';
import type { LoadedContent } from '../edges/content';
import { StateStore, StateConflict, ReplayInterrupted } from '../state/store';
export const MAX_INPUT_BYTES = 262144;
export const MAX_OUTPUT_BYTES = 1048576;
export const DEFAULT_CONFIG: OwnerConfig = {
  version: 1, revision: 'aos-runtime-default/1', checkerRevision: 'aos-policy/1',
  totalByteBudget: 65536, gateFailure: 'closed',
  rules: [{ id: 'explicit-verification', decision: 'allow', requires: ['verification'], when: { observation: 'verification', equals: true } }],
};
export interface ClockAdapter { timestamp(): string; monotonic(): number }
export interface Receipt {
  version: 1; requestId: string; sessionId: string; ownerId: string; nonce: string;
  requestDigest: string; payloadHash: string; schemaVersion: number; composeVersion: number;
  contentGeneration: number; contentDigest: string; subjectDigest: string; configRevision: string;
  configDigest: string; checkerRevision: string; timestamp: string;
  byteTiers: { kernel: number; reference: number; framework: number; total: number };
  gateVerdict: 'allow' | 'deny' | 'indeterminate'; provisional: true;
}
export interface RuntimeOutcome {
  status: 'complete' | 'incomplete' | 'refused'; provisional: true; enforcement: false;
  reason: string | null; observations: RuntimeObservation[];
  core: { composition: Outcome<ComposedPayload>; policy: Outcome<PolicyVerdict> } | null;
  receipt: Receipt | null;
}
function refused(reason: string): RuntimeOutcome {
  return { status: 'refused', provisional: true, enforcement: false, reason, observations: [], core: null, receipt: null };
}
export class RuntimeService {
  private content: LoadedContent;
  private config: OwnerConfig;
  private clock: ClockAdapter;
  private state: StateStore;
  constructor(options: { state: StateStore; content: LoadedContent; config?: unknown; clock?: ClockAdapter }) {
    this.state = options.state;
    this.content = structuredClone(options.content);
    this.config = OwnerConfigSchema.parse(options.config ?? DEFAULT_CONFIG);
    this.clock = options.clock ?? { timestamp: () => new Date().toISOString(), monotonic: () => performance.now() };
  }
  get handshake() { return { version: 1, schemaVersion: 1, composeVersion: 1, contentGeneration: this.content.generation, contentDigest: this.content.digest }; }
  get resources() {
    return this.content.documents.filter(d => d.tier === 'reference').map(d => ({ uri: `aos://reference/${d.id}`, name: d.id, mimeType: 'text/markdown' }));
  }
  /** Resource discovery never loads prose into the operation output. Read explicitly on demand. */
  readResource(uri: string): string | undefined {
    const resource = this.resources.find(r => r.uri === uri);
    return resource ? this.content.documents.find(d => d.id === resource.name)?.body : undefined;
  }
  async execute(input: unknown, options: { signal?: AbortSignal } = {}): Promise<RuntimeOutcome> {
    const start = this.clock.monotonic();
    const json = safeParse(JsonValueSchema, input);
    if (!json.success) return refused('operation must be plain JSON');
    if (Buffer.byteLength(JSON.stringify(json.data)) > MAX_INPUT_BYTES) return refused('operation input limit exceeded');
    const parsed = safeParse(OperationSchema, input);
    if (!parsed.success) return refused('invalid operation envelope or unauthorized configuration');
    const op = parsed.data;
    if (op.contentGeneration !== this.content.generation || op.configRevision !== this.config.revision || op.checkerRevision !== this.config.checkerRevision) return refused('version/generation/config handshake mismatch');
    const scenario = this.content.membership.scenarios.find(s => s.id === op.scenarioId);
    if (!scenario || scenario.harness !== 'default') return refused('unknown generic scenario');
    if (op.command === 'reference' && !this.content.documents.some(d => d.id === op.referenceId && d.tier === 'reference')) return refused('unknown reference');
    if (op.projectConfig?.totalByteBudget !== undefined && op.projectConfig.totalByteBudget > this.config.totalByteBudget) return refused('project budget exceeds owner ceiling');
    const configDigest = digestOfJson({ owner: this.config, project: op.projectConfig ?? {} } as unknown as Json);
    const requestDigest = digestOfJson(json.data);
    // Let an edge's queued cancellation reach this operation before synchronous core work.
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    const expired = () => options.signal?.aborted || this.clock.monotonic() - start >= op.timeoutMs;
    try {
      return this.state.transact(op.ownerId, op.sessionId, op.requestId, requestDigest, {
        generation: this.content.generation, contentDigest: this.content.digest, configRevision: op.configRevision,
        configDigest, checkerRevision: op.checkerRevision,
      }, () => {
        let core: RuntimeOutcome['core'] = null;
        let reason: string | null = null;
        const observations = op.observations.map(observation => {
          const p = observation.provenance;
          return p.subjectDigest === op.subjectDigest && p.configRevision === op.configRevision && p.checkerRevision === op.checkerRevision
            ? observation : { ...observation, status: 'incomplete' as const };
        });
        if (expired()) reason = options.signal?.aborted ? 'cancelled' : 'deadline exceeded';
        else {
          const event = { id: scenario.event, harness: 'default' };
          const state = { keys: [...(scenario.stateKeys ?? [])], referenceIds: op.referenceId ? [op.referenceId] : [] };
          const composition = compose(event, state, { documents: this.content.documents,
            totalByteBudget: op.projectConfig?.totalByteBudget ?? this.config.totalByteBudget,
            mustFireIds: scenario.expectedIds, mustFireKernelIds: scenario.expectedKernelIds });
          const policy = evaluatePolicy(event, { subjectDigest: op.subjectDigest, observations: observations.map(o => ({
            key: o.key, status: o.status === 'empty' || o.status === 'incomplete' ? 'unavailable' : o.status,
            ...(o.value === undefined ? {} : { value: o.value }),
          })) }, this.config.rules, { configRevision: op.configRevision, checkerRevision: op.checkerRevision });
          core = { composition, policy };
          if (expired()) { reason = options.signal?.aborted ? 'cancelled' : 'deadline exceeded'; core = null; }
          else if (!composition.ok || composition.degraded) reason = 'composition incomplete';
          else if (!observations.length || observations.some(o => o.status !== 'fresh') || policy.value.decision === 'indeterminate') reason = 'observations or policy incomplete';
        }
        let result: RuntimeOutcome = { status: reason ? 'incomplete' : 'complete', provisional: true, enforcement: false,
          reason, observations, core, receipt: null };
        if (Buffer.byteLength(JSON.stringify(result)) > MAX_OUTPUT_BYTES - 4096) {
          result = { ...result, status: 'incomplete', reason: 'output limit exceeded', core: null };
        }
        const timestamp = this.clock.timestamp();
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) throw new Error('invalid timestamp adapter');
        result.receipt = this.receipt(op, result, requestDigest, configDigest, timestamp);
        return result;
      }, () => !expired());
    } catch (error) {
      if (error instanceof ReplayInterrupted) return { ...refused(error.message), status: 'incomplete', observations: op.observations };
      return refused(error instanceof StateConflict ? error.message : 'runtime state or adapter unavailable');
    }
  }
  private receipt(op: Operation, result: RuntimeOutcome, requestDigest: string, configDigest: string, timestamp: string): Receipt {
    const payload = result.core?.composition.value.payload;
    const tiers = { kernel: 0, reference: 0, framework: 0, total: payload?.bytes ?? 0 };
    for (const segment of payload?.sourceMap ?? []) {
      const tier = this.content.documents.find(d => segment.sourceIds.includes(d.id))?.tier ?? 'framework';
      tiers[tier] += segment.byteLength;
    }
    return { version: 1, requestId: op.requestId, sessionId: op.sessionId, ownerId: op.ownerId, nonce: op.nonce,
      requestDigest, payloadHash: payload?.hash ?? digestOfString(''), schemaVersion: op.schemaVersion, composeVersion: op.composeVersion,
      contentGeneration: op.contentGeneration, contentDigest: this.content.digest, subjectDigest: op.subjectDigest,
      configRevision: op.configRevision, configDigest, checkerRevision: op.checkerRevision, timestamp, byteTiers: tiers,
      gateVerdict: result.status === 'complete' ? result.core!.policy.value.decision : 'indeterminate', provisional: true };
  }
}
