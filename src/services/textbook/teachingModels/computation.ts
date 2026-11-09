import { stageFrame, type TeachingStageBuild } from '../teachingStageFrame';

export interface LruStageConfig { capacity: number; initial: string[]; accesses: string[] }
export interface KnapsackStageConfig { capacity: number; items: Array<{ weight: number; value: number }> }
export interface AttentionStageConfig { queries: number[][]; keys: number[][]; values: number[][] }
export interface LruStageSnapshot {
  step: number; before: string[]; after: string[]; access: string | null; hit: boolean | null;
  evicted: string | null; operation: string; hits: number; misses: number;
}
export interface KnapsackStageSnapshot {
  step: number; phase: 'initial' | 'candidate' | 'committed' | 'skipped'; itemIndex: number | null;
  capacityIndex: number | null; sourceCapacity: number | null; sourceValue: number | null;
  oldValue: number | null; takeValue: number | null; chosenValue: number | null;
  before: number[]; after: number[]; bestItems: number[]; operation: string;
}
export interface AttentionStageSnapshot {
  step: number; phase: 'initial' | 'scores' | 'weights' | 'output'; queryIndex: number;
  scores: number[] | null; weights: number[] | null; output: number[] | null; operation: string;
}

function object(value: unknown, fields: string[], label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !fields.includes(key))) throw Error(`${label}配置字段无效`);
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw Error(`${label}超出支持范围`);
  return value;
}
function number(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw Error(`${label}必须是范围内的有限数`);
  return value;
}
function labels(value: unknown, max: number, label: string): string[] {
  if (!Array.isArray(value) || value.length > max || value.some(text => typeof text !== 'string'
    || !text.trim() || text.length > 40 || /[\u0000-\u001f\u007f]/u.test(text))) throw Error(`${label}无效`);
  return value.map(text => text as string);
}

export function parseLruStageConfig(value: unknown): LruStageConfig {
  const item = object(value, ['capacity', 'initial', 'accesses'], 'LRU');
  const capacity = integer(item.capacity, 1, 30, '缓存容量');
  const initial = labels(item.initial, capacity, '初始条目'), accesses = labels(item.accesses, 120, '访问序列');
  if (new Set(initial).size !== initial.length) throw Error('LRU 初始条目不能重复');
  return { capacity, initial, accesses };
}

export function parseKnapsackStageConfig(value: unknown): KnapsackStageConfig {
  const item = object(value, ['capacity', 'items'], '背包');
  const capacity = integer(item.capacity, 0, 30, '背包容量');
  if (!Array.isArray(item.items) || item.items.length > 12) throw Error('背包物品数量无效');
  const items = item.items.map(raw => {
    const entry = object(raw, ['weight', 'value'], '物品');
    return { weight: integer(entry.weight, 1, 10_000, '物品重量'), value: number(entry.value, 0, 1_000_000, '物品价值') };
  });
  return { capacity, items };
}

export function parseAttentionStageConfig(value: unknown): AttentionStageConfig {
  const item = object(value, ['queries', 'keys', 'values'], '注意力');
  const matrix = (raw: unknown, maxRows: number, label: string): number[][] => {
    if (!Array.isArray(raw) || !raw.length || raw.length > maxRows || !Array.isArray(raw[0]) || !raw[0].length || raw[0].length > 8)
      throw Error(`${label}矩阵尺寸无效`);
    const columns = raw[0].length;
    return raw.map(row => {
      if (!Array.isArray(row) || row.length !== columns) throw Error(`${label}各行维度不一致`);
      return row.map(value => number(value, -1_000_000, 1_000_000, label));
    });
  };
  const queries = matrix(item.queries, 4, '查询'), keys = matrix(item.keys, 12, '键'), values = matrix(item.values, 12, '值');
  if (queries[0].length !== keys[0].length || keys.length !== values.length) throw Error('注意力的查询/键维度或键/值行数不匹配');
  return { queries, keys, values };
}

/** These pure functions deliberately have no module closures. The same trusted
 * function bodies run in the guest, so the picture and tests share one model. */
