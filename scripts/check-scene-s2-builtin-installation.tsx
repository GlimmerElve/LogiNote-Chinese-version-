import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { S2Document } from '../src/types/sceneS2';
import type { S2Artifact, S2Json, S2PluginGrant, S2PluginInvocation, S2PluginNode } from '../src/types/sceneS2Plugin';
import { s2BuiltinPluginInstallation, s2BuiltinPluginRegistry, s2ComposableCapabilities, s2InstalledPluginCatalog, s2RuntimePluginCatalog } from '../src/services/scene/sceneS2PluginRegistry';
import { readS2Artifact, validateS2Invocation, validateS2Outcome } from '../src/services/scene/sceneS2PluginProtocol';
import { s2TableToRecords, type S2Table } from '../src/services/scene/sceneS2Structured';
import { S2PluginHost, S2_LOCAL_RUN_LIMIT } from '../src/services/scene/sceneS2PluginHost';
import { S2ArtifactView } from '../src/components/scene/S2ArtifactView';
import { s2AdapterRecords as records, s2AdapterSimulation as simulation, s2LocalAdapterSamples as samples } from './scene-s2-adapter-fixtures';

const previousFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Builtin installation regression forbids network and real models'); };
const hosts: S2PluginHost[] = [];
const registry = s2BuiltinPluginRegistry(), installation = s2BuiltinPluginInstallation();
const ref = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const key = (value: Omit<S2PluginNode, 'id'>) => `${value.pluginId}/${value.capabilityId}`;
const makeCall = (binding: Omit<S2PluginNode, 'id'>): S2PluginInvocation => ({ protocolVersion: 1,
  id: `call-${binding.pluginId}-${binding.capabilityId}`, sceneId: 'installation-scene', runId: 'installation-run', nodeId: 'target',
  revision: 1, ...binding, idempotencyKey: 'installation-key', inputs: {} });
function hasFunction(value: unknown): boolean {
  if (typeof value === 'function') return true;
  return Boolean(value && typeof value === 'object' && Object.values(value).some(hasFunction));
}
function inputArtifact(id: string, type: S2Artifact['type'], value: S2Json): S2Artifact {
  return readS2Artifact(registry, { protocolVersion: 1, id, type, complete: true,
    source: { sceneId: 'installation-scene', runId: 'installation-run', nodeId: 'input', revision: 1, kind: 'user' },
    payload: { kind: 'inline', value } });
}

