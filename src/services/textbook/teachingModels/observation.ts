import { escapeStageText as esc, stageFrame, type TeachingStageBuild } from '../teachingStageFrame';

export interface GroupingConfig { positions: number[]; colors: string[]; gapIndex: number; gapRange: [number, number]; initialGap: number; threshold: number }
export interface ReactionReactant { label: string; coefficient: number; count: number; atoms: Record<string, number> }
export interface ReactionProduct { label: string; coefficient: number; atoms: Record<string, number> }
export interface ReactionConfig { reactants: ReactionReactant[]; products: ReactionProduct[] }
const palette = ['#377f65', '#bd7451', '#7363a6', '#397f9e', '#a3536b', '#8c7d39'];
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('教学物料必须是对象');
  return value as Record<string, unknown>;
};
const finite = (value: unknown, limit = 10000): value is number => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit;
const integer = (value: unknown, min: number, max: number): value is number => finite(value, max) && Number.isInteger(value) && value >= min;

export function normalizeGroupingConfig(value: unknown): GroupingConfig {
  const d = object(value);
  if (!Array.isArray(d.positions) || d.positions.length < 2 || d.positions.length > 24 || !d.positions.every(point => finite(point))
    || d.positions.some((point, index) => index > 0 && point <= (d.positions as number[])[index - 1])) throw Error('分组点位置需要2至24个严格递增的有限坐标');
  if (!Array.isArray(d.colors) || d.colors.length !== d.positions.length || !d.colors.every(color => typeof color === 'string' && color.trim() && color.length <= 40 && !/[<>\u0000-\u001f]/u.test(color))
    || new Set(d.colors).size > 6) throw Error('分组点颜色类别与位置不匹配，最多6类');
  if (!integer(d.gapIndex, 1, d.positions.length - 1) || !Array.isArray(d.gapRange) || d.gapRange.length !== 2 || !d.gapRange.every(point => finite(point))
    || d.gapRange[0] <= 0 || d.gapRange[1] <= d.gapRange[0] || !finite(d.initialGap) || d.initialGap < d.gapRange[0] || d.initialGap > d.gapRange[1]
    || !finite(d.threshold) || d.threshold <= 0) throw Error('分组间距、下标或阈值无效');
  const actualGap = d.positions[d.gapIndex] - d.positions[d.gapIndex - 1];
  if (Math.abs(actualGap - d.initialGap) > Math.max(1, Math.abs(actualGap)) * 1e-9) throw Error('初始间距必须等于指定相邻两点的实际距离');
  return { positions: [...d.positions] as number[], colors: (d.colors as string[]).map(color => color.trim()), gapIndex: d.gapIndex,
    gapRange: [d.gapRange[0], d.gapRange[1]], initialGap: d.initialGap, threshold: d.threshold };
}

export function groupingObservation(config: GroupingConfig, gap: number) {
  if (!finite(gap) || gap < config.gapRange[0] || gap > config.gapRange[1]) throw Error('观察间距超出给定范围');
  const positions = config.positions.map((x, index) => x + (index >= config.gapIndex ? gap - config.initialGap : 0));
  const proximity: number[][] = [];
  for (let index = 0; index < positions.length; index++) {
    if (!index || positions[index] - positions[index - 1] > config.threshold + 1e-9) proximity.push([]);
    proximity[proximity.length - 1].push(index);
  }
  const similarity = [...new Set(config.colors)].map(color => config.colors.flatMap((item, index) => item === color ? [index] : []));
  return { positions, colors: [...config.colors], proximity, similarity };
}

export function groupingViewBox(config: GroupingConfig): [number, number, number, number] {
  const atMin = groupingObservation(config, config.gapRange[0]).positions, atMax = groupingObservation(config, config.gapRange[1]).positions;
  const low = Math.min(...atMin, ...atMax) - 34, high = Math.max(...atMin, ...atMax) + 34;
  return [low, 0, high - low, 138];
}

