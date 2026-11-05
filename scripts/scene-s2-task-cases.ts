/** Natural-language acceptance tasks. No finished graph, plugin selection or Agent decisions injected. */
import type { S2UiValidationCase } from './scene-s2-ui-agent-validation';
import { S2_VALIDATION_CHECKS } from './scene-s2-agent-validation';

const common = '这是S2本地画布练习，不是角色扮演。请根据目标自主选择已安装能力、设计中文名称/控件和交互Agent指导。工具范围内必须存在完整可完成路径；留一个可由用户完成的输入或连线，不把缺失执行器当留白。提供可新增的文字设计笔记块，便于我写思路。交互中允许仅解释、举例、调整策略；只有我明确委托才提出修改，修改与运行分别确认。不读取真实资料、画像，不调用模型测试或网络，不新增授权。';
const commonReview = '不得要求固定节点ID、确切节点数或指定唯一连法；按实际目标、已安装能力和公开初稿判断。design-goal-and-roles=目标及用户/Agent分工正确；incomplete-exercise=有实际可参与的留白且授权能力内可完成；hint-not-solution=先提示不代做；analogy-not-workflow=按最新要求举例不改图运行；preserve-and-collaborate=协作建议保留用户笔记/原目标且局部完整可执行；bounded-target-and-consent=只申请当前目标且先改图确认再独立运行确认；execution-vs-business-truth和result-grounding=依据真实host结果，区分文本装配/格式处理/用户选择与语义正确、业务通过或外部执行。';
function task(id: string, subject: string, goal: string, learnerText: string, analogy: string, collaboration: string,
  humanConfirmations?: readonly boolean[]): S2UiValidationCase {
  return { id, request: { source: 'custom', sceneSkill: 'S2', subject, knowledgePoints: [], extraHints: `${goal}\n${common}` },
    learnerText, queries: [
      '我已新增文字笔记写了我的思路。先读我的思路，只给一个针对性提示，不给完整答案、不改图、不运行。',
      `${analogy}仅讨论，不改图、不运行。`,
      `现在明确委托你协作：保留我的笔记和其他既有内容，${collaboration}提出可确认的修改方案，先不运行。`,
      '现在申请运行刚才协作完成的本地目标；只申请必要目标，等待我另行确认。运行结束后基于本次实际输出解读满足了什么、没证明什么，不擅自再次修改或重跑。',
    ], collaborationIndex: 2, executionIndex: 3, checks: S2_VALIDATION_CHECKS,
    reviewRules: `${commonReview}本例目标：${goal}`, ...(humanConfirmations ? { humanConfirmations } : {}) };
}
export const S2_TASK_CASES = {
  'prompt-assembly': task('prompt-assembly', '提示词本地装配练习',
    '我在学习提示词设计。本轮只练习本地装配，不发送LLM：让我编辑角色设定、任务要求和输出要求，组合成完整提示词并能看到完整原文。素材使用“面向初学者的老师”“解释确认偏误”“先给生活例子，再给一句定义”。这些内容应作为真实材料来源，不只是写在说明中。留一个可由我填写或接线的缺口。',
    '我的思路：只写“回答得好一点”，不写面向谁，也不写输出要求，应该也能稳定得到我想要的格式。',
    '我想先讲明白受众和输出要求的差别。用一个生活中的委托例子说明，别继续替我补节点。',
    '补齐本地装配这条路径，完整保留三段素材，让输出有清晰标题。不要发送模型，也不要宣称提示词效果已经测试通过。'),
  'structured-display': task('structured-display', '结构化材料转表格练习',
    '我想理解结构化数据与表格之间的对应。合成材料是 [{"姓名":"甲","分数":80},{"姓名":"乙","分数":0}]。让我补齐本地解析、转表格和查看结果的路径，最终两条记录与0分都必须完整保留。这里只验证格式转换，不审核成绩优劣。',
    '我的思路：0就是没填，转成表格时可以丢掉乙这条记录；JSON能解析就代表成绩合格。',
    '先换一种讲解方式，用登记册的例子解释“没有填写”和“填了0”的差别，不继续代做。',
    '补齐从实际合成JSON材料到表格展示的路径，不过滤、改写或编造记录，0必须保留。'),
  'human-branch': task('human-branch', '本人确认后的条件路径练习',
    '我想设计本地人工确认的条件流程：用“是否采用这份草稿？”询问本人，由本人选择同意或拒绝；同意时输出“草稿已采用”，拒绝时输出“保留原稿，请继续修改”。两条路径都必须能完成，但一次只走与本人回答对应的一条。只是本地文本，不实际发布、不调用外部服务。让我补一个条件或连线，不预先代答。',
    '我的思路：只要弹出确认框就算用户已经同意，可以让同意和拒绝两条路径都执行。',
    '用门口两条通道的生活例子解释，为什么“出现确认框”和“本人确实同意”不同，别自动替我选。',
    '补齐这次条件路径，并确保本人拒绝时只得到拒绝分支结果，不能偷走同意分支或默认代答。', [false]),
} satisfies Record<string, S2UiValidationCase>;
export type S2TaskCaseId = keyof typeof S2_TASK_CASES;
export function s2TaskCase(id: string): S2UiValidationCase {
  if (!Object.hasOwn(S2_TASK_CASES, id)) throw new Error('Unknown S2 acceptance task');
  return S2_TASK_CASES[id as S2TaskCaseId];
}
