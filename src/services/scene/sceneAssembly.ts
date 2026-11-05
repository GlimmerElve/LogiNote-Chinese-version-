import type {
  SceneCapabilityId,
  SceneInteractionType,
  ScenePromptModuleId,
  SceneRecipeId,
  SceneSpec,
} from '../../types';
import {
  SCENE_CAPABILITY_DEFINITIONS,
  getSceneCapability,
  getUnifiedSceneRecipe,
  isSceneRecipeCompatible,
  normalizeSceneCapabilityId,
  normalizeScenePromptModuleId,
  normalizeUnifiedSceneRecipeId,
} from './sceneCapabilityRegistry';
import { resolveSceneRuntimeInteractionProtocol } from './sceneInteraction';
import { getSceneInteractionComponentV2 } from './sceneInteractionComponentV2';
import { resolveSceneRuntimeContract } from './sceneRuntimeContract';
import { sceneInputForm } from './sceneInputForm';
import { unreachableSceneStages, validateSceneExecutionCombination } from './sceneExecutionRegistry';
import { resolveS4MetricBinding } from './sceneS4Policy';

export type SceneAssemblySeverity = 'info' | 'warning' | 'error';
export type SceneAssemblyDiagnosticCode =
  | 'unknown-recipe'
  | 'recipe-skill-mismatch'
  | 'unknown-capability'
  | 'unknown-prompt-module'
  | 'prompt-module-skill-mismatch'
  | 'assessment-without-question-set'
  | 'capability-surface-mismatch'
  | 'missing-required-capability'
  | 'preferred-capability-unavailable'
  | 'legacy-scene'
  | 'recipe-inferred'
  | 'missing-behavior'
  | 'missing-interaction-capability'
  | 'missing-component-adapter'
  | 'missing-compute'
  | 'missing-operation'
  | 'missing-expected-formula'
  | 'missing-symbol-table'
  | 'missing-execution-dependency'
  | 'unavailable-question-item'
  | 'unreachable-stage'
  | 'canvas-contract-projected'
  | 'invalid-runtime-contract'
  | 'invalid-s4-metric-binding';

export interface SceneAssemblyDiagnostic {
  code: SceneAssemblyDiagnosticCode;
  severity: SceneAssemblySeverity;
  message: string;
  capabilityId?: SceneCapabilityId | string;
}

export interface SceneAssemblyRequest {
  sceneSkill: 'S1' | 'S4';
  recipeId: SceneRecipeId | string;
  requestedCapabilities?: Array<SceneCapabilityId | string>;
  requestedPromptModules?: Array<ScenePromptModuleId | string>;
}

export interface SceneAssemblyResult {
  valid: boolean;
  surface?: 'turn' | 'canvas';
  recipeId?: SceneRecipeId;
  requiredCapabilities: SceneCapabilityId[];
  preferredCapabilities: SceneCapabilityId[];
  requestedCapabilities: SceneCapabilityId[];
  enabledCapabilities: SceneCapabilityId[];
  requestedPromptModules: ScenePromptModuleId[];
  enabledPromptModules: ScenePromptModuleId[];
  missingCapabilities: SceneCapabilityId[];
  diagnostics: SceneAssemblyDiagnostic[];
}

export interface ScenePreflightResult extends SceneAssemblyResult {
  legacy: boolean;
}

export interface ScenePreflightOptions {
  /** 自定义 S4 在点击开始后才生成 compute；预览时允许这个可恢复状态。 */
  allowDeferredCompute?: boolean;
  /** 测试、裁剪发行版或插件环境可传入实际安装能力。 */
  installedCapabilities?: readonly SceneCapabilityId[];
}

const INTERACTION_CAPABILITIES = new Set<SceneCapabilityId>([
  'text', 'single-choice', 'multiple-choice', 'ordering', 'fill-blanks', 'question-set',
]);

function unique<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function hasErrors(diagnostics: SceneAssemblyDiagnostic[]): boolean {
  return diagnostics.some((item) => item.severity === 'error');
}

