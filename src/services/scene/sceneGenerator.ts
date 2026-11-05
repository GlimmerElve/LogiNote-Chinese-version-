/**
 * 场景生成流水线：需求/装配后独立设计流程与专属指令，编译场景并做语义验收。
 *
 * 阶段一 decideScene：把 manifest 清单交给 LLM，判断「复用已有骨架(adapt)」还是「全新生成(new)」。
 * 阶段二 generateScene / adaptScene：按决策分支产出可预览 SceneSpec；S4 的 compute/help 延迟到开始时生成。
 *
 * 关键约束：
 * - 产出**永远是新 sceneId**，绝不覆盖源场景（sourceSceneId 仅作血缘记录）。
 * - adapt 允许 LLM 自推翻（adaptedFromExisting=false），前端以最终输出为准。
 * - 解析失败容错后重试一次（边界⑤）；mode=metric 但无指标则降级 signal（边界⑥）。
 */

import { callLLM } from '../llmService';
import { parseJsonLenient } from '../reviewSegmentScoring';
import {
  SceneSpec,
  SceneSkillManifest,
  SceneDecideResult,
  SceneEvent,
  SceneSkillType,
  DialogueParadigm,
  SceneCapabilityId,
  ScenePromptModuleId,
  SceneRecipeId,
  SceneInteractionType,
  SCENE_MANIFEST_PROMPT_LIMIT,
} from '../../types';
import {
  generateSceneId,
  saveScene as persistScene,
  bumpReuseCount,
} from './sceneSkillStore';
// S4 专属类型与工具（仅用于 compute/help 的容错解析与系统重算，不影响 S1 路径）
import type { ComputeSpec, HelpSpec, PremiseEntry, PremiseEntryKind } from '../../types/sceneS4';
import { SCENE_SKILL_S4, normalizeExpectedSteps } from '../../types/sceneS4';
import { computeMaxHelp } from './derivationRuntime';
import { s4HelpPenalty } from './sceneS4Policy';
import { parseBehaviorSpec } from './sceneParadigm';
import {
  getUnifiedSceneRecipe,
  isSceneRecipeCompatible,
  normalizeSceneCapabilityId,
  normalizeScenePromptModuleId,
  normalizeUnifiedSceneRecipeId,
} from './sceneCapabilityRegistry';
import { resolveSceneAssembly } from './sceneAssembly';
import { resolveSceneRuntimeContract, SCENE_RUNTIME_CONTRACT_DESIGN } from './sceneRuntimeContract';
import { SCENE_S4_RUNTIME_CONTRACT_DESIGN } from './sceneS4ContractDesign';
import { SCENE_S4_METRIC_DESIGN } from './sceneS4MetricDesign';
import { acceptSceneDesign, applySceneBehaviorDesign, designSceneBehavior, sceneBuildTask,
  reassembleSceneDesign, SceneAssemblyRevisionRequired, type SceneBuildRepairBudget,
  type SceneBuildContext, type SceneBuildDependencies, type SceneBuildRecovery, type SceneBuildAssemblyIssue } from './sceneBuildAgent';
import { runSceneSetupStage, SceneSetupError, type SceneSetupDiagnostic, type SceneSetupStage } from './sceneSetupStage';
import { captureSceneBuildAuthority, assertSceneBuildAuthority, SceneBuildAuthorityError, type SceneBuildAuthority } from './sceneBuildAuthority';
import { preflightSceneSpec } from './sceneAssembly';
import { SceneUnderstandingError } from './sceneUnderstanding';
import { normalizeSceneExperimentPolicy } from './sceneExperiment';
import { normalizeSceneInputForm } from './sceneInputForm';
import { normalizeScenePresentation, SCENE_PRESENTATION_TEXT_RULE } from './scenePresentation';
import type { LlmCallRequest, LlmCallResponse } from '../../types';

/** 生成场景的输入 */
export interface GenerateSceneOpts {
  /** Original brief and accepted design artifacts; never reconstructed only from a short summary. */
  buildContext?: SceneBuildContext;
  signal?: AbortSignal;
  onDiagnostic?: (diagnostic: SceneSetupDiagnostic) => void;
  onStage?: (stage: SceneSetupStage) => void;
  /** Session-private ref only. Do not persist, log, or send this recovery object to a model. */
  resume?: SceneBuildCheckpoint;
  onCheckpoint?: (checkpoint: SceneBuildCheckpoint) => void;
  callLlm?: (request: LlmCallRequest) => Promise<LlmCallResponse>;
  subject: string;
  knowledgePoints: string[];
  /** 期望角色描述（可选，来自搭建面板的「补充条件」） */
  roleHints?: string;
  /** 其它要求（可选，来自搭建面板的「补充条件」） */
  extraHints?: string;
  /** Agent 选定的声明式场景配方；用于约束生成及多 Agent 间稳定移交。 */
  recipeId?: SceneRecipeId;
  /** Agent/用户显式要求的可选能力；配方必需与优选能力由装配器补齐。 */
  requestedCapabilities?: SceneCapabilityId[];
  /** Agent 明确选中的提示词模块；未选模块不进入生成和运行链。 */
  requestedPromptModules?: ScenePromptModuleId[];
  /**
   * 场景类型（可选，缺省视为 'S1'）。
   *
   * **「两个框架」的分派开关**，决定走哪套提示词与 workflow：
   * - `'S1'` → 对话场景（`SCENE_GENERATE_PROMPT` / `scene-generate`）
   * - `'S4'` → 数理画布预览外壳（`SCENE_COMPUTE_GENERATE_PROMPT` / `scene-compute-generate`）
   *
   * 缺省保持 'S1'，保证 S1 生成路径行为与改动前完全一致。
   */
  sceneSkill?: SceneSkillType;
}

/** 改编场景的输入 */
export interface AdaptSceneOpts extends GenerateSceneOpts {
  sourceSpec: SceneSpec;
}

/**
 * 把场景清单渲染成 prompt 中的「可用场景架构清单」。
 * 条目上限 SCENE_MANIFEST_PROMPT_LIMIT（30），超出时按 reuseCount 降序截取（边界⑦）。
 */
export function buildManifestPromptSection(manifest: SceneSkillManifest): string {
  const scenes = Array.isArray(manifest?.scenes) ? manifest.scenes : [];
  if (scenes.length === 0) return '当前场景库为空，只能全新生成。';

  const picked = [...scenes]
    .sort((a, b) => (b.reuseCount || 0) - (a.reuseCount || 0))
    .slice(0, SCENE_MANIFEST_PROMPT_LIMIT);

  const lines = picked.map((s, i) => {
    const a = s.architecture;
    return [
      `${i + 1}. sceneId=${s.sceneId}｜名称：${s.name}｜学科：${s.subject}｜Skill：${s.sceneSkill}`,
      `   知识点：${(s.knowledgePoints || []).join('、') || '无'}`,
      `   学习目标：${s.goal || '无'}`,
      `   交互范式：${a?.paradigmLabel || '未知'}`,
      a?.behaviorKind ? `   通用交互形式：${a.behaviorKind}` : '',
      a?.recipeId ? `   场景配方：${a.recipeId}` : '',
      `   可执行交互：${(a?.interactionTypes || ['text']).join('、')}`,
      a?.capabilityIds?.length ? `   装配能力：${a.capabilityIds.join('、')}` : '',
      a?.promptModuleIds?.length ? `   提示词模块：${a.promptModuleIds.join('、')}` : '',
      `   技术：${(a?.technologies || []).join('、') || '无'}｜引擎：${(a?.engines || []).join('、') || '无'}`,
      `   突发事件：${a?.hasEvents ? '有' : '无'}｜可注入事件：${a?.eventInjection ? '是' : '否'}｜画像注入：${a?.injectProfile ? '是' : '否'}`,
      `   复用次数：${s.reuseCount || 0}`,
    ].filter(Boolean).join('\n');
  });

  return `可用场景架构清单（共 ${picked.length} 条，按复用次数排序）：\n${lines.join('\n')}`;
}

