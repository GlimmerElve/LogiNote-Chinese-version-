import type { NoteRagIndexInput, UserArgumentNodeHit } from '../../types.ts';
import { projectMaterialRows, type ProjectMaterialRow } from '../ragSourcePolicy.ts';
import { cognitionQueryTerms } from './retrieval.ts';
import { assessArgumentDoc, computeArgumentRevisionHash, getEffectiveArgumentQuality } from '../argumentDoc/quality.ts';
import type { ArgDoc } from '../argumentDoc/types.ts';

/** A source observation, NOT a CognitionHit or an inferred belief. */
export interface CognitionMaterialHit {
  noteId: string; title: string; text: string; passageId: string; score: number;
  sourceKind: 'project-restatement' | 'published-argument' | 'flow-review-argument';
  stance: 'not_assessed'; usableAsFactEvidence: false;
  textTruncated?: boolean;
  argumentDocId?: string; revisionHash?: string; nodeId?: string;
  relationSummary?: string;
  argumentHits?: UserArgumentNodeHit[];
}

export function rankProjectMaterials(rows: ProjectMaterialRow[], query: string, limit = 4): CognitionMaterialHit[] {
  const terms = cognitionQueryTerms(query).filter((t) => !['看待', '认识', '曾经', '目前', '现在', '表述', '记录'].includes(t));
  if (!terms.length) return [];
  return rows.map((row) => {
    const words = new Set(cognitionQueryTerms(row.text));
    // Full-body terms, not title alone, admit a passage. Query-term extraction
    // has a 1000-char bound and each row is <=900 chars.
    const matched = terms.filter((t) => words.has(t));
    const score = matched.length / terms.length;
    return { ...row, score };
  }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score)
    .slice(0, Math.max(0, Math.min(4, Number.isFinite(limit) ? Math.floor(limit) : 4)));
}

/** Browser fallback reads original notes on demand, never the public embedding cache. */
export function retrieveProjectMaterials(notes: NoteRagIndexInput[], query: string): CognitionMaterialHit[] {
  return rankProjectMaterials(notes.flatMap(projectMaterialRows), query);
}

/** Read published snapshots only, with the same hash/quality boundary as desktop. */
export function retrievePublishedMaterials(notes: NoteRagIndexInput[], query: string): CognitionMaterialHit[] {
  const terms = cognitionQueryTerms(query);
  const hits: CognitionMaterialHit[] = [];
  for (const note of notes) for (const { argumentDocId, snapshot } of note.publishedArguments || []) {
    try {
      const doc: ArgDoc = { doc_id: argumentDocId, title: snapshot.title, created_at: snapshot.publishedAt,
        updated_at: snapshot.publishedAt, iteration: 0, status: 'draft', nodes: snapshot.nodes, edges: snapshot.edges,
        summary: snapshot.summary, scores: snapshot.scores };
      if (computeArgumentRevisionHash(doc) !== snapshot.revisionHash) continue;
      const assessed = assessArgumentDoc(doc, snapshot.publishedAt);
      if (assessed.admission === 'review_required' || assessed.admission !== snapshot.assessment.admission
        || assessed.score !== snapshot.assessment.score
        || (snapshot.semanticAssessment && getEffectiveArgumentQuality(assessed, snapshot.semanticAssessment).admission === 'review_required')) continue;
      for (const node of snapshot.nodes) {
        const words = new Set(cognitionQueryTerms(node.text));
        const matched = terms.filter((t) => words.has(t));
        if (!matched.length) continue;
        const adjacent = snapshot.edges.filter((e) => e.source === node.id || e.target === node.id).slice(0, 2);
        const neighbors = adjacent.flatMap((e) => snapshot.nodes.filter((n) => n.id === (e.source === node.id ? e.target : e.source)));
        const text = [node, ...neighbors].map((n) => n.text).join('\n');
        hits.push({ noteId: note.id, title: note.title, passageId: `${argumentDocId}:${snapshot.revisionHash}:${node.id}`,
          sourceKind: 'published-argument', text: text.slice(0, 1000), textTruncated: text.length > 1000,
          stance: 'not_assessed', usableAsFactEvidence: false, score: matched.length / Math.max(terms.length, 1),
          argumentDocId, revisionHash: snapshot.revisionHash, nodeId: node.id,
          relationSummary: adjacent.map((e) => `${e.source} → ${e.target}: ${e.relation}`).join('；') });
      }
    } catch { /* Malformed or obsolete published snapshot is not admitted. */ }
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 2);
}

export function readCognitionMaterials(raw: unknown): CognitionMaterialHit[] {
  if (!Array.isArray(raw)) return [];
  const str = (v: unknown, max: number) => typeof v === 'string' ? v.slice(0, max) : '';
  return raw.slice(0, 6).flatMap((r): CognitionMaterialHit[] => {
    if (!r || typeof r !== 'object' || !str(r.noteId, 300) || !str(r.passageId, 300) || !str(r.text, 1000)
      || !['project-restatement', 'published-argument', 'flow-review-argument'].includes(r.sourceKind)
      || r.stance !== 'not_assessed' || r.usableAsFactEvidence !== false) return [];
    return [{ noteId: str(r.noteId, 300), title: str(r.title, 120), text: str(r.text, 1000), passageId: str(r.passageId, 300),
      sourceKind: r.sourceKind, stance: 'not_assessed', usableAsFactEvidence: false,
      score: typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : 0,
      textTruncated: r.textTruncated === true || r.text.length > 1000,
      argumentDocId: str(r.argumentDocId, 200) || undefined, revisionHash: str(r.revisionHash, 200) || undefined,
      nodeId: str(r.nodeId, 200) || undefined, relationSummary: str(r.relationSummary, 700) || undefined,
      // Navigation only; material text/relations never become factual evidence.
      argumentHits: Array.isArray(r.argumentHits) ? r.argumentHits.slice(0, 8).flatMap((h: UserArgumentNodeHit) => {
        if (!h || !str(h.argumentId, 500) || !str(h.argumentDocId, 200) || !str(h.nodeId, 200)
          || !str(h.revisionHash, 200) || !str(h.text, 900)
          || !['direct', 'expanded'].includes(h.match) || !['concept', 'judgment', 'logic'].includes(h.layer)) return [];
        return [{ argumentId: str(h.argumentId, 500), argumentDocId: str(h.argumentDocId, 200), nodeId: str(h.nodeId, 200),
          revisionHash: str(h.revisionHash, 200), text: str(h.text, 900), mainType: h.mainType, layer: h.layer, match: h.match,
          relationDirection: ['supports', 'supported_by', 'opposes', 'opposed_by'].includes(h.relationDirection || '') ? h.relationDirection : undefined }];
      }) : undefined }];
  });
}
