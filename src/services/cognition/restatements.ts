import type { NoteItem } from '../../types';
import type { RestatementObservation } from './types';
import { flowReviewContentText } from '../textbook/reviewAdmission.ts';
import { flowMasteryTextKey } from '../masteryShadow/sourceKey.ts';

/** Reuse only the structure already bound to the saved user restatement. No summaries or diagnostic text. */
export function savedRestatementObservations(notes: NoteItem[]): RestatementObservation[] {
  return notes.filter(note => note.noteType === 'project').flatMap(note => (note.learningReviewRecords || [])
    .filter(record => record.schemaVersion === 1 && record.projectNoteId === note.id)
    .map(record => {
      const raw = typeof record.editedRestatement === 'string' ? record.editedRestatement : record.rawRestatement;
      const plain = flowReviewContentText(raw), text = plain ? raw : '';
      const sourceMatches = record.argumentRestatementKey !== undefined
        ? record.argumentRestatementKey === flowMasteryTextKey(plain)
        : !record.userEditedRestatement && plain === flowReviewContentText(record.rawRestatement);
      // The normal review writer binds one graph. Ambiguous legacy multi-graph bindings stay raw.
      const doc = text && sourceMatches && record.argumentDocIds.length === 1
        ? note.argumentDocs?.find(doc => doc.doc_id === record.argumentDocIds[0]) : undefined;
      return { noteId: note.id, noteTitle: note.title, recordId: record.id, sessionId: record.sessionId,
        observedAt: record.endedAt, updatedAt: record.updatedAt, text,
        ...(doc?.nodes.length ? { graph: { argumentDocId: doc.doc_id, updatedAt: doc.updated_at,
          structure: { title: doc.title || note.title,
            nodes: doc.nodes.map(node => ({ id: node.id, text: node.text, mainType: node.mainType, ...(node.role ? { role: node.role } : {}) })),
            edges: doc.edges.map(edge => ({ id: edge.id, source: edge.source, target: edge.target, relation: edge.relation,
              ...(edge.reason ? { reason: edge.reason } : {}) })),
            ...(doc.flowStructure ? { flowStructure: doc.flowStructure } : {}) } } } : {}) };
    }));
}

export const restatementRecordId = (observation: Pick<RestatementObservation, 'noteId' | 'recordId'>) =>
  `restatement:${JSON.stringify([observation.noteId, observation.recordId])}`;
