import assert from 'node:assert/strict';
import { createS2Scene, interactS2Canvas, readS2Definition, applyS2Commands } from '../src/services/scene/sceneS2Canvas';
import { readS2ProposalReview, s2ProposalSources } from '../src/services/scene/sceneS2ProposalReview';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { S2ConversationMemory } from '../src/services/scene/sceneS2Memory';
import { readS2TurnIntent } from '../src/services/scene/sceneS2Turn';
import type { S2AgentReply } from '../src/types/sceneS2';

globalThis.fetch = async () => assert.fail('Proposal review regression must never call models/network/notes');
const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成审核练习', knowledgePoints: [], extraHints: '只展示合格记录；用户原文必须保留' });
const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const definition = readS2Definition({ version: 1, goal: '只展示合格记录', instructions: {
  understanding: '先理解需求', planning: '按需协作，不自动执行', response: '初始view输入留空；原文保留' },
  blockTypes: [{ id: 'note', label: '内容', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
  plugins: [cap('parse-json'), cap('to-table'), cap('table', 'structured-view')], initial: { nodes: [
    { id: 'input', type: 'note', position: { x: 0, y: 0 }, values: { content: '[{"name":"","score":120}]' } },
  ], edges: [], execution: { version: 1, nodes: [
    { id: 'parse', ...cap('parse-json'), position: { x: 200, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'input', fieldId: 'content' } } },
    { id: 'table', ...cap('to-table'), position: { x: 400, y: 0 }, bindings: {} },
    { id: 'view', ...cap('table', 'structured-view'), position: { x: 600, y: 0 }, bindings: {} },
  ], links: [{ source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'table', portId: 'value' } }] } } });
const active = { ...scene, canvasWorkspace: definition }, document = definition.initial, original = JSON.stringify(document);
const badCommands: S2AgentReply['commands'] = [{ op: 'connect-ports', link: { source: { nodeId: 'table', portId: 'table' }, target: { nodeId: 'view', portId: 'table' } } }];
const goodCommands: S2AgentReply['commands'] = [{ op: 'add-node', node: { id: 'advice', type: 'note', position: { x: 0, y: 200 }, values: { content: '保留审核缺口；先完善局部，不放行全量记录' } } }];
const intent = { understanding: '补齐一个局部但不擅自解除约束', desiredOutcome: '协作建议', actions: ['reply', 'edit'], constraints: [], questions: [] };
const answer = (commands: S2AgentReply['commands']): S2AgentReply => ({ understanding: intent.understanding, plan: '本轮仅提出建议', reply: '这只是待确认的修改建议', commands });
const response = (value: unknown) => ({ content: JSON.stringify(value) });
const judge = (verdict: 'accept' | 'revise' | 'clarify') => ({ verdict, reason: verdict === 'accept' ? '符合本轮委托，未扩大权限' : '全量转表直接接最终展示，未保留原有业务前提',
  evidence: [{ sourceId: 'scene-request', quote: '只展示合格记录' }], ...(verdict === 'accept' ? {} : { reply: '这会绕过你原先的审核要求。未改图、未执行；请先确认是否仅补解析局部。' }) });
const host = new S2PluginHost(scene.sceneId, definition.plugins); host.setDocument(document);
const pluginContext = host.prepare('input', { goal: definition.goal, ...definition.instructions }, '协作');
const stages: string[] = []; let reviews = 0;
const repaired = await interactS2Canvas(active, document, '帮我补个可运行局部，不运行', 'input', [], { pluginContext, invoke: async request => {
  const input = JSON.parse(request.userInput); stages.push(input.stage);
  if (input.stage === 'turn-understand') return response(intent);
  if (input.stage === 'turn-proposal-review') {
    assert.equal(input.pluginCatalog, undefined); assert.equal(input.proposalOnly, true);
    assert.ok(!request.systemPromptOverride!.includes('S2插件协议v1'), 'Independent review cannot choose tools');
    assert.equal(input.sources.find((s: any) => s.id === 'strategy-response').kind, 'strategy');
    if (++reviews === 1) {
      assert.ok(input.beforeWiring.unboundRequiredInputs.includes('view.table'));
      assert.ok(input.afterWiring.connectedInputs.includes('view.table <- table.table'));
      assert.equal(input.afterWiring.revision, undefined, 'A hypothetical graph is not the current host revision');
      return response(judge('revise'));
    }
    assert.ok(input.afterWiring.unboundRequiredInputs.includes('view.table'));
    return response(judge('accept'));
  }
  if (input.responseRepair) {
    assert.equal(input.responseRepair.kind, 'semantic-consistency'); assert.deepEqual(input.intent, intent);
    assert.equal(input.current.execution.links.length, 1, 'Repair uses the UNMODIFIED current graph');
  }
  return response(answer(input.responseRepair ? goodCommands : badCommands));
} });
assert.deepEqual(stages, ['turn-understand', 'turn-act', 'turn-proposal-review', 'turn-act', 'turn-proposal-review']);
assert.deepEqual(repaired.commands, goodCommands); assert.equal(JSON.stringify(document), original);
assert.equal(host.history().length, 0); assert.equal(host.remainingCalls, 64, 'Semantic reviews never execute plugins or consume tool quota');

