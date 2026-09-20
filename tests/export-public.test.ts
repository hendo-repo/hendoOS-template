import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  EXPORT_SCHEMA,
  MANIFEST_PATH,
  PublicExportError,
  exportPublicRevision,
  parsePublicExportManifest,
} from "../scripts/export-public.ts";
import { gitEnv } from "../scripts/check-public.ts";

const roots: string[] = [];
const baseEnv = gitEnv(process.env);

function git(root: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-C", root, ...args], { env: baseEnv, stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error("fixture git failed: " + result.stderr.toString());
  return result.stdout.toString().trim();
}

function put(root: string, path: string, body: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), body);
}

async function temp(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function sourceRepo(
  publicFiles: Record<string, string> = { "README.md": "Public fixture\n" },
  privateFiles: Record<string, string> = {},
): Promise<{ root: string; commit: string; files: string[] }> {
  const root = await temp("hendoos-export-source-");
  git(root, "init", "-q", "-b", "main");
  const files = [...Object.keys(publicFiles), MANIFEST_PATH].sort();
  const manifest = {
    schema: EXPORT_SCHEMA,
    publicRepository: "fixture/public-template",
    files,
    validationCommands: [["bun", "--version"]],
  };
  for (const [path, body] of Object.entries(publicFiles)) put(root, path, body);
  for (const [path, body] of Object.entries(privateFiles)) put(root, path, body);
  put(root, MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
  git(root, "add", "--all");
  git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com",
    "commit", "-q", "-m", "fixture source");
  return { root, commit: git(root, "rev-parse", "HEAD"), files };
}

async function runExport(
  source: { root: string; commit: string },
  env: Record<string, string | undefined> = {},
): Promise<{ stage: string; report: string; result: Awaited<ReturnType<typeof exportPublicRevision>> }> {
  const parent = await temp("hendoos-export-output-");
  const stage = join(parent, "stage");
  const report = join(parent, "evidence", "report.json");
  const result = await exportPublicRevision({
    sourceRoot: source.root,
    revision: source.commit,
    destination: stage,
    reportPath: report,
    env,
  });
  return { stage, report, result };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public export manifest", () => {
  test("is strict, exact, sorted, self-exporting, and case collision safe", () => {
    const valid = {
      schema: EXPORT_SCHEMA,
      publicRepository: "fixture/template",
      files: ["README.md", MANIFEST_PATH].sort(),
      validationCommands: [["bun", "verify"]],
    };
    expect(parsePublicExportManifest(JSON.stringify(valid)).files).toEqual(valid.files);
    for (const mutation of [
      { ...valid, extra: true },
      { ...valid, files: ["README.md"] },
      { ...valid, files: [MANIFEST_PATH, "../private.md"] },
      { ...valid, files: [MANIFEST_PATH, "docs/A.md", "docs/a.md"].sort() },
      { ...valid, files: [MANIFEST_PATH, "README.md", "README.md"].sort() },
    ]) expect(() => parsePublicExportManifest(JSON.stringify(mutation))).toThrow(PublicExportError);
  });
});

describe("revision-bound public export", () => {
  test("exports only allowlisted committed blobs with independent history and a private report", async () => {
    const source = await sourceRepo(
      { "README.md": "Public fixture\n", "bin/tool.sh": "#!/bin/sh\nexit 0\n" },
      { "config/operator.json": "{\"private\":true}\n", "vault/private.md": "not exported\n" },
    );
    chmodSync(join(source.root, "bin/tool.sh"), 0o755);
    git(source.root, "update-index", "--chmod=+x", "bin/tool.sh");
    git(source.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com",
      "commit", "-q", "-m", "mark executable");
    source.commit = git(source.root, "rev-parse", "HEAD");
    const { stage, report, result } = await runExport(source);
    expect(result.sourceCommit).toBe(source.commit);
    expect(result.stagedCommit).not.toBe(source.commit);
    expect(result.publicScan).toMatchObject({ result: "pass", commits: 1 });
    expect(result.files.map((file) => file.path)).toEqual(source.files);
    expect(result.files.find((file) => file.path === "bin/tool.sh")?.mode).toBe("100755");
    if (process.platform !== "win32") expect(lstatSync(join(stage, "bin/tool.sh")).mode & 0o111).not.toBe(0);
    expect(() => lstatSync(join(stage, "config/operator.json"))).toThrow();
    expect(() => lstatSync(join(stage, "vault/private.md"))).toThrow();
    expect(JSON.parse(readFileSync(report, "utf8")).sourceCommit).toBe(source.commit);
    if (process.platform !== "win32") expect(lstatSync(report).mode & 0o077).toBe(0);
    expect(git(stage, "rev-list", "--count", "HEAD")).toBe("1");
  });

  test("reads the selected commit, not dirty working-tree replacements", async () => {
    const source = await sourceRepo();
    put(source.root, "README.md", "dirty private replacement\n");
    const { stage } = await runExport(source);
    expect(readFileSync(join(stage, "README.md"), "utf8")).toBe("Public fixture\n");
  });

  test("rejects tracked symlinks instead of following them", async () => {
    const source = await sourceRepo({ "README.md": "Public\n", "linked.md": "placeholder\n" });
    rmSync(join(source.root, "linked.md"));
    symlinkSync("README.md", join(source.root, "linked.md"));
    git(source.root, "add", "--all");
    git(source.root, "-c", "user.name=Fixture", "-c", "user.email=fixture@users.noreply.github.com",
      "commit", "-q", "-m", "symlink fixture");
    source.commit = git(source.root, "rev-parse", "HEAD");
    await expect(runExport(source)).rejects.toMatchObject({ code: "unsupported-source-entry", detail: "linked.md" });
  });

  test("planted configured identities and tracker variants fail without echoing values", async () => {
    const identity = "Synthetic" + crypto.randomUUID().replaceAll("-", "");
    const trackerStem = "FixturePrivate";
    const source = await sourceRepo({
      "README.md": identity.toLocaleLowerCase("en-US") + "\n" +
        trackerStem.toLocaleLowerCase("en-US") + "_418\n",
    });
    let error: unknown;
    try {
      await runExport(source, {
        AOS_CHECK_PUBLIC_PRIVATE_TOKENS: "operator=" + identity,
        AOS_CHECK_PUBLIC_TRACKER_PREFIXES: "tracker=" + trackerStem + "-",
      });
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(PublicExportError);
    expect(error).toMatchObject({ code: "public-scan-failed" });
    expect(JSON.stringify(error)).not.toContain(identity);
    expect(JSON.stringify(error)).not.toContain(trackerStem);
  });
});
