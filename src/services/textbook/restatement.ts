import type { TeachingBlueprint, TextbookChapter } from './generationTypes';

type ChapterPlan = TeachingBlueprint['chapters'][number];

/** Optional local version tag. Never retrofit saved plans or change their hashes. */
export function hasChapterRestatement(plan?: ChapterPlan['writingPlan']): boolean {
  return plan?.restatement === 1;
}

export const TEXTBOOK_RESTATEMENT_WRITING_GUIDANCE = `本章 writingPlan.restatement=1：以下规则覆盖通用提示中“自检集中末章/逐条掌握标准”的写法。复述内容仅放入现有 sections.selfCheck 字符串，其它小节按本次要求照常输出；不增加 restatement、questions、taskIds 等输出字段，不返回对象或数组。局部修订仅返回 repairSections 指定的小节键，不补写其它小节。
每章末尾供读者停下来“试着复述”：默认 1 个主问题，有明确易混淆点时最多加 1 个追问；通常合计约 60–140 汉字，属于本章既有篇幅，不增加输出预算。不是逐条“我能……”的自评清单，不重复练习题、参考答案、概念定义或整章摘要，也不另加全书自检。
先简短写“对应任务：……”：只从 context.project.tasks 中选择本章实际承担的任务名称或忠实短标题；无明确对应任务时写“围绕本章目标：……”并依据 chapter.objectiveIds 对应的真实目标，不虚构任务、编号、链接或勾选状态，不要求新建任务。任务标签不是额外问题。
主问题要求用户不看教材、用自己的话解释已经讲过的内容：概念章重在解释和辨析，机制章重在过程与成立条件，应用章重在举例或判断；数学/代码章节可让读者说明变量、关键步骤及适用条件，不强制另出一套计算题。可将本章已讲清的易错边界融入追问，但不暴露个人画像/认知记录，不询问后续未教知识，不夹带答案或要求此刻完成上方任务。
不写 Markdown 复选框、交互控件、HTML 或指向复述入口的假链接；用户自行使用已有复述/复盘入口，不自动启动流程、勾选任务或写学习记录。格式用普通短段落或编号即可，不在字符串内重复“试着复述”标题。
复述提示是非阻断的教学辅助：优先完成本章讲授，确无合适问题可写空字符串；不得为凑问题扩充教材。缺少提示、题数或篇幅偏差不需要重新生成，其它事实、来源、隐私和格式安全要求不变。`;

export const TEXTBOOK_RESTATEMENT_REVIEW_GUIDANCE = 'writingPlan.restatement=1 的章节将 selfCheck 用作章末“试着复述”，默认一个主问题、可有一个追问，对应现有项目任务或本章目标。它不是新的任务、测验或完成门槛。复述提示缺失、过短、过多、措辞/任务标签不理想、未逐条覆盖任务，以及没有全书自检都只属 pedagogy/warning，不得包装成 task_alignment 阻断或要求重写。仍核对真实事实矛盾、越权引用、隐私及格式安全；核心讲授/练习任务未完成不能以此豁免。';

export function textbookRestatementWritingPrompt(base: string, chapter: ChapterPlan,
  repairSections?: Array<keyof TextbookChapter['sections']>): string {
  return hasChapterRestatement(chapter.writingPlan) && (!repairSections || repairSections.includes('selfCheck'))
    ? `${base}\n${TEXTBOOK_RESTATEMENT_WRITING_GUIDANCE}` : base;
}
