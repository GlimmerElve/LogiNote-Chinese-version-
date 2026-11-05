import { compileTextbookFunction, parseFunctionPlot } from './functionPlot';
import { sampleTextbookCurve } from './curveSampling';
import type { FigureDesign } from './interactiveFigureDesign';
import { generatedMathMarkdown } from './generatedMath';
import { renderTeachingBaseStyle, renderTeachingFormulaText as formulaText, renderTeachingFunctionPrediction, renderTeachingPrediction, renderTeachingRange, renderTeachingSelect, renderTeachingReset, renderTeachingTransfer, renderTeachingGoal, renderTeachingCaveat, renderTeachingExplanation } from './interactiveTeachingControls';

/** A function figure is a validated data specification, never model-authored code. */
export const INTERACTIVE_FUNCTION_PROMPT = `为教材设计函数交互图，只输出 JSON：{"design":{"anchor":"教材原句","goal":"教学目标","action":"调整什么","observation":"观察什么","model":"明确的数学关系","prediction":"预测问题","caveat":"依据和边界","transfer":"迁移问题"},"plot":{"title":"标题","variable":"x","xLabel":"x","yLabel":"y","xDomain":[-3,3],"yDomain":[-1,10],"curves":[{"id":"f","label":"y=x²","expression":"x^2"}]}}。本地程序负责曲线、坐标、刻度、滑块和预测题；不要输出 HTML、SVG、脚本或自行设计坐标。只提供教材明确给出的函数，不能确定时不要编造。expression 使用明确乘号及 + - * / ^、括号，幂支持固定整数、实数和表达式指数；非整数或变量指数只在实数定义域内绘图，避免 0^0 和未定义区间；支持 sin cos tan asin acos atan exp log sqrt abs，常量 pi e。variable 是唯一自变量；固定数值可写在 expression 中。xDomain 与 yDomain 为有限递增数字，曲线和示例必须在窗口内，最多 4 条。设计简洁可观察的教学目标；不要声称有限次采样构成证明。若学习目标要求比较参数，plot.parameters 声明初值，在 JSON 同级增加 parameterExploration: {"name":"k","values":[0.5,1,2]}，参数名和值只是示例，须符合题设；至少 2 至多 3 个有限不同示例。需要切换参数时，主曲线的 expression 必须保留该参数符号，禁止把不同参数值写死成多条曲线；plot.parameters 必须是名称到数字的对象，例如 {"k":1}，不可用数组。题设要求比较 e^k 时，增加表达式 exp(k) 的水平参照曲线，随 k 一起变化。明确有限观察不能证明极限。若题目要求说明理由，在 design.model 依据教材简述推导或原理；结论依赖的条件必须写清。`;
export function wantsInteractiveFunction(brief: string, lesson: string, wholePage = false): boolean {
  const text = wholePage ? lesson : brief;
  if (/(黎曼|积分面积|面积近似|分割.*矩形)/u.test(text)) return false;
  const functionCue = /(函数|抛物线|曲线|函数图|坐标图)/u;
  const graphIntent = /(函数图|抛物线|曲线|坐标图)/u.test(brief);
  // A conceptual discussion of input/output is not evidence for a particular
  // function. Only infer a curve from context when a y/f(x) relation is present.
  const relation = /(?:\by|\b[fg]\s*\(\s*[a-z]\s*\))\s*[=＝]\s*[^\s。；;\n]/iu.test(`${brief}\n${lesson}`);
  if (!wholePage && graphIntent) return true;
  if (functionCue.test(text) && relation) return true;
  // A short selection or automatically planned goal may mention only x/y,
  // inputs/outputs or slope while its immediate lesson names the function.
  const mathGoal = /\b[xyzts]\b|自变量|因变量|斜率|坐标|图像/u.test(brief) || (/输入/u.test(brief) && /输出/u.test(brief));
  if (!wholePage && mathGoal && /极限/u.test(brief) && /\^|\\frac|\\left/u.test(brief)) return true;
  return !wholePage && mathGoal && functionCue.test(lesson) && relation;
}
const escape = (value: string) => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;').replace(/'/gu, '&#39;');
const teachingText = (value: string) => escape(generatedMathMarkdown(value));
const number = (value: number) => Number(value.toPrecision(8)).toString();
const tickLabel = (value: number) => Number(value.toPrecision(15)).toString();
/** Accept a bounded structured list as well as the canonical name/value map. */
export function normalizeInteractiveParameterPlot(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const plot = input as Record<string, unknown>;
  if (!Array.isArray(plot.parameters)) return input;
  if (plot.parameters.length > 8) throw Error('函数图参数过多');
  const parameters: Record<string, number> = Object.create(null);
  for (const entry of plot.parameters) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw Error('函数图参数格式无效');
    const item = entry as Record<string, unknown>, name = item.name, value = item.initial ?? item.value;
    if (Object.keys(item).some(key => !['name', 'initial', 'value', 'min', 'max', 'step'].includes(key))
      || typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,15}$/u.test(name) || Object.hasOwn(parameters, name)
      || typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e6
      || ['min', 'max', 'step'].some(key => item[key] !== undefined && (typeof item[key] !== 'number' || !Number.isFinite(item[key])))) throw Error('函数图参数格式无效');
    parameters[name] = value;
  }
  return { ...plot, parameters };
}
/** Multiple bounded examples share the same axes and each uses the local safe evaluator. */
export function buildInteractiveParameterFigure(input: unknown, design: FigureDesign, specification: unknown): string {
  if (!specification || typeof specification !== 'object' || Array.isArray(specification)) throw Error('缺少参数探索配置');
  const spec = specification as Record<string, unknown>;
  if (Object.keys(spec).some(key => !['name', 'values'].includes(key)) || typeof spec.name !== 'string'
    || !Array.isArray(spec.values) || spec.values.length < 2 || spec.values.length > 3
    || !spec.values.every(value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e6)
    || new Set(spec.values).size !== spec.values.length) throw Error('参数探索需提供 2 至 3 个不同的有限示例值');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('缺少函数图配置');
  const plot = normalizeInteractiveParameterPlot(input) as Record<string, unknown>, parameters = plot.parameters;
  if (parameters !== undefined && (!parameters || typeof parameters !== 'object' || Array.isArray(parameters))) throw Error('函数图参数格式无效');
  const name = spec.name, values = spec.values as number[];
  if (!/^[A-Za-z][A-Za-z0-9_]{0,15}$/u.test(name) || name === plot.variable) throw Error('变化参数名称无效');
  const curves = plot.curves;
  const firstExpression = Array.isArray(curves) && curves[0] && typeof curves[0] === 'object' ? (curves[0] as Record<string, unknown>).expression : undefined;
  if (typeof firstExpression !== 'string' || !(firstExpression.match(/[A-Za-z][A-Za-z0-9_]*/gu) || []).some(token => token === name))
    throw Error('主曲线没有使用变化参数，无法进行参数探索');
  // The scenario already supplies each value; use it to fill a missing
  // declaration rather than spending another model call. Other parameters
  // still pass through the ordinary strict parser unchanged.
  const safeParameters = parameters as Record<string, unknown> | undefined;
  const cases = values.map(value => parseFunctionPlot(JSON.stringify({ ...plot, parameters: { ...safeParameters, [name]: value } })));
  const sharedY = [Math.min(...cases.map(item=>item.yDomain[0])),Math.max(...cases.map(item=>item.yDomain[1]))];
  const figures = cases.map(item => buildInteractiveFunctionFigure({ ...item, yDomain: sharedY, yRange:'fixed' }, design, { sampleSteps: 150, curveSteps: 150 }));
  const sections = figures.map((html, index) => `<section data-parameter-case="${index}"${index ? ' hidden' : ''}>${html}</section>`).join('');
  const choices = values.map((value, index) => ({value:String(index),label:`${name} = ${tickLabel(value)}`}));
  const html = `<div class="local-parameter-figure" data-local-function="true">${renderTeachingSelect({label:'切换参数示例：',marker:'data-parameter-choice',options:choices})}<p>这些数值是用于观察的示例；有限取值和有限区间的图像不能代替极限证明。</p>${sections}<script>(function(){const root=document.currentScript.parentElement,select=root.querySelector('[data-parameter-choice]'),cases=[...root.querySelectorAll('[data-parameter-case]')];select.addEventListener('change',()=>cases.forEach((section,index)=>section.hidden=String(index)!==select.value))})()</script></div>`;
  if (html.length > 100_000) throw Error('参数示例过多或图形过复杂，无法安全展示');
  return html;
}
function ticks(from: number, to: number): number[] {
  const raw = (to - from) / 5, power = 10 ** Math.floor(Math.log10(raw)), scaled = raw / power;
  const step = (scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 5 ? 5 : 10) * power;
  const out: number[] = [];
  for (let n = Math.ceil(from / step - 1e-10), end = Math.floor(to / step + 1e-10); n <= end && out.length < 20; n++) out.push(Number((n * step).toPrecision(15)));
  return out;
}

