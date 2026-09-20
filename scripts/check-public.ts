#!/usr/bin/env bun
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseTrackerPrefixes, trackerIdentifier } from "../src/schema/tracker";

export const RULES = {
  PATH_HOME: "R-PUB-PATH-HOME",
  PATH_PRIVATE_TOKEN: "R-PUB-PATH-PRIVATE-TOKEN",
  PATH_TRACKER_REF: "R-PUB-PATH-TRACKER-REF",
  HOME_PATH: "R-PUB-HOME-PATH",
  EMAIL: "R-PUB-EMAIL",
  PRIVATE_TOKEN: "R-PUB-PRIVATE-TOKEN",
  TRACKER_REF: "R-PUB-TRACKER-REF",
  IGNORE_DOC_EXEMPT: "R-PUB-IGNORE-DOC-EXEMPT",
  CRED_AWS_ACCESS_KEY: "R-PUB-CRED-AWS-ACCESS-KEY",
  CRED_AWS_SECRET: "R-PUB-CRED-AWS-SECRET",
  CRED_GITHUB_TOKEN: "R-PUB-CRED-GITHUB-TOKEN",
  CRED_GITHUB_PAT: "R-PUB-CRED-GITHUB-PAT",
  CRED_SLACK: "R-PUB-CRED-SLACK",
  CRED_GOOGLE: "R-PUB-CRED-GOOGLE",
  CRED_OPENAI: "R-PUB-CRED-OPENAI",
  CRED_ANTHROPIC: "R-PUB-CRED-ANTHROPIC",
  CRED_STRIPE: "R-PUB-CRED-STRIPE",
  CRED_PRIVATE_KEY: "R-PUB-CRED-PRIVATE-KEY",
  CRED_JWT: "R-PUB-CRED-JWT",
  CRED_ASSIGNMENT: "R-PUB-CRED-ASSIGNMENT",
  SYMLINK: "R-PUB-SYMLINK",
  NON_REGULAR: "R-PUB-NON-REGULAR",
  BINARY: "R-PUB-BINARY",
  UTF16: "R-PUB-UTF16",
  UNREADABLE: "R-PUB-UNREADABLE",
  TOO_LARGE: "R-PUB-TOO-LARGE",
  ENUMERATION: "R-PUB-ENUMERATION",
  NOT_A_REPO: "R-PUB-NOT-A-REPO",
  ZERO_COVERAGE: "R-PUB-ZERO-COVERAGE",
  HISTORY: "R-PUB-HISTORY",
} as const;

export const ENV_VARS = {
  PRIVATE_TOKENS: "AOS_CHECK_PUBLIC_PRIVATE_TOKENS",
  TRACKER_PREFIXES: "AOS_CHECK_PUBLIC_TRACKER_PREFIXES",
} as const;

export const RULE_DESCRIPTIONS: Record<string, string> = {
  [RULES.PATH_HOME]: "candidate PATH carries a machine-private home path",
  [RULES.PATH_PRIVATE_TOKEN]: "candidate PATH contains a configured private token",
  [RULES.PATH_TRACKER_REF]: "candidate PATH contains a configured tracker reference",
  [RULES.HOME_PATH]: "file text carries a machine-private home path",
  [RULES.EMAIL]: "e-mail address that is not the allowed legal attribution / noreply form",
  [RULES.PRIVATE_TOKEN]: "file text contains a configured private token",
  [RULES.TRACKER_REF]: "file text contains a configured tracker reference",
  [RULES.IGNORE_DOC_EXEMPT]: ".gitignore hides documents from this gate",
  [RULES.CRED_AWS_ACCESS_KEY]: "AWS access-key id",
  [RULES.CRED_AWS_SECRET]: "AWS secret access key assignment",
  [RULES.CRED_GITHUB_TOKEN]: "GitHub token",
  [RULES.CRED_GITHUB_PAT]: "GitHub fine-grained PAT",
  [RULES.CRED_SLACK]: "Slack token",
  [RULES.CRED_GOOGLE]: "Google API key",
  [RULES.CRED_OPENAI]: "provider API key with the openai-shaped prefix",
  [RULES.CRED_ANTHROPIC]: "provider API key with the anthropic-shaped prefix",
  [RULES.CRED_STRIPE]: "Stripe live key",
  [RULES.CRED_PRIVATE_KEY]: "PEM private-key block",
  [RULES.CRED_JWT]: "JSON Web Token",
  [RULES.CRED_ASSIGNMENT]: "quoted literal assigned to a secret-named field",
  [RULES.SYMLINK]: "symlink in the publish set (target contents would ship unread)",
  [RULES.NON_REGULAR]: "non-regular file in the publish set",
  [RULES.BINARY]: "binary file (NUL byte or invalid UTF-8) not in the extension allowlist",
  [RULES.UTF16]: "UTF-16 encoded file (rejected: text rules cannot see it reliably)",
  [RULES.UNREADABLE]: "candidate could not be read",
  [RULES.TOO_LARGE]: "candidate exceeds the scan size cap",
  [RULES.ENUMERATION]: "git enumeration failed",
  [RULES.NOT_A_REPO]: "root is not a git work tree",
  [RULES.ZERO_COVERAGE]: "zero publish candidates enumerated",
  [RULES.HISTORY]: "commit history could not be read",
};