export function lruStageFrames(config: LruStageConfig): LruStageSnapshot[] {
  let cache = [...config.initial], hits = 0, misses = 0;
  const frames: LruStageSnapshot[] = [{ step: 0, before: [...cache], after: [...cache], access: null,
    hit: null, evicted: null, operation: '初始状态：左端最近使用，右端最久未使用。', hits, misses }];
  for (const access of config.accesses) {
    const before = [...cache], index = cache.indexOf(access), hit = index >= 0;
    let evicted: string | null = null;
    if (hit) { hits++; cache.splice(index, 1); }
    else { misses++; if (cache.length >= config.capacity) evicted = cache.pop()!; }
    cache.unshift(access);
    const operation = hit ? `访问 ${access} 命中，移到最近使用端。`
      : evicted !== null ? `访问 ${access} 未命中，淘汰最久未使用的 ${evicted}，新条目移到最左端。`
        : `访问 ${access} 未命中，仍有空位，加入最近使用端。`;
    frames.push({ step: frames.length, before, after: [...cache], access, hit, evicted, operation, hits, misses });
  }
  return frames;
}

export function knapsackStageFrames(config: KnapsackStageConfig): KnapsackStageSnapshot[] {
  const dp = Array(config.capacity + 1).fill(0) as number[], picks = Array.from({ length: config.capacity + 1 }, () => [] as number[]);
  const frames: KnapsackStageSnapshot[] = [{ step: 0, phase: 'initial', itemIndex: null, capacityIndex: null,
    sourceCapacity: null, sourceValue: null, oldValue: null, takeValue: null, chosenValue: null,
    before: [...dp], after: [...dp], bestItems: [], operation: '初始状态：所有容量的最大价值为 0，尚未处理物品。' }];
  for (let itemIndex = 0; itemIndex < config.items.length; itemIndex++) {
    const { weight, value } = config.items[itemIndex];
    if (weight > config.capacity) {
      frames.push({ step: frames.length, phase: 'skipped', itemIndex, capacityIndex: null, sourceCapacity: null,
        sourceValue: null, oldValue: null, takeValue: null, chosenValue: null, before: [...dp], after: [...dp],
        bestItems: [...picks[config.capacity]], operation: `物品 ${itemIndex + 1} 的重量超出容量，不能装入，整行保持不变。` });
      continue;
    }
    for (let j = config.capacity; j >= weight; j--) {
      const before = [...dp], oldValue = dp[j], sourceCapacity = j - weight, sourceValue = dp[sourceCapacity];
      const takeValue = sourceValue + value, chosenValue = Math.max(oldValue, takeValue);
      const base = { itemIndex, capacityIndex: j, sourceCapacity, sourceValue, oldValue, takeValue, chosenValue, before };
      frames.push({ ...base, step: frames.length, phase: 'candidate', after: [...dp], bestItems: [...picks[config.capacity]],
        operation: `物品 ${itemIndex + 1}，容量 ${j}：比较不取与取当前物品的候选值，尚未写入 dp[${j}]。` });
      if (takeValue > oldValue) picks[j] = [...picks[sourceCapacity], itemIndex + 1];
      dp[j] = chosenValue;
      frames.push({ ...base, step: frames.length, phase: 'committed', after: [...dp], bestItems: [...picks[config.capacity]],
        operation: `物品 ${itemIndex + 1}，容量 ${j}：已将候选最大值写入 dp[${j}]，下一容量继续倒序。` });
    }
  }
  return frames;
}

export function attentionStageFrames(config: AttentionStageConfig, queryIndex = 0): AttentionStageSnapshot[] {
  if (!Number.isSafeInteger(queryIndex) || queryIndex < 0 || queryIndex >= config.queries.length) throw Error('查询编号无效');
  const q = config.queries[queryIndex], scale = Math.sqrt(q.length);
  const scores = config.keys.map(key => key.reduce((sum, value, index) => sum + value * q[index], 0) / scale);
  const maximum = Math.max(...scores), unnormalized = scores.map(score => Math.exp(score - maximum));
  const total = unnormalized.reduce((sum, value) => sum + value, 0), weights = unnormalized.map(value => value / total);
  const output = config.values[0].map((_, column) => config.values.reduce((sum, row, index) => sum + weights[index] * row[column], 0));
  return [
    { step: 0, phase: 'initial', queryIndex, scores: null, weights: null, output: null, operation: '输入就绪：查询、键和值固定；尚未展示分数、权重或输出。' },
    { step: 1, phase: 'scores', queryIndex, scores: [...scores], weights: null, output: null, operation: '计算缩放点积分数：查询与各键点积，再除以键维数的平方根。' },
    { step: 2, phase: 'weights', queryIndex, scores: [...scores], weights: [...weights], output: null, operation: '稳定 softmax：先减最大分数，再取指数并归一化为权重。' },
    { step: 3, phase: 'output', queryIndex, scores: [...scores], weights: [...weights], output: [...output], operation: '用各位置的权重乘对应值向量，再逐分量相加得到输出。' },
  ];
}