export function resolveSceneAssembly(
  request: SceneAssemblyRequest,
  installedCapabilities: readonly SceneCapabilityId[] = SCENE_CAPABILITY_DEFINITIONS.map((item) => item.id),
): SceneAssemblyResult {
  const diagnostics: SceneAssemblyDiagnostic[] = [];
  const recipeId = normalizeUnifiedSceneRecipeId(request.recipeId);
  const installed = new Set(installedCapabilities);
  const requested: SceneCapabilityId[] = [];
  const requestedPromptModules: ScenePromptModuleId[] = [];

  for (const rawId of request.requestedCapabilities || []) {
    const capabilityId = normalizeSceneCapabilityId(rawId);
    if (!capabilityId) {
      diagnostics.push({
        code: 'unknown-capability', severity: 'error', capabilityId: String(rawId),
        message: `未知场景能力：${String(rawId)}`,
      });
      continue;
    }
    if (!requested.includes(capabilityId)) requested.push(capabilityId);
  }

  for (const rawId of request.requestedPromptModules || []) {
    const moduleId = normalizeScenePromptModuleId(rawId);
    if (!moduleId) {
      diagnostics.push({
        code: 'unknown-prompt-module', severity: 'error',
        message: `未知场景提示词模块：${String(rawId)}`,
      });
      continue;
    }
    if (!requestedPromptModules.includes(moduleId)) requestedPromptModules.push(moduleId);
  }

  if (!recipeId) {
    diagnostics.push({ code: 'unknown-recipe', severity: 'error', message: `未知场景配方：${String(request.recipeId)}` });
    return {
      valid: false,
      requiredCapabilities: [], preferredCapabilities: [], requestedCapabilities: requested,
      enabledCapabilities: [], requestedPromptModules, enabledPromptModules: [], missingCapabilities: [], diagnostics,
    };
  }

  const recipe = getUnifiedSceneRecipe(recipeId)!;
  if (!isSceneRecipeCompatible(recipeId, request.sceneSkill)) {
    diagnostics.push({
      code: 'recipe-skill-mismatch', severity: 'error',
      message: `场景配方 ${recipeId} 不适用于 ${request.sceneSkill}。`,
    });
  }

  const allowedPromptModules = new Set(
    request.sceneSkill === 'S4'
      ? ['role-context', 'resource-grounding', 'structured-interaction', 'metric-state', 'profile-personalization']
      : ['role-context', 'scenario-framing', 'resource-grounding', 'personal-cognition-grounding', 'structured-interaction', 'deterministic-assessment', 'adaptive-progression', 'turn-agent-planning', 'metric-state', 'event-system', 'profile-personalization', 'model-experiment', 'input-form'],
  );
  for (const moduleId of requestedPromptModules) {
    if (!allowedPromptModules.has(moduleId)) {
      diagnostics.push({
        code: 'prompt-module-skill-mismatch', severity: 'error',
        message: `提示词模块 ${moduleId} 不适用于 ${request.sceneSkill}。`,
      });
    }
  }

  for (const capabilityId of requested) {
    const capability = getSceneCapability(capabilityId)!;
    const compatible = capability.sceneSkills.includes(request.sceneSkill)
      && (capability.surface === recipe.surface || capability.surface === 'shared');
    if (!compatible) {
      diagnostics.push({
        code: 'capability-surface-mismatch', severity: 'error', capabilityId,
        message: `能力 ${capabilityId} 不能用于 ${recipe.surface} 运行面。`,
      });
    }
  }

  const required = [...recipe.requiredCapabilities];
  const preferred = [...recipe.preferredCapabilities];
  const missingRequired = required.filter((id) => !installed.has(id));
  for (const capabilityId of missingRequired) {
    diagnostics.push({
      code: 'missing-required-capability', severity: 'error', capabilityId,
      message: `当前客户端缺少配方必需能力：${capabilityId}。`,
    });
  }
  for (const capabilityId of preferred) {
    if (!installed.has(capabilityId) && !missingRequired.includes(capabilityId)) {
      diagnostics.push({
        code: 'preferred-capability-unavailable', severity: 'warning', capabilityId,
        message: `建议能力 ${capabilityId} 当前不可用，场景将采用降级组合。`,
      });
    }
  }
  const requestedMissing = requested.filter((id) => !installed.has(id));
  for (const capabilityId of requestedMissing) {
    diagnostics.push({
      code: 'missing-required-capability', severity: 'error', capabilityId,
      message: `请求的场景能力未安装：${capabilityId}。`,
    });
  }

  // 显式请求表示 Agent 已完成装配，不再把“优选”能力全部强行打开。
  // undefined 仍使用旧默认，保证手动搭建和已有入口兼容。
  const enabled = unique([
    ...required,
    ...(request.requestedCapabilities === undefined ? preferred : requested),
  ]).filter((id) => installed.has(id));
  if (recipe.surface === 'turn' && !enabled.some(id => INTERACTION_CAPABILITIES.has(id)) && installed.has('text')) {
    enabled.push('text');
  }
  const enabledPromptModules = unique([
    ...recipe.requiredPromptModules,
    ...(request.requestedPromptModules === undefined ? recipe.defaultPromptModules : requestedPromptModules),
  ]);
  if (enabled.some(id => INTERACTION_CAPABILITIES.has(id) && id !== 'text') && !enabledPromptModules.includes('structured-interaction')) {
    enabledPromptModules.push('structured-interaction');
  }
  if (enabledPromptModules.includes('deterministic-assessment') && !enabled.includes('question-set')) {
    diagnostics.push({
      code: 'assessment-without-question-set', severity: 'error',
      message: '确定性评卷模块需要 question-set 组件。',
    });
  }
  for (const issue of validateSceneExecutionCombination(enabled, enabledPromptModules, installedCapabilities)) {
    diagnostics.push({ code: 'missing-execution-dependency', severity: 'error', capabilityId: issue.owner,
      message: issue.message });
  }
  return {
    valid: !hasErrors(diagnostics),
    surface: recipe.surface,
    recipeId,
    requiredCapabilities: required,
    preferredCapabilities: preferred,
    requestedCapabilities: requested,
    enabledCapabilities: enabled,
    requestedPromptModules,
    enabledPromptModules,
    missingCapabilities: unique([...missingRequired, ...requestedMissing]),
    diagnostics,
  };
}

