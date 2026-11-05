import type { LlmTool, DocumentSearchResult } from '../../types';
import type { QaEvidenceResult } from './tools/qaTools';
import { buildQaEvidenceResult } from './tools/qaTools';
import { QA_GRAPH_LIMITS, emptyQaDocumentGraph, validateQaGraphAnchors, type QaDocumentGraph, type QaGraphAnchor } from './qaDocumentGraph';
import { attachQaDocumentGraph, qaGraphAnchorsFromHits, qaNodeKey, qaSourceKey, QA_SOURCE_LIMIT } from './qaGraphEvidence';

export const QA_SUPPLEMENT_TOOL: LlmTool = {
  name: 'request_more_qa_evidence',
  description: '仅当本轮参考物料缺少回答所需信息时补检索一次。expand按已返回的docId/nodeId追溯真实图；search用明确实体、条件改写查询找正文。不能改图、评分或读取个人认知。补检索后必须回答或说明缺口，不能继续请求。',
  parameters: {type: 'object', additionalProperties: false, required: ['mode', 'missingMaterial'], properties: {
    mode: {type: 'string', enum: ['expand', 'search']},
    missingMaterial: {type: 'string', description: '缺少的具体依据、条件、结果或对象；非笼统要求更多资料。'},
    query: {type: 'string', description: 'search模式的具体改写查询，最多500字符。'},
    anchors: {type: 'array', maxItems: 8, items: {type: 'object', additionalProperties: false,
      required: ['docId', 'nodeId'], properties: {docId: {type: 'string'}, nodeId: {type: 'string'}}}},
  }},
};
export const QA_SUPPLEMENT_GUIDANCE = `
【有界补检索】
目标：依据已给原文和真实图回答，而非默认继续搜索。
选择：结论缺依据→expand，引用图中真实docId/nodeId；入口不对或对象不明→search，明确实体、条件改写查询。
边界：每轮最多补一次，失败也消耗额度；不能改图或开启个人认知通道。节点数量、coverage或保存关系不证明语义充分或资料为真。
结束：补检索后回答；无新增或仍缺材料则明确说明缺口，不再请求。`;

export interface QaSupplementResult extends QaEvidenceResult {
  supplement: {status: 'added' | 'no_new_material'; remaining: 0; addedSources: number; addedNodes: number; addedRelations: number};
}
export interface QaSupplementDependencies {
  search: (query: string, limit: number) => Promise<DocumentSearchResult[]>;
  readGraph: (anchors: QaGraphAnchor[], query?:string, intentQuery?:string) => Promise<QaDocumentGraph>;
}

