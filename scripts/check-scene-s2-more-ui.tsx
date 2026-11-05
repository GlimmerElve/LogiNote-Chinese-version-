import assert from 'node:assert/strict';
import { createS2Scene } from '../src/services/scene/sceneS2Canvas';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { experimentMaterialDefinition, experimentMaterialRequest } from './fixtures/s2-experiment';
import { harness } from './scene-s2-ui-harness';

const previousFetch = globalThis.fetch; globalThis.fetch = async () => assert.fail('More UI checks prohibit network');
const request = { ...experimentMaterialRequest, interactionPack: { id: 'prompt-lab', version: '0.1.0' } };
const scene = { ...createS2Scene(request), canvasWorkspace: structuredClone(experimentMaterialDefinition) };
let host!: S2PluginHost, modelCalls = 0;
const ui = harness({ initialRequest: request, initialDraft: scene, onHost(value) { host = value; } });
async function settle(test: () => boolean) { for (let i = 0; i < 300 && !test(); i++) { await new Promise(resolve => setImmediate(resolve)); ui.render(); } assert(test()); }
const choose = (value: string) => { ui.inline('material').elements().find(item => item.type === 'input' && item.props.type === 'file')!.props.onChange({ target: { files: [new File([value], '材料.md', { type: 'text/plain' })], value: 'selected' } }); ui.render(); };
function visibleText(value: any): string {
  if (Array.isArray(value)) return value.map(visibleText).join('');
  if (value == null || typeof value === 'boolean') return '';
  if (typeof value !== 'object') return String(value);
  if (value.props?.hidden) return '';
  return visibleText(value.children ?? value.props?.children);
}
try {
  const baseRequest = { ...request, source: 'custom' as const, interactionPack: null };
  const base = harness({ initialRequest: baseRequest, initialDraft: createS2Scene(baseRequest), onHost() { assert.fail('Adding a component cannot create a running session'); } });
  try {
    const select = base.labelControl('添加的执行能力', 'select');
    assert(base.elements(select).some(item => item.type === 'option' && item.props.value === 'structured-data@1.0.0/parse-json'));
    select.props.onChange({ target: { value: 'structured-data@1.0.0/parse-json' } }); base.render();
    base.button('添加执行节点').props.onClick(); base.render();
    assert(base.flow().props.nodes.some((node: any) => node.data.node?.pluginId === 'structured-data' && node.data.node?.capabilityId === 'parse-json'));
  } finally { base.dispose(); }
  choose('第一次材料');
  const notify = () => ui.resourceElement('material').props.onChange();
  host.approveModelTestSession(new S2ModelTestSession({ sceneId: scene.sceneId, runId: host.runId, resourceId: 'SyntheticMoreResource', providerId: 'synthetic',
    providerLabel: '合成服务', model: 'synthetic-more', limits: { maxRequests: 4, maxReservedOutputTokens: 8192, maxOutputTokens: 2048 },
    invoke: async input => { modelCalls++; assert.equal(input.userInput, '更新后的材料'); return { content: '合成完整结果', diagnostics: { finishReason: 'stop' } }; } }));
  // This intentionally exercises the pending-request fallback, not the package's direct Test action.
  const first = host.enqueueWorkflow(['testModel', 'showResult'], notify);
  await settle(() => host.waitingModelTests().length === 1);
  const originalWait = host.waitingModelTests()[0].id;
  const oldConfirm = ui.inline('testModel').button('确认发送本次模型请求').props.onClick;
  assert.equal(ui.inline('testModel').elements().filter(item => item.type === 'fieldset' && String(item.props['aria-label']).startsWith('确认模型请求')).length, 1);
  assert.equal(ui.flow().props.nodes.find((node: any) => node.id === 'showResult').data.nodeInteractionInput, undefined, 'Wait UI is scoped to its exact node');
  ui.button('更多').props.onClick(); ui.render();
  const more = ui.elements().find(item => item.props['aria-label'] === '画布操作面板')!;
  const text = visibleText(more);
  for (const term of ['批量删除所选', '整体右移', '整体下移', 'AI 重新设计初稿', '确认本局能力范围', '实验预期与评价标准', '设计理解与互动分工', '提供本局资料', '模型测试 · 独立授权', '确认发送本次模型请求', '本局插件记录', '内容关联目标', '材料传递连接']) assert(!text.includes(term), term);
  for (const term of ['复制所选', '组合与蓝图管理', '多选与分组', '工作区导入／导出', '可复用子图打包／粘贴', '开发诊断']) assert(text.includes(term), term);
  assert.equal(modelCalls, 0); assert.equal(host.waitingModelTests()[0].id, originalWait);
  const diagnosticToggle = ui.elements().find(item => item.type === 'input' && item.props.type === 'checkbox' && typeof item.props.checked === 'boolean')!;
  diagnosticToggle.props.onChange({ target: { checked: true } }); ui.render();
  ui.button('查看连接与技术说明').props.onClick(); ui.render();
  assert(visibleText(ui.elements().find(item => item.props['aria-label'] === '画布操作面板')).includes('模型测试 · 独立授权'));
  assert.equal(modelCalls, 0, 'Diagnostics never sends or grants a request');
  choose('更新后的材料'); oldConfirm(); ui.render();
  assert.equal(modelCalls, 0, 'A retired confirmation cannot send after inputs change');
  host.cancelWorkflow(first.id); await first.completion;
  const fresh = host.enqueueWorkflow(['testModel', 'showResult'], notify); await settle(() => host.waitingModelTests().length === 1);
  const confirm = ui.inline('testModel').button('确认发送本次模型请求').props.onClick;
  confirm(); confirm(); await fresh.completion; ui.render();
  assert.equal(modelCalls, 1); assert.equal(host.workflowHistory().at(-1)!.status, 'succeeded');
  assert.equal(host.modelTestSummary()!.usedRequests, 1); assert.deepEqual(host.waitingModelTests(), []);
  const rejected = host.enqueueWorkflow(['testModel'], notify); await settle(() => host.waitingModelTests().length === 1);
  const late = ui.inline('testModel').button('确认发送本次模型请求').props.onClick;
  ui.inline('testModel').button('拒绝本次模型请求').props.onClick(); await rejected.completion; ui.render(); assert.equal(modelCalls, 1);
  ui.dispose(); late(); assert.equal(modelCalls, 1, 'Unmounted pending controls never revive a request');
  console.log('S2 More UI passed: generic build/export/diagnostic tools only; no duplicate business/connection/movement controls; node-scoped model wait fallback, unchanged waiting state while opening diagnostics, stale/duplicate/reject/end guards and real synthetic request-to-result execution. No network or real model.');
} finally { ui.dispose(); globalThis.fetch = previousFetch; }
