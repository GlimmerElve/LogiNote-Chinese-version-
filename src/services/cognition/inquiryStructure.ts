import type { CognitionGraph } from './types';
import type { InquiryPage, InquirySource } from './inquiry';
import { flowStructureMatches } from '../argumentDoc/flowStructure';

export interface InquiryAnalysisHeader {
  id: string; recordId: string; revisionId: string; branchId: string;
  current: boolean; state: 'current' | 'source_only';
  argumentTotal: number; unresolvedTotal: number;
  sourceArgumentTotal: number; sourceUnresolvedTotal: number;
  /** Normal sequential read-page protocol; no separate tool or implicit unbounded read. */
  detailPages: { start: number; end: number } | null;
}
export interface InquiryArgumentPart {
  id: string; claim: string; status: 'argued' | 'stated_only' | 'incomplete';
  support: string[]; oppose: string[]; supportTotal: number; opposeTotal: number;
  part: number; parts: number;
}
export interface InquiryUnresolvedPart { id: string; nodeId?: string; reason: string; part: number; parts: number }
export interface InquiryAnalysisChunk {
  header: InquiryAnalysisHeader;
  arguments: InquiryArgumentPart[]; unresolved: InquiryUnresolvedPart[];
  memberSourcesTotal?: number;
  memberSourcesAvailable?: number;
  memberTextsTruncated?: boolean;
}
interface AnalysisContext {
  header: InquiryAnalysisHeader; sources: InquirySource[];
  arguments: InquiryArgumentPart[]; unresolved: InquiryUnresolvedPart[];
}

/** Keep group identity/jointness even when a very large membership list needs multiple pages. */
function argumentParts(a: NonNullable<CognitionGraph['flowStructure']>['arguments'][number]): InquiryArgumentPart[] {
  const rows = [...a.support.map(id => ({ kind: 'support' as const, id })), ...a.oppose.map(id => ({ kind: 'oppose' as const, id }))];
  const chunks: typeof rows[] = [[]];
  for (const row of rows) {
    let chunk = chunks.at(-1)!;
    if (chunk.length && JSON.stringify([...chunk, row]).length > 8000) { chunk = []; chunks.push(chunk); }
    chunk.push(row);
  }
  return chunks.map((chunk, index) => ({ id: a.id, claim: a.claim, status: a.status,
    support: chunk.filter(r => r.kind === 'support').map(r => r.id), oppose: chunk.filter(r => r.kind === 'oppose').map(r => r.id),
    supportTotal: a.support.length, opposeTotal: a.oppose.length, part: index + 1, parts: chunks.length }));
}

/** Selected branch/revision only. No original raw quotes or unrelated node text are copied. */
export function inquiryAnalysisContext(graph: CognitionGraph, sources: InquirySource[], id: string): AnalysisContext | undefined {
  const source = graph.flowStructure, anchor = sources[0], ref = anchor?.reference;
  if (!source || !ref) return undefined;
  const selected = new Set(sources.map(s => s.reference!.nodeId));
  const args = source.arguments.filter(a => [a.claim, ...a.support, ...a.oppose].some(nodeId => selected.has(nodeId)));
  const pending = source.unresolved.filter(u => !u.nodeId || selected.has(u.nodeId));
  const header: InquiryAnalysisHeader = { id, recordId: ref.recordId, revisionId: ref.revisionId, branchId: ref.branchId,
    current: anchor.current === true, state: flowStructureMatches(source, graph) ? 'current' : 'source_only',
    argumentTotal: args.length, unresolvedTotal: pending.length, sourceArgumentTotal: source.arguments.length,
    sourceUnresolvedTotal: source.unresolved.length, detailPages: null };
  for (const item of sources) item.analysisStructure = header;
  return { header, sources, arguments: args.flatMap(argumentParts), unresolved: pending.flatMap((u, index) => {
    const parts = Math.max(1, Math.ceil(u.reason.length / 1000));
    return Array.from({ length: parts }, (_, part) => ({ id: `U${index + 1}`, ...(u.nodeId ? { nodeId: u.nodeId } : {}),
      reason: u.reason.slice(part * 1000, (part + 1) * 1000), part: part + 1, parts }));
  }) };
}

/** Analysis pages carry a repeat of one already-selected source so a later turn
 * can cite a current, actually reread source rather than private text from chat history.
 * Serialized budgets include escaping; dense groups remain sequentially readable.
 */
export function appendInquiryAnalysisPages(pages: InquiryPage[], contexts: AnalysisContext[]): void {
  const excerpt = ({ analysisStructure: _directory, ...s }: InquirySource): InquirySource => ({ ...s,
    text: s.text.slice(0, 400), context: s.context?.slice(0, 160), reason: s.reason?.slice(0, 160),
    truncated: s.truncated || s.text.length > 400 || (s.context?.length || 0) > 160 });
  for (const context of contexts) {
    const start = pages.length;
    let active: InquiryPage | undefined;
    const fresh = (): InquiryPage => ({ page: pages.length, sources: [excerpt(context.sources[0])], edges: [],
      analysisStructures: [{ header: context.header, arguments: [], unresolved: [] }] });
    const append = <K extends 'arguments' | 'unresolved'>(key: K, value: InquiryAnalysisChunk[K][number]) => {
      active ||= fresh();
      const chunk = active.analysisStructures![0], target = chunk[key] as Array<typeof value>;
      target.push(value);
      if (JSON.stringify(active).length > 37000 && target.length) {
        target.pop();
        if (!chunk.arguments.length && !chunk.unresolved.length) throw new Error('原始论证条目超出安全分页预算');
        pages.push(active); active = fresh();
        (active.analysisStructures![0][key] as Array<typeof value>).push(value);
        if (JSON.stringify(active).length > 37000) throw new Error('原始论证条目超出安全分页预算');
      }
    };
    context.arguments.forEach(a => append('arguments', a));
    context.unresolved.forEach(u => append('unresolved', u));
    if (active) {
      pages.push(active); context.header.detailPages = { start, end: pages.length - 1 };
      // Reread relevant member excerpts, not an unrelated first branch node.
      // Detail-page continuation never needs old chat text as citation evidence.
      for (const page of pages.slice(start)) {
        const chunk = page.analysisStructures![0];
        const ids = new Set([...chunk.arguments.flatMap(a => [a.claim, ...a.support, ...a.oppose]), ...chunk.unresolved.flatMap(u => u.nodeId ? [u.nodeId] : [])]);
        const members = context.sources.filter(s => ids.has(s.reference!.nodeId));
        const candidates = members.length ? members : [context.sources[0]];
        chunk.memberSourcesTotal = ids.size || 1;
        chunk.memberSourcesAvailable = members.length || (ids.size ? 0 : 1);
        const fallback = page.sources[0]; page.sources = [];
        for (const member of candidates) {
          if (page.sources.length >= 8) break;
          page.sources.push(excerpt(member));
          if (JSON.stringify(page).length > 47000) { page.sources.pop(); break; }
        }
        if (!page.sources.length) page.sources = [fallback];
        chunk.memberTextsTruncated = (ids.size > members.length) || page.sources.length < candidates.length || page.sources.some(s => s.truncated);
      }
    }
  }
  if (pages.some(page => page.analysisStructures && JSON.stringify(page).length > 48000)) throw new Error('原始论证分页超出安全预算');
}
