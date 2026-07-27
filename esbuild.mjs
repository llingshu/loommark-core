import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');
const production = process.argv.includes('--production');

// This ships as a library other bundlers re-bundle, so only this package's own source is
// bundled together; every dependency (CodeMirror/Lezer peers, katex, mdast) is left external so
// the consumer's own dependency tree — not a copy embedded here — is what actually resolves at
// runtime. That matters most for the CodeMirror/Lezer packages: their StateField/StateEffect/
// Facet definitions rely on reference identity, so two copies coexisting (one bundled in here,
// one in the consumer's node_modules) would make this package's extensions invisible to a
// consumer's EditorView built from its own copy.
const external = [
  '@codemirror/*',
  '@lezer/*',
  'katex',
  'mdast-util-from-markdown',
];

const jsOptions = {
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  format: 'esm',
  platform: 'browser',
  external,
  minify: production,
  metafile: production,
  sourcemap: !production,
  logLevel: 'info',
};

// The CodeMirror-free entry point (see src/pure.ts) — no `external` needed since its own source
// graph never reaches editor.ts/widgets.ts in the first place, only mdast-util-from-markdown.
const pureOptions = {
  entryPoints: ['src/pure.ts'],
  outfile: 'dist/pure.js',
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  external: ['mdast-util-from-markdown'],
  minify: production,
  metafile: production,
  sourcemap: !production,
  logLevel: 'info',
};

// A separate build, deliberately not sharing `external` with the JS build above: CSS has no
// cross-copy identity concerns the way the CodeMirror/Lezer JS packages do, so katex's stylesheet
// is fully inlined here rather than left for the host to separately vendor.
const cssOptions = {
  entryPoints: ['src/style.css'],
  outfile: 'dist/index.css',
  bundle: true,
  minify: production,
  logLevel: 'info',
  // katex's stylesheet references woff/woff2/truetype math fonts; inline all of them as data URIs
  // (not just woff2) rather than dropping legacy formats, unlike the single-consumer, Chromium-only
  // webview build this package originated from — this dist/index.css is a published artifact a
  // downstream bundler re-processes, and an empty url() for a dropped format, while harmless for a
  // browser (which just skips an unusable @font-face src and falls back to the next), trips up
  // esbuild's own CSS bundler when it re-parses this file's url() tokens during that later build.
  loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl' },
};

const allOptions = [jsOptions, pureOptions, cssOptions];

if (watch) {
  const contexts = await Promise.all(allOptions.map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching loommark-core bundle...');
} else {
  await Promise.all(allOptions.map((options) => esbuild.build(options)));
}
