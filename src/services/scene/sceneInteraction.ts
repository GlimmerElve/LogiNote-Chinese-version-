/**
 * 场景交互能力协议的唯一归一化入口。
 *
 * 协议分三层：
 * 1. SceneBehaviorSpec.interaction：场景级能力白名单；
 * 2. SceneMessage.interaction：AI 在某一回合发出的结构化交互指令；
 * 3. SceneMessage.interactionResponse：用户提交的结构化原始响应。
 *
 * 当前客户端能力由 SceneInteractionComponentV2 注册表统一发布。
 * 后续接入控件时应同时登记 directive/response Schema、渲染器与校验器，
 * 运行时能力集合会从 V2 注册表自动生成。
 */

import type {
  SceneBlankItem,
  SceneInteractionDirective,
  SceneInteractionOption,
  SceneInteractionOrderPolicy,
  SceneInteractionProtocol,
  SceneInteractionResponse,
  SceneInteractionType,
  SceneOrderingItem,
  SceneQuestionSetAnswer,
  SceneQuestionSetEvaluation,
  SceneQuestionSetInteractionDirective,
  SceneQuestionSetItem,
} from '../../types';
import { listSceneInteractionComponentsV2 } from './sceneInteractionComponentV2';

export const SCENE_INTERACTION_PROTOCOL_VERSION = '1.0' as const;

/** 协议认识的全部类型；不代表客户端当前已经实现。 */
export const SCENE_INTERACTION_TYPES: readonly SceneInteractionType[] = listSceneInteractionComponentsV2('top-level')
  .map((component) => component.capabilityId as SceneInteractionType);

/** 当前真正可执行的前端能力。接入控件时在这里逐项启用。 */
export const SCENE_RUNTIME_INTERACTION_TYPES: readonly SceneInteractionType[] = SCENE_INTERACTION_TYPES;

const INTERACTION_TYPE_SET = new Set<SceneInteractionType>(SCENE_INTERACTION_TYPES);

export function createTextInteractionProtocol(): SceneInteractionProtocol {
  return {
    version: SCENE_INTERACTION_PROTOCOL_VERSION,
    allowedTypes: ['text'],
    defaultType: 'text',
    allowTextFallback: true,
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalText(value: unknown): string | undefined {
  const result = text(value);
  return result || undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}

/** Invalid policies are rejected rather than silently losing a semantic preserve-order request. */
function normalizeOrderPolicy(value: unknown): SceneInteractionOrderPolicy | undefined {
  if (value === undefined) return undefined;
  const raw = asRecord(value);
  if (!raw || !['shuffle', 'preserve'].includes(String(raw.mode)) || typeof raw.mode !== 'string') return undefined;
  const reasons = ['true-false', 'strategy-choice', 'position-dependent', 'ordered-scale', 'ordered-instruction'];
  if (raw.reason !== undefined && (typeof raw.reason !== 'string' || !reasons.includes(raw.reason))) return undefined;
  return { mode: raw.mode as SceneInteractionOrderPolicy['mode'], ...(raw.reason === undefined ? {} : { reason: raw.reason as SceneInteractionOrderPolicy['reason'] }) };
}

function isInteractionType(value: unknown): value is SceneInteractionType {
  return typeof value === 'string' && INTERACTION_TYPE_SET.has(value as SceneInteractionType);
}

/**
 * 将场景声明与客户端能力取交集。无声明、非法声明或交集为空时安全降级为 text。
 */
export function normalizeSceneInteractionProtocol(
  value: unknown,
  availableTypes: readonly SceneInteractionType[] = SCENE_INTERACTION_TYPES,
): SceneInteractionProtocol {
  const available = new Set(availableTypes.filter(isInteractionType));
  if (available.size === 0) available.add('text');

  const raw = asRecord(value);
  const declaredValues = Array.isArray(raw?.allowedTypes) ? raw.allowedTypes : [];
  const declared = declaredValues.filter(isInteractionType);
  const allowedTypes = [...new Set(declared)].filter((type) => available.has(type));

  // 历史场景没有协议；新场景声明了未安装的控件时也必须保持可运行。
  if (allowedTypes.length === 0) {
    const fallback = available.has('text') ? 'text' : [...available][0];
    allowedTypes.push(fallback);
  }

  const degradedToText = declaredValues.length > 0
    && !declared.some((type) => available.has(type));
  const allowTextFallback = degradedToText || raw?.allowTextFallback !== false;
  if (allowTextFallback && available.has('text') && !allowedTypes.includes('text')) {
    allowedTypes.push('text');
  }
  const requestedDefault = raw?.defaultType;
  const defaultType = isInteractionType(requestedDefault) && allowedTypes.includes(requestedDefault)
    ? requestedDefault
    : allowedTypes[0];

  return {
    version: SCENE_INTERACTION_PROTOCOL_VERSION,
    allowedTypes,
    defaultType,
    allowTextFallback,
  };
}

/**
 * 在不改写场景原始声明的前提下，计算本客户端真正可执行的协议。
 * 生成提示与前端渲染必须使用本函数，持久化则保留 normalize 后的原始声明。
 */
export function resolveSceneRuntimeInteractionProtocol(value: unknown): SceneInteractionProtocol {
  return normalizeSceneInteractionProtocol(value, SCENE_RUNTIME_INTERACTION_TYPES);
}

function normalizeOptions(value: unknown): SceneInteractionOption[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: SceneInteractionOption[] = [];
  for (const item of value.slice(0, 50)) {
    const raw = asRecord(item);
    const id = text(raw?.id);
    const label = text(raw?.label);
    if (!id || !label || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, label, description: optionalText(raw?.description) });
  }
  return result;
}

function normalizeOrderingItems(value: unknown): SceneOrderingItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: SceneOrderingItem[] = [];
  for (const item of value.slice(0, 50)) {
    const raw = asRecord(item);
    const id = text(raw?.id);
    const content = text(raw?.content);
    if (!id || !content || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, content });
  }
  return result;
}

