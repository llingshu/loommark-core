# @llingshu/loommark-core

Portable CodeMirror 6 Markdown editing kernel, extracted from [LoomMark](https://github.com/llingshu/vscode-loommark) (a VS Code custom Markdown editor) so it can be reused across other hosts — a web page, a personal note-taking app, a wiki — without maintaining the same editing logic twice.

## Status

`createLoomMarkEditor(container, options)` assembles a ready-to-use CodeMirror instance: pass it
a container element and it builds the editor DOM (including the outline drawer) inside it, wires
up sync/paste-image/link-opening callbacks, and returns a handle (`getText`, `setText`,
`acknowledgeSync`, `updateConfiguration`, `setWikiFiles`, `revealHeadingByOrdinal`,
`setOutlineCollapsed`, `getDiagnosticsReport`, `focus`, `destroy`). Multiple independent instances
can coexist on one page — verified directly: editing one instance, destroying it, or changing its
configuration/theme/outline state never affects a sibling instance, and `onSync` only fires for
the instance actually edited.

Visual styling has moved over too: `style.css` now includes the full table/list/heading-card/code
styling, scoped to `.loommark-workspace` (the class `createLoomMarkEditor` adds to its container)
instead of the VS Code webview's `<body>`. The genuinely VS Code-specific pieces — a page-level
`html`/`body` reset, and overrides keyed on `vscode-light`/`vscode-dark` classes VS Code itself
injects to signal its active color theme — stay in the VS Code extension's own small stylesheet
layered on top, since this package has no way to know what mechanism a given host uses to signal
"the surrounding theme is dark." Verified end to end against the real VS Code extension consuming
this package, including that override chain (a dark VS Code theme correctly flips code blocks to
their inverted "paper card" styling).

## Install

This is published to GitHub Packages, not the public npm registry. A consumer needs an `.npmrc` pointing `@llingshu` scoped packages at it:

```
@llingshu:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

`GITHUB_TOKEN` needs `read:packages` scope. Then:

```
npm install @llingshu/loommark-core
```

### Usage

```js
import { createLoomMarkEditor } from '@llingshu/loommark-core';
import '@llingshu/loommark-core/style.css';

const editor = createLoomMarkEditor(document.getElementById('editor-container'), {
  text: '# Hello\n\nStart typing...',
  syncDelay: 180,
  theme: 'vscode',
  outline: 'both',
  table: 'rich',
  tableStyle: 'grid',
  orderedListStyle: 'cycle',
  keyboardEditing: false,
  listGuides: true,
  cardMode: 'card',
  cardBackgroundColors: [],
  cardBorderColors: [],
  cardBackgroundStrength: 0.06,
  cardBorderStrength: 0.52,
  background: { enabled: false, opacity: 0.72, blur: 14, saturation: 0.7, overlay: 0.42, status: 'disabled' },
  cardImage: { enabled: false, imageUris: [], opacity: 0.72, blur: 4, saturation: 0.75, overlay: 0.18, status: 'disabled' },
  onSync(text, baseRevision, clientRevision) {
    // Persist `text` however this host does (a save API, a database write, ...), then:
    editor.acknowledgeSync(clientRevision, baseRevision + 1, text);
  },
});

// Later, when an external change arrives (a reload, a change made elsewhere):
editor.setText(externalText, externalRevision);

// When done with it:
editor.destroy();
```

`extensions` in the options object accepts extra CodeMirror `Extension[]`s appended after this
package's own — the seam a host uses to add its own `StateField`/keymap/`Decoration` (e.g. an
annotation-capture feature) without forking.

### Peer dependencies

CodeMirror and Lezer packages (`@codemirror/*`, `@lezer/*`) are **peer dependencies**, not regular dependencies — install them yourself, matching the version ranges in `package.json`. This is deliberate: CodeMirror's `StateField`/`StateEffect`/`Facet` definitions rely on reference identity, so two copies of `@codemirror/state` coexisting in a dependency tree (one bundled into this package, one already in your own) silently makes this package's extensions invisible to your `EditorView`. Declaring them as peers keeps exactly one copy in the whole tree — yours.

`katex` and `mdast-util-from-markdown` are regular dependencies; they don't have this problem.

### Stylesheet

```js
import '@llingshu/loommark-core/style.css';
```

Includes KaTeX's own stylesheet (needed by the math widget) plus this package's visual styling for
tables, lists, heading cards, and everything else — one import covers all of it.

### A second, CodeMirror-free entry point

```js
import { markdownHeadings, singleSplice } from '@llingshu/loommark-core/pure';
```

`@llingshu/loommark-core/pure` re-exports `types.ts`/`markdown-ranges.ts`/`headings.ts`/`text.ts`/
`paste-image.ts` — everything with zero CodeMirror or DOM dependency — built from its own separate
source file rather than carved out of the main entry point by tree-shaking. That distinction
matters in practice: the main entry point ships as one already-bundled file, and a downstream
bundler's tree-shaking can't reliably prove the CodeMirror-touching half is unreachable just
because a consumer only imports a few of its other named exports — a Node.js host that only needs
(say) heading extraction, with no browser/CodeMirror available at all, should import from `/pure`
specifically rather than the bare package, or risk pulling in code that references `document`/
`window` into a process that has neither.

## Local development against a consumer

Two different needs call for two different setups — don't use the same one for both:

**Actively co-developing this kernel alongside a consumer feature** (e.g. building a new host-specific feature that also needs a kernel change): use `npm link` so edits are visible instantly, with no publish step.

```
# in loommark-core
npm link

# in the consumer project
npm link @llingshu/loommark-core
```

The consumer's `package.json` keeps its real semver range (e.g. `"@llingshu/loommark-core": "^0.1.0"`) as the committed, resting state — `npm link` only overlays a local symlink in `node_modules`, uncommitted. Run `npm install` (or `npm unlink @llingshu/loommark-core`) in the consumer to drop back to the published version.

**A consumer that's shipped/deployed independently**: pin its `package.json` to a published version and upgrade deliberately (Dependabot can open PRs for this automatically once configured against this repo).

## Layout

- `src/editor.ts` — `createLoomMarkEditor()`, the factory that assembles everything else below into a live, per-instance CodeMirror `EditorView`.
- `src/pure.ts` — the `/pure` entry point: re-exports only the CodeMirror/DOM-free modules below (types, markdown-ranges, headings, text, paste-image), for hosts that can't or shouldn't pull in `editor.ts`/`widgets.ts`.
- `src/types.ts` — editor option types (`EditorConfiguration` and friends). A host's own wire protocol (if it has one, e.g. LoomMark's VS Code postMessage types) wraps these; they don't belong to any one host.
- `src/markdown-ranges.ts` — pure source scanners (tables, images, math, lists, headings, ...). No DOM, no CodeMirror.
- `src/widgets.ts` — CodeMirror `WidgetType` subclasses and the rendering helpers they use.
- `src/headings.ts` — Markdown heading extraction (`markdownHeadings`) plus folding a flat list into a tree (`nestHeadings`), unified from what used to be two near-duplicate implementations in the source project (one for a sidebar tree, one for an in-editor outline).
- `src/text.ts` — minimal-diff helper for turning "replace whole document" updates into a single targeted edit.
- `src/paste-image.ts` — glob matching against `markdown.copyFiles.destination`-style config, MIME-to-extension mapping, de-duplicated file naming.
