import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { applyCognitionMutation, cognitionGraph, emptyCognitionFile, latestCognition, parseCognitionFile, searchCognition } from '../src/services/cognition/core.ts';
import type { CognitionFile, CognitionMutation, CognitionObservation } from '../src/services/cognition/types.ts';
import { cognitionCandidateId, isCognitionCandidateText, reviewCognitionObservations } from '../src/services/cognition/observations.ts';
import { ALL_ARGUMENT_TYPES } from '../src/services/argumentDoc/types.ts';
import { COGNITION_FILE_NAME, loadCognition, mutateCognition } from '../src/electron/cognitionStore.ts';
import { captureReviewCognition } from '../src/services/cognition/store.ts';

let passed = 0;
async function test(name: string, run: () => void | Promise<void>) { await run(); passed++; console.log(`PASS ${name}`); }
const node = (id: string, text: string) => ({ id, text, mainType: '事实陈述' as const, position: { x: 0, y: 0 }, status: 'warning' as const, issue: '缺少证据', severity: 3, suggestion: '请补充来源', user_edited: true, collapsed: false });
const doc = { doc_id: 'graph-a', title: '条件因果', nodes: [node('s1', 'A 在 B 条件下导致 C')], edges: [] };
function request(state: CognitionFile, patch: Partial<Extract<CognitionMutation, { kind: 'confirm' }>> = {}): Extract<CognitionMutation, { kind: 'confirm' }> {
  return { kind: 'confirm', confirmed: true, expectedRevision: state.revision, operation: state.records.length ? 'supplement' : 'initial',
    reason: '我的新表述', authorship: 'own_expression', stance: 'endorsed', doc, noteId: 'note-a', ...patch };
}
let serial = 0;
const apply = (state: CognitionFile, input: unknown) => applyCognitionMutation(state, input, { id: `revision-${++serial}`, at: '2026-10-04T00:00:00.000Z' });
const initial = () => apply(emptyCognitionFile(), request(emptyCognitionFile()));
const current = (state: CognitionFile) => latestCognition(state.records[0]);

