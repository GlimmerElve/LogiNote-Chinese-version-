import assert from 'node:assert/strict';
import { cognitionManagementFixture } from './check-cognition-management';
import { applyCognitionMutation, latestCognition } from '../src/services/cognition/core';
import { buildCognitionManagement } from '../src/services/cognition/management';
import { registerCognitionTools } from '../src/services/agent/tools/cognitionTools';
import { executeTool, getTool, listToolsForRole, toolRequiresApproval } from '../src/services/agent/toolRegistry';
import { AGENT_ROLES, runAgentTurn } from '../src/services/agent/agentEngine';
import { applyAgentSkill, getAgentSkill, selectAgentSkill } from '../src/services/agent/skillRegistry';
import { isCognitionTopologyRequest } from '../src/services/agent/cognitionReadPolicy';
import type { AgentRuntimeContext } from '../src/services/agent/types';

let file = cognitionManagementFixture(), serial = 0, writes = 0, checks = 0;
const pass = (text: string) => { checks++; console.log(`PASS ${text}`); };
const stamp = () => ({ id: `browse-${++serial}`, at: '2026-10-21T00:00:00Z' });
const ref = (recordId: string, nodeId: string) => ({ recordId, branchId: 'primary', nodeId, revisionId: latestCognition(file.records.find(record => record.id === recordId)!).id });
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), originalFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { electronAPI: { userState: {
  getAgentTaskScope: async () => 'synthetic-browsing-scope', loadCognition: async () => structuredClone(file),
  mutateCognition: async () => { writes++; assert.fail('Browsing cannot write cognition'); },
} } }) });
globalThis.fetch = async () => assert.fail('No network/model/cloud/vault access in this test');
const ctx = { getNotes: () => [], getActiveNote: () => null, ensureDataFresh: async () => {}, getPlanDraftSession: () => null,
  getResourceDraftSession: () => null, hasPendingPlanEditorDraft: () => false, getAgentExecutionMode: () => 'deep' } as unknown as AgentRuntimeContext;