try {
  const installed = registry.catalog().flatMap(plugin => plugin.capabilities.map(capability => ({
    binding: ref(plugin.id, capability.id), capability,
  })));
  assert.equal(installed.length, 26);
  assert.equal(s2ComposableCapabilities().length, 24, 'Original routes plus image source, raw text view and single-node composition, never field editors');
  const kinds: Record<string, number> = {};
  for (const { binding } of installed) {
    const descriptor = installation.descriptor(binding);
    kinds[descriptor.kind] = (kinds[descriptor.kind] ?? 0) + 1;
    assert.equal(hasFunction(descriptor), false, 'Descriptions must not expose executable functions');
    assert.deepEqual(JSON.parse(JSON.stringify(descriptor)), descriptor);
  }
  assert.deepEqual(kinds, { editor: 2, local: 13, renderer: 4, human: 3, model: 1, resource: 3 });
  for (const catalogue of [s2InstalledPluginCatalog(), s2RuntimePluginCatalog([ref('structured-data', 'parse-json')])]) {
    assert.equal(hasFunction(catalogue), false);
    assert.deepEqual(JSON.parse(JSON.stringify(catalogue)), catalogue);
  }
  const runtime = s2RuntimePluginCatalog([ref('structured-data', 'parse-json')]);
  assert.deepEqual(runtime.plugins.flatMap(plugin => plugin.capabilities.filter(cap => cap.kind !== 'editor')
    .map(cap => `${plugin.id}/${cap.id}`)), ['structured-data/parse-json'], 'Registration is not a run-wide capability grant');

  // Every local route uses its real adapter and the same ingress/egress protocol as the host.
  const actualOutputs = new Map<string, S2Artifact>();
  for (const { binding, capability } of installed.filter(item => installation.descriptor(item.binding).kind === 'local')) {
    const values = samples[key(binding)]; assert.ok(values, `Missing adapter fixture: ${key(binding)}`);
    const call = makeCall(binding), artifacts: S2Artifact[] = [];
    for (const port of capability.inputs) {
      call.inputs[port.id] = (values[port.id] ?? []).map((value, index) => {
        const artifact = inputArtifact(`source-${port.id}-${index}`, port.type, value); artifacts.push(artifact); return artifact.id;
      });
    }
    const grant: S2PluginGrant = { sceneId: call.sceneId, runId: call.runId, revision: call.revision, capabilities: [binding],
      permissions: [], resourceScopes: [], readableArtifactIds: artifacts.map(artifact => artifact.id), confirmedInvocationIds: [], remainingCalls: 1 };
    const checked = await validateS2Invocation(registry, call, grant, artifacts);
    const raw = await installation.execute(checked.invocation, checked.inputs, new AbortController().signal);
    const outcome = await validateS2Outcome(registry, checked.invocation, raw, artifacts.map(artifact => artifact.id));
    assert.equal(outcome.status, 'succeeded', key(binding));
    const output = Object.values(outcome.outputs).flat(); assert.equal(output.length, 1);
    for (const artifact of output) {
      readS2Artifact(registry, artifact);
      assert.equal(artifact.source.invocationId, call.id); assert.equal(artifact.source.kind, 'plugin');
      assert.equal(artifact.complete, true);
    }
    actualOutputs.set(key(binding), output[0]);
    assert.equal(grant.remainingCalls, 1, 'Installation lookup/dispatch is not the host budget ledger');
  }
  const inlineValue = (artifact: S2Artifact) => {
    if (artifact.payload.kind !== 'inline') assert.fail('Fixture requires complete inline value');
    return artifact.payload.value;
  };
  assert.equal(inlineValue(actualOutputs.get('structured-data/select')!), false);
  assert.deepEqual(inlineValue(actualOutputs.get('structured-data/table-to-json')!), records);
  assert.deepEqual(inlineValue(actualOutputs.get('workflow-merge/merge-simulation')!), simulation);
  assert.equal(inlineValue(actualOutputs.get('text-template/render')!), '角色：场景讲解员');
  assert.equal(inlineValue(actualOutputs.get('text-template/compose')!), '第一段：原文甲 {{literal}}\n第三段：原文乙 $&');

  // Reviewed renderer declarations must be backed by the actual production UI, not a successful no-op.
  const renderCases = [
    { binding: ref('structured-view', 'text'), port: 'text', view: 'text', output: 'text-template/render', marker: '角色：场景讲解员' },
    { binding: ref('structured-view', 'json-tree'), port: 'value', view: 'json-tree', output: 'structured-data/parse-json', marker: 's2-json-tree' },
    { binding: ref('structured-view', 'table'), port: 'table', view: 'table', output: 'structured-data/to-table', marker: '记录表' },
    { binding: ref('workflow-simulation', 'inspect'), port: 'result', view: 'simulation', output: 'workflow-simulation/step', marker: '非真实业务执行' },
  ];
  for (const item of renderCases) {
    const descriptor = installation.descriptor(item.binding); assert.equal(descriptor.kind, 'renderer');
    if (descriptor.kind !== 'renderer') assert.fail('Renderer descriptor required');
    assert.equal(descriptor.portId, item.port); assert.equal(descriptor.view, item.view);
    const artifact = actualOutputs.get(item.output)!;
    const port = registry.capability(item.binding).inputs.find(port => port.id === descriptor.portId)!;
    assert.ok(port.required && !port.multiple && registry.compatible(artifact.type, port.type));
    const markup = renderToStaticMarkup(<S2ArtifactView artifact={artifact} />);
    assert.ok(markup.includes(item.marker), `${key(item.binding)} needs its production view`);
    assert.ok(!markup.includes('role="alert"')); assert.ok(!markup.includes('<script>'));
    if (descriptor.view === 'simulation') assert.ok(markup.includes('预设输出') && markup.includes('未验证业务效果'));
  }

  for (const { binding } of installed.filter(item => installation.descriptor(item.binding).kind !== 'local')) {
    await assert.rejects(async () => installation.execute(makeCall(binding), {}, new AbortController().signal),
      `Local dispatch must not bypass ${key(binding)} host lifecycle`);
  }
  for (const binding of [ref('uninstalled', 'run'), { ...ref('structured-data', 'parse-json'), pluginVersion: '1.0.1' }, ref('structured-data', 'invented')]) {
    assert.throws(() => installation.descriptor(binding));
    await assert.rejects(async () => installation.execute(makeCall(binding), {}, new AbortController().signal));
  }

  // Real host graph: exact typed chain, renderer consumes only its declared port, cache provenance stays distinct.
  const plugins = [ref('structured-data', 'parse-json'), ref('structured-data', 'to-table'), ref('structured-view', 'table')];
  const document: S2Document = { nodes: [{ id: 'raw', type: 'data', position: { x: 0, y: 0 }, values: { content: JSON.stringify(records) } }], edges: [],
    execution: { version: 1, nodes: [
      { id: 'parse', ...plugins[0], position: { x: 200, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'raw', fieldId: 'content' } } },
      { id: 'table', ...plugins[1], position: { x: 400, y: 0 }, bindings: {} },
      { id: 'view', ...plugins[2], position: { x: 600, y: 0 }, bindings: {} },
    ], links: [{ source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'table', portId: 'value' } },
      { source: { nodeId: 'table', portId: 'table' }, target: { nodeId: 'view', portId: 'table' } }] } };
  const host = new S2PluginHost('builtin-installation-host', plugins); hosts.push(host); host.setDocument(document);
  const first = await host.enqueueWorkflow(['view']).completion;
  assert.equal(first.status, 'succeeded'); assert.deepEqual(first.nodes.map(node => node.status), ['succeeded', 'succeeded', 'displayed']);
  assert.equal(host.history().length, 2); assert.equal(host.remainingCalls, S2_LOCAL_RUN_LIMIT - 2, 'Renderer does not consume local adapter quota');
  const tableArtifact = host.history().find(entry => entry.request.nodeId === 'table')!.artifacts[0];
  assert.deepEqual(first.nodes.find(node => node.nodeId === 'view')!.artifactIds, [tableArtifact.id]);
  assert.deepEqual(s2TableToRecords(inlineValue(tableArtifact) as unknown as S2Table), records);
  const cached = await host.enqueueWorkflow(['view']).completion;
  assert.equal(cached.status, 'succeeded'); assert.deepEqual(cached.nodes.map(node => node.status), ['cached', 'cached', 'displayed']);
  assert.equal(host.history().length, 2); assert.equal(host.remainingCalls, S2_LOCAL_RUN_LIMIT - 2);
  assert.ok(cached.nodes.filter(node => node.status === 'cached').every(node => node.cacheReuseId && !node.invocationId));
  const current = host.currentArtifact(cached.nodes.find(node => node.nodeId === 'view')!.artifactIds[0]);
  assert.deepEqual(inlineValue(current), inlineValue(tableArtifact));
  assert.equal(current.source.kind, 'host'); assert.equal(current.source.invocationId, undefined, 'Reuse is not a fabricated plugin execution');
  const reuse = host.prepare('view', { goal: '核对缓存来源', understanding: '只读', planning: '不运行', response: '说明依据' }, '只核对来源')
    .cacheReuses.find(item => item.nodeId === 'table')!;
  assert.equal(reuse.sourceInvocationId, tableArtifact.source.invocationId, 'Separate reuse evidence retains the original invocation');
  assert.deepEqual(reuse.outputs.table, [current.id]);
  assert.notEqual(current.id, tableArtifact.id, 'Cache replay publishes an explicit reused artifact, not a fabricated new call');
  const denied = new S2PluginHost('builtin-installation-denied', []); hosts.push(denied); denied.setDocument(document);
  await assert.rejects(async () => denied.enqueueWorkflow(['view']).completion);
  assert.equal(denied.history().length, 0); assert.equal(denied.remainingCalls, S2_LOCAL_RUN_LIMIT);
  assert.equal(networkAttempts, 0);
  console.log('S2 builtin installation passed: 26 exact routes (13 local / 4 renderer / 3 human / 2 editor / 1 model / 3 resource), all 13 real adapter ingress/egress checks, production renderer SSR, data-only catalogues, nonlocal dispatch rejection, typed host parse/table/view, preserved native values, grant and cache provenance isolation. Synthetic data; no model/network/resources.');
} finally {
  hosts.forEach(host => host.close()); globalThis.fetch = previousFetch;
}
