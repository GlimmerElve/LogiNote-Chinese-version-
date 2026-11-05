import type { KnowledgePointDsr, KnowledgePointMasteryResult, NoteItem, ReviewAnalysis } from '../../types';
import type { LearningChange, LearningEpisode, ReviewDraftAnswer, ReviewEpisodeCapture } from '../memory/types';
import { applyProjectReviewOutcome, calculateRetrievability, ratingToNumber, updateDifficulty, updateStability } from '../reviewScheduler';
import { computeLayeredMastery, MASTERY_LINE, scoreConceptEvidence, scoreJudgmentEvidence, scoreReasoningEvidence } from '../profile/scoring/threeLayer';
import { resolveNoteByTitleOrAlias } from '../noteResolver';
import { masteryReadMode, readKnowledgeMastery } from '../masteryReadModel';
import { applyReviewMasteryBatch } from '../masteryShadow/review';
import { masteryShadowCriterion } from '../masteryShadow/rubric';
import type { MasteryShadowObservation, MasteryShadowVerdict } from '../masteryShadow/types';

export interface ReviewExitOutcome {
  notes: NoteItem[];
  learningChanges: LearningChange[];
  knowledgePoints: string[];
  masteredCount: number;
  /** Only evaluations revalidated by the writer may become profile evidence. */
  masteryEvaluations?: import('../masteryShadow/evaluator').MasteryShadowEvaluationResult[];
}

/** An unavailable criterion is not a failed recall. Do not schedule from a mixed layer's summary. */
export function reviewSchedulingVerdicts(observation: MasteryShadowObservation): MasteryShadowVerdict[] {
  if (observation.coverage !== 'assessed' || observation.assistance !== 'independent') return [];
  return observation.results.flatMap(result => {
    if (result.criterionResults !== undefined) {
      return result.criterionResults.flatMap(criterion => {
        const definition = masteryShadowCriterion(criterion.id);
        const grounded = criterion.referenceBasis === 'grounded' && criterion.referenceIds.length > 0;
        // The same text-grounding rule as the mastery writer: logic/attribution need no external facts.
        const textGrounded = definition && !definition.referenceRequired && criterion.userEvidenceIds.length > 0;
        return definition?.layer === result.layer && result.criterionIds.includes(criterion.id)
          && criterion.userEvidenceIds.length > 0 && (grounded || textGrounded)
          && ['pass', 'partial', 'fail'].includes(criterion.verdict)
          ? [criterion.verdict as MasteryShadowVerdict] : [];
      });
    }
    // Historical layer-only receipts retain their old scheduling interpretation. An explicit [] is not historical.
    return observation.referenceBasis === 'grounded' && result.userEvidenceIds.length > 0
      && ['pass', 'partial', 'fail'].includes(result.verdict) ? [result.verdict] : [];
  });
}

