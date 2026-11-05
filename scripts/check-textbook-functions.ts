import assert from 'node:assert/strict';
import { compileTextbookFunction, parseFunctionPlot, optionalFunctionPlot, riemannRectangles } from '../src/services/textbook/functionPlot';
import { sampleTextbookCurve } from '../src/components/textbook/FunctionPlotBlock';
import { FunctionPlotBlock } from '../src/components/textbook/FunctionPlotBlock';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { textbookTimelinePrompt, TEXTBOOK_TIMELINE_GUIDANCE, TEXTBOOK_INVERSE_TRIG_GUIDANCE } from '../src/services/textbook/timeline';
import { parseControlledTextbookBlock } from '../src/services/textbook/contentSchema';
import { validateChapter, assembleTextbook, validateBlueprint } from '../src/services/textbook/validation';
import { autoLinkMarkdown } from '../src/services/markdownAutoLink';
import { parseTextbookMarkdown } from '../src/services/textbook/markdown';
import { TEXTBOOK_BLUEPRINT_PROMPT, TEXTBOOK_SOURCE_PROMPT, TEXTBOOK_CHAPTER_PROMPT, TEXTBOOK_SECTION_REPAIR_PROMPT, TEXTBOOK_PRESENTATION_SELECTION_PROMPT } from '../src/workflows/textbookPrompt';
import { textbookVisualGuidance } from '../src/services/textbook/visualGuidance';
import { mathBlueprint, mathChapters, mathSources, parabolaPlot, riemannPlot, signedPlot, functionFence } from './fixtures/textbook-math';
import { componentSelectionCases, assessComponentSelection } from './fixtures/textbook-component-selection';
let groups = 0;
function test(name: string, run: () => void) { run(); groups++; console.log(`PASS ${name}`); }
const parse = (value: unknown) => parseFunctionPlot(JSON.stringify(value));
const close = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
test('真实故障同构 atan(x) 图块及反三角别名可解析、采样；弧度与定义域准确', () => {
  const plot = parse({ title: '反正切的两端趋势', variable: 'x', xLabel: 'x（自变量）', yLabel: 'y（函数值）',
    xDomain: [-10, 10], yDomain: [-2, 2], curves: [{ id: 'f', label: 'y=arctan x', expression: 'atan(x)' }] });
  const segments = sampleTextbookCurve(plot, 0);
  assert.equal(segments.length, 1); assert.equal(segments[0].length, 601);
  close(segments[0][0][1], Math.atan(-10)); close(segments[0][600][1], Math.atan(10));
  for (const [name, fn] of [['asin', Math.asin], ['acos', Math.acos], ['atan', Math.atan],
    ['arcsin', Math.asin], ['arccos', Math.acos], ['arctan', Math.atan]] as const) {
    const compiled = compileTextbookFunction(`${name}(x)`, 'x');
    close(compiled.evaluate(.5), fn(.5)); assert.ok(compiled.continuousOn(-1, 1));
    if (!name.includes('tan')) { assert.ok(Number.isNaN(compiled.evaluate(2))); assert.equal(compiled.continuousOn(-2, 2), false); }
  }
  // Decreasing acos must produce ordered interval bounds; this denominator
  // crosses zero and must never be shaded as a continuous filled area.
  assert.equal(compileTextbookFunction('1/(acos(x)-1)', 'x').continuousOn(0, 1), false);
  assert.equal(sampleTextbookCurve({ ...plot, curves: [{ id: 'f', label: 'acos', expression: 'acos(x)' }] }, 0).some(segment => segment.some(([x]) => x < -1 || x > 1)), false);
});
test('图块错误显示具体安全原因、保留正文；旧任务提示词精确不变', () => {
  const html = renderToStaticMarkup(React.createElement(FunctionPlotBlock, { code: JSON.stringify({ ...parabolaPlot,
    curves: [{ id: 'f', label: 'f', expression: 'unknown(x)' }] }) }));
  assert.match(html, /不支持的函数/u); assert.match(html, /role="status"/u);
  assert.equal(optionalFunctionPlot('{bad'), null);
  const base = 'legacy prompt'; assert.equal(textbookTimelinePrompt(base), base);
  assert.equal(textbookTimelinePrompt(base, 2), `${base}\n${TEXTBOOK_TIMELINE_GUIDANCE}`);
  assert.ok(!textbookTimelinePrompt(base, 2).includes(TEXTBOOK_INVERSE_TRIG_GUIDANCE));
  assert.ok(textbookTimelinePrompt(base, 3).includes(TEXTBOOK_INVERSE_TRIG_GUIDANCE));
});
test('明确变量、数值参数、运算优先级，不执行脚本或任意函数', () => {
  close(compileTextbookFunction('a*t^2+sin(t)', 't', { a: 2 }).evaluate(2), 8 + Math.sin(2));
  close(compileTextbookFunction('-x^2', 'x').evaluate(2), -4);
  close(compileTextbookFunction('x^-2', 'x').evaluate(2), .25);
  close(compileTextbookFunction('3', 'x').evaluate(2), 3);
  close(compileTextbookFunction('exp(log(x))+sqrt(x)+abs(-x)', 'x').evaluate(4), 10);
  for (const expression of ['a*x', 'x+y', '2x', 'x.constructor', 'alert(x)', 'x;fetch(1)', 'window.x', 'x=1', 'x**2', '\\sin{x}', 'constructor(x)', 'x[0]']) assert.throws(() => compileTextbookFunction(expression, 'x'));
});
test('实数幂与变量指数按实数定义域计算，跨缺口不连线或填充', () => {
  const limit = compileTextbookFunction('(1+1/x)^x', 'x');
  close(limit.evaluate(1), 2); close(limit.evaluate(2), 2.25);
  assert.ok(limit.continuousOn(.1, 5)); assert.equal(limit.continuousOn(-2, 1), false);
  assert.ok(Number.isNaN(limit.evaluate(-.5))); assert.ok(!Number.isFinite(limit.evaluate(0)));
  const variable = compileTextbookFunction('x^x', 'x');
  close(variable.evaluate(2), 4); assert.ok(Number.isNaN(variable.evaluate(0)));
  assert.ok(variable.continuousOn(.1, 2)); assert.equal(variable.continuousOn(-1, 1), false);
  const root = compileTextbookFunction('x^0.5', 'x'); close(root.evaluate(4), 2);
  assert.ok(root.continuousOn(0, 4)); assert.equal(root.continuousOn(-1, 4), false);
  const negativeInteger = compileTextbookFunction('x^-13', 'x');
  close(negativeInteger.evaluate(-1), -1); assert.equal(negativeInteger.continuousOn(-1, 1), false);
  assert.ok(Number.isFinite(compileTextbookFunction('x^100000', 'x').evaluate(1)));
  const plot = { ...parabolaPlot, xDomain: [-2, 2], yDomain: [0, 5], curves: [{ id: 'f', label: '极限', expression: '(1+1/x)^x' }] };
  assert.ok(parse(plot)); assert.throws(() => parse({ ...plot, area: { curveId: 'f', from: -2, to: 2 } }));
  const segments = sampleTextbookCurve(parse(plot), 0);
  assert.ok(segments.some(segment => segment.every(([x]) => x > 0)));
  assert.ok(segments.every(segment => !segment.some(([x]) => x < 0) || !segment.some(([x]) => x > 0)));
});
test('双曲贴现示例由安全求值器采样，不依赖绘图库再次解析表达式', () => {
  const plot = parse({ title: '双曲贴现函数 D(t)=1/(1+0.05t)', variable: 't', xLabel: '延迟时间 t（天）', yLabel: '贴现因子 D(t)',
    xDomain: [0, 30], yDomain: [0, 1.05], curves: [{ id: 'd', label: 'D(t)', expression: '1/(1+0.05*t)' }] });
  const segments = sampleTextbookCurve(plot, 0, 60);
  assert.equal(segments.length, 1);
  close(segments[0][0][1], 1);
  close(segments[0][40][1], .5);
  close(segments[0][60][1], .4);
});
test('不明确/不支持图可跳过，渲染选项和注入字段一律拒绝', () => {
  assert.equal(optionalFunctionPlot('{broken'), null);
  for (const change of [{ variable: undefined }, { curves: [{ id: 'f', label: '未知', expression: 'a*x' }] }, { xDomain: [2, 1] }, { yDomain: [0, Infinity] }, { onclick: 'alert(1)' }, { curves: [{ id: 'f', label: '<script>', expression: 'x' }] }, { parameters: { x: 2 } }]) assert.throws(() => parse({ ...parabolaPlot, ...change }));
  assert.equal(parseControlledTextbookBlock('function-plot', '{bad'), null);
  assert.equal(optionalFunctionPlot(JSON.stringify({ ...parabolaPlot, xDomain: [-4, -1], curves: [{ id: 'f', label: '未定义区间', expression: 'sqrt(x)' }] })), null);
});
test('面积不跨越极点/定义域缺口，曲线允许断开不乱连', () => {
  for (const expression of ['1/x', '1/(x-0.3)', 'log(x)', 'sqrt(x)', 'tan(x)']) {
    const plot = { ...parabolaPlot, curves: [{ id: 'f', label: expression, expression }] };
    assert.ok(parse(plot));
    assert.throws(() => parse({ ...plot, area: { curveId: 'f', from: -2, to: 2 } }));
  }
  assert.ok(parse({ ...riemannPlot, curves: [{ id: 'f', label: '正区间倒数', expression: '1/x' }], area: { curveId: 'f', from: 1, to: 2 }, riemann: undefined }));
  assert.throws(() => parse({ ...riemannPlot, riemann: { ...riemannPlot.riemann, count: 100000 } }));
  assert.throws(() => parse({ ...riemannPlot, area: { curveId: 'unknown', from: 0, to: 2 } }));
});
test('黎曼和计算与教学例题一致，细分逼近8/3，正负区域不混淆', () => {
  close(riemannRectangles(riemannPlot, 4, 'midpoint').signedSum, 2.625);
  close(riemannRectangles(riemannPlot, 2, 'right').signedSum, 5);
  const coarse = riemannRectangles(riemannPlot, 4), fine = riemannRectangles(riemannPlot, 80);
  assert.ok(Math.abs(fine.signedSum - 8 / 3) < Math.abs(coarse.signedSum - 8 / 3));
  const signed = riemannRectangles(signedPlot, 8); close(signed.signedSum, 0); close(signed.geometricSum, 1);
  assert.equal(riemannRectangles(riemannPlot, 32).rectangles.length, 32);
});
test('完整数学示例通过正式结构校验和组装，新增图计划向下兼容', () => {
  validateBlueprint(mathBlueprint, { personal: [] } as any, mathSources);
  mathChapters.forEach(chapter => validateChapter(chapter, chapter.id, ['N1']));
  const body = assembleTextbook(mathBlueprint, mathChapters, mathSources);
  const kinds: string[] = []; const visit = (node: any) => { kinds.push(node.type); node.children?.forEach(visit); }; visit(parseTextbookMarkdown(body));
  for (const kind of ['math', 'inlineMath', 'table', 'footnoteDefinition', 'code']) assert.ok(kinds.includes(kind));
  assert.equal((body.match(/```function-plot/gu) || []).length, 3);
  assert.ok(body.includes('textbook-answer') && body.includes('微分') && body.includes('参考答案'));
  assert.equal(textbookVisualGuidance(mathBlueprint, 'ch2').targets[0].format, 'function-plot');
});
test('坏图不阻塞章节，不放宽其它格式/事实引用安全门', () => {
  const chapter = structuredClone(mathChapters[0]); chapter.sections.explanation += '\n\n```function-plot\n{"bad":true}\n```';
  validateChapter(chapter, 'ch1', ['N1']);
  chapter.sections.explanation += '\n\n```chart\n{"bad":true}\n```'; assert.throws(() => validateChapter(chapter, 'ch1', ['N1']));
  const hiddenReference = { ...parabolaPlot, title: '未经授权的来源 [N99]' };
  const sourced = structuredClone(mathChapters[0]); sourced.sections.explanation += '\n\n' + functionFence(hiddenReference);
  assert.throws(() => validateChapter(sourced, 'ch1', ['N1']));
});
test('自动双链不改图源码，生成/局部修复提示共享非阻断规则，无额外模型阶段', () => {
  const fence = functionFence(riemannPlot);
  assert.equal(autoLinkMarkdown(fence, [{ token: '抛物线', target: '平方函数' }]).updatedContent, fence);
  for (const prompt of [TEXTBOOK_CHAPTER_PROMPT, TEXTBOOK_SECTION_REPAIR_PROMPT]) {
    assert.ok(prompt.includes('function-plot') && prompt.includes('不询问用户') && prompt.includes('不因缺图/画图失败增加模型调用'));
  }
});
test('混合主题组件选择规则在选材/蓝图/章节/局部修订中传递，不按项目标题套模板', () => {
  assert.ok(TEXTBOOK_SOURCE_PROMPT.includes('不只选择名称相似的概念介绍'));
  for (const prompt of [TEXTBOOK_BLUEPRINT_PROMPT, TEXTBOOK_CHAPTER_PROMPT, TEXTBOOK_SECTION_REPAIR_PROMPT]) assert.ok(prompt.includes(TEXTBOOK_PRESENTATION_SELECTION_PROMPT));
  for (const rule of ['不能只根据项目标题', '公式存在不等于需要函数图', '参数未知时保留符号推导', '离散类别', '不因缺图重写章节']) assert.ok(TEXTBOOK_PRESENTATION_SELECTION_PROMPT.includes(rule));
});
test('混合蓝图绑定各章物料与组件；参数未知/离散计数不套函数图（离线契约，不证明模型理解）', () => {
  for (const item of componentSelectionCases) {
    const plan = (id: string, sourceIds: string[], format: 'mindmap' | 'function-plot' | 'table') => ({ id, title: '完成本章目标', objectiveIds: ['O1'], focusIds: [], sourceIds,
      bridge: '先核对概念和条件，再阅读当前模型与结果。', visuals: [{ format, section: 'explanation' as const, purpose: '借助组件辨认本章条件与关系。', readingQuestion: '图示与公式依据是否一致？' }] });
    const blueprint = { title: '混合主题教学', objectives: [{ id: 'O1', text: '依次解释概念、模型及其适用范围。' }], focuses: [], chapters: item.id === 'mixed-explicit'
      ? [plan('ch1', ['L1'], 'mindmap'), plan('ch2', ['L2'], 'function-plot'), plan('ch3', ['L3'], 'table')]
      : [plan('ch1', ['L1'], 'mindmap'), plan('ch2', ['L2'], 'table')] };
    validateBlueprint(blueprint, item.context, item.sources);
    assert.deepEqual(assessComponentSelection(item.id, blueprint), []);
    for (const chapter of blueprint.chapters) assert.deepEqual(textbookVisualGuidance(blueprint, chapter.id).targets, chapter.visuals);
    const wrong = structuredClone(blueprint); wrong.chapters[0].visuals[0].format = 'function-plot';
    assert.ok(assessComponentSelection(item.id, wrong).length > 0, '验收器识别无数学物料的错配，不将合成预设伪装成真实模型测试');
  }
});
console.log(`Textbook function checks passed: ${groups} groups. No model or user-vault access.`);
