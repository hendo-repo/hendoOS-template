/**
 * Manifests — the two machine-checkable inventories the core validates.
 *
 * ## Content manifest
 *
 * Records the corpus the build intends to ship: `owner`, monotonically increasing
 * `generation`, and one entry per source with its normalized relative `path`, its
 * `digest`, and its content `id`. Evaluating a manifest against a corpus catches a
 * source that changed under the build (digest mismatch) or that went missing, and a
 * `generation` lower than the observed one is a regression.
 *
 * ## Membership manifest
 *
 * Records the expected activated, activated-kernel, and static-prefix id sets per
 * scenario. Evaluation is set-equality in both directions. Keeping the static
 * prefix inventory independent matters because activation and rendering are separate
 * checks: only activated kernels may appear, and none may disappear from the prefix.
 *
 * Every path in a manifest is normalized and relative; unsafe paths are rejected
 * without echoing the input. Purity: no I/O, no clock.
 */
import { aosError, type AosError } from '../protocols/error';
import { digestOfString, isDigest, type Json } from '../protocols/json';
import { outcome, type Outcome } from '../protocols/outcome';
import { normalizeRelativePath, sortPaths } from '../protocols/paths';
import { buildActivation, type ActivationResult } from './activation';
import type { ContentCorpus, ContentDocument } from './content';
import { z } from 'zod';
import { ContentManifestRuntimeSchema, MembershipManifestRuntimeSchema, ContentDocumentRuntimeSchema, parseOrErrors } from './runtime';

/** Content manifest wire version. */
export const CONTENT_MANIFEST_VERSION = 1;
export const MEMBERSHIP_MANIFEST_VERSION = 1;

export interface ManifestSourceEntry {
  path: string;
  digest: string;
  id: string;
}

export interface ContentManifest {
  version: number;
  owner: string;
  generation: number;
  sources: readonly ManifestSourceEntry[];
}

export interface MembershipScenario {
  id: string;
  /** Harness this scenario is evaluated against. Generic opaque string. */
  harness: string;
  event: string;
  stateKeys?: readonly string[];
  /** Exact expected activated id set. */
  expectedIds: readonly string[];
  /** Independently authored exact kernel set; never inferred from document tiers. */
  expectedKernelIds: readonly string[];
  /** Independently authored exact activated-kernel set emitted in the static prefix. */
  expectedStaticIds: readonly string[];
}

export interface MembershipManifest {
  version: number;
  owner: string;
  generation: number;
  scenarios: readonly MembershipScenario[];
}

/** Structural validation of a content manifest. Pure. */
export function validateContentManifest(input: unknown): Outcome<ContentManifest> {
  const parsed = parseOrErrors(ContentManifestRuntimeSchema, input, { label: 'content manifest' });
  if (!parsed.ok) return outcome({ version: 1, owner: '', generation: 0, sources: [] }, parsed.errors, true);
  const manifest = parsed.value;
  const errors: AosError[] = [];
  const ids = new Set<string>();
  if (manifest.owner.trim() === '') {
    errors.push(aosError('manifest-source-digest-mismatch', 'content manifest owner is empty', { details: {} }));
  }
  if (!Number.isInteger(manifest.generation) || manifest.generation < 0) {
    errors.push(
      aosError('manifest-generation-regression', 'content manifest generation must be a non-negative integer', {
        details: { generation: manifest.generation },
      }),
    );
  }
  const seen = new Set<string>();
  for (const source of manifest.sources) {
    if (ids.has(source.id)) errors.push(aosError('internal-invariant', 'duplicate manifest content id', { id: source.id }));
    ids.add(source.id);
    const safe = normalizeRelativePath(source.path);
    if (!safe.ok) {
      errors.push(safe.error);
      continue;
    }
    if (safe.path !== source.path) {
      errors.push(
        aosError('unsafe-relative-path', 'content manifest source path is not normalized', {
          details: { normalized: safe.path },
          path: source.path,
        }),
      );
    }
    if (seen.has(safe.path)) {
      errors.push(
        aosError('internal-invariant', `duplicate manifest source path ${safe.path}`, { path: safe.path }),
      );
    }
    seen.add(safe.path);
    if (!isDigest(source.digest)) {
      errors.push(
        aosError('manifest-source-digest-mismatch', 'manifest source digest is not `sha256:<64 hex>`', {
          details: { digest: source.digest },
          path: safe.path,
          id: source.id,
        }),
      );
    }
  }
  return outcome(manifest, errors, errors.length > 0);
}

