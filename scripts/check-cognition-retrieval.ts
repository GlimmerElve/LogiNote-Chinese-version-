import assert from 'node:assert/strict';
import { applyCognitionMutation, emptyCognitionFile, latestCognition } from '../src/services/cognition/core';
import { cognitionQueryTerms, retrieveCurrentCognition, readCognitionRetrieval, wantsCognitionComparison, wantsCognitionRecall, wantsCognitionRetrieval, renderCognitionRecall } from '../src/services/cognition/retrieval';
import { registerQaTools, type QaEvidenceResult } from '../src/services/agent/tools/qaTools';
import { getTool } from '../src/services/agent/toolRegistry';
import { selectAgentSkill, getAgentSkill } from '../src/services/agent/skillRegistry';
import { buildPostToolReviewPrompt, createPostToolReviewState, runPostToolReviews } from '../src/services/agent/postToolReview';
import { buildQaAnswerCitations, discloseCognitionComparison, runQaFinalAnswerGate } from '../src/services/agent/finalAnswerGate';
import { buildQaLearningEpisode } from '../src/services/agent/qaMemory';
import { AGENT_ROLES, runAgentTurn } from '../src/services/agent/agentEngine';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import type { CognitionFile } from '../src/services/cognition/types';
import { inquiryReviewer } from './fixtures/cognition-inquiry-reviewer';

