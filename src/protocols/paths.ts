/**
 * Safe relative path normalization.
 *
 * Every path that crosses a contract boundary (manifest sources, membership
 * manifest roots, content frontmatter `id`) is stored *normalized and relative*.
 * Absolute paths, drive letters, UNC prefixes, home-relative forms, `~`, `..`
 * traversal and NUL bytes are rejected, and the unsafe path itself is never echoed
 * back into the returned error — only a masked form — so a rejected input cannot
 * leak a machine-local location into build output.
 */
import { aosError, type AosError } from './error';

export interface NormalizedPath {
  ok: true;
  /** POSIX-style relative path, no leading `./`, no trailing `/`. */
  path: string;
}

export interface UnsafePath {
  ok: false;
  error: AosError;
}

export type PathResult = NormalizedPath | UnsafePath;

const UNSAFE_CHARS = /[\u0000-\u001f\u007f]/;
const SEPARATORS = /[\\/]+/;

/** Mask a rejected path: keep only its last segment's length shape, never content. */
function maskPath(input: string): string {
  if (input.length === 0) return '<empty>';
  return `<rejected:${input.length} chars>`;
}

/**
 * Normalize `input` to a safe repo-relative POSIX path.
 *
 * Accepts `a/b.md`, `./a/b.md`, `a//b.md`, `a\b.md`.
 * Rejects absolute (`/x`), home (`~`), drive (`C:\`), UNC (`\\host`), traversal
 * (`../x`, `a/../b`) and control characters.
 */
export function normalizeRelativePath(input: string): PathResult {
  if (typeof input !== 'string' || input.length === 0) {
    return { ok: false, error: unsafe(input, 'path is empty') };
  }
  if (UNSAFE_CHARS.test(input)) {
    return { ok: false, error: unsafe(input, 'path contains control characters') };
  }
  if (input.startsWith('~')) {
    return { ok: false, error: unsafe(input, 'home-relative paths are not allowed') };
  }
  if (/^[a-zA-Z]:/.test(input)) {
    return { ok: false, error: unsafe(input, 'drive-letter paths are not allowed') };
  }
  if (input.startsWith('/') || input.startsWith('\\')) {
    return { ok: false, error: unsafe(input, 'absolute paths are not allowed') };
  }

  const segments: string[] = [];
  for (const raw of input.split(SEPARATORS)) {
    if (raw === '' || raw === '.') continue;
    if (raw === '..') {
      return { ok: false, error: unsafe(input, 'path traversal is not allowed') };
    }
    segments.push(raw);
  }
  if (segments.length === 0) {
    return { ok: false, error: unsafe(input, 'path resolves to the repo root') };
  }
  const normalized = segments.join('/');
  if (normalized.length > 1024) {
    return { ok: false, error: unsafe(input, 'path exceeds 1024 characters') };
  }
  return { ok: true, path: normalized };
}

function unsafe(input: string, reason: string): AosError {
  return aosError('unsafe-relative-path', `unsafe relative path rejected: ${reason}`, {
    details: { reason, input: maskPath(input) },
  });
}

/** True when `candidate` is `prefix` or sits underneath it (segment-wise). */
export function isPathUnder(candidate: string, prefix: string): boolean {
  if (candidate === prefix) return true;
  return candidate.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
}

/** Join already-normalized segments; does not validate (callers normalize first). */
export function joinRelative(...segments: readonly string[]): string {
  return segments
    .flatMap((segment) => segment.split('/'))
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

/** The last segment of a normalized path. */
export function basename(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? path : path.slice(index + 1);
}

/** The directory portion of a normalized path (`''` when there is none). */
export function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.slice(0, index);
}

/** Stable ordering for path lists: plain byte-wise ascending. */
export function sortPaths(paths: readonly string[]): string[] {
  return [...paths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
