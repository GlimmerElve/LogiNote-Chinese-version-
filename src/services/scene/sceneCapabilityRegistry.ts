import type { SceneCapabilityId, ScenePromptModuleId, SceneRecipeId, SceneSkillType } from '../../types';
import { sceneCapabilityExecutionContract, sceneModuleExecutionContract } from './sceneExecutionRegistry';

export type SceneCapabilitySurface = 'turn' | 'canvas' | 'shared';

export interface SceneCapabilityDefinition {
  id: SceneCapabilityId;
  label: string;
  surface: SceneCapabilitySurface;
  category: 'input' | 'composite' | 'display' | 'node' | 'relation' | 'action' | 'validator';
  purpose: string;
  sceneSkills: readonly SceneSkillType[];
  rendererId?: string;
  validatorId?: string;
  supportsTopLevel?: boolean;
  userCreatable?: boolean;
  children?: readonly SceneCapabilityId[];
  maxItems?: number;
  taskPreparation?: 'shuffle-objective-options-once' | 'shuffle-ordering-items-once' | 'preserve-order' | 'prepare-registered-children-once';
}

export interface UnifiedSceneRecipeDefinition {
  id: SceneRecipeId;
  label: string;
  surface: Exclude<SceneCapabilitySurface, 'shared'>;
  sceneSkill: 'S1' | 'S4';
  purpose: string;
  execution: 'turn-by-turn' | 'batch' | 'graph-workflow';
  preferredCapabilities: readonly SceneCapabilityId[];
  requiredCapabilities: readonly SceneCapabilityId[];
  /** 旧入口没有显式装配时的兼容默认值；Agent 显式传入后不会自动追加。 */
  defaultPromptModules: readonly ScenePromptModuleId[];
  /** 即使 Agent 精简装配也不能删除的执行契约。 */
  requiredPromptModules: readonly ScenePromptModuleId[];
}

export interface ScenePromptModuleDefinition {
  id: ScenePromptModuleId;
  label: string;
  purpose: string;
  sceneSkills: readonly ('S1' | 'S4')[];
}

export const SCENE_PROMPT_MODULE_DEFINITIONS: readonly ScenePromptModuleDefinition[] = [
  { id: 'input-form', label: '场景表单', purpose: '按用户目标设计1–8个文本/多行/选择字段，通过已授权text交互提交；不增加工具权限、不执行代码；适合提示词实验、结构化案例或材料输入，不替代仅单选/判断等显式题型约束', sceneSkills: ['S1'] },
  { id: 'model-experiment', label: '模型实验', purpose: '独立执行已提交的提示词、保留原始结果并隔离评估；会发送提交文本并消耗模型额度，不自动读取笔记', sceneSkills: ['S1'] },
  { id: 'role-context', label: '角色语境', purpose: '注入 NPC 角色卡、用户身份与角色回应约束', sceneSkills: ['S1', 'S4'] },
  { id: 'scenario-framing', label: '情境叙事', purpose: '注入背景、开场旁白、额外设定与已发生事实', sceneSkills: ['S1'] },
  { id: 'resource-grounding', label: '资源依据', purpose: '在生成和回合中使用绑定资源与引用', sceneSkills: ['S1', 'S4'] },
  { id: 'personal-cognition-grounding', label: '个人论证链', purpose: '按本轮问题检索用户已确认的观点与支持/反对关系；仅作个人认知，不作为事实证据', sceneSkills: ['S1'] },
  { id: 'structured-interaction', label: '结构化交互', purpose: '按已装配组件输出可执行的作答或操作指令', sceneSkills: ['S1', 'S4'] },
  { id: 'deterministic-assessment', label: '确定性评卷', purpose: '由本地答案核对直接评分，不调用角色、指标或事件推理', sceneSkills: ['S1'] },
  { id: 'adaptive-progression', label: '自适应推进', purpose: '根据上一轮表现调整下一轮内容和难度', sceneSkills: ['S1'] },
  { id: 'turn-agent-planning', label: '回合 Agent 规划', purpose: '每轮根据用户最新回答重新决定动作、检索源、交互组件与回应策略', sceneSkills: ['S1'] },
  { id: 'metric-state', label: '指标状态', purpose: '注入并更新场景指标、阈值与成败判定', sceneSkills: ['S1', 'S4'] },
  { id: 'event-system', label: '事件系统', purpose: '注入预设转折、条件触发与手动事件入口', sceneSkills: ['S1'] },
  { id: 'profile-personalization', label: '画像个性化', purpose: '把符合可信门槛的学习画像注入模型上下文', sceneSkills: ['S1', 'S4'] },
];

