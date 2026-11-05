import type { FigureDesign } from './interactiveFigureDesign';
import { renderTeachingPrediction, renderTeachingRange, renderTeachingReset, renderTeachingTransfer, renderTeachingBaseStyle, renderTeachingGoal, renderTeachingCaveat } from './interactiveTeachingControls';

export type ThresholdSample = { id: string; score: number; positive: boolean };
export function thresholdCounts(samples: ThresholdSample[], threshold: number) {
  return { falsePositive: samples.filter(s => !s.positive && s.score >= threshold).length,
    falseNegative: samples.filter(s => s.positive && s.score < threshold).length,
    positives: samples.filter(s => s.positive).length, negatives: samples.filter(s => !s.positive).length };
}
/** A local model is used only for an explicit binary rule and explicit samples. */
export function extractThresholdSamples(text: string): ThresholdSample[] | undefined {
  if (/(?:不|不会|不应|不能|并非|未)\s*判(?:为)?正/u.test(text)) return;
  if (!/分数[^。\n]{0,30}(?:大于或等于|不小于|≥|>=)[^。\n]{0,20}阈值[^。\n]{0,20}(?:判为?正|正类)/u.test(text)) return;
  const matches = [...text.matchAll(/\b([A-Z])\s*[=＝]\s*[(（]\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*[,，、]\s*(正|负)\s*[)）]/gu)];
  const described = [...text.matchAll(/\b([A-Z])\s*(?:的)?\s*[:：]?\s*分数\s*(?:为|是|[=＝:：])?\s*(0(?:\.\d+)?|1(?:\.0+)?)\s*[,，、;；]\s*(?:真实)?(?:标签|类别)\s*(?:为|是|[=＝:：])?\s*(正|负)(?:类)?/gu)];
  const samples = [...matches,...described].map(m => ({id:m[1],score:Number(m[2]),positive:m[3] === '正'}));
  if (samples.length < 2 || samples.length > 12 || new Set(samples.map(s=>s.id)).size !== samples.length || !samples.some(s=>s.positive) || !samples.some(s=>!s.positive)) return;
  return samples;
}
export function wantsLocalThresholdFigure(brief: string, lesson: string, renderer: string, wholePage = false) {
  if (wholePage || renderer !== 'svg-2d' || !/阈值/u.test(brief) || !/(误报|漏报|分类)/u.test(brief)) return;
  return extractThresholdSamples(lesson);
}
export const INTERACTIVE_THRESHOLD_PROMPT = '为分类阈值教学图设计说明，只输出 JSON {"design":{"anchor":"教材原句","goal":"教学目标","action":"操作","observation":"观察","model":"规则","prediction":"预测","caveat":"边界","transfer":"迁移问题"}}。本地程序用资料明确提供的样本和分数≥阈值判正规则计算误报漏报，自动提供阈值 0.5 与 0.3 的示例预测；数量没有分母。若讨论误报率或漏报率，分别以真实负例数和真实正例数为分母，不把总样本数当成两者分母。不要输出 HTML、代码或编造样本。';
/** A count has no denominator; avoid publishing an internally conflicting
 * generated transfer question. Questions about rates alone remain untouched. */
