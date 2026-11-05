import type { SceneSpec } from '../../types';

export const SCENE_DIALOGUE_PATCH_TARGETS = ['task', 'rules', 'behavior', 'runtimeContract', 'completion', 'agentInstructions', 'situation',
  'role', 'userRole', 'openingNarrative', 'resources', 'metrics', 'events', 'evaluationDimensions', 'extras', 'goal', 'subject', 'knowledgePoints', 'experimentPolicy', 'inputForm'] as const;
export type SceneAcceptancePatchTarget = typeof SCENE_DIALOGUE_PATCH_TARGETS[number];
const CANVAS_PATCH_TARGETS: readonly SceneAcceptancePatchTarget[] = ['task', 'rules', 'runtimeContract', 'completion', 'agentInstructions', 'situation',
  'role', 'userRole', 'resources', 'metrics', 'evaluationDimensions', 'goal', 'subject', 'knowledgePoints'];

export function sceneAcceptancePatchTargets(scene: SceneSpec): readonly SceneAcceptancePatchTarget[] {
  return scene.meta.sceneSkill === 'S4' ? CANVAS_PATCH_TARGETS : SCENE_DIALOGUE_PATCH_TARGETS;
}

export const SCENE_CANVAS_ACCEPTANCE_POLICY = `本次只验收S4数理画布范式，不验收S1对话回合工作流。
检查数学任务、必要已知条件和适用条件是否清楚；用户能否创建节点、声明前提连线、逐节点提交，再形成已验证的完整结论支路。允许不同的合法推导路线，不强迫匹配参考解步骤。
数学合法性以本地前提链引擎为准，语言模型仅解释与限次求助，不能替代引擎裁决。求助受compute-help能力与额度约束，不是自由对话工具。role是助手表达风格，不是必须扮演的NPC。
预览不应含compute/help、最终答案或完整参考步骤；这些私有配置在用户确认开始后生成，缺少它们不是预览缺陷。
S4没有behavior、inputForm、experimentPolicy，不要求题目控件、答题记录、逐回合理解规划回应循环或S1阶段图；不能为了满足验收而添加它们。agentInstructions只是保存的助手策略说明，不证明一个S1互动Agent已接管画布。
canvasPreflight只证明本地静态预检已通过，不证明数学引擎已运行、真实模型语义准确或UI已测试。不得把S1对话探针当作S4执行证据。
S4的completion.maxTurns是节点验证提交次数上限，不是对话回合；重新提交和失败计数，编辑、求助、讲解不计数。
修复只能选择本次patchTargets；runtimeContract只允许调整flowGuidance，completion只允许调整maxTurns（1–100整数），不可替换引擎拥有的验证/完成协议。装配缺陷应请求原授权范围内的assemblyIssues，而不是添加S1字段。`;

export const SCENE_DIALOGUE_ACCEPTANCE_POLICY = `本次验收S1互动Agent范式：按目标及授权的互动组件与工具组织对话、答题或实验，不套用S4节点、前提连线和数学引擎的完成条件。
localProtocolProbes只证明本地对话协议探针的结果，不证明真实模型语义准确或UI已测试。`;

function stableJson(value: unknown): string | undefined {
  if (Array.isArray(value)) return 'array:' + JSON.stringify(value.map(item => stableJson(item)));
  if (value && typeof value === 'object') return 'object:' + JSON.stringify(Object.entries(value)
    .filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, stableJson(item)]));
  return JSON.stringify(value);
}

/** Canvas field repair can change strategy, not the engine-owned execution contract. */
export function isSceneCanvasProtocolPatchAllowed(scene: SceneSpec, patch: Record<string, unknown>): boolean {
  if (scene.meta.sceneSkill !== 'S4') return true;
  for (const [field, strategyKey] of [['runtimeContract', 'flowGuidance'], ['completion', 'maxTurns']] as const) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const strategy = (value as Record<string, unknown>)[strategyKey];
    if (field === 'completion' && (!Number.isInteger(strategy) || Number(strategy) < 1 || Number(strategy) > 100)) return false;
    if (field === 'runtimeContract' && (typeof strategy !== 'string' || !strategy.trim() || strategy.length > 6000)) return false;
    const withoutStrategy = (object: object) => Object.fromEntries(Object.entries(object).filter(([key]) => key !== strategyKey));
    if (stableJson(withoutStrategy(value)) !== stableJson(withoutStrategy(scene[field] || {}))) return false;
  }
  return true;
}
