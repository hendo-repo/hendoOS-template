/**
 * Canonical JSON + digest primitives.
 *
 * `canonicalize` is the single definition of "the bytes we hash". It is a pure
 * function of its input: object keys are sorted, `-0` normalizes to `0`, and
 * non-JSON values (undefined, function, symbol, bigint, NaN, Infinity), cycles and
 * non-plain objects (Map/Set/class instances, except plain objects/arrays) are
 * rejected with an `AosError` rather than silently coerced. Digests taken with
 * this function are therefore stable across runs, platforms and key insertion
 * order.
 */
import { aosError, type AosError } from './error';

export type JsonPrimitive = string | number | boolean | null;
export type Json = JsonPrimitive | Json[] | { [key: string]: Json };

const SHA256_HEX = /^[a-f0-9]{64}$/;

/**
 * Normalize an arbitrary value into canonical JSON source text.
 * Throws `AosError('internal-invariant')` for non-JSON input.
 */
export function canonicalize(value: unknown): string {
  return write(normalize(value, []), 0);
}

/** Normalize + parse-free deep copy into a JSON-safe value. Throws on non-JSON. */
export function toJsonValue(value: unknown): Json {
  return normalize(value, []);
}

function fail(message: string, details: Json): never {
  throw aosError('internal-invariant', message, { details });
}

function normalize(value: unknown, stack: object[]): Json {
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
      return value;
    case 'string':
      return value;
    case 'number':
      if (!Number.isFinite(value)) {
        fail('canonicalize rejects non-finite numbers', { value: String(value) });
      }
      return Object.is(value, -0) ? 0 : value;
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      fail('canonicalize rejects non-JSON values', { type: typeof value });
      break;
    case 'object':
      break;
    default:
      fail('canonicalize received an unsupported value', { type: typeof value });
  }

  const asObject = value as object;
  if (stack.includes(asObject)) {
    fail('canonicalize rejects cyclic values', { depth: stack.length });
  }
  stack.push(asObject);
  try {
    if (Array.isArray(asObject)) {
      const out: Json[] = asObject.map((entry) => normalize(entry, stack));
      return out;
    }
    const proto: unknown = Object.getPrototypeOf(asObject);
    if (proto !== Object.prototype && proto !== null) {
      fail('canonicalize accepts only plain objects and arrays', {
        constructor: (asObject as { constructor?: { name?: string } }).constructor?.name ?? 'unknown',
      });
    }
    const record = asObject as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort();
    const out: { [key: string]: Json } = Object.create(null);
    for (const key of keys) {
      out[key] = normalize(record[key], stack);
    }
    return out;
  } finally {
    stack.pop();
  }
}

function write(value: Json, depth: number): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    default:
      break;
  }
  if (Array.isArray(value)) {
    let out = '[';
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0) out += ',';
      out += write(value[index] as Json, depth + 1);
    }
    return `${out}]`;
  }
  const keys = Object.keys(value).sort();
  let out = '{';
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    if (index > 0) out += ',';
    out += `${JSON.stringify(key)}:${write(value[key] as Json, depth + 1)}`;
  }
  return `${out}}`;
}

/** Lowercase hex SHA-256 of the UTF-8 encoding of `input`. Pure. */
export function sha256Hex(input: string): string {
  return new Bun.CryptoHasher('sha256').update(input).digest('hex');
}

/** Digest of a UTF-8 string, in the repo-wide wire form `sha256:<64 hex>`. */
export function digestOfString(input: string): string {
  return `sha256:${sha256Hex(input)}`;
}

/** Digest of a canonicalized JSON value. Throws on non-JSON input. */
export function digestOfJson(value: unknown): string {
  return digestOfString(canonicalize(value));
}

export function isDigest(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('sha256:') && value.length === 71 && SHA256_HEX.test(value.slice(7));
}

/** Narrow a JSON value to a plain object record (no prototypes beyond Object). */
export function isJsonRecord(value: unknown): value is { [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type { AosError };
