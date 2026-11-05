import type { FigureRepairWarning } from '../figureRepairReceipt';
/** Only the checks that actually produced evidence enter the repair prompt. */
const guides: Record<FigureRepairWarning,string> = {
  'prediction-consistency':'预测反馈：题目固定情境时，答案依据题目数值独立计算，不依赖当前滑块、资金来源或视角。反馈明确区分“题目结果”和“当前观察”；不改变题目以迎合错误判断，不直接向答错者公布答案。重置同时清除答案和反馈。',
  'budget-readout':'预算读数：实际支出、显示支出和总余额必须一致。超额时显示实际扣除额，另行标注申请额或限额；不得把申请额写成实际支出。保留材料给定规则，示意假设仍要标明。',
  'axis-scale':'坐标刻度：原点、数值刻度、零线、条形宽度共用同一尺度。由原点及每单位宽度重新计算；移动终点后重新计算所有刻度，不套用旧 expectedX，不只改标签掩盖几何错误。',
  'chart-overflow':'柱形越界：用最大输入计算所有柱值，修复统一比例、坐标刻度及标签，让整根柱形都在画布内；不能截断数据或改变公式。',
  'gear-contact':'齿轮接触：只在材料明确齿数和啮合方式时修正两轮节圆接触和转向；不推断未知齿数，不把简化几何当机械仿真。',
};
export function figureRepairGuidance(warnings: readonly FigureRepairWarning[]): string {
  return [...new Set(warnings)].map(w=>guides[w]).join('\n');
}