await test('瑕疵论证、单节点、无证据也能显式记录；不提高掌握度', () => {
  const state = initial();
  assert.equal(current(state).branches[0].graph.nodes[0].text, doc.nodes[0].text);
  assert.equal(current(state).mastery, 'not_assessed');
  assert.equal(current(state).factSupport, 'not_assessed');
  const source = current(state).source;
  assert.equal(source.kind === 'argument_editor' && source.noteId, 'note-a');
});
await test('全部既有论证节点类型均可记录', () => {
  for (const mainType of ALL_ARGUMENT_TYPES) assert.equal(cognitionGraph({ ...doc, nodes: [{ ...doc.nodes[0], mainType }] }).nodes[0].mainType, mainType);
});
await test('手动整图写入仍需明确保存，上传或 AI 自动写入请求被拒绝', () => {
  for (const confirmed of [false, undefined, 'true']) assert.throws(() => apply(emptyCognitionFile(), { ...request(emptyCognitionFile()), confirmed }), /明确确认/);
  assert.throws(() => apply(emptyCognitionFile(), { ...request(emptyCognitionFile()), kind: 'upload' }), /操作无效/);
  assert.throws(() => apply(emptyCognitionFile(), { ...request(emptyCognitionFile()), authorship: 'ai_generated' }), /表述来源/);
});
await test('AI 总结、建议、质量分、发布快照不进入认知投影', () => {
  const state = apply(emptyCognitionFile(), request(emptyCognitionFile(), { doc: { ...doc, summary: 'AI 的总结', rag: { publishedSnapshot: { text: 'AI 发布' } } } as never }));
  const raw = JSON.stringify(state);
  for (const excluded of ['AI 的总结', 'AI 发布', '请补充来源', '缺少证据', 'scores', 'publishedSnapshot']) assert.equal(raw.includes(excluded), false);
});
await test('补充 D 后保留 C，不改写为互斥或、不弱化确定程度', () => {
  const before = initial(); const original = JSON.stringify(before);
  const next = apply(before, request(before, { doc: { ...doc, nodes: [...doc.nodes, node('s2', 'A 在 B 条件下也导致 D')], edges: [{ id: 'e1', source: 's1', target: 's2', relation: 'support' }] } }));
  assert.deepEqual(current(next).branches[0].graph.nodes.map((n) => n.text), ['A 在 B 条件下导致 C', 'A 在 B 条件下也导致 D']);
  assert.equal(current(next).branches[0].graph.edges.length, 1);
  assert.equal(JSON.stringify(before), original);
  assert.deepEqual(next.records[0].revisions[0], before.records[0].revisions[0]);
});
await test('画布中少了 C，补充仍保留 C；同 ID 改成 D 必须显式修订', () => {
  const state = initial();
  const next = apply(state, request(state, { doc: { ...doc, nodes: [node('s2', 'D')] } }));
  assert.equal(current(next).branches[0].graph.nodes.length, 2);
  assert.throws(() => apply(state, request(state, { doc: { ...doc, nodes: [node('s1', 'D')] } })), /补充不能改写/);
  assert.throws(() => apply(state, request(state, { stance: 'tentative' })), /调整确定程度/);
});
await test('补充不能偷换旧连线的方向或关系', () => {
  const graph = { ...doc, nodes: [...doc.nodes, node('s2', 'D')], edges: [{ id: 'e1', source: 's1', target: 's2', relation: 'support' as const }] };
  const state = apply(emptyCognitionFile(), request(emptyCognitionFile(), { doc: graph }));
  assert.throws(() => apply(state, request(state, { doc: { ...graph, edges: [{ ...graph.edges[0], relation: 'oppose' }] } })), /改写已有连线/);
});
await test('修订／条件调整／确定程度调整保留历史，当前检索不返回被替代主张', () => {
  for (const operation of ['revise', 'qualify', 'certainty'] as const) {
    const state = initial();
    const next = apply(state, request(state, { operation, doc: { ...doc, nodes: [node('s1', '新的限定表述')] }, stance: 'tentative' }));
    assert.equal(current(next).number, 2);
    assert.equal(next.records[0].revisions[0].branches[0].graph.nodes[0].text, doc.nodes[0].text);
    assert.equal(current(next).branches[0].graph.nodes[0].text, '新的限定表述');
    assert.equal(searchCognition(next, '导致 C').length, 0);
    assert.equal(searchCognition(next, '限定表述').length, 1);
  }
});
await test('情境并存和未决分歧不抹去旧认知，未决分支不能标为事实', () => {
  let state = initial();
  for (const operation of ['contextual', 'alternative'] as const) {
    state = apply(state, request(state, { operation, reason: '在另外的边界条件下', doc: { ...doc, nodes: [node('s1', '另一个结论')] } }));
  }
  assert.equal(current(state).branches.length, 3);
  assert.equal(current(state).branches[0].graph.nodes[0].text, doc.nodes[0].text);
  assert.equal(current(state).branches[2].stance, 'tentative');
  const updated = apply(state, request(state, { operation: 'revise', doc: { ...doc, nodes: [node('s1', '修订主要理解')] } }));
  assert.equal(current(updated).branches.length, 3);
});
await test('更新必须说明原因、版本必须匹配、禁止重复初始化', () => {
  const state = initial();
  assert.throws(() => apply(state, request(state, { reason: '' })), /更新说明/);
  assert.throws(() => apply(state, request(state, { expectedRevision: 0 })), /其他窗口/);
  assert.throws(() => apply(state, request(state, { operation: 'initial' })), /已有个人认知/);
  assert.throws(() => apply(emptyCognitionFile(), request(emptyCognitionFile(), { operation: 'revise' })), /首次/);
});
await test('结构序列化错误拒绝写入，但不进行事实／逻辑质量准入', () => {
  for (const graph of [{ ...doc, nodes: [] }, { ...doc, nodes: [node('s1', '')] }, { ...doc, nodes: [doc.nodes[0], doc.nodes[0]] }, { ...doc, edges: [{ id: 'e1', source: 's1', target: 'missing', relation: 'support' }] }]) {
    assert.throws(() => cognitionGraph(graph));
  }
  assert.throws(() => parseCognitionFile({ schemaVersion: 9, revision: 0, records: [] }));
  const invalid = initial(); invalid.records[0].revisions[0].branches = [];
  assert.throws(() => parseCognitionFile(invalid));
});
await test('当前理解检索有来源／版本／认同状态，而且禁止用作事实证据', () => {
  const hits = searchCognition(initial(), '条件');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].purpose, 'cognition_diagnosis');
  assert.equal(hits[0].usableAsFactEvidence, false);
  assert.equal(hits[0].source.docId, doc.doc_id);
  assert.ok(hits[0].revisionId);
  assert.equal(searchCognition(initial(), '').length, 0);
});
await test('忘记认知独立于原图，删除后旧请求不能复活记录', () => {
  const state = initial(); const original = JSON.stringify(doc);
  const next = apply(state, { kind: 'forget', expectedRevision: state.revision, confirmed: true, recordId: doc.doc_id });
  assert.equal(next.records.length, 0);
  assert.equal(next.revision, 2);
  assert.equal(JSON.stringify(doc), original);
  assert.throws(() => apply(next, request(state)), /其他窗口/);
});