const U_SERS = "Us" + "ers";
const H_OME = "ho" + "me";

const HOME_PATH_RE = new RegExp("(?:^|[^A-Za-z0-9.])/(?:" + U_SERS + "|" + H_OME + ")/[^/\\s]+", "g");
const WIN_HOME_RE = new RegExp("[A-Za-z]:\\\\" + U_SERS + "\\\\[^\\\\\\s]+", "g");

const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

const NOREPLY_DOMAINS = ["users." + "noreply.github.com"];

export const CREDENTIAL_RULES: { id: string; label: string; re: RegExp }[] = [
  { id: RULES.CRED_AWS_ACCESS_KEY, label: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    id: RULES.CRED_AWS_SECRET,
    label: "aws-secret-access-key",
    re: /aws_secret_access_key\s*[:=]\s*["']?[A-Za-z0-9/+=]{40}/gi,
  },
  { id: RULES.CRED_GITHUB_TOKEN, label: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { id: RULES.CRED_GITHUB_PAT, label: "github-pat", re: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { id: RULES.CRED_SLACK, label: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  { id: RULES.CRED_GOOGLE, label: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: RULES.CRED_OPENAI, label: "openai-shaped-key", re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { id: RULES.CRED_ANTHROPIC, label: "anthropic-shaped-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g },
  { id: RULES.CRED_STRIPE, label: "stripe-live-key", re: /\bsk_live_[A-Za-z0-9]{16,}\b/g },
  {
    id: RULES.CRED_PRIVATE_KEY,
    label: "private-key-block",
    re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  {
    id: RULES.CRED_JWT,
    label: "jwt",
    re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    id: RULES.CRED_ASSIGNMENT,
    label: "quoted-secret-assignment",
    re: /(?<![A-Za-z0-9_])(?:api[_-]?key|apikey|secret|token|passw(?:or)?d|credential)s?["']?\s*[:=]\s*["'][^"'\n]{16,}["']/gi,
  },
];

const DOC_EXEMPT_RE = /^\s*(?:\*\*\/)?\*\.(?:md|mdx|markdown|txt|rst|adoc)\s*$/;
const DOC_DIR_RE = /^\s*\/?(?:docs?|documentation)\/?(?:\*\*\/?)?\s*$/;

export interface LiteralEntry {
  label: string;
  value: string;
}

export type FindingScope = "path" | "content" | "commit-message" | "commit-identity";

export interface Finding {
  ruleId: string;
  severity: "error";
  scope: FindingScope;
  path: string;
  line?: number;
  column?: number;
  label?: string;
  message: string;
  fatal?: boolean;
}

export interface PublicCheckOptions {
  root?: string;
  privateTokens?: string[];
  trackerPrefixes?: string[];
  allowEmails?: string[];
  allowBinaryExtensions?: string[];
  env?: Record<string, string | undefined>;
  skipHistory?: boolean;
  maxFindingsPerRulePerFile?: number;
  maxFileBytes?: number;
}

export interface PublicCheckReport {
  root: string;
  enumeration: { ok: boolean; candidates: number; command: string[]; detail?: string };
  stats: {
    candidates: number;
    scanned: number;
    bytes: number;
    findings: number;
    errors: number;
  };
  history: {
    state: "unborn" | "scanned" | "skipped" | "unavailable";
    commits: number;
    detail?: string;
  };
  findings: Finding[];
  errors: Finding[];
  notices: string[];
  policy: {
    privateTokenLabels: string[];
    trackerPrefixLabels: string[];
    allowEmails: number;
    allowBinaryExtensions: string[];
    pinned: string[];
  };
  result: "pass" | "fail";
  fatal: boolean;
}

export interface EnumerateResult {
  ok: boolean;
  paths: string[];
  detail?: string;
}

export function parseLiteralList(raw: string | undefined): LiteralEntry[] {
  if (!raw) return [];
  const out: LiteralEntry[] = [];
  const seen = new Set<string>();
  let positional = 0;
  for (const chunk of raw.split(/[,\n\r]+/)) {
    const entry = chunk.trim();
    if (!entry) continue;
    let label: string;
    let value: string;
    const eq = entry.indexOf("=");
    const candidate = eq > 0 ? entry.slice(0, eq) : "";
    if (eq > 0 && /^[A-Za-z0-9_.-]{1,64}$/.test(candidate) && !candidate.includes("@")) {
      label = candidate;
      value = entry.slice(eq + 1);
    } else {
      positional += 1;
      label = `entry#${positional}`;
      value = entry;
    }
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push({ label, value });
  }
  return out;
}

function entriesFrom(values: string[] | undefined): LiteralEntry[] {
  if (!values || values.length === 0) return [];
  return parseLiteralList(values.join("\n"));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function literalComponents(value: string): string[] {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
}

/** Match configured identities across case and path/name separator changes. */
export function configuredLiteralRegex(value: string): RegExp {
  const parts = literalComponents(value);
  const source = parts.length > 1
    ? parts.map(escapeRegExp).join("[^A-Za-z0-9]*")
    : escapeRegExp(value);
  return new RegExp(source, "gi");
}

/** Match one prefix under the same grammar every tracker consumer uses. */
export function trackerPrefixRegex(value: string): RegExp {
  const prefixes = parseTrackerPrefixes(value);
  return new RegExp(trackerIdentifier(prefixes).source, "gi");
}

export function configuredTrackerPrefixes(raw: string | undefined, extra: string[] = []): LiteralEntry[] {
  const joined = [raw ?? '', ...extra].filter(Boolean).join(',');
  if (!joined) return [];
  return parseTrackerPrefixes(joined).map((value, index) => ({ label: `prefix#${index + 1}`, value }));
}

export const GIT_ENV_STRIP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
];

export function gitEnv(base?: Record<string, string | undefined>): Record<string, string> {
  const source = base ?? process.env;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") out[key] = value;
  }
  for (const key of Object.keys(out)) if (key.startsWith("GIT_")) delete out[key];
  out.GIT_CONFIG_GLOBAL = "/dev/null";
  out.GIT_CONFIG_NOSYSTEM = "1";
  return out;
}

export const ENUMERATION_ARGS = ["ls-files", "-co", "--exclude-standard", "-z", "--"] as const;
export const ENUMERATION_PINS = ["-c", "core.quotePath=false", "-c", "core.excludesFile=/dev/null"] as const;

function runGit(root: string, args: string[], env?: Record<string, string | undefined>) {
  return Bun.spawnSync({
    cmd: ["git", "-C", root, ...ENUMERATION_PINS, ...args],
    env: gitEnv(env),
    stdout: "pipe",
    stderr: "pipe",
  });
}

export function resolveRepoRoot(root: string, env?: Record<string, string | undefined>): string | null {
  const res = runGit(root, ["rev-parse", "--show-toplevel"], env);
  if (!res.success) return null;
  const text = new TextDecoder().decode(res.stdout).trim();
  return text ? text : null;
}

export function enumeratePublishCandidates(
  root: string,
  env?: Record<string, string | undefined>,
): EnumerateResult {
  const res = runGit(root, [...ENUMERATION_ARGS], env);
  if (!res.success) {
    const detail = new TextDecoder().decode(res.stderr).trim().split("\n")[0] ?? "";
    return { ok: false, paths: [], detail: `exit ${res.exitCode}: ${detail.slice(0, 200)}` };
  }
  const ignored = runGit(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], env);
  if (!ignored.success) return { ok: false, paths: [], detail: "ignored-file enumeration failed" };
  const protectedPaths = new TextDecoder().decode(ignored.stdout).split("\0").filter((p) =>
    p && !/^(?:node_modules|dist|coverage|\.git)\//.test(p) &&
    /(?:\.(?:md|mdx|markdown|txt|rst|adoc|[cm]?[jt]sx?)|(?:^|\/)\.gitignore)$/i.test(p));
  const raw = new TextDecoder().decode(res.stdout) + protectedPaths.join("\0");
  const paths = raw.split("\0").filter((p) => p.length > 0);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of paths) {
    if (seen.has(p)) continue;
    seen.add(p);
    unique.push(p);
  }
  return { ok: true, paths: unique };
}

function lineColOf(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let last = -1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      last = i;
    }
  }
  return { line, column: index - last };
}

function maskEmail(_address: string): string {
  return "email:redacted";
}


function decodeUtf16(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff))
  );
}