export function thresholdTransferQuestion(text: string): string {
  return /(?:误报|漏报)[^。！？?]{0,30}(?:计数|数量|几个|多少个)[^。！？?]{0,40}分母/u.test(text)
    ? '将阈值调到 0.7，分别有几个误报和漏报？如果要计算误报率和漏报率，各应以哪类样本的数量为分母？' : text;
}
export function buildInteractiveThresholdFigure(samples: ThresholdSample[], design: FigureDesign): string {
  if (!Array.isArray(samples) || samples.length < 2 || samples.length > 12 || samples.some(s=>!s || !/^[A-Z]$/u.test(s.id) || !Number.isFinite(s.score) || s.score < 0 || s.score > 1 || typeof s.positive !== 'boolean') || new Set(samples.map(s=>s.id)).size !== samples.length || !samples.some(s=>s.positive) || !samples.some(s=>!s.positive)) throw Error('分类样本无效');
  const before=thresholdCounts(samples,.5), after=thresholdCounts(samples,.3);
  const choices=[`${after.falsePositive},${after.falseNegative}`,`${before.falsePositive},${before.falseNegative}`];
  for(let fp=0;fp<=before.negatives && choices.length<4;fp++) for(let fn=0;fn<=before.positives && choices.length<4;fn++) { const value=`${fp},${fn}`; if(!choices.includes(value)) choices.push(value); }
  choices.sort((a,b)=>{const [ap,an]=a.split(',').map(Number),[bp,bn]=b.split(',').map(Number);return ap-bp||an-bn});
  const options=[...new Set(choices)].map(value=>{const [fp,fn]=value.split(',');return {value,label:`误报 ${fp}，漏报 ${fn}`}});
  const data=JSON.stringify({samples,answer:`${after.falsePositive},${after.falseNegative}`}).replace(/</gu,'\\u003c');
  return `<div class="local-threshold" data-local-threshold="true">${renderTeachingBaseStyle('local-threshold')}<style>.local-threshold svg{display:block;width:100%;height:auto}.local-threshold input[type=range]{width:100%;accent-color:#386c50}</style><h2>分类阈值：误报与漏报</h2>${renderTeachingGoal(design.goal)}${renderTeachingPrediction('示例预测：阈值从 0.5 降到 0.3 后，误报和漏报各有几个？',options)}<div class="panel">${renderTeachingRange({label:'阈值：',ariaLabel:'分类阈值',marker:'data-threshold',min:0,max:1,step:.01,value:.5,initialText:'0.50'})}<p>规则：分数 ≥ 阈值判正。绿色表示真实正类，红色表示真实负类。</p><svg viewBox="0 0 640 120" role="img" aria-label="样本分数及分类阈值"><line x1="40" y1="70" x2="600" y2="70" stroke="#82988a"/><line data-boundary y1="25" y2="90" stroke="#315d49" stroke-width="2"/><g data-points></g><text x="40" y="110">0</text><text x="590" y="110">1</text></svg><p>误报数（负类判正）：<strong data-fp></strong> 个（真实负类共 ${before.negatives} 个）；漏报数（正类判负）：<strong data-fn></strong> 个（真实正类共 ${before.positives} 个）。</p><p data-detail aria-live="polite"></p>${renderTeachingReset()}</div>${renderTeachingCaveat(design.caveat,{prefix:'0.5 和 0.3 是用于观察的示例阈值。'})}${renderTeachingTransfer(thresholdTransferQuestion(design.transfer))}</div><script>(function(){const root=document.currentScript.previousElementSibling,d=${data},slider=root.querySelector('input[type=range]'),points=root.querySelector('[data-points]'),p=root.querySelector('[data-figure=prediction]'),feedback=root.querySelector('[data-feedback]');function update(){const t=Number(slider.value),fp=d.samples.filter(s=>!s.positive&&s.score>=t),fn=d.samples.filter(s=>s.positive&&s.score<t);root.querySelector('[data-threshold]').textContent=t.toFixed(2);root.querySelector('[data-fp]').textContent=String(fp.length);root.querySelector('[data-fn]').textContent=String(fn.length);root.querySelector('[data-detail]').textContent='误报：'+(fp.map(s=>s.id).join('、')||'无')+'；漏报：'+(fn.map(s=>s.id).join('、')||'无');root.querySelector('[data-boundary]').setAttribute('x1',String(40+560*t));root.querySelector('[data-boundary]').setAttribute('x2',String(40+560*t));points.replaceChildren();d.samples.forEach((s,i)=>{const n=document.createElementNS('http://www.w3.org/2000/svg','circle');n.setAttribute('cx',String(40+560*s.score));n.setAttribute('cy',String(42+(i%3)*14));n.setAttribute('r','6');n.setAttribute('fill',s.positive?'#2f8059':'#bd6662');const title=document.createElementNS('http://www.w3.org/2000/svg','title');title.textContent=s.id+'：'+s.score+'，真实'+(s.positive?'正':'负')+'类';n.appendChild(title);points.appendChild(n)})}slider.addEventListener('input',update);root.querySelector('[data-figure=check]').addEventListener('click',()=>{feedback.textContent=!p.value?'请先选择预测。':p.value===d.answer?'预测正确。':'再试试将阈值调到 0.3，观察误报和漏报。'});root.querySelector('[data-figure=reset]').addEventListener('click',()=>{slider.value='0.5';p.value='';feedback.textContent='';update()});update()})()</script>`;
}
