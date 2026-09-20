/**
 * Test-only seeded-defect fixtures.
 *
 * A gate that has never been seen to fail has not been demonstrated. Each
 * builder below takes a healthy corpus and injects exactly one defect class —
 * structural (schema), reference, budget, membership — so a test can assert the
 * gate fails *and* that its unseeded control passes.
 *
 * Pure: these functions return data; they never touch the filesystem.
 */
import type { ComposeIndex, StaticBlock } from '../../src/compose/index';
import type { ContentDocument, ContentSourceFile } from '../../src/schema/index';

export const SEEDED_BLOCK: StaticBlock = {
  id: 'seeded-framework',
  text: '<!-- aos:static -->\nFRAMEWORK RULES\n',
};

/** Healthy control: a minimal two-tier corpus plus a framework block. */
export interface SeededCorpus {
  files: ContentSourceFile[];
  documents: ContentDocument[];
  index: ComposeIndex;
}

function frontmatter(
  id: string,
  tier: 'kernel' | 'reference',
  event: string,
  extra: { budget?: number } = {},
): string {
  return [
    '---',
    `id: ${id}`,
    'version: 1',
    `tier: ${tier}`,
    'target_harnesses: [default]',
    `byte_budget: ${extra.budget ?? 4096}`,
    'activation_conditions:',
    '  - harnesses: [default]',
    `    event: ${event}`,
    '---',
    '',
  ].join('\n');
}

export const HEALTHY_SOURCES: readonly ContentSourceFile[] = [
  {
    path: 'content/kernel/seeded-kernel.md',
    text: `${frontmatter('seeded-kernel', 'kernel', 'session-start')}# Kernel\n\nRule body.\n\nReferences: seeded-recipes\n`,
  },
  {
    path: 'content/reference/seeded-recipes.md',
    text: `${frontmatter('seeded-recipes', 'reference', 'session-start')}# Recipes\n\nDepth body.\n`,
  },
];

export const HEALTHY_MUST_FIRE: readonly string[] = ['seeded-kernel', 'seeded-recipes'];
export const HEALTHY_EVENT = { id: 'session-start', harness: 'default' };

/** Structural defect: a source whose frontmatter violates the schema. */
export const STRUCTURAL_DEFECT: ContentSourceFile = {
  path: 'content/kernel/broken-shape.md',
  text: [
    '---',
    'id: broken-shape',
    'version: 1',
    'tier: kernel',
    'target_harnesses: []',
    'byte_budget: 4096',
    'activation_conditions:',
    '  - harnesses: [default]',
    '    event: session-start',
    '---',
    '',
    '# Broken',
    '',
    'Body.',
    '',
  ].join('\n'),
};

/** Structural defect: an unknown frontmatter key (typo silently disabling a rule). */
export const STRUCTURAL_UNKNOWN_KEY: ContentSourceFile = {
  path: 'content/kernel/broken-key.md',
  text: [
    '---',
    'id: broken-key',
    'version: 1',
    'tier: kernel',
    'target_harnesses: [default]',
    'byte_budget: 4096',
    'activation_conditions:',
    '  - harnesses: [default]',
    '    event: session-start',
    'activation_conditionss: []',
    '---',
    '',
    '# Broken key',
    '',
    'Body.',
    '',
  ].join('\n'),
};

/** Reference defect: an activated reference no kernel declares. */
export const REFERENCE_ORPHAN: ContentSourceFile = {
  path: 'content/reference/orphan-recipes.md',
  text: `${frontmatter('orphan-recipes', 'reference', 'session-start')}# Orphan\n\nNobody declared me.\n`,
};

/** Reference defect: a kernel declares a reference id absent from the index. */
export const REFERENCE_MISSING: ContentSourceFile = {
  path: 'content/kernel/declares-ghost.md',
  text: `${frontmatter('declares-ghost', 'kernel', 'session-start')}# Ghost\n\nBody.\n\nReferences: ghost-recipes\n`,
};

/** Budget defect: a body far over a tiny declared budget. */
export const BUDGET_DEFECT: ContentSourceFile = {
  path: 'content/kernel/over-budget.md',
  text: `${frontmatter('over-budget', 'kernel', 'session-start', { budget: 16 })}# Over\n\n${'x'.repeat(400)}\n`,
};

/** Membership defect: an expected id that does not activate. */
export const MEMBERSHIP_DEMOTED: readonly string[] = ['seeded-kernel', 'seeded-recipes', 'ghost-kernel'];

/** Membership defect: an id that activates but was not expected. */
export const MEMBERSHIP_EXTRA: readonly string[] = ['seeded-kernel'];

/** Build a corpus from sources and attach the seeded framework block. */
export function corpusIndex(
  documents: readonly ContentDocument[],
  mustFireIds?: readonly string[],
): ComposeIndex {
  return {
    documents,
    staticBlocks: [SEEDED_BLOCK],
    ...(mustFireIds === undefined ? {} : { mustFireIds }),
  };
}
