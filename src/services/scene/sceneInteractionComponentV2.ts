import type { SceneCapabilityId, SceneInteractionType } from '../../types';
import { getSceneCapability } from './sceneCapabilityRegistry';

export const SCENE_INTERACTION_COMPONENT_PROTOCOL_VERSION = '2.0' as const;

export type SceneInteractionComponentType = SceneInteractionType | 'true-false';
export type SceneInteractionComponentScope = 'top-level' | 'question-set-item';
export type SceneInteractionEvaluationMode = 'llm-next-turn' | 'deterministic-client' | 'deterministic-engine' | 'none';
export type SceneInteractionRandomizationMode = 'objective-options' | 'ordering-items' | 'registered-children' | 'preserve';

/**
 * 够用且可序列化的 JSON Schema 子集。它只描述 Agent 可填写的公开字段，
 * 不接受函数、组件名或任意代码；以后可平滑换成标准 JSON Schema 校验器。
 */
export interface SceneInteractionValueSchema {
  type: 'object' | 'array' | 'string' | 'integer' | 'boolean';
  description?: string;
  const?: string | number | boolean;
  enum?: ReadonlyArray<string | number | boolean>;
  properties?: Readonly<Record<string, SceneInteractionValueSchema>>;
  required?: readonly string[];
  additionalProperties?: boolean;
  items?: SceneInteractionValueSchema;
  minItems?: number;
  maxItems?: number;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
}

export interface SceneInteractionComponentV2Definition {
  protocolVersion: typeof SCENE_INTERACTION_COMPONENT_PROTOCOL_VERSION;
  capabilityId: SceneInteractionComponentType;
  label: string;
  purpose: string;
  scopes: readonly SceneInteractionComponentScope[];
  rendererId: string;
  validatorId: string;
  directiveSchema: SceneInteractionValueSchema;
  responseSchema: SceneInteractionValueSchema;
  evaluation: {
    mode: SceneInteractionEvaluationMode;
    /** 评分依据绝不能混进给前端/模型生成的 directive。 */
    answerVisibility: 'not-in-directive';
    feedbackTiming: 'immediate' | 'next-turn' | 'after-submit';
  };
  composition?: {
    allowedChildren: readonly SceneInteractionComponentType[];
    minItems: number;
    maxItems: number;
  };
  fallbackCapability?: 'text';
  /** Executed once before a new task is stored, never by a renderer or a model call. */
  preparation?: { randomization: SceneInteractionRandomizationMode; preservesStableIds: true };
}

const stringSchema = (description?: string): SceneInteractionValueSchema => ({ type: 'string', description });
const booleanSchema = (description?: string): SceneInteractionValueSchema => ({ type: 'boolean', description });
const integerSchema = (description?: string, minimum = 1, maximum?: number): SceneInteractionValueSchema => ({
  type: 'integer', description, minimum, maximum,
});
const arraySchema = (
  items: SceneInteractionValueSchema,
  options: Pick<SceneInteractionValueSchema, 'description' | 'minItems' | 'maxItems'> = {},
): SceneInteractionValueSchema => ({ type: 'array', items, ...options });
const objectSchema = (
  properties: Readonly<Record<string, SceneInteractionValueSchema>>,
  required: readonly string[],
): SceneInteractionValueSchema => ({ type: 'object', properties, required, additionalProperties: false });
const typed = (type: SceneInteractionComponentType): SceneInteractionValueSchema => ({ type: 'string', const: type });

const optionSchema = objectSchema({
  id: stringSchema('选项稳定 id'),
  label: stringSchema('用户可见选项'),
  description: stringSchema('可选补充说明'),
}, ['id', 'label']);

const baseDirectiveProperties = (type: SceneInteractionComponentType): Record<string, SceneInteractionValueSchema> => ({
  id: stringSchema('当前回合唯一 id'),
  type: typed(type),
  instruction: stringSchema('简短操作说明，主要题干放在消息正文'),
  required: booleanSchema('是否必须作答'),
});

const baseResponseProperties = (type: SceneInteractionComponentType): Record<string, SceneInteractionValueSchema> => ({
  interactionId: stringSchema('必须引用 directive.id'),
  type: typed(type),
  submittedAt: stringSchema('ISO 时间；缺省时由客户端补齐'),
});

function define(
  capabilityId: SceneInteractionComponentType,
  input: Omit<SceneInteractionComponentV2Definition, 'protocolVersion' | 'capabilityId' | 'label' | 'purpose' | 'rendererId' | 'validatorId'>,
): SceneInteractionComponentV2Definition {
  const capability = getSceneCapability(capabilityId as SceneCapabilityId);
  if (!capability || capability.surface !== 'turn' || !capability.rendererId || !capability.validatorId) {
    throw new Error(`V2 回合组件缺少统一能力注册：${capabilityId}`);
  }
  return {
    protocolVersion: SCENE_INTERACTION_COMPONENT_PROTOCOL_VERSION,
    capabilityId,
    label: capability.label,
    purpose: capability.purpose,
    rendererId: capability.rendererId,
    validatorId: capability.validatorId,
    ...input,
  };
}