function hasNulByte(bytes: Uint8Array): boolean {
  const limit = bytes.length;
  for (let i = 0; i < limit; i += 1) if (bytes[i] === 0) return true;
  return false;
}

function decodeUtf8Strict(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function extensionOf(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

interface ResolvedPolicy {
  privateTokens: LiteralEntry[];
  privateRes: { label: string; re: RegExp }[];
  trackerPrefixes: LiteralEntry[];
  trackerRes: { label: string; re: RegExp }[];
  allowEmails: string[];
  allowBinaryExtensions: string[];
  maxFindingsPerRulePerFile: number;
  maxFileBytes: number;
}

export const DEFAULT_MAX_FINDINGS_PER_RULE_PER_FILE = 25;
export const DEFAULT_MAX_FILE_BYTES = 16 * 1024 * 1024;

function resolvePolicy(options: PublicCheckOptions): ResolvedPolicy {
  const env = options.env ?? process.env;
  const privateTokens = [
    ...parseLiteralList(env[ENV_VARS.PRIVATE_TOKENS]),
    ...entriesFrom(options.privateTokens),
  ];
  const trackerPrefixes = configuredTrackerPrefixes(env[ENV_VARS.TRACKER_PREFIXES], options.trackerPrefixes);
  const dedupeValues = (entries: LiteralEntry[]): LiteralEntry[] => {
    const seen = new Set<string>();
    const out: LiteralEntry[] = [];
    for (const entry of entries) {
      if (seen.has(entry.value)) continue;
      seen.add(entry.value);
      out.push(entry);
    }
    return out;
  };
  const tokens = dedupeValues(privateTokens);
  const prefixes = dedupeValues(trackerPrefixes).map((entry) => ({
    label: entry.label,
    value: entry.value,
    re: trackerPrefixRegex(entry.value),
  }));
  return {
    privateTokens: tokens,
    privateRes: tokens.map(({ label, value }) => ({ label, re: configuredLiteralRegex(value) })),
    trackerPrefixes: prefixes.map(({ label, value }) => ({ label, value })),
    trackerRes: prefixes.map(({ label, re }) => ({ label, re })),
    allowEmails: (options.allowEmails ?? []).map((v) => v.trim()).filter(Boolean),
    allowBinaryExtensions: (options.allowBinaryExtensions ?? []).map((v) => v.trim().toLowerCase()).filter(Boolean),
    maxFindingsPerRulePerFile: Math.max(1, options.maxFindingsPerRulePerFile || DEFAULT_MAX_FINDINGS_PER_RULE_PER_FILE),
    maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
  };
}

interface TextScanContext {
  path: string;
  scope: FindingScope;
  policy: ResolvedPolicy;
  push: (finding: Finding) => void;
}

function scanText(text: string, ctx: TextScanContext): void {
  const caps = new Map<string, number>();
  const emit = (ruleId: string, index: number, label: string, message: string) => {
    const used = caps.get(ruleId) ?? 0;
    if (used >= ctx.policy.maxFindingsPerRulePerFile) return;
    caps.set(ruleId, used + 1);
    const { line, column } = lineColOf(text, index);
    ctx.push({
      ruleId,
      severity: "error",
      scope: ctx.scope,
      path: ctx.path,
      line,
      column,
      label,
      message,
    });
  };

  for (const re of [HOME_PATH_RE, WIN_HOME_RE]) {
    re.lastIndex = 0;
    for (const match of text.matchAll(re)) {
      emit(RULES.HOME_PATH, match.index ?? 0, "home-path", RULE_DESCRIPTIONS[RULES.HOME_PATH]!);
    }
  }

  for (const rule of CREDENTIAL_RULES) {
    rule.re.lastIndex = 0;
    for (const match of text.matchAll(rule.re)) {
      // The matched secret text is intentionally never carried into the finding.
      emit(rule.id, match.index ?? 0, rule.label, RULE_DESCRIPTIONS[rule.id]!);
    }
  }

  for (const token of ctx.policy.privateRes) {
    token.re.lastIndex = 0;
    for (const match of text.matchAll(token.re)) {
      emit(RULES.PRIVATE_TOKEN, match.index ?? 0, token.label, RULE_DESCRIPTIONS[RULES.PRIVATE_TOKEN]!);
    }
  }

  for (const tracker of ctx.policy.trackerRes) {
    tracker.re.lastIndex = 0;
    for (const match of text.matchAll(tracker.re)) {
      emit(RULES.TRACKER_REF, match.index ?? 0, tracker.label, RULE_DESCRIPTIONS[RULES.TRACKER_REF]!);
    }
  }

  const allowed = new Set(ctx.policy.allowEmails.map((v) => v.toLowerCase()));
  EMAIL_RE.lastIndex = 0;
  for (const match of text.matchAll(EMAIL_RE)) {
    const addr = match[0];
    const lower = addr.toLowerCase();
    if (allowed.has(lower)) continue;
    const at = lower.indexOf("@");
    const domain = lower.slice(at + 1);
    if (NOREPLY_DOMAINS.includes(domain)) continue;
    emit(RULES.EMAIL, match.index ?? 0, maskEmail(addr), RULE_DESCRIPTIONS[RULES.EMAIL]!);
  }
}

function scanPathForText(relPath: string, ctx: TextScanContext): void {
  for (const re of [HOME_PATH_RE, WIN_HOME_RE]) {
    re.lastIndex = 0;
    if (re.test(relPath)) {
      ctx.push({
        ruleId: RULES.PATH_HOME,
        severity: "error",
        scope: "path",
        path: relPath,
        label: "home-path",
        message: RULE_DESCRIPTIONS[RULES.PATH_HOME]!,
      });
    }
  }
  for (const token of ctx.policy.privateRes) {
    token.re.lastIndex = 0;
    if (token.re.test(relPath)) {
      ctx.push({
        ruleId: RULES.PATH_PRIVATE_TOKEN,
        severity: "error",
        scope: "path",
        path: relPath,
        label: token.label,
        message: RULE_DESCRIPTIONS[RULES.PATH_PRIVATE_TOKEN]!,
      });
    }
  }
  for (const tracker of ctx.policy.trackerRes) {
    tracker.re.lastIndex = 0;
    if (tracker.re.test(relPath)) {
      ctx.push({
        ruleId: RULES.PATH_TRACKER_REF,
        severity: "error",
        scope: "path",
        path: relPath,
        label: tracker.label,
        message: RULE_DESCRIPTIONS[RULES.PATH_TRACKER_REF]!,
      });
    }
  }
}

function scanGitignore(text: string, ctx: TextScanContext): void {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("!")) continue;
    if (DOC_EXEMPT_RE.test(trimmed) || DOC_DIR_RE.test(trimmed)) {
      ctx.push({
        ruleId: RULES.IGNORE_DOC_EXEMPT,
        severity: "error",
        scope: "content",
        path: ctx.path,
        line: i + 1,
        label: "ignore-pattern",
        message: RULE_DESCRIPTIONS[RULES.IGNORE_DOC_EXEMPT]!,
      });
    }
  }
}

