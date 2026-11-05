import type { NoteItem, KnowledgePointMasteryResult } from '../../types';
import type { ReviewEpisodeCapture } from '../memory/types';
import type { ReviewComparisonSession, ReviewComparisonDependencies, ReviewReferenceSnapshot } from '../reviewComparison/types';
import { reviewSnapshotHash } from '../reviewComparison/packet';
import { noteReferenceSourceDescriptor } from '../noteReferenceSource';
import { reviewComparisonAnswers } from '../reviewComparison/session';
import { parseReviewAssessment, type ReviewAssessmentTaskType } from '../reviewAssessment';
import { bindReviewReferenceItems } from '../reviewReferenceRubric';
import { collectProjectKnowledgeNotes } from '../knowledgePointSelector';
import { flowMasteryTextKey } from './sourceKey';
import { buildMasteryShadowEvaluationRequest, parseMasteryShadowEvaluation,
  type MasteryShadowEvaluationInput, type MasteryShadowEvaluationResult, type MasteryShadowEvaluationCall } from './evaluator';
import type { MasteryShadowCriterionId } from './rubric';
import { MASTERY_SHADOW_CRITERIA } from './rubric';
import { applyMasteryShadowObservations } from './stateMachine';
import { readKnowledgeMastery } from '../masteryReadModel';
import { masteryLayerAssessment } from './presentation';
import { MASTERY_SHADOW_LAYERS, type MasteryShadowPresentation } from './types';

const TASK_CRITERIA: Record<ReviewAssessmentTaskType, MasteryShadowCriterionId[]> = {
  definition: ['concept_accuracy', 'concept_boundary'], example: ['concept_application'], distinguish: ['concept_boundary'],
  fact: ['judgment_accuracy'], condition: ['judgment_conditions'],
  attribution: ['judgment_attribution'],
  reasoning: ['reasoning_relevance', 'reasoning_sufficiency', 'reasoning_consistency'],
};
const targetKey = (note: NoteItem) => flowMasteryTextKey(JSON.stringify([note.id, note.title, note.content, note.noteType]));

/** Local source binding only, not a semantic grade. Drafts and finish-time metadata are excluded. */
export function reviewMasterySourceKey(noteId: string, episode: ReviewEpisodeCapture): string {
  return flowMasteryTextKey(JSON.stringify([noteId, episode.id, episode.messages,
    (episode.answerEvidence || []).map(({ referenceStructureVerification: _shadowOnly, ...answer }) => answer)]));
}

export interface ReviewMasteryItem {
  knowledgePointId: string;
  name: string;
  targetKey: string;
  messageIds: string[];
  input: MasteryShadowEvaluationInput;
  /** Original reference snapshots only. Personal cognition is never a reference or model input. */
  sources: ReviewReferenceSnapshot[];
  evaluation?: MasteryShadowEvaluationResult;
  error?: string;
}
export interface ReviewMasteryBatch {
  version: 1;
  sessionId: string;
  noteId: string;
  sourceKey: string;
  observedAt: string;
  items: ReviewMasteryItem[];
  warnings: string[];
}

function scopeNotes(notes: NoteItem[], noteId: string): NoteItem[] {
  const owner = notes.find(note => note.id === noteId);
  return owner?.noteType === 'project' ? collectProjectKnowledgeNotes(noteId, notes)
    : owner?.noteType === 'knowledge' ? [owner] : [];
}

/** Closed question-time task mapping; never infer a task from a later answer or old score. */
function criteriaFor(answer: ReturnType<typeof reviewComparisonAnswers>[number], name: string) {
  const intent = answer.evidence.questionIntent;
  const assessment = parseReviewAssessment(intent.assessment, intent.knowledgeTargets);
  return assessment.status === 'fixed' && assessment.requirements.some(row => row.knowledgeTarget === name)
    ? TASK_CRITERIA[assessment.taskType!] : [];
}

