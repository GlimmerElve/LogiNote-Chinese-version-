import { createHash } from 'node:crypto';
import type { NoteItem, DocumentPreview } from '../src/types';
import type { CognitionFile } from '../src/services/cognition/types';
import type { ReviewEpisodeCapture } from '../src/services/memory/types';
import type { ReviewComparisonDependencies } from '../src/services/reviewComparison/types';
import { prepareReviewComparisonSession } from '../src/services/reviewComparison/session';
import type { ReviewDualCase } from './review-dual-dataset';

const at = '2026-10-06T00:00:00.000Z';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Real question/answer preparation with in-memory synthetic stores; never reads a configured user data root. */
export async function prepareReviewDualFixture(c: ReviewDualCase) {
  if (c.origin !== 'synthetic') throw new Error('Only synthetic fixtures allowed');
  const opaque = hash(c.id).slice(0, 16);
  const noteId = `synthetic-note-${opaque}`;
  const notes: NoteItem[] = c.references.length ? [{ id: noteId, title: c.topic, noteType: 'knowledge',
    content: c.references[0], tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at }] : [];
  const cognition: CognitionFile = { schemaVersion: 1, revision: 1, records: c.personal ? [{
    id: `record-${opaque}`, docId: `graph-${opaque}`, revisions: [{ id: `revision-${opaque}`, number: 1, at,
      operation: 'initial', reason: '', authorship: 'own_expression', source: { kind: 'argument_editor', docId: `graph-${opaque}` },
      factSupport: 'not_assessed', mastery: 'not_assessed', branches: [{ id: 'branch1', kind: 'primary',
        context: c.personal.context, stance: 'endorsed', graph: { title: c.topic,
          nodes: [{ id: 'node1', text: c.personal.text, mainType: '事实陈述' }], edges: [] } }],
    }],
  }] : [] };
  const documents: DocumentPreview[] = c.references.slice(1).map((text, index) => ({
    document: { id: `synthetic-doc-${opaque}-${index}`, fileName: `${c.topic}参考原文${index + 2}.txt`,
      fileType: 'txt', extension: '.txt', indexable: true, size: text.length * 3, status: 'ready',
      chunkCount: 1, totalChars: text.length, uploadAt: at, knowledgeGenerationId: 'synthetic-generation', indexSchemaVersion: 2 },
    chunks: [{ id: 'chunk1', index: 0, sectionPath: '参考原文', content: text, contentLength: text.length, contentHash: hash(text) }],
    totalChunkCount: 1, truncated: false,
  }));
  const dependencies: ReviewComparisonDependencies = {
    readNotes: async () => structuredClone(notes), loadCognition: async () => structuredClone(cognition),
    searchNotes: async () => [], searchDocuments: async () => documents.map((d) => ({ docId: d.document.id,
      chunkId: 'chunk1', fileName: d.document.fileName, snippet: d.chunks[0].content, sectionPath: '参考原文', score: 1, retrievalVersion: 1 })),
    previewDocument: async (id, chunkId) => {
      const result = documents.find((d) => d.document.id === id);
      if (!result || chunkId !== 'chunk1') throw new Error('Unknown synthetic document');
      return structuredClone(result);
    },
  };
  const intent = { version: 1 as const, questionMessageId: 'question1', knowledgeTargets: [c.topic],
    ...(c.personal ? { cognitionTarget: { recordId: `record-${opaque}`, revisionId: `revision-${opaque}`,
      branchId: 'branch1', nodeId: 'node1', purpose: c.personal.purpose } } : {}) };
  const episode: ReviewEpisodeCapture = { id: `activity-${opaque}`, startedAt: at, endedAt: at, questionText: c.question, knowledgeContext: '',
    messages: [{ id: 'question1', role: 'assistant', content: c.question, timestamp: at },
      { id: 'answer1', role: 'user', content: c.answer, timestamp: at }],
    answerEvidence: [{ messageId: 'answer1', answer: c.answer, hintLevel: c.hintLevel,
      targetKnowledgeNames: [c.topic], questionIntent: intent }],
  };
  const session = await prepareReviewComparisonSession(episode, dependencies, { targetScopeNoteIds: notes.map((n) => n.id), maxAnswers: 1 });
  if (session.packets.length !== 1) throw new Error('Synthetic packet preparation failed');
  return { packet: session.packets[0], dependencies, sourceFingerprint: hash(JSON.stringify({ notes, cognition, documents })) };
}
