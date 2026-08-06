import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annotationRanges,
  detailedFencedCodeRanges,
  fencedCodeRanges,
  inlineCodeRanges,
  escapedCharRanges,
  headingRanges,
  headingSections,
  horizontalRuleRanges,
  imageRanges,
  isEscaped,
  linkDestinationRanges,
  listGuideSegments,
  listItemRanges,
  mathRanges,
  orderedListLabels,
  quoteLineRanges,
  resolveAnnotationTarget,
  tableRanges,
  tagRanges,
} from '../out/test/markdown-ranges.mjs';

test('parses a fenced code block with language', () => {
  const source = 'before\n```ts\nconst x = 1;\n```\nafter';
  const [block] = detailedFencedCodeRanges(source);
  assert.equal(block.language, 'ts');
  assert.equal(block.code, 'const x = 1;');
  assert.equal(source.slice(block.openFrom, block.openTo), '```ts');
});

test('keeps an unterminated fence open to end of source', () => {
  const source = '```\ncode line';
  const [block] = detailedFencedCodeRanges(source);
  assert.equal(block.closeFrom, undefined);
  assert.equal(block.code, 'code line');
});

test('does not parse headings inside fenced code blocks', () => {
  const source = '# Real heading\n```markdown\n## Literal heading\n```\n### Another real heading';
  const headings = headingRanges(source);
  assert.deepEqual(headings.map((heading) => source.slice(heading.lineFrom, heading.lineTo)), [
    '# Real heading',
    '### Another real heading',
  ]);
});

test('inline code is excluded inside fenced blocks', () => {
  const source = '```\n`not inline`\n```\nreal `inline` here';
  const ranges = inlineCodeRanges(source, fencedCodeRanges(source));
  assert.equal(ranges.length, 1);
  assert.equal(source.slice(ranges[0].from, ranges[0].to), '`inline`');
});

test('parses a basic table with offsets', () => {
  const source = '| Name | Count |\n| --- | ---: |\n| Apple | 3 |\n| Pear | 12 |';
  const [table] = tableRanges(source);
  assert.equal(table.from, 0);
  assert.equal(table.to, source.length);
  assert.deepEqual(table.header.map((cell) => cell.text), ['Name', 'Count']);
  assert.deepEqual(table.alignments, [null, 'right']);
  assert.equal(table.rows.length, 2);
  assert.equal(source.slice(table.rows[0][0].from, table.rows[0][0].to), 'Apple');
});

test('parses all alignment kinds', () => {
  const source = '| a | b | c | d |\n| :-- | :-: | --: | --- |\n| 1 | 2 | 3 | 4 |';
  const [table] = tableRanges(source);
  assert.deepEqual(table.alignments, ['left', 'center', 'right', null]);
});

test('unescapes escaped pipes inside cells', () => {
  const source = '| a | b |\n| --- | --- |\n| x \\| y | z |';
  const [table] = tableRanges(source);
  assert.equal(table.rows[0][0].text, 'x | y');
});

test('rejects a header/delimiter column count mismatch', () => {
  const source = '| a | b |\n| --- |\n| 1 | 2 |';
  assert.equal(tableRanges(source).length, 0);
});

test('ignores tables inside fenced code blocks', () => {
  const source = '```\n| a | b |\n| --- | --- |\n```';
  assert.equal(tableRanges(source).length, 0);
});

test('table ends at the first line without a pipe', () => {
  const source = '| a |\n| --- |\n| 1 |\nplain text';
  const [table] = tableRanges(source);
  assert.equal(source.slice(table.from, table.to), '| a |\n| --- |\n| 1 |');
});

test('parses an own-line image', () => {
  const source = 'before\n![diagram](img/a.png)\nafter';
  const [image] = imageRanges(source);
  assert.equal(image.alt, 'diagram');
  assert.equal(image.src, 'img/a.png');
  assert.equal(image.ownLine, true);
});

test('parses an inline image and a titled image', () => {
  const source = 'see ![icon](i.svg "The icon") here';
  const [image] = imageRanges(source);
  assert.equal(image.ownLine, false);
  assert.equal(image.src, 'i.svg');
  assert.equal(image.title, 'The icon');
  assert.equal(source.slice(image.from, image.to), '![icon](i.svg "The icon")');
});