export function planReviewMastery(notes: NoteItem[], noteId: string, episode: ReviewEpisodeCapture,
  comparison: ReviewComparisonSession): ReviewMasteryBatch {
  const batch: ReviewMasteryBatch = { version: 1, sessionId: episode.id, noteId,
    sourceKey: reviewMasterySourceKey(noteId, episode), observedAt: episode.endedAt, items: [], warnings: [] };
  if (episode.masteryEligible === false) {
    batch.warnings.push('本次作答量或独立作答证据尚不足，先提供回答反馈，不更新长期掌握状态。');
    return batch;
  }
  const scope = scopeNotes(notes, noteId);
  const groups = new Map<string, ReviewMasteryItem>();
  const answers = reviewComparisonAnswers(episode);
  const holdLabels: Record<string, string> = {
    question_assessment_unavailable: '题目未携带有效检验任务标记', question_not_assessed: '本题为自由表达或澄清，不作定层检验',
    no_knowledge_target: '本题未指定知识点', insufficient_reference: '没有可读取的参考正文',
    ambiguous_target_note: '同名知识点不唯一', notes_unavailable: '知识点正文读取失败',
    question_reference_rubric_unavailable: '本题未选定完整参考检验项', question_reference_changed: '提问时的参考正文已变化',
    rubric_reference_outside_window: '所选参考内容不在当前参考节选内',
  };
  for (const answer of answers) {
    const packet = comparison.packets.find(row => row.activityId === episode.id && row.messageId === answer.evidence.messageId);
    // The actual question's frozen task can be checked against current canonical text even
    // when the tutor omitted fine-grained K# selection. Never recover missing tasks or stale selections.
    const optionalSelectionMissing = packet?.questionIntent.assessment?.status === 'fixed'
      && packet.questionIntent.referenceRubric?.status === 'unavailable'
      && ['missing_selection', 'incomplete_selection', 'no_reference'].includes(packet.questionIntent.referenceRubric.reason || '')
      && packet.preparation.masteryReasons.length > 0
      && packet.preparation.masteryReasons.every(reason => reason === 'question_reference_rubric_unavailable');
    if (!packet || packet.answer.text !== answer.evidence.answer || packet.questionText !== answer.questionText
      || packet.preparation.mastery !== 'pending_alignment' && !optionalSelectionMissing) {
      const reasons = !packet ? ['未能建立本轮题目与回答的比对包']
        : packet.preparation.masteryReasons.length ? packet.preparation.masteryReasons.map(reason => holdLabels[reason] || reason)
          : ['本轮题目或回答与比对快照不一致'];
      batch.warnings.push(`本轮不更新掌握状态：${reasons.join('；')}。仍可提供本次回答反馈。`); continue;
    }
    for (const name of answer.evidence.targetKnowledgeNames) {
      const targets = scope.filter(note => note.title === name || note.aliases?.includes(name));
      if (targets.length !== 1) { batch.warnings.push(`“${name}”未能唯一绑定当前复习范围的知识点。`); continue; }
      const note = targets[0];
      let criteria: MasteryShadowCriterionId[];
      try { criteria = criteriaFor(answer, name); } catch { batch.warnings.push(`“${name}”的题目检验要求不可用。`); continue; }
      if (!criteria.length) continue;
      const assisted = answer.evidence.hintLevel > 0 || !!answer.evidence.consultedMaterialIds?.length || packet.answer.hintLevel > 0;
      const key = `${note.id}:${assisted ? 'assisted' : 'independent'}`;
      let item = groups.get(key);
      if (!item) {
        if (groups.size >= 12) { batch.warnings.push('本次知识点评价预算已用完，额外知识点保持原状态。'); continue; }
        item = { knowledgePointId: note.id, name: note.title, targetKey: targetKey(note), messageIds: [], sources: [],
          input: { evaluationId: `review-mastery:${episode.id}:${key}`, knowledgePointId: note.id, knowledgePointTitle: note.title,
            occurredAt: episode.endedAt, source: 'socratic_review', assistance: assisted ? 'assisted' : 'independent', strength: 'natural',
            task: { evaluationMode: 'direct_test', referenceContract: 'criterion-scope-v3', confirmationPolicy: 'open-demonstration-v1', prompt: '', responseType: 'open', requiredLayers: [], criterionIds: [], verificationScopes: [] },
            answer: '', references: [] } };
        groups.set(key, item);
      }
      // Keep complete answers and questions. Oversized answers are held, not cut mid-sentence or silently graded.
      if ((item.input.answer + answer.evidence.answer).length > 3999 || (item.input.task.prompt + answer.questionText).length > 2500) {
        batch.warnings.push(`“${name}”部分完整回答超过本次评价预算，已保留原文但不计入本次掌握更新。`); continue;
      }
      const selected = packet.questionIntent.referenceRubric?.status === 'fixed'
        ? bindReviewReferenceItems(packet).filter(row => row.knowledgeTarget === name)
          .map(row => ({ quote: row.quote, source: packet.references.find(source => source.sourceId === row.sourceId)! }))
        : packet.references.filter(source => source.kind === 'target-note' && source.entityId === note.id).slice(0, 1)
          .map(source => ({ quote: source.text, source }));
      const layers = [...new Set(criteria.map(id => MASTERY_SHADOW_CRITERIA.find(row => row.id === id)!.layer))];
      // A missing baseline never falls back to old scores or the user's personal cognition.
      if (!selected.length || selected.some(row => row.quote.length > 2400)) {
        batch.warnings.push(`“${name}”缺少可核对的题目参考片段，本轮不更新掌握状态。`); continue;
      }
      const additional = selected.filter(({ quote, source }, index) => !item!.input.references.some(reference =>
        reference.sourceId === source.entityId && reference.quote === quote)
        && selected.findIndex(row => row.source.entityId === source.entityId && row.quote === quote) === index);
      if (item.input.references.length + additional.length > 12
        || item.input.references.reduce((sum, row) => sum + row.quote.length, 0) + additional.reduce((sum, row) => sum + row.quote.length, 0) > 6000) {
        batch.warnings.push(`“${name}”参考片段预算已用完，额外轮次不计入本次更新。`); continue;
      }
      item.messageIds.push(answer.evidence.messageId);
      item.input.answer += `${item.input.answer ? '\n\n' : ''}${answer.evidence.answer}`;
      item.input.task.prompt += `${item.input.task.prompt ? '\n' : ''}题目：${answer.questionText}；只检查${criteria.join('、')}。`;
      item.input.task.criterionIds = [...new Set([...item.input.task.criterionIds, ...criteria])];
      item.input.task.requiredLayers = [...new Set([...item.input.task.requiredLayers, ...layers])];
      const referenceIds: string[] = [];
      for (const { quote, source } of selected) {
        if (!item.sources.some(row => row.entityId === source.entityId && row.textStart === source.textStart && row.contentHash === source.contentHash)) {
          item.sources.push(structuredClone(source));
        }
        const existing = item.input.references.find(reference => reference.sourceId === source.entityId && reference.quote === quote);
        if (existing) {
          existing.layers = [...new Set([...(existing.layers || []), ...layers])];
          existing.criterionIds = [...new Set([...(existing.criterionIds || []), ...criteria])];
          referenceIds.push(existing.id);
        } else {
          const id = `REF${item.input.references.length + 1}`;
          item.input.references.push({ id, tier: 3, sourceRole: 'primary', sourceId: source.entityId,
            sourceLabel: source.title, locator: source.sectionPath || (source.truncated ? '原文节选，并非整篇教材' : '知识点正文'), quote, layers,
            criterionIds: [...criteria] });
          referenceIds.push(id);
        }
      }
      // Requests remain grouped by knowledge point, but one question's sources never
      // silently become another question's baseline after concatenating the answers.
      item.input.task.verificationScopes!.push({ id: answer.evidence.messageId, prompt: answer.questionText,
        answer: answer.evidence.answer, criterionIds: [...criteria], referenceIds: [...new Set(referenceIds)] });
    }
  }
  batch.items = [...groups.values()].filter(item => item.messageIds.length);
  batch.warnings = [...new Set(batch.warnings)];
  return batch;
}

