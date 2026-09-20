/**
 * `Outcome<T>` — the uniform return envelope of every pure entry point.
 *
 * One shape for `composeContent`, `evaluatePolicy`, `buildActivation`,
 * `evaluateMembership` and `composeVersionedPayload`, so callers can branch once:
 *
 * - `ok`       — false when any record carries severity `error`; the value may
 *                still be a usable degraded product (see `degraded`).
 * - `degraded` — true when the value was produced from incomplete, empty or
 *                explicitly substituted input. Degraded is never silent: every
 *                degradation also appears in `errors` as a record (severity
 *                `warn` or `error`) naming what was missing.
 * - `errors`   — deterministically sorted records (see `sortErrors`).
 * - `value`    — the product. Always present; never `undefined`.
 *
 * Expected failures are returned, never thrown. `canonicalize` is the one
 * documented exception (it throws `internal-invariant` on non-JSON input).
 */
import { hasError, sortErrors, type AosError } from './error';

export interface Outcome<T> {
  ok: boolean;
  degraded: boolean;
  errors: readonly AosError[];
  value: T;
}

export function outcome<T>(
  value: T,
  errors: readonly AosError[] = [],
  degraded = false,
): Outcome<T> {
  const sorted = sortErrors(errors);
  return { ok: !hasError(sorted), degraded: degraded || hasError(sorted), errors: sorted, value };
}

/** Map the value of an outcome, preserving `ok`/`degraded`/`errors`. */
export function mapOutcome<T, U>(source: Outcome<T>, map: (value: T) => U): Outcome<U> {
  return { ok: source.ok, degraded: source.degraded, errors: source.errors, value: map(source.value) };
}

/** Fold a list of outcomes into one; values are collected in input order. */
export function collect<T>(outcomes: readonly Outcome<T>[]): Outcome<T[]> {
  const errors: AosError[] = [];
  const values: T[] = [];
  let degraded = false;
  for (const entry of outcomes) {
    errors.push(...entry.errors);
    values.push(entry.value);
    degraded = degraded || entry.degraded;
  }
  return outcome(values, errors, degraded);
}
