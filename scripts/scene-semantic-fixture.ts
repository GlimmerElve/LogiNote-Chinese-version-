import type { SceneRunState, SceneSpec } from '../src/types';
import type { SceneTurnAgentDependencies } from '../src/services/scene/sceneTurnAgent';
import type { SceneUnderstanding } from '../src/services/scene/sceneUnderstanding';

/** Explicit synthetic decisions for plumbing tests, never a semantic accuracy evaluator. */
export function understandingFixture(sourceId: string, text: string, overrides: Partial<SceneUnderstanding> = {}): SceneUnderstanding {
  return { intent: 'question', userGoal: '解答当前问题', expectedExperience: '直接说明当前问题', requirements: [], exclusions: [],
    informationGaps: [], needsClarification: false, evaluationRequested: false,
    evidence: text ? [{ sourceId, quote: text.slice(0, 180) }] : [],
    ...(overrides.intent === 'build-scene' ? { buildConstraints: { version: 1 as const, interactionPolicy: 'unrestricted' as const,
      answerKinds: [], taskPackaging: 'unrestricted' as const, excludedBehaviors: [], evidence: [{ sourceId, quote: text.slice(0, 180) }] } } : {}), ...overrides };
}
export function turnFixture(spec: SceneSpec, run: SceneRunState, overrides: Partial<SceneUnderstanding> = {}) {
  const latest = [...run.messages].reverse().find(message => message.speakerType === 'user');
  return understandingFixture(latest?.id || '', latest?.content || '', { userGoal: spec.meta.goal || spec.task,
    intent: latest ? 'question' : 'start', informationGaps: [
      { id: 'material', description: '本测试需要的参考材料', kind: 'reference-material' },
      { id: 'personal', description: '本测试需要的个人认知', kind: 'personal-context' },
    ], ...overrides });
}
export function toolNeedFixture(raw: any) {
  const toolRequests = Array.isArray(raw?.toolRequests) ? raw.toolRequests :
    (Array.isArray(raw?.contextSources) ? raw.contextSources : []).map((id: string) => ({ id, query: raw.retrievalQuery || '合成查询' }));
  return { ...raw, toolRequests: toolRequests.map((tool: any) => ({
    needId: ['argument-chain', 'learner-profile'].includes(tool.id) ? 'personal' : 'material',
    reason: '本测试明确需要这项材料', ...tool,
  })) };
}
export function withTurnFixture(spec: SceneSpec, run: SceneRunState, dependencies: SceneTurnAgentDependencies): SceneTurnAgentDependencies {
  const original = dependencies.callLlm;
  return { ...dependencies, callLlm: async request => {
    if (request.workflow === 'scene-turn-plan' && JSON.parse(request.userInput).phase === 'understand') {
      return { content: JSON.stringify({ understanding: turnFixture(spec, run), action: 'respond' }) };
    }
    if (!original) throw new Error('Synthetic test omitted callLlm');
    const result = await original(request);
    if (request.workflow !== 'scene-turn-plan') return result;
    return { ...result, content: JSON.stringify(toolNeedFixture(JSON.parse(result.content))) };
  } };
}