/**
 * 把用户主题渲染成统一的输入段落（decide / generate / adapt 三处共用）。
 * 用户补充条件（roleHints / extraHints）为空时整段省略，避免污染 prompt。
 */
export function buildTopicSection(opts: GenerateSceneOpts): string {
  const lines = [
    `## 学习主题`,
    opts.subject,
    ``,
    `## 关联知识点`,
    opts.knowledgePoints.length > 0 ? opts.knowledgePoints.join('、') : '（未指定，请自行推断）',
  ];

  const roleHints = (opts.roleHints || '').trim();
  if (roleHints) {
    lines.push(``, `## 期望角色描述（用户指定，请据此设计 role）`, roleHints);
  }

  const extraHints = (opts.extraHints || '').trim();
  if (extraHints) {
    lines.push(``, `## 其它要求`, extraHints);
  }

  const recipe = getUnifiedSceneRecipe(opts.recipeId);
  if (recipe) {
    const requestedSkill = opts.sceneSkill || 'S1';
    if (!isSceneRecipeCompatible(recipe.id, requestedSkill)) {
      throw new Error(`场景配方 ${recipe.id} 不适用于 ${requestedSkill}`);
    }
    lines.push(
      ``,
      `## 指定场景配方（必须执行）`,
      `${recipe.id}｜${recipe.label}｜${recipe.execution}`,
      recipe.purpose,
    );
    const assembly = resolveSceneAssembly({
      sceneSkill: requestedSkill === 'S4' ? 'S4' : 'S1',
      recipeId: recipe.id,
      requestedCapabilities: opts.requestedCapabilities,
      requestedPromptModules: opts.requestedPromptModules,
    });
    if (!assembly.valid) {
      throw new Error(assembly.diagnostics.filter((item) => item.severity === 'error').map((item) => item.message).join('；'));
    }
    lines.push(
      ``,
      `## 已解析装配能力（只可使用这些客户端能力）`,
      assembly.enabledCapabilities.join('、'),
      `其中必需能力：${assembly.requiredCapabilities.join('、')}`,
      ``,
      `## 已解析提示词模块（未列出的模块不得生成或执行）`,
      assembly.enabledPromptModules.join('、') || '（仅核心执行提示）',
      requestedSkill === 'S4'
        ? `S4保留题目情境situation、已知条件resources、画布规则和引擎指标；这些不是S1可选叙事，不因未启用scenario-framing而清空。不要生成S1行为、选择题或逐轮对话契约。未启用profile-personalization则injectProfile=false。`
        : `硬性裁剪：未启用 role-context 则 role 只用最小占位且 userRole 留空；未启用 scenario-framing 则 situation/openingNarrative/extras 留空；未启用 metric-state 则 metrics=[] 且 completion.mode=signal；未启用 event-system 则 events=[] 且 eventInjection=false；未启用 profile-personalization 则 injectProfile=false。`,
    );
  }

  lines.push('', '## 场景运行契约', opts.sceneSkill === 'S4' ? SCENE_S4_RUNTIME_CONTRACT_DESIGN : SCENE_RUNTIME_CONTRACT_DESIGN);
  if (opts.sceneSkill === 'S4') lines.push(SCENE_S4_METRIC_DESIGN);
  if (opts.sceneSkill !== 'S4') lines.push('仅在用户需要必经里程碑时定义 runtimeContract.stages=[{id,goal,allowedNext:[阶段id]}] 和 initialStageId；普通自由对话、答疑无需阶段脚本，可省略。阶段引用必须存在，禁止用阶段变化扩大工具或互动权限。');
  return lines.join('\n');
}

/** 场景 Skill 类型合法值集合（用于归一化 LLM 输出） */
const SCENE_SKILL_TYPES = new Set<string>([
  'S0', 'S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'S10', 'S11', 'S12',
]);

/** 把任意值收敛为合法的事件触发器 */
function normalizeEvents(raw: unknown): SceneEvent[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((e) => e && typeof e === 'object')
    .map((e: any, i: number): SceneEvent => ({
      id: typeof e.id === 'string' && e.id ? e.id : `ev-${i + 1}`,
      description: typeof e.description === 'string' ? e.description : '',
      trigger: {
        type: e.trigger?.type === 'condition' ? ('condition' as const) : ('turn' as const),
        turn: typeof e.trigger?.turn === 'number' ? e.trigger.turn : undefined,
        condition: typeof e.trigger?.condition === 'string' ? e.trigger.condition : undefined,
      },
      fired: false,
    }))
    .filter((e) => e.description.trim().length > 0);
}

/**
 * 容错解析 LLM 输出的 SceneSpec。
 * - 剥离代码块后 JSON.parse（复用 parseJsonLenient）
 * - 补齐数组/对象字段
 * - mode='metric' 但 metrics 为空 → 降级 'signal'（边界⑥）
 * - sceneId 一律重新生成（永不覆盖源场景）
 */
export function parseSceneAgentInstructions(raw: unknown): SceneSpec['agentInstructions'] {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('场景专属指令必须是对象');
  const value = raw as Record<string, unknown>;
  for (const key of ['understanding', 'planning', 'response']) {
    if (typeof value[key] !== 'string' || !value[key].trim() || value[key].length > 6000) throw new Error(`场景专属指令 ${key} 无效`);
  }
  return { understanding: value.understanding as string, planning: value.planning as string, response: value.response as string };
}

export interface SceneBuildCheckpoint {
  version: 1;
  /** Exact private input binding; not a diagnostic or model context field. */
  binding: string;
  context: SceneBuildContext;
  recovery: SceneBuildRecovery;
  candidate?: SceneSpec;
  result?: SceneSpec;
  authority?: SceneBuildAuthority;
  identity?: Pick<SceneSpec, 'sceneId' | 'createdAt' | 'updatedAt'>;
  repairBudget: SceneBuildRepairBudget;
  assemblyRevisions: number;
  seenAssemblies: string[];
  lastStage: SceneSetupStage;
  pendingReassembly?: { candidate: SceneSpec; issues: SceneBuildAssemblyIssue[] };
  failure?: { stage: SceneSetupStage; code: string; retryable: boolean };
}
/** Keeps SceneSetupError compatibility while exposing a typed, private resume handle. */
export class SceneBuildInterruptedError extends SceneSetupError {
  declare readonly checkpoint: SceneBuildCheckpoint;
  declare readonly cause: unknown;
  constructor(checkpoint: SceneBuildCheckpoint, cause: unknown, readonly retryable: boolean,
    stage: SceneSetupStage, code: string) {
    super(stage, code, cause instanceof Error ? cause.message : '搭建未完成。', cause instanceof SceneSetupError ? cause.attempts : 1);
    this.name = 'SceneBuildInterruptedError';
    if (cause instanceof Error) this.message = cause.message;
    // Generic error logging must not enumerate original input, material snippets or private drafts.
    Object.defineProperties(this, { checkpoint: { value: checkpoint, enumerable: false }, cause: { value: cause, enumerable: false } });
  }
}