let passed = 0, serial = 0;
const now = '2026-10-04T00:00:00Z';
async function test(name: string, run: () => unknown | Promise<unknown>) { await run(); passed++; console.log(`PASS ${name}`); }
const apply = (f: CognitionFile, request: unknown) => applyCognitionMutation(f, request, { id: `v${++serial}`, at: now });
const node = (id: string, text: string) => ({ id, text, mainType: '事实陈述' as const });
function seed() {
  return apply(emptyCognitionFile(), { kind: 'confirm', confirmed: true, expectedRevision: 0, operation: 'initial',
    authorship: 'own_expression', stance: 'endorsed', reason: '', doc: { doc_id: 'cog-1', title: '选择与决策',
      nodes: [node('n1', '选择数量越多，决策质量总是越高。'), node('n2', '因此应当无限增加选择数量。')],
      edges: [{ id: 'e1', source: 'n1', target: 'n2', relation: 'support' }] } });
}
const compare = '请对照上传资料，检查我的理解：选择数量如何影响决策质量，是否存在矛盾？';
await test('显式比对路由，普通答疑与禁止比对不触发私人检索', () => {
  for (const query of [compare, '我的理解和资料有什么差异', '我对条件反射的理解与资料是否矛盾', '复核我的理解与资料有什么冲突']) {
    assert.equal(wantsCognitionComparison(query), true, query);
    assert.equal(selectAgentSkill(query)?.id, 'personalized-qa');
  }
  for (const query of ['选择数量如何影响决策质量？', '我的理解不要和资料比较', '不要读取我的认知，解释选择数量', '推荐学习资源']) assert.equal(wantsCognitionComparison(query), false, query);
  assert.equal(selectAgentSkill('推荐学习资源')?.id, 'resource-curation');
  assert.equal(selectAgentSkill('我的理解有问题，请帮我制定学习计划')?.id, 'plan-planning');
  assert.equal(selectAgentSkill('我的理解有问题，开始复习')?.id, 'socratic-review');
  assert.equal(getAgentSkill('personalized-qa')?.allowedTools.includes('update_cognition'), false);
});
await test('查询个人观点独立路由，不强制双库比对，不扩大普通知识问答权限', () => {
  for (const query of ['我是如何看待选择过载的', '我以前怎么理解选择数量', '我对选择过载的看法是什么', '我对选择过载有什么看法', '查看我的认知库中关于选择过载的理解', '回顾我的观点：选择数量', '我的理解有哪些：选择数量']) {
    assert.equal(wantsCognitionRecall(query), true, query);
    assert.equal(wantsCognitionComparison(query), false, query);
    assert.equal(selectAgentSkill(query)?.id, 'personalized-qa', query);
  }
  for (const query of ['我应该如何理解选择过载', '我想知道如何理解选择过载', '你如何看待选择过载', '解释选择过载', '不要读取我的认知，解释选择过载', '无需查询我的观点', '我的理解是选择越多越好']) {
    assert.equal(wantsCognitionRetrieval(query), false, query);
  }
  assert.equal(wantsCognitionRecall(compare), false);
});
await test('中文整句可命中词项，结果仅为当前认知，带来源和独立事实禁用标记', () => {
  const result = retrieveCurrentCognition(seed(), compare);
  assert.equal(result.items[0].nodeId, 'n1');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].usableAsFactEvidence, false);
  assert.equal(result.items[0].sourceKind, 'argument_editor');
  assert.equal(result.method, 'local-lexical-v1');
  assert.equal(retrieveCurrentCognition(seed(), '我的理解和资料有什么差异').items.length, 0);
  assert.equal(retrieveCurrentCognition(seed(), '火山岩浆').items.length, 0);
  assert.equal(retrieveCurrentCognition(seed(), compare, 0).items.length, 0);
  const withUnrelated = seed();
  latestCognition(withUnrelated.records[0]).branches[0].graph.nodes.push(node('unrelated', '价格波动受多种因素影响。'));
  assert.equal(retrieveCurrentCognition(withUnrelated, compare).items.some((h) => h.nodeId === 'unrelated'), false);
});
await test('中文单字分词退化保留相邻主题词，不放开单字或无主题整库查询', () => {
  const state = seed();
  latestCognition(state.records[0]).branches[0].graph.nodes.push(
    node('fan', '风扇甲在高速档运行时会使房间降温。'), node('coat', '涂层甲用于钢板时能防锈。'),
    node('factory', '厂区甲在九月能耗为 50 单位。'), node('single', '风。扇。甲。'));
  for (const [topic, id, word] of [['风扇甲', 'fan', '风扇'], ['涂层甲', 'coat', '涂层'], ['厂区甲能耗', 'factory', '厂区']]) {
    const query = `关于${topic}，请核对我的理解与资料有什么关系。`;
    assert.ok(cognitionQueryTerms(query).includes(word), query);
    const result = retrieveCurrentCognition(state, query);
    assert.equal(result.items[0]?.nodeId, id);
    assert.ok(!result.items.some((h) => h.nodeId === 'single'));
  }
  for (const query of ['我的理解和资料有什么差异', '请核对我的理解与资料有什么关系', '帮我进行认知复核',
    '关于我的观点，请检查一下是否合理', '我的理解与资料有关吗', '甲', '风，扇', '风 扇']) {
    assert.deepEqual(cognitionQueryTerms(query), [], query);
    assert.equal(retrieveCurrentCognition(state, query).items.length, 0, query);
  }
  assert.ok(cognitionQueryTerms('A 在 B 下导致 C').includes('a'));
  assert.ok(cognitionQueryTerms('风扇'.repeat(2000)).length <= 48);
});
await test('修订后的检索只见当前主张，保留其他节点来源及待复核状态；忘记即时失效', () => {
  const state = seed(), before = latestCognition(state.records[0]);
  const changed = apply(state, { kind: 'update_cognition', expectedRevision: state.revision, confirmed: true,
    target: { recordId: 'cog-1', revisionId: before.id, branchId: 'primary', nodeId: 'n1', operation: 'qualify', reason: '增加边界条件' },
    text: '选择数量增加可能增加决策负担，结果取决于比较成本。', mainType: '假设', stance: 'tentative', authorship: 'adopted_with_assistance' });
  const hits = retrieveCurrentCognition(changed, compare).items;
  assert.equal(hits.some((h) => h.text.includes('总是越高')), false);
  assert.equal(hits.find((h) => h.nodeId === 'n1')!.stance, 'tentative');
  assert.equal(hits.find((h) => h.nodeId === 'n2')!.originRevisionId, before.id);
  assert.equal(hits.find((h) => h.nodeId === 'n2')!.needsReview, true);
  const gone = apply(changed, { kind: 'forget', expectedRevision: changed.revision, confirmed: true, recordId: 'cog-1' });
  assert.equal(retrieveCurrentCognition(gone, compare).items.length, 0);
});
await test('候选、来源上下文、AI 诊断不进入召回，截断如实标记且总量受限', () => {
  const state = seed();
  state.candidates = [{ id: 'review/u1', status: 'pending', capturedAt: now, observation: { activityKind: 'review', activityId: 'review', messageId: 'u1', role: 'user', answer: '火山岩浆是尚未采纳的猜想', question: '', observedAt: now, noteTitle: '', hintLevel: null, consultedMaterialIds: [], targetKnowledgeNames: [] } }];
  assert.equal(retrieveCurrentCognition(state, '火山岩浆').items.length, 0);
  latestCognition(state.records[0]).branches[0].graph.nodes.push(...Array.from({ length: 10 }, (_, i) => node(`long-${i}`, '选择数量'.repeat(500))));
  const result = retrieveCurrentCognition(state, compare, 999);
  assert.equal(result.items.length, 4);
  assert.ok(result.items.every((item) => item.text.length <= 1000));
  assert.ok(result.items.some((item) => item.textTruncated));
  assert.equal(JSON.stringify(result).includes('capturedAt'), false);
});
await test('结果规范化只放行允许字段，拒绝无效引用和事实资格伪装', () => {
  const result = retrieveCurrentCognition(seed(), compare);
  const dirty = { ...result, secret: 'private', items: result.items.map((h) => ({ ...h, observation: 'private', score: NaN })) };
  const parsed = readCognitionRetrieval(dirty)!;
  assert.equal(JSON.stringify(parsed).includes('private'), false);
  assert.equal(parsed.items[0].score, 0);
  assert.equal(readCognitionRetrieval({ ...result, items: [{ ...result.items[0], usableAsFactEvidence: true }] })!.items.length, 0);
  assert.equal(readCognitionRetrieval({ status: 'other', items: [] }), undefined);
});

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalFetch = globalThis.fetch;
let stored = seed(), loads = 0, writes = 0, corrupt = false, failDocuments = false, documentSearches = 0;
const docs = [{ docId: 'external-doc', fileName: '决策资料.md', chunkId: 'chunk-1', sectionPath: '条件',
  snippet: '选择数量增加可能增加比较负担；结果取决于任务复杂度。', score: 0.9, matchKinds: ['passage'],
  sourceLocators: [{ kind: 'text', charStart: 0, charEnd: 38 }] }];
