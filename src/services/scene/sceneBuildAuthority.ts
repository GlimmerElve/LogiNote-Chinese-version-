import type { SceneCapabilityId, SceneInteractionType, ScenePromptModuleId, SceneRecipeId, SceneRuntimeToolId, SceneSpec } from '../../types';
import type { SceneBuildContext } from './sceneBuildAgent';
import { resolveSceneAssembly, type SceneAssemblyResult } from './sceneAssembly';
import { resolveSceneRuntimeContract } from './sceneRuntimeContract';
import { SceneUnderstandingError } from './sceneUnderstanding';
import { resolveSceneBuildPermissionPool, resolveSceneBuildManualSelections } from './sceneBuildPermissionPool';

const PRIVATE_MODULES: readonly ScenePromptModuleId[] = ['resource-grounding', 'personal-cognition-grounding', 'profile-personalization', 'model-experiment'];
const same = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every(id => b.includes(id));
const subset = (a: readonly string[], b: readonly string[]) => a.every(id => b.includes(id));
const scoped = (a: string[] | undefined, b: string[] | undefined) => b === undefined || (a !== undefined && subset(a, b));

export interface SceneBuildAuthority {
  surface: 'S1' | 'S4';
  manualRecipe?: SceneRecipeId;
  manualCapabilities?: SceneCapabilityId[];
  manualModules?: ScenePromptModuleId[];
  capabilityCeiling: SceneCapabilityId[];
  initialCapabilities: SceneCapabilityId[];
  moduleCeiling: ScenePromptModuleId[];
  permissionSource: 'validated-user-constraints' | 'legacy-initial-only';
  maxUserTasksPerTurn: number;
  questionItemTypeCeiling: NonNullable<SceneSpec['runtimeContract']>['allowedQuestionItemTypes'];
  interactionCeiling: SceneInteractionType[];
  initialModules: ScenePromptModuleId[];
  toolCeiling: SceneRuntimeToolId[];
  scope: { noteIds?: string[]; documentIds?: string[]; cognitionRecordIds?: string[] };
  referenceScope?: SceneSpec['referenceScope'];
  allowConversation: boolean;
  allowTextFallback: boolean;
  maxToolCallsPerTurn: number;
  maxPlanningSteps: number;
  experimentPolicy?: SceneSpec['experimentPolicy'];
}
export class SceneBuildAuthorityError extends SceneUnderstandingError {
  constructor(detail: string) { super('场景修复不能扩大原授权：' + detail, 'scene-authority-expansion'); this.name = 'SceneBuildAuthorityError'; }
}
export function captureSceneBuildAuthority(scene: SceneSpec, context: SceneBuildContext): SceneBuildAuthority {
  const surface = scene.meta.sceneSkill === 'S4' ? 'S4' : 'S1';
  if (context.selectedSurface && context.selectedSurface !== surface) throw new SceneBuildAuthorityError('不能改变用户已选择的运行面。');
  const manual = resolveSceneBuildManualSelections(surface, context);
  const contract = resolveSceneRuntimeContract(scene);
  const assembly = resolveSceneAssembly({ sceneSkill: scene.meta.sceneSkill === 'S4' ? 'S4' : 'S1',
    recipeId: scene.capabilityRecipeId || scene.behavior?.recipeId || (scene.meta.sceneSkill === 'S4' ? 'guided-derivation' : 'agent-designed'),
    requestedCapabilities: scene.capabilityIds, requestedPromptModules: scene.promptModuleIds });
  const capabilities = scene.capabilityIds || assembly.enabledCapabilities;
  const modules = scene.promptModuleIds || assembly.enabledPromptModules;
  const pool = resolveSceneBuildPermissionPool(scene.meta.sceneSkill === 'S4' ? 'S4' : 'S1', context, capabilities, modules, contract.allowedInteractionTypes, contract.allowedQuestionItemTypes);
  return structuredClone({ surface: scene.meta.sceneSkill === 'S4' ? 'S4' : 'S1', manualRecipe: context.explicitSelections.recipeId,
    manualCapabilities: manual.capabilities,
    manualModules: manual.promptModules,
    initialCapabilities: capabilities, capabilityCeiling: pool.capabilities, moduleCeiling: pool.promptModules,
    permissionSource: pool.provenance, interactionCeiling: pool.interactionTypes, initialModules: modules,
    maxUserTasksPerTurn: pool.maxUserTasksPerTurn ?? contract.maxUserTasksPerTurn, questionItemTypeCeiling: pool.questionItemTypes,
    toolCeiling: contract.allowedTools, scope: contract.scope, referenceScope: scene.referenceScope,
    allowConversation: pool.conversationPermitted ?? contract.allowConversation !== false, allowTextFallback: pool.textFallbackPermitted ?? contract.allowTextFallback,
    maxToolCallsPerTurn: contract.maxToolCallsPerTurn, maxPlanningSteps: contract.maxPlanningSteps,
    experimentPolicy: scene.experimentPolicy }) as SceneBuildAuthority;
}
export function assertSceneAssemblyAuthority(assembly: SceneAssemblyResult, authority: SceneBuildAuthority): void {
  if (!assembly.valid || (authority.manualRecipe && assembly.recipeId !== authority.manualRecipe)) throw new SceneBuildAuthorityError('配方或组件组合越界。');
  if (!subset(assembly.enabledCapabilities, authority.capabilityCeiling)) throw new SceneBuildAuthorityError('组件超出用户授权池、业务硬约束或手动选择。');
  if (!subset(assembly.enabledPromptModules, authority.moduleCeiling)) throw new SceneBuildAuthorityError('模块超出用户授权池或业务硬约束。');
  if (authority.manualCapabilities && !same(assembly.enabledCapabilities, authority.manualCapabilities)) throw new SceneBuildAuthorityError('不能改变手动选择的组件。');
  if (authority.manualModules && !same(assembly.enabledPromptModules, authority.manualModules)) throw new SceneBuildAuthorityError('不能改变手动选择的提示模块。');
  if (PRIVATE_MODULES.some(id => assembly.enabledPromptModules.includes(id) && !authority.initialModules.includes(id))) throw new SceneBuildAuthorityError('不能新增资料、个人认知、画像或付费实验授权。');
}
/** Field repairs and reassembly share the same authority; omitted scope is not an empty whitelist. */
export function assertSceneBuildAuthority(scene: SceneSpec, authority: SceneBuildAuthority): void {
  if (scene.meta.sceneSkill !== authority.surface) throw new SceneBuildAuthorityError('不能改变运行面。');
  const assembly = resolveSceneAssembly({ sceneSkill: authority.surface,
    recipeId: scene.capabilityRecipeId || scene.behavior?.recipeId || (authority.surface === 'S4' ? 'guided-derivation' : 'agent-designed'),
    requestedCapabilities: scene.capabilityIds, requestedPromptModules: scene.promptModuleIds });
  assertSceneAssemblyAuthority(assembly, authority);
  const contract = resolveSceneRuntimeContract(scene);
  if (!subset(contract.allowedQuestionItemTypes || [], authority.questionItemTypeCeiling || [])) throw new SceneBuildAuthorityError('不能增加未授权题组子题型。');
  if (!subset(contract.allowedTools, authority.toolCeiling) || !subset(contract.allowedInteractionTypes, authority.interactionCeiling)) throw new SceneBuildAuthorityError('不能新增工具或互动方式。');
  if (!scoped(contract.scope.noteIds, authority.scope.noteIds) || !scoped(contract.scope.documentIds, authority.scope.documentIds)
    || !scoped(contract.scope.cognitionRecordIds, authority.scope.cognitionRecordIds)) throw new SceneBuildAuthorityError('资料白名单只能保持或收窄。');
  const reference = authority.referenceScope;
  if (reference ? !scene.referenceScope || scene.referenceScope.projectId !== reference.projectId
    || !subset(scene.referenceScope.noteIds, reference.noteIds) || !subset(scene.referenceScope.documentIds, reference.documentIds)
    : scene.referenceScope !== undefined) throw new SceneBuildAuthorityError('不能更换本地项目取材范围。');
  if ((!authority.allowConversation && contract.allowConversation !== false) || (!authority.allowTextFallback && contract.allowTextFallback)
    || contract.maxToolCallsPerTurn > authority.maxToolCallsPerTurn || contract.maxPlanningSteps > authority.maxPlanningSteps
    || contract.maxUserTasksPerTurn > authority.maxUserTasksPerTurn) throw new SceneBuildAuthorityError('不能增加输入权限或取材/规划预算。');
  if (scene.promptModuleIds?.includes('model-experiment')) {
    const before = authority.experimentPolicy, after = scene.experimentPolicy;
    if (!before || !after || after.maxExperiments > before.maxExperiments || after.maxOutputTokens > before.maxOutputTokens
      || after.temperature !== before.temperature) throw new SceneBuildAuthorityError('不能增加实验预算或改变固定实验参数。');
  }
}
