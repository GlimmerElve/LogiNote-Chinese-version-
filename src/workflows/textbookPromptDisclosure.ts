import { TEXTBOOK_RICH_LAYOUT_GUIDANCE, TEXTBOOK_RICH_LAYOUT_GUIDANCE_V8, TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE } from '../services/textbook/richLayoutGuidance';

/** v4 uses a short planning index, then loads only the selected chapter modules.
 * No specialty prose or renderer JSON examples belong in this planning index. */
export const TEXTBOOK_TEACHING_TYPE_INDEX = '先按任务和已读物料识别teachingTypes：concept概念/效应、history历史演变、mathematics数学/数量关系、science理化、procedure操作/代码、general通用。全书及每章各选1–2类，混合内容可组合，章类型按各自职责选择；不确定用general。此为指导路由，不增加任务或检查门槛。';
export const TEXTBOOK_PROGRESSIVE_CAPABILITIES = '呈现索引：mindmap概念层级，flowchart条件/步骤，sequenceDiagram角色顺序，timeline来源中的阶段，table同维度比较，chart已知离散数据，function-plot已知单变量显式函数/面积，science-diagram二维物理示意，molecule已知SMILES，textbook-image已授权原图。公式用LaTeX、代码静态展示，不作为visuals新格式。每章最多两项主要图表；缺依据保留解释，不造函数、数据或素材，不因缺图追加生成。';
export const TEXTBOOK_PROGRESSIVE_STYLE_PROMPT = '默认讲授文风：严谨但通俗，像老师逐步讲授；术语首次出现解释含义，过渡说明先后关系。一段一个重点，通常2–4句、80–180汉字；步骤和比较用列表。避免摘要腔、碎句堆叠、重复总结和“显然”式省略，只按明确偏好调整讲法。';
/** v5 only. Freeze v4 bytes so continuing a saved chapter never resets attempts. */
export const TEXTBOOK_READING_STYLE_PROMPT = '讲授文风：严谨通俗，先短例再解释术语与关键理由，衔接交代为何走下一步。一段一意，步骤/比较才列项；理由讲一次，后文沿用，不逐式复述常识或重复总结。小节内不写H1/H2或重复标题；来源编号保留原前缀；按明确偏好调整。';

export function progressiveTextbookBlueprintPrompt(evidence: string, visualVersion?: 2 | 3): string {
  const capabilities = visualVersion ? TEXTBOOK_PROGRESSIVE_CAPABILITIES : TEXTBOOK_PROGRESSIVE_CAPABILITIES.replace('timeline来源中的阶段，', '');
  return `你是证据驱动的教学设计师。只输出教学蓝图JSON，不写正文、绘图源码或分析过程。
${evidence}
${TEXTBOOK_TEACHING_TYPE_INDEX}
范围按当前项目任务，不以根标题扩课、不改知识点名称。普通任务2–3个目标、2–3章，focused全书3500–5500汉字、建议4500；确有多步推导/实现/综合目标才用extended，通常4–5章、最多6章，6000–8500字、建议7200。篇幅是软目标，资料多和能画图不构成扩课理由。
默认按严谨但通俗的讲授文风设计。按先修关系分配概念机制、条件边界、案例反例、迁移练习与解释答案、总结；每章职责不同，不重复七套小节。explanation每章必选，selfCheck预留章末复述，practice/answer成对，总结通常末章；writingPlan分配各章篇幅，合计全书目标。bridge用1–2句承接。previousLearning仅作主题衔接，不安排复习、不假定已掌握、不抄私人记录。
可信画像只调讲法。focuses通常0–4项，not_expressed仅指本次记录未见表述，evidenceIds=[]；possible_confusion需个人原话与来源冲突，只描述待核实。无证据不造薄弱点，概括不冒充引语。
${capabilities}
visuals只写format、section、purpose、readingQuestion；purpose一句交代要展示的节点/阶段/比较维度/变量，readingQuestion一句说明观察什么。section取explanation/boundaries/workedExample/practice/summary并选入writingPlan.sections；有助理解且有依据才安排，不把示例图种套所有主题。
输出结构：
{"title":"教材标题","teachingTypes":["general"],"teachingPlan":{"version":1,"depth":"focused","targetChars":4500},"objectives":[{"id":"O1","text":"可观察目标"}],"focuses":[],"chapters":[{"id":"ch1","title":"理解与辨析","teachingTypes":["general"],"objectiveIds":["O1"],"focusIds":[],"sourceIds":["实际来源ID"],"bridge":"主题承接","visuals":[{"format":"table","section":"workedExample","purpose":"按相同维度比较条件与结论","readingQuestion":"哪些条件改变了判断？"}],"writingPlan":{"targetChars":2200,"sections":["explanation","boundaries","workedExample","selfCheck"]}},{"id":"ch2","title":"应用与迁移","teachingTypes":["general"],"objectiveIds":["O1"],"focusIds":[],"sourceIds":["实际来源ID"],"bridge":"由理解到应用","visuals":[],"writingPlan":{"targetChars":2300,"sections":["explanation","practice","answer","selfCheck","summary"]}}]}。
示例只演示结构，teachingTypes和图种须按实际任务选择。非空focus为{"id":"F1","kind":"not_expressed","description":"本次记录未见相关表述","evidenceIds":[],"sourceIds":["实际来源ID"],"strategy":"讲授方法"}，kind另可选expressed_view/possible_confusion。
契约：objectives 1–12项、chapters 2–6项、focuses最多12项，同类ID唯一、编号数组不重复。sourceIds只取sources.sourceId，每章/每focus非空；个人ID只取context.personal.evidenceId，除not_expressed外focus须有个人证据。每章objectiveIds非空并覆盖其focus全部sourceIds，全书覆盖全部目标和focus。JSON尽量4000字符内。`;
}