export async function evaluateReviewMastery(batch: ReviewMasteryBatch, call: MasteryShadowEvaluationCall): Promise<ReviewMasteryBatch> {
  const next = structuredClone(batch);
  for (let index = 0; index < next.items.length; index += 2) {
    await Promise.all(next.items.slice(index, index + 2).map(async item => {
      try { item.evaluation = parseMasteryShadowEvaluation(await call(buildMasteryShadowEvaluationRequest(item.input)), item.input); }
      catch (error) { item.error = error instanceof Error ? error.message : '本轮掌握评价未完成，原状态保留。'; }
    }));
  }
  return next;
}

/** Recheck only reference authority. Personal cognition changes cannot invalidate knowledge evidence. */
export async function recheckReviewMasteryReferences(batch: ReviewMasteryBatch,
  dependencies: Pick<ReviewComparisonDependencies, 'readNotes' | 'previewDocument'>): Promise<ReviewMasteryBatch> {
  const next = structuredClone(batch);
  const notes = await dependencies.readNotes().catch(() => undefined);
  const checks = new Map<string, Promise<boolean>>();
  async function fresh(source: ReviewReferenceSnapshot): Promise<boolean> {
    if (source.kind === 'external-document') {
      const preview = await dependencies.previewDocument(source.entityId, source.chunkId!);
      const chunk = preview.chunks.find(row => row.id === source.chunkId);
      return preview.document.status === 'ready' && preview.document.knowledgeGenerationId === source.version.generationId
        && !!chunk && chunk.contentHash === source.contentHash && chunk.contentLength === source.contentLength;
    }
    const note = notes?.find(row => row.id === source.entityId);
    return !!note && note.noteType === 'knowledge' && note.updatedAt === source.version.updatedAt
      && await reviewSnapshotHash({ title: note.title, noteType: note.noteType, content: note.content }) === source.contentHash
      && (!source.version.referenceSourceHash
        || await reviewSnapshotHash(noteReferenceSourceDescriptor(note)) === source.version.referenceSourceHash);
  }
  for (const item of next.items) {
    if (!item.evaluation || item.error) continue;
    for (const source of item.sources) {
      const key = JSON.stringify([source.entityId, source.chunkId, source.contentHash, source.version]);
      if (!checks.has(key)) checks.set(key, fresh(source).catch(() => false));
      if (!await checks.get(key)) { item.error = '参考资料已变化或暂不可读取，本项保留原掌握状态。'; break; }
    }
  }
  return next;
}