/**
 * 两套场景运行引擎共享的能力事实源。
 *
 * 注册只说明“系统已经能执行什么”，不承载 React 组件实例，也不改变运行时分派：
 * turn 仍由 SceneChatView/通用回合引擎执行，canvas 仍由
 * SceneDerivationView/前提链与计算引擎执行。
 */
export const SCENE_CAPABILITY_DEFINITIONS: readonly SceneCapabilityDefinition[] = [
  { id: 'text', label: '自由作答', surface: 'turn', category: 'input', purpose: '解释、论证、复述或开放回答', sceneSkills: ['S1'], rendererId: 'text-input', validatorId: 'text-response', supportsTopLevel: true, userCreatable: true },
  { id: 'single-choice', label: '单选 / 回应策略', surface: 'turn', category: 'input', purpose: '唯一答案选择题，或带标题与说明的单一回应策略卡', sceneSkills: ['S1'], rendererId: 'choice-input', validatorId: 'single-choice-response', supportsTopLevel: true, userCreatable: true, taskPreparation: 'shuffle-objective-options-once' },
  { id: 'multiple-choice', label: '多选 / 组合策略', surface: 'turn', category: 'input', purpose: '多个答案选择题，或允许组合的回应策略卡', sceneSkills: ['S1'], rendererId: 'choice-input', validatorId: 'multiple-choice-response', supportsTopLevel: true, userCreatable: true, taskPreparation: 'shuffle-objective-options-once' },
  { id: 'true-false', label: '判断', surface: 'turn', category: 'input', purpose: '题组内的对错判断题', sceneSkills: ['S1'], rendererId: 'true-false-input', validatorId: 'true-false-response', supportsTopLevel: false, userCreatable: true, taskPreparation: 'preserve-order' },
  { id: 'ordering', label: '排序', surface: 'turn', category: 'input', purpose: '步骤、事件或流程排序', sceneSkills: ['S1'], rendererId: 'ordering-input', validatorId: 'ordering-response', supportsTopLevel: true, userCreatable: true, taskPreparation: 'shuffle-ordering-items-once' },
  { id: 'fill-blanks', label: '填空', surface: 'turn', category: 'input', purpose: '一个或多个明确空位', sceneSkills: ['S1'], rendererId: 'fill-blanks-input', validatorId: 'fill-blanks-response', supportsTopLevel: true, userCreatable: true },
  {
    id: 'question-set', label: '题组/整卷', surface: 'turn', category: 'composite',
    purpose: '多道选择与判断题同屏、一次提交、提交后统一反馈', sceneSkills: ['S1'],
    rendererId: 'question-set-input', validatorId: 'question-set-response', supportsTopLevel: true,
    taskPreparation: 'prepare-registered-children-once',
    userCreatable: true, children: ['single-choice', 'multiple-choice', 'true-false'], maxItems: 12,
  },
  { id: 'markdown-content', label: '富文本材料', surface: 'shared', category: 'display', purpose: '展示 Markdown、公式、表格、代码与引用来源', sceneSkills: ['S1', 'S4'], rendererId: 'scene-rich-message', userCreatable: false },
  { id: 'given-node', label: '系统已知条件', surface: 'canvas', category: 'node', purpose: '把场景初始事实、定义和定义域作为冻结前提包展示', sceneSkills: ['S4'], rendererId: 'given-node', validatorId: 'given-premise-package', userCreatable: false },
  { id: 'assumption-node', label: '假设前提', surface: 'canvas', category: 'node', purpose: '添加只对连线下游生效的用户假设，并检查语法和前提冲突', sceneSkills: ['S4'], rendererId: 'assumption-node', validatorId: 'assumption-step-analyzer', userCreatable: true },
  { id: 'formula-node', label: '公式步骤', surface: 'canvas', category: 'node', purpose: '使用 MathLive 编写并提交中间推导步骤', sceneSkills: ['S4'], rendererId: 'formula-node', validatorId: 'premise-step-analyzer', userCreatable: true },
  { id: 'conclusion-node', label: '结论', surface: 'canvas', category: 'node', purpose: '提交推导支路的最终结论并触发完成判定', sceneSkills: ['S4'], rendererId: 'conclusion-node', validatorId: 'premise-step-analyzer', userCreatable: true },
  { id: 'derivation-edge', label: '推导连线', surface: 'canvas', category: 'relation', purpose: '显式声明目标节点引用的前提；拒绝自环、重复边和循环推导', sceneSkills: ['S4'], rendererId: 'derivation-edge', validatorId: 'dag-edge-validator', userCreatable: true },
  { id: 'mathlive-editor', label: 'MathLive 公式编辑', surface: 'canvas', category: 'input', purpose: '为假设、公式和结论节点提供 LaTeX 输入', sceneSkills: ['S4'], rendererId: 'mathlive-field', userCreatable: true },
  { id: 'step-submit', label: '步骤提交', surface: 'canvas', category: 'action', purpose: '提交单个节点，进入前提链分析、指标更新和完成判定', sceneSkills: ['S4'], validatorId: 'node-submit-pipeline', userCreatable: true },
  { id: 'premise-validation', label: '前提链判定', surface: 'canvas', category: 'validator', purpose: '依据入边收集前提并验证当前步骤是否合法', sceneSkills: ['S4'], validatorId: 'premise-chain', userCreatable: false },
  { id: 'compute-help', label: '限次推导求助', surface: 'canvas', category: 'action', purpose: '结合当前支路与用户问题给出分层提示，可将建议公式插入画布', sceneSkills: ['S4'], rendererId: 'helper-panel', validatorId: 'help-budget', userCreatable: true },
];

