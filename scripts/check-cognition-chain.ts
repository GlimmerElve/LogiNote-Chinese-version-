import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createCognitionAcceptanceFixture } from './cognition-acceptance-fixture';
import { INITIAL_CLAIM, ADDED_CLAIM, REVISED_CLAIM, reviewEpisode, argumentFixture, scriptedReviewer } from './fixtures/cognition-acceptance-shared';
import { captureReviewCognition, loadPersonalCognition, savePersonalCognition, searchCurrentPersonalCognition } from '../src/services/cognition/store';
import { latestCognition } from '../src/services/cognition/core';
import { AGENT_ROLES, runAgentTurn } from '../src/services/agent/agentEngine';
import { registerQaTools } from '../src/services/agent/tools/qaTools';
import { getTool } from '../src/services/agent/toolRegistry';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import { inquiryReviewer } from './fixtures/cognition-inquiry-reviewer';

const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), previousFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('No cloud/network in acceptance'); };
const fixture = await createCognitionAcceptanceFixture();
const steps: string[] = [];
const pass = (name: string) => { steps.push(name); console.log(`PASS ${name}`); };
try {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { electronAPI: {
    userState: { loadCognition: fixture.load, mutateCognition: fixture.mutate, searchCognition: fixture.search,
      loadLearningEpisodes: async () => ({ version: 2, episodes: [] }), saveLearningEpisodes: async () => {} },
    ragDocs: { search: fixture.searchDocuments }, noteRag: { search: async () => [] },
  } }) });
  registerQaTools();
  const ctx = { getNotes: () => [], getActiveNote: () => null, getResourceDraftSession: () => null, getPlanDraftSession: () => null,
    hasPendingPlanEditorDraft: () => false, ensureDataFresh: async () => {} } as unknown as AgentRuntimeContext;
  const docs = await fixture.searchDocuments('机器甲负载 B 振动');
  assert.ok(docs[0].snippet.includes('振动')); assert.ok(docs[0].sourceLocators?.length);
  assert.equal((await loadPersonalCognition()).records.length, 0);
  pass('实际 TXT 解析、离线向量化、资料索引与检索，不自动产生个人认知');

  await captureReviewCognition(reviewEpisode(), { title: '机械学习' }, false);
  assert.equal(fixture.stats.mutations, 0);
  await captureReviewCognition(reviewEpisode(), { title: '机械学习' }, true);
  let file = await loadPersonalCognition();
  assert.equal(file.records.length, 1); assert.equal(file.candidates?.length, 1);
  assert.equal((await searchCurrentPersonalCognition('机器甲发热')).items[0].text, INITIAL_CLAIM);
  assert.equal(file.candidates![0].status, 'accepted');
  pass('真实复习捕获入口默认自动入库，仅收用户自己的回答；预览／显式跳过不采集，无待确认阻塞');
  const before = await fixture.sourceText();
  await captureReviewCognition(reviewEpisode(), { title: '机械学习' });
  assert.equal(await fixture.sourceText(), before);
  file = await loadPersonalCognition();
  assert.equal(latestCognition(file.records[0]).mastery, 'not_assessed');
  assert.equal(latestCognition(file.records[0]).source.kind, 'review_answer');
  pass('自动入库后落盘并幂等重试；不提高掌握度，来源仍为用户复习回答');

  const original = await searchCurrentPersonalCognition('机器甲发热');
  assert.equal(original.method, 'local-hybrid-v1'); assert.equal(original.items[0].text, INITIAL_CLAIM);
  const diskBeforeAgent = await fixture.sourceText(), mutationsBefore = fixture.stats.mutations;
  const searchesBefore = fixture.stats.privateSearches;
  await getTool('retrieve_qa_evidence')!.execute({ question: '机器甲振动', scope: 'global' }, ctx);
  assert.equal(fixture.stats.privateSearches, searchesBefore);
  let calls = 0;
  const result = await runAgentTurn({ role: AGENT_ROLES.default, userText: '请比对我的理解：机器甲在负载 B 下发热与振动是否矛盾？',
    ctx, history: [], memoryPrefixLoader: async () => '', enableMultiAgent: true,
    callLlm: async (request) => { calls++; return scriptedReviewer(request); } });
  assert.equal(calls, 3); assert.match(result.reply, /不直接否定/);
  assert.ok(result.updatedHistory.at(-1)?.citations?.some((c) => c.sourceId === 'D1'));
  const ref = result.updatedHistory.at(-1)?.cognitionReferences?.[0]; assert.ok(ref);
  assert.equal(ref.nodeId, original.items[0].nodeId);
  assert.equal(await fixture.sourceText(), diskBeforeAgent); assert.equal(fixture.stats.mutations, mutationsBefore);
  pass('真实双库检索到 Agent 回答与引用指针；普通 QA 不读私人库，比对零写入（语义审核用替身）');

  const initialRecord = file.records[0], initialRevision = structuredClone(initialRecord.revisions[0]);
  const target = { recordId: ref.recordId, revisionId: ref.revisionId, branchId: ref.branchId, nodeId: ref.nodeId, operation: 'supplement' as const, reason: '增加另一结果' };
  file = await savePersonalCognition({ kind: 'update_cognition', expectedRevision: file.revision, confirmed: true, target,
    text: ADDED_CLAIM, mainType: '事实陈述', stance: 'endorsed', authorship: 'adopted_with_assistance' });
  await assert.rejects(fs.stat(fixture.indexPath), { code: 'ENOENT' });
  let current = latestCognition(file.records[0]);
  assert.deepEqual(current.branches[0].graph.nodes.map((n) => n.text), [INITIAL_CLAIM, ADDED_CLAIM]);
  assert.equal(current.branches[0].graph.edges.length, 0);
  assert.deepEqual(file.records[0].revisions[0], initialRevision);
  pass('从 Agent 精确指针确认补充 D，保留 C 和历史，不自行改成互斥或或新增连线，旧索引立即失效');

  await searchCurrentPersonalCognition('机器甲发热');
  const stale = { kind: 'update_cognition' as const, expectedRevision: file.revision, confirmed: true as const,
    target: { ...target, revisionId: current.id, operation: 'revise' as const }, text: REVISED_CLAIM, mainType: '事实陈述' as const,
    stance: 'tentative' as const, authorship: 'own_expression' as const };
  file = await savePersonalCognition(stale);
  await assert.rejects(fs.stat(fixture.indexPath), { code: 'ENOENT' });
  const revisionSaved = await fixture.sourceText();
  await assert.rejects(() => savePersonalCognition(stale));
  assert.equal(await fixture.sourceText(), revisionSaved);
  file = await loadPersonalCognition(); current = latestCognition(file.records[0]);
  const updated = await searchCurrentPersonalCognition('机器甲发热');
  assert.ok(updated.items.some((h) => h.text === REVISED_CLAIM)); assert.ok(!updated.items.some((h) => h.text === INITIAL_CLAIM));
  assert.ok(current.branches[0].graph.nodes.some((n) => n.text === ADDED_CLAIM));
  assert.equal(file.records[0].revisions[0].branches[0].graph.nodes[0].text, INITIAL_CLAIM);
  assert.ok((await fixture.searchDocuments('机器甲振动'))[0].snippet.includes('振动'));
  pass('确认修订、磁盘重载与新版本召回；旧主张仅留历史、并发旧草稿拒绝、资料库不变');

  const beforeRecall = await fixture.sourceText();
  const recall = await runAgentTurn({ role: AGENT_ROLES.default, userText: '我是如何看待机器甲在负载 B 下发热的', ctx, history: [],
    memoryPrefixLoader: async () => '', enableMultiAgent: true,
    callLlm: async (request) => inquiryReviewer(request) });
  assert.ok(recall.reply.includes(REVISED_CLAIM));
  assert.ok(!recall.reply.includes(`原话：“${INITIAL_CLAIM}”`));
  assert.ok(recall.updatedHistory.at(-1)?.cognitionReferences?.some((r) => r.revisionId === current.id));
  assert.equal(await fixture.sourceText(), beforeRecall);
  pass('自然语言查询自己的看法，经真实混合检索读取当前论证结构并综合回答，附 UI 指针且不写入（模型替身）');

  file = await savePersonalCognition({ kind: 'confirm', expectedRevision: file.revision, confirmed: true, operation: 'initial', reason: '',
    stance: 'tentative', authorship: 'own_expression', doc: argumentFixture() });
  assert.ok(file.records.some((r) => r.docId === 'acceptance-editor' && latestCognition(r).source.kind === 'argument_editor'));
  pass('论证编辑器的同一保存服务也可初始化个人认知，保持独立来源');
  console.log(JSON.stringify({ acceptance: 'core-service-chain', passed: steps.length, cloudCalls: 0,
    realDocumentParsing: true, realLocalEmbeddings: true, realDiskStores: true, nativeElectronIPC: false, semanticReviewer: 'scripted', steps }));
} finally {
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  globalThis.fetch = previousFetch;
  await fixture.close();
}
