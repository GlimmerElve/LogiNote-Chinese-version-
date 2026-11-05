import type { ArgumentFunctionType, DocumentChunk, KnowledgeArgumentUnit, KnowledgeArgumentEdge } from '../../types';
import { readCoupledArgumentForQuery } from '../argumentContext/coupledArgumentQueryRead.ts';
import { hasExplicitComparisonTargetMismatch } from '../../electron/rag/knowledgeSemantics.ts';
import type {DocumentArgumentRole} from '../documentArgumentV5Types';

export interface QaGraphAnchor { docId: string; nodeId: string }
export interface QaDocumentGraphNode extends QaGraphAnchor {
  chunkId: string; fileName: string; sectionPath: string; type: ArgumentFunctionType | DocumentArgumentRole; role?:DocumentArgumentRole;
  text: string; quote: string; citationId?: string;
  graphId?: string;
  sourceParts?: Array<{chunkId: string; sectionPath: string; quote: string; citationId?: string}>;
}
export interface QaDocumentGraph {
  revision: 'qa-document-graph-v1'; adapter: 'active-knowledge-shard' | 'source-bound-document-graph' | 'source-bound-document-graph-v5' | 'mixed-document-graphs';
  nodes: QaDocumentGraphNode[];
  relations: Array<{id: string; kind: 'support' | 'oppose' | 'explain' | 'context' | 'method_for' | 'relates'; from: string[]; to: string; reason?: string}>;
  omissions: Array<{id: string; reason: string}>;
  limitations: string[]; semanticCertified: false;
  /** Retrieval-only audit. Not persisted in the source graph or sent as model reasoning. */
  retrievalTrace?: {strategy:string;intent:string;entries:Array<{nodeId:string;status:'kept'|'omitted'}>;
    paths:Array<{entryId:string;nodeId:string;nodeIds:string[];relationIds:string[];depth:number}>;
    events:Array<{id:string;reason:string;entryId:string;depth?:number;branchPenalty?:number}>};
}
export const QA_GRAPH_LIMITS = { anchors: 8, nodes: 24, relations: 36, characters: 12000 } as const;
export function emptyQaDocumentGraph(reason: string): QaDocumentGraph {
  return {revision: 'qa-document-graph-v1', adapter: 'active-knowledge-shard', nodes: [], relations: [],
    omissions: [{id: '(graph)', reason}], limitations: ['旧索引仅包含已保存的支持/反对；没有解释关系或跨图关系不等于原文不存在。'], semanticCertified: false};
}

/** Keep source text once in model context; quote is an internal replay/citation field. */
export function qaDocumentGraphForPrompt(graph: QaDocumentGraph | undefined) {
  if (!graph) return undefined;
  const {retrievalTrace:_audit,...context}=graph;
  return {...context, nodes: graph.nodes.map(({quote: _quote, sourceParts, ...node}) => {
    let offset = 0;
    return {...node, ...(sourceParts ? {sourceParts:sourceParts.map(({quote, ...s},i) => {
      if (i) offset++;
      const textStart=offset; offset+=quote.length; return {...s,textStart,textEnd:offset};
    })} : {})};
  })};
}
export function validateQaGraphAnchors(raw: unknown): QaGraphAnchor[] {
  if (!Array.isArray(raw) || raw.length > QA_GRAPH_LIMITS.anchors) throw new Error('qa_graph_anchor_budget');
  const seen = new Set<string>();
  return raw.map(a => {
    if (!a || typeof a !== 'object' || Object.keys(a).sort().join('|') !== 'docId|nodeId'
      || typeof a.docId !== 'string' || !/^[A-Za-z0-9._-]{1,160}$/u.test(a.docId)
      || typeof a.nodeId !== 'string' || !a.nodeId.trim() || a.nodeId.length > 500) throw new Error('qa_graph_invalid_anchor');
    const key = JSON.stringify([a.docId, a.nodeId]); if (seen.has(key)) throw new Error('qa_graph_duplicate_anchor'); seen.add(key);
    return {docId: a.docId, nodeId: a.nodeId};
  });
}