function atomRecord(value: unknown): Record<string, number> {
  const input = object(value), keys = Object.keys(input);
  if (!keys.length || keys.length > 8 || keys.some(key => !/^[A-Z][a-z]?$/u.test(key) || !integer(input[key], 1, 1000))) throw Error('原子组成需要有限的元素符号和正整数计数');
  return Object.fromEntries(keys.map(key => [key, input[key] as number]));
}
export function normalizeReactionConfig(value: unknown): ReactionConfig {
  const d = object(value);
  if (!Array.isArray(d.reactants) || !Array.isArray(d.products) || !d.reactants.length || !d.products.length || d.reactants.length + d.products.length > 6) throw Error('反应物与产物总种类需要2至6种');
  const species = (value: unknown) => {
    const item = object(value);
    if (typeof item.label !== 'string' || !item.label.trim() || item.label.length > 50 || /[\u0000-\u001f]/u.test(item.label) || !integer(item.coefficient, 1, 1000)) throw Error('物种名称或化学计量系数无效');
    return { label: item.label.trim(), coefficient: item.coefficient, atoms: atomRecord(item.atoms) };
  };
  const reactants = d.reactants.map(value => {
    const item = object(value);
    if (!integer(item.count, 0, 60)) throw Error('初始分子数量需要0至60的整数');
    return { ...species(item), count: item.count };
  });
  const products = d.products.map(species);
  const totals = (items: ReactionProduct[]) => {
    const result: Record<string, number> = {};
    for (const item of items) for (const [atom, count] of Object.entries(item.atoms)) result[atom] = (result[atom] || 0) + item.coefficient * count;
    return result;
  };
  const left = totals(reactants), right = totals(products);
  if ([...new Set([...Object.keys(left), ...Object.keys(right)])].some(atom => left[atom] !== right[atom])) throw Error('反应关系未满足逐元素原子守恒，不能绘制');
  const steps = Math.min(...reactants.map(item => Math.floor(item.count / item.coefficient)));
  const initial = reactants.reduce((sum, item) => sum + item.count, 0);
  const final = reactants.reduce((sum, item) => sum + item.count - steps * item.coefficient, 0) + products.reduce((sum, item) => sum + steps * item.coefficient, 0);
  if (Math.max(initial, final) > 60) throw Error('反应计数示意最多同时展示60个分子');
  return { reactants, products };
}

export function reactionObservation(config: ReactionConfig, step: number) {
  const maximum = Math.min(...config.reactants.map(item => Math.floor(item.count / item.coefficient)));
  if (!integer(step, 0, maximum)) throw Error('反应步骤超出可执行份额');
  const species = [...config.reactants, ...config.products];
  const counts = species.map((item, index) => index < config.reactants.length ? config.reactants[index].count - step * item.coefficient : step * item.coefficient);
  const atomTotals: Record<string, number> = {};
  species.forEach((item, index) => { for (const [atom, count] of Object.entries(item.atoms)) atomTotals[atom] = (atomTotals[atom] || 0) + count * counts[index]; });
  return { step, maximum, counts, atomTotals, stopped: step === maximum };
}

