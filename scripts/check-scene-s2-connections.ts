import assert from 'node:assert/strict';
import type { S2CanvasDefinition, S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import type { S2Json } from '../src/types/sceneS2Plugin';
import { createS2Scene, readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { s2ConnectionDescriptions, s2ConnectionFieldLabel, s2ConnectionNodeLabel, s2ConnectionPortLabel } from '../src/services/scene/sceneS2Connections';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { s2ExecutionLinkKey } from '../src/services/scene/sceneS2Workflow';

const cap = (pluginId: string, capabilityId: string) => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const parse = cap('structured-data', 'parse-json'), stringify = cap('structured-data', 'stringify');
const literal = (value: S2Json) => ({ kind: 'literal' as const, value });
const node = (id: string, capability: ReturnType<typeof cap>, bindings: S2WorkflowNode['bindings']): S2WorkflowNode => ({
  id, ...capability, position: { x: 0, y: 0 }, bindings,
});
const sourceValue = { 'a/b': { '~key': { '0': false } }, private: 'BODY_SECRET_NEVER_DISPLAY' };
const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成可读连线验证', knowledgePoints: [] });
const definition = readS2Definition({ ...scene.canvasWorkspace, plugins: [parse, stringify],
  blockTypes: [{ id: 'text', label: '角色「设定」块', fields: [{ id: 'content', label: '正文与说明', kind: 'multiline' }] }],
  initial: { nodes: [
    { id: 'content-a', type: 'text', position: { x: 0, y: 0 }, values: { content: JSON.stringify(sourceValue) } },
    { id: 'content-b', type: 'text', position: { x: 0, y: 0 }, values: { content: 'SECOND_BODY_SECRET_NEVER_DISPLAY' } },
  ], edges: [{ id: 'idea-link', source: 'content-a', target: 'content-b', label: '补充解释' }], execution: {
    version: 1, nodes: [
      { ...node('parse-a', parse, { text: { kind: 'field', nodeId: 'content-a', fieldId: 'content' } }), presentation: { label: '重复步骤', outputs: { value: '完整「解析」结果' } } },
      { ...node('parse-b', parse, { text: literal('null') }), presentation: { label: '重复步骤', outputs: { value: '完整「解析」结果' } } },
      { ...node('text-output', stringify, {}), presentation: { label: '整理结果', inputs: { value: '待处理内容' } } },
      { ...node('equal-guard', stringify, { value: literal(false) }), when: { nodeId: 'parse-a', portId: 'value', pointer: '/a~1b/~0key/0', equals: false, match: true } },
      { ...node('unequal-guard', stringify, { value: literal(null) }), when: { nodeId: 'parse-b', portId: 'value', pointer: '', equals: null, match: false } },
      node('private-literal', parse, { text: literal('LITERAL_SECRET_NEVER_DISPLAY') }),
    ], links: [{ source: { nodeId: 'parse-a', portId: 'value' }, target: { nodeId: 'text-output', portId: 'value' } }],
  }, composites: [
    { id: 'bundle-a', label: '相同组合', nodeIds: ['parse-a', 'equal-guard'] },
    { id: 'bundle-b', label: '相同组合', nodeIds: ['parse-b', 'unequal-guard'] },
  ] } });
const document = definition.initial;
const snapshot = JSON.stringify({ definition, document });
const priorFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Connection descriptions forbid real IO'); };
const hosts: S2PluginHost[] = [];
try {
  assert.equal(s2ConnectionNodeLabel(definition, document, 'content-a'), '角色「设定」块（内容 1）');
  assert.equal(s2ConnectionNodeLabel(definition, document, 'content-b'), '角色「设定」块（内容 2）');
  assert.equal(s2ConnectionNodeLabel(definition, document, 'parse-a'), '重复步骤（步骤 1）');
  assert.equal(s2ConnectionNodeLabel(definition, document, 'parse-b'), '重复步骤（步骤 2）');
  assert.equal(s2ConnectionNodeLabel(definition, document, 'bundle-a'), '相同组合（组合 1）');
  assert.equal(s2ConnectionNodeLabel(definition, document, 'bundle-b'), '相同组合（组合 2）');
  assert.equal(s2ConnectionFieldLabel(definition, document, 'content-a', 'content'), '角色「设定」块（内容 1）「正文与说明」');
  assert.equal(s2ConnectionPortLabel(definition, document, { nodeId: 'parse-b', portId: 'value' }, 'outputs'), '重复步骤（步骤 2）「完整「解析」结果」');
  const descriptions = s2ConnectionDescriptions(definition, document);
  assert.deepEqual(descriptions.map(item => item.kind), ['association', 'data', 'field', 'condition', 'condition']);
  assert.equal(new Set(descriptions.map(item => item.id)).size, descriptions.length);
  const data = descriptions.find(item => item.kind === 'data')!;
  assert.equal(data.id, s2ExecutionLinkKey(document.execution!.links[0]));
  assert.equal(data.summary, '把重复步骤（步骤 1）「完整「解析」结果」交给整理结果（步骤 3）「待处理内容」。');
  assert.equal(data.sourceId, 'parse-a'); assert.equal(data.targetId, 'text-output');
  assert.equal(data.shortLabel, '交给待处理内容');
  assert.match(data.detail, /完整输出/); assert.match(data.detail, /连线本身不运行/);
  assert.deepEqual(JSON.parse(data.technical).source.type, { id: 'structured-data.value', version: 1 });
  assert.deepEqual(JSON.parse(data.technical).target.type, { id: 'structured-data.value', version: 1 });
  const field = descriptions.find(item => item.kind === 'field')!;
  assert.equal(field.id, JSON.stringify(['parse-a', 'text', document.execution!.nodes[0].bindings.text]));
  assert.match(field.summary, /正文与说明/); assert.match(field.summary, /重复步骤（步骤 1）/);
  assert.match(field.detail, /不是执行前置步骤/);
  assert.deepEqual(JSON.parse(field.technical).source.type, { id: 'core.text', version: 1 });
  const association = descriptions.find(item => item.kind === 'association')!;
  assert.equal(association.id, 'idea-link'); assert.match(association.summary, /内容 1.*内容 2/);
  assert.match(association.summary, /补充解释/); assert.match(association.detail, /不传递数据，也不控制运行顺序/);
  const conditions = descriptions.filter(item => item.kind === 'condition');
  assert.deepEqual(conditions.map(item => item.shortLabel), ['相等时运行', '不相等时运行']);
  assert.equal(conditions[0].id, JSON.stringify(['condition', 'equal-guard']));
  assert.equal(conditions[1].id, JSON.stringify(['condition', 'unequal-guard']));
  assert.match(conditions[0].summary, /指定位置/); assert.match(conditions[1].summary, /整体内容/);
  for (const description of conditions) {
    assert.match(description.detail, /不表示条件已满足/); assert.match(description.detail, /不作为普通输入材料/);
    assert.doesNotMatch(description.summary + description.detail, /第\d+项|false|null|通过了/);
    assert.ok(!Object.hasOwn(JSON.parse(description.technical), 'equals'));
  }
  assert.equal(JSON.parse(conditions[0].technical).pointer, '/a~1b/~0key/0', 'Escaped tokens remain exact technical paths, not guessed array indices');
  assert.doesNotMatch(JSON.stringify(descriptions), /BODY_SECRET|LITERAL_SECRET/);
  assert.equal(JSON.stringify({ definition, document }), snapshot, 'Display descriptions must not mutate documents');

  // Reject fabricated endpoints, including renamed ports that do not exist in the installed registry.
  assert.throws(() => s2ConnectionNodeLabel(definition, document, 'unknown'), /不存在/);
  assert.throws(() => s2ConnectionFieldLabel(definition, document, 'content-a', 'unknown'), /不存在/);
  assert.throws(() => s2ConnectionFieldLabel(definition, document, 'parse-a', 'content'), /不存在/);
  assert.throws(() => s2ConnectionPortLabel(definition, document, { nodeId: 'parse-a', portId: 'value' }, 'inputs'), /端口不存在/);
  assert.throws(() => s2ConnectionPortLabel(definition, document, { nodeId: 'bundle-a', portId: 'value' }, 'outputs'), /步骤不存在/);
  const invented = structuredClone(document); invented.execution!.nodes[0].presentation!.outputs!.fake = '看起来合法的名字';
  assert.throws(() => s2ConnectionPortLabel(definition, invented, { nodeId: 'parse-a', portId: 'fake' }, 'outputs'), /端口不存在/);
  const wrongVersion = structuredClone(document); wrongVersion.execution!.nodes[0].pluginVersion = '9.9.9';
  assert.throws(() => s2ConnectionPortLabel(definition, wrongVersion, { nodeId: 'parse-a', portId: 'value' }, 'outputs'));
  const ambiguous = structuredClone(document); ambiguous.composites![0].id = 'parse-a';
  assert.throws(() => s2ConnectionNodeLabel(definition, ambiguous, 'parse-a'), /不唯一/);
  const unknownType = structuredClone(document); unknownType.nodes[0].type = 'unknown';
  assert.throws(() => s2ConnectionNodeLabel(definition, unknownType, 'content-a'), /类型不存在/);

  // Body getters are sentinels, not supported document input: they prove the display path never reads values.
  const hidden = structuredClone(document);
  const unread = { get() { throw new Error('Body access forbidden'); }, enumerable: true };
  for (const content of hidden.nodes) Object.defineProperty(content, 'values', unread);
  for (const step of hidden.execution!.nodes) {
    for (const binding of Object.values(step.bindings)) if (binding.kind === 'literal') Object.defineProperty(binding, 'value', unread);
    if (step.when) Object.defineProperty(step.when, 'equals', unread);
  }
  const hiddenDefinition = { ...definition } as S2CanvasDefinition;
  Object.defineProperty(hiddenDefinition, 'initial', unread);
  Object.defineProperty(hiddenDefinition, 'instructions', unread);
  assert.deepEqual(s2ConnectionDescriptions(hiddenDefinition, hidden), descriptions);
  const editedCompare = structuredClone(document); editedCompare.execution!.nodes[3].when!.equals = 'COMPARE_SECRET_NEVER_DISPLAY';
  assert.deepEqual(s2ConnectionDescriptions(definition, editedCompare), descriptions, 'Comparison values are not part of connection explanations');

  // Ordinary display does not consume a call, create an artifact, invoke an adapter or alter execution.
  const host = new S2PluginHost('readable-connection-test', definition); hosts.push(host); host.setDocument(readS2Document(document, definition));
  const calls = host.remainingCalls;
  for (let i = 0; i < 10; i++) assert.deepEqual(s2ConnectionDescriptions(definition, document), descriptions);
  assert.equal(host.remainingCalls, calls); assert.equal(host.history().length, 0); assert.equal(host.workflowHistory().length, 0);
  const run = await host.enqueueWorkflow(['text-output']).completion;
  assert.equal(run.status, 'succeeded'); assert.equal(host.remainingCalls, calls - 2);
  const outputNode = run.nodes.find(item => item.nodeId === 'text-output')!;
  const output = host.currentArtifact(outputNode.artifactIds[0]);
  assert.equal(output.payload.kind, 'inline');
  if (output.payload.kind === 'inline') assert.deepEqual(JSON.parse(String(output.payload.value)), sourceValue);
  const beforeDisplay = { calls: host.remainingCalls, history: host.history(), runs: host.workflowHistory() };
  assert.deepEqual(s2ConnectionDescriptions(definition, document), descriptions, 'An execution does not turn design descriptions into result claims');
  assert.deepEqual({ calls: host.remainingCalls, history: host.history(), runs: host.workflowHistory() }, beforeDisplay);
  const equalRun = await host.enqueueWorkflow(['equal-guard']).completion;
  assert.equal(equalRun.nodes.find(item => item.nodeId === 'equal-guard')!.status, 'succeeded', 'false retains strict native comparison semantics');
  const notEqualRun = await host.enqueueWorkflow(['unequal-guard']).completion;
  assert.equal(notEqualRun.nodes.find(item => item.nodeId === 'unequal-guard')!.status, 'skipped', 'null retains strict native comparison semantics');
  assert.equal(network, 0);
  assert.equal(JSON.stringify({ definition, document }), snapshot);
  console.log('S2 connection descriptions passed: four distinct meanings, exact named endpoints, whole-document ordinals, no values/IO/mutation/calls, unchanged real Host execution.');
} finally {
  hosts.forEach(host => host.close()); globalThis.fetch = priorFetch;
}
