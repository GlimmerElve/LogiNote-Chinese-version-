import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createS2Scene, importS2Workspace, exportS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { harness } from './scene-s2-ui-harness';

const previous = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Rich control fixture forbids network'); };
try {
  const raw = readFileSync('scripts/fixtures/s2-rich-controls-workspace.json', 'utf8'), definition = importS2Workspace(raw);
  assert.deepEqual(importS2Workspace(exportS2Workspace(definition, definition.initial)), definition);
  const host = new S2PluginHost('scene-rich-controls', definition); host.setDocument(definition.initial);
  try {
    const result = await host.enqueueWorkflow(['view', 'tree']).completion;
    assert.equal(result.status, 'succeeded'); assert.equal(host.history().length, 2);
    assert.equal(host.remainingCalls, 62); // Only parse/to-table, never renderers or model calls.
    const value = host.history().find(item => item.request.nodeId === 'parse')!.artifacts[0];
    assert.equal(value.payload.kind, 'inline');
    if (value.payload.kind === 'inline') assert.deepEqual(value.payload.value,
      [{ name: '零值', score: 0, enabled: false }, { name: '空值', score: null }, { name: '缺失' }]);
    assert.ok(result.nodes.filter(node => ['view', 'tree'].includes(node.nodeId)).every(node => node.status === 'displayed'));
  } finally { host.close(); }
  const initial = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成导入入口', knowledgePoints: [] });
  const ui = harness({ initialDraft: initial });
  try {
    ui.labelControl('工作区 JSON', 'textarea').props.onChange({ target: { value: raw } }); ui.render();
    ui.button('导入并替换当前预览').props.onClick(); ui.render();
    assert.equal(ui.flow().props.nodes.length, 6);
    ui.labelControl('选择块', 'select').props.onChange({ target: { value: 'settings' } }); ui.render();
    assert.equal(ui.elements().filter(e => e.type === 'field-editor').length, 1);
    ui.labelControl('选择块', 'select').props.onChange({ target: { value: 'data' } }); ui.render();
    assert.equal(ui.elements().filter(e => e.type === 'field-editor').length, 3);
    assert.equal(ui.modelCalls(), 0);
  } finally { ui.dispose(); }
  assert.equal(network, 0);
  console.log('S2 rich controls fixture passed: actual import/schema/port checks, production field editor wiring, complete missing/null/zero/false parse-table-view/tree transport and zero model/network IO. Not browser or semantic acceptance.');
} finally { globalThis.fetch = previous; }
