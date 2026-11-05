import type { SceneRunState, SceneSpec } from '../../types';
import type { NodeVerification } from '../../types/sceneS4';
import { collectAncestors } from '../../modules/derivationCanvas/utils/branchGraph';
import { createS4ProofEvidence } from './sceneS4Evidence';

export const S4_GOAL_RETRY_LIMIT = 2;

/** Bind semantic goal coverage to this task and exact branch, never to a reference answer. */
export function s4GoalInputKey(spec: SceneSpec, run: SceneRunState, nodeId: string): string {
  const ids = new Set([nodeId, ...collectAncestors(nodeId, run.canvas?.edges ?? [])]);
  return JSON.stringify({ sceneId: spec.sceneId, task: spec.task, goal: spec.meta.goal, rules: spec.rules,
    symbols: spec.compute?.symbols,
    branch: (run.canvas?.nodes ?? []).filter(node => ids.has(node.id)).map(node => ({
      id: node.id, type: node.type, latex: node.data.latex, entries: node.data.entries,
      legacyGiven: node.type === 'given' && !node.data.entries ? node.data.note : undefined,
    })).sort((a, b) => a.id.localeCompare(b.id)),
    edges: (run.canvas?.edges ?? []).filter(edge => ids.has(edge.target)).map(({source,target}) => ({source,target}))
      .sort((a,b) => a.source.localeCompare(b.source) || a.target.localeCompare(b.target)),
  });
}

export function s4GoalAssessment(spec: SceneSpec, run: SceneRunState, nodeId: string, raw: unknown): NonNullable<NodeVerification['goalAssessment']> {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const reason = typeof data.reason === 'string' ? data.reason.trim() : '';
  const valid = ['achieved','not-achieved','unknown'].includes(String(data.status)) && reason.length > 0 && reason.length <= 800;
  return { status: valid ? data.status as 'achieved' | 'not-achieved' | 'unknown' : 'unknown',
    reason: valid ? reason : '数学验证已完成，但尚未可靠确认是否回答题目目标；可单独重试目标检查或主动结束。',
    inputKey: s4GoalInputKey(spec, run, nodeId) };
}

export function pendingS4GoalNodes(spec: SceneSpec, run: SceneRunState): string[] {
  return createS4ProofEvidence(spec, run.canvas).conclusions.filter(node => {
    const assessment = node.data.verification?.goalAssessment;
    return !assessment || assessment.status === 'unknown' || assessment.inputKey !== s4GoalInputKey(spec, run, node.id);
  }).map(node => node.id);
}

export function s4GoalRetryCount(spec: SceneSpec, run: SceneRunState, nodeId: string): number {
  const key = s4GoalInputKey(spec, run, nodeId);
  return (run.derivationEvents ?? []).filter(event => event.type === 'goal_check_request'
    && event.nodeId === nodeId && event.inputKey === key).length;
}

export function canRetryS4Goal(spec: SceneSpec, run: SceneRunState, nodeId: string): boolean {
  return spec.meta.sceneSkill === 'S4' && spec.sceneId === run.sceneId && run.status === 'running'
    && pendingS4GoalNodes(spec, run).includes(nodeId) && s4GoalRetryCount(spec, run, nodeId) < S4_GOAL_RETRY_LIMIT;
}

export function isS4GoalAchieved(spec: SceneSpec, run: SceneRunState, nodeId: string): boolean {
  const assessment = run.canvas?.nodes.find(node => node.id === nodeId)?.data.verification?.goalAssessment;
  return assessment?.status === 'achieved' && Boolean(assessment.reason?.trim())
    && assessment.inputKey === s4GoalInputKey(spec, run, nodeId);
}