const HISTORY_FORMAT = "%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B";

function scanHistory(root: string, env: Record<string, string | undefined>, policy: ResolvedPolicy) {
  const unavailable = () => ({
    state: "unavailable" as const, commits: 0, findings: [] as Finding[], notices: [],
    errors: [{ ruleId: RULES.HISTORY, severity: "error" as const, scope: "commit-identity" as const,
      path: "<history>", message: "cannot verify commit history", fatal: true }],
  });
  const probe = runGit(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], env);
  const refs = runGit(root, ["for-each-ref", "--format=%(refname)"], env);
  if (!refs.success) return unavailable();
  const refNames = refs.stdout.toString().trim().split("\n").filter(Boolean);
  if (!probe.success) {
    const symbolic = runGit(root, ["symbolic-ref", "--quiet", "HEAD"], env);
    if (!symbolic.success || probe.exitCode !== 1 || refNames.includes(symbolic.stdout.toString().trim())) {
      return unavailable();
    }
    if (refNames.length === 0) return {
      state: "unborn" as const, commits: 0, findings: [] as Finding[], errors: [] as Finding[],
      notices: ["No commits yet; commit metadata has not been checked."],
    };
  }

  const log = runGit(root, ["log", "--all", "-z", "--no-color", ...(probe.success ? ["HEAD"] : []), `--format=${HISTORY_FORMAT}`], env);
  if (!log.success) return unavailable();

  const raw = new TextDecoder().decode(log.stdout);
  const fields = raw.split("\0");
  if (fields.at(-1) === "") fields.pop();
  if (!fields.length || fields.length % 6 !== 0) return unavailable();
  const records: string[][] = [];
  for (let i = 0; i < fields.length; i += 6) records.push(fields.slice(i, i + 6));
  const findings: Finding[] = [];
  for (const record of records) {
    const [sha = "", an = "", ae = "", cn = "", ce = "", message = ""] = record;
    const short = sha.slice(0, 12);
    const push = (finding: Finding) => findings.push(finding);

    scanText(message, {
      path: `commit ${short}`,
      scope: "commit-message",
      policy,
      push,
    });
    scanText([an, ae, cn, ce].join(" "), {
      path: `commit ${short}`,
      scope: "commit-identity",
      policy,
      push,
    });
  }
  return { state: "scanned" as const, commits: records.length, findings, errors: [] as Finding[], notices: [] };
}

