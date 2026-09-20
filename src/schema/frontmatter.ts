/**
 * Frontmatter parsing — deterministic, dependency-free, subset-only.
 *
 * ## Format
 *
 * A document MAY begin with a frontmatter block:
 *
 * ```
 * ---
 * key: value
 * ---
 * body
 * ```
 *
 * The opening `---` must be the first line (a leading UTF-8 BOM and a single
 * leading blank line are tolerated). The closing `---` must be a line of exactly
 * three dashes. Everything after it is the body, verbatim.
 *
 * ## Supported YAML subset (everything else is a parse failure, never a guess)
 *
 * | Feature | Form |
 * | --- | --- |
 * | scalar | `key: value` |
 * | quoted scalar | `key: "a: b"` / `key: 'a b'` |
 * | int / bool / null | `1`, `-2`, `true`, `false`, `null`, `~` |
 * | flow list | `key: [a, b, "c"]` |
 * | block list | `key:` then deeper `- item` lines |
 * | block list of maps | `key:` then `- field: a` with continuation keys deeper-indented |
 * | comments | `# ...` outside quotes; blank lines skipped |
 *
 * Rejected on purpose (fail-closed, each returns an `AosError`): tabs for
 * indentation, duplicate keys, anchors/aliases (`&`/`*`), tags (`!`), block scalars
 * (`|`, `>`), flow maps (`{}`), nested lists inside a list item, a nested mapping
 * inside a list item (continuation keys of an item must be exactly one level deeper
 * than the dash), and any line whose indentation does not match the block it sits in.
 *
 * ## Purity
 *
 * No I/O, no clock, no randomness, no import-time work. The same text always
 * produces the same value or the same error list.
 */
import { aosError, type AosError } from '../protocols/error';
import type { Json } from '../protocols/json';
import { normalizeNewlines } from '../protocols/text';

export interface ParsedFrontmatter {
  /** Parsed frontmatter value, or `null` when the document has no frontmatter block. */
  data: Json | null;
  /** Body text after the closing dashes, newline-normalized; whole doc when absent. */
  body: string;
  /** Normalized whole-source text (frontmatter + body), the digest input. */
  source: string;
  /** True when a frontmatter block was present and terminated. */
  hasFrontmatter: boolean;
}

export interface FrontmatterParseResult {
  ok: boolean;
  errors: readonly AosError[];
  value: ParsedFrontmatter;
}

interface Line {
  indent: number;
  content: string;
  number: number;
}

const OPEN = /^-{3}\s*$/;
const KEY_VALUE = /^([A-Za-z0-9_][A-Za-z0-9_-]*):(.*)$/;
const INTEGER = /^-?\d+$/;

/** Parse a whole source document into frontmatter + body. Pure, never throws. */
export function parseFrontmatter(input: unknown): FrontmatterParseResult {
  if (typeof input !== 'string') return { ok: false, errors: [aosError('invalid-input-shape', 'frontmatter source must be a string')], value: { data: null, body: '', source: '', hasFrontmatter: false } };
  const source = normalizeNewlines(input);
  const lines = source.split('\n');

  let start = 0;
  if (lines.length > 0 && (lines[0] as string).charCodeAt(0) === 0xfeff) {
    lines[0] = (lines[0] as string).slice(1);
  }
  while (start < lines.length && (lines[start] as string).trim() === '') start += 1;

  if (start >= lines.length || !OPEN.test(lines[start] as string)) {
    return {
      ok: true,
      errors: [],
      value: { data: null, body: source, source, hasFrontmatter: false },
    };
  }

  let end = -1;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (OPEN.test(lines[index] as string)) {
      end = index;
      break;
    }
  }
  if (end === -1) {
    return {
      ok: false,
      errors: [
        aosError('frontmatter-unterminated', 'frontmatter block is not closed by a `---` line', {
          details: { openedAtLine: start + 1 },
        }),
      ],
      value: { data: null, body: source, source, hasFrontmatter: false },
    };
  }

  const block = tokenize(lines.slice(start + 1, end), start + 2);
  if (!block.ok) {
    return {
      ok: false,
      errors: block.errors,
      value: { data: null, body: source, source, hasFrontmatter: true },
    };
  }

  if (block.value.length === 0) {
    return {
      ok: true,
      errors: [],
      value: { data: {}, body: lines.slice(end + 1).join('\n'), source, hasFrontmatter: true },
    };
  }

  const firstLine = block.value[0];
  const parsed = parseBlock(block.value, 0, firstLine ? firstLine.indent : 0);
  if (!parsed.ok) {
    return {
      ok: false,
      errors: parsed.errors,
      value: { data: null, body: source, source, hasFrontmatter: true },
    };
  }
  if (parsed.next < block.value.length) {
    return {
      ok: false,
      errors: [
        aosError('frontmatter-parse-failed', 'unexpected indentation in frontmatter', {
          details: { line: (block.value[parsed.next] as Line).number },
        }),
      ],
      value: { data: null, body: source, source, hasFrontmatter: true },
    };
  }

  return {
    ok: true,
    errors: [],
    value: {
      data: parsed.value,
      body: lines.slice(end + 1).join('\n'),
      source,
      hasFrontmatter: true,
    },
  };
}

