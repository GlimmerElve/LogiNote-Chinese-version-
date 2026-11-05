import type { ArgumentRelationCase, ArgumentRelationLabel } from '../../src/services/argumentRelation/contract.ts';

function pair(groupId: string, source: string, target: string, forward: ArgumentRelationLabel, backward: ArgumentRelationLabel, reason: string): ArgumentRelationCase[] {
  return [false, true].map((reverse) => ({
    id: `${groupId}-${reverse ? 'r' : 'f'}`, groupId, origin: 'synthetic', annotationStatus: 'assistant_draft',
    phenomenon: reverse ? 'new_direction_reverse' : 'new_direction_forward',
    sentences: [{ id: 'a', text: source }, { id: 'b', text: target }],
    sourceSentenceIds: [reverse ? 'b' : 'a'], targetSentenceIds: [reverse ? 'a' : 'b'],
    expectedLabel: reverse ? backward : forward,
    annotationReason: `${reason} ${reverse ? '检查反方向，不能偷偷交换输入角色。' : '检查给定正方向。'}`,
  }));
}

/** New development challenge, NOT independent held-out data. Freeze before model inference. */
export const ARGUMENT_DIRECTION_CHALLENGE = [
  ...pair('dir-duration', '本次任务原耗时52分钟，改用新流程后耗时31分钟。', '本次任务耗时减少了21分钟。',
    'support', 'insufficient_evidence', '起止测量支持差值；差值不能唯一恢复起止数值。'),
  ...pair('dir-rule', '本活动规则是持蓝票者可以进入，甲持蓝票。', '按此规则，甲可以进入本活动。',
    'support', 'insufficient_evidence', '规则与个案共同支持许可；获许可不能反推出所持票色和规则。'),
  ...pair('dir-repair', '本次现场检查发现三处出口被杂物堵住，人员无法从这些出口离开。', '因此建议清理这些出口的杂物。',
    'support', 'insufficient_evidence', '观察到的阻碍支持清理建议；提出建议不证明发生了三处堵塞。'),
  ...pair('dir-qualified', '在两次限定测试中，设备甲均能运行，但未测试室外环境。', '现有测试给设备甲在已测条件下可运行提供初步依据。',
    'support', 'insufficient_evidence', '有限测试支持保留条件的主张；概括依据不足以恢复测试次数和未测环境。'),
  ...pair('dir-joint', '本批三个箱子分别有2、3、4件物品，且这三个箱子是本批全部箱子。', '本批一共有9件物品。',
    'support', 'insufficient_evidence', '完整分项支持总数；总数不能确定每箱数量或箱子总数。'),
  ...pair('dir-negation', '记录明确说甲在本轮提交了申请。', '记录明确说甲在本轮没有提交申请。',
    'oppose', 'oppose', '相同主体、轮次的显式肯定与否定冲突，两方向反驳都成立。'),
];
