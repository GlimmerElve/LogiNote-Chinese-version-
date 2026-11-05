import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { AgentRichMessage } from '../src/components/AgentRichMessage';
import { normalizeAgentAnswerText, agentMessageDisplayContent } from '../src/services/agent/answerFormat';
import { AGENT_ROLES, runAgentTurn } from '../src/services/agent/agentEngine';
import { runAgentFinalAnswerNode } from '../src/services/agent/runtime/finalAnswerNode';
import { createAgentRunState } from '../src/services/agent/runtime/types';
import { runQaFinalAnswerGate } from '../src/services/agent/finalAnswerGate';
import { createPostToolReviewState, type QaEvidenceReviewContext } from '../src/services/agent/postToolReview';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import type { LlmConversationMessage } from '../src/types';

globalThis.fetch = async () => assert.fail('Answer-format checks must not call the network');
let groups = 0;
const pass = (label: string) => { groups++; console.log(`PASS ${label}`); };
const body = '本地证据不足；以下为通用解释。[N1]\n\n这是一个简短例子。\n\n这是第二段。';
const wrapped = JSON.stringify({ answer: body });
assert.equal(normalizeAgentAnswerText(wrapped), body);
assert.equal(normalizeAgentAnswerText(' \n' + wrapped + '\n '), body);
assert.equal(normalizeAgentAnswerText(normalizeAgentAnswerText(wrapped)), body);
pass('截图同类完整 answer 外壳解包，真实段落与中文引号保留，重复处理幂等');

const codeAndMath = '公式：$\\nabla f$，路径 `C:\\notes\\new`。\n\n```js\nconst s = "\\n";\n```';
assert.equal(normalizeAgentAnswerText(JSON.stringify({ answer: codeAndMath })), codeAndMath);
for (const unchanged of [
  codeAndMath, '字面转义示例：\\n 和 \\t',
  '```json\n{"answer":"示例\\n保留"}\n```',
  '下面是示例： {"answer":"示例"}',
  JSON.stringify({ answer: '正文', citations: [{ sourceId: 'N999' }] }),
  JSON.stringify({ answer: 42 }), JSON.stringify({ answer: '' }), JSON.stringify({ answer: '   ' }),
  JSON.stringify([{ answer: '数组数据' }]), '{"answer":"未结束',
  JSON.stringify({ answer: JSON.stringify({ answer: '嵌套结构不递归解码' }) }),
  JSON.stringify({ answer: 'x'.repeat(200_001) }),
]) assert.equal(normalizeAgentAnswerText(unchanged), unchanged);
pass('公式/路径/代码/JSON 示例、其它字段、坏格式及嵌套数据不强行改写');

const oldMessage: LlmConversationMessage = { role: 'assistant', content: wrapped, citations: [
  { sourceId: 'N1', type: 'note', entityId: 'synthetic-note', title: '合成来源', snippet: '合成证据' },
] };
assert.equal(agentMessageDisplayContent(oldMessage), body);
assert.equal(agentMessageDisplayContent({ role: 'user', content: wrapped }), wrapped);
assert.equal(agentMessageDisplayContent({ role: 'tool', content: wrapped }), wrapped);
assert.equal(agentMessageDisplayContent({ ...oldMessage, toolCalls: [{ id: 't', name: 'mock', arguments: {} }] }), wrapped);
const html = renderToStaticMarkup(<AgentRichMessage message={oldMessage} onOpenCitation={() => {}} />);
assert.ok(!html.includes('&quot;answer&quot;') && !html.includes('\\n'));
assert.ok(html.includes('<p>这是第二段。</p>') && html.includes('agent-citation-marker'));
assert.ok(html.includes('aria-label="打开来源 N1：合成来源"'));
assert.equal(oldMessage.content, wrapped, 'Legacy presentation must not rewrite stored history');
const literalHtml = renderToStaticMarkup(<AgentRichMessage message={{ role: 'assistant', content: codeAndMath }} onOpenCitation={() => {}} />);
assert.ok(literalHtml.includes('katex') && literalHtml.includes('\\n'));
pass('真实聊天组件兼容旧回答、分段/引用可访问性正常；用户及工具消息、代码和公式保留');