test('preserves image presentation tokens in the title', () => {
  const [image] = imageRanges('![diagram](img/a.png "center frame")');
  assert.equal(image.title, 'center frame');
});

test('ignores images inside code', () => {
  const source = '```\n![a](b.png)\n```\nand `![c](d.png)` too';
  assert.equal(imageRanges(source).length, 0);
});

test('parses an angle-bracket wrapped image destination', () => {
  const source = '![Fig 1a](<../Figures_all/Figure-1a-experiment_design.png>)';
  const [image] = imageRanges(source);
  assert.equal(image.src, '../Figures_all/Figure-1a-experiment_design.png');
  assert.equal(image.ownLine, true);
});

test('parses a plain parent-directory image path', () => {
  const source = '![Fig 1a](../Figures_all/Figure-1a-experiment_design.png)';
  const [image] = imageRanges(source);
  assert.equal(image.src, '../Figures_all/Figure-1a-experiment_design.png');
});

test('does not treat an escaped image marker as an image', () => {
  const source = 'literal \\![alt](a.png) text';
  assert.equal(imageRanges(source).length, 0);
});

test('finds the destination-only range of an image, excluding the label', () => {
  const source = '![Fig 1a](<../Figures_all/Figure-1a-experiment_design.png>)';
  const [range] = linkDestinationRanges(source);
  assert.equal(
    source.slice(range.from, range.to),
    '<../Figures_all/Figure-1a-experiment_design.png>',
  );
});

test('finds the destination range of a plain link, excluding the label', () => {
  const source = 'see [a_b_c](path/to/some_file_name.png) here';
  const [range] = linkDestinationRanges(source);
  assert.equal(source.slice(range.from, range.to), 'path/to/some_file_name.png');
});

test('parses simple and nested tags', () => {
  const source = 'a #idea and a #project/alpha tag';
  const tags = tagRanges(source);
  assert.deepEqual(tags.map((tag) => tag.name), ['idea', 'project/alpha']);
});

test('does not treat a heading marker as a tag', () => {
  const source = '# Heading one\n## Heading two';
  assert.equal(tagRanges(source).length, 0);
});

test('does not treat a mid-word hash or a numeric hash as a tag', () => {
  const source = 'foo#bar and issue #123 and c#sharp';
  assert.equal(tagRanges(source).length, 0);
});

test('does not treat an escaped hash as a tag', () => {
  const source = 'literal \\#idea here';
  assert.equal(tagRanges(source).length, 0);
});

test('isEscaped checks for an odd number of preceding backslashes', () => {
  assert.equal(isEscaped('\\*', 1), true);
  assert.equal(isEscaped('\\\\*', 2), false);
  assert.equal(isEscaped('\\\\\\*', 3), true);
  assert.equal(isEscaped('*', 0), false);
});

test('finds a single escaped punctuation character', () => {
  const source = 'literal \\* star';
  const [range] = escapedCharRanges(source);
  assert.equal(source.slice(range.from, range.to), '\\*');
});

test('pairs up a run of backslashes left to right like CommonMark', () => {
  // \\* is an escaped backslash (one range) followed by a live, unescaped star (no range for it).
  const source = '\\\\*';
  const ranges = escapedCharRanges(source);
  assert.equal(ranges.length, 1);
  assert.equal(source.slice(ranges[0].from, ranges[0].to), '\\\\');
});

test('a run of three backslashes escapes both the backslash and the following star', () => {
  const source = '\\\\\\*';
  const ranges = escapedCharRanges(source);
  assert.equal(ranges.length, 2);
  assert.equal(source.slice(ranges[0].from, ranges[0].to), '\\\\');
  assert.equal(source.slice(ranges[1].from, ranges[1].to), '\\*');
});

test('does not escape a backslash followed by a non-punctuation character', () => {
  const source = 'a\\nb';
  assert.equal(escapedCharRanges(source).length, 0);
});

test('ignores escape sequences inside code', () => {
  const source = '`\\*` and\n```\n\\*\n```';
  assert.equal(escapedCharRanges(source).length, 0);
});

test('ignores escape sequences inside math (LaTeX \\\\ row breaks, \\{ \\})', () => {
  const source = 'inline $\\{1, 2\\}$ and\n\n$$\nmatrix \\\\ next row\n$$';
  assert.equal(escapedCharRanges(source).length, 0);
});

