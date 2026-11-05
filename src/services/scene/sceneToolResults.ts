import type { DocumentSearchResult, NoteSearchResult } from '../../types';
import type { CognitionHit, CognitionNeighbor } from '../cognition/retrieval';
import { QA_GRAPH_LIMITS, type QaDocumentGraph } from '../agent/qaDocumentGraph';

/** Reject malformed transport values; never stringify objects into apparently valid evidence. */
export class SceneToolResultError extends Error {
  constructor() { super('工具返回数据未通过运行时校验。'); this.name = 'SceneToolResultError'; }
}
const invalid = (): never => { throw new SceneToolResultError(); };
function object(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : invalid();
}
function text(raw: unknown, required = false): string {
  return typeof raw === 'string' && (!required || Boolean(raw.trim())) ? raw : invalid();
}
function number(raw: unknown): number { return typeof raw === 'number' && Number.isFinite(raw) ? raw : invalid(); }
function bool(raw: unknown): boolean { return typeof raw === 'boolean' ? raw : invalid(); }
function list(raw: unknown, max = 200): unknown[] { return Array.isArray(raw) && raw.length <= max ? raw : invalid(); }
function optionalText(raw: unknown): string | undefined { return raw === undefined ? undefined : text(raw); }
function enumValue<T extends string>(raw: unknown, values: readonly T[]): T {
  return typeof raw === 'string' && values.includes(raw as T) ? raw as T : invalid();
}

type SceneNoteResult = Pick<NoteSearchResult, 'noteId' | 'title' | 'snippet' | 'score' | 'noteType'> & { containsUserArgument: boolean };
export function readSceneNoteResults(raw: unknown): SceneNoteResult[] {
  return list(raw).map(item => {
    const hit = object(item);
    const evidenceOrigin = hit.evidenceOrigin === undefined ? undefined : enumValue(hit.evidenceOrigin, ['note-passage', 'user-argument-doc']);
    const matchKinds = hit.matchKinds === undefined ? [] : list(hit.matchKinds).map(kind => enumValue(kind, ['note', 'argument']));
    const argumentsPresent = hit.argumentHits === undefined ? false : list(hit.argumentHits).length > 0;
    return {
      noteId: text(hit.noteId, true), title: text(hit.title), snippet: text(hit.snippet), score: number(hit.score),
      noteType: hit.noteType === undefined ? undefined : enumValue(hit.noteType, ['knowledge', 'project']),
      containsUserArgument: evidenceOrigin === 'user-argument-doc' || matchKinds.includes('argument') || argumentsPresent,
    };
  });
}

export function readSceneDocumentResults(raw: unknown): DocumentSearchResult[] {
  return list(raw).map(item => {
    const hit = object(item), docId = text(hit.docId, true);
    return {
      docId, fileName: text(hit.fileName), chunkId: text(hit.chunkId, true), sectionPath: text(hit.sectionPath),
      snippet: text(hit.snippet), score: number(hit.score),
      documentGraphAnchors: hit.documentGraphAnchors === undefined ? undefined : list(hit.documentGraphAnchors).map(rawAnchor => {
        const anchor = object(rawAnchor); return { docId: text(anchor.docId, true), nodeId: text(anchor.nodeId, true) };
      }),
      documentGraphEntryCandidates: hit.documentGraphEntryCandidates === undefined ? undefined : list(hit.documentGraphEntryCandidates).map(rawCandidate => {
        const candidate = object(rawCandidate);
        return { docId: text(candidate.docId, true), nodeId: text(candidate.nodeId, true), score: number(candidate.score),
          channels: list(candidate.channels).map(channel => enumValue(channel, ['argument', 'dense', 'sparse', 'facet'])),
          denseRank: candidate.denseRank === undefined ? undefined : number(candidate.denseRank),
          sparseRank: candidate.sparseRank === undefined ? undefined : number(candidate.sparseRank),
          facetRanks: candidate.facetRanks === undefined ? undefined : list(candidate.facetRanks).map(rank => rank === undefined ? undefined : number(rank)),
        };
      }),
      arguments: hit.arguments === undefined ? undefined : list(hit.arguments).map(rawArgument => {
        const argument = object(rawArgument);
        return { argumentId: text(argument.argumentId, true), mainType: text(argument.mainType, true), text: text(argument.text),
          confidence: number(argument.confidence), origin: enumValue(argument.origin, ['imported-document-extraction']),
          admission: enumValue(argument.admission, ['admitted']), match: enumValue(argument.match, ['direct', 'expanded']) };
      }),
    } as DocumentSearchResult;
  });
}