const controls = '<div class="controls"><button type="button" data-figure="step">下一步</button><button type="button" data-figure="reset">重置</button></div>';
const state = '<p class="panel" data-figure="state" aria-live="polite"></p>';
const result = '<output data-figure="result" aria-live="polite"></output>';
const common = String.raw`
const next=root.querySelector('[data-figure="step"]'),reset=root.querySelector('[data-figure="reset"]'),state=root.querySelector('[data-figure="state"]'),visual=root.querySelector('[data-figure="visual"]'),result=root.querySelector('[data-figure="result"]');
let index=0;
`;

const lruController = String.raw`
function render(){
 const f=frames[index];root.dataset.modelStep=String(f.step);
 state.textContent='第 '+f.step+' / '+(frames.length-1)+' 次访问 · '+f.operation;
 const cells=(items,before)=>items.length?items.map((item,i)=>'<span class="tag '+(!before&&item===f.access?'current':'')+'" '+(before?'data-cache-before':'data-cache-item')+'="'+esc(item)+'" data-cache-position="'+i+'">'+esc(item)+'</span>').join(''):'<span class="note">空缓存</span>';
 visual.innerHTML='<div class="case"><h3>访问前 · 最近 → 最久</h3><div class="row">'+cells(f.before,true)+'</div></div><div class="case"><h3>访问后 · 最近 → 最久</h3><div class="row">'+cells(f.after,false)+'</div></div>';
 result.innerHTML='<span data-cache-access="'+esc(f.access||'')+'">'+esc(f.access===null?'尚未访问':'当前访问：'+f.access)+'</span><br><span data-cache-order>'+esc(f.after.join(' → ')||'空')+'</span> · 命中 '+f.hits+' 次，未命中 '+f.misses+' 次'+(f.evicted===null?'':' · 淘汰 '+esc(f.evicted));
 next.disabled=index===frames.length-1;
}
next.addEventListener('click',()=>{if(index<frames.length-1){index++;render()}});
reset.addEventListener('click',()=>{index=0;render()});render();
`;

const knapsackController = String.raw`
function render(){
 const f=frames[index];root.dataset.modelStep=String(f.step);root.dataset.dpPhase=f.phase;
 state.textContent='状态 '+f.step+' / '+(frames.length-1)+' · '+f.operation;
 const items=d.config.items.map((item,i)=>'<span class="tag '+(i===f.itemIndex?'current':'')+'">物品 '+(i+1)+'：重量 '+item.weight+'，价值 '+fmt(item.value)+'</span>').join('')||'<span class="note">没有物品</span>';
 const cells=f.after.map((value,j)=>'<div class="cell '+(j===f.capacityIndex?'current ':'')+(j===f.sourceCapacity?'read ':'')+(value!==f.before[j]?'changed':'')+'" data-dp-index="'+j+'" data-dp-value="'+value+'"><small>容量 '+j+'</small><br><strong>'+fmt(value)+'</strong></div>').join('');
 let candidates='<p class="note">'+(f.phase==='initial'?'初始整行尚未更新。':f.phase==='skipped'?'当前物品过重，dp 保持原值。':'')+'</p>';
 if(f.capacityIndex!==null){
   candidates='<div class="cases"><div class="case">不取当前物品<br><strong data-candidate-skip="'+f.oldValue+'">'+fmt(f.oldValue)+'</strong></div><div class="case">取当前物品：旧 dp['+f.sourceCapacity+'] + 物品价值<br><strong data-candidate-take="'+f.takeValue+'">'+fmt(f.sourceValue)+' + '+fmt(d.config.items[f.itemIndex].value)+' = '+fmt(f.takeValue)+'</strong></div></div><p>候选最大值 '+fmt(f.chosenValue)+'；'+(f.phase==='candidate'?'尚未写入，dp['+f.capacityIndex+'] 仍为 '+fmt(f.oldValue)+'。':'已写入，dp['+f.capacityIndex+'] 为 '+fmt(f.chosenValue)+'。')+'</p>';
 }
 visual.innerHTML='<div class="panel">'+items+'</div><div class="row">'+cells+'</div>'+candidates;
 const final=index===frames.length-1;
 result.textContent=(final?'全部物品处理结束':'当前已写入的状态')+'：dp = ['+f.after.map(fmt).join(', ')+']；容量 '+d.config.capacity+' 的最大价值 '+fmt(f.after[d.config.capacity])+'；对应物品 '+(f.bestItems.length?f.bestItems.join('、'):'无')+'。';
 next.disabled=final;
}
next.addEventListener('click',()=>{if(index<frames.length-1){index++;render()}});
reset.addEventListener('click',()=>{index=0;render()});render();
`;

