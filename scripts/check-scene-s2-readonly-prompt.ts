import assert from 'node:assert/strict';
import type { S2CanvasDefinition } from '../src/types/sceneS2';
import { readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { inspectS2PromptControls, inspectS2PromptTemplate, applyS2PromptParts } from '../src/interaction-packs/prompt-lab/promptControls';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';

const render = { pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'render' };
const sourceText = '固定说明\n{{task}}';
const make = (readOnly?: boolean): S2CanvasDefinition => readS2Definition({
  version: 1, goal: '合成只读绑定模板验收',
  instructions: { understanding: '保留原文', planning: '仅按需编辑或运行', response: '区分本地执行和业务判断' },
  blockTypes: [{ id: 'text', label: '通用内容', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] }],
  plugins: [render], initial: { nodes: [{ id: 'template', type: 'text', position: { x: 0, y: 0 }, values: { content: sourceText },
    ...(readOnly === undefined ? {} : { readOnly }) }], edges: [], execution: { version: 1, nodes: [{ id: 'layout', ...render,
      position: { x: 360, y: 0 }, bindings: { template: { kind: 'field', nodeId: 'template', fieldId: 'content' },
        variables: { kind: 'literal', value: { task: '原任务' } } } }], links: [] } },
});
const parts = [{ kind: 'text', text: '固定说明\n' }, { kind: 'material', material: 'task' }, { kind: 'text', text: '\n补充' }];
const oldFetch = globalThis.fetch;
let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Readonly prompt acceptance is local only'); };
const hosts: S2PluginHost[] = [];
try {
  for (const flag of [undefined, false] as const) {
    const definition = make(flag), document = structuredClone(definition.initial), original = JSON.stringify({ definition, document });
    const state = inspectS2PromptTemplate(definition, document, 'layout');
    assert.equal(state.kind, 'template');
    if (state.kind !== 'template') throw new Error('Editable field-backed template unavailable');
    const next = applyS2PromptParts(definition, document, 'layout', parts, state.base);
    assert.equal(next.nodes[0].values.content, `${sourceText}\n补充`);
    assert.equal(next.nodes[0].readOnly, flag);
    assert.deepEqual(next.execution, document.execution);
    assert.equal(JSON.stringify({ definition, document }), original, 'Applying a draft never mutates its input snapshots');
  }

  const definition = make(true), document = structuredClone(definition.initial), original = JSON.stringify({ definition, document });
  for (const inspect of [inspectS2PromptControls, inspectS2PromptTemplate]) {
    const state = inspect(definition, document, 'layout');
    assert.equal(state.kind, 'unavailable');
    if (state.kind !== 'unavailable') throw new Error('Readonly field-backed template offered an editing mode');
    assert.equal(state.recovery.code, 'template-readonly');
    assert.deepEqual(state.recovery.targets, [{ kind: 'content', nodeId: 'template', fieldId: 'content' }]);
    assert.match(state.reason, /只读/);
    assert.match(state.recovery.guidance, /继续引用、组装和运行/);
    assert.throws(() => applyS2PromptParts(definition, document, 'layout', parts, state.base), /只读/);
  }
  const forged = structuredClone(document); forged.nodes[0].readOnly = false;
  assert.throws(() => applyS2PromptParts(definition, forged, 'layout', parts, inspectS2PromptTemplate(definition, forged, 'layout').base), /只读/);
  assert.equal(JSON.stringify({ definition, document }), original);

  // Only the referenced content instance is fixed. A local literal template remains editable.
  const literal = structuredClone(document);
  literal.execution!.nodes[0].bindings.template = { kind: 'literal', value: sourceText };
  const literalState = inspectS2PromptTemplate(definition, literal, 'layout');
  assert.equal(literalState.kind, 'template');
  const literalNext = applyS2PromptParts(definition, literal, 'layout', parts, literalState.base);
  assert.equal(literalNext.nodes[0].values.content, sourceText);
  assert.deepEqual(literalNext.execution!.nodes[0].bindings.template, { kind: 'literal', value: `${sourceText}\n补充` });

  const host = new S2PluginHost('readonly-prompt-synthetic', definition); hosts.push(host); host.setDocument(document);
  const run = await host.enqueueWorkflow(['layout']).completion;
  assert.equal(run.status, 'succeeded');
  const output = host.currentArtifact(run.nodes.find(node => node.nodeId === 'layout')!.artifactIds[0]);
  assert.deepEqual(output.payload, { kind: 'inline', value: '固定说明\n原任务' });
  assert.deepEqual(document, definition.initial);
  assert.equal(network, 0);
  console.log('S2 readonly prompt passed: readonly field-backed template inspection and direct apply reject, authored lock survives forged current flag, explicit false/legacy editable behavior preserved, literal template independent, fixed original remains usable by real local Host render. Synthetic offline only.');
} finally { hosts.forEach(host => host.close()); globalThis.fetch = oldFetch; }
