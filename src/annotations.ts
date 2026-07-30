import { annotationRanges, type AnnotationRange } from './markdown-ranges';

export const DEFAULT_ANNOTATION_COLORS = ['#7c3aed', '#2563eb', '#168a72', '#b46a08', '#be3455', '#087f8c'];

export function annotationIdentity(annotation: AnnotationRange): string {
  return annotation.id !== undefined ? `id:${annotation.id}` : `${annotation.side}:${annotation.from}`;
}

export function annotationColor(annotations: AnnotationRange[], annotation: AnnotationRange): string {
  if (annotation.color) return `#${annotation.color}`;
  return DEFAULT_ANNOTATION_COLORS[annotations.indexOf(annotation) % DEFAULT_ANNOTATION_COLORS.length];
}

export function nextAnnotationOpeningTag(source: string): string {
  const annotations = annotationRanges(source);
  const maxId = annotations.reduce((max, annotation) => Math.max(max, annotation.id ?? 0), 0);
  const color = DEFAULT_ANNOTATION_COLORS[annotations.length % DEFAULT_ANNOTATION_COLORS.length].slice(1);
  return `[${maxId + 1}]${color}`;
}

// Deliberately limited to inline constructs. This DOM-only helper never injects HTML from a note,
// so hosts can use it for a read mode while retaining a textarea for Markdown source editing.
export function renderAnnotationInlineMarkdown(container: HTMLElement, text: string): void {
  const appendInline = (line: string) => {
    const tokens = /(`[^`]*`|\*\*[^*]+\*\*|~~[^~]+~~|\[[^\]]+\]\([^\s)]+\)|(?<!\*)\*[^*]+\*(?!\*)|(?<!_)_[^_]+_(?!_))/g;
    let cursor = 0;
    for (const match of line.matchAll(tokens)) {
      const index = match.index ?? 0;
      if (index > cursor) container.append(document.createTextNode(line.slice(cursor, index)));
      const token = match[0];
      if (token.startsWith('`')) {
        const node = document.createElement('code');
        node.textContent = token.slice(1, -1);
        container.append(node);
      } else if (token.startsWith('**')) {
        const node = document.createElement('strong');
        node.textContent = token.slice(2, -2);
        container.append(node);
      } else if (token.startsWith('~~')) {
        const node = document.createElement('s');
        node.textContent = token.slice(2, -2);
        container.append(node);
      } else if (token.startsWith('[')) {
        const bracket = token.indexOf('](');
        const href = token.slice(bracket + 2, -1);
        const node = document.createElement('a');
        node.textContent = token.slice(1, bracket);
        if (/^(https?:|mailto:)/i.test(href)) {
          node.href = href;
          node.target = '_blank';
          node.rel = 'noopener noreferrer';
        }
        container.append(node);
      } else {
        const node = document.createElement('em');
        node.textContent = token.slice(1, -1);
        container.append(node);
      }
      cursor = index + token.length;
    }
    if (cursor < line.length) container.append(document.createTextNode(line.slice(cursor)));
  };

  container.replaceChildren();
  text.split('\n').forEach((line, index) => {
    if (index > 0) container.append(document.createElement('br'));
    appendInline(line);
  });
}