export function parseSceneSpec(raw: string, sceneSkillOverride?: SceneSkillType): SceneSpec {
  const value = parseJsonLenient(raw) as Partial<SceneSpec> | null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('场景生成失败：模型未返回有效 JSON');
  }
  const parsed = normalizeScenePresentation(value);

  const metrics = Array.isArray(parsed.metrics) ? parsed.metrics.filter((m) => m && m.id) : [];
  const rawMode = parsed.completion?.mode === 'signal' ? 'signal' : 'metric';
  const mode: 'metric' | 'signal' = rawMode === 'metric' && metrics.length === 0 ? 'signal' : rawMode;

  /**
   * 场景类型：**以调用方传入值为权威**。
   *
   * 为什么不让 LLM 决定：若用户在搭建面板选了「数理场景」，而 LLM 返回 "S1"
   * （或返回非法值），仅凭 LLM 输出会静默降级为对话场景 —— 用户看到的是
   * 「选了 S4 却生成出对话框架」，且全程无报错，极难排查。
   *
   * 优先级：sceneSkillOverride > LLM 返回值（须合法） > 'S1'
   */
  const llmSkill = SCENE_SKILL_TYPES.has(String(parsed.meta?.sceneSkill))
    ? (parsed.meta?.sceneSkill as SceneSkillType)
    : undefined;
  const sceneSkill: SceneSkillType = sceneSkillOverride ?? llmSkill ?? 'S1';

  const paradigm: DialogueParadigm =
    parsed.engineConfig?.paradigm === 'multi-role-independent-memory' ||
    parsed.engineConfig?.paradigm === 'multi-role-event-response'
      ? parsed.engineConfig.paradigm
      : 'single-role-dialogue';

  const now = new Date().toISOString();
  const behavior = sceneSkill === 'S4' ? undefined : parseBehaviorSpec(parsed.behavior);
  const parsedRecipeId = normalizeUnifiedSceneRecipeId(parsed.capabilityRecipeId || behavior?.recipeId);
  const capabilityRecipeId = parsedRecipeId && isSceneRecipeCompatible(parsedRecipeId, sceneSkill)
    ? parsedRecipeId
    : sceneSkill === 'S4' ? 'guided-derivation' : undefined;

  return {
    sceneId: generateSceneId(),
    version: '1.0',
    meta: {
      name: parsed.meta?.name || '未命名场景',
      subject: parsed.meta?.subject || '',
      sceneSkill,
      knowledgePoints: Array.isArray(parsed.meta?.knowledgePoints) ? parsed.meta!.knowledgePoints! : [],
      goal: parsed.meta?.goal || '',
    },
    capabilityRecipeId,
    capabilityIds: Array.isArray(parsed.capabilityIds)
      ? [...new Set(parsed.capabilityIds.map(normalizeSceneCapabilityId).filter((id): id is SceneCapabilityId => Boolean(id)))]
      : undefined,
    promptModuleIds: Array.isArray(parsed.promptModuleIds)
      ? [...new Set(parsed.promptModuleIds.map(normalizeScenePromptModuleId).filter((id): id is ScenePromptModuleId => Boolean(id)))]
      : undefined,
    runtimeContract: parsed.runtimeContract,
    experimentPolicy: parsed.experimentPolicy,
    inputForm: parsed.inputForm,
    agentInstructions: parseSceneAgentInstructions(parsed.agentInstructions),
    situation: parsed.situation || '',
    task: parsed.task || '',
    role: {
      id: parsed.role?.id || 'role-1',
      name: parsed.role?.name || 'NPC',
      attributes: Array.isArray(parsed.role?.attributes)
        ? parsed.role!.attributes!.filter((a) => a && typeof a.key === 'string').map((a, i) => ({
            id: a.id || `attr-${i + 1}`,
            key: a.key,
            value: a.value ?? '',
            enabled: a.enabled !== false,
          }))
        : [],
    },
    userRole: parsed.userRole || '',
    openingNarrative: parsed.openingNarrative || '',
    resources: Array.isArray(parsed.resources) ? parsed.resources : [],
    rules: Array.isArray(parsed.rules) ? parsed.rules : [],
    metrics,
    completion: {
      mode,
      successExpression: parsed.completion?.successExpression || '',
      failureExpression: parsed.completion?.failureExpression,
      maxTurns: typeof parsed.completion?.maxTurns === 'number' ? parsed.completion.maxTurns : 12,
    },
    evaluationDimensions: Array.isArray(parsed.evaluationDimensions) ? parsed.evaluationDimensions : [],
    engineConfig: {
      paradigm,
      roleMemory: parsed.engineConfig?.roleMemory !== false,
      technologies: Array.isArray(parsed.engineConfig?.technologies) ? parsed.engineConfig!.technologies! : [],
      engines: Array.isArray(parsed.engineConfig?.engines) ? parsed.engineConfig!.engines! : [],
    },
    events: normalizeEvents(parsed.events),
    eventInjection: parsed.eventInjection !== false,
    injectProfile: parsed.injectProfile === true,
    extras:
      parsed.extras && typeof parsed.extras === 'object' && !Array.isArray(parsed.extras)
        ? (parsed.extras as Record<string, string>)
        : undefined,
    behavior,
    // S4 扩展字段（容错解析：缺失则 undefined，保证 S1 完全不受影响 —— 隔离点 I5）
    compute: parseComputeSpec(parsed.compute),
    help: parseHelpSpec(parsed.help),
    origin: 'new',
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 将 Agent 的装配决策作为权威约束投影到模型产物。
 * 即使模型按旧习惯生成了角色、事件或指标，未装配的部分也会在进入预览前被删除。
 */
export function applySceneAssemblyPlan(scene: SceneSpec, opts: GenerateSceneOpts): SceneSpec {
  if (!opts.recipeId) return scene;
  const sceneSkill = opts.sceneSkill === 'S4' ? 'S4' : 'S1';
  const assembly = resolveSceneAssembly({
    sceneSkill,
    recipeId: opts.recipeId,
    requestedCapabilities: opts.requestedCapabilities,
    requestedPromptModules: opts.requestedPromptModules,
  });
  if (!assembly.valid) {
    throw new Error(assembly.diagnostics.filter((item) => item.severity === 'error').map((item) => item.message).join('；'));
  }
  const modules = new Set(assembly.enabledPromptModules);
  if (sceneSkill === 'S4') {
    // The canvas problem statement, givens and deterministic metrics are not optional S1 narration.
    const result: SceneSpec = {
      ...scene, capabilityRecipeId: opts.recipeId, capabilityIds: assembly.enabledCapabilities,
      promptModuleIds: assembly.enabledPromptModules, capabilityPlan: opts.buildContext?.capabilityPlan || scene.capabilityPlan,
      behavior: undefined, inputForm: undefined, experimentPolicy: undefined,
      openingNarrative: '', events: [], eventInjection: false,
      injectProfile: modules.has('profile-personalization'),
      engineConfig: { ...scene.engineConfig, paradigm: 'single-role-dialogue', technologies: [], engines: [] },
    };
    result.runtimeContract = resolveSceneRuntimeContract(result);
    for (const need of result.capabilityPlan?.needs || []) for (const id of need.capabilityIds) {
      if (id.startsWith('tool:') && !result.runtimeContract.allowedTools.includes(id.slice(5) as import('../../types').SceneRuntimeToolId)) {
        throw new Error('能力计划要求的工具未在实际运行契约中授权：' + id);
      }
    }
    return result;
  }
  const technologies = (scene.engineConfig.technologies || []).filter((item) => (
    (modules.has('metric-state') || !/指标/u.test(item))
    && (modules.has('event-system') || !/事件|突发/u.test(item))
    && (modules.has('role-context') || !/角色/u.test(item))
  ));
  const engines = (scene.engineConfig.engines || []).filter((item) => (
    (modules.has('metric-state') || item !== 'MetricEngine')
    && (modules.has('event-system') || !/Event/i.test(item))
  ));
  const interactionTypes = assembly.enabledCapabilities.filter((id): id is SceneInteractionType => (
    ['text', 'single-choice', 'multiple-choice', 'ordering', 'fill-blanks', 'question-set'].includes(id)
  ));
  const priorInteraction = scene.behavior?.interaction;
  const defaultInteractionType = priorInteraction && interactionTypes.includes(priorInteraction.defaultType)
    ? priorInteraction.defaultType
    : interactionTypes[0] || 'text';
  const result: SceneSpec = {
    ...scene,
    capabilityRecipeId: opts.recipeId,
    capabilityIds: assembly.enabledCapabilities,
    promptModuleIds: assembly.enabledPromptModules,
    capabilityPlan: opts.buildContext?.capabilityPlan || scene.capabilityPlan,
    inputForm: modules.has('input-form') ? normalizeSceneInputForm(scene.inputForm) : undefined,
    experimentPolicy: modules.has('model-experiment') ? normalizeSceneExperimentPolicy(scene.experimentPolicy || {
      criteria: opts.buildContext?.understanding?.successCriteria?.length ? opts.buildContext.understanding.successCriteria
        : [opts.buildContext?.understanding?.userGoal || scene.meta.goal || scene.task],
      maxExperiments: 6, maxOutputTokens: 1024, temperature: .2,
    }) : undefined,
    role: modules.has('role-context')
      ? scene.role
      : { id: 'role-1', name: '场景引导器', attributes: [] },
    userRole: modules.has('role-context') ? scene.userRole : '',
    situation: modules.has('scenario-framing') ? scene.situation : '',
    openingNarrative: modules.has('scenario-framing') ? scene.openingNarrative : '',
    extras: modules.has('scenario-framing') ? scene.extras : undefined,
    resources: modules.has('resource-grounding') ? scene.resources : [],
    metrics: modules.has('metric-state') ? scene.metrics : [],
    completion: modules.has('metric-state')
      ? scene.completion
      : { ...scene.completion, mode: 'signal' },
    events: modules.has('event-system') ? scene.events : [],
    eventInjection: modules.has('event-system') && scene.eventInjection,
    // 模块白名单是场景搭建 Agent 的权威授权；具体某一轮是否读取画像由互动 Agent 再决定。
    injectProfile: modules.has('profile-personalization'),
    engineConfig: { ...scene.engineConfig, technologies, engines },
    behavior: scene.behavior
      ? {
          ...scene.behavior,
          recipeId: opts.recipeId,
          interaction: {
            version: '1.0',
            allowedTypes: interactionTypes.length > 0 ? interactionTypes : ['text'],
            defaultType: defaultInteractionType,
            allowTextFallback: defaultInteractionType === 'text' || priorInteraction?.allowTextFallback === true,
          },
        }
      : scene.behavior,
  };
  result.runtimeContract = resolveSceneRuntimeContract(result);
  for (const need of result.capabilityPlan?.needs || []) for (const id of need.capabilityIds) {
    if (id.startsWith('tool:') && !result.runtimeContract.allowedTools.includes(id.slice(5) as import('../../types').SceneRuntimeToolId)) {
      throw new Error('能力计划要求的工具未在实际运行契约中授权：' + id);
    }
  }
  return result;
}

/**
 * 前提条目合法 kind 集合（用于归一化 LLM 输出）。
 *
 * 非法取值一律回退 `relation` —— 该分类只影响引擎侧分流
 * （`domain` 走不等式通道、其余走 facts），回退到 relation 是
 * 「按最宽口径处理」的安全选择，不会丢失条目本身。
 */
const PREMISE_ENTRY_KINDS = new Set<string>(['definition', 'constant', 'domain', 'relation']);

/**
 * 容错解析 given 的前提条目（前提链架构）。
 *
 * 三态语义（与 `GivenItem.entries` 一致）：
 * - 非空数组   → 前提包，逐条参与判定
 * - 空数组     → 解构失败降级，该 given 节点**不可被引用**（UI 需标注）
 * - undefined  → 字段缺省，按旧逻辑（单条 symbol_value / display）处理
 *
 * 为什么必须区分「空数组」与「undefined」（关键）：
 *   二者在 `premiseChain.givenEntriesOf` 中走向完全不同的分支 ——
 *   undefined 会回退到 `display` 兜底（旧场景兼容），
 *   而空数组表示「LLM 明确尝试解构但失败」。此时若也回退 display 兜底，
 *   会把一条含分号的多条目式子当成**单条**喂给引擎，必然解析失败且无法定位。
 *   故空数组必须保留为「不可引用」的显式信号。
 */
function parsePremiseEntries(raw: unknown): PremiseEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: PremiseEntry[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const e = item as Partial<PremiseEntry>;
    const display = typeof e.display === 'string' ? e.display.trim() : '';
    const symbolic = typeof e.symbolic === 'string' ? e.symbolic.trim() : '';
    // 两种形式皆缺 → 该条目无信息量，丢弃（保留反而会污染引擎判定）
    if (!display && !symbolic) continue;
    const kind: PremiseEntryKind = PREMISE_ENTRY_KINDS.has(String(e.kind))
      ? (e.kind as PremiseEntryKind)
      : 'relation';
    const meta =
      e.meta && typeof e.meta === 'object'
        ? {
            unit: typeof e.meta.unit === 'string' ? e.meta.unit : undefined,
            params: Array.isArray(e.meta.params)
              ? e.meta.params.filter((p): p is string => typeof p === 'string')
              : undefined,
            vars: Array.isArray(e.meta.vars)
              ? e.meta.vars.filter((v): v is string => typeof v === 'string')
              : undefined,
          }
        : undefined;
    out.push({
      kind,
      // 只有 symbolic 时用 symbolic 兜底展示，保证 UI 不出现空条目
      display: display || symbolic,
      symbolic: symbolic || display,
      ...(meta ? { meta } : {}),
    });
  }
  return out;
}

