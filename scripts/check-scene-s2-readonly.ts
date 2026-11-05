import assert from 'node:assert/strict';
import type { S2Document } from '../src/types/sceneS2';
import { applyS2Commands, createS2Scene, exportS2Subgraph, exportS2Workspace, importS2Subgraph,
  importS2WorkspaceWithPack, interactS2Canvas, readS2Definition, readS2Document, readS2Scene } from '../src/services/scene/sceneS2Canvas';
import { assertS2ReadOnlyContent } from '../src/services/scene/sceneS2ReadOnly';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import { experimentDefinition } from './fixtures/s2-experiment';

globalThis.fetch = async () => assert.fail('Read-only acceptance forbids real network/model calls');
const raw = structuredClone(experimentDefinition);
for (const id of ['role', 'constraints']) raw.initial.nodes.find(node => node.id === id)!.readOnly = true;
raw.initial.nodes.find(node => node.id === 'task')!.readOnly = false;
const definition = readS2Definition(raw), original = structuredClone(definition.initial);
const block = (document: S2Document, id: string) => document.nodes.find(node => node.id === id)!;
assert.equal(block(definition.initial, 'role').readOnly, true);
assert.equal(block(definition.initial, 'task').readOnly, false);
assert.equal(Object.hasOwn(block(definition.initial, 'testInput'), 'readOnly'), false, 'Legacy omission is preserved');
for (const invalid of [null, 'true', 0, 1, {}]) {
  const next = structuredClone(raw); (next.initial.nodes[0] as any).readOnly = invalid;
  assert.throws(() => readS2Definition(next), /只读配置必须为布尔值/);
}
const update = (id: string, content: string) => ({ op: 'update-node', id, values: { content } });
let current = applyS2Commands(definition, original, [update('task', '只解释学习者新选择的概念。')]);
assert.equal(block(current, 'task').values.content, '只解释学习者新选择的概念。');
assert.deepEqual(block(current, 'role').values, block(original, 'role').values);
for (const id of ['role', 'constraints']) {
  assert.throws(() => applyS2Commands(definition, current, [update(id, '绕过固定内容')]), /只读内容块/);
  assert.throws(() => applyS2Commands(definition, current, [{ op: 'remove-node', id }]), /只读内容块/);
  assert.throws(() => applyS2Commands(definition, current, [{ op: 'batch-nodes', action: { kind: 'delete', nodeIds: [id] } }]), /只读内容块/);
  assert.throws(() => applyS2Commands(definition, current, [{ op: 'remove-node', id }, { op: 'add-node',
    node: { ...structuredClone(block(current, id)), values: { content: '同 id 替换' } } }]), /只读内容块/);
  assert.throws(() => applyS2Commands(definition, current, [{ op: 'remove-node', id }, { op: 'add-node',
    node: { ...structuredClone(block(current, id)), readOnly: false } }]), /只读内容块/);
}
const snapshot = structuredClone(current);
assert.throws(() => applyS2Commands(definition, current, [update('task', '不能部分提交'), update('role', '改写角色')]), /只读内容块/);
assert.deepEqual(current, snapshot, 'Mixed valid/forbidden Agent proposal fails atomically');
for (const mutate of [
  (next: S2Document) => { block(next, 'role').values.content = '原样字典也必须受保护'; },
  (next: S2Document) => { block(next, 'role').readOnly = false; },
  (next: S2Document) => { delete block(next, 'role').readOnly; },
  (next: S2Document) => { block(next, 'role').type = 'otherType'; },
  (next: S2Document) => { block(next, 'role').componentId = 'material-text'; },
  (next: S2Document) => { delete block(next, 'role').componentId; },
  (next: S2Document) => { next.nodes = next.nodes.filter(node => node.id !== 'role'); },
]) {
  const tampered = structuredClone(current); mutate(tampered);
  assert.throws(() => assertS2ReadOnlyContent(definition.initial, tampered, { requirePresence: true }), /只读内容块/);
  assert.throws(() => exportS2Workspace(definition, tampered), /只读内容块/, 'Export cannot turn a tampered snapshot into a new initial');
}
current = applyS2Commands(definition, current, [{ op: 'update-node', id: 'role', label: '固定角色说明', values: {} },
  { op: 'batch-nodes', action: { kind: 'move', nodeIds: ['role'], delta: { x: 40, y: 30 } } },
  { op: 'add-edge', edge: { id: 'reference', source: 'role', target: 'task', label: '参照' } }]);
assert.equal(block(current, 'role').label, '固定角色说明');
assert.equal(block(current, 'role').position.x, block(original, 'role').position.x + 40);
assert.equal(current.edges.at(-1)!.id, 'reference', 'Display names, layout and links are independently editable');
const copied = applyS2Commands(definition, current, [{ op: 'batch-nodes', action: { kind: 'copy', nodeIds: ['role'] } }]);
const copy = copied.nodes.find(node => !current.nodes.some(old => old.id === node.id))!;
assert.equal(copy.readOnly, true, 'Copies preserve an instance content restriction');
assert.deepEqual(copy.values, block(current, 'role').values);
assert.throws(() => applyS2Commands(definition, copied, [update(copy.id, '修改副本也被拒绝')]), /只读内容块/);
assert.doesNotThrow(() => assertS2ReadOnlyContent(copied, current), 'Undo may remove a newly derived fixed copy');
assert.deepEqual(applyS2Commands(definition, copied, [{ op: 'remove-node', id: copy.id }]), current);
const importedCopy = importS2Subgraph(exportS2Subgraph(definition, current, ['role']), definition, current);
assert.equal(block(importedCopy.document, importedCopy.nodeIds[0]).readOnly, true, 'Portable subgraphs retain the flag');

