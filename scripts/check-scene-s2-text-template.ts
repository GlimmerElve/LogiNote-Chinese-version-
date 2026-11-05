// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LlmCallResponse } from '../src/types';
import type { S2CanvasDefinition, S2Document, S2WorkflowNode } from '../src/types/sceneS2';
import type { S2Artifact, S2ExecutionLink, S2Json, S2PluginInvocation } from '../src/types/sceneS2Plugin';
import { S2_TEXT_TEMPLATE_PLUGIN, renderS2TextTemplate, bindS2TextTemplateVariable, executeS2TextTemplate } from '../src/interaction-packs/prompt-lab/textTemplate';
import { applyS2Commands, createS2Scene, designS2Canvas, exportS2Workspace, importS2Workspace, exportS2Subgraph, importS2Subgraph,
  interactS2Canvas, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { s2BuiltinPluginRegistry, s2ComposableCapabilities, readS2PluginBindings } from '../src/services/scene/sceneS2PluginRegistry';
import { s2TableToRecords, type S2Table } from '../src/services/scene/sceneS2Structured';
import { selectS2Execution } from '../src/services/scene/sceneS2Workflow';
import { s2DesignFixtureResponse } from './fixtures/s2-design-model';
import { S2ArtifactView } from '../src/components/scene/S2ArtifactView';

const previousFetch = globalThis.fetch;
let networkAttempts = 0;
globalThis.fetch = async () => { networkAttempts++; throw new Error('Text-template regression forbids network, real models, notes and profiles'); };
const hosts: S2PluginHost[] = [];
try {
  // Pure, literal interpolation. A variable value is data, never a second template,
  // regular-expression replacement string, expression, HTML component or tool result.
  assert.equal(renderS2TextTemplate('你好，{{name}}！{{ name }}', { name: '甲' }), '你好，甲！甲');
  assert.equal(renderS2TextTemplate('{{\tname\t}}/{{Name}}', { name: '甲', Name: '乙' }), '甲/乙');
  assert.equal(renderS2TextTemplate('', {}), '');
  assert.equal(renderS2TextTemplate('{{empty}}', { empty: '' }), '');
  assert.equal(renderS2TextTemplate('无占位的常量{}', {}), '无占位的常量{}');
  assert.equal(renderS2TextTemplate('{{name}}', { name: '甲', sharedUnused: '可供其他模板使用' }), '甲', 'Reusable dictionaries may contain unused valid string variables');
  const literal = '$& $1 \\ {{other}} <script>globalThis.textTemplateRan=true</script>';
  assert.equal(renderS2TextTemplate('{{name}}', { name: literal, other: '不能递归替换' }), literal);
  assert.equal((globalThis as Record<string, unknown>).textTemplateRan, undefined);
  assert.equal(renderS2TextTemplate('{"name":"{{name}}"}', { name: '甲' }), '{"name":"甲"}', 'Single JSON braces are ordinary literal text');
  assert.equal(renderS2TextTemplate('{"score":{{score}}}', { score: '80' }), '{"score":80}', 'A JSON closing brace after a placeholder remains literal, not a forbidden triple-brace expression');
  assert.equal(renderS2TextTemplate('{{A0_}}', { A0_: 'ASCII identifier' }), 'ASCII identifier');
  const longestKey = 'A'.repeat(64);
  assert.equal(renderS2TextTemplate(`{{${longestKey}}}`, { [longestKey]: '合法' }), '合法');
  const thirtyTwo = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`v${i}`, String(i)]));
  assert.equal(renderS2TextTemplate('{{v0}}/{{v31}}', thirtyTwo), '0/31');
  assert.throws(() => renderS2TextTemplate('constant', { ...thirtyTwo, v32: '33rd' }));
  assert.equal(renderS2TextTemplate('x'.repeat(6000), {}), 'x'.repeat(6000));
  assert.equal(renderS2TextTemplate('{{value}}', { value: '值'.repeat(6000) }), '值'.repeat(6000));
  assert.equal(renderS2TextTemplate('{{value}}{{value}}', { value: 'x'.repeat(3000) }).length, 6000);
  assert.throws(() => renderS2TextTemplate('x'.repeat(6001), {}));
  assert.throws(() => renderS2TextTemplate('{{value}}', { value: 'x'.repeat(6001) }));
  assert.throws(() => renderS2TextTemplate('{{value}}{{value}}', { value: 'x'.repeat(3001) }), 'Complete output cannot be truncated to fit');
  for (const invalid of [null, false, 1, 'text', [], { name: 1 }, { name: null }, { name: false }, { name: {} }, { name: [] }])
    assert.throws(() => renderS2TextTemplate('{{name}}', invalid as S2Json));
  for (const invalid of ['', '_name', '1name', 'name-part', 'a.b', '名字', 'a'.repeat(65), 'constructor', 'prototype', '__proto__']) {
    const variables = Object.fromEntries([[invalid, '不能接受']]);
    assert.throws(() => renderS2TextTemplate('constant', variables), `Every dictionary key is validated, even unused: ${invalid}`);
    assert.throws(() => bindS2TextTemplateVariable(invalid, '不能接受'));
  }
  for (const malformed of ['{{missing}}', '{{toString}}', '{{}}', '{{ name', 'name }}', '{{name}', '{name}}', '{{{{name}}',
    '{{name}}}}', '{{name {{other}}}}', '{{ name.part }}', '{{name[0]}}', '{{name || fallback}}', '{{globalThis.textTemplateRan=true}}'])
    assert.throws(() => renderS2TextTemplate(malformed, { name: '甲', other: '乙' }), `Malformed/missing/expression placeholder: ${malformed}`);
  assert.throws(() => renderS2TextTemplate('{{name}}', Object.create({ name: '继承值不能冒充 own 变量' })));
  const nullPrototype = Object.assign(Object.create(null), { name: '自有字符串' });
  assert.equal(renderS2TextTemplate('{{name}}', nullPrototype), '自有字符串');
  let accessorReads = 0;
  const accessor = Object.defineProperty({}, 'name', { enumerable: true, get() { accessorReads++; return '禁止执行getter'; } });
  assert.throws(() => renderS2TextTemplate('{{name}}', accessor)); assert.equal(accessorReads, 0);
  assert.throws(() => renderS2TextTemplate('constant', Object.defineProperty({}, 'name', { value: 'hidden', enumerable: false })));
  assert.throws(() => renderS2TextTemplate('constant', { [Symbol('hidden')]: 'not JSON' }));

  const dictionary = { role: '助教' }, beforeDictionary = JSON.stringify(dictionary);
  assert.deepEqual(bindS2TextTemplateVariable('task', '讲解JSON', dictionary), { role: '助教', task: '讲解JSON' });
  assert.equal(JSON.stringify(dictionary), beforeDictionary, 'Bind returns a new dictionary rather than modifying caller input');
  const bound = bindS2TextTemplateVariable('task', '', dictionary); bound.role = '修改返回副本';
  assert.equal(dictionary.role, '助教');
  assert.deepEqual(bindS2TextTemplateVariable('name', ''), { name: '' });
  assert.throws(() => bindS2TextTemplateVariable('role', '新角色', dictionary), 'Existing own keys cannot be implicitly overwritten');
  assert.throws(() => bindS2TextTemplateVariable('next', '33rd', thirtyTwo));
  assert.throws(() => bindS2TextTemplateVariable('name', 'x'.repeat(6001)));
  assert.throws(() => bindS2TextTemplateVariable('name', 1 as unknown as string));
  for (const invalid of [null, false, 1, 'text', [], { existing: 1 }])
    assert.throws(() => bindS2TextTemplateVariable('name', '甲', invalid as S2Json));

  const registry = s2BuiltinPluginRegistry(), cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
  const renderCap = cap('render', 'text-template'), bindCap = cap('bind', 'text-template');
  assert.equal(S2_TEXT_TEMPLATE_PLUGIN.id, 'text-template'); assert.equal(S2_TEXT_TEMPLATE_PLUGIN.version, '1.0.0');
  for (const binding of [renderCap, bindCap]) {
    const capability = registry.capability(binding);
    assert.equal(capability.effect, 'pure'); assert.deepEqual(capability.permissions, []);
    assert.ok(s2ComposableCapabilities().some(item => item.pluginId === binding.pluginId && item.capabilityId === binding.capabilityId));
  }
  assert.deepEqual(registry.capability(renderCap).inputs.map(port => [port.id, port.type.id]), [['template', 'core.text'], ['variables', 'structured-data.value']]);
  assert.deepEqual(registry.capability(renderCap).outputs.map(port => [port.id, port.type.id]), [['text', 'core.text']]);
  assert.deepEqual(registry.capability(bindCap).outputs.map(port => [port.id, port.type.id]), [['variables', 'structured-data.value']]);
  assert.equal(registry.capability(bindCap).inputs.find(port => port.id === 'variables').required, false);
  assert.throws(() => readS2PluginBindings([{ ...renderCap, pluginVersion: '1.0.1' }]));
  assert.throws(() => readS2PluginBindings(s2ComposableCapabilities().map(({ pluginId, pluginVersion, capabilityId }) => ({ pluginId, pluginVersion, capabilityId }))), /16/,
    'Expanding the installation catalogue does not expand the sixteen-capability per-scene boundary');

  const invocation = (binding = renderCap): S2PluginInvocation => ({ protocolVersion: 1, id: 'SyntheticTemplateInvocation', sceneId: 'SyntheticTemplateScene',
    runId: 'SyntheticTemplateRun', revision: 1, nodeId: 'render', ...binding, idempotencyKey: 'SyntheticTemplateKey', inputs: {} });
  const literalOutcome = await executeS2TextTemplate(invocation(), { template: ['not-json {{name}}'], variables: [{ name: '甲' }] });
  const firstBind = await executeS2TextTemplate(invocation(bindCap), { key: ['first'], value: ['原文'], variables: [] });
  assert.equal(firstBind.status, 'succeeded', 'Real host unpacks an absent optional port as an empty array');
  for (const badOptional of [null, [undefined], [{}, {}]]) {
    const rejected = await executeS2TextTemplate(invocation(bindCap), { key: ['first'], value: ['原文'], variables: badOptional as unknown as S2Json[] });
    assert.equal(rejected.status, 'failed', 'Malformed optional input is not the omitted optional input');
  }
  assert.equal(literalOutcome.status, 'succeeded');
  const literalOutput = (literalOutcome.outputs as Record<string, S2Artifact[]>).text[0];
  assert.equal(literalOutput.type.id, 'core.text'); assert.equal(literalOutput.source.kind, 'plugin');
  assert.equal(literalOutput.payload.kind, 'inline');
  if (literalOutput.payload.kind !== 'inline') assert.fail('Complete text output must be inline');
  const literalText = literalOutput.payload.value as string;
  assert.equal(literalText, 'not-json 甲');
  assert.throws(() => JSON.parse(literalText), 'Successful rendering is not successful JSON validation');
  const displayedText = structuredClone(literalOutput);
  displayedText.payload = { kind: 'inline', value: '第一行\n<script>alert(1)</script> $& {{literal}}' };
  const textMarkup = renderToStaticMarkup(React.createElement(S2ArtifactView, { artifact: displayedText, presentation: 'raw' }));
  assert.ok(textMarkup.includes('aria-label="原始文本产物"'));
  assert.ok(textMarkup.includes('第一行\n&lt;script&gt;alert(1)&lt;/script&gt; $&amp; {{literal}}'));
  assert.ok(!textMarkup.includes('<script>') && !textMarkup.includes('第一行\\n'), 'Text view keeps real newlines and React escaping, not JSON quotes or executable markup');
  const invalidOutcome = await executeS2TextTemplate(invocation(), { template: ['{{missing}}'], variables: [{}] });
  assert.equal(invalidOutcome.status, 'failed'); assert.equal(Object.values(invalidOutcome.outputs).flat().length, 0);
  const hugeOutcome = await executeS2TextTemplate(invocation(), { template: ['{{name}}{{name}}'], variables: [{ name: 'x'.repeat(3001) }] });
  assert.equal(hugeOutcome.status, 'failed'); assert.equal(Object.values(hugeOutcome.outputs).flat().length, 0, 'No partial truncated output artifact');
  const largeDictionary = { a: 'x'.repeat(6000), b: 'y'.repeat(6000), c: 'z'.repeat(6000) };
  assert.equal(Object.keys(bindS2TextTemplateVariable('d', 'w'.repeat(6000), largeDictionary)).length, 4, 'Pure function permits individually bounded values');
  const payloadOverflow = await executeS2TextTemplate(invocation(bindCap), { key: ['d'], value: ['w'.repeat(6000)], variables: [largeDictionary] });
  assert.equal(payloadOverflow.status, 'failed'); assert.equal(Object.values(payloadOverflow.outputs).flat().length, 0, 'Adapter still enforces the complete 24k structured artifact bound');

  const node = (id: string, binding: ReturnType<typeof cap>, bindings: S2WorkflowNode['bindings'] = {}): S2WorkflowNode => ({ id, ...binding, bindings, position: { x: 50, y: 50 } });
  const link = (source: string, output: string, target: string, input: string): S2ExecutionLink => ({ source: { nodeId: source, portId: output }, target: { nodeId: target, portId: input } });
  const plugins = [renderCap, bindCap, cap('parse-json'), cap('to-table'), cap('validate', 'json-check'), cap('table', 'structured-view'), cap('json-tree', 'structured-view')];
  const request = { source: 'custom' as const, subject: '合成本地文本拼装：不调用测试LLM', knowledgePoints: [], sceneSkill: 'S2' as const };
  const scene = createS2Scene(request);
  const document: S2Document = { nodes: [
    { id: 'template', type: 'text', position: { x: 0, y: 0 }, values: { content: '[{"name":"{{name}}","score":{{score}}}]' } },
    { id: 'variables', type: 'text', position: { x: 0, y: 180 }, values: { content: '{"score":"80","sharedUnused":"保留共享变量"}' } },
    { id: 'name', type: 'text', position: { x: 0, y: 360 }, values: { content: '合成甲' } },
  ], edges: [], execution: { version: 1, nodes: [
    node('parseVariables', cap('parse-json'), { text: { kind: 'field', nodeId: 'variables', fieldId: 'content' } }),
    node('bindName', bindCap, { key: { kind: 'literal', value: 'name' }, value: { kind: 'field', nodeId: 'name', fieldId: 'content' } }),
    node('render', renderCap, { template: { kind: 'field', nodeId: 'template', fieldId: 'content' } }),
    node('check', cap('validate', 'json-check')), node('parseOutput', cap('parse-json')), node('table', cap('to-table')),
    node('view', cap('table', 'structured-view')), node('tree', cap('json-tree', 'structured-view')),
  ], links: [link('parseVariables', 'value', 'bindName', 'variables'), link('bindName', 'variables', 'render', 'variables'),
    link('render', 'text', 'check', 'text'), link('render', 'text', 'parseOutput', 'text'), link('parseOutput', 'value', 'table', 'value'),
    link('table', 'table', 'view', 'table'), link('parseOutput', 'value', 'tree', 'value')] } };
  const definition = readS2Definition({ ...scene.canvasWorkspace, plugins, initial: document });
  scene.canvasWorkspace = definition;
  const createHost = (id: string, installed = plugins) => { const host = new S2PluginHost(id, installed); hosts.push(host); host.setDocument(document); return host; };
  const host = createHost(scene.sceneId), originalDocument = JSON.stringify(document);
  const first = await host.enqueueWorkflow(['view', 'tree', 'check']).completion;
  assert.equal(first.status, 'succeeded'); assert.equal(host.history().length, 6); assert.equal(host.remainingCalls, 58);
  const output = (run: typeof first, id: string) => host.currentArtifact(run.nodes.find(item => item.nodeId === id).artifactIds[0]);
  const rendered = output(first, 'render');
  assert.equal(rendered.type.id, 'core.text'); assert.equal((rendered.payload as any).value, '[{"name":"合成甲","score":80}]');
  assert.equal(rendered.source.kind, 'plugin'); assert.equal(rendered.source.nodeId, 'render');
  assert.equal((output(first, 'check').payload as any).value.status, 'pass');
  assert.equal(first.nodes.find(item => item.nodeId === 'view').status, 'displayed');
  assert.equal(first.nodes.find(item => item.nodeId === 'tree').status, 'displayed');
  assert.deepEqual(s2TableToRecords((output(first, 'view').payload as any).value as S2Table), [{ name: '合成甲', score: 80 }]);
  assert.equal(JSON.stringify(document), originalDocument, 'Local rendering never overwrites user fields');
  assert.ok(!host.history().some(item => item.request.pluginId === 'model' || item.request.capabilityId.includes('llm')));
  const afterFirst = host.remainingCalls;
  const second = await host.enqueueWorkflow(['view', 'tree', 'check']).completion;
  assert.equal(second.status, 'succeeded'); assert.equal(host.remainingCalls, afterFirst); assert.equal(host.history().length, 6);
  assert.equal(second.nodes.filter(item => item.status === 'cached').length, 6, 'Pure binds/render and downstream transforms reuse exact complete inputs');
  const moved = structuredClone(document); moved.nodes[0].position.x += 100; moved.execution.nodes[0].position.y += 100;
  host.setDocument(moved); assert.equal(host.currentArtifact(rendered.id).id, rendered.id);
  assert.equal(host.history()[0].receipt.publication, 'current', 'Presentation changes do not invalidate text artifacts');
  const changed = applyS2Commands(definition, moved, [{ op: 'update-node', id: 'name', values: { content: '合成乙' } }]);
  host.setDocument(changed);
  assert.throws(() => host.currentArtifact(rendered.id), /当前修订|过期|修订/);
  assert.equal(host.history()[0].receipt.publication, 'stale');
  const updated = await host.enqueueWorkflow(['view']).completion;
  assert.equal(updated.status, 'succeeded');
  assert.deepEqual(s2TableToRecords((output(updated, 'view').payload as any).value as S2Table), [{ name: '合成乙', score: 80 }]);
  assert.notEqual((output(updated, 'render').payload as any).value, (rendered.payload as any).value, 'Changed field input cannot reuse an old rendered string');

  const plain = applyS2Commands(definition, document, [{ op: 'update-node', id: 'template', values: { content: 'not-json {{name}}' } }]);
  const plainHost = createHost('SyntheticPlainText'); plainHost.setDocument(plain);
  const plainRun = await plainHost.enqueueWorkflow(['check', 'view']).completion;
  assert.equal(plainRun.status, 'failed');
  assert.equal(plainRun.nodes.find(item => item.nodeId === 'render').status, 'succeeded');
  assert.equal(plainRun.nodes.find(item => item.nodeId === 'check').status, 'succeeded', 'JSON checker execution may succeed while its content assessment fails');
  const checked = plainHost.currentArtifact(plainRun.nodes.find(item => item.nodeId === 'check').artifactIds[0]);
  assert.equal((checked.payload as any).value.status, 'fail');
  assert.equal(plainRun.nodes.find(item => item.nodeId === 'parseOutput').status, 'failed');
  assert.equal(plainRun.nodes.find(item => item.nodeId === 'view').status, 'blocked');
  const missing = applyS2Commands(definition, document, [{ op: 'update-node', id: 'template', values: { content: '{{missing}}' } }]);
  const failedHost = createHost('SyntheticMissingVariable'); failedHost.setDocument(missing);
  const failed = await failedHost.enqueueWorkflow(['view']).completion;
  assert.equal(failed.status, 'failed'); assert.equal(failed.nodes.find(item => item.nodeId === 'render').status, 'failed');
  assert.deepEqual(failed.nodes.find(item => item.nodeId === 'render').artifactIds, []);
  assert.equal(failedHost.history().find(item => item.request.nodeId === 'render').artifacts.length, 0);
  assert.throws(() => selectS2Execution(document, plugins.filter(item => item.pluginId !== 'text-template'), ['view']), /未装配|授权/);
  const deniedHost = createHost('SyntheticDeniedTemplate', plugins.filter(item => item.pluginId !== 'text-template'));
  assert.throws(() => deniedHost.enqueueWorkflow(['view']), /未装配|授权/); assert.equal(deniedHost.remainingCalls, 64);
  assert.throws(() => readS2Definition({ ...definition, initial: { ...document, execution: { ...document.execution,
    links: document.execution.links.map(item => item.target.nodeId === 'table' ? link('render', 'text', 'table', 'value') : item) } } }), /类型/);
  assert.throws(() => readS2Definition({ ...definition, initial: { ...document, execution: { ...document.execution,
    nodes: document.execution.nodes.map(item => item.id === 'render' ? { ...item, bindings: { ...item.bindings, variables: { kind: 'field', nodeId: 'variables', fieldId: 'content' } } } : item) } } }), /类型/);

  // Multiple independent text blocks can build the dictionary without an Agent
  // synthesizing hidden JSON. Each bind is explicit and returns a new artifact.
  const roles = ['role', 'task', 'constraint'], texts = ['助教', '解释JSON类型', '不访问外部服务'];
  const bindDocument: S2Document = { nodes: roles.map((id, index) => ({ id, type: 'text', position: { x: 0, y: index * 150 }, values: { content: texts[index] } })), edges: [],
    execution: { version: 1, nodes: [
      ...roles.map(id => node(`bind_${id}`, bindCap, { key: { kind: 'literal', value: id }, value: { kind: 'field', nodeId: id, fieldId: 'content' } })),
      node('compose', renderCap, { template: { kind: 'literal', value: '角色：{{role}}；任务：{{task}}；约束：{{constraint}}' } }),
    ], links: [link('bind_role', 'variables', 'bind_task', 'variables'), link('bind_task', 'variables', 'bind_constraint', 'variables'), link('bind_constraint', 'variables', 'compose', 'variables')] } };
  const bindHost = createHost('SyntheticMultiBlock'); bindHost.setDocument(readS2Definition({ ...definition, initial: bindDocument }).initial);
  const composed = await bindHost.enqueueWorkflow(['compose']).completion;
  assert.equal(composed.status, 'succeeded', JSON.stringify(composed)); assert.equal(bindHost.history().length, 4);
  const finalText = bindHost.currentArtifact(composed.nodes.find(item => item.nodeId === 'compose').artifactIds[0]);
  assert.equal((finalText.payload as any).value, '角色：助教；任务：解释JSON类型；约束：不访问外部服务');
  assert.equal((bindHost.currentArtifact(composed.nodes.find(item => item.nodeId === 'bind_role').artifactIds[0]).payload as any).value.task, undefined,
    'Later bind nodes do not mutate upstream dictionary artifacts');

  assert.deepEqual(importS2Workspace(exportS2Workspace(definition, document)), definition);
  const fragment = exportS2Subgraph(definition, document, ['render', 'bindName', 'parseVariables']);
  const imported = importS2Subgraph(fragment, definition, document);
  assert.equal(imported.nodeIds.length, 6, 'Subgraph carries the three explicit text-field dependencies as well as execution nodes');
  assert.equal(document.execution.nodes.length, 8, 'Subgraph import does not mutate the original canvas');

  const businessDefinition: S2CanvasDefinition = readS2Definition({ ...definition, business: { version: 1,
    purpose: '本地绑定文本变量、渲染文本，再显式解析与展示；不是测试LLM调用',
    knowledge: [{ id: 'TextBoundary', title: '文本拼装边界', content: '渲染只产生文本；JSON语法需单独检查或解析，业务含义需单独标准，不能当作模型返回。' }],
    workflow: [{ id: 'LocalCompose', goal: '仅在本地拼装与展示', actor: 'tool', capabilities: plugins, input: '用户模板、字典与姓名原文', output: '渲染文本和显式解析后的展示' }],
    completion: { mode: 'execution', reference: structuredClone(document), targetNodeIds: ['view', 'tree', 'check'],
      coverage: [{ requirementId: 'r1', stepIds: ['LocalCompose'], nodeIds: document.execution.nodes.map(item => item.id) }] },
    criteria: [{ id: 'TemplatePresent', label: '模板保留', expectation: '模板字段保留指定姓名占位', method: 'local', required: true,
      target: { nodeId: 'template', fieldId: 'content' }, rule: { kind: 'text-includes', value: '{{name}}' } }],
  } }, { requireBusiness: true });
  const businessScene = { ...scene, canvasWorkspace: businessDefinition };
  const designStages: string[] = [];
  const built = await designS2Canvas(businessScene, { disclosure: 'complete', invoke: async request => { designStages.push(JSON.parse(request.userInput).stage); return s2DesignFixtureResponse(request, businessDefinition); } });
  assert.deepEqual(designStages, ['understand', 'assemble']);
  assert.ok(built.plugins.some(item => item.pluginId === 'text-template' && item.capabilityId === 'render'));
  const controllerHost = createHost(scene.sceneId);
  const context = controllerHost.prepare(null, { goal: built.goal, ...built.instructions }, '只解释或申请本地运行');
  const respond = (value: unknown): LlmCallResponse => ({ content: JSON.stringify(value) });
  for (const execute of [false, true]) {
    const stages: string[] = [], beforeRuns = controllerHost.workflowHistory().length;
    const reply = await interactS2Canvas(businessScene, document, execute ? '申请运行本地拼装展示，等待确认' : '解释文本拼装边界，不运行', null, [], { pluginContext: context,
      invoke: async request => {
        const input = JSON.parse(request.userInput); stages.push(input.stage);
        if (input.stage === 'turn-understand') return respond({ understanding: '合成协议意图，不证明语义识别', desiredOutcome: '按显式合成模式检查本地请求',
          actions: ['reply', ...(execute ? ['execute'] : [])], constraints: [], questions: [], evaluation: 'advice', skillIds: ['TextBoundary'] });
        assert.equal(input.stage, 'turn-act'); assert.deepEqual(input.businessSkill.knowledge.map((item: { id: string }) => item.id), ['TextBoundary']);
        assert.equal(input.businessSkill.completion.reference, undefined); assert.equal(input.businessSkill.criteria[0].rule, undefined);
        return respond({ understanding: '合成理解', plan: '不自动调用', reply: '这里只拼装文本，不代表JSON已验证或测试模型已响应。', commands: [],
          ...(execute ? { executionRequest: { targetNodeIds: ['view'], reason: '仅本地拼装与展示，等待独立确认' } } : {}) });
      } });
    assert.deepEqual(stages, ['turn-understand', 'turn-act']); assert.deepEqual(reply.commands, []);
    assert.equal(!!reply.executionRequest, execute); assert.equal(controllerHost.workflowHistory().length, beforeRuns, 'Agent request never runs local tools without confirmation');
  }
  assert.equal(networkAttempts, 0);
  console.log('S2 text-template passed: bounded literal render and reusable string dictionaries, explicit immutable multi-block bind, malformed/missing/expression/oversize rejection without partial output, real typed parse→bind→render→check/parse/table/tree DAG, exact-input pure cache, layout/current vs semantic/stale separation, no unauthorized or implicit text→JSON use, portable templates/subgraphs, and synthetic goal-led builder/interaction with selected skill loading. Local text only: not an LLM experiment, JSON/business verdict, browser or real-model acceptance.');
} finally { hosts.forEach(host => host.close()); globalThis.fetch = previousFetch; }