type TokenizeResult =
  | { ok: true; value: Line[]; errors: readonly AosError[] }
  | { ok: false; value: Line[]; errors: readonly AosError[] };

function tokenize(raw: readonly string[], firstLineNumber: number): TokenizeResult {
  const errors: AosError[] = [];
  const lines: Line[] = [];
  for (let index = 0; index < raw.length; index += 1) {
    const number = firstLineNumber + index;
    let text = raw[index] as string;
    if (text.includes('\t')) {
      errors.push(
        aosError('frontmatter-parse-failed', 'tab characters are not allowed in frontmatter', {
          details: { line: number },
        }),
      );
      continue;
    }
    const trimmedEnd = text.replace(/\s+$/, '');
    if (trimmedEnd.trim() === '') continue;
    const indent = trimmedEnd.length - trimmedEnd.trimStart().length;
    const content = trimmedEnd.trimStart();
    if (content.startsWith('#')) continue;
    const stripped = stripComment(content);
    if (stripped === '') continue;
    lines.push({ indent, content: stripped, number });
  }
  if (errors.length > 0) return { ok: false, value: lines, errors };
  return { ok: true, value: lines, errors };
}

/** Remove a trailing `# ...` comment that is outside quotes. */
function stripComment(content: string): string {
  let quote: string | null = null;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index] as string;
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '#' && (index === 0 || content[index - 1] === ' ')) {
      return content.slice(0, index).trimEnd();
    }
  }
  return content;
}

type BlockResult =
  | { ok: true; value: Json; next: number }
  | { ok: false; errors: readonly AosError[]; next: number };

function parseBlock(lines: readonly Line[], start: number, indent: number): BlockResult {
  const first = lines[start];
  if (!first) {
    return { ok: true, value: null, next: start };
  }
  if (first.content.startsWith('- ') || first.content === '-') {
    return parseList(lines, start, indent);
  }
  return parseMap(lines, start, indent);
}

function parseMap(lines: readonly Line[], start: number, indent: number): BlockResult {
  const out: { [key: string]: Json } = Object.create(null);
  const errors: AosError[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index] as Line;
    if (line.indent < indent) break;
    if (line.indent > indent) {
      errors.push(
        aosError('frontmatter-parse-failed', 'unexpected indentation', {
          details: { line: line.number, indent: line.indent, expected: indent },
        }),
      );
      return { ok: false, errors, next: index };
    }
    if (line.content.startsWith('- ') || line.content === '-') break;

    const match = KEY_VALUE.exec(line.content);
    if (!match) {
      errors.push(
        aosError('frontmatter-parse-failed', 'expected a `key: value` line', {
          details: { line: line.number },
        }),
      );
      return { ok: false, errors, next: index };
    }
    const key = match[1] as string;
    const rest = (match[2] as string).trim();
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      errors.push(
        aosError('frontmatter-parse-failed', `duplicate frontmatter key \`${key}\``, {
          details: { line: line.number, key },
        }),
      );
      return { ok: false, errors, next: index };
    }

    if (rest === '') {
      const next = lines[index + 1];
      if (next && next.indent > indent) {
        const nested = parseBlock(lines, index + 1, next.indent);
        if (!nested.ok) return nested;
        out[key] = nested.value;
        index = nested.next;
      } else {
        out[key] = null;
        index += 1;
      }
      continue;
    }

    const scalar = parseScalar(rest, line.number, key);
    if (!scalar.ok) return { ok: false, errors: scalar.errors, next: index };
    out[key] = scalar.value;
    index += 1;
  }

  return { ok: true, value: out, next: index };
}

