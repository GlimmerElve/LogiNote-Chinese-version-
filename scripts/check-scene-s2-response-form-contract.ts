import assert from 'node:assert/strict';
import type { S2CanvasDefinition, S2Field } from '../src/types/sceneS2';
import type { S2PluginCapability } from '../src/types/sceneS2Plugin';
import { readS2Definition, readS2Document, exportS2Workspace, importS2Workspace, exportS2Subgraph, importS2Subgraph } from '../src/services/scene/sceneS2Canvas';
import { readS2NodePresentation } from '../src/services/scene/sceneS2Presentation';
import { s2BuiltinPluginRegistry } from '../src/services/scene/sceneS2PluginRegistry';
import { s2ParameterFormDraft, submitS2ParameterForm } from '../src/services/scene/sceneS2ParameterForm';
import { S2_WORKFLOW_AGENT_RULES, s2SemanticDocument, selectS2Execution } from '../src/services/scene/sceneS2Workflow';

const previousFetch = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Response form contract checks are offline'); };
try {
  const human = { pluginId: 'human-input', pluginVersion: '1.0.0', capabilityId: 'json' };
  const stringify = { pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'stringify' };
  const form: S2Field = { id: 'value', label: '练习要求', kind: 'form', fields: [
    { id: 'role', label: '角色设定', kind: 'multiline', required: true },
    { id: 'count', label: '题目数量', kind: 'number', min: 0, max: 20, integer: true },
    { id: 'examples', label: '给出例子', kind: 'boolean' },
    { id: 'difficulty', label: '难度', kind: 'enum', options: ['基础', '进阶'] },
  ] };
  const definition: S2CanvasDefinition = readS2Definition({ version: 1, goal: '用户填写场景语言的回答，提交原生 JSON 给下游。',
    instructions: { understanding: '先理解用户表达。', planning: '按需提出建议。', response: '不伪造用户回答。' },
    blockTypes: [{ id: 'note', label: '笔记', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
    plugins: [human, stringify], initial: { nodes: [], edges: [], execution: { version: 1, nodes: [
      { id: 'answer', ...human, position: { x: 0, y: 0 }, bindings: { prompt: { kind: 'literal', value: '请填写本轮练习要求。' } },
        presentation: { label: '填写练习要求', responseForm: form } },
      { id: 'text', ...stringify, position: { x: 300, y: 0 }, bindings: {} },
    ], links: [{ source: { nodeId: 'answer', portId: 'value' }, target: { nodeId: 'text', portId: 'value' } }] } } });
  const cap = s2BuiltinPluginRegistry().capability(human);
  assert.deepEqual(readS2NodePresentation({ label: '填写练习要求', responseForm: form }, cap, human).responseForm, form);
  assert.deepEqual(importS2Workspace(exportS2Workspace(definition, definition.initial)), definition);
  const pasted = importS2Subgraph(exportS2Subgraph(definition, definition.initial, ['answer', 'text']), definition, definition.initial);
  const copiedHuman = pasted.document.execution!.nodes.find(node => node.id !== 'answer' && node.pluginId === 'human-input')!;
  assert.deepEqual(copiedHuman.presentation!.responseForm, form);
  assert.ok(pasted.document.execution!.links.some(link => link.source.nodeId === copiedHuman.id && link.source.portId === 'value' && link.target.nodeId !== 'text'));
  assert.deepEqual(selectS2Execution(definition.initial, definition.plugins, ['text']).graph.nodes.map(node => node.id), ['answer', 'text']);

  // The same typed capability shape is insufficient without the exact installed identity.
  for (const identity of [undefined, { ...human, pluginId: 'custom-human' }, { ...human, pluginVersion: '2.0.0' },
    { ...human, capabilityId: 'text' }, { ...human, capabilityId: 'confirm' }]) {
    assert.throws(() => readS2NodePresentation({ label: '不能扩权', responseForm: form }, cap, identity), /回答表单仅支持/);
  }
  const wrongCaps: S2PluginCapability[] = [
    { ...cap, id: 'confirm' }, { ...cap, kind: 'transform' }, { ...cap, outputs: [] },
    ...[{ required: false }, { multiple: true }, { id: 'other' }, { type: { id: 'core.text', version: 1 } },
      { type: { id: 'structured-data.value', version: 2 } }].map(patch => ({ ...cap, outputs: cap.outputs.map(port => ({ ...port, ...patch })) })),
  ];
  for (const wrong of wrongCaps) assert.throws(() => readS2NodePresentation({ label: '不伪装输出', responseForm: form }, wrong, human), /回答表单仅支持/);
  for (const capabilityId of ['text', 'confirm']) {
    const other = structuredClone(definition); other.plugins![0].capabilityId = capabilityId;
    other.initial.execution!.nodes[0].capabilityId = capabilityId; other.initial.execution!.links = [];
    assert.throws(() => readS2Definition(other), /回答表单仅支持/);
  }
  for (const responseForm of [
    { ...form, id: 'context' }, { ...form, onSubmit: 'run()' }, { ...form, permissions: ['model-call'] },
    { ...form, fields: [{ id: 'role', label: '角色', kind: 'html' }] },
    { ...form, fields: Array.from({ length: 9 }, (_, i) => ({ id: `f${i}`, label: '过多字段', kind: 'text' })) },
    { id: 'value', label: '超限', kind: 'list', maxItems: 33, item: { id: 'item', label: '项', kind: 'text' } },
  ]) assert.throws(() => readS2NodePresentation({ label: '错误声明', responseForm }, cap, human));
  let getterReads = 0;
  const nested = structuredClone(form);
  Object.defineProperty(nested.fields![0], 'defaultValue', { enumerable: true, get() { getterReads++; return '不能读取'; } });
  assert.throws(() => readS2NodePresentation({ label: '拒绝执行访问器', responseForm: nested }, cap, human));
  const outer = { label: '拒绝顶层访问器' };
  Object.defineProperty(outer, 'responseForm', { enumerable: true, get() { getterReads++; return form; } });
  assert.throws(() => readS2NodePresentation(outer, cap, human)); assert.equal(getterReads, 0);
  const sparse: any[] = Array(1); Object.defineProperty(sparse, 'extra', { value: '伪装', enumerable: true });
  assert.throws(() => readS2NodePresentation({ label: '稀疏选项', responseForm: { id: 'value', label: '选项', kind: 'enum', options: sparse } }, cap, human));
  const reserved = JSON.parse('{"id":"value","label":"保留字段","kind":"text","__proto__":{}}');
  assert.throws(() => readS2NodePresentation({ label: '拒绝保留键', responseForm: reserved }, cap, human));

  const changed = structuredClone(definition.initial);
  changed.execution!.nodes[0].presentation!.responseForm!.fields![1].max = 10;
  changed.execution!.nodes[0].presentation!.responseForm!.label = '新的显示名称';
  assert.deepEqual(s2SemanticDocument(changed), s2SemanticDocument(definition.initial), 'Form UI is not an execution/schema permission change');
  const withoutForm = structuredClone(definition.initial); delete withoutForm.execution!.nodes[0].presentation!.responseForm;
  assert.deepEqual(s2SemanticDocument(withoutForm), s2SemanticDocument(definition.initial));
  assert.deepEqual(readS2Document(changed, definition), changed);
  const response = { role: '  你是老师。\n保留 {{literal}}  ', count: 0, examples: false, difficulty: '进阶' };
  assert.deepEqual(submitS2ParameterForm(form, s2ParameterFormDraft(form, response)), response);
  assert.throws(() => s2ParameterFormDraft(form, { ...response, extra: null }), /完整表达/, 'Switching into form mode cannot erase unknown valid JSON fields');
  assert.ok(S2_WORKFLOW_AGENT_RULES.includes('responseForm'));
  assert.ok(S2_WORKFLOW_AGENT_RULES.includes('不是工具输入或授权'));
  assert.equal(network, 0);
  console.log('S2 response-form contract passed: exact human/json identity and real output, strict declarative bounds/descriptors, native values and lossless switch guard, workspace/subgraph roundtrip, unchanged execution semantics and permission boundary. Synthetic offline only; no model/browser/runtime result claim.');
} finally { globalThis.fetch = previousFetch; }
