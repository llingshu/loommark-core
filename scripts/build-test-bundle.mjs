import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/markdown-ranges.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: 'out/test/markdown-ranges.mjs',
  logLevel: 'warning',
});

await esbuild.build({
  entryPoints: ['src/paste-image.ts'],
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  outfile: 'out/test/paste-image.mjs',
  logLevel: 'warning',
});

await esbuild.build({
  entryPoints: ['src/headings.ts'],
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['mdast-util-from-markdown'],
  outfile: 'out/test/headings.mjs',
  logLevel: 'warning',
});