/** Structural boundary only; never certifies semantic correctness of saved edges. */
export function readQaDocumentGraphPacket(raw: unknown, citationIds: Set<string>): QaDocumentGraph | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const g = raw as QaDocumentGraph;
  if (g.revision !== 'qa-document-graph-v1' || !['active-knowledge-shard','source-bound-document-graph','source-bound-document-graph-v5','mixed-document-graphs'].includes(g.adapter) || g.semanticCertified !== false
    || !Array.isArray(g.nodes) || g.nodes.length > QA_GRAPH_LIMITS.nodes
    || !Array.isArray(g.relations) || g.relations.length > QA_GRAPH_LIMITS.relations
    || !Array.isArray(g.omissions) || !Array.isArray(g.limitations)) return undefined;
  const ids = new Set<string>(); let chars = 0;
  for (const n of g.nodes) {
    if (!n || typeof n.docId !== 'string' || typeof n.nodeId !== 'string' || ids.has(n.nodeId)
      || typeof n.text !== 'string' || n.quote !== n.text || typeof n.type !== 'string'
      || typeof n.chunkId !== 'string' || typeof n.fileName !== 'string' || typeof n.sectionPath !== 'string'
      || !n.citationId || !citationIds.has(n.citationId)) return undefined;
    ids.add(n.nodeId); chars += n.text.length;
    if (n.sourceParts !== undefined && (!Array.isArray(n.sourceParts) || !n.sourceParts.length || n.sourceParts.length > 64
      || n.sourceParts.some(s => !s || typeof s.chunkId !== 'string' || typeof s.sectionPath !== 'string'
        || typeof s.quote !== 'string' || !s.citationId || !citationIds.has(s.citationId))
      || n.sourceParts.map(s => s.quote).join('\n') !== n.text)) return undefined;
  }
  if (chars > QA_GRAPH_LIMITS.characters) return undefined;
  const edgeIds = new Set<string>();
  for (const r of g.relations) {
    const auditOnlyV5=r&&Array.isArray(r.from)&&[...r.from,r.to].every(id=>typeof id==='string'&&id.startsWith('dg5:'));
    if (!r || typeof r.id !== 'string' || edgeIds.has(r.id) || !['support', 'oppose', 'explain', 'context', 'method_for', 'relates'].includes(r.kind)
      || !Array.isArray(r.from) || !r.from.length || r.from.length > 12
      || !auditOnlyV5&&(new Set(r.from).size !== r.from.length||r.from.includes(r.to))
      || [...r.from, r.to].some(id => !ids.has(id))) return undefined;
    edgeIds.add(r.id);
  }
  if (g.limitations.some(s => typeof s !== 'string') || g.omissions.some(o => !o || typeof o.id !== 'string' || typeof o.reason !== 'string')) return undefined;
  const audit=g.retrievalTrace;
  if(audit!==undefined&&(!audit||typeof audit.strategy!=='string'||typeof audit.intent!=='string'
    ||!Array.isArray(audit.entries)||audit.entries.length>QA_GRAPH_LIMITS.anchors
    ||!Array.isArray(audit.paths)||audit.paths.length>192||!Array.isArray(audit.events)||audit.events.length>192
    ||audit.entries.some(e=>!e||typeof e.nodeId!=='string'||!['kept','omitted'].includes(e.status))
    ||audit.paths.some(p=>!p||typeof p.entryId!=='string'||typeof p.nodeId!=='string'
      ||!Array.isArray(p.nodeIds)||!p.nodeIds.length||p.nodeIds.length>QA_GRAPH_LIMITS.nodes
      ||!Array.isArray(p.relationIds)||p.relationIds.length!==p.depth||p.nodeIds.length!==p.depth+1
      ||p.nodeIds[0]!==p.entryId||p.nodeIds.at(-1)!==p.nodeId||p.nodeIds.some(id=>!ids.has(id))
      ||p.relationIds.some((id,i)=>{const r=g.relations.find(r=>r.id===id);return !r||![...r.from,r.to].includes(p.nodeIds[i])||![...r.from,r.to].includes(p.nodeIds[i+1]);}))
    ||audit.events.some(e=>!e||typeof e.id!=='string'||typeof e.reason!=='string'||typeof e.entryId!=='string')))return undefined;
  return g;
}

