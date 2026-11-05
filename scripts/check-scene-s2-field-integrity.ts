import assert from 'node:assert/strict';
import type { S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import { createS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost, S2_LOCAL_RUN_LIMIT } from '../src/services/scene/sceneS2PluginHost';
import { S2ModelTestSession } from '../src/services/scene/sceneS2ModelTest';
import { harness } from './scene-s2-ui-harness';

const previousFetch = globalThis.fetch;
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Field integrity regression forbids real IO'); };
const hosts: S2PluginHost[] = [];
const strategy = { goal: '合成字段验证', understanding: '先理解空白草稿', planning: '仅验证消费字段', response: '不自动执行' };
const cap = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const check = cap('json-check', 'validate'), render = cap('text-template', 'render');
const human = cap('human-input', 'text'), model = cap('model-test', 'generate');
const field = (nodeId: string, fieldId = 'content') => ({ kind: 'field' as const, nodeId, fieldId });
const literal = (value: string | Record<string, never>) => ({ kind: 'literal' as const, value });
const node = (id: string, capability: ReturnType<typeof cap>, bindings: S2WorkflowNode['bindings']): S2WorkflowNode =>
  ({ id, ...capability, bindings, position: { x: 0, y: 0 } });
const state = (run: Awaited<ReturnType<S2PluginHost['enqueueWorkflow']>['completion']>, id: string) => run.nodes.find(node => node.nodeId === id)!;
try {
  const scene = createS2Scene({ source: 'custom', subject: '合成字段执行边界', sceneSkill: 'S2', knowledgePoints: [] });
  const definition = readS2Definition({ ...scene.canvasWorkspace,
    plugins: [check, render, human, model],
    blockTypes: [
      { id: 'text', label: '必填块', fields: [
        { id: 'content', label: '必填内容', kind: 'multiline', required: true },
        { id: 'unused', label: '暂未使用的必填字段', kind: 'text', required: true },
      ] },
      { id: 'optional', label: '可选块', fields: [{ id: 'content', label: '可选内容', kind: 'text' }] },
    ],
    initial: { nodes: [
      { id: 'input', type: 'text', position: { x: 0, y: 0 }, values: { content: '', unused: '' } },
      { id: 'good', type: 'text', position: { x: 0, y: 100 }, values: { content: '{}', unused: '' } },
      { id: 'optional', type: 'optional', position: { x: 0, y: 200 }, values: { content: '' } },
    ], edges: [], execution: { version: 1, nodes: [
      node('badCheck', check, { text: field('input') }),
      node('goodCheck', check, { text: field('good') }),
      node('badRender', render, { template: field('input'), variables: literal({}) }),
      node('downstream', check, {}),
      node('optionalRender', render, { template: field('optional'), variables: literal({}) }),
      node('badHuman', human, { prompt: field('input') }),
      node('badModel', model, { prompt: literal('合成提示词'), input: field('input') }),
      { ...node('skipped', render, { template: field('input'), variables: literal({}) }),
        when: { nodeId: 'goodCheck', portId: 'assessment', pointer: '/status', equals: 'pass', match: false } },
    ], links: [{ source: { nodeId: 'badRender', portId: 'text' }, target: { nodeId: 'downstream', portId: 'text' } }] } },
  });
  const makeHost = () => { const host = new S2PluginHost(scene.sceneId, definition); hosts.push(host); host.setDocument(definition.initial); return host; };
  let syntheticModelCalls = 0;
  const approveSynthetic = (host: S2PluginHost) => {
    const session = new S2ModelTestSession({ sceneId: scene.sceneId, runId: host.runId, resourceId: 'SyntheticResource',
      providerId: 'SyntheticProvider', providerLabel: '合成服务', model: 'synthetic-model',
      limits: { maxRequests: 1, maxReservedOutputTokens: 256, maxOutputTokens: 256 },
      invoke: async () => { syntheticModelCalls++; throw new Error('Invalid consumed fields must not reach even the synthetic model'); } });
    host.approveModelTestSession(session); return session;
  };
  const host = makeHost();
  const prepared = host.prepare('input', strategy, '先解释空白草稿');
  assert.equal(prepared.bindings.length, 2, 'Read-only context does not require filling the canvas');
  const executionPrepared = host.prepare('badCheck', strategy, '先解释绑定');
  assert.equal(executionPrepared.bindings.length, 1);
  const raw = (nodeId: string, artifactId: string) => ({ nodeId, ...check, inputs: { text: [artifactId] }, reason: '用户确认执行' });
  for (const [context, id] of [[prepared, 'input'], [executionPrepared, 'badCheck']] as const) {
    await assert.rejects(host.execute(raw(id, context.bindings[0].artifactId), context.frame, `invalid-${id}`),
      (error: any) => error.code === 'FIELD_INPUT_INVALID' && error.message.includes('必填内容'));
  }
  assert.equal(host.remainingCalls, S2_LOCAL_RUN_LIMIT); assert.equal(host.history().length, 0);
  const invalid = await host.enqueueWorkflow(['badRender', 'downstream']).completion;
  assert.equal(invalid.status, 'failed'); assert.match(state(invalid, 'badRender').error!, /必填内容/);
  assert.equal(state(invalid, 'downstream').status, 'blocked');
  assert.equal(host.remainingCalls, S2_LOCAL_RUN_LIMIT); assert.equal(host.history().length, 0);

  const independent = await host.enqueueWorkflow(['goodCheck']).completion;
  assert.equal(independent.status, 'succeeded', 'Blank unrelated nodes/fields do not block the selected subgraph');
  const skipped = await host.enqueueWorkflow(['skipped']).completion;
  assert.equal(skipped.status, 'succeeded'); assert.equal(state(skipped, 'skipped').status, 'skipped');
  assert.equal(host.remainingCalls, S2_LOCAL_RUN_LIMIT - 1, 'Only the successful check is charged; cached ancestor and skipped branch are not');
  const optional = await host.enqueueWorkflow(['optionalRender']).completion;
  assert.equal(optional.status, 'succeeded');
  const optionalOutput = host.history().at(-1)!.artifacts[0];
  assert.equal(optionalOutput.payload.kind, 'inline');
  if (optionalOutput.payload.kind === 'inline') assert.equal(optionalOutput.payload.value, '', 'Optional empty text remains valid executable data');
  const beforeWaits = host.remainingCalls;
  const session = approveSynthetic(host);
  for (const id of ['badHuman', 'badModel']) {
    const run = await host.enqueueWorkflow([id]).completion;
    assert.equal(run.status, 'failed'); assert.match(state(run, id).error!, /输入字段未通过校验.*必填内容/);
    assert.equal(host.remainingCalls, beforeWaits);
    assert.equal(host.waitingModelTests().length, 0); assert.equal(run.waiting?.length ?? 0, 0);
  }
  assert.equal(session.summary().usedRequests, 0); assert.equal(session.summary().reservedOutputTokens, 0);
  const parallel = makeHost(); approveSynthetic(parallel);
  const all = await parallel.enqueueWorkflow().completion;
  assert.equal(all.status, 'failed'); assert.equal(state(all, 'goodCheck').status, 'succeeded');
  assert.equal(state(all, 'optionalRender').status, 'succeeded'); assert.equal(state(all, 'downstream').status, 'blocked');
  assert.equal(parallel.history().length, 2, 'One failed branch does not stop independent work');

  // Caller mutation cannot weaken the host's captured field policy.
  definition.blockTypes[0].fields[0].required = false;
  await assert.rejects(host.execute(raw('input', prepared.bindings[0].artifactId), prepared.frame, 'mutated-policy'),
    (error: any) => error.code === 'FIELD_INPUT_INVALID');
  definition.blockTypes[0].fields[0].required = true;
  const fixed: S2Document = structuredClone(definition.initial); fixed.nodes[0].values.content = '{}';
  const beforeFix = host.remainingCalls;
  host.setDocument(fixed);
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(host.remainingCalls, beforeFix, 'Editing a field never automatically retries or executes');
  assert.equal(host.workflowHistory().find(run => run.id === invalid.id)!.publication, 'stale');
  await assert.rejects(host.execute(raw('input', prepared.bindings[0].artifactId), prepared.frame, 'old-frame'), /变化/);
  const retry = await host.enqueueWorkflow(['downstream']).completion;
  assert.equal(retry.status, 'succeeded'); assert.equal(host.remainingCalls, beforeFix - 2);
  const cached = await host.enqueueWorkflow(['downstream']).completion;
  assert.equal(cached.status, 'succeeded'); assert.equal(state(cached, 'badRender').status, 'cached');

  // Real production start and message handlers must supply the full policy, not only the plugin grant.
  scene.canvasWorkspace = definition; let uiHost: S2PluginHost | undefined;
  const ui = harness({ legacyCatalogue: true, initialDraft: scene, onHost: host => { uiHost = host; hosts.push(host); } });
  try {
    await ui.openConversationSession(); assert.ok(uiHost);
    const run = await uiHost.enqueueWorkflow(['badRender']).completion;
    assert.equal(run.status, 'failed'); assert.equal(uiHost.remainingCalls, S2_LOCAL_RUN_LIMIT);
    ui.labelControl('向 Agent 提出要求', 'textarea').props.onChange({ target: { value: '先解释如何填写，暂不执行' } }); ui.render();
    ui.button('发送').props.onClick(); ui.render();
    assert.match(ui.pluginContext()!.frame.event.text, /先解释如何填写/);
    ui.resolve({ understanding: '尚未填写', plan: '只解释', reply: '可以先讨论，填写后再执行。', commands: [] });
    await new Promise(resolve => setTimeout(resolve, 0)); ui.render();
    assert.equal(uiHost.remainingCalls, S2_LOCAL_RUN_LIMIT);
  } finally { ui.dispose(); }
  assert.equal(networkCalls, 0);
  assert.equal(syntheticModelCalls, 0);
  console.log('S2 field integrity passed: captured field policy, consumed-only required validation before execution/debit/cache/human/model waits, direct/snapshot/workflow paths, independent/skipped branches, optional empty text, explicit repair/retry, stale safety and real production start/conversation handlers. Offline synthetic only.');
} finally { hosts.forEach(host => host.close()); globalThis.fetch = previousFetch; }
