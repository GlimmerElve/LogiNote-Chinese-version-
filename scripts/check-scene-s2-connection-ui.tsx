import assert from 'node:assert/strict';
import { createS2Scene, readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { s2ExecutionLinkKey } from '../src/services/scene/sceneS2Workflow';
import { wrapS2CanvasComposite } from '../src/services/scene/sceneS2CompositeCanvas';
import { harness } from './scene-s2-ui-harness';
import { useGenericS2CanvasUi } from './fixtures/s2-generic-canvas-ui';

// Real production handlers and host, deterministic hooks. This is not browser pointer/layout QA.
const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const literal = (value: any) => ({ kind: 'literal', value });
const ids = { first: 'PRIVATE_CONTENT_A', second: 'PRIVATE_CONTENT_B', source: 'PRIVATE_PARSE_A', other: 'PRIVATE_PARSE_B',
  target: 'PRIVATE_STRINGIFY', condition: 'PRIVATE_CONDITION', view: 'PRIVATE_TREE' };
const text = '{"ready":true,"score":80,"zero":0,"enabled":false,"empty":null,"note":"PRIVATE_BODY_MARKER"}';
const definition = readS2Definition({ version: 1, goal: '合成可读连接验收',
  instructions: { understanding: '区分解释、编辑与运行', planning: '仅明确操作后执行', response: '以本地实际结果说明' },
  blockTypes: [{ id: 'note', label: '输入材料', fields: [{ id: 'content', label: '原文', kind: 'multiline' }] }],
  plugins: [cap('parse-json'), cap('stringify'), cap('json-tree', 'structured-view')],
  initial: { nodes: [
    { id: ids.first, type: 'note', position: { x: 0, y: 0 }, values: { content: text } },
    { id: ids.second, type: 'note', position: { x: 0, y: 260 }, values: { content: 'PRIVATE_OTHER_BODY' } },
  ], edges: [{ id: 'PRIVATE_ASSOCIATION', source: ids.first, target: ids.second, label: '辅助说明' }], execution: { version: 1, nodes: [
    { id: ids.source, ...cap('parse-json'), position: { x: 320, y: 0 }, bindings: { text: { kind: 'field', nodeId: ids.first, fieldId: 'content' } },
      presentation: { label: '整理材料', inputs: { text: '待整理原文' }, outputs: { value: '整理结果' } } },
    { id: ids.other, ...cap('parse-json'), position: { x: 320, y: 260 }, bindings: { text: literal('{}') }, presentation: { label: '整理材料' } },
    { id: ids.target, ...cap('stringify'), position: { x: 640, y: 0 }, bindings: {},
      presentation: { label: '保存为文字', inputs: { value: '待保存内容' }, outputs: { text: '保存文本' } } },
    { id: ids.condition, ...cap('stringify'), position: { x: 640, y: 260 }, bindings: { value: literal({ proof: 0 }) },
      when: { nodeId: ids.source, portId: 'value', pointer: '/ready', equals: true, match: true }, presentation: { label: '按条件生成说明' } },
    { id: ids.view, ...cap('json-tree', 'structured-view'), position: { x: 640, y: 520 }, bindings: {}, presentation: { label: '查看结果结构' } },
  ], links: [
    { source: { nodeId: ids.source, portId: 'value' }, target: { nodeId: ids.target, portId: 'value' } },
    { source: { nodeId: ids.source, portId: 'value' }, target: { nodeId: ids.view, portId: 'value' } },
  ] } },
});
const document = definition.initial, dataLink = document.execution!.links[0], dataId = s2ExecutionLinkKey(dataLink);
const fieldId = JSON.stringify([ids.source, 'text', document.execution!.nodes[0].bindings.text]);
const conditionId = JSON.stringify(['condition', ids.condition]);
const previousFetch = globalThis.fetch; let network = 0;
// Generic association-panel compatibility; prompt intentionally omits content settings.
const restoreCanvasUi = useGenericS2CanvasUi();
globalThis.fetch = async () => { network++; throw new Error('Connection UI acceptance forbids real network IO'); };
const uis: ReturnType<typeof harness>[] = [];
function makeUi(initial = document) {
  const scene = createS2Scene({ source: 'custom', subject: '合成连接说明', sceneSkill: 'S2', knowledgePoints: [], interactionPack: null });
  scene.canvasWorkspace = { ...definition, initial };
  let host!: S2PluginHost;
  const ui = harness({ initialDraft: scene, onHost: value => { host = value; } }); uis.push(ui);
  assert.ok(ui.flow().props.nodes.filter((node: any) => node.type !== 'composite').every((node: any) => node.data.referenceLabel === undefined), 'Ordinary content/step nodes omit technical ordinals');
  assert.ok(ui.flow().props.edges.every((edge: any) => edge.label === undefined), 'Ordinary canvas omits permanent connection labels');
  ui.button('更多').props.onClick(); ui.render();
  const diagnosticLabel = ui.elements().find(element => element.type === 'label' && ui.text(element) === '开发诊断（显示技术信息）'); assert.ok(diagnosticLabel);
  ui.elements(diagnosticLabel).find(element => element.type === 'input')!.props.onChange({ target: { checked: true } }); ui.render();
  const section = () => ui.elements().find(e => e.type === 'section' && e.props['aria-label'] === '连接说明')!;
  const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
  const edge = (id: string) => { const found = ui.flow().props.edges.find((item: any) => item.id === id); assert.ok(found, id); return found; };
  const show = (id: string) => { ui.flow().props.onEdgeClick({}, edge(id)); ui.render(); };
  const snapshot = () => JSON.stringify({
    content: ui.flow().props.nodes.filter((n: any) => n.type === 'block').map((n: any) => [n.id, n.data.fields]),
    nodes: ui.flow().props.nodes.filter((n: any) => n.type === 'execution').map((n: any) => n.data.node),
    edges: ui.flow().props.edges.map((e: any) => [e.id, e.source, e.target, e.sourceHandle, e.targetHandle]).sort((a: any[], b: any[]) => a[0].localeCompare(b[0])),
  });
  const disconnect = () => ui.elements().find(e => e.type === 'button' && ui.text(e) === '断开数据线')!;
  const ordinaryText = (root: any): string => Array.isArray(root) ? root.map(ordinaryText).join('')
    : root && typeof root === 'object' ? root.type === 'details' ? '' : ordinaryText(root.children) : String(root ?? '');
  return { ui, section, focus, edge, show, snapshot, disconnect, ordinaryText, host: () => host };
}
try {
  const h = makeUi(), { ui } = h;
  const original = h.snapshot();
  assert.equal(ui.flow().props.nodes.find((n: any) => n.id === ids.first).data.title, '输入材料');
  assert.equal(ui.flow().props.nodes.find((n: any) => n.id === ids.second).data.title, '输入材料');
  assert.equal(ui.flow().props.nodes.find((n: any) => n.id === ids.source).data.referenceLabel, '步骤 1');
  assert.equal(ui.flow().props.nodes.find((n: any) => n.id === ids.other).data.referenceLabel, '步骤 2');
  const expected = [[dataId, '交给待保存内容', '步骤 1', '步骤 3', '连线本身不运行'],
    [fieldId, '使用原文', '内容 1', '步骤 1', '不是执行前置步骤'],
    [conditionId, '相等时运行', '步骤 1', '步骤 4', '不表示条件已满足'],
    ['PRIVATE_ASSOCIATION', '关系：辅助说明', '内容 1', '内容 2', '不传递数据']];
  for (const [id, short, from, to, meaning] of expected) {
    const edge = h.edge(id); assert.equal(edge.label, short); assert.ok(edge.ariaLabel.includes(from)); assert.ok(edge.ariaLabel.includes(to));
    assert.ok(!edge.ariaLabel.includes('PRIVATE_')); assert.ok(!edge.ariaLabel.includes('structured-data'));
    h.show(id); const section = h.section(), visible = h.ordinaryText(section);
    assert.ok(visible.includes(edge.ariaLabel)); assert.ok(visible.includes(meaning));
    assert.ok(!visible.includes('PRIVATE_')); assert.ok(!visible.includes('core.text')); assert.ok(!visible.includes('parse-json'));
    const advanced = ui.elements(section).find(e => e.type === 'details')!;
    assert.equal(advanced.props.open, undefined); assert.ok(ui.text(advanced).startsWith('这条连接的技术详情'));
    assert.ok(!ui.text(advanced).includes('PRIVATE_BODY_MARKER')); assert.ok(!ui.text(advanced).includes('PRIVATE_OTHER_BODY'));
  }
  assert.equal(h.snapshot(), original, 'Inspecting each edge does not modify design or read field values');
  ui.flow().props.onEdgeClick({}, { id: dataId, source: ids.other, target: ids.condition, label: '伪造显示内容' }); ui.render();
  assert.ok(h.ordinaryText(h.section()).includes('整理材料（步骤 1）'));
  assert.ok(h.ordinaryText(h.section()).includes('保存为文字（步骤 3）'));
  assert.ok(!h.ordinaryText(h.section()).includes('伪造显示内容'), 'Only native edge identity selects the actual design explanation');
  const previewDisconnect = h.disconnect().props.onClick;
  ui.button('开始试验').props.onClick(); ui.render(); const host = h.host();
  previewDisconnect(); ui.render(); assert.equal(h.snapshot(), original, 'Preview callback cannot edit a started session');
  assert.ok(ui.text().includes('连接操作已过期'));
  h.focus(ids.target);
  const incompatibles = ui.elements().filter(e => e.type === 'details' && ui.elements(e).some(c => c.type === 'summary' && ui.text(c) === '为何其他结果不能直接使用'));
  assert.ok(incompatibles.length); assert.equal(incompatibles[0].props.open, undefined);
  assert.ok(ui.text(incompatibles[0]).includes('这里需要结构化数据')); assert.ok(ui.text(incompatibles[0]).includes('提供文字'));
  assert.ok(!ui.text(incompatibles[0]).includes('PRIVATE_')); assert.ok(!ui.text(incompatibles[0]).includes('structured-data'));
  const material = ui.labelControl('为待保存内容选择材料', 'select');
  const badOutput = JSON.stringify(['output', ids.condition, 'text']);
  assert.ok(!ui.elements(material).some(e => e.type === 'option' && e.props.value === badOutput));
  material.props.onChange({ target: { value: badOutput } }); ui.render();
  assert.equal(h.snapshot(), original, 'Forged incompatible selection cannot change native graph');
  ui.flow().props.onConnect({ source: ids.condition, sourceHandle: 'out:text', target: ids.target, targetHandle: 'in:value' }); ui.render();
  assert.equal(h.snapshot(), original); assert.ok(ui.text().includes('不能直接连接'));
  const error = ui.elements().find(e => e.props.role === 'alert')!;
  assert.ok(ui.text(error).includes('文字')); assert.ok(ui.text(error).includes('结构化数据')); assert.ok(!ui.text(error).includes('PRIVATE_'));
  assert.equal(host.history().length, 0); assert.equal(host.workflowHistory().length, 0); assert.equal(ui.modelCalls(), 0);

  // Stale disconnects fail after a semantic edit and after undo restores identical graph bytes.
  const oldDisconnect = h.disconnect().props.onClick;
  h.focus(ids.other); ui.labelControl('参数 text', 'textarea').props.onChange({ target: { value: '{"changed":1}' } }); ui.render();
  const changed = h.snapshot(); oldDisconnect(); ui.render(); assert.equal(h.snapshot(), changed);
  ui.keyShortcut('undo'); ui.render(); assert.equal(h.snapshot(), original);
  oldDisconnect(); ui.render(); assert.equal(h.snapshot(), original, 'Undo cannot revive an older destructive callback');
  // Fresh disconnect and reconnect modify only the exact native edge, without running.
  h.disconnect().props.onClick(); ui.render(); assert.ok(!ui.flow().props.edges.some((e: any) => e.id === dataId));
  assert.ok(ui.flow().props.edges.some((e: any) => e.id === fieldId)); assert.ok(ui.flow().props.edges.some((e: any) => e.id === conditionId));
  ui.flow().props.onConnect({ source: ids.source, sourceHandle: 'out:value', target: ids.target, targetHandle: 'in:value' }); ui.render();
  assert.equal(h.snapshot(), original); assert.equal(host.history().length, 0); assert.equal(host.remainingCalls, 64);
  // Human association controls use names and stable global ordinals, not IDs.
  ui.labelControl('选择块', 'select').props.onChange({ target: { value: ids.first } }); ui.render();
  const related = ui.labelControl('内容关联目标', 'select'); assert.ok(ui.text(related).includes('输入材料（内容 2）')); assert.ok(!ui.text(related).includes('PRIVATE_'));
  h.focus(ids.target); ui.button('运行所选步骤').props.onClick();
  for (let i = 0; i < 100 && host.workflowHistory().at(-1)?.status !== 'succeeded'; i++) { await new Promise(resolve => setImmediate(resolve)); ui.render(); }
  const run = host.workflowHistory().at(-1)!; assert.equal(run.status, 'succeeded');
  const output = host.currentArtifact(run.nodes.find(n => n.nodeId === ids.target)!.artifactIds[0]);
  assert.equal(output.payload.kind, 'inline'); if (output.payload.kind === 'inline') {
    assert.equal(typeof output.payload.value, 'string'); assert.deepEqual(JSON.parse(output.payload.value as string), JSON.parse(text));
  }
  const calls = host.remainingCalls, endedDisconnect = h.disconnect().props.onClick;
  h.show(dataId); assert.equal(host.remainingCalls, calls); assert.equal(ui.modelCalls(), 0);
  ui.button('结束试验').props.onClick(); ui.render(); const ended = h.snapshot();
  endedDisconnect(); ui.render(); assert.equal(h.snapshot(), ended); assert.equal(h.disconnect().props.disabled, true);
  h.disconnect().props.onClick(); ui.render(); assert.equal(h.snapshot(), ended, 'Disabled ended controls also reject direct stale-event invocation');
  h.show(conditionId); assert.ok(h.ordinaryText(h.section()).includes('不表示条件已满足'), 'Ended scene still permits reading connection explanations');
  ui.labelControl('查看连接说明', 'select').props.onChange({ target: { value: 'forged-edge' } }); ui.render();
  assert.equal(ui.labelControl('查看连接说明', 'select').props.value, conditionId, 'Unknown edge ID does not replace current inspection');
  assert.equal(host.remainingCalls, calls); assert.equal(ui.modelCalls(), 0);

  // Display proxies keep original edge identity and true internal endpoint semantics.
  const wrapped = wrapS2CanvasComposite(document, definition.plugins, [ids.source, ids.other], '整理组合');
  const compositeDoc = readS2Document(wrapped.document, definition), proxy = makeUi(compositeDoc);
  const drawn = proxy.edge(dataId); assert.equal(drawn.source, wrapped.id); assert.equal(drawn.id, dataId);
  assert.ok(drawn.ariaLabel.includes('整理材料（步骤 1）')); assert.ok(!drawn.ariaLabel.includes(wrapped.id));
  proxy.show(dataId); assert.ok(proxy.ordinaryText(proxy.section()).includes('整理组合（组合 1）'));
  assert.ok(proxy.ordinaryText(proxy.section()).includes('实际内部来源与接收位置以上方说明为准'));
  const oldProxyDisconnect = proxy.disconnect().props.onClick, oldProxyInspect = proxy.ui.flow().props.onEdgeClick;
  proxy.ui.button('进入内部 · 整理组合').props.onClick(); proxy.ui.render(); const inside = proxy.snapshot();
  oldProxyDisconnect(); proxy.ui.render(); assert.equal(proxy.snapshot(), inside, 'A parent-view disconnect is stale after entering a combination');
  oldProxyInspect({}, drawn); proxy.ui.render();
  assert.equal(proxy.ui.labelControl('查看连接说明', 'select').props.value, '', 'Old parent-view edge click cannot select an invisible internal link');
  assert.equal(proxy.ui.modelCalls(), 0);
  const grouped = makeUi(readS2Document({ ...structuredClone(document), groups: [{ id: 'PRIVATE_GROUP', label: '材料处理组', nodeIds: [ids.source], collapsed: true }] }, definition));
  assert.equal(grouped.edge(dataId).source, 'PRIVATE_GROUP'); grouped.show(dataId);
  assert.ok(grouped.ordinaryText(grouped.section()).includes('材料处理组')); assert.ok(grouped.ordinaryText(grouped.section()).includes('整理材料（步骤 1）'));
  assert.ok(!grouped.ordinaryText(grouped.section()).includes('PRIVATE_GROUP')); assert.equal(grouped.ui.modelCalls(), 0);
  assert.equal(network, 0);
  console.log('S2 connection UI passed: real production labels/edge selection, four distinct meanings, duplicate-name ordinals, collapsed technical details without content leakage, explanatory incompatible sources and atomic rejection, no implicit execution, exact disconnect/reconnect plus phase/edit/undo/end staleness, composite/group identity, and unchanged native execution. Synthetic offline only; not browser layout or real-model semantic acceptance.');
} finally { uis.forEach(ui => ui.dispose()); restoreCanvasUi(); globalThis.fetch = previousFetch; }
