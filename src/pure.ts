// A second entry point, deliberately narrower than index.ts: only the utilities that have zero
// CodeMirror/DOM dependency, safe to import from a Node.js process (a VS Code extension host, a
// backend) that has no business pulling in browser-only code. Importing from the main index.ts
// entry point isn't enough to avoid this on its own — it's built as one already-bundled file
// (dist/index.js), and a downstream bundler's tree-shaking can't reliably see through that to
// prove editor.ts/widgets.ts (the modules that actually import @codemirror/*/katex) are
// unreachable just because a consumer only imported a few of its other named exports.
export * from './types';
export * from './markdown-ranges';
export * from './headings';
export * from './text';
export * from './paste-image';