export function readSceneDocumentGraph(raw: unknown): QaDocumentGraph {
  const graph = object(raw);
  if (graph.revision !== 'qa-document-graph-v1' || graph.semanticCertified !== false) invalid();
  const nodes = list(graph.nodes, QA_GRAPH_LIMITS.nodes).map(rawNode => {
    const node = object(rawNode);
    return { docId: text(node.docId, true), nodeId: text(node.nodeId, true), chunkId: text(node.chunkId, true),
      fileName: text(node.fileName), sectionPath: text(node.sectionPath), type: text(node.type, true), text: text(node.text), quote: text(node.quote),
      sourceParts: node.sourceParts === undefined ? undefined : list(node.sourceParts, QA_GRAPH_LIMITS.nodes).map(rawPart => {
        const part = object(rawPart);
        return { chunkId: text(part.chunkId, true), sectionPath: text(part.sectionPath), quote: text(part.quote) };
      }) };
  });
  if (new Set(nodes.map(node => node.nodeId)).size !== nodes.length) invalid();
  const relations = list(graph.relations, QA_GRAPH_LIMITS.relations).map(rawRelation => {
    const relation = object(rawRelation);
    return { id: text(relation.id, true), kind: enumValue(relation.kind, ['support', 'oppose', 'explain', 'context', 'method_for', 'relates']),
      from: list(relation.from, QA_GRAPH_LIMITS.nodes).map(id => text(id, true)), to: text(relation.to, true), reason: optionalText(relation.reason) };
  });
  if (new Set(relations.map(relation => relation.id)).size !== relations.length) invalid();
  return { revision: 'qa-document-graph-v1', adapter: enumValue(graph.adapter,
    ['active-knowledge-shard', 'source-bound-document-graph', 'source-bound-document-graph-v5', 'mixed-document-graphs']),
    nodes: nodes as QaDocumentGraph['nodes'], relations, semanticCertified: false,
    omissions: list(graph.omissions).map(rawOmission => { const omission = object(rawOmission); return { id: text(omission.id), reason: text(omission.reason) }; }),
    limitations: list(graph.limitations).map(value => text(value)),
  };
}

type SceneCognitionHit = Pick<CognitionHit, 'recordId' | 'title' | 'text' | 'stance' | 'needsReview' | 'context'> & {
  neighbors?: Pick<CognitionNeighbor, 'relation' | 'text'>[];
};
export function readSceneCognitionResults(raw: unknown): { status: 'ready' | 'unavailable'; items: SceneCognitionHit[] } {
  const retrieval = object(raw), status = enumValue(retrieval.status, ['ready', 'unavailable']);
  if (status === 'unavailable') return { status, items: [] };
  return { status, items: list(retrieval.items).map(rawItem => {
    const item = object(rawItem);
    number(item.score);
    return { recordId: text(item.recordId, true), title: text(item.title), text: text(item.text),
      stance: enumValue(item.stance, ['endorsed', 'tentative']), needsReview: bool(item.needsReview), context: text(item.context),
      neighbors: item.neighbors === undefined ? undefined : list(item.neighbors).map(rawNeighbor => {
        const neighbor = object(rawNeighbor);
        return { relation: enumValue(neighbor.relation, ['support', 'oppose', 'context', 'method_for', 'relates']), text: text(neighbor.text) };
      }) };
  }) };
}

export function readSceneProfileResult(raw: unknown): string { return text(raw); }
