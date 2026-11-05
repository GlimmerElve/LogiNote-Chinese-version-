import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ALIGNMENT_AXES, COMPARISON_RELATIONS, validateCognitionAlignment, renderCognitionAlignment, type CognitionAlignment } from '../src/services/cognition/alignment';
import { runQaFinalAnswerGate } from '../src/services/agent/finalAnswerGate';
import { AGENT_ROLES, runAgentTurn } from '../src/services/agent/agentEngine';
import { registerQaTools } from '../src/services/agent/tools/qaTools';
import { mutateCognition, loadCognition, COGNITION_FILE_NAME } from '../src/electron/cognitionStore';
import { searchPersonalCognition } from '../src/electron/cognitionRetrieval';
import type { QaEvidenceReviewContext } from '../src/services/agent/postToolReview';
import type { AgentRuntimeContext } from '../src/services/agent/types';

let passed = 0;
async function test(name: string, run: () => unknown | Promise<unknown>) { await run(); passed++; console.log(`PASS ${name}`); }
const personalText = '条件 B 下，机器甲会产生热量。';
const documentText = '条件 B 下，机器甲还会产生振动。';
function evidence(): QaEvidenceReviewContext {
  return { personalCognition: { status: 'ready', method: 'local-hybrid-v1', items: [{ recordId: 'g', revisionId: 'v1', branchId: 'primary', nodeId: 'n1', title: '机器的作用',
    text: personalText, textTruncated: false, stance: 'endorsed', branchKind: 'primary', context: '', needsReview: false, confirmedAt: '2026-10-04', sourceKind: 'argument_editor', originRevisionId: 'v1', score: 1, usableAsFactEvidence: false }], warning: '' },
    review: { coverage: 'partial', supportedCitationIds: ['D1'], risks: [], answerGuidance: [] },
    sources: [{ sourceId: 'D1', type: 'document', entityId: 'doc', title: '合成资料', snippet: documentText }] };
}
function aligned(relation: CognitionAlignment['relation'] = 'supplement', context = evidence()): CognitionAlignment {
  const p = context.personalCognition!.items[0].text, d = context.sources[0].snippet;
  return { personalIndex: 0, sourceId: 'D1', personalQuote: p, documentQuote: d, sourcesCompatible: true, relation,
    ...(relation === 'contradiction' || relation === 'certainty_change' ? { relationBasis: {
      kind: relation === 'contradiction' ? 'incompatible_facts' as const : 'evidence_limit' as const,
      personalQuote: p, documentQuote: d, explanation: '脚本测试替身，真实语义仍需模型评估。' } } : {}),
    axes: Object.fromEntries(ALIGNMENT_AXES.map((axis) => [axis, { status: axis === 'condition' && relation === 'condition_difference' ? 'different' : axis === 'metric' && relation === 'supplement' ? 'different' : axis === 'baseline' ? 'not_applicable' : 'same',
      personalQuote: axis === 'baseline' ? '' : p, documentQuote: axis === 'baseline' ? '' : d, reason: axis === 'baseline' ? '本例不是相对比较句' : '测试替身提供的对齐判断，不代表模型能力' }])) as CognitionAlignment['axes'] };
}
await test('五项齐全且引用落在指定原文内，六类关系按规则处理', () => {
  for (const relation of COMPARISON_RELATIONS) {
    const context = evidence();
    if (relation === 'certainty_change') {
      context.personalCognition!.items[0].text = '算法甲预测必定精确等于 20。';
      context.sources[0].snippet = '算法甲预测不保证精确等于 20，实际尚未知。';
    }
    const result = validateCognitionAlignment(aligned(relation, context), context);
    assert.equal(result.accepted, relation !== 'insufficient', relation);
  }
  const result = renderCognitionAlignment(validateCognitionAlignment(aligned(), evidence()), evidence());
  assert.match(result, /不直接否定/); assert.match(result, /\[D1\]/);
});
await test('矛盾须有逐字依据，未知／假设／证据不足不能冒充已发生反例', () => {
  for (const document of ['算法甲不保证精确等于 20，实际尚未知。', '如果算法甲的实际结果为 18，就存在反例。', '算法甲可能得到 18。']) {
    const context = evidence(); context.personalCognition!.items[0].text = '算法甲的实际结果必定为 20。'; context.sources[0].snippet = document;
    const raw = aligned('contradiction', context);
    for (const kind of ['observed_counterexample', 'incompatible_facts', 'evidence_limit'] as const) {
      raw.relationBasis!.kind = kind;
      assert.equal(validateCognitionAlignment(raw, context).code, 'conflict_not_established');
    }
    delete raw.relationBasis;
    assert.equal(validateCognitionAlignment(raw, context).code, 'missing_relation_basis');
  }
  const context = evidence(); context.personalCognition!.items[0].text = '实验 R 第十秒仪表甲读数恰好为 10。';
  context.sources[0].snippet = '实验 R 第十秒仪表甲读数恰好为 12。';
  const raw = aligned('contradiction', context);
  assert.equal(validateCognitionAlignment(raw, context).accepted, true);
  assert.match(renderCognitionAlignment(validateCognitionAlignment(raw, context), context), /待核对的不相容依据/);
  raw.relationBasis!.documentQuote = '其他资料说读数为 12。';
  assert.equal(validateCognitionAlignment(raw, context).code, 'ungrounded_relation_basis');
  raw.relationBasis = { kind: 'unknown', personalQuote: raw.personalQuote, documentQuote: raw.documentQuote, explanation: '尚不清楚' };
  assert.equal(validateCognitionAlignment(raw, context).code, 'conflict_not_established');
  context.sources[0].snippet = '如果实验 R 第十秒仪表甲读数恰好为 12，就存在反例。';
  const cropped = aligned('contradiction', context); cropped.relationBasis!.documentQuote = '仪表甲读数恰好为 12';
  assert.equal(validateCognitionAlignment(cropped, context).code, 'conflict_not_established');
});
await test('混合资料必须聚焦真实反例；不能忽略实际反例而自动改判确定程度', () => {
  const context = evidence(); context.personalCognition!.items[0].text = '装置甲在工况 B 下必定成功。';
  context.sources[0].snippet = '装置甲不保证每次成功。装置甲在工况 B 下的第三次实测失败。';
  const raw = aligned('contradiction', context); raw.relationBasis!.kind = 'observed_counterexample';
  assert.equal(validateCognitionAlignment(raw, context).code, 'conflict_not_established');
  raw.relationBasis!.documentQuote = '装置甲在工况 B 下的第三次实测失败。';
  assert.equal(validateCognitionAlignment(raw, context).accepted, true);
});
function certaintyContext() {
  const context = evidence(); context.personalCognition!.items[0].text = '训练法甲必然缩短所有受试者的反应时间。';
  context.sources[0].snippet = '训练法甲可能缩短反应时间，目前仅有少数观察，没有实际失败案例，也不能保证所有人有效。';
  return context;
}
await test('只有依据充分且范围齐全才放行确定程度比较；泛泛缺项只展示有限措辞提示', () => {
  const context = certaintyContext(), raw = aligned('certainty_change', context);
  assert.equal(validateCognitionAlignment(raw, context).accepted, true);
  for (const axis of ['condition', 'time', 'baseline'] as const) raw.axes[axis].status = 'unknown';
  const decision = validateCognitionAlignment(raw, context);
  assert.equal(decision.accepted, false); assert.equal(decision.code, 'certainty_only'); assert.equal(decision.alignment, undefined);
  const text = renderCognitionAlignment(decision, context);
  assert.match(text, /本次不作完整关系判断/); assert.equal((text.match(/？/g) || []).length, 0);
  assert.ok(!text.includes('你的旧认知错误'));
  raw.relationBasis!.personalQuote = '凭空添加的必然结论';
  assert.equal(validateCognitionAlignment(raw, context).code, 'ungrounded_relation_basis');
});
await test('有限措辞提示不能绕过对象、指标、明确缺失范围、相对基准或来源保护', () => {
  for (const mode of ['object', 'metric', 'different', 'explicit-gap', 'comparison', 'source', 'truncated', 'weak-personal']) {
    const context = certaintyContext();
    if (mode === 'explicit-gap') context.personalCognition!.items[0].text += '具体条件尚未记录。';
    if (mode === 'comparison') context.personalCognition!.items[0].text = '训练法甲必定让反应更快。';
    if (mode === 'weak-personal') context.personalCognition!.items[0].text = '训练法甲不一定有效，也不是所有人都有效。';
    const raw = aligned('certainty_change', context); raw.axes.condition.status = 'unknown';
    if (mode === 'weak-personal') raw.relationBasis!.personalQuote = '一定有效';
    if (mode === 'object' || mode === 'metric') raw.axes[mode].status = 'unknown';
    if (mode === 'different') raw.axes.time.status = 'different';
    if (mode === 'source') raw.sourcesCompatible = false;
    if (mode === 'truncated') context.personalCognition!.items[0].textTruncated = true;
    const decision = validateCognitionAlignment(raw, context);
    assert.equal(decision.accepted, false, mode); assert.equal(decision.certaintyNotice, undefined, mode);
  }
});
await test('真实审核入口展示有限提示，不保留危险草稿、不追加模型调用', async () => {
  const context = certaintyContext(), raw = aligned('certainty_change', context); raw.axes.condition.status = 'unknown';
  let calls = 0;
  const result = await runQaFinalAnswerGate({ question: '核对我的理解', draftAnswer: '已经判定你错误并替你修改。', evidence: context,
    auditRunId: 'certainty-only', maxLlmCalls: 2, callLlm: async (request) => {
      calls++; assert.match(request.systemPromptOverride!, /relationBasis/);
      const example = JSON.parse(request.systemPromptOverride!.split('\n').find((line) => line.startsWith('{"personalIndex"'))!);
      assert.deepEqual(Object.keys(example.axes), [...ALIGNMENT_AXES]);
      return { content: JSON.stringify(raw) };
    } });
  assert.equal(calls, 1); assert.equal(result.review.valid, false);
  assert.match(result.review.repairInstructions[0], /仅展示措辞强度/);
  assert.match(result.answer, /目前只能提示措辞强度/); assert.ok(!result.answer.includes('替你修改'));
});
await test('模型甲与模型乙即使属于同一类别也不能按补充放行', () => {
  const value = aligned(); value.axes.object.status = 'different';
  const decision = validateCognitionAlignment(value, evidence());
  assert.equal(decision.code, 'different_object');
  assert.match(renderCognitionAlignment(decision, evidence()), /两个不同对象/);
});
await test('任一必要维度未知或缺失即先澄清，不保留错误草稿', () => {
  for (const axis of ALIGNMENT_AXES) {
    const value = aligned(); value.axes[axis].status = 'unknown';
    assert.equal(validateCognitionAlignment(value, evidence()).code, `unknown_${axis}`);
    const missing = aligned(); delete (missing.axes as Partial<typeof missing.axes>)[axis];
    assert.equal(validateCognitionAlignment(missing, evidence()).accepted, false);
  }
});
await test('一次只追问关键缺口：基准、明确丢失时间、明确缺失指标优先于泛泛条件', () => {
  const cases: Array<[string, string, string]> = [
    ['程序甲运行更快。', '程序甲运行更快。', 'unknown_baseline'],
    ['容器甲在某次测量时温度为 10 度，测量时刻已遗失。', '容器甲在今天十点温度为 20 度。', 'unknown_time'],
    ['设备甲某个指标为 10，指标名称尚未记录。', '设备甲电压为 20 伏。', 'unknown_metric'],
    ['设备甲在某种湿度下工作，具体湿度尚未记录。', '设备甲在湿度 90% 时无法工作。', 'unknown_condition'],
  ];
  for (const [personal, document, expected] of cases) {
    const context = evidence(); context.personalCognition!.items[0].text = personal; context.sources[0].snippet = document;
    const raw = aligned('insufficient', context);
    for (const axis of ['condition', 'time', 'metric', 'baseline'] as const) raw.axes[axis].status = 'unknown';
    const decision = validateCognitionAlignment(raw, context);
    assert.equal(decision.code, expected); assert.equal(decision.accepted, false);
    assert.equal((renderCognitionAlignment(decision, context).match(/？/g) || []).length, 1);
    if (expected === 'unknown_time') {
      // Recorded real response labeled a lost timestamp "different", while
      // blocking on generic unknown conditions. Do not mistake loss for scope.
      raw.axes.time.status = 'different'; raw.axes.time.personalQuote = '测量时刻已遗失'; raw.axes.time.documentQuote = '今天十点';
      assert.equal(validateCognitionAlignment(raw, context).code, 'unknown_time');
    }
    raw.axes.object.status = 'unknown';
    assert.equal(validateCognitionAlignment(raw, context).code, 'unknown_object');
  }
});
await test('未知维度不遮蔽后续伪造引用；澄清展示被选中的原话和资料配对', () => {
  const context = evidence();
  context.personalCognition!.items.unshift({ ...context.personalCognition!.items[0], nodeId: 'other', text: '无关的首条个人认知。' });
  context.sources.unshift({ ...context.sources[0], sourceId: 'D2', snippet: '无关的首条资料。' }); context.review.supportedCitationIds.push('D2');
  const raw = aligned(); raw.personalIndex = 1; raw.axes.condition.status = 'unknown';
  const decision = validateCognitionAlignment(raw, context);
  const answer = renderCognitionAlignment(decision, context);
  assert.match(answer, /机器甲/); assert.match(answer, /\[D1\]/); assert.ok(!answer.includes('无关的首条'));
  raw.axes.metric.documentQuote = '伪造的指标引文';
  assert.equal(validateCognitionAlignment(raw, context).code, 'ungrounded_axis');
});
await test('更快／更少这类比较不能用不适用掩盖缺失基准', () => {
  const input = evidence(); input.personalCognition!.items[0].text = '机器甲运行更快。';
  assert.equal(validateCognitionAlignment(aligned('supplement', input), input).code, 'unknown_baseline');
  const value = aligned(); value.axes.baseline.status = 'different'; value.axes.baseline.personalQuote = personalText; value.axes.baseline.documentQuote = documentText;
  assert.equal(validateCognitionAlignment(value, evidence()).code, 'different_baseline');
});
await test('条件／时间不同不能放行矛盾，指标不同只允许同对象补充', () => {
  for (const axis of ['condition', 'time', 'metric'] as const) {
    const value = aligned('contradiction'); value.axes[axis].status = 'different';
    assert.equal(validateCognitionAlignment(value, evidence()).code, 'relation_axis_mismatch');
  }
  assert.match(renderCognitionAlignment(validateCognitionAlignment(aligned('condition_difference'), evidence()), evidence()), /不必修改/);
});
await test('伪造原话、跨来源拼接、私人 N 引用不能绕过依据检查', () => {
  const fake = aligned(); fake.personalQuote = '从未说过'; assert.equal(validateCognitionAlignment(fake, evidence()).accepted, false);
  const fakeAxis = aligned(); fakeAxis.axes.object.documentQuote = '模型乙'; assert.equal(validateCognitionAlignment(fakeAxis, evidence()).code, 'ungrounded_axis');
  const wrong = aligned(); wrong.sourceId = 'D99'; assert.equal(validateCognitionAlignment(wrong, evidence()).code, 'invalid_source');
  const note = evidence(); note.sources[0].type = 'note'; assert.equal(validateCognitionAlignment(aligned(), note).code, 'no_document');
});
await test('已存前提可以提供条件引文，方向与缺失标记不会被忽略', () => {
  const input = evidence(); input.personalCognition!.items[0].neighbors = [{ nodeId: 'p', text: '条件 B 下', textTruncated: false, stance: 'endorsed', needsReview: false, sourceNodeId: 'p', targetNodeId: 'n1', relation: 'support' }];
  const value = aligned('supplement', input); value.axes.condition.personalQuote = '条件 B 下';
  assert.equal(validateCognitionAlignment(value, input).accepted, true);
  const conditional = aligned('condition_difference', input); conditional.axes.condition.personalQuote = '条件 B 下';
  assert.match(renderCognitionAlignment(validateCognitionAlignment(conditional, input), input), /范围依据：你的论证中是“条件 B 下”/);
  input.personalCognition!.items[0].neighbors[0].textTruncated = true;
  assert.equal(validateCognitionAlignment(value, input).code, 'incomplete_context');
});
await test('资料互相矛盾或上下文截断均不放行合并建议', () => {
  const value = aligned(); value.sourcesCompatible = false; assert.equal(validateCognitionAlignment(value, evidence()).code, 'sources_disagree');
  for (const field of ['textTruncated', 'contextTruncated', 'neighborhoodTruncated'] as const) {
    const input = evidence(); input.personalCognition!.items[0][field] = true;
    assert.equal(validateCognitionAlignment(aligned(), input).code, 'incomplete_context');
  }
});
await test('最终审核只用原有一次调用，展示受限结论，不展示危险自由文本', async () => {
  let calls = 0;
  const result = await runQaFinalAnswerGate({ question: '比较', draftAnswer: '应当直接删除旧认知 [D99]', evidence: evidence(), auditRunId: 'aligned', maxLlmCalls: 2,
    callLlm: async (request) => { calls++; assert.match(request.systemPromptOverride!, /比较基准/); return { content: JSON.stringify({ ...aligned(), malicious: '自动保存并删除旧认知' }) }; } });
  assert.equal(calls, 1); assert.equal(result.review.valid, true);
  assert.equal(result.answer.includes('自动保存'), false); assert.equal(result.answer.includes('D99'), false);
});
await test('审核失败、无预算、旧协议或伪造依据均不能保留危险草稿', async () => {
  for (const mode of ['failure', 'budget', 'old-schema', 'bad-quote']) {
    let calls = 0;
    const result = await runQaFinalAnswerGate({ question: '比较', draftAnswer: '你的旧理解错误，立即覆盖。', evidence: evidence(), auditRunId: mode, maxLlmCalls: mode === 'budget' ? 0 : 2,
      callLlm: async () => { calls++; if (mode === 'failure') throw new Error('offline'); return { content: '', parsedJson: mode === 'old-schema' ? { valid: true } : { ...aligned(), documentQuote: '伪造材料' } }; } });
    assert.equal(calls, mode === 'budget' ? 0 : 1); assert.equal(result.review.valid, false);
    assert.match(result.answer, /先不建议合并或覆盖/); assert.equal(result.answer.includes('你的旧理解错误'), false);
  }
});
await test('无个人命中或无资料时不浪费审核调用、不编造缺陷', async () => {
  for (const noPersonal of [true, false]) {
    const input = evidence(); if (noPersonal) input.personalCognition!.items = []; else input.sources = [];
    const result = await runQaFinalAnswerGate({ question: '比较', draftAnswer: '存在严重认知缺陷。', evidence: input, auditRunId: 'empty', maxLlmCalls: 2,
      callLlm: async () => { throw new Error('should not call'); } });
    assert.equal(result.coordination.totals.llmCalls, 0); assert.equal(result.answer.includes('严重认知缺陷'), false);
  }
});

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-alignment-'));
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), previousFetch = globalThis.fetch;
let privateReads = 0, docReads = 0, writes = 0;
try {
  await mutateCognition(root, { kind: 'confirm', confirmed: true, expectedRevision: 0, operation: 'initial', authorship: 'own_expression', stance: 'endorsed', reason: '',
    doc: { doc_id: 'g', title: '机器的作用', nodes: [{ id: 'n1', text: personalText, mainType: '事实陈述' }], edges: [] } });
  const before = await fs.readFile(path.join(root, COGNITION_FILE_NAME), 'utf-8');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { electronAPI: {
    userState: { searchCognition: async (query: string) => { privateReads++; return searchPersonalCognition(root, query, async () => Array.from({ length: 384 }, (_, i) => Number(i === 0))); },
      loadCognition: () => loadCognition(root), mutateCognition: async () => { writes++; throw new Error('No automatic writes'); },
      loadLearningEpisodes: async () => ({ version: 1, episodes: [] }), saveLearningEpisodes: async () => {} },
    noteRag: { search: async () => [] }, ragDocs: { search: async () => { docReads++; return [{ docId: 'doc', chunkId: 'chunk', fileName: '合成资料', sectionPath: '', snippet: documentText, score: 1, matchKinds: ['passage'] }]; } },
  } }) });
  globalThis.fetch = async () => { throw new Error('Network forbidden'); };
  const ctx = { getNotes: () => [], getActiveNote: () => null, getResourceDraftSession: () => null, getPlanDraftSession: () => null,
    hasPendingPlanEditorDraft: () => false, ensureDataFresh: async () => {} } as unknown as AgentRuntimeContext;
  registerQaTools();
  await test('真实 Agent 编排从私人混合检索到审核输出，成功／对齐失败／关闭审核三路径都不写认知', async () => {
    for (const mode of ['accepted', 'different-object', 'disabled']) {
      let calls = 0;
      const result = await runAgentTurn({ role: AGENT_ROLES.default, userText: '请比对我的理解：机器甲产生热量和振动是否矛盾？', ctx, history: [], memoryPrefixLoader: async () => '', enableMultiAgent: mode !== 'disabled',
        callLlm: async (request) => {
          calls++;
          if (request.systemPromptOverride?.includes('You are a citation evidence reviewer')) return { content: '', parsedJson: { coverage: 'partial', supportedCitationIds: ['D1'], risks: [], answerGuidance: [] } };
          if (request.systemPromptOverride?.includes('选取最值得核对的一条')) {
            const value = aligned(); if (mode === 'different-object') value.axes.object.status = 'different';
            return { content: JSON.stringify(value) };
          }
          return { content: '你的旧认知错误，已经替你覆盖旧版本。' };
        } });
      assert.equal(calls, mode === 'disabled' ? 1 : 3);
      assert.match(result.reply, mode === 'accepted' ? /不直接否定/ : /先不建议合并或覆盖/);
      assert.equal(result.reply.includes('已经替你覆盖'), false);
      assert.equal(result.updatedHistory.at(-1)?.cognitionReferences?.[0].nodeId, 'n1');
      assert.equal(result.updatedHistory.at(-1)?.citations?.[0].sourceId, 'D1');
    }
    assert.equal(privateReads, 3); assert.equal(docReads, 3); assert.equal(writes, 0);
    assert.equal(await fs.readFile(path.join(root, COGNITION_FILE_NAME), 'utf-8'), before);
  });
} finally {
  globalThis.fetch = previousFetch;
  if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow); else Reflect.deleteProperty(globalThis, 'window');
  await fs.rm(root, { recursive: true, force: true }); // Only the exact temporary directory created by this test.
}
console.log(`${passed} cognition alignment checks passed (scripted semantic reviewer, no network).`);
