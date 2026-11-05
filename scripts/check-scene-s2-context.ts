import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import type { S2AgentReply } from '../src/types/sceneS2';
import { createS2Scene, interactS2Canvas, readS2Scene, exportS2Workspace, readS2Definition, applyS2Commands } from '../src/services/scene/sceneS2Canvas';
import { S2ConversationMemory, S2_MEMORY_ACTION_RULES, S2_MEMORY_LIMITS, S2_MEMORY_READONLY_RULES, S2_MEMORY_RULES } from '../src/services/scene/sceneS2Memory';
import { readS2ContextRecall, s2CanvasContext, s2CanvasWiringFacts, s2CurrentExecutionFacts, s2TriggeredExecutionFacts, s2EvidenceIndex, s2HistoryContext, s2PluginContext, s2RecallContext } from '../src/services/scene/sceneS2Context';
import { S2PluginHost, executeS2JsonCheck } from '../src/services/scene/sceneS2PluginHost';
import { S2_JSON_CHECK_BINDING } from '../src/services/scene/sceneS2PluginRegistry';
import { fitSceneContextBudget } from '../src/services/scene/sceneContextBudget';

globalThis.fetch = async () => assert.fail('S2 context checks must not call real models, notes, profiles or external services');
const scene = createS2Scene({ source: 'custom', subject: 'Synthetic context', sceneSkill: 'S2', knowledgePoints: [] });
const definition = readS2Scene(scene), document = definition.initial, original = JSON.stringify(document);
const memory = new S2ConversationMemory(scene.sceneId, 'synthetic-run');
const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const wireDefinition = readS2Definition({ ...definition, instructions: { ...definition.instructions, response: '初始时tableView输入留空，等待用户补齐' },
  plugins: [cap('parse-json'), cap('to-table'), cap('table', 'structured-view')], initial: { ...definition.initial, execution: { version: 1, nodes: [
    { id: 'parse', ...cap('parse-json'), position: { x: 100, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'goal', fieldId: 'content' } } },
    { id: 'toTable', ...cap('to-table'), position: { x: 400, y: 0 }, bindings: {} },
    { id: 'tableView', ...cap('table', 'structured-view'), position: { x: 700, y: 0 }, bindings: {} },
  ], links: [{ source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'toTable', portId: 'value' } }] } } });
