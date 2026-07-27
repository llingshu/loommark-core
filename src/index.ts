// Public entry point. createLoomMarkEditor() — the instance-based factory that wires all of
// this into a live CodeMirror EditorView — lands here once the current host-coupled prototype
// (still module-global state, one instance per process) is refactored into per-instance state.
// Until then, this package exposes its scanners/widgets/options types directly so a host can
// already build against stable APIs while that refactor is in progress.
export * from './types';
export * from './markdown-ranges';
export * from './widgets';
export * from './headings';
export * from './text';
export * from './paste-image';
