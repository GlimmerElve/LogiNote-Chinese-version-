import assert from 'node:assert/strict';
import { cognitionManagementFixture } from './check-cognition-management';
import { applyCognitionMutation, latestCognition, parseCognitionFile } from '../src/services/cognition/core';
import { buildCognitionManagement } from '../src/services/cognition/management';
import { buildInquirySnapshot } from '../src/services/cognition/inquiry';
import { previewCognitionGraphEdit } from '../src/services/cognition/editing';
import type { CognitionGraphEdit, CognitionFile } from '../src/services/cognition/types';
import { prepareCognitionChange } from '../src/services/cognition/changeProposals';
import { executeTool, getTool, toolRequiresApproval } from '../src/services/agent/toolRegistry';
import { registerCognitionTools } from '../src/services/agent/tools/cognitionTools';
import { AGENT_ROLES, runAgentTurn, resolveAgentApproval } from '../src/services/agent/agentEngine';
import { selectAgentSkill } from '../src/services/agent/skillRegistry';
import type { AgentRuntimeContext } from '../src/services/agent/types';
import type { LlmCallRequest } from '../src/types';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCognition, mutateCognition } from '../src/electron/cognitionStore';

let sequence = 0, checks = 0;
const pass = (text: string) => { checks++; console.log(`PASS ${text}`); };
let file = cognitionManagementFixture();
const reference = (recordId: string, nodeId: string, input = file) => ({ recordId, revisionId: latestCognition(input.records.find(r => r.id === recordId)!).id, branchId: 'primary', nodeId });
const mutate = (edit: CognitionGraphEdit) => { file = applyCognitionMutation(file, { kind: 'edit_graph', confirmed: true, expectedRevision: file.revision, edit }, { id: `edit-${++sequence}`, at: '2026-10-20T03:00:00Z' }); return file; };
const view = () => buildCognitionManagement(file);
const old = structuredClone(file);
mutate({ action: 'add_node', title: '新认识', text: '我在有明确反馈时更容易保持投入。', mainType: '假设', stance: 'tentative', role: 'claim', reason: '用户主动记录' });
assert.equal(view().summary.nodes, 7); assert.equal(view().summary.isolated, 2); assert.deepEqual(file.records[0], old.records[0]);
const before = latestCognition(file.records[0]);
mutate({ action: 'update_node', target: reference('mental', 'c'), text: '我现在意识到，只有分类边界固定时心理账户才会限制我的消费决策。', mainType: '推理', stance: 'endorsed', operation: 'qualify', reason: '用户补充边界条件' });
assert.equal(latestCognition(file.records[0]).branches[0].graph.nodes.find(n => n.id === 'c')?.role, 'claim');
assert.equal(file.records[0].revisions.at(-2)?.id, before.id);
assert.throws(() => mutate({ action: 'delete_node', target: { ...reference('mental', 'c'), revisionId: before.id }, reason: '旧确认' }), /变化/);
pass('standalone addition and precise condition updates preserve other blocks, roles and version history; stale targets fail closed');

const destinationBase = cognitionManagementFixture(), destinationFrozen = structuredClone(destinationBase);
const destinationEdit: Extract<CognitionGraphEdit, { action: 'add_node' }> = { action: 'add_node', title: '睡眠与记忆', text: '我在充分睡眠后更容易记住新知识。',
  mainType: '假设', stance: 'tentative', reason: '用户明确要求加入已有记录', meaning: { interpretation: '新增认知块，保留既有主题', preserved: [] },
  parent: { recordId: 'mental', revisionId: latestCognition(destinationBase.records[0]).id, branchId: 'primary' } };
