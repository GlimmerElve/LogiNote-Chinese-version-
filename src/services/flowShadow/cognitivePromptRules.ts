import type { ShadowBehaviorCode } from './types';

/** Model-facing semantic criteria only. Not local classifiers, scores, or changes to profile axes. */
export const SHADOW_COGNITIVE_RULES: readonly {
  code: ShadowBehaviorCode; opportunity: string; negative: string; positive: string; exclude: string;
}[] = [
  { code: 'abstract_concrete', opportunity: '用户怎样组织同一解释',
    negative: '以具体对象、情景、操作或个别经验承载解释',
    positive: '以跨实例的概念、共同关系或一般规则承载解释',
    exclude: '术语出现不等于抽象，出现例子不等于偏具象；概念与实例相互说明可以互补均衡，不是冲突' },
  { code: 'structured_connections', opportunity: '原话中多个信息如何关联',
    negative: '同一解释反复跳转且缺少理解所需的关联',
    positive: '明确用层级、因果、比较或条件关系组织多个信息',
    exclude: '分段、编号、先后词本身不证明系统；图漏边不证明用户零散；单一信息不足以判方向' },
  { code: 'explore_converge', opportunity: '用户怎样处理解释或行动选项',
    negative: '依据证据筛选、排除选项，收束到有限结论或行动',
    positive: '主动提出不同解释、条件或路径并比较、试探',
    exclude: '话多不等于发散，结束发言不等于收敛，“可能”不等于探索；探索后收束可互补，不是自动mixed' },
  { code: 'uncertainty_calibration', opportunity: '表达强度是否随已知依据或条件调整',
    negative: '原话已显露证据不足或反例，仍作无条件确定断言或过度推广',
    positive: '说明证据/条件怎样限制结论，或据此撤回、修订过强说法',
    exclude: '肯定句不自动武断，“可能”口头禅不自动谨慎；明确自纠须分别引用原断言、撤回和替代内容' },
  { code: 'assumption_inspection', opportunity: '存在解释原因、机制或检验前提的任务/表达机会',
    negative: '已有解释机会却只用现象复述或标签代替所需原因',
    positive: '展开机制、中间因果步骤，或检查前提、替代原因与证据',
    exclude: '短句不等于表面，“因为/机制”字样不等于深度；任务仅要求描述且无深入机会时不判负极' },
];
