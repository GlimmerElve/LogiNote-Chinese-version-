import { compileTextbookFunction } from '../functionPlot';
import { generatedMathMarkdown } from '../generatedMath';
import { stageFrame, escapeStageText, type TeachingStageBuild } from '../teachingStageFrame';

type AreaMethod = 'midpoint' | 'left' | 'right';
export interface AreaStageModel {
  expression: string; variable: string; domain: [number, number]; minCount: number; maxCount: number; method: AreaMethod;
  exactIntegral?: number; yDomain: [number, number]; curve: Array<[number, number]>;
  frames: Array<{ count: number; heights: number[]; sum: number; error: number | null }>;
}
export interface OscillatorStageModel { mass: number; stiffness: number; amplitude: number; phase: number; omega: number; period: number }

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw Error('科学教学组件配置无效');
  return value as Record<string, unknown>;
}
function number(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw Error(`${name}超出支持范围`);
  return value;
}
function boundedFrame(options: Parameters<typeof stageFrame>[0]): string {
  const html = stageFrame(options);
  if (html.length > 100_000) throw Error('科学教学组件超出附件大小限制');
  return html;
}

/** Validate and compile once; generated configuration never becomes script. */
export function createAreaModel(config: unknown): AreaStageModel {
  const c = object(config, ['expression', 'variable', 'domain', 'minCount', 'maxCount', 'method', 'exactIntegral']);
  if (typeof c.expression !== 'string' || typeof c.variable !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,15}$/u.test(c.variable)
    || !Array.isArray(c.domain) || c.domain.length !== 2 || !['midpoint', 'left', 'right'].includes(c.method as string)) throw Error('矩形面积配置不完整');
  const a = number(c.domain[0], -1e6, 1e6, '积分下界'), b = number(c.domain[1], -1e6, 1e6, '积分上界');
  if (b - a < 1e-9 || b - a > 1e6) throw Error('积分区间无效');
  const minCount = number(c.minCount, 1, 80, '最小分割数'), maxCount = number(c.maxCount, minCount, 80, '最大分割数');
  if (!Number.isInteger(minCount) || !Number.isInteger(maxCount)) throw Error('分割数必须为整数');
  const exactIntegral = c.exactIntegral === undefined ? undefined : number(c.exactIntegral, -1e12, 1e12, '参考积分');
  const fn = compileTextbookFunction(c.expression, c.variable);
  if (!fn.continuousOn(a, b)) throw Error('当前组件不能跨越未定义点或不连续区间绘制面积');
  const boundedValue = (x: number) => Number(number(fn.evaluate(x), -1e6, 1e6, '函数值').toPrecision(12));
  const curve: Array<[number, number]> = Array.from({ length: 201 }, (_, i) => { const x = a + (b - a) * i / 200; return [Number(x.toPrecision(12)), boundedValue(x)]; });
  let low = 0, high = 0;
  for (const [, y] of curve) { low = Math.min(low, y); high = Math.max(high, y); }
  const method = c.method as AreaMethod;
  const frames: AreaStageModel['frames'] = [];
  for (let count = minCount; count <= maxCount; count++) {
    const dx = (b - a) / count;
    const heights = Array.from({ length: count }, (_, i) => boundedValue(a + (i + (method === 'left' ? 0 : method === 'right' ? 1 : .5)) * dx));
    const sum = heights.reduce((value, height) => value + height * dx, 0);
    number(sum, -1e12, 1e12, '矩形和');
    for (const y of heights) { low = Math.min(low, y); high = Math.max(high, y); }
    frames.push({ count, heights, sum, error: exactIntegral === undefined ? null : exactIntegral - sum });
  }
  const padding = high === low ? Math.max(1, Math.abs(low) * .1) : (high - low) * .09;
  return { expression: c.expression, variable: c.variable, domain: [a, b], minCount, maxCount, method,
    ...(exactIntegral === undefined ? {} : { exactIntegral }), yDomain: [low - padding, high + padding], curve, frames };
}