const beforeWiring = s2CanvasWiringFacts(wireDefinition.initial, 1);
assert.ok('unboundRequiredInputs' in beforeWiring);
assert.ok(beforeWiring.unboundRequiredInputs!.includes('tableView.table'));
const nowWired = applyS2Commands(wireDefinition, wireDefinition.initial, [{ op: 'connect-ports', link: {
  source: { nodeId: 'toTable', portId: 'table' }, target: { nodeId: 'tableView', portId: 'table' },
} }]);
const afterWiring = s2CanvasWiringFacts(nowWired, 2);
assert.ok('unboundRequiredInputs' in afterWiring && 'connectedInputs' in afterWiring);
assert.equal(afterWiring.unboundRequiredInputs!.includes('tableView.table'), false);
assert.ok(afterWiring.connectedInputs!.includes('tableView.table <- toTable.table'));
assert.equal(wireDefinition.initial.execution!.links.length, 1, 'Fact projection never mutates the original draft');
const wireHost = new S2PluginHost(scene.sceneId, wireDefinition.plugins); wireHost.setDocument(nowWired);
let wiringCalls = 0;
await interactS2Canvas({ ...scene, canvasWorkspace: wireDefinition }, nowWired, '现在表格输入接了吗，只解释，不运行', null, [], {
  pluginContext: wireHost.prepare(null, { goal: wireDefinition.goal, ...wireDefinition.instructions }, '只解释'), invoke: async request => {
    wiringCalls++; const input = JSON.parse(request.userInput);
    assert.ok(input.instructions.response.includes('输入留空'), 'Old design wording is deliberately present');
    assert.ok(input.currentWiring.connectedInputs.includes('tableView.table <- toTable.table'), 'Current host wiring overrides old factual wording');
    assert.match(input.contextRoles.instructions, /不是当前接线/);
    if (input.stage === 'turn-understand') return { content: JSON.stringify({ understanding: '查看最新接线', desiredOutcome: '解释结构，不运行', actions: ['reply'], constraints: ['不运行'], questions: [] }) };
    assert.match(request.systemPromptOverride!, /不为可运行而把未经处理的来源直接接到受约束的最终输出/);
    return { content: JSON.stringify({ understanding: '已接线未执行', plan: '只解释', reply: '表格输入已接到toTable；不代表执行或业务通过' }) };
  },
});
assert.equal(wiringCalls, 2); assert.equal(wireHost.history().length, 0);
const runnableWire = structuredClone(nowWired); runnableWire.nodes[0].values.content = '[{"name":"合成","score":80}]'; wireHost.setDocument(runnableWire);
await wireHost.enqueueWorkflow(['toTable']).completion;
const currentRunContext = wireHost.prepare(null, { goal: wireDefinition.goal, ...wireDefinition.instructions }, '解释最新运行');
const currentExecution = s2CurrentExecutionFacts(runnableWire, currentRunContext);
assert.ok('notIncludedInLatestWorkflow' in currentExecution);
assert.ok(currentExecution.notIncludedInLatestWorkflow!.includes('tableView'));
const completedWiring = s2CanvasWiringFacts(runnableWire, currentRunContext.frame.revision);
assert.ok('connectedInputs' in completedWiring); assert.ok(completedWiring.connectedInputs.includes('tableView.table <- toTable.table'));
assert.equal(wireHost.history().length, 2, 'Fact projection never reruns nodes');
runnableWire.nodes[0].values.content = '[]'; wireHost.setDocument(runnableWire);
const afterRevisionExecution = s2CurrentExecutionFacts(runnableWire, wireHost.prepare(null, { goal: wireDefinition.goal, ...wireDefinition.instructions }, 'after edit'));
assert.ok('latestWorkflow' in afterRevisionExecution); assert.equal(afterRevisionExecution.latestWorkflow, undefined, 'Stale results cannot become latest current execution');
assert.equal(s2CurrentExecutionFacts(runnableWire).available, false, 'Absent host context means unknown, not never executed');
wireHost.close();
const response = (value: unknown): LlmCallResponse => ({ content: JSON.stringify(value) } as LlmCallResponse);
const baseIntent = { understanding: '理解本轮表达', desiredOutcome: '按需解释，不强制改图或执行', actions: ['reply'], constraints: [], questions: [] };
const answer: S2AgentReply = { understanding: baseIntent.understanding, plan: '只解释', reply: 'Synthetic response', commands: [] };
const record = (id: string, quote: string, kind = 'constraint', nodeIds: string[] = []) => ({ id, kind, text: quote, quote, nodeIds });
// A missing operation list means no corresponding operation, not an inferred
// write/delete. Explicit invalid values retain strict validation and atomicity.
const partialMemory = new S2ConversationMemory(scene.sceneId, 'partial-memory');
const partialFrame = partialMemory.begin(scene.sceneId, undefined, '只解释，保留原文', 'user', document);
const partialSeed = partialMemory.propose(partialFrame, { set: [record('explain', '只解释'), record('preserve', '保留原文')] });
assert.deepEqual(partialMemory.snapshot(), [], 'Set-only proposals are not committed implicitly');
const partialReply = structuredClone(answer); partialMemory.stage(partialReply, partialFrame, partialSeed); assert.ok(partialMemory.accept(partialReply));
const unchangedPartial = partialMemory.snapshot(), unchangedFrame = partialMemory.begin(scene.sceneId, undefined, '只解释，保留原文', 'user', document);
for (const noOp of [undefined, {}, { set: [] }, { retire: [] }]) {
  assert.deepEqual(partialMemory.propose(unchangedFrame, noOp).map(({ nodeContent: _, ...item }) => item), unchangedPartial);
}
for (const field of ['set', 'retire'] as const) {
  for (const invalid of [undefined, null, false, 0, '[]', {}]) {
    assert.throws(() => partialMemory.propose(unchangedFrame, { [field]: invalid }), new RegExp(`${field}必须为数组`));
  }
  assert.throws(() => partialMemory.propose(unchangedFrame, { [field]: Array(5).fill({}) }), new RegExp(`${field}列表超过限制`));
}
for (const update of [
  { unknown: [] }, { set: [], unknown: undefined },
  { set: [record('fabricated', '不存在的引文')] },
  { set: [record('permission', '只解释', 'permission')] },
  { set: [record('missing_node', '只解释', 'focus', ['missing'])] },
  { set: [record('duplicate', '只解释'), record('duplicate', '只解释')] },
  { retire: [{ id: 'explain', quote: '不存在的引文', reason: 'invalid source' }] },
  { retire: [{ id: 'missing', quote: '只解释', reason: 'unknown record' }] },
]) assert.throws(() => partialMemory.propose(unchangedFrame, update));
assert.throws(() => partialMemory.propose(unchangedFrame, { set: [{ ...record('missing_list', '只解释'), nodeIds: null }] }), /set\[0\]\.nodeIds必须为数组/);
const partialEvent = partialMemory.begin(scene.sceneId, undefined, '只解释，保留原文', 'host-event', document);
for (const update of [{ set: [record('event_write', '只解释')] }, { retire: [{ id: 'explain', quote: '只解释', reason: 'event is not user consent' }] }]) {
  assert.throws(() => partialMemory.propose(partialEvent, update), /系统执行通知/);
}
assert.deepEqual(partialMemory.snapshot(), unchangedPartial, 'Malformed partial lists and event writes cannot change existing records');
const retireFrame = partialMemory.begin(scene.sceneId, undefined, '解除只解释，继续保留原文', 'user', document);
const retired = partialMemory.propose(retireFrame, { retire: [{ id: 'explain', quote: '解除只解释', reason: '真实用户局部解除' }] });
const retiredReply = structuredClone(answer); partialMemory.stage(retiredReply, retireFrame, retired); assert.ok(partialMemory.accept(retiredReply));
assert.deepEqual(partialMemory.snapshot().map(item => item.id), ['preserve'], 'Retire-only deletes only the named genuine-source record');
partialMemory.close();
async function turn(query: string, update?: unknown, inspect?: (input: any) => void) {
  const before = memory.snapshot(); let calls = 0;
  const reply = await interactS2Canvas(scene, document, query, null, history, { memory, invoke: async request => {
    calls++; const input = JSON.parse(request.userInput); inspect?.(input);
    assert.equal(input.memoryEnabled, true); assert.equal(input.memoryWritable, true, 'Only genuine user turns with run memory may propose writes');
    if (input.stage === 'turn-understand') {
      assert.ok(request.systemPromptOverride!.includes(S2_MEMORY_RULES), 'Only understanding receives the memory write protocol');
      return response({ ...baseIntent, ...(update === undefined ? {} : { memoryUpdate: update }) });
    }
    assert.ok(request.systemPromptOverride!.includes(S2_MEMORY_ACTION_RULES), 'Action receives read-only memory guidance');
    assert.ok(!request.systemPromptOverride!.includes(S2_MEMORY_RULES), 'Do not compile the semantic memory writer into the action stage');
    assert.ok(!request.systemPromptOverride!.includes('memoryUpdate:{set:'), 'The action prompt must not advertise a memory write output schema');
    return response(answer);
  } });
  assert.equal(calls, 2, 'No extra summarization-model call'); assert.deepEqual(memory.snapshot(), before, 'No implicit memory commit');
  assert.equal(memory.accept(reply), true); assert.equal(memory.accept(reply), false, 'Commit is once-only');
  history.push({ role: 'user', content: query }, { role: 'assistant', content: answer.reply });
}
await turn('暂停自动运行；先解释合流为什么冲突，讨论goal这个块', { set: [record('pause', '暂停自动运行'), record('merge_issue', '合流为什么冲突', 'question'), record('focus', '讨论goal这个块', 'focus', ['goal'])] });
for (let i = 0; i < 32; i++) await turn(`第${i}轮继续讨论一个细节`, undefined, input => {
  assert.equal(input.workingMemory.records.find((item: any) => item.id === 'pause').evidence.quote, '暂停自动运行');
  assert.equal(input.workingMemory.records.find((item: any) => item.id === 'merge_issue').kind, 'question');
  assert.equal(input.current.nodes[0].id, 'goal');
  if (input.stage === 'turn-understand') assert.equal(input.pluginCatalog, undefined, 'No catalog before understanding');
});
assert.ok(history.length > 60); assert.equal(memory.snapshot().length, 3);
await turn('现在不再暂停自动运行，但仍然每次执行前确认', { set: [record('pause', '每次执行前确认')], retire: [] });
assert.equal(memory.snapshot().find(item => item.id === 'pause')!.text, '每次执行前确认');
await turn('我理解了合流冲突，结束这个问题的讨论', { retire: [{ id: 'merge_issue', quote: '我理解了合流冲突', reason: '用户确认理解' }, { id: 'focus', quote: '结束这个问题的讨论', reason: '用户切换讨论对象' }] });
assert.deepEqual(memory.snapshot().map(item => item.id), ['pause']);
await turn('继续解释，不变更本局约定', {});
assert.deepEqual(memory.snapshot().map(item => item.id), ['pause'], 'Empty updates are no-ops through the real interaction entry, without repair');
await turn('继续讨论goal的内容', { set: [record('focus', '讨论goal的内容', 'focus', ['goal'])], retire: [] });
const moved = structuredClone(document); moved.nodes[0].position.x += 50;
assert.equal(memory.context(moved).records.find(item => item.id === 'focus')!.nodes[0].state, 'unchanged');
const changed = structuredClone(document); changed.nodes[0].values.content = 'new content';
assert.equal(memory.context(changed).records.find(item => item.id === 'focus')!.nodes[0].state, 'changed');
assert.equal(memory.context({ nodes: [], edges: [] }).records.find(item => item.id === 'focus')!.nodes[0].state, 'removed');
assert.equal(JSON.stringify(document), original); assert.ok(!exportS2Workspace(definition, document).includes('暂停自动运行'), 'Run memory is not saved to templates');
const snapshot = memory.snapshot(); snapshot[0].text = 'mutated externally'; assert.notEqual(memory.snapshot()[0].text, snapshot[0].text);
assert.throws(() => memory.begin('other-scene', undefined, 'x', 'user', document), /不属于/);
assert.throws(() => memory.begin(scene.sceneId, 'other-run', 'x', 'user', document), /不属于/);
const frame = memory.begin(scene.sceneId, undefined, '只解释，保留原文', 'user', document);
for (const update of [
  { set: [record('x', 'fabricated quote')], retire: [] },
  { set: [record('x', '只解释', 'permission')], retire: [] },
  { set: [record('x', '只解释', 'focus', ['missing'])], retire: [] },
  { set: [record('x', '只解释'), record('x', '只解释')], retire: [] },
  { set: [], retire: [{ id: 'missing', quote: '只解释', reason: 'bad' }] },
]) assert.throws(() => memory.propose(frame, update));
assert.equal(memory.accept(structuredClone(answer)), false, 'Unbranded replies cannot commit state');
const full = new S2ConversationMemory(scene.sceneId, 'full');
for (let i = 0; i < S2_MEMORY_LIMITS.records; i++) {
  const query = `要求${i}`, frame = full.begin(scene.sceneId, undefined, query, 'user', document), value = structuredClone(answer);
  full.stage(value, frame, full.propose(frame, { set: [record(`r${i}`, query)], retire: [] })); assert.equal(full.accept(value), true);
}
assert.throws(() => full.propose(full.begin(scene.sceneId, undefined, '新增要求', 'user', document), { set: [record('overflow', '新增要求')] }), /已满/);
assert.equal(full.snapshot().length, 16, 'No silent eviction of protected requirements'); full.close(); assert.equal(full.snapshot().length, 0);

