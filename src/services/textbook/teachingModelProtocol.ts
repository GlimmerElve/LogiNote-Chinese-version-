import { buildScienceStage } from './teachingModels/science';
import { buildComputationStage } from './teachingModels/computation';
import { buildObservationStage } from './teachingModels/observation';
import { isTeachingModelType, type TeachingModelType } from './teachingModelTypes';
import type { TeachingStageBuild } from './teachingStageFrame';
import type { FigureTeachingMode } from './interactiveFigurePedagogy';
import { compileTextbookFunction } from './functionPlot';
import { findInteractiveFigureEntries } from './interactiveFigureMarker';

const patterns: Array<[TeachingModelType, RegExp]> = [
  ['area', /黎曼|中点矩形|(?:矩形|分割).{0,12}(?:积分|面积)|Riemann/iu],
  ['oscillator', /弹簧振子|简谐振|(?:水平弹簧|无阻尼).{0,10}(?:振动|运动)/u],
  ['lru', /LRU|最近.{0,4}使用|缓存.{0,12}(?:命中|淘汰|访问)/iu],
  ['grouping', /(?:分组|组织).{0,18}(?:接近|相似)|(?:接近|相似).{0,18}分组|彩色点/u],
  ['reaction', /化学计量|限制反应物|限量反应物|反应份额|配平.{0,10}守恒/u],
  ['knapsack', /(?:0\s*[/\-]?\s*1|零一).{0,5}背包|背包.{0,12}(?:倒序|状态转移)/u],
  ['attention', /(?:单头|缩放点积|softmax).{0,12}注意力|注意力.{0,14}(?:权重|分数|查询)|attention/iu],
];
/** Only a specifically requested supported mechanism is routed to a model. */
export function selectTeachingModelType(brief: string, lesson: string, wholePage = false): TeachingModelType | undefined {
  if (/(三维|3d|剖面|空间旋转)/iu.test(brief)) return;
  const found = patterns.filter(([, pattern]) => pattern.test(brief)).map(([type]) => type);
  if (found.length === 1) return found[0];
  if (found.length > 1 || !wholePage) return;
  const headings = lesson.slice(0, 16000).replace(/```[^\n]*\n[\s\S]*?```/gu, '').split(/\r?\n/u).filter(line => /^\s*#{1,3}\s/u.test(line)).join('\n');
  const page = patterns.filter(([, pattern]) => pattern.test(headings)).map(([type]) => type);
  return page.length === 1 ? page[0] : undefined;
}
/** Fresh policy-2 UI requests often contain a selected formula or the default
 * whole-page instruction, rather than a mechanism name. Infer only one supported
 * mechanism from the already bounded current-page/selection context. Never read
 * another page or treat fenced examples/comments as the requested mechanism. */
export function selectEntryTeachingModelType(brief: string, lesson: string, wholePage = false, selectedPassage = false): TeachingModelType | undefined {
  if (/(三维|3d|剖面|空间旋转)/iu.test(brief)) return;
  const prose = (text: string) => text.replace(/<!--[\s\S]*?(?:-->|$)/gu, '')
    .replace(/^ {0,3}(?:>\s*)?(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}(?:>\s*)?\1\s*$/gmu, '')
    .replace(/^ {0,3}(?:>\s*)?(`{3,}|~{3,})[^\n]*(?:\n[\s\S]*)?$/gmu, '');
  const compatible = (type: TeachingModelType) => !(type === 'area' && /切线|导数|微分|局部极[大小]值/u.test(brief))
    && !(type === 'oscillator' && /(?:改变|调整|切换|拖动).{0,12}(?:初相位|振幅|质量|劲度系数)/u.test(brief));
  const direct = patterns.filter(([, pattern]) => pattern.test(prose(brief))).map(([type]) => type);
  if (direct.length) return direct.length === 1 && compatible(direct[0]) ? direct[0] : undefined;
  const page = prose(lesson.slice(0, 16000));
  const briefAt = page.indexOf(brief);
  const markers = selectedPassage ? [] : findInteractiveFigureEntries(page).filter(entry => entry.brief === brief);
  const marker = markers.length === 1 ? markers[0] : undefined;
  const anchor = marker?.start ?? (briefAt >= 0 ? briefAt : page.indexOf('**交互探索**'));
  const anchorEnd = marker?.end ?? anchor + brief.length;
  let start = wholePage ? 0 : anchor >= 0 ? Math.max(0, anchor - 3000) : 0;
  let end = wholePage ? page.length : anchor >= 0 ? Math.min(page.length, anchorEnd + 3000) : Math.min(page.length, 8000);
  if (!wholePage && anchor >= 0) {
    // A selected passage belongs to its own subsection. A planned marker may
    // inherit its chapter's model, but never a different chapter's example.
    const headings = [...page.matchAll(selectedPassage ? /^ {0,3}#{1,3}\s+.+$/gmu : /^ {0,3}#\s+.+$/gmu)];
    const before = headings.filter(heading => heading.index! < anchor).at(-1);
    const after = headings.find(heading => heading.index! >= anchorEnd);
    if (before) start = Math.max(start, before.index!);
    if (after) end = Math.min(end, after.index!);
  }
  const context = page.slice(start, end);
  const found = patterns.filter(([, pattern]) => pattern.test(context)).map(([type]) => type);
  // A nearby supported example must not replace a clearly different operation.
  return found.length === 1 && compatible(found[0]) ? found[0] : undefined;
}
export const teachingModelMode = (type: TeachingModelType): FigureTeachingMode => type === 'area' || type === 'oscillator' ? 'dynamic' : type === 'grouping' ? 'contrast' : 'step';
const schemas: Record<TeachingModelType, string> = {
  area: 'config={expression:"明确的单变量表达式",variable:"变量名",domain:[左端,右端],minCount:最少分割数,maxCount:最多分割数,method:"midpoint或left或right",exactIntegral:原文明确的精确积分数值(可省略)}。中点总和的误差与每个矩形局部高低不同，不声称每个矩形都在曲线下方。',
  oscillator: 'config={mass:质量kg,stiffness:劲度N/m,amplitude:振幅m,phase:初相位弧度(未指定可省略)}。仅理想水平无阻尼模型；合力为零不代表速度为零，迁移不跨到有向心力的单摆。',
  lru: 'config={capacity:正整数容量,initial:[最近到最久的条目字符串],accesses:[按顺序的访问字符串]}。按教材顺序逐字保留条目，不自行添加访问。',
  grouping: 'config={positions:[初始间距下各点实际横坐标],colors:[每点所属颜色类别字符串],gapIndex:从0起的右侧第一点下标,gapRange:[最小间距,最大间距],initialGap:初始间距,threshold:接近分组阈值}。右侧点整体平移当前间距减初始间距；相邻距≤threshold连组，相似按相同颜色。坐标可由原文坐标公式代入initialGap求得。阈值只是给定示意规则，不证明真实知觉理论。',
  reaction: 'config={reactants:[{label:"反应物名称或式",coefficient:配平系数,count:初始分子数,atoms:{元素符号:单分子原子数}}],products:[{label:"产物名称或式",coefficient:配平系数,atoms:{元素符号:单分子原子数}}]}。整数计量份额且原子配平；不编造真实碰撞机理或反应时间。',
  knapsack: 'config={capacity:整数容量,items:[{weight:正整数重量,value:非负价值}]}。每件最多一次，按给定顺序保留物品。本地按倒序计算候选与提交帧，不把候选尚未写入的格子称为已赋值。',
  attention: 'config={queries:[[查询向量],...],keys:[[键向量],...],values:[[值向量],...]}。缩放点积除以sqrt(键维数)，稳定softmax后加权值向量；保留教材的对应顺序，不把键向量当值，也不把权重视为事实真伪。',
};
export function teachingModelPrompt(type: TeachingModelType): string {
  return `为教材选择本地可执行教学组件，只输出JSON {"title":"点明教学目的的短标题","design":{"anchor":"教材对应原句","goal":"本图解决的问题"},"basis":"逐字复制参数所在的连续原文","component":{"type":"${type}","config":{}}}。仅从给定材料提取参数，不输出HTML、CSS、SVG或脚本，不补编未知数据。本地负责统一计算、逐步呈现、绘制、控件、重置与解释，不需要模型编写实现。basis必须是原文中的连续片段，覆盖所用参数；无法确定时不要猜。${schemas[type]}`;
}
function numbersIn(text: string): number[] {
  const value = text.replace(/[−–]/gu, '-').replace(/[₀₁₂₃₄₅₆₇₈₉]/gu, ch => String('₀₁₂₃₄₅₆₇₈₉'.indexOf(ch)));
  const values = [...value.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/giu)].map(match => Number(match[0]));
  for (const match of value.matchAll(/(-?\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/gu)) if (Number(match[2])) values.push(Number(match[1]) / Number(match[2]));
  return values;
}
const normalizeSubscripts = (text: string) => text.replace(/[₀₁₂₃₄₅₆₇₈₉]/gu, ch => String('₀₁₂₃₄₅₆₇₈₉'.indexOf(ch)));
/** Use unambiguous source geometry, rather than asking the model to do substitution.
 * Only accept the source's exact initial coordinates or its zero-offset coordinates.
 * Arbitrary mismatches and multiple coordinate lists are not silently corrected. */
export function sourceGroupingConfig(config: any, basis: string): unknown {
  if (!config || !Array.isArray(config.positions) || config.positions.length < 2 || config.positions.length > 24) return config;
  const lists = [...basis.matchAll(/(?:横坐标|点位置|positions?)\s*[^\[。;；\n]{0,20}\[([^\]\n]{1,700})\]/giu)];
  if (lists.length !== 1) return config;
  const terms = lists[0][1].split(/[,，]/u).map(term => term.trim().replace(/−/gu, '-'));
  if (terms.length !== config.positions.length || terms.some(term => !/^[A-Za-z_\d.+*/()\s-]{1,60}$/u.test(term))) throw Error('原文坐标表达式不明确');
  const variables = [...new Set(terms.flatMap(term => term.match(/[A-Za-z_][A-Za-z_0-9]*/gu) || []))];
  if (variables.length > 1) throw Error('原文坐标包含多个未知变量');
  const variable = variables[0] || 'g';
  const compiled = terms.map(term => compileTextbookFunction(term, variable));
  const initial = compiled.map(fn => fn.evaluate(config.initialGap)), base = compiled.map(fn => fn.evaluate(0));
  const same = (actual: number[]) => actual.every((value, index) => typeof config.positions[index] === 'number' && Number.isFinite(value)
    && Math.abs(value - config.positions[index]) <= Math.max(1e-8, Math.abs(value) * 1e-9));
  if (!same(initial) && !same(base)) throw Error('分组坐标与原文给定的位置关系不一致');
  return { ...config, positions: initial };
}
/** Numeric provenance is an admission aid, not a scientific-proof claim. */
function checkDirectParameters(type: TeachingModelType, config: any, basis: string) {
  const supplied = numbersIn(basis);
  if (type === 'lru') {
    const digits = '零一二三四五六七八九';
    for (const match of basis.matchAll(/(?:容量(?:为|是)?\s*([一二三四五六七八九十两]+)|([一二三四五六七八九十两]+)\s*(?:槽|个条目|格缓存))/gu)) {
      const value = (match[1] || match[2]).replace(/两/gu, '二'), parts = value.split('十');
      const n = parts.length === 2 ? (parts[0] ? digits.indexOf(parts[0]) : 1) * 10 + (parts[1] ? digits.indexOf(parts[1]) : 0) : digits.indexOf(value);
      if (n > 0 && n <= 30) supplied.push(n);
    }
  }
  const contains = (number: unknown) => typeof number === 'number' && supplied.some(value => Math.abs(value - number) <= Math.max(1e-8, Math.abs(number) * 1e-7));
  let required: unknown[] = [];
  if (type === 'area') required = [...(config?.domain || []), config?.minCount, config?.maxCount, ...(config?.exactIntegral === undefined ? [] : [config.exactIntegral])];
  if (type === 'oscillator') required = [config?.mass, config?.stiffness, config?.amplitude, ...(config?.phase === undefined ? [] : [config.phase])];
  if (type === 'lru') required = [config?.capacity];
  if (type === 'grouping') required = [...(config?.gapRange || []), config?.initialGap, config?.threshold];
  if (type === 'knapsack') required = [config?.capacity, ...(config?.items || []).flatMap((item: any) => [item.weight, item.value])];
  if (type === 'attention') required = [...(config?.queries || []), ...(config?.keys || []), ...(config?.values || [])].flat();
  if (type === 'reaction') {
    const species = [...(config?.reactants || []), ...(config?.products || [])];
    if (species.some((item: any) => typeof item.label !== 'string' || !normalizeSubscripts(basis).includes(normalizeSubscripts(item.label)))) throw Error('反应物种未能对应原文');
    required = species.flatMap((item: any) => [...(item.coefficient === 1 ? [] : [item.coefficient]), ...(item.count === undefined ? [] : [item.count]), ...Object.values(item.atoms || {}).filter(count => count !== 1)]);
  }
  if (required.some(value => !contains(value))) throw Error('教学组件有参数未能对应原文');
}
export function buildTeachingModel(candidate: unknown, type: TeachingModelType, lesson: string): TeachingStageBuild & { title: string; anchor: string; goal: string } {
  const value = candidate as any;
  if (!value || !isTeachingModelType(value.component?.type) || value.component.type !== type || typeof value.basis !== 'string'
    || value.basis.length < 8 || value.basis.length > 2400 || !lesson.includes(value.basis)) throw Error('教学组件缺少可核对的原文依据');
  if (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 100 || /[<>\u0000-\u001f]/u.test(value.title)) throw Error('教学组件标题无效');
  const anchor = value.design?.anchor, goal = value.design?.goal;
  if (typeof anchor !== 'string' || !anchor.trim() || anchor.length > 600 || !lesson.includes(anchor)
    || typeof goal !== 'string' || !goal.trim() || goal.length > 600) throw Error('教学组件未对应教材教学目标');
  checkDirectParameters(type, value.component.config, value.basis);
  const config = type === 'grouping' ? sourceGroupingConfig(value.component.config, value.basis) : value.component.config;
  const built = type === 'area' || type === 'oscillator' ? buildScienceStage(type, config, value.title)
    : type === 'lru' || type === 'knapsack' || type === 'attention' ? buildComputationStage(type, config, value.title)
    : buildObservationStage(type, config, value.title);
  return { ...built, title: value.title.trim(), anchor: anchor.trim(), goal: goal.trim() };
}