export function createOscillatorModel(config: unknown): OscillatorStageModel {
  const c = object(config, ['mass', 'stiffness', 'amplitude', 'phase']);
  const mass = number(c.mass, 1e-6, 1e6, '质量'), stiffness = number(c.stiffness, 1e-6, 1e6, '劲度系数');
  const amplitude = number(c.amplitude, 0, 1e4, '振幅');
  const phase = number(c.phase === undefined ? 0 : c.phase, -1e6, 1e6, '初相位') % (2 * Math.PI);
  const omega = Math.sqrt(stiffness / mass), period = 2 * Math.PI / omega;
  number(omega * amplitude, 0, 1e9, '最大速率'); number(stiffness * amplitude, 0, 1e9, '最大回复力');
  return { mass, stiffness, amplitude, phase, omega, period };
}

export function sampleOscillatorState(model: OscillatorStageModel, time: number) {
  const t = Math.max(0, Math.min(model.period, number(time, -1e12, 1e12, '时间')));
  const angle = model.omega * t + model.phase, x = model.amplitude * Math.cos(angle);
  const velocity = -model.amplitude * model.omega * Math.sin(angle), force = -model.stiffness * x;
  return { time: t, displacement: x, velocity, force, acceleration: force / model.mass };
}

const controls = `<div class="controls"><button type="button" data-figure="play">播放</button><button type="button" data-figure="pause">暂停</button><button type="button" data-figure="step">单步</button><button type="button" data-figure="reset">重置</button></div>`;
// The progress state remains continuous; drawing an integer count never mutates it.
const areaScript = String.raw`
const q=s=>root.querySelector(s),slider=q('[data-figure="time"]'),rectangles=q('[data-rectangles]');
let progress=d.minCount,lastCount=-1,playing=false;
const L=64,R=616,TOP=26,BOTTOM=272,W=R-L,H=BOTTOM-TOP;
const X=x=>L+(x-d.domain[0])/(d.domain[1]-d.domain[0])*W,Y=y=>BOTTOM-(y-d.yDomain[0])/(d.yDomain[1]-d.yDomain[0])*H;
q('[data-curve]').setAttribute('d',d.curve.map((point,i)=>(i?'L':'M')+X(point[0])+','+Y(point[1])).join(' '));
let grid='';for(let i=0;i<=4;i++){const x=d.domain[0]+(d.domain[1]-d.domain[0])*i/4,y=d.yDomain[0]+(d.yDomain[1]-d.yDomain[0])*i/4;grid+='<line x1="'+X(x)+'" x2="'+X(x)+'" y1="'+TOP+'" y2="'+BOTTOM+'" stroke="var(--line)"/><text x="'+X(x)+'" y="296" text-anchor="middle" font-size="11">'+esc(fmt(x))+'</text><line x1="'+L+'" x2="'+R+'" y1="'+Y(y)+'" y2="'+Y(y)+'" stroke="var(--line)"/><text x="56" y="'+(Y(y)+4)+'" text-anchor="end" font-size="11">'+esc(fmt(y))+'</text>';}q('[data-grid]').innerHTML=grid;
q('[data-zero]').setAttribute('y1',Y(0));q('[data-zero]').setAttribute('y2',Y(0));
function draw(){const count=Math.max(d.minCount,Math.min(d.maxCount,Math.round(progress)));slider.value=String(count);if(count===lastCount)return;lastCount=count;const frame=d.frames[count-d.minCount],dx=(d.domain[1]-d.domain[0])/count;rectangles.innerHTML=frame.heights.map((height,i)=>{const x=X(d.domain[0]+i*dx),y=Y(height);return '<rect x="'+x+'" y="'+Math.min(Y(0),y)+'" width="'+(W/count)+'" height="'+Math.abs(Y(0)-y)+'" fill="var(--accent)" fill-opacity=".22" stroke="var(--accent)" stroke-width=".7"/>'}).join('');q('[data-count]').textContent=String(count);q('[data-area]').textContent=fmt(frame.sum);q('[data-error]').textContent=frame.error===null?'未提供参考积分':fmt(frame.error);q('[data-figure="result"]').textContent='当前分割数 '+count+'，有向矩形和约为 '+fmt(frame.sum)+(frame.error===null?'；未提供参考积分，不报告精确误差。':'；参考积分减去矩形和约为 '+fmt(frame.error)+'。');}
function stop(){playing=false;window.TeachingClock?.pause();q('[data-figure="play"]').setAttribute('aria-pressed','false');}
q('[data-figure="play"]').onclick=()=>{if(!window.TeachingClock||window.TeachingClock.reducedMotion){q('[data-motion-note]').textContent='当前不播放动画；仍可用单步和分割数滑块观察。';return}if(progress>=d.maxCount)progress=d.minCount;playing=true;q('[data-figure="play"]').setAttribute('aria-pressed','true');window.TeachingClock.start(dt=>{if(!playing)return false;progress=Math.min(d.maxCount,progress+Math.max(0,dt)*6);draw();if(progress>=d.maxCount){stop();return false}})};
q('[data-figure="pause"]').onclick=stop;q('[data-figure="step"]').onclick=()=>{stop();progress=Math.min(d.maxCount,Math.round(progress)+1);draw()};q('[data-figure="reset"]').onclick=()=>{stop();progress=d.minCount;draw()};slider.oninput=()=>{stop();progress=Number(slider.value);draw()};document.addEventListener('visibilitychange',()=>{if(document.hidden)stop()});draw();`;

