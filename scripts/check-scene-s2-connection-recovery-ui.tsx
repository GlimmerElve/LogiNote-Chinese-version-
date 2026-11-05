import assert from 'node:assert/strict';
import { createS2Scene, readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { s2ExecutionLinkKey } from '../src/services/scene/sceneS2Workflow';
import { s2CanvasCompositeBlueprint, wrapS2CanvasComposite } from '../src/services/scene/sceneS2CompositeCanvas';
import { harness } from './scene-s2-ui-harness';

// Deterministic hooks execute the production component and native validator/host.
// These assertions are not browser geometry or real-model semantic acceptance.
const cap = (capabilityId: string) => ({ pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId });
const literal = (value: any) => ({ kind: 'literal', value });
const ids = { note: 'PRIVATE_NOTE', otherNote: 'PRIVATE_OTHER_NOTE', first: 'PRIVATE_FIRST', text: 'PRIVATE_TEXT',
  replacement: 'PRIVATE_REPLACEMENT', other: 'PRIVATE_OTHER', tail: 'PRIVATE_TAIL' };
const replacementValue = { zero: 0, enabled: false, empty: null, text: 'PRIVATE_PAYLOAD' };
const definition = readS2Definition({ version: 1, goal: '合成接线失败恢复验收',
  instructions: { understanding: '理解修改目的', planning: '保留原材料，由用户明确修改后单独运行', response: '只报告实际发生的操作' },
  blockTypes: [{ id: 'note', label: '输入材料', fields: [{ id: 'content', label: '原文', kind: 'multiline' }] }],
  plugins: [cap('parse-json'), cap('stringify')],
  initial: { nodes: [
    { id: ids.note, type: 'note', position: { x: 0, y: 0 }, values: { content: '{"ready":true,"body":"PRIVATE_BODY"}' } },
    { id: ids.otherNote, type: 'note', position: { x: 0, y: 200 }, values: { content: 'PRIVATE_OTHER_BODY' } },
  ], edges: [], execution: { version: 1, nodes: [
    { id: ids.first, ...cap('parse-json'), position: { x: 300, y: 0 }, bindings: { text: { kind: 'field', nodeId: ids.note, fieldId: 'content' } },
      presentation: { label: '整理材料', inputs: { text: '待整理原文' }, outputs: { value: '整理结果' } } },
    { id: ids.text, ...cap('stringify'), position: { x: 600, y: 0 }, bindings: {},
      presentation: { label: '生成文字', inputs: { value: '待保存内容' }, outputs: { text: '保存文本' } } },
    { id: ids.replacement, ...cap('stringify'), position: { x: 300, y: 300 }, bindings: { value: literal(replacementValue) },
      presentation: { label: '备用材料', inputs: { value: '固定材料' }, outputs: { text: '备用原文' } } },
    { id: ids.other, ...cap('parse-json'), position: { x: 300, y: 600 }, bindings: { text: literal('{}') },
      presentation: { label: '整理材料', inputs: { text: '待整理原文' }, outputs: { value: '整理结果' } } },
    { id: ids.tail, ...cap('parse-json'), position: { x: 900, y: 0 }, bindings: {},
      presentation: { label: '再读结果', inputs: { text: '再次读取的原文' }, outputs: { value: '读取结果' } } },
  ], links: [
    { source: { nodeId: ids.first, portId: 'value' }, target: { nodeId: ids.text, portId: 'value' } },
    { source: { nodeId: ids.text, portId: 'text' }, target: { nodeId: ids.tail, portId: 'text' } },
  ] } },
});
const originalDocument = definition.initial;
const fieldId = JSON.stringify([ids.first, 'text', originalDocument.execution!.nodes[0].bindings.text]);
const firstDataId = s2ExecutionLinkKey(originalDocument.execution!.links[0]);
const previousFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Connection recovery acceptance forbids network IO'); };
const uis: ReturnType<typeof harness>[] = [];
const ordinaryText = (root: any): string => Array.isArray(root) ? root.map(ordinaryText).join('')
  : root && typeof root === 'object' ? root.type === 'details' ? '' : ordinaryText(root.children) : String(root ?? '');
function makeUi(initial = originalDocument, deferred = false) {
  const scene = createS2Scene({ source: 'custom', subject: '合成连接恢复', sceneSkill: 'S2', knowledgePoints: [], interactionPack: null });
  scene.canvasWorkspace = { ...definition, initial }; let host!: S2PluginHost;
  const ui = harness({ initialDraft: scene, deferStateUpdates: deferred, onHost: value => { host = value; } }); uis.push(ui);
  const document = () => ui.elements().find(e => e.type === 'run-summary')!.props.document;
  const snapshot = () => JSON.stringify(document());
  const panel = () => ui.elements().find(e => e.type === 'section' && e.props['aria-label'] === '连接未应用');
  const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
  const selected = () => ui.labelControl('选择执行节点', 'select').props.value;
  const connect = (source: string, sourceHandle: string, target: string, targetHandle: string) => {
    ui.flow().props.onConnect({ source, sourceHandle, target, targetHandle }); ui.render();
  };
  const checkFailure = (before: string, words: string[]) => {
    assert.equal(snapshot(), before, 'Rejected edit preserves the complete native document');
    const root = panel(); assert.ok(root, 'Readable recovery panel'); assert.equal(root.props.role, 'alert');
    const text = ordinaryText(root); words.forEach(word => assert.ok(text.includes(word), `${word}: ${text}`));
    assert.ok(text.includes('原图未改变')); assert.ok(text.includes('不会断线、替换材料或运行'));
    assert.ok(!text.includes('PRIVATE_')); assert.ok(!text.includes('structured-data')); assert.ok(!text.includes('core.text'));
    const advanced = ui.elements(root).find(e => e.type === 'details')!;
    assert.ok(advanced); assert.equal(advanced.props.open, undefined);
    assert.ok(ui.text(advanced).startsWith('本次拒绝的技术详情'));
    for (const value of ['PRIVATE_BODY', 'PRIVATE_OTHER_BODY', 'PRIVATE_PAYLOAD']) assert.ok(!ui.text(advanced).includes(value), value);
    assert.equal(ui.modelCalls(), 0); assert.equal(ui.saved.length, 0); assert.equal(network, 0);
    if (host) { assert.equal(host.remainingCalls, 64); assert.equal(host.workflowHistory().length, 0); assert.equal(host.history().length, 0); }
    return root;
  };
  const related = (name: string) => ui.button(`查看相关步骤：${name}`).props.onClick;
  const existing = () => ui.elements(panel()).find(e => e.type === 'button' && ui.text(e).startsWith('查看已有连接：'))!.props.onClick;
  return { ui, document, snapshot, panel, focus, selected, connect, checkFailure, related, existing, host: () => host };
}
try {
  const h = makeUi(), { ui } = h; ui.button('开始试验').props.onClick(); ui.render();
  const original = h.snapshot();
  h.connect(ids.replacement, 'out:text', ids.first, 'in:text');
  h.checkFailure(original, ['整理材料（步骤 1）', '待整理原文']);
  const occupiedField = h.existing(); occupiedField(); ui.render();
  assert.equal(h.snapshot(), original); assert.equal(h.selected(), ids.first); assert.equal(h.panel(), undefined);
  assert.equal(ui.labelControl('查看连接说明', 'select').props.value, fieldId);
  assert.ok(ui.text().includes('原材料和连线均保留'));
  occupiedField(); ui.render(); assert.equal(h.snapshot(), original); assert.ok(ui.text().includes('定位已过期'));
  h.connect(ids.replacement, 'out:text', ids.first, 'in:text');
  ui.button('查看相关内容：输入材料（内容 1）').props.onClick(); ui.render();
  const source = ui.flow().props.nodes.find((node: any) => node.id === ids.note);
  assert.equal(source.selected, true, 'Content source navigation selects the actual editable block');
  const sourcePanel = ui.elements().find(item => item.props['aria-label'] === '输入材料「原文」的原内容');
  assert.ok(sourcePanel, 'Generic base recovery opens the selected source field');
  assert.equal(ui.elements(sourcePanel).find(item => item.type === 'textarea')!.props.value, originalDocument.nodes[0].values.content);
  assert.equal(h.snapshot(), original); assert.equal(h.panel(), undefined);

  // Dragging another content field must not silently replace an existing field or literal.
  h.connect(ids.otherNote, 'field:content', ids.first, 'in:text'); h.checkFailure(original, ['已经有材料', '整理材料（步骤 1）']);
  h.connect(ids.note, 'field:content', ids.first, 'in:text'); h.checkFailure(original, ['整理材料（步骤 1）']);
  h.connect(ids.otherNote, 'field:content', ids.other, 'in:text'); h.checkFailure(original, ['已经有材料', '整理材料（步骤 4）']);
  h.connect(ids.replacement, 'out:text', ids.other, 'in:text'); h.checkFailure(original, ['整理材料（步骤 4）']);
  h.connect(ids.otherNote, 'field:content', ids.tail, 'in:text'); h.checkFailure(original, ['再读结果（步骤 5）', '再次读取的原文']);

  // Existing native data links are named rather than silently displaced; identical links are rejected as duplicates.
  h.connect(ids.other, 'out:value', ids.text, 'in:value'); h.checkFailure(original, ['生成文字（步骤 2）', '待保存内容']);
  const occupiedData = h.existing(); occupiedData(); ui.render();
  assert.equal(h.selected(), ids.text); assert.equal(ui.labelControl('查看连接说明', 'select').props.value, firstDataId);
  assert.equal(h.snapshot(), original);
  h.connect(ids.first, 'out:value', ids.text, 'in:value'); h.checkFailure(original, ['连接']);
  assert.ok(ordinaryText(h.panel()).includes('这条连接已经存在'));

  // Another rejected attempt supersedes the prior diagnostic; the old panel is not a durable edit/navigation ticket.
  const superseded = h.related('生成文字（步骤 2）');
  h.connect(ids.replacement, 'out:text', ids.text, 'in:value'); assert.equal(h.panel(), undefined);
  const priorSelection = h.selected(); superseded(); ui.render();
  assert.equal(h.selected(), priorSelection); assert.equal(h.snapshot(), original); assert.ok(ui.text().includes('定位已过期'));
  h.connect(ids.first, 'out:value', ids.text, 'in:value'); h.checkFailure(original, ['连接']);

  // Selection retirement is immediate, even before the deferred React render and for duplicate callbacks.
  const staleSelection = h.related('生成文字（步骤 2）');
  h.focus(ids.other); staleSelection(); ui.render();
  assert.equal(h.selected(), ids.other); assert.equal(h.snapshot(), original); assert.equal(h.panel(), undefined);
  assert.ok(ui.text().includes('定位已过期'));

  // Edit -> undo cannot revive old recovery buttons even when all document bytes and selection match again.
  h.focus(ids.first); h.connect(ids.replacement, 'out:text', ids.first, 'in:text');
  const staleHistory = h.related('整理材料（步骤 1）');
  ui.button('清除输入 text').props.onClick(); ui.render(); assert.equal(h.panel(), undefined);
  ui.keyShortcut('undo'); ui.render(); assert.equal(h.snapshot(), original);
  staleHistory(); ui.render(); assert.equal(h.snapshot(), original); assert.ok(ui.text().includes('定位已过期'));

  // Explicit material choice is the replacement action. Diagnosis/navigation never makes it for the user.
  h.connect(ids.replacement, 'out:text', ids.first, 'in:text'); h.related('整理材料（步骤 1）')(); ui.render();
  const material = ui.labelControl('为待整理原文选择材料', 'select');
  material.props.onChange({ target: { value: JSON.stringify(['output', ids.replacement, 'text']) } }); ui.render();
  assert.equal(h.document().execution.nodes.find((node: any) => node.id === ids.first).bindings.text, undefined);
  assert.equal(h.document().execution.links.length, originalDocument.execution!.links.length + 1);
  assert.equal(h.host().remainingCalls, 64); assert.equal(h.host().workflowHistory().length, 0); assert.equal(ui.modelCalls(), 0);
  h.focus(ids.text); ui.button('运行所选步骤').props.onClick();
  for (let i = 0; i < 100 && h.host().workflowHistory().at(-1)?.status !== 'succeeded'; i++) { await new Promise(resolve => setImmediate(resolve)); ui.render(); }
  const run = h.host().workflowHistory().at(-1)!; assert.equal(run.status, 'succeeded');
  assert.deepEqual(new Set(run.nodes.map(node => node.nodeId)), new Set([ids.replacement, ids.first, ids.text]));
  const artifact = h.host().currentArtifact(run.nodes.find(node => node.nodeId === ids.text)!.artifactIds[0]);
  assert.equal(artifact.payload.kind, 'inline');
  if (artifact.payload.kind === 'inline') assert.deepEqual(JSON.parse(artifact.payload.value as string), replacementValue);
  assert.equal(h.host().remainingCalls, 61); assert.equal(ui.modelCalls(), 0);

  // A pure data cycle is rejected atomically; selecting a downstream result also cannot replace the old material.
  const emptySource = structuredClone(originalDocument); delete emptySource.execution!.nodes[0].bindings.text;
  const cycle = makeUi(readS2Document(emptySource, definition)); const cycleOriginal = cycle.snapshot();
  cycle.connect(ids.text, 'out:text', ids.first, 'in:text'); cycle.checkFailure(cycleOriginal, ['循环', '整理材料（步骤 1）', '生成文字（步骤 2）']);
  assert.ok(cycle.ui.elements(cycle.panel()).some(e => e.type === 'button' && cycle.ui.text(e).startsWith('查看已有连接：')));
  const pickerCycle = makeUi(); pickerCycle.focus(ids.first); const pickerOriginal = pickerCycle.snapshot();
  pickerCycle.ui.labelControl('为待整理原文选择材料', 'select').props.onChange({ target: { value: JSON.stringify(['output', ids.text, 'text']) } }); pickerCycle.ui.render();
  pickerCycle.checkFailure(pickerOriginal, ['循环']);
  assert.equal(pickerCycle.document().execution.nodes[0].bindings.text.kind, 'field');

  // Condition editing traverses the same native data + control dependency check.
  const mixed = makeUi(); mixed.focus(ids.first); const mixedOriginal = mixed.snapshot();
  const condition = mixed.ui.elements().find(e => e.type === 'condition-editor')!;
  assert.throws(() => condition.props.onApply({ nodeId: ids.tail, portId: 'value', pointer: '', equals: null, match: true }, condition.props.sourceKey), /循环/);
  mixed.ui.render(); mixed.checkFailure(mixedOriginal, ['循环', '整理材料（步骤 1）', '再读结果（步骤 5）']);
  assert.equal(mixed.document().execution.nodes[0].when, undefined);
  const mixedLocate = mixed.related('再读结果（步骤 5）'); mixedLocate(); mixed.ui.render();
  assert.equal(mixed.selected(), ids.tail); assert.equal(mixed.snapshot(), mixedOriginal);

  // Preview -> running and running -> finished retire explanations and their saved callbacks.
  const phase = makeUi(); const phaseOriginal = phase.snapshot();
  phase.connect(ids.first, 'out:value', ids.text, 'in:value'); const previewLocate = phase.related('生成文字（步骤 2）');
  phase.ui.button('开始试验').props.onClick(); phase.ui.render(); assert.equal(phase.panel(), undefined);
  previewLocate(); phase.ui.render(); assert.equal(phase.snapshot(), phaseOriginal); assert.ok(phase.ui.text().includes('定位已过期'));
  phase.connect(ids.first, 'out:value', ids.text, 'in:value'); const endedLocate = phase.related('生成文字（步骤 2）');
  phase.ui.button('结束试验').props.onClick(); phase.ui.render(); assert.equal(phase.panel(), undefined);
  endedLocate(); phase.ui.render(); assert.equal(phase.snapshot(), phaseOriginal); assert.ok(phase.ui.text().includes('定位已过期'));
  assert.equal(phase.host().remainingCalls, 64); assert.equal(phase.host().workflowHistory().length, 0); assert.equal(phase.ui.modelCalls(), 0);

  // A proxy connection resolves to the real inner receiver. Navigation opens that layer but makes no graph edit.
  const wrapped = wrapS2CanvasComposite(originalDocument, definition.plugins, [ids.first, ids.text, ids.tail], '整理组合');
  const compositeDocument = readS2Document(wrapped.document, definition), composite = makeUi(compositeDocument);
  const blueprint = s2CanvasCompositeBlueprint(compositeDocument, compositeDocument.composites!.find(item => item.id === wrapped.id)!, definition.plugins);
  const inlet = blueprint.inputs.find(port => port.targets.some(target => target.nodeId === ids.first && target.portId === 'text'))!;
  assert.ok(inlet, 'Composite exposes the actual occupied text input');
  const compositeOriginal = composite.snapshot();
  composite.connect(ids.replacement, 'out:text', wrapped.id, `in:${inlet.id}`);
  composite.checkFailure(compositeOriginal, ['整理材料（步骤 1）']);
  const oldProxyLocate = composite.related('整理材料（步骤 1）'); oldProxyLocate(); composite.ui.render();
  assert.equal(composite.selected(), ids.first); assert.equal(composite.snapshot(), compositeOriginal);
  assert.ok(composite.ui.flow().props.nodes.some((node: any) => node.id === ids.first));
  assert.ok(!composite.ui.flow().props.nodes.some((node: any) => node.id === wrapped.id));
  assert.ok(composite.ui.text().includes('原材料和连线均保留'));
  oldProxyLocate(); composite.ui.render(); assert.equal(composite.snapshot(), compositeOriginal); assert.ok(composite.ui.text().includes('定位已过期'));

  const view = makeUi(compositeDocument); const viewOriginal = view.snapshot();
  view.connect(ids.replacement, 'out:text', wrapped.id, `in:${inlet.id}`);
  const staleView = view.related('整理材料（步骤 1）');
  view.ui.button('进入内部 · 整理组合').props.onClick(); view.ui.render(); assert.equal(view.panel(), undefined);
  staleView(); view.ui.render(); assert.equal(view.snapshot(), viewOriginal); assert.ok(view.ui.text().includes('定位已过期'));
  assert.equal(view.selected(), '', 'A stale parent-view diagnostic cannot choose an inner node after a manual layer change');

  const nested = wrapS2CanvasComposite(compositeDocument, definition.plugins, [ids.first, ids.text, ids.tail], '外层组合');
  const nestedDocument = readS2Document(nested.document, definition), nestedUi = makeUi(nestedDocument);
  const nestedBlueprint = s2CanvasCompositeBlueprint(nestedDocument, nestedDocument.composites!.find(item => item.id === nested.id)!, definition.plugins);
  const nestedInlet = nestedBlueprint.inputs.find(port => port.targets.some(target => target.nodeId === ids.first && target.portId === 'text'))!;
  const nestedOriginal = nestedUi.snapshot(); nestedUi.connect(ids.replacement, 'out:text', nested.id, `in:${nestedInlet.id}`);
  nestedUi.related('整理材料（步骤 1）')(); nestedUi.ui.render();
  assert.equal(nestedUi.snapshot(), nestedOriginal); assert.equal(nestedUi.selected(), ids.first);
  assert.ok(nestedUi.ui.flow().props.nodes.some((node: any) => node.id === ids.first));
  assert.ok(!nestedUi.ui.flow().props.nodes.some((node: any) => node.id === wrapped.id), 'Recovery enters the deepest owning layer, not merely its outer wrapper');

  const deferred = makeUi(originalDocument, true); const deferredOriginal = deferred.snapshot();
  deferred.connect(ids.first, 'out:value', ids.text, 'in:value');
  const firstLocate = deferred.related('生成文字（步骤 2）'); firstLocate(); firstLocate(); deferred.ui.render();
  assert.equal(deferred.selected(), ids.text); assert.equal(deferred.snapshot(), deferredOriginal); assert.equal(deferred.panel(), undefined);
  assert.ok(deferred.ui.text().includes('定位已过期'), 'Consumed navigation ref retires before React applies queued state updates');
  assert.equal(network, 0);
  console.log('S2 connection recovery UI passed: occupied field/literal/data inputs and duplicate wires, no silent field replacement, pure and mixed dependency cycles, native atomic document preservation, metadata-only readable diagnostics, read-only recovery and composite navigation, selection/history/phase/consumption staleness, explicit material replacement followed by a separate exact native run. Synthetic offline only.');
} finally { uis.forEach(ui => ui.dispose()); globalThis.fetch = previousFetch; }
