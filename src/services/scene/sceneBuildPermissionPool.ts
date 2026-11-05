import type { SceneCapabilityId, SceneInteractionType, ScenePromptModuleId } from '../../types';
import type { SceneBuildContext } from './sceneBuildAgent';
import { SCENE_CAPABILITY_DEFINITIONS, SCENE_PROMPT_MODULE_DEFINITIONS } from './sceneCapabilityRegistry';
import { readSceneBuildConstraints, SceneUnderstandingError } from './sceneUnderstanding';
import { resolveSceneAssembly } from './sceneAssembly';

// Builtin-public allowlists: a future plugin registration is never a new authorization.
const PUBLIC_CAPABILITIES: readonly SceneCapabilityId[] = ['text', 'single-choice', 'multiple-choice', 'ordering', 'fill-blanks', 'question-set', 'markdown-content',
  'given-node', 'assumption-node', 'formula-node', 'conclusion-node', 'derivation-edge', 'mathlive-editor', 'step-submit', 'premise-validation'];
const PUBLIC_MODULES: readonly ScenePromptModuleId[] = ['role-context', 'scenario-framing', 'structured-interaction', 'deterministic-assessment',
  'adaptive-progression', 'turn-agent-planning', 'metric-state', 'event-system', 'input-form'];
const KNOWN_PRIVATE_MODULES: readonly ScenePromptModuleId[] = ['resource-grounding', 'personal-cognition-grounding', 'profile-personalization', 'model-experiment'];

/** Human selections plus registered required dependencies; never inferred from a generated draft. */
export function resolveSceneBuildManualSelections(surface: 'S1' | 'S4', context: SceneBuildContext): {
  capabilities?: SceneCapabilityId[]; promptModules?: ScenePromptModuleId[];
} {
  const selections = context.explicitSelections;
  if (selections.capabilities === undefined && selections.promptModules === undefined) return {};
  const manual = resolveSceneAssembly({
    sceneSkill: surface,
    recipeId: selections.recipeId || context.assembly?.recipeId || (surface === 'S4' ? 'guided-derivation' : 'agent-designed'),
    requestedCapabilities: selections.capabilities ?? context.assembly?.capabilities,
    requestedPromptModules: selections.promptModules ?? context.assembly?.promptModules,
  });
  if (!manual.valid) throw new SceneUnderstandingError('用户手动选择与运行面或必需依赖冲突。', 'invalid-manual-scene-selection');
  return {
    capabilities: selections.capabilities === undefined ? undefined : manual.enabledCapabilities,
    promptModules: selections.promptModules === undefined ? undefined : manual.enabledPromptModules,
  };
}
const INTERACTIONS: readonly SceneInteractionType[] = ['text', 'single-choice', 'multiple-choice', 'ordering', 'fill-blanks', 'question-set'];
const ANSWER_CAPABILITIES = { 'single-choice': 'single-choice', 'multiple-choice': 'multiple-choice', 'true-false': 'single-choice',
  ordering: 'ordering', 'fill-blanks': 'fill-blanks', 'free-text': 'text' } as const;
const BEHAVIOR_MODULES: Record<string, ScenePromptModuleId> = { 'role-play': 'role-context', narrative: 'scenario-framing',
  metrics: 'metric-state', events: 'event-system', forms: 'input-form', 'adaptive-progression': 'adaptive-progression' };