const destinationPreview = previewCognitionGraphEdit(destinationBase, destinationEdit, 'adopted_with_assistance').lines.join('\n');
assert.match(destinationPreview, /保存方式：加入已有认知记录/);
assert.match(destinationPreview, /目标记录：心理账户与消费决策（记录 ID：mental）/);
assert.match(destinationPreview, /目标分支：主要理解.*分支 ID：primary/);
assert.match(destinationPreview, /不会重命名目标记录/);
assert.ok(!destinationPreview.split('\n').includes('主题：睡眠与记忆'), 'an ignored proposed title cannot be presented as the saved destination');
const destinationSaved = applyCognitionMutation(destinationBase, { kind: 'edit_graph', confirmed: true, expectedRevision: destinationBase.revision, authorship: 'adopted_with_assistance', edit: destinationEdit }, { id: 'destination-added', at: '2026-10-20T03:00:00Z' });
assert.equal(buildCognitionManagement(destinationSaved).groups.flatMap(group => group.nodes).find(node => node.text === destinationEdit.text)!.title, '心理账户与消费决策');
for (const operation of ['contextual', 'alternative'] as const) {
  const branched = applyCognitionMutation(destinationBase, { kind: 'update_cognition', confirmed: true, expectedRevision: destinationBase.revision,
    target: { recordId: 'mental', revisionId: latestCognition(destinationBase.records[0]).id, branchId: 'primary', nodeId: 'c', operation, reason: '仅适用于特定收入情境' },
    text: '这是另一情境下的认识。', mainType: '假设', stance: 'tentative', authorship: 'own_expression' }, { id: `destination-${operation}`, at: '2026-10-20T03:00:00Z' });
  const revision = latestCognition(branched.records[0]), branch = revision.branches.find(branch => branch.kind === operation)!;
  const proposal = previewCognitionGraphEdit(branched, { ...destinationEdit, parent: { recordId: 'mental', revisionId: revision.id, branchId: branch.id } }).lines.join('\n');
  assert.ok(proposal.includes(`分支 ID：${branch.id}`)); assert.ok(proposal.includes(operation === 'contextual' ? '不同情境' : '未决分歧'));
  assert.match(proposal, /分支情境：仅适用于特定收入情境/);
}
const standalonePreview = previewCognitionGraphEdit(destinationBase, { ...destinationEdit, parent: undefined }).lines.join('\n');
assert.match(standalonePreview, /独立新建认知记录[\s\S]*主题：睡眠与记忆/); assert.ok(!standalonePreview.includes('目标记录：'));
assert.throws(() => previewCognitionGraphEdit(destinationBase, { ...destinationEdit, parent: { ...destinationEdit.parent!, revisionId: 'stale-version' } }), /变化/);
assert.deepEqual(destinationBase, destinationFrozen);
pass('addition previews identify the actual record, branch kind/ID/context and version; independent titles remain distinct, stale parents are rejected, and previews never rename or mutate their destination');

mutate({ action: 'add_relation', source: reference('mental', 'p'), target: reference('flow', 'p'), relation: 'context', reason: '用户明确选择跨活动背景关系，不是支持证明' });
assert.equal(file.links?.length, 1); assert.equal(view().groups.length, 3); // mental+flow; lone; new
assert.equal(view().groups.find(g => g.recordId === 'mental')?.nodes.length, 5);
assert.ok(latestCognition(file.records.find(r => r.id === 'flow')!).branches[0].reviewNeededNodeIds?.includes('c'));
const inquiry = buildInquirySnapshot(file, '我怎么理解心理账户');
assert.ok(inquiry.pages.flatMap(p => p.sources).some(s => s.reference?.recordId === 'flow'));
assert.ok(inquiry.pages.flatMap(p => p.edges).some(e => e.relation === 'context'));
let cross = view().groups.flatMap(g => g.edges).find(e => e.reference && 'linkId' in e.reference)!;
mutate({ action: 'update_relation', edge: cross.reference!, source: reference('flow', 'p'), target: reference('mental', 'p'), relation: 'relates', reason: '只记录相关，不作背景推导' });
assert.equal(file.links?.[0].relation, 'relates'); assert.equal(file.links?.[0].source.recordId, 'flow');
cross = view().groups.flatMap(g => g.edges).find(e => e.reference && 'linkId' in e.reference)!;
mutate({ action: 'delete_relation', edge: cross.reference!, reason: '用户移除跨活动关系' });
assert.equal(file.links?.length, 0); assert.equal(view().groups.length, 4); assert.ok(file.linkHistory!.length >= 4);
pass('explicit cross-activity directed links merge/split real components, reach inquiry, propagate review flags, and preserve relationship history');