test('ignores tags inside code and link destinations', () => {
  const source = '`#notreal` and [a](url#frag) and\n```\n#alsofake\n```';
  assert.equal(tagRanges(source).length, 0);
});

test('parses bullet levels and marker offsets', () => {
  const source = '- top\n    - nested\n        * deep';
  const items = listItemRanges(source);
  assert.deepEqual(items.map((item) => item.level), [0, 1, 2]);
  assert.equal(source.slice(items[1].markerFrom, items[1].markerTo), '-');
  assert.equal(items.every((item) => !item.ordered), true);
});

test('parses ordered and task items', () => {
  const source = '1. first\n- [ ] todo\n- [x] done';
  const items = listItemRanges(source);
  assert.equal(items[0].ordered, true);
  assert.equal(items[0].task, undefined);
  assert.equal(items[1].task.checked, false);
  assert.equal(items[2].task.checked, true);
  assert.equal(source.slice(items[1].task.boxFrom, items[1].task.boxTo), '[ ]');
});

test('does not treat horizontal rules or code as list items', () => {
  const source = '- - -\n```\n- in code\n```';
  assert.equal(listItemRanges(source).length, 0);
});

test('decimal style labels a flat ordered list 1, 2, 3', () => {
  const source = '1. a\n2. b\n3. c';
  const items = listItemRanges(source);
  const labels = orderedListLabels(source, items, 'decimal');
  assert.deepEqual(items.map((item) => labels.get(item.markerFrom)), ['1', '2', '3']);
});

test('source style keeps each ordered marker exactly as written', () => {
  const source = ['1. parent', '    2. child', '    7. another child'].join('\n');
  const items = listItemRanges(source);
  const labels = orderedListLabels(source, items, 'source');
  assert.deepEqual([...labels.values()], ['1', '2', '7']);
});

test('decimal style nests as 2.1, 2.2, then 2.2.1', () => {
  const source = [
    '1. a',
    '2. b',
    '    1. nested b1',
    '    2. nested b2',
    '        1. nested b2a',
    '3. c',
  ].join('\n');
  const items = listItemRanges(source);
  const labels = orderedListLabels(source, items, 'decimal');
  assert.deepEqual(items.map((item) => labels.get(item.markerFrom)), [
    '1', '2', '2.1', '2.2', '2.2.1', '3',
  ]);
});

test('decimal style restarts after a paragraph interrupts the list', () => {
  const source = '1. a\n2. b\n\nSome paragraph text.\n\n1. x\n2. y';
  const items = listItemRanges(source);
  const labels = orderedListLabels(source, items, 'decimal');
  assert.deepEqual(items.map((item) => labels.get(item.markerFrom)), ['1', '2', '1', '2']);
});

test('cycle style alternates arabic, letters, roman numerals per level', () => {
  const source = [
    '1. a',
    '2. b',
    '    1. nested b1',
    '    2. nested b2',
    '        1. nested b2a',
    '        2. nested b2b',
    '            1. nested b2b1',
  ].join('\n');
  const items = listItemRanges(source);
  const labels = orderedListLabels(source, items, 'cycle');
  assert.deepEqual(items.map((item) => labels.get(item.markerFrom)), [
    '1', '2', 'a', 'b', 'i', 'ii', '1',
  ]);
});

test('unordered items do not receive labels but still reset deeper counters', () => {
  const source = '1. a\n2. b\n- bullet\n1. restarts at 1';
  const items = listItemRanges(source);
  const labels = orderedListLabels(source, items, 'decimal');
  assert.deepEqual(items.map((item) => labels.get(item.markerFrom) ?? null), [
    '1', '2', null, '1',
  ]);
});

test('a flat list with no nesting produces no guide segments', () => {
  const source = '1. a\n2. b\n3. c';
  const items = listItemRanges(source);
  assert.deepEqual(listGuideSegments(source, items), []);
});

test('a parent with two children gets one guide segment spanning both', () => {
  const source = [
    '1. a',
    '2. b',
    '    1. nested b1',
    '    2. nested b2',
    '3. c',
  ].join('\n');
  const items = listItemRanges(source);
  const [segment] = listGuideSegments(source, items);
  const nestedB1 = items[2];
  const nestedB2 = items[3];
  assert.equal(segment.level, 0);
  assert.equal(segment.from, nestedB1.lineFrom);
  assert.equal(segment.to, nestedB2.lineTo);
});

