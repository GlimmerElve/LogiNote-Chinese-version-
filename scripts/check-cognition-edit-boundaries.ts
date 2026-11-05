import assert from 'node:assert/strict';
import { applyCognitionMutation, emptyCognitionFile, latestCognition } from '../src/services/cognition/core';
import { buildCognitionManagement } from '../src/services/cognition/management';
import { previewCognitionGraphEdit } from '../src/services/cognition/editing';
import { prepareCognitionChange } from '../src/services/cognition/changeProposals';
import { registerCognitionTools } from '../src/services/agent/tools/cognitionTools';
import { executeTool } from '../src/services/agent/toolRegistry';
import type { CognitionFile, CognitionGraphEdit } from '../src/services/cognition/types';
import type { AgentRuntimeContext } from '../src/services/agent/types';

let sequence = 0, checks = 0;
const stamp = () => ({ id: `boundary-${++sequence}`, at: '2026-10-20T00:00:00Z' });
const pass = (label: string) => { checks++; console.log(`PASS ${label}`); };
const ref = (file: CognitionFile, recordId: string, nodeId: string) => ({ recordId, nodeId, branchId: 'primary', revisionId: latestCognition(file.records.find(record => record.id === recordId)!).id });
const edit = (file: CognitionFile, change: CognitionGraphEdit) => applyCognitionMutation(file, { kind: 'edit_graph', confirmed: true, expectedRevision: file.revision, edit: change }, stamp());
const initial = (file: CognitionFile, id: string, nodes: Array<{ id: string; text: string; mainType: '假设' | '推理' }>, edges: Array<{ id: string; source: string; target: string; relation: 'support' }>) => applyCognitionMutation(file, {
  kind: 'confirm', confirmed: true, expectedRevision: file.revision, operation: 'initial', reason: '', stance: 'endorsed', authorship: 'own_expression', doc: { doc_id: id, title: id, nodes, edges },
}, stamp());
const chain = initial(emptyCognitionFile(), 'chain', [
  { id: 'p', text: '前提。', mainType: '假设' }, { id: 'c', text: '中间结论。', mainType: '推理' },
  { id: 'd', text: '下游结论。', mainType: '推理' }, { id: 'x', text: '新条件或证据。', mainType: '假设' },
], [{ id: 'pc', source: 'p', target: 'c', relation: 'support' }, { id: 'cd', source: 'c', target: 'd', relation: 'support' }]);
const flags = (file: CognitionFile, recordId: string) => latestCognition(file.records.find(record => record.id === recordId)!).branches[0].reviewNeededNodeIds || [];
for (const relation of ['support', 'oppose', 'limits', 'exception', 'context', 'method_for', 'relates'] as const) {
  const change: CognitionGraphEdit = { action: 'add_relation', source: ref(chain, 'chain', 'x'), target: ref(chain, 'chain', 'c'), relation, reason: '用户明确新增此关系' };
  const changed = edit(chain, change);
  assert.deepEqual(new Set(flags(changed, 'chain')), new Set(['c', 'd']), relation);
  assert.deepEqual(changed.records[0].revisions[0], chain.records[0].revisions[0], 'old snapshots remain immutable');
  assert.deepEqual(latestCognition(changed.records[0]).branches[0].graph.nodes, latestCognition(chain.records[0]).branches[0].graph.nodes);
  assert.match(previewCognitionGraphEdit(chain, change).lines.join('\n'), /待复核节点：0 → 2/);
}
pass('every explicit same-graph relation addition marks its target and downstream, without changing beliefs, stance or old versions');

let moved = edit(chain, { action: 'add_relation', source: ref(chain, 'chain', 'x'), target: ref(chain, 'chain', 'c'), relation: 'limits', reason: '旧限制' });
const oldRelation = latestCognition(moved.records[0]).branches[0].graph.edges.find(edge => edge.relation === 'limits')!;
latestCognition(moved.records[0]).branches[0].reviewNeededNodeIds = [];
moved = edit(moved, { action: 'update_relation', edge: { recordId: 'chain', branchId: 'primary', revisionId: latestCognition(moved.records[0]).id, edgeId: oldRelation.id },
  source: ref(moved, 'chain', 'x'), target: ref(moved, 'chain', 'p'), relation: 'exception', reason: '用户将关系重新指向前提' });
assert.deepEqual(new Set(flags(moved, 'chain')), new Set(['p', 'c', 'd']));
pass('retargeting a local relation reviews the old target, the new target and their affected conclusions');