const local = view().groups.flatMap(g => g.edges).find(e => e.relation === 'oppose')!;
mutate({ action: 'update_relation', edge: local.reference!, source: reference('mental', 'o'), target: reference('mental', 'c'), relation: 'relates', reason: '用户修改已有关系类型' });
assert.equal(view().groups.flatMap(g => g.edges).filter(e => e.relation === 'oppose').length, 0);
mutate({ action: 'delete_node', target: reference('mental', 'p'), reason: '只删除这个认知块及其关系' });
assert.equal(latestCognition(file.records[0]).branches[0].graph.nodes.length, 2);
assert.ok(!latestCognition(file.records[0]).branches[0].graph.edges.some(e => e.source === 'p' || e.target === 'p'));
mutate({ action: 'delete_node', target: reference('lone', 'p'), reason: '删除最后一个块但保留历史' });
assert.equal(latestCognition(file.records.find(r => r.id === 'lone')!).branches[0].graph.nodes.length, 0);
assert.ok(file.records.find(r => r.id === 'lone')!.revisions.length > 1); parseCognitionFile(JSON.parse(JSON.stringify(file)));
assert.throws(() => mutate({ action: 'add_relation', source: reference('mental', 'c'), target: reference('mental', 'c'), relation: 'support', reason: '自身' }), /自身/);
pass('node and local-edge CRUD remove only intended objects, delete incident links safely, and retain history even when a graph becomes empty');
file = cognitionManagementFixture();
mutate({ action: 'add_relation', source: reference('mental', 'p'), target: reference('flow', 'p'), relation: 'relates', reason: '用户保存的明确关系' });
const linked = structuredClone(file);
file.records[0].withdrawn = true;
assert.equal(view().summary.brokenReferences, 1); assert.equal(view().brokenEdges.length, 1);
assert.ok(!buildInquirySnapshot(file, '我的认知库').pages.flatMap(page => page.edges).some(edge => edge.relation === 'relates'));
const broken = view().brokenEdges[0];
mutate({ action: 'update_relation', edge: broken.reference!, source: reference('lone', 'p'), target: reference('flow', 'p'), relation: 'context', reason: '用户重新指定真实来源，不猜测替代节点' });
assert.equal(view().summary.brokenReferences, 0);
const corrupt = cognitionManagementFixture(); corrupt.records[0].revisions[0].branches[0].graph.nodes = []; corrupt.records[0].revisions[0].branches[0].graph.edges = [];
assert.throws(() => parseCognitionFile(corrupt), /非空/);
file = linked;
const forgotId = 'mental';
file = applyCognitionMutation(file, { kind: 'forget', confirmed: true, expectedRevision: file.revision, recordId: forgotId }, { id: 'forget-linked-record', at: '2026-10-20T04:00:00Z' });
assert.equal(file.links?.length, 0); assert.equal(file.linkHistory?.length, 0);
pass('withdrawn-source links become visible invalid references rather than false connections; explicit repair works and permanent forgetting removes related link history');

const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), originalFetch = globalThis.fetch;
let writes = 0, scope = 'synthetic-private-root';
file = cognitionManagementFixture();
const syntheticWindow = Object.assign(new EventTarget(), { location: { origin: 'http://synthetic' }, electronAPI: { userState: {
  getAgentTaskScope: async () => scope, loadCognition: async () => structuredClone(file),
  mutateCognition: async (input: any) => { assert.equal(input.storageScopeId, scope); const next = applyCognitionMutation(file, input, { id: `saved-${++sequence}`, at: '2026-10-20T04:00:00Z' }); file = next; writes++; return structuredClone(next); },
} } });
Object.defineProperty(globalThis, 'window', { configurable: true, value: syntheticWindow });
globalThis.fetch = async () => assert.fail('No network in cognition editing tests');
const ctx = { getNotes: () => [], getActiveNote: () => null, getResourceDraftSession: () => null, getPlanDraftSession: () => null,
  hasPendingPlanEditorDraft: () => false, ensureDataFresh: async () => {}, getAgentExecutionMode: () => 'deep' } as unknown as AgentRuntimeContext;
