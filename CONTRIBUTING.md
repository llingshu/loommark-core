# Contributing

## Setup

```bash
git clone https://github.com/llingshu/loommark-core.git
cd loommark-core
npm install
```

## Everyday commands

| Command | Does |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` — no build output, just type errors. |
| `npm test` | Builds the test bundle, then runs `test/*.test.mjs` under Node's built-in test runner. |
| `npm run check` | `typecheck` + `test` — run this before opening a PR. |
| `npm run build` | Production build of `dist/index.js`, `dist/pure.js`, `dist/index.css`. |
| `npm run watch` | Rebuilds on save, for manually exercising a change against a consumer via `npm link` (see the README's "Local development against a consumer" section). |
| `npm run package` | `clean` + `check` + `build` + `declarations` — what CI runs before publishing a release. |

## Before opening a pull request

1. `npm run check` passes — a PR that doesn't typecheck or fails a test won't be merged.
2. New behavior has a test. `test/markdown-ranges.test.mjs` is the largest suite and the easiest
   template to follow: pure functions, plain `assert.deepEqual`/`assert.equal`, no framework beyond
   Node's built-in `node:test`.
3. Source-fidelity rules still hold (see the README's "Source Fidelity" section, inherited from
   LoomMark): a scanner or widget must never rewrite, reformat, or reorder the document text a host
   passes in. Anything this kernel gets wrong should fail loudly (or leave the text untouched), not
   silently "fix" it.
4. If the change touches a CodeMirror `StateField`/`StateEffect`/decoration, double-check the peer
   dependency reasoning in the README ("Peer dependencies") still applies — don't accidentally add
   `@codemirror/*`/`@lezer/*` as a regular `dependencies` entry, which would let a duplicate copy of
   CodeMirror's state machinery sneak into a consumer's bundle.

## Reporting a bug or requesting a feature

Open a [GitHub issue](https://github.com/llingshu/loommark-core/issues). For a bug, include:
the Markdown input that triggers it, what you expected, what happened instead, and — if it's a
rendering issue — which host you saw it in (this package, LoomMark itself, or something else
consuming it) and its version.

## Design questions worth reading before a larger change

- **Why is CodeMirror/Lezer a peer dependency, not a regular one?** See "Peer dependencies" in the
  README — it's about reference identity for `StateField`/`StateEffect`/`Facet`, not just bundle
  size.
- **Why does `/pure` exist as a separate entry point instead of relying on tree-shaking?** See "A
  second, CodeMirror-free entry point" in the README.
- **Why does a scanner exclude ranges (code fences, math, annotations, ...) the way it does?** Check
  the comment directly above the function in `src/markdown-ranges.ts` first — most of these
  exclusions exist because of a specific bug a missing one caused, and the comment usually says
  which one.

## License

By contributing, you agree your contribution is licensed under this project's
[MIT License](LICENSE).