const reference = { id: 'prompt-lab', version: '0.1.0' };
const portable = importS2WorkspaceWithPack(exportS2Workspace(definition, current, reference));
assert.deepEqual(portable.interactionPack, reference);
assert.deepEqual(portable.definition.initial, current, 'Export/import retains locks and editable values');
const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '实例只读保存重开', knowledgePoints: [] });
scene.canvasWorkspace = portable.definition; scene.interactionPack = reference;
assert.deepEqual(readS2Scene(JSON.parse(JSON.stringify(scene))).initial, current, 'Saved scene reopens with the exact lock state');
assert.throws(() => applyS2Commands(portable.definition, portable.definition.initial, [update('role', '重开后篡改')]), /只读内容块/);
const legacy = readS2Definition(structuredClone(experimentDefinition));
assert.equal(block(applyS2Commands(legacy, legacy.initial, [update('role', '旧场景继续可编辑')]), 'role').values.content, '旧场景继续可编辑');
const authored = structuredClone(definition.initial); block(authored, 'role').readOnly = false;
assert.equal(block(readS2Document(authored, definition), 'role').readOnly, false, 'Parser is format-only; authoring creates a new definition, mutation guards enforce locks');

// Capability selection snapshots the current graph, but must not promote a derived copy into an original anchor.
const capabilitySnapshot = { ...definition, initial: copied };
const editedAfterUndo = applyS2Commands(capabilitySnapshot, current, [update('task', '撤销副本后继续编辑')], original);
assert.equal(block(editedAfterUndo, 'task').values.content, '撤销副本后继续编辑');
assert.doesNotThrow(() => exportS2Workspace(capabilitySnapshot, editedAfterUndo, reference, original));
let turnCalls = 0;
await interactS2Canvas({ ...scene, canvasWorkspace: capabilitySnapshot }, current, '仅解释当前内容，不改图或执行。', null, [], {
  readOnlyBaseline: original, invoke: async request => {
    turnCalls++; const input = JSON.parse(request.userInput);
    return { content: JSON.stringify(input.stage === 'turn-understand'
      ? { understanding: '只解释当前画布', desiredOutcome: '知道哪些内容可以修改', actions: ['reply'], constraints: ['不改图或执行'], questions: [] }
      : { understanding: '固定内容保持原文', plan: '仅解释', reply: '固定角色与输出要求保留，任务说明仍可修改。', commands: [] }) };
  },
});
assert.equal(turnCalls, 2, 'The real Agent controller uses host anchors and does not resurrect an undone copy');

const host = new S2PluginHost('readonly-synthetic-run', definition);
const sent: string[] = [];
const session = new S2ModelTestSession({ sceneId: 'readonly-synthetic-run', runId: host.runId, resourceId: 'readonly-synthetic-model',
  providerId: 'synthetic', providerLabel: '合成模型', model: 'synthetic',
  limits: { maxRequests: 2, maxReservedOutputTokens: 1024, maxOutputTokens: 512 },
  invoke: async request => { sent.push(request.systemPromptOverride!); return { content: `合成返回 ${sent.length}`, diagnostics: { finishReason: 'stop' } }; } });
try {
  host.approveModelTestSession(session);
  const run = async (document: S2Document) => {
    host.setDocument(document);
    const job = host.enqueueWorkflow(['showResult']);
    for (let i = 0; i < 100 && !host.waitingModelTests().length; i++) await new Promise(resolve => setTimeout(resolve, 0));
    const wait = host.waitingModelTests()[0]; assert(wait, 'Synthetic model still requires host confirmation');
    host.confirmModelTest(job.id, wait.id, true);
    const result = await job.completion; assert.equal(result.status, 'succeeded');
    const shown = result.nodes.find(node => node.nodeId === 'showResult')!;
    assert.equal((host.currentArtifact(shown.artifactIds[0]).payload as any).value, `合成返回 ${sent.length}`);
  };
  await run(definition.initial); await run(current);
  const expected = (document: S2Document) => `角色：${block(document, 'role').values.content}\n任务：${block(document, 'task').values.content}\n约束：${block(document, 'constraints').values.content}`;
  assert.deepEqual(sent, [expected(definition.initial), expected(current)]);
  assert.notEqual(sent[0], sent[1]);
  console.log('S2 content read-only passed: strict optional instance flag, immutable authored anchors and surviving copies, atomic Agent edits/removal/replacement denial, independent label/layout/links, safe copy undo, legacy editable defaults, saved/portable locks, and real local compose → confirmed synthetic model → raw result using fixed role/output plus updated task. No real model/network calls.');
} finally { host.close(); session.close(); }