/** All inputs are re-bound before applying semantic output; old numeric evidence is never converted. */
export function applyReviewMasteryBatch(notes: NoteItem[], noteId: string, episode?: ReviewEpisodeCapture) {
  const sourceBatch = episode?.masteryAssessment;
  const before = notes;
  if (!episode || episode.masteryEligible === false || !sourceBatch || sourceBatch.version !== 1 || sourceBatch.sessionId !== episode.id
    || sourceBatch.noteId !== noteId || sourceBatch.sourceKey !== reviewMasterySourceKey(noteId, episode)) {
    return { notes, results: [] as KnowledgePointMasteryResult[], masteredCount: 0, evaluations: [] as MasteryShadowEvaluationResult[] };
  }
  const batch = structuredClone(sourceBatch);
  const scope = scopeNotes(notes, noteId);
  let answers: ReturnType<typeof reviewComparisonAnswers>;
  try { answers = reviewComparisonAnswers(episode); } catch { return { notes, results: [] as KnowledgePointMasteryResult[], masteredCount: 0, evaluations: [] as MasteryShadowEvaluationResult[] }; }
  const seen = new Set<string>();
  const evaluations: MasteryShadowEvaluationResult[] = [];
  for (const item of batch.items) {
    const target = scope.find(note => note.id === item.knowledgePointId);
    if (!target || item.error || !item.evaluation || seen.has(item.input.evaluationId)) continue;
    if (item.targetKey !== targetKey(target)) { item.error = '知识点正文已变化，本项保留原掌握状态。'; continue; }
    seen.add(item.input.evaluationId);
    const selected = item.messageIds.map(id => answers.find(answer => answer.evidence.messageId === id));
    if (!selected.length || selected.some(answer => !answer || !answer.evidence.targetKnowledgeNames.some(name => target.title === name || target.aliases?.includes(name)))
      || new Set(item.messageIds).size !== item.messageIds.length) { item.error = '回答归属不匹配，原掌握状态保留。'; continue; }
    const trusted = selected as typeof answers;
    const assisted = trusted.some(answer => answer.evidence.hintLevel > 0 || !!answer.evidence.consultedMaterialIds?.length);
    const assistance = assisted ? 'assisted' : 'independent';
    let allowed: MasteryShadowCriterionId[];
    try { allowed = [...new Set(trusted.flatMap(answer => answer.evidence.targetKnowledgeNames.flatMap(name =>
      target.title === name || target.aliases?.includes(name) ? criteriaFor(answer, name) : [])))]; } catch { item.error = '题目检验要求不可用，原掌握状态保留。'; continue; }
    const layers = [...new Set(allowed.map(id => MASTERY_SHADOW_CRITERIA.find(row => row.id === id)!.layer))];
    const questionScopes = item.input.task.verificationScopes;
    const scopedSourceValid = item.input.task.referenceContract !== 'criterion-scope-v3' || !!questionScopes
      && questionScopes.length === trusted.length && new Set(questionScopes.map(row => row.id)).size === trusted.length
      && trusted.every((answer, index) => {
        const bound = questionScopes[index];
        const roundCriteria = [...new Set(answer.evidence.targetKnowledgeNames.flatMap(name =>
          target.title === name || target.aliases?.includes(name) ? criteriaFor(answer, name) : []))];
        const frozenItems = answer.evidence.questionIntent.referenceRubric?.status === 'fixed'
          ? answer.evidence.questionIntent.referenceRubric.items.filter(row => target.title === row.knowledgeTarget || target.aliases?.includes(row.knowledgeTarget))
          : undefined;
        return bound.id === answer.evidence.messageId && bound.prompt === answer.questionText && bound.answer === answer.evidence.answer
          && JSON.stringify([...bound.criterionIds].sort()) === JSON.stringify(roundCriteria.sort())
          && bound.referenceIds.length > 0 && new Set(bound.referenceIds).size === bound.referenceIds.length
          && bound.referenceIds.every(id => {
            const reference = item.input.references.find(row => row.id === id);
            return !!reference && roundCriteria.every(criterion => reference.criterionIds?.includes(criterion))
              && (!frozenItems || frozenItems.some(row => row.noteId === reference.sourceId && row.quote === reference.quote));
          });
      });
    if (item.input.evaluationId !== `review-mastery:${episode.id}:${target.id}:${assistance}` || item.input.source !== 'socratic_review'
      || item.input.assistance !== assistance || item.input.strength !== 'natural' || item.input.knowledgePointId !== target.id
      || item.input.knowledgePointTitle !== target.title || item.input.occurredAt !== batch.observedAt
      || item.input.answer !== trusted.map(answer => answer.evidence.answer).join('\n\n')
      || JSON.stringify([...item.input.task.criterionIds].sort()) !== JSON.stringify(allowed.sort())
      || JSON.stringify([...item.input.task.requiredLayers].sort()) !== JSON.stringify(layers.sort())
      || item.input.task.evaluationMode !== 'direct_test'
      || !scopedSourceValid
      || !item.input.references.length || item.input.references.some(reference => reference.tier !== 3
        || !item.sources.some(source => source.entityId === reference.sourceId && source.title === reference.sourceLabel
          && source.text.includes(reference.quote)))) { item.error = '评价来源或检验范围不匹配，原掌握状态保留。'; continue; }
    try {
      const evaluation = parseMasteryShadowEvaluation({ ...item.evaluation,
        evidence: item.evaluation.evidence.filter(evidence => trusted.some(answer => answer.evidence.answer.includes(evidence.quote))) }, item.input);
      item.evaluation = evaluation;
      const current = notes.find(note => note.id === target.id)!;
      const state = applyMasteryShadowObservations(current.dsrState?.masteryShadow, evaluation.observations);
      notes = notes.map(note => note.id === current.id ? { ...note, dsrState: {
        difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 0, consecutiveCorrect: 0, consecutiveWrong: 0,
        ...note.dsrState, masteryShadow: state } } : note);
      evaluations.push(evaluation);
    } catch { item.error = '本项评价无效，原掌握状态保留。'; }
  }
  const masteredCount = notes.filter(note => note.noteType === 'knowledge' && readKnowledgeMastery(note).confirmed
    && !readKnowledgeMastery(before.find(row => row.id === note.id)!).confirmed).length;
  return { notes, results: reviewMasteryResults(batch, notes), masteredCount, evaluations };
}

