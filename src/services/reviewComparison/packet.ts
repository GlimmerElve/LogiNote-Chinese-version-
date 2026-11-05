import type { NoteItem, DocumentSearchResult, NoteSearchResult } from '../../types';
import type { CognitionFile, CognitionGraph } from '../cognition/types';
import { noteReferenceSourceDescriptor } from '../noteReferenceSource';
import { selectReviewNotePassage, type ReviewNotePassage } from './notePassages';
import { parseReviewQuestionIntent } from '../reviewIntentValidation.ts';
import { bindReviewReferenceItems, verifyReviewReferenceRubric } from '../reviewReferenceRubric';
import type { ReviewComparisonAnswer, ReviewComparisonDependencies, ReviewComparisonPacket,
  ReviewPersonalSnapshot, ReviewReferenceSnapshot } from './types';

export async function reviewSnapshotHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

const targetNote = (note: NoteItem, name: string): boolean => note.title === name || !!note.aliases?.includes(name);
const substantive = (text: string): boolean => {
  const plain = text.replace(/[#>*_`\s]/gu, '');
  return plain.length >= 2 && plain !== '请对该知识点进行定义描述';
};

/** Expand the actual connected component in one exact current branch, with explicit limits. */
export async function resolveReviewPersonalSnapshot(
  file: CognitionFile | undefined,
  intent: ReviewComparisonPacket['questionIntent'],
): Promise<ReviewPersonalSnapshot> {
  const target = intent.cognitionTarget;
  if (!target) return { status: 'not_requested', truncated: false };
  if (!file) return { status: 'unavailable', truncated: false };
  const record = file.records.find((item) => item.id === target.recordId);
  const revision = record?.revisions.at(-1);
  if (!record || !revision) return { status: 'target_missing', truncated: false };
  if (revision.id !== target.revisionId) return { status: 'stale_target', truncated: false };
  const branch = revision.branches.find((item) => item.id === target.branchId);
  if (!branch?.graph.nodes.some((item) => item.id === target.nodeId)) return { status: 'target_missing', truncated: false };

  const seen = new Set<string>([target.nodeId]);
  const queue = [target.nodeId];
  for (let index = 0; index < queue.length && seen.size < 24; index++) {
    for (const edge of branch.graph.edges) {
      const neighbor = edge.source === queue[index] ? edge.target : edge.target === queue[index] ? edge.source : undefined;
      if (neighbor && !seen.has(neighbor) && seen.size < 24) { seen.add(neighbor); queue.push(neighbor); }
    }
  }
  let chars = 0;
  let truncated = branch.context.length > 1200;
  const nodes = queue.flatMap((nodeId): CognitionGraph['nodes'] => {
    const node = branch.graph.nodes.find((item) => item.id === nodeId)!;
    if (chars >= 12000) { truncated = true; return []; }
    const text = node.text.slice(0, Math.min(2000, 12000 - chars));
    chars += text.length;
    if (text.length !== node.text.length) truncated = true;
    return [{ ...node, text, stance: node.stance || branch.stance }];
  });
  const retained = new Set(nodes.map((node) => node.id));
  const componentEdges = branch.graph.edges.filter((edge) => retained.has(edge.source) && retained.has(edge.target));
  if (componentEdges.length > 64 || branch.graph.edges.some((edge) => retained.has(edge.source) !== retained.has(edge.target))) truncated = true;
  return { status: 'ready', branchHash: await reviewSnapshotHash(branch), title: branch.graph.title,
    context: branch.context.slice(0, 1200), stance: branch.stance,
    graph: { title: branch.graph.title, nodes, edges: structuredClone(componentEdges.slice(0, 64)) },
    reviewNeededNodeIds: branch.reviewNeededNodeIds?.filter((nodeId) => retained.has(nodeId)), truncated };
}

async function noteReference(note: NoteItem, kind: 'target-note' | 'related-note', passage: ReviewNotePassage): Promise<ReviewReferenceSnapshot | undefined> {
  if (note.noteType !== 'knowledge' || !substantive(note.content || '') || !Number.isFinite(Date.parse(note.updatedAt))) return undefined;
  return { sourceId: '', corpus: 'reference', kind, entityId: note.id, title: note.title,
    ...passage, contentLength: note.content.length, truncated: passage.text.length < note.content.length,
    contentHash: await reviewSnapshotHash({ title: note.title, noteType: note.noteType, content: note.content }),
    version: { updatedAt: note.updatedAt, referenceSourceHash: await reviewSnapshotHash(noteReferenceSourceDescriptor(note)) } };
}

export async function buildReviewComparisonPacket(
  input: ReviewComparisonAnswer,
  dependencies: ReviewComparisonDependencies,
  options: { targetScopeNoteIds: string[] },
): Promise<ReviewComparisonPacket> {
  // Freeze caller-owned evidence before any asynchronous source reads.
  input = structuredClone(input);
  const scope = new Set(options.targetScopeNoteIds);
  const intent = parseReviewQuestionIntent(input.evidence.questionIntent);
  if (!input.activityId || !input.evidence.messageId || !input.evidence.answer.trim()
    || input.evidence.answer.length > 20000 || input.questionText.length > 4000
    || ![0, 1, 2, 3, 4].includes(input.evidence.hintLevel)) throw new Error('复习比对的回答快照无效');
  if (JSON.stringify([...intent.knowledgeTargets].sort()) !== JSON.stringify([...input.evidence.targetKnowledgeNames].sort())) {
    throw new Error('复习比对的知识点意图与回答不一致');
  }
  const consultedMaterialIds = input.evidence.consultedMaterialIds || [];
  if (!Array.isArray(consultedMaterialIds) || consultedMaterialIds.length > 30
    || consultedMaterialIds.some((item) => typeof item !== 'string' || !item.trim() || item.length > 1000)) {
    throw new Error('复习比对的辅助资料记录无效');
  }
  const hintLevel = Math.max(input.evidence.hintLevel, consultedMaterialIds.length ? 3 : 0) as ReviewComparisonPacket['answer']['hintLevel'];
  // Do not let a student's (possibly incorrect) answer shift the question's reference baseline.
  const query = [input.questionText.slice(0, 700), ...intent.knowledgeTargets].join(' ').slice(0, 1000);
  const warnings: string[] = [];
  const reads = await Promise.allSettled([
    dependencies.readNotes(),
    intent.cognitionTarget ? dependencies.loadCognition() : Promise.resolve(undefined),
    intent.knowledgeTargets.length ? dependencies.searchNotes(query, 2) : Promise.resolve([]),
    intent.knowledgeTargets.length ? dependencies.searchDocuments(query, 3) : Promise.resolve([]),
  ]);
  const notes = reads[0].status === 'fulfilled' ? reads[0].value : [];
  const file = reads[1].status === 'fulfilled' ? reads[1].value : undefined;
  const noteHits: NoteSearchResult[] = reads[2].status === 'fulfilled' ? reads[2].value : [];
  const docHits: DocumentSearchResult[] = reads[3].status === 'fulfilled' ? reads[3].value : [];
  const readCodes = ['notes_unavailable', 'personal_unavailable', 'note_retrieval_unavailable', 'document_retrieval_unavailable'];
  reads.forEach((result, index) => { if (result.status === 'rejected') warnings.push(readCodes[index]); });

  const targetNotes = notes.filter((note) => scope.has(note.id) && note.noteType === 'knowledge'
    && intent.knowledgeTargets.some((name) => targetNote(note, name)));
  const references: ReviewReferenceSnapshot[] = [];
  const rubricCurrent = intent.referenceRubric?.status === 'fixed'
    && await verifyReviewReferenceRubric(intent.referenceRubric, notes);
  const preparedTargets = rubricCurrent
    ? targetNotes.filter(note => intent.referenceRubric!.items.some(item => item.noteId === note.id))
    : targetNotes.slice(0, 2);
  for (const note of preparedTargets) {
    // Fixed question-time items take precedence, even when another passage now ranks higher.
    const fixed = rubricCurrent ? intent.referenceRubric!.items.filter(item => item.noteId === note.id) : [];
    if (fixed.length) {
      for (const item of fixed) {
        if (references.some(source => source.entityId === note.id && source.textStart === item.start && source.textEnd === item.end)) continue;
        const source = await noteReference(note, 'target-note', { text: item.quote, textStart: item.start,
          textEnd: item.end, sectionPath: item.sectionPath });
        if (source) references.push(source);
      }
      continue;
    }
    if (intent.referenceRubric?.status === 'fixed') continue; // Never replace a stale/foreign frozen baseline.
    let scopedHits: NoteSearchResult[] = [];
    try { scopedHits = await dependencies.searchNotes(query, 1, { allowedNoteIds: [note.id] }); }
    catch { warnings.push('target_note_retrieval_unavailable'); }
    const selected = selectReviewNotePassage(note, [...scopedHits, ...noteHits],
      await reviewSnapshotHash(noteReferenceSourceDescriptor(note)), input.questionText);
    warnings.push(...selected.warnings);
    const source = selected.passage && await noteReference(note, 'target-note', selected.passage);
    if (source) references.push(source);
  }
  const missingTargetNames = intent.knowledgeTargets.filter((name) => !references.some((source) => {
    const note = targetNotes.find((item) => item.id === source.entityId);
    return !!note && targetNote(note, name);
  }));
  const seenNotes = new Set(targetNotes.map(note => note.id));
  for (const hit of noteHits.slice(0, 2)) {
    if (seenNotes.has(hit.noteId) || hit.noteType !== 'knowledge' || hit.evidenceOrigin === 'user-argument-doc'
      || hit.argumentHits?.length || hit.matchKinds?.includes('argument')) continue;
    const note = notes.find((item) => item.id === hit.noteId);
    if (!note) continue;
    const selected = selectReviewNotePassage(note, [hit],
      await reviewSnapshotHash(noteReferenceSourceDescriptor(note)), input.questionText);
    warnings.push(...selected.warnings);
    const source = selected.passage && await noteReference(note, 'related-note', selected.passage);
    if (source) { references.push(source); seenNotes.add(note.id); }
  }

  const seenChunks = new Set<string>();
  for (const hit of docHits.slice(0, 3)) {
    const key = `${hit.docId}/${hit.chunkId}`;
    if (!hit.docId || !hit.chunkId || seenChunks.has(key)) continue;
    seenChunks.add(key);
    try {
      const preview = await dependencies.previewDocument(hit.docId, hit.chunkId);
      const chunk = preview.chunks.find((item) => item.id === hit.chunkId);
      if (preview.document.id !== hit.docId || preview.document.status !== 'ready' || !chunk?.content.trim()) {
        warnings.push('document_chunk_missing'); continue;
      }
      // A legacy preview cannot prove changes outside the visible prefix.
      if (!Number.isSafeInteger(chunk.contentLength) || chunk.contentLength! < chunk.content.length
        || !/^[a-f0-9]{64}$/u.test(chunk.contentHash || '')) {
        warnings.push('document_snapshot_unverifiable'); continue;
      }
      references.push({ sourceId: '', corpus: 'reference', kind: 'external-document', entityId: hit.docId,
        title: preview.document.fileName, chunkId: chunk.id, sectionPath: chunk.sectionPath,
        sourceLocators: chunk.sourceLocators, text: chunk.content, textStart: 0, textEnd: chunk.content.length,
        contentLength: chunk.contentLength!, contentHash: chunk.contentHash!, truncated: chunk.contentLength! > chunk.content.length,
        version: { generationId: preview.document.knowledgeGenerationId,
          indexSchemaVersion: preview.document.indexSchemaVersion, retrievalVersion: hit.retrievalVersion } });
    } catch { warnings.push('document_preview_unavailable'); }
  }
  references.forEach((source, index) => { source.sourceId = `R${index + 1}`; });

  const personal = await resolveReviewPersonalSnapshot(file, intent);
  const growthReasons: string[] = [];
  if (personal.status !== 'ready') growthReasons.push(personal.status === 'not_requested' ? 'no_cognition_target' : personal.status);
  if (personal.truncated) growthReasons.push('incomplete_personal_context');
  if (intent.cognitionTarget?.purpose === 'connect_nodes') growthReasons.push('multiple_targets_required');
  const masteryReasons: string[] = [];
  if (intent.assessment?.status === 'unavailable') masteryReasons.push('question_assessment_unavailable');
  if (intent.assessment?.status === 'not_assessed') masteryReasons.push('question_not_assessed');
  if (!intent.knowledgeTargets.length) masteryReasons.push('no_knowledge_target');
  if (!references.length) masteryReasons.push('insufficient_reference');
  // Targets with the same title cannot silently become one course baseline.
  if (intent.knowledgeTargets.some((name) => targetNotes.filter((note) => targetNote(note, name)).length > 1)) masteryReasons.push('ambiguous_target_note');
  if (reads[0].status === 'rejected') masteryReasons.push('notes_unavailable');
  if (intent.referenceRubric) {
    if (intent.referenceRubric.status !== 'fixed') masteryReasons.push('question_reference_rubric_unavailable');
    else if (!rubricCurrent) masteryReasons.push('question_reference_changed');
    else {
      try { bindReviewReferenceItems({ questionIntent: intent, references } as ReviewComparisonPacket); }
      catch { masteryReasons.push('rubric_reference_outside_window'); }
    }
  }
  const body: Omit<ReviewComparisonPacket, 'packetId' | 'snapshotHash'> = {
    version: 1, activityId: input.activityId, messageId: input.evidence.messageId,
    questionText: input.questionText, questionIntent: intent,
    answer: { text: input.evidence.answer, hintLevel, consultedMaterialIds: [...consultedMaterialIds] },
    personal, references,
    coverage: { referencePresence: references.length ? 'available' : 'insufficient_reference',
      semanticCoverage: 'not_assessed', missingTargetNames },
    preparation: { cognitionGrowth: growthReasons.length ? 'held' : 'pending_alignment',
      mastery: masteryReasons.length ? 'held' : 'pending_alignment', growthReasons, masteryReasons,
      warnings: [...new Set(warnings)] },
  };
  const snapshotHash = await reviewSnapshotHash(body);
  return { ...body, snapshotHash, packetId: `review-comparison:${snapshotHash}` };
}

export type ReviewPacketCitation =
  | { corpus: 'answer'; quote: string }
  | { corpus: 'personal'; nodeId: string; quote: string }
  | { corpus: 'reference'; sourceId: string; quote: string };

/** These checks prove source membership, not the semantic correctness of an alignment. */
export function validateReviewPacketCitation(packet: ReviewComparisonPacket, citation: ReviewPacketCitation): boolean {
  if (typeof citation.quote !== 'string' || !citation.quote.trim() || citation.quote.length > 600) return false;
  if (citation.corpus === 'answer') return packet.answer.text.includes(citation.quote);
  if (citation.corpus === 'personal') return packet.personal.status === 'ready'
    && !!packet.personal.graph?.nodes.find((node) => node.id === citation.nodeId)?.text.includes(citation.quote);
  if (citation.corpus === 'reference') return !!packet.references.find((source) => source.sourceId === citation.sourceId)?.text.includes(citation.quote);
  return false;
}

/** Re-read authority after model work; no caller should apply either output on a held snapshot. */
export async function verifyReviewComparisonFreshness(
  packet: ReviewComparisonPacket, dependencies: ReviewComparisonDependencies,
): Promise<{ fresh: boolean; reasons: string[] }> {
  const { packetId, snapshotHash, ...body } = packet;
  const reasons: string[] = [];
  if (await reviewSnapshotHash(body) !== snapshotHash || packetId !== `review-comparison:${snapshotHash}`) {
    return { fresh: false, reasons: ['packet_changed'] };
  }
  const checked = await Promise.allSettled([
    packet.references.some((source) => source.kind !== 'external-document') ? dependencies.readNotes() : Promise.resolve([]),
    packet.personal.status === 'ready' ? dependencies.loadCognition() : Promise.resolve(undefined),
  ]);
  if (checked[0].status === 'rejected') reasons.push('notes_unavailable');
  if (checked[1].status === 'rejected') reasons.push('personal_unavailable');
  if (checked[1].status === 'fulfilled' && packet.personal.status === 'ready') {
    const current = await resolveReviewPersonalSnapshot(checked[1].value, packet.questionIntent);
    if (current.status !== 'ready' || current.branchHash !== packet.personal.branchHash) reasons.push('personal_snapshot_changed');
  }
  if (packet.preparation.mastery === 'pending_alignment' && packet.questionIntent.referenceRubric?.status === 'fixed'
    && checked[0].status === 'fulfilled' && !await verifyReviewReferenceRubric(packet.questionIntent.referenceRubric, checked[0].value)) {
    reasons.push('question_reference_changed');
  }
  for (const source of packet.references) {
    if (source.kind !== 'external-document') {
      if (checked[0].status !== 'fulfilled') continue;
      const note = checked[0].value.find((item) => item.id === source.entityId);
      if (!note || note.noteType !== 'knowledge' || note.updatedAt !== source.version.updatedAt
        || await reviewSnapshotHash({ title: note.title, noteType: note.noteType, content: note.content }) !== source.contentHash
        || source.version.referenceSourceHash && await reviewSnapshotHash(noteReferenceSourceDescriptor(note)) !== source.version.referenceSourceHash) {
        reasons.push('note_snapshot_changed');
      }
    } else {
      try {
        const preview = await dependencies.previewDocument(source.entityId, source.chunkId!);
        const chunk = preview.chunks.find((item) => item.id === source.chunkId);
        if (preview.document.id !== source.entityId || preview.document.status !== 'ready'
          || preview.document.knowledgeGenerationId !== source.version.generationId
          || preview.document.indexSchemaVersion !== source.version.indexSchemaVersion
          || preview.document.fileName !== source.title || !chunk || chunk.contentHash !== source.contentHash
          || chunk.contentLength !== source.contentLength || chunk.content !== source.text || chunk.sectionPath !== source.sectionPath) {
          reasons.push('document_snapshot_changed');
        }
      } catch { reasons.push('document_preview_unavailable'); }
    }
  }
  return { fresh: reasons.length === 0, reasons: [...new Set(reasons)] };
}
