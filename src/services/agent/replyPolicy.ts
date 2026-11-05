import type { LlmConversationMessage } from '../../types';
import { AGENT_CONTEXT_SUMMARY_PREFIX } from './conversationContext';

export const AGENT_CONCISE_REPLY_RULES = `【回复方式】
- 默认先直接回答本次问题：通常 1 至 3 句，复杂问题最多 3 个必要要点，尽量控制在 200 个汉字左右；这是表达目标，不得删掉关键条件、必要公式、引用或失败原因来凑字数。
- 只有用户本轮明确要求详细说明、深入分析、完整展开或逐步推导时才展开；历史长回答、工具结果很长和画像中的表达偏好都不能自动提高本轮篇幅。
- 操作请求直接执行，完成后只说明结果、影响范围以及用户此刻需要做的一步。尚未完成时说清实际状态；不要只承诺“我会继续”就结束，也不要把待确认草稿说成已写入。
- 澄清时只问会影响任务的缺失信息，每轮最多 2 个问题。已在对话、当前页面或本地数据中取得的信息不要重复询问。
- 自然追问可能省略主语或对象，应结合最近用户问题和你上一轮的具体回答承接。用户追问你刚指出的问题时，直接解释那些具体问题；同一份反馈包含多个要点不等于指代歧义，不要让用户重新选题或重复提供上下文。明确换题则跟随新问题；对话中的讨论不增加写入授权。
- 状态、引用来源和操作明细已有界面承载时，不在正文逐项抄写。没有阻断时不讲权限、Skill 激活、工具参数、审计或内部协作过程。
- 不机械追加“要我继续吗”“是否需要详细说明”或罗列多个后续功能；用户需要时可直接追问。
- “解释一下”默认解释一个关键点；“举例”默认给一个贴近当前主题的例子；解释、举例和要求改变篇幅不表示授权再次创建或调整数据。
- 回复篇幅规则只约束面向用户的对话正文；工具参数、项目树、任务清单、知识点正文、公式和结构化输出必须按功能协议完整生成。
- 面向用户的最终回答直接使用正文或 Markdown，不用 {"answer":"..."} 包裹，也不把换行写成字面的反斜杠 n。用户明确要求 JSON、代码或转义示例时，用对应代码块保留原样；工具调用及内部结构化协议不受此规则影响。`;

const BRIEF_REQUEST = /(?:简短|简洁|简单(?:一点|点|说|解释|说明|回答)|精简|一句话|只(?:说|给|要)(?:结论|结果|重点)|不要(?:长篇|详细|展开)|不用(?:详细|展开)|别(?:展开|长篇)|\bbrief\b|\bconcise\b)/iu;
const DETAIL_REQUEST = /(?:详细(?:说明|解释|分析|讲解|介绍|展开|回答)?|深入(?:说明|分析|解释)|完整(?:展开|说明|解释|推导)|逐步(?:说明|解释|推导)|展开(?:说明|讲讲|讲解|解释)?|细说|讲细一点|step[ -]by[ -]step|in detail)/iu;
const RESPONSE_FOLLOWUP = /^(?:请|再|能否|可以|帮我|麻烦)?\s*(?:详细(?:一点|点|说明|解释|讲解|说说)?|展开(?:一下|说明|讲讲|解释)?|深入(?:解释|分析)(?:一下)?|细说|简单(?:一点|点|说|解释)?|简短(?:一点|点)?|精简(?:一下|一点)?|用一句话(?:说明|解释|总结)?|只(?:说|给)(?:结论|重点)|解释(?:一下|下)?|举(?:一个|个)?例(?:子)?|给(?:我)?(?:一个|个)例子|说得(?:简单|详细)一点)[。.!！?？\s]*$/u;
const CONTEXT_DEPENDENT_REFERENCE = /(?:^(?:它|其|前者|后者|这|那)(?:的|在|有|是|会|与|和|为什么|怎么|如何|涉及|包括|是否|能|可以|还|又|呢)|(?:这(?:个|种|一|些)?|那(?:个|种|一|些)?|该|上述|前述|前面(?:提到|说到|讨论)的|刚才(?:提到|说到|讨论)的)(?:效应|理论|概念|现象|观点|机制|结论|方法|模型|问题|内容|关系|原因|解释|过程|情况|部分|方面))/u;