// A second conflict cannot use another repair. Do not commit a semantic draft that retired a constraint.
const memory = new S2ConversationMemory(scene.sceneId, host.runId);
const seedQuery = '只展示合格记录', frame = memory.begin(scene.sceneId, host.runId, seedQuery, 'user', document), seed = answer([]);
memory.stage(seed, frame, memory.propose(frame, { set: [{ id: 'gate', kind: 'constraint', text: seedQuery, quote: seedQuery, nodeIds: [] }], retire: [] })); memory.accept(seed);
let blockedCalls = 0;
const blocked = await interactS2Canvas(active, document, '补个局部', null, [], { memory, pluginContext, invoke: async request => {
  blockedCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'turn-understand') return response({ ...intent, memoryUpdate: { set: [], retire: [{ id: 'gate', quote: '补个局部', reason: 'Synthetic wrong retirement to test no commit' }] } });
  return response(input.stage === 'turn-proposal-review' ? judge('revise') : answer(badCommands));
} });
assert.equal(blockedCalls, 5); assert.deepEqual(blocked.commands, []); assert.match(blocked.reply, /未改图/);
assert.equal(blocked.pluginRequests, undefined); assert.equal(blocked.executionRequest, undefined);
assert.equal(memory.accept(blocked), false); assert.equal(memory.snapshot()[0].id, 'gate', 'Rejected proposal cannot silently retire protected requirements');
let noOpFixCalls = 0;
const noOpFix = await interactS2Canvas(active, document, '补个局部', null, [], { memory, pluginContext, invoke: async request => {
  noOpFixCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'turn-understand') return response({ ...intent, memoryUpdate: { set: [], retire: [{ id: 'gate', quote: '补个局部', reason: 'Synthetic wrong retirement' }] } });
  if (input.stage === 'turn-proposal-review') return response(judge('revise'));
  return response(answer(input.responseRepair ? [] : badCommands));
} });
assert.equal(noOpFixCalls, 4); assert.deepEqual(noOpFix.commands, []);
assert.equal(memory.accept(noOpFix), false); assert.equal(memory.snapshot()[0].id, 'gate', 'A safe no-op correction must not commit the challenged initial semantic memory');
let clarifyCalls = 0;
const clarified = await interactS2Canvas(active, document, '补个局部', null, [], { invoke: async request => {
  clarifyCalls++; const input = JSON.parse(request.userInput);
  return response(input.stage === 'turn-understand' ? intent : input.stage === 'turn-proposal-review' ? judge('clarify') : answer(badCommands));
} });
assert.equal(clarifyCalls, 3); assert.deepEqual(clarified.commands, []); assert.match(clarified.reply, /请先确认/);

// Users may explicitly change business strategy. This is an Agent judgment, not a keyword ban in code.
const override = '本轮不再要求先审核；只演示原始记录展示，不代表业务通过'; let overrideCalls = 0;
const changed = await interactS2Canvas(active, document, override, null, [], { invoke: async request => {
  overrideCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'turn-understand') return response(intent);
  if (input.stage === 'turn-proposal-review') return response({ verdict: 'accept', reason: '用户明确调整本轮业务策略，仍需用户确认改图',
    evidence: [{ sourceId: 'query', quote: '本轮不再要求先审核' }] });
  return response(answer(badCommands));
} });
assert.equal(overrideCalls, 3); assert.deepEqual(changed.commands, badCommands); assert.equal(JSON.stringify(document), original);
assert.equal(applyS2Commands(definition, document, changed.commands).execution!.links.length, 2, 'Accepted review only permits a proposal; explicit host confirmation remains separate');