export interface SceneBuildPermissionPool {
  provenance: 'validated-user-constraints' | 'legacy-initial-only';
  capabilities: SceneCapabilityId[];
  promptModules: ScenePromptModuleId[];
  interactionTypes: SceneInteractionType[];
  questionItemTypes: Array<'single-choice' | 'multiple-choice' | 'true-false'>;
  textFallbackPermitted?: boolean;
  conversationPermitted?: boolean;
  maxUserTasksPerTurn?: number;
}
export function resolveSceneBuildPermissionPool(surface: 'S1' | 'S4', context: SceneBuildContext,
  initialCapabilities: SceneCapabilityId[], initialModules: ScenePromptModuleId[], initialInteractionTypes: SceneInteractionType[], initialQuestionItemTypes: Array<'single-choice' | 'multiple-choice' | 'true-false'> = ['single-choice', 'multiple-choice', 'true-false']): SceneBuildPermissionPool {
  const manual = resolveSceneBuildManualSelections(surface, context);
  const narrowCapabilities = (ids: SceneCapabilityId[]) => manual.capabilities === undefined ? ids : ids.filter(id => manual.capabilities!.includes(id));
  const narrowModules = (ids: ScenePromptModuleId[]) => manual.promptModules === undefined ? ids : ids.filter(id => manual.promptModules!.includes(id));
  if (!context.understanding?.buildConstraints) {
    const capabilities = narrowCapabilities([...new Set([...initialCapabilities, ...(surface === 'S1' ? initialInteractionTypes : [])])]);
    return { provenance: 'legacy-initial-only', capabilities,
      promptModules: narrowModules([...initialModules]),
      interactionTypes: surface === 'S4' ? [] : initialInteractionTypes.filter(id => capabilities.includes(id)),
      questionItemTypes: surface === 'S4' ? [] : [...initialQuestionItemTypes] };
  }
  const sources = new Map([...context.conversation.filter(item => item.role === 'user').map(item => [item.sourceId, item.text] as const),
    ['request', context.userRequest] as const, ['selections', JSON.stringify(context.explicitSelections)] as const]);
  const constraints = readSceneBuildConstraints(context.understanding.buildConstraints, sources);
  if (surface === 'S4' && (constraints.interactionPolicy !== 'unrestricted' || constraints.taskPackaging === 'batch')) throw new SceneUnderstandingError('S4画布不能按S1题型授权。', 'surface-constraint-conflict');
  const restricted = surface === 'S1' && constraints.interactionPolicy === 'restricted';
  const answerCapabilities = new Set<SceneCapabilityId>(constraints.answerKinds.map(kind => ANSWER_CAPABILITIES[kind]));
  const questionItemTypes = (['single-choice', 'multiple-choice', 'true-false'] as const).filter(kind => !restricted || constraints.answerKinds.includes(kind));
  const allowedBatchChildren = questionItemTypes.length > 0;
  const excludedModules = new Set(constraints.excludedBehaviors.flatMap(id => BEHAVIOR_MODULES[id] ? [BEHAVIOR_MODULES[id]] : []));
  let capabilities = SCENE_CAPABILITY_DEFINITIONS.filter(item => PUBLIC_CAPABILITIES.includes(item.id)
    && item.sceneSkills.includes(surface) && (item.surface === 'shared' || item.surface === (surface === 'S1' ? 'turn' : 'canvas'))
    && (!restricted || item.id === 'markdown-content' || item.id === 'question-set' || answerCapabilities.has(item.id))
    && (item.id !== 'question-set' || (constraints.taskPackaging !== 'single' && allowedBatchChildren))).map(item => item.id);
  const authorizedNonPublicCapabilities = initialCapabilities.filter(id => !PUBLIC_CAPABILITIES.includes(id)
    && ((surface === 'S4' && id === 'compute-help') || context.explicitSelections.capabilities?.includes(id)));
  capabilities = [...new Set([...capabilities, ...authorizedNonPublicCapabilities])];
  // S4 has no structured canvas restrictions yet: retain its existing controls rather than infer new permissions.
  if (surface === 'S4') capabilities = capabilities.filter(id => initialCapabilities.includes(id));
  capabilities = narrowCapabilities(capabilities);
  let promptModules = SCENE_PROMPT_MODULE_DEFINITIONS.filter(item => PUBLIC_MODULES.includes(item.id)
    && item.sceneSkills.includes(surface) && !excludedModules.has(item.id)
    && (item.id !== 'input-form' || capabilities.includes('text'))).map(item => item.id);
  promptModules = [...new Set([...promptModules, ...initialModules.filter(id => !PUBLIC_MODULES.includes(id)
    && (KNOWN_PRIVATE_MODULES.includes(id) || context.explicitSelections.promptModules?.includes(id)))])];
  if (surface === 'S4') promptModules = promptModules.filter(id => initialModules.includes(id));
  promptModules = narrowModules(promptModules);
  const interactionTypes = surface === 'S4' ? [] : capabilities.filter((id): id is SceneInteractionType =>
    INTERACTIONS.includes(id as SceneInteractionType) && (constraints.taskPackaging !== 'batch' || id === 'question-set'));
  return { provenance: 'validated-user-constraints', capabilities, promptModules, interactionTypes,
    questionItemTypes: surface === 'S4' ? [] : questionItemTypes,
    textFallbackPermitted: surface === 'S1' ? interactionTypes.includes('text') : false,
    conversationPermitted: surface === 'S1' && !constraints.excludedBehaviors.includes('free-conversation'),
    maxUserTasksPerTurn: surface === 'S1' ? constraints.taskPackaging === 'single' ? 1 : 12 : 0 };
}