function normalizeBlanks(value: unknown): SceneBlankItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: SceneBlankItem[] = [];
  for (const item of value.slice(0, 30)) {
    const raw = asRecord(item);
    const id = text(raw?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, label: optionalText(raw?.label), placeholder: optionalText(raw?.placeholder) });
  }
  return result;
}

function normalizeQuestionSetItems(value: unknown): SceneQuestionSetItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: SceneQuestionSetItem[] = [];
  for (const item of value.slice(0, 12)) {
    const raw = asRecord(item);
    const id = text(raw?.id);
    const type = raw?.type;
    const content = text(raw?.content);
    if (!id || !content || seen.has(id)) continue;
    if (type === 'true-false') {
      seen.add(id);
      result.push({
        id,
        type,
        content,
        required: raw?.required !== false,
        trueLabel: optionalText(raw?.trueLabel),
        falseLabel: optionalText(raw?.falseLabel),
      });
      continue;
    }
    if (type !== 'single-choice' && type !== 'multiple-choice') continue;
    const orderPolicy = normalizeOrderPolicy(raw?.orderPolicy);
    if (raw?.orderPolicy !== undefined && !orderPolicy) continue;
    const options = normalizeOptions(raw?.options);
    if (options.length < 2) continue;
    seen.add(id);
    if (type === 'single-choice') {
      result.push({ id, type, content, required: raw?.required !== false, options, ...(orderPolicy ? { orderPolicy } : {}) });
      continue;
    }
    const minSelections = positiveInteger(raw?.minSelections);
    const requestedMax = positiveInteger(raw?.maxSelections);
    const maxSelections = Math.min(requestedMax || options.length, options.length);
    if (minSelections && minSelections > maxSelections) {
      seen.delete(id);
      continue;
    }
    result.push({
      id,
      type,
      content,
      required: raw?.required !== false,
      options,
      ...(orderPolicy ? { orderPolicy } : {}),
      minSelections,
      maxSelections,
    });
  }
  return result;
}

