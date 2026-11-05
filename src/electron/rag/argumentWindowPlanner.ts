import { createHash } from 'node:crypto';
import type { SourceBlock, SourceBlockKind, StructuredDocument } from '../../types.ts';
import { estimateEmbeddingTokens } from './chunking.ts';

/** Independent reading contract. Does not change L1 chunks, old sentence IDs or any index. */
export const ARGUMENT_WINDOW_VERSION = 'argument-reading-window-v1';
export interface ReadingSpan { start: number; end: number }
export interface ReadingSegment extends ReadingSpan { separatorBefore: string }
export interface ReadingUnit extends ReadingSpan {
  id: string; parentId: string; kind: SourceBlockKind; sectionPath: string;
  blockIds: string[]; runId: number; paragraphEnd: boolean;
  continuation: boolean; needsPrevious: boolean; terminal: boolean;
  segments: ReadingSegment[];
  contentRole: 'body' | 'bibliography';
}
export interface ArgumentReadingWindow {
  id: string; sectionPath: string; kind: SourceBlockKind;
  core: ReadingUnit[]; before: ReadingUnit[]; after: ReadingUnit[];
  cutReason: string; coreTokens: number; contextTokens: number;
  boundaryStatus: 'intact' | 'needs_context' | 'continuation' | 'unstructured';
  gaps: string[];
  /** Rules are NOT a certificate of semantic completeness or source truth. */
  semanticReview: 'not_performed';
  docId: string; contentHash: string;
}
export interface ArgumentWindowOptions {
  targetCoreTokens?: number; maxCoreTokens?: number; maxContextTokens?: number; maxBodyTokens?: number;
  measureTokens?: (text: string) => number;
  tokenBudgetKind?: 'estimated' | 'tokenizer'; tokenCounterId?: string;
  /** Caller-identified source annotations. Original spans remain in the coverage ledger. */
  isolatedNoteBlockIds?: string[];
}
export interface ArgumentWindowPlan {
  version: typeof ARGUMENT_WINDOW_VERSION; docId: string; contentHash: string;
  budget: { targetCoreTokens: number; maxCoreTokens: number; maxContextTokens: number; maxBodyTokens: number;
    kind: 'estimated' | 'tokenizer'; counterId: string };
  units: ReadingUnit[]; headings: ReadingSpan[]; windows: ArgumentReadingWindow[];
  metadata: (ReadingSpan & { blockId: string; reason: string; classification: 'rule_candidate' })[];
  gaps: string[];
  checks: { sourceCoverage: number; duplicateCoreCharacters: number; missingBodyCharacters: number;
    budgetPassed: boolean; semanticCompleteness: 'not_assessed' };
}
const previousCue = /^(?:因此|所以|故而|但是|但(?:对|在|这|该|其)|然而|不过|否则|才(?:会|能|可)|这(?:一|些|个|种|样|就)|上述|前述|以上|前面|它(?:们)?|他(?:们)?|其(?:中|结果|原因)|该(?:结果|研究|实验|方法|结论)|作者认为|由此|同样|because\b|therefore\b|however\b|this\b|these\b|otherwise\b)/iu;
const opener = /^(?:只有|如果|若(?:在|仅|满足|条件)?|除非|当|仅在|if\b|only if\b)/iu;
const closer = /(?:则|那么|才(?:会|能|可)|否则|便会|就会|可以|可能|会导致|会降低|会增加|then\b)/iu;
const terminalEnd = /[。！？!?\.][”’"'）)\]】]*$/u;
const bibliographyTitle = /^(?:参考文献(?:\s*[（(]References[）)])?|References)$/iu;
const trimSpan = (text: string, start: number, end: number): ReadingSpan | undefined => {
  while (start < end && /\s/u.test(text[start])) start++;
  while (end > start && /\s/u.test(text[end - 1])) end--;
  return end > start ? { start, end } : undefined;
};
function periodBoundary(text: string, i: number): boolean {
  const before = text.slice(0, i), after = text.slice(i + 1).trimStart();
  if (/\d$/u.test(before) && /^\d/u.test(after)) return false;
  if (/[A-Za-z0-9]/u.test(text[i + 1] || '')) return false;
  const word = before.match(/([A-Za-z]+)$/u)?.[1] || '';
  if (after && /^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Fig|Figs|Eq|Eqs|Vol|No|vs|etc|al)$/iu.test(word)) return false;
  if (/^[A-Z]$/u.test(word) && /^[A-Z]/u.test(after)) return false;
  return !(/(?:\b[A-Za-z]\.)+[A-Za-z]$/u.test(before) && after);
}
/** Semicolons are soft, quoted/bracketed punctuation is protected; source is never rewritten. */
export function argumentSentenceRanges(text: string): ReadingSpan[] {
  const result: ReadingSpan[] = [], stack: string[] = [];
  const pairs: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '『': '』', '（': '）', '(': ')', '[': ']', '【': '】' };
  let start = 0;
  const flush = (end: number) => { const span = trimSpan(text, start, end); if (span) result.push(span); start = end; };
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (pairs[char]) stack.push(pairs[char]);
    else if (stack.at(-1) === char) stack.pop();
    else if (char === '"') { if (stack.at(-1) === '"') stack.pop(); else stack.push('"'); }
    const endMark = /[。！？!?]/u.test(char) || (char === '.' && periodBoundary(text, i));
    if (endMark && stack.length === 0) {
      let end = i + 1;
      while (end < text.length && /[。！？!?.”’"'）)\]】]/u.test(text[end])) end++;
      flush(end); i = end - 1;
    } else if (char === '\n' && stack.length === 0 && /^\n[ \t\r]*\n/u.test(text.slice(i))) {
      const part = text.slice(start, i).trim();
      // An unfinished conditional or visual line continues into the next paragraph.
      if (terminalEnd.test(part)) flush(i);
    }
  }
  flush(text.length);
  return result;
}
function ambiguousColumns(a: SourceBlock, b: SourceBlock): boolean {
  if (a.locator.kind !== 'pdf' || b.locator.kind !== 'pdf' || a.locator.page !== b.locator.page
    || !a.locator.bbox || !b.locator.bbox) return false;
  const x = a.locator.bbox, y = b.locator.bbox;
  return (y[0] >= x[2] || x[0] >= y[2]) && y[1] < x[1];
}
/** Only bounded, repeated page furniture is isolated; all raw spans remain visible. */
function pageFurniture(source: StructuredDocument): Map<string, string> {
  const result = new Map<string, string>(), pages = new Map<number, SourceBlock[]>();
  for (const b of source.blocks) if (b.locator.kind === 'pdf' && b.locator.bbox) {
    const list = pages.get(b.locator.page) || []; list.push(b); pages.set(b.locator.page, list);
  }
  const occurrences = new Map<string, Set<number>>(), edges = new Set<string>();
  const bbox = (b: SourceBlock) => { if (b.locator.kind !== 'pdf' || !b.locator.bbox) throw new Error('argument_window_invalid_pdf_layout'); return b.locator.bbox; };
  for (const [page, blocks] of pages) {
    const top = Math.min(...blocks.map(b => bbox(b)[1])), bottom = Math.max(...blocks.map(b => bbox(b)[3]));
    for (const b of blocks) {
      const box = bbox(b), raw = source.normalizedText.slice(b.textStart, b.textEnd).replace(/^#+\s*/u, '').trim();
      const key = raw.replace(/\s+/gu, ' ');
      if (box[1] <= top + 50 || box[3] >= bottom - 40) {
        edges.add(b.id);
        if (key.length <= 160) { const set = occurrences.get(key) || new Set<number>(); set.add(page); occurrences.set(key, set); }
        if (/^\d{1,4}$/u.test(raw) && box[3] >= bottom - 40) result.set(b.id, 'page_number_candidate');
        if (/^(?:-?\d+-?\s+)?(?:心理科学进展|Advances in Psychological Science).*(?:\d{4}|年)/iu.test(raw)) result.set(b.id, 'journal_header_candidate');
      }
    }
  }
  for (const b of source.blocks) {
    const key = source.normalizedText.slice(b.textStart, b.textEnd).replace(/^#+\s*/u, '').trim().replace(/\s+/gu, ' ');
    const statementCue = /(?:如果|只有|条件|因此|然而|但是|可能|研究(?:表明|发现)|实验(?:发现|结果)|\b(?:if|only|because|could|should|must)\b|[。！？!?])/iu.test(key);
    if (edges.has(b.id) && !statementCue && (occurrences.get(key)?.size || 0) >= 2) result.set(b.id, 'repeated_page_furniture_candidate');
    if (b.locator.kind === 'pdf' && /^DOI:\s*\S+\s+\d{1,4}\s+[\p{Script=Han}A-Za-z ]+$/iu.test(key)) result.set(b.id, 'doi_page_footer_candidate');
    if (b.locator.kind === 'pdf' && b.locator.page === 1 && (/^Advances in .+Published Online .+https?:\/\//iu.test(key)
      || /^文章引用[:：]/u.test(key))) result.set(b.id, 'publication_frontmatter_candidate');
    if (b.locator.kind === 'pdf' && (/^收稿日期[:：]\s*\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+通讯作者[:：].+E-mail[:：]\s*\S+)?$/iu.test(key)
      || /^通讯作者[:：].+E-mail[:：]\s*\S+$/iu.test(key))) result.set(b.id, 'correspondence_footnote_candidate');
  }
  return result;
}
function readSegments(text: string, segments: ReadingSegment[]): string {
  return segments.map((s, i) => (i ? s.separatorBefore : '') + text.slice(s.start, s.end)).join('');
}
function unbalancedDelimiters(raw: string): boolean {
  const stack: string[] = [], pairs: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '『': '』', '（': '）', '(': ')', '[': ']', '【': '】' };
  for (const char of raw) {
    if (pairs[char]) stack.push(pairs[char]);
    else if (stack.at(-1) === char) stack.pop();
    else if (char === '"') { if (stack.at(-1) === '"') stack.pop(); else stack.push('"'); }
  }
  return stack.length > 0;
}
function validateSource(source: StructuredDocument): void {
  if (source.schemaVersion !== 1 || typeof source.normalizedText !== 'string' || !source.docId
    || source.normalizedText.length > 500000 || !Array.isArray(source.blocks) || source.blocks.length > 5000) throw new Error('argument_window_invalid_source');
  let end = 0;
  const ids = new Set<string>();
  for (const block of source.blocks) {
    if (!block.id || ids.has(block.id) || !Number.isSafeInteger(block.textStart) || !Number.isSafeInteger(block.textEnd)
      || block.textStart < end || block.textEnd <= block.textStart || block.textEnd > source.normalizedText.length
      || !['heading', 'paragraph', 'list', 'table', 'code', 'caption', 'notes'].includes(block.kind)
      || typeof block.sectionPath !== 'string' || !block.locator) throw new Error('argument_window_invalid_block');
    if (source.normalizedText.slice(end, block.textStart).trim()) throw new Error('argument_window_unmapped_source');
    ids.add(block.id); end = block.textEnd;
  }
  if (source.normalizedText.slice(end).trim()) throw new Error('argument_window_unmapped_source');
}
export function planArgumentWindows(source: StructuredDocument, options: ArgumentWindowOptions = {}): ArgumentWindowPlan {
  validateSource(source);
  const text = source.normalizedText, hash = createHash('sha256').update(text).digest('hex');
  const budget = { targetCoreTokens: options.targetCoreTokens ?? 1500, maxCoreTokens: options.maxCoreTokens ?? 2200,
    maxContextTokens: options.maxContextTokens ?? 800, maxBodyTokens: options.maxBodyTokens ?? 3000,
    kind: options.tokenBudgetKind ?? 'estimated', counterId: options.tokenCounterId ?? 'multilingual-estimate-v1' };
  if (![budget.targetCoreTokens, budget.maxCoreTokens, budget.maxBodyTokens].every(n => Number.isSafeInteger(n) && n > 0)
    || !Number.isSafeInteger(budget.maxContextTokens) || budget.maxContextTokens < 0
    || budget.targetCoreTokens > budget.maxCoreTokens || budget.maxCoreTokens > budget.maxBodyTokens
    || (budget.kind === 'tokenizer' && (!options.measureTokens || !options.tokenCounterId))) throw new Error('argument_window_invalid_budget');
  const counter = options.measureTokens ?? estimateEmbeddingTokens;
  const measure = (value: string) => { const n = counter(value); if (!Number.isFinite(n) || n < 0) throw new Error('argument_window_invalid_counter'); return Math.ceil(n); };
  const unitText = (unit: ReadingSpan & { segments?: ReadingSegment[] }) => unit.segments ? readSegments(text, unit.segments) : text.slice(unit.start, unit.end);
  const joined = (items: ReadingUnit[]) => items.map(unitText).join('\n');
  const headings: ReadingSpan[] = [], units: ReadingUnit[] = [], gaps: string[] = [];
  const metadata: ArgumentWindowPlan['metadata'] = [], furniture = pageFurniture(source);
  for (const id of options.isolatedNoteBlockIds || []) {
    if (!source.blocks.some(b => b.id === id)) throw new Error('argument_window_unknown_note_block');
    furniture.set(id, 'source_note_candidate');
  }
  let run: SourceBlock[] = [], runId = 0;
  let effectiveSection = '', contentRole: ReadingUnit['contentRole'] = 'body';
  const emit = (blocks: SourceBlock[]) => {
    if (!blocks.length) return;
    const first = blocks[0];
    let body = '';
    const mapping = blocks.map((b, i) => {
      const raw = text.slice(b.textStart, b.textEnd);
      const separatorBefore = i ? b.locator.kind === 'pdf'
        ? /\p{Script=Han}$/u.test(body) && /^\p{Script=Han}/u.test(raw) ? '' : ' '
        : '\n\n' : '';
      body += separatorBefore; const start = body.length; body += raw;
      return { block: b, start, end: body.length, separatorBefore };
    });
    const toSegments = (start: number, end: number): ReadingSegment[] => mapping.filter(m => m.start < end && m.end > start)
      .map((m, i) => ({ start: m.block.textStart + Math.max(0, start - m.start),
        end: m.block.textStart + Math.min(m.end, end) - m.start, separatorBefore: i ? m.separatorBefore : '' }));
    const spans = first.kind === 'paragraph' || first.kind === 'notes' || first.kind === 'caption'
      ? argumentSentenceRanges(body) : first.kind === 'list' || first.kind === 'table'
        ? [...body.matchAll(/[^\r\n]+/gu)].map(match => ({ start: match.index!, end: match.index! + match[0].length }))
        : [{ start: 0, end: body.length }];
    for (const span of spans) {
      const full = trimSpan(body, span.start, span.end);
      if (!full) continue;
      const fullSegments = toSegments(full.start, full.end);
      const parentId = `${hash}:${fullSegments[0].start}:${fullSegments.at(-1)!.end}`;
      let cursor = full.start;
      const oversized = measure(body.slice(full.start, full.end)) > budget.maxCoreTokens;
      while (cursor < full.end) {
        let stop = full.end;
        if (measure(body.slice(cursor, stop)) > budget.maxCoreTokens) {
          let low = cursor + 1, high = stop;
          // Conservative fallback, NOT semantic splitting or standalone assertions.
          while (low < high) { const mid = Math.ceil((low + high) / 2); if (measure(body.slice(cursor, mid)) <= budget.maxCoreTokens) low = mid; else high = mid - 1; }
          stop = low;
          while (stop > cursor && measure(body.slice(cursor, stop)) > budget.maxCoreTokens) stop--;
          if (stop > cursor && stop < full.end && /[\uD800-\uDBFF]/u.test(body[stop - 1])) stop--;
          if (stop <= cursor) throw new Error('argument_window_budget_cannot_fit_character');
        }
        const range = trimSpan(body, cursor, stop);
        if (range) {
          const raw = body.slice(range.start, range.end), segments = toSegments(range.start, range.end);
          if (!segments.length) { cursor = stop; continue; }
          const mapped = { start: segments[0].start, end: segments.at(-1)!.end };
          units.push({ ...mapped, segments, contentRole, id: `${ARGUMENT_WINDOW_VERSION}:${hash}:${mapped.start}:${mapped.end}`, parentId,
            kind: first.kind, sectionPath: effectiveSection, runId,
            blockIds: mapping.filter(m => m.start < range.end && m.end > range.start).map(m => m.block.id),
            paragraphEnd: /\n\s*\n/u.test(body.slice(range.end, spans[spans.indexOf(span) + 1]?.start ?? body.length)) || range.end === body.length,
            continuation: oversized, needsPrevious: previousCue.test(raw), terminal: terminalEnd.test(raw) });
        }
        cursor = stop;
      }
    }
    runId++;
  };
  for (const block of source.blocks) {
    const raw = text.slice(block.textStart, block.textEnd).trim();
    const isolated = furniture.get(block.id);
    if (isolated) { metadata.push({ start: block.textStart, end: block.textEnd, blockId: block.id, reason: isolated, classification: 'rule_candidate' }); continue; }
    // Recover unrecognised PDF section labels without treating arbitrary short lines as headings.
    const title = raw.replace(/^#+\s*/u, '');
    const sectionCandidate = contentRole !== 'bibliography' && block.locator.kind === 'pdf' && !raw.includes('\n') && title.length <= 65
      && (/^\d+(?:\.\d+)*\.?\s+[\p{Script=Han}A-Za-z].{0,60}$/u.test(title) || bibliographyTitle.test(title))
      && !/[，,。;；!?！？]/u.test(title);
    if (block.kind === 'heading' || sectionCandidate) {
      emit(run); run = []; headings.push({ start: block.textStart, end: block.textEnd });
      effectiveSection = block.kind === 'heading' ? block.sectionPath : title;
      contentRole = bibliographyTitle.test(title) ? 'bibliography' : 'body';
      continue;
    }
    const previous = run.at(-1);
    if (previous && ambiguousColumns(previous, block)) gaps.push(`layout_order_uncertain:${previous.id}:${block.id}`);
    if (previous && (previous.kind !== block.kind || (block.locator.kind !== 'pdf' && previous.sectionPath !== block.sectionPath))) {
      emit(run); run = [];
    }
    if (!run.length && block.locator.kind !== 'pdf') effectiveSection = block.sectionPath;
    run.push(block);
  }
  emit(run);
  // Protected neighbouring sentences travel together when they fit. No logical edge is inferred.
  const groups: ReadingUnit[][] = [];
  for (const unit of units) {
    const previous = groups.at(-1), last = previous?.at(-1);
    const pendingCondition = last && opener.test(unitText(last)) && !closer.test(unitText(last));
    if (previous && last!.runId === unit.runId && !unit.continuation && !last!.continuation
      && (unit.needsPrevious || pendingCondition) && measure(joined([...previous, unit])) <= budget.maxCoreTokens) previous.push(unit);
    else groups.push([unit]);
  }
  const windows: ArgumentReadingWindow[] = [];
  let core: ReadingUnit[] = [];
  const flush = (cutReason: string) => {
    if (!core.length) return;
    const first = core[0], last = core.at(-1)!;
    windows.push({ id: `${ARGUMENT_WINDOW_VERSION}:${source.docId}:${hash}:${first.start}:${last.end}`,
      docId: source.docId, contentHash: hash,
      kind: first.kind, sectionPath: first.sectionPath, core, before: [], after: [], cutReason,
      coreTokens: measure(joined(core)), contextTokens: 0,
      boundaryStatus: core.some(u => u.continuation) ? 'continuation' : first.kind === 'table' || first.kind === 'code' || first.contentRole === 'bibliography' ? 'unstructured'
        : first.needsPrevious || !last.terminal || (opener.test(unitText(last)) && !closer.test(unitText(last))) ? 'needs_context' : 'intact',
      gaps: [], semanticReview: 'not_performed' });
    core = [];
  };
  for (const group of groups) {
    if (core.length) {
      const last = core.at(-1)!, first = group[0];
      if (last.runId !== first.runId) flush(last.sectionPath !== first.sectionPath ? 'section_boundary' : 'kind_or_layout_boundary');
      else if (last.continuation || first.continuation) flush('continuation');
      else if (measure(joined([...core, ...group])) > budget.maxCoreTokens) flush('sentence_budget');
      else if (measure(joined(core)) >= budget.targetCoreTokens && last.paragraphEnd) flush('paragraph_boundary');
    }
    core.push(...group);
  }
  flush('end_of_source');
  for (const window of windows) {
    const first = units.indexOf(window.core[0]), last = units.indexOf(window.core.at(-1)!);
    const wantsExtra = window.boundaryStatus === 'needs_context' || units[last + 1]?.needsPrevious;
    const candidates = [units[first - 1], units[last + 1], ...(wantsExtra ? [units[first - 2], units[last + 2]] : [])].filter(Boolean);
    for (const candidate of candidates) {
      if (candidate.runId !== window.core[0].runId) continue;
      const before = candidate.start < window.core[0].start;
      const nextBefore = [...window.before, ...(before ? [candidate] : [])].sort((a, b) => a.start - b.start);
      const nextAfter = [...window.after, ...(!before ? [candidate] : [])].sort((a, b) => a.start - b.start);
      const cost = measure(joined([...nextBefore, ...nextAfter]));
      if (cost <= budget.maxContextTokens && measure(joined([...nextBefore, ...window.core, ...nextAfter])) <= budget.maxBodyTokens) {
        window.before = nextBefore; window.after = nextAfter; window.contextTokens = cost;
      } else window.gaps.push(`context_budget:${candidate.id}`);
    }
    if (window.core[0].needsPrevious && !window.before.length) window.gaps.push('unresolved_previous_context');
    if (window.boundaryStatus === 'continuation') window.gaps.push('requires_complete_parent_sentence');
    if (window.kind === 'table' || window.kind === 'list') window.gaps.push('shared_header_or_intro_not_semantically_bound');
    if (window.core[0].contentRole === 'bibliography') window.gaps.push('bibliography_not_argument_body');
    if (window.core.some(u => unbalancedDelimiters(unitText(u)))) {
      window.gaps.push('unclosed_quote_or_bracket');
      if (window.boundaryStatus === 'intact') window.boundaryStatus = 'needs_context';
    }
    for (const gap of gaps) {
      const relevant = source.blocks.some(b => (gap.includes(`${b.id}:`) || gap.endsWith(`:${b.id}`))
        && b.textStart >= window.core[0].start && b.textStart < window.core.at(-1)!.end);
      if (relevant) { window.gaps.push(gap); if (window.boundaryStatus === 'intact') window.boundaryStatus = 'needs_context'; }
    }
    if (!window.core.at(-1)!.terminal && window.kind === 'paragraph') window.gaps.push('unfinished_sentence_or_non_body_text');
    const unclosed = opener.test(unitText(window.core.at(-1)!)) && !closer.test(unitText(window.core.at(-1)!));
    if (unclosed && !window.after.length) window.gaps.push('unresolved_following_condition');
  }
  const seen = new Uint8Array(text.length);
  for (const heading of headings) for (let i = heading.start; i < heading.end; i++) seen[i] = 1;
  for (const item of metadata) for (let i = item.start; i < item.end; i++) seen[i] = 1;
  let duplicate = 0;
  for (const window of windows) for (const unit of window.core) for (const segment of unit.segments) for (let i = segment.start; i < segment.end; i++) {
    if (seen[i] && !/\s/u.test(text[i])) duplicate++;
    seen[i] = 1;
  }
  let missing = 0, nonWhitespace = 0;
  for (let i = 0; i < text.length; i++) if (!/\s/u.test(text[i])) { nonWhitespace++; if (!seen[i]) missing++; }
  return { version: ARGUMENT_WINDOW_VERSION, docId: source.docId, contentHash: hash, budget, units, headings, metadata, windows, gaps,
    checks: { sourceCoverage: nonWhitespace ? (nonWhitespace - missing) / nonWhitespace : 1, duplicateCoreCharacters: duplicate,
      missingBodyCharacters: missing, budgetPassed: windows.every(w => w.coreTokens <= budget.maxCoreTokens
        && w.contextTokens <= budget.maxContextTokens && measure(joined([...w.before, ...w.core, ...w.after])) <= budget.maxBodyTokens),
      semanticCompleteness: 'not_assessed' } };
}

export function readArgumentWindowText(source: StructuredDocument, window: ArgumentReadingWindow): { core: string; before: string; after: string } {
  if (source.docId !== window.docId || createHash('sha256').update(source.normalizedText).digest('hex') !== window.contentHash) throw new Error('argument_window_source_version_mismatch');
  const read = (units: ReadingUnit[]) => units.map(u => {
    for (const s of u.segments) if (s.start < 0 || s.end <= s.start || s.end > source.normalizedText.length) throw new Error('argument_window_invalid_segment');
    return readSegments(source.normalizedText, u.segments);
  }).join('\n');
  return { core: read(window.core), before: read(window.before), after: read(window.after) };
}
