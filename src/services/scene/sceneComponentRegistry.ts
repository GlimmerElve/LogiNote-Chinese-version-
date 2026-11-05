import type { SceneInteractionType, SceneRecipeId } from '../../types';
import {
  SCENE_CAPABILITY_DEFINITIONS,
  UNIFIED_SCENE_RECIPE_DEFINITIONS,
  normalizeUnifiedSceneRecipeId,
} from './sceneCapabilityRegistry';
import { buildSceneInteractionComponentV2Prompt } from './sceneInteractionComponentV2';

export type SceneComponentType = SceneInteractionType | 'true-false';

export interface SceneComponentDefinition {
  type: SceneComponentType;
  label: string;
  category: 'input' | 'composite';
  purpose: string;
  rendererId: string;
  supportsTopLevel: boolean;
  allowedChildren?: SceneComponentType[];
  maxItems?: number;
}

export interface SceneRecipeDefinition {
  id: SceneRecipeId;
  label: string;
  purpose: string;
  execution: 'turn-by-turn' | 'batch';
  preferredComponents: SceneComponentType[];
}

/**
 * S1 兼容视图。真正的事实源是 sceneCapabilityRegistry；保留本模块的导出名称，
 * 让既有协议校验、提示词和测试无需同时迁移。
 */
export const SCENE_COMPONENT_DEFINITIONS: readonly SceneComponentDefinition[] = SCENE_CAPABILITY_DEFINITIONS
  .filter((capability) => capability.surface === 'turn')
  .map((capability) => ({
    type: capability.id as SceneComponentType,
    label: capability.label,
    category: capability.category === 'composite' ? 'composite' : 'input',
    purpose: capability.purpose,
    rendererId: capability.rendererId || capability.id,
    supportsTopLevel: capability.supportsTopLevel === true,
    allowedChildren: capability.children ? [...capability.children] as SceneComponentType[] : undefined,
    maxItems: capability.maxItems,
  }));

export const SCENE_RECIPE_DEFINITIONS: readonly SceneRecipeDefinition[] = UNIFIED_SCENE_RECIPE_DEFINITIONS
  .filter((recipe) => recipe.surface === 'turn')
  .map((recipe) => ({
    id: recipe.id,
    label: recipe.label,
    purpose: recipe.purpose,
    execution: recipe.execution as 'turn-by-turn' | 'batch',
    preferredComponents: [...recipe.preferredCapabilities] as SceneComponentType[],
  }));

const TURN_RECIPE_IDS = new Set<SceneRecipeId>(SCENE_RECIPE_DEFINITIONS.map((recipe) => recipe.id));

export function normalizeSceneRecipeId(value: unknown): SceneRecipeId | undefined {
  const recipeId = normalizeUnifiedSceneRecipeId(value);
  return recipeId && TURN_RECIPE_IDS.has(recipeId) ? recipeId : undefined;
}

export function getSceneRecipe(id?: SceneRecipeId): SceneRecipeDefinition | undefined {
  return id ? SCENE_RECIPE_DEFINITIONS.find((recipe) => recipe.id === id) : undefined;
}

export function buildSceneComponentCapabilityPrompt(): string {
  return buildSceneInteractionComponentV2Prompt();
}

export function buildSceneRecipeCatalogPrompt(): string {
  return SCENE_RECIPE_DEFINITIONS.map((recipe) => (
    `- ${recipe.id}（${recipe.label}，${recipe.execution}）：${recipe.purpose}；优先组件 ${recipe.preferredComponents.join('、')}`
  )).join('\n');
}
