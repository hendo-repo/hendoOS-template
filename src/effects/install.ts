/**
 * Staged installer and uninstaller — the only writer in this slice.
 *
 * Every target-byte mutation for `install`, `uninstall` and `recoverInstall`
 * happens in this module. Callers render bytes into an explicit *stage* root and
 * supply an independent strict build manifest; this module verifies both before
 * it touches the target.
 *
 * Non-negotiable properties (evidence in `tests/install.test.ts`, contract text in
 * `docs/install.md`):
 *
 * - **Explicit separate roots.** Source (build inputs), stage (rendered bytes) and
 *   target (installation) are three caller-supplied absolute directories validated
 *   with `validateRoots` from `src/effects/paths.ts`. No live harness default is
 *   resolved, and two roots may not overlap lexically or physically.
 * - **Verify before mutate.** Every `manifest.sources` digest is checked in the
 *   source root and every `manifest.outputs` digest in the stage root before any
 *   target byte changes. A mismatch refuses with zero mutations.
 * - **Per-file placement, never a multi-file swap.** Output bytes are copied into
 *   `target/.aos/staging/<nonce>/`, re-hashed on disk, and moved into place with a
 *   single exclusive hard link per file. A multi-file install is *not* atomic: it is a
 *   journaled sequence, and a crash leaves the journal rather than a silent
 *   half-install. Recovery reads that journal and resolves it.
 * - **Ownership.** A committed ownership state records owner, generation and the
 *   digest of every installed artifact. Unowned collisions, a different owner, and
 *   user-modified owned files are refused, never overwritten. Stale files are
 *   removed only when the recorded digest still matches the bytes on disk; a
 *   modified stale file is preserved and reported.
 * - **Single writer.** A live SQLite write transaction serializes
 *   cooperating installers, uninstallers and recoveries, including processes.
 * - **Journaled recovery.** `recoverInstall` rolls an interrupted transaction back
 *   (or forward when the interrupted run had already committed) using
 *   digest-verified state. An unreadable or malformed journal is refused, never
 *   guessed at.
 *
 * Reports are JSON-safe. Diagnostics omit roots, owner values, digests, file bytes
 * and raw filesystem errors. Relative artifact paths are intentionally reported.
 * The target must be isolated from hostile concurrent writers; see docs/install.md.
 */
import { Database } from 'bun:sqlite';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { link, lstat, mkdir, open, readFile, realpath, rm, rmdir } from 'node:fs/promises';
import { dirname as parentDir, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import { sortPaths } from '../protocols/paths';
import { InstallManifestSchema, isInstallPath } from '../schema/install';
import { readFileDigest, validateRoots, type PathFailureCode } from './paths';

/** Reserved control directory inside the target root. Owned by this module. */
export const CONTROL_DIR = '.aos';
export const CONTROL_STATE_PATH = `${CONTROL_DIR}/state.json`;
export const CONTROL_JOURNAL_PATH = `${CONTROL_DIR}/journal.jsonl`;
export const CONTROL_LOCK_PATH = `${CONTROL_DIR}/lock`;
/** Stable exclusion inode: never removed by installation, recovery or uninstall. */
export const CONTROL_COORDINATION_PATH = `${CONTROL_DIR}/coordination.sqlite`;
export const CONTROL_STAGING_PATH = `${CONTROL_DIR}/staging`;
export const CONTROL_BACKUP_PATH = `${CONTROL_DIR}/backup`;

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const NONCE_PATTERN = /^[a-f0-9]{32}$/;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
/**
 * Nesting bound for the plain-data walk. It mirrors the shared JSON validator in
 * `src/protocols/validation.ts`, which refuses input nested deeper than 100
 * rather than recursing without limit. A manifest nested past this bound is not
 * JSON wire data, so it is refused instead of walked.
 */
const MAX_PLAIN_DATA_DEPTH = 100;

export type InstallOperation = 'install' | 'uninstall' | 'recover';

/**
 * Report status vocabulary. Which values an operation can produce:
 *
 * - `install`   — `installed`, `unchanged`, `refused`, `rolled-back`, `interrupted`, `partial`
 * - `uninstall` — `removed`, `unchanged`, `refused`, `rolled-back`, `interrupted`, `partial`
 * - `recover`   — `recovered`, `unchanged`, `refused`, `partial`
 *
 * `partial` is never success: artifact mutations or residue remain and the caller
 * must resolve them. `interrupted` means a journaled transaction is on disk and
 * `recoverInstall` is required before the target can be used again.
 */
export type InstallStatus =
  | 'installed'
  | 'removed'
  | 'unchanged'
  | 'refused'
  | 'rolled-back'
  | 'interrupted'
  | 'recovered'
  | 'partial';

export type InstallIssueKind =
  | 'options'
  | 'manifest'
  | 'roots'
  | 'ownership'
  | 'concurrent'
  | 'control'
  | 'state'
  | 'journal'
  | 'source'
  | 'stage'
  | 'target'
  | 'conflict'
  | 'io'
  | 'recovery';

export type InstallIssueCode =
  | 'invalid-options'
  | 'malformed-manifest'
  | 'owner-mismatch'
  | 'generation-mismatch'
  | 'generation-regression'
  | 'reserved-path'
  | 'root-invalid'
  | 'control-invalid'
  | 'lock-held'
  | 'recovery-required'
  | 'state-malformed'
  | 'state-unreadable'
  | 'journal-malformed'
  | 'journal-unreadable'
  | 'source-missing'
  | 'source-modified'
  | 'source-unreadable'
  | 'stage-missing'
  | 'stage-modified'
  | 'stage-unreadable'
  | 'target-missing'
  | 'target-modified'
  | 'target-unowned'
  | 'target-not-file'
  | 'stale-preserved'
  | 'ownership-mismatch'
  | 'no-state'
  | 'no-pending-transaction'
  | 'orphan-lock-removed'
  | 'foreign-lock'
  | 'live-lock'
  | 'crash-injected'
  | 'failpoint-abort'
  | 'write-failed'
  | 'permission-denied'
  | 'cross-device'
  | 'rollback-incomplete'
  | 'recovered-forward'
  | 'recovered-back'
  | 'control-residue';

export interface InstallIssue {
  kind: InstallIssueKind;
  code: InstallIssueCode;
  message: string;
  /** Safe relative path only; never an absolute root. */
  path?: string;
  /** Set when the failure came from `src/effects/paths.ts`. */
  pathCode?: PathFailureCode;
}

export interface InstallCounts {
  sourcesChecked: number;
  outputsVerified: number;
  planned: number;
  added: number;
  replaced: number;
  removed: number;
  unchanged: number;
  missing: number;
  preserved: number;
}

export interface InstallReport {
  schemaVersion: 1;
  operation: InstallOperation;
  status: InstallStatus;
  /** A completed install is a sequence of exclusive single-file links, never one swap. */
  atomicity: 'per-file-link';
  generation: number | null;
  counts: InstallCounts;
  mutations: { applied: number; rolledBack: number };
  /** Owned artifacts deliberately left in place (user-modified). Safe relative paths. */
  residue: string[];
  /** True when an unresolved journal/lock is on disk: run `recoverInstall`. */
  recoveryRequired: boolean;
  issues: InstallIssue[];
}

export type Failpoint =
  | 'after-lock'
  | 'after-journal'
  | 'after-stage'
  | 'after-backup-link'
  | 'after-place-link'
  | 'after-move-link'
  | 'after-state-write'
  | 'after-plan'
  | 'after-backup'
  | 'after-place'
  | 'before-state'
  | 'after-state'
  | 'after-state-unlink'
  | 'after-recovery-decision'
  | 'after-rollback-unlink'
  | 'after-restore-link'
  | 'after-cleanup-file'
  | 'after-cleanup-journal'
  | 'before-cleanup';

/**
 * Test-only failure injection. `abort` fails the transaction and rolls it back
 * in-process; `crash` stops without any cleanup (the on-disk state a real process
 * death would leave) and reports `interrupted`; `exit` terminates the process
 * mid-transaction. Production callers must not set this field.
 */
export type FailpointMode = 'abort' | 'crash' | 'exit';
export interface Failpoints {
  at: Failpoint;
  mode: FailpointMode;
}

export interface InstallOptions {
  sourceRoot: string;
  targetRoot: string;
  stageRoot: string;
  /** Independent strict build manifest (never read back from the target). */
  manifest: unknown;
  owner: string;
  /** The generation the caller believes is currently installed. */
  expectedGeneration?: number;
  /** Exact permission bits for owned outputs; omitted new outputs default to 0600. */
  modes?: Record<string, number>;
  failpoints?: Failpoints;
}

export interface UninstallOptions {
  targetRoot: string;
  owner: string;
  expectedGeneration?: number;
  failpoints?: Failpoints;
}

export interface RecoveryOptions {
  targetRoot: string;
  owner: string;
  /**
   * Ignore only the stale PID diagnostic. The SQLite transaction lock must still
   * be acquired; this flag cannot take over an active library transaction.
   */
  assumeDead?: boolean;
  failpoints?: Failpoints;
}

export interface OwnershipEntry {
  path: string;
  digest: string;
  /** Absent in legacy state: permissions are unknown and mutation is refused. */
  mode?: number;
}

/** Committed record of what this owner installed into a target root. */
export interface OwnershipState {
  schemaVersion: 1;
  owner: string;
  generation: number;
  harness: string;
  entries: OwnershipEntry[];
  directories?: string[];
}

// Owner-read is required so later hash verification remains possible. Special
// bits are deliberately excluded; source permissions never supply caller intent.
const ModeSchema = z.int().min(0).max(0o777).refine(mode => (mode & 0o400) !== 0);
const OwnershipEntrySchema = z.strictObject({
  path: z.string().refine(isInstallPath),
  digest: z.string().length(71).regex(DIGEST_PATTERN),
  mode: ModeSchema.optional(),
});

const OwnershipStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  owner: z.string().refine((value) => value.trim().length > 0),
  generation: z.int().positive(),
  harness: z.string().min(1),
  entries: z.array(OwnershipEntrySchema),
  directories: z.array(z.string().refine(isInstallPath)).optional(),
});

const LockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  nonce: z.string().length(32).regex(NONCE_PATTERN),
  owner: z.string().refine((value) => value.trim().length > 0),
  generation: z.int().positive(),
  operation: z.enum(['install', 'uninstall', 'recover']),
  // A real lock never records PID 0: `process.kill(0, 0)` probes the whole process
  // group, so a zero marker would be treated as live and could never be resolved.
  pid: z.int().positive(),
});