const observation: CognitionObservation = {
  activityKind: 'review', activityId: 'review-test', messageId: 'user-1', role: 'user',
  answer: '我的理解是：A 在 B 条件下不仅导致 C，还可能导致 D。', question: '请解释 A 在条件 B 下的影响。',
  observedAt: '2026-10-04T10:00:00.000Z', noteId: 'note-1', noteTitle: '条件推理', hintLevel: 2,
  consultedMaterialIds: ['note:source-1'], targetKnowledgeNames: ['条件推理'],
};
const capture = (observations = [observation]) => ({ kind: 'capture_review', enabled: true, observations });
const pending = () => apply(emptyCognitionFile(), capture());
const accept = (state: CognitionFile, patch: Record<string, unknown> = {}) => ({ kind: 'accept_candidate',
  expectedRevision: state.revision, confirmed: true, candidateId: cognitionCandidateId(observation),
  text: 'A 在 B 下可能有 C 和 D 两种结果，仍需分别寻找证据。', mainType: '假设', stance: 'tentative', authorship: 'adopted_with_assistance', ...patch });

await test('候选过滤寒暄、纯提问、显式引用，不对实质回答判真伪', () => {
  for (const text of ['好的，谢谢，我明白了', '请问这个问题应该如何解释呢', 'A 在这个条件下为什么会导致 C？', '> 这是资料中的原文，不是我的表达。', '“选择过多一定会造成决策困难。”', '资料说选择过多一定会造成决策困难。']) assert.equal(isCognitionCandidateText(text), false, text);
  assert.equal(isCognitionCandidateText(observation.answer), true);
  assert.equal(isCognitionCandidateText('我的猜想是这些现象可能还有其他解释。'), true);
});
await test('只从用户消息提取，辅助信息按消息 ID 匹配，不采集资料正文和 AI 总结', () => {
  const observations = reviewCognitionObservations({ id: 'review-test', startedAt: observation.observedAt, endedAt: observation.observedAt,
    questionText: observation.question, knowledgeContext: '不应保存的完整上传资料', masteryEligible: false,
    messages: [{ id: 'tutor-1', role: 'assistant', content: '最新追问上下文', timestamp: observation.observedAt },
      { id: 'user-1', role: 'user', content: observation.answer, timestamp: observation.observedAt },
      { id: 'tutor-2', role: 'assistant', content: 'AI 长篇评价总结不能作为认知回答', timestamp: observation.observedAt }],
    answerEvidence: [{ messageId: 'other', answer: observation.answer, hintLevel: 0, targetKnowledgeNames: [] },
      { messageId: 'user-1', answer: observation.answer, hintLevel: 3, targetKnowledgeNames: ['条件推理'], consultedMaterialIds: ['note:x'] }],
  }, { id: 'note-1', title: '条件推理' });
  assert.equal(observations.length, 1); assert.equal(observations[0].hintLevel, 3);
  assert.equal(observations[0].question, '最新追问上下文');
  assert.equal(JSON.stringify(observations).includes('完整上传资料'), false);
  assert.equal(JSON.stringify(observations).includes('AI 长篇'), false);
});
await test('缺少旧消息 ID 不回填；辅助原文不匹配时按未知处理', () => {
  const base = { id: 'review-test', startedAt: observation.observedAt, endedAt: observation.observedAt,
    questionText: '', knowledgeContext: '', messages: [{ role: 'user' as const, content: observation.answer, timestamp: observation.observedAt }] };
  assert.equal(reviewCognitionObservations(base, { title: '' }).length, 0);
  const found = reviewCognitionObservations({ ...base, messages: [{ ...base.messages[0], id: 'user-1' }],
    answerEvidence: [{ messageId: 'user-1', answer: '另一条回答', hintLevel: 0, targetKnowledgeNames: [] }] }, { title: '' });
  assert.equal(found[0].hintLevel, null);
});
await test('候选采集不创建当前认知，也不能进入当前认知检索', () => {
  const state = pending();
  assert.equal(state.records.length, 0); assert.equal(state.candidates?.length, 1);
  assert.equal(searchCognition(state, '条件').length, 0);
  assert.throws(() => apply(emptyCognitionFile(), { ...capture(), enabled: false }), /未开启/);
  assert.throws(() => apply(emptyCognitionFile(), capture([{ ...observation, role: 'assistant' } as never])), /用户/);
});
await test('批次重试幂等；同 ID 原文变更不能覆盖候选', () => {
  const state = pending();
  assert.deepEqual(apply(state, capture()), state);
  assert.throws(() => apply(state, capture([{ ...observation, answer: '另一条不同的实质性回答原文' }])), /原文或上下文已变化/);
});
await test('显式采纳原子地生成独立认知并移除待处理项，原文和整理稿分开', () => {
  const state = pending(); const next = apply(state, accept(state)); const v = current(next);
  assert.equal(next.records.length, 1); assert.equal(next.candidates![0].status, 'accepted');
  assert.equal(v.source.kind, 'review_answer');
  assert.equal(v.source.kind === 'review_answer' && v.source.observation.answer, observation.answer);
  assert.equal(v.branches[0].graph.nodes[0].text, accept(state).text);
  assert.equal(v.branches[0].graph.edges.length, 0);
  assert.equal(v.mastery, 'not_assessed'); assert.equal(v.factSupport, 'not_assessed');
  assert.deepEqual(apply(next, capture()), next);
  assert.throws(() => apply(next, accept(next)), /已被处理/);
});
await test('有提示／查阅／未知辅助不能将采纳标为独立表述', () => {
  for (const hints of [observation, { ...observation, hintLevel: null }, { ...observation, hintLevel: 0 }]) {
    const state = apply(emptyCognitionFile(), capture([hints as CognitionObservation]));
    assert.throws(() => apply(state, accept(state, { authorship: 'own_expression' })), /不能标记为独立/);
  }
  const unassisted = apply(emptyCognitionFile(), capture([{ ...observation, hintLevel: 0, consultedMaterialIds: [] }]));
  assert.equal(current(apply(unassisted, accept(unassisted, { authorship: 'own_expression' }))).authorship, 'own_expression');
});
await test('未确认、空稿、过期版本不能采纳；不会影响原有认知', () => {
  const state = apply(initial(), capture()); const old = JSON.stringify(state.records);
  for (const patch of [{ confirmed: false }, { text: '' }, { expectedRevision: -1 }]) assert.throws(() => apply(state, accept(state, patch)));
  const next = apply(state, accept(state));
  assert.equal(JSON.stringify(next.records.slice(0, 1)), old);
  assert.equal(next.records.length, 2);
});
await test('忽略清除候选原文，重放不复活；忘记已采纳记录也不复活', () => {
  const state = pending();
  const ignored = apply(state, { kind: 'dismiss_candidate', expectedRevision: state.revision, confirmed: true, candidateId: cognitionCandidateId(observation) });
  assert.deepEqual(ignored.candidates, [{ id: cognitionCandidateId(observation), status: 'dismissed' }]);
  assert.equal(JSON.stringify(ignored).includes(observation.answer), false);
  assert.deepEqual(apply(ignored, capture()), ignored);
  const accepted = apply(state, accept(state));
  const forgotten = apply(accepted, { kind: 'forget', expectedRevision: accepted.revision, confirmed: true, recordId: accepted.records[0].id });
  assert.equal(forgotten.records.length, 0);
  assert.equal(JSON.stringify(forgotten).includes(observation.answer), false);
  assert.deepEqual(apply(forgotten, capture()), forgotten);
});
await test('候选格式损坏与超量批次拒绝；兼容没有候选字段的旧文件', () => {
  assert.deepEqual(parseCognitionFile(emptyCognitionFile()), emptyCognitionFile());
  assert.throws(() => parseCognitionFile({ ...emptyCognitionFile(), candidates: [{}] }));
  assert.throws(() => apply(emptyCognitionFile(), capture([{ ...observation, hintLevel: 9 } as never])));
  assert.throws(() => apply(emptyCognitionFile(), capture(Array(501).fill(observation))));
});

