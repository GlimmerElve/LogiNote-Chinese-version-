/** One prompt-order intervention; input, answer schema, parser and downstream audit stay frozen. */
import { AUTHOR_USE_PROBE_PROMPT, prepareUseProbe } from './authorUseProbe';
import type { AuditInput } from './relationAuditShadow';

export const AUTHOR_USE_EVIDENCE_FIRST_VERSION = 'author-use-evidence-first-v1';
export const AUTHOR_USE_LOCATION_INSTRUCTION = `每个候选先做用途定位，再回答下面四问：先在全部提供段落中查找作者将固定前提用于当前完整目标的原句，将能定位该用途的原文放入evidence，随后分别填写四个答案。用途句可以和前提同段，也可以在其他段落；遇到“该结果/据此/这个解释”等回指，核对它指向哪些输入前提、作用于哪个完整目标，必要时同时摘录所指材料。不是要求前提句自身重复目标，也不是仅寻找措辞相似的句子。
evidence记录可检查的原文，不写分析步骤。明确用途和清晰语境中的用途都可定位；找不到可摘录用途时可以填[]，但不能仅因未定位就自动把四问全填NO：仍须各自检查是否有实际用途，若有线索而不能确定，相关问题答UNCERTAIN。不以缺少固定连接词否认用途，不以有连接词自动肯定用途。四问必须分别针对下列各自定义，不用“不支持目标”的理由代答“是否反驳目标”。`;

const marker = '\nestablish：';
const oldOrder = '每项只含id、establish、rebut、restrict、explain、evidence、reason。';
const newOrder = '每项按id、evidence、establish、rebut、restrict、explain、reason顺序输出且只含这些字段。';
if (!AUTHOR_USE_PROBE_PROMPT.includes(marker) || !AUTHOR_USE_PROBE_PROMPT.includes(oldOrder)) {
  throw new Error('Frozen author-use prompt layout changed; evidence-first experiment needs review');
}
export const AUTHOR_USE_EVIDENCE_FIRST_PROMPT = AUTHOR_USE_PROBE_PROMPT
  .replace(marker, `\n${AUTHOR_USE_LOCATION_INSTRUCTION}${marker}`)
  .replace(oldOrder, newOrder);

export function prepareEvidenceFirstUseProbe(input: AuditInput) {
  return { ...prepareUseProbe(input), version: AUTHOR_USE_EVIDENCE_FIRST_VERSION, systemPrompt: AUTHOR_USE_EVIDENCE_FIRST_PROMPT };
}