/** Structural validation of a membership manifest. Pure. */
export function validateMembershipManifest(
  input: unknown,
): Outcome<MembershipManifest> {
  const parsed = parseOrErrors(MembershipManifestRuntimeSchema, input, { label: 'membership manifest' });
  if (!parsed.ok) return outcome({ version: 1, owner: '', generation: 0, scenarios: [] }, parsed.errors, true);
  const manifest = parsed.value;
  const errors: AosError[] = [];
  if (manifest.owner.trim() === '') {
    errors.push(aosError('membership-mismatch', 'membership manifest owner is empty', { details: {} }));
  }
  if (!Number.isInteger(manifest.generation) || manifest.generation < 0) {
    errors.push(
      aosError('manifest-generation-regression', 'membership manifest generation must be a non-negative integer', {
        details: { generation: manifest.generation },
      }),
    );
  }
  const seen = new Set<string>();
  for (const scenario of manifest.scenarios) {
    if (seen.has(scenario.id)) {
      errors.push(
        aosError('membership-mismatch', `duplicate membership scenario id \`${scenario.id}\``, {
          details: { id: scenario.id },
          id: scenario.id,
        }),
      );
    }
    seen.add(scenario.id);
    const inventories = [scenario.expectedIds, scenario.expectedKernelIds, scenario.expectedStaticIds];
    if (inventories.some(ids => new Set(ids).size !== ids.length)) {
      errors.push(
        aosError('membership-mismatch', `scenario \`${scenario.id}\` lists a duplicate expected id`, {
          details: { id: scenario.id },
          id: scenario.id,
        }),
      );
    }
    const expectedKernel = [...scenario.expectedKernelIds].sort();
    const expectedStatic = [...scenario.expectedStaticIds].sort();
    if (JSON.stringify(expectedKernel) !== JSON.stringify(expectedStatic)) {
      errors.push(aosError('membership-mismatch', `scenario \`${scenario.id}\` does not declare the exact activated-kernel static prefix`, {
        id: scenario.id,
      }));
    }
  }
  return outcome(manifest, errors, errors.length > 0);
}

export interface ManifestComparison {
  /** Sources in the manifest with no matching corpus document. */
  missing: readonly string[];
  /** Sources whose declared digest differs from the corpus document's digest. */
  changed: readonly { path: string; declared: string; actual: string }[];
  /** Corpus documents absent from the manifest. */
  unlisted: readonly string[];
  /** True when the manifest generation is lower than `observedGeneration`. */
  generationRegression: boolean;
  /** True when paths, digests and id coverage all agree. */
  exact: boolean;
}

/**
 * Compare a content manifest against a corpus. Pure.
 *
 * `observedGeneration` lets a caller supply the generation it just produced; a
 * manifest with a lower generation is a regression regardless of source agreement.
 */
