import { z } from 'zod';
import { normalizeRelativePath } from '../protocols/paths';

const prototypeNames = new Set(Object.getOwnPropertyNames(Object.prototype).map((name) => name.toLowerCase()));
prototypeNames.add('prototype');

/** Strict, portable, already-normalized file names; never silently normalize input. */
export function isInstallPath(value: string): boolean {
  const normalized = normalizeRelativePath(value);
  return normalized.ok && normalized.path === value && value.normalize('NFC') === value &&
    value.split('/').every((part) => !prototypeNames.has(part.toLowerCase()) &&
      !/[<>:"|?*]/.test(part) && !/[. ]$/.test(part) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

const PlainObjectSchema = z.custom<Record<string, unknown>>((value) => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null) &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string' &&
      Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}, 'Expected a plain JSON object without accessors');

export const InstallEntrySchema = PlainObjectSchema.pipe(z.strictObject({
  path: z.string().refine(isInstallPath, 'Expected a normalized safe relative file path'),
  // A length guard prevents the JavaScript `$` end-anchor accepting a final newline.
  digest: z.string().length(71).regex(/^sha256:[a-f0-9]{64}$/),
}));

export const InstallManifestSchema = PlainObjectSchema.pipe(z.strictObject({
  schemaVersion: z.literal(1),
  owner: z.string().refine((value) => value.trim().length > 0, 'Owner must be nonempty'),
  generation: z.int().positive(),
  harness: z.string().min(1),
  sources: z.array(InstallEntrySchema).min(1),
  outputs: z.array(InstallEntrySchema).min(1),
})).superRefine((manifest, ctx) => {
  for (const field of ['sources', 'outputs'] as const) {
    const seen = new Set<string>();
    const spellings = new Map<string, string>();
    manifest[field].forEach((entry, index) => {
      const key = entry.path.toLowerCase();
      if (seen.has(key)) ctx.addIssue({ code: 'custom', path: [field, index, 'path'], message: 'Duplicate or case-fold alias' });
      seen.add(key);
      const parts = entry.path.split('/');
      for (let length = 1; length <= parts.length; length++) {
        const prefix = parts.slice(0, length).join('/');
        const folded = prefix.toLowerCase();
        const previous = spellings.get(folded);
        if (previous !== undefined && previous !== prefix) {
          ctx.addIssue({ code: 'custom', path: [field, index, 'path'], message: 'Case-fold component alias' });
        }
        spellings.set(folded, prefix);
      }
    });
    manifest[field].forEach((entry, index) => {
      const parts = entry.path.toLowerCase().split('/');
      for (let length = 1; length < parts.length; length++) {
        if (seen.has(parts.slice(0, length).join('/'))) {
          ctx.addIssue({ code: 'custom', path: [field, index, 'path'], message: 'File path has a manifest file ancestor' });
        }
      }
    });
  }
});

export type InstallEntry = z.infer<typeof InstallEntrySchema>;
export type InstallManifest = z.infer<typeof InstallManifestSchema>;
