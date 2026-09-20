/**
 * Text measurement + line folding.
 *
 * `byteLength` is the single definition of a content byte budget: UTF-8 bytes of
 * the *whole source document*, measured after newline normalization, so the number
 * is stable regardless of the authoring platform.
 *
 * `foldLines` is a deterministic word-wrap used for degraded/debug rendering. It is
 * NOT a layout algorithm: it folds on spaces only, never splits a word, and a word
 * longer than the width occupies its own over-width line.
 */
import { aosError, type AosError } from './error';

const encoder = new TextEncoder();
const CRLF = /\r\n?/g;
const WHITESPACE_RUN = /\s+/g;

/** Normalize line endings to `\n`. Pure. */
export function normalizeNewlines(input: string): string {
  return input.replace(CRLF, '\n');
}

/** UTF-8 byte length of `input`. Pure. */
export function byteLength(input: string): number {
  return encoder.encode(input).length;
}

/** UTF-8 byte length of `input` after newline normalization. Pure. */
export function normalizedByteLength(input: string): number {
  return byteLength(normalizeNewlines(input));
}

export function assertByteBudget(
  input: string,
  budget: number,
  path: string | null,
): AosError | null {
  const actual = normalizedByteLength(input);
  if (actual <= budget) return null;
  return aosError('byte-budget-exceeded', `content exceeds its byte budget by ${actual - budget} bytes`, {
    details: { actual, budget, over: actual - budget },
    path,
  });
}

/** Collapse all whitespace runs to single spaces and trim. Pure. */
export function collapseWhitespace(input: string): string {
  return input.replace(WHITESPACE_RUN, ' ').trim();
}

export interface FoldResult {
  lines: string[];
  overWidthLines: number;
}

/**
 * Deterministic word wrap. Long words are kept intact (never split), so a line may
 * exceed `width`; the count of such lines is returned for explicit reporting.
 */
export function foldLines(input: string, width: number): FoldResult {
  if (!Number.isInteger(width) || width < 1) {
    throw aosError('internal-invariant', 'foldLines width must be an integer >= 1', {
      details: { width },
    });
  }
  const lines: string[] = [];
  let overWidthLines = 0;
  for (const paragraph of normalizeNewlines(input).split('\n')) {
    const trimmed = paragraph.trim();
    if (trimmed === '') {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of trimmed.split(' ')) {
      if (current === '') {
        current = word;
        continue;
      }
      if (current.length + 1 + word.length <= width) {
        current += ` ${word}`;
      } else {
        lines.push(current);
        if (current.length > width) overWidthLines += 1;
        current = word;
      }
    }
    lines.push(current);
    if (current.length > width) overWidthLines += 1;
  }
  return { lines, overWidthLines };
}

/** Byte length of a JSON document as it would be written (canonical or compact). */
export function jsonByteLength(value: unknown, pretty = false): number {
  const text = JSON.stringify(value, null, pretty ? 2 : 0) ?? 'null';
  return byteLength(text);
}