for (const mode of ['bad-evidence', 'unknown-field', 'truncated', 'transport', 'abort'] as const) {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(() => interactS2Canvas(active, document, '协作', null, [], { signal: controller.signal, invoke: async request => {
    calls++; const input = JSON.parse(request.userInput);
    if (input.stage === 'turn-understand') return response(intent);
    if (input.stage === 'turn-act') return response(answer(badCommands));
    if (mode === 'transport') throw new Error('synthetic review transport failure');
    if (mode === 'abort') controller.abort();
    const raw = mode === 'bad-evidence' ? { ...judge('accept'), evidence: [{ sourceId: 'query', quote: '伪造的解除要求' }] }
      : mode === 'unknown-field' ? { ...judge('accept'), commands: badCommands } : judge('accept');
    return { ...response(raw), ...(mode === 'truncated' ? { diagnostics: { finishReason: 'length' } } : {}) } as any;
  } }), /来源|复核|截断|transport|停止/);
  assert.equal(calls, 3, 'No transport/truncation/review-format auto retry'); assert.equal(JSON.stringify(document), original);
}
let sharedCalls = 0;
const shared = await interactS2Canvas(active, document, '补个局部', null, [], { invoke: async request => {
  sharedCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'turn-understand') return response(intent);
  if (input.stage === 'turn-proposal-review') return response(judge('revise'));
  return response(input.responseRepair ? answer(badCommands) : { ...answer(badCommands), commands: null });
} });
assert.equal(sharedCalls, 4); assert.deepEqual(shared.commands, [], 'Protocol and semantic fixes share ONE action repair allowance');
for (const commands of [[], [{ op: 'batch-nodes', action: { kind: 'move', nodeIds: ['input'], delta: { x: 50, y: 0 } } }]] as const) {
  let calls = 0;
  const layoutOrReply = await interactS2Canvas(active, document, '解释或移动布局', null, [], { invoke: async request => {
    calls++; const input = JSON.parse(request.userInput); assert.notEqual(input.stage, 'turn-proposal-review');
    return response(input.stage === 'turn-understand' ? intent : answer(commands as any));
  } });
  assert.equal(calls, 2); assert.equal(layoutOrReply.commands.length, commands.length);
}
const large = structuredClone(document);
for (let i = 0; i < 22; i++) large.nodes.push({ id: `note${i}`, type: 'note', position: { x: 0, y: i * 20 }, values: { content: '合成说明'.repeat(170) } });
const edgeCommand: S2AgentReply['commands'] = [{ op: 'add-edge', edge: { id: 'related', source: 'note20', target: 'note21', label: '用户请求关联' } }];
let edgeReviewCalls = 0;
await interactS2Canvas(active, large, '关联最后两个说明块', null, [], { invoke: async request => {
  edgeReviewCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'turn-understand') return response(intent);
  if (input.stage === 'turn-act') return response(answer(edgeCommand));
  assert.equal(input.before.representation, 'indexed-canvas');
  assert.deepEqual(input.before.details.map((node: any) => node.id).sort(), ['note20', 'note21'], 'Review receives bodies of affected semantic-edge endpoints, not merely IDs');
  return response({ verdict: 'accept', reason: 'Synthetic related-block review', evidence: [{ sourceId: 'query', quote: '关联最后两个说明块' }] });
} });
assert.equal(edgeReviewCalls, 3); assert.equal(large.edges.length, 0);
const sources = s2ProposalSources(scene.task, definition, override, 'user', [], memory.context(document));
assert.equal(sources.find(s => s.id === 'query')!.kind, 'user'); assert.equal(sources.find(s => s.id === 'memory-gate')!.text, seedQuery);
for (const invalid of [{ ...judge('accept'), evidence: [] }, { ...judge('accept'), verdict: 'execute' }, { ...judge('clarify'), reply: '' },
  { ...judge('accept'), evidence: [{ sourceId: 'missing', quote: '只展示合格记录' }] }]) assert.throws(() => readS2ProposalReview(invalid, sources));

// First-pass handoff keeps original requirements (not just generated summaries), with source-bound decisions.
const preservedRequirement = { requirement: '保留用户原文', handling: 'preserve' as const, scope: 'session' as const,
  sourceId: 'scene-request', quote: '用户原文必须保留' };
const adjustedRequirement = { requirement: '本轮仅原始预览，不代表审核通过', handling: 'adjust' as const, scope: 'turn' as const,
  sourceId: 'query', quote: '本轮不再要求先审核' };
