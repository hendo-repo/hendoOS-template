/**
 * Frontmatter nesting regression.
 *
 * A block list of maps whose continuation line re-opens a deeper mapping
 * (`- event: e` then `meta:` then `a: 1` indented further) was silently
 * flattened: `meta` became `null` and `a` became a sibling key of the item.
 * The parser contract promises fail-closed behaviour — unsupported indentation
 * is rejected with `frontmatter-parse-failed`, never silently restructured.
 */
import { expect, test } from 'bun:test';
import { parseFrontmatter } from '../src/schema/frontmatter';

const doc = (front: string) => `---\n${front}---\nbody\n`;
const json = (value: unknown) => JSON.parse(JSON.stringify(value));

test('a nested mapping inside a list item refuses instead of flattening', () => {
  const result = parseFrontmatter(doc('- event: e\n  meta:\n    a: 1\n'));
  expect(result.ok).toBe(false);
  expect(result.errors.some((error) => error.code === 'frontmatter-parse-failed')).toBe(true);
  expect(result.value.data).toBeNull();
});

test('a continuation line indented past the list-item block refuses', () => {
  const result = parseFrontmatter(doc('- event: e\n      stray: 1\n'));
  expect(result.ok).toBe(false);
  expect(result.errors.some((error) => error.code === 'frontmatter-parse-failed')).toBe(true);
  expect(result.value.data).toBeNull();
});

test('a supported block list of maps still parses', () => {
  const result = parseFrontmatter(
    doc('- harnesses: [default]\n  event: task-start\n- event: other\n'),
  );
  expect(result.ok).toBe(true);
  expect(json(result.value.data)).toEqual([
    { harnesses: ['default'], event: 'task-start' },
    { event: 'other' },
  ]);
});

test('a mapping key with an empty value at the item depth still parses as null', () => {
  const result = parseFrontmatter(doc('- event: e\n  meta:\n- event: f\n'));
  expect(result.ok).toBe(true);
  expect(json(result.value.data)).toEqual([
    { event: 'e', meta: null },
    { event: 'f' },
  ]);
});

test('a list item map under a keyed list still parses', () => {
  const result = parseFrontmatter(
    doc('activation_conditions:\n  - harnesses: [default]\n    event: task-start\n'),
  );
  expect(result.ok).toBe(true);
  expect(json(result.value.data)).toEqual({
    activation_conditions: [{ harnesses: ['default'], event: 'task-start' }],
  });
});