// Memory corrections are source-checked; only the semantic draft is repaired once.
let repairCalls = 0;
const repairReply = await interactS2Canvas(scene, document, '只解释，不修改', null, history, { memory, invoke: async request => {
  repairCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'turn-understand') {
    if (!input.memoryRepair) return response({ ...baseIntent, memoryUpdate: { set: [record('no_edit', 'not in user input')], retire: [] } });
    assert.match(input.memoryRepair.error, /连续原文/); return response({ ...baseIntent, memoryUpdate: { set: [record('no_edit', '只解释，不修改')], retire: [] } });
  }
  return response(answer);
} });
assert.equal(repairCalls, 3); assert.equal(memory.accept(repairReply), true);
let eventCalls = 0;
const beforeEvent = memory.snapshot();
const eventReply = await interactS2Canvas(scene, document, '用户已确认执行插件', null, history, { memory, origin: 'host-event', invoke: async request => {
  eventCalls++; const input = JSON.parse(request.userInput);
  assert.equal(input.memoryEnabled, true); assert.equal(input.memoryWritable, false); assert.equal(input.memoryRepair, undefined);
  if (input.stage === 'turn-understand') {
    assert.ok(request.systemPromptOverride!.includes(S2_MEMORY_READONLY_RULES));
    assert.ok(!request.systemPromptOverride!.includes(S2_MEMORY_RULES));
    assert.ok(!request.systemPromptOverride!.includes('memoryUpdate:{set:'));
    return response({ ...baseIntent, memoryUpdate: { set: [record('fake_consent', '用户已确认')], retire: [] } });
  }
  assert.equal(Object.hasOwn(input.intent, 'memoryUpdate'), false, 'Unauthorized host sidecar must not reach the action stage');
  return response(answer);
} });
assert.equal(eventCalls, 2, 'A readonly host update is ignored locally without a paid memory repair');
assert.deepEqual(memory.snapshot(), beforeEvent); assert.equal(memory.accept(eventReply), true); assert.deepEqual(memory.snapshot(), beforeEvent);
for (const update of [
  { set: [record('event_set_only', '只解释')] },
  { retire: [{ id: 'pause', quote: '只解释', reason: 'host event cannot retire user constraint' }] },
  { set: [record('event_fake', '宿主执行通知')], retire: [{ id: 'pause', quote: '宿主执行通知', reason: 'not user consent' }] },
  {}, { set: [], retire: [] }, { set: null }, { retire: {} }, { unknown: 'untrusted sidecar' }, null, false, [], 'invalid-sidecar',
]) {
  const before = memory.snapshot(), stages: string[] = []; let calls = 0;
  const readonly = await interactS2Canvas(scene, document, '宿主执行通知：请解释结果，不改变用户要求', null, history, { memory, origin: 'host-event', invoke: async request => {
    calls++; const input = JSON.parse(request.userInput); stages.push(input.stage);
    assert.equal(input.memoryWritable, false); assert.equal(input.memoryEnabled, true);
    assert.equal(input.memoryRepair, undefined); assert.equal(input.responseRepair, undefined);
    assert.deepEqual(input.workingMemory.records.map(({ nodes: _, ...item }: any) => item), before);
    if (input.stage === 'turn-understand') return response({ ...baseIntent, memoryUpdate: update });
    assert.equal(Object.hasOwn(input.intent, 'memoryUpdate'), false); return response({ ...answer, memoryUpdate: update });
  } });
  assert.equal(calls, 2); assert.deepEqual(stages, ['turn-understand', 'turn-act']);
  assert.equal(Object.hasOwn(readonly, 'memoryUpdate'), false, 'Action host sidecar is removed rather than returned or staged as memory');
  assert.deepEqual(memory.snapshot(), before); assert.ok(memory.accept(readonly)); assert.deepEqual(memory.snapshot(), before,
    'Accepting a readonly result may advance the turn version but must preserve every genuine user record');
}
let noMemoryHostCalls = 0;
const noMemoryHost = await interactS2Canvas(scene, document, '只解读宿主通知', null, [], { origin: 'host-event', invoke: async request => {
  noMemoryHostCalls++; const input = JSON.parse(request.userInput);
  assert.equal(input.memoryEnabled, false); assert.equal(input.memoryWritable, false); assert.equal(input.memoryRepair, undefined);
  if (input.stage === 'turn-understand') return response({ ...baseIntent, memoryUpdate: { set: null, retire: 'invalid' } });
  assert.equal(Object.hasOwn(input.intent, 'memoryUpdate'), false); return response(answer);
} });
assert.equal(noMemoryHostCalls, 2); assert.deepEqual(noMemoryHost.commands, []);
let hostActionSidecarCalls = 0;
const actionSidecarBefore = memory.snapshot();
const actionSidecar = await interactS2Canvas(scene, document, '只解释本地返回结果', null, [], { memory, origin: 'host-event', invoke: async request => {
  hostActionSidecarCalls++; const input = JSON.parse(request.userInput);
  assert.equal(input.memoryRepair, undefined); assert.equal(input.responseRepair, undefined);
  return response(input.stage === 'turn-understand' ? baseIntent : { ...answer, memoryUpdate: { set: [record('action_fake', '只解释本地返回结果')], retire: [{ id: 'pause' }] } });
} });
assert.equal(hostActionSidecarCalls, 2); assert.equal(Object.hasOwn(actionSidecar, 'memoryUpdate'), false);
assert.ok(memory.accept(actionSidecar)); assert.deepEqual(memory.snapshot(), actionSidecarBefore);
let strictHostUnknownCalls = 0;
const strictHostUnknown = await interactS2Canvas(scene, document, '只解释本地返回结果', null, [], { memory, origin: 'host-event', invoke: async request => {
  strictHostUnknownCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'turn-understand') return response(baseIntent);
  if (!input.responseRepair) return response({ ...answer, memoryUpdate: { set: null }, unrelatedUnknownField: 'still forbidden' });
  assert.match(input.responseRepair.error, /unrelatedUnknownField/); return response(answer);
} });
assert.equal(strictHostUnknownCalls, 3, 'Discarding one unauthorized sidecar does not bypass validation or retries for other unknown fields');
assert.ok(memory.accept(strictHostUnknown)); assert.deepEqual(memory.snapshot(), actionSidecarBefore);
let strictUserActionCalls = 0;
const strictUserAction = await interactS2Canvas(scene, document, '只解释本地返回结果', null, [], { memory, invoke: async request => {
  strictUserActionCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'turn-understand') return response(baseIntent);
  if (!input.responseRepair) return response({ ...answer, memoryUpdate: { set: null } });
  assert.match(input.responseRepair.error, /memoryUpdate/); return response(answer);
} });
assert.equal(strictUserActionCalls, 3, 'A user action-stage memory write remains an invalid output with the original single response repair');
assert.ok(memory.accept(strictUserAction)); assert.deepEqual(memory.snapshot(), actionSidecarBefore);
for (const scenario of [
  { origin: 'user' as const, update: { set: null }, error: /set必须为数组/ },
  { origin: 'user' as const, update: { retire: {} }, error: /retire必须为数组/ },
]) {
  const before = memory.snapshot(); let calls = 0;
  const repaired = await interactS2Canvas(scene, document, '只解释，不修改', null, history, { memory, origin: scenario.origin, invoke: async request => {
    calls++; const input = JSON.parse(request.userInput);
    if (input.stage === 'turn-understand') {
      if (!input.memoryRepair) return response({ ...baseIntent, memoryUpdate: scenario.update });
      assert.match(input.memoryRepair.error, scenario.error); return response(baseIntent);
    }
    return response(answer);
  } });
  assert.equal(calls, 3, 'Genuine user invalid partial lists retain exactly the original one semantic repair');
  assert.deepEqual(memory.snapshot(), before); assert.ok(memory.accept(repaired)); assert.deepEqual(memory.snapshot(), before);
}
let repeatedPartialRepairCalls = 0;
await assert.rejects(() => interactS2Canvas(scene, document, '只解释', null, [], { memory, invoke: async request => {
  repeatedPartialRepairCalls++; assert.equal(JSON.parse(request.userInput).stage, 'turn-understand');
  return response({ ...baseIntent, memoryUpdate: { retire: null } });
} }), /retire必须为数组/);
assert.equal(repeatedPartialRepairCalls, 2, 'Repeated malformed memory stops after the existing single repair, without action or extra loops');