export function buildInteractiveFunctionFigure(input: unknown, design: FigureDesign, options?: { sampleSteps?: number; curveSteps?: number }): string {
  const encoded = JSON.stringify(input);
  if (!encoded) throw Error('缺少函数图配置');
  const plot = parseFunctionPlot(encoded);
  const steps = options?.sampleSteps ?? 600, curveSteps = options?.curveSteps ?? 500;
  if (plot.area || plot.riemann) throw Error('交互函数图暂不支持面积或黎曼矩形配置');
  const [xmin, xmax] = plot.xDomain, [ymin, ymax] = plot.yDomain;
  const left = 68, right = 738, top = 24, bottom = 346, width = right - left, height = bottom - top;
  const X = (x: number) => left + (x - xmin) / (xmax - xmin) * width;
  const Y = (y: number) => bottom - (y - ymin) / (ymax - ymin) * height;
  const limit = (v: number) => Math.max(-10000, Math.min(10000, v));
  const axisX = Math.max(left, Math.min(right, X(0))), axisY = Math.max(top, Math.min(bottom, Y(0)));
  const xticks = ticks(xmin, xmax), yticks = ticks(ymin, ymax);
  const grid = xticks.map(x => `<line x1="${number(X(x))}" y1="${top}" x2="${number(X(x))}" y2="${bottom}"/><text x="${number(X(x))}" y="${bottom + 20}" text-anchor="middle">${escape(tickLabel(x))}</text>`).join('')
    + yticks.map(y => `<line x1="${left}" y1="${number(Y(y))}" x2="${right}" y2="${number(Y(y))}"/><text x="${left - 8}" y="${number(Y(y) + 4)}" text-anchor="end">${escape(tickLabel(y))}</text>`).join('');
  const colors = ['#287b59', '#685bb0', '#a65e25', '#b34866'];
  const paths = plot.curves.map((curve, i) => sampleTextbookCurve(plot, i, curveSteps).map(segment => `<path data-local-curve="${escape(curve.id)}" d="${segment.map(([x, y], j) => `${j ? 'L' : 'M'}${number(limit(X(x)))} ${number(limit(Y(y)))}`).join(' ')}" fill="none" stroke="${colors[i]}" stroke-width="2.5"/>`).join('')).join('');
  const compiled = plot.curves.map(curve => compileTextbookFunction(curve.expression, plot.variable, plot.parameters));
  const samples = Array.from({ length: steps + 1 }, (_, i) => {
    const x = xmin + (xmax - xmin) * i / steps;
    return [x, ...compiled.map(fn => { const y = fn.evaluate(x); return Number.isFinite(y) ? y : null; })];
  });
  const visible = (value: number | null | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= ymin && value <= ymax;
  let predictionIndex = Math.round(steps / 3);
  if (!visible(samples[predictionIndex][1])) {
    const candidates = samples.map((row, index) => visible(row[1]) ? index : -1).filter(index => index >= 0);
    predictionIndex = candidates.reduce((best, index) => Math.abs(index - steps / 3) < Math.abs(best - steps / 3) ? index : best, candidates[0] ?? -1);
  }
  // The plot validator checks 65 positions. Preserve one of those positions if
  // a very narrow visible interval happens to fall between the 601 slider samples.
  if (predictionIndex < 0) {
    for (let i = 0; i <= 64; i++) {
      const x = xmin + (xmax - xmin) * i / 64;
      if (!visible(compiled[0].evaluate(x))) continue;
      predictionIndex = Math.round(i / 64 * steps);
      samples[predictionIndex] = [x, ...compiled.map(fn => { const y = fn.evaluate(x); return Number.isFinite(y) ? y : null; })];
      break;
    }
  }
  if (predictionIndex < 0) throw Error('所选范围没有可观察的函数值');
  // Honor a concrete teaching question when it gives an x value, but always
  // calculate its answer locally from the validated expression.
  const requestedPattern = new RegExp(`\\b${plot.variable}\\s*[=＝]\\s*([-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)(?:[eE][-+]?\\d+)?)(?![A-Za-z0-9_.])`, 'gu');
  const requestedValues = [...design.prediction.matchAll(requestedPattern)].map(match => Number(match[1]));
  const uniqueRequested = [...new Set(requestedValues.filter(Number.isFinite))];
  const requestedX = uniqueRequested.length === 1 ? uniqueRequested[0] : NaN;
  const requestedY = Number.isFinite(requestedX) && requestedX >= xmin && requestedX <= xmax ? compiled[0].evaluate(requestedX) : NaN;
  const requestedVisible = visible(requestedY) && Math.abs(requestedY) < 1e12;
  // When the stated lesson and prediction explicitly ask for symmetry, ask a
  // concrete pair comparison instead of silently reducing it to x=0. The pair
  // is evaluated locally; equality at two points is not a general proof.
  const transition = design.prediction.match(/从\s*([-+]?(?:\d+(?:\.\d+)?|\.\d+))\s*(?:变为|变成|到)\s*([-+]?(?:\d+(?:\.\d+)?|\.\d+))/u);
  const transitionValues = transition ? [Number(transition[1]), Number(transition[2])] : [];
  const fromExplicit = uniqueRequested.length === 2 && uniqueRequested[0] !== 0 && uniqueRequested[0] === -uniqueRequested[1] ? Math.abs(uniqueRequested[0]) : undefined;
  const fromTransition = transitionValues.length === 2 && transitionValues[0] !== 0 && transitionValues[0] === -transitionValues[1] ? Math.abs(transitionValues[0]) : undefined;
  const explicitPair = fromExplicit ?? fromTransition;
  const symmetryRequested = plot.curves.length === 1 && /(对称|相反数)/u.test(`${design.goal} ${design.observation}`)
    && (explicitPair !== undefined || /(对称|相反数)/u.test(design.prediction));
  const pairCandidates = explicitPair !== undefined ? [explicitPair] : uniqueRequested.length >= 2 || transition ? [] : [2, 1, 0.5, Math.min(xmax, -xmin) / 2];
  const pair = symmetryRequested ? pairCandidates.find(x => {
    if (!Number.isFinite(x) || x <= 0 || -x < xmin || x > xmax) return false;
    const left = compiled[0].evaluate(-x), right = compiled[0].evaluate(x);
    return visible(left) && visible(right) && Math.abs(left) < 1e12 && Math.abs(right) < 1e12 && left === right;
  }) : undefined;
  // Prefer a readable axis tick when the model did not specify a usable
  // point. Evaluate that exact point and make it reachable on the slider.
  const readableTick = (uniqueRequested.length ? [] : xticks).filter(x => x > xmin && x < xmax && visible(compiled[0].evaluate(x)) && Math.abs(compiled[0].evaluate(x)) < 1e12)
    .sort((a, b) => Math.abs(a - (xmin + (xmax - xmin) / 3)) - Math.abs(b - (xmin + (xmax - xmin) / 3)))[0];
  const predictionX = pair !== undefined ? -pair : requestedVisible ? requestedX : readableTick ?? samples[predictionIndex][0]!;
  const predictionY = compiled[0].evaluate(predictionX);
  const predictionFallback = pair === undefined && uniqueRequested.length === 1 && !requestedVisible;
  // Keep the exact question reachable even when it falls between grid samples.
  if (requestedVisible || pair !== undefined || readableTick !== undefined) {
    predictionIndex = Math.max(0, Math.min(steps, Math.round((predictionX - xmin) / (xmax - xmin) * steps)));
    samples[predictionIndex] = [predictionX, ...compiled.map(fn => { const y = fn.evaluate(predictionX); return Number.isFinite(y) ? y : null; })];
  }
  // Do not display the answer as the initial readout before the learner tries.
  const distinctAnswer = (index: number) => index !== predictionIndex && visible(samples[index][1]) && samples[index][1] !== predictionY;
  const otherVisible = (index: number) => index !== predictionIndex && visible(samples[index][1]);
  const preferred = [Math.round(steps / 2), 0, steps, Math.round(steps / 4), Math.round(steps * 3 / 4)];
  const alternativeIndex = preferred.find(distinctAnswer) ?? samples.findIndex((_row, index) => distinctAnswer(index));
  const differentX = preferred.find(otherVisible) ?? samples.findIndex((_row, index) => otherVisible(index));
  const initialIndex = alternativeIndex >= 0 ? alternativeIndex : differentX >= 0 ? differentX : predictionIndex;
  const points = plot.curves.map((curve, i) => `<circle data-local-point="${escape(curve.id)}" r="5" fill="${colors[i]}" stroke="#fff" stroke-width="2"/>`).join('');
  const legend = plot.curves.map((curve, i) => `<span><i style="background:${colors[i]}"></i>${formulaText(curve.label, curve.expression)}${curve.label.includes(curve.expression) || /[=＝$]/u.test(curve.label) ? '' : `：\\(${escape(curve.expression)}\\)`}</span>`).join('');
  // Keep rendered formulas in stable DOM nodes; moving the slider updates only values.
  const readouts = plot.curves.map((curve, i) => `${i ? '；' : ''}<span data-readout-entry>${formulaText(curve.label, curve.expression)}${curve.label.includes(curve.expression) || /[=＝$]/u.test(curve.label) ? '' : `：\\(${escape(curve.expression)}\\)`} = <output data-readout-value></output></span>`).join('');
  const source = JSON.stringify({ samples, predictionX, predictionY, comparison: pair !== undefined, initialIndex, xmin, xmax, ymin, ymax, left, right, top, bottom, fixedYRange:plot.yRange==='fixed' }).replace(/</gu, '\\u003c').replace(/&/gu, '\\u0026');
  return `<div class="local-function-figure" data-local-function="true">${renderTeachingBaseStyle('local-function-figure')}<style>
.local-function-figure h2{margin:0 0 .4em}.local-function-figure .legend{display:flex;flex-wrap:wrap;gap:12px}.local-function-figure .legend i{display:inline-block;width:9px;height:9px;border-radius:50%;margin-right:5px}.local-function-figure svg{display:block;width:100%;height:auto}.local-function-figure .grid line{stroke:#e5eee8;stroke-width:1}.local-function-figure .grid text{fill:#50675a;font-size:12px}.local-function-figure .axis{stroke:#658873;stroke-width:1.4}.local-function-figure input[type=range]{width:100%;accent-color:#386c50}.local-function-figure button{margin:.4em .4em 0 0}.local-function-figure output{font-weight:600}
</style><h2>${formulaText(plot.title, plot.curves[0].expression)}</h2>${renderTeachingGoal(pair !== undefined ? `观察 ${plot.variable} 与其相反数对应的函数值，并解释两者关系。` : design.goal,true)}<p>${teachingText(pair !== undefined ? `先预测，再分别将滑块调整到 ${plot.variable}=${tickLabel(pair)} 和 ${plot.variable}=${tickLabel(-pair)}，比较读数。` : design.action)}</p>
${pair !== undefined ? renderTeachingPrediction(`先预测：${plot.variable}=${tickLabel(pair)} 与 ${plot.variable}=${tickLabel(-pair)} 时，函数值是否相同？`, [{value:'same',label:'相同'},{value:'different',label:'不同'}]) : renderTeachingFunctionPrediction(plot.variable,plot.curves[0].label,plot.curves[0].expression,predictionFallback ? `原预测点（${plot.variable}=${tickLabel(requestedX)}）不在当前图示范围内，以下选择可见位置进行预测。` : undefined)}
<div class="panel"><div class="legend">${legend}</div><svg viewBox="0 0 780 385" role="img" aria-label="${escape(plot.title)}"><defs><clipPath id="local-function-clip"><rect x="${left}" y="${top}" width="${width}" height="${height}"/></clipPath></defs><g class="grid">${grid}</g><line class="axis" x1="${left}" y1="${number(axisY)}" x2="${right}" y2="${number(axisY)}"/><line class="axis" x1="${number(axisX)}" y1="${top}" x2="${number(axisX)}" y2="${bottom}"/><g clip-path="url(#local-function-clip)">${paths}${points}</g><text x="${right}" y="${bottom + 37}" text-anchor="end" fill="#50675a" font-size="13">${escape(plot.xLabel)}</text><text x="${left}" y="15" fill="#50675a" font-size="13">${escape(plot.yLabel)}</text></svg>
${renderTeachingRange({label:`调整 ${plot.variable}：`,ariaLabel:`调整${plot.variable}`,marker:'data-x',min:0,max:steps,step:1,value:initialIndex})}<p data-readout aria-live="polite">${readouts}</p><p class="note" data-range-note aria-live="polite"></p>${renderTeachingReset()}</div>
${renderTeachingCaveat(design.caveat,{suffix:' 坐标和读数由同一表达式计算；请结合教材核对函数与适用范围。',math:true})}${renderTeachingExplanation(design.model,design.observation,true)}${renderTeachingTransfer(design.transfer,'如果题设改变定义域，先确认输入属于新的范围。',true)}</div>
<script>(function(){'use strict';const d=${source},root=document.currentScript.previousElementSibling,slider=root.querySelector('input[type=range]'),prediction=root.querySelector('[data-figure=prediction]'),feedback=root.querySelector('[data-feedback]'),points=[...root.querySelectorAll('[data-local-point]')],values=[...root.querySelectorAll('[data-readout-value]')];const fmt=n=>Number(n.toPrecision(8)).toString(),fmtX=n=>{const rounded=Number(n.toPrecision(7));return (Math.abs(n-rounded)>Math.max(1e-12,Math.abs(n)*1e-12)?'≈ ':'')+rounded};const predictionXNode=root.querySelector('[data-prediction-x]');if(predictionXNode){const text=fmtX(d.predictionX);predictionXNode.textContent=text.replace(/^≈ /,'');const relation=root.querySelector('[data-prediction-relation]');if(relation)relation.textContent=text.startsWith('≈ ')?'≈':'=';}function update(){const row=d.samples[Number(slider.value)];root.querySelector('[data-x]').textContent=fmtX(row[0]);values.forEach((value,i)=>{value.textContent=row[i+1]===null?'未定义':fmt(row[i+1])});const missing=row.slice(1).filter(y=>y===null).length,outside=row.slice(1).filter(y=>y!==null&&(y<d.ymin||y>d.ymax)).length;root.querySelector('[data-range-note]').textContent=[missing?(values.length===1?'函数在当前输入下未定义。':'部分曲线在当前输入下未定义。'):'',outside?(values.length===1?'函数值超出图示纵轴范围，标记暂不显示。':'部分函数值超出图示纵轴范围，标记暂不显示。'):''].filter(Boolean).join(' ');points.forEach((p,i)=>{const y=row[i+1],visible=y!==null&&y>=d.ymin&&y<=d.ymax;p.style.display=visible?'':'none';if(visible){p.setAttribute('cx',d.left+(row[0]-d.xmin)/(d.xmax-d.xmin)*(d.right-d.left));p.setAttribute('cy',d.bottom-(y-d.ymin)/(d.ymax-d.ymin)*(d.bottom-d.top));}})}slider.addEventListener('input',update);root.querySelector('[data-figure=check]').addEventListener('click',()=>{if(prediction.value.trim()===''){feedback.textContent='请先输入预测值。';return}if(d.comparison){feedback.textContent=prediction.value==='same'?'预测正确。请分别观察两个输入，并结合教材解释；有限取点不能证明整个函数的对称性。':'再观察：分别把滑块调到题目中的两个输入，比较对应的输出。';return}const expected=d.predictionY,actual=Number(prediction.value);feedback.textContent=Number.isFinite(actual)&&Math.abs(actual-expected)<=Math.max(1e-12,Math.abs(expected)*0.005)?'预测正确。':'再核对：把滑块调到题目给出的输入，比较曲线位置和输出。';});root.querySelector('[data-figure=reset]').addEventListener('click',()=>{slider.value=String(d.initialIndex);prediction.value='';feedback.textContent='';update()});update()})();</script>`;
}