/** Read-only adapter. Source text is replayed from current L1 sentences; no inferred edges or identities. */
export function buildQaDocumentGraph(input: {anchors: QaGraphAnchor[]; chunks: DocumentChunk[];
  units: KnowledgeArgumentUnit[]; edges: KnowledgeArgumentEdge[]}): QaDocumentGraph {
  const anchors = validateQaGraphAnchors(input.anchors), out = emptyQaDocumentGraph('no_saved_graph');
  out.omissions = [];
  const wanted = new Set(anchors.map(a => a.docId)), chunks = new Map(input.chunks.map(c => [c.id, c]));
  const byId = new Map<string, QaDocumentGraphNode>();
  const duplicates = new Set<string>();
  for (const u of input.units) {
    if (!wanted.has(u.docId) || u.admission !== 'admitted' || u.origin !== 'imported-document-extraction') continue;
    const c = chunks.get(u.chunkId);
    const spans = u.sentenceIds.map(id => c?.sentenceSpans?.find(s => s.id === id));
    const positions = u.sentenceIds.map(id => c?.sentenceSpans?.findIndex(s => s.id === id) ?? -1);
    const base = c?.textStart || 0;
    if (!c || c.docId !== u.docId || !spans.length || positions.some((p, i) => p < 0 || (i > 0 && p !== positions[i-1] + 1))
      || spans.some(s => !s || !Number.isSafeInteger(s.textStart)
      || !Number.isSafeInteger(s.textEnd) || s.textStart < base || s.textEnd <= s.textStart || s.textEnd-base > c.content.length)) continue;
    const text = spans.map(s => c.content.slice(s!.textStart-base, s!.textEnd-base).trim()).filter(Boolean).join('\n');
    if (!text || text !== u.text || Math.min(...spans.map(s => s!.textStart)) !== u.textStart
      || Math.max(...spans.map(s => s!.textEnd)) !== u.textEnd) continue;
    if (byId.has(u.id)) {duplicates.add(u.id); continue;}
    byId.set(u.id, {docId: u.docId, nodeId: u.id, chunkId: c.id, fileName: c.fileName,
      sectionPath: c.sectionPath, type: u.mainType, text, quote: text});
  }
  for (const id of duplicates) byId.delete(id);
  const edges = input.edges.filter(e => e.admission === 'admitted' && (e.relation === 'support' || e.relation === 'oppose')
    && byId.get(e.sourceArgumentId)?.docId === e.docId && byId.get(e.targetArgumentId)?.docId === e.docId
    && e.sourceArgumentId !== e.targetArgumentId
    && !(e.relation === 'oppose' && hasExplicitComparisonTargetMismatch(byId.get(e.sourceArgumentId)!.text, byId.get(e.targetArgumentId)!.text)));
  const signatures = new Set<string>(), edgeIds = new Set<string>();
  const relations = edges.flatMap(e => {
    const key = JSON.stringify([e.relation, e.sourceArgumentId, e.targetArgumentId]);
    if (signatures.has(key) || edgeIds.has(e.id)) return [];
    signatures.add(key); edgeIds.add(e.id);
    return [{id: e.id, kind: e.relation, from: [e.sourceArgumentId], to: e.targetArgumentId}];
  });
  const seeds = anchors.filter(a => byId.get(a.nodeId)?.docId === a.docId).map(a => a.nodeId);
  for (const a of anchors) if (!seeds.includes(a.nodeId)) out.omissions.push({id: a.nodeId, reason: 'node_unavailable_or_source_changed'});
  if (!seeds.length) return out;
  const graph = {nodes: [...byId.values()].map(n => ({id: n.nodeId, type: n.type as ArgumentFunctionType, text: n.text})), relations};
  const read = readCoupledArgumentForQuery(graph, seeds, {maxNodes: QA_GRAPH_LIMITS.nodes,
    maxRelations: QA_GRAPH_LIMITS.relations, contextDepth: 1, supportDirection: 'both'});
  // Preserve whole nodes; skip rather than slice source statements. Incomplete edges never survive clipping.
  let characters = 0;
  const ordered = [...seeds, ...read.nodeIds.filter(id => !seeds.includes(id))];
  for (const id of ordered) {
    const n = byId.get(id)!;
    if (characters+n.text.length > QA_GRAPH_LIMITS.characters) {out.omissions.push({id, reason: 'character_budget'}); continue;}
    out.nodes.push(n); characters += n.text.length;
  }
  const selected = new Set(out.nodes.map(n => n.nodeId));
  for (const r of read.relations) {
    if ([...r.from, r.to].every(id => selected.has(id))) out.relations.push({...r, kind: r.kind as 'support' | 'oppose'});
    else out.omissions.push({id: r.id, reason: 'endpoint_omitted'});
  }
  out.omissions.push(...read.omissions.map(o => ({id: o.relationId, reason: o.reason})));
  return out;
}