export function progressiveTextbookChapterPrompt(evidence: string, guidance: string, syntax: string, output: string, readingStyle = false, richLayout = false, interactiveFigure = false, richLayoutV8 = false): string {
  return `你是教学教材作者。按已校验蓝图写当前一章；不修改蓝图，承接previousSummary。
${evidence}
${readingStyle ? TEXTBOOK_READING_STYLE_PROMPT : TEXTBOOK_PROGRESSIVE_STYLE_PROMPT}
${guidance}
事实只引用本章chapter.sourceIds及sources提供的[L/N]编号，关键解释、边界、案例及答案给出处，图表事实在相邻正文引用；不照抄示例ID。个人C/M/R只隐性调整教法，不输出个人编号、原话、画像或能力诊断。
按writingPlan分工和篇幅完成讲授，字数可浮动约四分之一；单章含源码尽量6000字符内。旧蓝图无分配时通常1500–2500汉字。已选必填小节正文至少15字；selfCheck复述按专门指导可为空。未选小节不补占位，不重复其它章。案例解释条件差异，反例检验同一命题；练习给足条件，答案解释依据、推断与未知。
只落实visualizationGuidance.targets的图种、小节、用途与问题，图前一句观察问题，图后2–3句解释和一个读图动作。练习图不泄露答案；缺依据、不支持或图块失败就保留文字解释，不因此重写或补造。
使用标准Markdown、GFM脚注、闭合代码围栏、$...$/$$...$$，正确转义JSON换行及LaTeX反斜杠。代码仅作围栏中的静态文本。正文不嵌HTML、MDX/JSX、可执行脚本、[[双链]]、任务复选框或教材边界。提示用textbook-tip围栏{"title":"提示","text":"...","kind":"tip"}，kind只选tip/warning/definition；原图用textbook-image围栏{"assetId":"本章已提供素材ID","caption":"观察说明"}，未获像素不声称识图，不自行下载图片。${richLayout ? `\n${richLayoutV8 ? TEXTBOOK_RICH_LAYOUT_GUIDANCE_V8 : TEXTBOOK_RICH_LAYOUT_GUIDANCE}` : ''}${interactiveFigure ? `\n${TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE}` : ''}
${syntax}
不写复习安排、写作过程、自查报告或占位。
${output}`;
}