const PlannedEntrySchema = z.strictObject({
  path: z.string().refine(isInstallPath),
  digest: z.string().length(71).regex(DIGEST_PATTERN),
  mode: ModeSchema.optional(),
  action: z.enum(['add', 'replace', 'remove']),
  backup: z.string().refine(isInstallPath).nullable(),
});

const JournalRecordSchema = z.discriminatedUnion('phase', [
  z.strictObject({
    seq: z.int().positive(), phase: z.literal('begin'), nonce: z.string().length(32).regex(NONCE_PATTERN),
    owner: z.string().refine((value) => value.trim().length > 0), generation: z.int().positive(),
    operation: z.enum(['install', 'uninstall']),
  }),
  z.strictObject({
    seq: z.int().positive(), phase: z.literal('verified'),
    sourcesChecked: z.int().nonnegative(), outputsVerified: z.int().nonnegative(),
  }),
  z.strictObject({
    seq: z.int().positive(), phase: z.literal('planned'), nonce: z.string().length(32).regex(NONCE_PATTERN),
    operation: z.enum(['install', 'uninstall']), entries: z.array(PlannedEntrySchema), createdDirs: z.array(z.string().refine(isInstallPath)),
    priorState: OwnershipStateSchema.nullable(), nextState: OwnershipStateSchema.nullable(),
  }),
  z.strictObject({ seq: z.int().positive(), phase: z.literal('backed-up'), path: z.string().refine(isInstallPath) }),
  z.strictObject({ seq: z.int().positive(), phase: z.literal('placed'), path: z.string().refine(isInstallPath) }),
  z.strictObject({ seq: z.int().positive(), phase: z.literal('committed') }),
  z.strictObject({ seq: z.int().positive(), phase: z.literal('finalized') }),
  z.strictObject({ seq: z.int().positive(), phase: z.literal('rolling-back') }),
]);

type JournalRecord = z.infer<typeof JournalRecordSchema>;
type PlannedEntry = z.infer<typeof PlannedEntrySchema>;

const FailpointsSchema = z.strictObject({
  at: z.enum(['after-lock', 'after-journal', 'after-stage', 'after-backup-link', 'after-place-link', 'after-move-link', 'after-state-write', 'after-plan', 'after-backup', 'after-place', 'before-state', 'after-state', 'after-state-unlink', 'after-recovery-decision', 'after-rollback-unlink', 'after-restore-link', 'after-cleanup-file', 'after-cleanup-journal', 'before-cleanup']),
  mode: z.enum(['abort', 'crash', 'exit']),
});

const OwnerSchema = z.string().refine((value) => value.trim().length > 0);

const InstallOptionsSchema = z.strictObject({
  sourceRoot: z.string(), targetRoot: z.string(), stageRoot: z.string(),
  manifest: z.unknown(), owner: OwnerSchema,
  modes: z.record(z.string().refine(path => isInstallPath(path) && !reserved(path)), ModeSchema).optional(),
  expectedGeneration: z.int().positive().optional(), failpoints: FailpointsSchema.optional(),
});

const UninstallOptionsSchema = z.strictObject({
  targetRoot: z.string(), owner: OwnerSchema,
  expectedGeneration: z.int().positive().optional(), failpoints: FailpointsSchema.optional(),
});

const RecoveryOptionsSchema = z.strictObject({
  targetRoot: z.string(), owner: OwnerSchema, assumeDead: z.boolean().optional(), failpoints: FailpointsSchema.optional(),
});

const KNOWN_FIELDS = new Set([
  'sourceRoot', 'targetRoot', 'stageRoot', 'manifest', 'owner', 'expectedGeneration', 'failpoints', 'assumeDead',
  'schemaVersion', 'generation', 'harness', 'sources', 'outputs', 'path', 'digest', 'at', 'mode',
  'modes', 'entryOwner', 'entries', 'priorState', 'nextState', 'operation', 'nonce', 'pid', 'seq', 'phase',
]);

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

class AbortInjected extends Error {}
class CrashInjected extends Error {}

function errnoOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function digestOf(bytes: Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
}

function makeIssue(kind: InstallIssueKind, code: InstallIssueCode, message: string, path?: string, pathCode?: PathFailureCode): InstallIssue {
  const issue: InstallIssue = { kind, code, message };
  if (path !== undefined) issue.path = path;
  if (pathCode !== undefined) issue.pathCode = pathCode;
  return issue;
}

/** Map a filesystem error to a fixed, non-leaking diagnostic. */
function ioIssue(error: unknown, path?: string): InstallIssue {
  const errno = errnoOf(error);
  if (errno === 'EACCES' || errno === 'EPERM' || errno === 'EROFS') {
    return makeIssue('io', 'permission-denied', 'Filesystem permission denied for a required operation', path);
  }
  if (errno === 'EXDEV') {
    return makeIssue('io', 'cross-device', 'Cross-device linking is unsupported', path);
  }
  if (errno === 'EISDIR' || errno === 'ENOTDIR' || errno === 'ENOTEMPTY') {
    return makeIssue('io', 'target-not-file', 'A required path is not a regular file', path);
  }
  return makeIssue('io', 'write-failed', 'Filesystem operation failed', path);
}

/** Mask Zod locations so a rejected input can never echo a private key name. */
function maskedLocations(error: z.ZodError, fallback: string): string {
  const seen = new Set<string>();
  for (const issue of error.issues) {
    const location = issue.path.map((part) => typeof part === 'number' ? String(part)
      : KNOWN_FIELDS.has(String(part)) ? String(part) : '<field>').join('.');
    seen.add(location || fallback);
  }
  return [...seen].sort().join(', ');
}

function emptyCounts(): InstallCounts {
  return { sourcesChecked: 0, outputsVerified: 0, planned: 0, added: 0, replaced: 0, removed: 0, unchanged: 0, missing: 0, preserved: 0 };
}

function emptyReport(operation: InstallOperation): InstallReport {
  return {
    schemaVersion: 1, operation, status: 'refused', atomicity: 'per-file-link', generation: null,
    counts: emptyCounts(), mutations: { applied: 0, rolledBack: 0 }, residue: [], recoveryRequired: false, issues: [],
  };
}

/** Duplicate and file/ancestor conflicts inside one path list (case-insensitive). */
function hasPathConflict(paths: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const path of paths) {
    const folded = path.toLowerCase();
    if (seen.has(folded)) return true;
    const parts = folded.split('/');
    for (let length = 1; length < parts.length; length++) {
      if (seen.has(parts.slice(0, length).join('/'))) return true;
    }
    seen.add(folded);
  }
  return false;
}

function statesEqual(a: OwnershipState | null, b: OwnershipState | null): boolean {
  if (a === null || b === null) return a === b;
  if (JSON.stringify([...(a.directories ?? [])].sort()) !== JSON.stringify([...(b.directories ?? [])].sort())) return false;
  if (a.generation !== b.generation || a.owner !== b.owner || a.harness !== b.harness) return false;
  const left = sortPaths(a.entries.map((entry) => entry.path));
  const right = sortPaths(b.entries.map((entry) => entry.path));
  if (left.length !== right.length) return false;
  return right.every(path => {
    const x = a.entries.find(entry => entry.path === path), y = b.entries.find(entry => entry.path === path)!;
    return x !== undefined && x.digest === y.digest && x.mode === y.mode;
  });
}

/**
 * Single-root inspection for `uninstall`/`recoverInstall`.
 *
 * `validateRoots` requires two distinct existing roots, so a one-root operation
 * cannot use it. This mirrors the same contract: explicit absolute path, no
 * traversal or control characters, every component inspected with `lstat` and no
 * symbolic link anywhere in the chain, final component a directory, physical path
 * returned. `install` always uses `validateRoots` for all three of its roots.
 */
async function inspectRoot(root: string): Promise<{ ok: true; root: string } | { ok: false; code: PathFailureCode; message: string }> {
  const fail = (code: PathFailureCode, message: string) => ({ ok: false as const, code, message });
  if (typeof root !== 'string' || root.length === 0 || !isAbsolute(root) ||
    /[\u0000-\u001f\u007f]/.test(root) || root.split(sep).includes('..') || root.split(sep).includes('.')) {
    return fail('unsafe-path', 'Roots must be explicit absolute paths without traversal');
  }
  const absolute = resolve(root);
  let current = absolute.slice(0, absolute.indexOf(sep) + 1) || sep;
  const parts = absolute.slice(current.length).split(sep).filter(Boolean);
  try {
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]!);
      const info = await lstat(current);
      if (info.isSymbolicLink()) return fail('symlink', 'Symbolic links are not allowed in any path component');
      if (index < parts.length - 1 ? !info.isDirectory() : !info.isDirectory()) {
        return fail('not-directory', 'Root must be a directory');
      }
    }
    const physical = await realpath(absolute);
    if (physical !== absolute) return fail('symlink', 'Root resolves through a symbolic link');
    return { ok: true, root: physical };
  } catch (error) {
    const errno = errnoOf(error);
    if (errno === 'ENOENT') return fail('missing', 'Required filesystem entry is missing');
    if (errno === 'ELOOP') return fail('symlink', 'Symbolic links are not allowed');
    if (errno === 'ENOTDIR') return fail('not-directory', 'A path component is not a directory');
    return fail('unreadable', 'Filesystem entry could not be read');
  }
}

/** Create each missing directory component, recording the ones this call created. */
async function ensureDirectory(root: string, relative: string, created: string[]): Promise<void> {
  if (relative === '' || relative === '.') return;
  let current = '';
  for (const part of relative.split('/')) {
    current = current === '' ? part : `${current}/${part}`;
    const absolute = join(root, current);
    let info;
    try { info = await lstat(absolute); }
    catch (error) {
      if (errnoOf(error) !== 'ENOENT') throw error;
      await mkdir(absolute);
      await syncDir(root, parentDir(current));
      created.push(current);
      continue;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
  }
}

/** Remove the reserved control directory only when it is empty. */
async function removeEmptyControlDir(targetRoot: string): Promise<void> {
  try { await rmdir(join(targetRoot, CONTROL_DIR)); } catch { /* Non-empty or absent: keep it. */ }
}

async function inspectControlDir(targetRoot: string): Promise<{ ok: true; created: boolean } | { ok: false; issue: InstallIssue }> {
  const absolute = join(targetRoot, CONTROL_DIR);
  try {
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return { ok: false, issue: makeIssue('control', 'control-invalid', 'Reserved control path is not a real directory') };
    }
    return { ok: true, created: false };
  } catch (error) {
    if (errnoOf(error) !== 'ENOENT') return { ok: false, issue: ioIssue(error) };
    try { await mkdir(absolute); }
    catch (createError) {
      if (errnoOf(createError) === 'EEXIST') return inspectControlDir(targetRoot);
      return { ok: false, issue: ioIssue(createError) };
    }
    return { ok: true, created: true };
  }
}

