import assert from 'node:assert/strict';
import { previewS2CompositeMigration, isS2CompositeMigrationPreviewCurrent, readS2CompositeMigrationDetail } from '../src/services/scene/sceneS2CompositeMigration';
import { createS2CompositeDesign, instantiateS2CompositeDesign, readS2CompositeDesign } from '../src/services/scene/sceneS2CompositeLibrary';
import { wrapS2CanvasComposite } from '../src/services/scene/sceneS2CompositeCanvas';
import { createS2Scene, readS2Definition, readS2Document, exportS2Workspace, importS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import type { S2CanvasDefinition, S2Document } from '../src/types/sceneS2';
import type { S2CompositeDesign, S2CompositeValues } from '../src/types/sceneS2Composite';
import { browserDefinition, browserRequest } from './fixtures/s2-browser-definition';
import { harness } from './scene-s2-ui-harness';

const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const definition = readS2Definition(browserDefinition), plugins = definition.plugins!;
const wrapped = wrapS2CanvasComposite(definition.initial, plugins, ['parse', 'rows'], '原始处理');
const metadata = { id: 'records', version: '1.0.0', label: '独立处理', description: '合成迁移预览' };
const first = createS2CompositeDesign(wrapped.document, plugins, wrapped.id, metadata), second = structuredClone(first);
second.blueprint.version = '1.1.0'; second.blueprint.description = '新用途说明，结构不变';
function setup(a = first, b = second, base: S2Document = wrapped.document, def = definition, values: S2CompositeValues = { inputs: { [first.blueprint.inputs[0].id]: '[{"name":"PRIVATE_LITERAL","score":0}]' } }) {
  const document = readS2Document({ ...base, blueprints: [a, b] }, def);
  const added = instantiateS2CompositeDesign(document, def.plugins, a.blueprint.id, a.blueprint.version, values);
  const current = readS2Document(added.document, def);
  const preview = (doc: unknown = current, target = b.blueprint.version) => previewS2CompositeMigration(doc, def, added.id, target);
  const ready = (doc: unknown = current, target = b.blueprint.version) => { const report = preview(doc, target); if (report.status !== 'preview') throw new Error(report.reason); return report; };
  const actual = (localId: string) => current.composites!.find(item => item.id === added.id)!.blueprint!.mapping!.nodes.find(item => item.localId === localId)!.id;
  return { document: current, id: added.id, nodeIds: added.nodeIds, preview, ready, actual, definition: def };
}
const previousFetch = globalThis.fetch; let network = 0; globalThis.fetch = async () => { network++; throw new Error('Synthetic carry preview only'); };
const hosts: S2PluginHost[] = []; let ui: ReturnType<typeof harness> | undefined;
try {
  const base = setup(), original = JSON.stringify(base.document), report = base.ready();
  assert.equal(report.applied, false); assert.equal(report.canApply, false); assert.equal(report.migrationSupported, false);
  assert.equal(report.items[0].state, 'candidate'); assert.equal(report.blockers.length, 0);
  assert.ok(!JSON.stringify(report).includes('PRIVATE_LITERAL'));
  assert.equal(isS2CompositeMigrationPreviewCurrent(report, base.document, definition), true);
  assert.equal(isS2CompositeMigrationPreviewCurrent(report, structuredClone(base.document), structuredClone(definition)), true);
  assert.equal(isS2CompositeMigrationPreviewCurrent(structuredClone(report), base.document, definition), false);
  const detail = readS2CompositeMigrationDetail(report, base.document, definition, report.items[0].key);
  assert.equal(detail.status, 'available'); assert.ok(JSON.stringify(detail).includes('PRIVATE_LITERAL'));
  if (detail.status === 'available' && detail.detail.current.kind === 'literal') detail.detail.current.value = 'MUTATED';
  assert.ok(JSON.stringify(readS2CompositeMigrationDetail(report, base.document, definition, report.items[0].key)).includes('PRIVATE_LITERAL'), 'Explicit detail returns a clone');
  for (const edit of [
    (doc: S2Document) => { doc.nodes[0].values.content += ' '; },
    (doc: S2Document) => { doc.execution!.nodes[0].position.x += 1; },
    (doc: S2Document) => { doc.blueprints![0].blueprint.description = '同版本不同正文'; },
    (doc: S2Document) => { doc.blueprints![1].blueprint.description = '目标改变'; },
    (doc: S2Document) => { doc.blueprints!.pop(); },
    (doc: S2Document) => { doc.composites!.find(item => item.id === base.id)!.blueprint!.mapping!.nodes[0].localId = 'foreign'; },
  ]) {
    const changed = structuredClone(base.document); edit(changed);
    assert.equal(isS2CompositeMigrationPreviewCurrent(report, changed, definition), false);
    assert.throws(() => readS2CompositeMigrationDetail(report, changed, definition, report.items[0].key), /过期/);
  }
  const changedDefinition = structuredClone(definition); changedDefinition.instructions.response += '新的限制';
  assert.equal(isS2CompositeMigrationPreviewCurrent(report, base.document, changedDefinition), false);
  const alteredReport = base.ready(); alteredReport.items[0].label = '伪造预览';
  assert.equal(isS2CompositeMigrationPreviewCurrent(alteredReport, base.document, definition), false);
  let gets = 0; const hostile = { ...base.document }; Object.defineProperty(hostile, 'execution', { enumerable: true, get: () => { gets++; return base.document.execution; } });
  assert.throws(() => base.preview(hostile)); assert.equal(gets, 0);
  assert.equal(base.preview(base.document, 'latest').status, 'unavailable'); assert.equal(base.preview(base.document, first.blueprint.version).status, 'unavailable');
  const legacy = structuredClone(base.document); delete legacy.composites!.find(item => item.id === base.id)!.blueprint!.mapping;
  assert.equal(base.preview(legacy).status, 'unavailable');
  const missingVersion = structuredClone(base.document); missingVersion.blueprints!.shift(); assert.equal(base.preview(missingVersion).status, 'unavailable');
  const field = structuredClone(base.document); field.execution!.nodes.find(node => node.id === base.actual('parse'))!.bindings.text = { kind: 'field', nodeId: 'input', fieldId: 'content' };
  const fieldReport = base.ready(field); assert.equal(fieldReport.items[0].state, 'candidate'); assert.ok(fieldReport.items[0].currentDescription.includes('内容与笔记'));
  assert.equal(fieldReport.externalReferenceCount, 1);
  assert.ok(!JSON.stringify(readS2CompositeMigrationDetail(fieldReport, field, definition, fieldReport.items[0].key)).includes('示例甲'), 'Field details do not resolve/copy content');
  const renamed = structuredClone(base.document); renamed.execution!.nodes.find(node => node.id === base.actual('parse'))!.presentation = { label: '我的自定义读取' };
  assert.ok(base.ready(renamed).blockers.some(reason => reason.includes('不能直接覆盖')));
  const missingStep = structuredClone(base.document), removedId = base.actual('parse');
  missingStep.execution!.nodes = missingStep.execution!.nodes.filter(node => node.id !== removedId);
  missingStep.execution!.links = missingStep.execution!.links.filter(link => link.source.nodeId !== removedId && link.target.nodeId !== removedId);
  missingStep.composites = missingStep.composites!.map(item => ({ ...item, nodeIds: item.nodeIds.filter(id => id !== removedId) })).filter(item => item.nodeIds.length);
  assert.equal(base.ready(missingStep).items[0].state, 'conflict');
  const newMapping = structuredClone(second); newMapping.blueprint.workflow.nodes.push({ ...structuredClone(newMapping.blueprint.workflow.nodes[0]), id: 'other-parse' });
  newMapping.composites[0].nodeIds.push('other-parse'); newMapping.blueprint.inputs[0].targets.push({ nodeId: 'other-parse', portId: 'text' });
  assert.equal(setup(first, newMapping).ready().items[0].state, 'conflict');
  const differentLabel = structuredClone(second); differentLabel.blueprint.inputs[0].label = '相似用途不是同一含义';
  assert.equal(setup(first, differentLabel).ready().items[0].state, 'conflict');
  const differentId = structuredClone(second); differentId.blueprint.inputs[0].id = 'new-id';
  const differentIds = setup(first, differentId).ready(); assert.ok(differentIds.items.some(item => item.state === 'removed')); assert.ok(differentIds.items.some(item => item.state === 'missing'));
  const insufficient = structuredClone(second); insufficient.blueprint.plugins.push(cap('stringify')); insufficient.blueprint.workflow.nodes.push({ id: 'convert', ...cap('stringify'), position: { x: 900, y: 200 }, bindings: { value: { kind: 'literal', value: false } } }); insufficient.composites[0].nodeIds.push('convert');
  assert.ok(setup(first, insufficient).ready().missingCapabilities.length); assert.ok(setup(first, insufficient).ready().blockers.length);
  const lostOutput = structuredClone(second); lostOutput.blueprint.outputs = [];
  assert.equal(setup(first, lostOutput).ready().outputChanges.length, 1);
  const linkedDefinition = { ...definition, plugins: [...plugins, cap('stringify')] }, linked = setup(first, second, wrapped.document, linkedDefinition);
  linked.document.execution!.nodes.push({ id: 'feed', ...cap('stringify'), position: { x: 1000, y: 900 }, bindings: { value: { kind: 'literal', value: [] } } });
  delete linked.document.execution!.nodes.find(node => node.id === linked.actual('parse'))!.bindings.text;
  linked.document.execution!.links.push({ source: { nodeId: 'feed', portId: 'text' }, target: { nodeId: linked.actual('parse'), portId: 'text' } });
  const externalLink = linked.ready(); assert.equal(externalLink.items[0].state, 'candidate'); assert.ok(externalLink.items[0].currentDescription.includes('步骤输出'));
  assert.ok(!JSON.stringify(readS2CompositeMigrationDetail(externalLink, linked.document, linkedDefinition, externalLink.items[0].key)).includes('artifactId'));
  linked.document.composites!.find(item => item.id === linked.id)!.nodeIds.push('feed');
  assert.equal(linked.ready().items[0].state, 'conflict', 'Internal computation cannot become a public literal during migration');

  function native(defaultValue: any, withDefault = true) {
    const design = structuredClone(first); design.blueprint.id = 'native'; design.blueprint.plugins = [cap('stringify')];
    design.blueprint.workflow = { version: 1, nodes: [{ id: 'convert', ...cap('stringify'), position: { x: 0, y: 0 }, bindings: {} }], links: [] };
    design.blueprint.inputs = []; design.blueprint.parameters = [{ id: 'value', label: '待转换内容', type: { id: 'structured-data.value', version: 1 }, target: { nodeId: 'convert', portId: 'value' }, ...(withDefault ? { defaultValue } : {}) }];
    design.blueprint.outputs = [{ id: 'result', label: '转换结果', type: { id: 'core.text', version: 1 }, required: true, multiple: false, source: { nodeId: 'convert', portId: 'text' } }];
    design.composites = [{ id: design.rootId, label: '转换', nodeIds: ['convert'] }]; return readS2CompositeDesign(design);
  }
  const empty = { nodes: [], edges: [] };
  for (const value of [false, 0, null, '', 'PRIVATE_ACTUAL']) {
    const a = native('PRIVATE_OLD_DEFAULT'), b = native('PRIVATE_NEW_DEFAULT'); b.blueprint.version = '1.1.0';
    const def = { ...definition, plugins: a.blueprint.plugins, initial: empty, business: undefined }; delete def.business;
    const trial = setup(a, b, empty, def, { parameters: { value } }), p = trial.ready();
    assert.equal(p.items[0].state, 'choose'); assert.ok(!JSON.stringify(p).includes('PRIVATE_'));
    const read = readS2CompositeMigrationDetail(p, trial.document, def, p.items[0].key);
    assert.equal(read.status, 'available'); if (read.status === 'available') {
      assert.deepEqual(read.detail.current, { kind: 'literal', value }); assert.equal(read.detail.targetDefault.value, 'PRIVATE_NEW_DEFAULT');
    }
    const same = structuredClone(a); same.blueprint.version = '1.1.0'; assert.equal(setup(a, same, empty, def, { parameters: { value } }).ready().items[0].state, 'candidate');
    const noDefault = native(undefined, false); noDefault.blueprint.version = '1.1.0'; assert.equal(setup(a, noDefault, empty, def, { parameters: { value } }).ready().items[0].state, 'conflict');
  }
  const a = native(null), newParameter = structuredClone(a); newParameter.blueprint.version = '1.1.0'; newParameter.blueprint.parameters[0].id = 'new';
  const nativeDef = { ...definition, plugins: a.blueprint.plugins, initial: empty }; delete nativeDef.business;
  assert.ok(setup(a, newParameter, empty, nativeDef, {}).ready().items.some(item => item.state === 'new'));
  const oversized = setup(a, { ...a, blueprint: { ...a.blueprint, version: '1.1.0' } }, empty, nativeDef, { parameters: { value: 'x'.repeat(13000) } });
  const oversizedReport = oversized.ready(); assert.equal(readS2CompositeMigrationDetail(oversizedReport, oversized.document, nativeDef, oversizedReport.items[0].key).status, 'unavailable');
  const typeChange = structuredClone(a); typeChange.blueprint.version = '1.1.0'; typeChange.blueprint.plugins = [cap('parse-json')]; typeChange.blueprint.workflow.nodes[0] = { id: 'convert', ...cap('parse-json'), position: { x: 0, y: 0 }, bindings: {} };
  typeChange.blueprint.parameters[0] = { ...typeChange.blueprint.parameters[0], type: { id: 'core.text', version: 1 }, target: { nodeId: 'convert', portId: 'text' }, defaultValue: '{}' };
  typeChange.blueprint.outputs[0] = { ...typeChange.blueprint.outputs[0], type: { id: 'structured-data.value', version: 1 }, source: { nodeId: 'convert', portId: 'value' } };
  const typeDef = { ...nativeDef, plugins: [...a.blueprint.plugins, ...typeChange.blueprint.plugins] };
  assert.equal(setup(a, typeChange, empty, typeDef, {}).ready().items[0].state, 'conflict');
  const single = structuredClone(a); single.blueprint.parameters = []; single.blueprint.inputs = [{ id: 'data', label: '内容', type: { id: 'structured-data.value', version: 1 }, required: true, multiple: false, targets: [{ nodeId: 'convert', portId: 'value' }] }];
  const multiple = structuredClone(single); multiple.blueprint.version = '1.1.0'; multiple.blueprint.plugins = [cap('merge-json', 'workflow-merge')];
  multiple.blueprint.workflow.nodes[0] = { id: 'convert', ...multiple.blueprint.plugins[0], position: { x: 0, y: 0 }, bindings: {} };
  multiple.blueprint.inputs[0] = { ...multiple.blueprint.inputs[0], multiple: true, targets: [{ nodeId: 'convert', portId: 'candidates' }] };
  multiple.blueprint.outputs[0] = { ...multiple.blueprint.outputs[0], type: { id: 'structured-data.value', version: 1 }, source: { nodeId: 'convert', portId: 'selected' } };
  assert.equal(setup(single, multiple, empty, { ...nativeDef, plugins: [...single.blueprint.plugins, ...multiple.blueprint.plugins] }, { inputs: { data: false } }).ready().items[0].state, 'conflict');

  const fanout = structuredClone(first); fanout.blueprint.workflow.nodes.push({ ...structuredClone(first.blueprint.workflow.nodes[0]), id: 'twin' }); fanout.composites[0].nodeIds.push('twin'); fanout.blueprint.inputs[0].targets.push({ nodeId: 'twin', portId: 'text' });
  const fanout2 = structuredClone(fanout); fanout2.blueprint.version = '1.1.0';
  const split = setup(fanout, fanout2); assert.equal(split.ready().items[0].state, 'candidate');
  split.document.execution!.nodes.find(node => node.id === split.actual('twin'))!.bindings.text = { kind: 'literal', value: 'DIFFERENT' };
  const splitReport = split.ready(); assert.equal(splitReport.items[0].state, 'conflict'); assert.equal(splitReport.items[0].detailAvailable, false);

  for (const pluginId of ['local-material', 'project-notes']) {
    const resource = structuredClone(first); resource.blueprint.id = 'resource'; resource.blueprint.plugins = [cap('read-text', pluginId)];
    resource.blueprint.workflow = { version: 1, nodes: [{ id: 'read', ...resource.blueprint.plugins[0], position: { x: 0, y: 0 }, bindings: {} }], links: [] };
    resource.blueprint.inputs = [{ id: 'resource', label: '本局资料', type: { id: 'core.text', version: 1 }, required: true, multiple: false, targets: [{ nodeId: 'read', portId: 'resource' }] }]; resource.blueprint.parameters = [];
    resource.blueprint.outputs = [{ id: 'text', label: '资料文本', type: { id: 'core.text', version: 1 }, required: true, multiple: false, source: { nodeId: 'read', portId: 'text' } }]; resource.composites = [{ id: resource.rootId, label: '资料', nodeIds: ['read'] }];
    const resource2 = structuredClone(resource); resource2.blueprint.version = '1.1.0';
    const def = { ...nativeDef, plugins: resource.blueprint.plugins }, trial = setup(resource, resource2, empty, def, {});
    trial.document.execution!.nodes[0].bindings.resource = { kind: 'literal', value: 'PRIVATE_OLD_HANDLE' };
    const p = trial.ready(); assert.equal(p.items[0].state, 'reselect'); assert.equal(p.items[0].detailAvailable, false);
    assert.ok(!JSON.stringify(p).includes('PRIVATE_OLD_HANDLE')); assert.equal(readS2CompositeMigrationDetail(p, trial.document, def, p.items[0].key).status, 'unavailable');
  }

  // Read-only analysis does not touch an actual Host's completed artifacts or outstanding human wait.
  const human = cap('text', 'human-input'), waitDef = { ...definition, plugins: [...plugins, human] };
  const waitDoc = structuredClone(base.document); waitDoc.execution!.nodes.push({ id: 'ask', ...human, position: { x: 100, y: 900 }, bindings: { prompt: { kind: 'literal', value: '等待合成回答' } } });
  const host = new S2PluginHost('carry-preview', waitDef.plugins); hosts.push(host); host.setDocument(waitDoc);
  const completed = await host.enqueueWorkflow(base.nodeIds).completion; assert.equal(completed.status, 'succeeded');
  const waiting = host.enqueueWorkflow(['ask']); for (let i = 0; i < 200 && !host.waitingHumanInputs().length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(host.waitingHumanInputs().length, 1);
  const state = () => { const { event: _, ...frame } = host.prepare(null, undefined, '').frame; return JSON.stringify([frame, host.history(), host.waitingHumanInputs(), host.workflowHistory(), host.remainingCalls]); };
  const before = state(), p = previewS2CompositeMigration(waitDoc, waitDef, base.id, '1.1.0');
  assert.equal(p.status, 'preview'); if (p.status === 'preview') readS2CompositeMigrationDetail(p, waitDoc, waitDef, p.items[0].key);
  assert.equal(state(), before); host.close(); await waiting.completion;
  assert.deepEqual(importS2Workspace(exportS2Workspace(definition, base.document)).initial, base.document);
  assert.equal(JSON.stringify(base.document), original);

  let live!: S2PluginHost;
  ui = harness({ legacyCatalogue: true, initialRequest: browserRequest, initialDraft: { ...createS2Scene(browserRequest), canvasWorkspace: { ...definition, initial: base.document } }, onHost: value => { live = value; } });
  await ui.openConversationSession();
  const targetLabel = `「${metadata.label}」的沿用目标版本`, previewLabel = `预览材料与参数沿用 · ${metadata.label}`;
  ui.labelControl(targetLabel, 'select').props.onChange({ target: { value: '1.1.0' } }); ui.render();
  const stalePreview = ui.button(previewLabel).props.onClick; stalePreview(); ui.render(); assert.ok(ui.text().includes('可进入沿用确认')); assert.ok(!ui.text().includes('PRIVATE_LITERAL'));
  const detailLabel = `查看当前值与目标默认值 · ${first.blueprint.inputs[0].label}`, staleDetail = ui.button(detailLabel).props.onClick;
  staleDetail(); ui.render(); assert.ok(ui.text().includes('[{"name":"PRIVATE_LITERAL","score":0}]'), 'Display original text without transport quoting/backslash escapes'); assert.equal(live.remainingCalls, 64); assert.equal(live.history().length, 0); assert.equal(ui.modelCalls(), 1);
  ui.labelControl(targetLabel, 'select').props.onChange({ target: { value: '' } }); ui.render(); staleDetail(); stalePreview(); ui.render();
  assert.ok(!ui.text().includes('PRIVATE_LITERAL')); assert.ok(!ui.text().includes('可进入沿用确认'));
  ui.labelControl(targetLabel, 'select').props.onChange({ target: { value: '1.1.0' } }); ui.render(); ui.button(previewLabel).props.onClick(); ui.render();
  const oldRead = ui.button(detailLabel).props.onClick; ui.button('＋内容与笔记').props.onClick(); ui.render(); oldRead(); ui.render();
  assert.ok(ui.text().includes('沿用预览已过期')); assert.ok(!ui.text().includes('PRIVATE_LITERAL'));
  ui.button(previewLabel).props.onClick(); ui.render(); const endRead = ui.button(detailLabel).props.onClick;
  const beforeDispose = JSON.stringify(ui.flow().props.nodes); ui.dispose(); endRead(); assert.throws(() => ui.documentSnapshot(), /null|结束/); assert.equal(JSON.stringify(ui.flow().props.nodes), beforeDispose);
  assert.equal(live.history().length, 0); assert.equal(live.remainingCalls, 64); assert.equal(ui.modelCalls(), 1); assert.equal(network, 0);
  console.log('S2 carry preview passed: exact versions/interfaces/maps and current native values, source/default/type/endpoint/fanout conflicts, resource-handle exclusion, opaque host-local full-source pins and clone/tamper/stale rejection, explicit full-or-unavailable detail reads, native falsy values, unchanged actual Host artifacts/waits/revision/budget, production readonly/target/edit/end guards. Synthetic offline only; no apply/migration, historical-source authentication, browser/live-model acceptance or real resources.');
} finally { hosts.forEach(host => host.close()); ui?.dispose(); globalThis.fetch = previousFetch; }
