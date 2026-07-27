import assert from 'node:assert/strict';
import test from 'node:test';
import { markdownHeadings, nestHeadings } from '../out/test/headings.mjs';

test('extracts a flat list of headings with label, level, ordinal, line, and offset', () => {
  const source = '# One\nintro\n## Two\nbody';
  const headings = markdownHeadings(source);
  assert.equal(headings.length, 2);
  assert.deepEqual(headings[0], { label: 'One', level: 1, ordinal: 0, line: 1, offset: 0 });
  assert.deepEqual(headings[1], { label: 'Two', level: 2, ordinal: 1, line: 3, offset: 12 });
});

test('falls back to an "Untitled H<n>" label for an empty heading', () => {
  const [heading] = markdownHeadings('##   \n');
  assert.equal(heading.label, 'Untitled H2');
});

test('uses an image alt text as the heading label when the heading is just an image', () => {
  const [heading] = markdownHeadings('# ![a diagram](diagram.png)');
  assert.equal(heading.label, 'a diagram');
});

test('nests a flat heading list by level, closing deeper sections at same-or-shallower headings', () => {
  const headings = markdownHeadings('# One\n## Two\n### Three\n## Four\n# Five');
  const tree = nestHeadings(headings);
  assert.equal(tree.length, 2);
  assert.equal(tree[0].label, 'One');
  assert.equal(tree[0].children.length, 2);
  assert.equal(tree[0].children[0].label, 'Two');
  assert.equal(tree[0].children[0].children[0].label, 'Three');
  assert.equal(tree[0].children[1].label, 'Four');
  assert.equal(tree[1].label, 'Five');
});