test('three levels of nesting each get their own guide segment', () => {
  const source = [
    '1. a',
    '    1. nested a1',
    '        1. nested a1a',
  ].join('\n');
  const items = listItemRanges(source);
  const segments = listGuideSegments(source, items);
  assert.deepEqual(segments.map((segment) => segment.level).sort(), [0, 1]);
});

test('an indented continuation paragraph extends the guide segment', () => {
  const source = [
    '- item',
    '',
    '    A continuation paragraph indented under the item.',
  ].join('\n');
  const items = listItemRanges(source);
  const [segment] = listGuideSegments(source, items);
  assert.equal(segment.level, 0);
  assert.equal(segment.to, source.length);
  assert.ok(source.slice(segment.from, segment.to).includes('A continuation paragraph'));
});

test('an unindented paragraph after a blank line ends the list, no segment', () => {
  const source = [
    '- item',
    '',
    'An unrelated paragraph, not indented.',
  ].join('\n');
  const items = listItemRanges(source);
  assert.deepEqual(listGuideSegments(source, items), []);
});

test('an indented fenced code block extends the guide segment', () => {
  const source = [
    '- item',
    '    ```js',
    '    code line',
    '    ```',
  ].join('\n');
  const items = listItemRanges(source);
  const [segment] = listGuideSegments(source, items);
  assert.equal(segment.level, 0);
  assert.equal(source.slice(segment.to - 3, segment.to), '```');
});

test('parses quote lines with depth and marker offsets', () => {
  const source = '> outer\n> > inner\nplain';
  const quotes = quoteLineRanges(source);
  assert.equal(quotes.length, 2);
  assert.deepEqual(quotes.map((quote) => quote.depth), [1, 2]);
  assert.equal(source.slice(quotes[1].markerFrom, quotes[1].markerTo), '> > ');
});

test('parses horizontal rules and excludes code', () => {
  const source = '---\n***\n___\n```\n---\n```';
  const rules = horizontalRuleRanges(source);
  assert.equal(rules.length, 3);
  assert.equal(source.slice(rules[0].from, rules[0].to), '---');
});

test('parses inline math', () => {
  const source = 'Euler: $e^{i\\pi} + 1 = 0$ is neat';
  const [math] = mathRanges(source);
  assert.equal(math.tex, 'e^{i\\pi} + 1 = 0');
  assert.equal(math.display, false);
  assert.equal(source.slice(math.from, math.to), '$e^{i\\pi} + 1 = 0$');
});

test('parses display math including multi-line blocks', () => {
  const source = 'before\n$$\n\\int_0^1 x^2 \\, dx\n$$\nafter and $$a+b$$ inline';
  const blocks = mathRanges(source);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].display, true);
  assert.equal(blocks[0].tex, '\\int_0^1 x^2 \\, dx');
  assert.equal(blocks[1].tex, 'a+b');
  assert.equal(blocks[1].display, true);
});

test('does not treat currency as math', () => {
  const source = 'It costs $5 and $10 total, $ 20 and 30$ too';
  assert.equal(mathRanges(source).length, 0);
});

test('ignores math inside code', () => {
  const source = '```\n$x+y$\n```\nand `$a$` too';
  assert.equal(mathRanges(source).length, 0);
});

test('parses heading levels and line offsets', () => {
  const source = '# H1\ntext\n## H2\nmore\n### H3';
  const headings = headingRanges(source);
  assert.deepEqual(headings.map((h) => h.level), [1, 2, 3]);
  assert.equal(source.slice(headings[1].lineFrom, headings[1].lineTo), '## H2');
});

test('a lone top-level heading spans to the end of the document', () => {
  const source = '# Title\nbody line one\nbody line two';
  const headings = headingRanges(source);
  const [section] = headingSections(source, headings);
  assert.equal(section.level, 1);
  assert.equal(section.from, headings[0].lineFrom);
  assert.equal(section.to, source.length);
});

test('a shallower heading closes the previous section right before it', () => {
  const source = '# One\nbody\n# Two\nbody';
  const headings = headingRanges(source);
  const sections = headingSections(source, headings);
  const first = sections.find((s) => source.slice(s.from, s.from + 5) === '# One');
  assert.equal(source.slice(first.from, first.to), '# One\nbody');
});