// ---------------------------------------------------------------------------
// Control-file IO
// ---------------------------------------------------------------------------

interface LockRecord { schemaVersion: 1; nonce: string; owner: string; generation: number; operation: InstallOperation; pid: number }

function newNonce(): string {
  return crypto.randomUUID().replaceAll('-', '');
}

/** The lock carries the transaction nonce so recovery can prove it owns the journal. */
async function acquireLock(targetRoot: string, owner: string, generation: number, operation: InstallOperation, nonce: string): Promise<{ ok: true; nonce: string } | { ok: false; issue: InstallIssue }> {
  const control = await inspectControlDir(targetRoot);
  if (!control.ok) return control;
  const record: LockRecord = { schemaVersion: 1, nonce, owner, generation, operation, pid: process.pid };
  try {
    const handle = await open(join(targetRoot, CONTROL_LOCK_PATH), 'wx', 0o600);
    try { await handle.write(JSON.stringify(record) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
  } catch (error) {
    if (errnoOf(error) === 'EEXIST') {
      return { ok: false, issue: makeIssue('concurrent', 'lock-held',
        'Target control directory is locked: another installer is running or a previous run was interrupted. Resolve with recoverInstall or wait for the running installer.') };
    }
    return { ok: false, issue: ioIssue(error) };
  }
  await syncDir(targetRoot, CONTROL_DIR);
  await syncDir(targetRoot);
  return { ok: true, nonce };
}

/**
 * Read the persistent transaction marker. It is not the live SQLite exclusion lock.
 */
async function readLock(targetRoot: string): Promise<{ ok: true; lock: LockRecord | null } | { ok: false; issue: InstallIssue }> {
  const absolute = join(targetRoot, CONTROL_LOCK_PATH);
  let info;
  try { info = await lstat(absolute); }
  catch (error) { if (errnoOf(error) === 'ENOENT') return { ok: true, lock: null }; return { ok: false, issue: ioIssue(error) }; }
  if (info.isSymbolicLink() || !info.isFile()) return { ok: false, issue: makeIssue('control', 'control-invalid', 'Lock entry is not a regular file') };
  try {
    const parsed = LockSchema.safeParse(JSON.parse(await readFile(absolute, 'utf8')));
    if (!parsed.success) return { ok: false, issue: makeIssue('control', 'control-invalid', 'Lock entry failed strict validation') };
    return { ok: true, lock: parsed.data };
  } catch { return { ok: false, issue: makeIssue('control', 'control-invalid', 'Lock entry could not be read') }; }
}

async function releaseLock(targetRoot: string, nonce: string): Promise<void> {
  const current = await readLock(targetRoot);
  if (!current.ok || (current.lock && current.lock.nonce !== nonce)) throw new Error('lock changed');
  if (current.lock) { await rm(join(targetRoot, CONTROL_LOCK_PATH)); await syncDir(targetRoot, CONTROL_DIR); }
}

async function readOwnershipState(targetRoot: string): Promise<{ ok: true; state: OwnershipState | null } | { ok: false; issue: InstallIssue }> {
  const absolute = join(targetRoot, CONTROL_STATE_PATH);
  let info;
  try { info = await lstat(absolute); }
  catch (error) {
    if (errnoOf(error) === 'ENOENT') return { ok: true, state: null };
    return { ok: false, issue: makeIssue('state', 'state-unreadable', 'Ownership state could not be read') };
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    return { ok: false, issue: makeIssue('state', 'state-malformed', 'Ownership state must be a regular file') };
  }
  let text: string;
  try { text = await readFile(absolute, 'utf8'); }
  catch { return { ok: false, issue: makeIssue('state', 'state-unreadable', 'Ownership state could not be read') }; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { return { ok: false, issue: makeIssue('state', 'state-malformed', 'Ownership state is not valid JSON') }; }
  const result = OwnershipStateSchema.safeParse(parsed);
  if (!result.success) return { ok: false, issue: makeIssue('state', 'state-malformed', 'Ownership state failed strict validation') };
  if (!validState(result.data)) {
    return { ok: false, issue: makeIssue('state', 'state-malformed', 'Ownership state contains ambiguous paths') };
  }
  return { ok: true, state: result.data };
}

function journalExists(targetRoot: string): Promise<boolean> {
  return lstat(join(targetRoot, CONTROL_JOURNAL_PATH)).then(() => true, () => false);
}

async function openJournal(targetRoot: string): Promise<{ ok: true; handle: FileHandle } | { ok: false; issue: InstallIssue }> {
  try {
    const handle = await open(join(targetRoot, CONTROL_JOURNAL_PATH), 'wx', 0o600);
    await syncDir(targetRoot, CONTROL_DIR);
    return { ok: true, handle };
  } catch (error) {
    if (errnoOf(error) === 'EEXIST') {
      return { ok: false, issue: makeIssue('journal', 'recovery-required', 'An unfinished journal exists: resolve it with recoverInstall') };
    }
    return { ok: false, issue: ioIssue(error) };
  }
}

async function appendRecord(handle: FileHandle, record: JournalRecord): Promise<void> {
  await handle.write(JSON.stringify(record) + '\n', null, 'utf8');
  await handle.sync();
}

async function readJournal(targetRoot: string): Promise<{ ok: true; records: JournalRecord[] } | { ok: false; issue: InstallIssue }> {
  const absolute = join(targetRoot, CONTROL_JOURNAL_PATH);
  let info;
  try { info = await lstat(absolute); }
  catch (error) {
    if (errnoOf(error) === 'ENOENT') return { ok: true, records: [] };
    return { ok: false, issue: makeIssue('journal', 'journal-unreadable', 'Journal could not be read') };
  }
  if (info.isSymbolicLink() || !info.isFile()) return { ok: false, issue: makeIssue('journal', 'journal-malformed', 'Journal must be a regular file') };
  if (info.size > MAX_JOURNAL_BYTES) return { ok: false, issue: makeIssue('journal', 'journal-malformed', 'Journal exceeds the supported size') };
  let text: string;
  try { text = await readFile(absolute, 'utf8'); }
  catch { return { ok: false, issue: makeIssue('journal', 'journal-unreadable', 'Journal could not be read') }; }
  const records: JournalRecord[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line === '') {
      if (index !== lines.length - 1) return { ok: false, issue: makeIssue('journal', 'journal-malformed', 'Journal contains an empty record') };
      continue;
    }
    let parsed: ReturnType<typeof JournalRecordSchema.safeParse>;
    try { parsed = JournalRecordSchema.safeParse(JSON.parse(line)); }
    catch { return { ok: false, issue: makeIssue('journal', 'journal-malformed', 'Journal record is not valid JSON') }; }
    if (!parsed.success) return { ok: false, issue: makeIssue('journal', 'journal-malformed', 'Journal record failed strict validation') };
    if (parsed.data.seq !== records.length + 1) return { ok: false, issue: makeIssue('journal', 'journal-malformed', 'Journal sequence is not contiguous') };
    records.push(parsed.data);
  }
  if (records.length > 0 && records[0]!.phase !== 'begin') {
    return { ok: false, issue: makeIssue('journal', 'journal-malformed', 'Journal does not start at the begin phase') };
  }
  if (!validJournal(records)) return { ok: false, issue: makeIssue('journal', 'journal-malformed', 'Journal intent or phase order is inconsistent') };
  return { ok: true, records };
}

async function writeOwnershipState(ctx: TxContext, state: OwnershipState | null, allowed: (OwnershipState | null)[]): Promise<void> {
  const root = ctx.targetRoot, scratch = `${CONTROL_DIR}/state-${ctx.nonce}.tmp`;
  if (state) {
    const handle = await open(join(root, scratch), 'wx', 0o600);
    try { await handle.write(stateText(state)); await handle.sync(); } finally { await handle.close(); }
    await syncDir(root, CONTROL_DIR);
  }
  await assertState(root, allowed);
  if (await safeInfo(root, CONTROL_STATE_PATH)) {
    await rm(join(root, CONTROL_STATE_PATH));
    await syncDir(root, CONTROL_DIR);
  }
  shot(ctx, 'after-state-unlink');
  if (state) {
    await link(join(root, scratch), join(root, CONTROL_STATE_PATH));
    await syncDir(root, CONTROL_DIR);
    await unlinkKnown(root, scratch, digestOf(Buffer.from(stateText(state))));
  }
}

// ---------------------------------------------------------------------------
// Option/manifest parsing
// ---------------------------------------------------------------------------

function parseOptions<T>(report: InstallReport, schema: z.ZodType<T>, options: unknown): T | null {
  if (!plainOptions(options)) { report.issues.push(makeIssue('options', 'invalid-options', 'Options must be plain data without accessors')); return null; }
  let parsed: ReturnType<typeof schema.safeParse>;
  try { parsed = schema.safeParse(options); }
  catch { report.issues.push(makeIssue('options', 'invalid-options', 'Options could not be validated')); return null; }
  if (!parsed.success) {
    report.issues.push(makeIssue('options', 'invalid-options', `Options failed strict validation at ${maskedLocations(parsed.error, '<options>')}`));
    return null;
  }
  return parsed.data;
}

function ownershipFailure(report: InstallReport, error: unknown): void {
  if (error instanceof z.ZodError) {
    report.issues.push(makeIssue('manifest', 'malformed-manifest', `Manifest failed strict validation at ${maskedLocations(error, '<manifest>')}`));
    return;
  }
  report.issues.push(makeIssue('manifest', 'malformed-manifest', 'Manifest could not be validated'));
}

// ---------------------------------------------------------------------------
// Transaction execution
// ---------------------------------------------------------------------------

interface TxContext {
  targetRoot: string;
  stageRoot: string | null;
  nonce: string;
  failpoints: Failpoints | undefined;
  journal: FileHandle | null;
  seq: number;
  createdDirs: string[];
  applied: number;
  fired?: boolean;
}

interface MutationPlan {
  operation: 'install' | 'uninstall';
  entries: PlannedEntry[];
  priorState: OwnershipState | null;
  nextState: OwnershipState | null;
}

interface TxOutcome {
  status: 'installed' | 'removed' | 'rolled-back' | 'interrupted' | 'partial';
  issues: InstallIssue[];
  residue: string[];
}

/**
 * Fire a configured failpoint. `exit` terminates the process immediately: nothing
 * unwinds, which is exactly the on-disk state a real crash leaves behind.
 */
function fireFailpoint(ctx: TxContext, at: Failpoint): 'continue' | 'abort' | 'crash' {
  const failpoints = ctx.failpoints;
  if (!failpoints || failpoints.at !== at || ctx.fired) return 'continue';
  ctx.fired = true;
  if (failpoints.mode === 'exit') { process.exit(70); }
  return failpoints.mode;
}

/**
 * Apply a plan as a journaled sequence of exclusive single-file links. Returns the outcome
 * of this transaction only; it never claims a multi-file atomic swap.
 */
function shot(ctx: TxContext, at: Failpoint): void {
  const result = fireFailpoint(ctx, at);
  if (result === 'crash') throw new CrashInjected();
  if (result === 'abort') throw new AbortInjected();
}

function reserved(path: string): boolean {
  return path.toLowerCase() === CONTROL_DIR || path.toLowerCase().startsWith(`${CONTROL_DIR}/`);
}

/** Same plain-data contract as `plainData`, bounded at the same nesting limit. */
function plainOptions(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value) || depth > MAX_PLAIN_DATA_DEPTH) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) return false;
  return Reflect.ownKeys(value).every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === 'string' && Object.hasOwn(descriptor, 'value') &&
      (!['failpoints', 'modes'].includes(key) || descriptor.value === undefined || plainOptions(descriptor.value, depth + 1));
  });
}

