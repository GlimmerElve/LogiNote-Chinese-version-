import type { MasteryShadowLayer } from './types';

export const MASTERY_SHADOW_CRITERIA = [
  {
    id: 'concept_accuracy',
    layer: 'concept',
    label: '概念含义',
    retrievalFocus: '概念含义 定义 核心特征',
    question: '回答对核心概念的含义是否与参考资料语义一致？',
    referenceRequired: true,
  },
  {
    id: 'concept_boundary',
    layer: 'concept',
    label: '概念边界',
    retrievalFocus: '适用范围 边界 例外 易混概念 不能仅凭',
    question: '回答是否正确处理题目要求的适用范围、反例或易混概念？',
    referenceRequired: true,
  },
  {
    id: 'concept_application',
    layer: 'concept',
    label: '概念应用',
    retrievalFocus: '应用 实例 操作 如何识别',
    question: '回答中的实例或操作是否真正符合该概念？',
    referenceRequired: true,
  },
  {
    id: 'judgment_accuracy',
    layer: 'judgment',
    label: '判断正确性',
    retrievalFocus: '判断结论 正确 错误 证据能否证明',
    question: '回答的具体事实或结论是否有相应资料支持？仅遵循观点归属或表达规范，不等于结论真伪已经核验。',
    referenceRequired: true,
  },
  {
    id: 'judgment_conditions',
    layer: 'judgment',
    label: '条件与程度',
    retrievalFocus: '结论成立条件 对象范围 程度 限制',
    question: '回答是否保留了使结论成立所必需的条件、程度和对象范围？',
    referenceRequired: true,
  },
  {
    id: 'judgment_attribution',
    layer: 'judgment',
    label: '判断归属',
    retrievalFocus: '事实 假设 教材观点 自己推论 归属',
    question: '回答是否区分了事实、假设、他人观点和自己的结论？',
    referenceRequired: false,
  },
  {
    id: 'reasoning_relevance',
    layer: 'reasoning',
    label: '依据相关性',
    retrievalFocus: '依据与结论 因果机制 中间联系',
    question: '给出的依据是否真正指向结论，而不只是同主题？',
    referenceRequired: false,
  },
  {
    id: 'reasoning_sufficiency',
    layer: 'reasoning',
    label: '依据充分性',
    retrievalFocus: '证据充分性 关键前提 联合条件 样本代表性 反例',
    question: '相对于参考资料和任务要求，是否遗漏了关键前提或联合条件？',
    referenceRequired: true,
  },
  {
    id: 'reasoning_consistency',
    layer: 'reasoning',
    label: '推理一致性',
    retrievalFocus: '推导步骤 循环论证 矛盾 一致性',
    question: '推导中是否存在同范围矛盾、循环或无法推出的步骤？',
    referenceRequired: false,
  },
] as const satisfies ReadonlyArray<{
  id: string;
  layer: MasteryShadowLayer;
  label: string;
  retrievalFocus: string;
  question: string;
  referenceRequired: boolean;
}>;

export type MasteryShadowCriterionId = (typeof MASTERY_SHADOW_CRITERIA)[number]['id'];

export function masteryShadowCriterion(id: string) {
  return MASTERY_SHADOW_CRITERIA.find((criterion) => criterion.id === id);
}
