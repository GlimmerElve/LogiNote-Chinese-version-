import assert from 'node:assert/strict';
import type { SceneInitialRequest } from '../src/types';
import { createS2Scene } from '../src/services/scene/sceneS2Canvas';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { harness } from './scene-s2-ui-harness';

const previousFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Synthetic model UI cannot access network'); };
const request: SceneInitialRequest = { source: 'custom', sceneSkill: 'S2', subject: 'Synthetic approved model test', knowledgePoints: [] };
const draft = createS2Scene(request);
const prompt = '只分析我给的合成资料，不调用工具。\n原样保留空白与 $&。';
draft.canvasWorkspace!.plugins = [{ pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate' }];
draft.canvasWorkspace!.initial.nodes[0].values.content = prompt;
draft.canvasWorkspace!.initial.execution = { version: 1, nodes: [{ id: 'trial', pluginId: 'model-test', pluginVersion: '1.0.0', capabilityId: 'generate',
  position: { x: 400, y: 0 }, bindings: { prompt: { kind: 'field', nodeId: 'goal', fieldId: 'content' }, input: { kind: 'literal', value: '  合成输入\n保留格式  ' } } }], links: [] };
async function settle(ui: ReturnType<typeof harness>, done: () => boolean) {
  for (let i = 0; i < 400; i++) { ui.render(); if (done()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Synthetic model UI did not settle');
}
const uis: ReturnType<typeof harness>[] = [];
try {
  let host!: S2PluginHost, actualCalls = 0, preparations = 0, sessions = 0;
  const ui = harness({ initialRequest: request, initialDraft: draft, onHost: value => { host = value; }, modelProvider: async () => {
    preparations++;
    return { providerLabel: 'Synthetic provider', model: 'synthetic-model', resourceId: 'SyntheticModelResource', supportsImages: false,
      createSession(sceneId, runId, limits) {
        sessions++;
        return new S2ModelTestSession({ sceneId, runId, limits, resourceId: 'SyntheticModelResource', providerId: 'synthetic', providerLabel: 'Synthetic provider', model: 'synthetic-model',
          invoke: async request => {
            actualCalls++;
            assert.equal(request.systemPromptOverride, prompt); assert.equal(request.userInput, '  合成输入\n保留格式  ');
            assert.equal(request.workflow, 'scene-model-experiment'); assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
            return { content: 'Synthetic complete response\n第二行', diagnostics: { finishReason: 'stop' }, usage: { promptTokens: 12, completionTokens: 8 } };
          } });
      } };
  } }); uis.push(ui);
  assert.equal(ui.button('准备本局模型测试（不发送）').props.disabled, true);
  ui.button('开始试验').props.onClick(); ui.render();
  ui.button('运行全部步骤').props.onClick(); ui.render();
  assert.ok(ui.text().includes('尚未单独批准')); assert.equal(actualCalls, 0); assert.equal(host.modelTestSummary(), null);
  ui.button('准备本局模型测试（不发送）').props.onClick(); await settle(ui, () => ui.text().includes('核对并批准本局预算'));
  assert.equal(preparations, 1); assert.equal(sessions, 0); assert.equal(actualCalls, 0);
  for (const [label, value] of [['模型请求次数上限', '1'], ['单次输出 tokens 上限', '512'], ['总预留输出 tokens 上限', '512']]) {
    ui.labelControl(label, 'input').props.onChange({ target: { value } }); ui.render();
  }
  const approve = ui.button('批准本局模型测试预算（仍逐次确认）').props.onClick;
  approve(); ui.render(); assert.equal(sessions, 1); assert.equal(actualCalls, 0); assert.equal(host.modelTestSummary()!.usedRequests, 0);
  ui.button('运行全部步骤').props.onClick(); await settle(ui, () => host.waitingModelTests().length === 1);
  assert.equal(actualCalls, 0); assert.ok(ui.text().includes(prompt));
  assert.ok(ui.text().includes('完整待测提示词')); assert.ok(ui.text().includes('实际输出上限 512 tokens'));
  assert.ok(ui.text().includes('确认后才发送，可能产生费用'));
  ui.button('拒绝本次模型请求').props.onClick(); await settle(ui, () => host.workflowHistory().at(-1)!.status === 'failed');
  assert.equal(actualCalls, 0); assert.equal(host.modelTestSummary()!.usedRequests, 0);
  ui.button('运行全部步骤').props.onClick(); await settle(ui, () => host.waitingModelTests().length === 1);
  const send = ui.button('确认发送本次模型请求').props.onClick;
  send(); send(); ui.render();
  await settle(ui, () => host.workflowHistory().at(-1)!.status === 'succeeded');
  assert.equal(actualCalls, 1); assert.equal(host.modelTestSummary()!.usedRequests, 1); assert.equal(host.modelTestSummary()!.reservedOutputTokens, 512);
  assert.equal(host.modelTestSummary()!.records[0].outputComplete, true);
  ui.button('保存场景').props.onClick(); await settle(ui, () => ui.saved.length === 1);
  const saved = JSON.stringify(ui.saved[0]);
  assert.ok(!saved.includes('Synthetic complete response') && !saved.includes('SyntheticModelResource') && !saved.includes('maxReservedOutputTokens'), 'Template never gains runtime output, provider resource or budget authority');
  ui.button('运行全部步骤').props.onClick(); await settle(ui, () => host.workflowHistory().at(-1)!.status === 'failed');
  assert.equal(actualCalls, 1, 'Exhausted budget never sends another request or substitutes cached model output');
  ui.button('撤回模型测试权限').props.onClick(); ui.render();
  assert.equal(host.modelTestSummary()!.active, false); assert.equal(host.modelTestSummary()!.usedRequests, 1);
  approve(); ui.render(); assert.equal(sessions, 1); assert.equal(actualCalls, 1, 'A captured old authorization handler cannot reset budget');
  ui.button('结束试验').props.onClick(); ui.render(); assert.equal(host.waitingModelTests().length, 0);

  // Auto-close must produce visible terminal node reasons, not disappear from
  // the confirmation panel while leaving another workflow permanently waiting.
  const excessDraft = structuredClone(draft);
  excessDraft.canvasWorkspace!.initial.execution!.nodes.push({ ...structuredClone(excessDraft.canvasWorkspace!.initial.execution!.nodes[0]), id: 'trialTwo' });
  let excessHost!: S2PluginHost, excessCalls = 0;
  const excess = harness({ initialRequest: request, initialDraft: excessDraft, onHost: value => { excessHost = value; }, modelProvider: async () => ({
    providerLabel: 'Synthetic overusage provider', model: 'synthetic-model', resourceId: 'SyntheticOverusageResource', supportsImages: false,
    createSession: (sceneId, runId, limits) => new S2ModelTestSession({ sceneId, runId, limits, resourceId: 'SyntheticOverusageResource', providerId: 'synthetic', providerLabel: 'Synthetic overusage provider', model: 'synthetic-model',
      invoke: async () => { excessCalls++; return { content: 'Synthetic overusage only', usage: { promptTokens: 8, completionTokens: 513 }, diagnostics: { finishReason: 'stop' } }; } }),
  }) }); uis.push(excess);
  excess.button('开始试验').props.onClick(); excess.render();
  excess.button('准备本局模型测试（不发送）').props.onClick(); await settle(excess, () => excess.text().includes('核对并批准本局预算'));
  excess.labelControl('单次输出 tokens 上限', 'input').props.onChange({ target: { value: '512' } }); excess.render();
  excess.button('批准本局模型测试预算（仍逐次确认）').props.onClick(); excess.render();
  excess.button('运行全部步骤').props.onClick(); await settle(excess, () => excessHost.waitingModelTests().length === 2);
  excess.button('确认发送本次模型请求').props.onClick(); await settle(excess, () => excessHost.workflowHistory().at(-1)!.status === 'failed');
  assert.equal(excessCalls, 1); assert.equal(excessHost.waitingModelTests().length, 0);
  assert.equal(excessHost.modelTestSummary()!.active, false); assert.equal(excessHost.modelTestSummary()!.usedRequests, 1);
  assert.equal(excessHost.modelTestSummary()!.reservedOutputTokens, 512);
  assert.ok(excess.text().includes('本局授权已关闭') && excess.text().includes('超过本次请求上限'));
  assert.ok(excessHost.workflowHistory().at(-1)!.nodes.every(node => !['pending', 'running', 'waiting'].includes(node.status)));

  let release!: (value: Awaited<ReturnType<NonNullable<Parameters<typeof harness>[0]['modelProvider']>>>) => void;
  const late = harness({ initialRequest: request, initialDraft: draft, modelProvider: async signal => {
    return await new Promise(resolve => { release = resolve; assert.equal(signal?.aborted, false); });
  } }); uis.push(late);
  late.button('开始试验').props.onClick(); late.render(); late.button('准备本局模型测试（不发送）').props.onClick(); late.render();
  late.dispose(); release({ providerLabel: 'Late synthetic', model: 'synthetic', resourceId: 'LateResource', supportsImages: false, createSession: () => { assert.fail('Late preparation cannot authorize a session'); } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(networkAttempts, 0);
  console.log('S2 model UI passed: real production prepare/approval/wait/send/reject/revoke/end handlers, exact original request, zero calls before explicit confirmation, one-use confirmation, strict budget/no replay or model cache, template authority exclusion and late-prepare abort. Synthetic injected transport only; NOT browser, live model or semantic acceptance.');
} finally { uis.forEach(ui => ui.dispose()); globalThis.fetch = previousFetch; }
