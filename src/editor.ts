import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  autocompletion,
  completionStatus,
  type CompletionContext,
  type CompletionResult,
} from '@codemirror/autocomplete';
import { markdown } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { EditorState, type Extension, type Range, RangeSet, RangeValue, StateEffect, StateField } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  layer,
  type LayerMarker,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import { tags } from '@lezer/highlight';
import { GFM } from '@lezer/markdown';
import {
  codeRanges,
  containsPosition,
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
  LIST_INDENT_WIDTH,
  listGuideSegments,
  listItemRanges,
  mathRanges,
  orderedListLabels,
  quoteLineRanges,
  tableRanges,
  tagRanges,
} from './markdown-ranges';
import {
  BulletWidget,
  CardBoundaryWidget,
  CheckboxWidget,
  CodeToolbarWidget,
  enterTableFromKeyboard,
  HorizontalRuleWidget,
  ImageWidget,
  ListGuideWidget,
  MathWidget,
  OrderedLabelWidget,
  QuoteMarkerWidget,
  TableWidget,
  type BlockCardPresentation,
} from './widgets';
import { singleSplice } from './text';
import { markdownHeadings } from './headings';
import type {
  CardMode,
  EditorConfiguration,
  OrderedListStyle,
  TableMode,
  TableStyle,
} from './types';

export type LoomMarkStateSnapshot = {
  text: string;
  documentRevision: number;
  outlineCollapsed: boolean;
  cursor?: number;
};

export type LoomMarkEditorOptions = EditorConfiguration & {
  text: string;
  documentRevision?: number;
  resourceBase?: string;
  wikiFiles?: string[];
  initialOutlineCollapsed?: boolean;
  initialCursor?: number;
  // Extra CodeMirror extensions appended after this package's own — the seam a host uses to add
  // its own StateField/keymap/Decoration (e.g. an annotation-capture feature) without forking.
  extensions?: Extension[];
  // Called (debounced by syncDelay) whenever local edits need persisting. A host with async
  // persistence (a save API, a VS Code TextDocument edit) replies later via acknowledgeSync();
  // a host that persists synchronously can just call acknowledgeSync() immediately.
  onSync?: (text: string, baseRevision: number, clientRevision: number) => void;
  // Requests the host save a pasted clipboard image and return a path to link it from. Resolves
  // with either { relativePath } to insert `![](relativePath)`, or { error } to show a failure.
  onPasteImage?: (data: string, mimeType: string) => Promise<{ relativePath?: string; error?: string }>;
  // Ctrl/Cmd+click on a link or wiki-link asks the host to actually open it (a browser, another
  // document, ...) since the kernel itself has no notion of what "open" means for a given host.
  onOpenLink?: (href: string, wiki: boolean) => Promise<{ status: 'opened' | 'error'; resolvedUri?: string; error?: string }>;
  // Called after any state a host might want to persist (across reloads, sessions, etc.) changes.
  // Purely advisory — the host decides where this goes (VS Code webview state, localStorage, ...).
  onStateChange?: (state: LoomMarkStateSnapshot) => void;
};

export type LoomMarkEditor = {
  getText(): string;
  // Applies an externally-arrived document change (a reload, a change made elsewhere) as a
  // minimal diff against the current text, so the cursor only moves if the edit actually touches it.
  setText(text: string, documentRevision?: number): void;
  // Resolves a sync round trip started by onSync's clientRevision. If the host's canonical text
  // differs from what was sent (e.g. another writer edited concurrently), applies it like setText.
  acknowledgeSync(clientRevision: number, documentRevision: number, text: string): void;
  updateConfiguration(config: EditorConfiguration): void;
  setWikiFiles(wikiFiles: string[]): void;
  revealHeadingByOrdinal(ordinal: number): void;
  setOutlineCollapsed(collapsed: boolean): void;
  getDiagnosticsReport(): Record<string, unknown>;
  focus(): void;
  destroy(): void;
};

function requiredChild<T extends Element>(container: HTMLElement, selector: string): T {
  const element = container.querySelector<T>(selector);
  if (!element) throw new Error(`Missing editor element: ${selector}`);
  return element;
}

export function createLoomMarkEditor(container: HTMLElement, options: LoomMarkEditorOptions): LoomMarkEditor {
  container.classList.add('loommark-workspace');
  container.innerHTML = `
    <main class="loommark-editor-root" aria-label="Markdown editor"></main>
    <button class="loommark-outline-fab" type="button" title="Show outline" aria-label="Show outline" aria-expanded="false">
      <span class="outline-fab-icon" aria-hidden="true"><i></i><i></i><i></i></span>
    </button>
    <aside class="loommark-outline" aria-label="Document outline">
      <header class="outline-header">
        <span class="outline-title">Outline</span>
        <button class="loommark-outline-toggle" type="button" title="Hide outline" aria-label="Hide outline" aria-expanded="true">
          <span class="outline-toggle-icon" aria-hidden="true"></span>
        </button>
      </header>
      <nav class="outline-nav" aria-label="Headings">
        <ol class="loommark-outline-list"></ol>
        <p class="loommark-outline-empty">No headings</p>
      </nav>
    </aside>
    <div class="loommark-status" role="status">Loading editor...</div>
  `;
  const root = requiredChild<HTMLElement>(container, '.loommark-editor-root');
  const status = requiredChild<HTMLElement>(container, '.loommark-status');
  const outline = requiredChild<HTMLElement>(container, '.loommark-outline');
  const outlineList = requiredChild<HTMLOListElement>(container, '.loommark-outline-list');
  const outlineEmpty = requiredChild<HTMLElement>(container, '.loommark-outline-empty');
  const outlineToggle = requiredChild<HTMLButtonElement>(container, '.loommark-outline-toggle');
  const outlineFab = requiredChild<HTMLButtonElement>(container, '.loommark-outline-fab');

let sourceText = options.text;
let documentRevision = options.documentRevision ?? 0;
let resourceBase = options.resourceBase ?? '';
let tableMode: TableMode = options.table;
let tableStyle: TableStyle = options.tableStyle;
let orderedListStyle: OrderedListStyle = options.orderedListStyle;
let listGuidesEnabled = options.listGuides;

let cardMode: CardMode = options.cardMode;
let cardBackgroundColors: string[] = options.cardBackgroundColors;
let cardBorderColors: string[] = options.cardBorderColors;
let cardBackgroundStrength = options.cardBackgroundStrength;
let cardBorderStrength = options.cardBorderStrength;
let backgroundDiagnostic: EditorConfiguration['background'] | undefined = options.background;
let cardImage: EditorConfiguration['cardImage'] = options.cardImage;
let cardImageRevision = 0;
let keyboardEditing = options.keyboardEditing;
let clientRevision = 0;
let syncDelay = options.syncDelay;
let timer: number | undefined;
let editor: EditorView | undefined;
let applyingHostUpdate = false;
let wikiFiles: string[] = options.wikiFiles ?? [];
let lastPointerDiagnostic: Record<string, unknown> | undefined;
let lastVisualHoverDiagnostic: Record<string, unknown> | undefined;
let lastLinkRequest: Record<string, unknown> | undefined;
let lastHostLinkResult: Record<string, unknown> | undefined;
let lastPasteDiagnostic: Record<string, unknown> | undefined;
let lastImagePasteResult: Record<string, unknown> | undefined;
// Rolling logs for LoomMark: Copy Editor Diagnostics, to see exactly what a keypress did without
// having to reproduce a report with a headless browser: recentKeydowns records the raw DOM event
// (key/modifiers, and whether *something* called preventDefault on it) as it happens, in capture
// phase so nothing else can react first; recentSelectionChanges records every resulting selection
// move. Comparing the two after reproducing a "keyboardEditing doesn't work" report shows whether
// the keypress reached the page at all, whether some handler claimed it, and whether the cursor
// actually moved (and by how much) versus visually appearing to skip.
const recentKeydowns: Array<{ at: string; key: string; shift: boolean; ctrl: boolean; alt: boolean; meta: boolean; defaultPrevented: boolean }> = [];
const recentSelectionChanges: Array<{ at: string; head: number }> = [];
let editorInitializationError: string | undefined;
let localGeneration = 0;
const pendingEdits = new Map<number, number>();
let outlineCollapsed = options.initialOutlineCollapsed ?? true;
let initialCursorRestored = false;
let nextPasteRequestId = 1;

const headingDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildHeadingDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      this.decorations = buildHeadingDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

const inlineDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildInlineDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      this.decorations = buildInlineDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

const markdownHighlightStyle = HighlightStyle.define([
  { tag: tags.strong, fontWeight: '700' },
  { tag: tags.emphasis, fontStyle: 'italic' },
  { tag: tags.strikethrough, textDecoration: 'line-through' },
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword], color: '#c678dd' },
  { tag: [tags.string, tags.special(tags.string)], color: '#98c379' },
  { tag: [tags.number, tags.bool, tags.null], color: '#d19a66' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: '#61afef' },
  { tag: [tags.typeName, tags.className], color: '#e5c07b' },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: '#5c6370', fontStyle: 'italic' },
]);

const linkDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildLinkDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      this.decorations = buildLinkDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

const tagDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildTagDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = buildTagDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

const escapedCharDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildEscapedCharDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet) {
      this.decorations = buildEscapedCharDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

const inlineCodeDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildInlineCodeDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      this.decorations = buildInlineCodeDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

const fencedCodeDecorations = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = buildFencedCodeDecorations(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.selectionSet || update.viewportChanged || update.focusChanged) {
      this.decorations = buildFencedCodeDecorations(update.view);
    }
  }
}, { decorations: (value) => value.decorations });

const codeCursorAttributes = EditorView.editorAttributes.of((view) => ({
  class: isCursorInFencedCode(view) ? 'cm-loommark-code-cursor' : '',
}));

