/** Synthetic model-evaluation inputs only; not empirical descriptions of a psychological effect. */
import type { TextbookContext, TextbookSource, TeachingBlueprint } from '../../src/services/textbook/generationTypes';
const source = (sourceId: string, title: string, text: string): TextbookSource => ({ sourceId, title, text,
  kind: 'document', id: `selection-${sourceId}`, version: 'selection-fixture-v1' });
const context = (tasks: string[]): TextbookContext => ({ project: { id: 'component-test', rootId: 'component-root',
  title: '学习某效应：概念、模型与模拟', rootTitle: '跨领域学习', tasks, knowledgeTitles: ['某效应'] },
  profile: '', preferences: {}, personal: [], mastery: {}, warnings: [] });
export const componentSelectionCases: Array<{ id: string; context: TextbookContext; sources: TextbookSource[] }> = [
  { id: 'mixed-explicit', context: context(['解释效应的条件；推导教学模型的导数并读出变化趋势；比较离散模拟结果。']), sources: [
    source('L1', '效应概念与边界', '某效应是本验收的虚构名称。现象描述须核对情境与适用条件，不能仅凭一个变量确定结果。定性描述不提供量化公式、参数或实测数据。'),
    source('L2', '明确的连续教学模型', '以下为专门用于理解收益与成本权衡的教学假设，不是某效应的实证规律。定义连续无量纲投入强度 t∈[0,8]，教学净收益 u(t)=t/(1+t)-0.08*t，收益项 t/(1+t)、线性成本项0.08*t，参数固定已知。导数u\'(t)=1/(1+t)^2-0.08。可用曲线观察变化、极值和边际收益，不代表现实满意度或过载概率。'),
    source('L3', '离散模拟输出', '独立的教学模拟：固定规则比较三种离散策略甲乙丙，各有100次假设试验。成功次数分别60、70、65，非真实实验。比较三组频率和抽样结果；策略名称是类别，不是连续自变量。代码只用于说明计算方法，不声称执行了真实实验。'),
  ] },
  { id: 'unknown-parameters', context: context(['解释效应的条件和参数 a、b 的含义，说明符号推导如何依赖这些条件。']), sources: [
    source('L1', '定性概念', '某效应是本验收的虚构名称。需要核对情境、目标、负荷等条件，不能给出普遍的数量阈值。'),
    source('L2', '只有符号的教学假设', '只提供符号教学模型 u(t)=a*log(1+t)-b*t，t≥0，a>0、b>0，但a和b没有具体数值。导数为a/(1+t)-b，变化方向依赖参数和所在区间。不提供经验参数、离散模拟数据或某效应的实证曲线。'),
  ] },
  { id: 'discrete-counts', context: context(['解释效应的条件；推导n项完整两两比较次数；用代码及表格/图表比较有限计算结果。']), sources: [
    source('L1', '定性效应与计数的区别', '某效应是本验收的虚构名称。效应是否发生需要情境证据，比较次数不等于效应发生概率或实测时间。'),
    source('L2', '整数计数与模拟', '假设每两个不同选项恰好比较一次且不重复，选项数n只能取整数1到8，比较次数C(n)=n(n-1)/2。n=1,2,3,4,5,6,7,8对应0,1,3,6,10,15,21,28。用for循环可重现这些有限计数；这是教学模型，不是实验统计，未引入连续延拓或插值假设。'),
  ] },
];
/** Case-specific acceptance oracle, not a production semantic gate. */
export function assessComponentSelection(caseId: string, blueprint: TeachingBlueprint): string[] {
  const issues: string[] = [];
  const planned = blueprint.chapters.flatMap(chapter => (chapter.visuals || []).map(visual => ({ chapter, visual })));
  const functions = planned.filter(item => item.visual.format === 'function-plot');
  if (caseId === 'mixed-explicit') {
    if (!functions.some(item => item.chapter.sourceIds.includes('L2'))) issues.push('明确连续模型没有安排有来源的函数图');
    if (functions.some(item => !item.chapter.sourceIds.includes('L2'))) issues.push('函数图落在未获得模型来源的章节');
    if (!planned.some(item => ['chart', 'table'].includes(item.visual.format) && item.chapter.sourceIds.includes('L3'))) issues.push('离散模拟结果未安排图表/对照表');
    if (!planned.some(item => ['mindmap', 'flowchart', 'table'].includes(item.visual.format) && item.chapter.sourceIds.includes('L1'))) issues.push('概念辨析没有相应阅读支架');
  } else if (functions.length) issues.push(caseId === 'unknown-parameters' ? '参数未知仍安排具体函数曲线' : '离散计数被安排为连续函数图');
  if (caseId === 'discrete-counts' && !planned.some(item => ['chart', 'table'].includes(item.visual.format) && item.chapter.sourceIds.includes('L2'))) issues.push('有限计数没有安排表格/统计图');
  return issues;
}