test('nested headings each get their own section, parent spans the whole subtree', () => {
  // Once inside a level-3 section, only a heading of level <= 3 can end it — plain body text
  // can never "return" to a shallower section on its own, so "more three text" stays part of
  // Three's section, and Three's section stays part of Two's, and so on up to One's.
  const source = '# One\nintro\n## Two\nbody two\n### Three\nbody three\nmore three text';
  const headings = headingRanges(source);
  const sections = headingSections(source, headings);
  assert.equal(sections.length, 3);
  const byLevel = Object.fromEntries(sections.map((s) => [s.level, s]));
  assert.equal(source.slice(byLevel[3].from, byLevel[3].to), '### Three\nbody three\nmore three text');
  assert.equal(source.slice(byLevel[2].from, byLevel[2].to), source.slice(byLevel[2].from));
  assert.equal(source.slice(byLevel[1].from, byLevel[1].to), source);
});

test('a same-level heading closes all deeper open sections at once', () => {
  const source = '# One\n## Two\n### Three\n# Four';
  const headings = headingRanges(source);
  const sections = headingSections(source, headings);
  assert.equal(sections.length, 4);
  const closedBeforeFour = sections.filter((s) => s.to === source.indexOf('# Four') - 1);
  assert.equal(closedBeforeFour.length, 3);
});

test('parses a left annotation block with single-line content', () => {
  const source = 'target line\n<<<\nnote text\n<<<\nafter';
  const [annotation] = annotationRanges(source);
  assert.equal(annotation.side, 'left');
  assert.equal(annotation.text, 'note text');
  assert.equal(source.slice(annotation.from, annotation.to), '<<<\nnote text\n<<<');
});

test('parses a right annotation block with multi-line content', () => {
  const source = 'target line\n>>>\nline one\nline two\n>>>\nafter';
  const [annotation] = annotationRanges(source);
  assert.equal(annotation.side, 'right');
  assert.equal(annotation.text, 'line one\nline two');
  assert.equal(source.slice(annotation.contentFrom, annotation.contentTo), 'line one\nline two');
});

test('an unclosed annotation block extends to the end of the document', () => {
  const source = 'target\n<<<\nnever closed';
  const [annotation] = annotationRanges(source);
  assert.equal(annotation, undefined);
});

test('ignores annotation-like delimiters inside a fenced code block', () => {
  const source = 'target\n```\n<<<\ncode, not an annotation\n<<<\n```\nafter';
  assert.deepEqual(annotationRanges(source), []);
});

test('a delimiter line with trailing content does not open or close a block', () => {
  const source = 'target\n<<< not a delimiter\nsome text\n<<<\nafter';
  assert.deepEqual(annotationRanges(source), []);
});

test('an opening delimiter can carry a fixed color as a 6-hex-digit tag', () => {
  const source = 'target\n<<<7c3aed\nnote text\n<<<\nafter';
  const [annotation] = annotationRanges(source);
  assert.equal(annotation.color, '7c3aed');
  assert.equal(annotation.text, 'note text');
  assert.equal(annotation.side, 'left');
});

test('a right annotation can carry a color tag too', () => {
  const source = 'target\n>>>2563eb\nnote text\n>>>\nafter';
  const [annotation] = annotationRanges(source);
  assert.equal(annotation.color, '2563eb');
  assert.equal(annotation.side, 'right');
});

test('an opening delimiter can carry a persistent numeric id before its color', () => {
  const source = 'target\n<<<[12]7c3aed\nnote text\n<<<\nafter';
  const [annotation] = annotationRanges(source);
  assert.equal(annotation.id, 12);
  assert.equal(annotation.color, '7c3aed');
  assert.equal(annotation.text, 'note text');
});

test('an annotation id does not require a color tag', () => {
  const source = 'target\n>>>[1]\nnote text\n>>>\nafter';
  const [annotation] = annotationRanges(source);
  assert.equal(annotation.id, 1);
  assert.equal(annotation.color, undefined);
  assert.equal(annotation.side, 'right');
});