export const UNIFIED_SCENE_RECIPE_DEFINITIONS: readonly UnifiedSceneRecipeDefinition[] = [
  { id: 'agent-designed', label: '按目标自由设计', surface: 'turn', sceneSkill: 'S1', purpose: '配方不预设业务流程；由目标、能力计划和运行契约决定交互、反馈与推进', execution: 'turn-by-turn', preferredCapabilities: ['text'], requiredCapabilities: [], defaultPromptModules: ['turn-agent-planning'], requiredPromptModules: ['turn-agent-planning'] },
  { id: 'free-dialogue', label: '自由对话', surface: 'turn', sceneSkill: 'S1', purpose: '围绕目标自然交流，按需澄清、展开或总结，不默认评分或持续追问', execution: 'turn-by-turn', preferredCapabilities: ['text'], requiredCapabilities: ['text'], defaultPromptModules: ['turn-agent-planning', 'resource-grounding'], requiredPromptModules: ['turn-agent-planning'] },
  { id: 'question-answer', label: '问题答疑', surface: 'turn', sceneSkill: 'S1', purpose: '用户主动提问，Agent 按需检索、澄清并回答，允许连续追问', execution: 'turn-by-turn', preferredCapabilities: ['text'], requiredCapabilities: ['text'], defaultPromptModules: ['turn-agent-planning', 'resource-grounding'], requiredPromptModules: ['turn-agent-planning'] },
  { id: 'role-dialogue', label: '角色对话', surface: 'turn', sceneSkill: 'S1', purpose: '维持人物立场、共同事实与对话承诺，自然回应用户', execution: 'turn-by-turn', preferredCapabilities: ['text'], requiredCapabilities: ['text'], defaultPromptModules: ['turn-agent-planning', 'role-context', 'scenario-framing'], requiredPromptModules: ['turn-agent-planning', 'role-context'] },
  { id: 'guided-practice', label: '逐题练习', surface: 'turn', sceneSkill: 'S1', purpose: '每轮一题，立即反馈并自适应下一题', execution: 'turn-by-turn', preferredCapabilities: ['single-choice', 'multiple-choice', 'fill-blanks', 'ordering', 'text'], requiredCapabilities: [], defaultPromptModules: ['resource-grounding', 'structured-interaction', 'adaptive-progression', 'turn-agent-planning', 'profile-personalization'], requiredPromptModules: ['turn-agent-planning'] },
  { id: 'batch-assessment', label: '整卷测评', surface: 'turn', sceneSkill: 'S1', purpose: '多题同屏，一次提交，提交后统一评卷', execution: 'batch', preferredCapabilities: ['question-set'], requiredCapabilities: ['question-set'], defaultPromptModules: ['resource-grounding', 'structured-interaction', 'deterministic-assessment'], requiredPromptModules: ['structured-interaction', 'deterministic-assessment'] },
  { id: 'socratic-dialogue', label: '苏格拉底对话', surface: 'turn', sceneSkill: 'S1', purpose: '通过复述、澄清、反例和迁移追问推进理解', execution: 'turn-by-turn', preferredCapabilities: ['text'], requiredCapabilities: ['text'], defaultPromptModules: ['resource-grounding', 'adaptive-progression', 'turn-agent-planning', 'profile-personalization'], requiredPromptModules: ['turn-agent-planning'] },
  { id: 'case-analysis', label: '案例分析', surface: 'turn', sceneSkill: 'S1', purpose: '围绕材料进行选择、判断和解释', execution: 'turn-by-turn', preferredCapabilities: ['single-choice', 'multiple-choice', 'text'], requiredCapabilities: [], defaultPromptModules: ['scenario-framing', 'resource-grounding', 'structured-interaction', 'adaptive-progression', 'turn-agent-planning'], requiredPromptModules: ['turn-agent-planning'] },
  { id: 'decision-simulation', label: '情境决策', surface: 'turn', sceneSkill: 'S1', purpose: '做出决策并观察后果与新事件', execution: 'turn-by-turn', preferredCapabilities: ['single-choice', 'multiple-choice', 'text'], requiredCapabilities: [], defaultPromptModules: ['role-context', 'scenario-framing', 'structured-interaction', 'adaptive-progression', 'turn-agent-planning', 'metric-state', 'event-system'], requiredPromptModules: ['turn-agent-planning'] },
  { id: 'process-training', label: '流程训练', surface: 'turn', sceneSkill: 'S1', purpose: '排序步骤、补全环节并解释依据', execution: 'turn-by-turn', preferredCapabilities: ['ordering', 'fill-blanks', 'text'], requiredCapabilities: [], defaultPromptModules: ['resource-grounding', 'structured-interaction', 'adaptive-progression', 'turn-agent-planning'], requiredPromptModules: ['turn-agent-planning'] },
  {
    id: 'guided-derivation', label: '引导式数理推导', surface: 'canvas', sceneSkill: 'S4',
    purpose: '在显式前提图上创建假设、公式步骤和结论，逐节点提交判定并按需限次求助',
    execution: 'graph-workflow',
    preferredCapabilities: ['given-node', 'assumption-node', 'formula-node', 'conclusion-node', 'derivation-edge', 'mathlive-editor', 'step-submit', 'premise-validation', 'compute-help'],
    requiredCapabilities: ['given-node', 'formula-node', 'conclusion-node', 'derivation-edge', 'mathlive-editor', 'step-submit', 'premise-validation'],
    defaultPromptModules: ['role-context', 'resource-grounding', 'structured-interaction', 'metric-state', 'profile-personalization'],
    requiredPromptModules: ['structured-interaction'],
  },
];

