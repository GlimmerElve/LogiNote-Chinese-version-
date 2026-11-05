import type { SceneInteractionDirective, SceneInteractionResponse, SceneObjectiveAssessment, SceneObjectiveEvaluation } from '../../types';

/** Objective answer keys are private data; simulation strategy choices have no objective key. */
export function normalizeSceneObjectiveEvaluation(raw: unknown, directive?: SceneInteractionDirective): SceneObjectiveEvaluation | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !directive
    || (directive.type !== 'single-choice' && directive.type !== 'multiple-choice' && directive.type !== 'ordering') || directive.assessment === 'none') return undefined;
  const value = raw as Record<string, unknown>;
  if (value.interactionId !== directive.id || value.type !== directive.type) return undefined;
  const explanation = typeof value.explanation === 'string' ? value.explanation.slice(0, 1500) : '';
  if (directive.type === 'single-choice' && typeof value.correctId === 'string'
    && directive.options.some(option => option.id === value.correctId)) {
    return { interactionId: directive.id, type: 'single-choice', correctId: value.correctId, explanation };
  }
  if (directive.type === 'multiple-choice' && Array.isArray(value.correctIds) && value.correctIds.length
    && value.correctIds.every(id => typeof id === 'string' && directive.options.some(option => option.id === id))
    && new Set(value.correctIds).size === value.correctIds.length
    && value.correctIds.length >= (directive.minSelections ?? 1)
    && value.correctIds.length <= (directive.maxSelections ?? directive.options.length)) {
    return { interactionId: directive.id, type: 'multiple-choice', correctIds: value.correctIds as string[], explanation };
  }
  if (directive.type === 'ordering' && Array.isArray(value.correctOrderIds)
    && value.correctOrderIds.length === directive.items.length && new Set(value.correctOrderIds).size === value.correctOrderIds.length
    && value.correctOrderIds.every(id => typeof id === 'string' && directive.items.some(item => item.id === id))) {
    return { interactionId: directive.id, type: 'ordering', correctOrderIds: value.correctOrderIds as string[], explanation };
  }
  return undefined;
}

export function gradeSceneObjectiveResponse(response: SceneInteractionResponse, evaluation?: SceneObjectiveEvaluation): SceneObjectiveAssessment | undefined {
  if (!evaluation || evaluation.interactionId !== response.interactionId || evaluation.type !== response.type) return undefined;
  if (evaluation.type === 'single-choice' && response.type === 'single-choice') {
    return { interactionId: response.interactionId, correct: response.selectedId === evaluation.correctId, explanation: evaluation.explanation };
  }
  if (evaluation.type === 'multiple-choice' && response.type === 'multiple-choice') {
    const selected = new Set(response.selectedIds);
    return { interactionId: response.interactionId, correct: selected.size === evaluation.correctIds.length
      && evaluation.correctIds.every(id => selected.has(id)), explanation: evaluation.explanation };
  }
  if (evaluation.type === 'ordering' && response.type === 'ordering') {
    return { interactionId: response.interactionId, correct: response.orderedIds.length === evaluation.correctOrderIds.length
      && response.orderedIds.every((id, index) => id === evaluation.correctOrderIds[index]), explanation: evaluation.explanation };
  }
  return undefined;
}