const codeToolbarField = StateField.define<DecorationSet>({
  create(state) {
    return buildCodeToolbarDecorations(state);
  },
  update(value, transaction) {
    if (transaction.docChanged
      || transaction.effects.some((effect) => effect.is(decorationsRefresh))) {
      return buildCodeToolbarDecorations(transaction.state);
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const decorationsRefresh = StateEffect.define<null>();

function selectionAwareField(build: (state: EditorState) => DecorationSet): StateField<DecorationSet> {
  return StateField.define<DecorationSet>({
    create: build,
    update(value, transaction) {
      if (transaction.docChanged || transaction.selection
        || transaction.effects.some((effect) => effect.is(decorationsRefresh))) {
        return build(transaction.state);
      }
      return value;
    },
    provide: (field) => EditorView.decorations.from(field),
  });
}

// True when the current selection sits entirely within [from, to]: a collapsed cursor placed
// inside to edit, or a range selection made *within* already-revealed source to copy it (e.g.
// double-clicking a word, or dragging across some of the raw text) both count. False for a
// selection that extends outside the range — a drag or shift-click that merely passes through
// while selecting a wider span, which must not force the widget to reveal for the duration (see
// docs/EDITOR_TECHNOLOGY.md, "Widgets"). Checking only the selection head (as an earlier version
// of this did) got the first case right but broke the second: once revealed, selecting text
// inside it to copy turns the selection non-empty, which needs to keep counting as "inside".
function selectionWithin(state: EditorState, from: number, to: number): boolean {
  const selection = state.selection.main;
  return selection.from >= from && selection.to <= to;
}

const tableField = selectionAwareField((state) => {
  const ranges: Range<Decoration>[] = [];
  const source = state.doc.toString();
  for (const table of tableRanges(source)) {
    if (tableMode === 'source' && selectionWithin(state, table.from, table.to)) continue;
    ranges.push(Decoration.replace({
      widget: new TableWidget(
        table,
        source.slice(table.from, table.to),
        tableMode,
        blockCardPresentation(source, table.from),
      ),
      block: true,
    }).range(table.from, table.to));
  }
  return Decoration.set(ranges, true);
});

const imageField = selectionAwareField((state) => {
  const ranges: Range<Decoration>[] = [];
  const source = state.doc.toString();
  const destinations = linkDestinationRanges(source);
  const markSource = (image: { from: number; to: number; src: string }): void => {
    // Cursor-inside (source) state: no widget, but the raw text should still be easy to
    // spot (a highlighted background) and Ctrl/Cmd + click should still open the image,
    // so mark it with the same attribute the global click handler expects.
    ranges.push(Decoration.mark({
      attributes: { class: 'cm-loommark-image-source', 'data-loommark-href': image.src },
    }).range(image.from, image.to));
    const destination = destinations.find((range) => range.from >= image.from && range.to <= image.to);
    if (destination) {
      ranges.push(Decoration.mark({
        attributes: { class: 'cm-loommark-link' },
      }).range(destination.from, destination.to));
    }
  };
  for (const image of imageRanges(source)) {
    if (image.ownLine) {
      const line = state.doc.lineAt(image.from);
      if (selectionWithin(state, line.from, line.to)) {
        markSource(image);
        continue;
      }
      ranges.push(Decoration.replace({
        widget: new ImageWidget(image, resourceBase, true, blockCardPresentation(source, image.from)),
        block: true,
      }).range(line.from, line.to));
    } else {
      if (selectionWithin(state, image.from, image.to)) {
        markSource(image);
        continue;
      }
      ranges.push(Decoration.replace({
        widget: new ImageWidget(image, resourceBase, false),
      }).range(image.from, image.to));
    }
  }
  return Decoration.set(ranges, true);
});

const listField = selectionAwareField((state) => {
  const ranges: Range<Decoration>[] = [];
  const cursor = state.selection.main.head;
  const source = state.doc.toString();
  const items = listItemRanges(source);
    const orderedLabels = orderedListLabels(source, items, orderedListStyle);
    for (const item of items) {
    if (item.task?.checked && item.task.boxTo < item.lineTo) {
      // Do not lower opacity on the entire line: a line decoration also fades its Card tint,
      // background image, and rails. Mark only the task's visible text after the checkbox.
      ranges.push(Decoration.mark({ class: 'cm-loommark-task-done' })
        .range(item.task.boxTo, item.lineTo));
    }
    const cursorOnLine = cursor >= item.lineFrom && cursor <= item.lineTo;
    if (item.ordered) {
      // Unlike other markers, this label is a derived display value, not the literal source
      // text (that's the whole point of loommark.orderedListStyle) — revealing the raw number
      // when the cursor lands on the line would show a *different* number than what was just
      // displayed (e.g. "I." becoming "3."), which is confusing rather than informative. Always
      // show the rendered label; click it like the other rich widgets to edit the source.
      const label = orderedLabels.get(item.markerFrom);
      if (label) {
        const delimiter = source[item.markerTo - 1];
        ranges.push(Decoration.replace({ widget: new OrderedLabelWidget(label, delimiter, item.markerTo) })
          .range(item.markerFrom, item.markerTo));
      }
    } else if (!cursorOnLine) {
      ranges.push(Decoration.replace({ widget: new BulletWidget(item.level) })
        .range(item.markerFrom, item.markerTo));
    }
    if (item.task && !cursorOnLine) {
      ranges.push(Decoration.replace({ widget: new CheckboxWidget(item.task.checked, item.task.boxFrom) })
        .range(item.task.boxFrom, item.task.boxTo));
    }
  }
  return Decoration.set(ranges, true);
});

const listGuideField = selectionAwareField((state) => {
  const ranges: Range<Decoration>[] = [];
  if (!listGuidesEnabled) return Decoration.set(ranges);
  const cursor = state.selection.main.head;
  const source = state.doc.toString();
  const items = listItemRanges(source);
  const segments = listGuideSegments(source, items);
  if (!segments.length) return Decoration.set(ranges);

  const itemByLineFrom = new Map(items.map((item) => [item.lineFrom, item] as const));
  // A line's rendered rails are exactly the ancestor levels of every segment that covers it;
  // an item's own segment (if any) starts on the line *after* it, so this never includes the
  // item's own level on its own line, only on lines belonging to its descendants/continuation.
  const lineLevels = new Map<number, Set<number>>();
  for (const segment of segments) {
    let position = segment.from;
    while (position <= segment.to) {
      const line = state.doc.lineAt(position);
      let levels = lineLevels.get(line.from);
      if (!levels) {
        levels = new Set();
        lineLevels.set(line.from, levels);
      }
      levels.add(segment.level);
      position = line.to + 1;
    }
  }

  // Highlighted lines are the cursor's own line plus each ancestor *item's own line* (where
  // its bullet/number sits) — not every line a connector visually passes through. A sibling
  // branch under the same shallow ancestor sits inside that ancestor's segment too, but isn't
  // on the cursor's actual path, so it must not light up just because the level matches.
  const cursorLine = state.doc.lineAt(cursor);
  const highlightedLines = new Set<number>([cursorLine.from]);
  for (const segment of segments) {
    if (cursor >= segment.from && cursor <= segment.to) highlightedLines.add(segment.itemLineFrom);
  }
  // A soft line break (Shift+Enter) inside a list item's own content produces another line that
  // is logically still the same paragraph, just visually wrapped onto more lines — so the cursor
  // sitting on any of them should light up that *whole contiguous run* of plain (markerless)
  // continuation lines, not just the exact line the cursor is on. This walks outward from the
  // cursor's line only through lines that share its own deepest level and carry no marker of
  // their own, stopping at the item's own opening line or at a nested child item's line in
  // either direction — a nested sub-item one level deeper still only lights up when the cursor
  // is actually on/under it, not just because it happens to share the same parent segment.
  const ownLevel = Math.max(-1, ...(lineLevels.get(cursorLine.from) ?? []));
  const ownSegment = ownLevel >= 0
    ? segments.find((segment) => segment.level === ownLevel && cursor >= segment.from && cursor <= segment.to)
    : undefined;
  if (ownSegment) {
    for (const direction of [-1, 1] as const) {
      let line = cursorLine;
      for (;;) {
        const nextLineNumber = line.number + direction;
        if (nextLineNumber < 1 || nextLineNumber > state.doc.lines) break;
        const nextLine = state.doc.line(nextLineNumber);
        if (nextLine.from < ownSegment.from || nextLine.from > ownSegment.to) break;
        if (itemByLineFrom.has(nextLine.from)) break;
        if (!lineLevels.get(nextLine.from)?.has(ownLevel)) break;
        highlightedLines.add(nextLine.from);
        line = nextLine;
      }
    }
  }

  for (const [lineFrom, levels] of lineLevels) {
    const line = state.doc.lineAt(lineFrom);
    const item = itemByLineFrom.get(lineFrom);
    const replaceTo = item
      ? item.markerFrom
      : line.from + (line.text.match(/^[ \t]*/)?.[0].length ?? 0);
    if (replaceTo <= line.from) continue;
    // Unlike marker-hiding decorations elsewhere, guides never reveal raw whitespace when the
    // cursor enters the line: there is no source syntax being hidden here to edit, only blank
    // space, so reverting away from the widget would just make the indent jump around and the
    // rails vanish right where the cursor is — the opposite of what a "where am I" guide is for.
    ranges.push(Decoration.replace({
      widget: new ListGuideWidget(Math.max(...levels) + 1, highlightedLines.has(lineFrom)),
    }).range(line.from, replaceTo));
  }
  return Decoration.set(ranges, true);
});

const HEADING_CARD_INSET_STEP = 10;
// Keep Card geometry on whole CSS pixels. Fractional borders land on different device-pixel
// boundaries after zoom/DPR scaling, making independently rendered CodeMirror lines appear
// horizontally offset even when their numeric positions are identical.
const HEADING_CARD_BORDER_WIDTH = 2;
const CODE_BLOCK_BORDER_WIDTH = 1;
// Extra room between the innermost border/rail and real content (text, or a nested code
// block's own border), on top of the geometric per-level inset — the whole point being that
// card content must never sit flush against the card's own edge.
const HEADING_CARD_CONTENT_PADDING = 12;

// Vertical clearance between a nested card's rounded bottom border and the bottom of its
// closing line; deeper levels closing on the same line stack extra clearance so each border
// stays individually visible. The outer level's border sits on the line's own bottom edge.
function cardClosingGap(level: number, outerLevel: number): number {
  return level === outerLevel ? 0 : 8 + (level - outerLevel - 1) * 4;
}

function blockCardPresentation(source: string, position: number): BlockCardPresentation {
  if (cardMode === 'off') return undefined;
  const active = headingSections(source, headingRanges(source))
    .filter((section) => position >= section.from && position <= section.to);
  if (!active.length) return undefined;
  const outer = active.reduce((a, b) => (a.level <= b.level ? a : b));
  const deepest = active.reduce((a, b) => (a.level >= b.level ? a : b));
  const outerInset = (outer.level - 1) * HEADING_CARD_INSET_STEP;
  const contentPadding = (deepest.level - outer.level) * HEADING_CARD_INSET_STEP
    + HEADING_CARD_CONTENT_PADDING;
  const deepestFirst = [...active].sort((a, b) => b.level - a.level);
  const style = [`--loommark-heading-card-color: ${headingBorderColor(outer.level) ?? 'transparent'}`];

  if (cardMode === 'tint') {
    const layers = deepestFirst.flatMap((section) => {
      const tint = headingBackgroundTint(section.level);
      if (!tint) return [];
      const inset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
      return [`linear-gradient(${tint}, ${tint}) ${inset}px 0 / calc(100% - ${inset * 2}px) 100% no-repeat`];
    });
    style.push(
      `margin-left: ${outerInset}px`, `margin-right: ${outerInset}px`,
      `padding-left: ${contentPadding}px`, `padding-right: ${contentPadding}px`,
      layers.length > 0 ? `background: ${layers.join(', ')}` : '',
    );
  } else if (cardMode === 'accent') {
    const shadows = active.flatMap((section) => {
      const color = headingBorderColor(section.level);
      if (!color) return [];
      const inset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
      return [`inset ${inset}px 0 0 0 ${color}`];
    });
    style.push(
      `margin-left: ${outerInset}px`, `padding-left: ${contentPadding}px`,
      shadows.length > 0 ? `box-shadow: ${shadows.join(', ')}` : '',
    );
  } else {
    const tintLayers = deepestFirst.flatMap((section) => {
      const tint = headingBackgroundTint(section.level);
      if (!tint) return [];
      const inset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
      return [`linear-gradient(${tint}, ${tint}) ${inset}px 0 / calc(100% - ${inset * 2}px) 100% no-repeat`];
    });
    const borderLayers = active.filter((section) => section.level !== outer.level).flatMap((section) => {
      const color = headingBorderColor(section.level);
      if (!color) return [];
      const inset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
      return [
        `linear-gradient(${color}, ${color}) ${inset}px 0 / ${HEADING_CARD_BORDER_WIDTH}px 100% no-repeat`,
        `linear-gradient(${color}, ${color}) calc(100% - ${inset}px - ${HEADING_CARD_BORDER_WIDTH}px) 0 / ${HEADING_CARD_BORDER_WIDTH}px 100% no-repeat`,
      ];
    });
    const allLayers = [...borderLayers, ...tintLayers];
    style.push(
      `margin-left: ${outerInset}px`, `margin-right: ${outerInset}px`,
      `padding-left: ${contentPadding}px`, `padding-right: ${contentPadding}px`,
      allLayers.length > 0 ? `background: ${allLayers.join(', ')}` : '',
    );
  }
  return {
    className: `cm-loommark-heading-card cm-loommark-heading-card-${cardMode}`,
    style: style.filter(Boolean).join('; '),
  };
}

// loommark.cardBackgroundColors/cardBorderColors cycle by level, independently, so background
// fill and border/rail color can be customized (or disabled) separately. An empty array means
// "no color" for that layer — the layer is not drawn at all — rather than falling back to any
// default; the shipped setting default is DEFAULT_CARD_COLORS, not [], so out of the box both
// still render normally.
function cardColorAt(colors: string[], level: number): string | null {
  if (colors.length === 0) return null;
  return colors[(level - 1) % colors.length];
}

function headingBorderColor(level: number): string | null {
  const base = cardColorAt(cardBorderColors, level);
  if (base === null) return null;
  const percentage = Math.round(cardBorderStrength * 1000) / 10;
  return `color-mix(in oklab, ${base} ${percentage}%, var(--vscode-editor-foreground))`;
}

// Border/rail lines stay close to full color so they read clearly; background fills use a very
// light tint instead — a background wash strong enough to read as a "color" behind body text
// makes the text itself harder to read, which is the opposite of what this feature is for.
function headingBackgroundTint(level: number): string | null {
  const base = cardColorAt(cardBackgroundColors, level);
  if (base === null) return null;
  const percentage = Math.round(cardBackgroundStrength * 1000) / 10;
  return `color-mix(in srgb, ${base} ${percentage}%, var(--loommark-card-surface-base))`;
}

function cardImageIndex(seed: string, count: number): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % count;
}

class CardImageMarker implements LayerMarker {
  constructor(
    private readonly uri: string,
    private readonly surface: string,
    private readonly left: number,
    private readonly top: number,
    private readonly width: number,
    private readonly height: number,
  ) {}

  eq(other: CardImageMarker): boolean {
    return this.uri === other.uri && this.surface === other.surface && this.left === other.left && this.top === other.top
      && this.width === other.width && this.height === other.height;
  }

  draw(): HTMLElement {
    const marker = document.createElement('div');
    marker.className = 'cm-loommark-card-image';
    marker.style.left = `${this.left}px`;
    marker.style.top = `${this.top}px`;
    marker.style.width = `${this.width}px`;
    marker.style.height = `${this.height}px`;
    marker.style.background = this.surface;
    marker.style.setProperty('--loommark-card-image-opacity', String(cardImage.opacity));
    marker.style.setProperty('--loommark-card-image-blur', `${cardImage.blur}px`);
    marker.style.setProperty('--loommark-card-image-saturation', String(cardImage.saturation));
    marker.style.setProperty('--loommark-card-image-overlay', String(cardImage.overlay));
    const image = document.createElement('span');
    image.className = 'cm-loommark-card-image-media';
    image.style.backgroundImage = `url(${JSON.stringify(this.uri)})`;
    const overlay = document.createElement('span');
    overlay.className = 'cm-loommark-card-image-overlay';
    marker.append(image, overlay);
    return marker;
  }
}

let drawnCardImageRevision = -1;
const cardImageLayer = layer({
  above: false,
  class: 'cm-loommark-card-image-layer',
  update(update) {
    const changed = drawnCardImageRevision !== cardImageRevision;
    drawnCardImageRevision = cardImageRevision;
    return changed || update.docChanged || update.viewportChanged || update.geometryChanged;
  },
  markers(view): readonly LayerMarker[] {
    // tint has no real border or CardBoundaryWidget closing gap to stay clear of, so its markers
    // use a simpler geometry below; accent's rails are too thin a sliver for imagery to read.
    if (!cardImage.enabled || !cardImage.imageUris.length
      || (cardMode !== 'card' && cardMode !== 'tint')) return [];
    const bordered = cardMode === 'card';
    const source = view.state.doc.toString();
    // Outer sections must draw first. A deeper Card is a new visual surface, not a translucent
    // window onto its ancestor, so its marker must sit above the ancestor marker everywhere the
    // two ranges overlap.
    const sections = headingSections(source, headingRanges(source))
      .sort((left, right) => left.level - right.level || left.from - right.from);
    const scrollRect = view.scrollDOM.getBoundingClientRect();
    const baseLeft = scrollRect.left - view.scrollDOM.scrollLeft * view.scaleX;
    const baseTop = scrollRect.top - view.scrollDOM.scrollTop * view.scaleY;
    const contentStyle = getComputedStyle(view.contentDOM);
    const contentLeft = view.contentDOM.getBoundingClientRect().left - baseLeft
      + Number.parseFloat(contentStyle.paddingLeft);
    const contentWidth = view.contentDOM.clientWidth
      - Number.parseFloat(contentStyle.paddingLeft)
      - Number.parseFloat(contentStyle.paddingRight);
    const documentTop = view.documentTop - baseTop;
    // -first/-last card lines carry real CSS margins, which CodeMirror's height map cannot see
    // (it measures border boxes only), so lineBlockAt positions drift by the accumulated
    // margins above them. Whenever a section edge is mounted in the rendered viewport, measure
    // its actual line element instead; the BlockInfo estimate is only a fallback for edges that
    // are offscreen, where the drift cannot be seen.
    const measuredLineRect = (position: number): DOMRect | null => {
      if (position < view.viewport.from || position > view.viewport.to) return null;
      const { node } = view.domAtPos(position);
      let element = node instanceof HTMLElement ? node : node.parentElement;
      while (element && element !== view.contentDOM && !element.classList.contains('cm-line')) {
        element = element.parentElement;
      }
      return element && element !== view.contentDOM ? element.getBoundingClientRect() : null;
    };
    const markers: CardImageMarker[] = [];
    for (const section of sections) {
      if (section.to < view.viewport.from || section.from > view.viewport.to) continue;
      // The shallowest section enclosing this one decides both the horizontal margin shift its
      // lines get and this section's closing-gap clearance — the same "outer" the line
      // decorations compute per line, constant across one section's span.
      const outerSection = sections.reduce(
        (outer, other) => (other.from <= section.from && other.to >= section.to
          && other.level < outer.level ? other : outer),
        section,
      );
      const outerLevel = outerSection.level;
      // A nested section's closing gap is positioned from its line's padding box; when that
      // line is also the outer card's last line, the line additionally carries the outer's real
      // bottom border, sitting between padding box and border box. Only 'card' reserves either
      // a gap or a border in the first place — 'tint' bands run flush to each line's own edges.
      const closeLine = view.state.doc.lineAt(section.to);
      const closeBorder = bordered && section !== outerSection
        && view.state.doc.lineAt(outerSection.to).from === closeLine.from
        ? HEADING_CARD_BORDER_WIDTH : 0;
      // Stay inside every drawn edge: the outer card's real 2px border, plus a nested level's
      // own 2px gradient rail, so the image never shows outside a border line or rounded corner.
      const inset = (outerLevel - 1) * HEADING_CARD_INSET_STEP
        + (section.level - outerLevel) * HEADING_CARD_INSET_STEP
        + (bordered ? HEADING_CARD_BORDER_WIDTH + (section.level === outerLevel ? 0 : HEADING_CARD_BORDER_WIDTH) : 0);
      const openRect = measuredLineRect(section.from);
      const closeRect = measuredLineRect(section.to);
      const top = (openRect
        ? openRect.top - baseTop
        : documentTop + view.lineBlockAt(section.from).top)
        + (bordered ? HEADING_CARD_BORDER_WIDTH : 0);
      const bottom = (closeRect
        ? closeRect.bottom - baseTop
        : documentTop + view.lineBlockAt(section.to).bottom)
        - (bordered ? cardClosingGap(section.level, outerLevel) + HEADING_CARD_BORDER_WIDTH + closeBorder : 0);
      const headingLine = view.state.doc.lineAt(section.from).text;
      const uri = cardImage.imageUris[
        cardImageIndex(`${resourceBase}\0${section.level}\0${headingLine}`, cardImage.imageUris.length)
      ];
      const surfaceAccent = cardColorAt(cardBackgroundColors, section.level);
      markers.push(new CardImageMarker(
        uri,
        surfaceAccent
          ? `color-mix(in srgb, ${surfaceAccent} 8%, var(--vscode-editor-background))`
          : 'var(--vscode-editor-background)',
        contentLeft + inset,
        top,
        Math.max(0, contentWidth - inset * 2),
        Math.max(0, bottom - top),
      ));
    }
    return markers;
  },
});

// One StateField, not a selectionAwareField: which lines are inside which heading's card
// depends only on document structure, never on where the cursor is.
function buildHeadingCardDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  if (cardMode === 'off') return Decoration.set(ranges);
  const source = state.doc.toString();
  const headings = headingRanges(source);
  if (!headings.length) return Decoration.set(ranges);
  const sections = headingSections(source, headings);
  const fencedCodeLineStarts = new Set<number>();
  for (const block of detailedFencedCodeRanges(source)) {
    for (let lineNumber = block.contentStartLine; lineNumber <= block.contentEndLine; lineNumber++) {
      fencedCodeLineStarts.add(state.doc.line(lineNumber).from);
    }
  }

  // A line can be inside several nested sections at once (an H3 body line is also inside its
  // H2 and H1 ancestors' sections). Group by line first so each line is styled exactly once.
  const lineSections = new Map<number, typeof sections>();
  for (const section of sections) {
    let position = section.from;
    while (position <= section.to) {
      const line = state.doc.lineAt(position);
      let list = lineSections.get(line.from);
      if (!list) {
        list = [];
        lineSections.set(line.from, list);
      }
      list.push(section);
      position = line.to + 1;
    }
  }

  for (const [lineFrom, sectionsForLine] of lineSections) {
    const line = state.doc.lineAt(lineFrom);
    // The shallowest heading active on this line gets the real, rounded card border (card mode
    // only); a single DOM element only has one border-radius, so deeper levels nested on the
    // same line fall back to a plain (unrounded) inset line — see docs/EDITOR_TECHNOLOGY.md.
    const outer = sectionsForLine.reduce((a, b) => (a.level <= b.level ? a : b));
    const deepest = sectionsForLine.reduce((a, b) => (a.level >= b.level ? a : b));
    const outerInset = (outer.level - 1) * HEADING_CARD_INSET_STEP;
    const isOuterFirst = line.from === outer.from;
    const isOuterLast = line.to >= outer.to;
    const contentPadding = (deepest.level - outer.level) * HEADING_CARD_INSET_STEP
      + HEADING_CARD_CONTENT_PADDING;
    // Deepest first: CSS paints the first-listed background layer on top, so the narrowest
    // (innermost) band needs to come first to sit visually above the wider ancestor bands.
    const deepestFirst = [...sectionsForLine].sort((a, b) => b.level - a.level);

    const classes = ['cm-loommark-heading-card', `cm-loommark-heading-card-${cardMode}`];
    if (sectionsForLine.some((section) => section.level !== outer.level && line.from === section.from)) {
      classes.push('cm-loommark-heading-card-nested-first');
    }
    if (sectionsForLine.some((section) => section.level !== outer.level && line.to >= section.to)) {
      classes.push('cm-loommark-heading-card-nested-last');
    }
    const styleParts: string[] = [`--loommark-heading-card-color: ${headingBorderColor(outer.level) ?? 'transparent'}`];

    if (cardMode === 'tint') {
      const images: string[] = [];
      const positions: string[] = [];
      const sizes: string[] = [];
      for (const section of deepestFirst) {
        const tint = headingBackgroundTint(section.level);
        if (!tint) continue;
        const relativeInset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
        images.push(`linear-gradient(${tint}, ${tint})`);
        positions.push(`${relativeInset}px 0`);
        sizes.push(`calc(100% - ${relativeInset * 2}px) 100%`);
      }
      if (fencedCodeLineStarts.has(line.from)) {
        // Code lines lay out their own 58px line-number gutter with padding, so content inset
        // must come from margins that move the whole code panel; the backdrop pseudo-element
        // then continues the tint bands across the vacated side strips.
        classes.push('cm-loommark-card-contained-code');
        styleParts.push(
          `margin-left: ${outerInset + contentPadding}px`,
          `margin-right: ${outerInset + contentPadding}px`,
          `--loommark-card-code-gutter-left: ${contentPadding + CODE_BLOCK_BORDER_WIDTH}px`,
          `--loommark-card-code-gutter-right: ${contentPadding + CODE_BLOCK_BORDER_WIDTH}px`,
          images.length > 0 ? `--loommark-card-code-backdrop-image: ${images.join(', ')}` : '',
          images.length > 0 ? `--loommark-card-code-backdrop-position: ${positions.join(', ')}` : '',
          images.length > 0 ? `--loommark-card-code-backdrop-size: ${sizes.join(', ')}` : '',
        );
      } else {
        styleParts.push(
          `margin-left: ${outerInset}px`,
          `margin-right: ${outerInset}px`,
          `padding-left: ${contentPadding}px`,
          `padding-right: ${contentPadding}px`,
          images.length > 0 ? `background-image: ${images.join(', ')}` : '',
          images.length > 0 ? `background-position: ${positions.join(', ')}` : '',
          images.length > 0 ? `background-size: ${sizes.join(', ')}` : '',
          images.length > 0 ? 'background-repeat: no-repeat' : '',
        );
      }
    } else if (cardMode === 'accent') {
      if (fencedCodeLineStarts.has(line.from)) {
        // Same containment as tint, but the backdrop repaints the accent bars: the stacked
        // inset box-shadows resolve to one solid stripe per nested level, deepest rightmost.
        classes.push('cm-loommark-card-contained-code');
        const images: string[] = [];
        const positions: string[] = [];
        const sizes: string[] = [];
        for (const section of sectionsForLine) {
          if (section.level === outer.level) continue;
          const color = headingBorderColor(section.level);
          if (!color) continue;
          images.push(`linear-gradient(${color}, ${color})`);
          positions.push(`${(section.level - outer.level - 1) * HEADING_CARD_INSET_STEP}px 0`);
          sizes.push(`${HEADING_CARD_INSET_STEP}px 100%`);
        }
        styleParts.push(
          `margin-left: ${outerInset + contentPadding}px`,
          `--loommark-card-code-gutter-left: ${contentPadding + CODE_BLOCK_BORDER_WIDTH}px`,
          '--loommark-card-code-gutter-right: 0px',
          images.length > 0 ? `--loommark-card-code-backdrop-image: ${images.join(', ')}` : '',
          images.length > 0 ? `--loommark-card-code-backdrop-position: ${positions.join(', ')}` : '',
          images.length > 0 ? `--loommark-card-code-backdrop-size: ${sizes.join(', ')}` : '',
        );
      } else {
        const shadows: string[] = [];
        for (const section of sectionsForLine) {
          const color = headingBorderColor(section.level);
          if (!color) continue;
          const relativeInset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
          shadows.push(`inset ${relativeInset}px 0 0 0 ${color}`);
        }
        styleParts.push(
          `margin-left: ${outerInset}px`,
          `padding-left: ${contentPadding}px`,
          shadows.length > 0 ? `box-shadow: ${shadows.join(', ')}` : '',
        );
      }
    } else {
      const images: string[] = [];
      const positions: string[] = [];
      const sizes: string[] = [];
      const borderImages: string[] = [];
      const borderPositions: string[] = [];
      const borderSizes: string[] = [];
      let closingBottomGap = 0;
      const boundaryWidgets: Range<Decoration>[] = [];
      for (const section of deepestFirst) {
        const relativeInset = (section.level - outer.level) * HEADING_CARD_INSET_STEP;
        const tint = headingBackgroundTint(section.level);
        // A nested level only gets its own rounded corner-trim/rail treatment when it actually
        // has a border color configured; with none, its tint (if any) is just a plain band, the
        // same as the outer level's own fill.
        const color = section.level !== outer.level ? headingBorderColor(section.level) : null;
        const hasBorder = color !== null;
        const opensHere = line.from === section.from;
        const closesHere = line.to >= section.to;
        const bottomGap = hasBorder && closesHere ? cardClosingGap(section.level, outer.level) : 0;
        const cornerRadius = 6;
        const topTrim = hasBorder && opensHere ? cornerRadius : 0;
        const bottomTrim = hasBorder && closesHere ? bottomGap + cornerRadius : 0;
        // Nested fills occupy the border's inner box rather than extending under an
        // independently antialiased rail. Sharing these inner-edge coordinates prevents a
        // one-device-pixel tint fringe from appearing beyond the right border at some zooms.
        const fillInset = relativeInset + (hasBorder ? HEADING_CARD_BORDER_WIDTH : 0);
        if (tint) {
          images.push(`linear-gradient(${tint}, ${tint})`);
          positions.push(`${fillInset}px ${topTrim}px`);
          sizes.push(
            `calc(100% - ${fillInset * 2}px) calc(100% - ${topTrim + bottomTrim}px)`,
          );
        }
        if (hasBorder) {
          closingBottomGap = Math.max(closingBottomGap, bottomGap);
          borderImages.push(`linear-gradient(${color}, ${color})`, `linear-gradient(${color}, ${color})`);
          borderPositions.push(
            `${relativeInset}px ${opensHere ? cornerRadius : 0}px`,
            `calc(100% - ${relativeInset}px - ${HEADING_CARD_BORDER_WIDTH}px) ${opensHere ? cornerRadius : 0}px`,
          );
          borderSizes.push(
            `${HEADING_CARD_BORDER_WIDTH}px calc(100% - ${opensHere ? cornerRadius : 0}px - ${closesHere ? bottomGap + cornerRadius : 0}px)`,
            `${HEADING_CARD_BORDER_WIDTH}px calc(100% - ${opensHere ? cornerRadius : 0}px - ${closesHere ? bottomGap + cornerRadius : 0}px)`,
          );
          if (opensHere) {
            boundaryWidgets.push(Decoration.widget({
              widget: new CardBoundaryWidget('open', relativeInset, 0, color, tint ?? 'transparent'),
              side: -1,
            }).range(line.from));
          }
          if (closesHere) {
            boundaryWidgets.push(Decoration.widget({
              widget: new CardBoundaryWidget('close', relativeInset, bottomGap, color, tint ?? 'transparent'),
              side: 1,
            }).range(line.to));
          }
        }
      }
      ranges.push(...boundaryWidgets);
      images.unshift(...borderImages);
      positions.unshift(...borderPositions);
      sizes.unshift(...borderSizes);
      if (isOuterFirst) classes.push('cm-loommark-heading-card-first');
      if (isOuterLast) classes.push('cm-loommark-heading-card-last');
      if (closingBottomGap > 0) styleParts.push(`padding-bottom: ${closingBottomGap}px`);
      if (fencedCodeLineStarts.has(line.from)) {
        // CodeMirror renders fenced-code content as normal .cm-line elements, unlike the
        // separate toolbar widget. Move the actual code surface into the card's content box,
        // then let a behind-the-line pseudo-element repaint the card layers across the vacated
        // gutters. This preserves the code block's own background, borders, gutter and radius.
        classes.push('cm-loommark-card-contained-code');
        // The toolbar sits in the shell's content box, which starts at margin + 2px card border
        // + content padding. Code lines have no shell, so their border box must be given that
        // same span directly for the toolbar and the code panel to share both edges exactly.
        const totalInset = outerInset + contentPadding + HEADING_CARD_BORDER_WIDTH;
        styleParts.push(
          `margin-left: ${totalInset}px`,
          `margin-right: ${totalInset}px`,
          // Absolutely positioned children use the code line's padding box as their origin,
          // which is one code-border pixel inside its border box. Reaching back to the normal
          // card rail therefore costs the content padding plus both border widths.
          `--loommark-card-code-gutter-left: ${contentPadding + HEADING_CARD_BORDER_WIDTH + CODE_BLOCK_BORDER_WIDTH}px`,
          `--loommark-card-code-gutter-right: ${contentPadding + HEADING_CARD_BORDER_WIDTH + CODE_BLOCK_BORDER_WIDTH}px`,
          images.length > 0 ? `--loommark-card-code-backdrop-image: ${images.join(', ')}` : '',
          images.length > 0 ? `--loommark-card-code-backdrop-position: ${positions.join(', ')}` : '',
          images.length > 0 ? `--loommark-card-code-backdrop-size: ${sizes.join(', ')}` : '',
        );
      } else {
        styleParts.push(
          `margin-left: ${outerInset}px`,
          `margin-right: ${outerInset}px`,
          `padding-left: ${contentPadding}px`,
          `padding-right: ${contentPadding}px`,
          images.length > 0 ? `background-image: ${images.join(', ')}` : '',
          images.length > 0 ? `background-position: ${positions.join(', ')}` : '',
          images.length > 0 ? `background-size: ${sizes.join(', ')}` : '',
          images.length > 0 ? 'background-repeat: no-repeat' : '',
        );
      }
    }

    ranges.push(Decoration.line({
      attributes: { class: classes.join(' '), style: styleParts.filter(Boolean).join('; ') },
    }).range(line.from));
  }
  return Decoration.set(ranges, true);
}

const headingCardField = StateField.define<DecorationSet>({
  create: buildHeadingCardDecorations,
  update(value, transaction) {
    if (transaction.docChanged || transaction.effects.some((effect) => effect.is(decorationsRefresh))) {
      return buildHeadingCardDecorations(transaction.state);
    }
    return value.map(transaction.changes);
  },
  provide: (field) => EditorView.decorations.from(field),
});

const mathField = selectionAwareField((state) => {
  const ranges: Range<Decoration>[] = [];
  const source = state.doc.toString();
  for (const math of mathRanges(source)) {
    const startLine = state.doc.lineAt(math.from);
    const endLine = state.doc.lineAt(math.to);
    const multiLine = startLine.number !== endLine.number;
    const ownLine = multiLine
      || source.slice(startLine.from, endLine.to).trim() === source.slice(math.from, math.to);
    if (math.display && ownLine) {
      if (selectionWithin(state, startLine.from, endLine.to)) continue;
      ranges.push(Decoration.replace({
        widget: new MathWidget(math, true, blockCardPresentation(source, math.from)),
        block: true,
      }).range(startLine.from, endLine.to));
    } else {
      if (selectionWithin(state, math.from, math.to)) continue;
      ranges.push(Decoration.replace({
        widget: new MathWidget(math, false),
      }).range(math.from, math.to));
    }
  }
  return Decoration.set(ranges, true);
});

const quoteField = selectionAwareField((state) => {
  const ranges: Range<Decoration>[] = [];
  const source = state.doc.toString();
  for (const quote of quoteLineRanges(source)) {
    const line = state.doc.lineAt(quote.lineFrom);
    ranges.push(Decoration.line({
      attributes: { class: `cm-loommark-quote cm-loommark-quote-depth-${Math.min(quote.depth, 3)}` },
    }).range(line.from));
    if (!selectionWithin(state, line.from, line.to)) {
      ranges.push(Decoration.replace({
        widget: new QuoteMarkerWidget(quote.depth),
      }).range(quote.markerFrom, quote.markerTo));
    }
  }
  for (const rule of horizontalRuleRanges(source)) {
    const line = state.doc.lineAt(rule.from);
    if (selectionWithin(state, line.from, line.to)) continue;
    ranges.push(Decoration.replace({ widget: new HorizontalRuleWidget() }).range(rule.from, rule.to));
  }
  return Decoration.set(ranges, true);
});

// Marks rendered images, tables, and math as atomic so keyboard cursor motion skips over them
// instead of stepping in to reveal source. Enabling keyboard editing empties the set, letting the
// cursor enter and edit with the keyboard.
//
// Ranges come directly from the source scanners (tableRanges/imageRanges/mathRanges), not from
// reading tableField/imageField/mathField's current decorations: those fields hide their widget
// (revealing raw source) using an inclusive cursor >= from && cursor <= to check, the same `from`
// CodeMirror treats as a legal, non-atomic landing spot when moving in from outside. Deriving
// atomicity from "is a widget currently rendered there" made the range stop being atomic the
// instant the cursor first touched that boundary — which is exactly the step arrow-key motion is
// supposed to be free to take — so the very next keystroke found nothing atomic left to skip and
// walked straight through, one character at a time, regardless of options.keyboardEditing. Using
// a strict cursor > from && cursor < to check here (matching CodeMirror's own strict "inside an
// atomic range" test) keeps the range atomic right up to and including that boundary, so a
// keyboard approach from outside is correctly bounced to the far edge in one step, while a cursor
// already genuinely inside (via a click, or keyboardEditing entry) still moves around freely.
class AtomicMarker extends RangeValue {}
const atomicMarker = new AtomicMarker();

function buildAtomicRanges(state: EditorState): RangeSet<AtomicMarker> {
  if (keyboardEditing) return RangeSet.empty;
  const cursor = state.selection.main.head;
  const source = state.doc.toString();
  const spans = [...tableRanges(source), ...imageRanges(source), ...mathRanges(source)]
    .filter((span) => !(cursor > span.from && cursor < span.to))
    .sort((a, b) => a.from - b.from);
  return RangeSet.of(spans.map((span) => atomicMarker.range(span.from, span.to)), true);
}

const atomicRangesField = StateField.define<RangeSet<AtomicMarker>>({
  create: buildAtomicRanges,
  update(value, transaction) {
    if (transaction.docChanged || transaction.selection
      || transaction.effects.some((effect) => effect.is(decorationsRefresh))) {
      return buildAtomicRanges(transaction.state);
    }
    return value.map(transaction.changes);
  },
});

const keyboardAtomicRanges = [
  atomicRangesField,
  EditorView.atomicRanges.of((view) => view.state.field(atomicRangesField)),
];

function buildCodeToolbarDecorations(state: EditorState): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const source = state.doc.toString();
  for (const block of detailedFencedCodeRanges(source)) {
    const position = state.doc.line(block.contentStartLine).from;
    ranges.push(Decoration.widget({
      widget: new CodeToolbarWidget(block, blockCardPresentation(source, block.openFrom)),
      block: true,
      side: -1,
    }).range(position));
  }
  return Decoration.set(ranges, true);
}

function buildHeadingDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main.head;
  for (let lineNumber = 1; lineNumber <= view.state.doc.lines; lineNumber++) {
    const line = view.state.doc.line(lineNumber);
    const match = line.text.match(/^( {0,3})(#{1,6})(\s+)/);
    if (!match) continue;
    const level = match[2].length;
    const active = cursor >= line.from && cursor <= line.to;
    ranges.push(Decoration.line({
      attributes: { class: `cm-loommark-heading cm-loommark-h${level}${active ? ' cm-loommark-heading-active' : ''}` },
    }).range(line.from));
    if (!active) {
      const markerEnd = line.from + match[1].length + match[2].length + match[3].length;
      ranges.push(Decoration.replace({}).range(line.from, markerEnd));
    }
  }
  return Decoration.set(ranges, true);
}

function buildInlineDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main.head;
  const source = view.state.doc.toString();
  const excluded = [
    ...codeRanges(source),
    ...linkDestinationRanges(source),
    ...tagRanges(source),
    ...mathRanges(source),
  ];
  // Content group matches a single non-space char alone, or a non-space char followed by
  // anything lazily ending in a non-space char — unlike `(?=\S)(.+?\S)`, this also matches
  // single-character content (`**a**`), which needs at least two characters to satisfy.
  const patterns = [
    /\*\*(\S(?:.*?\S)?)\*\*/g,
    /__(\S(?:.*?\S)?)__/g,
    /~~(\S(?:.*?\S)?)~~/g,
    /(?<!\*)\*(?!\*)(\S(?:.*?\S)?)\*(?!\*)/g,
    /(?<!_)_(?!_)(\S(?:.*?\S)?)_(?!_)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const from = match.index ?? 0;
      const to = from + match[0].length;
      if (containsPosition(excluded, from) || isEscaped(source, from)) continue;
      const markerLength = match[0].startsWith('**') || match[0].startsWith('__')
        || match[0].startsWith('~~') ? 2 : 1;
      // A backslash-escaped closing marker (`**bold\**`) is not a real delimiter either;
      // leave the whole span as plain text instead of treating it as emphasis.
      if (isEscaped(source, to - markerLength)) continue;
      addHiddenSyntax(ranges, cursor, from, from + markerLength);
      addHiddenSyntax(ranges, cursor, to - markerLength, to);
    }
  }
  return Decoration.set(ranges, true);
}

function buildLinkDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main.head;
  const source = view.state.doc.toString();
  const excluded = codeRanges(source);
  const wikiRanges: Array<{ from: number; to: number }> = [];
  const wikiPattern = /\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g;

  for (const match of source.matchAll(wikiPattern)) {
    const from = match.index ?? 0;
    const to = from + match[0].length;
    if (containsPosition(excluded, from) || isEscaped(source, from)) continue;
    wikiRanges.push({ from, to });
    const target = match[1].trim();
    const pipe = match[0].indexOf('|');
    const labelFrom = pipe < 0 ? from + 2 : from + pipe + 1;
    const labelTo = to - 2;
    addHiddenSyntax(ranges, cursor, from, labelFrom);
    addHiddenSyntax(ranges, cursor, labelTo, to);
    ranges.push(Decoration.mark({
      attributes: {
        class: 'cm-loommark-link cm-loommark-wiki-link',
        'data-loommark-href': target,
        'data-loommark-wiki': 'true',
      },
    }).range(labelFrom, labelTo));
  }

  const linkPattern = /\[([^\]\n]+)\]\((?:<([^<>\n]*)>|([^\s)]+))(?:\s+["'][^"'\n]*["'])?\)/g;
  for (const match of source.matchAll(linkPattern)) {
      const from = match.index ?? 0;
      const to = from + match[0].length;
      if (from > 0 && source[from - 1] === '!') continue;
      if (containsPosition(excluded, from) || isEscaped(source, from)) continue;
      if (wikiRanges.some((range) => from < range.to && to > range.from)) continue;
      const labelFrom = from + 1;
      const labelTo = labelFrom + match[1].length;
      addHiddenSyntax(ranges, cursor, from, labelFrom);
      addHiddenSyntax(ranges, cursor, labelTo, to);
      ranges.push(Decoration.mark({
        attributes: { class: 'cm-loommark-link', 'data-loommark-href': match[2] ?? match[3] },
      }).range(labelFrom, labelTo));
  }
  return Decoration.set(ranges, true);
}

function buildTagDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const source = view.state.doc.toString();
  for (const tag of tagRanges(source)) {
    ranges.push(Decoration.mark({
      attributes: { class: 'cm-loommark-tag' },
    }).range(tag.from, tag.to));
  }
  return Decoration.set(ranges, true);
}

function buildEscapedCharDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main.head;
  const source = view.state.doc.toString();
  for (const escape of escapedCharRanges(source)) {
    // Hide only the backslash; the escaped character stays visible as plain text.
    addHiddenSyntax(ranges, cursor, escape.from, escape.from + 1);
  }
  return Decoration.set(ranges, true);
}

function buildInlineCodeDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main.head;
  const source = view.state.doc.toString();
  for (const range of inlineCodeRanges(source, fencedCodeRanges(source))) {
    const markerLength = range.markerLength;
    addHiddenSyntax(ranges, cursor, range.from, range.from + markerLength);
    addHiddenSyntax(ranges, cursor, range.to - markerLength, range.to);
    ranges.push(Decoration.mark({
      attributes: { class: 'cm-loommark-inline-code' },
    }).range(range.from + markerLength, range.to - markerLength));
  }
  return Decoration.set(ranges, true);
}

function buildFencedCodeDecorations(view: EditorView): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const cursor = view.state.selection.main.head;
  for (const block of detailedFencedCodeRanges(view.state.doc.toString())) {
    const fenceActive = view.hasFocus && (
      cursor >= block.openFrom && cursor <= block.openTo
      || block.closeFrom !== undefined && block.closeTo !== undefined
        && cursor >= block.closeFrom && cursor <= block.closeTo
    );
    for (let lineNumber = block.contentStartLine; lineNumber <= block.contentEndLine; lineNumber++) {
      const line = view.state.doc.line(lineNumber);
      ranges.push(Decoration.line({
        attributes: {
          class: `cm-loommark-code-block-line${lineNumber === block.contentStartLine ? ' cm-loommark-code-block-first' : ''}${lineNumber === block.contentEndLine ? ' cm-loommark-code-block-last' : ''}`,
          'data-line-number': String(lineNumber - block.contentStartLine + 1),
        },
      }).range(line.from));
    }
    if (!fenceActive) {
      ranges.push(Decoration.replace({}).range(block.openFrom, block.openTo));
      if (block.closeFrom !== undefined && block.closeTo !== undefined) {
        ranges.push(Decoration.replace({}).range(block.closeFrom, block.closeTo));
      }
    }
  }
  return Decoration.set(ranges, true);
}

