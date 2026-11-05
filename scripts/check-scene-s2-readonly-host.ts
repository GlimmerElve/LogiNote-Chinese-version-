import assert from 'node:assert/strict';
import type { S2Document } from '../src/types/sceneS2';
import type { ScenePackConfig } from '../src/types/sceneInteractionPack';
import { createS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { mutateS2Batch } from '../src/services/scene/sceneS2Layout';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { createScenePackHostServices } from '../src/services/scene/sceneInteractionHostServices';

globalThis.fetch = async () => assert.fail('Read-only host acceptance forbids real network/model calls');
const parse = { pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json' };
const human = { pluginId: 'human-input', pluginVersion: '1.0.0', capabilityId: 'text' };
const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '通用只读宿主验收', knowledgePoints: [] });
const definition = readS2Definition({ ...scene.canvasWorkspace, plugins: [parse, human], initial: {
  nodes: [{ id: 'fixed', type: 'text', readOnly: true, position: { x: 0, y: 0 }, values: { content: '{"fixed":true}' } },
    { id: 'editable', type: 'text', position: { x: 0, y: 200 }, values: { content: '可自由修改' } }], edges: [],
  execution: { version: 1, nodes: [{ id: 'parse', ...parse, position: { x: 400, y: 0 },
    bindings: { text: { kind: 'field', nodeId: 'fixed', fieldId: 'content' } } },
    { id: 'ask', ...human, position: { x: 400, y: 200 }, bindings: { prompt: { kind: 'literal', value: '合成人工确认' } } }], links: [] },
} });
const fixed = (document: S2Document) => document.nodes.find(node => node.id === 'fixed')!;
const strategy = { goal: '通用内容保护', ...definition.instructions };
const hosts: S2PluginHost[] = [];
const makeHost = (selection: ConstructorParameters<typeof S2PluginHost>[1]) => {
  const host = new S2PluginHost(`readonly-host-${hosts.length}`, selection); hosts.push(host); return host;
};
const mutateFixed = (document: S2Document) => { fixed(document).values.content = '{"fixed":false}'; };
try {
  // The definition supplied at construction is the authority even before first setDocument.
  const supplied = structuredClone(definition), host = makeHost(supplied);
  mutateFixed(supplied.initial);
  assert.throws(() => host.setDocument(supplied.initial), /只读内容块/);
  host.setDocument(definition.initial);
  const completed = await host.enqueueWorkflow(['parse']).completion;
  assert.equal(completed.status, 'succeeded');
  const artifactId = completed.nodes.find(node => node.nodeId === 'parse')!.artifactIds[0];
  assert.deepEqual((host.currentArtifact(artifactId).payload as any).value, { fixed: true });
  const waiting = host.enqueueWorkflow(['ask']);
  for (let i = 0; i < 100 && !host.waitingHumanInputs().length; i++) await new Promise(resolve => setTimeout(resolve, 0));
  const wait = host.waitingHumanInputs()[0]; assert(wait);
  const before = host.prepare('fixed', strategy, '只观察宿主状态');
  const calls = host.remainingCalls, ledger = host.history(), workflow = host.workflowHistory();
  for (const change of [mutateFixed,
    (document: S2Document) => { fixed(document).readOnly = false; },
    (document: S2Document) => { delete fixed(document).readOnly; },
    (document: S2Document) => { fixed(document).type = 'other'; },
    (document: S2Document) => { document.nodes = document.nodes.filter(node => node.id !== 'fixed'); },
    // Actual field resolution selects the first match: a duplicate must not fool a last-match lock guard.
    (document: S2Document) => { document.nodes.unshift({ ...structuredClone(fixed(document)), readOnly: false, values: { content: '{"injected":true}' } }); },
    (document: S2Document) => { document.nodes.push(structuredClone(fixed(document))); },
  ]) {
    const tampered = structuredClone(definition.initial); change(tampered);
    assert.throws(() => host.setDocument(tampered), /只读内容块/);
    const after = host.prepare('fixed', strategy, '继续观察');
    assert.equal(after.frame.revision, before.frame.revision);
    assert.deepEqual(after.bindings, before.bindings);
    assert.equal(after.interactions.totalEvents, before.interactions.totalEvents);
    assert.equal(host.remainingCalls, calls); assert.deepEqual(host.history(), ledger);
    assert.deepEqual(host.workflowHistory(), workflow);
    assert.equal(host.waitingHumanInputs()[0].id, wait.id, 'Rejected writes neither cancel waits nor stale existing artifacts');
    assert.deepEqual((host.currentArtifact(artifactId).payload as any).value, { fixed: true });
  }
  const renamed = structuredClone(definition.initial); fixed(renamed).label = '改名'; fixed(renamed).position.x += 50;
  host.setDocument(renamed);
  assert.equal(host.prepare(null, strategy, '').frame.revision, before.frame.revision, 'Allowed display/layout writes preserve execution revision');
  assert.equal(host.waitingHumanInputs()[0].id, wait.id);
  host.submitHumanInput(waiting.id, wait.id, '确认'); assert.equal((await waiting.completion).status, 'succeeded');
  const copied = mutateS2Batch(renamed, { kind: 'copy', nodeIds: ['fixed'] });
  const copy = copied.nodes.find(node => !renamed.nodes.some(old => old.id === node.id))!;
  host.setDocument(copied);
  const badCopy = structuredClone(copied); badCopy.nodes.find(node => node.id === copy.id)!.values.content = '不能改副本';
  assert.throws(() => host.setDocument(badCopy), /只读内容块/);
  assert.doesNotThrow(() => host.setDocument(renamed), 'Undo/removal of a derived copy is allowed');
  const editable = structuredClone(renamed); editable.nodes.find(node => node.id === 'editable')!.values.content = '新的可编辑内容';
  assert.doesNotThrow(() => host.setDocument(editable));

  for (const selection of [definition.plugins, { plugins: definition.plugins, blockTypes: definition.blockTypes }]) {
    const legacy = makeHost(selection), initial = structuredClone(definition.initial);
    legacy.setDocument(initial); mutateFixed(initial);
    assert.throws(() => legacy.setDocument(initial), /只读内容块/, 'Legacy callers freeze an independent first-document baseline');
  }

  const serviceHost = makeHost(definition); serviceHost.setDocument(definition.initial);
  let config: ScenePackConfig = { definition: structuredClone(definition), document: structuredClone(definition.initial) }, applies = 0;
  const services = createScenePackHostServices(serviceHost, () => config, next => {
    serviceHost.setDocument(next.document); config = next; applies++;
  });
  const checkDenied = (candidate: ScenePackConfig) => {
    const original = structuredClone(config), count = applies;
    assert.throws(() => services.applyConfig(candidate), /只读内容块/);
    assert.equal(applies, count, 'Guard rejects before calling an application mutation callback');
    assert.deepEqual(config, original);
  };
  // Reject self-contradictory candidates on their first validation/application, even for a newly authored fixed block.
  // Previously the first application succeeded and the same config only failed on its second application.
  for (const mutation of ['missing', 'changed', 'unlocked'] as const) {
    const candidate = structuredClone(config), original = structuredClone(config), count = applies;
    const anchor = { ...structuredClone(fixed(candidate.definition.initial)), id: 'newFixed', position: { x: 0, y: 400 } };
    candidate.definition.initial.nodes.push(anchor);
    if (mutation !== 'missing') candidate.document.nodes.push({ ...structuredClone(anchor),
      ...(mutation === 'changed' ? { values: { content: '{"changed":true}' } } : { readOnly: false }) });
    assert.throws(() => services.validateConfig(candidate), /只读内容块/);
    assert.deepEqual(config, original); assert.equal(applies, count, 'Validation has no callback side effects');
    checkDenied(candidate);
    assert.equal(serviceHost.history().length, 0); assert.equal(serviceHost.workflowHistory().length, 0);
  }
  assert.doesNotThrow(() => services.validateConfig(config), 'The actual current candidate remains valid after all rejected attempts');
  let candidate = structuredClone(config); mutateFixed(candidate.definition.initial); checkDenied(candidate);
  candidate = structuredClone(config); mutateFixed(candidate.document); checkDenied(candidate);
  candidate = structuredClone(config);
  fixed(candidate.definition.initial).readOnly = false; fixed(candidate.document).readOnly = false;
  mutateFixed(candidate.definition.initial); mutateFixed(candidate.document); checkDenied(candidate);
  candidate = structuredClone(config);
  for (const document of [candidate.definition.initial, candidate.document]) {
    document.nodes = document.nodes.filter(node => node.id !== 'fixed');
    delete document.execution!.nodes.find(node => node.id === 'parse')!.bindings.text;
  }
  checkDenied(candidate);
  candidate = structuredClone(config); candidate.document.nodes.find(node => node.id === 'editable')!.values.content = '包内合法改写';
  services.applyConfig(candidate); assert.equal(applies, 1);
  assert.equal(config.document.nodes.find(node => node.id === 'editable')!.values.content, '包内合法改写');
  candidate = structuredClone(config); candidate.document = mutateS2Batch(candidate.document, { kind: 'copy', nodeIds: ['fixed'] });
  services.applyConfig(candidate);
  const serviceCopy = config.document.nodes.find(node => !definition.initial.nodes.some(old => old.id === node.id))!;
  candidate = structuredClone(config);
  candidate.definition.initial.nodes.push({ ...structuredClone(serviceCopy), readOnly: false });
  const tamperedCopy = candidate.document.nodes.find(node => node.id === serviceCopy.id)!;
  tamperedCopy.readOnly = false; tamperedCopy.values.content = '伪造新基线也不能解锁副本';
  checkDenied(candidate);
  candidate = structuredClone(config); candidate.document.nodes = candidate.document.nodes.filter(node => node.id !== serviceCopy.id);
  assert.doesNotThrow(() => services.applyConfig(candidate), 'Package callback may remove a derived fixed copy');
  console.log('S2 read-only host passed: constructor and legacy baseline snapshots, duplicate-ID shadow writes rejected before field resolution, rejected writes preserve revision/artifacts/ledger/budget/active human waits, allowed display/layout and editable writes, derived-copy undo, and package validateConfig/applyConfig reject self-contradictory candidates or forged authored/current baselines before callbacks. Generic JSON/human plugins only; no prompt package, model or network calls.');
} finally { hosts.forEach(host => host.close()); }