async function read(args: Record<string, unknown> = {}) {
  const result = await executeTool('query_cognition', args, ctx); assert.equal(result.ok, true, result.error);
  const value = result.result as any; assert.ok(JSON.stringify(value).length <= value.responseLimitChars); return value;
}
try {
  registerCognitionTools();
  const frozen = structuredClone(file);
  assert.equal(getTool('query_cognition')!.requiresCognitionContext, undefined);
  assert.equal(toolRequiresApproval(getTool('query_cognition')!, {}, ctx), false);
  assert.ok(listToolsForRole(AGENT_ROLES.default).some(tool => tool.name === 'query_cognition'));
  assert.ok(applyAgentSkill(AGENT_ROLES.default, getAgentSkill('personalized-qa')!).allowedTools.includes('query_cognition'));
  assert.ok(!applyAgentSkill({ ...AGENT_ROLES.default, allowedTools: [], skillToolCeiling: [] }, getAgentSkill('personalized-qa')!).allowedTools.includes('query_cognition'), 'never widen a restricted role ceiling');
  const all = await read(); assert.equal(all.totalMatches, 6); assert.equal(all.nodes.length, 6);
  const isolated = await read({ filter: 'isolated' });
  assert.equal(isolated.totalMatches, 1); assert.equal(isolated.nodes[0].recordId, 'lone'); assert.equal(isolated.nodes[0].degree, 0);
  assert.equal(isolated.graphSummary.nodes, 6); assert.equal(isolated.edges.length, 0);
  assert.equal((await read({ filter: 'isolated', query: '心理账户' })).totalMatches, 0);
  assert.equal((await read({ filter: 'tentative' })).nodes[0].nodeId, 'o');
  assert.deepEqual(file, frozen); assert.equal(writes, 0);
  pass('general Agent and skill paths expose ceiling-bounded read-only browsing; global/isolated/stance filters need no note or theme and never mutate');

  file = applyCognitionMutation(file, { kind: 'edit_graph', confirmed: true, expectedRevision: file.revision, edit: {
    action: 'add_relation', source: ref('mental', 'p'), target: ref('flow', 'p'), relation: 'context', reason: '合成跨活动背景关系，不是支持或因果' } }, stamp());
  const cross = await read({ filter: 'cross-activity' });
  assert.equal(cross.totalMatches, 2); assert.equal(cross.edges.length, 1); assert.equal(cross.edges[0].relation, 'context');
  assert.ok(cross.edges[0].reference.linkId);
  const reason = await read({ edge: cross.edges[0].reference, expectedRevision: file.revision });
  assert.equal(reason.edges[0].reason, '合成跨活动背景关系，不是支持或因果');
  const review = await read({ filter: 'review' });
  assert.ok(review.totalMatches > 0); assert.ok(review.nodes.every((node: any) => node.needsReview));
  assert.equal(review.totalMatches, buildCognitionManagement(file).summary.needsReview);
  file.records.find(record => record.id === 'mental')!.withdrawn = true;
  const broken = await read({ filter: 'broken' }); assert.equal(broken.nodes.length, 1); assert.equal(broken.nodes[0].recordId, 'flow');
  assert.equal(broken.brokenEdgeTotal, 1); assert.equal(broken.brokenEdges[0].reference.linkId, cross.edges[0].reference.linkId);
  assert.equal((await read({ filter: 'cross-activity' })).totalMatches, 0);
  assert.equal((await read({ target: ref('flow', 'p') })).nodes[0].truncated, false);
  pass('cross-activity filters retain real directions/types/references, review flags match the manager, withdrawn endpoints become broken references rather than fabricated links');

  file = cognitionManagementFixture();
  for (let index = 0; index < 14; index++) file = applyCognitionMutation(file, { kind: 'edit_graph', confirmed: true, expectedRevision: file.revision,
    edit: { action: 'add_node', title: `独立${index}`, text: `合成孤立观点${index}`, mainType: '假设', stance: 'tentative', reason: '分页样例' } }, stamp());
  const nodes = new Set<string>(); let offset = 0;
  for (let page = 0; page < 10; page++) {
    const result = await read({ filter: 'isolated', offset, expectedRevision: file.revision });
    assert.equal(result.totalMatches, 15);
    for (const node of result.nodes) { assert.equal(node.degree, 0); assert.ok(!nodes.has(node.id)); nodes.add(node.id); }
    if (result.nextOffset === undefined) break;
    assert.ok(result.nextOffset > offset); offset = result.nextOffset;
  }
  assert.equal(nodes.size, 15);
  for (const args of [{ filter: 'made-up' }, { offset: -1 }, { expectedRevision: file.revision - 1 }, { target: ref('flow', 'p'), filter: 'isolated' }])
    assert.equal((await executeTool('query_cognition', args, ctx)).ok, false);
  pass('snapshot-bound pagination reaches all isolated nodes with no duplicates and fails closed on invalid filters, stale revisions and mixed exact/filter modes');

  for (const question of ['有哪些孤立节点', '看看认知库全部节点', '列出跨活动连线', '检查断链', '有哪些待复核节点']) {
    assert.equal(isCognitionTopologyRequest(question), true, question);
    assert.equal(selectAgentSkill(question, 'personalized-qa'), undefined, question);
  }
  assert.equal(isCognitionTopologyRequest('图论中的孤立节点是什么意思？'), false);
  assert.equal(selectAgentSkill('帮我找到这个认知并调整')?.id, 'cognition-management');
  const history = [{ role: 'user' as const, content: '我们刚才在谈心理账户。' },
    { role: 'assistant' as const, content: '我只能按主题查询，不能列出全库孤立节点；请先给我一个主题或节点名。' }];
  for (const routedSkill of ['general', 'personalized-qa']) {
    let calls = 0;
    const result = await runAgentTurn({ role: AGENT_ROLES.default, userText: '有哪些孤立节点', history, ctx,
      preferredSkillId: 'personalized-qa', requestedSkillId: 'personalized-qa', memoryPrefixLoader: async () => '',
      callLlm: async request => {
        if (request.workflow === 'agent-intent-routing') {
          assert.match(request.systemPromptOverride!, /孤立节点/);
          return { content: '', parsedJson: { skillId: routedSkill, confidence: .99, standaloneRequest: '列出认知库中全部孤立节点', referenceResolution: 'none' } };
        }
        assert.equal(request.workflow, 'agent-chat', 'structural browsing must not enter forced QA/inquiry');
        assert.ok(request.tools?.some(tool => tool.name === 'query_cognition'));
        assert.match(request.systemPromptOverride!, /不要求先选笔记或提供主题/);
        if (++calls === 1) return { content: '', toolCalls: [{ id: 'isolated-read', name: 'query_cognition', arguments: { filter: 'isolated' } }] };
        return { content: '当前筛选到15个孤立节点，本批读取8个，可以继续读取；孤立不等于错误。' };
      } });
    assert.equal(result.pendingApproval, undefined);
    assert.equal(result.activeSkill, undefined, 'structural inventory cannot be recorded as a learning-QA activity');
    assert.equal(result.toolTrace.filter(step => step.ok && step.call.name === 'query_cognition').length, 1);
    assert.ok(!result.toolTrace.some(step => ['retrieve_qa_evidence', 'read_cognition_page', 'commit_cognition_change'].includes(step.call.name)));
  }
  assert.equal((await executeTool('prepare_cognition_change', {}, ctx)).ok, false);
  assert.equal((await executeTool('commit_cognition_change', { proposalId: 'not-authorized' }, ctx, { cognitionContext: true })).ok, false);
  assert.equal(writes, 0);
  pass('actual Agent tool loop lists isolated nodes after QA and even if classifier chooses QA; no forced evidence workflow, mutation authorization or writes');
} finally {
  globalThis.fetch = originalFetch;
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow); else Reflect.deleteProperty(globalThis, 'window');
}
console.log(`Cognition browsing: ${checks} groups passed; actual tools + stub-model routing, synthetic state only (not a semantic accuracy evaluation).`);
