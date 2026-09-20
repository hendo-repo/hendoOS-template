#!/usr/bin/env bun
// Source-level gate, not a proof of purity. Computed calls and package internals
// require review. Local value imports are followed; type-only imports are inert.
import { lstatSync, readFileSync } from 'node:fs';
import { posix, join } from 'node:path';
import ts from 'typescript';
import { enumeratePublishCandidates, resolveRepoRoot } from './check-public.ts';

export const ARCH_RULES = {
  PURE_IMPORT: 'R-ARCH-PURE-IMPORT', PURE_AMBIENT: 'R-ARCH-PURE-AMBIENT',
  VENDOR_IMPORT: 'R-ARCH-VENDOR-IMPORT', VENDOR_LITERAL: 'R-ARCH-VENDOR-LITERAL',
  SHELL_DOLLAR: 'R-ARCH-SHELL-DOLLAR', SUBPROCESS_MODULE: 'R-ARCH-SUBPROCESS-MODULE',
  SUBPROCESS_LANG: 'R-ARCH-SUBPROCESS-LANG', ENUMERATION: 'R-ARCH-ENUMERATION',
  NOT_A_REPO: 'R-ARCH-NOT-A-REPO', ZERO_COVERAGE: 'R-ARCH-ZERO-COVERAGE',
  SOURCE: 'R-ARCH-SOURCE',
} as const;
export const ARCH_DEFAULTS = {
  coreDirs: ['src'], pureDirs: ['src/compose', 'src/policy'], vendorDirs: ['src/protocols'],
  docDirs: ['docs', 'content'], forbiddenModules: [],
  vendorHosts: ['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com', 'openrouter.ai', 'api.mistral.ai'],
};
export interface ArchitectureCheckOptions {
  root?: string; env?: Record<string, string | undefined>;
  coreDirs?: string[]; pureDirs?: string[]; vendorDirs?: string[];
  docDirs?: string[]; docExtensions?: string[]; forbiddenModules?: string[]; vendorHosts?: string[];
  maxFindingsPerRulePerFile?: number;
}
export interface ArchFinding {
  ruleId: string; severity: 'error'; path: string; line?: number; message: string; fatal?: boolean;
}
export interface ArchitectureCheckReport {
  root: string; result: 'pass' | 'fail'; fatal: boolean;
  enumeration: { ok: boolean; candidates: number; detail?: string };
  stats: { candidates: number; scanned: number; findings: number; errors: number };
  findings: ArchFinding[]; errors: ArchFinding[];
}
const inDirs = (path: string, dirs: string[]) => dirs.some(d => {
  d = d.replace(/^\.\//, '').replace(/\/$/, '');
  return d === '.' || path === d || path.startsWith(d + '/');
});
const sourceExtension = /\.[cm]?[jt]sx?$/;
const ioModule = /^(?:node:)?(?:fs|fs\/promises|net|http|https|http2|tls|dns|dgram|child_process|cluster|worker_threads|timers|timers\/promises|perf_hooks|os|process|readline|repl|inspector)(?:\/|$)|^(?:bun|bun:.*)$/;
const vendorModule = /^(?:openai|@anthropic-ai\/|@google\/generative-ai|@google\/genai|@mistralai\/|@openrouter\/|@ai-sdk\/|ai$)/;
const foreignCommand = /^(?:(?:[^\s]*\/)?(?:python[\d.]*|node|npx|bunx|pwsh|powershell))(?:\s|$)/;

function imports(node: ts.Node): { spec: string; typeOnly: boolean } | undefined {
  if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
    const clause = node.importClause;
    const named = clause?.namedBindings;
    return { spec: node.moduleSpecifier.text, typeOnly: !!clause?.isTypeOnly ||
      (!!named && ts.isNamedImports(named) && !clause?.name && named.elements.length > 0 && named.elements.every(e => e.isTypeOnly)) };
  }
  if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
    return { spec: node.moduleSpecifier.text, typeOnly: node.isTypeOnly };
  }
  if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) {
    return { spec: node.moduleReference.expression.text, typeOnly: node.isTypeOnly };
  }
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
      (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
    const arg = node.arguments[0];
    return { spec: arg && ts.isStringLiteralLike(arg) ? arg.text : '<computed>', typeOnly: false };
  }
  return undefined;
}
function memberName(node: ts.Node): string | undefined {
  if (ts.isIdentifier(node)) return node.text;
  if (ts.isPropertyAccessExpression(node)) {
    const base = memberName(node.expression);
    return base ? base + '.' + node.name.text : undefined;
  }
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)) {
    const base = memberName(node.expression);
    return base ? base + '.' + node.argumentExpression.text : undefined;
  }
  return undefined;
}

