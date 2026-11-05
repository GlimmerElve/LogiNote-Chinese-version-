import assert from 'node:assert/strict';
import { createS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import type { SceneSpec } from '../src/types';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { s2TableToRecords, type S2Table } from '../src/services/scene/sceneS2Structured';
import { browserManualReuseDefinition, browserManualReuseRequest, browserResourceSource, browserResourceState } from './fixtures/s2-browser-definition';
import { harness } from './scene-s2-ui-harness';
import { addS2PackCapability } from './fixtures/s2-canvas-ui-actions';

async function settle(predicate: () => boolean, render = () => {}) {
  for (let i = 0; i < 600; i++) { render(); if (predicate()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('Manual reuse fixture did not settle');
}
const definition = readS2Definition(browserManualReuseDefinition, { requireBusiness: true });
const records = [{ 姓名: '我填写的甲', 次数: 0, 完成: false, 备注: null }, { 姓名: '我填写的乙', 备注: '' }];
let network = 0; const previous = globalThis.fetch;
globalThis.fetch = async () => { network++; throw new Error('Manual task is synthetic local only'); };
try {
  for (const deferStateUpdates of [false, true]) {
    const scene = createS2Scene(browserManualReuseRequest); scene.canvasWorkspace = structuredClone(definition);
    let host!: S2PluginHost;
    const ui = harness({ initialDraft: scene, initialRequest: browserManualReuseRequest, projectNoteSource: browserResourceSource,
      deferStateUpdates, onHost(value) { host = value; } });
    let stored!: SceneSpec, snapshot = '', readId = '', viewId = '', rowsId = '', confirmId = '', oldWait: (v: boolean) => void;
    const reads = browserResourceState.reads;
    try {
      const document = () => ui.elements().find(e => e.type === 'run-summary')!.props.document;
      const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
      const add = (key: string) => {
        const ids = new Set(document().execution.nodes.map((n: any) => n.id));
        const positions = document().execution.nodes.map((n: any) => ({ ...n.position }));
        addS2PackCapability(ui, key);
        const added = document().execution.nodes.find((n: any) => !ids.has(n.id)); assert.ok(added);
        assert.equal(added.position.y, 100);
        assert.ok(positions.every((position: any) => added.position.x >= position.x + 390), 'Ordinary additions must not stack over existing cards');
        assert.deepEqual(document().execution.nodes.filter((n: any) => ids.has(n.id)).map((n: any) => n.position), positions, 'Adding a node must not rearrange the existing design');
        assert.equal(added.presentation, undefined, 'Ordinary new nodes do not depend on Agent presentation aliases'); return added.id;
      };
      assert.equal(scene.canvasWorkspace.initial.execution!.nodes.length, 0);
      ui.button('开始试验').props.onClick(); ui.render();
      rowsId = add('structured-data@1.0.0/to-table');
      const parameter = () => ui.elements().find(e => e.type === 'json-parameter' && e.props.nodeId === rowsId && e.props.portId === 'value')!.props;
      parameter().onCommit(records, parameter().sourceKey, 'form'); ui.render();
      // A separate unsubmitted form draft must never enter a saved template.
      parameter().drafts.set(JSON.stringify([rowsId, 'value']), { marker: 'PRIVATE_UNAPPLIED_DRAFT' });
      viewId = add('structured-view@1.0.0/table');
      ui.labelControl('为表格内容选择材料', 'select').props.onChange({ target: { value: JSON.stringify(['output', rowsId, 'table']) } }); ui.render();
      confirmId = add('human-input@1.0.0/confirm');
      ui.labelControl('为提示内容选择材料', 'select').props.onChange({ target: { value: 'manual' } }); ui.render();
      ui.labelControl('填写提示内容', 'textarea').props.onChange({ target: { value: '请本人核对设计；这不是工具授权。' } }); ui.render();
      readId = add('project-notes@1.0.0/read-text');
      ui.labelControl('选择并允许本局读取知识笔记', 'select').props.onChange({ target: { value: 'synthetic-note' } }); ui.render();
      ui.labelControl('为读取步骤选择笔记', 'select').props.onChange({ target: { value: host.projectNoteSummary()[0].id } }); ui.render();
      assert.equal(host.remainingCalls, 64); assert.equal(host.workflowHistory().length, 0); assert.equal(browserResourceState.reads, reads);
      ui.button('运行所选步骤').props.onClick(); await settle(() => host.workflowHistory().at(-1)?.status === 'succeeded', ui.render);
      assert.equal(browserResourceState.reads, reads + 1); assert.equal(host.remainingCalls, 63);
      focus(viewId); ui.button('运行所选步骤').props.onClick(); await settle(() => host.workflowHistory().at(-1)?.status === 'succeeded', ui.render);
      const run = host.workflowHistory().at(-1)!, result = host.currentArtifact(run.nodes.find(n => n.nodeId === rowsId)!.artifactIds[0]);
      assert.equal(result.payload.kind, 'inline'); if (result.payload.kind === 'inline') assert.deepEqual(s2TableToRecords(result.payload.value as unknown as S2Table), records);
      assert.equal(host.remainingCalls, 62);
      focus(confirmId); ui.button('运行所选步骤').props.onClick(); await settle(() => host.waitingHumanInputs().length === 1, ui.render);
      oldWait = ui.elements().find(e => e.type === 'human-input')!.props.onSubmit;
      const beforeSave = JSON.stringify(document()), budget = host.remainingCalls, wait = host.waitingHumanInputs()[0].id;
      ui.button('保存场景').props.onClick(); ui.button('保存场景').props.onClick();
      await settle(() => ui.saved.length === 1 && /已保存场景/.test(ui.text()), ui.render);
      stored = structuredClone(ui.saved[0]); snapshot = JSON.stringify(stored.canvasWorkspace!.initial);
      assert.equal(snapshot, beforeSave); assert.equal(JSON.stringify(document()), beforeSave);
      assert.notEqual(stored.sceneId, scene.sceneId); assert.equal(stored.sourceSceneId, scene.sceneId);
      assert.equal(host.remainingCalls, budget); assert.equal(host.waitingHumanInputs()[0].id, wait);
      assert.equal(browserResourceState.reads, reads + 1); assert.equal(ui.modelCalls(), 0);
      const serialized = JSON.stringify(stored);
      for (const secret of ['PRIVATE_UNAPPLIED_DRAFT', host.runId, wait, result.id]) assert.ok(!serialized.includes(secret));
      assert.match(ui.text(), /未应用草稿/); assert.match(ui.text(), /本局授权/);
      ui.button('结束试验').props.onClick(); ui.render(); assert.throws(() => oldWait(true), /失效|无效/);
      assert.equal(host.remainingCalls, budget);
    } finally { ui.dispose(); }
    let freshHost!: S2PluginHost, loads = 0;
    const opened = harness({ initialRequest: { ...browserManualReuseRequest, source: 'existing', sceneId: stored.sceneId },
      loadScene: async id => { loads++; assert.equal(id, stored.sceneId); return structuredClone(stored); },
      projectNoteSource: browserResourceSource, deferStateUpdates, onHost(value) { freshHost = value; } });
    try {
      await settle(() => opened.text().includes('预览：可编辑初始画布'), opened.render);
      assert.equal(loads, 1); assert.equal(freshHost, undefined); assert.equal(opened.modelCalls(), 0);
      const document = () => opened.elements().find(e => e.type === 'run-summary')!.props.document;
      assert.equal(JSON.stringify(document()), snapshot);
      opened.button('开始试验').props.onClick(); opened.render();
      assert.equal(freshHost.remainingCalls, 64); assert.equal(freshHost.workflowHistory().length, 0);
      assert.equal(freshHost.waitingHumanInputs().length, 0); assert.equal(freshHost.projectNoteSummary().length, 0);
      const focus = (id: string) => { opened.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); opened.render(); };
      focus(readId); opened.button('运行所选步骤').props.onClick(); opened.render();
      // A saved local handle is design data, not current consent. It must fail without reading.
      await settle(() => freshHost.workflowHistory().every(run => !['queued', 'running'].includes(run.status)), opened.render);
      assert.equal(browserResourceState.reads, reads + 1); assert.equal(freshHost.remainingCalls, 64);
      focus(viewId); opened.button('运行所选步骤').props.onClick(); await settle(() => freshHost.workflowHistory().at(-1)?.status === 'succeeded', opened.render);
      assert.equal(freshHost.remainingCalls, 63); assert.equal(freshHost.waitingHumanInputs().length, 0);
      const run = freshHost.workflowHistory().at(-1)!, result = freshHost.currentArtifact(run.nodes.find(n => n.nodeId === rowsId)!.artifactIds[0]);
      assert.equal(result.payload.kind, 'inline');
      if (result.payload.kind === 'inline') assert.deepEqual(s2TableToRecords(result.payload.value as unknown as S2Table), records);
      focus(confirmId); opened.button('运行所选步骤').props.onClick(); await settle(() => freshHost.waitingHumanInputs().length === 1, opened.render);
      assert.throws(() => oldWait!(true), /失效|无效/); assert.equal(freshHost.waitingHumanInputs().length, 1);
      opened.elements().find(e => e.type === 'human-input')!.props.onSubmit(false);
      await settle(() => freshHost.workflowHistory().at(-1)?.status === 'succeeded', opened.render);
      assert.equal(freshHost.remainingCalls, 63); assert.equal(opened.modelCalls(), 0);
      assert.equal(JSON.stringify(stored.canvasWorkspace!.initial), snapshot);
    } finally { opened.dispose(); }
  }
  assert.equal(network, 0);
  console.log('S2 manual reuse passed: empty public canvas, every real step added through ordinary library with separated placement, native material commits and named connections, separate exact table/read/human execution, one saved snapshot while waiting, no private draft or runtime carry, actual existing-scene loader preview and fresh host, old callback/old resource authority rejection and preserved falsy/missing data under ordinary/deferred hooks, including saved nodes without presentation aliases. Synthetic local only; not real disk/model/browser/user-comprehension acceptance.');
} finally { globalThis.fetch = previous; }
