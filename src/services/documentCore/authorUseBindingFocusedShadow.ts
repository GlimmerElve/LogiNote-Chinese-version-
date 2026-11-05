/** One prompt-only intervention. Frozen compact input, output, parser and budget remain unchanged. */
import type { AuditInput } from './relationAuditShadow';
import { AUTHOR_USE_BINDING_PROMPT, prepareBindingDiagnosis } from './authorUseBindingShadow';

export const AUTHOR_USE_BINDING_FOCUSED_VERSION = 'author-use-binding-focused-shadow-v1';
const oldOpening = '只读诊断：依据全部给定段落，定位固定候选附近作者真实的“把什么材料用于哪条判断”。';
const newOpening = '只读诊断：依据全部给定段落，定位与固定候选有关的实际论证用途：作者用哪些材料接受、否定、独立限定哪条判断，或解释哪个现象。';
const marker = '\n每项finding仅为';
export const BINDING_ROLE_INSTRUCTION = `实际论证用途不是泛指“谈到、回应、回指或同属一段”。这些只是查找线索；最终须确定作者让哪些实际材料对哪条完整判断或具体方面发挥了什么作用，不以“回应了相关观点”代替这个定位，也不要求固定连接词。
useText只能如实表述fromIds所承载的断言如何作用于toId/toSpan，不能让ID保持不变、理由却换成同段另一条材料。若实际用的是其他节点就如实记录其他端点，未映射就按下文记缺口；不能拿目标本身充当前提，或把另一条结论当作当前整条目标。
对条件命题，区分整个“若A则B”、假设A、预测B和对假设的回应。作者用结果否定A，不自动表明他否定或支持整个条件关系；若只是在讨论这次回应，也不自动有对整个条件关系的论证用途。仅在原文实际如此使用时记录，不自行套用逻辑演算造边。
对独立限定，定位作者实际限制的是什么：本项判断的依据、可保证范围或确定程度，还是另一条根本未提出的更强主张。作者明说本项比较的证据范围有限、不能担保其他情境，可以是对本项判断的独立限定；无需目标先声称适用所有情境，也无需否定原情境下的结果。反之，“没有声称唯一/没有否认其他可能”本身不把普通机制或相容判断变成带有唯一性、排他性承诺的靶子。依据具体语境判断，不把每句保留意见都连成边。`;
if (!AUTHOR_USE_BINDING_PROMPT.startsWith(oldOpening) || !AUTHOR_USE_BINDING_PROMPT.includes(marker)) {
  throw new Error('Frozen compact prompt layout changed; focused binding experiment requires review');
}
export const AUTHOR_USE_BINDING_FOCUSED_PROMPT = AUTHOR_USE_BINDING_PROMPT
  .replace(oldOpening, newOpening)
  .replace(marker, `\n${BINDING_ROLE_INSTRUCTION}${marker}`);

export function prepareFocusedBindingDiagnosis(input: AuditInput) {
  return { ...prepareBindingDiagnosis(input), version: AUTHOR_USE_BINDING_FOCUSED_VERSION, systemPrompt: AUTHOR_USE_BINDING_FOCUSED_PROMPT };
}

// Identity exports, not alternate implementations or a widened parser.
export { parseBindingDiagnosis, compareUseBindings, makeBindingBatches } from './authorUseBindingShadow';
