import assert from 'node:assert/strict';
import type { S2Document } from '../src/types/sceneS2';

const priorFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error('Output-index protocol test forbids real network'); };
try {
  const { S2PluginHost } = await import('../src/services/scene/sceneS2PluginHost');
  const { readS2ContextRecall, s2EvidenceIndex, s2PluginContext, s2RecallContext, s2RunRequestContext } = await import('../src/services/scene/sceneS2Context');
  const { createS2AssessmentArtifactScope, resolveS2AssessmentOutput } = await import('../src/services/scene/sceneS2ArtifactAccess');
  const binding = { pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'render' };
  const document: S2Document = { nodes: [], edges: [], execution: { version: 1, nodes: Array.from({ length: 34 }, (_, index) => ({
    id: `Render${index}`, ...binding, position: { x: index, y: 0 }, bindings: { template: { kind: 'literal' as const, value: `Synthetic ${index}` }, variables: { kind: 'literal' as const, value: {} } },
  })), links: [] } };
  const host = new S2PluginHost('SyntheticOutputIndex', [binding]);
  const strategy = { goal: 'Discover real latest outputs without scanning previews', understanding: 'Use metadata, then explicit full recall', planning: 'No automatic run', response: 'Only assess actual sources' };
  try {
    host.setDocument(document);
    const empty = s2EvidenceIndex(host.prepare(null, strategy, '仅查看当前输出'), [{ nodeId: 'Render0', portId: 'text' }])!;
    assert.equal(empty.currentOutputs.length, 16); assert.equal(empty.outputIndexOmitted, 18);
    assert.equal(empty.currentOutputs[0].state, 'not-attempted');
    const completed = await host.enqueueWorkflow().completion;
    assert.equal(completed.status, 'succeeded');
    const targetId = completed.nodes.find(node => node.nodeId === 'Render0')!.artifactIds[0];
    await host.enqueueWorkflow(document.execution!.nodes.slice(1).map(node => node.id)).completion;
    const context = host.prepare(null, strategy, '核对第一个目标');
    const index = s2EvidenceIndex(context, [{ nodeId: 'Render0', portId: 'text' }])!;
    assert.ok(!index.artifacts.some(item => item.id === targetId), 'History tail can omit a still-current output on a larger graph');
    assert.equal(index.currentOutputs[0].nodeId, 'Render0'); assert.deepEqual(index.currentOutputs[0].artifactIds, [targetId]);
    assert.equal(index.currentOutputs[0].state, 'available');
    const focused = s2EvidenceIndex(host.prepare('Render1', strategy, '讨论选中节点'), [{ nodeId: 'Render0', portId: 'text' }])!;
    assert.ok(focused.currentOutputs.some(item => item.nodeId === 'Render1'), 'A focus is discoverability context, not an execution target');
    assert.equal(index.currentOutputs.length, 16); assert.equal(index.outputIndexOmitted, 18);
    const before = { calls: host.remainingCalls, history: JSON.stringify(host.history()), runs: JSON.stringify(host.workflowHistory()) };
    const recall = readS2ContextRecall({ artifactIds: index.currentOutputs[0].artifactIds });
    const body = s2RecallContext(recall, [], document, context);
    assert.equal((body.items[0].value as { text: string }).text, 'Synthetic 0');
    const scope = createS2AssessmentArtifactScope(context, body.items.map(item => item.id));
    assert.equal(resolveS2AssessmentOutput(scope, 'Render0', 'text')!.artifact.id, targetId);
    assert.ok(!Object.hasOwn(s2PluginContext(context, recall)!, 'outputIndex'), 'Do not duplicate the unbounded local index into model tool context');
    context.outputIndex[0].type.id = 'forged'; context.outputIndex[0].artifactIds.push('artifact-forged');
    assert.equal(resolveS2AssessmentOutput(scope, 'Render0', 'text')!.artifact.type.id, 'core.text');
    assert.deepEqual(host.prepare(null, strategy, '重新查看').outputIndex[0].artifactIds, [targetId]);
    assert.deepEqual({ calls: host.remainingCalls, history: JSON.stringify(host.history()), runs: JSON.stringify(host.workflowHistory()) }, before);
    const newer = host.enqueueWorkflow(['Render0']); host.cancelWorkflow(newer.id); await newer.completion;
    const unavailable = s2EvidenceIndex(host.prepare(null, strategy, '新尝试被取消'), [{ nodeId: 'Render0', portId: 'text' }])!.currentOutputs[0];
    assert.equal(unavailable.state, 'unavailable'); assert.deepEqual(unavailable.artifactIds, []);
    assert.equal(resolveS2AssessmentOutput(scope, 'Render0', 'text'), undefined);
    const layout = structuredClone(document); layout.execution!.nodes[0].position.x += 20; host.setDocument(layout);
    assert.equal(host.prepare(null, strategy, '移动布局不重置尝试').outputIndex[0].state, 'unavailable');
    const semantic = structuredClone(layout); semantic.execution!.nodes[0].bindings.template = { kind: 'literal', value: 'changed' }; host.setDocument(semantic);
    assert.ok(host.prepare(null, strategy, '新修订尚未尝试').outputIndex.every(item => item.state === 'not-attempted' && !item.artifactIds.length));
    assert.equal(host.remainingCalls, before.calls, 'Semantic revision does not reset spent calls');
  } finally { host.close(); }

  const initiating = 'u'.repeat(1950) + '完成后仅解释JSON语法，不做业务评价、不提出修改。';
  const latest = 'v'.repeat(1800) + '后续临时暂停正式评价，只解释。';
  const history = [{ role: 'user' as const, content: initiating }, { role: 'assistant' as const, content: 'a'.repeat(6000) },
    { role: 'user' as const, content: latest }, { role: 'assistant' as const, content: 'b'.repeat(6000) }];
  const requests = s2RunRequestContext(history, 'history-0');
  assert.deepEqual(requests.initiatingRequest, { sourceId: 'history-0', text: initiating });
  assert.deepEqual(requests.latestUserRequest, { sourceId: 'history-2', text: latest });
  assert.throws(() => s2RunRequestContext(history, 'history-1'), /真实用户历史/);
  assert.throws(() => s2RunRequestContext(history, 'history-9'), /真实用户历史/);
  assert.throws(() => s2RunRequestContext(history, 'query'), /真实用户历史/);
  assert.equal(s2RunRequestContext([], undefined).initiatingRequest, undefined);
  console.log('S2 output/request indexes passed: bounded discovery pins real criterion ports and focus despite >32-artifact history, full recall and scope still required, immutable metadata, cancelled vs never-attempted states, semantic/layout separation and zero read side effects; exact initiating/latest historical user anchors survive optional history, with forged/assistant origins rejected. Synthetic local adapters only, no real model or user data.');
} finally { globalThis.fetch = priorFetch; }
