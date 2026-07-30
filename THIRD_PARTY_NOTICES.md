# Third-party notices

`@llingshu/loommark-core` is MIT-licensed (see [`LICENSE`](LICENSE)). This file lists the
third-party software it depends on, split by whether that software's own code is actually
embedded in what this package publishes, since that's what determines what needs reproducing here.

## Bundled into published output

**[KaTeX](https://katex.org/)** (`katex`, MIT) — `dist/index.css` inlines KaTeX's compiled
stylesheet and math web fonts directly (as `data:` URIs) so a consumer gets working math rendering
from a single `import '@llingshu/loommark-core/style.css'`, with no separate KaTeX asset step of
their own. Because that CSS is redistributed as part of this package, KaTeX's license text is
reproduced in full below, per its own terms.

```
MIT License

Copyright (c) 2013-2020 Khan Academy and other contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

KaTeX's own JavaScript is **not** bundled — `katex` stays an `external` module in `esbuild.mjs`'s
JS build, so the code that actually renders math is resolved from the consumer's own installed
copy at runtime. Only the compiled CSS/font assets travel with this package.

## Runtime dependencies, resolved from the consumer's own install (not bundled)

None of the packages below have their source code copied into this package's published files —
`dist/index.js`/`dist/pure.js` `import` them as bare specifiers (`external` in `esbuild.mjs`), and
npm installs each consumer's own copy alongside this package. They're listed here for attribution,
not because redistribution obligations apply.

| Package | License | Role |
| --- | --- | --- |
| [`@codemirror/state`](https://github.com/codemirror/state), [`@codemirror/view`](https://github.com/codemirror/view), [`@codemirror/commands`](https://github.com/codemirror/commands), [`@codemirror/language`](https://github.com/codemirror/language), [`@codemirror/language-data`](https://github.com/codemirror/language-data), [`@codemirror/lang-markdown`](https://github.com/codemirror/lang-markdown), [`@codemirror/autocomplete`](https://github.com/codemirror/autocomplete), [`@codemirror/search`](https://github.com/codemirror/search) | MIT | The editing surface itself — text state, view/DOM layer, commands, and language support this package's extensions are built on top of. Peer dependencies (see the README's "Peer dependencies" section for why). |
| [`@lezer/highlight`](https://github.com/lezer-parser/highlight), [`@lezer/markdown`](https://github.com/lezer-parser/markdown) | MIT | The incremental parser CodeMirror's Markdown mode is built on. Peer dependencies. |
| [`mdast-util-from-markdown`](https://github.com/syntax-tree/mdast-util-from-markdown) (and its own `micromark`/`unist`/`mdast` ecosystem dependencies) | MIT | Parses Markdown into a syntax tree for `renderAnnotationInlineMarkdown`'s inline rendering. Regular dependency, still left external. |

## License compliance check

Every package actually installed for this project — direct and transitive, including
`devDependencies` — declares a permissive license (`MIT`, `BSD-2-Clause`, `BSD-3-Clause`,
`Apache-2.0`, or `ISC`). None are copyleft (GPL/LGPL/AGPL/MPL) or source-unavailable. This was
verified by walking every `package.json` under `node_modules` and checking its `license` field —
93 unique packages at the time of writing, all clean. Re-run this check yourself with:

```bash
node -e "
const fs = require('fs');
const path = require('path');
const permissive = new Set(['MIT','BSD-2-Clause','BSD-3-Clause','Apache-2.0','ISC','0BSD','CC0-1.0','Unlicense']);
const flagged = [];
const seen = new Set();
function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.name.startsWith('@')) { walk(full); continue; }
    const pkgPath = path.join(full, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const key = pkg.name + '@' + pkg.version;
      if (!seen.has(key)) {
        seen.add(key);
        let lic = pkg.license;
        if (typeof lic === 'object') lic = lic.type;
        if (!lic || !permissive.has(lic)) flagged.push([key, lic]);
      }
      const nested = path.join(full, 'node_modules');
      if (fs.existsSync(nested)) walk(nested);
    } else walk(full);
  }
}
walk('node_modules');
console.log('scanned:', seen.size, 'flagged:', flagged);
"
```
