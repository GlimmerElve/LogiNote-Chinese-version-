import type { FigureDesign } from './interactiveFigureDesign';
import { renderTeachingPrediction, renderTeachingSelect, renderTeachingReset, renderTeachingTransfer, renderTeachingBaseStyle, renderTeachingGoal, renderTeachingCaveat } from './interactiveTeachingControls';

export function extractCoinProbability(text: string): number | undefined {
  // A negated or explicitly unknown fairness statement is not evidence of p=.5.
  if (/(?:不|非|并非|不是|未必|不一定|不能确定|无法确定)[^。\n]{0,6}公平(?:的)?(?:硬币|钱币)/u.test(text)
    || /公平(?:的)?(?:硬币|钱币)[^。\n]{0,12}(?:不成立|不确定|未知)/u.test(text)) return;
  const fair = /公平(?:的)?(?:硬币|钱币)/u.test(text);
  if (/(?:正面(?:朝上)?(?:的)?概率|出现正面的概率)\s*(?:为|是|等于|[=＝:：])\s*\d+(?:\.\d+)?\s*%?\s*(?:或|至|到|~|～)\s*\d/u.test(text)) return;
  const matches = [...text.matchAll(/(?:正面(?:朝上)?(?:的)?概率|出现正面的概率)\s*(?:为|是|等于|[=＝:：])\s*((?:\d+(?:\.\d+)?)\s*%|0(?:\.\d+)?|1(?:\.0+)?)(?![\d.%])/gu)];
  // An explicitly stated but unsupported probability must not be silently
  // discarded in favor of another sentence's fair-coin assumption.
  const declarations = [...text.matchAll(/(?:正面(?:朝上)?(?:的)?概率|出现正面的概率)\s*(?:为|是|等于|[=＝:：])/gu)];
  if (declarations.length !== matches.length) return;
  const values = matches.map(m => m[1].includes('%') ? Number(m[1].replace('%',''))/100 : Number(m[1]));
  if (fair) values.push(.5);
  if (!values.length || values.some(v=>!Number.isFinite(v)||v<=0||v>=1) || new Set(values).size!==1) return;
  return values[0];
}
export function wantsLocalProbabilityFigure(brief:string,lesson:string,renderer:string,wholePage=false): number | undefined {
  const probabilityGoal = /(概率|抽样|随机|次数|样本)/u.test(brief)
    || (/(正面|反面|抛|投掷|出现)/u.test(brief) && /(比例|频率|频数)/u.test(brief));
  if (wholePage || renderer!=='svg-2d' || !/(硬币|抛硬币|投币)/u.test(brief) || !probabilityGoal) return;
  return extractCoinProbability(lesson);
}
export const INTERACTIVE_PROBABILITY_PROMPT='为硬币随机抽样教学图设计说明，只输出 JSON {"design":{"anchor":"教材原句","goal":"目标","action":"操作","observation":"观察","model":"概率模型","prediction":"预测","caveat":"边界","transfer":"迁移"}}。本地程序按资料明确给出的正面概率运行可复现的模拟，区分理论概率、期望次数与实际样本；不要输出 HTML、脚本或捏造实验结果。';
export function buildInteractiveProbabilityFigure(probability:number,design:FigureDesign):string {
  if (!Number.isFinite(probability)||probability<=0||probability>=1) throw Error('概率必须在 0 和 1 之间');
  const data=JSON.stringify({probability}).replace(/</gu,'\\u003c');
  return `<div class="local-probability" data-local-probability="true">${renderTeachingBaseStyle('local-probability')}<style>.local-probability .bars{display:flex;align-items:end;gap:20px;min-height:150px}.local-probability .bar{width:90px;min-height:5px;background:#65a780;border-radius:6px 6px 0 0}.local-probability .bar:last-child{background:#c9817b}</style><h2>硬币抽样：理论与结果</h2>${renderTeachingGoal(design.goal)}${renderTeachingPrediction('先预测：抛掷 10 次时，正面次数一定等于期望次数吗？',[{value:'yes',label:'一定相等'},{value:'no',label:'不一定相等'}])}<div class="panel"><p>理论正面概率：<strong data-probability></strong></p>${renderTeachingSelect({label:'每次抽样次数：',marker:'data-sample-size',options:[{value:'10',label:'10'},{value:'50',label:'50'},{value:'100',label:'100'}]})} <button data-sample>抽样一次</button> ${renderTeachingReset()}<p>期望正面次数：<strong data-expected></strong>；实际正面次数：<strong data-heads></strong>；反面次数：<strong data-tails></strong></p><div class="bars" data-figure="visual" aria-label="正反面样本计数"><div class="bar" data-head-bar title="正面"></div><div class="bar" data-tail-bar title="反面"></div></div><p data-result aria-live="polite">尚未抽样</p></div>${renderTeachingCaveat(design.caveat,{prefix:'这是基于各次投掷相互独立的假设、依据给定概率生成的可复现模拟，并非真实投掷记录；一次样本不能证明一般规律。'})}${renderTeachingTransfer(design.transfer)}</div><script>(function(){const root=document.currentScript.previousElementSibling,d=${data},size=root.querySelector('[data-sample-size]'),pred=root.querySelector('[data-figure=prediction]');let seed=123456789;function next(){seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/4294967296}function blank(){root.querySelector('[data-expected]').textContent=String(Number((Number(size.value)*d.probability).toPrecision(6)));root.querySelector('[data-heads]').textContent='—';root.querySelector('[data-tails]').textContent='—';root.querySelector('[data-result]').textContent='尚未抽样';root.querySelector('[data-head-bar]').style.height='5px';root.querySelector('[data-tail-bar]').style.height='5px'}root.querySelector('[data-probability]').textContent=String(d.probability);size.addEventListener('change',blank);root.querySelector('[data-sample]').addEventListener('click',()=>{const n=Number(size.value);let heads=0;for(let i=0;i<n;i++)if(next()<d.probability)heads++;const tails=n-heads;root.querySelector('[data-heads]').textContent=String(heads);root.querySelector('[data-tails]').textContent=String(tails);root.querySelector('[data-head-bar]').style.height=Math.max(5,heads/n*130)+'px';root.querySelector('[data-tail-bar]').style.height=Math.max(5,tails/n*130)+'px';root.querySelector('[data-result]').textContent='正面 '+heads+' 次，反面 '+tails+' 次；样本比例 '+(heads/n*100).toFixed(1)+'%。'});root.querySelector('[data-figure=check]').addEventListener('click',()=>{root.querySelector('[data-feedback]').textContent=!pred.value?'请先选择预测。':pred.value==='no'?'预测正确：有限样本的实际次数可能偏离期望。':'再观察几次抽样，比较实际次数与期望次数。'});root.querySelector('[data-figure=reset]').addEventListener('click',()=>{seed=123456789;size.value='10';pred.value='';root.querySelector('[data-feedback]').textContent='';blank()});blank()})()</script>`;
}
