import type { NoteItem } from '../../types';
import type { ArgumentRole, RelationType } from '../argumentDoc/types';
import { computeArgumentRevisionHash } from '../argumentDoc/quality';
import { cognitionQueryTerms } from './retrieval';
import type { CognitionMaterialHit } from './materials';

export interface FlowReviewIndexStatus {
  graphCount: number; nodeCount: number; graphIds: string[];
  vectorStatus: 'ready' | 'unavailable' | 'missing'; processing: boolean;
}

export interface SavedFlowReviewGraph {
  noteId: string; title: string; sessionId: string; argumentDocId: string; revisionHash: string;
  nodes: Array<{ id: string; role: ArgumentRole; text: string }>;
  edges: Array<{ id: string; source: string; target: string; relation: RelationType }>;
  sourceKind: 'flow-review-argument'; stance: 'not_assessed'; usableAsFactEvidence: false;
}
const roles = new Set(['claim', 'premise', 'background', 'method']);
const relations = new Set(['support', 'oppose', 'context', 'method_for', 'relates']);

/** Only graphs actually saved and bound to this note's review record. No promotion of publication or stance. */
export function savedFlowReviewGraphs(note: NoteItem): SavedFlowReviewGraph[] {
  if (note.noteType !== 'project') return [];
  const seen = new Set<string>();
  return (note.learningReviewRecords || []).flatMap(review => {
    if (review.schemaVersion !== 1 || review.projectNoteId !== note.id) return [];
    return review.argumentDocIds.flatMap(id => {
      const doc = note.argumentDocs?.find(d => d.doc_id === id);
      if (!doc || seen.has(id) || !doc.nodes.length || doc.nodes.length > 10000 || doc.edges.length > 30000) return [];
      const nodes = doc.nodes.map(n => ({ id: n.id, role: n.role!, text: n.text }));
      const ids = new Set(nodes.map(n => n.id));
      if (ids.size !== nodes.length || nodes.some(n => !n.id || !roles.has(n.role) || typeof n.text !== 'string')) return [];
      seen.add(id);
      return [{ noteId: note.id, title: note.title, sessionId: review.sessionId, argumentDocId: id,
        revisionHash: computeArgumentRevisionHash(doc), nodes,
        edges: doc.edges.filter(e => ids.has(e.source) && ids.has(e.target) && e.source !== e.target && relations.has(e.relation))
          .map(e => ({ id: e.id, source: e.source, target: e.target, relation: e.relation })),
        sourceKind: 'flow-review-argument' as const, stance: 'not_assessed' as const, usableAsFactEvidence: false as const }];
    });
  });
}

/** Retrieval preserves edge directions/roles. Graph material is not a confirmed belief or a factual reference. */
export function retrieveFlowReviewGraphs(graphs: SavedFlowReviewGraph[], query: string, limit = 2): CognitionMaterialHit[] {
  const terms = cognitionQueryTerms(query);
  if (!terms.length) return [];
  const hits = graphs.flatMap(graph => graph.nodes.flatMap(node => {
    const words = new Set(cognitionQueryTerms(node.text));
    const score = terms.filter(t => words.has(t)).length / terms.length;
    if (!score) return [];
    const adjacent = graph.edges.filter(e => e.source === node.id || e.target === node.id).slice(0, 6);
    const ids = new Set([node.id, ...adjacent.flatMap(e => [e.source, e.target])]);
    const nodes = graph.nodes.filter(n => ids.has(n.id));
    const text = nodes.map(n => `${n.id}[${n.role}] ${n.text}`).join('\n');
    return [{ noteId: graph.noteId, title: graph.title, text: text.slice(0, 1000), textTruncated: text.length > 1000,
      passageId: `${graph.argumentDocId}:${graph.revisionHash}:${node.id}`, score,
      sourceKind: 'flow-review-argument' as const, stance: 'not_assessed' as const, usableAsFactEvidence: false as const,
      argumentDocId: graph.argumentDocId, revisionHash: graph.revisionHash, nodeId: node.id,
      relationSummary: adjacent.map(e => `${e.source} -${e.relation}-> ${e.target}`).join('；') }];
  }));
  const seen = new Set<string>();
  return hits.sort((a, b) => b.score - a.score).filter(h => !seen.has(h.argumentDocId!) && !!seen.add(h.argumentDocId!))
    .slice(0, Math.max(0, Math.min(4, limit)));
}

export function readSavedFlowGraphs(raw: unknown): SavedFlowReviewGraph[] {
  if (!Array.isArray(raw) || raw.length > 5000) throw new Error('个人复盘图索引无效');
  for (const graph of raw) {
    if (!graph || typeof graph.noteId !== 'string' || typeof graph.title !== 'string' || typeof graph.sessionId !== 'string'
      || typeof graph.argumentDocId !== 'string' || typeof graph.revisionHash !== 'string'
      || graph.sourceKind !== 'flow-review-argument' || graph.stance !== 'not_assessed' || graph.usableAsFactEvidence !== false
      || !Array.isArray(graph.nodes) || graph.nodes.length > 10000 || !Array.isArray(graph.edges) || graph.edges.length > 30000
      || graph.nodes.some((n: SavedFlowReviewGraph['nodes'][number]) => !n || typeof n.id !== 'string' || !roles.has(n.role) || typeof n.text !== 'string')) throw new Error('个人复盘图索引无效');
    const ids = new Set(graph.nodes.map((n: { id: string }) => n.id));
    if (ids.size !== graph.nodes.length || graph.edges.some((e: SavedFlowReviewGraph['edges'][number]) => !e || typeof e.id !== 'string'
      || !ids.has(e.source) || !ids.has(e.target) || e.source === e.target || !relations.has(e.relation))) throw new Error('个人复盘图索引无效');
  }
  return raw as SavedFlowReviewGraph[];
}