/** All new-mode review writes share the evidence-backed state machine; legacy rollback stays isolated. */
export function prepareReviewExitOutcome(notes: NoteItem[], input: {
  noteId: string; noteTitle: string; analysis: ReviewAnalysis | null;
  segmentMastery?: KnowledgePointMasteryResult[]; episode?: ReviewEpisodeCapture;
}, reviewedAt = input.episode?.endedAt || new Date().toISOString()): ReviewExitOutcome {
  if (masteryReadMode() === 'legacy') return prepareLegacyReviewExitOutcome(notes, input, reviewedAt);
  const before = notes;
  const result = applyReviewMasteryBatch(notes, input.noteId, input.episode);
  notes = result.notes;
  const learningChanges: LearningChange[] = [];
  for (const note of notes) {
    const old = before.find(row => row.id === note.id)!;
    if (old.dsrState?.masteryShadow !== note.dsrState?.masteryShadow
      && JSON.stringify(old.dsrState?.masteryShadow) !== JSON.stringify(note.dsrState?.masteryShadow)) {
      const from = readKnowledgeMastery(old), to = readKnowledgeMastery(note);
      learningChanges.push({ noteId: note.id, noteTitle: note.title, field: 'mastery',
        before: `${from.displayLabel} · ${from.summary}`, after: `${to.displayLabel} · ${to.summary}` });
    }
  }
  // Memory scheduling remains independent from understanding. Project reviews only touch actually assessed targets.
  const episode = input.episode;
  if (episode?.masteryEligible !== false && episode?.id) {
    const eligible = result.evaluations.flatMap(evaluation => evaluation.observations.flatMap(observation => {
      const verdicts = reviewSchedulingVerdicts(observation);
      return verdicts.length ? [{ knowledgePointId: observation.knowledgePointId, verdicts }] : [];
    }));
    const ids = eligible.map(observation => observation.knowledgePointId);
    for (const id of new Set(ids)) {
      const target = notes.find(note => note.id === id && note.noteType === 'knowledge');
      if (!target || !(episode.answerEvidence || []).some(answer => answer.answer.trim()
        && answer.targetKnowledgeNames.some(name => name === target.title || target.aliases?.includes(name)))) continue;
      const dsr: KnowledgePointDsr = target.dsrState || { difficulty: 5, stability: 2, lastReviewedAt: null,
        reviewCount: 0, consecutiveCorrect: 0, consecutiveWrong: 0 };
      if (dsr.reviewSessionIds?.includes(episode.id)) continue;
      const observed = eligible.filter(observation => observation.knowledgePointId === id).flatMap(observation => observation.verdicts);
      const grade = observed.includes('fail') ? 1 : observed.includes('partial') ? 2
        : 4;
      const stability = updateStability(dsr.stability, grade, calculateRetrievability(dsr.stability, dsr.lastReviewedAt));
      const difficulty = updateDifficulty(dsr.difficulty, grade, dsr.reviewCount);
      const correct = grade >= 3;
      notes = notes.map(note => note.id === id ? { ...note, dsrState: { ...dsr, stability, difficulty,
        lastReviewedAt: reviewedAt, reviewCount: dsr.reviewCount + 1,
        consecutiveCorrect: correct ? dsr.consecutiveCorrect + 1 : 0, consecutiveWrong: correct ? 0 : dsr.consecutiveWrong + 1,
        reviewSessionIds: [...(dsr.reviewSessionIds || []), episode.id].slice(-100) }, lastReferencedAt: reviewedAt } : note);
      learningChanges.push({ noteId: id, noteTitle: target.title, field: 'difficulty', before: dsr.difficulty, after: difficulty },
        { noteId: id, noteTitle: target.title, field: 'stability', before: dsr.stability, after: stability });
    }
  }
  return { notes, learningChanges, masteredCount: result.masteredCount, masteryEvaluations: result.evaluations,
    knowledgePoints: [...new Set((episode?.answerEvidence || []).flatMap(answer => answer.targetKnowledgeNames))] };
}

