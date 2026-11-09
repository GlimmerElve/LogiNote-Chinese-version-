import type { ProgressiveWritingPolicy } from './types';
import { normalizeTextbookTeachingTypes, type TextbookTeachingType } from '../textbook/teachingTypes';

interface WritingContext {
  title: string;
  rootTitle?: string;
  pageTitle?: string;
  objectives?: readonly string[];
  scope?: string;
  sources?: readonly { title: string; text: string }[];
}

// A routing hint, not a subject assessment. Narrow page context takes priority
// over a broad course/book. No extra model call or scan of a personal library.
const signals: Array<[TextbookTeachingType, RegExp]> = [
  ['history', /历史|发展史|思想史|学说史|演变|沿革|年代|分期|史料|\b(?:history|historical|chronology)\b/iu],
  ['mathematics', /数学|微积分|极限|函数|导数|积分|数列|方程|不等式|概率|统计|代数|矩阵|向量|几何|数量关系|\b(?:math(?:ematics)?|calculus|derivative|integral|probability|statistics|matrix|algebra)\b/iu],
  ['science', /物理|化学|力学|受力|弹簧|电路|电磁|热力|光学|分子|原子|反应速率|化学平衡|\b(?:physics|chemistry|mechanics|molecule|circuit|thermodynamics)\b/iu],
  ['procedure', /操作|编程|代码|算法|调试|配置|部署|安装|实验步骤|工作流程|\b(?:python|javascript|typescript|programming|debugging|deployment|sql)\b/iu],
  ['concept', /概念|效应|机制|心理|认知|偏差|行为|哲学|经济|社会|理论|\b(?:concept|effect|psychology|cognitive|bias|philosophy|economics)\b/iu],
];
const short = (value: string | undefined, limit: number) => (value || '').slice(0, limit);

export function createProgressiveWritingPolicy(context: WritingContext): ProgressiveWritingPolicy {
  const scopes = [
    short(context.scope, 1600),
    [short(context.pageTitle, 300), ...(context.objectives || []).slice(0, 6).map(value => short(value, 200))].join('\n'),
    short(context.title, 300), short(context.rootTitle, 300),
    (context.sources || []).slice(0, 4).map(source => `${short(source.title, 200)}\n${short(source.text, 600)}`).join('\n'),
  ];
  for (const scope of scopes) {
    const types = signals.filter(([, signal]) => signal.test(scope)).map(([type]) => type);
    if (types.length) {
      const teachingTypes = types.slice(0, 2);
      // A bounded selection hint, NOT a verifier of equations/parameters. Keep
      // it with the reservation so later title/source changes cannot reroute it.
      const evidence = [short(context.scope, 1600), short(context.title, 300),
        ...(context.sources || []).slice(0, 4).map(source => short(source.text, 600))].join('\n');
      const quantitative = teachingTypes.includes('science')
        && /\b[a-zA-Z][a-zA-Z0-9_]{0,12}\s*\(\s*[a-zA-Z]\s*\)\s*=\s*[^。\n;；]{0,100}\d/u.test(evidence);
      return { version: 6, teachingTypes, ...(quantitative ? { inlineVisual: 'quantitative' as const } : {}) };
    }
  }
  return { version: 6, teachingTypes: ['general'] };
}

// V1 bytes are frozen for persisted page reservations. Future revisions get
// another version; never silently replace guidance while resuming a request.
const commonV1 = '正文文风v1：严谨通俗，围绕本页核心问题逐步讲清。段落一意，长短随推理变化；术语首次出现解释，过渡说明下一步为何必要。例子交代条件与判断依据，类比说清对应及局限。步骤/比较才列项，其余连贯成段；卡片只突出关键处。删去空泛评价、套话、反复概述和“显然”式省略，保留事实、引用与边界。文风在既有篇幅内落实，不增字段、自查输出、审核门槛或重生成；续写沿用已保存正文的语气、术语和符号，只补未完成部分。';
const specialtyV1: Record<TextbookTeachingType, string> = {
  concept: '学科讲法【概念】：用一个简短情境贯穿定义、机制和条件变化；解释为何成立，再辨析相近概念。示例：“选项更多为何反而难选？”从实际判断引出概念，避免连续堆定义或把相关写成因果。',
  history: '学科讲法【历史】：按问题、背景、转折和影响组织材料，用比较说明观点差异；区分当时主张与后人解释。人名年代只在推进理解时出现；缺证据不编史实，不把时间先后直接写成因果。',
  mathematics: '学科讲法【数学】：先给可算的小例，再引入符号和推导；定义写全条件，解释关键变形为何可做，常规计算适当合并。例：“分母何时为零？”先判断允许输入再运算；图后解释变量关系，不逐式重复读公式。',
  science: '学科讲法【理化】：从现象与观察问题引出模型、假设、规律及应用；说清量、方向、单位和条件，再解释结果。区分示意、预测与实测，用条件变化暴露模型边界，避免只列公式或凭图宣称证明。',
  procedure: '学科讲法【实践】：先给任务、输入和预期结果，再按必要步骤解释操作；关键处说明为何这样做及如何判断成功。代码围绕一个最小例子讲输入、处理和输出，区分推演与实际运行，不逐行复述或堆命令。',
  general: '学科讲法【通用】：按问题、解释、例子和应用的实际关系组织小节，不强套齐模板；每节解决一个具体疑问，讲清必要前提。标题点明内容，结尾承接下一步，避免标题清单代替正文。',
};

