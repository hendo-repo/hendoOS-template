#!/usr/bin/env bun
import { chmod, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitEnv, scanPublicRepo } from "./check-public.ts";

export const EXPORT_SCHEMA = "hendoos.public-export/v1";
export const EXPORT_REPORT_SCHEMA = "hendoos.public-export-report/v1";
export const MANIFEST_PATH = "public-export.manifest.json";
export const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));

export interface PublicExportManifest {
  schema: typeof EXPORT_SCHEMA;
  publicRepository: string;
  files: string[];
  validationCommands: string[][];
}

export interface PublicExportOptions {
  sourceRoot: string;
  revision: string;
  destination: string;
  reportPath: string;
  env?: Record<string, string | undefined>;
}

export interface PublicExportReport {
  schema: typeof EXPORT_REPORT_SCHEMA;
  sourceCommit: string;
  sourceManifestBlob: string;
  stagedCommit: string;
  publicRepository: string;
  files: Array<{ path: string; mode: "100644" | "100755"; sourceBlob: string; sha256: string; bytes: number }>;
  validationCommands: string[][];
  publicScan: { result: "pass"; candidates: number; commits: number; ruleIds: string[] };
}

export class PublicExportError extends Error {
  constructor(readonly code: string, readonly detail?: string) {
    super(code);
    this.name = "PublicExportError";
  }
}

type TreeEntry = { mode: string; type: string; object: string; path: string };

function cleanRelativePath(value: unknown): string {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\\") || isAbsolute(value)) {
    throw new PublicExportError("invalid-manifest-path");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === "..") || parts[0] === ".git") {
    throw new PublicExportError("invalid-manifest-path");
  }
  return parts.join("/");
}

function parseCommand(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every((part) => typeof part === "string" && part.length > 0 && !part.includes("\0"))) {
    throw new PublicExportError("invalid-validation-command");
  }
  return [...value];
}

export function parsePublicExportManifest(text: string): PublicExportManifest {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new PublicExportError("invalid-manifest-json"); }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PublicExportError("invalid-manifest");
  const value = raw as Record<string, unknown>;
  const keys = Object.keys(value).sort();
  const expected = ["files", "publicRepository", "schema", "validationCommands"].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected) || value.schema !== EXPORT_SCHEMA ||
      typeof value.publicRepository !== "string" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.publicRepository)) {
    throw new PublicExportError("invalid-manifest");
  }
  if (!Array.isArray(value.files) || value.files.length === 0) throw new PublicExportError("empty-export");
  const files = value.files.map(cleanRelativePath);
  if (new Set(files).size !== files.length || files.some((path, index) => index > 0 && files[index - 1]! >= path)) {
    throw new PublicExportError("manifest-files-not-unique-sorted");
  }
  const folded = new Set<string>();
  for (const path of files) {
    const key = path.toLocaleLowerCase("en-US");
    if (folded.has(key)) throw new PublicExportError("case-colliding-export-paths");
    folded.add(key);
  }
  if (!files.includes(MANIFEST_PATH)) throw new PublicExportError("manifest-not-self-exported");
  if (!Array.isArray(value.validationCommands) || value.validationCommands.length === 0) {
    throw new PublicExportError("missing-validation-commands");
  }
  return {
    schema: EXPORT_SCHEMA,
    publicRepository: value.publicRepository,
    files,
    validationCommands: value.validationCommands.map(parseCommand),
  };
}

function runGit(root: string, args: string[], env: Record<string, string | undefined>): Uint8Array {
  const result = Bun.spawnSync(["git", "-C", root, ...args], {
    env: gitEnv(env), stdout: "pipe", stderr: "pipe",
  });
  if (!result.success) throw new PublicExportError("git-command-failed", args[0]);
  return result.stdout;
}

function gitText(root: string, args: string[], env: Record<string, string | undefined>): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(runGit(root, args, env)).trim();
}

function parseTree(bytes: Uint8Array): Map<string, TreeEntry> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const entries = new Map<string, TreeEntry>();
  for (const record of text.split("\0")) {
    if (!record) continue;
    const match = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record);
    if (!match) throw new PublicExportError("unreadable-source-tree");
    const entry = { mode: match[1]!, type: match[2]!, object: match[3]!, path: match[4]! };
    entries.set(entry.path, entry);
  }
  return entries;
}

