import assert from 'node:assert/strict';
import type { S2CanvasDefinition, S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import type { S2Artifact, S2ExecutionLink, S2Json } from '../src/types/sceneS2Plugin';
import { createS2Scene, exportS2Workspace, importS2Workspace, readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { prepareS2FieldChoices, readS2FieldChoices, applyS2FieldChoice } from '../src/services/scene/sceneS2FieldChoices';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { executeS2Structured, selectS2Pointer } from '../src/services/scene/sceneS2Structured';
import { harness } from './scene-s2-ui-harness';

// Real field-choice service, production UI handlers and real local Host. All materials are synthetic.
const cap = (capabilityId: string) => ({ pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId });
const literal = (value: S2Json) => ({ kind: 'literal' as const, value });
const node = (id: string, capabilityId: string, bindings: S2WorkflowNode['bindings']): S2WorkflowNode => ({
  id, ...cap(capabilityId), position: { x: 100, y: 100 }, bindings,
});
const link = (source: string, output: string, target: string, input: string): S2ExecutionLink => ({
  source: { nodeId: source, portId: output }, target: { nodeId: target, portId: input },
});
const data: S2Json = {
  'a/b': { '~key': [false, 0, null, '', { '': 'PRIVATE_SCALAR_DO_NOT_LABEL' }] },
  '': { ' slash/tilde~ ': true }, rows: [{ name: '合成甲', optional: null }, { name: '' }],
};
const definition = readS2Definition({
  version: 1, goal: '合成字段选择验收；只查看已有数据，不猜字段或隐式执行。',
  instructions: { understanding: '区分查看、选择、应用与运行。', planning: '只在授权能力内操作。', response: '保留原材料和连线。' },
  blockTypes: [{ id: 'note', label: '合成材料块', fields: [{ id: 'content', label: '填写内容', kind: 'multiline' }] }],
  plugins: ['parse-json', 'select', 'stringify'].map(cap), initial: {
    nodes: [{ id: 'source', type: 'note', position: { x: 0, y: 0 }, values: { content: JSON.stringify(data) } },
      { id: 'pointerSource', type: 'note', position: { x: 0, y: 240 }, values: { content: '/rows' } }], edges: [],
    execution: { version: 1, nodes: [
      node('fixed', 'select', { value: literal(data), pointer: literal('/missing') }),
      { ...node('parse', 'parse-json', { text: { kind: 'field', nodeId: 'source', fieldId: 'content' } }), presentation: { label: '解析合成材料' } },
      node('connected', 'select', { pointer: literal('') }),
      node('dynamic', 'select', { value: literal(data), pointer: { kind: 'field', nodeId: 'pointerSource', fieldId: 'content' } }),
      node('pointerText', 'stringify', { value: literal('/rows') }),
      node('linkedPointer', 'select', { value: literal(data) }),
    ], links: [link('parse', 'value', 'connected', 'value'), link('pointerText', 'text', 'linkedPointer', 'pointer')] },
  },
});
const document = structuredClone(definition.initial), original = JSON.stringify(definition), originalDoc = JSON.stringify(document);
const initialFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Field choices do not access models, notes or network'); };
const hosts: S2PluginHost[] = [], uis: ReturnType<typeof harness>[] = [];
const hostFor = (definition: S2CanvasDefinition, document: S2Document) => {
  const host = new S2PluginHost('field-choice-synthetic', definition); hosts.push(host); host.setDocument(document); return host;
};
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await tick(); } assert.fail('Synthetic field-choice deadline'); }
const exactPointerOnly = (before: S2Document, after: S2Document, id: string, pointer: string) => {
  const expected = structuredClone(before); expected.execution!.nodes.find(node => node.id === id)!.bindings.pointer = literal(pointer);
  assert.deepEqual(after, expected, 'Only the selected literal pointer changes; full source, other values and both kinds of wiring survive');
  assert.deepEqual(readS2Document(after, definition), after);
};
try {
  const fixed = prepareS2FieldChoices(definition, document, 'fixed');
  assert.equal(fixed.sourceLabel, '本步骤已填写的固定材料'); assert.equal(fixed.current, null); assert.equal(fixed.canApply, true);
  assert.deepEqual(fixed.options[0], { pointer: '', label: '整体数据', type: '对象' });
  const expectedPointers = ['', '/a~1b', '/a~1b/~0key', ...Array.from({ length: 5 }, (_, i) => `/a~1b/~0key/${i}`),
    '/a~1b/~0key/4/', '/', '// slash~1tilde~0 ', '/rows', '/rows/0', '/rows/0/name', '/rows/0/optional', '/rows/1', '/rows/1/name'];
  assert.deepEqual(fixed.options.map(option => option.pointer), expectedPointers);
  assert.deepEqual(fixed.options.filter(option => /^\/a~1b\/~0key\/[0-3]$/.test(option.pointer)).map(option => option.type), ['布尔值', '数字', '空值', '文字']);
  assert.ok(fixed.options.some(option => option.label.includes('字段「a/b」') && option.label.includes('字段「~key」') && option.label.includes('第1项')));
  assert.ok(fixed.options.some(option => option.pointer === '/' && option.label.includes('（空名称）')));
  assert.ok(!JSON.stringify(fixed).includes('PRIVATE_SCALAR_DO_NOT_LABEL'), 'Names and types do not disclose scalar values');
  assert.ok(!JSON.stringify(fixed).includes('合成甲'));
  const readable = readS2FieldChoices(fixed, definition, document); assert.deepEqual(readable, fixed); assert.notEqual(readable, fixed);
  readable.options[0].label = '改动显示副本'; assert.equal(readS2FieldChoices(fixed, definition, document).options[0].label, '整体数据');
  assert.throws(() => applyS2FieldChoice(readable, definition, document, ''), /宿主/);
  for (const pointer of ['', '/a~1b/~0key/0', '/a~1b/~0key/1', '/a~1b/~0key/2', '/a~1b/~0key/3', '/a~1b/~0key/4/', '// slash~1tilde~0 ']) {
    const result = applyS2FieldChoice(fixed, definition, document, pointer); exactPointerOnly(document, result, 'fixed', pointer);
    assert.equal(prepareS2FieldChoices(definition, result, 'fixed').current, pointer);
    assert.deepEqual(importS2Workspace(exportS2Workspace(definition, result)).initial, result);
  }
  for (const pointer of ['/absent', 'rows/0', '/a/b', '/a~2b', '/rows/02', '/rows/-', null, false, 0]) {
    assert.throws(() => applyS2FieldChoice(fixed, definition, document, pointer as string));
  }
  assert.throws(() => readS2FieldChoices(structuredClone(fixed), definition, document), /宿主/);
  assert.throws(() => readS2FieldChoices({ ...fixed }, definition, document), /宿主/);
  const tampered = prepareS2FieldChoices(definition, document, 'fixed'); tampered.options[0].pointer = '/forged';
  assert.throws(() => applyS2FieldChoice(tampered, definition, document, '/forged'), /宿主/);
  const tamperedCanApply = prepareS2FieldChoices(definition, document, 'dynamic'); tamperedCanApply.canApply = true;
  assert.throws(() => applyS2FieldChoice(tamperedCanApply, definition, document, '/rows'), /宿主/);
  const changed = structuredClone(document); changed.nodes[0].values.content += '\n';
  assert.throws(() => readS2FieldChoices(fixed, definition, changed), /已变化/);
  const moved = structuredClone(document); moved.execution!.nodes[0].position.x++;
  assert.throws(() => applyS2FieldChoice(fixed, definition, moved, ''), /已变化/, 'Even nonsemantic full-graph edits require a fresh report');
  const config = structuredClone(definition); config.instructions.response += '新策略';
  assert.throws(() => applyS2FieldChoice(fixed, config, document, ''), /已变化/);
  for (const id of ['dynamic', 'linkedPointer']) {
    const dynamic = prepareS2FieldChoices(definition, document, id); assert.equal(dynamic.canApply, false); assert.equal(dynamic.current, null);
    assert.throws(() => applyS2FieldChoice(dynamic, definition, document, '/rows'), /原引用/);
  }
  for (const id of ['parse', 'missing', 'pointerText']) assert.throws(() => prepareS2FieldChoices(definition, document, id), /不支持/);
  const unbound = structuredClone(document); delete unbound.execution!.nodes.find(node => node.id === 'fixed')!.bindings.value;
  assert.throws(() => prepareS2FieldChoices(definition, unbound, 'fixed'), /未知结构/);
  assert.throws(() => prepareS2FieldChoices(definition, document, 'connected'), /单独运行/);
  const limit = (count: number) => { const copy = structuredClone(document); copy.execution!.nodes[0].bindings.value = literal(Array.from({ length: count }, (_, i) => i)); return copy; };
  assert.equal(prepareS2FieldChoices(definition, limit(255), 'fixed').options.length, 256);
  assert.throws(() => prepareS2FieldChoices(definition, limit(256), 'fixed'), /过大/);
  const tooLongLabel = structuredClone(document); tooLongLabel.execution!.nodes[0].bindings.value = literal({ ['名'.repeat(1025)]: 1 });
  assert.throws(() => prepareS2FieldChoices(definition, tooLongLabel, 'fixed'), /过大/);
  const largeReport = structuredClone(document);
  largeReport.execution!.nodes[0].bindings.value = literal({ ['名'.repeat(600)]: Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`item${i}`, 0])) });
  assert.deepEqual(readS2Document(largeReport, definition), largeReport, 'The native input is valid and below its own data limits');
  assert.throws(() => prepareS2FieldChoices(definition, largeReport, 'fixed'), /128000/, 'Path repetition may overflow the full report even with fewer than 256 short-enough labels; never issue an unreadable report');
  // Reject accessors before traversal or value extraction; no getter is executed at any trust boundary.
  let getters = 0;
  const hostileDocument = structuredClone(document);
  Object.defineProperty(hostileDocument.execution!.nodes[0].bindings.value, 'value', { enumerable: true, get() { getters++; return data; } });
  assert.throws(() => prepareS2FieldChoices(definition, hostileDocument, 'fixed'));
  const hostileDefinition = structuredClone(definition);
  Object.defineProperty(hostileDefinition.instructions, 'response', { enumerable: true, get() { getters++; return '不能执行'; } });
  assert.throws(() => prepareS2FieldChoices(hostileDefinition, document, 'fixed'));
  const hostileReport = prepareS2FieldChoices(definition, document, 'fixed');
  Object.defineProperty(hostileReport.options[0], 'label', { enumerable: true, get() { getters++; return '不能执行'; } });
  assert.throws(() => readS2FieldChoices(hostileReport, definition, document)); assert.equal(getters, 0);

  // Native local selection never uses truthiness: each falsy leaf is a complete, exact output.
  for (const [pointer, expected] of [['/a~1b/~0key/0', false], ['/a~1b/~0key/1', 0], ['/a~1b/~0key/2', null], ['/a~1b/~0key/3', '']] as const) {
    const selected = applyS2FieldChoice(fixed, definition, document, pointer), local = hostFor(definition, selected);
    assert.equal(local.history().length, 0); assert.equal(local.remainingCalls, 64);
    const result = await local.enqueueWorkflow(['fixed']).completion; assert.equal(result.status, 'succeeded');
    const artifact = local.readCurrentStructuredOutput('fixed', 'value'); assert.equal(artifact.payload.kind, 'inline');
    if (artifact.payload.kind === 'inline') assert.equal(artifact.payload.value, expected);
    assert.equal(local.remainingCalls, 63);
  }

  // A connected source is not inspected until its real local parse has separately run.
  const host = hostFor(definition, document), readOutput = (nodeId: string, portId: string) => host.readCurrentStructuredOutput(nodeId, portId);
  const beforeRun = host.remainingCalls;
  assert.throws(() => host.readCurrentStructuredOutput('parse', 'value'), /尚无/);
  assert.throws(() => prepareS2FieldChoices(definition, document, 'connected', readOutput), /尚无/);
  assert.equal(host.remainingCalls, beforeRun); assert.equal(host.history().length, 0);
  const parsed = await host.enqueueWorkflow(['parse']).completion; assert.equal(parsed.status, 'succeeded'); assert.equal(host.remainingCalls, beforeRun - 1);
  const output = readOutput('parse', 'value'); assert.equal(output.payload.kind, 'inline');
  assert.deepEqual(output.payload.kind === 'inline' && output.payload.value, data);
  const connected = prepareS2FieldChoices(definition, document, 'connected', readOutput);
  assert.ok(connected.sourceLabel.includes('解析合成材料')); assert.equal(connected.current, '');
  assert.deepEqual(connected.options, fixed.options); assert.equal(host.remainingCalls, beforeRun - 1); assert.equal(host.history().length, 1);
  assert.throws(() => host.readCurrentStructuredOutput('parse', output.id));
  assert.throws(() => host.readCurrentStructuredOutput('pointerText', 'text'));
  assert.throws(() => host.readCurrentStructuredOutput('connected', 'value'));
  if (output.payload.kind === 'inline') output.payload.value = 'changed clone';
  assert.deepEqual(readS2FieldChoices(connected, definition, document, readOutput), connected, 'Reader returns detached artifacts and does not mutate latest output');
  const genuine = readOutput('parse', 'value');
  for (const artifact of [{ ...genuine, complete: false }, { ...genuine, source: { ...genuine.source, nodeId: 'connected' } },
    { ...genuine, type: { id: 'core.text', version: 1 }, payload: { kind: 'inline', value: '{}' } },
    { ...genuine, payload: { kind: 'reference', artifactRef: 'not-a-full-value', bytes: 1, sha256: '0'.repeat(64) } }]) {
    assert.throws(() => prepareS2FieldChoices(definition, document, 'connected', () => artifact as S2Artifact));
  }
  const hostileArtifact = structuredClone(genuine);
  Object.defineProperty(hostileArtifact.payload, 'value', { enumerable: true, get() { getters++; return data; } });
  assert.throws(() => prepareS2FieldChoices(definition, document, 'connected', () => hostileArtifact)); assert.equal(getters, 0);
  const cacheJob = host.enqueueWorkflow(['parse']);
  assert.throws(() => readOutput('parse', 'value'), /尚无/, 'Enqueue invalidates the previous latest output synchronously, before a new run settles');
  assert.throws(() => readS2FieldChoices(connected, definition, document, readOutput), /尚无/);
  const cached = await cacheJob.completion;
  assert.equal(cached.nodes[0].status, 'cached'); assert.equal(host.remainingCalls, beforeRun - 1);
  assert.notEqual(readOutput('parse', 'value').id, genuine.id, 'Cached execution republishes a distinct current output identity');
  assert.throws(() => readS2FieldChoices(connected, definition, document, readOutput), /已变化/);
  const fresh = prepareS2FieldChoices(definition, document, 'connected', readOutput);
  const selected = applyS2FieldChoice(fresh, definition, document, '/a~1b/~0key/1', readOutput);
  exactPointerOnly(document, selected, 'connected', '/a~1b/~0key/1'); assert.equal(host.remainingCalls, beforeRun - 1);
  host.setDocument(selected);
  assert.throws(() => readS2FieldChoices(fresh, definition, selected, readOutput));
  assert.throws(() => readS2FieldChoices(fresh, definition, document, readOutput), /尚无|已失效|修订/);
  const selectedRun = await host.enqueueWorkflow(['connected']).completion; assert.equal(selectedRun.status, 'succeeded');
  const selectedOutput = host.readCurrentStructuredOutput('connected', 'value');
  assert.equal(selectedOutput.payload.kind, 'inline'); if (selectedOutput.payload.kind === 'inline') assert.equal(selectedOutput.payload.value, 0);
  assert.equal(host.remainingCalls, beforeRun - 2, 'Parse is cached after pointer-only edit; select alone adds one local invocation');
  const afterSelection = prepareS2FieldChoices(definition, selected, 'connected', readOutput); host.close();
  assert.throws(() => host.readCurrentStructuredOutput('parse', 'value'), /已结束/);
  assert.throws(() => readS2FieldChoices(afterSelection, definition, selected, readOutput), /已结束/);

  // Force, edit/undo and other runs all invalidate the exact source identity, even when payloads are equal.
  const lifecycle = hostFor(definition, document), lifecycleRead = (nodeId: string, portId: string) => lifecycle.readCurrentStructuredOutput(nodeId, portId);
  await lifecycle.enqueueWorkflow(['parse']).completion;
  const beforeForce = prepareS2FieldChoices(definition, document, 'connected', lifecycleRead), forceId = lifecycleRead('parse', 'value').id;
  const forceJob = lifecycle.enqueueWorkflow(['parse'], undefined, { force: true });
  assert.throws(() => lifecycleRead('parse', 'value'), /尚无/);
  assert.throws(() => applyS2FieldChoice(beforeForce, definition, document, '', lifecycleRead), /尚无/);
  assert.equal((await forceJob.completion).nodes[0].status, 'succeeded'); assert.notEqual(lifecycleRead('parse', 'value').id, forceId);
  assert.equal(lifecycle.remainingCalls, 62); assert.throws(() => readS2FieldChoices(beforeForce, definition, document, lifecycleRead), /已变化/);
  const beforeUndo = prepareS2FieldChoices(definition, document, 'connected', lifecycleRead), edited = structuredClone(document);
  edited.nodes[0].values.content += '\n'; lifecycle.setDocument(edited); lifecycle.setDocument(document);
  assert.throws(() => readS2FieldChoices(beforeUndo, definition, document, lifecycleRead), /尚无/);
  await lifecycle.enqueueWorkflow(['parse']).completion;
  assert.throws(() => applyS2FieldChoice(beforeUndo, definition, document, '', lifecycleRead), /已变化/, 'Restoring identical graph content does not restore the old run/revision artifact');
  const lifecycleReport = prepareS2FieldChoices(definition, document, 'connected', lifecycleRead), other = hostFor(definition, document);
  await other.enqueueWorkflow(['parse']).completion;
  const otherRead = (nodeId: string, portId: string) => other.readCurrentStructuredOutput(nodeId, portId);
  assert.notEqual(lifecycle.runId, other.runId);
  assert.throws(() => readS2FieldChoices(lifecycleReport, definition, document, otherRead), /已变化/);
  assert.throws(() => applyS2FieldChoice(lifecycleReport, definition, document, '/rows', otherRead), /已变化/);

  // A completed upstream output remains available during a downstream human wait and after cancelling only that wait.
  const waitDefinition = readS2Definition({ ...definition, plugins: [...definition.plugins, { pluginId: 'human-input', pluginVersion: '1.0.0', capabilityId: 'text' }],
    initial: { ...document, execution: { ...document.execution!, nodes: [...document.execution!.nodes,
      { ...node('wait', 'text', { prompt: literal('确认合成材料，不自动代答。') }), pluginId: 'human-input' }],
      links: [...document.execution!.links, link('parse', 'value', 'wait', 'context')] } } });
  const waiting = hostFor(waitDefinition, waitDefinition.initial), waitRead = (nodeId: string, portId: string) => waiting.readCurrentStructuredOutput(nodeId, portId);
  const waitJob = waiting.enqueueWorkflow(['wait']); await until(() => waiting.waitingHumanInputs().length === 1);
  const whileWaiting = prepareS2FieldChoices(waitDefinition, waitDefinition.initial, 'connected', waitRead), waitingId = waitRead('parse', 'value').id;
  assert.deepEqual(whileWaiting.options, fixed.options); assert.equal(waiting.remainingCalls, 63);
  waiting.cancelWorkflow(waitJob.id); assert.equal((await waitJob.completion).status, 'cancelled');
  assert.equal(waitRead('parse', 'value').id, waitingId); assert.deepEqual(readS2FieldChoices(whileWaiting, waitDefinition, waitDefinition.initial, waitRead), whileWaiting);

  // A failed rerun cannot fall back to an older successful same-revision artifact or its receipt preview.
  let failNext = false;
  const failHost = new S2PluginHost('field-choice-failure', definition, async (call, inputs) => failNext
    ? { status: 'failed', outputs: {}, error: { code: 'SYNTHETIC_REJECTED', message: '合成重跑失败' } }
    : executeS2Structured(call, inputs)); hosts.push(failHost); failHost.setDocument(document);
  const failRead = (nodeId: string, portId: string) => failHost.readCurrentStructuredOutput(nodeId, portId);
  await failHost.enqueueWorkflow(['parse']).completion;
  const beforeFailure = prepareS2FieldChoices(definition, document, 'connected', failRead), historical = failRead('parse', 'value'); failNext = true;
  const failureJob = failHost.enqueueWorkflow(['parse'], undefined, { force: true }); assert.throws(() => failRead('parse', 'value'), /尚无/);
  assert.equal((await failureJob.completion).status, 'failed'); assert.equal(failHost.currentArtifact(historical.id).id, historical.id);
  assert.throws(() => failRead('parse', 'value'), /尚无/); assert.throws(() => readS2FieldChoices(beforeFailure, definition, document, failRead), /尚无/);
  assert.equal(failHost.remainingCalls, 62);

  // Production UI: viewing and selecting create only a draft; application and actual execution remain separate.
  const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成字段选择 UI', knowledgePoints: [], interactionPack: null }); scene.canvasWorkspace = definition;
  let live!: S2PluginHost;
  const ui = harness({ initialDraft: scene, deferStateUpdates: true, onHost(value) { live = value; } }); uis.push(ui);
  const focus = (id: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value: id } }); ui.render(); };
  const exported = () => { ui.button('导出工作区 JSON 到下方').props.onClick(); ui.render(); return JSON.parse(ui.labelControl('工作区 JSON', 'textarea').props.value).definition.initial as S2Document; };
  const fieldForm = () => { const found = ui.elements().find(element => element.type === 'form' && element.props['aria-label'] === '设置提取字段'); assert(found, 'Field selection form'); return found; };
  const inspect = () => { ui.button('查看当前材料的字段（不运行）').props.onClick(); ui.render(); };
  const choose = (pointer: string) => { ui.labelControl('要提取哪一部分', 'select').props.onChange({ target: { value: JSON.stringify(pointer) } }); ui.render(); };
  const submit = () => { fieldForm().props.onSubmit({ preventDefault() {} }); ui.render(); };
  focus('fixed'); const initialUI = exported(); inspect();
  assert.equal(ui.button('应用提取字段（不运行）').props.disabled, true, 'Unknown original pointer is not silently replaced by root');
  choose(''); assert.deepEqual(exported(), initialUI); const previewSubmit = fieldForm().props.onSubmit;
  ui.button('开始试验').props.onClick(); ui.render(); previewSubmit({ preventDefault() {} }); ui.render();
  assert.deepEqual(exported(), initialUI); assert.equal(live.history().length, 0); assert.equal(live.remainingCalls, 64);
  inspect(); const staleDraft = fieldForm().props.onSubmit; choose('/a~1b/~0key/0'); staleDraft({ preventDefault() {} }); ui.render();
  assert.deepEqual(exported(), initialUI, 'Old enabled callback cannot confirm a replacement draft');
  const invalidChoice = ui.labelControl('要提取哪一部分', 'select').props.onChange;
  invalidChoice({ target: { value: JSON.stringify('/forged') } }); ui.render(); assert.deepEqual(exported(), initialUI);
  submit(); const appliedUI = exported(); exactPointerOnly(initialUI, appliedUI, 'fixed', '/a~1b/~0key/0');
  assert.equal(live.history().length, 0); assert.equal(live.remainingCalls, 64); assert.equal(ui.modelCalls(), 0);
  inspect(); const staleUndo = fieldForm().props.onSubmit;
  ui.button('＋合成材料块').props.onClick(); ui.render(); ui.keyShortcut('undo'); ui.render();
  staleUndo({ preventDefault() {} }); ui.render(); assert.deepEqual(exported(), appliedUI, 'Undo does not revive a field-choice callback');
  focus('dynamic'); inspect(); assert.equal(ui.labelControl('要提取哪一部分', 'select').props.disabled, true);
  choose('/rows'); submit(); assert.deepEqual(exported(), appliedUI, 'Calling a disabled dynamic-source handler does not overwrite the reference');
  focus('connected'); inspect(); assert.ok(ui.text().includes('尚无当前有效结果')); assert.equal(live.history().length, 0);
  focus('parse'); ui.button('运行所选步骤').props.onClick(); ui.render();
  await until(() => { ui.render(); try { live.readCurrentStructuredOutput('parse', 'value'); return true; } catch { return false; } });
  assert.equal(live.remainingCalls, 63); focus('connected'); inspect(); choose('/a~1b/~0key/1');
  const staleOutput = fieldForm().props.onSubmit, beforeCache = exported();
  const cacheRun = await live.enqueueWorkflow(['parse']).completion; assert.equal(cacheRun.nodes[0].status, 'cached'); ui.render();
  staleOutput({ preventDefault() {} }); ui.render(); assert.deepEqual(exported(), beforeCache, 'Re-published cache output invalidates an old UI preview');
  assert.equal(live.remainingCalls, 63); inspect(); choose('/a~1b/~0key/1'); submit();
  const beforeSelectRun = exported(); exactPointerOnly(beforeCache, beforeSelectRun, 'connected', '/a~1b/~0key/1');
  assert.equal(live.remainingCalls, 63); assert.equal(live.history().length, 1);
  ui.button('运行所选步骤').props.onClick(); ui.render();
  await until(() => { ui.render(); try { const output = live.readCurrentStructuredOutput('connected', 'value'); return output.payload.kind === 'inline' && output.payload.value === 0; } catch { return false; } });
  assert.equal(live.remainingCalls, 62); assert.equal(live.history().length, 2); assert.equal(ui.modelCalls(), 0);
  inspect(); const afterEnd = fieldForm().props.onSubmit, beforeEnd = exported();
  ui.button('结束试验').props.onClick(); ui.render(); afterEnd({ preventDefault() {} }); ui.render(); assert.deepEqual(exported(), beforeEnd);
  assert.equal(live.remainingCalls, 62); assert.equal(ui.modelCalls(), 0);
  assert.deepEqual(selectS2Pointer(data, '/a~1b/~0key/0'), false);
  assert.equal(JSON.stringify(definition), original); assert.equal(JSON.stringify(document), originalDoc); assert.equal(network, 0);
  console.log('S2 field choices passed: exact native fixed/current-output sources, named nested/array/escaped/empty-key choices without scalar values, false/0/null/empty preservation, branded immutable reports and strict getter/size/config/graph/artifact freshness, dynamic-pointer preservation, real Host read-only latest outputs and cache identity invalidation, explicit application and separate exact local execution, production deferred preview/draft/forgery/undo/end guards, no implicit calls or real IO. Synthetic offline only; not browser layout, IME, user-comprehension or real-model acceptance.');
} finally { uis.forEach(ui => ui.dispose()); hosts.forEach(host => host.close()); globalThis.fetch = initialFetch; }
