import type { ScenePromptModuleId, SceneRuntimeAction, SceneRuntimeContract, SceneRuntimeToolId, SceneSpec } from '../../types';
import { SCENE_RUNTIME_INTERACTION_TYPES, resolveSceneRuntimeInteractionProtocol } from './sceneInteraction';
import { getUnifiedSceneRecipe } from './sceneCapabilityRegistry';
import { normalizeSceneExperimentPolicy } from './sceneExperiment';
import { normalizeSceneAnswerFeedback } from './sceneTeachingPolicy';

export const SCENE_RUNTIME_TOOLS: readonly SceneRuntimeToolId[] = [
  'knowledge-notes', 'documents', 'document-arguments', 'argument-chain', 'learner-profile',
  'model-experiment',
];
export const SCENE_RUNTIME_ACTIONS: readonly SceneRuntimeAction[] = [
  'respond', 'clarify', 'challenge', 'evaluate', 'advance', 'summarize', 'finish',
];

function record(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
}
function bounded(raw: unknown, fallback: number, max: number): number {
  return typeof raw === 'number' && Number.isFinite(raw) ? Math.max(0, Math.min(max, Math.round(raw))) : fallback;
}
function ids(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 100
    || raw.some(id => typeof id !== 'string' || !id.trim() || id.length > 500)) {
    throw new Error('场景运行契约的 ID 白名单无效');
  }
  // Never truncate or rewrite an identifier into a different resource's ID.
  return [...new Set(raw)] as string[];
}
function requireRecord(raw: unknown, field: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`场景运行契约 ${field} 必须是对象`);
  return raw as Record<string, unknown>;
}
function validateContract(raw: Record<string, unknown>) {
  const enums: Record<string, readonly string[]> = {
    version: ['1.0'], mode: ['dialogue', 'qa', 'coaching', 'simulation', 'assessment', 'derivation'],
    initiator: ['user', 'agent', 'either'], evaluation: ['none', 'on-request', 'each-answer'], completion: ['user-controlled', 'objective'],
  };
  for (const [key, values] of Object.entries(enums)) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'string' || !values.includes(raw[key] as string))) {
      throw new Error(`场景运行契约 ${key} 无效`);
    }
  }
  for (const [key, values] of Object.entries({ allowedTools: SCENE_RUNTIME_TOOLS,
    allowedActions: SCENE_RUNTIME_ACTIONS, allowedInteractionTypes: SCENE_RUNTIME_INTERACTION_TYPES,
    allowedQuestionItemTypes: ['single-choice', 'multiple-choice', 'true-false'] })) {
    const value = raw[key];
    if (value !== undefined && (!Array.isArray(value) || value.some(item => !values.includes(item as never)))) {
      throw new Error(`场景运行契约 ${key} 必须是有效白名单`);
    }
  }
  if (raw.allowTextFallback !== undefined && typeof raw.allowTextFallback !== 'boolean') throw new Error('场景运行契约 allowTextFallback 无效');
  if (raw.allowConversation !== undefined && typeof raw.allowConversation !== 'boolean') throw new Error('场景运行契约 allowConversation 无效');
  if (raw.flowGuidance !== undefined && (typeof raw.flowGuidance !== 'string' || raw.flowGuidance.length > 6000)) {
    throw new Error('场景流程指令无效或过长；不能通过截断省略约束');
  }
  for (const key of ['maxToolCallsPerTurn', 'maxPlanningSteps', 'maxUserTasksPerTurn']) {
    if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key]))) throw new Error(`场景运行契约 ${key} 无效`);
  }
  if (raw.stages !== undefined && (!Array.isArray(raw.stages) || raw.stages.length > 12)) throw new Error('场景阶段定义无效');
}

/** Keep required lifecycle modules consistent across prompts, tools and UI execution. */
export function isScenePromptModuleEnabled(spec: SceneSpec, moduleId: ScenePromptModuleId): boolean {
  const recipe = getUnifiedSceneRecipe(spec.capabilityRecipeId || spec.behavior?.recipeId || (spec.meta.sceneSkill === 'S4' ? 'guided-derivation' : spec.behavior ? 'guided-practice' : undefined));
  const selected = spec.promptModuleIds || recipe?.defaultPromptModules;
  return Boolean(recipe?.requiredPromptModules.includes(moduleId)
    || (moduleId === 'structured-interaction' && resolveSceneRuntimeInteractionProtocol(spec.behavior?.interaction).allowedTypes.some(type => type !== 'text'))
    || (selected ? selected.includes(moduleId) : !spec.behavior));
}