function isCursorInFencedCode(view: EditorView): boolean {
  const cursor = view.state.selection.main.head;
  return detailedFencedCodeRanges(view.state.doc.toString()).some((block) => {
    const contentFrom = view.state.doc.line(block.contentStartLine).from;
    const contentTo = view.state.doc.line(block.contentEndLine).to;
    return cursor >= contentFrom && cursor <= contentTo;
  });
}

function addHiddenSyntax(
  ranges: Range<Decoration>[],
  cursor: number,
  from: number,
  to: number,
): void {
  if (from < to && !(cursor >= from && cursor <= to)) {
    ranges.push(Decoration.replace({}).range(from, to));
  }
}

function saveState(): void {
  options.onStateChange?.({
    text: sourceText,
    documentRevision,
    outlineCollapsed,
    cursor: editor?.state.selection.main.head,
  });
}

function scheduleSync(): void {
  window.clearTimeout(timer);
  if (applyingHostUpdate) return;
  timer = window.setTimeout(() => {
    timer = undefined;
    clientRevision++;
    pendingEdits.set(clientRevision, localGeneration);
    options.onSync?.(sourceText, documentRevision, clientRevision);
    status.textContent = 'Syncing...';
  }, syncDelay);
}

// Complete only unambiguous block delimiters typed on an otherwise empty line. This is a local
// insertion at the cursor, not a Markdown serialization pass, so surrounding source remains exact.
// The cursor stays after the opening fence so a language name can still be entered normally.
const completeBlockDelimiters = EditorView.inputHandler.of((view, from, to, text) => {
  if (from !== to || text.length !== 1) return false;
  const line = view.state.doc.lineAt(from);
  if (view.state.doc.sliceString(from, line.to).trim() !== '') return false;
  const before = view.state.doc.sliceString(line.from, from);
  const indent = before.match(/^ {0,3}/)?.[0] ?? '';

  let insertion: string | undefined;
  if (text === '`' && before === `${indent}\`\``) {
    insertion = `\`\n\n${indent}\`\`\``;
  } else if (text === '~' && before === `${indent}~~`) {
    insertion = `~\n\n${indent}~~~`;
  } else if (text === '$' && before === `${indent}$`) {
    insertion = `$\n\n${indent}$$`;
  }
  if (!insertion) return false;

  view.dispatch({
    changes: { from, to, insert: insertion },
    selection: { anchor: from + 1 },
    userEvent: 'input.type',
  });
  return true;
});