/** 不信任 LLM 输出：字段不完整或不在场景白名单中时返回 undefined。 */
export function normalizeSceneInteractionDirective(
  value: unknown,
  protocol: SceneInteractionProtocol,
): SceneInteractionDirective | undefined {
  const raw = asRecord(value);
  const id = text(raw?.id);
  const type = raw?.type;
  if (!id || !isInteractionType(type) || !protocol.allowedTypes.includes(type)) return undefined;

  const base = {
    id,
    instruction: optionalText(raw?.instruction),
    required: raw?.required !== false,
  };

  if (type === 'text') {
    const minLength = positiveInteger(raw?.minLength);
    const maxLength = positiveInteger(raw?.maxLength);
    return {
      ...base,
      type,
      placeholder: optionalText(raw?.placeholder),
      minLength,
      maxLength: maxLength && (!minLength || maxLength >= minLength) ? maxLength : undefined,
    };
  }

  if (type === 'single-choice' || type === 'multiple-choice') {
    const orderPolicy = normalizeOrderPolicy(raw?.orderPolicy);
    if (raw?.orderPolicy !== undefined && !orderPolicy) return undefined;
    const assessment = raw?.assessment === 'objective' ? 'objective' as const : raw?.assessment === 'none' ? 'none' as const : undefined;
    if (raw?.assessment !== undefined && assessment === undefined) return undefined;
    const options = normalizeOptions(raw?.options);
    if (options.length < 2) return undefined;
    if (type === 'single-choice') {
      return { ...base, type, options, ...(assessment === undefined ? {} : { assessment }), ...(orderPolicy ? { orderPolicy } : {}), allowExplanation: raw?.allowExplanation === true };
    }
    const minSelections = positiveInteger(raw?.minSelections);
    const requestedMax = positiveInteger(raw?.maxSelections);
    const maxSelections = Math.min(requestedMax || options.length, options.length);
    if (minSelections && minSelections > maxSelections) return undefined;
    return {
      ...base,
      type,
      options,
      ...(assessment === undefined ? {} : { assessment }),
      ...(orderPolicy ? { orderPolicy } : {}),
      minSelections,
      maxSelections,
      allowExplanation: raw?.allowExplanation === true,
    };
  }

  if (type === 'ordering') {
    const assessment = raw?.assessment === 'objective' ? 'objective' as const : raw?.assessment === 'none' ? 'none' as const : undefined;
    if (raw?.assessment !== undefined && assessment === undefined) return undefined;
    const orderPolicy = normalizeOrderPolicy(raw?.orderPolicy);
    if (raw?.orderPolicy !== undefined && !orderPolicy) return undefined;
    const items = normalizeOrderingItems(raw?.items);
    if (items.length < 2) return undefined;
    return { ...base, type, items, ...(assessment === undefined ? {} : { assessment }), ...(orderPolicy ? { orderPolicy } : {}), allowExplanation: raw?.allowExplanation === true };
  }

  if (type === 'question-set') {
    const items = normalizeQuestionSetItems(raw?.items);
    if (items.length < 2) return undefined;
    return {
      ...base,
      type,
      title: optionalText(raw?.title),
      description: optionalText(raw?.description),
      submissionMode: 'batch',
      feedbackMode: 'after-submit',
      items,
    };
  }

  const blanks = normalizeBlanks(raw?.blanks);
  if (blanks.length === 0) return undefined;
  return { ...base, type: 'fill-blanks', blanks, allowExplanation: raw?.allowExplanation === true };
}

/**
 * 校验模型返回的题组私有答案。答案与展示 directive 分离，避免正确项进入组件属性。
 */
