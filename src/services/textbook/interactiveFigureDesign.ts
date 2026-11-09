import { isFigureTeachingMode, type FigureTeachingMode } from './interactiveFigurePedagogy';
import { isTeachingModelType, type TeachingModelType } from './teachingModelTypes';
export type FigureKind = 'quantitative' | 'process' | 'comparison' | 'general';
export type FigureRenderer = 'svg-2d' | 'anatomy-iso' | 'anatomy-3d';
/** Supplemental guidance is not persisted as a new kind, so older figures remain readable. */
export type FigureMechanism = 'stochastic' | 'structure' | 'mechanical' | 'computation'
  | 'sampler' | 'tokens' | 'embedding' | 'attention' | 'architecture' | 'training'
  | 'context' | 'chunker' | 'validator' | 'builder' | 'flow' | 'agent'
  | 'threshold' | 'frontier' | 'scorer' | 'economics'
  | 'assembly' | 'kinematics' | 'section' | 'spatial';
export interface FigureDesign {
  kind: FigureKind;
  /** Absent on existing attachments: preserve their original contract and digest. */
  teachingMode?: FigureTeachingMode;
  modelType?: TeachingModelType;
  renderer?: FigureRenderer;
  /** Location fallback only; it does not prove the model's factual claim. */
  anchorFallback?: true;
  anchor: string;
  goal: string;
  action: string;
  observation: string;
  model: string;
  prediction: string;
  caveat: string;
  transfer: string;
}

/** A rigid-primitives kit does not supply accurate organ or textile geometry. */
export function requiresReferenceGeometry(brief: string): boolean {
  return /(人体|器官|解剖|织物|布料|服饰)/u.test(brief) && /(三维|3d|旋转|逼真|真实|详细|剖面|解剖)/iu.test(brief);
}

/** A fixed-angle projection is useful for simple devices; never market it as 3D. */
export function selectFigureRenderer(brief: string): FigureRenderer {
  if (/(解剖|人体|器官|织物|布料)/iu.test(brief)) return 'svg-2d';
  if (/(三维|3d|旋转视角|旋转观察)/iu.test(brief)) return 'anatomy-3d';
  if (/(简单线图|简易线图|线条示意|平面示意|二维示意)/u.test(brief)) return 'svg-2d';
  return /(等轴测|等距视角|立体示意|装置|抽屉|按键|开关|面板)/u.test(brief) ? 'anatomy-iso' : 'svg-2d';
}
export async function loadFigureRendererGuidance(renderer: FigureRenderer): Promise<string> {
  if (renderer === 'anatomy-iso') return (await import('./figureGuidance/anatomyIso')).default;
  if (renderer === 'anatomy-3d') return (await import('./figureGuidance/anatomy3d')).default;
  return '';
}

/** Conservative routing uses the selected teaching goal only, not the entire book. */
export function selectFigureKind(brief: string): FigureKind {
  if (/(函数|数列|极限|收敛|曲线|斜率|导数|积分|面积|坐标|自变量|因变量|方程|平方|比例|概率分布)/u.test(brief)) return 'quantitative';
  if (/(比较|对比|权衡|选择|决策)/u.test(brief)) return 'comparison';
  if (/(步骤|过程|流程|状态|循环|顺序|机制|运行|传递)/u.test(brief)) return 'process';
  return 'general';
}

export async function loadFigureGuidance(kind: FigureKind): Promise<string> {
  switch (kind) {
    case 'quantitative': return (await import('./figureGuidance/quantitative')).default;
    case 'comparison': return (await import('./figureGuidance/comparison')).default;
    case 'process': return (await import('./figureGuidance/process')).default;
    default: return (await import('./figureGuidance/general')).default;
  }
}

