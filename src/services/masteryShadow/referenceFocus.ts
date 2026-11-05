import { MASTERY_SHADOW_CRITERIA, type MasteryShadowCriterionId } from './rubric';

// Retrieval coordinates only. These mechanical cues never grade an answer or supply a baseline.
const FACETS = [
  { key: 'experiment', cue: /对照|两组|分组|控制变量|归因|实验设计/u, terms: '对照实验 分组 控制变量 混杂因素 归因',
    criteria: ['judgment_accuracy', 'judgment_conditions', 'reasoning_sufficiency', 'reasoning_consistency'] },
  { key: 'comparison', cue: /支配|各有取舍|各有优劣|价格|便宜|功能|属性比较/u, terms: '属性比较 支配关系 目标选项 竞争选项',
    criteria: ['concept_application', 'concept_boundary', 'judgment_accuracy'] },
  { key: 'calculation', cue: /计算|算出|百分[点比]|方程|单位|数值/u, terms: '计算 公式 数值 单位 换算',
    criteria: ['concept_application', 'judgment_accuracy', 'reasoning_consistency'] },
  { key: 'proof', cue: /充分必要|充要|数学归纳|反证|证明题/u, terms: '证明 前提 推导步骤 成立条件',
    criteria: ['reasoning_relevance', 'reasoning_sufficiency', 'reasoning_consistency'] },
  { key: 'causal', cue: /因果|导致|机制|中间过程/u, terms: '因果机制 中间过程 前提 结果',
    criteria: ['reasoning_relevance', 'reasoning_sufficiency'] },
] as const;

export function masteryTopicContext(text: string, name: string, otherNames: string[]): string {
  const names = [...new Set([name, ...otherNames].filter(Boolean))];
  let owner = names.length === 1 ? name : '';
  const selected: string[] = [];
  for (const sentence of text.split(/(?<=[。！？!?])\s*|\n+/u)) {
    const mentioned = names.filter(value => sentence.includes(value));
    if (mentioned.length === 1) owner = mentioned[0];
    if (mentioned.includes(name) || mentioned.length === 0 && owner === name) selected.push(sentence);
  }
  return selected.join('\n');
}

export function masteryCriterionQuery(name: string, criterionId: MasteryShadowCriterionId, context: string): string {
  const definition = MASTERY_SHADOW_CRITERIA.find(criterion => criterion.id === criterionId)!;
  const selected = FACETS.filter(facet => (facet.criteria as readonly string[]).includes(criterionId) && facet.cue.test(context)).slice(0, 2);
  // Concrete neutral objects come first. Do not copy the user's asserted result or numerical answer.
  return [name, ...selected.map(facet => facet.terms), definition.retrievalFocus].join(' ');
}