/**
 * 容错解析 ComputeSpec（隔离点 I5）。
 *
 * 设计要点：
 * - **结构不合法时返回 undefined**，绝不抛错——S1 的 LLM 不会返回该字段，
 *   即便返回了脏数据也只影响 S4 场景自身，不会让 S1 生成流程失败。
 * - `expected_formula` 为空视为无效（它是等价性判定的唯一锚点，缺了场景无法运行）。
 * - 数组字段逐项过滤，保证类型正确。
 */
function parseComputeSpec(raw: unknown): ComputeSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<ComputeSpec>;
  if (typeof r.expected_formula !== 'string' || !r.expected_formula.trim()) return undefined;

  const given: ComputeSpec['given'] = Array.isArray(r.given)
    ? r.given
        .filter((g) => g && typeof g.name === 'string')
        .map((g) => ({
          name: g.name,
          display: typeof g.display === 'string' ? g.display : String(g.name),
          symbol_value: typeof g.symbol_value === 'string' ? g.symbol_value : undefined,
          unit: typeof g.unit === 'string' ? g.unit : undefined,
          // 前提链架构：框外自然语言解释（与 display 严格分离，不参与符号计算）
          note: typeof g.note === 'string' && g.note.trim() ? g.note.trim() : undefined,
          // 前提链架构：解构后的条目列表（三态语义见 parsePremiseEntries）
          entries: parsePremiseEntries(g.entries),
        }))
    : [];

  const symbols: ComputeSpec['symbols'] = Array.isArray(r.symbols)
    ? r.symbols
        .filter((s) => s && typeof s.name === 'string')
        .map((s) => {
          /**
           * kind 三分支归一（修复静默降级）。
           *
           * 原实现只认 constant / variable，把 `kind:'function'` **静默降级为 variable** ——
           * 而 Prompt 正大力推荐 LLM 声明函数（A(x) 带 body 才能让 A'(x) 真正求值）。
           * 降级后果：引擎 `_compile_symbols` 收到 variable 后建成 Symbol，
           * 于是 `A(x)` 被当作乘法、`diff(A(x), x)` 因 A 无 body 而永久停在
           * Derivative 形态 → 求导步骤无法与具体表达式比对（Prompt 承诺的能力失效）。
           */
          const kind: ComputeSpec['symbols'][number]['kind'] =
            s.kind === 'constant' || s.kind === 'function' ? s.kind : 'variable';
          return {
            name: s.name,
            kind,
            value: typeof s.value === 'string' ? s.value : undefined,
            range:
              Array.isArray(s.range) && s.range.length === 2
                ? ([String(s.range[0]), String(s.range[1])] as [string, string])
                : undefined,
            display: typeof s.display === 'string' ? s.display : undefined,
            // kind='function' 的形参列表（引擎据 _apply_function_bodies 展开实参）
            params: Array.isArray(s.params)
              ? s.params.filter((p): p is string => typeof p === 'string')
              : undefined,
            // kind='function' 的函数体（缺失则 A'(x) 永远求不出结果）
            body: typeof s.body === 'string' && s.body.trim() ? s.body.trim() : undefined,
            // 正值假设：使引擎可完成 sqrt(c**2)=c 一类化简（否则停在 |c|）
            positive: s.positive === true ? true : undefined,
            // 复数域：不做 real 假设，且跳过除零安全检查
            complex: s.complex === true ? true : undefined,
          };
        })
    : [];

  /**
   * 参考解步骤解析（两分层，轮次 B）。
   *
   * 原实现用 `filter((s): s is string => typeof s === 'string')` 只保留字符串。
   * 一旦 LLM 按新格式返回对象（`{display, symbolic}`），对象项会被**静默丢弃** ——
   * 参考解步骤凭空少几条且不报错，是本轮最难排查的一类缺陷。
   * 改用 `normalizeExpectedSteps` 统一归一，兼容字符串 / 对象 / 混用三种形态。
   */
  const expectedSteps = normalizeExpectedSteps(r.expected_steps);

  const stepsCount =
    typeof r.expected_steps_count === 'number' && r.expected_steps_count > 0
      ? r.expected_steps_count
      : (expectedSteps?.length ?? 10);

  return {
    type: r.type === 'data_modeling' || r.type === 'simulation' ? r.type : 'formula',
    given,
    symbols,
    operation: typeof r.operation === 'string' ? r.operation : 'simplify',
    expected_formula: r.expected_formula,
    expected_steps: expectedSteps?.length ? expectedSteps : undefined,
    expected_steps_count: stepsCount,
    boundary_conditions: Array.isArray(r.boundary_conditions)
      ? r.boundary_conditions.filter((b): b is string => typeof b === 'string')
      : [],
  };
}

