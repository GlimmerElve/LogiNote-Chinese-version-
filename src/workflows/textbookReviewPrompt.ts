import { TEXTBOOK_COMPACT_QUALITY_PROMPT } from './textbookPromptV2';

/** Only the quality request uses this wire protocol. Author prompts/checkpoints stay unchanged. */
export function indexedTextbookReviewPrompt(base: string): string {
  const end = TEXTBOOK_COMPACT_QUALITY_PROMPT.indexOf('\n输出{');
  const suffix = base.startsWith(TEXTBOOK_COMPACT_QUALITY_PROMPT) ? base.slice(TEXTBOOK_COMPACT_QUALITY_PROMPT.length) : '';
  return `${TEXTBOOK_COMPACT_QUALITY_PROMPT.slice(0, end)}
文本以[{ref,text}]提供，每个ref唯一标识本次原文片段；原文只出现一次。只用现有ref，不从标题猜测或编造编号，不必重抄引文或改写公式。
仅输出{"schemaVersion":4,"passed":true,"findings":[]}；有重大明确错误才passed=false，通常至多8条。每条finding含severity(blocker/warning)、impact(critical/minor)、certainty(clear/uncertain)、category、target:{"ref":"教材片段编号"}、message、reason、basis:[{"ref":"依据片段编号"}]。ref只是定位，不是正确性证明；说明具体错误及其学习影响。
target只能指向章节小节、objective、focus或bridge的T编号；basis可用来源S、另一处教材T、任务K、个人记录P、上次主题H。factual_support的blocker须有本章允许的来源S；internal_consistency须有另一处不同教材论断T；task_alignment须有任务K或objective的T；personalization须有P/H/S。个人记录不能否决事实。
可选quote仅在需要缩小片段范围时逐字复制；省略则程序直接定位整段，禁止概括或省略号拼接。找不到位置的普通呈现建议可以不报；若确有重大明确错误但定位困难，应核对ref后报告，不得假装通过。reportCorrection仅说明上次报告的定位错误，须重新核对当前原文，不能把错误报告当教材事实或改写章节。${suffix}`;
}