const CAPABILITY_BY_ID = new Map(SCENE_CAPABILITY_DEFINITIONS.map((item) => [item.id, item]));
const RECIPE_BY_ID = new Map(UNIFIED_SCENE_RECIPE_DEFINITIONS.map((item) => [item.id, item]));
const PROMPT_MODULE_BY_ID = new Map(SCENE_PROMPT_MODULE_DEFINITIONS.map((item) => [item.id, item]));

export function getSceneCapability(id: SceneCapabilityId): SceneCapabilityDefinition | undefined {
  return CAPABILITY_BY_ID.get(id);
}

export const SCENE_CAPABILITY_IDS: readonly SceneCapabilityId[] = SCENE_CAPABILITY_DEFINITIONS.map((item) => item.id);
export const SCENE_PROMPT_MODULE_IDS: readonly ScenePromptModuleId[] = SCENE_PROMPT_MODULE_DEFINITIONS.map((item) => item.id);

export function normalizeScenePromptModuleId(value: unknown): ScenePromptModuleId | undefined {
  return typeof value === 'string' && PROMPT_MODULE_BY_ID.has(value as ScenePromptModuleId)
    ? value as ScenePromptModuleId
    : undefined;
}

export function buildScenePromptModulePrompt(): string {
  return SCENE_PROMPT_MODULE_DEFINITIONS.map((module) => {
    const execution = sceneModuleExecutionContract(module.id);
    const dependencies = [...execution.requiresCapabilities, ...execution.requiresModules.map(id => `module:${id}`)];
    return `- ${module.id}（${module.label}）：${module.purpose}；依赖 ${dependencies.join('、') || '无额外依赖'}；${execution.handoff}`;
  }).join('\n');
}