const decisions = [preservedRequirement, adjustedRequirement]; let firstPassCalls = 0;
const firstPass = await interactS2Canvas(active, document, override, null, [], { invoke: async request => {
  firstPassCalls++; const input = JSON.parse(request.userInput);
  if (input.stage !== 'turn-proposal-review') {
    assert.equal(input.requirementSources.find((s: any) => s.id === 'scene-request').text, scene.task);
    for (const source of input.requirementSources.filter((s: any) => s.contextPath)) {
      assert.equal(source.contextPath.reduce((value: any, key: string | number) => value[key], input), sources.find(s => s.id === source.id)!.text);
      assert.equal(source.text, undefined, 'Do not duplicate protected goal, strategy or memory texts');
    }
  }
  if (input.stage === 'turn-understand') return response({ ...intent, requirementDecisions: decisions });
  assert.deepEqual(input.intent.requirementDecisions, decisions, 'One frozen decision summary reaches action AND independent review');
  return response(input.stage === 'turn-proposal-review' ? { verdict: 'accept', reason: 'Synthetic explicit turn-only change',
    evidence: [{ sourceId: 'query', quote: adjustedRequirement.quote }] } : answer(badCommands));
} });
assert.equal(firstPassCalls, 3, 'No extra planning call, automatic application or execution');
assert.deepEqual(firstPass.commands, badCommands); assert.equal(JSON.stringify(document), original);
assert.deepEqual(readS2TurnIntent({ ...intent, requirementDecisions: decisions }, sources).requirementDecisions, decisions);
for (const badDecision of [
  { ...adjustedRequirement, sourceId: 'strategy-response', quote: '初始view输入留空' },
  { ...preservedRequirement, sourceId: 'unknown' }, { ...preservedRequirement, quote: '伪造的原文' },
  { ...adjustedRequirement, scope: 'permanent' }, { ...adjustedRequirement, allowedTools: ['network'] },
]) assert.throws(() => readS2TurnIntent({ ...intent, requirementDecisions: [badDecision] }, sources));
assert.throws(() => readS2TurnIntent({ ...intent, requirementDecisions: decisions }, s2ProposalSources(scene.task, definition, override, 'host-event', [])), /本轮用户来源/);
assert.throws(() => readS2TurnIntent({ ...intent, requirementDecisions: Array(7).fill(preservedRequirement) }, sources), /超过/);
let badDecisionCalls = 0;
await assert.rejects(() => interactS2Canvas(active, document, override, null, [], { invoke: async () => {
  badDecisionCalls++; return response({ ...intent, requirementDecisions: [{ ...adjustedRequirement, quote: '伪造用户授权' }] });
} }), /真实本轮用户来源/);
assert.equal(badDecisionCalls, 1, 'Forged source fails before tool selection or edit generation');
// Single calls and graph changes must not share a confirmation against different revisions.
const singleDefinition = readS2Definition({ ...definition, plugins: [...definition.plugins!, cap('validate', 'json-check')] });
const singleHost = new S2PluginHost(scene.sceneId, singleDefinition.plugins); singleHost.setDocument(document);
const singleContext = singleHost.prepare('input', { goal: singleDefinition.goal, ...singleDefinition.instructions }, '协作后检查');
const singleRequest = { ...cap('validate', 'json-check'), nodeId: 'input', inputs: { text: [singleContext.bindings[0].artifactId] }, reason: '只检查当前原文格式' };
const combined = { ...answer(goodCommands), pluginRequests: [singleRequest] };
let combinedCalls = 0;
const separated = await interactS2Canvas({ ...active, canvasWorkspace: singleDefinition }, document, '帮我加说明再检查，分开确认', 'input', [], {
  pluginContext: singleContext, invoke: async request => {
    combinedCalls++; const input = JSON.parse(request.userInput);
    if (input.stage === 'turn-understand') return response({ ...intent, actions: ['reply', 'edit', 'execute'] });
    assert.notEqual(input.stage, 'turn-proposal-review', 'An invalid mixed proposal is corrected before semantic review or UI confirmation');
    if (!input.responseRepair) return response(combined);
    assert.match(input.responseRepair.error, /改图与单次插件调用须分开确认/);
    return response({ ...answer([]), pluginRequests: [singleRequest] });
  },
});
assert.equal(combinedCalls, 3); assert.deepEqual(separated.commands, []); assert.deepEqual(separated.pluginRequests, [singleRequest]);
let persistentMixedCalls = 0;
await assert.rejects(() => interactS2Canvas({ ...active, canvasWorkspace: singleDefinition }, document, '协作并检查', 'input', [], {
  pluginContext: singleContext, invoke: async request => {
    persistentMixedCalls++; return response(JSON.parse(request.userInput).stage === 'turn-understand' ? { ...intent, actions: ['reply', 'edit', 'execute'] } : combined);
  },
}), /改图与单次插件调用须分开确认/);
assert.equal(persistentMixedCalls, 3, 'Only the existing one action repair is used');
assert.equal(singleHost.history().length, 0); assert.equal(singleHost.remainingCalls, 64); assert.equal(JSON.stringify(document), original); singleHost.close();
assert.equal(host.history().length, 0); assert.equal(JSON.stringify(document), original); host.close(); memory.close();
console.log('S2 proposal review passed: source-bound independent semantic review of actual before/after, bounded correction/clarification, separate edit/single-call confirmation, shared repair quota, explicit user strategy changes allowed, rejected memory retirement, latest wiring, layout/reply no extra review and transport/truncation/abort/source failure closed. Synthetic model decisions only, NOT real semantic accuracy.');
