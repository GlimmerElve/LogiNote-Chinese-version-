import type { DocumentSearchResult } from '../../types';
import type { QaEvidenceResult, QaEvidenceSource } from './tools/qaTools';
import { QA_GRAPH_LIMITS, type QaDocumentGraph, type QaGraphAnchor } from './qaDocumentGraph';
import { selectRetrievalEntries } from './documentRetrievalPolicy';

export const QA_SOURCE_LIMIT = 36;
export const qaSourceKey = (s: QaEvidenceSource) => JSON.stringify([s.type, s.entityId, s.chunkId || '']);
export const qaNodeKey = (n: QaGraphAnchor) => JSON.stringify([n.docId, n.nodeId]);

export function qaGraphAnchorsFromHits(hits: DocumentSearchResult[]): QaGraphAnchor[] {
  const seen = new Set<string>();
  const native = hits.flatMap(h => (h.documentGraphAnchors || []).filter(a => a.docId === h.docId));
  const independent = hits.flatMap(h => (h.documentGraphEntryCandidates || []).filter(a => a.docId === h.docId));
  const preferred = independent.length ? selectRetrievalEntries(independent, QA_GRAPH_LIMITS.anchors)
    .map(({docId,nodeId})=>({docId,nodeId})) : native;
  const legacy = hits.flatMap(h => (h.arguments || []).map(n => ({...n, docId: h.docId})))
    .sort((a, b) => Number(b.match === 'direct') - Number(a.match === 'direct'))
    .filter(n => n.admission === 'admitted')
    .map(n => ({docId:n.docId,nodeId:n.argumentId}));
  return [...preferred,...legacy].flatMap(a => {
      const key = qaNodeKey(a);
      if (seen.has(key)) return []; seen.add(key); return [a];
    }).slice(0, QA_GRAPH_LIMITS.anchors);
}

/** Keep stable citations, full node statements and only relations whose endpoints survived. */
export function attachQaDocumentGraph(evidence: QaEvidenceResult, graph: QaDocumentGraph): QaEvidenceResult {
  const sources = evidence.sources.map(s => ({...s}));
  let nextId = Math.max(0, ...sources.map(s => /^D(\d+)$/u.exec(s.sourceId)).filter(Boolean).map(m => Number(m![1]))) + 1;
  const omissions = [...graph.omissions];
  const nodes = graph.nodes.flatMap(n => {
    const parts = n.sourceParts || [{chunkId:n.chunkId, sectionPath:n.sectionPath, quote:n.quote}];
    const missing = new Set(parts.filter(p => !sources.some(s => s.type === 'document' && s.entityId === n.docId && s.chunkId === p.chunkId)).map(p => p.chunkId));
    if (sources.length + missing.size > QA_SOURCE_LIMIT) {omissions.push({id:n.nodeId, reason:'citation_source_budget'}); return [];}
    const cited = parts.map(p => {
      let source = sources.find(s => s.type === 'document' && s.entityId === n.docId && s.chunkId === p.chunkId);
      if (!source) {
        source = {sourceId: `D${nextId++}`, type: 'document', entityId: n.docId, chunkId: p.chunkId,
        title: n.fileName, sectionPath: p.sectionPath, snippet: p.quote.slice(0, 900), score: 0,
        matchKinds: ['argument'], evidenceOrigin: 'imported-document-extraction', admission: 'admitted'};
        sources.push(source);
      }
      return {...p, citationId:source.sourceId};
    });
    return [{...n, citationId:cited[0].citationId, ...(n.sourceParts ? {sourceParts:cited} : {})}];
  });
  const ids = new Set(nodes.map(n => n.nodeId));
  const relations = graph.relations.filter(r => [...r.from, r.to].every(id => ids.has(id)));
  const edgeIds=new Set(relations.map(r=>r.id));
  const retrievalTrace=graph.retrievalTrace?{...graph.retrievalTrace,
    entries:graph.retrievalTrace.entries.map(e=>({...e,status:ids.has(e.nodeId)?'kept' as const:'omitted' as const})),
    paths:graph.retrievalTrace.paths.filter(p=>p.nodeIds.every(id=>ids.has(id))&&p.relationIds.every(id=>edgeIds.has(id)))}:undefined;
  return {...evidence, sources, sourceIds: [...new Set(sources.map(s => `${s.type}:${s.entityId}`))],
    documentGraph: {...graph, nodes, relations, omissions,...(retrievalTrace?{retrievalTrace}:{})}};
}
