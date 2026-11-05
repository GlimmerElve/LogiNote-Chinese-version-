import { DOCUMENT_CORE_SEMANTIC_OUTLINE_PROMPT } from './documentCoreSemanticOutlinePrompt';

export const DOCUMENT_CORE_SEMANTIC_OUTLINE_V2_VERSION = 'document-core-semantic-outline-v2' as const;
const previous = `inferences每项为{"premises":["依据命题id"],"target":"被支持或质疑的命题id","kind":"support或oppose"}。联合理由放同一数组，独立理由分开；中间命题可作为后续依据。反对的目标是被质疑的命题，不能因为某段属于反方就给同一立场的两句话标oppose。
conclusions只选主要回应，conditions/limitations引用对应命题id，它们不是自动支持边。原文没有明确推导就不造边；unresolved用文字说明具体不确定性。不要输出节点角色、逐字引文、quote定位字段、辅助关系或逐步内部思考过程。`;
const replacement = `inferences每项为{"premises":["依据命题id"],"target":"被支持或质疑的命题id","kind":"support或oppose"}。按作者实际论证用途区分：
- support：这些理由使哪个判断成立？结果须连到作者据此得出的判断，不只复述结果或反方。假设推出待检验预期，不反用预期证明假设；概念不同本身不证明实证效应独立。
- oppose：这些证据削弱哪个原判断？保留双方的对象、条件和结果范围；不同范围的例外不直接相反，“还有别的机制”不否定“这是一个机制”。
- conditions：目标判断在哪些适用条件下成立？不是其依据清单。
- limitations：目标不能断言到什么程度？不等于目标错误，也不是实践建议的理由。
联合理由放同一数组，独立理由分开；中间命题用同一id回接。conclusions只选主要回应，conditions/limitations引用对应命题id，不能引用自身，也不自动变成逻辑边。原文没有明确推导就不造边；unresolved用文字说明具体不确定性。不要输出节点角色、逐字引文、quote定位字段、辅助关系或逐步内部思考过程。`;
if (!DOCUMENT_CORE_SEMANTIC_OUTLINE_PROMPT.includes(previous)) throw new Error('冻结的v1关系段已变化，停止准备v2对照');
// Only relationship semantics change; source task, wire fields, limits and transport stay frozen.
export const DOCUMENT_CORE_SEMANTIC_OUTLINE_V2_PROMPT = DOCUMENT_CORE_SEMANTIC_OUTLINE_PROMPT.replace(previous, replacement);