export function normalizeQuestionSetEvaluation(
  value: unknown,
  directive: SceneInteractionDirective | undefined,
): SceneQuestionSetEvaluation | undefined {
  if (!directive || directive.type !== 'question-set') return undefined;
  const raw = asRecord(value);
  if (!raw || raw.type !== 'question-set' || text(raw.interactionId) !== directive.id || !Array.isArray(raw.items)) {
    return undefined;
  }
  if (raw.items.length !== directive.items.length) return undefined;
  const byItemId = new Map<string, Record<string, unknown>>();
  for (const valueItem of raw.items) {
    const item = asRecord(valueItem);
    const itemId = text(item?.itemId);
    if (!item || !itemId || byItemId.has(itemId)) return undefined;
    byItemId.set(itemId, item);
  }
  const items: SceneQuestionSetEvaluation['items'] = [];
  for (const question of directive.items) {
    const answer = byItemId.get(question.id);
    if (!answer || answer.type !== question.type) return undefined;
    const explanation = optionalText(answer.explanation);
    if (question.type === 'true-false') {
      if (typeof answer.correctValue !== 'boolean') return undefined;
      items.push({ itemId: question.id, type: question.type, correctValue: answer.correctValue, explanation });
      continue;
    }
    const validIds = new Set(question.options.map((option) => option.id));
    if (question.type === 'single-choice') {
      const correctId = text(answer.correctId);
      if (!validIds.has(correctId)) return undefined;
      items.push({ itemId: question.id, type: question.type, correctId, explanation });
      continue;
    }
    const correctIds = uniqueStrings(answer.correctIds);
    if (!Array.isArray(answer.correctIds) || answer.correctIds.length !== correctIds.length
      || correctIds.length < (question.minSelections || 1)
      || correctIds.length > (question.maxSelections || question.options.length)
      || correctIds.some((id) => !validIds.has(id))) return undefined;
    items.push({ itemId: question.id, type: question.type, correctIds, explanation });
  }
  return { interactionId: directive.id, type: 'question-set', items };
}

/** 系统侧确定性核对题组答案，结果供下一轮 LLM 组织反馈。 */
export function gradeQuestionSetResponse(
  response: SceneInteractionResponse,
  evaluation: SceneQuestionSetEvaluation | undefined,
): { correct: number; total: number; incorrectItemIds: string[] } | undefined {
  if (response.type !== 'question-set' || !evaluation || response.interactionId !== evaluation.interactionId) return undefined;
  const submitted = new Map(response.answers.map((answer) => [answer.itemId, answer]));
  const incorrectItemIds: string[] = [];
  let correct = 0;
  for (const expected of evaluation.items) {
    const actual = submitted.get(expected.itemId);
    let matched = false;
    if (actual && actual.type === expected.type) {
      if (expected.type === 'true-false' && actual.type === 'true-false') {
        matched = actual.value === expected.correctValue;
      } else if (expected.type === 'single-choice' && actual.type === 'single-choice') {
        matched = actual.selectedId === expected.correctId;
      } else if (expected.type === 'multiple-choice' && actual.type === 'multiple-choice') {
        const left = [...new Set(actual.selectedIds)].sort();
        const right = [...new Set(expected.correctIds)].sort();
        matched = left.length === right.length && left.every((id, index) => id === right[index]);
      }
    }
    if (matched) correct += 1;
    else incorrectItemIds.push(expected.itemId);
  }
  return { correct, total: evaluation.items.length, incorrectItemIds };
}

/**
 * 本地直接生成整卷评分结果。这条路径不调用 LLM，也不注入角色、
 * 动作、指标或突发事件，避免把客观答案核对变成另一段场景推演。
 */
export function formatQuestionSetGradeFeedback(
  directive: SceneQuestionSetInteractionDirective,
  response: SceneInteractionResponse,
  evaluation: SceneQuestionSetEvaluation | undefined,
): { content: string; correct: number; total: number } | undefined {
  const grade = gradeQuestionSetResponse(response, evaluation);
  if (!grade || response.type !== 'question-set' || !evaluation) return undefined;
  const submitted = new Map(response.answers.map((answer) => [answer.itemId, answer]));
  const expected = new Map(evaluation.items.map((item) => [item.itemId, item]));
  const lines = directive.items.map((question, index) => {
    const answer = submitted.get(question.id);
    const key = expected.get(question.id);
    const correct = !grade.incorrectItemIds.includes(question.id);
    let expectedText = '';
    if (key?.type === 'true-false') expectedText = key.correctValue ? (question.type === 'true-false' ? question.trueLabel || '正确' : '正确') : (question.type === 'true-false' ? question.falseLabel || '错误' : '错误');
    if (key?.type === 'single-choice' && question.type === 'single-choice') {
      expectedText = question.options.find((option) => option.id === key.correctId)?.label || key.correctId;
    }
    if (key?.type === 'multiple-choice' && question.type === 'multiple-choice') {
      expectedText = key.correctIds.map((id) => question.options.find((option) => option.id === id)?.label || id).join('、');
    }
    const explanation = key?.explanation ? `；${key.explanation}` : '';
    const unanswered = !answer ? '（未作答）' : '';
    return `${index + 1}. ${correct ? '✓' : '✗'} ${question.content}${unanswered}${correct ? '' : `；正确答案：${expectedText || '见解析'}`}${explanation}`;
  });
  return {
    content: [`## 评卷结果`, `得分：${grade.correct} / ${grade.total}`, '', ...lines].join('\n'),
    correct: grade.correct,
    total: grade.total,
  };
}

function uniqueStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(text).filter(Boolean))];
}

/** 按当前回合指令校验用户响应，防止类型错配、伪造选项或残缺排序进入运行态。 */
export function normalizeSceneInteractionResponse(
  value: unknown,
  directive: SceneInteractionDirective,
): SceneInteractionResponse | undefined {
  const raw = asRecord(value);
  if (!raw || text(raw.interactionId) !== directive.id || raw.type !== directive.type) return undefined;
  const submittedAt = text(raw.submittedAt) || new Date().toISOString();
  const explanation = optionalText(raw.explanation);

  if (directive.type === 'text') {
    const answer = text(raw.value);
    if (directive.required && !answer) return undefined;
    if (directive.minLength && answer.length < directive.minLength) return undefined;
    if (directive.maxLength && answer.length > directive.maxLength) return undefined;
    return { interactionId: directive.id, type: 'text', value: answer, submittedAt };
  }

  if (directive.type === 'single-choice') {
    const selectedId = text(raw.selectedId);
    if (!directive.options.some((option) => option.id === selectedId)) return undefined;
    return { interactionId: directive.id, type: 'single-choice', selectedId, explanation, submittedAt };
  }

  if (directive.type === 'multiple-choice') {
    const selectedIds = uniqueStrings(raw.selectedIds);
    const validIds = new Set(directive.options.map((option) => option.id));
    if (selectedIds.some((id) => !validIds.has(id))) return undefined;
    if (directive.required && selectedIds.length === 0) return undefined;
    if (directive.minSelections && selectedIds.length < directive.minSelections) return undefined;
    if (directive.maxSelections && selectedIds.length > directive.maxSelections) return undefined;
    return { interactionId: directive.id, type: 'multiple-choice', selectedIds, explanation, submittedAt };
  }

  if (directive.type === 'ordering') {
    const orderedIds = uniqueStrings(raw.orderedIds);
    const expectedIds = directive.items.map((item) => item.id);
    if (orderedIds.length !== expectedIds.length || expectedIds.some((id) => !orderedIds.includes(id))) return undefined;
    return { interactionId: directive.id, type: 'ordering', orderedIds, explanation, submittedAt };
  }

  if (directive.type === 'question-set') {
    if (!Array.isArray(raw.answers)) return undefined;
    const rawAnswers = new Map<string, Record<string, unknown>>();
    for (const value of raw.answers) {
      const answer = asRecord(value);
      const itemId = text(answer?.itemId);
      if (!answer || !itemId || rawAnswers.has(itemId)) return undefined;
      rawAnswers.set(itemId, answer);
    }
    if ([...rawAnswers.keys()].some((itemId) => !directive.items.some((item) => item.id === itemId))) {
      return undefined;
    }

    const answers: SceneQuestionSetAnswer[] = [];
    for (const item of directive.items) {
      const answer = rawAnswers.get(item.id);
      if (!answer) {
        if (item.required) return undefined;
        continue;
      }
      if (answer.type !== item.type) return undefined;
      if (item.type === 'true-false') {
        if (typeof answer.value !== 'boolean') return undefined;
        answers.push({ itemId: item.id, type: item.type, value: answer.value });
        continue;
      }
      const validIds = new Set(item.options.map((option) => option.id));
      if (item.type === 'single-choice') {
        const selectedId = text(answer.selectedId);
        if (!validIds.has(selectedId)) return undefined;
        answers.push({ itemId: item.id, type: item.type, selectedId });
        continue;
      }
      const selectedIds = uniqueStrings(answer.selectedIds);
      if (selectedIds.some((id) => !validIds.has(id))) return undefined;
      const minimum = item.minSelections || (item.required ? 1 : 0);
      const maximum = item.maxSelections || item.options.length;
      if (selectedIds.length < minimum || selectedIds.length > maximum) return undefined;
      answers.push({ itemId: item.id, type: item.type, selectedIds });
    }
    return { interactionId: directive.id, type: 'question-set', answers, submittedAt };
  }

  const rawValues = asRecord(raw.values);
  if (!rawValues) return undefined;
  const values: Record<string, string> = {};
  for (const blank of directive.blanks) {
    const answer = text(rawValues[blank.id]);
    if (directive.required && !answer) return undefined;
    values[blank.id] = answer;
  }
  return { interactionId: directive.id, type: 'fill-blanks', values, explanation, submittedAt };
}

