import type { ShadowBehaviorCode, ShadowCriterionId, ShadowLayer } from './types.ts';
export const SHADOW_CRITERIA: ReadonlyArray<{ id: ShadowCriterionId; layer: ShadowLayer; label: string; question: string }> = [
  { id: 'concept_clarity', layer: 'concept', label: '对象与含义', question: '关键概念或指代在本任务中是否清楚？准确使用也可作证，不要求定义配额。' },
  { id: 'concept_consistency', layer: 'concept', label: '一致与区分', question: '前后含义是否一致，确实影响理解的边界或相近概念是否区分？' },
  { id: 'concept_application', layer: 'concept', label: '概念运用', question: '解释、例子或应用是否与已表达的概念一致？无参考资料不判外部定义真伪。' },
  { id: 'judgment_clarity', layer: 'judgment', label: '判断明确', question: '判断对象、内容、程度和适用范围是否明确？' },
  { id: 'judgment_attribution', layer: 'judgment', label: '性质与归属', question: '观察、假设、价值判断与他人观点是否被正确区分？' },
  { id: 'judgment_calibration', layer: 'judgment', label: '强度与条件', question: '结论强度是否超过已给依据？仅在条件确实影响成立时评价条件。' },
  { id: 'reasoning_relevance', layer: 'reasoning', label: '依据相关', question: '用户实际给出的依据是否与主张相关，而非仅同主题或相邻？' },
  { id: 'reasoning_sufficiency', layer: 'reasoning', label: '推导充分', question: '按演绎、经验或价值任务检查关键前提和联合依据，是否有可证实的跳步？' },
  { id: 'reasoning_consistency', layer: 'reasoning', label: '一致与检验', question: '有无同范围矛盾、循环或无效推出？只有出现反证或任务要求时才评价反证处理。' },
];
export const SHADOW_BEHAVIORS: ReadonlyArray<{ code: ShadowBehaviorCode; dimension: 'expression' | 'strategy'; label: string }> = [
  { code: 'concept_framing', dimension: 'expression', label: '概念与框架阐释' },
  { code: 'evidence_description', dimension: 'expression', label: '事例与证据说明' },
  { code: 'mechanism_explanation', dimension: 'expression', label: '机制与过程解释' },
  { code: 'comparison_review', dimension: 'expression', label: '比较与评议' },
  { code: 'action_application', dimension: 'expression', label: '行动与应用' },
  { code: 'abstract_concrete', dimension: 'strategy', label: '概括与实例转换' },
  { code: 'structured_connections', dimension: 'strategy', label: '层次与前后衔接' },
  { code: 'explore_converge', dimension: 'strategy', label: '探索与有据收束' },
  { code: 'uncertainty_calibration', dimension: 'strategy', label: '条件与不确定性校准' },
  { code: 'assumption_inspection', dimension: 'strategy', label: '机制与假设检查' },
];
export const SHADOW_LAYER_LABELS: Record<ShadowLayer, string> = { concept: '概念', judgment: '判断', reasoning: '推理' };
