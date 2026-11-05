import type { NoteItem } from '../types';
import { getLearningCompletionTarget, setLearningCompletion, type LearningTaskBinding } from './learningCompletion';
import { getPlanMilestoneGate, togglePlanMilestoneCompletion } from './planMilestoneState';
import { getScheduledProjectState, toggleScheduledProjectCompletion } from './planProjectState';

/** An explicit acknowledgement, not a toggle that can reverse a successful retry. */
export type PlanCompletionIntent =
  | { kind: 'project'; projectId: string; completed: boolean }
  | { kind: 'execution'; binding: LearningTaskBinding; completed: boolean }
  | { kind: 'milestone'; rootId: string; milestoneId: string; completed: boolean };

export function applyPlanCompletionIntent(notes: NoteItem[], intent: PlanCompletionIntent, now = new Date().toISOString()): NoteItem[] {
  if (intent.kind === 'execution') {
    const target = getLearningCompletionTarget(notes, intent.binding);
    if (!target || target.kind !== 'execution') throw new Error('该执行事项已调整或移除，请重新查看计划。');
    return setLearningCompletion(notes, target, intent.completed, now);
  }
  if (intent.kind === 'project') {
    const project = notes.filter(note => note.id === intent.projectId && note.noteType === 'project');
    const state = getScheduledProjectState(notes, intent.projectId);
    if (project.length !== 1 || !state.hasScheduledWork) throw new Error('该项目已取消排期或移除，请重新查看计划。');
    return state.completed === intent.completed ? notes : toggleScheduledProjectCompletion(notes, intent.projectId, now);
  }
  const roots = notes.filter(note => note.id === intent.rootId && note.noteType === 'project');
  const matches = roots.length === 1 ? roots[0].planMeta?.milestones?.filter(item => item.id === intent.milestoneId) : [];
  const milestone = matches?.length === 1 ? matches[0] : undefined;
  if (!milestone) throw new Error('该里程碑已调整或移除，请重新查看计划。');
  if (Boolean(milestone.completed) === intent.completed) return notes;
  if (intent.completed && !getPlanMilestoneGate(notes, intent.rootId, milestone).ready) {
    throw new Error('里程碑的前置项目尚未全部完成，请先完成后再验收。');
  }
  return togglePlanMilestoneCompletion(notes, intent.rootId, intent.milestoneId, now);
}