const attentionController = String.raw`
const query=root.querySelector('[data-attention-query]');
const vector=values=>'['+values.map(fmt).join(', ')+']';
query.innerHTML=d.config.queries.map((q,i)=>'<option value="'+i+'">查询 '+(i+1)+' '+esc(vector(q))+'</option>').join('');
let queryIndex=0,frames=createFrames(d.config,queryIndex);
function render(){
 const f=frames[index];root.dataset.modelStep=String(f.step);root.dataset.attentionPhase=f.phase;
 state.textContent='阶段 '+f.step+' / 3 · '+f.operation;
 const q=d.config.queries[queryIndex];
 const rows=d.config.keys.map((key,i)=>'<tr><th>位置 '+(i+1)+'</th><td data-attention-key="'+i+'">'+esc(vector(key))+'</td><td data-attention-value="'+i+'">'+esc(vector(d.config.values[i]))+'</td><td>'+(f.scores?'<span data-attention-score="'+f.scores[i]+'" data-score-index="'+i+'">'+fmt(f.scores[i])+'</span>':'待计算')+'</td><td>'+(f.weights?'<span data-weight="'+f.weights[i]+'" data-weight-index="'+i+'">'+fmt(f.weights[i])+'</span>':'待计算')+'</td></tr>').join('');
 const height=64+d.config.keys.length*44;
 const connections=d.config.keys.map((key,i)=>{
   const y=42+i*44,weight=f.weights?f.weights[i]:null;
   const line=f.scores?'<line x1="130" y1="'+(height/2)+'" x2="330" y2="'+y+'" stroke="var(--accent)" stroke-width="'+(weight===null?1:1+weight*9)+'"/>':'';
   const bar=weight===null?'':'<rect x="420" y="'+(y-10)+'" width="'+(weight*130)+'" height="18" fill="var(--accent)" opacity=".65"/>';
   return line+'<rect x="330" y="'+(y-16)+'" width="70" height="31" rx="6" fill="var(--panel)" stroke="var(--line)"/><text x="365" y="'+(y+5)+'" text-anchor="middle">位置 '+(i+1)+'</text>'+bar;
 }).join('');
 const diagram='<svg viewBox="0 0 570 '+height+'" role="img" aria-label="查询与各键的连接，权重阶段线宽与条形表示权重"><rect x="20" y="'+(height/2-22)+'" width="110" height="44" rx="8" fill="var(--panel)" stroke="var(--line)"/><text x="75" y="'+(height/2+5)+'" text-anchor="middle">查询 '+(queryIndex+1)+'</text>'+connections+'</svg>';
 let output='<p class="note">输出尚未计算；分数与权重会在对应阶段出现。</p>';
 if(f.output){output='<div class="panel"><strong>输出 o = </strong>'+f.output.map((value,i)=>'<span class="tag" data-output="'+value+'" data-output-index="'+i+'">'+fmt(value)+'</span>').join('')+'<p class="note">每个分量分别计算 Σᵢ wᵢ vᵢ；加权的是值 V，不是键 K。</p></div>'}
 visual.innerHTML='<div class="panel"><strong>当前查询 q = '+esc(vector(q))+'</strong>；键维数 '+q.length+'</div><div class="plot">'+diagram+'</div><div style="overflow-x:auto"><table><thead><tr><th>位置</th><th>键 K</th><th>值 V</th><th>分数</th><th>权重</th></tr></thead><tbody>'+rows+'</tbody></table></div>'+output;
 result.textContent=f.output?'输出 '+vector(f.output)+'；权重总和 '+fmt(f.weights.reduce((s,w)=>s+w,0))+'。':f.weights?'softmax 权重 '+vector(f.weights)+'，总和 '+fmt(f.weights.reduce((s,w)=>s+w,0))+'；输出待下一步计算。':f.scores?'缩放点积分数 '+vector(f.scores)+'；权重与输出尚未展示。':'当前只展示输入；下一步计算 q·k / √dₖ。';
 next.disabled=index===3;
}
next.addEventListener('click',()=>{if(index<3){index++;render()}});
query.addEventListener('change',()=>{queryIndex=Number(query.value);index=0;frames=createFrames(d.config,queryIndex);render()});
reset.addEventListener('click',()=>{queryIndex=0;query.value='0';index=0;frames=createFrames(d.config,0);render()});render();
`;

