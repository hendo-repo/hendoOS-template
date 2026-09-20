import { constants } from 'node:fs';
import type { Stats } from 'node:fs';
import { lstat, open, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalize, digestOfString } from '../protocols/json';

export class VaultError extends Error { constructor(readonly code: string) { super(code); } }

export type VaultManifestEntry = {
  path: string; bytes: number; mode: number; digest: string;
};
export type VaultFinding = { code: string; path: string; detail?: string };
export type VaultInventory = {
  schema: 'hendoos.vault-inventory/v1'; root: string; manifestDigest: string;
  counts: { files: number; directories: number; symlinks: number; bytes: number; markdown: number;
    attachments: number; binaries: number; links: number; embeds: number; externalLinks: number };
  extensions: Record<string, number>; largest: Array<{ path: string; bytes: number }>;
  findings: VaultFinding[]; unscanned: Array<{ path: string; reason: string }>;
  entries: VaultManifestEntry[];
};

const MAX_FILES = 16_384;
const TEXT_SCAN_LIMIT = 2 * 1024 * 1024;
const READ_CHUNK = 128 * 1024;
const textExtensions = new Set(['.md', '.txt', '.json', '.js', '.cjs', '.ts', '.py', '.sh', '.yml', '.yaml', '.toml', '.css', '.html', '.go', '.patch', '.raw', '.base']);
const attachmentExtensions = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.mp3', '.mp4', '.mov', '.wav']);
const binaryExtensions = new Set(['.gz', '.zip', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.pyc', '.mp3', '.mp4', '.mov', '.wav']);
const credentialRules: Array<{ code: string; re: RegExp }> = [
  { code: 'credential-github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { code: 'credential-provider', re: /\b(?:sk-ant-|sk-)[A-Za-z0-9_-]{20,}\b/g },
  { code: 'credential-slack', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { code: 'credential-google', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { code: 'credential-private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g },
  { code: 'credential-jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

const portable = (root: string, path: string) => relative(root, path).split(sep).join('/');
const excluded = (path: string, exclusions: string[]) => exclusions.some(prefix => path === prefix || path.startsWith(prefix + '/'));

async function hashFile(path: string, expected: Stats): Promise<string> {
  const handle = await open(path, process.platform === 'win32' ? 'r' : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size !== expected.size || opened.ino !== expected.ino || opened.dev !== expected.dev) throw new VaultError('file-changed');
    const hasher = new Bun.CryptoHasher('sha256');
    const buffer = Buffer.allocUnsafe(READ_CHUNK);
    let offset = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      if (!bytesRead) break;
      offset += bytesRead; hasher.update(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat();
    if (offset !== expected.size || after.size !== expected.size || after.mtimeMs !== expected.mtimeMs || after.ctimeMs !== expected.ctimeMs) throw new VaultError('file-changed');
    return `sha256:${hasher.digest('hex')}`;
  } finally { await handle.close(); }
}

function linkTargets(source: string): { targets: Array<{ target: string; embed: boolean }>; external: number } {
  const targets: Array<{ target: string; embed: boolean }> = [];
  let external = 0;
  for (const match of source.matchAll(/(!?)\[\[([^\]]+)\]\]/g)) {
    const target = match[2]!.split('|')[0]!.split('#')[0]!.trim();
    if (target) targets.push({ target, embed: match[1] === '!' });
  }
  for (const match of source.matchAll(/!?\[[^\]]*\]\(([^)\s]+)(?:\s+['"][^)]*['"])?\)/g)) {
    const target = match[1]!.replace(/^<|>$/g, '');
    if (/^(?:https?:|mailto:|obsidian:)/i.test(target)) external++;
    else if (target && !target.startsWith('#') && !target.startsWith('data:')) targets.push({ target: target.split('#')[0]!, embed: match[0]!.startsWith('!') });
  }
  return { targets, external };
}

function linkResolves(from: string, target: string, paths: Set<string>, names: Map<string, number>): boolean {
  let decoded = target;
  try { decoded = decodeURIComponent(target); } catch { /* report the unresolved original */ }
  decoded = decoded.replaceAll('\\', '/').replace(/^\.\//, '');
  const candidates = [decoded, decoded + '.md', join(dirname(from), decoded).split(sep).join('/'), join(dirname(from), decoded + '.md').split(sep).join('/')];
  if (candidates.some(value => paths.has(value))) return true;
  const key = basename(decoded).replace(/\.md$/i, '').normalize('NFC').toLocaleLowerCase('en');
  return names.get(key) === 1;
}

/** Read-only inventory. It emits paths and rule ids, never matched credential values. */
export async function inventoryVault(inputRoot: string, exclusions: string[] = []): Promise<VaultInventory> {
  if (!isAbsolute(inputRoot)) throw new VaultError('absolute-root-required');
  const root = await realpath(inputRoot);
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new VaultError('invalid-root');
  const findings: VaultFinding[] = [], unscanned: Array<{ path: string; reason: string }> = [];
  const entries: VaultManifestEntry[] = [], dirs: string[] = [''], paths = new Set<string>(), text = new Map<string, string>();
  let directories = 0, symlinks = 0;
  while (dirs.length) {
    const relDir = dirs.shift()!; const absolute = join(root, relDir);
    for (const item of await readdir(absolute, { withFileTypes: true })) {
      const rel = (relDir ? `${relDir}/${item.name}` : item.name).normalize('NFC');
      if (excluded(rel, exclusions)) continue;
      const path = join(root, relDir, item.name); const info = await lstat(path);
      if (info.isSymbolicLink()) { symlinks++; findings.push({ code: 'symlink', path: rel }); continue; }
      if (item.isDirectory()) { directories++; dirs.push(rel); continue; }
      if (!item.isFile()) { findings.push({ code: 'non-regular', path: rel }); continue; }
      if (entries.length >= MAX_FILES) throw new VaultError('file-limit');
      const digest = await hashFile(path, await stat(path));
      entries.push({ path: rel, bytes: info.size, mode: info.mode & 0o777, digest }); paths.add(rel);
      const ext = extname(item.name).toLocaleLowerCase('en');
      if (info.size > TEXT_SCAN_LIMIT) unscanned.push({ path: rel, reason: 'text-scan-size-limit' });
      else if (textExtensions.has(ext) || ext === '') {
        try { text.set(rel, new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path))); }
        catch { unscanned.push({ path: rel, reason: 'invalid-utf8' }); }
      } else if (binaryExtensions.has(ext)) unscanned.push({ path: rel, reason: 'binary' });
    }
  }
  entries.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const collision = new Map<string, string[]>();
  for (const entry of entries) {
    const key = entry.path.normalize('NFC').toLocaleLowerCase('en');
    const list = collision.get(key) ?? []; list.push(entry.path); collision.set(key, list);
  }
  for (const list of collision.values()) if (list.length > 1) for (const path of list) findings.push({ code: 'case-or-unicode-collision', path, detail: list.filter(value => value !== path).join(', ') });
  const names = new Map<string, number>();
  for (const path of paths) if (path.toLocaleLowerCase('en').endsWith('.md')) {
    const key = basename(path, extname(path)).normalize('NFC').toLocaleLowerCase('en'); names.set(key, (names.get(key) ?? 0) + 1);
  }
  let links = 0, embeds = 0, externalLinks = 0;
  for (const entry of entries) {
    if (/(?:^|\/)(?:local\.[^/]*|\.env(?:\.[^/]*)?)$/i.test(entry.path)) findings.push({ code: 'local-config', path: entry.path });
    if (/(?:conflicted copy|\.sync-conflict| - copy(?: \(\d+\))?)/i.test(entry.path)) findings.push({ code: 'conflict-copy', path: entry.path });
  }
  for (const [path, source] of text) {
    for (const rule of credentialRules) { rule.re.lastIndex = 0; if (rule.re.test(source)) findings.push({ code: rule.code, path }); }
    if (!path.toLocaleLowerCase('en').endsWith('.md')) continue;
    const parsed = linkTargets(source); externalLinks += parsed.external;
    for (const target of parsed.targets) {
      links++; if (target.embed) embeds++;
      if (!linkResolves(path, target.target, paths, names)) findings.push({ code: target.embed ? 'unresolved-embed' : 'unresolved-link', path, detail: target.target });
    }
  }
  const extensions: Record<string, number> = {};
  for (const entry of entries) { const ext = extname(entry.path).toLocaleLowerCase('en') || '[none]'; extensions[ext] = (extensions[ext] ?? 0) + 1; }
  const counts = { files: entries.length, directories, symlinks, bytes: entries.reduce((n, value) => n + value.bytes, 0),
    markdown: entries.filter(value => value.path.toLocaleLowerCase('en').endsWith('.md')).length,
    attachments: entries.filter(value => attachmentExtensions.has(extname(value.path).toLocaleLowerCase('en'))).length,
    binaries: entries.filter(value => binaryExtensions.has(extname(value.path).toLocaleLowerCase('en'))).length,
    links, embeds, externalLinks };
  return { schema: 'hendoos.vault-inventory/v1', root, manifestDigest: digestOfString(canonicalize(entries)), counts,
    extensions: Object.fromEntries(Object.entries(extensions).sort(([a], [b]) => a.localeCompare(b))),
    largest: [...entries].sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)).slice(0, 50).map(({ path, bytes }) => ({ path, bytes })),
    findings: findings.sort((a, b) => a.path.localeCompare(b.path) || a.code.localeCompare(b.code)), unscanned, entries };
}

export function compareVaultInventories(left: VaultInventory, right: VaultInventory): object {
  const leftEntries = new Map(left.entries.map(value => [value.path, value]));
  const rightEntries = new Map(right.entries.map(value => [value.path, value]));
  const missing: string[] = [], added: string[] = [], changed: string[] = [];
  for (const [path, value] of leftEntries) {
    const other = rightEntries.get(path);
    if (!other) missing.push(path);
    else if (value.bytes !== other.bytes || value.mode !== other.mode || value.digest !== other.digest) changed.push(path);
  }
  for (const path of rightEntries.keys()) if (!leftEntries.has(path)) added.push(path);
  const status = missing.length || added.length || changed.length ? 'different' : 'identical';
  return { schema: 'hendoos.vault-compare/v1', status, left: left.manifestDigest, right: right.manifestDigest, missing, added, changed };
}