// A discarded/late/aborted/truncated response never commits a working-memory draft.
const beforeFailure = memory.snapshot();
const pending = await interactS2Canvas(scene, document, '新增一个偏好', null, [], { memory, invoke: async request => response(JSON.parse(request.userInput).stage === 'turn-understand'
  ? { ...baseIntent, memoryUpdate: { set: [record('late', '新增一个偏好')], retire: [] } } : answer) });
assert.deepEqual(memory.snapshot(), beforeFailure);
await turn('继续讨论'); assert.equal(memory.accept(pending), false, 'A newer accepted turn invalidates an older memory draft');
for (const failure of ['abort', 'truncated', 'transport', 'invalid']) {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(() => interactS2Canvas(scene, document, '新增另一个偏好', null, [], { memory, signal: controller.signal, invoke: async request => {
    calls++; const input = JSON.parse(request.userInput);
    if (input.stage === 'turn-understand') return response({ ...baseIntent, memoryUpdate: { set: [record('failed', '新增另一个偏好')], retire: [] } });
    if (failure === 'abort') controller.abort();
    if (failure === 'transport') throw new Error('synthetic transport');
    if (failure === 'invalid') return response({ ...answer, commands: [{ op: 'run-code', code: 'not allowed' }] });
    return failure === 'truncated' ? { ...response(answer), diagnostics: { finishReason: 'length' } } as LlmCallResponse : response(answer);
  } }), /停止|截断|transport|本轮意图/);
  assert.equal(calls, failure === 'invalid' ? 3 : 2); assert.deepEqual(memory.snapshot(), beforeFailure);
}

