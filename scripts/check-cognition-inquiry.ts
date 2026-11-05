import assert from 'node:assert/strict';
import { applyCognitionMutation, emptyCognitionFile, latestCognition } from '../src/services/cognition/core';
import { buildInquirySnapshot, resolveInquiryQuestion, validateInquiryAnswer, checkInquiryAnswer } from '../src/services/cognition/inquiry';
import { callLLM } from '../src/services/llmService';
import { wantsCognitionRecall } from '../src/services/cognition/retrieval';
import { profileInquiryDetails } from '../src/services/profile/inquiryDetails';
import { runAgentTurn, AGENT_ROLES, trimQaConversationHistory } from '../src/services/agent/agentEngine';
import { registerQaTools } from '../src/services/agent/tools/qaTools';
import { registerDataTools } from '../src/services/agent/tools/dataTools';
import { inquiryReviewer } from './fixtures/cognition-inquiry-reviewer';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import type { CognitionFile } from '../src/services/cognition/types';
import type { UserProfile, LlmConversationMessage } from '../src/types';

let passed = 0;
async function test(name: string, run: () => unknown | Promise<unknown>) { await run(); passed++; console.log(`PASS ${name}`); }
function seed(count = 12): CognitionFile {
  return applyCognitionMutation(emptyCognitionFile(), { kind: 'confirm', confirmed: true, expectedRevision: 0, operation: 'initial', authorship: 'own_expression', stance: 'endorsed', reason: '',
    doc: { doc_id: 'chain', title: '决策思考', nodes: Array.from({ length: count }, (_, i) => ({ id: `n${i}`, mainType: i === 10 ? '举例' : '事实陈述',
      text: i === 0 ? '选择过载会增加比较成本。' : i === 10 ? '果酱实验是我采用的例子。' : `第 ${i} 个推理步骤记录了决策限制。` })),
    edges: Array.from({ length: count - 1 }, (_, i) => ({ id: `e${i}`, source: `n${i}`, target: `n${i + 1}`, relation: i === 8 ? 'oppose' : 'support' })) },
  }, { id: 'v1', at: '2026-10-04T00:00:00Z' });
}
function largeConditionFile() {
  const file = seed(8), conditions = Array.from({ length: 40 }, (_, i) => `条件${i}：${'学'.repeat(450)}`);
  for (const node of latestCognition(file.records[0]).branches[0].graph.nodes) Object.assign(node, { text: `${conditions.join('；')}时我倾向于接受该观点。`, conditions: [...conditions] });
  return file;
}
await test('条件元数据按条数、单条长度及总长度截断，告知范围且不修改原库', () => {
  const file = largeConditionFile(), before = JSON.stringify(file), snapshot = buildInquirySnapshot(file, '我的认知库'), page = snapshot.pages[0];
  for (const source of page.sources) {
    assert.ok(source.conditions!.length <= 8);
    assert.ok(source.conditions!.every(condition => condition.length <= 160));
    assert.ok(source.conditions!.reduce((total, condition) => total + condition.length, 0) <= 640);
    assert.equal(source.conditionsTotal, 40); assert.equal(source.conditionsTruncated, true); assert.equal(source.truncated, true);
  }
  assert.ok(JSON.stringify(page).length < 24000, 'one page must not expand from ~16k to ~162k through condition metadata');
  assert.match(snapshot.warnings.join('\n'), /条件.*截断/);
  assert.equal(JSON.stringify(file), before, 'read projection cannot truncate persisted conditions');
  const short = seed(1), shortNode = latestCognition(short.records[0]).branches[0].graph.nodes[0];
  Object.assign(shortNode, { text: '目标清晰且挑战适中时，我更容易进入心流。', conditions: ['目标清晰', '挑战适中'] });
  const whole = buildInquirySnapshot(short, '我的认知库').pages[0].sources[0];
  assert.deepEqual(whole.conditions, shortNode.conditions); assert.equal(whole.conditionsTotal, 2); assert.equal(whole.conditionsTruncated, false);
  assert.equal(whole.truncated, false);
  const legacy = buildInquirySnapshot(seed(1), '我的认知库').pages[0].sources[0];
  assert.equal(legacy.conditions, undefined); assert.equal(legacy.conditionsTotal, undefined);
});
await test('自己的信念、历史和画像自然语言入口，普通答疑仍不打开', () => {
  for (const q of ['我相信哪些事实', '我的认知有哪些暂定假设', '我的用户画像是什么', '我的学习习惯是什么', '我为什么改变了对选择过载的看法', '我的理解发生了哪些变化']) assert.ok(wantsCognitionRecall(q), q);
  assert.equal(wantsCognitionRecall('解释选择过载'), false);
  assert.equal(wantsCognitionRecall('不要读取我的认知库，解释选择过载'), false);
  assert.equal(wantsCognitionRecall('不要查看我的画像'), false);
  assert.equal(wantsCognitionRecall('我不希望你读取我的学习记录'), false);
});
await test('从命中节点读取超过一跳的连通论证，保留方向、反对边和例子', () => {
  const snapshot = buildInquirySnapshot(seed(), '我是如何看待选择过载的');
  assert.equal(snapshot.mode, 'topic'); assert.equal(snapshot.counts.selectedNodes, 12); assert.equal(snapshot.pages.length, 2);
  assert.ok(snapshot.pages[1].sources.some((s) => s.mainType === '举例'));
  assert.ok(snapshot.pages[1].edges.some((e) => e.source === 'C9' && e.target === 'C10' && e.relation === 'oppose'));
  assert.equal(snapshot.pages[0].sources.length, 8);
});
await test('当前认同按个人立场筛选，不用旧九类判定事实或遗漏新角色', () => {
  const file = seed(45), graph = latestCognition(file.records[0]).branches[0].graph;
  graph.nodes[2].stance = 'tentative'; graph.nodes[3].mainType = '推理';
  const snapshot = buildInquirySnapshot(file, '我相信哪些事实');
  assert.equal(snapshot.mode, 'overview'); assert.equal(snapshot.counts.currentNodes, 45);
  assert.equal(snapshot.counts.endorsedFacts, 42); assert.equal(snapshot.counts.endorsedNodes, 44); assert.equal(snapshot.counts.selectedNodes, 44); assert.equal(snapshot.pages.length, 6);
  assert.ok(snapshot.pages.every((p) => p.sources.every((s) => s.stance === 'endorsed')));
  assert.equal(buildInquirySnapshot(file, '我认同哪些观点').counts.selectedNodes, 44);
  assert.equal(buildInquirySnapshot(file, '我的用户画像和掌握情况是什么').counts.selectedNodes, 45);
  assert.equal(buildInquirySnapshot(file, '我的认知发生了哪些变化').mode, 'history');
  assert.equal(buildInquirySnapshot(file, '我的认知发生了哪些变化').counts.selectedNodes, 45);
});
await test('历史独立标识，旧主张不混入当前，旧主题也可定位历史', () => {
  const file = seed();
  const updated = applyCognitionMutation(file, { kind: 'update_cognition', expectedRevision: file.revision, confirmed: true,
    target: { recordId: 'chain', revisionId: 'v1', branchId: 'primary', nodeId: 'n0', operation: 'revise', reason: '调整适用条件' },
    text: '复杂任务中较多选项可能增加比较成本。', mainType: '假设', stance: 'tentative', authorship: 'own_expression' }, { id: 'v2', at: '2026-10-05T00:00:00Z' });
  const historical = buildInquirySnapshot(updated, '我以前如何看待选择过载');
  assert.equal(historical.mode, 'history'); assert.equal(historical.counts.selectedNodes, 24);
  assert.ok(historical.pages.flatMap((p) => p.sources).some((s) => !s.current && s.text.includes('选择过载')));
  const current = buildInquirySnapshot(updated, '我是如何看待复杂任务的');
  assert.ok(current.pages.flatMap((p) => p.sources).every((s) => s.current && !s.text.includes('选择过载')));
});
await test('引用必须来自已读来源且逐字存在，拒绝伪造和未读页', () => {
  const sources = buildInquirySnapshot(seed(), '我是如何看待选择过载的').pages[0].sources;
  const valid = { action: 'answer', paragraphs: [{ text: '你认为选项增加会提高比较成本。', evidence: [{ id: 'C1', quote: '选择过载会增加比较成本。' }] }] };
  assert.ok(validateInquiryAnswer(valid, sources));
  assert.equal(validateInquiryAnswer({ ...valid, paragraphs: [{ ...valid.paragraphs[0], evidence: [{ id: 'C99', quote: '选择过载会增加比较成本。' }] }] }, sources), undefined);
  assert.equal(validateInquiryAnswer({ ...valid, paragraphs: [{ ...valid.paragraphs[0], evidence: [{ id: 'C1', quote: '不存在的引文' }] }] }, sources), undefined);
});
await test('已核验的重复正文引用不误拒绝，伪造标记及近似引文仍被拦截', () => {
  const sources = buildInquirySnapshot(seed(), '我是如何看待选择过载的').pages[0].sources;
  const answer = (text: string, quote = ' 选择过载会增加比较成本。 ') => ({ action: 'answer', paragraphs: [{ text, evidence: [{ id: 'C1', quote }] }] });
  assert.equal(checkInquiryAnswer(answer('你认为选项多增加比较成本。[C1]'), sources).answer?.text, '你认为选项多增加比较成本。 [C1]');
  assert.equal(checkInquiryAnswer(answer('你认为选项多增加比较成本。[C99]'), sources).error, 'invalid_inline_citation');
  assert.equal(checkInquiryAnswer(answer('概括', '选择过载将增加比较成本。'), sources).error, 'quote_mismatch');
  for (const raw of [null, 'answer', [], { action: 'answer', paragraphs: [null] }]) assert.equal(checkInquiryAnswer(raw, sources).error, 'invalid_structure');
});
await test('画像详细依据只投影已采信指标，不泄漏整个门控状态或无关片段', () => {
  const profile = { evidenceGate: { aggregates: {
    a: { status: 'trusted', dimension: 'ability', indicator: 'reasoningValidity', mean: 70, confidence: 0.8, samples: [{ episodeId: 'review', evidenceSnippetIds: ['s1'], observedAt: '2026-10-04', value: 70 }] },
    b: { status: 'holding', indicator: 'never-send', samples: [] },
  }, processedEpisodeIds: ['private-internal'] } } as unknown as UserProfile;
  const result = profileInquiryDetails(profile, [{ id: 'review', type: 'review', title: '复习', evidenceSnippets: [
    { id: 's1', text: '指出了推理的边界条件。', source: 'scored_analysis', type: 'success', importance: 1 },
    { id: 's2', text: '无关私人片段', source: 'user_statement', type: 'observation', importance: 1 },
  ] }] as never);
  assert.equal(result.length, 1); assert.match(result[0], /边界条件/);
  assert.doesNotMatch(result[0], /never-send|private-internal|无关私人片段/);
});

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), previousFetch = globalThis.fetch;
let stored = seed(), writes = 0, profileReads = 0, fail = false;
const ctx = { getNotes: () => [], getActiveNote: () => null, ensureDataFresh: async () => {}, getPlanDraftSession: () => null, getResourceDraftSession: () => null } as unknown as AgentRuntimeContext;
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { electronAPI: {
  userState: { loadCognition: async () => { if (fail) throw new Error('unavailable'); return structuredClone(stored); }, mutateCognition: async () => { writes++; throw new Error('write forbidden'); },
    loadLearningEpisodes: async () => ({ version: 2, episodes: [] }), saveLearningEpisodes: async () => { writes++; } },
  agent: { queryProfile: async (args: { includeEvidence: boolean }) => { profileReads++; assert.equal(args.includeEvidence, true); return { text: '系统观察到你倾向核对推理条件。', details: ['某次复习中明确给出了适用条件。'] }; },
    queryMastery: async () => ({ rows: [{ title: '选择过载', evidenceSamples: 1, reviewCount: 1 }] }) },
} }) });
globalThis.fetch = async () => { throw new Error('No network'); };
registerQaTools(); registerDataTools();
const run = (question: string, history: LlmConversationMessage[] = [], caller = async (r: Parameters<typeof inquiryReviewer>[0]) => inquiryReviewer(r)) => runAgentTurn({ role: AGENT_ROLES.default, userText: question, history, ctx, memoryPrefixLoader: async () => '', enableMultiAgent: true, callLlm: caller });
try {
  await test('真实 Agent 请求仅发送受限条件节选，并在简洁回答中明确提示条件不完整', async () => {
    stored = largeConditionFile(); const original = JSON.stringify(stored); let calls = 0;
    const result = await run('我相信哪些事实', [], async request => {
      calls++; assert.ok(request.userInput.length < 27000, 'actual outgoing prompt remains bounded');
      const body = JSON.parse(request.userInput), source = body.pages[0].sources[0];
      assert.equal(source.conditionsTruncated, true); assert.equal(source.conditionsTotal, 40);
      assert.match(request.systemPromptOverride || '', /conditionsTruncated/);
      return { content: '', parsedJson: { action: 'answer', paragraphs: [{ text: '记录包含适用条件，但本次只是节选，不能判断完整适用范围。', evidence: [{ id: source.id, quote: source.text.slice(0, 16) }] }] } };
    });
    assert.equal(calls, 1); assert.match(result.reply, /适用条件.*截断|条件.*不完整/);
    assert.equal(JSON.stringify(stored), original); assert.equal(writes, 0);
  });
  await test('真实 LLM 服务层向 IPC 转发逐次 JSON 配置，默认普通答疑不改变', async () => {
    const api = (window as unknown as { electronAPI: { llm?: unknown } }).electronAPI;
    const oldLlm = api.llm, oldStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
    const schemas: unknown[] = [];
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: () => null, setItem: () => {} } });
    api.llm = { request: async (body: { outputSchema?: object }) => { schemas.push(body.outputSchema); return { content: '{}' }; } };
    try {
      const base = { providerId: '', model: '', workflow: 'agent-chat' as const, userInput: 'synthetic', skipMemoryInjection: true };
      await callLLM({ ...base, outputSchema: { type: 'object' } });
      await callLLM(base);
      assert.deepEqual(schemas, [{ type: 'object' }, undefined]);
    } finally {
      api.llm = oldLlm;
      if (oldStorage) Object.defineProperty(globalThis, 'localStorage', oldStorage); else Reflect.deleteProperty(globalThis, 'localStorage');
    }
  });
  await test('格式失败仅修正一次，JSON 输出贯穿请求且不回传被拒绝的回答', async () => {
    stored = seed(); let calls = 0;
    const result = await run('我是如何看待选择过载的', [], async (request) => {
      calls++; assert.deepEqual(request.outputSchema, { type: 'object' });
      if (calls === 1) return { content: 'rejected-payload-private-marker' };
      const body = JSON.parse(request.userInput);
      assert.equal(body.correction, 'invalid_json'); assert.equal(body.canReadMore, false);
      assert.doesNotMatch(request.userInput, /rejected-payload-private-marker/);
      return inquiryReviewer(request);
    });
    assert.equal(calls, 2); assert.doesNotMatch(result.reply, /以下不是综合分析/);
    const steps = result.toolTrace.filter((s) => s.call.name === 'synthesize_cognition_answer');
    assert.deepEqual(steps.map((s) => (s.result as { code: string }).code), ['invalid_json', 'accepted']);
    assert.doesNotMatch(JSON.stringify(steps), /rejected-payload-private-marker|选择过载/);
  });
  await test('默认画像问答不自动附长篇原文，展开请求继承主题但不继承篇幅', async () => {
    stored = seed();
    const answer = async (request: Parameters<typeof inquiryReviewer>[0]) => ({ content: '', parsedJson: {
      action: 'answer', paragraphs: [{ text: '你认为选项过多会增加比较成本。', evidence: [{ id: 'C1', quote: '选择过载会增加比较成本。' }] }],
    } });
    const brief = await run('我是如何看待选择过载的', [], async (request) => {
      assert.match(request.systemPromptOverride || '', /本轮篇幅：简洁回答/);
      return answer(request);
    });
    assert.doesNotMatch(brief.reply, /依据：\n|本次只读|分类统计|当前认知库共/);
    assert.match(brief.reply, /\[C1\]/); assert.ok(brief.reply.length < 200);
    const detailed = await run('再详细一点', brief.updatedHistory, async (request) => {
      assert.match(JSON.parse(request.userInput).question, /如何看待选择过载/);
      assert.match(request.systemPromptOverride || '', /本轮篇幅：用户明确要求展开/);
      return answer(request);
    });
    assert.match(detailed.reply, /依据：\n/);
    assert.equal(detailed.updatedHistory.at(-1)?.cognitionReferences?.length, 1);
    const briefAgain = await run('简单说', detailed.updatedHistory, async (request) => {
      assert.match(request.systemPromptOverride || '', /本轮篇幅：简洁回答/);
      return answer(request);
    });
    assert.doesNotMatch(briefAgain.reply, /依据：\n/); assert.equal(writes, 0);
  });
  await test('伪造引文修正失败有明确原因，不弱化依据检查', async () => {
    stored = seed(); let calls = 0;
    const result = await run('我是如何看待选择过载的', [], async () => {
      calls++; return { content: '', parsedJson: { action: 'answer', paragraphs: [{ text: '虚构综合结论', evidence: [{ id: 'C1', quote: '不存在的引文' }] }] } };
    });
    assert.equal(calls, 2); assert.match(result.reply, /引文与来源原文不匹配/); assert.match(result.reply, /一次修正/);
    assert.doesNotMatch(result.reply, /虚构综合结论/);
  });
  await test('服务调用失败不重试、不伪报引用错误、不泄露错误载荷', async () => {
    stored = seed(); let calls = 0;
    const result = await run('我是如何看待选择过载的', [], async () => { calls++; throw new Error('private-network-error'); });
    assert.equal(calls, 1); assert.match(result.reply, /模型服务调用失败/);
    assert.doesNotMatch(result.reply, /引文与来源原文不匹配|private-network-error/);
    assert.doesNotMatch(JSON.stringify(result.toolTrace), /private-network-error/);
  });
  await test('输出截断可有限修正，畸形结构的错误分类独立于网络错误', async () => {
    stored = seed(); let calls = 0;
    const repaired = await run('我是如何看待选择过载的', [], async (r) => {
      calls++; return calls === 1 ? { content: '{', diagnostics: { finishReason: 'length' } } : inquiryReviewer(r);
    });
    assert.equal(calls, 2); assert.doesNotMatch(repaired.reply, /以下不是综合分析/);
    assert.equal((repaired.toolTrace.find((s) => s.call.name === 'synthesize_cognition_answer')?.result as { code: string }).code, 'truncated');
    const malformed = await run('我是如何看待选择过载的', [], async () => ({ content: 'null' }));
    assert.match(malformed.reply, /回答结构不符合要求/); assert.doesNotMatch(malformed.reply, /模型服务调用失败/);
  });
  await test('实际 Agent 按需读下一页后综合逻辑链；不调用资料库、不写入', async () => {
    let calls = 0;
    const result = await run('我是如何看待选择过载的', [], async (request) => {
      calls++; const input = JSON.parse(request.userInput);
      if (input.nextPage !== null) return { content: '', parsedJson: { action: 'read', page: input.nextPage } };
      const example = input.pages[1].sources.find((s: { mainType: string }) => s.mainType === '举例');
      return { content: '', parsedJson: { action: 'answer', paragraphs: [{ text: '你认为选择过载增加比较成本，并以果酱实验作为例子。', evidence: [{ id: 'C1', quote: '选择过载会增加比较成本。' }, { id: example.id, quote: example.text }] }] } };
    });
    assert.equal(calls, 2); assert.match(result.reply, /果酱实验/); assert.match(result.reply, /第 1–2 页，共 2 页/);
    assert.equal(result.updatedHistory.at(-1)?.cognitionReferences?.length, 2); assert.equal(writes, 0);
  });
  await test('概览分页后“继续”使用同一查询的新读取，不依赖历史回答当事实', async () => {
    stored = seed(45);
    const first = await run('我相信哪些事实'); assert.match(first.reply, /尚有未读内容/);
    const history = trimQaConversationHistory(first.updatedHistory); assert.ok(history.at(-1)?.cognitionInquiry);
    const next = await run('继续', history);
    assert.match(next.reply, /第 2–2 页/); assert.equal(next.toolTrace[0].call.arguments.page, 1);
    assert.equal(resolveInquiryQuestion('解释地震', history), undefined);
    assert.equal(resolveInquiryQuestion('继续', [...history, { role: 'assistant', content: '另一个话题' }]), undefined);
  });
  await test('查询期间认知被修改时丢弃旧回答；分页快照变化从头读取', async () => {
    stored = seed();
    const result = await run('我是如何看待选择过载的', [], async (request) => { stored.revision++; return inquiryReviewer(request); });
    assert.match(result.reply, /认知库发生变化/); assert.equal(result.updatedHistory.at(-1)?.cognitionReferences, undefined);
    const changed = await run('继续', [{ role: 'assistant', content: '旧查询', cognitionInquiry: { question: '我相信哪些事实', fileRevision: 0, nextPage: 1 } }]);
    assert.match(changed.reply, /新快照重新读取/);
  });
  await test('用户询问画像时才附带画像依据与掌握记录，当前信念和系统观察分离', async () => {
    stored = emptyCognitionFile(); const before = profileReads;
    const result = await run('我的用户画像和掌握情况是什么');
    assert.equal(profileReads, before + 1); assert.match(result.reply, /系统记录/); assert.match(result.reply, /明确给出了适用条件/);
    assert.ok(result.toolTrace.some((s) => s.call.name === 'query_learner_profile')); assert.equal(writes, 0);
  });
  await test('空库／故障不编造观点，模型输出无效则仅列原始记录', async () => {
    stored = emptyCognitionFile(); assert.match((await run('我相信哪些事实')).reply, /目前没有可用记录/);
    fail = true; assert.match((await run('我相信哪些事实')).reply, /暂不可读/); fail = false;
    fail = true;
    try { assert.match((await run('我的用户画像是什么')).reply, /只回答可读取的画像或学习记录/); } finally { fail = false; }
    stored = seed(); assert.match((await run('我是如何看待选择过载的', [], async () => ({ content: '无依据的自由文本' }))).reply, /模型没有返回可解析的结构化回答/);
  });
  await test('一个回合最多四次模型调用，无法通过分页读到无限多私人内容', async () => {
    stored = seed(90); let calls = 0;
    const result = await run('我相信哪些事实', [], async (r) => { calls++; return { content: '', parsedJson: { action: 'read', page: JSON.parse(r.userInput).nextPage } }; });
    assert.equal(calls, 4); assert.equal(result.toolTrace.filter((s) => s.call.name === 'read_cognition_page').length, 4);
    assert.match(result.reply, /尚有未读内容/); assert.equal(writes, 0);
  });
} finally {
  globalThis.fetch = previousFetch;
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
}
console.log(`${passed} personal inquiry checks passed; synthetic fixtures only, no cloud calls.`);
