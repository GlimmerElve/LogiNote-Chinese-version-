export interface ReadingViewport { block: number; offset: number; element?: number }
export function readingViewportAnchor(position: ReadingViewport): string {
  return `reading-block-${position.block}${position.element === undefined ? '' : `-node-${position.element}`}`;
}
export function parseReadingViewport(anchor?: string, offset = 0): ReadingViewport | undefined {
  const match = /^reading-(?:block|page)-(\d+)(?:-node-(\d+))?$/u.exec(anchor || '');
  if (!match || !Number.isFinite(offset) || offset < 0 || offset > 100_000_000) return;
  const block = Number(match[1]), element = match[2] === undefined ? undefined : Number(match[2]);
  if (!Number.isSafeInteger(block) || (element !== undefined && !Number.isSafeInteger(element))) return;
  return { block, offset, ...(element === undefined ? {} : { element }) };
}
const chunkContent = (slot: Element) => slot.firstElementChild?.classList.contains('textbook-reading-chunk')
  && (slot.firstElementChild as HTMLElement).style.contentVisibility !== 'hidden' ? slot.firstElementChild : undefined;

/** Logarithmic geometry reads: no text scanning or full-document layout walk.
 * A paragraph index survives line wrapping when Note and Flow widths differ. */
export function captureReadingViewport(host: HTMLElement, article: HTMLElement): ReadingViewport | undefined {
  const slots = article.children; if (!slots.length) return;
  const viewportTop = host.getBoundingClientRect().top;
  const base = article.getBoundingClientRect().top - viewportTop + host.scrollTop;
  let low = 0, high = slots.length;
  while (low < high) { const mid = (low + high) >>> 1; if ((slots[mid] as HTMLElement).offsetTop + base <= host.scrollTop + 10) low = mid + 1; else high = mid; }
  const block = Math.max(0, low - 1), slot = slots[block] as HTMLElement, children = chunkContent(slot)?.children;
  if (!children?.length) return { block, offset: Math.max(0, host.scrollTop - slot.offsetTop - base) };
  low = 0; high = children.length;
  while (low < high) { const mid = (low + high) >>> 1; if (children[mid].getBoundingClientRect().top <= viewportTop + 10) low = mid + 1; else high = mid; }
  const element = Math.max(0, low - 1);
  return { block, element, offset: Math.max(0, viewportTop - children[element].getBoundingClientRect().top) };
}
export function readingViewportTop(host: HTMLElement, slot: HTMLElement, position: ReadingViewport): number {
  const element = position.element === undefined ? undefined : chunkContent(slot)?.children[position.element];
  const target = element || slot, bounds = target.getBoundingClientRect();
  const offset = element ? Math.min(position.offset, Math.max(0, bounds.height - 1)) : position.element === undefined ? position.offset : 0;
  return bounds.top - host.getBoundingClientRect().top + host.scrollTop + offset;
}
