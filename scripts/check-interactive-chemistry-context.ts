/** Chemistry gate scope and display-only legacy adaptation. No network/model. */
import assert from 'node:assert/strict';
import { chemistryPredictionForDisplay, gateChemistryPrediction, isChemistryFigureContext } from '../src/services/textbook/interactiveFigurePredictionGate';

globalThis.fetch = async () => assert.fail('Chemistry context regression must not use the network');
const checks: string[] = [];
function check(name: string, task: () => void) { task(); checks.push(name); }
const chemistryLesson = '# 电解水的气体体积比\n\n相同温度和压强下，电解水总反应为2H2O → 2H2 + O2，氢气与氧气体积之比为2:1。';
const psychologyLesson = '# 联想主义与复合观念\n\n介绍心理化学、精神化学理论。\n\n' + '先区分感觉元素、联结和主动组织。'.repeat(100) + '\n\n## 化学反应的类比\n原子与分子仅是心理学解释的比喻。';
const html = '<article><h2>复合观念</h2><svg><circle r="4"/></svg><script>const text="</details>";</script><p>原片段 &amp; 文字。</p></article>';

check('真实化学教学目标保持准入', () => {
  for (const goal of ['比较电解水产生氢气和氧气的体积，并解释比例。', '调节化学反应进度，观察反应物和生成物', '改变温度观察化学平衡', '酸碱滴定与物质的量', 'Compare electrolysis products'])
    assert.equal(isChemistryFigureContext(goal, psychologyLesson), true, goal);
});
check('心理化学和精神化学不是化学教学目标', () => {
  for (const goal of ['心理化学如何解释复合观念', '比较精神化学与联想主义', '思想化学与观念组织', '人际的化学反应', '爱情化学反应与情感'])
    assert.equal(isChemistryFigureContext(goal, chemistryLesson), false, goal);
});
check('化学比喻不触发预测遮挡', () => {
  for (const goal of ['用化学反应类比联想主义', '像化学反应一样的团队协作', '用氧化还原比喻心理变化', '化学隐喻中的人际关系'])
    assert.equal(isChemistryFigureContext(goal, chemistryLesson), false, goal);
});
check('具体选区优先且不从长文旁及化学推断', () => {
  assert.equal(isChemistryFigureContext('改变共现次数，观察柠檬复合观念的解释', psychologyLesson), false);
  assert.equal(isChemistryFigureContext('比较两种动物形成条件反射所需试次', chemistryLesson), false);
  assert.equal(isChemistryFigureContext('根据本页教材的核心内容生成交互图。', psychologyLesson), false);
  assert.equal(isChemistryFigureContext('根据本页教材的核心内容生成交互图。', '# 心理化学与联想主义\n\n电解水只是比较案例。'), false);
});
check('整页默认目标仅继承明确的页面主题', () => {
  assert.equal(isChemistryFigureContext('根据本页教材的核心内容生成交互图。', chemistryLesson), true);
  assert.equal(isChemistryFigureContext('', '电解水时，比较两种气体体积。\n\n后续讲解。'), true);
  assert.equal(isChemistryFigureContext('交互探索', '# 心理学史\n\n讨论化学反应的类比'), false);
});
check('误套旧包装仅显示解包且原片段逐字保留', () => {
  const stored = gateChemistryPrediction(html, '心理化学能解释 <全部> 观念吗？');
  assert.equal(chemistryPredictionForDisplay(stored, psychologyLesson, '观察复合观念的组织'), html);
  assert.ok(stored.includes('data-local-prediction-gate="true"'));
  assert.equal(chemistryPredictionForDisplay(stored, chemistryLesson, '观察复合观念的组织'), html);
});
check('真实化学旧包装不变且新包装不重复', () => {
  const stored = gateChemistryPrediction(html, '两种气体的体积比是多少？');
  assert.equal(chemistryPredictionForDisplay(stored, chemistryLesson, '电解水产生气体'), stored);
  assert.equal(chemistryPredictionForDisplay(html, chemistryLesson, '电解水产生气体', '两种气体的体积比是多少？'), stored);
});
check('未知作者结构和局部相似包装不做改写', () => {
  const stored = gateChemistryPrediction(html, '问题');
  for (const authored of [html, `<div>${stored}</div>`, stored.replace('先思考：', '先考虑：'), stored.replace('可跳过预测', '自由探索')])
    assert.equal(chemistryPredictionForDisplay(authored, psychologyLesson, '观察复合观念'), authored);
});
check('已有本地组件免于新增化学包装', () => {
  const local = '<section data-local-function="true">现有曲线</section>';
  assert.equal(chemistryPredictionForDisplay(local, chemistryLesson, '电解水产生气体'), local);
});
console.log(JSON.stringify({ passed: checks.length, checks, remoteRequests: 0 }, null, 2));