function groupingStage(value: unknown, title: string): TeachingStageBuild {
  const config = normalizeGroupingConfig(value), box = groupingViewBox(config), categories = [...new Set(config.colors)];
  const named: Record<string, string> = { green:'#377f65',red:'#bd5454',blue:'#397f9e',orange:'#bd7451',purple:'#7363a6',teal:'#377f80',black:'#343c37',gray:'#758079',grey:'#758079' };
  const colors = categories.map((color, index) => /^#(?:[\da-f]{3}|[\da-f]{6}|[\da-f]{8})$/iu.test(color) ? color : named[color.toLowerCase()] || palette[index]);
  const points = config.positions.map((x, index) => `<circle data-point-index="${index}" data-x="${x}" data-color="${esc(config.colors[index])}" cx="${x}" cy="64" r="8" fill="${colors[categories.indexOf(config.colors[index])]}"/><text data-point-label="${index}" x="${x}" y="101" text-anchor="middle" font-size="12">${index + 1}</text>`).join('');
  const scene = (kind: string, heading: string, note: string) => `<article data-figure="case" class="case"><h3>${heading}</h3><svg data-group-case="${kind}" class="plot" viewBox="${box.join(' ')}" role="img" aria-label="${heading}，使用相同位置和颜色的点"><g data-group-bands></g>${points}</svg><p class="note">${note}</p><p data-${kind}-groups></p></article>`;
  const body = `<div class="controls"><label>指定两点的间距 g <input data-shared-input data-gap type="range" min="${config.gapRange[0]}" max="${config.gapRange[1]}" step="any" value="${config.initialGap}"/></label><span data-gap-value class="tag"></span><button type="button" data-figure="reset">重置</button></div><div class="cases">${scene('proximity', '按接近规则组织', `相邻点间距不大于${config.threshold}时归入同一连续组。`)}${scene('similarity', '按颜色类别组织', '同色点属于同一类别，位置变化不改写其颜色。')}</div><output data-figure="result" aria-live="polite"></output><p class="note">两幅图始终共享同一批点的坐标和颜色；这只是对明确分组规则的可视化，不把某一种组织方式判为唯一正确解释。</p>`;
  const script = `const input=root.querySelector('[data-gap]'),out=root.querySelector('[data-figure="result"]');function draw(){const gap=Number(input.value),positions=d.positions.map((x,i)=>x+(i>=d.gapIndex?gap-d.initialGap:0)),proximity=[];positions.forEach((x,i)=>{if(!i||x-positions[i-1]>d.threshold+1e-9)proximity.push([]);proximity[proximity.length-1].push(i)});const similarity=[...new Set(d.colors)].map(color=>d.colors.flatMap((item,i)=>item===color?[i]:[]));root.querySelector('[data-gap-value]').textContent='g='+fmt(gap);for(const kind of ['proximity','similarity']){const svg=root.querySelector('[data-group-case="'+kind+'"]'),groups=kind==='proximity'?proximity:similarity;svg.querySelectorAll('[data-point-index]').forEach(node=>{const i=Number(node.dataset.pointIndex);node.setAttribute('cx',String(positions[i]));node.dataset.x=String(positions[i])});svg.querySelectorAll('[data-point-label]').forEach(node=>node.setAttribute('x',String(positions[Number(node.dataset.pointLabel)])));const layer=svg.querySelector('[data-group-bands]');layer.innerHTML=groups.map((group,index)=>{const lo=positions[group[0]],hi=positions[group[group.length-1]],color=d.palette[index%d.palette.length];return kind==='proximity'?'<rect x="'+(lo-15)+'" y="39" width="'+(hi-lo+30)+'" height="49" rx="12" fill="none" stroke="'+color+'" stroke-width="2"/>':'<line x1="'+lo+'" y1="31" x2="'+hi+'" y2="31" stroke="'+color+'" stroke-width="3" stroke-dasharray="4 3"/>'}).join('');const label=root.querySelector('[data-'+kind+'-groups]');label.setAttribute('data-'+kind+'-groups',JSON.stringify(groups));label.textContent='组：'+groups.map(group=>'['+group.map(i=>i+1).join('、')+']').join(' ')}out.textContent='同一组输入，当前间距 '+fmt(gap)+'；接近规则得到 '+proximity.length+' 组，颜色规则得到 '+similarity.length+' 类。右侧点整体移动，颜色与点编号保持不变。'}input.addEventListener('input',draw);root.querySelector('[data-figure="reset"]').addEventListener('click',()=>{input.value=String(d.initialGap);draw()});draw();`;
  return { html: stageFrame({ type: 'point-grouping', title, mode: 'contrast', lead: '改变组间距，比较接近规则与颜色规则如何组织完全相同的输入。', body, data: { ...config, palette: colors }, script }),
    semantics: { model: `两幅图的坐标和颜色完全相同；相邻距离≤${config.threshold}形成连续接近组，同色形成类别组。`, action: '拖动间距滑块，对照两幅图，再用重置恢复初态。', observation: '右侧点整体平移，接近分组可以变化；颜色类别保持不变。', caveat: '这是给定规则的定性组织示意，不是心理实验数据，也不判定某种解释唯一正确。', transfer: '改变接近阈值时，先说明哪些间距会跨越规则边界，再比较颜色分类是否改变。' } };
}

function reactionStage(value: unknown, title: string): TeachingStageBuild {
  const config = normalizeReactionConfig(value), initial = reactionObservation(config, 0), species = [...config.reactants, ...config.products], atomNames = [...new Set(species.flatMap(item => Object.keys(item.atoms)))];
  const equation = (items: ReactionProduct[]) => items.map(item => `${item.coefficient === 1 ? '' : item.coefficient}${item.label}`).join(' + ');
  const cards = species.map((item, index) => {
    const maximum = index < config.reactants.length ? config.reactants[index].count : initial.maximum * item.coefficient, columns = Math.min(5, Math.max(1, maximum)), rows = Math.max(1, Math.ceil(maximum / columns));
    return `<article class="case" data-species-index="${index}" data-count="${initial.counts[index]}"><h3>${esc(item.label)} <span data-count-output>${initial.counts[index]}</span> 份</h3><p class="note">${index < config.reactants.length ? '反应物' : '产物'}；每份组成 ${Object.entries(item.atoms).map(([atom,count])=>esc(atom)+(count===1?'':count)).join('、')}</p><svg data-molecule-plot class="plot" viewBox="0 0 ${columns * 72} ${rows * 62}" style="max-height:360px" role="img" aria-label="${esc(item.label)}的分子计数示意"><g data-molecules></g></svg></article>`;
  }).join('');
  const totals = atomNames.map(atom => `<span class="tag">${esc(atom)} 原子：<strong data-atom-total="${esc(atom)}">${initial.atomTotals[atom]}</strong></span>`).join('');
  const body = `<p class="panel">每次份额：${esc(equation(config.reactants))} → ${esc(equation(config.products))}</p><div class="controls"><button type="button" data-figure="step">推进一个反应份额</button><button type="button" data-figure="reset">重置</button><span data-figure="state" class="tag"></span></div><div data-atom-totals>${totals}</div><div class="cases" data-figure="visual">${cards}</div><output data-figure="result" aria-live="polite"></output><p class="note">每个小图表示一份给定组成的分子；复杂组成中带乘数的原子圆表示同类原子的计数组。连线只帮助数清组成，不代表真实化学键或反应运动。</p>`;
  const script = `const species=[...d.reactants,...d.products],maximum=Math.min(...d.reactants.map(item=>Math.floor(item.count/item.coefficient))),atoms=[...new Set(species.flatMap(item=>Object.keys(item.atoms)))];let step=0;function draw(){const counts=species.map((item,i)=>i<d.reactants.length?d.reactants[i].count-step*item.coefficient:step*item.coefficient),totals={};species.forEach((item,i)=>{for(const atom of Object.keys(item.atoms))totals[atom]=(totals[atom]||0)+item.atoms[atom]*counts[i]});species.forEach((item,i)=>{const card=root.querySelector('[data-species-index="'+i+'"]'),max=i<d.reactants.length?d.reactants[i].count:maximum*item.coefficient,columns=Math.min(5,Math.max(1,max));card.dataset.count=String(counts[i]);card.querySelector('[data-count-output]').textContent=String(counts[i]);const atomCount=Object.values(item.atoms).reduce((a,b)=>a+b,0),display=atomCount<=12?Object.entries(item.atoms).flatMap(([atom,count])=>Array.from({length:count},()=>({atom,count:1}))):Object.entries(item.atoms).map(([atom,count])=>({atom,count}));let markup='';for(let n=0;n<counts[i];n++){const offset=i<d.reactants.length?step*item.coefficient:0,cx=(n%columns)*72,cy=Math.floor(n/columns)*62;markup+='<g data-molecule-index="'+(n+offset)+'" transform="translate('+cx+','+cy+')">';display.forEach((entry,k)=>{const x=10+(k%4)*16,y=12+Math.floor(k/4)*17,color=d.palette[atoms.indexOf(entry.atom)%d.palette.length];markup+='<circle data-atom="'+entry.atom+'" data-atom-multiplicity="'+entry.count+'" cx="'+x+'" cy="'+y+'" r="7" fill="'+color+'" fill-opacity=".3" stroke="'+color+'"/><text x="'+x+'" y="'+(y+3)+'" text-anchor="middle" font-size="7">'+entry.atom+(entry.count===1?'':'×'+entry.count)+'</text>'});markup+='</g>'}card.querySelector('[data-molecules]').innerHTML=markup});for(const atom of atoms)root.querySelector('[data-atom-total="'+atom+'"]').textContent=String(totals[atom]);root.querySelector('[data-figure="step"]').disabled=step>=maximum;root.querySelector('[data-figure="state"]').textContent='第 '+step+' / '+maximum+' 步';const shortage=d.reactants.filter((item,i)=>counts[i]<item.coefficient).map(item=>item.label);root.querySelector('[data-figure="result"]').textContent=species.map((item,i)=>item.label+'='+counts[i]).join('，')+'。'+(step>=maximum?'不足以再推进一个份额：'+shortage.join('、')+'。':'满足下一份额的物料条件。')+'各元素原子总数保持初始值。'}root.querySelector('[data-figure="step"]').addEventListener('click',()=>{if(step<maximum){step++;draw()}});root.querySelector('[data-figure="reset"]').addEventListener('click',()=>{step=0;draw()});draw();`;
  return { html: stageFrame({ type: 'stoichiometry', title, mode: 'step', lead: '逐份额追踪反应物和产物，结合原子总数理解物料守恒与终止条件。', body, data: { ...config, palette }, script }),
    semantics: { model: `${equation(config.reactants)} → ${equation(config.products)}；每步按给定整数系数消费和生成，逐元素核对原子总数。`, action: '每次推进一个份额，观察各物种的图形数量、计数和终止条件；重置恢复全部初始物料。', observation: '物种数量随份额改变，每个元素的原子总数保持不变；反应物不足时停下。', caveat: '这是配平方程式的离散计数示意，不表示真实碰撞路径或反应速率，也不证明真实条件下该反应必定发生。', transfer: '改变初始数量时，先判断哪一种反应物最先不足，再用逐元素原子总数检验。' } };
}

export function buildObservationStage(type: 'grouping' | 'reaction', config: unknown, title: string): TeachingStageBuild {
  if (type === 'grouping') return groupingStage(config, title);
  if (type === 'reaction') return reactionStage(config, title);
  throw Error('未知的观察教学组件');
}