// A path segment containing a space, or a closing paren (which would otherwise end the link
// early), needs the same <...> wrapping the README already documents for typed image paths.
function markdownImageLink(relativePath: string): string {
  const target = /[\s)]/.test(relativePath) ? `<${relativePath}>` : relativePath;
  return `![](${target})`;
}

// This package has no file-system access of its own, so it only detects a pasted image, reads it
// into a data URL, and hands the bytes to options.onPasteImage, which resolves once the host has
// actually saved the file somewhere (see resolvePastedImage above) and the resulting Markdown
// link can be inserted. Records what it saw into lastPasteDiagnostic regardless of outcome
// (surfaced by getDiagnosticsReport), since a paste that silently does nothing could mean no
// handler ran at all, clipboardData had no items, or an item was found but wasn't recognized as
// an image — each points to a different cause and isn't otherwise visible. A host with no
// onPasteImage configured simply can't save the file; the paste is still claimed (preventDefault)
// so the browser doesn't fall back to pasting a data: URL or raw bytes into the document.
async function resolvePastedImage(view: EditorView, requestId: number, base64: string, mimeType: string): Promise<void> {
  const result = await options.onPasteImage?.(base64, mimeType) ?? { error: 'No image paste handler configured' };
  lastImagePasteResult = { ...result, requestId, receivedAt: new Date().toISOString() };
  if (result.relativePath) {
    const markdown = markdownImageLink(result.relativePath);
    const pos = view.state.selection.main.head;
    view.dispatch({
      changes: { from: pos, insert: markdown },
      selection: { anchor: pos + markdown.length },
      scrollIntoView: true,
    });
    view.focus();
  } else if (result.error) {
    console.error('LoomMark could not paste image:', result.error);
    status.textContent = 'Image paste failed';
    window.setTimeout(() => { if (status.textContent === 'Image paste failed') status.textContent = ''; }, 3000);
  }
}

const imagePasteHandler = EditorView.domEventHandlers({
  paste(event, view) {
    const items = event.clipboardData ? Array.from(event.clipboardData.items) : undefined;
    lastPasteDiagnostic = {
      firedAt: new Date().toISOString(),
      hasClipboardData: !!event.clipboardData,
      itemCount: items?.length ?? 0,
      itemKinds: items?.map((item) => ({ kind: item.kind, type: item.type })) ?? [],
    };
    if (!items) return false;
    const imageItem = items.find((item) => item.kind === 'file' && item.type.startsWith('image/'));
    const file = imageItem?.getAsFile();
    if (!file) return false;
    event.preventDefault();
    const requestId = nextPasteRequestId++;
    lastPasteDiagnostic = { ...lastPasteDiagnostic, requestId, fileType: file.type, fileSize: file.size };
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== 'string') {
        lastPasteDiagnostic = { ...lastPasteDiagnostic, requestId, readerResultType: typeof result };
        return;
      }
      const base64 = result.slice(result.indexOf(',') + 1);
      lastPasteDiagnostic = { ...lastPasteDiagnostic, requestId, sentDataLength: base64.length };
      void resolvePastedImage(view, requestId, base64, file.type);
    };
    reader.onerror = () => {
      lastPasteDiagnostic = { ...lastPasteDiagnostic, requestId, readerError: String(reader.error) };
    };
    reader.readAsDataURL(file);
    return true;
  },
});