/**
 * 将已校验的结构化响应转成可读摘要，供聊天记录、LLM 历史和旧版导出继续使用。
 * 原始结构仍保存在 SceneMessage.interactionResponse，摘要不是判定依据。
 */
export function formatSceneInteractionResponseContent(
  response: SceneInteractionResponse,
  directive: SceneInteractionDirective,
): string {
  if (response.type !== directive.type || response.interactionId !== directive.id) return '';
  if (response.type === 'text' && directive.type === 'text') return response.value;

  if (response.type === 'single-choice' && directive.type === 'single-choice') {
    const option = directive.options.find((item) => item.id === response.selectedId);
    return [`选择：${option?.label || response.selectedId}`, response.explanation ? `说明：${response.explanation}` : '']
      .filter(Boolean).join('\n');
  }

  if (response.type === 'multiple-choice' && directive.type === 'multiple-choice') {
    const labels = response.selectedIds.map((id) => directive.options.find((item) => item.id === id)?.label || id);
    return [`选择：${labels.join('、')}`, response.explanation ? `说明：${response.explanation}` : '']
      .filter(Boolean).join('\n');
  }

  if (response.type === 'ordering' && directive.type === 'ordering') {
    const labels = response.orderedIds.map((id) => directive.items.find((item) => item.id === id)?.content || id);
    return [`排序：${labels.map((label, index) => `${index + 1}. ${label}`).join('；')}`, response.explanation ? `说明：${response.explanation}` : '']
      .filter(Boolean).join('\n');
  }

  if (response.type === 'fill-blanks' && directive.type === 'fill-blanks') {
    const answers = directive.blanks.map((blank, index) => `${blank.label || `空${index + 1}`}：${response.values[blank.id] || ''}`);
    return [answers.join('；'), response.explanation ? `说明：${response.explanation}` : '']
      .filter(Boolean).join('\n');
  }

  if (response.type === 'question-set' && directive.type === 'question-set') {
    const lines = response.answers.map((answer, index) => {
      const item = directive.items.find((candidate) => candidate.id === answer.itemId);
      if (!item) return `${index + 1}. 未知题目`;
      if (answer.type === 'true-false' && item.type === 'true-false') {
        return `${index + 1}. ${answer.value ? (item.trueLabel || '对') : (item.falseLabel || '错')}`;
      }
      if (answer.type === 'single-choice' && item.type === 'single-choice') {
        const option = item.options.find((candidate) => candidate.id === answer.selectedId);
        return `${index + 1}. ${option?.label || answer.selectedId}`;
      }
      if (answer.type === 'multiple-choice' && item.type === 'multiple-choice') {
        const labels = answer.selectedIds.map((id) => item.options.find((candidate) => candidate.id === id)?.label || id);
        return `${index + 1}. ${labels.join('、')}`;
      }
      return `${index + 1}. 答案类型不匹配`;
    });
    return [`整卷作答（${response.answers.length} 题）`, ...lines].join('\n');
  }

  return '';
}
