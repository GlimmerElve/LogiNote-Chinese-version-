import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildScenePack } from './build-scene-pack-example.mjs';
import { createSceneInteractionPackStore } from '../src/electron/sceneInteractionPackStore';
import { loadSceneInteractionPack } from '../src/services/scene/sceneInteractionPackLoader';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { compileS2PublicCanvas, projectS2PublicCanvas, publicS2Catalog, type S2PublicCanvas } from '../src/services/scene/sceneS2PublicAuthoring';
import { exportS2Workspace, importS2WorkspaceWithPack, applyS2Commands } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { enqueueSceneInteractionWorkflow, closeSceneInteractionHost, scenePackLocalAdapter, createScenePackHostServices } from '../src/services/scene/sceneInteractionHostServices';
import { scenePackEditorServices } from '../src/services/scene/scenePackEditorServices';
import { readFaultTreeModel } from '../examples/scene-packs/fault-tree/model';
import { createRuntime } from '../examples/scene-packs/fault-tree/runtime';
import { executeLocal } from '../examples/scene-packs/fault-tree/plugins';
import { MAX_GATE_INPUTS, isCondition } from '../examples/scene-packs/fault-tree/domain';
import { prepareS2InteractionActions, executeS2InteractionActions } from '../src/services/scene/sceneS2InteractionActions';
import { scenePackNodeDoubleClick } from '../src/components/scene/ScenePackView';
import type { ScenePackConfig, ScenePackViewContext } from '../src/types/sceneInteractionPack';
import type { S2PluginInvocation } from '../src/types/sceneS2Plugin';