/**
 * 容错解析 HelpSpec（隔离点 I5）。
 * 缺失或结构不合法时返回 undefined；数值字段全部带默认值兜底。
 */
function parseHelpSpec(raw: unknown): HelpSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Partial<HelpSpec>;
  return {
    base_help_count: typeof r.base_help_count === 'number' ? r.base_help_count : 2,
    difficulty_factor: typeof r.difficulty_factor === 'number' ? r.difficulty_factor : 1.0,
    user_factor: typeof r.user_factor === 'number' ? r.user_factor : 1.0,
    // 显式上限（含 0）会与公式预算取最小值，不是可被自动覆盖的占位。
    max_help_count: typeof r.max_help_count === 'number' ? r.max_help_count : 2,
    penalty_per_help: s4HelpPenalty({ help: r }),
  };
}

/**
 * 阶段一：决策复用 or 新建。
 * 校验 LLM 给出的 targetSceneId 必须真实存在于 manifest，否则降级为 new（边界⑧）。
 */
export async function decideScene(
  opts: GenerateSceneOpts & {
    manifest: SceneSkillManifest;
    /**
     * 场景类型过滤（S4 新增，可选 —— 隔离点 I6）。
     * 存在时只把同 sceneSkill 的场景作为复用候选，避免「用对话场景骨架改编出数理场景」。
     * S1 不传该参数 → 不过滤，行为与改动前完全一致。
     */
    sceneSkillFilter?: SceneSkillType;
  },
): Promise<SceneDecideResult> {
  const allScenes = Array.isArray(opts.manifest?.scenes) ? opts.manifest.scenes : [];
  const scenes = opts.sceneSkillFilter
    ? allScenes.filter((s) => s.sceneSkill === opts.sceneSkillFilter)
    : allScenes;
  // 场景库为空时无需调用 LLM，直接新建（省一次调用）
  if (scenes.length === 0) {
    return { decision: 'new', reason: '场景库为空，全新生成' };
  }

  const userInput = [
    buildTopicSection(opts),
    ``,
    // 传过滤后的清单：让 LLM 只看到同类场景，避免「选了再被 valid 校验拒绝」的无效决策
    buildManifestPromptSection({ ...opts.manifest, scenes }),
  ].join('\n');

  try {
    const invoke = opts.callLlm || ((request: LlmCallRequest) => callLLM(request, { signal: opts.signal }));
    const resp = await invoke({ providerId: '', model: '', workflow: 'scene-decide', skipMemoryInjection: true,
      userInput: JSON.stringify(sceneBuildTask(buildContextFromOptions(opts), 'assemble', '仅判断已有骨架是否适配总目标，不改变已确定装配。', {}, { selectionInput: userInput })) });
    const parsed = parseJsonLenient(resp.content) as Partial<SceneDecideResult> | null;
    const target = typeof parsed?.targetSceneId === 'string' ? parsed.targetSceneId : '';
    const valid = target && scenes.some((s) => s.sceneId === target);
    if (parsed?.decision === 'adapt' && valid) {
      return { decision: 'adapt', targetSceneId: target, reason: parsed.reason || '复用已有场景骨架' };
    }
    return { decision: 'new', reason: parsed?.reason || '无适配场景，全新生成' };
  } catch (e) {
    if (opts.signal?.aborted || (e instanceof Error && e.name === 'AbortError')) throw e;
    // 决策失败不阻塞流程，降级为全新生成
    console.warn('[scene] 决策失败，降级为全新生成:', (e as Error)?.message);
    return { decision: 'new', reason: '决策调用失败，降级为全新生成' };
  }
}

