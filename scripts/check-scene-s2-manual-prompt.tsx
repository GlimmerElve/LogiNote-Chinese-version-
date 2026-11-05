import assert from 'node:assert/strict';
import { createS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { inspectS2PromptControls } from '../src/interaction-packs/prompt-lab/promptControls';
import type { SceneSpec } from '../src/types';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { manualPromptDefinition, manualPromptRequest, manualPromptTexts, manualPromptExpected } from './fixtures/s2-review-task';
import { harness } from './scene-s2-ui-harness';
import { addS2PackCapability } from './fixtures/s2-canvas-ui-actions';

async function settle(predicate: () => boolean, render: () => void) {
  for (let i = 0; i < 800; i++) { render(); if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('Manual prompt task did not settle');
}
const definition = readS2Definition(manualPromptDefinition, { requireBusiness: true });
const original = JSON.stringify(definition);
let network = 0; const previous = globalThis.fetch;
globalThis.fetch = async () => { network++; throw new Error('Synthetic local task only'); };
try {
  for (const deferStateUpdates of [false, true]) {
    const scene = createS2Scene(manualPromptRequest); scene.canvasWorkspace = structuredClone(definition);
    let host!: S2PluginHost, stored!: SceneSpec, oldSubmit!: (value: boolean) => void;
    let accepted = '', declined = '', confirm = '', assembly = '';
    const ui = harness({ initialDraft: scene, initialRequest: manualPromptRequest, deferStateUpdates, onHost(value) { host = value; } });
    try {
      const document = () => ui.elements().find(e => e.type === 'run-summary')!.props.document;
      const inline = () => ui.inline(document().execution.nodes.at(-1).id);
      const change = (label: string, type: string, value: string) => {
        const control = ['这份内容叫什么', '第1段使用的内容', '第1段标题（可选）', '第2段使用的内容', '第2段标题（可选）'].includes(label)
          ? inline().labelControl(label, type) : ui.labelControl(label, type);
        control.props.onChange({ target: { value } }); ui.render();
      };
      const submit = (label: string) => { inline().elements().find(e => e.type === 'form' && e.props['aria-label'] === label)!.props.onSubmit({ preventDefault() {} }); ui.render(); };
      const add = (capability: string) => {
        const before = new Set(document().execution.nodes.map((node: any) => node.id));
        addS2PackCapability(ui, capability);
        const node = document().execution.nodes.find((node: any) => !before.has(node.id)); assert.ok(node); assert.equal(node.presentation, undefined); return node.id;
      };
      const wire = (label: string, nodeId: string, portId: string) => change(`为${label}选择材料`, 'select', JSON.stringify(['output', nodeId, portId]));
      const purpose = (label: string, text: string) => {
        change('这份内容叫什么', 'input', label); submit('设置内容用途');
        change(`为${label}选择材料`, 'select', 'manual'); change(`填写${label}`, 'textarea', text);
      };
      const layout = () => {
        const inspected = inspectS2PromptControls(definition, document(), document().execution.nodes.at(-1).id);
        assert.ok(inspected.kind === 'layout');
        inline().button('添加提示词段落').props.onClick(); ui.render(); inline().button('添加提示词段落').props.onClick(); ui.render();
        change('第1段使用的内容', 'select', inspected.available[0].key); change('第1段标题（可选）', 'input', '角色');
        change('第2段使用的内容', 'select', inspected.available[1].key); change('第2段标题（可选）', 'input', '任务');
        submit('按内容名称安排提示词');
      };
      ui.button('开始试验').props.onClick(); ui.render(); assert.equal(document().execution.nodes.length, 0);
      const role = add('text-template@1.0.0/bind'); purpose('角色设定', manualPromptTexts.role);
      const task = add('text-template@1.0.0/bind'); purpose('任务要求', manualPromptTexts.task); wire('已汇集的内容', role, 'variables');
      assembly = add('text-template@1.0.0/render'); wire('已汇集的内容', task, 'variables'); layout();
      confirm = add('human-input@1.0.0/confirm'); wire('提示内容', assembly, 'text');
      for (const approved of [true, false]) {
        const id = add('text-template@1.0.0/render'); if (approved) accepted = id; else declined = id;
        wire('已汇集的内容', task, 'variables'); layout();
        const editor = ui.elements().find(e => e.type === 'condition-editor')!.props;
        // Parent's actual apply callback; the condition form itself is covered by its dedicated real-control checks/browser.
        editor.onApply({ nodeId: confirm, portId: 'decision', pointer: '/approved', equals: true, match: approved }, editor.sourceKey, 'form'); ui.render();
      }
      assert.equal(document().execution.nodes.length, 6); assert.equal(document().execution.links.length, 5);
      assert.equal(host.workflowHistory().length, 0); assert.equal(host.remainingCalls, 64); assert.equal(ui.modelCalls(), 0);
      for (const approved of [false, true]) {
        ui.button('运行全部步骤').props.onClick(); await settle(() => host.waitingHumanInputs().length === 1, ui.render);
        const human = ui.elements().find(e => e.type === 'human-input')!.props;
        assert.equal(human.wait.prompt, manualPromptExpected);
        assert.equal(ui.labelControl('向 Agent 提出要求', 'textarea').props.disabled, false);
        const before = host.remainingCalls; human.onSubmit(approved);
        await settle(() => host.workflowHistory().at(-1)?.status === 'succeeded', ui.render);
        assert.equal(host.remainingCalls, before - 1, 'Only the selected local branch runs after a choice');
        const run = host.workflowHistory().at(-1)!;
        const chosen = run.nodes.find(node => node.nodeId === (approved ? accepted : declined))!;
        assert.equal(chosen.status, 'succeeded'); assert.equal(run.nodes.find(node => node.nodeId === (approved ? declined : accepted))!.status, 'skipped');
        const output = host.currentArtifact(chosen.artifactIds[0]); assert.equal(output.payload.kind, 'inline');
        if (output.payload.kind === 'inline') assert.equal(output.payload.value, manualPromptExpected);
        assert.throws(() => human.onSubmit(!approved), /失效|提交/);
      }
      ui.button('运行全部步骤').props.onClick(); await settle(() => host.waitingHumanInputs().length === 1, ui.render);
      oldSubmit = ui.elements().find(e => e.type === 'human-input')!.props.onSubmit;
      const snapshot = JSON.stringify(document()), waitId = host.waitingHumanInputs()[0].id, budget = host.remainingCalls;
      ui.button('保存场景').props.onClick(); await settle(() => ui.saved.length === 1, ui.render);
      stored = structuredClone(ui.saved[0]); assert.equal(JSON.stringify(stored.canvasWorkspace!.initial), snapshot);
      for (const runtime of [host.runId, waitId]) assert.ok(!JSON.stringify(stored).includes(runtime));
      assert.equal(host.waitingHumanInputs()[0].id, waitId); assert.equal(host.remainingCalls, budget);
      ui.button('结束试验').props.onClick(); ui.render(); assert.throws(() => oldSubmit(true), /失效|无效/);
    } finally { ui.dispose(); }
    // Reopen the real saved design and its alias-free variant through the actual existing-scene loader.
    for (const legacy of [false, true]) {
      const template = structuredClone(stored);
      if (legacy) template.canvasWorkspace!.initial.execution!.nodes.forEach(node => { delete node.presentation; });
      let fresh!: S2PluginHost;
      const opened = harness({ initialRequest: { ...manualPromptRequest, source: 'existing', sceneId: template.sceneId },
        loadScene: async () => structuredClone(template), deferStateUpdates, onHost(value) { fresh = value; } });
      try {
        await settle(() => opened.text().includes('预览：可编辑初始画布'), opened.render);
        assert.equal(fresh, undefined); assert.equal(opened.modelCalls(), 0);
        opened.button('开始试验').props.onClick(); opened.render();
        assert.equal(fresh.remainingCalls, 64); assert.equal(fresh.workflowHistory().length, 0); assert.equal(fresh.waitingHumanInputs().length, 0);
        assert.deepEqual(opened.elements().find(e => e.type === 'run-summary')!.props.document, template.canvasWorkspace!.initial);
        opened.button('运行全部步骤').props.onClick(); await settle(() => fresh.waitingHumanInputs().length === 1, opened.render);
        assert.throws(() => oldSubmit(true), /失效|无效/); assert.equal(fresh.waitingHumanInputs().length, 1);
        const human = opened.elements().find(e => e.type === 'human-input')!.props;
        assert.equal(human.wait.prompt, manualPromptExpected); human.onSubmit(false);
        await settle(() => fresh.workflowHistory().at(-1)?.status === 'succeeded', opened.render);
        const run = fresh.workflowHistory().at(-1)!;
        assert.equal(run.nodes.find(node => node.nodeId === accepted)!.status, 'skipped');
        const chosen = run.nodes.find(node => node.nodeId === declined)!; assert.equal(chosen.status, 'succeeded');
        const output = fresh.currentArtifact(chosen.artifactIds[0]); assert.equal(output.payload.kind, 'inline');
        if (output.payload.kind === 'inline') assert.equal(output.payload.value, manualPromptExpected);
        assert.equal(fresh.remainingCalls, 60); assert.equal(fresh.waitingHumanInputs().length, 0);
        assert.equal(opened.modelCalls(), 0);
      } finally { opened.dispose(); }
    }
  }
  assert.equal(JSON.stringify(definition), original); assert.equal(network, 0);
  console.log('S2 empty-canvas prompt task passed: all six steps added through ordinary production library, Chinese purposes and named layouts, exact single-pass literal text, separately submitted approval/refusal branches, saved waiting design and actual fresh existing-scene load with/without presentation, no old callbacks/choices/results carried, ordinary/deferred hooks; synthetic local only, not browser or real semantics.');
} finally { globalThis.fetch = previous; }