function validState(state: OwnershipState): boolean {
  const paths = state.entries.map(entry => entry.path);
  if (paths.some(reserved) || hasPathConflict([...paths].sort())) return false;
  const spellings = new Map<string, string>();
  for (const path of [...paths, ...(state.directories ?? [])]) {
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join('/');
      const previous = spellings.get(prefix.toLowerCase());
      if (previous && previous !== prefix) return false;
      spellings.set(prefix.toLowerCase(), prefix);
    }
  }
  return (state.directories ?? []).every(dir => !reserved(dir) &&
    paths.some(path => path.startsWith(`${dir}/`)) && !paths.includes(dir));
}

async function syncDir(root: string, relative = ''): Promise<void> {
  const checked = await inspectRoot(join(root, relative));
  if (!checked.ok) throw new Error('directory changed');
  // Windows does not permit opening directory handles through this Node API.
  // File handles are synced individually; directory fsync remains a POSIX-only
  // durability step.
  if (process.platform === 'win32') return;
  const handle = await open(join(root, relative), constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function safeInfo(root: string, path: string) {
  if (!isInstallPath(path)) throw new Error('unsafe path');
  const checked = await inspectRoot(join(root, parentDir(path)));
  if (!checked.ok) {
    if (checked.code === 'missing') return null;
    throw new Error('unsafe ancestor');
  }
  try {
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) throw new Error('symlink');
    return info;
  } catch (error) { if (errnoOf(error) === 'ENOENT') return null; throw error; }
}

async function matches(root: string, path: string, digest: string, mode?: number): Promise<boolean> {
  const read = await readFileDigest(root, path);
  return read.ok && read.value === digest && (mode === undefined || await modeMatches(root, path, mode));
}

async function modeMatches(root: string, path: string, mode: number | undefined): Promise<boolean> {
  if (mode === undefined) return false; // Legacy hashes cannot prove permission ownership.
  const info = await safeInfo(root, path);
  // Windows does not implement portable POSIX mode bits. File identity and
  // digest remain mandatory; mode intent is enforced only on POSIX hosts.
  return !!info?.isFile() && (process.platform === 'win32' || (info.mode & 0o7777) === mode);
}

async function sameFile(root: string, a: string, b: string): Promise<boolean> {
  const left = await safeInfo(root, a), right = await safeInfo(root, b);
  return !!left && !!right && left.isFile() && right.isFile() && left.ino === right.ino && left.dev === right.dev;
}

async function unlinkKnown(root: string, path: string, digest: string, mode?: number): Promise<void> {
  if (!await safeInfo(root, path)) return;
  if (!await matches(root, path, digest, mode)) throw new Error('changed file');
  await rm(join(root, path));
  await syncDir(root, parentDir(path));
}

async function missingParents(root: string, paths: string[]): Promise<string[]> {
  const directories = new Set<string>();
  for (const path of paths) {
    let dir = parentDir(path);
    while (dir !== '.') {
      const info = await safeInfo(root, dir);
      if (info && !info.isDirectory()) throw new Error('non-directory');
      if (!info) directories.add(dir);
      dir = parentDir(dir);
    }
  }
  return [...directories].sort();
}

async function removeEmptyDirectories(root: string, directories: string[]): Promise<void> {
  for (const dir of [...new Set(directories)].sort((a,b) => b.split('/').length - a.split('/').length)) {
    const info = await safeInfo(root, dir);
    if (!info) continue;
    if (!info.isDirectory()) throw new Error('directory replaced');
    try { await rmdir(join(root, dir)); await syncDir(root, parentDir(dir)); }
    catch (error) { if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(errnoOf(error) ?? '')) throw error; }
  }
}

async function assertState(root: string, allowed: (OwnershipState | null)[]): Promise<void> {
  const current = await readOwnershipState(root);
  if (!current.ok || !allowed.some(state => statesEqual(current.state, state))) throw new Error('state changed');
}

async function executeTransaction(ctx: TxContext, plan: MutationPlan): Promise<TxOutcome> {
  const staging = `${CONTROL_STAGING_PATH}/${ctx.nonce}`;
  try {
    shot(ctx, 'after-plan');
    // The durable plan precedes directory and artifact mutations.
    for (const entry of plan.entries) {
      const staged = `${staging}/${entry.path}`;
      if (entry.action !== 'remove') {
        if (!ctx.stageRoot || !await matches(ctx.stageRoot, entry.path, entry.digest)) throw new Error('stage changed');
        const bytes = await readFile(join(ctx.stageRoot, entry.path));
        if (digestOf(bytes) !== entry.digest) throw new Error('stage changed');
        await ensureDirectory(ctx.targetRoot, parentDir(staged), []);
        const handle = await open(join(ctx.targetRoot, staged), 'wx', 0o600);
        try {
          await handle.writeFile(bytes);
          // NTFS through Bun does not expose portable POSIX permission bits.
          // Ownership is still proven by exclusive creation, inode checks, and
          // byte digests; exact chmod enforcement remains a POSIX guarantee.
          if (process.platform !== 'win32') {
            await handle.chmod(entry.mode ?? 0o600);
            if (((await handle.stat()).mode & 0o7777) !== (entry.mode ?? 0o600)) throw new Error('mode unsupported');
          }
          await handle.sync();
        } finally { await handle.close(); }
        await syncDir(ctx.targetRoot, parentDir(staged));
        shot(ctx, 'after-stage');
      }
      if (entry.backup) {
        const old = plan.priorState!.entries.find(item => item.path === entry.path)!;
        if (old.mode === undefined || !await matches(ctx.targetRoot, entry.path, old.digest, old.mode)) throw new Error('target changed');
        await ensureDirectory(ctx.targetRoot, parentDir(entry.backup), []);
        // Keep the pre-image linked until cleanup. Link creation refuses collisions.
        await link(join(ctx.targetRoot, entry.path), join(ctx.targetRoot, entry.backup));
        await syncDir(ctx.targetRoot, parentDir(entry.backup));
        shot(ctx, 'after-backup-link');
        if (!await sameFile(ctx.targetRoot, entry.path, entry.backup)) throw new Error('target changed');
        await unlinkKnown(ctx.targetRoot, entry.path, old.digest, old.mode);
        await appendRecord(ctx.journal!, { seq: ++ctx.seq, phase: 'backed-up', path: entry.path });
      }
      shot(ctx, 'after-backup');
      if (entry.action !== 'remove') {
        await ensureDirectory(ctx.targetRoot, parentDir(entry.path) === '.' ? '' : parentDir(entry.path), []);
        if (!await matches(ctx.targetRoot, staged, entry.digest, entry.mode)) throw new Error('stage changed');
        if (await safeInfo(ctx.targetRoot, entry.path)) throw new Error('target appeared');
        // No-replace placement: retain the staged inode as rollback ownership proof.
        const move = `${CONTROL_DIR}/move-${ctx.nonce}.tmp`;
        await link(join(ctx.targetRoot, staged), join(ctx.targetRoot, move));
        await syncDir(ctx.targetRoot, CONTROL_DIR);
        shot(ctx, 'after-move-link');
        await link(join(ctx.targetRoot, move), join(ctx.targetRoot, entry.path));
        await syncDir(ctx.targetRoot, parentDir(entry.path));
        // A kill here leaves both links. The journaled intent and staging inode prove them.
        shot(ctx, 'after-place-link');
        await unlinkKnown(ctx.targetRoot, move, entry.digest, entry.mode);
        await appendRecord(ctx.journal!, { seq: ++ctx.seq, phase: 'placed', path: entry.path });
      }
      ctx.applied++;
      shot(ctx, 'after-place');
    }
    shot(ctx, 'before-state');
    await assertState(ctx.targetRoot, [plan.priorState]);
    await ensureDirectory(ctx.targetRoot, staging, []);
    await writeOwnershipState(ctx, plan.nextState, [plan.priorState]);
    await syncDir(ctx.targetRoot, CONTROL_DIR);
    shot(ctx, 'after-state-write');
    await appendRecord(ctx.journal!, { seq: ++ctx.seq, phase: 'committed' });
    shot(ctx, 'after-state');
    await appendRecord(ctx.journal!, { seq: ++ctx.seq, phase: 'finalized' });
    await removeEmptyDirectories(ctx.targetRoot, (plan.priorState?.directories ?? []).filter(dir =>
      !plan.nextState?.entries.some(entry => entry.path.startsWith(`${dir}/`))));
    return { status: plan.operation === 'install' ? 'installed' : 'removed', issues: [], residue: [] };
  } catch (error) {
    if (error instanceof CrashInjected) return { status: 'interrupted', issues: [makeIssue('recovery', 'crash-injected', 'Injected interruption; recovery is required')], residue: [] };
    try { await appendRecord(ctx.journal!, { seq: ++ctx.seq, phase: 'rolling-back' }); }
    catch { return { status: 'partial', issues: [ioIssue(error)], residue: [] }; }
    const restored = await rollbackInProcess(ctx, plan);
    return { status: restored ? 'rolled-back' : 'partial', residue: [], issues: [error instanceof AbortInjected
      ? makeIssue('io', 'failpoint-abort', 'Injected transaction abort') : ioIssue(error),
      ...(!restored ? [makeIssue('recovery', 'rollback-incomplete', 'Changed or missing recovery evidence was preserved')] : [])] };
  }
}