export function scanPublicRepo(options: PublicCheckOptions = {}): PublicCheckReport {
  const requestedRoot = resolve(options.root ?? process.cwd());
  const env = options.env ?? process.env;
  const policy = resolvePolicy(options);

  const findings: Finding[] = [];
  const errors: Finding[] = [];
  const notices: string[] = [];

  const base: PublicCheckReport = {
    root: requestedRoot,
    enumeration: { ok: false, candidates: 0, command: [] },
    stats: { candidates: 0, scanned: 0, bytes: 0, findings: 0, errors: 0 },
    history: { state: "skipped", commits: 0 },
    findings,
    errors,
    notices,
    policy: {
      privateTokenLabels: policy.privateTokens.map((t) => t.label),
      trackerPrefixLabels: policy.trackerPrefixes.map((t) => t.label),
      allowEmails: policy.allowEmails.length,
      allowBinaryExtensions: [...policy.allowBinaryExtensions],
      pinned: [...ENUMERATION_PINS],
    },
    result: "fail",
    fatal: false,
  };

  const topLevel = resolveRepoRoot(requestedRoot, env);
  if (!topLevel) {
    errors.push({
      ruleId: RULES.NOT_A_REPO,
      severity: "error",
      scope: "path",
      path: requestedRoot,
      message: "root is not a git work tree (git rev-parse --show-toplevel failed)",
      fatal: true,
    });
    base.fatal = true;
    base.stats.errors = errors.length;
    return base;
  }
  base.root = topLevel;

  const enumerated = enumeratePublishCandidates(topLevel, env);
  base.enumeration = {
    ok: enumerated.ok,
    candidates: enumerated.paths.length,
    command: ["git", "-C", "<root>", ...ENUMERATION_PINS, ...ENUMERATION_ARGS],
    detail: enumerated.detail,
  };
  if (!enumerated.ok) {
    errors.push({
      ruleId: RULES.ENUMERATION,
      severity: "error",
      scope: "path",
      path: topLevel,
      message: `git ls-files enumeration failed: ${enumerated.detail ?? "unknown error"}`,
      fatal: true,
    });
    base.fatal = true;
    base.stats.errors = errors.length;
    return base;
  }
  if (enumerated.paths.length === 0) {
    errors.push({
      ruleId: RULES.ZERO_COVERAGE,
      severity: "error",
      scope: "path",
      path: topLevel,
      message: "zero publish candidates enumerated — refusing to report a clean scan",
      fatal: true,
    });
    base.fatal = true;
    base.stats.errors = errors.length;
    return base;
  }

  base.stats.candidates = enumerated.paths.length;

  const push = (finding: Finding) => findings.push(finding);
  for (const relPath of enumerated.paths) {
    scanPathForText(relPath, { path: relPath, scope: "path", policy, push });

    const absolute = join(topLevel, relPath);
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      errors.push({
        ruleId: RULES.UNREADABLE,
        severity: "error",
        scope: "path",
        path: relPath,
        message: `lstat failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    if (stat.isSymbolicLink()) {
      errors.push({
        ruleId: RULES.SYMLINK,
        severity: "error",
        scope: "path",
        path: relPath,
        message: RULE_DESCRIPTIONS[RULES.SYMLINK]!,
      });
      continue;
    }
    if (!stat.isFile()) {
      errors.push({
        ruleId: RULES.NON_REGULAR,
        severity: "error",
        scope: "path",
        path: relPath,
        message: RULE_DESCRIPTIONS[RULES.NON_REGULAR]!,
      });
      continue;
    }
    if (stat.size > policy.maxFileBytes) {
      errors.push({
        ruleId: RULES.TOO_LARGE,
        severity: "error",
        scope: "path",
        path: relPath,
        message: `${RULE_DESCRIPTIONS[RULES.TOO_LARGE]} (${stat.size} bytes > ${policy.maxFileBytes})`,
      });
      continue;
    }

    let bytes: Uint8Array;
    try {
      bytes = readFileSync(absolute);
    } catch (error) {
      errors.push({
        ruleId: RULES.UNREADABLE,
        severity: "error",
        scope: "path",
        path: relPath,
        message: `read failed: ${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }

    if (decodeUtf16(bytes)) {
      errors.push({
        ruleId: RULES.UTF16,
        severity: "error",
        scope: "path",
        path: relPath,
        message: RULE_DESCRIPTIONS[RULES.UTF16]!,
      });
      continue;
    }

    const extension = extensionOf(relPath);
    const binaryAllowed = policy.allowBinaryExtensions.includes(extension);
    if (hasNulByte(bytes) && !binaryAllowed) {
      errors.push({
        ruleId: RULES.BINARY,
        severity: "error",
        scope: "path",
        path: relPath,
        message: RULE_DESCRIPTIONS[RULES.BINARY]!,
      });
      continue;
    }

    const text = decodeUtf8Strict(bytes);
    if (text === null && !binaryAllowed) {
      errors.push({
        ruleId: RULES.BINARY,
        severity: "error",
        scope: "path",
        path: relPath,
        message: `${RULE_DESCRIPTIONS[RULES.BINARY]} (invalid UTF-8)`,
      });
      continue;
    }

    base.stats.scanned += 1;
    base.stats.bytes += bytes.length;
    if (text === null) continue; // allowlisted binary: read, size-counted, not text-scanned

    const ctx: TextScanContext = { path: relPath, scope: "content", policy, push };
    scanText(text, ctx);
    if (relPath === ".gitignore" || relPath.endsWith("/.gitignore")) {
      scanGitignore(text, ctx);
    }
  }

  if (!options.skipHistory) {
    const history = scanHistory(topLevel, env, policy);
    base.history = { state: history.state, commits: history.commits };
    if (history.state === "unavailable") {
      errors.push(...history.errors);
    } else {
      findings.push(...history.findings);
    }
    notices.push(...history.notices);
  }

  base.stats.findings = findings.length;
  base.stats.errors = errors.length;
  base.fatal = base.fatal || errors.some((e) => e.fatal === true);
  base.result = findings.length === 0 && errors.length === 0 ? "pass" : "fail";
  return base;
}

export const CLI_USAGE = `check-public — publish-candidate privacy gate

usage: bun scripts/check-public.ts [flags]

flags:
  --root <dir>                 scan the git work tree containing <dir> (default: cwd)
  --private-token <L=V|V>      repeatable; private literal; same grammar as
                               ${ENV_VARS.PRIVATE_TOKENS}; value never printed
  --tracker-prefix <PREFIX>    repeatable; tracker prefix, matches PREFIX-<digits>;
                               same grammar as ${ENV_VARS.TRACKER_PREFIXES}
  --allow-email <address>      repeatable; option-only e-mail allowance
  --allow-binary-ext <.png>    repeatable; option-only binary extension allowance
  --json                       machine-readable report on stdout
  --list-rules                 print rule ids and descriptions, then exit 0
  --help                       print this help, then exit 0

environment (additive strictness only, never used to weaken the gate):
  ${ENV_VARS.PRIVATE_TOKENS}      comma/newline separated "L=V" or "V" entries
  ${ENV_VARS.TRACKER_PREFIXES}    comma-separated prefixes such as CURRENT,LEGACY

exit codes: 0 clean | 1 findings or scan errors | 2 usage error or fatal scan error
`;

export interface CliResult {
  code: number;
  report?: PublicCheckReport;
  stdout: string;
}

export function runCli(argv: string[], env?: Record<string, string | undefined>): CliResult {
  const options: PublicCheckOptions = { env: env ?? process.env };
  let json = false;
  const privateTokens: string[] = [];
  const trackerPrefixes: string[] = [];
  const allowEmails: string[] = [];
  const allowBinaryExtensions: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (["--root", "--private-token", "--tracker-prefix", "--allow-email", "--allow-binary-ext"].includes(arg) &&
        (!argv[i + 1] || argv[i + 1]!.startsWith("--"))) return { code: 2, stdout: "check-public: missing option value\n" };
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`missing value for ${arg}`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--help":
      case "-h":
        return { code: 0, stdout: CLI_USAGE };
      case "--list-rules": {
        const lines = Object.entries(RULE_DESCRIPTIONS).map(([id, text]) => `${id}\t${text}`);
        return { code: 0, stdout: lines.join("\n") + "\n" };
      }
      case "--json":
        json = true;
        break;
      case "--root":
        options.root = next();
        break;
      case "--private-token":
        privateTokens.push(next());
        break;
      case "--tracker-prefix":
        trackerPrefixes.push(next());
        break;
      case "--allow-email":
        allowEmails.push(next());
        break;
      case "--allow-binary-ext":
        allowBinaryExtensions.push(next());
        break;
      default:
        return { code: 2, stdout: `check-public: unknown argument: ${arg}\n\n${CLI_USAGE}` };
    }
  }

  options.privateTokens = privateTokens;
  options.trackerPrefixes = trackerPrefixes;
  options.allowEmails = allowEmails;
  options.allowBinaryExtensions = allowBinaryExtensions;

  let report: PublicCheckReport;
  try {
    report = scanPublicRepo(options);
  } catch (error) {
    return {
      code: 2,
      stdout: `check-public: fatal: ${error instanceof Error ? error.message : String(error)}\n`,
    };
  }

  if (json) {
    return { code: exitCodeFor(report), report, stdout: JSON.stringify(report, null, 2) + "\n" };
  }
  return { code: exitCodeFor(report), report, stdout: renderHuman(report) };
}