const source = path.resolve('examples/scene-packs/fault-tree'), output = path.resolve('output/fault-tree-checks');
await fs.mkdir(output, { recursive: true }); const temporary = await fs.mkdtemp(path.join(output, 'run-'));
const previousFetch = globalThis.fetch, oldWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const hosts: S2PluginHost[] = [];
globalThis.fetch = async () => assert.fail('Fault-tree checks forbid network/model calls');
try {
  assert.deepEqual(sceneInteractionPacks.catalog(), []);
  const built = await buildScenePack({ sourceDir: source, outputRoot: path.join(temporary, 'distribution') });
  assert.equal(built.modules, 12, 'Only package-owned modules enter the single ESM bundle');
  const store = createSceneInteractionPackStore(path.join(temporary, 'installed'), path.join(temporary, 'distribution'));
  const list = await store.list(); assert.deepEqual(list.errors, []); assert.deepEqual(list.packs.map(item => item.id), ['fault-tree']);
  const styles: unknown[] = [];
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { electronAPI: { sceneInteractionPacks: store } } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { createElement: () => ({ dataset: {}, textContent: '' }), head: { appendChild: (style: unknown) => styles.push(style) } } });
  const ref = { id: 'fault-tree', version: '1.0.0' }; await loadSceneInteractionPack(ref);
  const pack = sceneInteractionPacks.resolve(ref); assert.equal(styles.length, 1);
  assert.equal(pack.execution, 'none');
  // Pure capability serialization contracts remain testable below the public
  // package flow. The actual package entry must never schedule them for editing.
  const runCapabilityContract = (host: S2PluginHost, config: ScenePackConfig, targets: string[]) => {
    assert.deepEqual(pack.validate(config), []); host.setDocument(config.document); return host.enqueueWorkflow(targets);
  };
  assert.deepEqual(pack.authoring!.components.map(item => item.id), ['event', 'gate']);
  assert.deepEqual(pack.authoring!.components[0].parameters, ['eventType', 'content']);
  assert.deepEqual(pack.authoring!.components[1].parameters, ['gateType']);
  const sample: S2PublicCanvas = JSON.parse(await fs.readFile(path.join(source, 'sample.public-canvas.json'), 'utf8'));
  const config: ScenePackConfig = compileS2PublicCanvas(pack, sample, { goal: '事故树：C = AND(A, B)' });
  assert.deepEqual(pack.validate(config), []);
  assert.equal(config.document.nodes.length, 0, 'Events are capability nodes, never native content blocks');
  assert.deepEqual(readFaultTreeModel(config.document).rules, [{ eventId: 'c', gateId: 'gate', operator: 'AND', inputEventIds: ['a', 'b'] }]);
  const host = new S2PluginHost('fault-tree-contract', config.definition, scenePackLocalAdapter(ref)); hosts.push(host); host.setDocument(config.document);
  assert.throws(() => enqueueSceneInteractionWorkflow(host, config, ref, ['c']), /PACK_EXECUTION_DISABLED/);
  assert.equal(host.workflowHistory().length, 0);
  const services = createScenePackHostServices(host, () => config, undefined, { interactionPack: ref });
  assert.throws(() => services.run(['c']), /PACK_EXECUTION_DISABLED/);
  let result = await runCapabilityContract(host, config, ['c']).completion;
  assert.equal(result.status, 'succeeded');
  const eventResult = () => host.currentArtifact(result.nodes.find(item => item.nodeId === 'c')!.artifactIds[0]);
  assert.deepEqual(eventResult().payload, { kind: 'inline', value: { eventId: 'c', eventType: 'top', content: 'C', definition: { gateId: 'gate', operator: 'AND', inputEventIds: ['a', 'b'] } } });
  assert.equal(host.history().length, 4);
  const links = structuredClone(config.document.execution!.links); let revision = 0;
  const context = (nodeId: string): ScenePackViewContext => {
    const version = revision, snapshot = structuredClone(config.document);
    return { definition: config.definition, document: snapshot, node: snapshot.execution!.nodes.find(item => item.id === nodeId)!, active: true, editable: true,
      state: { get: () => undefined, initialize: (_key, create) => create(), set() {}, delete() {} },
      guard() { if (version !== revision) throw new Error('STALE_VIEW'); }, readCurrent: () => structuredClone(config),
      registerPanel() {}, navigate() {}, focusSettings() {}, nodeLabel: id => id, inputLabel: (_id, port) => port, onNotice() {}, onError(message) { throw new Error(message); },
      onInputChange(portId, binding, base) {
        assert.equal(base, scenePackEditorServices.parameterSource(config.document, nodeId, portId).key);
        config.document = applyS2Commands(config.definition, config.document, [{ op: 'update-execution-node', id: nodeId, bindings: { [portId]: binding! } }]); revision++;
      }, onDocumentChange() { assert.fail('Parameter edits do not replace the whole document'); } };
  };
  const gateView = context('gate'), oldGesture = scenePackNodeDoubleClick(ref, gateView)!; oldGesture();
  const selectedGate = config.document.execution!.nodes.find(item => item.id === 'gate')!.bindings.gateType;
  assert.equal(selectedGate.kind, 'literal'); if (selectedGate.kind === 'literal') assert.equal(selectedGate.value, 'OR');
  assert.throws(oldGesture, /STALE_VIEW/); assert.deepEqual(config.document.execution!.links, links);
  host.setDocument(config.document); result = await runCapabilityContract(host, config, ['c']).completion;
  assert.equal(result.status, 'succeeded'); const payload = eventResult().payload;
  assert.equal(payload.kind, 'inline'); if (payload.kind === 'inline') assert.equal((payload.value as any).definition.operator, 'OR');
  const fixed = context('gate'); fixed.editable = false; assert.throws(scenePackNodeDoubleClick(ref, fixed)!, /不可编辑/);
  const ended = context('gate'); ended.active = false; assert.throws(scenePackNodeDoubleClick(ref, ended)!, /不可编辑/);
  const Gate = pack.views!['fault-tree-logic/gate'].node as React.ComponentType<ScenePackViewContext>;
  const Event = pack.views!['fault-tree-logic/event'].node as React.ComponentType<ScenePackViewContext>;
  const eventMarkup = renderToStaticMarkup(React.createElement(Event, context('a')));
  assert.equal((eventMarkup.match(/<select/g) ?? []).length, 1); assert.equal((eventMarkup.match(/<textarea/g) ?? []).length, 1);
  assert(!eventMarkup.includes('<input') && !eventMarkup.includes('事件名称') && !eventMarkup.includes('是否发生'));
  assert(renderToStaticMarkup(React.createElement(Gate, context('gate'))).includes('双击切换为与门'));
  const projection = projectS2PublicCanvas(pack, config.definition, config.document);
  assert.deepEqual(Object.keys(projection.nodes.find(item => item.id === 'a')!.values!).sort(), ['content', 'eventType']);
  const publicText = JSON.stringify([projection, publicS2Catalog(pack), pack.describe()]);
  for (const privateKey of ['onDoubleClick', 'inputAnchors', 'outputAnchors', 'nodeView']) assert(!publicText.includes(privateKey));
  const workspace = exportS2Workspace(config.definition, config.document, ref), restored = importS2WorkspaceWithPack(workspace);
  assert.deepEqual(restored.interactionPack, ref); assert.deepEqual(restored.definition.initial, config.document);
  assert.deepEqual(readFaultTreeModel(restored.definition.initial).rules[0].operator, 'OR');
  // Ship a deterministic, complete AND starter independent of the modified test instance.
  const starter = compileS2PublicCanvas(pack, sample, { goal: '事故树：C = AND(A, B)' });
  const starterText = exportS2Workspace(starter.definition, starter.document, ref);
  await fs.writeFile(path.join(source, 'sample.s2-workspace.json'), starterText + '\n');
  await fs.writeFile(path.join(source, 'sample.pack-config.json'), JSON.stringify(starter, null, 2) + '\n');
  const multiStarter = compileS2PublicCanvas(pack, JSON.parse(await fs.readFile(path.join(source, 'sample.multi-input.public-canvas.json'), 'utf8')), { goal: '事故树：C = AND(A, B, D)' });
  assert.deepEqual(pack.validate(multiStarter), []);
  await fs.writeFile(path.join(source, 'sample.multi-input.s2-workspace.json'), exportS2Workspace(multiStarter.definition, multiStarter.document, ref) + '\n');
  await fs.writeFile(path.join(source, 'sample.multi-input.pack-config.json'), JSON.stringify(multiStarter, null, 2) + '\n');
  await fs.writeFile(path.join(temporary, 'restored-workspace.json'), workspace);
  const fresh = new S2PluginHost('fault-tree-restored', restored.definition, scenePackLocalAdapter(ref)); hosts.push(fresh); fresh.setDocument(restored.definition.initial);
  assert.equal(fresh.history().length, 0); assert.notEqual(fresh.runId, host.runId);
  assert.equal((await runCapabilityContract(fresh, { definition: restored.definition, document: restored.definition.initial }, ['c']).completion).status, 'succeeded');
  const badRole = structuredClone(config); badRole.document.execution!.nodes.find(item => item.id === 'c')!.bindings.eventType = { kind: 'literal', value: 'basic' };
  assert(pack.validate(badRole).some(item => item.message.includes('基本事件不接')));
  assert.doesNotThrow(() => exportS2Workspace(badRole.definition, badRole.document, ref), 'Incomplete/invalid business drafts remain saveable');
  const beforeRuns = host.workflowHistory().length;
  assert.throws(() => enqueueSceneInteractionWorkflow(host, badRole, ref, ['c']), /PACK_EXECUTION_DISABLED/); assert.equal(host.workflowHistory().length, beforeRuns);
  const missing = structuredClone(config); missing.document.execution!.links = links.filter(item => item.target.portId !== 'right');
  assert(pack.validate(missing).some(item => item.message.includes('2至32个不同下级事件')));
  const badValue = structuredClone(sample); badValue.nodes.find(item => item.id === 'a')!.values!.eventType = 'unknown';
  assert.throws(() => compileS2PublicCanvas(pack, badValue, { goal: '类型枚举严格校验' }));
  const tooLong = structuredClone(sample); tooLong.nodes.find(item => item.id === 'a')!.values!.content = 'x'.repeat(2001);
  assert.throws(() => compileS2PublicCanvas(pack, tooLong, { goal: '内容上限与公共目录一致' }));
  const blank = compileS2PublicCanvas(pack, { version: 1, nodes: [], connections: [] }, { goal: '空白草稿' }); assert(pack.validate(blank).length > 0);
  assert.doesNotThrow(() => exportS2Workspace(blank.definition, blank.document, ref));
  const invalid = structuredClone(sample); invalid.connections![0].target = { nodeId: 'c', portId: 'condition' };
  assert.throws(() => compileS2PublicCanvas(pack, invalid, { goal: '拒绝事件直连事件' }), /类型|TYPE/);
  const cyclic = structuredClone(sample); cyclic.connections!.push({ source: { nodeId: 'c', portId: 'event' }, target: { nodeId: 'gate', portId: 'left' } });
  assert.throws(() => compileS2PublicCanvas(pack, cyclic, { goal: '拒绝循环' }));
  const call = { protocolVersion: 1, id: 'test', sceneId: 's', runId: 'r', revision: 0, pluginId: 'fault-tree-logic', pluginVersion: '1.0.0', capabilityId: 'gate', nodeId: 'g' } as S2PluginInvocation;
  // Old A/B left/right saves remain compatible; both stable ports now aggregate
  // many event sources. Exercise actual host gathering, not just schema changes.
  const multiCanvas = (count: number, split = count): S2PublicCanvas => ({ version: 1,
    nodes: [
      { id: 'parent', componentId: 'event', position: { x: 300, y: 0 }, values: { eventType: 'top', content: '多输入顶事件' } },
      { id: 'many', componentId: 'gate', position: { x: 300, y: 250 }, values: { gateType: 'AND' } },
      ...Array.from({ length: count }, (_, i) => ({ id: `event${i}`, componentId: 'event', position: { x: i * 250, y: 500 }, values: { eventType: 'basic', content: `事件${i}` } })),
    ], connections: [
      ...Array.from({ length: count }, (_, i) => ({ source: { nodeId: `event${i}`, portId: 'event' }, target: { nodeId: 'many', portId: i < split ? 'left' : 'right' } })),
      { source: { nodeId: 'many', portId: 'condition' }, target: { nodeId: 'parent', portId: 'condition' } },
    ] });
  for (const [count, split] of [[3, 3], [5, 2], [2, 0]]) {
    const many = compileS2PublicCanvas(pack, multiCanvas(count, split), { goal: '多个输入共同定义门条件' });
    assert.deepEqual(pack.validate(many), []);
    for (const operator of ['AND', 'OR']) {
      many.document = applyS2Commands(many.definition, many.document, [{ op: 'update-execution-node', id: 'many', bindings: { gateType: { kind: 'literal', value: operator } } }]);
      const live = new S2PluginHost(`multi-${count}-${operator}`, many.definition, scenePackLocalAdapter(ref)); hosts.push(live); live.setDocument(many.document);
      const run = await runCapabilityContract(live, many, ['parent']).completion; assert.equal(run.status, 'succeeded');
      const output = live.currentArtifact(run.nodes.find(node => node.nodeId === 'parent')!.artifactIds[0]); assert.equal(output.payload.kind, 'inline');
      if (output.payload.kind === 'inline') {
        const condition = (output.payload.value as any).definition;
        assert.equal(condition.operator, operator); assert.deepEqual(condition.inputEventIds, Array.from({ length: count }, (_, i) => `event${i}`));
        assert(isCondition(condition));
      }
      const restoredMany = importS2WorkspaceWithPack(exportS2Workspace(many.definition, many.document, ref));
      assert.deepEqual(readFaultTreeModel(restoredMany.definition.initial), readFaultTreeModel(many.document));
    }
  }
  const maximum = compileS2PublicCanvas(pack, multiCanvas(MAX_GATE_INPUTS, 16), { goal: '完整协议边界32事件' });
  assert.deepEqual(pack.validate(maximum), []); assert.equal(readFaultTreeModel(maximum.document).rules[0].inputEventIds.length, 32);
  assert.equal(maximum.document.execution!.nodes.length, 34, '32 input events plus one gate and one parent fit the 40-node host limit');
  // Gate fan-in and whole-graph size are independent limits. Exercise both
  // without raising the host budget or silently dropping any example nodes.
  const atHostLimit = multiCanvas(MAX_GATE_INPUTS, 16);
  for (let i = atHostLimit.nodes.length; i < 40; i++) atHostLimit.nodes.push({ id: `draft${i}`, componentId: 'event',
    position: { x: i * 250, y: 750 }, values: { eventType: 'basic', content: `待连接事件${i}` } });
  const boundedDraft = compileS2PublicCanvas(pack, atHostLimit, { goal: '40节点草稿边界' });
  assert.equal(boundedDraft.document.execution!.nodes.length, 40);
  assert.deepEqual(importS2WorkspaceWithPack(exportS2Workspace(boundedDraft.definition, boundedDraft.document, ref)).definition.initial, boundedDraft.document);
  atHostLimit.nodes.push({ id: 'overHostLimit', componentId: 'event', position: { x: 0, y: 1000 }, values: { eventType: 'basic', content: '第41个节点' } });
  assert.throws(() => compileS2PublicCanvas(pack, atHostLimit, { goal: '拒绝41节点而非裁剪' }), /≤40/);
  const fullInputs = Array.from({ length: 32 }, (_, i) => ({ eventId: `event${i}`, eventType: 'basic', content: `事件${i}` }));
  const maxRun = await executeLocal(call, { gateType: ['OR'], left: fullInputs.slice(0, 16), right: fullInputs.slice(16) }, new AbortController().signal);
  assert.equal(maxRun.status, 'succeeded');
  // A multi-input condition can define an intermediate event and participate
  // in a second gate; the event payload does not recursively copy the tree.
  const nestedCanvas = multiCanvas(3, 2);
  nestedCanvas.nodes.find(node => node.id === 'parent')!.values!.eventType = 'intermediate';
  nestedCanvas.nodes.push({ id: 'upper', componentId: 'gate', position: { x: 300, y: -150 }, values: { gateType: 'OR' } },
    { id: 'root', componentId: 'event', position: { x: 300, y: -400 }, values: { eventType: 'top', content: '顶事件' } });
  nestedCanvas.connections.push({ source: { nodeId: 'parent', portId: 'event' }, target: { nodeId: 'upper', portId: 'left' } },
    { source: { nodeId: 'event0', portId: 'event' }, target: { nodeId: 'upper', portId: 'left' } },
    { source: { nodeId: 'upper', portId: 'condition' }, target: { nodeId: 'root', portId: 'condition' } });
  const nested = compileS2PublicCanvas(pack, nestedCanvas, { goal: '多输入门与中间事件的上下层组合' }); assert.deepEqual(pack.validate(nested), []);
  const nestedHost = new S2PluginHost('nested-many', nested.definition, scenePackLocalAdapter(ref)); hosts.push(nestedHost); nestedHost.setDocument(nested.document);
  const nestedRun = await runCapabilityContract(nestedHost, nested, ['root']).completion;
  assert.equal(nestedRun.status, 'succeeded');
  const middleOutput = nestedHost.currentArtifact(nestedRun.nodes.find(node => node.nodeId === 'parent')!.artifactIds[0]);
  if (middleOutput.payload.kind === 'inline') assert.deepEqual((middleOutput.payload.value as any).definition.inputEventIds, ['event0', 'event1', 'event2']);
  assert.throws(() => compileS2PublicCanvas(pack, multiCanvas(33, 33), { goal: '拒绝一个接入点33来源' }), /32|CARDINALITY/);
  const overflow = compileS2PublicCanvas(pack, multiCanvas(33, 16), { goal: '两点合计不能超过32个' });
  assert(pack.validate(overflow).some(issue => issue.message.includes('2至32')));
  assert.equal((await executeLocal(call, { gateType: ['AND'], left: fullInputs.slice(0, 16), right: [...fullInputs.slice(16), { eventId: 'extra', eventType: 'basic', content: '超限事件' }] }, new AbortController().signal)).status, 'failed');
  const duplicate = multiCanvas(2); duplicate.connections.push({ source: { nodeId: 'event0', portId: 'event' }, target: { nodeId: 'many', portId: 'right' } });
  const duplicateConfig = compileS2PublicCanvas(pack, duplicate, { goal: '跨端口重复事件不能作为第三个条件' });
  assert(pack.validate(duplicateConfig).some(issue => issue.message.includes('重复接入')));
  assert.equal((await executeLocal(call, { gateType: ['AND'], left: [fullInputs[0]], right: [fullInputs[0]] }, new AbortController().signal)).status, 'failed');
  assert(!isCondition({ gateId: 'g', operator: 'AND', inputEventIds: ['a', 'a'] }));
  assert(!isCondition({ gateId: 'g', operator: 'AND', inputEventIds: ['a'] }));
  assert(!isCondition({ gateId: 'g', operator: 'OR', inputEventIds: Array.from({ length: 33 }, (_, i) => `e${i}`) }));
  // The Agent uses exactly the same public connect operation as manual wiring.
  // Preserve every old wire while adding two more events to occupied inputs.
  let agentConfig = compileS2PublicCanvas(pack, sample, { goal: 'Agent扩展已有门' });
  const actions = ['d', 'e'].flatMap(id => [
    { type: 'addNode', node: { id, componentId: 'event', position: { x: 800, y: id === 'd' ? 500 : 800 }, values: { eventType: 'basic', content: id } } },
    { type: 'connect', connection: { source: { nodeId: id, portId: 'event' }, target: { nodeId: 'gate', portId: 'left' } } },
  ]);
  const plan = prepareS2InteractionActions(pack, agentConfig, actions as any, { actions: ['reply', 'edit'] });
  const applied = await executeS2InteractionActions(plan, { guard() {}, readConfig: () => agentConfig, applyConfig: next => { agentConfig = next; },
    run: async () => assert.fail('Adding input wires does not run'), cancel: () => assert.fail('Adding input wires does not cancel') });
  assert.equal(applied.status, 'completed'); assert.deepEqual(pack.validate(agentConfig), []);
  assert.equal(readFaultTreeModel(agentConfig.document).rules[0].inputEventIds.length, 4);
  for (const type of ['run', 'cancel']) assert.throws(() => prepareS2InteractionActions(pack, agentConfig,
    type === 'run' ? [{ type, targetNodeIds: ['c'] }] : [{ type, runId: 'fake-run' }], { actions: ['reply', 'edit', 'execute'] }), /PACK_EXECUTION_DISABLED/);
  assert.deepEqual(agentConfig.document.execution!.links.slice(0, 3), starter.document.execution!.links);
  assert.equal((await executeLocal(call, { gateType: ['XOR'] }, new AbortController().signal)).status, 'failed');
  const stop = new AbortController(); stop.abort(); assert.equal((await executeLocal(call, {}, stop.signal)).status, 'cancelled');
  let current = structuredClone(config), closes = 0;
  const runtime = createRuntime(current, { readConfig: () => structuredClone(current), validateConfig() {}, applyConfig: next => { current = next; },
    run: () => ({ id: 'owned', completion: Promise.resolve({}) }), cancel() {}, readResults: () => [], close() { closes++; } });
  assert.equal((runtime.dispatch('readModel') as any).rules[0].operator, 'OR');
  assert.throws(() => runtime.run(['c']), /PACK_EXECUTION_DISABLED/);
  assert.throws(() => runtime.dispatch('run', { targets: ['c'] }), /PACK_EXECUTION_DISABLED/);
  assert.throws(() => runtime.updateConfig(missing), /INVALID_CONFIG/);
  assert.throws(() => runtime.dispatch('cancel', { runId: 'foreign' }), /RUN_NOT_OWNED/);
  assert.throws(() => runtime.dispatch('calculateProbability'), /UNKNOWN_OPERATION/);
  runtime.dispose(); runtime.dispose(); assert.equal(closes, 1); assert.throws(() => runtime.dispatch('readModel'), /PACK_CLOSED/);
  console.log('Fault-tree package passed: backward-compatible A/B and 3/5-input AND/OR typed execution, all inputs on either anchor, nested gates, 32-event (34-node) boundary, 40-node draft roundtrip/41-node rejection and overflows/duplicates, Agent public add+connect actions preserving old wires, workspace reuse, local views/lifecycle and Agent UI exclusion. No prompt pack, model or network.');
} finally {
  hosts.forEach(closeSceneInteractionHost); globalThis.fetch = previousFetch;
  if (oldWindow) Object.defineProperty(globalThis, 'window', oldWindow); else Reflect.deleteProperty(globalThis, 'window');
  if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document');
}
