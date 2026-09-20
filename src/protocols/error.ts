/**
 * AosError — the single error shape shared by every module in the pure core.
 *
 * Contract:
 *  - Pure core functions never throw for *expected* failures (malformed source,
 *    unsafe path, missing observation, membership mismatch). They return the value
 *    plus a list of `AosError` records so callers can render an explicit failure.
 *  - `aosError` is the only constructor; do not hand-roll object literals, so
 *    `severity`/`details` defaults stay uniform.
 *  - `path` is always a normalized safe relative path (see `protocols/paths`);
 *    `id` is a harness-generic content id. Never a filesystem absolute path.
 *  - `details` values are JSON-safe (see `protocols/json`).
 *
 * Vendor-name policy: this file lives in `src/protocols/`, the only place in the
 * repository where harness-specific naming is permitted. Core modules
 * (`src/schema`, `src/compose`, `src/policy`) use opaque harness id strings and
 * import only these generic primitives.
 */
import type { Json } from './json';

export type AosErrorSeverity = 'error' | 'warn';

export type AosErrorCode =
  // --- source / frontmatter -------------------------------------------------
  | 'frontmatter-missing'
  | 'frontmatter-unterminated'
  | 'frontmatter-parse-failed'
  | 'frontmatter-schema-invalid'
  | 'content-body-empty'
  // --- budget / path --------------------------------------------------------
  | 'byte-budget-exceeded'
  | 'unsafe-relative-path'
  // --- membership / activation ---------------------------------------------
  | 'duplicate-content-id'
  | 'membership-mismatch'
  | 'unknown-harness'
  | 'empty-index'
  | 'empty-selection'
  | 'activation-unknown'
  | 'reference-unresolved'
  | 'reference-declared-missing'
  | 'static-content-missing'
  // --- input shape ----------------------------------------------------------
  | 'invalid-input-shape'
  // --- manifest -------------------------------------------------------------
  | 'manifest-generation-regression'
  | 'manifest-source-digest-mismatch'
  // --- policy ---------------------------------------------------------------
  | 'policy-duplicate-rule-id'
  | 'policy-malformed-rule'
  | 'policy-rule-shape-invalid'
  | 'policy-indeterminate'
  // --- versioning -----------------------------------------------------------
  | 'unsupported-version'
  | 'internal-invariant';

export interface AosError {
  code: AosErrorCode;
  severity: AosErrorSeverity;
  message: string;
  details: Json;
  path: string | null;
  id: string | null;
}

export interface AosErrorInit {
  severity?: AosErrorSeverity;
  details?: Json;
  path?: string | null;
  id?: string | null;
}

/** Construct an `AosError`. Defaults: severity `error`, empty details, null refs. */
export function aosError(
  code: AosErrorCode,
  message: string,
  init: AosErrorInit = {},
): AosError {
  return {
    code,
    severity: init.severity ?? 'error',
    message,
    details: init.details ?? null,
    path: init.path ?? null,
    id: init.id ?? null,
  };
}

export function isAosError(value: unknown): value is AosError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<AosError>;
  return (
    typeof candidate.code === 'string' &&
    typeof candidate.message === 'string' &&
    (candidate.severity === 'error' || candidate.severity === 'warn')
  );
}

/**
 * Deterministic ordering for error lists: code, then path, then id, then message.
 * Every module that returns an `errors` array sorts with this so two runs with the
 * same inputs produce byte-identical output.
 */
export function sortErrors(errors: readonly AosError[]): AosError[] {
  return [...errors].sort(compareErrors);
}

export function compareErrors(a: AosError, b: AosError): number {
  return (
    cmp(a.code, b.code) ||
    cmp(a.path ?? '', b.path ?? '') ||
    cmp(a.id ?? '', b.id ?? '') ||
    cmp(a.message, b.message)
  );
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** True when any record has severity `error` (a `warn`-only list is not a failure). */
export function hasError(errors: readonly AosError[]): boolean {
  return errors.some((e) => e.severity === 'error');
}