// Long history and canvas: index first, then retrieve exact local sources selected by semantic intent.
const large = structuredClone(document); large.nodes = Array.from({ length: 35 }, (_, i) => ({ ...structuredClone(document.nodes[0]), id: `n${i}`, values: { content: `node-${i}:` + 'z'.repeat(1100) } }));
const longHistory = Array.from({ length: 160 }, (_, i) => ({ role: i % 2 ? 'assistant' as const : 'user' as const, content: `message-${i}:` + 'x'.repeat(5500) }));
const largeBefore = JSON.stringify(large), historyBefore = JSON.stringify(longHistory), projected = s2CanvasContext(large, 'n3', []);
assert.equal('representation' in projected && projected.representation, 'indexed-canvas'); assert.ok(JSON.stringify(projected).length < largeBefore.length / 3);
const historyContext = s2HistoryContext(longHistory); assert.ok(historyContext.recentConversation.length < 8); assert.ok(historyContext.historyIndexOmitted > 0);
let largestRequest = 0;
await interactS2Canvas(scene, large, '回看第一条用户要求和n20的原文，只解释', 'n3', longHistory, { invoke: async request => {
  largestRequest = Math.max(largestRequest, request.userInput.length); const input = JSON.parse(request.userInput);
  if (input.stage === 'turn-understand') {
    assert.equal(input.current.representation, 'indexed-canvas'); assert.equal(input.historyMessageCount, 160); assert.ok(input.historyIndex.some((item: any) => item.sourceId === 'history-0'));
    return response({ ...baseIntent, recall: { messageIds: ['history-0'], fields: [{ nodeId: 'n20', fieldId: 'content' }] } });
  }
  assert.equal(input.recalledContext.items.find((item: any) => item.kind === 'message').value.content, longHistory[0].content);
  assert.equal(input.recalledContext.items.find((item: any) => item.kind === 'field').value, large.nodes[20].values.content);
  assert.deepEqual(input.recalledContext.unavailable, []); return response(answer);
} });
assert.ok(largestRequest < 40000); assert.equal(JSON.stringify(large), largeBefore); assert.equal(JSON.stringify(longHistory), historyBefore);
const largeMemory = new S2ConversationMemory(scene.sceneId, 'large-memory');
for (let batch = 0; batch < 2; batch++) {
  const query = 'q'.repeat(500), frame = largeMemory.begin(scene.sceneId, undefined, query, 'user', large), pending = structuredClone(answer);
  const set = Array.from({ length: 4 }, (_, i) => ({ ...record(`p${batch * 4 + i}`, query), text: 't'.repeat(400) }));
  largeMemory.stage(pending, frame, largeMemory.propose(frame, { set, retire: [] })); assert.ok(largeMemory.accept(pending));
}
let declaredHistoryOmissions = false;
await interactS2Canvas(scene, large, '保留所有早期约定，核对第一条历史和当前n20字段', 'n3', longHistory, { memory: largeMemory, invoke: async request => {
  const input = JSON.parse(request.userInput); assert.equal(input.workingMemory.records.length, 8); assert.equal(input.query, '保留所有早期约定，核对第一条历史和当前n20字段');
  assert.ok(input.workingMemory.records.every((item: any) => item.text.length === 400 && item.evidence.quote.length === 500));
  if (input.contextBudgetOmissions?.some((id: string) => id.startsWith('s2-history-'))) declaredHistoryOmissions = true;
  if (input.stage === 'turn-understand') return response({ ...baseIntent, recall: { messageIds: ['history-0'], fields: [{ nodeId: 'n20', fieldId: 'content' }] } });
  assert.equal(input.recalledContext.items[0].value.content, longHistory[0].content);
  for (const source of input.requirementSources.filter((s: any) => s.id.startsWith('memory-'))) {
    assert.equal(source.text, undefined);
    assert.equal(source.contextPath.reduce((value: any, key: string | number) => value[key], input), 'q'.repeat(500));
  }
  const { optionalContextBlocks, ...requiredInput } = input;
  const candidate = { ...request, userInput: JSON.stringify(requiredInput), sceneOptionalContext: optionalContextBlocks };
  // Derive pressure from protected sources AND the real 10% safety reserve. A
  // growing protocol must not make this test request a smaller-than-required
  // protected window and then mistake correct fail-closed behavior for a bug.
  const protectedBaseline = fitSceneContextBudget({ ...candidate, sceneOptionalContext: [] }).diagnostics!;
  const pressureWindow = Math.ceil((protectedBaseline.estimatedInputTokens + protectedBaseline.outputReserveTokens + 512) / .9);
  const squeezed = fitSceneContextBudget(candidate, { provider: { contextWindowTokens: pressureWindow } });
  declaredHistoryOmissions ||= squeezed.diagnostics!.omittedContextIds.some(id => id.startsWith('s2-history-'));
  const preserved = JSON.parse(squeezed.request.userInput); assert.deepEqual(preserved.workingMemory, input.workingMemory); assert.deepEqual(preserved.recalledContext, input.recalledContext); assert.equal(preserved.query, input.query);
  return response(answer);
} });
assert.equal(declaredHistoryOmissions, true, 'Budget pressure drops only declared optional history, never query/memory/explicit recall'); largeMemory.close();
const optionalUserHistory = 'EARLIER-USER-ONLY:' + 'optional-user-text-'.repeat(50);
let optionalHistoryCalls = 0;
await interactS2Canvas(scene, document, '只解释，不改图', null, [{ role: 'user', content: optionalUserHistory }], { invoke: async request => {
  optionalHistoryCalls++; const input = JSON.parse(request.userInput), { optionalContextBlocks, ...protectedInput } = input;
  assert.ok(optionalContextBlocks.some((b: any) => b.sourceIds.includes('history-0')));
  assert.equal(JSON.stringify(protectedInput).includes(optionalUserHistory), false, 'New requirement sources cannot smuggle optional raw user history into protected context');
  return response(input.stage === 'turn-understand' ? baseIntent : answer);
} });
assert.equal(optionalHistoryCalls, 2, 'Explain-only remains a two-call path');
const oversize = s2RecallContext(readS2ContextRecall({ messageIds: ['history-0', 'history-1'], fields: [{ nodeId: 'n3', fieldId: 'constructor' }], invocationIds: ['foreign-call'] }), longHistory, large);
assert.equal(oversize.items[0].value && (oversize.items[0].value as any).content, longHistory[0].content);
assert.ok(oversize.unavailable.some(item => item.reason.includes('预算'))); assert.ok(oversize.unavailable.some(item => item.id === 'n3.constructor'));
assert.ok(oversize.unavailable.some(item => item.id === 'foreign-call'));
assert.throws(() => readS2ContextRecall({ messageIds: Array(5).fill('history-0') }), /范围/);

