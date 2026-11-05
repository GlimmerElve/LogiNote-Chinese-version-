import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { cognitionManagementFixture } from './check-cognition-management';
import { CognitionAssistantSession } from '../src/services/agent/cognitionAssistantSession';
import { applyAgentTaskStatePatch, normalizeAgentTaskState } from '../src/services/agent/taskStateCodec';
import { saveAgentTaskState, flushAgentTaskStateWrites } from '../src/services/agent/taskStateClient';
import { executeApprovedToolBatch } from '../src/services/agent/toolRegistry';
import { applyCognitionMutation, latestCognition } from '../src/services/cognition/core';
import type { CognitionGraphEdit } from '../src/services/cognition/types';
import type { AgentLlmCaller } from '../src/services/agent/runtime/types';
import { mutateCognition, COGNITION_FILE_NAME } from '../src/electron/cognitionStore';

const deferred = () => { let resolve!: () => void; return { promise: new Promise<void>(done => { resolve = done; }), resolve: () => resolve() }; };
const tool = (id: string, name: string, args: Record<string, unknown>) => ({ id, name, arguments: args });
let file = cognitionManagementFixture(), tasks = normalizeAgentTaskState(null), writes = 0, mutationAttempts = 0, serial = 0, checks = 0;
let failSave = false, failLoad = false, loadCount = 0, holdRead: ReturnType<typeof deferred> | undefined, readStarted = deferred();
let holdSave: ReturnType<typeof deferred> | undefined, saveStarted = deferred(), beforeMutation: (() => void) | undefined;
const stamp = () => ({ id: `boundary-${++serial}`, at: '2026-10-21T08:00:00Z' });
const pass = (message: string) => { checks++; console.log(`PASS ${message}`); };
const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), priorFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { electronAPI: { userState: {
  getAgentTaskScope: async () => 'synthetic-boundary-root',
  loadAgentTaskState: async () => { loadCount++; if (failLoad) { failLoad = false; throw new Error('synthetic load failure'); } return { scopeId: 'synthetic-boundary-root', state: structuredClone(tasks) }; },
  saveAgentTaskState: async (_id: string, patch: any) => {
    if (holdSave) { const gate = holdSave; holdSave = undefined; saveStarted.resolve(); await gate.promise; }
    if (failSave) throw new Error('synthetic storage failure');
    tasks = applyAgentTaskStatePatch(tasks, patch);
  },
  loadCognition: async () => { if (holdRead) { const gate = holdRead; holdRead = undefined; readStarted.resolve(); await gate.promise; } return structuredClone(file); },
  mutateCognition: async (input: any) => {
    mutationAttempts++; beforeMutation?.();
    const next = applyCognitionMutation(file, input, stamp()); file = next; writes++; return structuredClone(file);
  },
} } }) });
globalThis.fetch = async () => assert.fail('No network, paid model or private vault');
const sessions: CognitionAssistantSession[] = [];
const session = (callLlm: AgentLlmCaller = async () => ({ content: 'synthetic reply' })) => {
  const agent = new CognitionAssistantSession({ callLlm }); sessions.push(agent); return agent;
};
try {
  const first = session(); await Promise.all([first.initialize(), first.initialize(), first.initialize()]); assert.equal(loadCount, 1);
  await first.send('original message'); const original = structuredClone(tasks.cognitionAssistant), visible = structuredClone(first.view().messages);
  failSave = true; await assert.rejects(first.clear(), /synthetic storage/);
  assert.deepEqual(first.view().messages, visible); assert.deepEqual(tasks.cognitionAssistant, original);
  assert.match(first.view().error, /原聊天已保留/);
  failSave = false; first.dispose(); const restored = session(); await restored.initialize();
  assert.deepEqual(restored.view().messages, original!.messages);
  await restored.clear(); assert.equal(restored.view().messages.length, 0); restored.dispose();
  const afterClear = session(); await afterClear.initialize(); assert.equal(afterClear.view().messages.length, 0); afterClear.dispose();
  pass('failed clear preserves visible and durable history; explicit retry clears both, restart never revives a successful clear; initialization is single-flight');

  failLoad = true; const retry = session(); await retry.initialize(); assert.equal(retry.view().ready, false);
  await retry.initialize(); assert.equal(retry.view().ready, true); assert.equal(retry.view().error, ''); retry.dispose();
  pass('reconnecting after a transient initialization failure clears stale errors without duplicate loads or replacing an active session');

  let round = 0;
  const old = session(async () => ++round === 1 ? { content: '', toolCalls: [tool('late-query', 'query_cognition', { filter: 'all' })] } : { content: 'must not be used' });
  await old.initialize(); const readGate = deferred(); holdRead = readGate; readStarted = deferred();
  const running = old.send('old in-flight message'); await readStarted.promise; old.dispose();
  const fresh = session(); await fresh.initialize(); await fresh.clear(); await fresh.send('new private conversation');
  const freshState = structuredClone(tasks.cognitionAssistant);
  readGate.resolve(); await running; await old.flush(); assert.deepEqual(tasks.cognitionAssistant, freshState); assert.equal(round, 1);
  fresh.dispose(); pass('a disposed session cannot publish/persist late query results or overwrite a newer cleared conversation');

  const queued = session(); await queued.initialize();
  const saveGate = deferred(); holdSave = saveGate; saveStarted = deferred();
  const blocker = saveAgentTaskState('synthetic-boundary-root', { kind: 'workflows', jobs: [] }); await saveStarted.promise;
  queued.ctx.observeCognitionRead!({ filter: 'all' }, { fileRevision: file.revision, nodes: [] });
  await Promise.resolve(); queued.dispose(); saveGate.resolve(); await blocker; await queued.flush();
  assert.deepEqual(tasks.cognitionAssistant, freshState); assert.deepEqual(tasks.workflows, []);
  pass('revocation is checked inside the shared write queue too; queued stale checkpoints cannot overwrite a newer category state');

  const confirmed = session(); await confirmed.initialize(); const inflightGate = deferred(); holdSave = inflightGate; saveStarted = deferred();
  const saving = confirmed.send('already-sent checkpoint'); await saveStarted.promise; confirmed.dispose();
  const reopened = session(); let initialized = false; const reopening = reopened.initialize().then(() => { initialized = true; });
  await Promise.resolve(); assert.equal(initialized, false); inflightGate.resolve(); await saving; await reopening;
  assert.equal(reopened.view().messages.at(-1)?.content, 'already-sent checkpoint'); reopened.dispose();
  pass('restoration drains an already-dispatched native write before reading, so it cannot race an older durable checkpoint');

  function editsFor(refs: Array<{ recordId: string; nodeId: string }>): CognitionGraphEdit[] {
    return refs.map(ref => {
      const record = file.records.find(record => record.id === ref.recordId)!, revision = latestCognition(record);
      const node = revision.branches[0].graph.nodes.find(node => node.id === ref.nodeId)!;
      return { action: 'update_node', target: { ...ref, branchId: 'primary', revisionId: revision.id },
        text: `${node.text}适用于合成证据充分的情境。`, mainType: node.mainType, stance: 'endorsed', operation: 'add_conditions', reason: '合成批量条件测试',
        meaning: { interpretation: '保留原文，新增合成条件', preserved: [node.text], conditions: { before: node.conditions || [], changes: [{ kind: 'add', after: '合成证据充分' }] } } };
    });
  }
  async function prepareBatch(edits: CognitionGraphEdit[]) {
    let step = 0;
    const agent = session(async request => {
      if (++step === 1) return { content: '', toolCalls: edits.map((edit, index) => tool(`read-${index}`, 'query_cognition', { target: 'target' in edit ? edit.target : undefined })) };
      if (step === 2) return { content: '', toolCalls: edits.map((edit, index) => tool(`preview-${index}`, 'prepare_cognition_change', { edit })) };
      if (step === 3) {
        const previews = request.agentMessages!.filter(message => message.role === 'tool' && message.toolName === 'prepare_cognition_change').slice(-edits.length).map(message => JSON.parse(message.content));
        assert.ok(previews.every(result => result.ok));
        return { content: '', toolCalls: previews.map((preview, index) => tool(`commit-${index}`, 'commit_cognition_change', { proposalId: preview.result.proposalId })) };
      }
      return { content: 'synthetic completion' };
    });
    await agent.initialize(); await agent.send('分别给这些认识新增适用条件'); assert.equal(agent.view().pending?.items.length, edits.length, agent.view().error);
    return agent;
  }
  for (const refs of [[{ recordId: 'mental', nodeId: 'p' }, { recordId: 'mental', nodeId: 'c' }], [{ recordId: 'mental', nodeId: 'p' }, { recordId: 'flow', nodeId: 'p' }]]) {
    file = cognitionManagementFixture(); tasks = normalizeAgentTaskState(null); writes = 0; mutationAttempts = 0;
    const before = file.revision, agent = await prepareBatch(editsFor(refs)); await agent.approve(true);
    assert.equal(writes, 1); assert.equal(mutationAttempts, 1); assert.equal(file.revision, before + 1); assert.equal(agent.view().error, '');
    for (const ref of refs) assert.deepEqual(latestCognition(file.records.find(record => record.id === ref.recordId)!).branches[0].graph.nodes.find(node => node.id === ref.nodeId)!.conditions, ['合成证据充分']);
    assert.match(agent.view().messages.at(-1)!.content, /已按你确认/); agent.dispose();
  }
  pass('two separately bound confirmations commit atomically in ONE mutation/revision, including distinct nodes in the same activity and cross-activity edits');

  file = cognitionManagementFixture(); tasks = normalizeAgentTaskState(null); writes = 0;
  const duplicate = editsFor([{ recordId: 'mental', nodeId: 'p' }, { recordId: 'mental', nodeId: 'p' }]);
  const conflicting = await prepareBatch(duplicate), unchanged = structuredClone(file);
  await conflicting.approve(true); assert.equal(writes, 0); assert.deepEqual(file, unchanged); assert.match(conflicting.view().messages.at(-1)!.content, /未保存/); conflicting.dispose();
  pass('mutually affecting edits reject the whole batch in memory, without partial storage or silently changing a confirmed baseline');

  const refs = [{ recordId: 'mental', nodeId: 'p' }, { recordId: 'flow', nodeId: 'p' }];
  tasks = normalizeAgentTaskState(null); const cancelled = await prepareBatch(editsFor(refs)); await cancelled.approve(false); assert.equal(writes, 0); cancelled.dispose();
  const stale = await prepareBatch(editsFor(refs));
  beforeMutation = () => { beforeMutation = undefined; file = applyCognitionMutation(file, { kind: 'edit_graph', confirmed: true, expectedRevision: file.revision,
    edit: { action: 'add_node', title: 'external', text: 'external synthetic change', mainType: '假设', stance: 'tentative', reason: 'CAS race' } }, stamp()); };
  await stale.approve(true); assert.equal(writes, 0); assert.equal(file.records.length, 4);
  for (const ref of refs) assert.equal(latestCognition(file.records.find(record => record.id === ref.recordId)!).branches[0].graph.nodes.find(node => node.id === ref.nodeId)!.conditions, undefined);
  stale.dispose(); pass('cancelling a batch writes nothing; a concurrent change at the store CAS rejects every item and preserves the other writer');

  const ctx = session().ctx;
  assert.equal((await executeApprovedToolBatch('commit_cognition_change', [], ctx, {})).ok, false);
  assert.equal((await executeApprovedToolBatch('commit_cognition_change', [], ctx, { userApproved: true })).ok, false);
  pass('the new internal batch path still rejects missing explicit approval and wrong cognition context; no model-visible tools or permissions were added');

  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-cognition-batch-'));
  try {
    file = cognitionManagementFixture(); const edits = editsFor(refs), baseline = JSON.stringify(file), target = path.join(directory, COGNITION_FILE_NAME);
    await fs.writeFile(target, baseline, 'utf8');
    const invalid = structuredClone(edits); if (invalid[1].action === 'update_node') invalid[1].target.revisionId = 'stale';
    await assert.rejects(mutateCognition(directory, { kind: 'edit_graph_batch', expectedRevision: file.revision, confirmed: true, authorship: 'adopted_with_assistance', edits: invalid }), /变化/);
    assert.equal(await fs.readFile(target, 'utf8'), baseline, 'invalid second entry cannot change even the file bytes');
    const mutation = { kind: 'edit_graph_batch', expectedRevision: file.revision, confirmed: true, authorship: 'adopted_with_assistance', edits };
    const results = await Promise.allSettled([mutateCognition(directory, mutation), mutateCognition(directory, mutation)]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const saved = JSON.parse(await fs.readFile(target, 'utf8')); assert.equal(saved.revision, file.revision + 1);
    for (const ref of refs) assert.deepEqual(latestCognition(saved.records.find((record: any) => record.id === ref.recordId)).branches[0].graph.nodes.find(node => node.id === ref.nodeId)!.conditions, ['合成证据充分']);
  } finally {
    if (path.dirname(path.resolve(directory)) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('loginote-cognition-batch-')) throw new Error('Synthetic cleanup path escaped temporary directory');
    await fs.rm(directory, { recursive: true, force: true });
  }
  pass('actual native file transaction rejects an invalid batch without changing bytes, and concurrent batches yield exactly one complete CAS commit');
  await flushAgentTaskStateWrites();
} finally {
  sessions.forEach(agent => agent.dispose()); globalThis.fetch = priorFetch;
  if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window');
}
console.log(`Cognition assistant boundaries: ${checks} groups passed; synthetic state/model transports only.`);