export function buildComputationStage(type: 'lru' | 'knapsack' | 'attention', config: unknown, title: string): TeachingStageBuild {
  if (type === 'lru') {
    const value = parseLruStageConfig(config);
    const semantics = {
      model: 'LRU 缓存列表从左到右为最近至最久使用；命中移至左端，满容量未命中先淘汰右端再加入左端。所有读数来自同一次访问后的缓存状态。',
      action: '每次点击下一步处理一个访问，查看访问前后顺序、命中或未命中与淘汰条目；重置恢复初始序列。',
      observation: '比较条目身份和顺序的变化，区分访问时刻与加入时刻，最后一次访问后不再推进。',
      caveat: '这是明确访问序列下的有限 LRU 状态模型，不代表真实系统的并发、性能或持久化行为。',
      transfer: '如果改变下一次访问的条目，哪个条目会移到最近端，满容量时谁会被淘汰？',
    };
    return { semantics, html: stageFrame({ type: 'lru', title, mode: 'step', lead: semantics.action,
      body: controls + state + '<div class="cases" data-figure="visual"></div>' + result,
      data: { config: value }, script: common + `const frames=(${lruStageFrames.toString()})(d.config);` + lruController }) };
  }
  if (type === 'knapsack') {
    const value = parseKnapsackStageConfig(config);
    const semantics = {
      model: '0/1 背包以容量上限 j 为状态；每件物品最多选一次，容量倒序更新 dp[j]=max(旧 dp[j],旧 dp[j−w]+v)，候选比较与写入分开显示。',
      action: '每次推进一次候选比较或状态写入，观察当前物品、容量、来源格和更新后的 dp 行；重置回到全零初态。',
      observation: '读取较小容量的旧状态得到取物品候选值；写入后才改变 dp，倒序避免重复使用当前物品。',
      caveat: '这是非负价值、正整数重量、有限整数容量的 0/1 背包模型；不适用于允许无限复用的完全背包。',
      transfer: '若容量改小或物品重量改变，哪些容量格仍能读取合法的来源状态？为什么不能直接改为容量正序更新？',
    };
    return { semantics, html: stageFrame({ type: 'knapsack', title, mode: 'step', lead: semantics.action,
      body: controls + state + '<div data-figure="visual"></div>' + result,
      data: { config: value }, script: common + `const frames=(${knapsackStageFrames.toString()})(d.config);` + knapsackController }) };
  }
  if (type === 'attention') {
    const value = parseAttentionStageConfig(config);
    const semantics = {
      model: '单头缩放点积注意力：sᵢ=q·kᵢ/√dₖ，稳定 softmax 先减最大分数再归一化，输出 o=Σᵢ wᵢvᵢ。输入矩阵、图形和各阶段读数共享同一计算状态。',
      action: '选择查询后，从初态依次推进分数、权重、输出三个阶段；改变查询或重置都会回到尚未展示计算结果的初态。',
      observation: '查询改变各键的分数，softmax 得到归一化权重，最后加权对应值向量；分数阶段不提前显示权重或输出。',
      caveat: '这是给定有限矩阵的单头玩具计算，不包含训练、多头、掩码、残差或完整语言模型；注意力权重不证明语义、因果或事实真伪。',
      transfer: '若只改变一个值向量而保持查询和键不变，哪些阶段会保持不变，最终输出为什么可能改变？',
    };
    return { semantics, html: stageFrame({ type: 'attention', title, mode: 'step', lead: semantics.action,
      body: '<div class="controls"><label>查询 <select data-attention-query aria-label="选择查询"></select></label></div>' + controls + state + '<div data-figure="visual"></div>' + result,
      data: { config: value }, script: common + `const createFrames=(${attentionStageFrames.toString()});` + attentionController }) };
  }
  throw Error('不支持的计算教学组件');
}
