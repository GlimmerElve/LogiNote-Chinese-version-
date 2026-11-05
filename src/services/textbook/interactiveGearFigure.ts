import type { FigureDesign } from './interactiveFigureDesign';
import { escapeTeachingText as escape, renderTeachingNumericPrediction, renderTeachingRange, renderTeachingReset, renderTeachingTransfer, renderTeachingBaseStyle, renderTeachingGoal, renderTeachingCaveat } from './interactiveTeachingControls';

export interface ExternalGearFacts { driverTeeth: number; drivenTeeth: number }

/** Only select the deterministic diagram when both roles and tooth counts are
 * explicit and unambiguous in this lesson. Never infer a ratio from examples. */
export function extractExternalGearFacts(text: string): ExternalGearFacts | undefined {
  if (!/外啮合/u.test(text) || !/齿轮/u.test(text) || /(内啮合|齿条|行星齿轮|惰轮)/u.test(text)) return undefined;
  const read = (role: string): number | undefined => {
    const pattern = new RegExp(`(?:${role})(?:齿轮|轮)?[^\\d\\n。；，,;]{0,12}(\\d{1,3})\\s*齿`, 'gu');
    const values = [...text.matchAll(pattern)].map(match => Number(match[1]));
    const unique = [...new Set(values)];
    return unique.length === 1 && unique[0] >= 6 && unique[0] <= 300 ? unique[0] : undefined;
  };
  const driverTeeth = read('主动'), drivenTeeth = read('从动');
  return driverTeeth && drivenTeeth ? { driverTeeth, drivenTeeth } : undefined;
}

export function wantsLocalGearFigure(brief: string, lesson: string, renderer: string, wholePage = false): ExternalGearFacts | undefined {
  if (renderer !== 'svg-2d' || wholePage || !/齿轮/u.test(brief) || /(三维|3d|内啮合|齿条|行星|惰轮)/iu.test(brief)) return undefined;
  return extractExternalGearFacts(lesson);
}

export const INTERACTIVE_GEAR_PROMPT = '为教材设计理想外啮合齿轮教学图，只输出 JSON {"design":{"anchor":"教材原句","goal":"理解目标","action":"操作","observation":"可观察结果","model":"明确关系","prediction":"预测问题","caveat":"依据和边界","transfer":"迁移问题"}}。本地程序按材料中的主动轮和从动轮齿数绘制接触的节圆、计算转向与转数，并生成固定的预测题。请围绕这一模型写简洁教学目标和迁移问题；不生成HTML或代码，不编造资料中没有的物理条件。';
const number = (value: number) => Number(value.toPrecision(8)).toString();

export function buildInteractiveGearFigure(facts: ExternalGearFacts, design: FigureDesign): string {
  const { driverTeeth, drivenTeeth } = facts;
  if (![driverTeeth, drivenTeeth].every(n => Number.isInteger(n) && n >= 6 && n <= 300)) throw Error('齿轮齿数无效');
  const max = Math.max(driverTeeth, drivenTeeth), r1 = 110 * driverTeeth / max, r2 = 110 * drivenTeeth / max;
  const x1 = 320 - (r1 + r2) / 2, x2 = x1 + r1 + r2, y = 135;
  const source = JSON.stringify({ driverTeeth, drivenTeeth, x1, x2, y, r1, r2 }).replace(/</gu, '\\u003c');
  return `<div class="local-gear" data-local-gear="true">${renderTeachingBaseStyle('local-gear')}<style>
.local-gear svg{display:block;width:100%;height:auto}.local-gear input[type=range]{width:100%;accent-color:#386c50}.local-gear output{font-weight:600}
</style><h2>外啮合齿轮：转向与转数</h2>${renderTeachingGoal(design.goal)}<p>先预测，再将主动轮调到 1 圈，比较两轮的转向和读数。</p>
${renderTeachingNumericPrediction('先预测：主动轮顺时针转 1 圈，从动轮转多少圈？','输入预测圈数')}
<div class="panel"><svg viewBox="0 0 640 280" role="img" aria-label="两个相切的齿轮节圆示意"><circle data-gear="driver" cx="${number(x1)}" cy="${y}" r="${number(r1)}" fill="#d9efe2" stroke="#2f6b4f" stroke-width="2"/><circle data-gear="driven" cx="${number(x2)}" cy="${y}" r="${number(r2)}" fill="#eef8f1" stroke="#568c6d" stroke-width="2"/><line data-spoke="driver" x1="${number(x1)}" y1="${y}" x2="${number(x1)}" y2="${number(y-r1*.8)}" stroke="#245b40" stroke-width="3"/><line data-spoke="driven" x1="${number(x2)}" y1="${y}" x2="${number(x2)}" y2="${number(y-r2*.8)}" stroke="#568c6d" stroke-width="3"/><circle cx="${number(x1+r1)}" cy="${y}" r="4" fill="#ba6b65"/><text x="${number(x1)}" y="260" text-anchor="middle" fill="#245b40">主动轮 ${driverTeeth} 齿</text><text x="${number(x2)}" y="260" text-anchor="middle" fill="#245b40">从动轮 ${drivenTeeth} 齿</text></svg>
${renderTeachingRange({label:'主动轮顺时针转数：',ariaLabel:'调整主动轮转数',marker:'data-driver',min:0,max:3,step:.25,value:0,initialText:'0',suffix:' 圈'})}<p>从动轮逆时针：<output data-driven>0</output> 圈</p>${renderTeachingReset()}</div>
${renderTeachingCaveat(design.caveat,{prefix:'理想外啮合示意：节圆相切，齿数比决定转数比；假设同模数并忽略滑动、摩擦与间隙，不代表真实齿形。'})}${renderTeachingTransfer(design.transfer)}</div>
<script>(function(){'use strict';const d=${source},root=document.querySelector('.local-gear'),slider=root.querySelector('input[type=range]'),prediction=root.querySelector('[data-figure=prediction]'),feedback=root.querySelector('[data-feedback]');const fmt=n=>Number(n.toPrecision(8)).toString();function update(){const n=Number(slider.value),driven=n*d.driverTeeth/d.drivenTeeth;root.querySelector('[data-driver]').textContent=fmt(n);root.querySelector('[data-driven]').textContent=fmt(driven);root.querySelector('[data-spoke=driver]').setAttribute('transform','rotate('+(n*360)+' '+d.x1+' '+d.y+')');root.querySelector('[data-spoke=driven]').setAttribute('transform','rotate('+(-driven*360)+' '+d.x2+' '+d.y+')')}slider.addEventListener('input',update);root.querySelector('[data-figure=check]').addEventListener('click',()=>{if(prediction.value.trim()===''){feedback.textContent='请先输入预测圈数。';return}const expected=d.driverTeeth/d.drivenTeeth,actual=Number(prediction.value);feedback.textContent=Number.isFinite(actual)&&Math.abs(actual-expected)<=Math.max(1e-9,Math.abs(expected)*0.005)?'预测正确，从动轮逆时针转 '+fmt(expected)+' 圈。':'再核对：先把主动轮调到 1 圈，观察从动轮的转数与转向。'});root.querySelector('[data-figure=reset]').addEventListener('click',()=>{slider.value='0';prediction.value='';feedback.textContent='';update()});update()})();</script>`;
}