/**
 * 阶段二·分支 A：全新生成。
 *
 * 按 `sceneSkill` 分派到两套提示词之一（「两个框架」的分派点）：
 * - S1 → `scene-generate`（对话场景）
 * - S4 → `scene-compute-generate`（只产出不泄露答案的预览外壳）
 */
export async function generateScene(
  opts: GenerateSceneOpts & { manifest: SceneSkillManifest },
): Promise<SceneSpec> {
  if (opts.sceneSkill === 'S2') throw new Error('S2 请使用独立通用画布搭建入口，不走 S1/S4 生成协议');
  return generateDesignedScene(opts, buildManifestPromptSection(opts.manifest));
}

/**
 * 阶段二·分支 B：基于已有骨架改编。
 * 支持 LLM 自推翻：adaptedFromExisting=false 时把 origin 记为 'new' 并清空血缘。
 */
export async function adaptScene(opts: AdaptSceneOpts): Promise<SceneSpec> {
  if (opts.sceneSkill === 'S2' || opts.sourceSpec.meta.sceneSkill === 'S2') throw new Error('S2 不能通过 S1/S4 改编协议迁移，请使用独立画布入口');
  return generateDesignedScene(opts, '', opts.sourceSpec);
}

function buildContextFromOptions(opts: GenerateSceneOpts): SceneBuildContext {
  if (opts.buildContext) return structuredClone(opts.buildContext);
  return { version: 1, userRequest: buildTopicSection(opts), conversation: [], selectedSurface: opts.sceneSkill === 'S4' ? 'S4' : 'S1',
    explicitSelections: { recipeId: opts.recipeId, capabilities: opts.requestedCapabilities, promptModules: opts.requestedPromptModules },
    assembly: opts.recipeId ? { recipeId: opts.recipeId, capabilities: opts.requestedCapabilities || [],
      promptModules: opts.requestedPromptModules || [], interactionPlan: '按用户目标设计，不添加未授权机制。' } : undefined };
}

/** Compile only the selected S1 capability instructions; S4 keeps its dedicated math protocol. */
function compileSceneGenerationPrompt(context: SceneBuildContext, adapting: boolean): string {
  const modules = new Set(context.assembly?.promptModules || []);
  const lines = [
    '你是场景编译Agent。将输入中已接受的语义、组件装配、流程和专属指令编译为完整SceneSpec JSON，不重新推测目标，不执行工具或生成本局具体题目。',
    adapting ? '返回{adaptedFromExisting:true,scene:{...}}，旧场景只作为可改编素材。' : '只返回SceneSpec对象，不使用Markdown围栏。',
    'behavior.outputFormats仅声明所需markdown/latex/code/table/image，可为空；question-set至少2题且runtimeContract.maxUserTasksPerTurn须覆盖题量（2–12），逐题选择最多一个待答任务。',
    '基本字段：meta:{name,subject,goal,knowledgePoints:[]},task,rules:[],behavior:{recipeId,kind,aiBehavior,userAction,evaluationRule,progressionRule,interaction:{version:"1.0",allowedTypes:[],defaultType,allowTextFallback}},runtimeContract,completion:{mode:"signal",maxTurns:12}。behavior必须采用前序设计，交互类型只取已装配能力。',
    SCENE_PRESENTATION_TEXT_RULE,
    SCENE_RUNTIME_CONTRACT_DESIGN,
    '题型只限制作答任务，不要求每次回复出题；提示/解释/调整/总结可纯文本。普通交流默认开启，只有原用户明确禁止才关闭，不得从只要单选题推导禁聊。',
    modules.has('role-context') ? '按目标填写role:{name,attributes:[{key,value,enabled}]}和可选userRole。' : '',
    modules.has('scenario-framing') ? '按目标填写situation、可选openingNarrative/extras。' : '',
    modules.has('resource-grounding') ? 'resources只写有实际来源的资料或明确待检索范围，不冒充通读全部笔记。' : '',
    modules.has('metric-state') ? 'metrics仅设计0–4个必要状态：{id,name,description,type,initial,target,unit?}；type仅continuous/discrete/boolean/count/set/time。continuous需range:[min,max]；discrete需options且initial/target来自options；description说明变化语义。不把交流默认为学习成绩。' : '',
    modules.has('event-system') ? 'events仅设计必要事件：{id,description,trigger:{type:"turn",turn:正整数}|{type:"condition",condition:"具体条件"},fired:false}；不因场景一词添加突发事件。' : '',
    modules.has('input-form') ? 'inputForm与前序flow.inputForm保持一致，仅使用已支持的字段类型。' : '',
    modules.has('model-experiment') ? 'experimentPolicy必须采用前序已设计标准与预算，不执行实验，不增加预算。' : '',
    '未装配的角色、背景、指标、事件等不写；本地会填空默认值。权限快照存在时只能保持或收窄，不把缺省scope当作取消白名单。',
  ];
  return lines.filter(Boolean).join('\n');
}