const evidence: QaEvidenceReviewContext = {
  review: { coverage: 'partial', supportedCitationIds: ['N1'], risks: [], answerGuidance: [] },
  sources: oldMessage.citations!,
};
const state = createAgentRunState({ runId: 'format-fixture', createdAt: '', userText: '解释合成概念', role: AGENT_ROLES.default, history: [] });
state.activeSkill = { id: 'personalized-qa', name: '答疑' };
const reviews = createPostToolReviewState(); reviews.qaEvidence = evidence;
const final = await runAgentFinalAnswerNode(state, {
  draftAnswer: wrapped, mode: 'complete', postToolReviewState: reviews, enablePostToolReview: false,
});
assert.equal(final.finalReply, body);
assert.equal(final.finalCitations?.[0].sourceId, 'N1');
assert.equal(final.draftReply, wrapped, 'Keep the raw draft as diagnostic state');
const insufficient = createPostToolReviewState();
insufficient.qaEvidence = { ...evidence, review: { ...evidence.review, coverage: 'insufficient', supportedCitationIds: [] } };
const fallback = await runAgentFinalAnswerNode(state, {
  draftAnswer: JSON.stringify({ answer: '合成通用解释。[N999]' }), mode: 'complete', postToolReviewState: insufficient,
  enablePostToolReview: true, callLlm: async () => { throw new Error('Synthetic review unavailable'); },
});
assert.ok(fallback.finalReply?.includes('本地证据不足') && !fallback.finalReply.includes('N999'));
assert.ok(!fallback.finalReply?.includes('{"answer"'));
pass('真实最终节点在证据门控前解包，不绕过来源不足披露或非法引用清理');

const noModelGate = await runQaFinalAnswerGate({ question: '合成问题', draftAnswer: wrapped,
  evidence, auditRunId: 'format-zero', maxLlmCalls: 0 });
assert.equal(noModelGate.answer, body); assert.equal(noModelGate.changed, true);
let calls = 0;
const repair = await runQaFinalAnswerGate({ question: '合成问题', draftAnswer: '错误引用 [N999]', evidence,
  auditRunId: 'format-repair', callLlm: async () => {
    calls++;
    return { content: calls === 1
      ? JSON.stringify({ valid: false, invalidCitationIds: ['N999'], unsupportedClaims: [], repairInstructions: [] })
      : JSON.stringify({ answer: '修正后的解释。[N1]\n\n第二段不能带无效引用。[D999]' }) };
  },
});
assert.equal(calls, 2); assert.ok(repair.answer.includes('[N1]') && !repair.answer.includes('D999'));
assert.ok(!repair.answer.includes('{"answer"') && repair.answer.includes('\n\n'));
pass('直接调用证据门与审核修订回包均正确解包，仍只接受本次有效引用且不增加模型轮数');

const ctx = { getNotes: () => [], getActiveNote: () => null, ensureDataFresh: async () => {},
  getPlanDraftSession: () => null, getResourceDraftSession: () => null } as unknown as AgentRuntimeContext;
const turn = await runAgentTurn({ role: AGENT_ROLES.default, userText: '你好', history: [], ctx,
  memoryPrefixLoader: async () => '', callLlm: async () => ({ content: JSON.stringify({ answer: '你好。\n\n很高兴见到你。' }) }),
});
assert.equal(turn.reply, '你好。\n\n很高兴见到你。');
assert.equal(turn.updatedHistory.at(-1)?.content, turn.reply);
assert.equal(turn.updatedHistory.filter(message => message.role === 'tool').length, 0);
pass('真实 Agent 回合与更新后会话历史存入正文，无工具调用或收费模型');

const panel = readFileSync('src/components/AgentPanel.tsx', 'utf8');
assert.ok(panel.includes('content: agentMessageDisplayContent(message)'));
assert.ok(panel.includes('copyMessage(message.content, index)') && panel.includes("prepareMessageAction('save', message.content)"));
pass('旧聊天复制/解释/存知识点与可见正文保持一致，不迁移或覆盖真实会话');
console.log(`${groups} answer-format groups passed; synthetic renderer/engine/evidence fixtures only.`);