try {
  registerCognitionTools();
  assert.equal(toolRequiresApproval({ ...getTool('commit_cognition_change')!, isPreauthorized: () => true }, {}, ctx), true);
  const update = (): Extract<CognitionGraphEdit, { action: 'update_node' }> => {
    const conditions = latestCognition(file.records[0]).branches[0].graph.nodes.find(node => node.id === 'c')?.conditions;
    return { action: 'update_node', target: reference('mental', 'c'), text: '只有分类边界固定时心理账户才限制消费决策。', mainType: '推理', stance: 'endorsed', operation: conditions?.length ? 'revise' : 'add_conditions', reason: '用户要求补充适用条件',
      meaning: { interpretation: '为指定认知补充并保留分类边界条件，其他主张不变', preserved: [], ...(conditions?.length ? {} : { conditions: { before: [], changes: [{ kind: 'add', after: '分类边界固定' }] } }) } };
  };
  const prepared = await prepareCognitionChange(update());
  assert.equal(writes, 0); assert.equal(prepared.saved, false);
  const denied = await executeTool('commit_cognition_change', { proposalId: prepared.proposalId, confirmed: true }, ctx, { cognitionContext: true });
  assert.equal(denied.ok, false); assert.equal(writes, 0);
  assert.equal((await executeTool('query_cognition', { query: '心理账户' }, ctx)).ok, true, 'read-only browsing is available without write-management context');
  assert.equal((await executeTool('prepare_cognition_change', { edit: update() }, ctx)).ok, false, 'free browsing does not grant mutation preparation');
  assert.equal(selectAgentSkill('帮我找到这个认知并调整')?.id, 'cognition-management');
  assert.notEqual(selectAgentSkill('我现在意识到不是这样，只在某些条件下发生')?.id, 'cognition-management');
  pass('ordinary chat has no mutation, preview has no write, and model confirmation fields or persistent/automatic authorization cannot bypass the commit guard');

  async function pendingTurn() {
    let calls = 0;
    return runAgentTurn({ role: AGENT_ROLES.default, userText: '帮我找到这个认知并调整，补上刚才说的条件', history: [
      { role: 'user', content: '刚才说我的心理账户会限制消费决策。' }, { role: 'assistant', content: '你在讨论心理账户分类带来的影响。' },
      { role: 'user', content: '我现在意识到不是一直这样，只有分类边界固定时才出现。' },
    ], ctx, memoryPrefixLoader: async () => '',
      callLlm: async (request: LlmCallRequest) => {
        if (request.workflow === 'agent-intent-routing') return { content: '', parsedJson: { skillId: 'cognition-management', confidence: .99, standaloneRequest: '查找心理账户限制消费决策的个人认知，补充只有分类边界固定时才出现的条件', referenceResolution: 'resolved' } };
        assert.equal(request.workflow, 'agent-chat'); calls++;
        if (calls === 1) return { content: '', toolCalls: [{ id: 'lookup', name: 'query_cognition', arguments: { target: reference('mental', 'c') } }] };
        if (calls === 2) return { content: '', toolCalls: [{ id: 'prepare', name: 'prepare_cognition_change', arguments: { edit: update() } }] };
        const raw = request.agentMessages!.findLast(message => message.role === 'tool' && message.toolName === 'prepare_cognition_change');
        const result = JSON.parse(raw!.content).result;
        return { content: '', toolCalls: [{ id: 'commit', name: 'commit_cognition_change', arguments: { proposalId: result.proposalId } }] };
      } });
  }
  let turn = await pendingTurn(); assert.ok(turn.pendingApproval); assert.equal(writes, 0);
  assert.equal(turn.activeSkill?.id, 'cognition-management');
  assert.match(turn.pendingApproval.items[0].impacts!.join('\n'), /修改前：[\s\S]*修改后：[\s\S]*条件/);
  const tampered = structuredClone(turn.pendingApproval); tampered.items[0].call.arguments.proposalId = prepared.proposalId;
  await assert.rejects(resolveAgentApproval({ role: AGENT_ROLES.default, approval: tampered, approved: true, history: turn.updatedHistory, ctx, callLlm: async () => assert.fail('Tampered approval must stop') }), /变化/);
  assert.equal(writes, 0);
  const clipped = structuredClone(turn.pendingApproval); clipped.items[0].impacts = ['已省略修改细节'];
  await assert.rejects(resolveAgentApproval({ role: AGENT_ROLES.default, approval: clipped, approved: true, history: turn.updatedHistory, ctx, callLlm: async () => assert.fail('Clipped preview must stop') }), /展示内容已变化或被截断/);
  assert.equal(writes, 0);
  await resolveAgentApproval({ role: AGENT_ROLES.default, approval: turn.pendingApproval, approved: false, history: turn.updatedHistory, ctx, callLlm: async () => assert.fail('Cancel must not call model') });
  assert.equal(writes, 0);
  turn = await pendingTurn();
  const result = await resolveAgentApproval({ role: AGENT_ROLES.default, approval: turn.pendingApproval!, approved: true, history: turn.updatedHistory, ctx, callLlm: async () => ({ content: '已补充指定条件，其他认知未改。' }) });
  assert.equal(writes, 1); assert.ok(result.toolTrace.some(step => step.call.name === 'commit_cognition_change' && step.ok));
  assert.equal(latestCognition(file.records[0]).authorship, 'adopted_with_assistance');
  assert.equal(latestCognition(file.records[0]).branches[0].graph.nodes.find(n => n.id === 'c')?.text, update().text);
  pass('actual Agent lookup → precise read → preview → bound approval card → cancel/approve execution; only confirmed content is written once');

  turn = await pendingTurn();
  file = applyCognitionMutation(file, { kind: 'edit_graph', confirmed: true, expectedRevision: file.revision, edit: { action: 'add_node', title: '并发改动', text: '另一个窗口的新观点。', mainType: '假设', stance: 'tentative', reason: '测试并发' } }, { id: 'other-window', at: '2026-10-20T05:00:00Z' });
  await assert.rejects(resolveAgentApproval({ role: AGENT_ROLES.default, approval: turn.pendingApproval!, approved: true, history: turn.updatedHistory, ctx, callLlm: async () => assert.fail('Stale approval must stop') }), /版本已变化/);
  assert.equal(writes, 1);
  const scoped = await prepareCognitionChange(update()); scope = 'different-root';
  assert.equal((await executeTool('commit_cognition_change', { proposalId: scoped.proposalId }, ctx, { userApproved: true, cognitionContext: true })).ok, false);
  assert.equal(writes, 1);
  pass('changed versions and changed private roots invalidate existing approvals without rebasing, retries, or writes');
  scope = 'synthetic-private-root';
  const discussion = await runAgentTurn({ role: AGENT_ROLES.default, userText: '我现在意识到不是一直这样，只有某些条件下才出现。', history: [], ctx, memoryPrefixLoader: async () => '', callLlm: async request => request.workflow === 'agent-intent-routing'
    ? { content: '', parsedJson: { skillId: 'general', confidence: .99, referenceResolution: 'none' } } : { content: '这是对适用条件的新理解，当前没有修改认知库。' } });
  assert.equal(writes, 1); assert.equal(discussion.pendingApproval, undefined);
  const ambiguous = await runAgentTurn({ role: AGENT_ROLES.default, userText: '帮我把这个认知调整一下', history: [{ role: 'user', content: '我们同时谈到了心理账户和心流。' }], ctx, memoryPrefixLoader: async () => '', callLlm: async request => request.workflow === 'agent-intent-routing'
    ? { content: '', parsedJson: { skillId: 'cognition-management', confidence: .99, referenceResolution: 'ambiguous' } } : { content: '你指心理账户还是心流这项认识？' } });
  assert.equal(writes, 1); assert.equal(ambiguous.toolTrace.length, 0);
  pass('semantic conversation routing resolves the correction topic; ordinary new insights do not mutate storage and ambiguous references stop for clarification');
} finally {
  globalThis.fetch = originalFetch;
  if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window');
}
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-cognition-editing-'));
try {
  let stored: CognitionFile = await loadCognition(directory);
  for (const record of cognitionManagementFixture().records) {
    const graph = latestCognition(record).branches[0].graph;
    stored = await mutateCognition(directory, { kind: 'confirm', confirmed: true, operation: 'initial', reason: '', expectedRevision: stored.revision, stance: 'endorsed', authorship: 'own_expression', doc: { ...graph, doc_id: record.id } });
  }
  stored = await mutateCognition(directory, { kind: 'edit_graph', confirmed: true, expectedRevision: stored.revision, edit: { action: 'add_relation', source: reference('mental', 'c', stored), target: reference('flow', 'p', stored), relation: 'relates', reason: '测试显式跨活动关联' } });
  assert.equal((await loadCognition(directory)).links?.length, 1);
  const target = reference('mental', 'c', stored), revision = stored.revision;
  const writes = await Promise.allSettled([
    mutateCognition(directory, { kind: 'edit_graph', confirmed: true, expectedRevision: revision, edit: { action: 'delete_node', target, reason: '并发删除' } }),
    mutateCognition(directory, { kind: 'edit_graph', confirmed: true, expectedRevision: revision, edit: { action: 'update_node', target, text: '我限定了这个观点的条件。', mainType: '推理', stance: 'endorsed', operation: 'qualify', reason: '并发编辑' } }),
  ]);
  assert.equal(writes.filter(result => result.status === 'fulfilled').length, 1);
  parseCognitionFile(await loadCognition(directory));
  pass('native atomic private-file persistence retains new links/history and rejects one of two concurrent stale graph writes');
} finally { assert.ok(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep)); await fs.rm(directory, { recursive: true, force: true }); }
console.log(`Cognition editing: ${checks} groups passed; actual domain/Agent approval paths, synthetic private state only.`);