async function rollbackInProcess(ctx: TxContext, plan: MutationPlan): Promise<boolean> {
  try {
    await assertState(ctx.targetRoot, [plan.priorState, plan.nextState, null]);
    for (const entry of [...plan.entries].reverse()) {
      if (entry.mode === undefined) return false;
      const staged = `${CONTROL_STAGING_PATH}/${ctx.nonce}/${entry.path}`;
      const current = await safeInfo(ctx.targetRoot, entry.path);
      const old = plan.priorState?.entries.find(item => item.path === entry.path);
      const backup = entry.backup && await safeInfo(ctx.targetRoot, entry.backup);
      if (entry.action === 'add') {
        if (current) {
          if (!await sameFile(ctx.targetRoot, staged, entry.path)) return false;
          await unlinkKnown(ctx.targetRoot, entry.path, entry.digest, entry.mode);
          shot(ctx, 'after-rollback-unlink');
        }
      } else if (backup) {
        if (!old || old.mode === undefined || !await matches(ctx.targetRoot, entry.backup!, old.digest, old.mode)) return false;
        if (current && await sameFile(ctx.targetRoot, entry.backup!, entry.path) && await matches(ctx.targetRoot, entry.path, old.digest, old.mode)) continue;
        if (current) {
          if (entry.action !== 'replace' || !await sameFile(ctx.targetRoot, staged, entry.path)) return false;
          await unlinkKnown(ctx.targetRoot, entry.path, entry.digest, entry.mode);
          shot(ctx, 'after-rollback-unlink');
        }
        await ensureDirectory(ctx.targetRoot, parentDir(entry.path) === '.' ? '' : parentDir(entry.path), []);
        await link(join(ctx.targetRoot, entry.backup!), join(ctx.targetRoot, entry.path));
        shot(ctx, 'after-restore-link');
        await syncDir(ctx.targetRoot, parentDir(entry.path));
      } else if (!old || !current || !await matches(ctx.targetRoot, entry.path, old.digest, old.mode)) return false;
    }
    const staging = `${CONTROL_STAGING_PATH}/${ctx.nonce}`;
    await ensureDirectory(ctx.targetRoot, staging, []);
    // A crash can leave this exact state scratch file. Only remove verified bytes.
    const scratch = `${CONTROL_DIR}/state-${ctx.nonce}.tmp`;
    if (await safeInfo(ctx.targetRoot, scratch)) {
      const data = await readFile(join(ctx.targetRoot, scratch), 'utf8');
      if (![plan.nextState, plan.priorState].some(state => state && data === stateText(state))) return false;
      await unlinkKnown(ctx.targetRoot, scratch, digestOf(Buffer.from(data)));
    }
    await writeOwnershipState(ctx, plan.priorState, [plan.priorState, plan.nextState, null]);
    await syncDir(ctx.targetRoot, CONTROL_DIR);
    await removeEmptyDirectories(ctx.targetRoot, ctx.createdDirs);
    return true;
  } catch { return false; }
}

function stateText(state: OwnershipState): string { return JSON.stringify(OwnershipStateSchema.parse(state), null, 2) + '\n'; }

