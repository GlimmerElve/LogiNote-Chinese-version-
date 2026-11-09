import type { FigureDesign } from '../../src/services/textbook/interactiveFigureDesign';

/** Synthetic executable fixtures, not model output or evidence of teaching efficacy. */
export interface InteractiveTeachingModeFixture {
  id: string;
  mode: 'dynamic' | 'step' | 'contrast';
  title: string;
  brief: string;
  objective: string;
  lesson: string;
  design: FigureDesign;
  html: string;
}

const dynamicBrief = '动态演示小车在两秒内匀速运动，允许播放、暂停和定位中间时刻。';
const stepBrief = '逐步观察队列依次入队A、入队B、出队A，追踪每一步的当前状态。';
const contrastBrief = '比较同一串材料的逐项记录与按类别组织，共用相同输入，不判定哪一种解释唯一正确。';
const common = { caveat: '合成教学示例，不代表实验观测或模型生成质量。', prediction: '此演示不安排预测题。', transfer: '改变输入后，说明哪些条件保持不变。' };

export const INTERACTIVE_TEACHING_MODE_FIXTURES: readonly InteractiveTeachingModeFixture[] = [
  {
    id: 'dynamic-car', mode: 'dynamic', title: '暂停观察匀速运动', brief: dynamicBrief,
    objective: '把连续时间、位置读数和画面中的位置联系起来，能暂停并检查中间状态。',
    lesson: '合成运动模型：小车从位置0米出发，以1米每秒匀速前进，观察时间为0到2秒；位置等于时间乘以速度。',
    design: { ...common, kind: 'general', teachingMode: 'dynamic', anchor: dynamicBrief, goal: '观察时间与位置的对应关系', action: '播放、暂停或移动时间滑块', observation: '位置读数与小车位置同步改变', model: '速度恒为1米每秒，位置x=t米，0≤t≤2秒。' },
    html: `<section data-figure-mode="dynamic" data-figure-theme-aware="true">
<h2>暂停观察匀速运动</h2><p>播放后观察小车与位置读数，随时暂停检查中间时刻；也可直接拖动时间滑块。</p>
<svg viewBox="0 0 560 110" role="img" aria-label="0至2米直线轨道上的小车" style="width:100%;max-width:680px"><line x1="30" y1="50" x2="530" y2="50" stroke="#75877b"/><circle id="car" data-car cx="30" cy="50" r="10" fill="#287b59"/><text x="25" y="90">0米</text><text x="275" y="90">1米</text><text x="505" y="90">2米</text></svg>
<p><button data-figure="play">播放</button> <button data-figure="pause">暂停</button> <button data-figure="reset">重置</button></p>
<label>时间（秒）<input data-figure="time" type="range" min="0" max="2" step="0.01" value="0"></label>
<output data-figure="result" aria-live="polite">时间0.00秒，位置0.00米。</output><p>同一状态驱动画面、滑块和数值；到2秒停止。减少动态效果时可直接定位观察。</p>
<script>(function(){const root=document.currentScript.closest('section'),clock=window.TeachingClock,car=root.querySelector('[data-car]'),time=root.querySelector('[data-figure="time"]'),result=root.querySelector('[data-figure="result"]');let t=0;function draw(){time.value=String(t);car.setAttribute('cx',String(30+250*t));car.setAttribute('data-position',String(t));result.textContent='时间'+t.toFixed(2)+'秒，位置'+t.toFixed(2)+'米。'}function advance(dt){t=Math.min(2,t+dt);draw();return t<2;}root.querySelector('[data-figure="play"]').onclick=function(){if(t>=2)return;clock.start(advance)};root.querySelector('[data-figure="pause"]').onclick=function(){clock.pause()};root.querySelector('[data-figure="reset"]').onclick=function(){clock.pause();t=0;draw()};time.oninput=function(){clock.pause();t=Number(time.value);draw()};document.addEventListener('visibilitychange',function(){clock.setVisible(!document.hidden)});draw()})();</script></section>`,
  },
  {
    id: 'step-queue', mode: 'step', title: '追踪队列的三次操作', brief: stepBrief,
    objective: '区分操作前后的队列状态，并说明先进先出的作用。',
    lesson: '合成队列初始为空。操作顺序固定为入队A、入队B、出队一次；出队删除最早进入的A，最终剩B。',
    design: { ...common, kind: 'process', teachingMode: 'step', anchor: stepBrief, goal: '理解先进先出的状态转移', action: '点击下一步，依次执行三次操作', observation: '队列从空变A、A和B、最后只剩B', model: '入队从队尾添加；出队从队首删除。第三步结束后不再推进。' },
    html: `<section data-figure-mode="step" data-figure-theme-aware="true"><h2>追踪队列的三次操作</h2><p>先读当前队列，再逐步执行操作；每次只改变一个状态。</p>
<div data-figure="visual" style="display:flex;gap:12px;padding:16px"><span>队首 →</span><span id="queue-items">空队列</span><span>← 队尾</span></div>
<p data-figure="state">第0/3步：初始为空。</p><button data-figure="step">下一步</button> <button data-figure="reset">重置</button>
<output data-figure="result" aria-live="polite">队列为空，尚未执行操作。</output><p>解释：入队不会改变已经进入的先后关系；出队先删除最早进入的元素。</p>
<script>(function(){const root=document.currentScript.closest('section'),next=root.querySelector('[data-figure="step"]'),state=root.querySelector('[data-figure="state"]'),result=root.querySelector('[data-figure="result"]'),items=root.querySelector('#queue-items');const phases=[{queue:[],action:'初始为空'},{queue:['A'],action:'入队A'},{queue:['A','B'],action:'入队B'},{queue:['B'],action:'出队A'}];let index=0;function draw(){const current=phases[index];items.textContent=current.queue.join(' → ')||'空队列';items.dataset.queue=current.queue.join(',');state.textContent='第'+index+'/3步：'+current.action+'。';result.textContent=index===3?'三次操作完成；A最早进入，先被删除，剩余B。':index===0?'队列为空，尚未执行操作。':'已执行'+current.action+'，当前队列：'+current.queue.join('、')+'。';next.disabled=index===3;}next.onclick=function(){if(index<3){index++;draw()}};root.querySelector('[data-figure="reset"]').onclick=function(){index=0;draw()};draw()})();</script></section>`,
  },
  {
    id: 'contrast-organization', mode: 'contrast', title: '用两种方式组织同一材料', brief: contrastBrief,
    objective: '在输入相同时比较两种组织方式，能描述差异而不把示意当作理论真伪证明。',
    lesson: '合成材料依次为A、A、B、B、C、C。逐项记录保留出现顺序；按类别组织把相同字母放在一组。两种方式使用同一批材料，没有遗漏或增加。这里只比较表征，不证明心理理论。',
    design: { ...common, kind: 'comparison', teachingMode: 'contrast', anchor: contrastBrief, goal: '在相同输入下比较两种表征', action: '改变参与对照的材料数量', observation: '同一批材料分别保留顺序或按类别组织', model: '输入取固定材料序列的前n项；左侧按顺序展示，右侧按字母分类。没有唯一优胜解释。' },
    html: `<section data-figure-mode="contrast" data-figure-theme-aware="true"><h2>用两种方式组织同一材料</h2><p>共同输入始终取序列A、A、B、B、C、C的前几项；比较两种呈现各保留了什么。</p>
<label>材料数量<input data-shared-input type="range" min="2" max="6" step="1" value="4"></label>
<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px">
<article data-figure="case"><h3>逐项记录</h3><div data-figure="visual"><span>出现顺序：</span><strong id="ordered">A A B B</strong></div><p>保留输入顺序，便于追踪每次出现。</p></article>
<article data-figure="case"><h3>按类别组织</h3><div data-figure="visual"><span>类别分组：</span><strong id="grouped">A:2 | B:2</strong></div><p>保留同类数量，便于比较类别。</p></article></div>
<button data-figure="reset">重置</button><output data-figure="result" aria-live="polite">共同输入4项；两种表征没有改变材料本身。</output><p>这是表征方式的定性对照，不把某一种组织方式预设为唯一正确解释。</p>
<script>(function(){const root=document.currentScript.closest('section'),input=root.querySelector('[data-shared-input]'),ordered=root.querySelector('#ordered'),grouped=root.querySelector('#grouped'),result=root.querySelector('[data-figure="result"]'),source=['A','A','B','B','C','C'];function draw(){const n=Number(input.value),items=source.slice(0,n),counts={};for(const value of items)counts[value]=(counts[value]||0)+1;ordered.textContent=items.join(' ');grouped.textContent=Object.keys(counts).map(function(key){return key+':'+counts[key]}).join(' | ');result.textContent='共同输入'+n+'项；两种表征没有改变材料本身。'}input.oninput=draw;root.querySelector('[data-figure="reset"]').onclick=function(){input.value='4';draw()};draw()})();</script></section>`,
  },
];
