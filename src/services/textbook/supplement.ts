import type { TextbookSource } from './generationTypes';
import { extractResourceCoreTerm } from '../resourceSearchTerm';
import { hasTeachingTable, teachingTableRanges } from './webMaterialAssessment';

/** A bounded public-topic permission, separate from remote model permission. */
export interface TextbookSupplementPolicy { version: 1; topics: string[]; domain: string; tables: boolean; images: boolean }
export interface TextbookSupplementGap { term: string; reason: 'topic' | 'table' | 'image'; query: string }
export interface TextbookSupplementRequest { jobId: string; token: string; gaps: TextbookSupplementGap[] }
export interface TextbookSupplementResult {
  snapshots: import('./webTypes').TextbookWebSnapshot[];
  warnings: string[];
  queries: string[];
}
export function textbookSupplementQuery(policy: TextbookSupplementPolicy, term: string, reason: TextbookSupplementGap['reason']): string {
  // A specific topic already carries its domain. Requiring every domain word
  // often ranks book/course catalogues over the actual illustrated article.
  const ambiguous = [...term].length <= 2 || /^[a-z]+$/iu.test(term);
  return [term, ambiguous && policy.domain !== term ? policy.domain : '', reason === 'table' ? '对照表' : reason === 'image' ? '示意图' : '百科'].filter(Boolean).join(' ').slice(0, 120);
}
export function textbookSupplementPolicy(title: string, rootTitle: string, knowledgeTitles: string[], tasks: string): TextbookSupplementPolicy | undefined {
  const core = extractResourceCoreTerm(title);
  const topics = [...new Set([core, ...knowledgeTitles.map(t => t.trim().slice(0, 60))].filter(Boolean))].slice(0, 4);
  if (!topics.length) return undefined;
  return { version: 1, topics, domain: extractResourceCoreTerm(rootTitle).slice(0, 24),
    tables: /表格|对照|比较|数据/u.test(tasks), images: /图片|图示|图解|示意|结构图|实验装置|原图/u.test(tasks) };
}
/** Count only nearby body context, never the title or the rest of an unrelated
 * long document. Merge overlapping windows so repeated terms cannot inflate it.
 * This remains a coverage hint, not a semantic correctness claim. */
function topicContextChars(text: string, term: string): number {
  if (!term) return 0;
  let count = 0, end = 0, offset = text.indexOf(term);
  while (offset >= 0) {
    const start = Math.max(0, offset - 400), nextEnd = Math.min(text.length, offset + term.length + 400);
    count += nextEnd - Math.max(start, end); end = nextEnd;
    if (count >= 1000) return count;
    offset = text.indexOf(term, offset + term.length);
  }
  return count;
}
/** Coverage hints, not semantic correctness claims. No additional model/review call. */
export function textbookSupplementGaps(policy: TextbookSupplementPolicy, sources: TextbookSource[]): TextbookSupplementGap[] {
  const gaps: Array<Pick<TextbookSupplementGap, 'term' | 'reason'>> = [];
  for (const term of policy.topics) {
    if (sources.reduce((sum, s) => sum + topicContextChars(s.text, term), 0) < 1000) gaps.push({ term, reason: 'topic' });
  }
  if (policy.tables && !sources.some(s => hasTeachingTable(s.text))) gaps.push({ term: policy.topics[0], reason: 'table' });
  if (policy.images && !sources.some(s => s.assets?.length)) gaps.push({ term: policy.topics[0], reason: 'image' });
  // At most two short searches for an entire textbook, never sixteen page refreshes.
  const topics = gaps.filter(g => g.reason === 'topic'), formats = gaps.filter(g => g.reason !== 'topic');
  return [...topics.slice(0, 1), ...formats, ...topics.slice(1)].slice(0, 2)
    .map(gap => ({ ...gap, query: textbookSupplementQuery(policy, gap.term, gap.reason) }));
}

export function textbookWebSource(snapshot: import('./webTypes').TextbookWebSnapshot, sourceId: string, maxChars = 6000): TextbookSource {
  let start = 0;
  // Preserve a useful late table in the bounded original excerpt, rather than
  // noticing it in a 20k page then dropping it from the model's first 4k input.
  const table = teachingTableRanges(snapshot.text)[0];
  if (table && table.end > maxChars && table.end - table.start < maxChars) {
    start = Math.max(0, table.end - maxChars);
    const boundary = snapshot.text.indexOf('\n\n', start); if (boundary >= start && boundary < table.start) start = boundary + 2;
  }
  let end = Math.min(snapshot.text.length, start + maxChars);
  if (end < snapshot.text.length) { const boundary = snapshot.text.lastIndexOf('\n\n', end); if (boundary > start + maxChars / 2 && (!table || boundary >= table.end)) end = boundary; }
  return { sourceId, kind: 'web', id: snapshot.resourceId, title: snapshot.title, version: snapshot.version,
    text: snapshot.text.slice(start, end), textStart: start, textEnd: end,
    web: { ...snapshot.web, coverage: start === 0 && end === snapshot.text.length ? 'full_text' : 'excerpt' },
    ...(snapshot.assets?.length ? { assets: snapshot.assets.map(asset => ({ ...asset, sourceId })) } : {}) };
}
