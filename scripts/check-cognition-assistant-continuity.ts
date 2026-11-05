import assert from 'node:assert/strict';
import { cognitionManagementFixture } from './check-cognition-management';
import { CognitionAssistantSession } from '../src/services/agent/cognitionAssistantSession';
import { emptyCognitionAssistantState, normalizeCognitionAssistantState } from '../src/services/agent/cognitionAssistantState';
import { applyAgentTaskStatePatch, normalizeAgentTaskState } from '../src/services/agent/taskStateCodec';
import { executeTool } from '../src/services/agent/toolRegistry';
import { cognitionChangePreview } from '../src/services/cognition/changeProposals';
import { applyCognitionMutation, emptyCognitionFile, latestCognition } from '../src/services/cognition/core';
import type { AgentLlmCaller } from '../src/services/agent/runtime/types';

let file = cognitionManagementFixture(), tasks = normalizeAgentTaskState(null), writes = 0, serial = 0, groups = 0;
let failReceiptWrite = false, failAfterMutation = false;
const deferred = () => { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; };
let holdRead: ReturnType<typeof deferred> | undefined, startedRead = deferred();
const stamp = () => ({ id: `continuity-${++serial}`, at: '2026-10-21T10:00:00Z' });
const pass = (label: string) => { groups++; console.log(`PASS ${label}`); };
const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), priorFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { electronAPI: { userState: {
  getAgentTaskScope: async () => 'synthetic-continuity-root',
  loadAgentTaskState: async () => ({ scopeId: 'synthetic-continuity-root', state: structuredClone(tasks) }),
  saveAgentTaskState: async (_scope: string, patch: any) => {
    if (failReceiptWrite) { failReceiptWrite = false; throw new Error('synthetic receipt storage failure'); }
    tasks = applyAgentTaskStatePatch(tasks, patch);
  },
  loadCognition: async () => { if (holdRead) { const gate = holdRead; holdRead = undefined; startedRead.resolve(); await gate.promise; } return structuredClone(file); },
  mutateCognition: async (input: unknown) => { file = applyCognitionMutation(file, input, stamp()); writes++; if (failAfterMutation) { failAfterMutation = false; failReceiptWrite = true; } return structuredClone(file); },
} } }) });
globalThis.fetch = async () => assert.fail('No live model/network/private vault');
const sessions: CognitionAssistantSession[] = [];
const session = (callLlm: AgentLlmCaller = async () => ({ content: 'synthetic discussion' })) => {
  const agent = new CognitionAssistantSession({ callLlm }); sessions.push(agent); return agent;
};
const call = (name: string, args: Record<string, unknown>) => ({ content: '', toolCalls: [{ id: `call-${++serial}`, name, arguments: args }] });
const lastResult = (request: Parameters<AgentLlmCaller>[0], name: string) => JSON.parse(request.agentMessages!.findLast(message => message.role === 'tool' && message.toolName === name)!.content);
const add = { action: 'add_node', title: 'synthetic belief', text: 'synthetic proposition', mainType: '假设', stance: 'tentative', reason: 'user requested preview', meaning: { interpretation: '新增这项暂定认识', preserved: [] } };
async function read(agent: CognitionAssistantSession, args: Record<string, unknown>) {
  const result = await executeTool('query_cognition', args, agent.ctx); assert.equal(result.ok, true, result.error); return result.result as any;
}
try {
  file = applyCognitionMutation(emptyCognitionFile(), { kind: 'confirm', expectedRevision: 0, confirmed: true, operation: 'initial', reason: '', authorship: 'own_expression', stance: 'endorsed',
    doc: { doc_id: 'star', title: 'synthetic star', nodes: Array.from({ length: 121 }, (_, index) => ({ id: `n${index}`, text: `synthetic proposition ${index}`, mainType: '事实陈述' })),
      edges: Array.from({ length: 120 }, (_, index) => ({ id: `e${index}`, source: 'n0', target: `n${index + 1}`, relation: 'support' })) } }, stamp());
  const target = { recordId: 'star', branchId: 'primary', nodeId: 'n0', revisionId: latestCognition(file.records[0]).id };
  let agent = session(); await agent.initialize();
  const first = await read(agent, { target, relationsOnly: true }); assert.equal(first.edges.length, 100); assert.equal(first.nextEdgeOffset, 100);
  assert.equal(agent.view().work.query, undefined); assert.equal(agent.view().work.relations!.nextEdgeOffset, 100);
  await agent.flush(); agent.dispose(); agent = session(); await agent.initialize();
  const second = await read(agent, { target, relationsOnly: true, edgeOffset: 100 }); assert.equal(second.edges.length, 20);
  assert.equal(new Set([...first.edges, ...second.edges].map(edge => edge.id)).size, 120);
  pass('exact target relations page through all 120 edges across restart without list-filter injection or a preexisting node query');

  await read(agent, { filter: 'all' }); const nodes = structuredClone(agent.view().work.candidates), nodeQuery = structuredClone(agent.view().work.query);
  await read(agent, { target, relationsOnly: true }); const implicit = await read(agent, { edgeOffset: 100 }); assert.equal(implicit.edges.length, 20);
  assert.deepEqual(agent.view().work.candidates, nodes); assert.deepEqual(agent.view().work.query, nodeQuery);
  await read(agent, { filter: 'all', offset: 8, relationsOnly: true });
  assert.equal(agent.view().work.relations!.offset, 8); assert.equal(agent.view().work.query!.offset, 0); assert.deepEqual(agent.view().work.candidates, nodes);
  const remainder = await read(agent, { edgeOffset: 1 }); assert.equal(remainder.edges.length, 7); assert.equal(agent.view().work.relations!.offset, 8);
  await agent.flush(); const stored = structuredClone(tasks.cognitionAssistant!.work); agent.dispose(); agent = session(); await agent.initialize();
  assert.deepEqual(agent.view().work, stored);
  await read(agent, { offset: 8 }); assert.equal(agent.view().work.query!.offset, 8); assert.equal(agent.view().work.candidates[0].number, 9);
  pass('node candidate page/numbering and relation page/offset remain independent through exact reads, relation-only paging, implicit continuation and restoration');

  await read(agent, { target, relationsOnly: true });
  assert.equal((await executeTool('query_cognition', { target: { ...target, nodeId: 'n1' }, edgeOffset: 100, relationsOnly: true }, agent.ctx)).ok, false);
  assert.equal((await executeTool('query_cognition', { target, edgeOffset: 100, relationsOnly: false }, agent.ctx)).ok, false);
  assert.equal((await executeTool('query_cognition', { target, edgeOffset: 100, relationsOnly: true, expectedRevision: file.revision + 1 }, agent.ctx)).ok, false);
  assert.equal((await executeTool('query_cognition', { target, offset: 8 }, agent.ctx)).ok, false);
  file = applyCognitionMutation(file, { kind: 'edit_graph', expectedRevision: file.revision, confirmed: true, edit: { ...add, action: 'add_node', mainType: '假设', stance: 'tentative' } }, stamp());
  assert.equal((await executeTool('query_cognition', { target, edgeOffset: 100, relationsOnly: true }, agent.ctx)).ok, false);
  await agent.flush(); agent.dispose(); agent = session(); await agent.initialize(); assert.equal(agent.view().work.relations, undefined); assert.equal(agent.view().work.query, undefined); agent.dispose();
  pass('changed targets, modes, versions and exact-node offsets fail closed; library changes invalidate both cursors together');

  const legacy = emptyCognitionAssistantState(); assert.deepEqual(normalizeCognitionAssistantState(legacy), legacy);
  const mixedLegacy = normalizeCognitionAssistantState({ ...legacy, messages: [{ role: 'user', content: '保留旧对话' }],
    work: { revision: file.revision, query: { ...nodeQuery, offset: 8 }, candidates: nodes } });
  assert.equal(mixedLegacy.work.query, undefined); assert.deepEqual(mixedLegacy.work.candidates, []); assert.equal(mixedLegacy.messages.length, 1);
  assert.throws(() => normalizeCognitionAssistantState({ ...legacy, work: { candidates: [], revision: 1, relations: { filter: 'all', offset: 8, edgeOffset: 0, brokenEdgeOffset: 0, target, relationsOnly: true } } }));
  assert.throws(() => normalizeCognitionAssistantState({ ...legacy, completions: [{ proposalId: 'bad', action: 'create_note', fileRevision: 1, at: 'now', request: '' }] }));
  pass('legacy sessions remain readable; malformed relation anchors and foreign/invalid completion receipts are rejected by the storage codec');

  async function prepare(final: AgentLlmCaller) {
    let round = 0;
    const agent = session(async request => {
      if (++round === 1) return call('prepare_cognition_change', { edit: add });
      if (round === 2) return call('commit_cognition_change', { proposalId: lastResult(request, 'prepare_cognition_change').result.proposalId });
      return final(request);
    });
    await agent.initialize(); await agent.send('新增这项认识'); assert.ok(agent.view().pending, agent.view().error); return agent;
  }
  for (const mode of ['failure', 'stop', 'receipt-storage'] as const) {
    file = cognitionManagementFixture(); tasks = normalizeAgentTaskState(null); writes = 0;
    const started = deferred(), release = deferred(); let summaryCalls = 0;
    const writer = await prepare(async () => {
      summaryCalls++; assert.equal(tasks.cognitionAssistant!.completions!.length, 1, 'completion receipt is durable BEFORE a summarization request');
      if (mode === 'failure') throw new Error('synthetic summary transport failure');
      started.resolve(); await release.promise; return { content: 'discard stopped summary' };
    });
    if (mode === 'receipt-storage') failAfterMutation = true;
    const running = writer.approve(true);
    if (mode === 'stop') { await started.promise; writer.stop(); release.resolve(); }
    await running; await writer.flush(); assert.equal(writes, 1); assert.equal(file.records.length, 4);
    assert.equal(tasks.cognitionAssistant!.completions!.length, 1); assert.match(writer.view().messages.at(-1)!.content, /保存1项/);
    if (mode === 'receipt-storage') assert.equal(summaryCalls, 0, 'do not proceed to the model after a failed receipt checkpoint');
    const receipt = structuredClone(tasks.cognitionAssistant!.completions![0]); writer.dispose();
    const restored = session(async request => {
      assert.ok(request.systemPromptOverride!.includes(receipt.proposalId)); assert.match(request.systemPromptOverride!, /不是当前编辑基线/);
      assert.deepEqual(request.tools!.map(tool => tool.name).sort(), ['commit_cognition_change', 'prepare_cognition_change', 'query_cognition']);
      return { content: '这项认识已经保存，先核对再继续，不重复新增。' };
    });
    await restored.initialize(); assert.match(restored.view().notice, /已保存/); assert.deepEqual(restored.ctx.getCognitionAssistantCompletions!(), [receipt]);
    await restored.send('刚才那项做完了吗'); assert.equal(writes, 1); await restored.clear(); assert.equal(tasks.cognitionAssistant!.completions, undefined); restored.dispose();
  }
  pass('successful writes survive failed/stopped summaries and a transient checkpoint failure with durable receipts, truthful restored dialogue and no replay/new permissions; clearing removes chat receipts only');

  file = cognitionManagementFixture(); tasks = normalizeAgentTaskState(null); writes = 0;
  let round = 0, lastPreview = '';
  const previewer = session(async request => {
    if (++round === 1) return call('prepare_cognition_change', { edit: add });
    const result = lastResult(request, 'prepare_cognition_change'); assert.equal(result.ok, true, result.error); lastPreview = result.result.proposalId;
    return { content: '只讨论预览，尚未修改。' };
  });
  await previewer.initialize();
  for (let index = 0; index < 40; index++) { round = 0; await previewer.send('先预览，不提交'); assert.equal(previewer.view().pending, null); assert.throws(() => cognitionChangePreview(lastPreview), /失效/); if (index % 10 === 0) await previewer.clear(); }
  assert.equal(writes, 0); previewer.dispose();
  pass('40 preview-only discussions release unsubmitted proposals each turn, including after clear, without hitting the unchanged 30-slot safety limit');

  const ownerA = await prepare(async () => ({ content: 'saved' })), proposalA = ownerA.view().pending!.items[0].call.arguments.proposalId;
  const ownerB = await prepare(async () => ({ content: 'saved' })), proposalB = ownerB.view().pending!.items[0].call.arguments.proposalId;
  assert.notEqual(ownerA.ctx.getCognitionProposalOwner!(), ownerB.ctx.getCognitionProposalOwner!());
  ownerA.dispose(); assert.throws(() => cognitionChangePreview(proposalA)); assert.ok(cognitionChangePreview(proposalB));
  await ownerB.approve(false); assert.throws(() => cognitionChangePreview(proposalB)); assert.equal(writes, 0); ownerB.dispose();
  pass('pending-card previews remain usable, while discard/cancel/dispose only release their own controller and cannot delete a replacement controller\'s approval');

  const stopped = session(async () => call('prepare_cognition_change', { edit: add })); await stopped.initialize();
  const readGate = deferred(); holdRead = readGate; startedRead = deferred(); const preparing = stopped.send('预览');
  await startedRead.promise; stopped.dispose(); readGate.resolve(); await preparing;
  // No proposal may be inserted after disposal, even though the native read finishes late.
  const survivor = await prepare(async () => ({ content: 'saved' })); assert.ok(survivor.view().pending); await survivor.approve(false); survivor.dispose();
  pass('late preview preparation honors cancellation before caching, and a stopped controller never creates an orphan that outlives its owner');
} finally {
  sessions.forEach(agent => agent.dispose()); globalThis.fetch = priorFetch;
  if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window');
}
console.log(`Cognition assistant continuity: ${groups} groups passed; actual controller/runtime/tools, synthetic storage/model transports only.`);