/** Immutable, loss-aware merge. Old citations and verified source text never get overwritten. */
export function mergeQaSupplement(base: QaEvidenceResult, incoming: QaEvidenceResult): QaSupplementResult {
  // A rewritten query can find a NEW excerpt in the SAME chunk. Keep both excerpts
  // under stable separate citation IDs instead of silently discarding the new answer material.
  const contentKey = (s: QaEvidenceResult['sources'][number]) => JSON.stringify([qaSourceKey(s), s.snippet]);
  const sources = base.sources.map(s => ({...s})), keys = new Set(sources.map(contentKey));
  let nextId = Math.max(0, ...sources.map(s => /^D(\d+)$/u.exec(s.sourceId)).filter(Boolean).map(m => Number(m![1]))) + 1;
  const warnings = [...new Set([...base.warnings, ...incoming.warnings])];
  for (const s of incoming.sources) {
    if (keys.has(contentKey(s))) continue;
    if (sources.length >= QA_SOURCE_LIMIT) {warnings.push('补检索来源预算已满，未加入部分新来源。'); break;}
    keys.add(contentKey(s)); sources.push({...s, sourceId: `D${nextId++}`});
  }
  const graph = base.documentGraph || emptyQaDocumentGraph('initial_graph_unavailable');
  const nodes = graph.nodes.map(n => ({...n})), nodeIds = new Map(nodes.map(n => [n.nodeId, n]));
  const omissions = [...graph.omissions, ...(incoming.documentGraph?.omissions || [])];
  let chars = nodes.reduce((n, s) => n + s.text.length, 0);
  for (const n of incoming.documentGraph?.nodes || []) {
    const previous = nodeIds.get(n.nodeId);
    if (previous) {
      if (qaNodeKey(previous) !== qaNodeKey(n) || previous.text !== n.text || previous.chunkId !== n.chunkId)
        throw new Error('qa_supplement_source_changed');
      continue;
    }
    if (nodes.length >= QA_GRAPH_LIMITS.nodes || chars + n.text.length > QA_GRAPH_LIMITS.characters) {
      omissions.push({id: n.nodeId, reason: 'supplement_graph_budget'}); continue;
    }
    nodes.push({...n}); nodeIds.set(n.nodeId, n); chars += n.text.length;
  }
  const relations = graph.relations.map(r => ({...r, from: [...r.from]}));
  const signature = (r: QaDocumentGraph['relations'][number]) => JSON.stringify([r.kind, [...r.from].sort(), r.to]);
  const relationKeys = new Set(relations.map(signature)), relationIds = new Set(relations.map(r => r.id));
  for (const r of incoming.documentGraph?.relations || []) {
    if (relationKeys.has(signature(r))) continue;
    if (relationIds.has(r.id) || relations.length >= QA_GRAPH_LIMITS.relations || [...r.from, r.to].some(id => !nodeIds.has(id))) {
      omissions.push({id: r.id, reason: 'supplement_relation_budget_or_conflict'}); continue;
    }
    relations.push({...r, from: [...r.from]}); relationKeys.add(signature(r)); relationIds.add(r.id);
  }
  const coverage = base.coverage === 'insufficient' && sources.length ? 'partial' : base.coverage;
  const result = attachQaDocumentGraph({...base, coverage, sources, warnings}, {...graph, nodes, relations,
    adapter: graph.adapter === incoming.documentGraph?.adapter || !incoming.documentGraph ? graph.adapter : 'mixed-document-graphs',
    omissions: omissions.slice(0, 128), limitations: [...new Set([...graph.limitations, ...(incoming.documentGraph?.limitations || [])])]});
  const addedSources = result.sources.length - base.sources.length;
  const addedNodes = result.documentGraph!.nodes.length - (base.documentGraph?.nodes.length || 0);
  const addedRelations = result.documentGraph!.relations.length - (base.documentGraph?.relations.length || 0);
  return {...result, supplement: {status: addedSources || addedNodes || addedRelations ? 'added' : 'no_new_material',
    remaining: 0, addedSources, addedNodes, addedRelations}};
}

/** Per-turn capability, not a global tool. Claim budget before validation/IO to stop retries and races. */
export function createQaSupplementSession(base: QaEvidenceResult, deps: QaSupplementDependencies, alreadyUsed = false) {
  let used = alreadyUsed;
  return {
    get available() { return !used; },
    async execute(raw: Record<string, unknown>): Promise<QaSupplementResult> {
      if (used) throw new Error('qa_supplement_budget_exhausted');
      used = true;
      if (Object.keys(raw).some(k => !['mode', 'missingMaterial', 'query', 'anchors'].includes(k))
        || typeof raw.missingMaterial !== 'string' || !raw.missingMaterial.trim() || raw.missingMaterial.length > 500)
        throw new Error('qa_supplement_invalid_request');
      let incoming: QaEvidenceResult;
      if (raw.mode === 'expand') {
        if (raw.query !== undefined) throw new Error('qa_supplement_invalid_request');
        const anchors = validateQaGraphAnchors(raw.anchors);
        if (!anchors.length || anchors.some(a => !base.documentGraph?.nodes.some(n => qaNodeKey(n) === qaNodeKey(a))))
          throw new Error('qa_supplement_unknown_anchor');
        incoming = {...base, sources: [], sourceIds: [], documentGraph: await deps.readGraph(anchors,base.question)};
      } else if (raw.mode === 'search') {
        if (raw.anchors !== undefined || typeof raw.query !== 'string' || !raw.query.trim() || raw.query.length > 500)
          throw new Error('qa_supplement_invalid_query');
        const hits = await deps.search(raw.query.trim(), 6);
        incoming = buildQaEvidenceResult({question: base.question, requestedScope: 'global', noteResults: [], documentResults: hits});
        const anchors = qaGraphAnchorsFromHits(hits);
        if (anchors.length) {
          try { incoming = attachQaDocumentGraph(incoming, await deps.readGraph(anchors,raw.query.trim(),base.question)); }
          catch { incoming.warnings.push('补检索的图不可读，已保留正文，不把缺图视为缺依据。'); }
        }
      } else throw new Error('qa_supplement_invalid_mode');
      // Personal cognition, question and scope stay on their original authorized channel.
      return mergeQaSupplement(base, incoming);
    },
  };
}
