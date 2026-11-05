import type {
  SceneInteractionDirective,
  SceneInteractionOption,
  SceneInteractionOrderPolicy,
  SceneObjectiveEvaluation,
  SceneQuestionSetEvaluation,
} from '../../types';
import { getSceneInteractionComponentV2 } from './sceneInteractionComponentV2';

export interface SceneInteractionPreparation {
  version: 1;
  interactionId: string;
  sourceFingerprint: string;
  preparedFingerprint: string;
  orders: Array<{
    itemId?: string;
    field: 'options' | 'items';
    ids: string[];
    mode: 'shuffled' | 'preserved';
    reason?: string;
  }>;
}

export interface SceneTaskPreparationInput {
  content: string;
  interaction: SceneInteractionDirective;
  objectiveEvaluation?: SceneObjectiveEvaluation;
  interactionEvaluation?: SceneQuestionSetEvaluation;
  /** Optional private ordering target. Never rendered or copied into the directive. */
  orderingTargetIds?: readonly string[];
  /** Local executor receipt only. Never read this field from an LLM response. */
  interactionPreparation?: SceneInteractionPreparation;
}

function fingerprint(value: SceneTaskPreparationInput): string {
  const payload = { content: value.content, interaction: value.interaction,
    objectiveEvaluation: value.objectiveEvaluation, interactionEvaluation: value.interactionEvaluation,
    orderingTargetIds: value.orderingTargetIds || (value.objectiveEvaluation?.type === 'ordering' ? value.objectiveEvaluation.correctOrderIds : undefined) };
  // This is task identity/corruption detection, not an authorization or cryptographic boundary.
  const serialized = JSON.stringify(payload);
  let hash = 2166136261;
  for (let i = 0; i < serialized.length; i += 1) hash = Math.imul(hash ^ serialized.charCodeAt(i), 16777619);
  return `${serialized.length}:${(hash >>> 0).toString(16)}`;
}

function randomFraction(): number {
  if (globalThis.crypto?.getRandomValues) {
    const bytes = new Uint32Array(1);
    globalThis.crypto.getRandomValues(bytes);
    return bytes[0] / 0x100000000;
  }
  return Math.random();
}

function randomIndex(max: number, random: () => number): number {
  const fraction = random();
  if (!Number.isFinite(fraction) || fraction < 0 || fraction >= 1) throw new Error('任务准备随机源必须返回 [0,1) 数值。');
  return Math.floor(fraction * max);
}