async function generateDesignedScene(opts: GenerateSceneOpts, manifest: string, source?: SceneSpec): Promise<SceneSpec> {
  const isS4 = opts.sceneSkill === SCENE_SKILL_S4;
  const workflow = isS4 ? (source ? 'scene-compute-adapt' : 'scene-compute-generate') : (source ? 'scene-adapt' : 'scene-generate');
  const initialContext = buildContextFromOptions(opts);
  const binding = JSON.stringify({ context: initialContext, subject: opts.subject, knowledgePoints: opts.knowledgePoints,
    roleHints: opts.roleHints, extraHints: opts.extraHints, sceneSkill: opts.sceneSkill, recipeId: opts.recipeId,
    capabilities: opts.requestedCapabilities, promptModules: opts.requestedPromptModules, source });
  const fingerprint = (value: SceneBuildContext) => JSON.stringify({ recipeId: value.assembly?.recipeId,
    capabilities: [...(value.assembly?.capabilities || [])].sort(), promptModules: [...(value.assembly?.promptModules || [])].sort(),
    interactionPlan: value.assembly?.interactionPlan, capabilityPlan: value.capabilityPlan });
  if (opts.resume && (opts.resume.version !== 1 || opts.resume.binding !== binding
    || ![0, 1].includes(opts.resume.assemblyRevisions) || ![0, 1].includes(opts.resume.repairBudget?.fieldRepairsUsed)
    || !opts.resume.recovery?.stages || !Array.isArray(opts.resume.seenAssemblies))) {
    throw new SceneSetupError('generate', 'resume-binding-mismatch', '恢复状态与原始请求不一致，未重用产物或发送模型请求。');
  }
  if (opts.resume?.failure?.retryable === false) throw new SceneSetupError(opts.resume.failure.stage,
    'resume-terminal', '该搭建已耗尽语义修复或重装配额度；不能通过恢复重置额度。修改需求后请显式新建。');
  const checkpoint: SceneBuildCheckpoint = opts.resume ? structuredClone(opts.resume) : {
    version: 1, binding, context: initialContext, recovery: { stages: {} }, repairBudget: { fieldRepairsUsed: 0 },
    assemblyRevisions: 0, seenAssemblies: [fingerprint(initialContext)], lastStage: 'flow',
  };
  delete checkpoint.failure;
  let context = checkpoint.context;
  let authority = checkpoint.authority, identity = checkpoint.identity;
  let assemblyRevisions = checkpoint.assemblyRevisions;
  const repairBudget = checkpoint.repairBudget;
  const seen = new Set(checkpoint.seenAssemblies);
  let activeOpts = { ...opts, buildContext: context,
    ...(assemblyRevisions && context.assembly ? { recipeId: context.assembly.recipeId,
      requestedCapabilities: context.assembly.capabilities, requestedPromptModules: context.assembly.promptModules } : {}) };
  const publish = () => {
    checkpoint.context = context; checkpoint.authority = authority; checkpoint.identity = identity;
    checkpoint.assemblyRevisions = assemblyRevisions; checkpoint.seenAssemblies = [...seen];
    opts.onCheckpoint?.(structuredClone(checkpoint));
  };
  const deps: SceneBuildDependencies = {
    invoke: opts.callLlm || (request => callLLM(request, { signal: opts.signal })), signal: opts.signal,
    onDiagnostic: opts.onDiagnostic, recovery: checkpoint.recovery, onRecovery: publish,
    onStage: stage => { checkpoint.lastStage = stage; publish(); opts.onStage?.(stage); },
  };
  const finishReassembly = async () => {
    const pending = checkpoint.pendingReassembly;
    if (!pending || !authority) throw new SceneSetupError('assemble', 'invalid-resume-state', '重装配恢复缺少原授权或已验收问题。');
    deps.recoveryPrefix = `design-${assemblyRevisions}`;
    const next = await reassembleSceneDesign(context, pending.candidate, pending.issues, authority, deps);
    const key = fingerprint(next);
    if (seen.has(key)) throw new SceneSetupError('assemble', 'unchanged-reassembly', '重装配未改变配置或互动计划，停止重复生成。');
    seen.add(key); context = next;
    delete checkpoint.pendingReassembly; delete checkpoint.candidate;
    delete checkpoint.recovery.flow; delete checkpoint.recovery.instructions; delete checkpoint.recovery.acceptance;
    activeOpts = { ...opts, buildContext: context, recipeId: context.assembly!.recipeId,
      requestedCapabilities: context.assembly!.capabilities, requestedPromptModules: context.assembly!.promptModules };
    publish();
  };
  try {
  if (checkpoint.result) {
    if (!authority) throw new SceneSetupError('accept', 'invalid-resume-state', '完成记录缺少原授权。');
    assertSceneBuildAuthority(checkpoint.result, authority);
    if (!preflightSceneSpec(checkpoint.result, { allowDeferredCompute: true }).valid) throw new SceneSetupError('accept', 'invalid-resume-state', '完成记录未通过执行协议。');
    return structuredClone(checkpoint.result);
  }
  if (checkpoint.pendingReassembly) await finishReassembly();
  for (;;) {
  deps.recoveryPrefix = `design-${assemblyRevisions}`;
  const design = await designSceneBehavior(context, deps);
  const compile = (scene: SceneSpec) => {
    const parsed = parseSceneSpec(JSON.stringify(scene), activeOpts.sceneSkill);
    if (isS4) { parsed.compute = undefined; parsed.help = undefined; }
    const assembled = applySceneAssemblyPlan(parsed, activeOpts);
    const result = { ...assembled,
      // Feedback timing is compiled from the accepted flow, including field-repair passes.
      runtimeContract: !isS4 && design.flow.answerFeedback ? { ...assembled.runtimeContract!, answerFeedback: design.flow.answerFeedback } : assembled.runtimeContract,
      sceneId: identity?.sceneId || scene.sceneId, createdAt: identity?.createdAt || scene.createdAt, updatedAt: identity?.updatedAt || scene.updatedAt,
      origin: scene.origin, sourceSceneId: scene.sourceSceneId, referenceScope: scene.referenceScope };
    const constraints = context.understanding?.buildConstraints;
    if (result.meta.sceneSkill === 'S1' && constraints?.interactionPolicy === 'restricted') {
      const runtime = resolveSceneRuntimeContract(result);
      result.runtimeContract = { ...runtime, allowedQuestionItemTypes: runtime.allowedQuestionItemTypes!.filter(type => constraints.answerKinds.includes(type)) };
    }
    assertSceneBuildAuthority(result, authority || captureSceneBuildAuthority(result, context));
    return result;
  };
  const generateKey = `${deps.recoveryPrefix}:generate`;
  const generated = checkpoint.candidate ? { payload: checkpoint.candidate }
    : await runSceneSetupStage({ stage: 'generate', ...deps, maxOutputChars: 64000,
    resume: checkpoint.recovery.stages[generateKey],
    onRetryState: state => { checkpoint.recovery.stages[generateKey] = state; publish(); },
    request: { providerId: '', model: '', workflow, skipMemoryInjection: true,
      systemPromptOverride: isS4 ? undefined : compileSceneGenerationPrompt(design.context, Boolean(source)),
      userInput: JSON.stringify(sceneBuildTask(design.context, 'generate',
        source ? '按原始目标改编已有骨架；前序专项设计优先于旧场景不适用的行为。' : '将专项设计编译为可运行的完整场景，不重新猜测用户目标。',
        { flow: design.flow, instructions: design.instructions }, {
          generationRequirements: buildTopicSection(activeOpts), manifest, authoritySummary: authority, assemblyRevision: assemblyRevisions,
          sourceScene: source ? { ...source, referenceScope: undefined, ...(isS4 ? { compute: undefined, help: undefined } : {}) } : undefined,
          instruction: SCENE_PRESENTATION_TEXT_RULE + '按当前 workflow 的 SceneSpec 格式输出。行为指令与流程采用前序专项设计，不照搬无关角色、指标和事件。' })) },
    validate: raw => {
      let compilationStep = 'parse';
      try {
        if (source && (!raw.scene || typeof raw.scene !== 'object')) throw new Error('missing adapted scene');
        const parsed = parseSceneSpec(JSON.stringify(source ? raw.scene : raw), activeOpts.sceneSkill);
        compilationStep = 'flow';
        const designed = applySceneBehaviorDesign(parsed, design);
        compilationStep = 'assembly';
        const scene = compile({ ...designed, origin: source && raw.adaptedFromExisting !== false ? 'adapted' : 'new',
          sourceSceneId: source && raw.adaptedFromExisting !== false ? source.sceneId : undefined });
        const preflight = preflightSceneSpec(scene, { allowDeferredCompute: true });
        if (!preflight.valid) throw new SceneUnderstandingError('场景未通过组合执行校验：' + JSON.stringify(
          preflight.diagnostics.filter(item => item.severity === 'error').map(({ code, capabilityId, message }) => ({ code, capabilityId, message }))), 'invalid-generated-scene');
        return scene;
      } catch (error) {
        if (error instanceof SceneBuildAuthorityError) throw error;
        if (error instanceof SceneUnderstandingError && error.code === 'invalid-generated-scene') throw error;
        // Only forward bounded messages from local field validators, never arbitrary provider/JSON bodies.
        const detail = error instanceof Error && /^(?:场景|S4|能力计划|项目取材范围|数理)/u.test(error.message)
          ? error.message.slice(0, 400) : '字段结构不满足当前运行面要求';
        throw new SceneUnderstandingError(`${isS4 ? '数理画布' : '场景'}编译在${compilationStep}阶段未通过：${detail}。请修复对应字段，不要增加无关行为或权限。`, 'invalid-generated-scene');
      }
    } });
  if (!identity) identity = { sceneId: generated.payload.sceneId, createdAt: generated.payload.createdAt, updatedAt: generated.payload.updatedAt };
  if (!authority) authority = captureSceneBuildAuthority(generated.payload, context);
  checkpoint.candidate = structuredClone(generated.payload);
  publish();
  try {
    const result = await acceptSceneDesign(generated.payload, design, deps, compile, { authority, repairBudget });
    checkpoint.result = structuredClone(result); publish();
    return result;
  }
  catch (error) {
    if (!(error instanceof SceneAssemblyRevisionRequired)) throw error;
    if (assemblyRevisions >= 1) throw new SceneSetupError('accept', 'reassembly-budget-exhausted', '原授权内重装配一次仍未通过验收，已停止，不再循环或扩大权限。');
    assemblyRevisions++;
    checkpoint.pendingReassembly = { candidate: structuredClone(error.candidate), issues: structuredClone(error.issues) };
    publish();
    await finishReassembly();
  }
  }
  } catch (cause) {
    const stage = cause instanceof SceneSetupError ? cause.stage : checkpoint.lastStage;
    const code = cause instanceof SceneSetupError || cause instanceof SceneUnderstandingError ? cause.code
      : cause instanceof Error && cause.name === 'AbortError' ? 'build-aborted' : 'build-interrupted';
    const retryable = !['semantic-rejected', 'reassembly-budget-exhausted', 'unchanged-reassembly', 'invalid-resume-state', 'resume-binding-mismatch'].includes(code);
    checkpoint.failure = { stage, code, retryable }; publish();
    if (cause instanceof Error && cause.name === 'AbortError') throw cause;
    throw new SceneBuildInterruptedError(structuredClone(checkpoint), cause, retryable, stage, code);
  }
}

