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

// A separate build, deliberately not sharing `external` with the JS build above: CSS has no
// cross-copy identity concerns the way the CodeMirror/Lezer JS packages do, so katex's stylesheet
// is fully inlined here rather than left for the host to separately vendor.
const cssOptions = {
  entryPoints: ['src/style.css'],
  outfile: 'dist/index.css',
  bundle: true,
  minify: production,
  logLevel: 'info',
  // katex's stylesheet references woff2 math fonts; inline them so the output is self-contained.
  loader: { '.woff': 'empty', '.woff2': 'dataurl', '.ttf': 'empty' },
};

if (watch) {
  const contexts = await Promise.all([jsOptions, cssOptions].map((options) => esbuild.context(options)));
  await Promise.all(contexts.map((context) => context.watch()));
  console.log('Watching loommark-core bundle...');
} else {
  await Promise.all([esbuild.build(jsOptions), esbuild.build(cssOptions)]);
}
