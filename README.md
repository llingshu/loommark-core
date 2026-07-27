# @llingshu/loommark-core

Portable CodeMirror 6 Markdown editing kernel, extracted from [LoomMark](https://github.com/llingshu/vscode-loommark) (a VS Code custom Markdown editor) so it can be reused across other hosts — a web page, a personal note-taking app, a wiki — without maintaining the same editing logic twice.

## Status

This package is mid-extraction. What's here today is stable, host-agnostic building blocks: Markdown source scanners, CodeMirror widgets, and shared option types — everything that has zero VS Code-specific coupling in the source project. **`createLoomMarkEditor()`, a single factory function that assembles all of this into one ready-to-use CodeMirror instance, does not exist yet** — that requires converting the source project's `webview/main.ts` (currently ~40 module-level globals — one editor instance per process, which VS Code's one-webview-per-document model happens to make safe) into per-instance state, so this package can support more than one editor on a page at once. Until that lands, a host wires these pieces into its own `EditorState`/`EditorView` setup directly.

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

### Peer dependencies

CodeMirror and Lezer packages (`@codemirror/*`, `@lezer/*`) are **peer dependencies**, not regular dependencies — install them yourself, matching the version ranges in `package.json`. This is deliberate: CodeMirror's `StateField`/`StateEffect`/`Facet` definitions rely on reference identity, so two copies of `@codemirror/state` coexisting in a dependency tree (one bundled into this package, one already in your own) silently makes this package's extensions invisible to your `EditorView`. Declaring them as peers keeps exactly one copy in the whole tree — yours.

`katex` and `mdast-util-from-markdown` are regular dependencies; they don't have this problem.

### Stylesheet

```js
import '@llingshu/loommark-core/style.css';
```

Currently just KaTeX's stylesheet (needed by the math widget). The package's own visual styling (tables, lists, heading cards, etc.) moves here once `webview/main.ts`'s decorations move over from the source project.

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

- `src/types.ts` — editor option types (`EditorConfiguration` and friends). A host's own wire protocol (if it has one, e.g. LoomMark's VS Code postMessage types) wraps these; they don't belong to any one host.
- `src/markdown-ranges.ts` — pure source scanners (tables, images, math, lists, headings, ...). No DOM, no CodeMirror.
- `src/widgets.ts` — CodeMirror `WidgetType` subclasses and the rendering helpers they use.
- `src/headings.ts` — Markdown heading extraction (`markdownHeadings`) plus folding a flat list into a tree (`nestHeadings`), unified from what used to be two near-duplicate implementations in the source project (one for a sidebar tree, one for an in-editor outline).
- `src/text.ts` — minimal-diff helper for turning "replace whole document" updates into a single targeted edit.
- `src/paste-image.ts` — glob matching against `markdown.copyFiles.destination`-style config, MIME-to-extension mapping, de-duplicated file naming.