const explanation = stringSchema('可选作答理由');
const assessmentSchema: SceneInteractionValueSchema = {
  type: 'string', enum: ['objective', 'none'],
  description: '新顶层选择必须声明：objective为有私有答案键的客观题，none为无确定性评分的策略选择；旧存储和题组子项可省略。',
};
const orderPolicySchema = objectSchema({
  mode: { type: 'string', enum: ['shuffle', 'preserve'] },
  reason: { type: 'string', enum: ['true-false', 'strategy-choice', 'position-dependent', 'ordered-scale', 'ordered-instruction'] },
}, ['mode']);

export const SCENE_INTERACTION_COMPONENT_V2_DEFINITIONS: readonly SceneInteractionComponentV2Definition[] = [
  define('text', {
    scopes: ['top-level'], fallbackCapability: 'text',
    directiveSchema: objectSchema({
      ...baseDirectiveProperties('text'), placeholder: stringSchema(), minLength: integerSchema(), maxLength: integerSchema(),
    }, ['id', 'type', 'required']),
    responseSchema: objectSchema({ ...baseResponseProperties('text'), value: stringSchema('用户自由回答') }, ['interactionId', 'type', 'value']),
    evaluation: { mode: 'llm-next-turn', answerVisibility: 'not-in-directive', feedbackTiming: 'next-turn' },
  }),
  define('single-choice', {
    scopes: ['top-level', 'question-set-item'], fallbackCapability: 'text',
    preparation: { randomization: 'objective-options', preservesStableIds: true },
    directiveSchema: objectSchema({
      ...baseDirectiveProperties('single-choice'), options: arraySchema(optionSchema, { minItems: 2, maxItems: 50 }), allowExplanation: booleanSchema(), assessment: assessmentSchema, orderPolicy: orderPolicySchema,
    }, ['id', 'type', 'required', 'options']),
    responseSchema: objectSchema({ ...baseResponseProperties('single-choice'), selectedId: stringSchema(), explanation }, ['interactionId', 'type', 'selectedId']),
    evaluation: { mode: 'llm-next-turn', answerVisibility: 'not-in-directive', feedbackTiming: 'next-turn' },
  }),
  define('multiple-choice', {
    scopes: ['top-level', 'question-set-item'], fallbackCapability: 'text',
    preparation: { randomization: 'objective-options', preservesStableIds: true },
    directiveSchema: objectSchema({
      ...baseDirectiveProperties('multiple-choice'), options: arraySchema(optionSchema, { minItems: 2, maxItems: 50 }),
      minSelections: integerSchema(), maxSelections: integerSchema(), allowExplanation: booleanSchema(), assessment: assessmentSchema, orderPolicy: orderPolicySchema,
    }, ['id', 'type', 'required', 'options']),
    responseSchema: objectSchema({
      ...baseResponseProperties('multiple-choice'), selectedIds: arraySchema(stringSchema(), { minItems: 0, maxItems: 50 }), explanation,
    }, ['interactionId', 'type', 'selectedIds']),
    evaluation: { mode: 'llm-next-turn', answerVisibility: 'not-in-directive', feedbackTiming: 'next-turn' },
  }),
  define('ordering', {
    scopes: ['top-level'], fallbackCapability: 'text',
    preparation: { randomization: 'ordering-items', preservesStableIds: true },
    directiveSchema: objectSchema({
      ...baseDirectiveProperties('ordering'),
      items: arraySchema(objectSchema({ id: stringSchema(), content: stringSchema() }, ['id', 'content']), { minItems: 2, maxItems: 50 }),
      allowExplanation: booleanSchema(), orderPolicy: orderPolicySchema, assessment: assessmentSchema,
    }, ['id', 'type', 'required', 'items']),
    responseSchema: objectSchema({
      ...baseResponseProperties('ordering'), orderedIds: arraySchema(stringSchema(), { minItems: 2, maxItems: 50 }), explanation,
    }, ['interactionId', 'type', 'orderedIds']),
    evaluation: { mode: 'llm-next-turn', answerVisibility: 'not-in-directive', feedbackTiming: 'next-turn' },
  }),
  define('fill-blanks', {
    scopes: ['top-level'], fallbackCapability: 'text',
    directiveSchema: objectSchema({
      ...baseDirectiveProperties('fill-blanks'),
      blanks: arraySchema(objectSchema({ id: stringSchema(), label: stringSchema(), placeholder: stringSchema() }, ['id']), { minItems: 1, maxItems: 30 }),
      allowExplanation: booleanSchema(),
    }, ['id', 'type', 'required', 'blanks']),
    responseSchema: objectSchema({
      ...baseResponseProperties('fill-blanks'),
      values: { type: 'object', description: '以 blank.id 为键的文本答案', additionalProperties: true }, explanation,
    }, ['interactionId', 'type', 'values']),
    evaluation: { mode: 'llm-next-turn', answerVisibility: 'not-in-directive', feedbackTiming: 'next-turn' },
  }),
  define('true-false', {
    scopes: ['question-set-item'],
    preparation: { randomization: 'preserve', preservesStableIds: true },
    directiveSchema: objectSchema({
      ...baseDirectiveProperties('true-false'), content: stringSchema('完整判断题干'), trueLabel: stringSchema(), falseLabel: stringSchema(),
    }, ['id', 'type', 'content', 'required']),
    responseSchema: objectSchema({ itemId: stringSchema(), type: typed('true-false'), value: booleanSchema() }, ['itemId', 'type', 'value']),
    evaluation: { mode: 'llm-next-turn', answerVisibility: 'not-in-directive', feedbackTiming: 'after-submit' },
  }),
  define('question-set', {
    scopes: ['top-level'],
    preparation: { randomization: 'registered-children', preservesStableIds: true },
    directiveSchema: objectSchema({
      ...baseDirectiveProperties('question-set'), title: stringSchema(), description: stringSchema(),
      submissionMode: { type: 'string', const: 'batch' }, feedbackMode: { type: 'string', const: 'after-submit' },
      items: arraySchema({ type: 'object', description: '由允许的子组件 Schema 校验', additionalProperties: true }, { minItems: 2, maxItems: 12 }),
    }, ['id', 'type', 'required', 'submissionMode', 'feedbackMode', 'items']),
    responseSchema: objectSchema({
      ...baseResponseProperties('question-set'),
      answers: arraySchema({ type: 'object', description: '与 item.id 和 item.type 对应的答案', additionalProperties: true }, { minItems: 1, maxItems: 12 }),
    }, ['interactionId', 'type', 'answers']),
    evaluation: { mode: 'llm-next-turn', answerVisibility: 'not-in-directive', feedbackTiming: 'after-submit' },
    composition: { allowedChildren: ['single-choice', 'multiple-choice', 'true-false'], minItems: 2, maxItems: 12 },
  }),
];

