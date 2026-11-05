/** Portable GFM remains readable when a renderer does not recognize the labels. */
// Frozen for existing v6/v7 jobs and their request fingerprints.
export const TEXTBOOK_RICH_LAYOUT_GUIDANCE = `按讲解需要适量使用可分享的标准Markdown布局，不强制凑数：对比用引用块第一行“> **对比**”，后接同一引用块内2–3条无序列表；步骤用“> **步骤**”和有序列表；例题用“> **例题**”和题目、推导说明。列表和各段前均保留引用符>，空行写>；内容写实质讲解而非占位。公式、引用按正文规则书写，不使用HTML，不新增JSON字段。`;
export const TEXTBOOK_RICH_LAYOUT_GUIDANCE_V8 = `按教学需要适量使用可分享的标准Markdown引用块，不强制凑数：首行单独写“> **对比**”并接2–3条无序列表；“> **步骤**”接有序列表；“> **例题**”接题目与推导；也可用“> **要点**”“> **注意**”“> **思考**”“> **注释**”呈现结论、易错点、引导问题及补充说明。各段和列表行保留引用符>，空行写>；卡片之间用正文衔接。内容写实质讲解，公式与引用按正文规则书写，不使用HTML，不新增JSON字段。`;
export const TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE = '仅当调整参数、预测并观察变化能实质帮助理解，且正文已给出必要条件时，在讲解后添加标准Markdown引用块：第一行“> **交互探索**”，第二行单独写“>”作为空行，第三行以“> ”写一句不带格式的观察目标与可调整条件。每页/章最多一个，无必要则不写；不写HTML、脚本或图像代码，不新增JSON字段。';
/** Only used by newly started progressive pages; existing chapter prompts stay frozen. */
export const TEXTBOOK_INTERACTIVE_FIGURE_GUIDANCE_V2 = '判断本页是否讲清了可操作的关系：读者改变一个已明确的输入或条件，能观察到有依据的结果。若是，优先在相关讲解后添加一个标准Markdown引用块：第一行单独写“> **交互探索**”，第二行写“>”，第三行以“> ”写一句不带格式的观察目标与可调整条件。系统稍后单独处理，不在正文输出HTML、SVG、脚本或图像代码。每页最多一个；关系、条件或素材不足时不写，不编造公式和数据。';
