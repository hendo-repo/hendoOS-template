/** Shared pure validators. No coercion and no unknown configuration keys. */
import { z } from 'zod';
import type { Json } from './json';
import { normalizeRelativePath } from './paths';

export const TokenSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*(?![\s\S])/, 'expected a non-empty token');
export const HarnessSchema = z.union([z.literal('*'), TokenSchema]);
export const ContentIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]*(?![\s\S])/);
export const DigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}(?![\s\S])/);
export const RelativePathSchema = z.string().refine(value => {
  const result = normalizeRelativePath(value);
  return result.ok && result.path === value;
}, 'expected a normalized relative path');
export const UniqueTokensSchema = z.array(TokenSchema).refine(ids => new Set(ids).size === ids.length, 'duplicate token');

// Validate arbitrary JSON before recursive Zod parsing or hashing. Cycles, accessors,
// undefined, special objects and non-finite numbers are not JSON wire values.
function isJson(value: unknown, ancestors = new Set<object>(), depth = 0): value is Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 100 || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  if (Reflect.ownKeys(value).some(key => typeof key === 'symbol')) return false;
  ancestors.add(value);
  try {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(d => d.get || d.set)) return false;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) if (!Object.hasOwn(value, i) || !isJson(value[i], ancestors, depth + 1)) return false;
      return Object.keys(value).length === value.length;
    }
    return Object.values(descriptors).every(d => isJson(d.value, ancestors, depth + 1));
  } finally { ancestors.delete(value); }
}
export const JsonValueSchema = z.custom<Json>(value => {
  try { return isJson(value); } catch { return false; }
}, 'expected finite, acyclic JSON');

/** Also catches hostile accessors/proxies at a runtime boundary. */
export function safeParse<T>(schema: z.ZodType<T>, input: unknown) {
  try { return schema.safeParse(input); }
  catch { return { success: false as const, error: { issues: [{ path: [] as PropertyKey[], message: 'input could not be inspected safely' }] } }; }
}
