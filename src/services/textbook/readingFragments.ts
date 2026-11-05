import type { Element, RootContent } from 'hast';
import { textbookQuoteKind } from './quoteKind';

export const READING_PAGE_CHARACTERS = 6_000;
export const READING_PAGE_ELEMENTS = 720;
const INLINE_CHARACTERS = 3_000, INLINE_CHILDREN = 20, CONTAINER_CHILDREN = 40;
/** Includes the hidden accessible MathML tree and common fraction markup. */
const MATH_ELEMENTS = 64;
type Cost = { characters: number; elements: number };

/** Bounded render fragments, not new stored Markdown/checkpoints. Only legal
 * element child boundaries are split; atomic fences/formulas keep their source. */
export function createReadingFragments() {
  const costs = new WeakMap<object, Cost>();
  const cost = (node: RootContent): Cost => {
    const hit = costs.get(node); if (hit) return hit;
    if (node.type !== 'element') {
      const result = { characters: 'value' in node ? node.value.length : 0, elements: 0 };
      costs.set(node, result); return result;
    }
    const classes = node.properties.className;
    const math = node.tagName === 'code' && Array.isArray(classes)
      && classes.some(value => value === 'math-inline' || value === 'math-display');
    const result = { characters: 0, elements: math ? MATH_ELEMENTS : 1 };
    for (const child of node.children) {
      const next = cost(child as RootContent); result.characters += next.characters; result.elements += next.elements;
    }
    costs.set(node, result); return result;
  };
  const plain = (node: RootContent): string => 'value' in node ? node.value
    : 'children' in node ? node.children.map(child => plain(child as RootContent)).join('') : '';
  const over = (node: RootContent, elementLimit = READING_PAGE_ELEMENTS, characterLimit = INLINE_CHARACTERS) => {
    const size = cost(node); return size.characters > characterLimit || size.elements > elementLimit;
  };
  const clone = (node: Element, children: Element['children'], index: number, total: number): Element => {
    const properties = { ...node.properties,
      ...(index ? { id: undefined, 'data-reading-continuation': true } : {}),
      ...(index < total - 1 ? { 'data-reading-fragment-tail': true } : {}) };
    const data = { ...node.data, ...(index ? { readingContinuation: true } : {}) };
    if (node.tagName === 'blockquote') {
      const kind = textbookQuoteKind(node);
      if (kind) data.readingQuoteKind = kind;
      if (kind === 'interactive' && !index) data.readingQuoteBrief = node.children
        .filter(child => child.type === 'element').slice(1).map(child => plain(child)).join(' ').trim();
    }
    return { ...node, properties, data, children };
  };
  const withoutIds = (node: Element): Element => ({ ...node, properties: { ...node.properties, id: undefined },
    children: node.children.map(child => child.type === 'element' ? withoutIds(child) : child) });
  const groups = (children: Element['children'], childLimit: number, charLimit = READING_PAGE_CHARACTERS,
    reserve = 1, elementLimit = READING_PAGE_ELEMENTS): Element['children'][] => {
    const result: Element['children'][] = []; let next: Element['children'] = [], size = 0, elements = reserve;
    for (const child of children) {
      const value = cost(child as RootContent);
      if (next.length && (next.length >= childLimit || size + value.characters > charLimit
        || elements + value.elements > elementLimit)) {
        result.push(next); next = []; size = 0; elements = reserve;
      }
      next.push(child); size += value.characters; elements += value.elements;
    }
    if (next.length) result.push(next); return result;
  };
  const wrap = (node: Element, slices: Element['children'][]): Element[] => slices.map((children, index) => clone(node, children, index, slices.length));
  const inlineTags = new Set(['p', 'a', 'strong', 'em', 'del', 'span', 'td', 'th']);
  const blockTags = new Set(['li', 'ul', 'ol', 'blockquote', 'section', 'div', 'details', 'aside']);
  const split = (node: RootContent, elementLimit = READING_PAGE_ELEMENTS, characterLimit = READING_PAGE_CHARACTERS): RootContent[] => {
    const inlineLimit = Math.max(1, Math.min(INLINE_CHARACTERS, characterLimit));
    if (node.type === 'text' && node.value.length > inlineLimit) {
      // Array.from avoids cutting surrogate pairs (emoji/astral characters).
      const points = Array.from(node.value), result: RootContent[] = [];
      const sliceSize = Math.max(1, Math.floor(inlineLimit / 2));
      for (let i = 0; i < points.length; i += sliceSize) result.push({ ...node, value: points.slice(i, i + sliceSize).join('') });
      return result;
    }
    if (node.type !== 'element') return [node];
    const classes = node.properties.className;
    if (node.tagName === 'pre' || node.tagName === 'code'
      || Array.isArray(classes) && classes.some(value => value === 'math-inline' || value === 'math-display')) return [node];
    if (node.tagName === 'table') return splitTable(node);
    if (!inlineTags.has(node.tagName) && !blockTags.has(node.tagName)) return [node];
    // Normal nodes stay byte/structure-identical. Exceptional descendants are
    // visited even when they are the ONLY child of a quote/list/cell.
    if (!over(node, elementLimit, inlineLimit) && node.children.length <= (inlineTags.has(node.tagName) ? 60 : CONTAINER_CHILDREN)) return [node];
    let ordinal = Number(node.properties.start || 1);
    const children: Element['children'] = [];
    for (const child of node.children) {
      const parts = split(child as RootContent, Math.max(1, elementLimit - 1), characterLimit) as Element['children'];
      if ((node.tagName === 'ul' || node.tagName === 'ol') && child.type === 'element' && child.tagName === 'li') {
        if (child.properties.value !== undefined && Number.isFinite(Number(child.properties.value))) ordinal = Number(child.properties.value);
        for (let index = 0; index < parts.length; index++) {
          const part = parts[index];
          if (part.type === 'element') parts[index] = { ...part,
            properties: { ...part.properties, ...(node.tagName === 'ol' ? { value: String(ordinal) } : {}),
              ...(index ? { 'data-reading-list-continuation': true } : {}) } };
        }
        ordinal++;
      }
      children.push(...parts);
    }
    const slices = groups(children, inlineTags.has(node.tagName) ? INLINE_CHILDREN : CONTAINER_CHILDREN,
      inlineTags.has(node.tagName) ? inlineLimit : characterLimit, 1, elementLimit);
    const result = wrap(node, slices);
    if (node.tagName === 'ol') for (const part of result) {
      const first = part.children.find(child => child.type === 'element' && child.tagName === 'li') as Element | undefined;
      if (first?.properties.value !== undefined && Number.isFinite(Number(first.properties.value))) part.properties.start = Number(first.properties.value);
    }
    return result;
  };
  const splitRow = (row: Element, elementLimit = READING_PAGE_ELEMENTS, characterLimit = READING_PAGE_CHARACTERS): Element[] => {
    const cells = row.children.filter((child): child is Element => child.type === 'element');
    if (!over(row, elementLimit, characterLimit)) return [row];
    // Preserve column membership and authored cell order, but budget the WHOLE
    // row: zipping independently full-size cells recreates a giant DOM chunk.
    const empty = (cell: Element): Element => ({ ...cell, properties: { ...cell.properties, id: undefined }, children: [] });
    const emptyCells = () => cells.map(empty);
    const slices: Element['children'][] = [];
    let next = emptyCells(), used = false;
    const publish = () => { if (used) slices.push(next); next = emptyCells(); used = false; };
    const base = 1 + cells.length;
    for (let column = 0; column < cells.length; column++) {
      const parts = split(cells[column], Math.max(1, elementLimit - base + 1), characterLimit) as Element[];
      for (const part of parts) {
        const trial = [...next]; trial[column] = part;
        if (used && (next[column].children.length > 0 || cost({ ...row, children: trial }).elements > elementLimit
          || cost({ ...row, children: trial }).characters > characterLimit)) publish();
        next[column] = part; used = true;
      }
    }
    publish();
    return slices.map((children, index) => clone(row, children, index, slices.length));
  };
  const splitTable = (table: Element): Element[] => {
    const head = table.children.find((child): child is Element => child.type === 'element' && child.tagName === 'thead');
    const body = table.children.find((child): child is Element => child.type === 'element' && child.tagName === 'tbody');
    const rows = body?.children.filter((child): child is Element => child.type === 'element' && child.tagName === 'tr') || [];
    if (!over(table) && rows.length <= 30) return [table];
    const headerRows = head?.children.filter((child): child is Element => child.type === 'element' && child.tagName === 'tr')
      .flatMap(row => splitRow(row, Math.floor(READING_PAGE_ELEMENTS / 2) - 2, READING_PAGE_CHARACTERS / 2)) || [];
    const headerSlices = groups(headerRows, 30, READING_PAGE_CHARACTERS / 2, 1, Math.floor(READING_PAGE_ELEMENTS / 2));
    const headers = headerSlices.map(children => ({ ...head!, children }));
    // A gigantic header is displayed in bounded header-only continuations once;
    // normal headers repeat as before, without duplicating navigation IDs.
    const repeatedHead = headers[0];
    const reserve = 2 + (repeatedHead ? cost(repeatedHead).elements : 0);
    const bodyCharacters = Math.max(1, READING_PAGE_CHARACTERS - (repeatedHead ? cost(repeatedHead).characters : 0));
    const rowSlices = groups(rows.flatMap(row => splitRow(row, Math.max(1, READING_PAGE_ELEMENTS - reserve), bodyCharacters)), 30, bodyCharacters,
      Math.min(READING_PAGE_ELEMENTS - 1, reserve));
    const slices: Element['children'][] = headers.length > 1 ? headers.map(header => [header]) : [];
    if (!rows.length && !slices.length && repeatedHead) slices.push([repeatedHead]);
    for (const children of rowSlices) slices.push([
      ...(repeatedHead ? [slices.length ? withoutIds(repeatedHead) : repeatedHead] : []),
      { ...body!, properties: { ...body!.properties, ...(slices.length ? { id: undefined } : {}) }, children },
    ]);
    return wrap(table, slices.length ? slices : [table.children]);
  };
  return { split, cost };
}