const targeted = (state: CognitionFile, operation: 'supplement' | 'revise' | 'qualify' | 'certainty' | 'contextual' | 'alternative' = 'supplement', nodeId = 's1') => ({
  kind: 'update_cognition', expectedRevision: state.revision, confirmed: true,
  target: { recordId: state.records[0].id, revisionId: current(state).id, branchId: 'primary', nodeId, operation, reason: '用户核对后的调整' },
  text: 'A 在 B 条件下也导致 D', mainType: '假设', stance: 'tentative', authorship: 'own_expression',
});
const connected = () => apply(emptyCognitionFile(), request(emptyCognitionFile(), { doc: { ...doc,
  nodes: [...doc.nodes, node('s2', '由 C 推导 E'), node('s3', '由 E 推导 F')],
  edges: [{ id: 'e1', source: 's1', target: 's2', relation: 'support' }, { id: 'e2', source: 's2', target: 's3', relation: 'oppose' }] } }));
await test('定点补充保留 C 与原连线，不猜测逻辑关系，也不降低其他节点认同程度', () => {
  const state = connected(), original = JSON.stringify(state);
  const next = apply(state, targeted(state));
  assert.equal(current(next).branches[0].graph.nodes.length, 4);
  assert.deepEqual(current(next).branches[0].graph.nodes.slice(0, 3), current(state).branches[0].graph.nodes);
  assert.deepEqual(current(next).branches[0].graph.edges, current(state).branches[0].graph.edges);
  assert.equal(searchCognition(next, '导致 C')[0].stance, 'endorsed');
  assert.equal(searchCognition(next, '导致 D')[0].stance, 'tentative');
  assert.equal(JSON.stringify(state), original);
});
await test('修订／条件／确定程度只改选中节点，向下游传递待复核，不删除或判错', () => {
  for (const op of ['revise', 'qualify', 'certainty'] as const) {
    const state = connected(), next = apply(state, targeted(state, op));
    const branch = current(next).branches[0];
    assert.deepEqual(branch.reviewNeededNodeIds, ['s2', 's3']);
    assert.deepEqual(branch.graph.nodes.slice(1), current(state).branches[0].graph.nodes.slice(1));
    assert.equal(branch.graph.edges.length, 2);
    assert.equal(searchCognition(next, '推导 F')[0].needsReview, true);
    assert.equal(searchCognition(next, '推导 F')[0].usableAsFactEvidence, false);
    assert.deepEqual(next.records[0].revisions[0], state.records[0].revisions[0]);
  }
});
await test('定点复核清除本节点标记，其他待复核结论不会被一并洗白', () => {
  const state = connected(), changed = apply(state, targeted(state, 'revise'));
  const next = apply(changed, { ...targeted(changed, 'revise', 's2'), text: '由 C 推导 E', mainType: '事实陈述', stance: 'endorsed' });
  assert.deepEqual(current(next).branches[0].reviewNeededNodeIds, ['s3']);
});
await test('循环论证的待复核传播会终止，不把刚确认的起点重复标回', () => {
  const state = connected();
  current(state).branches[0].graph.edges.push({ id: 'cycle', source: 's3', target: 's1', relation: 'support' });
  assert.deepEqual(current(apply(state, targeted(state, 'revise'))).branches[0].reviewNeededNodeIds, ['s2', 's3']);
});
await test('画布修订同样标记依赖变化，补充不会清除既有待复核标记', () => {
  const state = connected();
  const changed = apply(state, request(state, { operation: 'revise', doc: { ...doc, nodes: [node('s1', '改过的前提'), node('s2', '由 C 推导 E'), node('s3', '由 E 推导 F')], edges: current(state).branches[0].graph.edges } }));
  assert.deepEqual(current(changed).branches[0].reviewNeededNodeIds, ['s2', 's3']);
  const next = apply(changed, request(changed, { doc: { ...doc, nodes: [node('s4', '新补充')] } }));
  assert.deepEqual(current(next).branches[0].reviewNeededNodeIds, ['s2', 's3']);
});
await test('候选合并原子地追加版本与处理回执，保留原回答和旧节点来源', () => {
  const state = apply(initial(), capture());
  const next = apply(state, accept(state, { target: targeted(state).target }));
  assert.equal(next.records.length, 1); assert.equal(next.revision, state.revision + 1);
  assert.equal(current(next).number, 2);
  assert.equal(current(next).source.kind, 'review_answer');
  const source = current(next).source;
  assert.equal(source.kind === 'review_answer' && source.observation.answer, observation.answer);
  assert.deepEqual(next.candidates, [{ id: cognitionCandidateId(observation), status: 'accepted', recordId: doc.doc_id }]);
  assert.equal(searchCognition(next, '导致 C')[0].source.kind, 'argument_editor');
  assert.equal(searchCognition(next, '仍需分别寻找证据')[0].source.kind, 'review_answer');
  assert.deepEqual(apply(next, capture()), next);
  const later = apply(next, targeted(next, 'revise'));
  assert.equal(searchCognition(later, '仍需分别寻找证据')[0].source.kind, 'review_answer');
});
await test('候选合并失败不消费候选：过期／未知目标／非法状态／独立表述限制', () => {
  const state = apply(initial(), capture()), original = JSON.stringify(state), target = targeted(state).target;
  for (const patch of [{ revisionId: 'stale' }, { recordId: 'other' }, { branchId: 'other' }, { nodeId: 'missing' }, { operation: 'initial' }, { reason: '' }]) {
    assert.throws(() => apply(state, accept(state, { target: { ...target, ...patch } })));
  }
  assert.throws(() => apply(state, accept(state, { target, authorship: 'own_expression' })), /独立/);
  assert.throws(() => apply(state, accept(state, { target, stance: 'correct' })));
  assert.throws(() => apply(state, accept(state, { target, confirmed: false })));
  assert.equal(JSON.stringify(state), original);
});
await test('定点并存分支不覆写原分支，未决分歧强制待验证，可继续定点更新分支', () => {
  for (const operation of ['contextual', 'alternative'] as const) {
    const state = initial(), next = apply(state, { ...targeted(state, operation), stance: 'endorsed' });
    assert.deepEqual(current(next).branches[0], current(state).branches[0]);
    const branch = current(next).branches[1];
    assert.equal(branch.graph.edges.length, 0);
    assert.equal(branch.stance, operation === 'alternative' ? 'tentative' : 'endorsed');
    const mutation = targeted(next, 'qualify');
    const updated = apply(next, { ...mutation, text: '另一情境下的限定表述', target: { ...mutation.target, branchId: branch.id, nodeId: branch.graph.nodes[0].id } });
    assert.equal(current(updated).branches[1].graph.nodes[0].text, '另一情境下的限定表述');
    assert.deepEqual(current(updated).branches[0], current(state).branches[0]);
  }
});
await test('旧回答独立记录可手动修订，来源原文留在旧版本而非新版本伪装复习', () => {
  const state = pending(), accepted = apply(state, accept(state));
  const next = apply(accepted, targeted(accepted, 'qualify'));
  assert.equal(current(next).source.kind, 'manual_revision');
  assert.equal(next.records[0].revisions[0].source.kind, 'review_answer');
  assert.doesNotThrow(() => parseCognitionFile(next));
});
await test('扩展格式拒绝损坏节点状态、待复核引用、变更目标与采纳回执', () => {
  const state = initial(), next = apply(state, targeted(state));
  for (const corrupt of [
    (f: CognitionFile) => { current(f).branches[0].reviewNeededNodeIds = ['missing']; },
    (f: CognitionFile) => { current(f).branches[0].graph.nodes[0].stance = 'wrong' as never; },
    (f: CognitionFile) => { current(f).change!.revisionId = 'missing'; },
    (f: CognitionFile) => { f.candidates = [{ id: cognitionCandidateId(observation), status: 'accepted', recordId: 'missing' }]; },
  ]) { const copy = structuredClone(next); corrupt(copy); assert.throws(() => parseCognitionFile(copy)); }
});

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-cognition-test-'));
try {
  const directory = path.join(temporary, 'user-state');
  await test('独立私人目录持久化与重读一致', async () => {
    const state = await mutateCognition(directory, request(emptyCognitionFile()));
    assert.deepEqual(await loadCognition(directory), state);
    assert.deepEqual(await fs.readdir(temporary), ['user-state']);
    assert.deepEqual(await fs.readdir(directory), [COGNITION_FILE_NAME]);
  });
  await test('两窗口基于同一旧版本并发更新：仅一个成功，不丢失历史', async () => {
    const state = await loadCognition(directory);
    const results = await Promise.allSettled([
      mutateCognition(directory, request(state, { reason: '窗口一', doc: { ...doc, nodes: [...doc.nodes, node('s2', '新结论 D')] } })),
      mutateCognition(directory, request(state, { reason: '窗口二', doc: { ...doc, nodes: [...doc.nodes, node('s3', '新结论 E')] } })),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    assert.equal((await loadCognition(directory)).records[0].revisions.length, 2);
  });
  await test('失败不毒化事务队列；刷新后重试保留前一窗口更新', async () => {
    const state = await loadCognition(directory);
    const next = await mutateCognition(directory, request(state, { doc: { ...doc, nodes: [node('s3', '新结论 E')] } }));
    assert.deepEqual(current(next).branches[0].graph.nodes.map((n) => n.id), ['s1', 's2', 's3']);
    assert.deepEqual(await loadCognition(directory), next);
  });
  await test('数据根目录之间严格隔离', async () => {
    const other = path.join(temporary, 'other-user-state');
    assert.equal((await loadCognition(other)).records.length, 0);
    await mutateCognition(other, request(emptyCognitionFile()));
    assert.equal((await loadCognition(directory)).revision, 3);
    assert.equal((await loadCognition(other)).revision, 1);
  });
  await test('损坏文件不能静默当空库覆盖', async () => {
    const target = path.join(directory, COGNITION_FILE_NAME);
    await fs.writeFile(target, '{broken', 'utf-8');
    await assert.rejects(() => loadCognition(directory));
    await assert.rejects(() => mutateCognition(directory, request(emptyCognitionFile())));
    assert.equal(await fs.readFile(target, 'utf-8'), '{broken');
  });
  await test('旧候选并发重试只保存一份，读取时自动接入认知；并发编辑仍校验版本', async () => {
    const candidateDir = path.join(temporary, 'candidate-store');
    await Promise.all([mutateCognition(candidateDir, capture()), mutateCognition(candidateDir, capture())]);
    const state = await loadCognition(candidateDir);
    assert.equal(state.candidates?.length, 1); assert.equal(state.revision, 2);
    assert.equal(state.records.length, 1); assert.equal(state.candidates![0].status, 'accepted');
    const edit = { kind: 'update_cognition', expectedRevision: state.revision, confirmed: true, text: '用户修改后的理解仍完整保留。',
      mainType: '事实陈述', stance: 'endorsed', authorship: 'own_expression', target: { recordId: state.records[0].id,
        revisionId: latestCognition(state.records[0]).id, branchId: 'primary', nodeId: 's1', operation: 'revise', reason: '用户编辑' } };
    const results = await Promise.allSettled([mutateCognition(candidateDir, edit), mutateCognition(candidateDir, edit)]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const stored = await loadCognition(candidateDir);
    assert.equal(stored.records.length, 1); assert.equal(stored.candidates![0].status, 'accepted');
  });
  await test('候选定点合并与手工修改并发只成功一个，持久化后保留完整历史和来源', async () => {
    const dir = path.join(temporary, 'merge-store');
    await mutateCognition(dir, request(emptyCognitionFile()));
    const state = await mutateCognition(dir, capture());
    const results = await Promise.allSettled([
      mutateCognition(dir, accept(state, { target: targeted(state).target })),
      mutateCognition(dir, targeted(state, 'revise')),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const stored = await loadCognition(dir);
    assert.equal(stored.records.length, 1); assert.equal(current(stored).number, 2);
    assert.equal(stored.candidates![0].status, 'accepted');
    assert.equal(current(stored).source.kind, 'review_answer');
  });
} finally {
  // Only the exact, freshly allocated test directory; never touches the configured user data root.
  assert.ok(path.basename(temporary).startsWith('loginote-cognition-test-'));
  assert.equal(path.dirname(temporary), os.tmpdir());
  await fs.rm(temporary, { recursive: true, force: true });
}
await test('现有事实 RAG／Agent／掌握度流程未自动接入私人认知写入', async () => {
  for (const file of ['src/services/ragService.ts', 'src/services/agent/tools/qaTools.ts', 'src/services/memory/episodeStore.ts']) {
    assert.equal((await fs.readFile(file, 'utf-8')).includes('savePersonalCognition'), false);
  }
  const userState = await fs.readFile('src/services/userStateService.ts', 'utf-8');
  assert.ok(userState.includes("cognition: 'personal-cognition.json'"));
  const sharable = userState.slice(userState.indexOf('export const SHARABLE_NOTE_FIELDS'), userState.indexOf('export const USER_STATE_FIELDS'));
  assert.equal(sharable.includes('cognition'), false);
});
await test('真实采集入口尊重开关、无有效候选不写库、失败向上抛出且重试幂等', async () => {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  let stored = emptyCognitionFile(), writes = 0, failWrite = false;
  const bridge = Object.assign(new EventTarget(), { electronAPI: { userState: {
    mutateCognition: async (input: CognitionMutation) => {
      writes++;
      if (failWrite) throw new Error('simulated disk failure');
      stored = apply(stored, input); return stored;
    },
  } } });
  Object.defineProperty(globalThis, 'window', { value: bridge, configurable: true });
  try {
    const episode = { id: 'review-test', startedAt: observation.observedAt, endedAt: observation.observedAt,
      questionText: observation.question, knowledgeContext: 'secret material', masteryEligible: false,
      messages: [{ id: 'user-1', role: 'user' as const, content: observation.answer, timestamp: observation.observedAt }] };
    await captureReviewCognition(episode, { title: '条件推理' }, false); assert.equal(writes, 0);
    await captureReviewCognition({ ...episode, messages: [{ ...episode.messages[0], content: '好的' }] }, { title: '' }, true); assert.equal(writes, 0);
    failWrite = true;
    await assert.rejects(() => captureReviewCognition(episode, { title: '条件推理' }, true), /disk failure/);
    assert.equal(stored.records.length, 0); assert.equal(stored.candidates?.length || 0, 0);
    failWrite = false;
    await captureReviewCognition(episode, { title: '条件推理' }, true);
    await captureReviewCognition(episode, { title: '条件推理' }, true);
    assert.equal(stored.candidates?.length, 1); assert.equal(stored.records.length, 1);
    assert.equal(latestCognition(stored.records[0]).branches[0].stance, 'endorsed');
    assert.equal(JSON.stringify(stored).includes('secret material'), false);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
console.log(`\n${passed} personal cognition checks passed.`);
