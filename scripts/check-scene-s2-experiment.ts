import assert from 'node:assert/strict';
import type { LlmCallRequest } from '../src/types';
import { createS2Scene, readS2Scene } from '../src/services/scene/sceneS2Canvas';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { harness } from './scene-s2-ui-harness';
import { experimentDefinition, experimentImageDefinition, experimentMaterialDefinition, experimentRequest, experimentImageRequest, experimentMaterialRequest,
  SYNTHETIC_EXPERIMENT_PNG, SYNTHETIC_EXPERIMENT_TEXT } from './fixtures/s2-experiment';

// Run actual production Trial handlers and the local plugin host. Only the model
// transport and child component renderers are synthetic; no real IO is allowed.
const priorFetch = globalThis.fetch; let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Synthetic experiment forbids network'); };
const interfaces: ReturnType<typeof harness>[] = [], restored: S2PluginHost[] = [];
async function settle(ui: ReturnType<typeof harness>, done: () => boolean) {
  for (let attempt = 0; attempt < 400; attempt++) {
    ui.render(); if (done()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('User-led experiment did not settle');
}
function edit(ui: ReturnType<typeof harness>, nodeId: string, text: string) {
  const node = ui.flow().props.nodes.find((item: any) => item.id === nodeId);
  assert.ok(node, nodeId); const field = node.data.fields.find((item: any) => item.id === 'content');
  assert.equal(typeof field.startEdit, 'function', 'Prompt text opens a validated block-local editor');
  field.startEdit(); ui.render();
  const editing = ui.flow().props.nodes.find((item: any) => item.id === nodeId).data.fields.find((item: any) => item.id === 'content');
  assert.equal(editing.editor.props.variant, 'inline');
  editing.editor.props.onSubmit({ version: 1, kind: 'field-submit', nodeId, fieldId: field.id, previousValue: field.value, value: text });
  editing.editor.props.onDone(); ui.render();
}
try {
  for (const source of ['text', 'image', 'material'] as const) {
    const withImage = source === 'image', withMaterial = source === 'material';
    const request = withImage ? experimentImageRequest : withMaterial ? experimentMaterialRequest : experimentRequest;
    const definition = structuredClone(withImage ? experimentImageDefinition : withMaterial ? experimentMaterialDefinition : experimentDefinition);
    const draft = createS2Scene(request); draft.canvasWorkspace = definition;
    const calls: LlmCallRequest[] = [];
    let host!: S2PluginHost, preparations = 0, sessions = 0;
    const ui = harness({ initialRequest: request, initialDraft: draft, onHost: value => { host = value; }, modelProvider: async () => {
      preparations++;
      return { providerLabel: '合成实验服务', model: 'synthetic-vision-model', resourceId: 'SyntheticExperimentResource', supportsImages: true,
        createSession(sceneId, runId, limits) {
          sessions++;
          return new S2ModelTestSession({ sceneId, runId, limits, resourceId: 'SyntheticExperimentResource', providerId: 'synthetic-experiment',
            providerLabel: '合成实验服务', model: 'synthetic-vision-model', supportsImages: true, invoke: async actual => {
              calls.push(structuredClone(actual));
              return { content: `  第 ${calls.length} 轮原始返回\n<script>只是文本，不执行</script>  `,
                diagnostics: { finishReason: 'stop' }, usage: { promptTokens: 40, completionTokens: 16 } };
            } });
        } };
    } }); interfaces.push(ui);
    assert.equal(readS2Scene(draft).business, undefined);
    assert.equal(readS2Scene(draft).criteria?.length, 1, 'Expected effect is optional root data, not a mandatory business package');
    assert.deepEqual(definition.blockTypes.map(type => type.id), ['text']);
    assert.ok(definition.initial.nodes.every(node => node.type === 'text'));
    assert.equal(definition.initial.execution!.nodes.filter(node => node.pluginId === 'text-template').length, 1,
      'Assembly is one actual execution node, not a pipeline hidden in a composite');
    assert.equal(definition.initial.execution!.nodes.find(node => node.id === 'assemble')?.capabilityId, 'compose');
    assert.ok(!definition.initial.execution!.nodes.some(node => ['bind', 'render'].includes(node.capabilityId)));
    assert.equal(definition.initial.composites?.length ?? 0, 0);
    assert.equal(ui.elements().filter(item => item.type === 'button' && ui.text(item).startsWith('＋')).length, 1);
    assert.equal(ui.button('＋内容块').props.disabled, false, 'Role/task/format are ordinary interchangeable content, not separate block types');
    ui.button('开始试验').props.onClick(); ui.render();
    ui.button('关闭助手').props.onClick(); ui.render();
    const role = '  我随便写的角色\n$& {{not-an-instruction}}  ';
    const task = '这个任务可能不够好，也必须原样发送。';
    const format = '只返回一行；这是用户的原文。';
    const input = withMaterial ? SYNTHETIC_EXPERIMENT_TEXT : '  待处理材料\n保留首尾空白  ';
    edit(ui, 'role', role); edit(ui, 'task', task); edit(ui, 'constraints', format);
    if (!withMaterial) edit(ui, 'testInput', input);
    assert.equal(calls.length, 0); assert.equal(ui.modelCalls(), 0);
    let imageId: string | undefined;
    if (withImage) {
      const file = new File([Uint8Array.from(atob(SYNTHETIC_EXPERIMENT_PNG), char => char.charCodeAt(0))], '合成原图.png', { type: 'image/png' });
      const selected = await host.approveImageFile(file); imageId = selected.id;
      const controls = ui.flow().props.nodes.find((node: any) => node.id === 'picture').data.nodeControls;
      const imagePanel = ui.elements(controls).find(item => item.type === 'image-materials'); assert.ok(imagePanel);
      assert.equal(imagePanel.props.selectedNodeId, 'picture'); assert.equal(imagePanel.props.active, true);
      assert.equal(imagePanel.props.compact, true); assert.equal(imagePanel.props.autoBind, true);
      assert.equal(imagePanel.props.isCurrent(), true);
      imagePanel.props.onBind(imageId); ui.render();
      assert.equal(ui.flow().props.nodes.find((node: any) => node.id === 'picture').data.inputSources.resource, file.name,
        'Image input descriptions use the image grant catalogue, not the text-file catalogue');
      assert.equal(host.imageResourcePreview(imageId).label, file.name, 'The inline preview retains the selected picture name without a duplicate sidebar summary');
      assert.equal(calls.length, 0, 'Choosing/binding a picture never runs or sends');
    }
    ui.button('准备本局模型测试（不发送）').props.onClick();
    await settle(ui, () => ui.text().includes('核对并批准本局预算'));
    assert.equal(preparations, 1); assert.equal(sessions, 0); assert.equal(calls.length, 0);
    for (const [label, value] of [['模型请求次数上限', '2'], ['单次输出 tokens 上限', '512'], ['总预留输出 tokens 上限', '1024']]) {
      ui.labelControl(label, 'input').props.onChange({ target: { value } }); ui.render();
    }
    ui.button('批准本局模型测试预算（仍逐次确认）').props.onClick(); ui.render();
    assert.equal(sessions, 1); assert.equal(calls.length, 0);
    if (withMaterial) {
      ui.button('运行全部步骤').props.onClick(); ui.render();
      assert.equal(calls.length, 0); assert.equal(host.waitingModelTests().length, 0);
      assert.equal(host.modelTestSummary()!.usedRequests, 0, 'Missing material never sends or reserves a request');
      const file = new File([SYNTHETIC_EXPERIMENT_TEXT], '合成待处理资料.md', { type: 'text/markdown' });
      const picker = ui.inline('material').elements().find(item => item.type === 'input' && item.props['aria-label'] === '选择本地文本资料'); assert.ok(picker);
      picker.props.onChange({ target: { files: [file], value: 'synthetic-selection' } }); ui.render();
      assert.equal(host.textResourceSummary().length, 1); assert.equal(calls.length, 0);
      assert.deepEqual(ui.flow().props.nodes.find((node: any) => node.id === 'material').data.node.bindings.resource,
        { kind: 'literal', value: host.textResourceSummary()[0].id }, 'The actual node picker grants and binds, without a second sidebar selector');
      assert.equal(ui.flow().props.nodes.find((node: any) => node.id === 'material').data.inputSources.resource, file.name);
      assert.equal(calls.length, 0); assert.equal(host.history().length, 0, 'Allowing and selecting material does not read or execute it');
    }
    const priorRuns = host.workflowHistory().length;
    for (let round = 1; round <= 2; round++) {
      if (round === 2) edit(ui, 'task', `${task}\n用户修改后再次测试。`);
      ui.button('运行全部步骤').props.onClick();
      await settle(ui, () => host.waitingModelTests().length === 1);
      const wait = host.waitingModelTests()[0];
      const expectedTask = round === 1 ? task : `${task}\n用户修改后再次测试。`;
      const prompt = `角色：${role}\n任务：${expectedTask}\n约束：${format}`;
      assert.equal(wait.prompt, prompt, 'Local assembly copies exact inputs without judging/repairing prompt quality');
      assert.equal(wait.input, input); assert.equal(calls.length, round - 1);
      if (withMaterial) assert.ok(!wait.prompt.includes(SYNTHETIC_EXPERIMENT_TEXT), 'Data is sent on the material channel, not added to system instructions');
      assert.ok(ui.text().includes(prompt) && ui.text().includes(input), 'Actual full request is shown before each send');
      assert.ok(!prompt.includes(definition.criteria![0].expectation), 'Expected effects are not injected into the tested prompt');
      if (withImage) {
        assert.equal(wait.images?.[0].id, imageId);
        const preview = ui.elements().find(item => item.type === 'img' && item.props.alt === '本次待发送原图：合成原图.png');
        assert.ok(preview); assert.equal(preview.props.src, `data:image/png;base64,${SYNTHETIC_EXPERIMENT_PNG}`);
      } else assert.equal(wait.images, undefined);
      assert.equal(ui.button('确认发送本次模型请求').props.disabled, false, 'Closed assistant does not disable explicit sending');
      ui.button('确认发送本次模型请求').props.onClick();
      await settle(ui, () => host.workflowHistory().length === priorRuns + round && host.workflowHistory().at(-1)?.status === 'succeeded');
      assert.equal(calls.length, round); assert.equal(ui.modelCalls(), 0, 'No assistant request is needed for a complete or repeated experiment');
      assert.equal(calls[round - 1].systemPromptOverride, prompt); assert.equal(calls[round - 1].userInput, input);
      assert.equal(calls[round - 1].skipMemoryInjection, true); assert.equal(calls[round - 1].skipProfileInjection, true);
      assert.equal(calls[round - 1].images?.[0].assetId, imageId);
      if (withImage) assert.equal(calls[round - 1].images![0].dataUrl, `data:image/png;base64,${SYNTHETIC_EXPERIMENT_PNG}`);
      const raw = `  第 ${round} 轮原始返回\n<script>只是文本，不执行</script>  `;
      const shown = ui.flow().props.nodes.find((node: any) => node.id === 'showResult');
      assert.equal(shown.data.status, 'displayed'); assert.equal(shown.data.artifacts[0].payload.value, raw);
      assert.ok(ui.text().includes(raw), 'Raw model text remains available before and without assistant analysis');
      assert.equal(host.modelTestSummary()!.records.at(-1)!.output, raw);
      assert.equal(ui.button('运行全部步骤').props.disabled, false, 'Local execution remains available even when model sending budget is exhausted');
      assert.equal(host.modelTestSummary()!.usedRequests, round);
    }
    ui.button('保存场景').props.onClick(); await settle(ui, () => ui.saved.length === 1);
    const saved = ui.saved[0], serialized = JSON.stringify(saved);
    for (const forbidden of [SYNTHETIC_EXPERIMENT_PNG, 'data:image/', 'SyntheticExperimentResource', 'maxReservedOutputTokens', '第 2 轮原始返回'])
      assert.ok(!serialized.includes(forbidden), `Templates never serialize ${forbidden.slice(0, 30)}`);
    if (withMaterial) assert.ok(!serialized.includes(SYNTHETIC_EXPERIMENT_TEXT), 'Selected file body is not a saved content block or permission');
    assert.equal(saved.canvasWorkspace.business, undefined); assert.deepEqual(saved.canvasWorkspace.criteria, definition.criteria);
    const fresh = new S2PluginHost(saved.sceneId, readS2Scene(saved)); restored.push(fresh); fresh.setDocument(saved.canvasWorkspace.initial);
    assert.equal(fresh.modelTestSummary(), null); assert.deepEqual(fresh.imageResourceSummary(), []); assert.deepEqual(fresh.textResourceSummary(), []); assert.deepEqual(fresh.history(), []);
    if (imageId) assert.throws(() => fresh.imageResourcePreview(imageId), /撤回|不属于/);
    ui.button('结束试验').props.onClick(); ui.render();
    assert.equal(ui.modelCalls(), 0); assert.equal(calls.length, 2);
  }
  assert.equal(networkAttempts, 0);
  console.log('S2 user-led experiment passed: interchangeable text inputs, businessless root criteria, actual local assembly, assistant-off repeated text/image/file-material runs, native image grant + real parent binding/name/preview, actual file-picker grant and resource selector, missing material does not send, exact separate prompt/material channels and raw result, separate approval/confirmation, template without file bodies/image bytes/runtime authority. Synthetic handlers only; NOT browser or live semantic acceptance.');
} finally { interfaces.forEach(ui => ui.dispose()); restored.forEach(host => host.close()); globalThis.fetch = priorFetch; }
