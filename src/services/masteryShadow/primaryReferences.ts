import type { NoteItem } from '../../types';
import type { FlowReferenceReaders } from '../flowAnalysis/referenceProvider';
import { searchNotes } from '../ragService';
import { selectReviewNotePassage, selectReviewNotePassages } from '../reviewComparison/notePassages';
import { noteReferenceSourceFingerprint } from '../noteReferenceSource';
import { hasSubstantiveReferenceText, referenceNoteContent } from '../ragSourcePolicy';
import { selectReferenceEvidence } from '../referenceEvidence';
import type { MasteryShadowReferenceItem } from './evaluator';
import type { MasteryShadowCriterionId } from './rubric';
import { masteryShadowCriterion } from './rubric';

/** Actual target-note passages, not other linked notes or a user's stored cognition.
 * A nonempty hit is only a candidate; the evaluator separately decides baseline coverage. */
export async function primaryMasteryReferences(note: NoteItem | undefined, criterionId: MasteryShadowCriterionId,
  query: string, readers?: Partial<FlowReferenceReaders>): Promise<MasteryShadowReferenceItem[]> {
  if (!note || note.noteType !== 'knowledge' || !hasSubstantiveReferenceText(referenceNoteContent(note))) return [];
  let hits: Awaited<ReturnType<typeof searchNotes>> = [];
  // Search returns at most one head hit per note. A non-evidence head must allow
  // selectReviewNotePassage to fall back to usable current-body semantic units.
  try { hits = await (readers?.searchNotes || searchNotes)(query, 1, { allowedNoteIds: [note.id] }); }
  catch { /* Current-source semantic-unit fallback below; never rebuild an index. */ }
  const sourceHash = await noteReferenceSourceFingerprint(note);
  let selected = selectReviewNotePassages(note, hits, sourceHash, query,
    { limit: 2, maxTotalChars: 1800, requireMatch: true });
  const topicOnly = !selected.passages.length;
  // A coarse lexical fallback may not recognize paraphrases. Supply a clearly
  // labelled topic context instead of pretending a zero-match passage is the
  // requested condition/proof, or preventing all questions about a readable note.
  if (topicOnly) selected = selectReviewNotePassages(note, [], sourceHash, `${note.title} 定义 含义 核心`,
    { limit: 1, maxTotalChars: 1400 });
  return selected.passages.flatMap((passage, index) => {
    const restored = selectReferenceEvidence(note.content, passage);
    return restored ? [{ id: `KP-NOTE-${criterionId}${index ? '-2' : ''}`, tier: 3 as const, sourceRole: 'primary' as const, sourceId: note.id,
      retrievalPurpose: topicOnly ? 'topic_context' as const : 'criterion_candidate' as const,
      sourceLabel: note.title, quote: restored.text, layers: [masteryShadowCriterion(criterionId)!.layer], criterionIds: [criterionId],
      locator: `${passage.chunkId || 'semantic-fallback'}:${passage.sectionPath}@${restored.textStart}-${restored.textEnd}` }] : [];
  });
}

export async function primaryMasteryReference(note: NoteItem | undefined, criterionId: MasteryShadowCriterionId,
  query: string, readers?: Partial<FlowReferenceReaders>): Promise<MasteryShadowReferenceItem | undefined> {
  // Existing single-passage callers keep their pre-optimization behavior.
  if (!note || note.noteType !== 'knowledge' || !hasSubstantiveReferenceText(referenceNoteContent(note))) return undefined;
  let hits: Awaited<ReturnType<typeof searchNotes>> = [];
  try { hits = await (readers?.searchNotes || searchNotes)(query, 1, { allowedNoteIds: [note.id] }); }
  catch { /* Read-only current-body fallback. */ }
  const selected = selectReviewNotePassage(note, hits, await noteReferenceSourceFingerprint(note), query).passage;
  const restored = selected && selectReferenceEvidence(note.content, selected);
  if (!selected || !restored) return undefined;
  return { id: `KP-NOTE-${criterionId}`, tier: 3, sourceRole: 'primary', sourceId: note.id,
    sourceLabel: note.title, quote: restored.text, layers: [masteryShadowCriterion(criterionId)!.layer], criterionIds: [criterionId],
    locator: `${selected.chunkId || 'semantic-fallback'}:${selected.sectionPath}@${restored.textStart}-${restored.textEnd}` };
}