/** Historical rollback only: its numeric writes must never execute in current mode. */
function prepareLegacyReviewExitOutcome(notes: NoteItem[], input: {
  noteId: string; noteTitle: string; analysis: ReviewAnalysis | null;
  segmentMastery?: KnowledgePointMasteryResult[]; episode?: ReviewEpisodeCapture;
}, reviewedAt: string): ReviewExitOutcome {
  const { analysis, segmentMastery, episode } = input;
  const learningChanges: LearningChange[] = [];
  const replacements = new Map<string, NoteItem>();
  let masteredCount = 0;
  const baseDsr: KnowledgePointDsr = { difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 0, consecutiveCorrect: 0, consecutiveWrong: 0 };
  if (Array.isArray(segmentMastery)) {
    if (episode?.masteryEligible !== false) {
      for (const result of segmentMastery) {
        if (result.level === 'none') continue;
        const target = resolveNoteByTitleOrAlias(result.name, notes.filter((note) => note.noteType === 'knowledge'));
        if (!target || replacements.has(target.id)) continue;
        const dsr = target.dsrState || baseDsr;
        const before = dsr.conceptMastery ?? 0;
        const layered = computeLayeredMastery(result.conceptDelta, result.judgmentDelta, result.reasoningDelta, before);
        learningChanges.push({ noteId: target.id, noteTitle: target.title, field: 'mastery', before, after: layered.mastery });
        if (before < MASTERY_LINE && layered.mastery >= MASTERY_LINE) masteredCount++;
        const updatedDsr = applyProjectReviewOutcome({ ...dsr, conceptMastery: layered.mastery,
          conceptMasterySamples: (dsr.conceptMasterySamples || 0) + 1, conceptMasteryUpdatedAt: reviewedAt,
        }, reviewedAt, result.conceptDelta + result.judgmentDelta + result.reasoningDelta >= 0);
        replacements.set(target.id, { ...target, dsrState: updatedDsr, lastReferencedAt: reviewedAt });
      }
    }
  } else if (analysis && input.noteId && episode?.masteryEligible !== false) {
    const target = notes.find((note) => note.id === input.noteId);
    if (target) {
      const dsr = target.dsrState || baseDsr;
      const grade = ratingToNumber(analysis.overallRating);
      const retrievability = calculateRetrievability(dsr.stability, dsr.lastReviewedAt);
      const average = (analysis.accuracyScore + analysis.completenessScore + analysis.logicScore + analysis.relevanceScore) / 4;
      const stability = updateStability(dsr.stability, grade, retrievability, average);
      const difficulty = updateDifficulty(dsr.difficulty, grade, dsr.reviewCount);
      const correct = grade >= 3;
      const concept = scoreConceptEvidence(analysis.masteryEvidence?.conceptEvidence);
      const judgment = scoreJudgmentEvidence(analysis.masteryEvidence?.judgmentEvidence);
      const reasoning = scoreReasoningEvidence(analysis.masteryEvidence?.reasoningEvidence);
      const hasEvidence = concept !== null || judgment !== null || reasoning !== null;
      const before = dsr.conceptMastery ?? 0;
      const layered = computeLayeredMastery(concept, judgment, reasoning, before);
      learningChanges.push(
        { noteId: target.id, noteTitle: target.title, field: 'difficulty', before: dsr.difficulty, after: difficulty },
        { noteId: target.id, noteTitle: target.title, field: 'stability', before: dsr.stability, after: stability },
      );
      if (hasEvidence) learningChanges.push({ noteId: target.id, noteTitle: target.title, field: 'mastery', before, after: layered.mastery });
      if (hasEvidence && before < MASTERY_LINE && layered.mastery >= MASTERY_LINE) masteredCount++;
      replacements.set(target.id, { ...target, dsrState: { ...dsr, difficulty, stability,
        lastReviewedAt: reviewedAt, reviewCount: dsr.reviewCount + 1,
        consecutiveCorrect: correct ? dsr.consecutiveCorrect + 1 : 0, consecutiveWrong: correct ? 0 : dsr.consecutiveWrong + 1,
        ...(hasEvidence ? { conceptMastery: layered.mastery, conceptMasterySamples: (dsr.conceptMasterySamples || 0) + 1, conceptMasteryUpdatedAt: reviewedAt } : {}),
      }, lastReferencedAt: reviewedAt });
    }
  }
  const attempted = [...new Set((episode?.answerEvidence || []).flatMap((item) => item.targetKnowledgeNames))];
  return { notes: notes.map((note) => replacements.get(note.id) || note), learningChanges, masteredCount,
    knowledgePoints: Array.isArray(segmentMastery) ? attempted.length ? attempted : segmentMastery.map((item) => item.name)
      : input.noteTitle ? [input.noteTitle] : [],
  };
}

export interface ReviewExitProgress {
  outcome?: ReviewExitOutcome;
  completed?: boolean;
  notified?: boolean;
  pending?: Promise<ReviewExitOutcome>;
}

/** Retry the unsaved stage only: an episode failure must not increment mastery twice. */
export function commitReviewExitWrite(progress: ReviewExitProgress, dependencies: {
  persistNotes: () => Promise<ReviewExitOutcome>;
  persistEpisode: (outcome: ReviewExitOutcome) => Promise<void>;
}): Promise<ReviewExitOutcome> {
  if (progress.pending) return progress.pending;
  if (progress.completed && progress.outcome) return Promise.resolve(progress.outcome);
  const operation = (async () => {
    if (!progress.outcome) progress.outcome = await dependencies.persistNotes();
    await dependencies.persistEpisode(progress.outcome);
    progress.completed = true;
    return progress.outcome;
  })();
  progress.pending = operation.finally(() => { progress.pending = undefined; });
  return progress.pending;
}

/** Only the latest session for this exact note can offer an unsent draft. */
export function getReviewDraftForNote(episodes: LearningEpisode[], noteId: string): { episodeId: string; draft: ReviewDraftAnswer } | null {
  const latest = episodes.filter((episode) => episode.type === 'review' && episode.noteId === noteId)
    .sort((a, b) => (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0))[0];
  const draft = latest?.draftAnswer;
  return draft && typeof draft.id === 'string' && typeof draft.content === 'string' && draft.content.trim()
    ? { episodeId: latest.id, draft } : null;
}