export function compareContentManifest(
  input: unknown,
  corpus: ContentCorpus,
  observedGeneration?: number,
): Outcome<ManifestComparison> {
  const checked = validateContentManifest(input);
  const corpusCheck = parseOrErrors(z.strictObject({ documents: z.array(ContentDocumentRuntimeSchema), byId: z.map(z.string(), ContentDocumentRuntimeSchema), duplicateIds: z.array(z.string()), rejectedPaths: z.array(z.string()) }), corpus, { label: 'manifest corpus' });
  const generationCheck = parseOrErrors(z.int().nonnegative().optional(), observedGeneration, { label: 'observed generation' });
  const errors: AosError[] = [...checked.errors, ...(corpusCheck.ok ? [] : corpusCheck.errors), ...(generationCheck.ok ? [] : generationCheck.errors)];
  if (!checked.ok || !corpusCheck.ok || !generationCheck.ok) return outcome({ missing: [], changed: [], unlisted: [], generationRegression: false, exact: false }, errors, true);
  const manifest = checked.value;
  corpus = corpusCheck.value;
  if (corpus.duplicateIds.length || corpus.rejectedPaths.length) errors.push(aosError('internal-invariant', 'corpus contains rejected or duplicate sources'));
  const declared = new Map<string, ManifestSourceEntry>();
  for (const source of manifest.sources) declared.set(source.path, source);

  const missing: string[] = [];
  const changed: { path: string; declared: string; actual: string }[] = [];
  const unlisted: string[] = [];

  for (const [path, source] of declared) {
    const document = corpus.documents.find((entry) => entry.sourcePath === path);
    if (!document) {
      missing.push(path);
      errors.push(
        aosError('manifest-source-digest-mismatch', 'manifest source is missing from the corpus', {
          details: { id: source.id },
          path,
          id: source.id,
        }),
      );
      continue;
    }
    if (document.digest !== source.digest) {
      changed.push({ path, declared: source.digest, actual: document.digest });
      errors.push(
        aosError('manifest-source-digest-mismatch', 'manifest digest differs from corpus digest', {
          details: { declared: source.digest, actual: document.digest },
          path,
          id: document.id,
        }),
      );
    }
    if (document.id !== source.id) {
      errors.push(
        aosError('manifest-source-digest-mismatch', 'manifest id differs from corpus id', {
          details: { declaredId: source.id, actualId: document.id },
          path,
          id: document.id,
        }),
      );
    }
  }

  for (const document of corpus.documents) {
    if (!declared.has(document.sourcePath)) {
      unlisted.push(document.sourcePath);
      errors.push(aosError('manifest-source-digest-mismatch', 'corpus source is absent from manifest', { path: document.sourcePath }));
    }
  }

  const generationRegression =
    observedGeneration !== undefined && manifest.generation < observedGeneration;
  if (generationRegression) {
    errors.push(
      aosError('manifest-generation-regression', 'manifest generation is behind the observed generation', {
        details: { manifest: manifest.generation, observed: observedGeneration },
      }),
    );
  }

  const comparison: ManifestComparison = {
    missing: missing.sort(),
    changed: changed.sort((a, b) => (a.path < b.path ? -1 : 1)),
    unlisted: sortPaths(unlisted),
    generationRegression,
    exact: errors.length === 0,
  };

  return outcome(comparison, errors, errors.length > 0);
}

export interface ScenarioEvaluation {
  scenarioId: string;
  harness: string;
  event: string;
  stateKeys: readonly string[];
  expectedIds: readonly string[];
  actualIds: readonly string[];
  expectedStaticIds: readonly string[];
  actualStaticIds: readonly string[];
  /** Expected but not activated. */
  missingIds: readonly string[];
  /** Activated but not expected. */
  extraIds: readonly string[];
  /** True when the sets are equal. */
  exact: boolean;
  activationDigest: string;
}

export interface MembershipEvaluation {
  manifestOwner: string;
  manifestGeneration: number;
  results: readonly ScenarioEvaluation[];
  /** True when every scenario matched exactly. */
  exact: boolean;
  /** Total number of scenario-level set mismatches. */
  mismatchCount: number;
}

/**
 * Evaluate a membership manifest against a corpus: exact scenario sets (both
 * directions) for every scenario. Pure.
 */