/** Select from the requested mechanism, never from unrelated chapters of the book. */
const mechanismPatterns: ReadonlyArray<readonly [FigureMechanism, RegExp]> = [
  ['stochastic', /(概率分布|随机抽样|随机样本|掷骰|抛硬币|伯努利|蒙特卡洛|概率模拟|随机试验|随机实验)/u],
  ['structure', /(拆解|拆装|剖视|剖面|爆炸图|装配顺序|内部结构|观察结构|结构观察)/u],
  ['mechanical', /(齿轮|传动|杠杆|弹簧|滑轮|曲柄|机械装置|液压泵)/u],
  ['computation', /(数据流|数据流转|缓存淘汰|缓存命中|队列积压|注意力权重|计算过程|算法步骤)/u],
];
/** Upstream mechanism vocabulary is guidance, not a new persisted widget kind. */
const detailedMechanismPatterns: ReadonlyArray<readonly [FigureMechanism, RegExp]> = [
  ['sampler', /(采样温度|温度采样|采样分布|采样概率|temperature\s+sampling)/iu],
  ['tokens', /(分词器|词元|令牌计费|token(?:izer|s|计数|计费|数量)|分词.{0,8}(?:计数|计费|单元))/iu],
  ['embedding', /(向量嵌入|文本嵌入|嵌入向量|向量相似度|余弦相似度|embedding)/iu],
  ['attention', /(注意力权重|自注意力|交叉注意力|attention\s+(?:weights?|mechanism)|self.attention)/iu],
  ['architecture', /((?:模型|网络|神经网络).{0,6}(?:架构|结构|层数|维度)|model\s+architecture)/iu],
  ['training', /((?:训练|验证).{0,6}(?:损失|曲线|学习率|收敛)|training\s+(?:loss|curve))/iu],
  ['context', /(上下文窗口|上下文容量|上下文截断|context\s+window)/iu],
  ['chunker', /(文档切块|文本切块|分块检索|切块检索|检索分块|chunk(?:ing|er))/iu],
  ['validator', /(验证规则|校验规则|校验器|验证器|validator)/iu],
  ['builder', /((?:组合|配置).{0,5}(?:构造器|生成器|部件)|builder\s+(?:config|component))/iu],
  ['flow', /((?:流程|工作流).{0,8}(?:分支|故障|失败|步骤)|(?:分支|故障|失败).{0,6}(?:流程|工作流)|workflow\s+(?:failure|steps))/iu],
  ['agent', /((?:智能体|代理|agent).{0,10}(?:循环|迭代|停止条件|观察与行动)|agent\s+loop)/iu],
  ['threshold', /(分类阈值|决策阈值|阈值.{0,8}(?:误报|漏报|权衡)|(?:误报|漏报).{0,8}阈值|classification\s+threshold)/iu],
  ['frontier', /(帕累托|多目标.{0,6}权衡|有效前沿|pareto|trade.off\s+frontier)/iu],
  ['scorer', /(加权评分|权重评分|评分权重|评分准则|weighted\s+scor)/iu],
  ['economics', /(现金流|收支流|资金流入|资金流出|成本收益|cash\s*flow)/iu],
  ['assembly', /(装配约束|装配顺序|零件装配|assembly\s+(?:order|constraint))/iu],
  ['kinematics', /(运动学|运动轨迹|构件运动|kinematics)/iu],
  ['section', /(截面与切割|切割截面|切面位置|剖切平面|cross.section)/iu],
  ['spatial', /(空间旋转|旋转视角|改变视角|空间观察|spatial\s+(?:view|rotation))/iu],
];
function mechanismsFor(text: string): FigureMechanism[] {
  const detailed = detailedMechanismPatterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
  const legacy = mechanismPatterns.filter(([, pattern]) => pattern.test(text)).map(([name]) => name).filter(name =>
    !(name === 'stochastic' && detailed.includes('sampler'))
    && !(name === 'structure' && detailed.some(item => ['assembly', 'section', 'spatial'].includes(item)))
    && !(name === 'mechanical' && detailed.includes('kinematics'))
    && !(name === 'computation' && detailed.some(item => ['attention', 'context', 'chunker'].includes(item))));
  return [...detailed, ...legacy];
}
export function selectFigureMechanism(brief: string): FigureMechanism | undefined {
  const found = mechanismsFor(brief);
  return found.length === 1 ? found[0] : undefined;
}

/** Whole-page requests have no selected passage: use only an unambiguous heading,
 * rather than guessing from an unrelated example deep in the lesson. */
export function selectPageFigureMechanism(lesson: string): FigureMechanism | undefined {
  let fenced = false;
  const found = new Set<FigureMechanism>();
  for (const line of lesson.slice(0, 16000).split(/\r?\n/u)) {
    if (/^\s*(```|~~~)/u.test(line)) { fenced = !fenced; continue; }
    if (fenced || !/^\s{0,3}#{1,3}\s+/u.test(line)) continue;
    for (const mechanism of mechanismsFor(line.slice(0, 240))) found.add(mechanism);
  }
  return found.size === 1 ? [...found][0] : undefined;
}

export async function loadFigureMechanismGuidance(mechanism: FigureMechanism | undefined): Promise<string> {
  if (mechanism === 'stochastic') return (await import('./figureGuidance/stochastic')).default;
  if (mechanism === 'structure') return (await import('./figureGuidance/structure')).default;
  if (mechanism === 'mechanical') return (await import('./figureGuidance/mechanical')).default;
  if (mechanism === 'computation') return (await import('./figureGuidance/computation')).default;
  if (mechanism && ['sampler', 'tokens', 'embedding', 'attention', 'architecture', 'training'].includes(mechanism)) {
    const pack = await import('./figureGuidance/aiMechanisms'); return pack[mechanism as keyof typeof pack];
  }
  if (mechanism && ['context', 'chunker', 'validator', 'builder', 'flow', 'agent'].includes(mechanism)) {
    const pack = await import('./figureGuidance/processMechanisms'); return pack[mechanism as keyof typeof pack];
  }
  if (mechanism && ['threshold', 'frontier', 'scorer', 'economics'].includes(mechanism)) {
    const pack = await import('./figureGuidance/decisionMechanisms'); return pack[mechanism as keyof typeof pack];
  }
  if (mechanism && ['assembly', 'kinematics', 'section', 'spatial'].includes(mechanism)) {
    const pack = await import('./figureGuidance/spatialMechanisms'); return pack[mechanism as keyof typeof pack];
  }
  return '';
}

export function validateFigureDesign(value: unknown, kind: FigureKind, renderer?: FigureRenderer): FigureDesign {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('交互图缺少教学设计');
  const item = value as Record<string, unknown>;
  if (item.teachingMode !== undefined && !isFigureTeachingMode(item.teachingMode)) throw Error('交互图教学方式无效');
  if (item.modelType !== undefined && !isTeachingModelType(item.modelType)) throw Error('交互图本地模型类型无效');
  const keys = ['anchor', 'goal', 'action', 'observation', 'model', 'prediction', 'caveat', 'transfer'] as const;
  const design = { kind, ...(renderer ? { renderer } : {}), ...(item.anchorFallback === true ? { anchorFallback: true as const } : {}) } as FigureDesign;
  for (const key of keys) {
    const text = item[key];
    if (key === 'prediction' && item.teachingMode && item.teachingMode !== 'prediction' && (text === undefined || text === '')) { design.prediction = ''; continue; }
    if (typeof text !== 'string' || !text.trim() || text.length > 600 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) throw Error('交互图教学设计不完整');
    design[key] = text.trim();
  }
  if (isFigureTeachingMode(item.teachingMode)) design.teachingMode = item.teachingMode;
  if (isTeachingModelType(item.modelType)) design.modelType = item.modelType;
  return design;
}