export function exitCodeFor(report: PublicCheckReport): number {
  if (report.fatal) return 2;
  if (report.result === "fail") return 1;
  return 0;
}

export function renderHuman(report: PublicCheckReport): string {
  const lines: string[] = [];
  lines.push("check-public — publish-candidate privacy gate");
  lines.push(`root: ${report.root}`);
  lines.push(
    `policy: private-token-labels=[${report.policy.privateTokenLabels.join(", ")}] ` +
      `tracker-prefix-labels=[${report.policy.trackerPrefixLabels.join(", ")}] ` +
      `allow-emails=${report.policy.allowEmails} ` +
      `allow-binary-exts=[${report.policy.allowBinaryExtensions.join(", ")}]`,
  );
  lines.push(`enumeration: ${report.enumeration.command.join(" ")} (candidates=${report.enumeration.candidates})`);
  lines.push(
    `scanned: ${report.stats.scanned} file(s), ${report.stats.bytes} bytes ` +
      `(findings=${report.stats.findings} errors=${report.stats.errors})`,
  );
  lines.push(`history: ${report.history.state} (commits=${report.history.commits})`);
  for (const notice of report.notices) lines.push(`notice: ${notice}`);
  for (const finding of report.findings) lines.push(`  FINDING ${formatFinding(finding)}`);
  for (const error of report.errors) lines.push(`  ERROR   ${formatFinding(error)}`);
  lines.push(
    `${report.result.toUpperCase()}: ${report.stats.findings} finding(s), ${report.stats.errors} scan error(s)`,
  );
  return lines.join("\n") + "\n";
}

function formatFinding(finding: Finding): string {
  const location =
    finding.line === undefined
      ? finding.path
      : `${finding.path}:${finding.line}${finding.column === undefined ? "" : `:${finding.column}`}`;
  const label = finding.label ? ` label=${finding.label}` : "";
  return `${finding.ruleId} ${finding.scope} ${location}${label} — ${finding.message}`;
}

if (import.meta.main) {
  const result = runCli(process.argv.slice(2));
  process.stdout.write(result.stdout);
  process.exit(result.code);
}