export function evaluateMembership(
  input: unknown,
  documents: unknown,
): Outcome<MembershipEvaluation> {
  const errors: AosError[] = [];
  const structural = validateMembershipManifest(input);
  errors.push(...structural.errors);
  if (!structural.ok) return outcome({ manifestOwner: '', manifestGeneration: 0, results: [], exact: false, mismatchCount: 0 }, errors, true);
  const manifest = structural.value;

  const results: ScenarioEvaluation[] = [];
  for (const scenario of [...manifest.scenarios].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const stateKeys = [...new Set(scenario.stateKeys ?? [])].sort();
    const activation: Outcome<ActivationResult> = buildActivation(
      { id: scenario.event, harness: scenario.harness },
      { keys: stateKeys },
      documents,
    );
    errors.push(...activation.errors);
    const actualIds = [...activation.value.ids];
    const expectedSet = new Set(scenario.expectedIds);
    const actualSet = new Set(actualIds);
    const missingIds = [...expectedSet].filter((id) => !actualSet.has(id)).sort();
    const extraIds = [...actualSet].filter((id) => !expectedSet.has(id)).sort();
    const expectedKernel = [...scenario.expectedKernelIds].sort();
    const actualKernel = [...activation.value.kernelIds].sort();
    const kernelExact = JSON.stringify(expectedKernel) === JSON.stringify(actualKernel);
    const expectedStatic = [...scenario.expectedStaticIds].sort();
    const activated = new Set(activation.value.ids);
    const actualStatic = (documents as readonly ContentDocument[])
      .filter(document => document.tier === 'kernel' && activated.has(document.id) &&
        (document.targetHarnesses.includes('*') || document.targetHarnesses.includes(scenario.harness)))
      .map(document => document.id).sort();
    const staticExact = JSON.stringify(expectedStatic) === JSON.stringify(actualStatic);
    const setsExact = missingIds.length === 0 && extraIds.length === 0 && kernelExact && staticExact;
    const exact = activation.ok && setsExact;

    if (!setsExact) {
      errors.push(
        aosError('membership-mismatch', `scenario \`${scenario.id}\` id set does not match the manifest`, {
          details: {
            scenarioId: scenario.id,
            missing: missingIds,
            extra: extraIds,
            expected: [...expectedSet].sort(),
            actual: actualIds,
            expectedKernel, actualKernel, expectedStatic, actualStatic,
          },
          id: scenario.id,
        }),
      );
    }

    results.push({
      scenarioId: scenario.id,
      harness: scenario.harness,
      event: scenario.event,
      stateKeys,
      expectedIds: [...expectedSet].sort(),
      actualIds,
      expectedStaticIds: expectedStatic,
      actualStaticIds: actualStatic,
      missingIds,
      extraIds,
      exact,
      activationDigest: activation.value.digest,
    });
  }

  const mismatchCount = results.filter((result) => !result.exact).length;
  if (manifest.scenarios.length === 0) {
    errors.push(
      aosError('empty-selection', 'membership manifest declares no scenarios', {
        details: { owner: manifest.owner },
      }),
    );
  }

  return outcome(
    {
      manifestOwner: manifest.owner,
      manifestGeneration: manifest.generation,
      results,
      exact: errors.length === 0 && mismatchCount === 0 && manifest.scenarios.length > 0,
      mismatchCount,
    },
    errors,
    errors.length > 0,
  );
}

/** Build a content manifest from a corpus (the generator side of the contract). */
export function buildContentManifest(
  owner: string,
  generation: number,
  corpus: ContentCorpus,
): ContentManifest {
  return {
    version: CONTENT_MANIFEST_VERSION,
    owner,
    generation,
    sources: corpus.documents.map((document) => ({
      path: document.sourcePath,
      digest: document.digest,
      id: document.id,
    })),
  };
}

/** Fingerprint of a manifest's declared inventory — the "generation id" for tests. */
export function manifestDigest(manifest: ContentManifest | MembershipManifest): string {
  return digestOfString(JSON.stringify(manifest));
}

export type { Json };
