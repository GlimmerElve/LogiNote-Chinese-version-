/** Teaching mode is independent of the subject mechanism and its renderer. */
export const FIGURE_TEACHING_MODES = ['dynamic', 'step', 'contrast', 'prediction'] as const;
export type FigureTeachingMode = typeof FIGURE_TEACHING_MODES[number];

export function isFigureTeachingMode(value: unknown): value is FigureTeachingMode {
  return typeof value === 'string' && (FIGURE_TEACHING_MODES as readonly string[]).includes(value);
}

function readablePurpose(text: string, limit: number): string {
  return text.slice(0, limit)
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/^\s*(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\s*\1\s*$/gmu, '')
    // Declining autoplay does not decline an otherwise explicit dynamic lesson.
    .replace(/(?:不需要|不要|不用|不必|无需|取消|去掉|避免)(?:做|进行|添加|强制)?\s*自动播放/gu, '')
    // Discard the declined action and its subject, stopping before a replacement
    // purpose. Otherwise "不要动态演示振动" still routes through "振动".
    .replace(/(?:不需要|不要|不用|不必|无需|取消|去掉|避免)(?:做|进行|添加|强制)?\s*(?:预测|检验|测验|答题|动态(?:演示|展示|过程|模拟|观察)?|动画|播放|步进|逐步|单步|对照|对比|比较|演示(?:运动|振动|振荡))(?:(?!而是|改为|只(?:要|需|做|用|对比|比较|演示|观察))[^，,。；;\n])*/gu, '');
}

const predictionPurpose = /先预测|预测题|预测并(?:检查|检验|验证)|预测.{0,10}(?:再|后)(?:操作|观察|验证|检验)|(?:请|要求|希望|需要|进行|做|生成|增加|设计).{0,8}(?:预测|检验|测验)|(?:^|[。；;\n])\s*(?:预测(?!模型|方法|理论|误差|分布)|检验|测验)|检验(?:预测|理解|掌握|结论)|(?:prediction\s+(?:question|check)|predict\s+(?:first|then))/iu;
const stepPurpose = /逐步|步进|单步|一步(?:一|步)|每一步|按步骤|分阶段|沿.{0,6}流程|执行过程|算法状态|状态转移|状态流转|(?:step.by.step|single.step)/iu;
const dynamicPurpose = /动态(?:演示|展示|过程|模拟|观察)?|动画|播放|时间演(?:进|变)|随时间|运动演示|演示.{0,8}(?:运动|振动|振荡)|(?:time.evolution|animate|animation)/iu;
const contrastPurpose = /比较|对照|对比|并排|正反例|反例|不同假设|两种解释|(?:contrast|compare|comparison)/iu;
const dynamicSubject = /振动|振荡|简谐|弹簧.{0,10}运动|运动轨迹|运动过程|波的传播|波动传播|随.{0,5}时间.{0,8}(?:变化|演变)|(?:oscillat|vibrat)/iu;
const stepSubject = /算法|工作流|流程|装配顺序|计算步骤|数据流转|数据传递|队列.{0,8}(?:入队|出队|状态)|状态.{0,6}(?:更新|变化|转换)|(?:algorithm|workflow|state\s+transition)/iu;

function purposeMode(text: string): FigureTeachingMode | undefined {
  // Explicit teaching actions take precedence over a subject's usual representation.
  if (stepPurpose.test(text)) return 'step';
  if (dynamicPurpose.test(text)) return 'dynamic';
  if (contrastPurpose.test(text)) return 'contrast';
  if (dynamicSubject.test(text)) return 'dynamic';
  if (stepSubject.test(text)) return 'step';
}

/** A user's chosen activity is stronger than a component's default activity.
 * Unlike selectFigureTeachingMode, this does not turn the absence of an action
 * into an explicit request for a comparison. Existing policy-1 routing is frozen. */
export function explicitFigureTeachingMode(brief: string): FigureTeachingMode | undefined {
  const text = readablePurpose(brief, 2400);
  if (predictionPurpose.test(text)) return 'prediction';
  if (stepPurpose.test(text)) return 'step';
  if (dynamicPurpose.test(text)) return 'dynamic';
  if (contrastPurpose.test(text)) return 'contrast';
}

/** Controlled local widgets may override this result to their existing prediction
 * contract. Prose mentioning a prediction is not itself a request for a quiz. */
export function selectFigureTeachingMode(brief: string, lesson: string, wholePage = false): FigureTeachingMode {
  const purpose = readablePurpose(brief, 2400);
  if (predictionPurpose.test(purpose)) return 'prediction';
  const explicit = purposeMode(purpose);
  if (explicit) return explicit;
  // A selected passage owns its purpose; unrelated examples elsewhere cannot replace it.
  if (!wholePage) return 'contrast';
  const body = readablePurpose(lesson, 16000);
  const headings = body.split(/\r?\n/u).filter(line => /^\s{0,3}#{1,3}\s+/u.test(line)).join('\n');
  return purposeMode(headings) || purposeMode(body) || 'contrast';
}

const modeGuidance: Readonly<Record<FigureTeachingMode, string>> = {
  dynamic: '教学方式：动态演示。根元素写 data-figure-mode="dynamic"。让对象、现象或轨迹随时间演进，画面与读数由同一状态驱动；至少有 data-figure="play" 与 data-figure="pause" 按钮，并提供 data-figure="time" 时间滑块或 data-figure="step" 单步按钮，能暂停检查中间状态。用有意义的变化解释教材论断，不能只移动装饰；未给定定量规律时使用标明假设的定性演示，不杜撰数据。提供 data-figure="reset" 重置和 data-figure="result" 可读结果（output 或 aria-live），无需另套答题表单。隐藏时停动画，减少动态效果时可单步。',
  step: '教学方式：过程步进。根元素写 data-figure-mode="step"。依据教材的过程或算法，让 data-figure="step" 按钮推进一次有意义的状态转移，data-figure="state" 显示当前步骤、条件和中间状态；图与读数来自同一状态。保留操作前后的线索，说明为什么进入下一步及终止条件，不能只是轮播文字或装饰动画。未知规则明确标为示意，不杜撰执行结果。提供 data-figure="reset" 重置和 data-figure="result" 可读结果（output 或 aria-live），无需另套答题表单。',
  contrast: '教学方式：解释对照。根元素写 data-figure-mode="contrast"。至少两个 data-figure="case" 可见对照视图，共用同一输入，保持无关条件相同；可对比不同假设、解释、边界或操作前后。操作后保留可比较的状态，突出真正不同的原因与结果，图和读数由同一规则驱动。必须有能改变对照状态的操作，不能只是两段静态文字；不以装饰代替解释，未知关系只作标明假设的定性示意。提供 data-figure="reset" 重置和 data-figure="result" 可读结果（output 或 aria-live），无需另套答题表单。',
  prediction: '教学方式：预测检验。根元素写 data-figure-mode="prediction"。围绕教材中的一个常见误解，先用 data-figure="prediction" 输入或选择预测，再进行一次有效操作，data-figure="check" 检查同一情境并给观察提示；错误时不立即泄露答案。题目、反馈、图和读数由同一状态或规则决定，改变条件时同步题目；不要把无依据的猜测判为事实。提供 data-figure="reset" 重置、data-figure="result" 可读结果（output 或 aria-live）和 data-figure="transfer" 新情境问题；不以有限观察冒充证明。',
};

/** Disclose only the selected mode; the shared contract belongs to the caller. */
export function figureTeachingModeGuidance(mode: FigureTeachingMode): string {
  return modeGuidance[mode];
}
