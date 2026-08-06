# Changelog

All notable changes to `@llingshu/loommark-core` are documented here.

## [0.1.4] - 2026-08-05

### Added

- Block images now render as centered, framed figures by default and show their Markdown alt text
  as a caption. Their optional Markdown title accepts `no-center` and `no-frame` presentation
  tokens for opting out independently.

### Fixed

- Standalone images now resolve as complete annotation targets, matching tables, fenced code, and
  display math. Hosts can therefore attach an annotation stripe and badge to the rendered image
  block instead of its hidden source line.

## [0.1.3] - 2026-08-05

### Added

- Hosts can persist and restore a `LoomMarkViewportSnapshot` through `onStateChange` and
  `initialViewport`. It combines the raw scroll position with a top-visible-line anchor and offset
  so a recreated editor returns to the same reading position after layout changes. The editor
  restores focus after the viewport settles, preserving the saved cursor and allowing typing to
  resume without an extra click.

## [0.1.2] - 2026-07-30

### Fixed

- Fenced code-block content is excluded from heading scanning. Markdown-looking `#` lines inside
  a code fence no longer create heading decorations, heading-card boundaries, or outline entries.