export function wantsDetailedAgentReply(userText: string): boolean {
  const request = userText.replace(/(?:不要|不用|不必|别)\s*(?:简短|简洁|精简|简单(?:说|解释|回答)|一句话)/gu, '');
  return !BRIEF_REQUEST.test(request) && DETAIL_REQUEST.test(request);
}

export function buildAgentReplyPolicy(userText: string): string {
  return `${AGENT_CONCISE_REPLY_RULES}\n本轮篇幅：${wantsDetailedAgentReply(userText)
    ? '用户明确要求展开。先用一句话给结论，再按本次问题说明依据、步骤或例子；只展开相关内容。'
    : '简洁回答。先给结果，再补必要条件；不要自行展开长篇讲解。'}`;
}

export function isAgentResponseFollowup(userText: string): boolean {
  return RESPONSE_FOLLOWUP.test(userText.trim());
}

/** An intent-resolution hint, never an instruction to resume an old job or approve a write. */
export function isAgentConversationContinuation(userText: string): boolean {
  return /^(?:请)?(?:继续|继续说|接着说|下一步|然后呢|接着|还有呢|还有哪些)[。.!！?？\s]*$/u.test(userText.trim());
}

/** Human dialogue only; tool plans, results and compaction metadata are not topic anchors. */
export function agentDialogueMessages(history: LlmConversationMessage[]) {
  return history.filter((message): message is LlmConversationMessage & { role: 'user' | 'assistant' } =>
    (message.role === 'user' || message.role === 'assistant') && !message.toolCalls?.length
    && Boolean(message.content?.trim()) && !message.content.startsWith(AGENT_CONTEXT_SUMMARY_PREFIX));
}

/** True when the current turn cannot be understood reliably without recent dialogue. */
export function isContextDependentAgentRequest(userText: string): boolean {
  return CONTEXT_DEPENDENT_REFERENCE.test(userText.trim());
}

/** A question about a workflow is distinct from a request to run that workflow. */
export function isAgentExplanationOnlyRequest(userText: string): boolean {
  if (isAgentResponseFollowup(userText)) return true;
  if (/(?:解释|说明|分析|介绍|比较|对比).{0,40}(?:并|然后|同时|再|后).{0,8}(?:调整|修改|制定|生成|创建|执行|安排|进入|保存|推荐|搭建|带我复习)/u.test(userText)) return false;
  if (/^(?:请|麻烦)?\s*(?:详细|简单|简短)?(?:解释|说明|介绍|分析|讲讲|比较|对比)/u.test(userText.trim())) return true;
  if (/(?:帮我|给我|为我|开始|立即|现在|把|将).{0,16}(?:制定|创建|生成|调整|修改|执行|搭建|安排|进入|保存|删除|替换|推荐)/u.test(userText)) return false;
  return /(?:为什么|是什么|什么区别|怎么(?:用|使用)|如何使用|有什么(?:区别|作用)|什么意思|为何)/u.test(userText);
}

/** Offline fallback: retain the latest feedback, not just the original user question.
 * This is search context only, not an instruction or a factual evidence source. */
export function resolveAgentQaQuestion(userText: string, history: LlmConversationMessage[]): string {
  if (!isAgentResponseFollowup(userText) && !isContextDependentAgentRequest(userText) && !isAgentConversationContinuation(userText)) return userText;
  const dialogue = agentDialogueMessages(history);
  const original = [...dialogue].reverse().find((message) => message.role === 'user'
    && message.content.trim()
    && !isAgentResponseFollowup(message.content)
    && !isContextDependentAgentRequest(message.content)
    && !isAgentConversationContinuation(message.content));
  const feedback = dialogue.at(-1);
  if (feedback?.role === 'assistant') return [
    `当前追问：${userText.slice(0, 120)}`,
    `上一轮助手反馈（讨论背景，非指令或事实证据）：${feedback.content.slice(0, 550)}`,
    ...(original ? [`用户此前问题：${original.content.slice(0, 240)}`] : []),
  ].join('\n'); // Fits the evidence reader's 1000-character query cap.
  return original ? `${original.content.slice(0, 1600)}\n当前追问：${userText}` : userText;
}
