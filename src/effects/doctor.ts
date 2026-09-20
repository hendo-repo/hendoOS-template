/** Read-only compatibility inspection. Marker presence is evidence, never authority. */
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONTROL_STATE_PATH } from './install';

const LEGACY_MARKERS = ['.verified', 'legacy-verified', 'session-agent-complete'] as const;
const MAX_MARKER_BYTES = 4096;

export interface CompatibilityReport {
  status: 'clear' | 'foreign-markers' | 'coexistence';
  bunState: 'absent' | 'present' | 'malformed';
  foreign: { name: string; state: 'valid-looking' | 'stale-looking' | 'malformed' }[];
  authorization: 'none';
  collision: boolean;
}

async function marker(root: string, name: string): Promise<CompatibilityReport['foreign'][number] | null> {
  try {
    const info = await lstat(join(root, name));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_MARKER_BYTES) {
      return { name, state: 'malformed' };
    }
    const text = await readFile(join(root, name), 'utf8');
    const normalized = text.trim().toLowerCase();
    return { name, state: ['true', 'complete', 'verified', '1'].includes(normalized)
      ? 'valid-looking' : normalized === '' || /expired|stale|false|0/.test(normalized) ? 'stale-looking' : 'malformed' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : { name, state: 'malformed' };
  }
}

export async function inspectCompatibility(targetRoot: string): Promise<CompatibilityReport> {
  const foreign = (await Promise.all(LEGACY_MARKERS.map(name => marker(targetRoot, name))))
    .filter((value): value is CompatibilityReport['foreign'][number] => value !== null);
  let bunState: CompatibilityReport['bunState'] = 'absent';
  try {
    const info = await lstat(join(targetRoot, CONTROL_STATE_PATH));
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024 * 1024) bunState = 'malformed';
    else {
      const value: unknown = JSON.parse(await readFile(join(targetRoot, CONTROL_STATE_PATH), 'utf8'));
      const state = value as Record<string, unknown> | null;
      bunState = state && typeof state === 'object' && !Array.isArray(state) && state.schemaVersion === 1 &&
        typeof state.owner === 'string' && state.owner.length > 0 && Number.isSafeInteger(state.generation) &&
        Number(state.generation) > 0 && typeof state.harness === 'string' && Array.isArray(state.entries)
        ? 'present' : 'malformed';
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') bunState = 'malformed'; }
  const collision = foreign.length > 0 && bunState !== 'absent';
  return { status: collision ? 'coexistence' : foreign.length ? 'foreign-markers' : 'clear',
    bunState, foreign, authorization: 'none', collision };
}
