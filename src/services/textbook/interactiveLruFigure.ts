import type { FigureDesign } from './interactiveFigureDesign';
import { escapeTeachingText as escape, renderTeachingPrediction, renderTeachingReset, renderTeachingTransfer, renderTeachingBaseStyle, renderTeachingGoal, renderTeachingCaveat } from './interactiveTeachingControls';

export interface LruFacts { initial: string[] }
/** Only use explicit, unambiguous most-recent-first examples from the lesson. */
export function extractLruFacts(text: string): LruFacts | undefined {
  if (!/\bLRU\b/iu.test(text)) return undefined;
  if (!/(?<![未不])命中[^。\n]{0,50}(?:最近使用|最近|最前)/u.test(text)
    || !/未命中[^。\n]{0,50}淘汰[^。\n]{0,20}(?:最久|最少使用)/u.test(text)
    || /(?:不|不会|无需)淘汰/u.test(text)) return undefined;
  const pattern = /初始(?:缓存)?(?:顺序|排列)?[^。\n]{0,40}?(?:为|是|[:：])\s*([A-Z](?:\s*[、,，]\s*[A-Z]){1,4})(?!\s*[、,，]\s*[A-Z])/gu;
  const matches = [...text.matchAll(pattern)];
  const orders = matches.map(match => match[1].split(/[、,，]/u).map(item => item.trim()));
  if (!orders.length || orders.some(order => new Set(order).size !== order.length)) return undefined;
  for (const match of matches) {
    const start = Math.max(text.lastIndexOf('。', match.index - 1), text.lastIndexOf('\n', match.index - 1), text.lastIndexOf('；', match.index - 1)) + 1;
    const tail = text.slice(match.index + match[0].length).search(/[。\n；]/u);
    const end = tail < 0 ? text.length : match.index + match[0].length + tail;
    const sentence = text.slice(start, end);
    if (!/(最近到最久|最近使用到最久|最近使用至最久|从最近[^。\n]{0,12}最久)/u.test(sentence) || /(最久到最近|从最久[^。\n]{0,12}最近)/u.test(sentence)) return undefined;
  }
  const unique = [...new Set(orders.map(order => order.join(',')))];
  if (unique.length !== 1) return undefined;
  const initial = orders[0];
  const capacities = [...text.matchAll(/(?:容量(?:为|是)?\s*([2-5])\s*(?:个)?(?:槽|项|条目)|([二三四五])槽)/gu)]
    .map(match => match[1] ? Number(match[1]) : ({ 二:2, 三:3, 四:4, 五:5 } as Record<string, number>)[match[2]]);
  if (capacities.some(capacity => capacity !== initial.length)) return undefined;
  return { initial };
}
export function wantsLocalLruFigure(brief: string, lesson: string, renderer: string, wholePage = false): LruFacts | undefined {
  if (renderer !== 'svg-2d' || wholePage || !/(缓存|LRU)/iu.test(brief) || !/(命中|淘汰|访问|顺序|替换)/u.test(brief) || /(三维|3d)/iu.test(brief)) return undefined;
  return extractLruFacts(lesson);
}
export const INTERACTIVE_LRU_PROMPT = '为教材设计LRU缓存交互图，只输出JSON {"design":{"anchor":"教材原句","goal":"理解目标","action":"操作","observation":"可观察结果","model":"明确规则","prediction":"预测问题","caveat":"依据和边界","transfer":"迁移问题"}}。本地程序按资料中明确的初始顺序模拟缓存命中和淘汰，并生成固定预测题；请围绕这个例子写简洁目标与迁移问题，不输出HTML或代码，不编造资料中没有的运行数据。';

export function buildInteractiveLruFigure(facts: LruFacts, design: FigureDesign): string {
  const initial = facts.initial;
  if (!Array.isArray(initial) || initial.length < 2 || initial.length > 5 || initial.some(x => !/^[A-Z]$/u.test(x)) || new Set(initial).size !== initial.length) throw Error('缓存初始状态无效');
  const target = initial[1], expected = [target, initial[0], ...initial.slice(2)];
  const choices = [...new Set([initial.join('、'), expected.join('、'), [...initial].reverse().join('、')])];
  const added = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').find(item => !initial.includes(item))!;
  const buttons = [...initial, added].map(item => `<button type="button" data-access="${item}">访问 ${item}${item === added ? '（新增示例）' : ''}</button>`).join('');
  const options = choices.map(item => ({value:item,label:item}));
  const data = JSON.stringify({ initial, target, expected: expected.join('、') }).replace(/</gu, '\\u003c');
  return `<div class="local-lru" data-local-lru="true">${renderTeachingBaseStyle('local-lru')}<style>
.local-lru .slots{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0}.local-lru .slot{min-width:58px;padding:12px;border:1px solid #9abca5;border-radius:8px;text-align:center;background:#f3f8f4}.local-lru .slot:first-child{border:2px solid #386c50;background:#e5f3e9}.local-lru .actions{display:flex;gap:8px;flex-wrap:wrap}
</style><h2>LRU 缓存：访问与淘汰</h2>${renderTeachingGoal(design.goal)}<p>顺序从最近使用到最久未使用。先预测，再访问 ${target}，比较操作前后的顺序。</p>
${renderTeachingPrediction(`先预测：初始顺序为 ${initial.join('、')}，访问 ${target} 后顺序是什么？`,options,'选择预测顺序')}
<div class="panel"><p>当前顺序：最近使用 → 最久未使用</p><div class="slots" data-figure="visual" aria-label="缓存顺序"></div><div class="actions">${buttons}${renderTeachingReset()}</div><p data-event aria-live="polite"></p></div>
${renderTeachingCaveat(design.caveat,{prefix:'按资料中的初始顺序演示 LRU；新增示例只用于观察淘汰，不代表实测数据。'})}${renderTeachingTransfer(design.transfer)}</div>
<script>(function(){'use strict';const d=${data},root=document.querySelector('.local-lru'),slots=root.querySelector('.slots'),prediction=root.querySelector('[data-figure=prediction]'),feedback=root.querySelector('[data-feedback]'),event=root.querySelector('[data-event]');let order=d.initial.slice();function render(){slots.replaceChildren();order.forEach((item,i)=>{const el=document.createElement('span');el.className='slot';el.textContent=item;el.setAttribute('aria-label',item+(i===0?' 最近使用':i===order.length-1?' 最久未使用':''));slots.appendChild(el)})}function access(item){const index=order.indexOf(item);if(index>=0){order.splice(index,1);order.unshift(item);event.textContent='命中 '+item+'，移到最近使用位置。'}else{const evicted=order.pop();order.unshift(item);event.textContent='未命中 '+item+'，淘汰最久未使用的 '+evicted+'。'}render()}root.querySelectorAll('[data-access]').forEach(button=>button.addEventListener('click',()=>access(button.dataset.access)));root.querySelector('[data-figure=check]').addEventListener('click',()=>{feedback.textContent=!prediction.value?'请先选择预测顺序。':prediction.value===d.expected?'预测正确。':'再核对：先重置，再访问 '+d.target+'，比较操作前后的顺序。'});root.querySelector('[data-figure=reset]').addEventListener('click',()=>{order=d.initial.slice();prediction.value='';feedback.textContent='';event.textContent='';render()});render()})();</script>`;
}
