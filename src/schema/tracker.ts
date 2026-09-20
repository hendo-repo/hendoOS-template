/** One grammar for configured current and legacy tracker identifiers. */
export class TrackerPrefixError extends Error {
  constructor(readonly code: 'empty-prefix' | 'leading-digit' | 'illegal-character' | 'duplicate-prefix') {
    super(code);
  }
}

export function parseTrackerPrefixes(input: string): string[] {
  const raw = input.split(',');
  if (!raw.length || raw.some(value => value.trim().length === 0)) throw new TrackerPrefixError('empty-prefix');
  const prefixes: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const prefix = value.trim().toUpperCase();
    if (/^[0-9]/.test(prefix)) throw new TrackerPrefixError('leading-digit');
    if (!/^[A-Z][A-Z0-9]*$/.test(prefix)) throw new TrackerPrefixError('illegal-character');
    if (seen.has(prefix)) throw new TrackerPrefixError('duplicate-prefix');
    seen.add(prefix);
    prefixes.push(prefix);
  }
  return prefixes;
}

export function trackerIdentifier(prefixes: readonly string[]): RegExp {
  if (!prefixes.length) throw new TrackerPrefixError('empty-prefix');
  return new RegExp(`\\b(?:${prefixes.join('|')})-[1-9][0-9]*\\b`, 'g');
}

export function parseTrackerIdentifier(value: string, prefixes: readonly string[]): { prefix: string; number: number } | null {
  const match = /^([A-Z][A-Z0-9]*)-([1-9][0-9]*)$/.exec(value.toUpperCase());
  if (!match || !prefixes.includes(match[1]!)) return null;
  const number = Number(match[2]);
  return Number.isSafeInteger(number) ? { prefix: match[1]!, number } : null;
}
