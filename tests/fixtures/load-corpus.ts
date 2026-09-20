/**
 * Test-only source loading.
 *
 * This is the ONLY module in the repository that touches the filesystem, and it
 * lives under `tests/`, never under `src/`. The pure core receives text; it never
 * reads a file, a clock, an environment variable or a network.
 */
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';
import {
  buildActivation,
  buildContentManifest,
  buildContentCorpus,
  compileContentDocument,
  type ActivationEvent,
  type ActivationResult,
  type ContentCorpus,
  type ContentDocument,
  type ContentManifest,
  type ContentSourceFile,
  type MembershipManifest,
  type Outcome,
} from '../../src/schema/index';

export interface LoadedCorpus {
  /** Every `content/**` markdown source, path-relative-to-repo, sorted by path. */
  files: ContentSourceFile[];
  corpus: ContentCorpus;
  manifest: ContentManifest;
}

/**
 * Repo root, resolved through `fileURLToPath` so a path containing spaces (a
 * percent-encoded `import.meta.url`) still resolves to a real directory.
 */
export const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
export const CONTENT_DIR = join(REPO_ROOT, 'content');

/** Recursively collect `content/**\/*.md` as normalized relative paths. Pure I/O. */
export async function loadContentFiles(dir: string = CONTENT_DIR): Promise<ContentSourceFile[]> {
  const out: ContentSourceFile[] = [];

  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith('.md')) continue;
      out.push({
        path: relative(REPO_ROOT, full).split(sep).join('/'),
        text: await readFile(full, 'utf8'),
      });
    }
  }

  await walk(dir);
  return out.sort((a, b) => (a.path < b.path ? -1 : 1));
}

/** Load the shipped starter corpus plus its generated content manifest. */
export async function loadCorpus(): Promise<LoadedCorpus> {
  const files = await loadContentFiles();
  const compiled = buildContentCorpus(files);
  const manifest: ContentManifest =
    compiled.value.documents.length > 0
      ? buildContentManifest('aos-core', 1, compiled.value)
      : { version: 1, owner: 'aos-core', generation: 1, sources: [] };
  return {
    files,
    corpus: compiled.value,
    manifest,
  };
}

/** Read the checked-in membership manifest from `content/`. */
export async function loadMembershipManifest(): Promise<MembershipManifest> {
  const text = await readFile(join(CONTENT_DIR, 'membership.manifest.json'), 'utf8');
  return JSON.parse(text) as MembershipManifest;
}

export interface ScenarioRun {
  event: ActivationEvent;
  activation: Outcome<ActivationResult>;
}

/**
 * Run one scenario against a document set.
 *
 * `compose` is the entry point that applies reference resolution; tests that need
 * raw activation use `buildActivation` directly. Both are exported so the two
 * layers can be asserted independently.
 */
export function activate(
  event: ActivationEvent,
  stateKeys: readonly string[],
  documents: readonly ContentDocument[],
): Outcome<ActivationResult> {
  return buildActivation(event, { keys: stateKeys }, documents);
}

export { compileContentDocument };