function enterCompletedBlock(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  if (selection.head !== line.to) return false;
  const code = line.text.match(/^( {0,3})(```|~~~)[^\n]*$/);
  const math = line.text.match(/^( {0,3})(\$\$)\s*$/);
  const match = code ?? math;
  if (!match) return false;
  const expectedClose = `${match[1]}${match[2]}`;
  const after = view.state.doc.sliceString(selection.head, selection.head + expectedClose.length + 2);
  if (after !== `\n\n${expectedClose}`) return false;
  view.dispatch({ selection: { anchor: selection.head + 1 }, scrollIntoView: true });
  return true;
}

// Shift+Enter's default (insertNewlineAndIndent, from @codemirror/commands) copies the current
// line's exact leading whitespace onto the new line. That is correct once already inside a list
// item's own continuation content (already offset from the marker), but wrong when pressed on the
// item's own marker line itself: the new line needs LIST_INDENT_WIDTH *more* indent than the
// marker line to actually be recognized as that item's continuation, matching the same fixed
// per-level width used everywhere else in this file (indentUnit, Tab/Shift-Tab, list rendering).
// Otherwise it reads as a dedent/sibling and drops out of the item's scope entirely -- both for
// Lezer's own parser and for listGuideSegments (markdown-ranges.ts), which is what made a
// line created this way fail to inherit its parent item's guide rails and highlighting.
function continueListInsideItem(view: EditorView): boolean {
  const selection = view.state.selection.main;
  if (!selection.empty) return false;
  const line = view.state.doc.lineAt(selection.head);
  if (selection.head !== line.to) return false;
  const ownItem = listItemRanges(view.state.doc.toString()).find((item) => item.lineFrom === line.from);
  if (!ownItem) return false;
  const indent = ' '.repeat((ownItem.markerFrom - ownItem.lineFrom) + LIST_INDENT_WIDTH);
  view.dispatch({
    changes: { from: selection.head, insert: `\n${indent}` },
    selection: { anchor: selection.head + 1 + indent.length },
    scrollIntoView: true,
    userEvent: 'input.type',
  });
  return true;
}

// Vertical arrow-key movement (moveVertically, which cursorLineUp/Down are built on) finds its
// target by hit-testing a pixel coordinate against the rendered DOM. A table/image/math block
// widget has no per-character rendering inside it to hit-test against, so that coordinate lookup
// always resolves to just outside the widget — silently skipping over the whole block regardless
// of options.keyboardEditing or buildAtomicRanges, unlike horizontal motion (which walks logical
// document offsets, not pixel coordinates, so it can land inside one just fine). This explicitly
// redirects into the adjacent block instead, landing at its near edge (which selectionWithin then
// correctly recognizes as inside, revealing it), whenever keyboardEditing allows entering at all.
function verticalMoveIntoBlockWidget(forward: boolean) {
  return (view: EditorView): boolean => {
    if (!keyboardEditing) return false;
    const selection = view.state.selection.main;
    if (!selection.empty) return false;
    const source = view.state.doc.toString();
    const currentLine = view.state.doc.lineAt(selection.head);
    // A rich-mode table never reveals as plain source the way image/math widgets do (see
    // enterTableFromKeyboard in widgets.ts), so entering one has to start cell editing directly
    // rather than just moving the selection into its range, which the widget would ignore.
    for (const table of tableRanges(source)) {
      const startLine = view.state.doc.lineAt(table.from);
      const endLine = view.state.doc.lineAt(table.to);
      const adjacent = forward ? startLine.number === currentLine.number + 1 : endLine.number === currentLine.number - 1;
      if (!adjacent) continue;
      if (tableMode === 'rich' && enterTableFromKeyboard(view, table.from, forward ? 'start' : 'end')) return true;
      view.dispatch({ selection: { anchor: forward ? table.from : table.to }, scrollIntoView: true });
      return true;
    }
    const blockRanges = [
      ...imageRanges(source).filter((image) => image.ownLine),
      ...mathRanges(source).filter((math) => math.display),
    ];
    for (const range of blockRanges) {
      const startLine = view.state.doc.lineAt(range.from);
      const endLine = view.state.doc.lineAt(range.to);
      if (forward && startLine.number === currentLine.number + 1) {
        view.dispatch({ selection: { anchor: range.from }, scrollIntoView: true });
        return true;
      }
      if (!forward && endLine.number === currentLine.number - 1) {
        view.dispatch({ selection: { anchor: range.to }, scrollIntoView: true });
        return true;
      }
    }
    return false;
  };
}

function createEditor(text: string): void {
  editor?.destroy();
  root.replaceChildren();
  editorInitializationError = undefined;
  try {
    editor = new EditorView({
      parent: root,
      state: EditorState.create({
      doc: text,
      extensions: [
        history(),
        markdown({ extensions: [GFM], codeLanguages: languages }),
        autocompletion({ override: [fileLinkCompletions] }),
        search({ top: true }),
        completeBlockDelimiters,
        imagePasteHandler,
        // Matches LIST_INDENT_WIDTH: CommonMark requires a nested ordered item's content to
        // reach its parent's content column (3-4+ characters), which 2 spaces never satisfies.
        indentUnit.of(' '.repeat(LIST_INDENT_WIDTH)),
        keymap.of([
          { key: 'Enter', run: enterCompletedBlock },
          { key: 'Shift-Enter', run: continueListInsideItem },
          { key: 'ArrowDown', run: verticalMoveIntoBlockWidget(true) },
          { key: 'ArrowUp', run: verticalMoveIntoBlockWidget(false) },
          indentWithTab,
          ...searchKeymap,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.lineWrapping,
        cardImageLayer,
        headingDecorations,
        headingCardField,
        inlineDecorations,
        inlineCodeDecorations,
        fencedCodeDecorations,
        codeToolbarField,
        tableField,
        imageField,
        listField,
        listGuideField,
        quoteField,
        mathField,
        keyboardAtomicRanges,
        codeCursorAttributes,
        linkDecorations,
        tagDecorations,
        escapedCharDecorations,
        syntaxHighlighting(markdownHighlightStyle),
        EditorView.updateListener.of((update) => {
          if (update.selectionSet) {
            recentSelectionChanges.push({ at: new Date().toISOString(), head: update.state.selection.main.head });
            if (recentSelectionChanges.length > 20) recentSelectionChanges.shift();
          }
          if (applyingHostUpdate) return;
          if (update.docChanged) {
            sourceText = update.state.doc.toString();
            localGeneration++;
            scheduleSync();
            refreshOutline();
          }
          if (update.docChanged || update.selectionSet) saveState();
        }),
        options.extensions ?? [],
      ],
      }),
    });
    if (!initialCursorRestored && options.initialCursor !== undefined) {
      editor.dispatch({
        selection: { anchor: Math.min(options.initialCursor, text.length) },
        scrollIntoView: true,
      });
    }
    initialCursorRestored = true;
  } catch (error: unknown) {
    editor = undefined;
    editorInitializationError = error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
      : String(error);
    root.replaceChildren();
    const failure = document.createElement('pre');
    failure.className = 'loommark-editor-error';
    failure.textContent = `LoomMark editor failed to initialize.\n\n${editorInitializationError}`;
    root.append(failure);
  }
  refreshOutline();
}

root.addEventListener('mousedown', (event) => {
  const link = (event.target as HTMLElement).closest<HTMLElement>('[data-loommark-href]');
  lastPointerDiagnostic = {
    type: event.type,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    button: event.button,
    target: (event.target as HTMLElement).outerHTML?.slice(0, 500),
    matchedLink: link?.outerHTML.slice(0, 500),
  };
  if (!event.ctrlKey && !event.metaKey) return;
  if (!link) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const href = link.dataset.loommarkHref ?? '';
  const wiki = link.dataset.loommarkWiki === 'true';
  lastLinkRequest = { href, wiki };
  void options.onOpenLink?.(href, wiki).then((result) => {
    lastHostLinkResult = { ...result, href, wiki, receivedAt: new Date().toISOString() };
  });
}, true);

root.addEventListener('mousemove', (event) => {
  const target = event.target as HTMLElement;
  const visual = target.closest<HTMLElement>(
    '.cm-loommark-card-image, .cm-loommark-math, .cm-loommark-heading-card, .cm-loommark-block-card-shell',
  );
  if (!visual) return;
  const rect = visual.getBoundingClientRect();
  const style = getComputedStyle(visual);
  lastVisualHoverDiagnostic = {
    target: target.outerHTML?.slice(0, 400),
    visual: visual.outerHTML.slice(0, 600),
    className: visual.className,
    rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
    background: style.background,
    backgroundImage: style.backgroundImage,
    opacity: style.opacity,
    zIndex: style.zIndex,
  };
});

function wikiFileDetail(target: string): string {
  // Extensionless targets follow the Obsidian-style Markdown convention used by
  // findWikiFiles; everything else keeps its extension, which becomes the detail label.
  const extension = /\.([^./]+)$/.exec(target)?.[1];
  return extension ? `${extension} file` : 'Markdown file';
}

function fileLinkCompletions(context: CompletionContext): CompletionResult | null {
  const wikiMatch = context.matchBefore(/\[\[[^\]\n|]*/);
  const markdownMatch = context.matchBefore(/\[[^\]\n]*\]\([^\s)\n]*/);
  const match = wikiMatch ?? markdownMatch;
  if (!match) return null;
  const wiki = Boolean(wikiMatch);
  const targetStart = wiki ? match.from + 2 : match.from + match.text.lastIndexOf('(') + 1;
  return {
    from: targetStart,
    options: wikiFiles.map((target) => ({
      label: target,
      detail: wikiFileDetail(target),
      type: 'file',
      apply(view, _completion, from, to) {
        const closing = wiki ? ']]' : ')';
        const suffix = view.state.doc.sliceString(to, to + closing.length) === closing ? '' : closing;
        view.dispatch({
          changes: { from, to, insert: target + suffix },
          selection: { anchor: from + target.length },
        });
      },
    })),
    validFor: wiki ? /^[^\]\n|]*$/ : /^[^\s)\n]*$/,
  };
}

function applyHostText(text: string): void {
  if (!editor) {
    sourceText = text;
    createEditor(text);
    return;
  }
  const current = editor.state.doc.toString();
  if (text === current) return;
  // A full-document replace (from 0 to the old length) makes CodeMirror's own change-based
  // selection mapping meaningless — as far as the ChangeSet is concerned everything was deleted
  // and reinserted from scratch, so a cursor anywhere in the document loses its logical position
  // and the old code fell back to clamping its raw numeric offset against the new length instead.
  // That silently breaks whenever an external edit changes the document's length anywhere before
  // the cursor — trimming trailing whitespace on an earlier line during autosave, for example —
  // since every character removed/added earlier shifts what that same numeric offset now points
  // at, up to landing the cursor lines away from where it actually was. singleSplice (the same
  // minimal-diff helper the extension host already uses for the opposite direction) turns this
  // into one small, targeted change instead, so CodeMirror maps the existing selection through it
  // like any other edit and the cursor only moves if the edit actually touches its position.
  const splice = singleSplice(current, text);
  if (!splice) return;
  applyingHostUpdate = true;
  editor.dispatch({
    changes: { from: splice.from, to: splice.to, insert: splice.insert },
  });
  sourceText = text;
  applyingHostUpdate = false;
  refreshOutline();
}

function revealHeadingOffset(offset: number): void {
  if (!editor) return;
  // Plain `scrollIntoView: true` only scrolls the minimal distance needed, so the heading lands
  // wherever the *edge it approached from* happens to stop — hugging the bottom when scrolling
  // down to it, the top when scrolling up — which reads as random depending on where the cursor
  // already was. An explicit `y: 'start'` effect always aligns the heading to the top instead.
  editor.dispatch({
    selection: { anchor: offset },
    effects: EditorView.scrollIntoView(offset, { y: 'start' }),
  });
  editor.focus();
}

function refreshOutline(): void {
  const headings = markdownHeadings(sourceText);
  outlineList.replaceChildren();
  headings.forEach((heading) => {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'outline-item';
    button.style.setProperty('--outline-level', String(heading.level - 1));
    button.textContent = heading.label;
    button.addEventListener('click', () => revealHeadingOffset(heading.offset));
    item.append(button);
    outlineList.append(item);
  });
  outlineEmpty.hidden = headings.length > 0;
}

function setOutlineCollapsed(collapsed: boolean): void {
  outlineCollapsed = collapsed;
  container.classList.toggle('outline-collapsed', collapsed);
  outline.setAttribute('aria-hidden', String(collapsed));
  outlineToggle.ariaExpanded = String(!collapsed);
  outlineFab.ariaExpanded = String(!collapsed);
  saveState();
}

function applyConfiguration(config: EditorConfiguration): void {
  syncDelay = config.syncDelay;
  container.dataset.loommarkTheme = config.theme;
  const background = config.background;
  backgroundDiagnostic = background;
  const hasBackground = background.enabled && Boolean(background.imageUri);
  container.classList.toggle('loommark-has-background', hasBackground);
  container.style.setProperty(
    '--loommark-background-image',
    hasBackground ? `url(${JSON.stringify(background.imageUri)})` : 'none',
  );
  container.style.setProperty('--loommark-background-opacity', String(background.opacity));
  container.style.setProperty('--loommark-background-blur', `${background.blur}px`);
  container.style.setProperty('--loommark-background-saturation', String(background.saturation));
  container.style.setProperty('--loommark-background-overlay', String(background.overlay));
  const nextCardImage = config.cardImage;
  container.classList.toggle(
    'loommark-has-card-images',
    nextCardImage.enabled && nextCardImage.status === 'loaded' && nextCardImage.imageUris.length > 0,
  );
  container.classList.toggle(
    'editor-outline-disabled',
    config.outline === 'explorer' || config.outline === 'off',
  );
  container.classList.toggle('loommark-table-ruled', config.tableStyle === 'ruled');
  const needsRefresh = tableMode !== config.table
    || tableStyle !== config.tableStyle
    || orderedListStyle !== config.orderedListStyle
    || keyboardEditing !== config.keyboardEditing
    || listGuidesEnabled !== config.listGuides
    || cardMode !== config.cardMode
    || cardBackgroundStrength !== config.cardBackgroundStrength
    || cardBorderStrength !== config.cardBorderStrength
    || JSON.stringify(cardImage) !== JSON.stringify(nextCardImage)
    || cardBackgroundColors.join(' ') !== config.cardBackgroundColors.join(' ')
    || cardBorderColors.join(' ') !== config.cardBorderColors.join(' ');
  tableMode = config.table;
  tableStyle = config.tableStyle;
  orderedListStyle = config.orderedListStyle;
  keyboardEditing = config.keyboardEditing;
  listGuidesEnabled = config.listGuides;
  cardMode = config.cardMode;
  cardBackgroundColors = config.cardBackgroundColors;
  cardBorderColors = config.cardBorderColors;
  cardBackgroundStrength = config.cardBackgroundStrength;
  cardBorderStrength = config.cardBorderStrength;
  cardImage = nextCardImage;
  if (needsRefresh) cardImageRevision++;
  if (needsRefresh) editor?.dispatch({ effects: decorationsRefresh.of(null) });
}

outlineToggle.addEventListener('click', () => {
  setOutlineCollapsed(true);
  outlineFab.focus();
});
outlineFab.addEventListener('click', () => {
  setOutlineCollapsed(false);
  outlineToggle.focus();
});
const outlineEscapeHandler = (event: KeyboardEvent): void => {
  if (event.key === 'Escape' && !outlineCollapsed) setOutlineCollapsed(true);
};
container.addEventListener('keydown', outlineEscapeHandler);
setOutlineCollapsed(outlineCollapsed);

function updateConfiguration(config: EditorConfiguration): void {
  applyConfiguration(config);
}

function setText(text: string, revision?: number): void {
  if (timer !== undefined || pendingEdits.size > 0) return;
  window.clearTimeout(timer);
  timer = undefined;
  documentRevision = revision ?? documentRevision + 1;
  applyHostText(text);
  status.textContent = '';
  saveState();
}

function acknowledgeSync(clientRevision: number, revision: number, text: string): void {
  documentRevision = revision;
  const sentGeneration = pendingEdits.get(clientRevision);
  pendingEdits.delete(clientRevision);
  if (sentGeneration === localGeneration && text !== sourceText) {
    applyHostText(text);
  }
  status.textContent = '';
  saveState();
}

function revealHeadingByOrdinal(ordinal: number): void {
  const heading = markdownHeadings(sourceText)[ordinal];
  if (heading) revealHeadingOffset(heading.offset);
}

function setWikiFiles(next: string[]): void {
  wikiFiles = next;
}

// Every table/image/math span in the document plus whether the current selection is "within"
// each one (the same selectionWithin check the fields themselves use) and whether a rendered
// widget for it is actually still in the DOM. If keyboardEditing is on, atomicRanges is empty,
// and this shows a range the cursor is inside yet hasRenderedWidget is still true, the cursor
// genuinely reached that position but the field never revealed it -- a rendering bug, not an
// atomic-range one. If instead no range ever reports being "inside" no matter where the cursor is
// moved to, the keypress isn't moving the model's cursor at all in this environment, which points
// at CodeMirror's key handling instead. Scoped to `container` throughout (not `document`) so a
// report only reflects this instance, not others that may share the page.
function getDiagnosticsReport(): Record<string, unknown> {
  const lines = Array.from(container.querySelectorAll<HTMLElement>('.cm-line')).map((line) => ({
    text: line.textContent,
    html: line.innerHTML,
  }));
  const atomicRanges: Array<{ from: number; to: number }> = [];
  if (editor) {
    for (let iter = editor.state.field(atomicRangesField).iter(); iter.value; iter.next()) {
      atomicRanges.push({ from: iter.from, to: iter.to });
    }
  }
  const activeEditor = editor;
  const revealCandidates = activeEditor ? [
    ...tableRanges(sourceText).map((r) => ({ kind: 'table', from: r.from, to: r.to })),
    ...imageRanges(sourceText).map((r) => ({ kind: 'image', from: r.from, to: r.to })),
    ...mathRanges(sourceText).map((r) => ({ kind: 'math', from: r.from, to: r.to })),
  ].map((range) => ({
    ...range,
    selectionWithinRange: selectionWithin(activeEditor.state, range.from, range.to),
  })) : [];
  return {
    documentRevision,
    localGeneration,
    pendingEdits: pendingEdits.size,
    keyboardEditing,
    selectionHead: editor?.state.selection.main.head,
    atomicRangeCount: atomicRanges.length,
    atomicRanges: atomicRanges.slice(0, 30),
    revealCandidates: revealCandidates.slice(0, 30),
    renderedWidgetCounts: {
      table: container.querySelectorAll('.cm-loommark-table').length,
      image: container.querySelectorAll('.cm-loommark-image').length,
      math: container.querySelectorAll('.cm-loommark-math').length,
    },
    recentKeydowns,
    recentSelectionChanges,
    clipboardApiAvailable: typeof navigator !== 'undefined' && !!navigator.clipboard,
    lastPasteDiagnostic,
    lastImagePasteResult,
    background: backgroundDiagnostic,
    backgroundContainerClass: container.className,
    backgroundImageStyle: container.style.getPropertyValue('--loommark-background-image'),
    cardImage: {
      ...cardImage,
      imageUris: cardImage.imageUris.slice(0, 10),
      renderedCards: container.querySelectorAll('.cm-loommark-card-image').length,
    },
    wikiFileCount: wikiFiles.length,
    wikiFiles: wikiFiles.slice(0, 50),
    completionStatus: editor ? completionStatus(editor.state) : null,
    fencedCodeRanges: detailedFencedCodeRanges(sourceText),
    editorClasses: editor?.dom.className,
    codeLines: Array.from(container.querySelectorAll<HTMLElement>('.cm-loommark-code-block-line'))
      .map((line) => ({
        text: line.textContent,
        className: line.className,
        background: getComputedStyle(line).backgroundColor,
        color: getComputedStyle(line).color,
      })),
    codeGeometry: Array.from(container.querySelectorAll<HTMLElement>('.cm-loommark-code-toolbar'))
      .map((toolbar) => {
        const code = toolbar.parentElement?.nextElementSibling?.classList.contains('cm-line')
          ? toolbar.parentElement.nextElementSibling as HTMLElement
          : undefined;
        const toolbarRect = toolbar.getBoundingClientRect();
        const codeRect = code?.getBoundingClientRect();
        return {
          toolbar: { left: toolbarRect.left, right: toolbarRect.right, width: toolbarRect.width },
          code: codeRect && { left: codeRect.left, right: codeRect.right, width: codeRect.width },
        };
      }),
    visualLayers: Array.from(container.querySelectorAll<HTMLElement>(
      '.cm-loommark-card-image, .cm-loommark-math.is-block, .cm-loommark-heading-card',
    )).map((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        className: element.className,
        rect: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
        background: style.background,
        backgroundImage: style.backgroundImage,
        opacity: style.opacity,
        zIndex: style.zIndex,
      };
    }),
    cursorStyles: Array.from(container.querySelectorAll<HTMLElement>('.cm-cursor')).map((cursor) => ({
      className: cursor.className,
      borderLeftColor: getComputedStyle(cursor).borderLeftColor,
      borderLeftWidth: getComputedStyle(cursor).borderLeftWidth,
    })),
    activeElement: document.activeElement?.className || document.activeElement?.tagName,
    sourceMatches: {
      wiki: Array.from(sourceText.matchAll(/\[\[([^\]\n|]+)(?:\|([^\]\n]+))?\]\]/g))
        .map((match) => match[0]),
      markdown: Array.from(sourceText.matchAll(/\[([^\]\n]+)\]\(([^\s)]+)(?:\s+["'][^"'\n]*["'])?\)/g))
        .map((match) => match[0]),
    },
    linkElements: Array.from(container.querySelectorAll<HTMLElement>('[data-loommark-href]'))
      .map((element) => ({
        text: element.textContent,
        href: element.dataset.loommarkHref,
        wiki: element.dataset.loommarkWiki,
        html: element.outerHTML,
      })),
    lastPointerDiagnostic,
    lastVisualHoverDiagnostic,
    lastLinkRequest,
    lastHostLinkResult,
    editorLoaded: Boolean(editor),
    editorInitializationError,
    editorText: editor?.state.doc.toString(),
    classes: Array.from(container.querySelectorAll<HTMLElement>('[class*="loommark"]'))
      .map((element) => element.className),
    lines,
  };
}

// When a host window (or tab) regains focus, focus typically lands on the host's own container
// element rather than any particular element inside it — a browser never draws a caret in a
// non-focused editable region, so the cursor simply doesn't render until something is clicked.
// Restore it automatically, but only when nothing else (an outline button, a table cell) has
// already legitimately reclaimed focus. Both events are registered since it is not guaranteed
// which one a given host actually dispatches on tab/window reactivation.
function restoreEditorFocusIfIdle(): void {
  const active = document.activeElement;
  if (editor && (!active || active === document.body)) editor.focus();
}
window.addEventListener('focus', restoreEditorFocusIfIdle);
const visibilityChangeHandler = (): void => {
  if (document.visibilityState === 'visible') restoreEditorFocusIfIdle();
};
document.addEventListener('visibilitychange', visibilityChangeHandler);

// Capture phase, so this always sees the raw event before CodeMirror's own keymap (or anything
// else) can act on or stop it -- including a stopPropagation() call that would keep a bubble-phase
// listener from ever seeing the event at all. defaultPrevented is read back via setTimeout rather
// than immediately (capture runs *before* the target/bubble-phase handlers, including CodeMirror's
// own keymap, that would actually call it) or via queueMicrotask (CodeMirror's own state updates
// were not reliably visible by the next microtask in testing); a macrotask reliably runs after the
// full synchronous dispatch and any microtasks it queued. Scoped to `container` (not `document`),
// same reasoning as getDiagnosticsReport, so a report only reflects keys pressed in this instance.
const diagnosticsKeydownHandler = (event: KeyboardEvent): void => {
  const entry = {
    at: new Date().toISOString(),
    key: event.key,
    shift: event.shiftKey,
    ctrl: event.ctrlKey,
    alt: event.altKey,
    meta: event.metaKey,
    defaultPrevented: false,
  };
  recentKeydowns.push(entry);
  if (recentKeydowns.length > 20) recentKeydowns.shift();
  window.setTimeout(() => { entry.defaultPrevented = event.defaultPrevented; }, 0);
};
container.addEventListener('keydown', diagnosticsKeydownHandler, true);

applyConfiguration(options);
createEditor(options.text);
status.textContent = '';
saveState();

return {
  getText: () => sourceText,
  setText,
  acknowledgeSync,
  updateConfiguration,
  setWikiFiles,
  revealHeadingByOrdinal,
  setOutlineCollapsed,
  getDiagnosticsReport,
  focus: () => editor?.focus(),
  destroy() {
    window.clearTimeout(timer);
    editor?.destroy();
    window.removeEventListener('focus', restoreEditorFocusIfIdle);
    document.removeEventListener('visibilitychange', visibilityChangeHandler);
    container.removeEventListener('keydown', diagnosticsKeydownHandler, true);
    container.removeEventListener('keydown', outlineEscapeHandler);
  },
};
}