/** Delete only explicitly planned, hash-verified scratch files. Unknown data stays. */
async function cleanupTransaction(targetRoot: string, journal: FileHandle | null, nonce: string, ctx?: TxContext): Promise<InstallIssue[]> {
  try { await journal?.close(); } catch { /* Closed by recovery. */ }
  try {
    const lock = await readLock(targetRoot);
    if (!lock.ok || lock.lock?.nonce !== nonce) throw new Error('lock changed');
    const read = await readJournal(targetRoot);
    if (!read.ok) throw new Error('journal changed');
    const plan = read.records.find(record => record.phase === 'planned');
    const move = `${CONTROL_DIR}/move-${nonce}.tmp`;
    if (await safeInfo(targetRoot, move)) {
      let proved = false;
      if (plan?.phase === 'planned') for (const entry of plan.entries) {
        if (entry.action !== 'remove' && await sameFile(targetRoot, move, `${CONTROL_STAGING_PATH}/${nonce}/${entry.path}`) &&
          await matches(targetRoot, move, entry.digest, entry.mode)) { await unlinkKnown(targetRoot, move, entry.digest, entry.mode); proved = true; break; }
      }
      if (!proved) throw new Error('move scratch changed');
    }
    const dirs: string[] = [];
    if (plan?.phase === 'planned') {
      for (const entry of plan.entries) {
        const files = [{path: `${CONTROL_STAGING_PATH}/${nonce}/${entry.path}`, digest: entry.digest, mode: entry.mode}];
        if (entry.backup) {
          const old = plan.priorState!.entries.find(old => old.path === entry.path)!;
          files.push({ path: entry.backup, digest: old.digest, mode: old.mode });
        }
        for (const file of files) {
          await unlinkKnown(targetRoot, file.path, file.digest, file.mode);
          if (ctx) shot(ctx, 'after-cleanup-file');
          let dir = parentDir(file.path);
          while (dir !== CONTROL_DIR) { dirs.push(dir); dir = parentDir(dir); }
        }
      }
      const scratch = `${CONTROL_DIR}/state-${nonce}.tmp`;
      if (await safeInfo(targetRoot, scratch)) {
        const text = await readFile(join(targetRoot, scratch), 'utf8');
        if (![plan.priorState, plan.nextState].some(state => state && stateText(state) === text)) throw new Error('scratch changed');
        await unlinkKnown(targetRoot, scratch, digestOf(Buffer.from(text)));
      }
    }
    dirs.push(`${CONTROL_STAGING_PATH}/${nonce}`, `${CONTROL_BACKUP_PATH}/${nonce}`, CONTROL_STAGING_PATH, CONTROL_BACKUP_PATH);
    await removeEmptyDirectories(targetRoot, dirs);
    // Retain the journal if an unknown entry occupies either scratch tree.
    for (const dir of [CONTROL_STAGING_PATH, CONTROL_BACKUP_PATH]) if (await safeInfo(targetRoot, dir)) throw new Error('unknown scratch');
    await rm(join(targetRoot, CONTROL_JOURNAL_PATH), { force: true });
    await syncDir(targetRoot, CONTROL_DIR);
    if (ctx) shot(ctx, 'after-cleanup-journal');
    await releaseLock(targetRoot, nonce);
    await removeEmptyControlDir(targetRoot);
    await syncDir(targetRoot);
    return [];
  } catch { return [makeIssue('control', 'control-residue', 'Recovery evidence or unknown control data remains')]; }
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

async function installLocked(options: InstallOptions, locked = false): Promise<InstallReport> {
  const report = emptyReport('install');
  const input = parseOptions(report, InstallOptionsSchema, options);
  if (!input) return report;

  if (!plainData(input.manifest)) {
    report.issues.push(makeIssue('manifest', 'malformed-manifest', 'Manifest must be plain JSON data')); return report;
  }
  let manifest;
  try {
    const parsed = InstallManifestSchema.safeParse(input.manifest);
    if (!parsed.success) { ownershipFailure(report, parsed.error); return report; }
    manifest = parsed.data;
  } catch (error) { ownershipFailure(report, error); return report; }

  if (manifest.owner !== input.owner) {
    report.issues.push(makeIssue('ownership', 'owner-mismatch', 'Manifest owner does not match the caller owner'));
    return report;
  }
  if (Object.keys(input.modes ?? {}).some(path => !manifest.outputs.some(entry => entry.path === path))) {
    report.issues.push(makeIssue('options', 'invalid-options', 'Modes may name only exact manifest output paths')); return report;
  }
  report.generation = manifest.generation;
  for (const entry of manifest.outputs) {
    if (reserved(entry.path)) {
      report.issues.push(makeIssue('manifest', 'reserved-path', 'Output path is inside the reserved control directory', entry.path));
      return report;
    }
  }

  // Three explicit roots. Overlap is refused pairwise, lexically and physically.
  const sourceTarget = await validateRoots(input.sourceRoot, input.targetRoot);
  if (!sourceTarget.ok) {
    report.issues.push(makeIssue('roots', 'root-invalid', sourceTarget.message, undefined, sourceTarget.code));
    return report;
  }
  const targetStage = await validateRoots(sourceTarget.value.targetRoot, input.stageRoot);
  if (!targetStage.ok) {
    report.issues.push(makeIssue('roots', 'root-invalid', targetStage.message, undefined, targetStage.code));
    return report;
  }
  const sourceStage = await validateRoots(sourceTarget.value.sourceRoot, targetStage.value.targetRoot);
  if (!sourceStage.ok) {
    report.issues.push(makeIssue('roots', 'root-invalid', sourceStage.message, undefined, sourceStage.code));
    return report;
  }
  const sourceRoot = sourceTarget.value.sourceRoot;
  const targetRoot = targetStage.value.sourceRoot;
  const stageRoot = sourceStage.value.targetRoot;

  // Verify the independent source bytes and the rendered stage bytes first.
  const blockers: InstallIssue[] = [];
  for (const entry of manifest.sources) {
    const result = await readFileDigest(sourceRoot, entry.path);
    if (!result.ok) {
      blockers.push(makeIssue('source', result.code === 'missing' ? 'source-missing' : 'source-unreadable',
        result.message, entry.path, result.code));
    } else if (result.value !== entry.digest) {
      blockers.push(makeIssue('source', 'source-modified', 'Source bytes differ from the build manifest', entry.path));
    } else {
      report.counts.sourcesChecked++;
    }
  }
  for (const entry of manifest.outputs) {
    const result = await readFileDigest(stageRoot, entry.path);
    if (!result.ok) {
      blockers.push(makeIssue('stage', result.code === 'missing' ? 'stage-missing' : 'stage-unreadable',
        result.message, entry.path, result.code));
    } else if (result.value !== entry.digest) {
      blockers.push(makeIssue('stage', 'stage-modified', 'Staged bytes differ from the manifest', entry.path));
    } else {
      report.counts.outputsVerified++;
    }
  }
  if (blockers.length > 0) {
    report.issues.push(...blockers);
    return report;
  }

  if (!locked) return serialized('install', InstallOptionsSchema, input, value => installLocked(value, true));

  // Serialize competing installers on this target before any mutation or journal.
  // The lock carries this transaction's nonce, so cleanup can prove ownership.
  const nonce = newNonce();
  const control = await inspectControlDir(targetRoot);
  if (!control.ok) { report.issues.push(control.issue); return report; }
  const lock = await acquireLock(targetRoot, input.owner, manifest.generation, 'install', nonce);
  if (!lock.ok) {
    report.issues.push(lock.issue);
    // A persistent marker requires recovery; only the SQLite lock proves live exclusion.
    report.recoveryRequired = lock.issue.code === 'lock-held' || await journalExists(targetRoot);
    if (report.recoveryRequired) report.issues.push(makeIssue('journal', 'recovery-required', 'Pending transaction requires recovery'));
    if (control.created) await removeEmptyControlDir(targetRoot);
    return report;
  }
  if (await journalExists(targetRoot)) {
    report.recoveryRequired = true;
    report.issues.push(makeIssue('journal', 'recovery-required', 'An unfinished journal exists: resolve it with recoverInstall before installing'));
    await releaseLock(targetRoot, nonce);
    await removeEmptyControlDir(targetRoot);
    return report;
  }

  if (input.failpoints?.at === 'after-lock') {
    if (input.failpoints.mode === 'exit') process.exit(70);
    if (input.failpoints.mode === 'abort') { await releaseLock(targetRoot, nonce); await removeEmptyControlDir(targetRoot); report.status = 'rolled-back'; }
    else { report.status = 'interrupted'; report.recoveryRequired = true; }
    report.issues.push(makeIssue('recovery', input.failpoints.mode === 'abort' ? 'failpoint-abort' : 'crash-injected', 'Injected interruption after lock'));
    return report;
  }
  const journalOpen = await openJournal(targetRoot);
  if (!journalOpen.ok) {
    // Distinguish "another installer holds the lock" from "a journal is unresolved".
    report.recoveryRequired = journalOpen.issue.code === 'recovery-required';
    report.issues.push(journalOpen.issue);
    await releaseLock(targetRoot, nonce);
    await removeEmptyControlDir(targetRoot);
    return report;
  }
  const journal = journalOpen.handle;
  const ctx: TxContext = {
    targetRoot, stageRoot, nonce, failpoints: input.failpoints, journal, seq: 0,
    createdDirs: [], applied: 0,
  };
  try {
    shot(ctx, 'after-journal');
    await appendRecord(journal, { seq: ++ctx.seq, phase: 'begin', nonce: ctx.nonce, owner: input.owner,
      generation: manifest.generation, operation: 'install' });
    await appendRecord(journal, { seq: ++ctx.seq, phase: 'verified',
      sourcesChecked: report.counts.sourcesChecked, outputsVerified: report.counts.outputsVerified });

    const stateRead = await readOwnershipState(targetRoot);
    if (!stateRead.ok) {
      report.issues.push(stateRead.issue);
      await finishCleanup(report, targetRoot, journal, ctx.nonce);
      return report;
    }
    const state = stateRead.state;
    if (state !== null && state.owner !== input.owner) {
      report.issues.push(makeIssue('ownership', 'ownership-mismatch',
        'Target is owned by a different owner; ownership takeover is refused'));
      await finishCleanup(report, targetRoot, journal, ctx.nonce);
      return report;
    }
    if (input.expectedGeneration !== undefined && (state === null || state.generation !== input.expectedGeneration)) {
      report.issues.push(makeIssue('manifest', 'generation-mismatch',
        state === null ? 'No installed generation matches the expected generation' : 'Installed generation does not match the expected generation'));
      await finishCleanup(report, targetRoot, journal, ctx.nonce);
      return report;
    }
    if (state !== null && manifest.generation < state.generation) {
      report.issues.push(makeIssue('manifest', 'generation-regression', 'Manifest generation is older than the installed generation'));
      await finishCleanup(report, targetRoot, journal, ctx.nonce);
      return report;
    }

    const desiredMode = (path: string) => input.modes?.[path] ?? state?.entries.find(entry => entry.path === path)?.mode ?? 0o600;
    if (state && state.generation === manifest.generation && (state.harness !== manifest.harness ||
      manifest.outputs.some(entry => !state.entries.some(old => old.path === entry.path && old.digest === entry.digest && (old.mode === undefined ? input.modes?.[entry.path] === undefined : old.mode === desiredMode(entry.path)))))) {
      report.issues.push(makeIssue('manifest', 'generation-mismatch', 'Changed output ownership requires a newer generation'));
      await finishCleanup(report, targetRoot, journal, ctx.nonce); return report;
    }
    const owned = new Map((state?.entries ?? []).map((entry) => [entry.path, entry.digest]));
    const combinedPaths = [...new Set([...owned.keys(), ...manifest.outputs.map(entry => entry.path)])];
    if (!validState({ schemaVersion: 1, owner: input.owner, generation: manifest.generation, harness: manifest.harness,
      entries: combinedPaths.map(path => ({ path, digest: manifest.outputs[0]!.digest })) })) {
      report.issues.push(makeIssue('conflict', 'target-unowned', 'Old and new paths contain ambiguous aliases or ancestry'));
      await finishCleanup(report, targetRoot, journal, ctx.nonce); return report;
    }
    const outputs = new Map(manifest.outputs.map((entry) => [entry.path, entry.digest]));
    const entries: PlannedEntry[] = [];
    const nextEntries: OwnershipEntry[] = [];
    const preserved: OwnershipEntry[] = [];

    for (const path of sortPaths(manifest.outputs.map((entry) => entry.path))) {
      const digest = outputs.get(path)!;
      const mode = desiredMode(path);
      const prior = state?.entries.find(entry => entry.path === path);
      const recorded = owned.get(path);
      const current = await readFileDigest(targetRoot, path);
      const backup = `${CONTROL_BACKUP_PATH}/${ctx.nonce}/${path}`;
      if (!current.ok && current.code !== 'missing') {
        blockers.push(makeIssue('conflict',
          current.code === 'symlink' || current.code === 'not-file' || current.code === 'not-directory'
            ? 'target-not-file' : 'write-failed',
          'Existing target entry is not a readable regular file; it is left untouched', path, current.code));
        continue;
      }
      if (!current.ok) {
        // Absent: create it. A previously owned missing file is re-created.
        entries.push({ path, digest, mode, action: 'add', backup: null });
        nextEntries.push({ path, digest, mode });
        continue;
      }
      if (recorded === undefined) {
        blockers.push(makeIssue('conflict', 'target-unowned',
          'Target path exists but is not owned by this owner; ownership takeover is refused', path));
        continue;
      }
      if (current.value !== recorded || (prior?.mode !== undefined && !await modeMatches(targetRoot, path, prior.mode))) {
        blockers.push(makeIssue('conflict', 'target-modified',
          'Owned target file was modified locally; the ambiguous conflict is refused', path));
        continue;
      }
      if (prior?.mode === undefined) {
        if (current.value === digest && input.modes?.[path] === undefined) { nextEntries.push(prior!); continue; }
        blockers.push(makeIssue('conflict', 'target-modified', 'Legacy ownership has no permission evidence; replacement is refused', path));
        continue;
      }
      if (current.value === digest && prior.mode === mode) { nextEntries.push({ path, digest, mode }); continue; }
      entries.push({ path, digest, mode, action: 'replace', backup });
      nextEntries.push({ path, digest, mode });
    }

    // Stale entries: owned last generation, absent from this manifest.
    for (const entry of state?.entries ?? []) {
      if (outputs.has(entry.path)) continue;
      const current = await readFileDigest(targetRoot, entry.path);
      if (!current.ok) {
        if (current.code === 'missing') {
          report.counts.missing++;
          report.issues.push(makeIssue('target', 'target-missing', 'Previously installed file is already absent', entry.path));
          continue;
        }
        report.counts.preserved++;
        report.residue.push(entry.path);
        preserved.push(entry);
        report.issues.push(makeIssue('target', 'stale-preserved', 'Previously installed file could not be read and is preserved', entry.path, current.code));
        continue;
      }
      if (current.value !== entry.digest || !await modeMatches(targetRoot, entry.path, entry.mode)) {
        report.counts.preserved++;
        report.residue.push(entry.path);
        preserved.push(entry);
        report.issues.push(makeIssue('target', 'stale-preserved', 'User-modified stale file is preserved and its ownership is retained', entry.path));
        continue;
      }
      entries.push({ path: entry.path, digest: entry.digest, mode: entry.mode, action: 'remove',
        backup: `${CONTROL_BACKUP_PATH}/${ctx.nonce}/${entry.path}` });
    }

    if (blockers.length > 0) {
      report.issues.push(...blockers);
      await finishCleanup(report, targetRoot, journal, ctx.nonce);
      return report;
    }

    if (state?.generation === manifest.generation && entries.some(entry => entry.action === 'remove')) {
      report.issues.push(makeIssue('manifest', 'generation-mismatch', 'Removing owned outputs requires a newer generation'));
      await finishCleanup(report, targetRoot, journal, ctx.nonce); return report;
    }
    ctx.createdDirs = await missingParents(targetRoot, manifest.outputs.map(entry => entry.path));
    const nextState: OwnershipState = {
      schemaVersion: 1, owner: input.owner, generation: manifest.generation, harness: manifest.harness,
      directories: [...new Set([...(state?.directories ?? []), ...ctx.createdDirs])].filter(dir => [...nextEntries, ...preserved].some(entry => entry.path.startsWith(`${dir}/`))).sort(),
      entries: [...nextEntries, ...preserved].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    };
    report.counts.added = entries.filter((entry) => entry.action === 'add').length;
    report.counts.replaced = entries.filter((entry) => entry.action === 'replace').length;
    report.counts.removed = entries.filter((entry) => entry.action === 'remove').length;
    report.counts.unchanged = manifest.outputs.length - report.counts.added - report.counts.replaced;
    report.counts.planned = entries.length;

    const stateChanged = !statesEqual(state, nextState);
    if (entries.length === 0 && !stateChanged) {
      report.status = report.residue.length ? 'partial' : 'unchanged';
      await finishCleanup(report, targetRoot, journal, ctx.nonce);
      return report;
    }

    await appendRecord(journal, { seq: ++ctx.seq, phase: 'planned', nonce: ctx.nonce, operation: 'install',
      entries, priorState: state, nextState, createdDirs: ctx.createdDirs });

    const outcome = await executeTransaction(ctx, { operation: 'install', entries, priorState: state, nextState });
    report.issues.push(...outcome.issues);
    report.mutations.applied = ctx.applied;
    if (outcome.status === 'interrupted') {
      report.status = 'interrupted';
      report.recoveryRequired = true;
      try { await journal.close(); } catch { /* Process death would not close it either. */ }
      return report;
    }
    if (outcome.status === 'rolled-back' || outcome.status === 'partial') {
      report.status = outcome.status;
      report.mutations.rolledBack = ctx.applied;
    } else {
      report.status = report.residue.length ? 'partial' : outcome.status;
    }
    if (outcome.status === 'partial') {
      report.recoveryRequired = true; await journal.close(); return report;
    }
    const cleanup = await cleanupTransaction(targetRoot, journal, ctx.nonce);
    report.issues.push(...cleanup);
    if (cleanup.length) { report.status = 'partial'; report.recoveryRequired = true; }
    return report;
  } catch (error) {
    if (error instanceof CrashInjected) {
      report.status = 'interrupted'; report.recoveryRequired = true;
      report.issues.push(makeIssue('recovery', 'crash-injected', 'Injected pre-plan interruption'));
      await journal.close(); return report;
    }
    report.issues.push(error instanceof AbortInjected ? makeIssue('io', 'failpoint-abort', 'Injected pre-plan abort') : ioIssue(error));
    report.status = error instanceof AbortInjected ? 'rolled-back' : 'refused';
    const cleanup = await cleanupTransaction(targetRoot, journal, ctx.nonce);
    report.issues.push(...cleanup);
    if (cleanup.length) { report.status = 'partial'; report.recoveryRequired = true; }
    return report;
  }
}

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

async function uninstallLocked(options: UninstallOptions): Promise<InstallReport> {
  const report = emptyReport('uninstall');
  const input = parseOptions(report, UninstallOptionsSchema, options);
  if (!input) return report;

  const root = await inspectRoot(input.targetRoot);
  if (!root.ok) {
    report.issues.push(makeIssue('roots', 'root-invalid', root.message, undefined, root.code));
    return report;
  }
  const targetRoot = root.root;

  const control = await inspectControlDir(targetRoot);
  if (!control.ok) { report.issues.push(control.issue); return report; }

  if (await journalExists(targetRoot)) { report.recoveryRequired = true; report.issues.push(makeIssue('journal', 'recovery-required', 'Pending transaction requires recovery')); return report; }
  const pendingLock = await readLock(targetRoot);
  if (!pendingLock.ok) { report.issues.push(pendingLock.issue); return report; }
  if (pendingLock.lock) { report.recoveryRequired = true; report.issues.push(makeIssue('concurrent', 'lock-held', 'Abandoned or active lock requires recovery')); return report; }
  const stateRead = await readOwnershipState(targetRoot);
  if (!stateRead.ok) { report.issues.push(stateRead.issue); return report; }
  const state = stateRead.state;
  if (state === null) {
    report.status = 'unchanged';
    report.issues.push(makeIssue('state', 'no-state', 'No ownership state is installed in this target'));
    await removeEmptyControlDir(targetRoot);
    return report;
  }
  if (state.owner !== input.owner) {
    report.issues.push(makeIssue('ownership', 'ownership-mismatch', 'Target is owned by a different owner; uninstall is refused'));
    await removeEmptyControlDir(targetRoot);
    return report;
  }
  report.generation = state.generation;
  if (input.expectedGeneration !== undefined && state.generation !== input.expectedGeneration) {
    report.issues.push(makeIssue('manifest', 'generation-mismatch', 'Installed generation does not match the expected generation'));
    return report;
  }

  // Serialize competing installers before any mutation or journal.
  const nonce = newNonce();
  const lock = await acquireLock(targetRoot, input.owner, state.generation, 'uninstall', nonce);
  if (!lock.ok) {
    report.issues.push(lock.issue);
    report.recoveryRequired = lock.issue.code === 'lock-held' || await journalExists(targetRoot);
    if (report.recoveryRequired) report.issues.push(makeIssue('journal', 'recovery-required', 'Pending transaction requires recovery'));
    await removeEmptyControlDir(targetRoot);
    return report;
  }
  if (await journalExists(targetRoot)) {
    report.recoveryRequired = true;
    report.issues.push(makeIssue('journal', 'recovery-required', 'An unfinished journal exists: resolve it with recoverInstall before uninstalling'));
    await releaseLock(targetRoot, nonce);
    await removeEmptyControlDir(targetRoot);
    return report;
  }

  if (input.failpoints?.at === 'after-lock') {
    if (input.failpoints.mode === 'exit') process.exit(70);
    if (input.failpoints.mode === 'abort') { await releaseLock(targetRoot, nonce); await removeEmptyControlDir(targetRoot); report.status = 'rolled-back'; }
    else { report.status = 'interrupted'; report.recoveryRequired = true; }
    report.issues.push(makeIssue('recovery', input.failpoints.mode === 'abort' ? 'failpoint-abort' : 'crash-injected', 'Injected interruption after lock'));
    return report;
  }
  const journalOpen = await openJournal(targetRoot);
  if (!journalOpen.ok) {
    report.recoveryRequired = journalOpen.issue.code === 'recovery-required';
    report.issues.push(journalOpen.issue);
    await releaseLock(targetRoot, nonce);
    await removeEmptyControlDir(targetRoot);
    return report;
  }
  const journal = journalOpen.handle;
  const ctx: TxContext = {
    targetRoot, stageRoot: null, nonce, failpoints: input.failpoints, journal, seq: 0,
    createdDirs: [], applied: 0,
  };
  try {
    shot(ctx, 'after-journal');
    await appendRecord(journal, { seq: ++ctx.seq, phase: 'begin', nonce: ctx.nonce, owner: input.owner,
      generation: state.generation, operation: 'uninstall' });
    await appendRecord(journal, { seq: ++ctx.seq, phase: 'verified', sourcesChecked: 0, outputsVerified: 0 });

    const entries: PlannedEntry[] = [];
    const residue: OwnershipEntry[] = [];
    for (const path of sortPaths(state.entries.map((entry) => entry.path))) {
      const entry = state.entries.find((candidate) => candidate.path === path)!;
      const current = await readFileDigest(targetRoot, path);
      if (!current.ok) {
        if (current.code === 'missing') {
          report.counts.missing++;
          report.issues.push(makeIssue('target', 'target-missing', 'Owned file is already absent', path));
          continue;
        }
        report.counts.preserved++;
        report.residue.push(path);
        residue.push(entry);
        report.issues.push(makeIssue('conflict', 'stale-preserved', 'Owned entry is not a readable regular file and is preserved', path, current.code));
        continue;
      }
      if (current.value !== entry.digest || !await modeMatches(targetRoot, entry.path, entry.mode)) {
        report.counts.preserved++;
        report.residue.push(path);
        residue.push(entry);
        report.issues.push(makeIssue('conflict', 'target-modified', 'Owned file was modified locally and is preserved, not removed', path));
        continue;
      }
      entries.push({ path, digest: entry.digest, mode: entry.mode, action: 'remove', backup: `${CONTROL_BACKUP_PATH}/${ctx.nonce}/${path}` });
    }

    const nextState: OwnershipState | null = residue.length === 0 ? null : {
      schemaVersion: 1, owner: input.owner, generation: state.generation, harness: state.harness,
      directories: (state.directories ?? []).filter(dir => residue.some(entry => entry.path.startsWith(`${dir}/`))),
      entries: [...residue].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    };
    report.counts.removed = entries.length;
    report.counts.planned = entries.length;
    const stateChanged = !statesEqual(state, nextState);
    if (entries.length === 0 && !stateChanged) {
      report.status = residue.length ? 'partial' : 'unchanged';
      await finishCleanup(report, targetRoot, journal, ctx.nonce);
      return report;
    }

    await appendRecord(journal, { seq: ++ctx.seq, phase: 'planned', nonce: ctx.nonce, operation: 'uninstall',
      entries, priorState: state, nextState, createdDirs: ctx.createdDirs });

    const outcome = await executeTransaction(ctx, { operation: 'uninstall', entries, priorState: state, nextState });
    report.issues.push(...outcome.issues);
    report.mutations.applied = ctx.applied;
    if (outcome.status === 'interrupted') {
      report.status = 'interrupted';
      report.recoveryRequired = true;
      try { await journal.close(); } catch { /* Process death would not close it either. */ }
      return report;
    }
    if (outcome.status === 'rolled-back' || outcome.status === 'partial') {
      report.status = outcome.status;
      report.mutations.rolledBack = ctx.applied;
    } else if (residue.length > 0) {
      // Removals completed but owned residue remains: never report success.
      report.status = 'partial';
    } else {
      report.status = 'removed';
    }
    if (outcome.status === 'partial') {
      report.recoveryRequired = true; await journal.close(); return report;
    }
    const cleanup = await cleanupTransaction(targetRoot, journal, ctx.nonce);
    report.issues.push(...cleanup);
    if (cleanup.length) { report.status = 'partial'; report.recoveryRequired = true; }
    return report;
  } catch (error) {
    if (error instanceof CrashInjected) {
      report.status = 'interrupted'; report.recoveryRequired = true;
      report.issues.push(makeIssue('recovery', 'crash-injected', 'Injected pre-plan interruption'));
      await journal.close(); return report;
    }
    report.issues.push(error instanceof AbortInjected ? makeIssue('io', 'failpoint-abort', 'Injected pre-plan abort') : ioIssue(error));
    report.status = error instanceof AbortInjected ? 'rolled-back' : 'refused';
    const cleanup = await cleanupTransaction(targetRoot, journal, ctx.nonce);
    report.issues.push(...cleanup);
    if (cleanup.length) { report.status = 'partial'; report.recoveryRequired = true; }
    return report;
  }
}

// ---------------------------------------------------------------------------
// recoverInstall
// ---------------------------------------------------------------------------

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return errnoOf(error) !== 'ESRCH'; }
}