/**
 * 保存生成的场景：落盘 + 更新 manifest。
 * 若为 adapted，顺带给源场景的 reuseCount +1（供检索排序）。
 * 返回补齐 sceneId 与时间戳后的最终 spec。
 */
export async function saveGeneratedScene(spec: SceneSpec): Promise<SceneSpec> {
  // S4：落盘前收窄到权限、显式上限及公式预算；不得扩大用户设置或覆盖零额度。
  // S1 场景没有 help 字段，此段整块跳过，行为不变（隔离点 I5）。
  const ready: SceneSpec =
    spec.meta.sceneSkill === SCENE_SKILL_S4 && spec.compute && spec.help
      ? { ...spec, help: { ...spec.help, max_help_count: computeMaxHelp(spec) } }
      : spec;

  const saved = await persistScene(ready);
  if (saved.origin === 'adapted' && saved.sourceSceneId) {
    await bumpReuseCount(saved.sourceSceneId);
  }
  return saved;
}

/**
 * S4 两阶段生成的**第二阶段**（对应实施计划 §6.8 成本策略 / M7）。
 *
 * 由 `SceneMode.handleStart` 在 `sceneSkill === 'S4' && !spec.compute` 时调用：
 * 用户已确认情境/任务/知识点，此时才花一次 LLM 调用产出 `compute` + `help`，
 * 避免「预览阶段就烧调用」。
 *
 * 本函数保证：
 * - 解析失败时**抛出可读错误**（由调用方展示），不返回半成品 spec
 * - `help.max_help_count` 不超过显式上限与公式预算；未授权组件时为 0
 */
export async function generateS4ComputeConfig(opts: {
  spec: SceneSpec;
  /** 用户补充条件（可选） */
  extraHints?: string;
  signal?: AbortSignal;
  /** Offline testing can inject responses without changing the default provider or request budget. */
  callLlm?: (request: LlmCallRequest) => Promise<LlmCallResponse>;
}): Promise<SceneSpec> {
  const { spec, extraHints } = opts;
  if (spec.meta.sceneSkill !== 'S4') throw new Error('数理配置仅适用于 S4 画布场景');

  const userInput = [
    '## 任务',
    '为下面这个**已存在的数理推导场景**补充计算配置（compute）与求助配置（help）。',
    '只输出这两部分构成的 JSON 对象，形如 `{ "compute": {...}, "help": {...} }`。',
    '',
    '## 场景信息',
    `名称：${spec.meta.name}`,
    `学科：${spec.meta.subject}`,
    `学习目标：${spec.meta.goal}`,
    `知识点：${spec.meta.knowledgePoints.join('、') || '未指定'}`,
    '',
    '## 情境',
    spec.situation,
    '',
    '## 任务',
    spec.task,
    '',
    '## 用户已确认的有限资料与已知条件（不是完整项目正文）',
    ...spec.resources.map(item => `- ${item}`),
    '',
    '## 指标（compute 相关指标请给出 source 字段）',
    spec.metrics.map((m) => `- id=${m.id}｜${m.name}｜类型=${m.type}`).join('\n') || '（无）',
    extraHints ? `\n## 补充要求\n${extraHints}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  let lastErr: Error | null = null;
  const invoke = opts.callLlm || ((request: LlmCallRequest) => callLLM(request, { signal: opts.signal }));
  const assertActive = () => { if (opts.signal?.aborted) { const error = new Error('数理配置生成已取消'); error.name = 'AbortError'; throw error; } };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      assertActive();
      const resp = await invoke({
        providerId: '',
        model: '',
        workflow: 'scene-compute-config',
        skipMemoryInjection: true,
        skipProfileInjection: true,
        userInput:
          attempt === 0
            ? userInput
            : `${userInput}\n\n【重要】上次输出无法解析为 JSON。请严格只输出一个 JSON 对象，不要任何解释或代码块标记。`,
      });
      assertActive();
      const parsed = parseJsonLenient(resp.content) as { compute?: unknown; help?: unknown } | null;
      const compute = parseComputeSpec(parsed?.compute);
      if (!compute) {
        throw new Error('数理配置生成失败：未返回有效的目标公式（expected_formula）');
      }
      const help = parseHelpSpec(parsed?.help);
      if (spec.capabilityIds?.includes('compute-help') && !help) throw new Error('数理配置缺少已装配的求助配置 help');

      const merged: SceneSpec = {
        ...spec,
        compute,
        help,
        updatedAt: new Date().toISOString(),
      };

      // 系统重算求助次数上限（§6.6 唯一口径，覆盖 LLM 建议值）
      if (merged.help) {
        merged.help = { ...merged.help, max_help_count: computeMaxHelp(merged) };
      }
      const preflight = preflightSceneSpec(merged);
      if (!preflight.valid) throw new Error('数理配置未通过启动校验：' + preflight.diagnostics
        .filter(item => item.severity === 'error').map(item => item.message).join('；'));
      return merged;
    } catch (e) {
      if (opts.signal?.aborted || (e instanceof Error && e.name === 'AbortError')) throw e;
      lastErr = e as Error;
    }
  }
  throw lastErr || new Error('数理配置生成失败');
}
