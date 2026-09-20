import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { isInstallPath } from '../schema/install';

export type PathFailureCode = 'missing' | 'symlink' | 'not-directory' | 'not-file' | 'overlap' | 'unsafe-path' | 'changed' | 'unreadable';
export interface PathFailure { ok: false; code: PathFailureCode; message: string }
export type PathResult<T> = { ok: true; value: T } | PathFailure;
export interface SafeRoots { sourceRoot: string; targetRoot: string }

/**
 * Constant ceiling for any single artifact read by `readFileDigest`. Real bundles are
 * ~150 KB, so 16 MiB leaves generous headroom while keeping the helper from allocating
 * an unbounded buffer. Callers that must handle larger files stay out of scope here.
 */
export const ARTIFACT_SIZE_CEILING = 16 * 1024 * 1024;
/** Chunk sizing keeps the hashing buffer bounded regardless of file size. */
const READ_CHUNK_SIZE = 64 * 1024;

function failure(code: PathFailureCode, message: string): PathFailure { return { ok: false, code, message }; }

function ioFailure(error: unknown): PathFailure {
  const code = (error as NodeJS.ErrnoException)?.code;
  if (code === 'ENOENT') return failure('missing', 'Required filesystem entry is missing');
  if (code === 'ELOOP') return failure('symlink', 'Symbolic links are not allowed');
  if (code === 'ENOTDIR') return failure('not-directory', 'A path component is not a directory');
  return failure('unreadable', 'Filesystem entry could not be read');
}

/** Inspect every absolute component with lstat; do not follow even ancestor links. */
async function inspect(absolute: string, kind: 'file' | 'directory'): Promise<PathResult<Awaited<ReturnType<typeof lstat>>>> {
  let current = parse(absolute).root;
  const parts = absolute.slice(current.length).split(sep).filter(Boolean);
  try {
    let info = await lstat(current);
    for (let index = 0; index < parts.length; index++) {
      current = join(current, parts[index]!);
      info = await lstat(current);
      if (info.isSymbolicLink()) return failure('symlink', 'Symbolic links are not allowed in any path component');
      if (index < parts.length - 1 && !info.isDirectory()) return failure('not-directory', 'A path component is not a directory');
    }
    if (kind === 'directory' && !info.isDirectory()) return failure('not-directory', 'Root must be a directory');
    if (kind === 'file' && !info.isFile()) return failure('not-file', 'Manifest entry must be a regular file');
    return { ok: true, value: info };
  } catch (error) { return ioFailure(error); }
}

function rootPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && isAbsolute(value) &&
    !/[\u0000-\u001f\u007f]/.test(value) && !value.split(/[\\/]/).includes('..') && !value.split(/[\\/]/).includes('.');
}

function contains(root: string, candidate: string): boolean {
  const tail = relative(root.toLowerCase(), candidate.toLowerCase());
  return tail === '' || (tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail));
}

/** Explicit existing roots only. Sibling roots are allowed; aliases and nesting are not. */
export async function validateRoots(sourceRoot: string, targetRoot: string): Promise<PathResult<SafeRoots>> {
  if (!rootPath(sourceRoot) || !rootPath(targetRoot)) return failure('unsafe-path', 'Roots must be explicit absolute paths without traversal');
  const source = resolve(sourceRoot);
  const target = resolve(targetRoot);
  if (contains(source, target) || contains(target, source)) return failure('overlap', 'Source and target roots overlap');
  const sourceInfo = await inspect(source, 'directory');
  if (!sourceInfo.ok) return sourceInfo;
  const targetInfo = await inspect(target, 'directory');
  if (!targetInfo.ok) return targetInfo;
  try {
    const sourcePhysical = await realpath(source);
    const targetPhysical = await realpath(target);
    // Existing directory roots are resolved physically above. Windows/Bun can
    // report zero for both directory device and inode, so those fields are not
    // portable alias evidence; treating 0/0 as identity rejects every sibling.
    if (contains(sourcePhysical, targetPhysical) || contains(targetPhysical, sourcePhysical)) {
      return failure('overlap', 'Source and target roots physically overlap');
    }
    return { ok: true, value: { sourceRoot: sourcePhysical, targetRoot: targetPhysical } };
  } catch (error) { return ioFailure(error); }
}

/** Hash actual bytes through a read-only descriptor; refuse links and nonregular files. */
export async function readFileDigest(root: string, path: string): Promise<PathResult<string>> {
  if (!rootPath(root) || typeof path !== 'string' || !isInstallPath(path)) return failure('unsafe-path', 'Unsafe root or relative file path');
  const absolute = join(root, path);
  const before = await inspect(absolute, 'file');
  if (!before.ok) return before;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    // Bun on Windows rejects the POSIX numeric O_RDONLY value for ordinary
    // files. The portable string form opens the same read-only descriptor;
    // link refusal is still enforced by the inspections before and after open.
    handle = await open(absolute, process.platform === 'win32'
      ? 'r'
      : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.value.dev || opened.ino !== before.value.ino) {
      return failure('changed', 'File identity changed during inspection');
    }
    // Refuse on metadata before any allocation: an oversized artifact never gets buffered.
    if (opened.size > ARTIFACT_SIZE_CEILING) return failure('unreadable', 'File exceeds the artifact size ceiling');
    const hasher = new Bun.CryptoHasher('sha256');
    // One fixed-size buffer, reused per chunk: memory stays bounded even if the file grows mid-read.
    const buffer = Buffer.allocUnsafe(READ_CHUNK_SIZE);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, READ_CHUNK_SIZE, total);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > ARTIFACT_SIZE_CEILING) return failure('unreadable', 'File exceeded the artifact size ceiling while hashing');
      hasher.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    const pathAfter = await inspect(absolute, 'file');
    if (!pathAfter.ok) return pathAfter;
    if (total !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs ||
      pathAfter.value.dev !== opened.dev || pathAfter.value.ino !== opened.ino) {
      return failure('changed', 'File changed during inspection');
    }
    return { ok: true, value: `sha256:${hasher.digest('hex')}` };
  } catch (error) { return ioFailure(error); }
  finally {
    try { await handle?.close(); }
    catch { return failure('unreadable', 'File descriptor could not be closed'); }
  }
}
