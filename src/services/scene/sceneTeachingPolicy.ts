import type {
  SceneAnswerFeedbackPolicy, SceneFeedbackTiming, SceneTeachingConditionalRule,
  SceneTeachingInstruction, SceneTeachingInstructionUpdate,
} from '../../types';

export function normalizeSceneAnswerFeedback(raw: unknown): SceneAnswerFeedbackPolicy {
  if (raw === undefined) return { correctness: 'immediate', explanation: 'immediate' };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('answerFeedback必须是对象');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).some(key => !['correctness', 'explanation'].includes(key))
    || !isSceneFeedbackTiming(value.correctness) || !isSceneFeedbackTiming(value.explanation)) {
    throw new Error('answerFeedback的correctness/explanation必须为immediate/on-request/at-end');
  }
  return { correctness: value.correctness, explanation: value.explanation };
}
export function isSceneFeedbackTiming(value: unknown): value is SceneFeedbackTiming {
  return typeof value === 'string' && ['immediate', 'on-request', 'at-end'].includes(value);
}

const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value)
  ? value as Record<string, unknown> : {};
function text(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(field + '必须是有效的有限长度文本');
  return value.trim();
}

/** This is only a typed teaching strategy, never an executable tool or permission request. */
export function readSceneTeachingPolicyUpdates(raw: unknown): SceneTeachingInstructionUpdate[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 4) throw new Error('policyUpdates每轮须有1至4项');
  const ids = new Set<string>();
  return raw.map(input => {
    const value = object(input), id = text(value.id, 80, 'policyUpdates.id');
    if (ids.has(id)) throw new Error('policyUpdates同轮不能重复更新同一ID');
    ids.add(id);
    if (Object.keys(value).some(key => !['id', 'action', 'scope', 'interactionId', 'target', 'instruction', 'rules', 'source'].includes(key))
      || (value.action !== 'set' && value.action !== 'revoke')
      || (value.scope !== 'session' && value.scope !== 'task' && value.scope !== 'review')
      || (value.interactionId !== undefined && value.scope !== 'task')
      || (value.target !== undefined && (value.scope !== 'review' || (value.target !== 'all' && value.target !== 'incorrect')))) {
      throw new Error('policyUpdates字段、动作或范围无效');
    }
    const source = object(value.source);
    if (Object.keys(source).some(key => !['sourceMessageId', 'quote'].includes(key))) throw new Error('policyUpdates.source只能引用真实用户消息');
    const reference = { sourceMessageId: text(source.sourceMessageId, 200, 'policyUpdates.source.sourceMessageId'),
      quote: text(source.quote, 500, 'policyUpdates.source.quote') };
    const base = { id, action: value.action, scope: value.scope, source: reference } as SceneTeachingInstructionUpdate;
    if (value.action === 'revoke') {
      if (['interactionId', 'target', 'instruction', 'rules'].some(key => value[key] !== undefined)) throw new Error('revoke不能夹带新策略或目标');
      return base;
    }
    if (value.interactionId !== undefined) base.interactionId = text(value.interactionId, 200, 'policyUpdates.interactionId');
    if (value.target !== undefined) base.target = value.target as 'all' | 'incorrect';
    if (value.instruction !== undefined) base.instruction = text(value.instruction, 600, 'policyUpdates.instruction');
    if (value.rules !== undefined) {
      if (!Array.isArray(value.rules) || !value.rules.length || value.rules.length > 4) throw new Error('每项策略须有1至4条条件规则');
      const conditions = new Set<string>();
      base.rules = value.rules.map(inputRule => {
        const rule = object(inputRule);
        if (Object.keys(rule).some(key => !['when', 'correctness', 'explanation', 'responseStyle'].includes(key))
          || typeof rule.when !== 'string' || !['any', 'correct', 'incorrect', 'on-request'].includes(rule.when)
          || conditions.has(rule.when)
          || ['correctness', 'explanation', 'responseStyle'].every(key => rule[key] === undefined)
          || (rule.correctness !== undefined && !isSceneFeedbackTiming(rule.correctness))
          || (rule.explanation !== undefined && !isSceneFeedbackTiming(rule.explanation))
          || (rule.responseStyle !== undefined && (typeof rule.responseStyle !== 'string'
            || !['brief-confirmation', 'explanation', 'agent-decides'].includes(rule.responseStyle)))) throw new Error('条件规则字段或when无效');
        conditions.add(rule.when);
        return { when: rule.when,
          ...(rule.correctness === undefined ? {} : { correctness: rule.correctness }),
          ...(rule.explanation === undefined ? {} : { explanation: rule.explanation }),
          ...(rule.responseStyle === undefined ? {} : { responseStyle: rule.responseStyle }),
        } as SceneTeachingConditionalRule;
      });
    }
    if (!base.instruction && !base.rules?.length) throw new Error('set至少提供本局指令或条件规则');
    return base;
  });
}

/** New verified sources win; specificity orders conditions only within each instruction. */
export function resolveSceneTeachingConditionalPolicy(base: SceneAnswerFeedbackPolicy,
  instructions: SceneTeachingInstruction[] | undefined,
  context: { interactionId: string; outcome?: 'correct' | 'incorrect'; explanationRequested: boolean; currentUserMessageId?: string },
  overrides: Array<{ acceptedOrder?: number; scope: 'session' | 'task'; correctness?: SceneFeedbackTiming; explanation?: SceneFeedbackTiming }> = []) {
  const result: SceneAnswerFeedbackPolicy & { responseStyle: NonNullable<SceneTeachingConditionalRule['responseStyle']>; matchedInstructionIds: string[] } = {
    ...base, responseStyle: 'agent-decides', matchedInstructionIds: [],
  };
  const order = (value: number | undefined) => Number.isSafeInteger(value) && value! >= 0 ? value! : 0;
  const scopeRank = (scope: string) => scope === 'session' ? 0 : scope === 'task' ? 1 : 2;
  const candidates = [
    ...overrides.map(override => ({ order: order(override.acceptedOrder), scope: override.scope, override, instruction: undefined as SceneTeachingInstruction | undefined })),
    ...(instructions || []).map(instruction => ({ order: order(instruction.acceptedOrder), scope: instruction.scope, instruction,
      override: undefined as typeof overrides[number] | undefined })),
  ].sort((left, right) => left.order - right.order || scopeRank(left.scope) - scopeRank(right.scope));
  for (const candidate of candidates) {
    if (candidate.override) {
      if (candidate.override.correctness !== undefined) result.correctness = candidate.override.correctness;
      if (candidate.override.explanation !== undefined) {
        result.explanation = candidate.override.explanation;
        result.responseStyle = candidate.override.explanation === 'immediate' ? 'explanation' : 'agent-decides';
      }
      continue;
    }
    const instruction = candidate.instruction!;
    if (instruction.scope !== 'session' && !instruction.interactionIds?.includes(context.interactionId)) continue;
    if (instruction.scope === 'review' && instruction.source.sourceMessageId !== context.currentUserMessageId) continue;
    result.matchedInstructionIds.push(instruction.id);
    for (const when of ['any', context.outcome, ...(context.explanationRequested ? ['on-request'] : [])]) {
      if (!when) continue;
      const rule = instruction.rules.find(item => item.when === when);
      if (!rule) continue;
      if (rule.correctness !== undefined) result.correctness = rule.correctness;
      if (rule.explanation !== undefined) result.explanation = rule.explanation;
      if (rule.responseStyle !== undefined) result.responseStyle = rule.responseStyle;
    }
  }
  return result;
}