export function normalizeSceneCapabilityId(value: unknown): SceneCapabilityId | undefined {
  return typeof value === 'string' && CAPABILITY_BY_ID.has(value as SceneCapabilityId)
    ? value as SceneCapabilityId
    : undefined;
}

export function listSceneCapabilities(options: { surface?: SceneCapabilitySurface; sceneSkill?: SceneSkillType } = {}): SceneCapabilityDefinition[] {
  return SCENE_CAPABILITY_DEFINITIONS.filter((capability) => (
    (!options.surface || capability.surface === options.surface)
    && (!options.sceneSkill || capability.sceneSkills.includes(options.sceneSkill))
  ));
}

export function normalizeUnifiedSceneRecipeId(value: unknown): SceneRecipeId | undefined {
  return typeof value === 'string' && RECIPE_BY_ID.has(value as SceneRecipeId)
    ? value as SceneRecipeId
    : undefined;
}

export function getUnifiedSceneRecipe(id?: SceneRecipeId): UnifiedSceneRecipeDefinition | undefined {
  return id ? RECIPE_BY_ID.get(id) : undefined;
}

export function sceneSurfaceForSkill(sceneSkill: SceneSkillType): 'turn' | 'canvas' | undefined {
  if (sceneSkill === 'S1') return 'turn';
  if (sceneSkill === 'S4') return 'canvas';
  return undefined;
}

export function isSceneRecipeCompatible(recipeId: SceneRecipeId, sceneSkill: SceneSkillType): boolean {
  const recipe = getUnifiedSceneRecipe(recipeId);
  return Boolean(recipe && recipe.sceneSkill === sceneSkill && recipe.surface === sceneSurfaceForSkill(sceneSkill));
}

export function buildUnifiedSceneCapabilityPrompt(surface?: SceneCapabilitySurface): string {
  return listSceneCapabilities({ surface }).map((capability) => {
    const children = capability.children?.length
      ? `；可包含 ${capability.children.join('、')}，最多 ${capability.maxItems} 项`
      : '';
    const actor = capability.userCreatable ? '用户可操作' : '系统能力';
    const preparation = capability.taskPreparation ? `；本地任务准备 ${capability.taskPreparation}，一次保存、不变更答案 id；语义保序可声明 orderPolicy` : '';
    const execution = sceneCapabilityExecutionContract(capability.id);
    const dependencies = [...execution.requiresCapabilities, ...execution.requiresModules.map(id => `module:${id}`)];
    return `- ${capability.id}（${capability.label}，${capability.surface}，${actor}）：${capability.purpose}${children}${preparation}；依赖 ${dependencies.join('、') || '无额外依赖'}；界面槽位 ${execution.uiSlots.join('、') || '无独占槽位'}`;
  }).join('\n');
}

export function buildUnifiedSceneRecipePrompt(surface?: 'turn' | 'canvas'): string {
  return UNIFIED_SCENE_RECIPE_DEFINITIONS
    .filter((recipe) => !surface || recipe.surface === surface)
    .map((recipe) => (
      `- ${recipe.id}（${recipe.label}，${recipe.surface}/${recipe.execution}）：${recipe.purpose}；必需能力 ${recipe.requiredCapabilities.join('、')}；优先能力 ${recipe.preferredCapabilities.join('、')}；兼容默认提示模块 ${recipe.defaultPromptModules.join('、') || '无'}`
    ))
    .join('\n');
}
