import type { DocumentQueryIntent, DocumentSearchResult } from '../../types';

/** Host-only ablation switches. Never part of extraction, storage, or IPC options. */
export type DocumentRetrievalStrategy = 'legacy' | 'direct' | 'layered' | 'intent';
export const DEFAULT_DOCUMENT_RETRIEVAL_STRATEGY: DocumentRetrievalStrategy = 'intent';
export const RETRIEVAL_HEAD_GUARANTEE = 1;

export function retrievalQueryIntent(query: string): DocumentQueryIntent {
  const q = query.toLocaleLowerCase();
  if (/(反例|反对|削弱|质疑|局限|缺陷|争议|不同观点|反驳|怎样回应|如何回应|oppose|counterexample|objection)/u.test(q)) return 'opposition';
  if (/(支持|依据|证据|论据|证明|支撑|理由|support|evidence)/u.test(q)) return 'support';
  if (/(为什么|为何|原因|缘由|因果|怎么会|why|because|reason)/u.test(q)) return 'reason';
  if (/(区别|差异|异同|对比|比较|相比|versus|\bvs\.?\b|compare)/u.test(q)) return 'comparison';
  // Explicit relational questions outrank “是什么”, but a concept named 关系 does not.
  if (/(什么关系|关系是什么|有何关系|之间.{0,8}(关系|联系)|关系如何|关系怎样|的关系)/u.test(q)) return 'entity_relation';
  if (/(什么是|是什么|什么意思|是什么意思|何谓|定义|含义|概念|define|definition|meaning)/u.test(q)) return 'definition';
  if (/(关联|联系|属于|包含|组成|依赖|影响|relation|related)/u.test(q)) return 'entity_relation';
  if (/(如何|怎么做|怎样|应用|实践|步骤|方案|用法|apply|application|how to)/u.test(q)) return 'application';
  if (/(是否|何时|多少|哪一|事实|数据|fact|when|where|which)/u.test(q)) return 'fact';
  return 'general';
}

/** Conservative lexical facets, not a semantic model or a claim about the answer. */
export function retrievalQueryFacets(query: string): string[] {
  const parts = query.split(/[？?；;、]|并(?:且)?|以及|同时/u).map(s => s.trim()).filter(s => s.length >= 6);
  return parts.length > 1 ? [...new Set(parts)].slice(0, 4) : [];
}

export type RetrievalEntryCandidate = NonNullable<DocumentSearchResult['documentGraphEntryCandidates']>[number];
const validRank=(rank:unknown):rank is number=>Number.isSafeInteger(rank)&&Number(rank)>0;

/** Keep independent channel heads before the shared ranking fills remaining slots. */
export function selectRetrievalEntries(candidates: RetrievalEntryCandidate[], limit: number): RetrievalEntryCandidate[] {
  const byId = new Map<string, RetrievalEntryCandidate>();
  for (const c of candidates) {
    const key = JSON.stringify([c.docId, c.nodeId]);
    const old = byId.get(key);
    if (!old) byId.set(key, { ...c, channels: [...c.channels] });
    else {
      old.score = Math.max(old.score, c.score);
      old.channels = [...new Set([...old.channels, ...c.channels])];
    }
  }
  const ranked = [...byId.values()].sort((a,b) => b.score-a.score || a.nodeId.localeCompare(b.nodeId));
  const selected = new Set<RetrievalEntryCandidate>();
  const nominate = (list: RetrievalEntryCandidate[]) => {
    for (const c of list.slice(0, RETRIEVAL_HEAD_GUARANTEE)) if (selected.size < limit) selected.add(c);
  };
  nominate(ranked);
  nominate(ranked.filter(c=>validRank(c.denseRank)).sort((a,b)=>a.denseRank!-b.denseRank!));
  nominate(ranked.filter(c=>validRank(c.sparseRank)).sort((a,b)=>a.sparseRank!-b.sparseRank!));
  const facets = Math.max(0, ...ranked.map(c=>c.facetRanks?.length || 0));
  for (let f=0;f<facets;f++) nominate(ranked.filter(c=>validRank(c.facetRanks?.[f]))
    .sort((a,b)=>a.facetRanks![f]-b.facetRanks![f]));
  for (const c of ranked) if (selected.size < limit) selected.add(c);
  return [...selected].sort((a,b)=>b.score-a.score || a.nodeId.localeCompare(b.nodeId));
}

/** Preserve one head per available route; remaining slots use the common ranking. */
export function mergeRetrievalRoutes(ranked: DocumentSearchResult[], passageIds: string[], argumentIds: string[], limit: number,
  quoteKey: (hit: DocumentSearchResult)=>string): DocumentSearchResult[] {
  const selected = new Set<DocumentSearchResult>(), keys = new Set<string>();
  const add = (hit: DocumentSearchResult | undefined) => {
    if (!hit || selected.size >= limit) return;
    const key = quoteKey(hit);
    if (keys.has(key)) {
      const existing = [...selected].find(h=>quoteKey(h)===key)!;
      existing.matchKinds = [...new Set([...(existing.matchKinds || []), ...(hit.matchKinds || [])])];
      return;
    }
    if ([...selected].filter(h=>h.docId===hit.docId).length >= 3) return;
    selected.add({...hit}); keys.add(key);
  };
  // A one-result API cannot guarantee both routes. Keep its best common-ranked hit.
  if (limit===1) add(ranked[0]);
  else {
    for (const route of [passageIds,argumentIds]) {
      const head=route.map(id=>ranked.find(h=>h.chunkId===id)).find(Boolean);
      add(head);
    }
  }
  for (const hit of ranked) add(hit);
  return [...selected].sort((a,b)=>b.score-a.score);
}
