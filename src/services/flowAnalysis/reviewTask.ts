import type { FlowAnalysisInput } from './types';
import type { ShadowInput } from '../flowShadow/types';

/** Only caller-provided requirements can make missing performance eligible for zero. */
export function buildFlowReviewTask(input: FlowAnalysisInput): ShadowInput['task'] {
  if (input.reviewTask) return structuredClone(input.reviewTask);
  return {
    id: input.noteId || input.noteTitle || 'flow-review',
    goal: '自由复述所学内容，评价本次实际展示的表现；不强制展示所有三层能力。',
    family: 'free_review', requiredLayers: [], promptedBehaviors: [],
  };
}