export function reviewMasteryResults(batch: ReviewMasteryBatch, notes: NoteItem[]): KnowledgePointMasteryResult[] {
  return [...new Set(batch.items.map(item => item.knowledgePointId))].flatMap(id => {
    const note = notes.find(note => note.id === id && note.noteType === 'knowledge');
    if (!note) return [];
    const items = batch.items.filter(item => item.knowledgePointId === id);
    const view = readKnowledgeMastery(note);
    const shadow: MasteryShadowPresentation = { evaluationId: `review-mastery:${batch.sessionId}:${id}`,
      status: items.some(item => item.evaluation && !item.error) ? 'evaluated' : 'failed',
      overview: { label: view.displayLabel, summary: view.summary, nextAction: view.nextAction },
      layers: Object.fromEntries(MASTERY_SHADOW_LAYERS.map(layer => {
        // Independent assessment takes precedence over a later hinted attempt.
        const item = items.find(item => !item.error && item.evaluation && item.input.assistance === 'independent'
          && item.input.task.requiredLayers.includes(layer)) || items.find(item => !item.error && item.evaluation && item.input.task.requiredLayers.includes(layer));
        const observation = item?.evaluation?.observations.find(row => row.results[0]?.layer === layer);
        return [layer, { coverage: observation?.coverage || 'not_tested', verdict: observation?.results[0]?.verdict || 'not_observed',
          state: view.layers[layer], reason: item?.evaluation?.summary || '本次未检验该层，原状态保留。',
          ...(item ? { assessment: masteryLayerAssessment({ evaluation: item.evaluation, references: item.input.references }, layer) } : {}) }];
      })) as MasteryShadowPresentation['layers'] };
    return [{ name: note.title, existingNoteTitle: note.title, level: 'none', conceptDelta: 0, judgmentDelta: 0, reasoningDelta: 0,
      shadow, comment: items.some(item => item.error) ? '部分评价未完成，相关状态保留。' : '仅更新本次有据检验的层次。' }];
  });
}