const oscillatorScript = String.raw`
const q=s=>root.querySelector(s),slider=q('[data-figure="time"]');let time=0,playing=false;
const radius=d.amplitude||1,forceMax=d.stiffness*d.amplitude||1,velocityMax=d.omega*d.amplitude||1;
function state(){const angle=d.omega*time+d.phase,x=d.amplitude*Math.cos(angle),v=-d.amplitude*d.omega*Math.sin(angle),F=-d.stiffness*x;return{x,v,F,a:F/d.mass}}
function arrow(node,cx,value,max,y){const zero=Math.abs(value)<=Math.max(1e-12,max*1e-10);node.style.display=zero?'none':'';node.setAttribute('x1',cx);node.setAttribute('x2',cx+(zero?0:value/max*86));node.setAttribute('y1',y);node.setAttribute('y2',y)}
function draw(){const s=state(),cx=338+s.x/radius*122; q('[data-block]').setAttribute('x',cx-16);const end=cx-16;let pts='60,148 72,148 ';for(let i=1;i<16;i++)pts+=(72+(end-84)*i/16)+','+(i%2?136:160)+' ';pts+=(end-12)+',148 '+end+',148';q('[data-spring]').setAttribute('points',pts);arrow(q('[data-velocity-arrow]'),cx,s.v,velocityMax,98);arrow(q('[data-force-arrow]'),cx,s.F,forceMax,208);q('[data-time]').textContent=fmt(time);q('[data-displacement]').textContent=fmt(s.x);q('[data-velocity]').textContent=fmt(s.v);q('[data-force]').textContent=fmt(s.F);q('[data-acceleration]').textContent=fmt(s.a);slider.value=String(time);q('[data-figure="result"]').textContent='t≈'+fmt(time)+' s；x≈'+fmt(s.x)+' m；v≈'+fmt(s.v)+' m/s；F≈'+fmt(s.F)+' N。'+(d.amplitude===0?'振幅为零，滑块保持在平衡位置。':'位置、速度与力由同一时刻计算；不要把接近平衡位置误作恰好到达。');}
function stop(){playing=false;window.TeachingClock?.pause();q('[data-figure="play"]').setAttribute('aria-pressed','false')}
q('[data-figure="play"]').onclick=()=>{if(!window.TeachingClock||window.TeachingClock.reducedMotion){q('[data-motion-note]').textContent='当前不播放动画；仍可单步或拖动时间检查状态。';return}if(time>=d.period)time=0;playing=true;q('[data-figure="play"]').setAttribute('aria-pressed','true');window.TeachingClock.start(dt=>{if(!playing)return false;time=Math.min(d.period,time+Math.max(0,dt));draw();if(time>=d.period){stop();return false}})};
q('[data-figure="pause"]').onclick=stop;q('[data-figure="step"]').onclick=()=>{stop();time=Math.min(d.period,time+d.period/32);draw()};q('[data-figure="reset"]').onclick=()=>{stop();time=0;draw()};slider.oninput=()=>{stop();time=Math.max(0,Math.min(d.period,Number(slider.value)));draw()};root.querySelectorAll('[data-time-fraction]').forEach(button=>button.onclick=()=>{stop();time=Number(button.dataset.timeFraction)*d.period;draw()});document.addEventListener('visibilitychange',()=>{if(document.hidden)stop()});draw();`;