const COMPONENT_BY_ID = new Map(SCENE_INTERACTION_COMPONENT_V2_DEFINITIONS.map((item) => [item.capabilityId, item]));

export function getSceneInteractionComponentV2(
  capabilityId: SceneInteractionComponentType,
  scope?: SceneInteractionComponentScope,
): SceneInteractionComponentV2Definition | undefined {
  const component = COMPONENT_BY_ID.get(capabilityId);
  return component && (!scope || component.scopes.includes(scope)) ? component : undefined;
}

export function listSceneInteractionComponentsV2(scope?: SceneInteractionComponentScope): SceneInteractionComponentV2Definition[] {
  return SCENE_INTERACTION_COMPONENT_V2_DEFINITIONS.filter((item) => !scope || item.scopes.includes(scope));
}

export function validateSceneInteractionComponentV2Registry(): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const component of SCENE_INTERACTION_COMPONENT_V2_DEFINITIONS) {
    if (ids.has(component.capabilityId)) errors.push(`重复组件：${component.capabilityId}`);
    ids.add(component.capabilityId);
    if (!component.rendererId) errors.push(`${component.capabilityId} 缺少 rendererId`);
    if (!component.validatorId) errors.push(`${component.capabilityId} 缺少 validatorId`);
    if (component.directiveSchema.additionalProperties !== false) errors.push(`${component.capabilityId} directive 必须关闭额外字段`);
    if (component.evaluation.answerVisibility !== 'not-in-directive') errors.push(`${component.capabilityId} 不得在 directive 暴露答案`);
    for (const child of component.composition?.allowedChildren || []) {
      if (!COMPONENT_BY_ID.has(child)) errors.push(`${component.capabilityId} 引用了未注册子组件 ${child}`);
    }
  }
  return errors;
}

export function buildSceneInteractionComponentV2Prompt(): string {
  const lines = listSceneInteractionComponentsV2().map((component) => {
    const scopes = component.scopes.includes('top-level') ? '顶层' : '仅子项';
    const children = component.composition
      ? `；子组件 ${component.composition.allowedChildren.join('、')}，数量 ${component.composition.minItems}-${component.composition.maxItems}`
      : '';
    const preparation = component.preparation ? `；本地一次性准备 ${component.preparation.randomization}，稳定 id 不变` : '';
    return `- ${component.capabilityId}（${component.label}，${scopes}）：${component.purpose}${children}${preparation}`;
  });
  return [
    `协议版本：${SCENE_INTERACTION_COMPONENT_PROTOCOL_VERSION}`,
    ...lines,
    '- directive 只包含展示和作答约束；禁止放入正确答案、评分规则、隐藏提示或模型内部控制字段。',
    '- 用户响应必须符合对应 responseSchema；组件类型和 interactionId 必须与 directive 一致。',
    '- 客观选择选项及排序初始项由本地组件一次性洗牌并随任务保存，无需模型随机；答案必须引用稳定 id，不引用原位置字母。判断题、策略选择、位置依赖及有序量表应声明 orderPolicy:{mode:"preserve",reason:"..."}；普通客观选择可省略。',
  ].join('\n');
}
