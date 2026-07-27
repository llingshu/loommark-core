import { fromMarkdown } from 'mdast-util-from-markdown';

type MdastNode = {
  type: string;
  value?: string;
  alt?: string;
  depth?: number;
  children?: MdastNode[];
  position?: { start: { line: number; offset?: number } };
};

export type HeadingInfo = {
  label: string;
  level: number;
  ordinal: number;
  line: number;
  offset: number;
};

export type HeadingTreeNode = HeadingInfo & { children: HeadingTreeNode[] };

function headingText(node: MdastNode): string {
  if (node.value) return node.value;
  if (node.type === 'image' && node.alt) return node.alt;
  return node.children?.map(headingText).join('') ?? '';
}

// A flat list carries both a character offset (for scrolling/selecting inside a CodeMirror
// editor) and a 1-based line number (for hosts, like an editor's own explorer sidebar, that only
// know about lines). `ordinal` is the heading's position across the whole document regardless of
// nesting, stable enough to use as a jump target (see nestHeadings/revealHeading-style callers).
export function markdownHeadings(source: string): HeadingInfo[] {
  const tree = fromMarkdown(source) as MdastNode;
  const headings: HeadingInfo[] = [];
  let ordinal = 0;
  for (const node of tree.children ?? []) {
    if (node.type !== 'heading' || !node.depth) continue;
    headings.push({
      label: headingText(node).trim() || `Untitled H${node.depth}`,
      level: node.depth,
      ordinal: ordinal++,
      line: node.position?.start.line ?? 1,
      offset: node.position?.start.offset ?? 0,
    });
  }
  return headings;
}

// Folds a flat, level-tagged heading list into a nested tree — e.g. for a sidebar tree view. A
// heading closes every open section at its level or deeper, same rule headingSections()
// (markdown-ranges.ts) uses for section boundaries, just building parent/child links instead of
// from/to ranges.
export function nestHeadings(headings: HeadingInfo[]): HeadingTreeNode[] {
  const roots: HeadingTreeNode[] = [];
  const stack: HeadingTreeNode[] = [];
  for (const heading of headings) {
    const node: HeadingTreeNode = { ...heading, children: [] };
    while (stack.length && stack[stack.length - 1].level >= node.level) stack.pop();
    const siblings = stack.length ? stack[stack.length - 1].children : roots;
    siblings.push(node);
    stack.push(node);
  }
  return roots;
}