// Real local host ledger, not fake model output: bound observations but retain failure/history provenance.
const scoped = { ...definition, plugins: [S2_JSON_CHECK_BINDING] }, hostScene = { ...scene, canvasWorkspace: scoped };
const host = new S2PluginHost(scene.sceneId, scoped.plugins, async (call, inputs, signal) => call.idempotencyKey === 'first'
  ? { status: 'failed', outputs: {}, error: { code: 'SYNTHETIC_FAILURE', message: 'synthetic failure before edits' } } : executeS2JsonCheck(call, inputs, signal));
const data = structuredClone(document); data.nodes[0].values.content = '{"ok":true}'; host.setDocument(data);
for (let i = 0; i < 24; i++) {
  const context = host.prepare('goal', { goal: scoped.goal, ...scoped.instructions }, 'check'), text = context.bindings[0].artifactId;
  await host.execute({ ...S2_JSON_CHECK_BINDING, nodeId: 'goal', inputs: { text: [text] }, reason: 'synthetic' }, context.frame, i ? `call-${i}` : 'first');
}
const complete = host.prepare('goal', { goal: scoped.goal, ...scoped.instructions }, 'explain'), completeBefore = JSON.stringify(complete);
const selected = s2PluginContext(complete, readS2ContextRecall(undefined))!;
assert.ok(selected.frame.observations.length <= 5); assert.ok(selected.contextOmissions.observations > 0);
assert.equal((selected as any).workflowArchive, undefined, 'Never include the full local archive in a model projection');
assert.ok(s2PluginContext(complete, readS2ContextRecall({ workflowRunIds: ['foreign'] }))!.contextOmissions.executionRuns >= 0);
assert.ok(selected.frame.observations.some(item => item.executionStatus === 'failed'), 'Retain recent failure even beyond the ordinary observation tail');
assert.equal(JSON.stringify(complete), completeBefore); assert.equal(host.history().length, 24); assert.equal(host.remainingCalls, 40);
await interactS2Canvas(hostScene, data, '解释本地结果，不重新运行', 'goal', [], { pluginContext: complete, invoke: async request => {
  const input = JSON.parse(request.userInput);
  if (input.stage === 'turn-understand') return response(baseIntent);
  assert.ok(input.pluginContext.frame.observations.length <= 5); assert.ok(input.evidenceIndex.observationIndexOmitted > 0); return response(answer);
} });
assert.equal(host.history().length, 24); assert.equal(host.remainingCalls, 40, 'Context retrieval spends no execution budget');
const firstId = complete.receiptIndex[0].invocationId; data.nodes[0].values.content = '{}'; host.setDocument(data);
const revised = host.prepare('goal', { goal: scoped.goal, ...scoped.instructions }, 'after edit');
assert.deepEqual(revised.frame.observations, []); assert.ok(s2EvidenceIndex(revised)!.observations.some(item => item.invocationId === firstId && item.publication === 'stale'));
const historical = s2RecallContext(readS2ContextRecall({ invocationIds: [firstId] }), [], data, revised);
assert.equal(historical.items[0].kind, 'historical-receipt'); assert.equal((historical.items[0].value as any).publication, 'stale');
assert.equal((historical.items[0].value as any).artifacts, undefined, 'Historical receipt does not resurrect obsolete output');
const workflowData = structuredClone(data); workflowData.execution = { version: 1, nodes: [{ id: 'check', ...S2_JSON_CHECK_BINDING, position: { x: 0, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'goal', fieldId: 'content' } } }], links: [] };
host.setDocument(workflowData); let firstWorkflow = '';
for (let i = 0; i < 10; i++) { const job = host.enqueueWorkflow(['check']); if (!i) firstWorkflow = job.id; await job.completion; }
const workflowContext = host.prepare(null, { goal: scoped.goal, ...scoped.instructions }, 'old workflow');
assert.ok(!workflowContext.executionRuns.some(run => run.id === firstWorkflow));
const oldRun = s2RecallContext(readS2ContextRecall({ workflowRunIds: [firstWorkflow] }), [], workflowData, workflowContext);
assert.equal(oldRun.items[0].kind, 'workflow'); assert.equal((oldRun.items[0].value as any).nodes[0].nodeId, 'check');
// A human wait may finish after newer queue jobs have pushed it out of every ordinary tail.
// Its completion event must preserve the exact triggering run before the semantic recall decision.
const triggerDefinition = readS2Definition({ ...definition, plugins: [S2_JSON_CHECK_BINDING, cap('text', 'human-input')], initial: {
  ...document, execution: { version: 1, nodes: [
    { id: 'human', ...cap('text', 'human-input'), position: { x: 0, y: 0 }, bindings: { prompt: { kind: 'literal', value: '提交合成JSON' } } },
    { id: 'oldCheck', ...S2_JSON_CHECK_BINDING, position: { x: 100, y: 0 }, bindings: {} },
    { id: 'newCheck', ...S2_JSON_CHECK_BINDING, position: { x: 200, y: 0 }, bindings: { text: { kind: 'literal', value: '{}' } } },
  ], links: [{ source: { nodeId: 'human', portId: 'text' }, target: { nodeId: 'oldCheck', portId: 'text' } }] },
} });
const triggerHost = new S2PluginHost(scene.sceneId, triggerDefinition.plugins); triggerHost.setDocument(triggerDefinition.initial);
const waitingJob = triggerHost.enqueueWorkflow(['oldCheck']);
for (let i = 0; i < 500 && !triggerHost.waitingHumanInputs().length; i++) await new Promise(resolve => setTimeout(resolve, 1));
assert.equal(triggerHost.waitingHumanInputs().length, 1);
let latestJob = '';
for (let i = 0; i < 9; i++) { const job = triggerHost.enqueueWorkflow(['newCheck'], undefined, { force: true }); latestJob = job.id; await job.completion; }
triggerHost.submitHumanInput(waitingJob.id, triggerHost.waitingHumanInputs()[0].id, '{}');
assert.equal((await waitingJob.completion).status, 'succeeded');
const triggerContext = triggerHost.prepare('oldCheck', { goal: triggerDefinition.goal, ...triggerDefinition.instructions }, 'host completion');
triggerContext.frame.event = { id: 'synthetic-host-event', kind: 'workflow-completed', workflowRunId: waitingJob.id };
assert.ok(!s2EvidenceIndex(triggerContext)!.workflows.some(run => run.id === waitingJob.id), 'Ordinary evidence tail deliberately excludes the older trigger');
assert.ok(!s2PluginContext(triggerContext, readS2ContextRecall(undefined))!.executionRuns.some(run => run.id === waitingJob.id));
const triggerFacts = s2TriggeredExecutionFacts(triggerContext)!;
assert.equal(triggerFacts.available, true); assert.equal(triggerFacts.workflowRunId, waitingJob.id);
assert.ok('workflow' in triggerFacts); assert.equal(triggerFacts.workflow!.id, waitingJob.id);
const triggerHistory = JSON.stringify(triggerHost.workflowHistory()), triggerBudget = triggerHost.remainingCalls;
const triggerMemory = new S2ConversationMemory(scene.sceneId, triggerHost.runId);
const triggerSeed = triggerMemory.begin(scene.sceneId, triggerHost.runId, '保留本局要求，不自动重跑工具', 'user', triggerDefinition.initial);
const triggerSeedReply = structuredClone(answer);
triggerMemory.stage(triggerSeedReply, triggerSeed, triggerMemory.propose(triggerSeed, { set: [record('user_boundary', '保留本局要求，不自动重跑工具')] }));
assert.ok(triggerMemory.accept(triggerSeedReply)); const triggerMemoryBefore = triggerMemory.snapshot();
let triggerCalls = 0;
const triggerReply = await interactS2Canvas({ ...scene, canvasWorkspace: triggerDefinition }, triggerDefinition.initial, '执行返回，请解释而不重试', 'oldCheck', [], {
  pluginContext: triggerContext, memory: triggerMemory, origin: 'host-event', invoke: async request => {
    triggerCalls++; const input = JSON.parse(request.userInput);
    assert.equal(input.memoryEnabled, true); assert.equal(input.memoryWritable, false); assert.equal(input.memoryRepair, undefined);
    assert.equal(input.hostEvent.kind, 'workflow-completed'); assert.equal(input.hostEvent.workflowRunId, waitingJob.id);
    assert.equal(input.triggeredExecution.workflow.id, waitingJob.id); assert.equal(input.triggeredExecution.workflow.status, 'succeeded');
    assert.equal(input.currentExecution.latestWorkflow.id, latestJob, 'Newest-created run remains separate from the completed trigger');
    if (input.stage === 'turn-understand') return response({ ...baseIntent, recall: { workflowRunIds: [waitingJob.id] }, memoryUpdate: {
      set: [record('host_completed', '执行返回')], retire: [{ id: 'user_boundary', quote: '执行返回', reason: '宿主通知不能解除用户要求' }],
    } });
    assert.equal(Object.hasOwn(input.intent, 'memoryUpdate'), false);
    assert.equal(input.recalledContext.items.find((item: any) => item.kind === 'workflow').value.id, waitingJob.id);
    return response(answer);
  },
});
assert.equal(triggerCalls, 2); assert.equal(triggerHost.remainingCalls, triggerBudget); assert.equal(JSON.stringify(triggerHost.workflowHistory()), triggerHistory);
assert.deepEqual(triggerMemory.snapshot(), triggerMemoryBefore); assert.ok(triggerMemory.accept(triggerReply));
assert.deepEqual(triggerMemory.snapshot(), triggerMemoryBefore, 'Host-result interpretation preserves user records and never reruns a completed local tool'); triggerMemory.close();
const foreignEvent = structuredClone(triggerContext); foreignEvent.frame.event.workflowRunId = 'foreign-run';
const unknownTrigger = s2TriggeredExecutionFacts(foreignEvent)!;
assert.equal(unknownTrigger.available, false); assert.equal('workflow' in unknownTrigger, false, 'Event prose cannot invent a workflow receipt');
const editedTrigger = structuredClone(triggerDefinition.initial); editedTrigger.nodes[0].values.content = 'new revision'; triggerHost.setDocument(editedTrigger);
const staleTriggerContext = triggerHost.prepare(null, { goal: triggerDefinition.goal, ...triggerDefinition.instructions }, 'after edit');
staleTriggerContext.frame.event = triggerContext.frame.event;
assert.equal(s2TriggeredExecutionFacts(staleTriggerContext)!.available, false, 'Old completion is never promoted to current-revision evidence');
triggerHost.close();
const largeTriggerDoc = structuredClone(document); largeTriggerDoc.execution = { version: 1, nodes: Array.from({ length: 8 }, (_, i) => ({
  id: `failure${i}`, ...S2_JSON_CHECK_BINDING, position: { x: i * 50, y: 0 }, bindings: { text: { kind: 'literal' as const, value: '{}' } },
})), links: [] };
const largeTriggerHost = new S2PluginHost(scene.sceneId, [S2_JSON_CHECK_BINDING], async () => { throw new Error('synthetic-local-failure-'.repeat(50)); });
largeTriggerHost.setDocument(largeTriggerDoc);
const largeTriggerJob = largeTriggerHost.enqueueWorkflow(); assert.equal((await largeTriggerJob.completion).status, 'failed');
const largeTriggerContext = largeTriggerHost.prepare(null, { goal: definition.goal, ...definition.instructions }, 'large failed workflow');
largeTriggerContext.frame.event = { id: 'synthetic-large-event', kind: 'workflow-completed', workflowRunId: largeTriggerJob.id };
const largeTriggerFacts = s2TriggeredExecutionFacts(largeTriggerContext)!;
assert.ok('workflow' in largeTriggerFacts); assert.ok(largeTriggerFacts.workflow && 'nodeIndex' in largeTriggerFacts.workflow);
assert.equal(largeTriggerFacts.workflow.nodeIndex.length, 8, 'Oversize triggering records provide a declared index, never a silently truncated full run');
assert.ok(JSON.stringify(largeTriggerFacts).length < 5000); largeTriggerHost.close();
host.close(); memory.close(); assert.deepEqual(memory.snapshot(), []); assert.equal(memory.accept(pending), false);
assert.throws(() => memory.begin(scene.sceneId, undefined, 'x', 'user', document), /已结束/);
assert.deepEqual(new S2ConversationMemory(scene.sceneId, 'new-run').snapshot(), []);
console.log(`S2 context/memory passed: separate readable/writable memory and host-only readonly rules, ignored unauthorized host set/retire/empty/malformed sidecars with exactly understand+action and no paid repair/tool replay, strict low-level host write rejection and unchanged user one-repair validation, optional partial lists, 32-turn protected constraints/issues/focus, user correction/release, grounded bounded atomic memory, accepted/stale/abort/truncated isolation, changed/deleted anchors, 160-message/35-node indexed context and exact local recall, full-or-unavailable limits, bounded real-host observations with failure/stale provenance and untouched inputs/ledgers/budgets. Largest synthetic request ${largestRequest} chars. No real model/notes/profile/network or semantic-quality claim.`);