/** Canvas operations are host-owned; a graph is not an S1 text/choice dialogue. */
function resolveSceneCanvasRuntimeContract(spec: SceneSpec, raw: Record<string, unknown>): SceneRuntimeContract {
  // Retain permission/scope validation, but discard inactive S1 lifecycle metadata.
  // In particular, neither an old unreachable dialogue stage nor answerFeedback
  // may block a mathematical canvas that does not execute either protocol.
  validateContract({ ...raw, stages: undefined, initialStageId: undefined, answerFeedback: undefined });
  const fields = new Set(['version', 'mode', 'initiator', 'allowedTools', 'allowedActions', 'allowedInteractionTypes',
    'allowedQuestionItemTypes', 'allowTextFallback', 'allowConversation', 'scope', 'evaluation', 'answerFeedback',
    'completion', 'maxToolCallsPerTurn', 'maxPlanningSteps', 'maxUserTasksPerTurn', 'flowGuidance', 'stages', 'initialStageId']);
  for (const key of Object.keys(raw)) if (!fields.has(key)) throw new Error(`S4 数理运行契约包含未知字段：${key}`);
  // Older releases serialized S1 permissions into S4. Validate their known shapes,
  // then narrow them away; never inherit an unavailable canvas tool.
  if (Array.isArray(raw.allowedTools) && raw.allowedTools.includes('model-experiment')) {
    throw new Error('S4 数理画布不支持 model-experiment 付费工具');
  }
  const scope = raw.scope === undefined ? {} : requireRecord(raw.scope, 'scope');
  for (const key of Object.keys(scope)) if (!['noteIds', 'documentIds', 'cognitionRecordIds'].includes(key)) {
    throw new Error(`S4 数理运行契约 scope 包含未知字段：${key}`);
  }
  const projectScope = spec.referenceScope === undefined ? undefined : requireRecord(spec.referenceScope, 'referenceScope');
  const intersect = (requested: unknown, selected: unknown) => {
    const requestedIds = ids(requested), selectedIds = ids(selected);
    if (!selectedIds) throw new Error('项目取材范围缺少 ID 白名单');
    return requestedIds ? requestedIds.filter(id => selectedIds.includes(id)) : selectedIds;
  };
  // Shared scope validation still applies, even though no S1 tool executor exists on the canvas.
  return {
    version: '1.0', mode: 'derivation', initiator: 'user',
    allowedTools: [], allowedActions: [], allowedInteractionTypes: [], allowedQuestionItemTypes: [],
    allowTextFallback: false, allowConversation: false,
    scope: { noteIds: projectScope ? intersect(scope.noteIds, projectScope.noteIds) : ids(scope.noteIds),
      documentIds: projectScope ? intersect(scope.documentIds, projectScope.documentIds) : ids(scope.documentIds), cognitionRecordIds: ids(scope.cognitionRecordIds) },
    evaluation: 'none', completion: 'objective',
    // S1 budgets are not the canvas compute/help budgets and must not grant execution.
    maxToolCallsPerTurn: 0, maxPlanningSteps: 0, maxUserTasksPerTurn: 0,
    flowGuidance: typeof raw.flowGuidance === 'string' ? raw.flowGuidance : '在画布创建公式与结论节点，引用前提并逐节点提交；求助仅按已授权 compute/help 配置执行。',
  };
}