function inferredRecipe(spec: SceneSpec): { id?: SceneRecipeId; inferred: boolean } {
  const explicit = normalizeUnifiedSceneRecipeId(spec.capabilityRecipeId || spec.behavior?.recipeId);
  if (explicit) return { id: explicit, inferred: false };
  if (spec.meta.sceneSkill === 'S4') return { id: 'guided-derivation', inferred: true };
  if (!spec.behavior) return { inferred: false };
  const protocol = resolveSceneRuntimeInteractionProtocol(spec.behavior.interaction);
  return {
    id: protocol.allowedTypes.includes('question-set') || protocol.defaultType === 'question-set'
      ? 'batch-assessment'
      : 'guided-practice',
    inferred: true,
  };
}

/** 启动前的纯函数预检：不调用 LLM、不写磁盘，也不修改 SceneSpec。 */
export function preflightSceneSpec(spec: SceneSpec, options: ScenePreflightOptions = {}): ScenePreflightResult {
  const sceneSkill = spec.meta.sceneSkill === 'S4' ? 'S4' : 'S1';
  const selected = inferredRecipe(spec);

  // 没有 behavior/recipe 的旧 S1 仍按传统文本对话运行，避免历史场景被新协议锁死。
  if (sceneSkill === 'S1' && !selected.id && !spec.behavior) {
    return {
      valid: true, legacy: true, surface: 'turn',
      requiredCapabilities: ['text'], preferredCapabilities: [], requestedCapabilities: ['text'],
      enabledCapabilities: ['text'], requestedPromptModules: [], enabledPromptModules: [], missingCapabilities: [],
      diagnostics: [{ code: 'legacy-scene', severity: 'info', message: '旧版对话场景将按纯文本兼容模式运行。' }],
    };
  }

  const protocol = sceneSkill === 'S1' && spec.behavior
    ? resolveSceneRuntimeInteractionProtocol(spec.behavior.interaction)
    : undefined;
  const requested = unique([
    ...(spec.capabilityIds || []),
    ...(protocol?.allowedTypes || []),
  ]);
  const assembly = resolveSceneAssembly(
    {
      sceneSkill,
      recipeId: selected.id || '',
      requestedCapabilities: sceneSkill === 'S4' && spec.capabilityIds === undefined ? undefined : requested,
      requestedPromptModules: spec.promptModuleIds,
    },
    options.installedCapabilities,
  );
  const diagnostics = [...assembly.diagnostics];
  // Assembly proposals may add required components; validating a saved scene may not grant them.
  if (sceneSkill === 'S4' && spec.capabilityIds !== undefined) {
    for (const capabilityId of assembly.requiredCapabilities) {
      if (!spec.capabilityIds.includes(capabilityId)) diagnostics.push({
        code: 'missing-required-capability', severity: 'error', capabilityId,
        message: `数理场景未授权必需组件 ${capabilityId}，请返回搭建阶段重新装配；预检不会自动扩大权限。`,
      });
    }
  }
  try {
    const contract = resolveSceneRuntimeContract(spec);
    if (sceneSkill === 'S1' && !contract.allowedActions.length) throw new Error('未授权任何运行行动');
    if (sceneSkill === 'S1' && spec.promptModuleIds?.includes('input-form') && !sceneInputForm(spec)) throw new Error('场景表单必须具备有效配置和已授权text交互。');
    if (sceneSkill === 'S1' && spec.runtimeContract?.stages !== undefined) {
      for (const id of unreachableSceneStages(contract)) diagnostics.push({ code: 'unreachable-stage', severity: 'error',
        message: `显式流程阶段 ${id} 无法从初始阶段到达；请修复 allowedNext 或删除不需要的阶段，不限制合法循环。` });
    }
    if (contract.allowedInteractionTypes.includes('question-set')) {
      const installed = new Set(options.installedCapabilities || SCENE_CAPABILITY_DEFINITIONS.map(item => item.id));
      for (const id of contract.allowedQuestionItemTypes || []) if (!installed.has(id) || !getSceneInteractionComponentV2(id, 'question-set-item')) {
        diagnostics.push({ code: 'unavailable-question-item', severity: 'error', capabilityId: id,
          message: `题组已授权子型 ${id} 缺少已安装的渲染/校验适配器；不能用其他题型替换绕过题型权限。` });
      }
    }
    if (sceneSkill === 'S4' && spec.runtimeContract && (
      [spec.runtimeContract.allowedTools, spec.runtimeContract.allowedActions, spec.runtimeContract.allowedInteractionTypes,
        spec.runtimeContract.allowedQuestionItemTypes].some(value => value?.length)
      || spec.runtimeContract.allowConversation || spec.runtimeContract.allowTextFallback
      || spec.runtimeContract.maxToolCallsPerTurn > 0 || spec.runtimeContract.maxPlanningSteps > 0
      || spec.runtimeContract.maxUserTasksPerTurn > 0)) {
      diagnostics.push({ code: 'canvas-contract-projected', severity: 'warning',
        message: '旧数理场景中的 S1 对话权限已收窄为空；画布仍按已装配能力及 compute/help 配置运行，不增加工具或预算。' });
    }
  } catch (error) {
    diagnostics.push({ code: 'invalid-runtime-contract', severity: 'error',
      message: `运行契约不可执行：${(error as Error).message}` });
  }

  if (selected.inferred) {
    diagnostics.push({
      code: 'recipe-inferred', severity: 'warning',
      message: `场景未声明配方，已按现有结构推断为 ${selected.id}。`,
    });
  }

  if (sceneSkill === 'S1') {
    if (!spec.behavior) {
      diagnostics.push({ code: 'missing-behavior', severity: 'error', message: '该配方缺少 S1 交互行为契约。' });
    } else {
      const allowed = new Set<SceneInteractionType>(protocol!.allowedTypes);
      for (const capabilityId of allowed) {
        if (!getSceneInteractionComponentV2(capabilityId, 'top-level')) {
          diagnostics.push({
            code: 'missing-component-adapter', severity: 'error', capabilityId,
            message: `交互能力 ${capabilityId} 缺少 V2 渲染/校验适配器。`,
          });
        }
      }
      for (const capabilityId of assembly.requiredCapabilities) {
        if (INTERACTION_CAPABILITIES.has(capabilityId) && !allowed.has(capabilityId as SceneInteractionType)) {
          diagnostics.push({
            code: 'missing-interaction-capability', severity: 'error', capabilityId,
            message: `交互协议没有启用配方必需组件：${capabilityId}。`,
          });
        }
      }
      for (const capabilityId of spec.capabilityIds || []) {
        if (
          INTERACTION_CAPABILITIES.has(capabilityId)
          && !allowed.has(capabilityId as SceneInteractionType)
          && !assembly.requiredCapabilities.includes(capabilityId)
        ) {
          diagnostics.push({
            code: 'missing-interaction-capability', severity: 'error', capabilityId,
            message: `场景声明了 ${capabilityId}，但交互协议没有启用该组件。`,
          });
        }
      }
    }
  } else if (!spec.compute) {
    diagnostics.push({
      code: 'missing-compute', severity: options.allowDeferredCompute ? 'warning' : 'error',
      message: options.allowDeferredCompute
        ? '数理配置将在点击开始后生成。'
        : '数理场景缺少 compute 配置，不能启动。',
    });
  } else {
    if (!spec.compute.operation?.trim()) {
      diagnostics.push({ code: 'missing-operation', severity: 'error', message: '数理配置缺少运算类型。' });
    }
    if (!spec.compute.expected_formula?.trim()) {
      diagnostics.push({ code: 'missing-expected-formula', severity: 'error', message: '数理配置缺少目标公式。' });
    }
    if (!Array.isArray(spec.compute.symbols)) {
      diagnostics.push({ code: 'missing-symbol-table', severity: 'error', message: '数理配置缺少符号表。' });
    }
  }

  if (sceneSkill === 'S4') {
    for (const metric of spec.metrics) {
      const binding = resolveS4MetricBinding(metric);
      if ((metric.source === 'engine' || metric.source === 'rule' || metric.s4Binding !== undefined)
        && !binding) {
        diagnostics.push({ code: 'invalid-s4-metric-binding', severity: 'error',
          message: `数理指标 ${metric.id} 缺少可执行的 s4Binding，或绑定与 source/type 不匹配；请指定受支持的本地数据绑定。` });
      } else if (binding === 'numerical-error' || binding === 'boundary-count' || binding === 'dimension-check') {
        // Current premise verification does not emit independent measurements for these
        // historical fields. Recognizing a name is not proof of an executable producer.
        diagnostics.push({ code: 'invalid-s4-metric-binding', severity: 'error',
          message: `数理指标 ${metric.id} 的 ${binding} 绑定没有独立的本地测量数据源；当前前提链不能将其作为强制完成条件，请删除该指标或重新设计可测量指标。` });
      }
    }
  }

  const actualEnabled = sceneSkill === 'S1' && protocol
    ? unique([
        ...protocol.allowedTypes,
        ...assembly.requestedCapabilities.filter((id) => getSceneCapability(id)?.surface === 'shared'),
      ])
    : sceneSkill === 'S4' && spec.capabilityIds !== undefined
      ? assembly.requestedCapabilities.filter(id => assembly.enabledCapabilities.includes(id))
      : assembly.enabledCapabilities;
  return {
    ...assembly,
    valid: !hasErrors(diagnostics),
    legacy: false,
    enabledCapabilities: actualEnabled,
    diagnostics,
  };
}