async function recoverLocked(options: RecoveryOptions): Promise<InstallReport> {
  const report = emptyReport('recover');
  const input = parseOptions(report, RecoveryOptionsSchema, options);
  if (!input) return report;
  const root = await inspectRoot(input.targetRoot);
  if (!root.ok) { report.issues.push(makeIssue('roots', 'root-invalid', root.message, undefined, root.code)); return report; }
  const targetRoot = root.root;
  const control = await inspectControlDir(targetRoot);
  if (!control.ok) { report.issues.push(control.issue); return report; }
  const lockRead = await readLock(targetRoot);
  if (!lockRead.ok) { report.issues.push(lockRead.issue); report.recoveryRequired = true; return report; }
  const lock = lockRead.lock;
  if (lock && lock.owner !== input.owner) {
    report.issues.push(makeIssue('ownership', 'ownership-mismatch', 'Lock owner differs from caller')); return report;
  }
  if (lock && processAlive(lock.pid) && !input.assumeDead) {
    report.issues.push(makeIssue('concurrent', 'live-lock', 'Lock records a live process'));
    report.recoveryRequired = true; return report;
  }
  const read = await readJournal(targetRoot);
  if (!read.ok) { report.issues.push(read.issue); report.recoveryRequired = true; return report; }
  const begin = read.records[0];
  if (begin?.phase === 'begin' && begin.owner !== input.owner) {
    report.issues.push(makeIssue('ownership', 'ownership-mismatch', 'Journal owner differs from caller')); return report;
  }
  if (begin?.phase === 'begin' && lock && (lock.nonce !== begin.nonce || lock.generation !== begin.generation || lock.operation !== begin.operation)) {
    report.issues.push(makeIssue('recovery', 'foreign-lock', 'Lock does not match journal'));
    report.recoveryRequired = true; return report;
  }
  if (!lock && await journalExists(targetRoot)) {
    report.issues.push(makeIssue('recovery', 'foreign-lock', 'Journal has no matching lock proof'));
    report.recoveryRequired = true; return report;
  }
  const plan = read.records.find(record => record.phase === 'planned');
  const rollingBack = read.records.some(record => record.phase === 'rolling-back');
  const committed = !rollingBack && read.records.some(record => record.phase === 'committed');
  if (!lock) {
    await removeEmptyControlDir(targetRoot);
    report.status = 'recovered'; return report;
  }
  // The live SQLite transaction lock is already held. Never unlink a live owner's lock.
  if (!begin) {
    if (await journalExists(targetRoot)) {
      // An empty journal can only precede intent and mutations.
      await rm(join(targetRoot, CONTROL_JOURNAL_PATH));
    }
    await releaseLock(targetRoot, lock.nonce); await removeEmptyControlDir(targetRoot);
    report.status = 'recovered';
    report.issues.push(makeIssue('recovery', 'recovered-back', 'Abandoned marker released without artifact changes'));
    return report;
  }
  const ctx: TxContext = { targetRoot, stageRoot: null, nonce: lock.nonce, failpoints: input.failpoints,
    journal: null, seq: read.records.length, createdDirs: plan?.phase === 'planned' ? plan.createdDirs : [],
    applied: 0 };
  try {
    if (plan?.phase === 'planned') {
      if (plan.entries.some(entry => entry.mode === undefined)) throw new Error('legacy permissions unknown');
      report.counts.planned = plan.entries.length;
      if (committed) {
        shot(ctx, 'after-recovery-decision');
        await assertState(targetRoot, [plan.nextState]);
        for (const entry of plan.entries) {
          if (entry.action === 'remove') {
            if (await safeInfo(targetRoot, entry.path)) throw new Error('removed path changed');
          } else if (!await matches(targetRoot, entry.path, entry.digest, entry.mode)) throw new Error('placed path changed');
        }
        await removeEmptyDirectories(targetRoot, (plan.priorState?.directories ?? []).filter(dir =>
          !plan.nextState?.entries.some(entry => entry.path.startsWith(`${dir}/`))));
        report.generation = plan.nextState?.generation ?? null;
      } else {
        if (!rollingBack) {
          const handle = await open(join(targetRoot, CONTROL_JOURNAL_PATH), process.platform === 'win32'
            ? 'a'
            : constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
          try { await appendRecord(handle, { seq: read.records.length + 1, phase: 'rolling-back' }); }
          finally { await handle.close(); }
        }
        shot(ctx, 'after-recovery-decision');
        if (!await rollbackInProcess(ctx, plan)) throw new Error('rollback incomplete');
        report.mutations.rolledBack = plan.entries.length;
        report.generation = plan.priorState?.generation ?? null;
      }
    }
    shot(ctx, 'before-cleanup');
    const cleanup = await cleanupTransaction(targetRoot, null, lock.nonce, ctx);
    report.issues.push(...cleanup);
    report.status = cleanup.length ? 'partial' : 'recovered';
    report.recoveryRequired = cleanup.length > 0;
    report.issues.push(makeIssue('recovery', committed ? 'recovered-forward' : 'recovered-back',
      committed ? 'Committed transaction finalized' : 'Interrupted transaction restored'));
  } catch {
    report.status = 'partial'; report.recoveryRequired = true;
    report.issues.push(makeIssue('recovery', 'rollback-incomplete', 'Changed recovery evidence or user content was preserved'));
  }
  return report;
}

// Keep one stable database inode, including after uninstall. No leases or PID
// takeover are involved: BEGIN IMMEDIATE is held only by a live connection.
// A separate durable marker/journal fences interrupted work after process death.
const activeRoots = new Set<string>();
async function serialized<T extends { targetRoot: string }>(operation: InstallOperation, schema: z.ZodType<T>,
  options: T, run: (options: T) => Promise<InstallReport>): Promise<InstallReport> {
  const report = emptyReport(operation);
  const input = parseOptions(report, schema, options);
  if (!input) return report;
  const root = await inspectRoot(input.targetRoot);
  if (!root.ok) { report.issues.push(makeIssue('roots', 'root-invalid', root.message, undefined, root.code)); return report; }
  const busy = () => { report.issues.push(makeIssue('concurrent', 'lock-held', 'Another operation holds the target coordination lock')); return report; };
  if (activeRoots.has(root.root)) return busy();
  activeRoots.add(root.root);
  let db: Database | undefined;
  try {
    const control = await inspectControlDir(root.root);
    if (!control.ok) { report.issues.push(control.issue); return report; }
    const path = join(root.root, CONTROL_COORDINATION_PATH);
    try {
      const handle = await open(path, 'wx', 0o600);
      try { await handle.sync(); } finally { await handle.close(); }
      await syncDir(root.root, CONTROL_DIR);
      await syncDir(root.root);
    } catch (error) { if (errnoOf(error) !== 'EEXIST') throw error; }
    for (const relative of [CONTROL_COORDINATION_PATH, ...['-journal', '-wal', '-shm'].map(suffix => CONTROL_COORDINATION_PATH + suffix)]) {
      const info = await safeInfo(root.root, relative);
      if (info && (!info.isFile() || info.nlink !== 1)) throw new Error('unsafe coordination file');
    }
    db = new Database(path, { strict: true });
    db.exec('PRAGMA busy_timeout = 0');
    // Explicit SQL is intentional: a synchronous transaction callback must not
    // return a Promise and release exclusion before asynchronous filesystem work.
    db.exec('BEGIN IMMEDIATE');
    return await run(input);
  } catch (error) {
    if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes(errnoOf(error) ?? '')) return busy();
    report.issues.push(ioIssue(error)); return report;
  } finally {
    try { db?.close(true); } finally { activeRoots.delete(root.root); }
  }
}

