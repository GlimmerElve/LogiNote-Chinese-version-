import type { SceneBehaviorSpec, SceneInteractionProtocol, SceneOutputFormat, SceneSpec } from '../../types';
import { normalizeSceneInteractionProtocol, resolveSceneRuntimeInteractionProtocol } from './sceneInteraction';
import { getSceneRecipe, normalizeSceneRecipeId } from './sceneComponentRegistry';

export type SceneParadigm = 'compute' | 'general' | 'dialogue';

const OUTPUT_FORMATS = new Set<SceneOutputFormat>(['markdown', 'latex', 'code', 'table', 'image']);

function requiredText(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** 不信任 LLM JSON：五个行为字段缺一则回退传统 S1。 */
export function parseBehaviorSpec(value: unknown): SceneBehaviorSpec | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const behavior: SceneBehaviorSpec = {
    recipeId: normalizeSceneRecipeId(raw.recipeId),
    kind: requiredText(raw.kind),
    aiBehavior: requiredText(raw.aiBehavior),
    userAction: requiredText(raw.userAction),
    evaluationRule: requiredText(raw.evaluationRule),
    progressionRule: requiredText(raw.progressionRule),
    outputFormats: Array.isArray(raw.outputFormats)
      ? [...new Set(raw.outputFormats.filter((item): item is SceneOutputFormat => OUTPUT_FORMATS.has(item as SceneOutputFormat)))]
      : undefined,
    interaction: normalizeSceneInteractionProtocol(raw.interaction),
  };
  if (!behavior.kind || !behavior.aiBehavior || !behavior.userAction || !behavior.evaluationRule || !behavior.progressionRule) {
    return undefined;
  }
  return behavior;
}

/** 分派优先级固定为 S4 计算画布 > 通用 S1 > 传统 S1。 */
export function resolveSceneParadigm(spec: Pick<SceneSpec, 'compute' | 'behavior'>): SceneParadigm {
  if (spec.compute) return 'compute';
  if (spec.behavior) return 'general';
  return 'dialogue';
}

export function buildOutputFormatHint(formats?: SceneOutputFormat[]): string {
  if (!formats?.length) return '';
  const labels: Record<SceneOutputFormat, string> = {
    markdown: '使用简洁 Markdown 组织内容',
    latex: '公式使用 $...$ 或 $$...$$',
    code: '代码使用带语言标识的代码块',
    table: '比较信息可使用 Markdown 表格',
    image: '只有已有可靠 URL 时才使用 Markdown 图片',
  };
  return formats.map((format) => `- ${labels[format]}`).join('\n');
}

export function buildBehaviorPromptSection(spec: Pick<SceneSpec, 'behavior'>, protocol?: SceneInteractionProtocol): string {
  const behavior = spec.behavior;
  if (!behavior) return '';
  const formatHint = buildOutputFormatHint(behavior.outputFormats);
  const interaction = protocol || resolveSceneRuntimeInteractionProtocol(behavior.interaction);
  const recipe = getSceneRecipe(behavior.recipeId);
  return [
    recipe ? `【场景配方】${recipe.id}（${recipe.label}，${recipe.execution}）` : '',
    `【交互形式】${behavior.kind}`,
    `【你的回合行为】${behavior.aiBehavior}`,
    `【用户本轮任务】${behavior.userAction}`,
    `【评价规则】${behavior.evaluationRule}`,
    `【推进规则】${behavior.progressionRule}`,
    `【可用交互能力】${interaction.allowedTypes.join('、')}；创建任务时默认 ${interaction.defaultType}，并非每轮必须创建任务。只能要求用户完成已授权交互；${interaction.allowTextFallback ? '允许配置范围内的文本作答。' : '不得用文本输入替代指定题型的作答控件。'}解释、提示、澄清、调整要求和总结不是答题任务，可以使用纯文本回应；用户交流入口由独立allowConversation权限控制。`,
    formatHint ? `【输出格式】\n${formatHint}` : '',
  ].filter(Boolean).join('\n\n');
}
