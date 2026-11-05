import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import type { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import type { S2Artifact } from '../src/types/sceneS2Plugin';
import { S2ArtifactView } from '../src/components/scene/S2ArtifactView';
import { browserRecordFormDefinition, browserRecordFormRequest } from './fixtures/s2-browser-definition';
import { harness } from './scene-s2-ui-harness';

async function settle(check: () => boolean, render: () => void) {
  for (let i = 0; i < 600; i++) { render(); if (check()) return; await new Promise(resolve => setImmediate(resolve)); }
  assert.fail('Result reading did not settle');
}
let network = 0; const previous = globalThis.fetch;
globalThis.fetch = async () => { network++; throw new Error('Result reading forbids external IO'); };
try {
  const literal = '  中文\r\n$& {{literal}} <script>纯文字</script>  ' + '长文'.repeat(2900) + '\r\n完整末尾';
  const textArtifact: S2Artifact = { protocolVersion: 1, id: 'text', type: { id: 'core.text', version: 1 }, complete: true,
    source: { kind: 'user', sceneId: 'synthetic', runId: 'run', nodeId: 'source', revision: 1 }, payload: { kind: 'inline', value: literal } };
  const serialized = JSON.stringify(textArtifact), textMarkup = renderToStaticMarkup(<S2ArtifactView artifact={textArtifact} complete />);
  assert.ok(textMarkup.includes('完整末尾')); assert.ok(textMarkup.includes('$&amp; {{literal}}'));
  assert.ok(textMarkup.includes('&lt;script&gt;纯文字&lt;/script&gt;')); assert.ok(!textMarkup.includes('<script>'));
  assert.equal(JSON.stringify(textArtifact), serialized);
  const structuredArtifact: S2Artifact = { ...textArtifact, id: 'structured', type: { id: 'structured-data.value', version: 1 },
    payload: { kind: 'inline', value: Array.from({ length: 220 }, (_, index) => ({ index, 空值: null, 布尔: false, 文本: index === 219 ? '完整结构末尾' : '' })) } };
  const structuredSnapshot = JSON.stringify(structuredArtifact);
  const structuredMarkup = renderToStaticMarkup(<S2ArtifactView artifact={structuredArtifact} complete />);
  assert.ok(structuredMarkup.includes('完整结构末尾')); assert.ok(!structuredMarkup.includes('树预览已达200项'));
  assert.ok(structuredMarkup.includes('false')); assert.ok(structuredMarkup.includes('null'));
  assert.equal(JSON.stringify(structuredArtifact), structuredSnapshot);
  for (const deferStateUpdates of [false, true]) {
    const definition = structuredClone(browserRecordFormDefinition);
    const rows = Array.from({ length: 25 }, (_, i) => ({ 姓名: `记录${i + 1}`, 次数: 0, 完成: false, 备注: i === 24 ? '<script>literal</script>\r\n末行' : null }));
    definition.initial.execution!.nodes.find(n => n.id === 'recordRows')!.bindings.value = { kind: 'literal', value: rows };
    // Exercise the old/default presentation path, not Agent-provided aliases.
    definition.initial.execution!.nodes.forEach(n => { delete n.presentation; });
    const scene = createS2Scene(browserRecordFormRequest); scene.canvasWorkspace = readS2Definition(definition, { requireBusiness: true });
    let host!: S2PluginHost;
    const ui = harness({ initialDraft: scene, deferStateUpdates, onHost(value) { host = value; } });
    try {
      ui.button('开始试验').props.onClick(); ui.render();
      const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
      focus('recordView');
      assert.ok(!ui.elements().some(e => e.type === 'button' && ui.text(e).includes('全屏阅读所选步骤结果')));
      ui.button('运行所选步骤').props.onClick(); await settle(() => host.workflowHistory().at(-1)?.status === 'succeeded', ui.render)
        .catch(cause => { throw new Error(`${cause.message}; synthetic run: ${JSON.stringify(host.workflowHistory().at(-1))}`); });
      const document = () => ui.elements().find(e => e.type === 'run-summary')!.props.document;
      const snapshot = JSON.stringify(document()), history = JSON.stringify(host.workflowHistory()), budget = host.remainingCalls;
      const trigger = ui.button('全屏阅读所选步骤结果'); trigger.props.onClick({ currentTarget: null }); ui.render();
      const dialog = () => ui.elements().find(e => e.type === 'dialog');
      assert.ok(dialog()); assert.equal(dialog()!.props['aria-labelledby'], 's2-result-title');
      const view = ui.elements(dialog()).find(e => e.type === 'artifact-view')!;
      assert.equal(view.props.complete, true); assert.equal(view.props.presentation, 'typed');
      const ordinary = renderToStaticMarkup(<S2ArtifactView artifact={view.props.artifact} />);
      const complete = renderToStaticMarkup(<S2ArtifactView artifact={view.props.artifact} complete />);
      assert.ok(ordinary.includes('仅预览前20行')); assert.ok(!ordinary.includes('记录25'));
      assert.ok(!complete.includes('仅预览前20行')); assert.ok(complete.includes('记录25'));
      assert.ok(complete.includes('false')); assert.ok(complete.includes('&lt;script&gt;literal&lt;/script&gt;')); assert.ok(!complete.includes('<script>'));
      assert.equal(JSON.stringify(document()), snapshot); assert.equal(JSON.stringify(host.workflowHistory()), history);
      assert.equal(host.remainingCalls, budget); assert.equal(ui.modelCalls(), 0);
      let prevented = false; dialog()!.props.onCancel({ preventDefault() { prevented = true; } }); ui.render();
      assert.ok(prevented); assert.equal(dialog(), undefined);
      // Navigation only focuses existing regions, without selecting, applying or running anything.
      for (const name of ['添加', '更多', '运行记录与授权']) { ui.button(name).props.onClick(); ui.render(); }
      ui.render(); assert.equal(JSON.stringify(document()), snapshot); assert.equal(host.remainingCalls, budget);
      trigger.props.onClick({ currentTarget: null }); ui.render();
      focus('recordRows');
      const parameter = ui.elements().find(e => e.type === 'json-parameter' && e.props.nodeId === 'recordRows')!.props;
      parameter.onCommit([{ 姓名: '新的设计，不是旧结果' }], parameter.sourceKey, 'form'); ui.render();
      assert.ok(dialog()); assert.match(ui.text(dialog()), /结果已过期/);
      assert.equal(ui.elements(dialog()).filter(e => e.type === 'artifact-view').length, 0, 'Changed design must retire visible current data');
      ui.button('关闭结果阅读').props.onClick(); ui.render();
      trigger.props.onClick({ currentTarget: null }); ui.render(); assert.equal(dialog(), undefined);
      assert.match(ui.text(), /结果已过期或本局已结束/);
      ui.keyShortcut('undo'); ui.render();
      trigger.props.onClick({ currentTarget: null }); ui.render(); assert.equal(dialog(), undefined, 'Undo does not revive prior result authority');
      focus('recordView'); ui.button('运行所选步骤').props.onClick();
      await settle(() => host.workflowHistory().at(-1)?.status === 'succeeded', ui.render);
      ui.button('全屏阅读所选步骤结果').props.onClick({ currentTarget: null }); ui.render();
      assert.ok(ui.elements(dialog()).some(e => e.type === 'artifact-view'));
      ui.button('结束试验').props.onClick(); ui.render();
      assert.equal(ui.elements(dialog()).filter(e => e.type === 'artifact-view').length, 0);
      assert.match(ui.text(dialog()), /本局已结束/); assert.equal(ui.modelCalls(), 0);
    } finally { ui.dispose(); }
  }
  assert.equal(network, 0);
  console.log('S2 result reading passed: alias-free saved-style nodes, real local table execution, independent current-result reader, full 25-row escaped rendering versus 20-row preview, source/budget/history preservation, navigation-only controls, stale/edit/undo/end retirement and ordinary/deferred UI hooks. Synthetic offline only; native dialog focus/Escape and browser layout are verified separately, not real models or disk acceptance.');
} finally { globalThis.fetch = previous; }