export function install(options: InstallOptions): Promise<InstallReport> {
  return installLocked(options);
}
export function uninstall(options: UninstallOptions): Promise<InstallReport> {
  return serialized('uninstall', UninstallOptionsSchema, options, uninstallLocked);
}
export function recoverInstall(options: RecoveryOptions): Promise<InstallReport> {
  return serialized('recover', RecoveryOptionsSchema, options, recoverLocked);
}

/** Validate the whole intent, not merely individual JSON records. */
function validJournal(records: JournalRecord[]): boolean {
  if (!records.length) return true;
  const begin = records[0];
  if (begin?.phase !== 'begin') return false;
  if (records.length === 1) return true;
  if (records[1]?.phase !== 'verified') return false;
  if (records.length === 2) return true;
  const plan = records[2];
  if (plan?.phase !== 'planned' || plan.nonce !== begin.nonce || plan.operation !== begin.operation) return false;
  for (const state of [plan.priorState, plan.nextState]) {
    if (state && (!validState(state) || state.owner !== begin.owner)) return false;
  }
  if (plan.operation === 'install') {
    if (!plan.nextState || plan.nextState.generation !== begin.generation ||
      (plan.priorState && plan.nextState.generation < plan.priorState.generation)) return false;
  } else if (!plan.priorState || plan.priorState.generation !== begin.generation ||
    (plan.nextState && (plan.nextState.generation !== begin.generation || plan.nextState.harness !== plan.priorState.harness))) return false;
  if (hasPathConflict(plan.entries.map(entry => entry.path).sort())) return false;
  const old = new Map(plan.priorState?.entries.map(entry => [entry.path, entry.digest]));
  const next = new Map(plan.nextState?.entries.map(entry => [entry.path, entry.digest]));
  const planned = new Map(plan.entries.map(entry => [entry.path, entry]));
  const events: { phase: string; path?: string }[] = [];
  for (const entry of plan.entries) {
    if (reserved(entry.path)) return false;
    const expected = (entry.action === 'remove' ? plan.priorState : plan.nextState)?.entries.find(item => item.path === entry.path);
    if (entry.mode !== expected?.mode) return false;
    if (entry.action === 'add') {
      if (entry.backup !== null || next.get(entry.path) !== entry.digest || plan.operation !== 'install') return false;
    } else {
      if (!old.has(entry.path) || entry.backup !== `${CONTROL_BACKUP_PATH}/${plan.nonce}/${entry.path}`) return false;
      events.push({ phase: 'backed-up', path: entry.path });
      if (entry.action === 'remove') {
        if (next.has(entry.path) || entry.digest !== old.get(entry.path)) return false;
      } else if (next.get(entry.path) !== entry.digest || plan.operation !== 'install') return false;
    }
    if (entry.action !== 'remove') events.push({ phase: 'placed', path: entry.path });
  }
  for (const [path, digest] of next) {
    if (!planned.has(path) && (old.get(path) !== digest ||
      plan.priorState?.entries.find(entry => entry.path === path)?.mode !== plan.nextState?.entries.find(entry => entry.path === path)?.mode)) return false;
  }
  // Missing stale files may be dropped without a mutation entry.
  if (new Set(plan.createdDirs).size !== plan.createdDirs.length || plan.createdDirs.some(dir => reserved(dir) ||
    !(plan.nextState?.directories ?? []).includes(dir) || (plan.priorState?.directories ?? []).includes(dir) ||
    !plan.entries.some(entry => entry.action === 'add' && entry.path.startsWith(`${dir}/`)))) return false;
  events.push({ phase: 'committed' }, { phase: 'finalized' });
  const actual = records.slice(3);
  if (actual.at(-1)?.phase === 'rolling-back') actual.pop();
  return actual.length <= events.length && actual.every((record, index) => {
    const expected = events[index]!;
    return record.phase === expected.phase && (!('path' in record) || record.path === expected.path);
  });
}

function plainData(value: unknown, seen = new Set<object>(), depth = 0): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return true;
  if (typeof value !== 'object' || seen.has(value) || depth > MAX_PLAIN_DATA_DEPTH) return false;
  seen.add(value);
  const proto = Object.getPrototypeOf(value);
  if (Array.isArray(value) ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return false;
  const keys = Reflect.ownKeys(value);
  const ok = keys.every(key => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === 'string' && Object.hasOwn(descriptor, 'value') && plainData(descriptor.value, seen, depth + 1);
  });
  seen.delete(value);
  return ok;
}

async function finishCleanup(report: InstallReport, root: string, journal: FileHandle | null, nonce: string): Promise<void> {
  const issues = await cleanupTransaction(root, journal, nonce);
  report.issues.push(...issues);
  if (issues.length) { report.status = 'partial'; report.recoveryRequired = true; }
}
