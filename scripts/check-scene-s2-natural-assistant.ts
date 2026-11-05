import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import type { S2TurnIntent } from '../src/services/scene/sceneS2Turn';
import { createS2Scene, interactS2Canvas, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { S2_PLUGIN_PROTOCOL_RULES } from '../src/services/scene/sceneS2PluginProtocol';
import { S2_WORKFLOW_AGENT_RULES } from '../src/services/scene/sceneS2Workflow';
import { experimentDefinition, experimentRequest } from './fixtures/s2-experiment';

// Intent replies here are deliberately synthetic. This checks the real service's
// ordering, scoped recall, proposal boundaries and repairs, NOT model semantics.
const previousFetch = globalThis.fetch; let forbiddenIo = 0;
globalThis.fetch = async () => { forbiddenIo++; throw new Error('Natural-assistant fixture forbids network'); };
const fixture = structuredClone(experimentDefinition);
fixture.plugins = fixture.plugins!.filter(ref => ref.capabilityId === 'compose' || ref.pluginId === 'structured-view');
fixture.initial.execution!.nodes = fixture.initial.execution!.nodes.filter(node => node.id === 'assemble' || node.id === 'showResult');
fixture.initial.execution!.links = [{ source: { nodeId: 'assemble', portId: 'text' }, target: { nodeId: 'showResult', portId: 'text' } }];
fixture.criteria = [{ id: 'KeepRole', label: '保留角色部分', expectation: '本次实际组装结果保留角色前缀', method: 'local', required: true,
  target: { nodeId: 'assemble', portId: 'text' }, rule: { kind: 'text-includes', value: '角色：' } }];
const definition = readS2Definition(fixture), document = definition.initial;
const scene = createS2Scene(experimentRequest); scene.canvasWorkspace = definition;
const host = new S2PluginHost(scene.sceneId, definition); host.setDocument(document);
const snapshot = () => JSON.stringify({ scene, document, history: host.history(), workflows: host.workflowHistory(), calls: host.remainingCalls });
const response = (value: unknown): LlmCallResponse => ({ content: JSON.stringify(value) });
const intent = (extra: Partial<S2TurnIntent> = {}): S2TurnIntent => ({ understanding: '理解本轮自然表达', desiredOutcome: '围绕真实对象解释，不自动操作',
  actions: ['reply'], constraints: ['不自动运行'], questions: [], evaluation: 'advice', ...extra });
const reply = (text: string, extra: object = {}) => ({ understanding: '已按本轮语义理解', plan: '只回应，操作另行确认', reply: text, commands: [], ...extra });
function semanticFirst(request: LlmCallRequest) {
  const input = JSON.parse(request.userInput);
  assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
  if (input.stage === 'turn-understand') {
    assert.equal(input.pluginCatalog, undefined); assert.equal(input.pluginContext, undefined);
    assert.ok(request.systemPromptOverride!.includes('先理解用户真正要什么，不选择插件、不匹配工具'));
    assert.ok(!request.systemPromptOverride!.includes(S2_PLUGIN_PROTOCOL_RULES));
    assert.ok(!request.systemPromptOverride!.includes(S2_WORKFLOW_AGENT_RULES), 'Operation protocol cannot precede semantic understanding');
  }
  return input;
}
try {
  const query = '我没看懂这里的角色文字为什么要这么写，拿生活中的事情解释一下，先别动我的画布。';
  const stages: string[] = [], beforeExplanation = snapshot();
  const explained = await interactS2Canvas(scene, document, query, 'role', [], { pluginContext: host.prepare('role', { goal: definition.goal, ...definition.instructions }, query),
    invoke: async request => {
      const input = semanticFirst(request); stages.push(input.stage);
      if (input.stage === 'turn-understand') return response(intent({ recall: { messageIds: [], nodeIds: [], fields: [{ nodeId: 'role', fieldId: 'content' }], invocationIds: [], workflowRunIds: [] } }));
      assert.equal(input.stage, 'turn-act'); assert.deepEqual(input.intent.actions, ['reply']);
      assert.equal(input.recalledContext.items.find((item: any) => item.kind === 'field').value, document.nodes.find(node => node.id === 'role')!.values.content);
      assert.ok(!request.systemPromptOverride!.includes(S2_WORKFLOW_AGENT_RULES));
      return response(reply('就像请一位老师讲课，角色文字是在说明希望以什么身份回答；这里只解释，没有修改。'));
    } });
  assert.deepEqual(stages, ['turn-understand', 'turn-act']); assert.deepEqual(explained.commands, []); assert.equal(snapshot(), beforeExplanation);

  // The user, not the assistant, has already run the pure local assembly.
  const run = await host.enqueueWorkflow(['showResult']).completion; assert.equal(run.status, 'succeeded');
  const execution = host.history().find(item => item.request.nodeId === 'assemble')!, artifact = execution.artifacts[0];
  assert.equal(artifact.payload.kind, 'inline'); const rawResult = (artifact.payload as { value: string }).value;
  const beforeResultDiscussion = snapshot(), analysisStages: string[] = [];
  const analyzeQuery = '对照刚才的真实结果看看有没有保留角色那一段，按约定标准核对；不需要替我再运行。';
  const analyzed = await interactS2Canvas(scene, document, analyzeQuery, null, [], {
    pluginContext: host.prepare(null, { goal: definition.goal, ...definition.instructions }, analyzeQuery), invoke: async request => {
      const input = semanticFirst(request); analysisStages.push(input.stage);
      if (input.stage === 'turn-understand') {
        assert.ok(input.evidenceIndex.artifacts.some((item: any) => item.id === artifact.id));
        assert.ok(input.evidenceIndex.trials.some((item: any) => item.id === execution.receipt.invocationId));
        return response(intent({ evaluation: 'criteria', recall: { messageIds: [], nodeIds: [], fields: [{ nodeId: 'role', fieldId: 'content' }],
          invocationIds: [], workflowRunIds: [run.id], artifactIds: [artifact.id], trialIds: [execution.receipt.invocationId] } }));
      }
      const recalled = input.recalledContext;
      assert.deepEqual(recalled.unavailable, []); assert.equal(recalled.items.find((item: any) => item.kind === 'artifact').value.text, rawResult);
      const trial = recalled.items.find((item: any) => item.kind === 'trial').value;
      assert.equal(trial.inputs.part1[0].text, document.nodes.find(node => node.id === 'role')!.values.content);
      assert.equal(trial.outputs.text[0].text, rawResult); assert.equal(trial.historicalOnly, true);
      assert.equal(recalled.items.find((item: any) => item.kind === 'workflow').value.id, run.id);
      return response(reply('只核对这次真实组装结果，不据此推断整个实验目标达成。', { assessment: { criterionIds: ['KeepRole'] } }));
    } });
  assert.deepEqual(analysisStages, ['turn-understand', 'turn-act']); assert.equal(analyzed.assessment!.checks[0].verdict, 'met');
  assert.equal(analyzed.executionRequest, undefined); assert.equal(snapshot(), beforeResultDiscussion, 'Recall/analysis never reruns tools or changes the canvas');

  const editQuery = '帮我往任务那块写一个通俗的解释例子，我看完确认再应用，不要运行。';
  const editStages: string[] = [], beforeProposal = snapshot(), suggested = '请用图书馆找书的例子解释检索。';
  const proposed = await interactS2Canvas(scene, document, editQuery, 'task', [], { pluginContext: host.prepare('task', { goal: definition.goal, ...definition.instructions }, editQuery),
    invoke: async request => {
      const input = semanticFirst(request); editStages.push(input.stage);
      if (input.stage === 'turn-understand') return response(intent({ actions: ['reply', 'edit'], assistance: 'demonstrate' }));
      if (input.stage === 'turn-proposal-review') {
        assert.equal(input.proposalOnly, true); assert.ok(input.sources.some((source: any) => source.id === 'query' && source.text === editQuery));
        return response({ verdict: 'accept', reason: '只提出用户请求的任务文字修改，等待确认', evidence: [{ sourceId: 'query', quote: '帮我往任务那块写一个通俗的解释例子' }] });
      }
      assert.equal(input.stage, 'turn-act'); assert.deepEqual(input.intent.actions, ['reply', 'edit']);
      assert.ok(request.systemPromptOverride!.includes(S2_WORKFLOW_AGENT_RULES), 'Only semantically requested collaboration compiles edit instructions');
      return response(reply('可以先写成下面这个例子，等你确认应用。', { commands: [{ op: 'update-node', id: 'task', values: { content: suggested } }] }));
    } });
  assert.deepEqual(editStages, ['turn-understand', 'turn-act', 'turn-proposal-review']);
  assert.equal(proposed.commands.length, 1); assert.equal(proposed.executionRequest, undefined); assert.equal(snapshot(), beforeProposal, 'Accepted proposal is still not an applied edit or execution');

  for (const repairSucceeds of [true, false]) {
    const calls: string[] = [], before = snapshot(); let actionCalls = 0;
    const operation = () => interactS2Canvas(scene, document, '只是说说这样写的好坏，暂时不要替我改。', 'task', [], { invoke: async request => {
      const input = semanticFirst(request); calls.push(input.stage);
      if (input.stage === 'turn-understand') return response(intent());
      assert.equal(input.stage, 'turn-act'); actionCalls++;
      if (actionCalls === 2) { assert.ok(input.responseRepair.error.includes('不包含改图')); assert.deepEqual(input.intent.actions, ['reply']); }
      return response(reply('合成协议回复', { commands: repairSucceeds && actionCalls === 2 ? [] : [{ op: 'update-node', id: 'task', values: { content: '不得应用' } }] }));
    } });
    if (repairSucceeds) assert.deepEqual((await operation()).commands, []); else await assert.rejects(operation, /本轮意图不包含改图/);
    assert.deepEqual(calls, ['turn-understand', 'turn-act', 'turn-act']); assert.equal(snapshot(), before, 'One repair cannot expand semantic action permissions');
  }

  const clarifyStages: string[] = [], beforeClarification = snapshot(), question = '你指的是哪一个内容块，想调整文字还是连接方式？';
  const unclear = await interactS2Canvas(scene, document, '把那个改一下，还是按刚才的意思。', null, [], { invoke: async request => {
    const input = semanticFirst(request); clarifyStages.push(input.stage);
    if (input.stage === 'turn-understand') return response(intent({ understanding: '缺少可以可靠确定的对象和改法', desiredOutcome: '先确认真实对象', questions: [question] }));
    assert.deepEqual(input.intent.questions, [question]); assert.deepEqual(input.intent.actions, ['reply']);
    return response(reply(question));
  } });
  assert.deepEqual(clarifyStages, ['turn-understand', 'turn-act']); assert.equal(unclear.reply, question); assert.deepEqual(unclear.commands, []);
  assert.equal(unclear.pluginRequests, undefined); assert.equal(unclear.executionRequest, undefined); assert.equal(snapshot(), beforeClarification);
  assert.equal(forbiddenIo, 0);
  console.log('S2 natural assistant passed: real understand-before-catalogue/action protocol, semantically selected exact field/result/workflow/trial recall and local criteria analysis, natural collaboration returns a reviewed uncommitted proposal, explanation forbids edits with one bounded repair, missing targets clarify without execution. Synthetic intent/reply fixtures only; NOT real semantic accuracy or UI acceptance.');
} finally { host.close(); globalThis.fetch = previousFetch; }