/** Display-only fallback. Showing an existing state never creates an observation or write receipt. */
export function withReviewMasteryDisplayStates(results: KnowledgePointMasteryResult[], notes: NoteItem[], noteId: string,
  episode: ReviewEpisodeCapture): KnowledgePointMasteryResult[] {
  const scope = scopeNotes(notes, noteId);
  const names = new Set((episode.answerEvidence || []).flatMap(answer => answer.targetKnowledgeNames));
  const targets = scope.filter(note => note.id === noteId || [...names].some(name =>
    (note.title === name || note.aliases?.includes(name)) && scope.filter(row => row.title === name || row.aliases?.includes(name)).length === 1));
  return [...results, ...targets.filter(note => !results.some(result => (result.existingNoteTitle || result.name) === note.title)).map(note => {
    const view = readKnowledgeMastery(note);
    return { name: note.title, existingNoteTitle: note.title, level: 'none' as const, conceptDelta: 0, judgmentDelta: 0, reasoningDelta: 0,
      comment: '仅展示已有累计状态，不是本次评价或写入凭证。',
      shadow: { evaluationId: `review-display:${episode.id}:${note.id}`, status: 'failed' as const,
        overview: { label: view.displayLabel, summary: view.summary, nextAction: view.nextAction },
        layers: Object.fromEntries(MASTERY_SHADOW_LAYERS.map(layer => [layer, { state: view.layers[layer],
          coverage: 'unverifiable', verdict: 'unverifiable', reason: '本次未形成可核验的该层结论，显示已有累计状态；不据此判定不会或降低掌握。' }])) as MasteryShadowPresentation['layers'] } };
  })];
}