// V2 changes mathematics only; all other specialties keep their V1 guidance.
// Both versions remain immutable so saved reservations can resume verbatim.
const commonV2 = commonV1.replace('正文文风v1：', '正文文风v2：');
const mathematicsV2 = '学科讲法【数学】：先算小例，再讲符号、条件和关键推导，图后解释变量关系，避免逐式复述。类比明确输入对象、输出类型和规则：两个同名学生各有唯一学号，仍可构成函数；重名不使同一学生有多个学号。集合若作为一个输出，其多个元素不等于多输出。若讲f:A→B，A为定义域、B为陪域，实际像集f(A)才是值域且包含于B，不把B直接叫值域。“三要素”按所用教材约定，带陪域的映射声明保留B。仅在相关概念出现时澄清，不为补术语扩课。';
const commonV3 = commonV2.replace('正文文风v2：', '正文文风v3：')
  + '图文逐项核对输入、定义域/陪域、边界与分支结论；每条成功路径覆盖正文全部必要条件。局部错误只修对应图块，保留其余正文、题目和主线，不额外复核或重生成整页。';

// V1–V3 stay byte-identical for interrupted reservations. Only NEW pages use
// inline figure selection. The same model response already supports these
// fences; no second generation pass, mandatory figure quota or render gate.
const commonV4 = '正文文风v4：严谨通俗，围绕本页核心问题讲清。段落一意，术语首次解释，过渡说明下一步为何必要。例子给条件和依据，类比说明对应与局限；步骤/比较才列项，卡片只突出关键处。删去套话、重复概述和“显然”式省略，保留来源与边界。图文核对变量、适用条件、数值与分支，成功路径覆盖全部必要条件。图示配置放在正文相关段落，同次响应输出；围栏闭合后由本地组件绘制。文风与图示在既有篇幅内落实，不加字段、审核门槛、绘图请求或整页重生成；续写只补未完成部分，沿用已保存的语气、术语和符号。局部错误只修对应图块，保留其他正文、题目和主线。';
const scienceV4 = '学科讲法【理化】：从现象到模型、假设、规律和应用，说清量、方向、单位与边界；区分速率与有向速度、大小与分量，结论不越出假设。空间、受力或电路关系用science-diagram；显式关系、参数、单位与区间已知的定量变化用function-plot，坐标覆盖曲线。Mermaid流程图不能替代受力图或数值曲线。按本页关键关系选0–2图，确有两种互补关系可各一图，不凑图。直接输出已支持的围栏配置，图前提问、图后解读，不以“建议画图”或探索卡占位。教学示意simulated=true、sourceIds=[]，依据在相邻正文引用；未知量不猜，条件不足跳过图并继续正文，不加请求或重生成。';

// V4 has already reserved pages too. Correct physics terminology and units in
// a new version rather than changing any persisted request's prompt on resume.
const commonV5 = commonV4.replace('正文文风v4：', '正文文风v5：');
const scienceV5 = '学科讲法【理化】：现象→模型/假设→规律→应用，说清量、方向、单位和边界，类比也受假设约束。正文、图注和概念摘要统一：x=-A是位移最小而非最大，用“位移极值/位移大小最大”，速度、加速度的大小不等于有向分量。受力/空间/电路用science-diagram；显式关系、参数和区间已知的变化用function-plot，坐标容纳完整曲线。同一纵轴仅放同单位量；异量须分图，或先明示参考量归一化（如x/A、v/(ωA)），轴名注明无量纲，不编双轴字段。Mermaid不替代示意或曲线。选0–2互补图，围栏随正文同次生成，图前问、图后解读，不用建议卡占位。示意simulated=true、sourceIds=[]，正文引依据；条件不足跳过图继续正文，不加请求或整页重生成。';
const commonV6 = commonV5.replace('正文文风v5：', '正文文风v6：');

/** Compact request intent; no separate planning response or output fields. */
export function progressiveInlineVisualDesign(policy?: ProgressiveWritingPolicy) {
  if (policy?.version !== 6 || policy.inlineVisual !== 'quantitative' || !policy.teachingTypes.includes('science')) return undefined;
  return { primaryFormat: 'function-plot', instruction: '本页使用已给显式关系与完整参数讲解时，在相关段落输出至少一张实际曲线配置，流程图或探索卡不能替代。优先单量曲线；异量共图须先列参考尺度并归一化，纵轴注明无量纲。未知量不猜，条件不足跳过图继续正文；随正文同次生成，不追加绘图请求。' };
}

/** Only selected snippets enter the prompt. Legacy/unknown versions stay on the
 * existing generation path; optional prose hints must never block recovery. */
export function progressiveWritingGuidance(policy?: ProgressiveWritingPolicy): string {
  if (policy?.version !== 1 && policy?.version !== 2 && policy?.version !== 3 && policy?.version !== 4 && policy?.version !== 5 && policy?.version !== 6) return '';
  const revised = policy.version !== 1;
  return '\n' + [policy.version === 6 ? commonV6 : policy.version === 5 ? commonV5 : policy.version === 4 ? commonV4 : policy.version === 3 ? commonV3 : revised ? commonV2 : commonV1, ...normalizeTextbookTeachingTypes(policy.teachingTypes)
    .map(type => (policy.version === 5 || policy.version === 6) && type === 'science' ? scienceV5 : policy.version === 4 && type === 'science' ? scienceV4
      : revised && type === 'mathematics' ? mathematicsV2 : specialtyV1[type])].join('\n');
}