test('a bare opening delimiter has no color', () => {
  const source = 'target\n<<<\nnote text\n<<<\nafter';
  const [annotation] = annotationRanges(source);
  assert.equal(annotation.color, undefined);
  assert.equal('color' in annotation, false);
});

test('the closing delimiter must stay bare — a tag there does not close the block', () => {
  const source = 'target\n<<<7c3aed\nnote text\n<<<7c3aed\nafter';
  assert.equal(annotationRanges(source).length, 0);
});

test('a malformed or wrong-length tag on the opening delimiter is not a delimiter at all', () => {
  assert.deepEqual(annotationRanges('target\n<<<abc\nnote\n<<<\nafter'), []);
  assert.deepEqual(annotationRanges('target\n<<<7c3ae\nnote\n<<<\nafter'), []);
  assert.deepEqual(annotationRanges('target\n<<<7c3aedd\nnote\n<<<\nafter'), []);
  assert.deepEqual(annotationRanges('target\n<<<zzzzzz\nnote\n<<<\nafter'), []);
});

test('annotation ids must be unambiguous positive safe integers', () => {
  assert.deepEqual(annotationRanges('target\n<<<[0]\nnote\n<<<\nafter'), []);
  assert.deepEqual(annotationRanges('target\n<<<[01]\nnote\n<<<\nafter'), []);
  assert.deepEqual(annotationRanges('target\n<<<[abc]\nnote\n<<<\nafter'), []);
  assert.deepEqual(annotationRanges('target\n<<<[9007199254740992]\nnote\n<<<\nafter'), []);
});

test('resolveAnnotationTarget attaches to the immediately preceding line', () => {
  const source = 'target line\n<<<\nnote\n<<<\nafter';
  const [annotation] = annotationRanges(source);
  const target = resolveAnnotationTarget(source, annotation);
  assert.equal(source.slice(target.from, target.to), 'target line');
});

test('resolveAnnotationTarget skips past other annotation blocks stacked directly above it, regardless of side', () => {
  const source = [
    'target line',
    '<<<',
    'first note',
    '<<<',
    '>>>',
    'second note',
    '>>>',
  ].join('\n');
  const [first, second] = annotationRanges(source);
  const firstTarget = resolveAnnotationTarget(source, first);
  const secondTarget = resolveAnnotationTarget(source, second);
  assert.equal(source.slice(firstTarget.from, firstTarget.to), 'target line');
  assert.equal(source.slice(secondTarget.from, secondTarget.to), 'target line');
});

test('resolveAnnotationTarget treats a table/code/math/block-image above it as one whole target', () => {
  const tableSource = ['| a | b |', '| --- | --- |', '| 1 | 2 |', '<<<', 'note', '<<<'].join('\n');
  const [tableAnnotation] = annotationRanges(tableSource);
  const tableTarget = resolveAnnotationTarget(tableSource, tableAnnotation);
  assert.equal(tableSource.slice(tableTarget.from, tableTarget.to), '| a | b |\n| --- | --- |\n| 1 | 2 |');

  const codeSource = ['```', 'line one', 'line two', '```', '<<<', 'note', '<<<'].join('\n');
  const [codeAnnotation] = annotationRanges(codeSource);
  const codeTarget = resolveAnnotationTarget(codeSource, codeAnnotation);
  assert.equal(codeSource.slice(codeTarget.from, codeTarget.to), '```\nline one\nline two\n```');

  const mathSource = ['$$', 'x = 1', '$$', '<<<', 'note', '<<<'].join('\n');
  const [mathAnnotation] = annotationRanges(mathSource);
  const mathTarget = resolveAnnotationTarget(mathSource, mathAnnotation);
  assert.equal(mathSource.slice(mathTarget.from, mathTarget.to), '$$\nx = 1\n$$');

  const imageSource = ['![Figure](plot.png)', '<<<', 'note', '<<<'].join('\n');
  const [imageAnnotation] = annotationRanges(imageSource);
  const imageTarget = resolveAnnotationTarget(imageSource, imageAnnotation);
  assert.equal(imageSource.slice(imageTarget.from, imageTarget.to), '![Figure](plot.png)');
});

test('resolveAnnotationTarget returns undefined for an annotation with nothing above it', () => {
  const source = '<<<\nnote\n<<<\nafter';
  const [annotation] = annotationRanges(source);
  assert.equal(resolveAnnotationTarget(source, annotation), undefined);
});

