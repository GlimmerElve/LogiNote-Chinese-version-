import assert from 'node:assert/strict';
import type { S2CompositeBlueprint, S2CompositeCapability } from '../src/types/sceneS2Composite';
import type { S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import { expandS2Composite, exportS2CompositeBlueprint, importS2CompositeBlueprint, readS2CompositeBlueprint, s2CompositeSignature } from '../src/services/scene/sceneS2Composite';
import { createS2Scene, readS2Definition, readS2Document, exportS2Workspace, importS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { s2TableToRecords, type S2Table } from '../src/services/scene/sceneS2Structured';

const previousFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; assert.fail('Composite protocol cannot access network, models or real resources'); };
const ref = (capabilityId: string, pluginId = 'structured-data'): S2CompositeCapability => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const plugins = [ref('parse-json'), ref('select'), ref('to-table'), ref('table', 'structured-view')];
const node = (id: string, capabilityId: string, pluginId = 'structured-data'): S2WorkflowNode => ({ id, ...ref(capabilityId, pluginId), position: { x: 0, y: 0 }, bindings: {} });
const type = (id: string) => ({ id, version: 1 });
const link = (source: string, sourcePort: string, target: string, targetPort: string) => ({ source: { nodeId: source, portId: sourcePort }, target: { nodeId: target, portId: targetPort } });
function blueprint(): S2CompositeBlueprint {
  return { format: 's2-composite', protocolVersion: 1, id: 'RecordTable', version: '1.0.0', label: '读取记录并整理表格', description: '明确解析文本、提取指定记录并转表格；不证明记录符合业务要求。', plugins: structuredClone(plugins.slice(0, 3)),
    workflow: { version: 1, nodes: [node('parse', 'parse-json'), { ...node('pick', 'select'), position: { x: 340, y: 0 } }, { ...node('rows', 'to-table'), position: { x: 680, y: 0 } }],
      links: [link('parse', 'value', 'pick', 'value'), link('pick', 'value', 'rows', 'value')] },
    inputs: [{ id: 'source', label: '完整记录文本', type: type('core.text'), required: true, multiple: false, targets: [{ nodeId: 'parse', portId: 'text' }] }],
    outputs: [{ id: 'table', label: '整理好的表格', type: type('structured-data.table'), required: true, multiple: false, source: { nodeId: 'rows', portId: 'table' } }],
    parameters: [{ id: 'path', label: '提取记录的位置', type: type('core.text'), target: { nodeId: 'pick', portId: 'pointer' }, defaultValue: '/items' }],
  };
}
const hosts: S2PluginHost[] = [];
const host = (document: S2Document, allowed = plugins) => { const h = new S2PluginHost('composite-synthetic', allowed); hosts.push(h); h.setDocument(document); return h; };
const realId = (expansion: ReturnType<typeof expandS2Composite>, local: string) => expansion.sourceMap.find(item => item.localNodeId === local)!.nodeId;
const outputValue = (h: S2PluginHost, run: Awaited<ReturnType<S2PluginHost['enqueueWorkflow']>['completion']>, nodeId: string, producer = nodeId) => {
  const artifact = h.currentArtifact(run.nodes.find(node => node.nodeId === nodeId)!.artifactIds[0]);
  assert.equal(artifact.source.nodeId, producer); assert.equal(artifact.source.revision, run.revision); assert.equal(artifact.complete, true);
  if (artifact.payload.kind !== 'inline') assert.fail('Expected complete native output'); return artifact.payload.value;
};
try {
  const raw = blueprint(), original = JSON.stringify(raw), checked = readS2CompositeBlueprint(raw, plugins);
  assert.deepEqual(checked, raw); assert.notEqual(checked, raw); checked.inputs[0].label = 'copy only'; assert.equal(JSON.stringify(raw), original);
  const serialized = exportS2CompositeBlueprint(raw, plugins);
  assert.deepEqual(importS2CompositeBlueprint(serialized, plugins), raw);
  assert.equal(s2CompositeSignature(raw, plugins), s2CompositeSignature(JSON.parse(serialized), plugins));
  const rejects: Array<[string, (value: any) => void]> = [
    ['protocol', value => { value.protocolVersion = 2; }], ['version range', value => { value.version = '^1.0.0'; }],
    ['version coercion', value => { value.version = ['1.0.0']; }], ['authority', value => { value.grant = { permissions: ['network'] }; }],
    ['budget', value => { value.budget = 24; }], ['receipt', value => { value.workflow.receipts = []; }],
    ['nested unsupported', value => { value.workflow.nodes[0].composite = {}; }], ['unknown capability', value => { value.plugins[0].capabilityId = 'eval'; }],
    ['extra capability', value => { value.plugins.push(plugins[3]); }], ['wrong type', value => { value.inputs[0].type = type('structured-data.value'); }],
    ['type version', value => { value.outputs[0].type.version = 2; }], ['required', value => { value.inputs[0].required = false; }],
    ['multiple', value => { value.inputs[0].multiple = true; }], ['output cardinality', value => { value.outputs[0].multiple = true; }],
    ['unknown endpoint', value => { value.inputs[0].targets[0].nodeId = 'absent'; }], ['unknown port', value => { value.inputs[0].targets[0].portId = 'absent'; }],
    ['empty fanout', value => { value.inputs[0].targets = []; }], ['duplicate target', value => { value.inputs[0].targets.push(value.inputs[0].targets[0]); }],
    ['duplicate input', value => { value.inputs.push(structuredClone(value.inputs[0])); }], ['duplicate public name', value => { value.parameters[0].id = 'source'; }],
    ['output alias', value => { value.outputs.push({ ...value.outputs[0], id: 'again' }); }], ['hidden required input', value => { value.inputs = []; }],
    ['missing parameter exposure', value => { value.parameters = []; }], ['default type', value => { value.parameters[0].defaultValue = false; }],
    ['fixed input conflict', value => { value.workflow.nodes[0].bindings.text = { kind: 'literal', value: '{}' }; }],
    ['fixed parameter conflict', value => { value.workflow.nodes[1].bindings.pointer = { kind: 'literal', value: '/other' }; }],
    ['internal connection conflict', value => { value.inputs[0].type = type('structured-data.value'); value.inputs[0].targets = [{ nodeId: 'pick', portId: 'value' }]; }],
    ['external content reference', value => { value.workflow.nodes[0].bindings.text = { kind: 'field', nodeId: 'privateNote', fieldId: 'content' }; }],
    ['external control', value => { value.workflow.nodes[0].when = { nodeId: 'notIncluded', portId: 'value', pointer: '', equals: true, match: true }; }],
    ['data cycle', value => { value.workflow.links.push(link('pick', 'value', 'pick', 'value')); }],
  ];
  for (const [name, change] of rejects) { const value = blueprint(); change(value); assert.throws(() => readS2CompositeBlueprint(value, plugins), undefined, name); }
  assert.throws(() => readS2CompositeBlueprint(raw, plugins.slice(1)), /范围外/);
  assert.throws(() => readS2CompositeBlueprint({ ...raw, label: undefined }, plugins));
  assert.throws(() => readS2CompositeBlueprint(Object.assign(Object.create({}), raw), plugins));
  let getterCalls = 0; const getter = blueprint(); Object.defineProperty(getter, 'label', { enumerable: true, get: () => { getterCalls++; return 'must not run'; } });
  assert.throws(() => readS2CompositeBlueprint(getter, plugins)); assert.equal(getterCalls, 0);
  const hidden = blueprint(); Object.defineProperty(hidden, 'grant', { value: {}, enumerable: false }); assert.throws(() => readS2CompositeBlueprint(hidden, plugins));
  const symbol = blueprint(); (symbol as any)[Symbol('grant')] = {}; assert.throws(() => readS2CompositeBlueprint(symbol, plugins));
  const sparse = blueprint(); sparse.inputs.length = 2; assert.throws(() => readS2CompositeBlueprint(sparse, plugins));
  const cycle = blueprint(); (cycle as any).cycle = cycle; assert.throws(() => readS2CompositeBlueprint(cycle, plugins));
  assert.throws(() => readS2CompositeBlueprint({ ...raw, toJSON: () => raw }, plugins));
  assert.throws(() => readS2CompositeBlueprint({ ...raw, nan: NaN }, plugins));
  assert.throws(() => importS2CompositeBlueprint('x'.repeat(128001), plugins));
  assert.throws(() => readS2CompositeBlueprint({ ...raw, extra: ['汉'.repeat(22000), '汉'.repeat(22000)] }, plugins), /128000/);
  const fresh = expandS2Composite(raw, plugins), another = expandS2Composite(raw, plugins);
  assert.notEqual(fresh.instanceId, another.instanceId); assert.equal(new Set([...fresh.sourceMap, ...another.sourceMap].map(item => item.nodeId)).size, 6);
  assert.equal(fresh.workflow.nodes[1].bindings.pointer.kind, 'literal'); assert.equal((fresh.workflow.nodes[1].bindings.pointer as any).value, '/items');
  assert.deepEqual(fresh.inputs[0].targets, [{ nodeId: realId(fresh, 'parse'), portId: 'text' }]);
  assert.deepEqual(fresh.outputs[0].source, { nodeId: realId(fresh, 'rows'), portId: 'table' });
  assert.deepEqual(fresh.parameters[0].target, { nodeId: realId(fresh, 'pick'), portId: 'pointer' });
  fresh.workflow.nodes[1].bindings.pointer = { kind: 'literal', value: '/changed' }; assert.equal((another.workflow.nodes[1].bindings.pointer as any).value, '/items');
  assert.equal(JSON.stringify(raw), original);
  for (const values of [{ inputs: { absent: '{}' } }, { parameters: { path: false } }, { inputs: { source: null } }, { inputs: null }, { parameters: null }, { position: null }, { grant: true }, { position: { x: Infinity, y: 0 } }, { position: { x: 100000, y: 0 } }]) assert.throws(() => expandS2Composite(raw, plugins, values as any));
  const textA = JSON.stringify({ items: [{ name: '甲', enabled: false, count: 0, empty: null }, { name: '缺失' }], other: [{ name: '甲另一组' }] });
  const textB = JSON.stringify({ items: [{ name: '乙备用' }], other: [{ name: '乙' }] });
  const a = expandS2Composite(raw, plugins, { inputs: { source: textA }, position: { x: 20, y: 30 } });
  const b = expandS2Composite(raw, plugins, { parameters: { path: '/other' }, position: { x: 20, y: 330 } });
  b.workflow.nodes.find(node => node.id === realId(b, 'parse'))!.bindings.text = { kind: 'field', nodeId: 'externalText', fieldId: 'content' };
  const scene = createS2Scene({ source: 'custom', subject: 'Synthetic composite E1', knowledgePoints: [], sceneSkill: 'S2' });
  const definition = readS2Definition({ ...scene.canvasWorkspace, plugins, initial: { nodes: [], edges: [] } });
  const joined: S2Document = { nodes: [{ id: 'externalText', type: definition.blockTypes[0].id, position: { x: 0, y: 0 }, values: { [definition.blockTypes[0].fields[0].id]: textB } }], edges: [], execution: { version: 1,
    nodes: [...a.workflow.nodes, ...b.workflow.nodes, node('displayA', 'table', 'structured-view'), node('displayB', 'table', 'structured-view')],
    links: [...a.workflow.links, ...b.workflow.links, link(a.outputs[0].source.nodeId, 'table', 'displayA', 'table'), link(b.outputs[0].source.nodeId, 'table', 'displayB', 'table')] } };
  // The outer canvas owns content schemas. Use its real field name rather than a blueprint-local content ID.
  (joined.execution!.nodes.find(node => node.id === realId(b, 'parse'))!.bindings.text as any).fieldId = definition.blockTypes[0].fields[0].id;
  const document = readS2Document(joined, definition), h = host(document);
  assert.equal(h.history().length, 0); assert.equal(h.remainingCalls, 64, 'Expansion and canvas validation do not execute');
  const first = await h.enqueueWorkflow(['displayA']).completion;
  assert.equal(first.status, 'succeeded'); assert.equal(first.nodes.length, 4); assert.equal(h.history().length, 3);
  assert.deepEqual(s2TableToRecords(outputValue(h, first, 'displayA', a.outputs[0].source.nodeId) as unknown as S2Table), JSON.parse(textA).items);
  assert.ok(h.history().every(entry => a.sourceMap.some(map => map.nodeId === entry.request.nodeId)));
  const second = await h.enqueueWorkflow(['displayB']).completion;
  assert.equal(second.status, 'succeeded'); assert.deepEqual(s2TableToRecords(outputValue(h, second, 'displayB', b.outputs[0].source.nodeId) as unknown as S2Table), [{ name: '乙' }]);
  const changed = structuredClone(document); changed.execution!.nodes.find(node => node.id === realId(a, 'pick'))!.bindings.pointer = { kind: 'literal', value: '/other' }; h.setDocument(changed);
  const third = await h.enqueueWorkflow(['displayA']).completion;
  assert.deepEqual(s2TableToRecords(outputValue(h, third, 'displayA', a.outputs[0].source.nodeId) as unknown as S2Table), [{ name: '甲另一组' }]);
  const beforeB = h.history().length, bAgain = await h.enqueueWorkflow(['displayB']).completion;
  assert.equal(h.history().length, beforeB); assert.ok(bAgain.nodes.slice(0, 3).every(node => node.status === 'cached'));
  assert.deepEqual(s2TableToRecords(outputValue(h, bAgain, 'displayB', b.outputs[0].source.nodeId) as unknown as S2Table), [{ name: '乙' }]);
  assert.ok(h.history().slice(0, 3).every(entry => entry.receipt.publication === 'stale'), 'Old internal receipts are not relabeled current');
  const failure = structuredClone(changed); failure.execution!.nodes.find(node => node.id === realId(a, 'parse'))!.bindings.text = { kind: 'literal', value: 'bad JSON' }; h.setDocument(failure);
  const mixed = await h.enqueueWorkflow(['displayA', 'displayB']).completion;
  assert.notEqual(mixed.status, 'succeeded'); assert.equal(mixed.nodes.find(node => node.nodeId === 'displayA')!.status, 'blocked'); assert.equal(mixed.nodes.find(node => node.nodeId === 'displayB')!.status, 'displayed');
  assert.ok(h.history().at(-1)!.receipt.error); assert.ok(a.sourceMap.some(item => item.nodeId === h.history().at(-1)!.request.nodeId));
  const saved = importS2Workspace(exportS2Workspace(definition, changed)); const clean = host(saved.initial);
  assert.equal(clean.history().length, 0); assert.equal(clean.remainingCalls, 64); assert.equal((await clean.enqueueWorkflow(['displayB']).completion).status, 'succeeded');
  const tooMany = structuredClone(document), originalDocument = JSON.stringify(document);
  for (let i = 0; i < 12; i++) { const more = expandS2Composite(raw, plugins); tooMany.execution!.nodes.push(...more.workflow.nodes); tooMany.execution!.links.push(...more.workflow.links); }
  assert.throws(() => readS2Document(tooMany, definition)); assert.equal(JSON.stringify(document), originalDocument, 'Over-limit expansion is not committed');
  const fanout = blueprint(); fanout.workflow = { version: 1, nodes: [node('one', 'parse-json'), node('two', 'parse-json')], links: [] }; fanout.plugins = [ref('parse-json')]; fanout.parameters = [];
  fanout.inputs[0].targets = [{ nodeId: 'one', portId: 'text' }, { nodeId: 'two', portId: 'text' }]; fanout.outputs = ['one', 'two'].map(id => ({ id, label: id, type: type('structured-data.value'), required: true, multiple: false, source: { nodeId: id, portId: 'value' } }));
  const f = expandS2Composite(fanout, plugins, { inputs: { source: '{}' } }); assert.ok(f.workflow.nodes.every(node => (node.bindings.text as any).value === '{}'));
  const large = structuredClone(fanout); large.workflow.nodes = Array.from({ length: 16 }, (_, i) => node(`parse${i}`, 'parse-json')); large.inputs[0].targets = large.workflow.nodes.map(node => ({ nodeId: node.id, portId: 'text' })); large.outputs = [];
  assert.throws(() => expandS2Composite(large, plugins, { inputs: { source: 'x'.repeat(5000) } }), /展开后/);
  const missing = expandS2Composite(raw, plugins), missingHost = host({ nodes: [], edges: [], execution: missing.workflow });
  assert.throws(() => missingHost.enqueueWorkflow(), /必填输入/); assert.equal(missingHost.history().length, 0, 'Unfilled public input cannot run');
  for (const value of [false, 0, null, '']) {
    const native = blueprint(); native.plugins = [ref('stringify')]; native.workflow = { version: 1, nodes: [node('text', 'stringify')], links: [] }; native.inputs = [];
    native.parameters = [{ id: 'value', label: '原生值', type: type('structured-data.value'), target: { nodeId: 'text', portId: 'value' }, defaultValue: value }];
    native.outputs = [{ id: 'text', label: '完整文本', type: type('core.text'), required: true, multiple: false, source: { nodeId: 'text', portId: 'text' } }];
    const n = expandS2Composite(native, native.plugins), nh = host({ nodes: [], edges: [], execution: n.workflow }, native.plugins), run = await nh.enqueueWorkflow().completion;
    assert.equal(run.status, 'succeeded'); assert.equal(outputValue(nh, run, n.outputs[0].source.nodeId), JSON.stringify(value));
  }

  // Prompt assembly is another composition, not a hard-coded teaching workflow or an implicit model request.
  const prompt = blueprint(); prompt.id = 'PromptAssembly'; prompt.plugins = [ref('bind', 'text-template'), ref('render', 'text-template')];
  prompt.workflow = { version: 1, nodes: [
    { ...node('role', 'bind', 'text-template'), bindings: { key: { kind: 'literal', value: 'role' } } },
    { ...node('task', 'bind', 'text-template'), bindings: { key: { kind: 'literal', value: 'task' } } },
    node('render', 'render', 'text-template')], links: [link('role', 'variables', 'task', 'variables'), link('task', 'variables', 'render', 'variables')] };
  prompt.inputs = ['role', 'task'].map(id => ({ id, label: id === 'role' ? '角色设定' : '任务要求', type: type('core.text'), required: true, multiple: false, targets: [{ nodeId: id, portId: 'value' }] }));
  prompt.parameters = [{ id: 'layout', label: '提示词排版', type: type('core.text'), target: { nodeId: 'render', portId: 'template' }, defaultValue: '角色：{{role}}\n任务：{{task}}' }];
  prompt.outputs = [{ id: 'text', label: '完整提示词', type: type('core.text'), required: true, multiple: false, source: { nodeId: 'render', portId: 'text' } }];
  const p = expandS2Composite(prompt, prompt.plugins, { inputs: { role: '教练 $& {{literal}}', task: '解释一个概念' } });
  const ph = host({ nodes: [], edges: [], execution: p.workflow }, prompt.plugins), promptRun = await ph.enqueueWorkflow().completion;
  assert.equal(promptRun.status, 'succeeded'); assert.equal(outputValue(ph, promptRun, p.outputs[0].source.nodeId), '角色：教练 $& {{literal}}\n任务：解释一个概念');

  // Control dependencies remain internal and are remapped. Two human waits cannot answer one another.
  const control = blueprint(); control.id = 'HumanBranch'; control.plugins = [ref('confirm', 'human-input'), ref('parse-json'), ref('merge-json', 'workflow-merge')];
  const allowedControl = [...control.plugins];
  control.workflow = { version: 1, nodes: [
    { ...node('confirm', 'confirm', 'human-input'), bindings: { prompt: { kind: 'literal', value: '选择本次分支' } } },
    { ...node('yes', 'parse-json'), bindings: { text: { kind: 'literal', value: '{"answer":true}' } }, when: { nodeId: 'confirm', portId: 'decision', pointer: '/approved', equals: true, match: true } },
    { ...node('no', 'parse-json'), bindings: { text: { kind: 'literal', value: '{"answer":false}' } }, when: { nodeId: 'confirm', portId: 'decision', pointer: '/approved', equals: false, match: true } },
    node('merge', 'merge-json', 'workflow-merge')], links: [link('yes', 'value', 'merge', 'candidates'), link('no', 'value', 'merge', 'candidates')] };
  control.inputs = []; control.parameters = []; control.outputs = [{ id: 'result', label: '本次选择的结果', type: type('structured-data.value'), required: true, multiple: false, source: { nodeId: 'merge', portId: 'selected' } }];
  const c1 = expandS2Composite(control, allowedControl), c2 = expandS2Composite(control, allowedControl);
  assert.equal(c1.workflow.nodes.find(node => node.id === realId(c1, 'yes'))!.when!.nodeId, realId(c1, 'confirm'));
  const humanHost = host({ nodes: [], edges: [], execution: { version: 1, nodes: [...c1.workflow.nodes, ...c2.workflow.nodes], links: [...c1.workflow.links, ...c2.workflow.links] } }, allowedControl);
  const job1 = humanHost.enqueueWorkflow([c1.outputs[0].source.nodeId]), job2 = humanHost.enqueueWorkflow([c2.outputs[0].source.nodeId]);
  for (let i = 0; i < 200 && humanHost.waitingHumanInputs().length < 2; i++) await new Promise(resolve => setImmediate(resolve));
  const waits = humanHost.waitingHumanInputs(); assert.equal(waits.length, 2); const wait1 = waits.find(wait => wait.workflowId === job1.id)!, wait2 = waits.find(wait => wait.workflowId === job2.id)!;
  assert.throws(() => humanHost.submitHumanInput(job1.id, wait2.id, true));
  humanHost.submitHumanInput(job1.id, wait1.id, true); const done1 = await job1.completion;
  assert.equal(humanHost.waitingHumanInputs().length, 1); humanHost.submitHumanInput(job2.id, wait2.id, false); const done2 = await job2.completion;
  assert.equal(done1.status, 'succeeded'); assert.equal(done2.status, 'succeeded');
  assert.deepEqual(outputValue(humanHost, done1, c1.outputs[0].source.nodeId), { answer: true }); assert.deepEqual(outputValue(humanHost, done2, c2.outputs[0].source.nodeId), { answer: false });

  for (const pluginId of ['local-material', 'project-notes']) {
    const resource = blueprint(); resource.id = 'ReadMaterial'; resource.plugins = [ref('read-text', pluginId)]; resource.workflow = { version: 1, nodes: [node('read', 'read-text', pluginId)], links: [] };
    resource.parameters = []; resource.inputs = [{ id: 'resource', label: '本局允许的资料', type: type('core.text'), required: true, multiple: false, targets: [{ nodeId: 'read', portId: 'resource' }] }];
    resource.outputs = [{ id: 'text', label: '资料正文', type: type('core.text'), required: true, multiple: false, source: { nodeId: 'read', portId: 'text' } }];
    const e = expandS2Composite(resource, resource.plugins, { inputs: { resource: 'old-run-handle' } });
    const rh = host({ nodes: [], edges: [], execution: e.workflow }, resource.plugins); const before = rh.remainingCalls;
    assert.equal((await rh.enqueueWorkflow().completion).status, 'failed'); assert.equal(rh.history().length, 0); assert.equal(rh.remainingCalls, before);
    const bound = structuredClone(resource); bound.inputs = []; bound.workflow.nodes[0].bindings.resource = { kind: 'literal', value: 'old-run-handle' }; assert.throws(() => readS2CompositeBlueprint(bound, resource.plugins), /句柄/);
    const parameter = structuredClone(resource); parameter.inputs = []; parameter.parameters = [{ id: 'resource', label: '不能内置旧授权', type: type('core.text'), target: { nodeId: 'read', portId: 'resource' }, defaultValue: 'old' }]; assert.throws(() => readS2CompositeBlueprint(parameter, resource.plugins), /本局资料输入/);
  }
  const model = blueprint(); model.id = 'Model'; model.plugins = [ref('generate', 'model-test')]; model.workflow = { version: 1, nodes: [{ ...node('model', 'generate', 'model-test'), bindings: { prompt: { kind: 'literal', value: '只用合成材料' } } }], links: [] }; model.inputs = []; model.parameters = [];
  model.outputs = [{ id: 'text', label: '待核对回复', type: type('core.text'), required: true, multiple: false, source: { nodeId: 'model', portId: 'text' } }];
  const m = expandS2Composite(model, model.plugins), mh = host({ nodes: [], edges: [], execution: m.workflow }, model.plugins);
  assert.throws(() => mh.enqueueWorkflow(), /授权|模型/); assert.equal(mh.history().length, 0);
  assert.equal(network, 0); assert.equal(JSON.stringify(raw), original);
  console.log(`S2 composite E1 passed: inert versioned blueprint, ${rejects.length} schema/mapping rejections plus descriptor/limit guards, exact public types/cardinality/fanout/parameters, isolated real-node expansions, external field input and local parse/select/table/display, scoped targets/cache/stale provenance, independent failures, remapped human branches and separate waits, saved flat-template authority exclusion, resource/model fail-closed gates. Synthetic offline only; no nested/collapsed UI, real models, private notes, files or network.`);
} finally { hosts.forEach(host => host.close()); globalThis.fetch = previousFetch; }