const bridge = Object.assign(new EventTarget(), { electronAPI: {
  userState: {
    loadCognition: async () => { loads++; if (corrupt) throw new Error('corrupt private file'); return structuredClone(stored); },
    mutateCognition: async () => { writes++; throw new Error('Agent must never write cognition'); },
    loadLearningEpisodes: async () => ({ version: 1, episodes: [] }), saveLearningEpisodes: async () => {},
  },
  noteRag: { search: async () => [] },
  ragDocs: { search: async () => { documentSearches++; if (failDocuments) throw new Error('simulated unavailable'); return docs; } },
} });
Object.defineProperty(globalThis, 'window', { value: bridge, configurable: true });
globalThis.fetch = async () => { throw new Error('Network forbidden in cognition tests'); };
const ctx = { getNotes: () => [], getActiveNote: () => null, getResourceDraftSession: () => null, getPlanDraftSession: () => null,
  hasPendingPlanEditorDraft: () => false, ensureDataFresh: async () => {} } as unknown as AgentRuntimeContext;
try {
  registerQaTools();
  const retrieve = async (include?: boolean) => await getTool('retrieve_qa_evidence')!.execute({ question: compare, scope: 'global', includePersonalCognition: include }, ctx) as QaEvidenceResult;
  await test('真实 QA 工具默认不读私人库，显式开启才分渠道检索，原覆盖度和引用不变', async () => {
    const ordinary = await retrieve(); assert.equal(loads, 0); assert.equal(ordinary.personalCognition, undefined);
    const result = await retrieve(true); assert.equal(loads, 1); assert.equal(result.personalCognition!.items.length, 2);
    assert.deepEqual(result.sources, ordinary.sources); assert.equal(result.coverage, ordinary.coverage);
    assert.deepEqual(result.sourceIds, ['document:external-doc']); assert.equal(writes, 0);
  });
  await test('一侧检索失败独立降级，私人读取失败不是空库，私人召回不弥补事实证据不足', async () => {
    corrupt = true; const failure = await retrieve(true); corrupt = false;
    assert.equal(failure.personalCognition!.status, 'unavailable'); assert.equal(failure.sources.length, 1);
    failDocuments = true; const noDocuments = await retrieve(true); failDocuments = false;
    assert.equal(noDocuments.coverage, 'insufficient'); assert.equal(noDocuments.personalCognition!.items.length, 2);
    assert.equal(noDocuments.sources.length, 0);
  });
  await test('双库上下文分离，私人引用不能成为 D/N 引用；模型差异不写入学习摘要', async () => {
    const result = await retrieve(true), state = createPostToolReviewState();
    await runPostToolReviews({ skillId: 'personalized-qa', userRequest: compare, state, auditRunId: 'test', allowLlmReviews: false,
      steps: [{ call: { id: 'qa-test', name: 'retrieve_qa_evidence', arguments: {} }, ok: true, result }] });
    const prompt = buildPostToolReviewPrompt(state);
    assert.ok(prompt.includes('总是越高')); assert.ok(prompt.includes('不是外部事实')); assert.ok(prompt.includes('新结果 D 不自动否定 C'));
    assert.deepEqual(state.qaEvidence!.review.supportedCitationIds, ['D1']);
    assert.equal(buildQaAnswerCitations('据资料 [D1]，个人认知 [N1]', state.qaEvidence).length, 1);
    const episode = buildQaLearningEpisode({ question: compare, answer: 'AI 推断用户存在严重认知缺陷', evidence: result });
    assert.equal(JSON.stringify(episode).includes('严重认知缺陷'), false);
    const noDocuments = { ...state.qaEvidence!, sources: [] };
    assert.match(discloseCognitionComparison('比较结果', noDocuments), /没有可用的上传资料/);
    assert.match(discloseCognitionComparison('比较结果', { ...noDocuments, personalCognition: { status: 'unavailable', method: 'local-lexical-v1', items: [], warning: '' } }), /读取失败/);
  });
  await test('实际 Agent 流程只读召回并附带精确 UI 指针，没有额外模型调用或审批', async () => {
    const original = JSON.stringify(stored); let modelCalls = 0;
    const result = await runAgentTurn({ role: AGENT_ROLES.default, userText: compare, ctx, history: [], memoryPrefixLoader: async () => '',
      callLlm: async (request) => {
        if (request.workflow === 'agent-intent-routing') return { content: '', parsedJson: { skillId: 'personalized-qa', confidence: 0.99, standaloneRequest: compare, referenceResolution: 'none' } };
        modelCalls++; assert.ok(request.systemPromptOverride?.includes('总是越高'));
        return { content: '你之前认为选择数量越多越好；资料提示需要考虑比较负担 [D1]。可以进一步明确适用条件。' }; } });
    assert.equal(result.activeSkill!.id, 'personalized-qa'); assert.equal(result.toolTrace[0].call.arguments.includePersonalCognition, true);
    assert.equal(result.pendingApproval, undefined); assert.equal(modelCalls, 1);
    const refs = result.updatedHistory.at(-1)!.cognitionReferences!;
    assert.equal(refs.length, 2); assert.deepEqual(Object.keys(refs[0]).sort(), ['branchId', 'nodeId', 'recordId', 'revisionId']);
    assert.equal(result.updatedHistory.at(-1)!.citations![0].sourceId, 'D1');
    assert.match(result.reply, /未修改个人认知/); assert.equal(JSON.stringify(stored), original); assert.equal(writes, 0);
  });
  await test('截图原句经真实 Agent 路由读取认知，而非笔记；不依赖资料或语义审核', async () => {
    const previous = structuredClone(stored);
    latestCognition(stored.records[0]).branches[0].graph.nodes.push(node('overload', '我认为选择过载的影响取决于比较成本，而非选项越多越差。'));
    const sourceBefore = JSON.stringify(stored), beforeLoads = loads, beforeDocuments = documentSearches;
    for (const enableMultiAgent of [false, true]) {
      const result = await runAgentTurn({ role: AGENT_ROLES.default, userText: '我是如何看待选择过载的', ctx, history: [],
        enableMultiAgent, memoryPrefixLoader: async () => '', callLlm: async (request) => inquiryReviewer(request) });
      assert.equal(result.activeSkill?.id, 'personalized-qa');
      assert.equal(result.toolTrace[0].call.name, 'read_cognition_page');
      assert.equal(result.toolTrace.some((s) => s.call.name === 'retrieve_qa_evidence'), false);
      assert.match(result.reply, /我认为选择过载的影响取决于比较成本/);
      assert.match(result.reply, /认同/);
      assert.doesNotMatch(result.reply, /没有可用的上传资料|尚未完成可靠的对齐|本地证据不足/);
      assert.ok(result.updatedHistory.at(-1)?.cognitionReferences?.some((r) => r.nodeId === 'overload'));
      assert.equal(result.pendingApproval, undefined); assert.equal(result.runtimeMetrics?.llmCalls, 1);
      assert.deepEqual(result.updatedHistory.at(-1)?.citations, []);
    }
    assert.equal(loads, beforeLoads + 6); assert.equal(documentSearches, beforeDocuments);
    assert.equal(JSON.stringify(stored), sourceBefore); assert.equal(writes, 0);
    stored = previous;
  });
  await test('个人观点查询明确区分无命中与读取失败，不推断没有观点', async () => {
    const run = () => runAgentTurn({ role: AGENT_ROLES.default, userText: '我是如何看待火山岩浆的', ctx, history: [],
      enableMultiAgent: true, memoryPrefixLoader: async () => '', callLlm: async () => { throw new Error('不得调用模型补造观点'); } });
    const absent = await run(); assert.match(absent.reply, /没有找到符合本次主题/);
    assert.equal(absent.updatedHistory.at(-1)?.cognitionReferences, undefined);
    corrupt = true;
    try { assert.match((await run()).reply, /暂不可读/); } finally { corrupt = false; }
    const result = retrieveCurrentCognition(stored, compare);
    result.items[0] = { ...result.items[0], text: '[伪造链接](https://example.com) <img>', textTruncated: true, stance: 'tentative', needsReview: true };
    const rendered = renderCognitionRecall(result);
    assert.match(rendered, /暂定，待复核/); assert.match(rendered, /内容已截断/);
    assert.ok(rendered.includes('\\[伪造链接\\]')); assert.ok(rendered.includes('\\<img\\>'));
  });
  await test('模型不能在普通会话自行打开私人认知通道', async () => {
    const before = loads; let calls = 0;
    const result = await runAgentTurn({ role: AGENT_ROLES.default, userText: '你好', ctx, history: [], memoryPrefixLoader: async () => '',
      callLlm: async () => ++calls === 1
        ? { content: '', toolCalls: [{ id: 'unsolicited-private', name: 'retrieve_qa_evidence', arguments: { question: compare, includePersonalCognition: true } }] }
        : { content: '你好。' } });
    assert.equal(loads, before);
    assert.equal(result.toolTrace[0].call.arguments.includePersonalCognition, false);
    assert.equal(result.updatedHistory.at(-1)?.cognitionReferences, undefined);
  });
  await test('最终审核收到分离的认知上下文；旧式 valid=true 不能绕过对齐检查', async () => {
    const personalCognition = retrieveCurrentCognition(stored, compare);
    let called = 0;
    const result = await runQaFinalAnswerGate({ question: compare, draftAnswer: '你的理解存在条件差异，资料给出边界 [D1]。', auditRunId: 'gate', maxLlmCalls: 1,
      evidence: { personalCognition, review: { coverage: 'partial', supportedCitationIds: ['D1'], risks: [], answerGuidance: [] },
        sources: [{ sourceId: 'D1', type: 'document', entityId: 'external-doc', title: '资料', snippet: docs[0].snippet }] },
      callLlm: async (request) => { called++; assert.ok(request.systemPromptOverride!.includes('个人认知'));
        const body = JSON.parse(request.userInput); assert.equal(body.personalCognition.items.length, 2); assert.deepEqual(body.sources.map((s: { sourceId: string }) => s.sourceId), ['D1']);
        return { content: '', parsedJson: { valid: true, invalidCitationIds: [], unsupportedClaims: [], repairInstructions: [] } }; } });
    assert.equal(called, 1); assert.equal(result.review.valid, false); assert.match(result.answer, /先不建议合并或覆盖/);
  });
  assert.ok(documentSearches > 0);
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
}
console.log(`\n${passed} cognition retrieval checks passed (synthetic data, no network).`);
