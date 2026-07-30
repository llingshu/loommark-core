# Changelog

All notable changes to `@llingshu/loommark-core` are documented here.

## [0.1.2] - 2026-07-30

### Fixed

- Fenced code-block content is excluded from heading scanning. Markdown-looking `#` lines inside
  a code fence no longer create heading decorations, heading-card boundaries, or outline entries.