test('an annotation block between two ordered items does not interrupt numbering', () => {
  const source = [
    '1. first',
    '<<<',
    'a comment on "first"',
    '<<<',
    '2. second',
  ].join('\n');
  const items = listItemRanges(source);
  const labels = orderedListLabels(source, items, 'decimal');
  assert.equal(labels.get(items[0].markerFrom), '1');
  assert.equal(labels.get(items[1].markerFrom), '2');
});

test('a real blank paragraph between ordered items still interrupts numbering (control case)', () => {
  const source = [
    '1. first',
    '',
    'a real paragraph, not an annotation',
    '',
    '1. second',
  ].join('\n');
  const items = listItemRanges(source);
  const labels = orderedListLabels(source, items, 'decimal');
  assert.equal(labels.get(items[0].markerFrom), '1');
  assert.equal(labels.get(items[1].markerFrom), '1');
});

test('an annotation block attached to a list item does not close its guide segment', () => {
  const source = [
    '- item',
    '    continuation paragraph',
    '<<<',
    'a comment',
    '<<<',
    '    more continuation, still part of the item',
  ].join('\n');
  const items = listItemRanges(source);
  const segments = listGuideSegments(source, items);
  assert.equal(segments.length, 1);
  assert.equal(source.slice(segments[0].from, segments[0].to), source.slice(source.indexOf('    continuation')));
});

test('resolveAnnotationTarget widens to a list item\'s own shift+enter continuation lines', () => {
  const source = [
    '- item',
    '    first continuation line',
    '    second continuation line',
    '<<<',
    'note',
    '<<<',
  ].join('\n');
  const [annotation] = annotationRanges(source);
  const target = resolveAnnotationTarget(source, annotation);
  assert.equal(
    source.slice(target.from, target.to),
    '- item\n    first continuation line\n    second continuation line',
  );
});

test('resolveAnnotationTarget stops a list item\'s compound span at a nested child item', () => {
  const source = [
    '- item',
    '    own continuation',
    '    - nested child',
    '<<<',
    'note',
    '<<<',
  ].join('\n');
  const [annotation] = annotationRanges(source);
  const target = resolveAnnotationTarget(source, annotation);
  // The annotation attaches to the nested child's own line (the immediate predecessor), which
  // has no continuation of its own here, so the target is just that one line — the parent
  // item's "own continuation" line must not be swept in along with it.
  assert.equal(source.slice(target.from, target.to), '    - nested child');
});

test('resolveAnnotationTarget stays a single line for a list item with no continuation of its own', () => {
  const source = ['- item', '<<<', 'note', '<<<'].join('\n');
  const [annotation] = annotationRanges(source);
  const target = resolveAnnotationTarget(source, annotation);
  assert.equal(source.slice(target.from, target.to), '- item');
});

test('a heading-looking line inside an annotation block is not a real heading', () => {
  const source = ['# real heading', 'body', '<<<', '# not a real heading', '<<<', 'after'].join('\n');
  const headings = headingRanges(source);
  assert.equal(headings.length, 1);
  assert.equal(source.slice(headings[0].lineFrom, headings[0].lineTo), '# real heading');
});

test('a table-looking block inside an annotation is not a real table', () => {
  const source = ['<<<', '| a | b |', '| --- | --- |', '| 1 | 2 |', '<<<'].join('\n');
  assert.deepEqual(tableRanges(source), []);
});

test('a $$...$$ block inside an annotation is not real display math', () => {
  const source = ['<<<', '$$', 'x = 1', '$$', '<<<'].join('\n');
  assert.deepEqual(mathRanges(source), []);
});

test('a blockquote-looking line inside an annotation is not a real blockquote', () => {
  const source = ['<<<', '> not a real quote', '<<<'].join('\n');
  assert.deepEqual(quoteLineRanges(source), []);
});

test('a horizontal-rule-looking line inside an annotation is not a real rule', () => {
  const source = ['<<<', '---', '<<<'].join('\n');
  assert.deepEqual(horizontalRuleRanges(source), []);
});

test('a #tag-looking token inside an annotation is not a real tag', () => {
  const source = ['<<<', '#nottag', '<<<'].join('\n');
  assert.deepEqual(tagRanges(source), []);
});