let linked = initial(chain, 'remote', [{ id: 'q', text: '另一活动的结论。', mainType: '推理' }, { id: 'r', text: '更下游的认识。', mainType: '推理' }], [{ id: 'qr', source: 'q', target: 'r', relation: 'support' }]);
linked = edit(linked, { action: 'add_relation', source: ref(linked, 'chain', 'd'), target: ref(linked, 'remote', 'q'), relation: 'support', reason: '明确的跨活动依赖' });
linked = edit(linked, { action: 'add_relation', source: ref(linked, 'remote', 'r'), target: ref(linked, 'chain', 'c'), relation: 'relates', reason: '保留循环关联' });
for (const alreadyFlagged of [false, true]) {
  const before = structuredClone(linked);
  for (const record of before.records) latestCognition(record).branches[0].reviewNeededNodeIds = record.id === 'chain' && alreadyFlagged ? ['c', 'd'] : [];
  const frozen = structuredClone(before);
  const after = edit(before, { action: 'add_relation', source: ref(before, 'chain', 'x'), target: ref(before, 'chain', 'c'), relation: 'limits', reason: '循环依赖中的新限制' });
  assert.deepEqual(new Set(flags(after, 'chain')), new Set(['c', 'd']));
  assert.deepEqual(new Set(flags(after, 'remote')), new Set(['q', 'r']));
  for (const record of frozen.records) assert.deepEqual(after.records.find(row => row.id === record.id)!.revisions.slice(0, record.revisions.length), record.revisions);
  assert.equal(buildCognitionManagement(after).summary.needsReview, 4);
}
pass('local relation changes propagate across existing cross-activity dependencies and cycles, even when the local target was already flagged');

const conditions = Array.from({ length: 40 }, (_, i) => `条件${i}：${'学'.repeat(450)}`);
const body = `${conditions.join('；')}时我倾向于接受该观点。`;
const corpus = initial(emptyCognitionFile(), 'long', Array.from({ length: 8 }, (_, i) => ({ id: `n${i}`, text: body, mainType: '假设' as const })), []);
for (const node of latestCognition(corpus.records[0]).branches[0].graph.nodes) node.conditions = [...conditions];
const corpusBefore = JSON.stringify(corpus), priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), priorFetch = globalThis.fetch;
Object.defineProperty(globalThis, 'window', { configurable: true, value: Object.assign(new EventTarget(), { location: { origin: 'http://synthetic' }, electronAPI: { userState: {
  loadCognition: async () => structuredClone(corpus), getAgentTaskScope: async () => 'synthetic-only', mutateCognition: async () => assert.fail('Read tests must not write'),
} } }) });
globalThis.fetch = async () => assert.fail('No network');
try {
  registerCognitionTools();
  const ctx = {} as AgentRuntimeContext;
  const candidates = await executeTool('query_cognition', { query: '条件' }, ctx, { cognitionContext: true });
  assert.equal(candidates.ok, true);
  const result = candidates.result as any;
  assert.equal(result.nodes.length, 8); assert.ok(JSON.stringify(result).length < 27000);
  for (const node of result.nodes) {
    assert.ok(node.text.length <= 1600); assert.ok(node.conditions.length <= 8);
    assert.ok(node.conditions.every((condition: string) => condition.length <= 160));
    assert.ok(node.conditions.reduce((sum: number, condition: string) => sum + condition.length, 0) <= 640);
    assert.equal(node.conditionsTotal, 40); assert.equal(node.conditionsTruncated, true); assert.equal(node.truncated, true);
  }
  const target = ref(corpus, 'long', 'n0');
  await assert.rejects(prepareCognitionChange({ action: 'update_node', target, mainType: '假设', stance: 'endorsed', operation: 'remove_conditions', reason: '节选不能冒充完整基线',
    text: `${conditions.slice(1).join('；')}时我倾向于接受该观点。`, meaning: { interpretation: '移除指定条件', preserved: [], conditions: { before: result.nodes[0].conditions, changes: [{ kind: 'remove', before: conditions[0] }] } },
  }), /原条件与当前节点不符/);
  const exact = await executeTool('query_cognition', { target, expectedRevision: corpus.revision }, ctx, { cognitionContext: true });
  assert.equal(exact.ok, true); const full = exact.result as any;
  assert.equal(full.nodes.length, 1); assert.equal(full.nodes[0].text, body); assert.deepEqual(full.nodes[0].conditions, conditions); assert.equal(full.nodes[0].truncated, false);
  const proposal = await prepareCognitionChange({ action: 'update_node', target, mainType: '假设', stance: 'endorsed', operation: 'remove_conditions', reason: '使用精确全文基线',
    text: `${conditions.slice(1).join('；')}时我倾向于接受该观点。`, meaning: { interpretation: '只移除第一项条件，保留其他 39 项', preserved: [], conditions: { before: full.nodes[0].conditions, changes: [{ kind: 'remove', before: conditions[0] }] } },
  });
  assert.equal(proposal.saved, false); assert.equal(proposal.requiresUserConfirmation, true);
  assert.equal(JSON.stringify(corpus), corpusBefore);
  pass(`actual candidate query is bounded (${JSON.stringify(result).length} characters), while exact current text/conditions remain complete and excerpts cannot be used as edit baselines`);
} finally {
  globalThis.fetch = priorFetch;
  if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window');
}
console.log(`Cognition edit boundaries: ${checks} groups passed; synthetic stores/tools only, no real model or user data.`);
