/** Additive authoring capability, not another LLM stage or publication quota.
 * Base prompts remain exact for old, possibly exhausted, checkpoint requests. */
export const TEXTBOOK_TIMELINE_GUIDANCE = `新增可视化能力（本任务 visualCapabilitiesVersion=2；覆盖上文旧 Mermaid 三类白名单）：visuals.format 现在也支持 timeline，仍使用既有 mermaid 围栏，不新增章节字段或输出图源码到蓝图。
timeline 用于物料明确支持的历史阶段、年代演进或时间先后骨架。任务明确要求时间轴且资料有相应顺序时，安排 timeline，不用流程图或层级导图冒充；若“五大部分”仅是并列主题而无时间关系，使用 mindmap/table，而不是强造时间轴。操作步骤和条件分支用 flowchart，角色交互用 sequenceDiagram。
年份、时期、事件和先后关系必须来自本章已读资料；只有相对阶段时可用原有阶段名，不补造年份、跨度、遗漏事件或因果。图展示先后而非等比例时间距离，时间间隔不由节点间距推断。没有依据就不画时间轴，用文字或适合的已支持格式说明，不询问、不新增搜索/请求。
写作使用最简 Mermaid 语法：第一行 timeline，可有 title 短标题和 section 短阶段组名；每条“时期 : 事件”，同一时期追加事件可另写“: 事件”。冒号两侧留空格，追加行冒号后留空格；一条一行、中文短句，不写HTML、样式、图标、配置、URL或交互。至多12个时期、24个事件，通常3–6个时期、源码约800字符内；这些计入既有至多两项图表与篇幅预算，不借此扩课或扩大token额度。不要把flowchart的节点/连线语法混入timeline。
图前给观察问题，图后解释阶段转折、依据和局限，在相邻正文引用本章允许的[L/N]原文，不把来源编号塞入事件标签。多样性不是凑图数量；缺图/图种选择仍是非阻断的呈现建议，不增加图片生成或语义审核阶段。`;

export const TEXTBOOK_INVERSE_TRIG_GUIDANCE = `函数图能力补充（覆盖上文旧函数白名单）：function-plot 的 expression 现在还支持 asin/acos/atan，以及同义写法 arcsin/arccos/arctan；全部使用弧度。反正弦/反余弦的实数输入仅在[-1,1]，反正切接受任意有限实数。仅在模型、变量、参数和绘图窗口明确时使用，仍为受控 JSON，不写 Math.atan、LaTeX、脚本或未知参数。输出字段与原 function-plot 示例完全相同，不新增字段或生成阶段；不因图示失败重写章节。`;

export function textbookTimelinePrompt(base: string, version?: 2 | 3): string {
  // Version 2 must remain byte-exact for saved/exhausted checkpoint inputs.
  const timeline = version === 2 || version === 3 ? `${base}\n${TEXTBOOK_TIMELINE_GUIDANCE}` : base;
  return version === 3 ? `${timeline}\n${TEXTBOOK_INVERSE_TRIG_GUIDANCE}` : timeline;
}