export function scanArchitecture(options: ArchitectureCheckOptions = {}): ArchitectureCheckReport {
  const report: ArchitectureCheckReport = {
    root: options.root ?? process.cwd(), result: 'fail', fatal: false,
    enumeration: { ok: false, candidates: 0 },
    stats: { candidates: 0, scanned: 0, findings: 0, errors: 0 }, findings: [], errors: [],
  };
  const error = (ruleId: string, path: string, message: string) => {
    report.errors.push({ ruleId, path, message, severity: 'error', fatal: true });
  };
  const finish = () => {
    report.stats.findings = report.findings.length; report.stats.errors = report.errors.length;
    report.fatal = report.errors.length > 0;
    report.result = report.fatal || report.findings.length ? 'fail' : 'pass';
    return report;
  };
  const root = resolveRepoRoot(report.root, options.env);
  if (!root) { error(ARCH_RULES.NOT_A_REPO, '.', 'Cannot resolve Git work tree'); return finish(); }
  report.root = root;
  const enumeration = enumeratePublishCandidates(root, options.env);
  report.enumeration = { ok: enumeration.ok, candidates: enumeration.paths.length, detail: enumeration.detail };
  if (!enumeration.ok) { error(ARCH_RULES.ENUMERATION, '.', 'Cannot enumerate files'); return finish(); }
  const coreDirs = options.coreDirs ?? ARCH_DEFAULTS.coreDirs;
  const pureDirs = options.pureDirs ?? ARCH_DEFAULTS.pureDirs;
  const vendorDirs = options.vendorDirs ?? ARCH_DEFAULTS.vendorDirs;
  // Prose is not executable; source files are never exempted by a docs directory.
  const paths = enumeration.paths.filter(p => sourceExtension.test(p) && inDirs(p, [...coreDirs, ...pureDirs, ...vendorDirs]));
  report.stats.candidates = paths.length;
  if (!paths.length) { error(ARCH_RULES.ZERO_COVERAGE, '.', 'No source files covered'); return finish(); }
  const sources = new Map<string, ts.SourceFile>();
  for (const path of paths) {
    try {
      const stat = lstatSync(join(root, path));
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw Error('unsupported file');
      const text = new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(join(root, path)));
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
      if ((source as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] }).parseDiagnostics.length) throw Error('invalid syntax');
      sources.set(path, source); report.stats.scanned++;
    } catch { error(ARCH_RULES.SOURCE, path, 'Source is unreadable, unsupported, or invalid'); }
  }
  const resolveLocal = (path: string, spec: string) => {
    const base = posix.normalize(posix.join(posix.dirname(path), spec));
    return [base, base + '.ts', base + '.tsx', base + '/index.ts', base.replace(/\.js$/, '.ts')].find(p => sources.has(p));
  };
  const pure = new Set(paths.filter(p => inDirs(p, pureDirs)));
  for (const path of pure) {
    const source = sources.get(path);
    if (!source) continue;
    const visit = (node: ts.Node) => {
      const imp = imports(node);
      if (imp && !imp.typeOnly && imp.spec.startsWith('.')) {
        const target = resolveLocal(path, imp.spec);
        if (target) pure.add(target);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  for (const [path, source] of sources) {
    const emit = (ruleId: string, node: ts.Node, message: string) => {
      report.findings.push({ ruleId, severity: 'error', path,
        line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, message });
    };
    const visit = (node: ts.Node) => {
      const imp = imports(node);
      if (imp && !imp.typeOnly) {
        if (pure.has(path) && (ioModule.test(imp.spec) || imp.spec === '<computed>' ||
            (options.forbiddenModules ?? []).includes(imp.spec) ||
            (imp.spec.startsWith('.') && !resolveLocal(path, imp.spec)))) {
          emit(ARCH_RULES.PURE_IMPORT, node, 'Pure code imports an effect module or unresolved dependency');
        }
        if (inDirs(path, coreDirs) && /^(?:node:)?child_process$/.test(imp.spec)) emit(ARCH_RULES.SUBPROCESS_MODULE, node, 'Core imports a subprocess module');
        if (!inDirs(path, vendorDirs) && vendorModule.test(imp.spec)) emit(ARCH_RULES.VENDOR_IMPORT, node, 'Vendor SDK belongs in protocols');
      }
      const member = memberName(node)?.replace(/^globalThis\./, '');
      if (pure.has(path) && member && /^(?:process(?:\.|$)|Bun\.(?!CryptoHasher(?:\.|$))|Date(?:\.|$)|Math\.random$|performance(?:\.|$)|crypto\.(?:randomUUID|getRandomValues)$|fetch$|WebSocket$|XMLHttpRequest$|setTimeout$|setInterval$)/.test(member)) {
        emit(ARCH_RULES.PURE_AMBIENT, node, 'Pure code accesses I/O, clock, randomness, or ambient state');
      }
      if (inDirs(path, coreDirs) && member === 'Bun.$') emit(ARCH_RULES.SHELL_DOLLAR, node, 'Core uses shell shorthand');
      if (inDirs(path, coreDirs) && ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
          node.moduleSpecifier.text === 'bun' && node.importClause?.namedBindings && ts.isNamedImports(node.importClause.namedBindings) &&
          node.importClause.namedBindings.elements.some(e => (e.propertyName ?? e.name).text === '$')) emit(ARCH_RULES.SHELL_DOLLAR, node, 'Core imports shell shorthand');
      if (ts.isStringLiteralLike(node)) {
        if (!inDirs(path, vendorDirs) && (options.vendorHosts ?? ARCH_DEFAULTS.vendorHosts).some(h => node.text.includes(h))) emit(ARCH_RULES.VENDOR_LITERAL, node, 'Vendor host belongs in protocols');
        if (inDirs(path, coreDirs) && foreignCommand.test(node.text.trim())) emit(ARCH_RULES.SUBPROCESS_LANG, node, 'Foreign runtime command in core');
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return finish();
}
export const ARCH_CLI_USAGE = `usage: bun scripts/check-architecture.ts [--root <dir>] [--json] [--help]
Checks pure code and local dependencies for effects, vendor SDK placement, and core subprocess use.
Exit: 0 clean, 1 findings, 2 usage/coverage errors. Source-level checks require review for computed calls.
`;
export const archExitCodeFor = (report: ArchitectureCheckReport) => report.fatal ? 2 : report.result === 'fail' ? 1 : 0;
export function runArchitectureCli(argv: string[], env = process.env) {
  let root: string | undefined, json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { code: 0, stdout: ARCH_CLI_USAGE };
    if (arg === '--json') json = true;
    else if (arg === '--root' && argv[i + 1] && !argv[i + 1]!.startsWith('--')) root = argv[++i];
    else return { code: 2, stdout: ARCH_CLI_USAGE };
  }
  try {
    const report = scanArchitecture({ root, env });
    const stdout = json ? JSON.stringify(report, null, 2) :
      [...report.findings, ...report.errors].map(f => `${f.ruleId} ${f.path}:${f.line ?? 0} ${f.message}`).join('\n') +
      `\n${report.result.toUpperCase()}: ${report.stats.scanned} source files, ${report.stats.findings} findings, ${report.stats.errors} errors`;
    return { code: archExitCodeFor(report), report, stdout: stdout + '\n' };
  } catch { return { code: 2, stdout: 'check-architecture: scan failed\n' }; }
}
if (import.meta.main) {
  const result = runArchitectureCli(process.argv.slice(2));
  process.stdout.write(result.stdout); process.exit(result.code);
}