async function assertAbsent(path: string, code: string): Promise<void> {
  try { await lstat(path); throw new PublicExportError(code); }
  catch (error) {
    if (error instanceof PublicExportError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new PublicExportError("path-inspection-failed");
  }
}

async function listFiles(root: string, current = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(root, current), { withFileTypes: true })) {
    if (!current && entry.name === ".git") continue;
    const rel = current ? `${current}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await listFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
    else throw new PublicExportError("non-regular-staged-path", rel);
  }
  return out.sort();
}

function sha256(bytes: Uint8Array): string {
  return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

function safeDestination(sourceRoot: string, destination: string, reportPath: string): void {
  const source = resolve(sourceRoot);
  const dest = resolve(destination);
  const report = resolve(reportPath);
  if (dest === source || relative(source, dest) === "" || !relative(source, dest).startsWith("..") ||
      dest === resolve(dest, "/") || report === dest || !relative(dest, report).startsWith("..")) {
    throw new PublicExportError("unsafe-output-location");
  }
}

export async function exportPublicRevision(options: PublicExportOptions): Promise<PublicExportReport> {
  const sourceRoot = resolve(options.sourceRoot);
  const destination = resolve(options.destination);
  const reportPath = resolve(options.reportPath);
  const env = { ...process.env, ...options.env };
  safeDestination(sourceRoot, destination, reportPath);
  await assertAbsent(destination, "destination-already-exists");
  await assertAbsent(reportPath, "report-already-exists");

  const sourceCommit = gitText(sourceRoot, ["rev-parse", "--verify", `${options.revision}^{commit}`], env);
  if (!/^[0-9a-f]{40,64}$/.test(sourceCommit)) throw new PublicExportError("invalid-source-commit");
  const tree = parseTree(runGit(sourceRoot, ["ls-tree", "-rz", "--full-tree", sourceCommit], env));
  const manifestEntry = tree.get(MANIFEST_PATH);
  if (!manifestEntry || manifestEntry.type !== "blob" || manifestEntry.mode !== "100644") {
    throw new PublicExportError("manifest-not-regular-file");
  }
  const manifestBytes = runGit(sourceRoot, ["cat-file", "blob", manifestEntry.object], env);
  const manifest = parsePublicExportManifest(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));

  const reportFiles: PublicExportReport["files"] = [];
  await mkdir(destination, { recursive: false });
  for (const path of manifest.files) {
    const entry = tree.get(path);
    if (!entry) throw new PublicExportError("manifest-file-missing", path);
    if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) {
      throw new PublicExportError("unsupported-source-entry", path);
    }
    const bytes = runGit(sourceRoot, ["cat-file", "blob", entry.object], env);
    const target = join(destination, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
    await chmod(target, entry.mode === "100755" ? 0o755 : 0o644);
    reportFiles.push({ path, mode: entry.mode, sourceBlob: entry.object, sha256: sha256(bytes), bytes: bytes.byteLength });
  }
  const stagedFiles = await listFiles(destination);
  if (JSON.stringify(stagedFiles) !== JSON.stringify(manifest.files)) throw new PublicExportError("staged-file-set-mismatch");

  runGit(destination, ["init", "-q", "-b", "main"], env);
  runGit(destination, ["add", "--all"], env);
  runGit(destination, [
    "-c", "user.name=hendoOS Export",
    "-c", "user.email=hendoos-export@users.noreply.github.com",
    "commit", "-q", "-m", "chore: publish hendoOS template export",
  ], env);
  const stagedCommit = gitText(destination, ["rev-parse", "HEAD"], env);
  const scan = scanPublicRepo({ root: destination, env });
  if (scan.result !== "pass" || scan.fatal) {
    const ids = [...new Set([...scan.findings, ...scan.errors].map((finding) => finding.ruleId))].sort();
    throw new PublicExportError("public-scan-failed", ids.join(","));
  }
  const report: PublicExportReport = {
    schema: EXPORT_REPORT_SCHEMA,
    sourceCommit,
    sourceManifestBlob: manifestEntry.object,
    stagedCommit,
    publicRepository: manifest.publicRepository,
    files: reportFiles,
    validationCommands: manifest.validationCommands,
    publicScan: { result: "pass", candidates: scan.stats.candidates, commits: scan.history.commits, ruleIds: [] },
  };
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  return report;
}

function usage(): string {
  return "usage: bun scripts/export-public.ts --source-root PATH --revision REV --destination PATH --report PATH";
}

function parseArgs(args: string[]): PublicExportOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1];
    if (!flag || !value || !["--source-root", "--revision", "--destination", "--report"].includes(flag) || values.has(flag)) {
      throw new PublicExportError("usage");
    }
    values.set(flag, value);
  }
  if (values.size !== 4) throw new PublicExportError("usage");
  return {
    sourceRoot: values.get("--source-root")!, revision: values.get("--revision")!,
    destination: values.get("--destination")!, reportPath: values.get("--report")!,
  };
}

if (import.meta.main) {
  try {
    if (process.argv.slice(2).includes("--help")) {
      if (process.argv.length !== 3) throw new PublicExportError("usage");
      console.log(usage());
    } else {
      const report = await exportPublicRevision(parseArgs(process.argv.slice(2)));
      console.log(JSON.stringify({ schema: report.schema, status: "pass", stagedCommit: report.stagedCommit,
        files: report.files.length, bytes: report.files.reduce((sum, file) => sum + file.bytes, 0) }));
    }
  } catch (error) {
    const failure = error instanceof PublicExportError ? error : new PublicExportError("unexpected-export-failure");
    console.error(JSON.stringify({ schema: EXPORT_REPORT_SCHEMA, status: "fail", code: failure.code, detail: failure.detail }));
    process.exitCode = 1;
  }
}
