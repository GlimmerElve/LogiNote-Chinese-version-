import assert from 'node:assert/strict';
import { createS2Scene } from '../src/services/scene/sceneS2Canvas';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import type { S2Document } from '../src/types/sceneS2';
import { experimentDefinition, experimentRequest } from './fixtures/s2-experiment';
import { harness } from './scene-s2-ui-harness';
import { useGenericS2CanvasUi } from './fixtures/s2-generic-canvas-ui';

// Generic base compatibility: optional name/settings panel without package canvas policy.
// Real Trial handlers, fixed synthetic data and one injected model response.
// No app settings, real files, real provider or semantic acceptance is involved.
const priorFetch = globalThis.fetch; let network = 0;
const restoreCanvasUi = useGenericS2CanvasUi();
globalThis.fetch = async () => { network++; throw new Error('Content-name UI check forbids real IO'); };
const activeUis: ReturnType<typeof harness>[] = [];
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
async function settle(ui: ReturnType<typeof harness>, done: () => boolean) {
  for (let i = 0; i < 300; i++) { ui.render(); if (done()) return; await tick(); }
  assert.fail('Content-name synthetic UI did not settle');
}
const choose = (ui: ReturnType<typeof harness>, id: string) => { ui.labelControl('选择块', 'select').props.onChange({ target: { value: id } }); ui.render(); };
const name = (ui: ReturnType<typeof harness>, value: string) => { ui.labelControl('名称（可选）', 'input').props.onChange({ target: { value } }); ui.render(); };
const content = (ui: ReturnType<typeof harness>, id: string) => ui.flow().props.nodes.find((node: any) => node.id === id);
function document(ui: ReturnType<typeof harness>): S2Document {
  ui.button('导出工作区 JSON 到下方').props.onClick(); ui.render();
  return JSON.parse(ui.labelControl('工作区 JSON', 'textarea').props.value).definition.initial;
}
try {
  const draft = createS2Scene(experimentRequest); draft.canvasWorkspace = structuredClone(experimentDefinition);
  let host!: S2PluginHost, calls = 0;
  const options: Parameters<typeof harness>[0] = { initialRequest: experimentRequest, initialDraft: draft, onHost: value => { host = value; } };
  const ui = harness(options); activeUis.push(ui);
  assert.equal(draft.canvasWorkspace.blockTypes.length, 1); assert.equal(draft.canvasWorkspace.initial.nodes.length, 4);
  assert.ok(draft.canvasWorkspace.initial.nodes.every(node => node.type === 'text'));
  assert.equal(ui.elements().filter(item => item.type === 'button' && ui.text(item).startsWith('＋')).length, 1);
  assert.equal(ui.button('＋内容块').props.disabled, false);
  choose(ui, 'role');
  const original = document(ui), values = structuredClone(original.nodes.find(node => node.id === 'role')!.values);
  const oldBlank = ui.labelControl('名称（可选）', 'input').props.onChange;
  name(ui, '我的角色材料');
  assert.equal(content(ui, 'role').data.title, '我的角色材料');
  assert.ok(ui.text(ui.labelControl('选择块', 'select')).includes('我的角色材料'));
  assert.ok(ui.text(ui.labelControl('查看连接说明', 'select')).includes('我的角色材料'));
  assert.deepEqual(document(ui).execution, original.execution, 'A display name cannot change bindings or topology');
  assert.deepEqual(document(ui).nodes.find(node => node.id === 'role')!.values, values);
  oldBlank({ target: { value: '过期标签不得覆盖' } }); ui.render();
  assert.equal(content(ui, 'role').data.title, '我的角色材料');
  ui.keyShortcut('undo'); ui.render(); assert.equal(content(ui, 'role').data.title, '内容块');
  oldBlank({ target: { value: '撤销后仍不得复活旧入口' } }); ui.render();
  assert.equal(content(ui, 'role').data.title, '内容块', 'History changes retire an old callback even when the old label is restored');
  ui.keyShortcut('redo'); ui.render(); assert.equal(content(ui, 'role').data.title, '我的角色材料');
  const oldSelection = ui.labelControl('名称（可选）', 'input').props.onChange;
  choose(ui, 'task'); oldSelection({ target: { value: '不应从旧选区修改' } }); ui.render();
  assert.equal(content(ui, 'role').data.title, '我的角色材料');
  choose(ui, 'role'); ui.button('批量复制所选（含内部连线）').props.onClick(); ui.render();
  const copied = document(ui).nodes.find(node => !original.nodes.some(source => source.id === node.id))!;
  assert.equal(copied.label, '我的角色材料'); assert.deepEqual(copied.values, values);
  ui.keyShortcut('undo'); ui.render(); assert.equal(document(ui).nodes.length, 4);
  ui.button('开始试验').props.onClick(); ui.render();
  ui.button('关闭助手').props.onClick(); ui.render();
  host.approveModelTestSession(new S2ModelTestSession({ sceneId: draft.sceneId, runId: host.runId, resourceId: 'SyntheticContentNameResource',
    providerId: 'synthetic', providerLabel: 'Synthetic name check', model: 'synthetic-name', limits: { maxRequests: 1, maxOutputTokens: 512, maxReservedOutputTokens: 512 },
    invoke: async request => { calls++; assert.ok(!JSON.stringify(request).includes('我的角色材料')); assert.ok(!JSON.stringify(request).includes('等待中改名'));
      assert.ok(request.systemPromptOverride?.includes(values.content)); return { content: '名称不改变本次完整返回', diagnostics: { finishReason: 'stop' } }; } }));
  ui.render(); ui.button('运行全部步骤').props.onClick();
  await settle(ui, () => host.waitingModelTests().length === 1);
  const wait = host.waitingModelTests()[0];
  choose(ui, 'role'); name(ui, '等待中改名');
  assert.equal(host.waitingModelTests()[0].id, wait.id); assert.equal(host.waitingModelTests()[0].prompt, wait.prompt);
  assert.equal(host.waitingModelTests()[0].revision, wait.revision); assert.equal(calls, 0);
  ui.button('确认发送本次模型请求').props.onClick(); await settle(ui, () => host.workflowHistory().at(-1)?.status === 'succeeded');
  assert.equal(calls, 1); name(ui, '已完成后改名');
  assert.equal(host.workflowHistory().at(-1)?.publication, 'current', 'Display-only renaming cannot retire completed execution');
  assert.equal(content(ui, 'showResult').data.status, 'displayed');
  assert.deepEqual(document(ui).execution, original.execution); assert.equal(ui.modelCalls(), 0);
  ui.button('保存场景').props.onClick(); await settle(ui, () => ui.saved.length === 1);
  const saved = ui.saved[0]; assert.equal(saved.canvasWorkspace.initial.nodes.find((node: any) => node.id === 'role').label, '已完成后改名');
  assert.ok(!JSON.stringify(saved).includes('名称不改变本次完整返回')); assert.ok(!JSON.stringify(saved).includes('SyntheticContentNameResource'));
  const afterEnd = ui.labelControl('名称（可选）', 'input').props.onChange;
  ui.button('结束试验').props.onClick(); ui.render(); afterEnd({ target: { value: '结束后不得修改' } }); ui.render();
  assert.equal(content(ui, 'role').data.title, '已完成后改名');

  let reopenedHost!: S2PluginHost;
  const reopened = harness({ initialRequest: { ...experimentRequest, source: 'existing', sceneId: saved.sceneId }, initialDraft: saved,
    onHost: value => { reopenedHost = value; } }); activeUis.push(reopened);
  choose(reopened, 'role'); assert.equal(reopened.labelControl('名称（可选）', 'input').props.value, '已完成后改名');
  assert.equal(content(reopened, 'role').data.fields[0].value, values.content);
  reopened.button('开始试验').props.onClick(); reopened.render(); assert.equal(reopenedHost.modelTestSummary(), null); assert.equal(reopenedHost.history().length, 0);

  const legacy = structuredClone(saved); for (const node of legacy.canvasWorkspace.initial.nodes) delete node.label;
  const legacyOptions: Parameters<typeof harness>[0] = { initialDraft: legacy, initialRequest: { ...experimentRequest, subject: '旧模板无名称' } };
  const old = harness(legacyOptions); activeUis.push(old); choose(old, 'role');
  assert.equal(old.labelControl('名称（可选）', 'input').props.value, ''); assert.equal(content(old, 'role').data.title, '内容块');
  const otherSceneHandler = old.labelControl('名称（可选）', 'input').props.onChange;
  legacyOptions.initialDraft = { ...structuredClone(legacy), sceneId: 'scene-s2-other-name-test' };
  legacyOptions.initialRequest = { ...experimentRequest, subject: '切换到另一场景' }; old.render(); choose(old, 'role');
  otherSceneHandler({ target: { value: '旧场景不得修改新状态' } }); old.render(); assert.equal(content(old, 'role').data.title, '内容块');
  assert.equal(network, 0);
  console.log('S2 generic-base content-name UI compatibility passed (optional canvas policy omitted): one generic text type, optional Chinese names in preview/running, synchronized node/selector/connection labels, unchanged content/bindings/request, pending and completed runs remain current, undo/redo/copy/save/reopen/legacy compatibility, and stale selection/history/scene/end callbacks rejected. Synthetic handlers and transport only.');
} finally { activeUis.forEach(ui => ui.dispose()); restoreCanvasUi(); globalThis.fetch = priorFetch; }
