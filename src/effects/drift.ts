import { z } from 'zod';
import { InstallManifestSchema } from '../schema/install';
import { readFileDigest, validateRoots } from './paths';

export type DriftStatus = 'clean' | 'drift' | 'indeterminate';
export type DriftIssueKind = 'missing' | 'modified' | 'stale' | 'ownership' | 'malformed' | 'unreadable';
export interface DriftIssue {
  kind: DriftIssueKind;
  scope: 'manifest' | 'roots' | 'source' | 'output';
  message: string;
  path?: string;
  code?: string;
}
export interface DriftCoverage { expected: number; checked: number; skipped: number }
export interface DriftReport {
  status: DriftStatus;
  checked: number;
  skipped: number;
  coverage: { sources: DriftCoverage; outputs: DriftCoverage };
  issues: DriftIssue[];
}
export interface CheckDriftOptions {
  sourceRoot: string;
  targetRoot: string;
  /** Independent build manifest; never rebuild this from the installed target. */
  manifest: unknown;
  owner: string;
  expectedGeneration?: number;
}

const OptionsSchema = z.strictObject({
  sourceRoot: z.string().min(1), targetRoot: z.string().min(1), manifest: InstallManifestSchema,
  owner: z.string().refine((value) => value.trim().length > 0), expectedGeneration: z.int().positive().optional(),
});

function emptyReport(): DriftReport {
  return { status: 'indeterminate', checked: 0, skipped: 0,
    coverage: { sources: { expected: 0, checked: 0, skipped: 0 }, outputs: { expected: 0, checked: 0, skipped: 0 } }, issues: [] };
}

/** Read-only detection. All external input and filesystem failures become JSON diagnostics. */
export async function checkDrift(options: CheckDriftOptions): Promise<DriftReport> {
  const report = emptyReport();
  let parsed: ReturnType<typeof OptionsSchema.safeParse>;
  try { parsed = OptionsSchema.safeParse(options); }
  catch { report.issues.push({ kind: 'malformed', scope: 'manifest', message: 'Input could not be validated' }); return report; }
  if (!parsed.success) {
    // Do not echo Zod messages or key names: unknown keys can contain private data.
    const knownFields = new Set(['manifest', 'schemaVersion', 'owner', 'generation', 'harness', 'sources', 'outputs', 'path', 'digest', 'sourceRoot', 'targetRoot', 'expectedGeneration']);
    for (const issue of parsed.error.issues) {
      const location = issue.path.map((part) => typeof part === 'number' ? String(part)
        : knownFields.has(String(part)) ? String(part) : '<field>').join('.');
      report.issues.push({ kind: 'malformed', scope: 'manifest', code: issue.code,
        message: `Input failed strict validation at ${location || '<input>'}` });
    }
    return report;
  }
  const input = parsed.data;
  const manifest = input.manifest;
  report.coverage.sources.expected = manifest.sources.length;
  report.coverage.outputs.expected = manifest.outputs.length;
  if (input.owner !== manifest.owner) {
    report.issues.push({ kind: 'ownership', scope: 'manifest', message: 'Manifest owner does not match the caller owner' });
  }
  const roots = await validateRoots(input.sourceRoot, input.targetRoot);
  if (!roots.ok) report.issues.push({ kind: 'unreadable', scope: 'roots', code: roots.code, message: roots.message });
  if (!roots.ok || input.owner !== manifest.owner) {
    for (const coverage of Object.values(report.coverage)) coverage.skipped = coverage.expected;
    report.skipped = manifest.sources.length + manifest.outputs.length;
    return report;
  }
  if (input.expectedGeneration !== undefined && input.expectedGeneration !== manifest.generation) {
    report.issues.push({ kind: 'stale', scope: 'manifest', message: 'Manifest generation does not match the expected generation' });
  }
  for (const [field, root, scope] of [
    ['sources', roots.value.sourceRoot, 'source'], ['outputs', roots.value.targetRoot, 'output'],
  ] as const) {
    const coverage = report.coverage[field];
    for (const entry of manifest[field]) {
      const result = await readFileDigest(root, entry.path);
      if (!result.ok && result.code !== 'missing') {
        coverage.skipped++;
        report.issues.push({ kind: 'unreadable', scope, path: entry.path, code: result.code, message: result.message });
      } else {
        coverage.checked++;
        if (!result.ok) report.issues.push({ kind: 'missing', scope, path: entry.path, message: 'Manifest file is missing' });
        else if (result.value !== entry.digest) report.issues.push({
          kind: scope === 'source' ? 'stale' : 'modified', scope, path: entry.path,
          message: scope === 'source' ? 'Source bytes differ from the build manifest' : 'Output bytes differ from the build manifest',
        });
      }
    }
  }
  report.checked = report.coverage.sources.checked + report.coverage.outputs.checked;
  report.skipped = report.coverage.sources.skipped + report.coverage.outputs.skipped;
  report.status = report.skipped > 0 ? 'indeterminate' : report.issues.length > 0 ? 'drift' : 'clean';
  return report;
}

export interface DriftAggregateReport {
  status: DriftStatus;
  checked: number;
  skipped: number;
  targets: DriftReport[];
}

/** Empty and partially checked target sets cannot succeed. Results retain input order. */
export async function checkDriftTargets(targets: readonly CheckDriftOptions[]): Promise<DriftAggregateReport> {
  const reports: DriftReport[] = [];
  for (const target of targets) reports.push(await checkDrift(target));
  return {
    status: reports.length === 0 || reports.some((report) => report.status === 'indeterminate') ? 'indeterminate'
      : reports.some((report) => report.status === 'drift') ? 'drift' : 'clean',
    checked: reports.reduce((sum, report) => sum + report.checked, 0),
    skipped: reports.reduce((sum, report) => sum + report.skipped, 0), targets: reports,
  };
}