function shuffled<T>(values: readonly T[], random: () => number): T[] {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = randomIndex(i + 1, random);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function hasPositionReference(text: string): boolean {
  // Conservative preservation beats changing an old letter/position reference into a wrong answer.
  return /(?:选项|答案|选择|选|option|answer)\s*(?:是|为|：|:)?\s*[A-ZＡ-Ｚ](?![a-z])/iu.test(text)
    || /(?:^|\n)\s*(?:[（(])?[A-ZＡ-Ｚ][.．、):：）]\s*\S/u.test(text)
    || /[A-ZＡ-Ｚ]\s*(?:项|选项|是正确答案|为正确答案|is\s+the\s+(?:correct\s+)?(?:answer|option))/iu.test(text)
    || /第\s*(?:[一二三四五六七八九十]|\d+)\s*(?:个|项|条)?\s*(?:选项|答案|项目)|(?:以上|上述|下面|以下|前面|后面)(?:的)?(?:选项)?(?:都|均|全部|各项|两项|皆)|(?:all|none)\s+of\s+the\s+(?:above|below)|(?:first|second|third|last)\s+(?:option|choice|item)/iu.test(text);
}

function isBooleanChoice(options: readonly SceneInteractionOption[]): boolean {
  if (options.length !== 2) return false;
  const labels = options.map(option => option.label.trim().replace(/[。.!！]/g, '').toLowerCase());
  return [['正确', '错误'], ['对', '错'], ['是', '否'], ['true', 'false'], ['yes', 'no']]
    .some(pair => pair.every(label => labels.includes(label)));
}

function hasLegacyAnswerLetterReference(explanation: string | undefined): boolean {
  if (!explanation) return false;
  return /^\s*[A-ZＡ-Ｚ]\s*[。.!！]?\s*$/iu.test(explanation)
    || /(?:正确|错误)(?:的)?(?:答案|选项)?\s*(?:是|为|：|:)?\s*[A-ZＡ-Ｚ](?![a-z])/iu.test(explanation)
    || /(?:^|\s|[。；;，,])[A-ZＡ-Ｚ](?![a-z])\s*(?:项)?\s*(?:是|为)?\s*(?:正确|错误|correct|incorrect)/iu.test(explanation);
}

function preserveReason(policy: SceneInteractionOrderPolicy | undefined, text: string, options?: readonly SceneInteractionOption[]): string | undefined {
  if (policy?.mode === 'preserve') return policy.reason || 'explicit-preserve';
  if (options && isBooleanChoice(options)) return 'true-false';
  // Explicit shuffle is not permission to corrupt position-dependent task text or explanations.
  if (hasPositionReference(text)) return 'position-reference';
  return undefined;
}

function restoreOrder<T extends { id: string }>(values: readonly T[], ids: readonly string[]): T[] {
  const byId = new Map(values.map(value => [value.id, value]));
  if (ids.length !== values.length || new Set(ids).size !== ids.length || ids.some(id => !byId.has(id))) {
    throw new Error('任务准备收据与当前组件项目不一致。');
  }
  return ids.map(id => byId.get(id)!);
}

function replayOrders(interaction: SceneInteractionDirective, orders: SceneInteractionPreparation['orders']): SceneInteractionDirective {
  let result = interaction;
  for (const order of orders) {
    if (result.type === 'question-set' && order.itemId && order.field === 'options') {
      result = { ...result, items: result.items.map(item => item.id === order.itemId && item.type !== 'true-false'
        ? { ...item, options: restoreOrder(item.options, order.ids) } : item) };
    } else if ((result.type === 'single-choice' || result.type === 'multiple-choice') && !order.itemId && order.field === 'options') {
      result = { ...result, options: restoreOrder(result.options, order.ids) };
    } else if (result.type === 'ordering' && !order.itemId && order.field === 'items') {
      result = { ...result, items: restoreOrder(result.items, order.ids) };
    } else throw new Error('任务准备收据引用了不兼容的组件。');
  }
  return result;
}

/**
 * Registered-component task preparation, called only after protocol/key validation and before storage.
 * IDs and private answer keys never change; callers persist both the prepared directive and receipt.
 * A replay accepts either the original or prepared payload, and never consumes randomness again.
 */
export function prepareSceneInteractionTask<T extends SceneTaskPreparationInput>(
  input: T,
  options: { random?: () => number } = {},
): T & { interactionPreparation: SceneInteractionPreparation } {
  const sourceFingerprint = fingerprint(input);
  const previous = input.interactionPreparation;
  if (previous) {
    if (previous.version !== 1 || previous.interactionId !== input.interaction.id
      || (sourceFingerprint !== previous.sourceFingerprint && sourceFingerprint !== previous.preparedFingerprint)) {
      throw new Error('不能将另一道题的准备收据用于当前任务。');
    }
    const replayed = { ...input, interaction: replayOrders(input.interaction, previous.orders), interactionPreparation: previous };
    if (fingerprint(replayed) !== previous.preparedFingerprint) throw new Error('任务准备收据已损坏。');
    return replayed;
  }
  const random = options.random || randomFraction;
  const orders: SceneInteractionPreparation['orders'] = [];
  const component = getSceneInteractionComponentV2(input.interaction.type, 'top-level');
  if (!component) throw new Error('任务准备只能执行已注册的顶层交互组件。');
  let interaction = input.interaction;
  const prepareOptions = (values: SceneInteractionOption[], reason: string | undefined, itemId?: string) => {
    const prepared = reason ? [...values] : shuffled(values, random);
    orders.push({ ...(itemId ? { itemId } : {}), field: 'options', ids: prepared.map(option => option.id), mode: reason ? 'preserved' : 'shuffled', ...(reason ? { reason } : {}) });
    return prepared;
  };
  if (component?.preparation?.randomization === 'objective-options' && (interaction.type === 'single-choice' || interaction.type === 'multiple-choice')) {
    const text = [input.content, interaction.instruction, input.objectiveEvaluation?.explanation,
      ...interaction.options.flatMap(option => [option.label, option.description])].filter(Boolean).join('\n');
    const reason = interaction.assessment === 'none' ? 'strategy-choice'
      : interaction.assessment === undefined && !input.objectiveEvaluation ? 'legacy-ungraded-choice'
      : hasLegacyAnswerLetterReference(input.objectiveEvaluation?.explanation) ? 'legacy-answer-letter'
      : preserveReason(interaction.orderPolicy, text, interaction.options);
    interaction = { ...interaction, options: prepareOptions(interaction.options, reason) };
  } else if (component?.preparation?.randomization === 'ordering-items' && interaction.type === 'ordering') {
    const text = [input.content, interaction.instruction, ...interaction.items.map(item => item.content)].filter(Boolean).join('\n');
    const reason = interaction.assessment === 'none' ? 'strategy-choice' : preserveReason(interaction.orderPolicy, text);
    const sourceIds = interaction.items.map(item => item.id);
    const targetIds = input.orderingTargetIds || (input.objectiveEvaluation?.type === 'ordering' ? input.objectiveEvaluation.correctOrderIds : undefined);
    if (targetIds && (targetIds.length !== sourceIds.length || new Set(targetIds).size !== targetIds.length || targetIds.some(id => !sourceIds.includes(id)))) {
      throw new Error('排序私有目标必须精确引用当前项目稳定 id。');
    }
    let items = reason ? [...interaction.items] : shuffled(interaction.items, random);
    const isTarget = () => !!targetIds && items.every((item, index) => item.id === targetIds[index]);
    if (!reason) {
      for (let attempt = 0; attempt < 8 && isTarget(); attempt += 1) items = shuffled(interaction.items, random);
      // Bounded fallback also handles a deterministic/broken test RNG without a retry loop.
      if (items.length > 1 && isTarget()) [items[0], items[1]] = [items[1], items[0]];
    }
    orders.push({ field: 'items', ids: items.map(item => item.id), mode: reason ? 'preserved' : 'shuffled', ...(reason ? { reason } : {}) });
    interaction = { ...interaction, items };
  } else if (component?.preparation?.randomization === 'registered-children' && interaction.type === 'question-set') {
    const group = interaction;
    interaction = { ...group, items: group.items.map(item => {
      if (item.type === 'true-false' || getSceneInteractionComponentV2(item.type, 'question-set-item')?.preparation?.randomization !== 'objective-options') return item;
      const key = input.interactionEvaluation?.items.find(candidate => candidate.itemId === item.id);
      const text = [input.content, group.instruction, group.title, group.description,
        item.content, key?.explanation, ...item.options.flatMap(option => [option.label, option.description])].filter(Boolean).join('\n');
      const reason = hasLegacyAnswerLetterReference(key?.explanation) ? 'legacy-answer-letter' : preserveReason(item.orderPolicy, text, item.options);
      return { ...item, options: prepareOptions(item.options, reason, item.id) };
    }) };
  }
  const prepared = { ...input, interaction };
  const receipt: SceneInteractionPreparation = {
    version: 1, interactionId: interaction.id, sourceFingerprint,
    preparedFingerprint: fingerprint(prepared), orders,
  };
  return { ...prepared, interactionPreparation: receipt };
}