/** Always resolve at execution time: stored JSON and model plans are not authority. */
export function resolveSceneRuntimeContract(spec: SceneSpec): SceneRuntimeContract {
  const raw = spec.runtimeContract === undefined ? {} : requireRecord(spec.runtimeContract, 'runtimeContract');
  if (spec.meta.sceneSkill === 'S4') return resolveSceneCanvasRuntimeContract(spec, raw);
  validateContract(raw);
  const recipe = spec.capabilityRecipeId || spec.behavior?.recipeId || (spec.behavior ? 'guided-practice' : undefined);
  const defaultMode = recipe === 'batch-assessment' ? 'assessment'
    : recipe === 'question-answer' ? 'qa'
    : recipe === 'agent-designed' || recipe === 'free-dialogue' || recipe === 'role-dialogue' || !spec.behavior ? 'dialogue'
    : recipe === 'decision-simulation' || recipe === 'case-analysis' ? 'simulation' : 'coaching';
  const modes = ['dialogue', 'qa', 'coaching', 'simulation', 'assessment', 'derivation'];
  const mode = modes.includes(String(raw.mode)) ? raw.mode as SceneRuntimeContract['mode'] : defaultMode;
  const ceiling: SceneRuntimeToolId[] = [];
  if (isScenePromptModuleEnabled(spec, 'resource-grounding')) ceiling.push('knowledge-notes', 'documents', 'document-arguments');
  // Private cognition requires an explicit module, even on old scenes.
  if (spec.promptModuleIds?.includes('personal-cognition-grounding')) ceiling.push('argument-chain');
  if (isScenePromptModuleEnabled(spec, 'profile-personalization') && spec.injectProfile) ceiling.push('learner-profile');
  const requestedTools = Array.isArray(raw.allowedTools) ? raw.allowedTools : ceiling;
  // New paid execution can never be inherited from legacy module defaults.
  if (spec.meta.sceneSkill === 'S1' && spec.promptModuleIds?.includes('model-experiment')) {
    normalizeSceneExperimentPolicy(spec.experimentPolicy);
    ceiling.push('model-experiment');
  }
  const declaredInteraction = record(spec.behavior?.interaction);
  if (declaredInteraction.allowTextFallback === false && (!Array.isArray(declaredInteraction.allowedTypes)
    || !declaredInteraction.allowedTypes.some(type => SCENE_RUNTIME_INTERACTION_TYPES.includes(type)))) {
    throw new Error('场景运行契约禁止文本降级，但没有可执行的互动方式');
  }
  const protocol = resolveSceneRuntimeInteractionProtocol(spec.behavior?.interaction);
  const requestedTypes = Array.isArray(raw.allowedInteractionTypes) ? raw.allowedInteractionTypes : protocol.allowedTypes;
  const allowedInteractionTypes = protocol.allowedTypes.filter(type => requestedTypes.includes(type));
  if (!allowedInteractionTypes.length) throw new Error('场景运行契约未授权可执行的互动方式');
  const questionTypes = ['single-choice', 'multiple-choice', 'true-false'] as const;
  const allowedQuestionItemTypes = questionTypes.filter(type => !Array.isArray(raw.allowedQuestionItemTypes) || raw.allowedQuestionItemTypes.includes(type));
  if (allowedInteractionTypes.includes('question-set') && !allowedQuestionItemTypes.length) throw new Error('题组没有已授权的子题型');
  const evaluation = ['none', 'on-request', 'each-answer'].includes(String(raw.evaluation))
    ? raw.evaluation as SceneRuntimeContract['evaluation']
    : mode === 'dialogue' || mode === 'qa' ? 'none' : 'each-answer';
  const completion = raw.completion === 'user-controlled' || raw.completion === 'objective' ? raw.completion
    : mode === 'dialogue' || mode === 'qa' ? 'user-controlled' : 'objective';
  const actions = Array.isArray(raw.allowedActions) ? raw.allowedActions : SCENE_RUNTIME_ACTIONS;
  const scope = raw.scope === undefined ? {} : requireRecord(raw.scope, 'scope');
  const projectScope = spec.referenceScope === undefined ? undefined : requireRecord(spec.referenceScope, 'referenceScope');
  const intersect = (requested: unknown, selected: unknown) => {
    const requestIds = ids(requested), selectedIds = ids(selected);
    if (!selectedIds) throw new Error('项目取材范围缺少 ID 白名单');
    return requestIds ? requestIds.filter(id => selectedIds.includes(id)) : selectedIds;
  };
  const stages = Array.isArray(raw.stages) ? raw.stages.slice(0, 12).flatMap(item => {
    const stage = record(item);
    if (typeof stage.id !== 'string' || !stage.id.trim() || stage.id.length > 80
      || typeof stage.goal !== 'string' || !stage.goal.trim()) throw new Error('场景阶段定义无效');
    return [{ id: stage.id, goal: stage.goal.slice(0, 500), allowedNext: ids(stage.allowedNext) || [] }];
  }) : [{ id: 'interaction', goal: spec.meta.goal || spec.task, allowedNext: [] }];
  const stageIds = new Set(stages.map(stage => stage.id));
  if (!stages.length || stageIds.size !== stages.length || stages.some(stage => stage.allowedNext.some(id => !stageIds.has(id)))) {
    throw new Error('场景阶段定义或允许的转换无效');
  }
  if (raw.initialStageId !== undefined && (typeof raw.initialStageId !== 'string' || !stageIds.has(raw.initialStageId))) throw new Error('场景阶段初始节点无效');
  return {
    version: '1.0', mode,
    initiator: ['user', 'agent', 'either'].includes(String(raw.initiator))
      ? raw.initiator as SceneRuntimeContract['initiator'] : mode === 'qa' ? 'user' : mode === 'dialogue' ? 'either' : 'agent',
    allowedTools: ceiling.filter(tool => requestedTools.includes(tool)),
    allowedActions: SCENE_RUNTIME_ACTIONS.filter(action => actions.includes(action)
      && (evaluation !== 'none' || action !== 'evaluate')
      && (completion !== 'user-controlled' || action !== 'finish')),
    allowedInteractionTypes,
    allowedQuestionItemTypes,
    allowTextFallback: protocol.allowTextFallback && raw.allowTextFallback !== false && allowedInteractionTypes.includes('text'),
    allowConversation: raw.allowConversation !== false,
    scope: { noteIds: projectScope ? intersect(scope.noteIds, projectScope.noteIds) : ids(scope.noteIds),
      documentIds: projectScope ? intersect(scope.documentIds, projectScope.documentIds) : ids(scope.documentIds), cognitionRecordIds: ids(scope.cognitionRecordIds) },
    evaluation, completion, answerFeedback: normalizeSceneAnswerFeedback(raw.answerFeedback),
    maxToolCallsPerTurn: bounded(raw.maxToolCallsPerTurn, 3, 5),
    maxPlanningSteps: Math.max(1, bounded(raw.maxPlanningSteps, 3, 4)),
    maxUserTasksPerTurn: Math.max(1, bounded(raw.maxUserTasksPerTurn, mode === 'assessment' ? 12 : 1, 12)),
    flowGuidance: typeof raw.flowGuidance === 'string' ? raw.flowGuidance : spec.behavior?.progressionRule || '自然回应用户，按需澄清。',
    stages, initialStageId: typeof raw.initialStageId === 'string' && stageIds.has(raw.initialStageId) ? raw.initialStageId : stages[0].id,
  };
}

