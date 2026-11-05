import type { PdfRawBlock } from './pdfPreprocessing.ts';

type Box = [number, number, number, number];
const area = (box: Box) => Math.max(0, box[2] - box[0]) * Math.max(0, box[3] - box[1]);
const byPosition = (a: PdfRawBlock, b: PdfRawBlock) => a.bbox![1] - b.bbox![1]
  || a.bbox![0] - b.bbox![0] || a.blockIndex - b.blockIndex;

/** A gutter needs substantial prose on BOTH sides at overlapping heights.
 * Short headings/indented lines alone must not turn a single-column page into two. */
function findGutter(blocks: PdfRawBlock[]): number | undefined {
  const prose = blocks.filter(b => b.kind === 'paragraph' && b.bbox && b.text.trim().length >= 8);
  if (prose.length < 4) return;
  const left = Math.min(...prose.map(b => b.bbox![0]));
  const right = Math.max(...prose.map(b => b.bbox![2]));
  const width = right - left;
  if (width < 100) return;
  const narrow = prose.filter(b => {
    const w = b.bbox![2] - b.bbox![0];
    return w >= width * 0.2 && w <= width * 0.65;
  });
  const edges = [...new Set(narrow.flatMap(b => [b.bbox![0], b.bbox![2]]))].sort((a, b) => a - b);
  let best: { x: number; score: number } | undefined;
  for (let i = 1; i < edges.length; i++) {
    if (edges[i] - edges[i - 1] < 6) continue;
    const x = (edges[i] + edges[i - 1]) / 2;
    if (x < left + width * 0.25 || x > right - width * 0.25) continue;
    const l = narrow.filter(b => b.bbox![2] <= x);
    const r = narrow.filter(b => b.bbox![0] >= x);
    if (l.length < 2 || r.length < 2 || l.length + r.length < narrow.length * 0.9) continue;
    const overlap = Math.min(Math.max(...l.map(b => b.bbox![3])), Math.max(...r.map(b => b.bbox![3])))
      - Math.max(Math.min(...l.map(b => b.bbox![1])), Math.min(...r.map(b => b.bbox![1])));
    if (overlap < 20) continue;
    const score = l.length + r.length + Math.min(l.length, r.length) + (edges[i] - edges[i - 1]) / width;
    if (!best || score > best.score) best = { x, score };
  }
  return best?.x;
}

/** Preserve original blockIndex/IDs as source identities; only reorder the reading projection.
 * Full-width title/abstract/table blocks divide a page into horizontal reading bands.
 * Each band reads the entire left column, then the entire right column. */
export function orderPdfReadingBlocks(input: PdfRawBlock[], furniture = new Set<string>()) {
  const ordered: PdfRawBlock[] = [];
  const columnPages: number[] = [];
  const columnLayouts: Array<{ page: number; gutter: number }> = [];
  const pages = [...new Set(input.map(b => b.page))].sort((a, b) => a - b);
  for (const page of pages) {
    const pageBlocks = input.filter(b => b.page === page);
    // Explicit layout auxiliaries are a separate reading lane. Keeping their
    // original Y positions in the prose lane would interrupt paragraphs and
    // prevent gutter detection after a contents sidebar is correctly labelled.
    const auxiliary = pageBlocks.filter(b => b.layoutRole && b.layoutRole !== 'drop_cap');
    const blocks = pageBlocks.filter(b => !auxiliary.includes(b));
    if (!blocks.length) {
      ordered.push(...auxiliary.sort((a, b) => a.blockIndex - b.blockIndex));
      continue;
    }
    if (blocks.some(b => !b.bbox || !b.bbox.every(Number.isFinite) || area(b.bbox) <= 0)) {
      ordered.push(...blocks.sort((a, b) => a.blockIndex - b.blockIndex));
      ordered.push(...auxiliary.sort((a, b) => a.blockIndex - b.blockIndex));
      continue;
    }
    const content = blocks.filter(b => !furniture.has(b.id));
    const gutter = findGutter(content);
    if (gutter === undefined) {
      ordered.push(...blocks.sort(byPosition));
      ordered.push(...auxiliary.sort((a, b) => a.blockIndex - b.blockIndex));
      continue;
    }
    columnPages.push(page);
    columnLayouts.push({ page, gutter });
    const minY = Math.min(...content.map(b => b.bbox![1]));
    const topFurniture = blocks.filter(b => furniture.has(b.id) && b.bbox![1] < minY);
    const bottomFurniture = blocks.filter(b => furniture.has(b.id) && b.bbox![1] >= minY);
    const spanning = content.filter(b => b.bbox![0] < gutter - 3 && b.bbox![2] > gutter + 3).sort(byPosition);
    let pending = content.filter(b => !spanning.includes(b));
    const emitBand = (band: PdfRawBlock[]) => {
      ordered.push(...band.filter(b => (b.bbox![0] + b.bbox![2]) / 2 < gutter).sort(byPosition),
        ...band.filter(b => (b.bbox![0] + b.bbox![2]) / 2 >= gutter).sort(byPosition));
    };
    ordered.push(...topFurniture.sort(byPosition));
    for (const barrier of spanning) {
      const centerY = (barrier.bbox![1] + barrier.bbox![3]) / 2;
      emitBand(pending.filter(b => (b.bbox![1] + b.bbox![3]) / 2 < centerY));
      pending = pending.filter(b => (b.bbox![1] + b.bbox![3]) / 2 >= centerY);
      ordered.push(barrier);
    }
    emitBand(pending);
    ordered.push(...bottomFurniture.sort(byPosition));
    ordered.push(...auxiliary.sort((a, b) => a.blockIndex - b.blockIndex));
  }
  return { blocks: ordered, columnPages, columnLayouts };
}