function parseList(lines: readonly Line[], start: number, indent: number): BlockResult {
  const out: Json[] = [];
  const errors: AosError[] = [];
  let index = start;

  while (index < lines.length) {
    const line = lines[index] as Line;
    if (line.indent < indent) break;
    if (line.indent > indent) break;
    if (!(line.content.startsWith('- ') || line.content === '-')) break;

    const itemText = line.content === '-' ? '' : line.content.slice(2).trim();
    if (itemText === '') {
      errors.push(
        aosError('frontmatter-parse-failed', 'nested lists inside a list item are not supported', {
          details: { line: line.number },
        }),
      );
      return { ok: false, errors, next: index };
    }

    const inlineKey = KEY_VALUE.exec(itemText);
    if (inlineKey && inlineKey[2] !== undefined) {
      const synthetic: Line[] = [
        { indent: line.indent + 2, content: itemText, number: line.number },
      ];
      let cursor = index + 1;
      while (cursor < lines.length && (lines[cursor] as Line).indent > indent) {
        const continuation = lines[cursor] as Line;
        if (continuation.content.startsWith('- ') || continuation.content === '-') {
          errors.push(
            aosError('frontmatter-parse-failed', 'nested lists inside a list item are not supported', {
              details: { line: continuation.number },
            }),
          );
          return { ok: false, errors, next: index };
        }
        // Continuation keys of a list item sit exactly one level deeper than the
        // dash. Anything deeper re-opens a nested mapping, which this subset does
        // not support — refuse rather than flatten it into the item's siblings.
        if (continuation.indent !== line.indent + 2) {
          errors.push(
            aosError('frontmatter-parse-failed', 'unexpected indentation in a list item', {
              details: {
                line: continuation.number,
                indent: continuation.indent,
                expected: line.indent + 2,
              },
            }),
          );
          return { ok: false, errors, next: index };
        }
        synthetic.push({
          indent: line.indent + 2,
          content: continuation.content,
          number: continuation.number,
        });
        cursor += 1;
      }
      const mapResult = parseMap(synthetic, 0, line.indent + 2);
      if (!mapResult.ok) return { ok: false, errors: mapResult.errors, next: index };
      out.push(mapResult.value);
      index = cursor;
      continue;
    }

    const scalar = parseScalar(itemText, line.number, null);
    if (!scalar.ok) return { ok: false, errors: scalar.errors, next: index };
    out.push(scalar.value);
    index += 1;
  }

  return { ok: true, value: out, next: index };
}

type ScalarResult =
  | { ok: true; value: Json }
  | { ok: false; errors: readonly AosError[] };

function parseScalar(text: string, line: number, key: string | null): ScalarResult {
  const reject = (reason: string): ScalarResult => ({
    ok: false,
    errors: [
      aosError('frontmatter-parse-failed', `unsupported frontmatter value: ${reason}`, {
        details: { line, key },
      }),
    ],
  });

  if (text.startsWith('|') || text.startsWith('>')) return reject('block scalars are not supported');
  if (text.startsWith('&') || text.startsWith('*')) return reject('anchors/aliases are not supported');
  if (text.startsWith('!')) return reject('tags are not supported');
  if (text.startsWith('{')) return reject('flow maps are not supported');

  if (text.startsWith('[')) {
    if (!text.endsWith(']')) return reject('unterminated flow list');
    const inner = text.slice(1, -1).trim();
    if (inner === '') return { ok: true, value: [] };
    const parts = splitFlow(inner);
    if (!parts.ok) return reject(parts.reason);
    const values: Json[] = [];
    for (const part of parts.value) {
      const trimmed = part.trim();
      if (trimmed === '') return reject('empty flow-list entry');
      const scalar = parseScalar(trimmed, line, key);
      if (!scalar.ok) return scalar;
      values.push(scalar.value);
    }
    return { ok: true, value: values };
  }

  if ((text.startsWith('"') && text.endsWith('"') && text.length >= 2) ||
      (text.startsWith("'") && text.endsWith("'") && text.length >= 2)) {
    const inner = text.slice(1, -1);
    if (text.startsWith('"')) {
      return { ok: true, value: inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') };
    }
    return { ok: true, value: inner.replace(/''/g, "'") };
  }
  if (text.startsWith('"') || text.startsWith("'")) return reject('unterminated quoted value');

  if (text === 'true') return { ok: true, value: true };
  if (text === 'false') return { ok: true, value: false };
  if (text === 'null' || text === '~') return { ok: true, value: null };
  if (INTEGER.test(text)) return { ok: true, value: Number.parseInt(text, 10) };
  return { ok: true, value: text };
}

function splitFlow(
  inner: string,
): { ok: true; value: string[] } | { ok: false; reason: string } {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index] as string;
    if (quote) {
      current += char;
      if (char === '\\') {
        current += inner[index + 1] ?? '';
        index += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ',') {
      parts.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (quote) return { ok: false, reason: 'unterminated quote in flow list' };
  parts.push(current);
  return { ok: true, value: parts };
}