export { SCENE_S4_RUNTIME_CONTRACT_DESIGN } from './sceneS4ContractDesign';

export const SCENE_RUNTIME_CONTRACT_DESIGN = `生成 runtimeContract（版本 1.0）：mode 为 dialogue/qa/coaching/simulation/assessment/derivation；initiator 为 user/agent/either；allowedTools 仅可选 knowledge-notes、documents、document-arguments、argument-chain、learner-profile、model-experiment，且必须受已启用提示模块限制；allowedActions 仅 respond/clarify/challenge/evaluate/advance/summarize/finish；allowedInteractionTypes 必须是已装配交互类型的子集；question-set子题型由allowedQuestionItemTypes单独限制，仅single-choice/multiple-choice/true-false，不得借题组绕过用户题型限制；allowTextFallback 只控制文本答案降级。allowConversation独立控制用户普通交流、求助与调整要求，默认true，不要求allowedInteractionTypes包含text；只有用户明确禁止自由交流才设false，不能从“只要单选题”推导关闭。新顶层选择控件用assessment=objective/none区分客观题和策略选择，objective必须私有答案键，本地核对不由场景mode决定。scope 可包含用户实际指定的 noteIds/documentIds/cognitionRecordIds（不得编造 ID，未指定不填）。evaluation只控制学习表现评价，为none/on-request/each-answer。answerFeedback独立定义已答题的公开时机：{correctness:"immediate|on-request|at-end",explanation:"immediate|on-request|at-end"}，两字段分别控制对错与解析；后台始终本地核对，有私有答案键并不代表立即公开。一直答题最后分析时两者均at-end；推进由Agent根据表达与理解证据自主组织，不从题型推导答后立刻出下一题。completion 为 user-controlled/objective。普通对话和答疑默认不评分、由用户决定收场；教学/训练按实际需要评价。maxToolCallsPerTurn 建议 3，maxPlanningSteps 建议 3，maxUserTasksPerTurn 默认 1（整卷按题量配置），flowGuidance 描述必经阶段与允许灵活调整的策略。model-experiment 仅在 S1 显式装配该同名模块且已有 experimentPolicy 时可用；已批准能力计划需要实际实验时应保留该工具，未装配时禁止添加。场景运行契约设计应独立于具体题目与本局聊天记录。`;