export function buildScienceStage(type: 'area' | 'oscillator', config: unknown, title: string): TeachingStageBuild {
  if (type === 'area') {
    const data = createAreaModel(config), method = { midpoint: '中点', left: '左端点', right: '右端点' }[data.method];
    const formula = generatedMathMarkdown(`f(${data.variable}) = ${data.expression}`);
    const reference = data.exactIntegral === undefined ? undefined : Number(data.exactIntegral.toPrecision(6));
    const body = `<p><span class="tag">${escapeStageText(data.variable)} ∈ [${data.domain.join(', ')}]</span><span class="tag">${method}取样</span><span class="tag">${escapeStageText(formula)}</span></p><div class="plot"><svg viewBox="0 0 660 324" role="img" aria-label="函数曲线与有向矩形面积"><g data-grid></g><g data-rectangles></g><path data-curve fill="none" stroke="var(--red)" stroke-width="2.5"/><line data-zero x1="64" x2="616" stroke="var(--ink)"/><text x="620" y="315" font-size="12">${escapeStageText(data.variable)}</text></svg></div>${controls}<div class="controls"><label>分割数 n <input type="range" data-figure="time" min="${data.minCount}" max="${data.maxCount}" step="1" value="${data.minCount}" aria-label="分割数 n"></label></div><div class="grid"><div class="cell">分割数 n<br><strong data-count></strong></div><div class="cell">有向矩形和 ≈<br><strong data-area></strong></div><div class="cell">${data.exactIntegral === undefined ? '参考积分未提供' : '参考积分 − 矩形和 ≈'}<br><strong data-error></strong></div></div><output data-figure="result" aria-live="polite"></output><p class="note">${reference === undefined ? '没有给定参考积分时，不把近似和或不同分割的差值称为精确误差。' : `已给定参考积分（显示近似）：${reference}。`} 矩形可能在曲线的两侧；总和的误差不能推出每个矩形都低于或高于曲线。负函数值对应负的有向面积。</p><p class="note" data-motion-note>播放表示分割数的展示顺序，并非物理时间；有限取样与折线图不代替极限证明。</p>`;
    return { html: boundedFrame({ type, title, mode: 'dynamic', lead: `调整分割数，比较${method}矩形、矩形和与给定参考值；暂停检查每一次分割。`, body, data, script: areaScript }), semantics: {
      model: `${method}矩形在区间 [${data.domain.join(', ')}] 取样；Δx=(b−a)/n，矩形和为所示函数值乘宽度之和。${data.exactIntegral === undefined ? '未提供参考积分，不计算精确误差。' : '误差读数为给定参考积分减去矩形和。'}`,
      action: '播放或暂停分割数变化；单步增加一个分割，拖动分割数滑块，重置到最小分割数。',
      observation: '分割数、矩形高度与有向面积读数由同一取样规则产生。总和接近积分不表示每个矩形都在曲线同一侧。',
      caveat: '这是有限分割的数值教学模型，不代替积分存在性或收敛证明；参考积分是题设输入，组件不证明它的正确性。',
      transfer: '同一函数改用左端点或右端点取样，矩形和与参考积分的差如何改变？先核对函数和区间，不能直接沿用另一种取样方法的误差公式。',
    } };
  }
  if (type !== 'oscillator') throw Error('未知科学教学组件');
  const data = createOscillatorModel(config);
  const body = `<p><span class="tag">m=${data.mass} kg</span><span class="tag">k=${data.stiffness} N/m</span><span class="tag">A=${data.amplitude} m</span><span class="tag">向右为正</span></p><div class="plot"><svg viewBox="0 0 660 274" role="img" aria-label="理想水平弹簧振子的位置、速度和回复力"><defs><marker id="science-arrow-v" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0 0L6 3L0 6Z" fill="var(--accent)"/></marker><marker id="science-arrow-f" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0 0L6 3L0 6Z" fill="var(--red)"/></marker></defs><line x1="52" y1="170" x2="610" y2="170" stroke="var(--line)" stroke-width="3"/><rect x="40" y="124" width="20" height="48" fill="var(--line)"/><polyline data-spring fill="none" stroke="var(--muted)" stroke-width="2.5"/><line x1="338" x2="338" y1="118" y2="178" stroke="var(--muted)" stroke-dasharray="4 4"/><rect data-block width="32" height="42" y="127" rx="5" fill="var(--accent)"/><line data-velocity-arrow stroke="var(--accent)" stroke-width="3" marker-end="url(#science-arrow-v)"/><line data-force-arrow stroke="var(--red)" stroke-width="3" marker-end="url(#science-arrow-f)"/><text x="338" y="196" text-anchor="middle" font-size="12">平衡位置 x=0</text><text x="216" y="196" text-anchor="middle" font-size="12">−A</text><text x="460" y="196" text-anchor="middle" font-size="12">+A</text><text x="58" y="101" font-size="12">速度 v（m/s）</text><text x="58" y="215" font-size="12">回复力 F（N）</text><text x="338" y="252" text-anchor="middle" font-size="12">两类箭头分别按各自最大值缩放，不能跨单位比较箭头长度。</text></svg></div>${controls}<div class="controls"><label>时间（s）<input type="range" data-figure="time" min="0" max="${data.period}" step="any" value="0" aria-label="时间（秒）"></label></div><div class="controls"><button type="button" data-time-fraction="0.25">T/4</button><button type="button" data-time-fraction="0.5">T/2</button><button type="button" data-time-fraction="0.75">3T/4</button><button type="button" data-time-fraction="1">T</button></div><div class="grid"><div class="cell">时间（s）<strong data-time></strong></div><div class="cell">位移（m）<strong data-displacement></strong></div><div class="cell">速度（m/s）<strong data-velocity></strong></div><div class="cell">回复力（N）<strong data-force></strong></div><div class="cell">加速度（m/s²）<strong data-acceleration></strong></div></div><output data-figure="result" aria-live="polite"></output><p class="note">${String.raw`$x=A\cos(\omega t+\varphi)$，$v=-A\omega\sin(\omega t+\varphi)$，$F=-kx$；$\omega=\sqrt{k/m}$，$T=2\pi/\omega$。`}忽略摩擦、阻尼和弹簧质量，仅在胡克定律范围内使用；不是实验实测。</p><p class="note" data-motion-note>暂停后可拖动时间或用分数周期按钮检查准确时刻；不会把附近时间强行标为平衡位置或端点。</p>`;
  return { html: boundedFrame({ type, title, mode: 'dynamic', lead: '观察同一时刻的滑块位置、速度方向和回复力方向。合力为零不等于速度为零。', body, data, script: oscillatorScript }), semantics: {
    model: '无阻尼理想水平模型：ω=√(k/m)，T=2π/ω，x=A cos(ωt+φ)，v=−Aω sin(ωt+φ)，F=−kx，a=F/m。所有画面和读数使用同一时间。',
    action: '播放一次周期，暂停、单步或拖动时间检查中间状态；可直达分数周期并重置初态。',
    observation: data.amplitude === 0 ? '振幅为零时位置、速度、回复力都为零，滑块保持静止。' : '经过平衡位置时回复力为零、速率最大；两端速率为零、回复力的绝对值最大。数值容差仅用于隐藏浮点残差，不把附近时间冒作准确相位。',
    caveat: '仅讨论光滑水平轨道上的轻弹簧与滑块，忽略阻尼、摩擦和弹簧质量。速度与力使用不同单位和独立的箭头比例；计算结果不是实验测量。',
    transfer: '在同一理想水平弹簧系统中，保持质量与劲度系数不变，只改变振幅，周期和最大速率分别怎样变化？不要把水平合力结论直接搬到单摆或其他约束系统。',
  } };
}
