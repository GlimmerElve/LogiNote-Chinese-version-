import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createS2Scene, readS2Definition, applyS2Commands, importS2Workspace } from '../src/services/scene/sceneS2Canvas';
import { s2MaterialInput, planS2MaterialInput } from '../src/services/scene/sceneS2Materials';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { s2ParameterSource } from '../src/services/scene/sceneS2ControlDrafts';
import { harness } from './scene-s2-ui-harness';

const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const previous = globalThis.fetch; let network = 0;
globalThis.fetch = async () => { network++; throw new Error('Synthetic local materials only'); };
try {
  assert.equal(importS2Workspace(readFileSync('scripts/fixtures/s2-materials-workspace.json', 'utf8')).initial.execution!.nodes.length, 6);
  const definition = readS2Definition({ version: 1, goal: '合成多路材料与文字参数验收',
    instructions: { understanding: '理解用户需求', planning: '只提出必要操作', response: '按真实结果说明' },
    blockTypes: [{ id: 'note', label: '说明块', fields: [{ id: 'content', label: '说明文字', kind: 'multiline' }] }],
    plugins: [cap('parse-json'), cap('stringify'), cap('merge-json', 'workflow-merge'), cap('text', 'human-input')],
    initial: { nodes: [{ id: 'note', type: 'note', position: { x: 0, y: 0 }, values: { content: '材料示例' } }], edges: [], execution: { version: 1, links: [], nodes: [
      { id: 'guard', ...cap('parse-json'), position: { x: 300, y: 0 }, bindings: { text: { kind: 'literal', value: '{"choose":"left"}' } } },
      ...['left', 'right'].map((id, index) => ({ id, ...cap('parse-json'), position: { x: 650, y: index * 250 }, bindings: { text: { kind: 'literal', value: JSON.stringify({ result: id, zero: 0, enabled: false, nullable: null }) } },
        when: { nodeId: 'guard', portId: 'value', pointer: '/choose', equals: 'left', match: id === 'left' }, presentation: { label: index ? '方案乙' : '方案甲' } })),
      { id: 'merge', ...cap('merge-json', 'workflow-merge'), position: { x: 1000, y: 0 }, bindings: { candidates: { kind: 'literal', value: { fixed: 'keep' } } }, presentation: { label: '选择本次方案', inputs: { candidates: '候选方案' } } },
      { id: 'text', ...cap('stringify'), position: { x: 0, y: 250 }, bindings: { value: { kind: 'literal', value: { example: true } } } },
      { id: 'ask', ...cap('text', 'human-input'), position: { x: 0, y: 500 }, bindings: { prompt: { kind: 'literal', value: '原来的问题' } } },
    ] } },
  });
  const doc = definition.initial, id = (nodeId: string) => JSON.stringify(['output', nodeId, 'value']);
  const input = s2MaterialInput(definition, doc, 'merge', 'candidates');
  assert.deepEqual(input.selected, ['fixed']); assert.equal(input.port.multiple, true);
  assert.ok(input.options.some(option => option.id === id('left')));
  assert.ok(!input.options.some(option => option.id.includes('text')), 'Text output must not enter structured candidates');
  const preserve = applyS2Commands(definition, doc, planS2MaterialInput(definition, doc, 'merge', 'candidates', ['fixed', id('left')], input.base));
  assert.deepEqual(preserve.execution!.nodes.find(node => node.id === 'merge')!.bindings.candidates, { kind: 'literal', value: { fixed: 'keep' } }, 'Adding a candidate never silently deletes the existing constant');
  for (const invalid of [[id('left'), id('left')], ['unknown'], Array(1), 'not-an-array', [JSON.stringify(['output', 'text', 'text'])]]) {
    assert.throws(() => planS2MaterialInput(definition, doc, 'merge', 'candidates', invalid, input.base), /材料/);
  }
  assert.throws(() => planS2MaterialInput(definition, preserve, 'merge', 'candidates', [], input.base), /来源已变化/);
  const moved = structuredClone(doc); moved.execution!.nodes[0].position.x += 10;
  assert.equal(s2MaterialInput(definition, moved, 'merge', 'candidates').base, input.base, 'Layout does not revoke a source choice');
  const changedProducer = structuredClone(doc); changedProducer.execution!.nodes[1].capabilityId = 'select';
  assert.notEqual(s2MaterialInput(definition, changedProducer, 'merge', 'candidates').base, input.base, 'Same endpoint ID with a different producer is stale');

  // Large valid inputs stay editable one source at a time without rebuilding retained links.
  // The graph limit remains 32 sources and the native atomic operation limit remains 12.
  for (const count of [7, 32]) {
    const sources = Array.from({ length: count + 1 }, (_, index) => ({ id: `source-${index}`, ...cap('parse-json'),
      position: { x: 0, y: index * 50 }, bindings: { text: { kind: 'literal', value: 'null' } } }));
    const wire = (nodeId: string) => ({ source: { nodeId, portId: 'value' }, target: { nodeId: 'merge', portId: 'candidates' } });
    const crowded = readS2Definition({ ...definition, initial: { nodes: [], edges: [], execution: { version: 1,
      nodes: [...sources, { id: 'merge', ...cap('merge-json', 'workflow-merge'), position: { x: 500, y: 0 }, bindings: {} }],
      links: sources.slice(0, count).map(source => wire(source.id)) } } });
    const original = crowded.initial, originalKey = JSON.stringify(original), current = s2MaterialInput(crowded, original, 'merge', 'candidates');
    const remove = planS2MaterialInput(crowded, original, 'merge', 'candidates', current.selected.slice(1), current.base);
    assert.deepEqual(remove, [{ op: 'disconnect-ports', link: wire('source-0') }], `${count} → ${count - 1} uses one atomic removal`);
    const reduced = applyS2Commands(crowded, original, remove);
    assert.deepEqual(reduced.execution!.links, original.execution!.links.slice(1));
    const reducedInput = s2MaterialInput(crowded, reduced, 'merge', 'candidates');
    const add = planS2MaterialInput(crowded, reduced, 'merge', 'candidates', [...reducedInput.selected, id(`source-${count}`)], reducedInput.base);
    assert.deepEqual(add, [{ op: 'connect-ports', link: wire(`source-${count}`) }], 'Adding one source does not touch retained wires');
    assert.equal(applyS2Commands(crowded, reduced, add).execution!.links.length, count);
    const swap = planS2MaterialInput(crowded, original, 'merge', 'candidates', [...current.selected.slice(1), id(`source-${count}`)], current.base);
    assert.deepEqual(swap, [{ op: 'disconnect-ports', link: wire('source-0') }, { op: 'connect-ports', link: wire(`source-${count}`) }]);
    assert.deepEqual(applyS2Commands(crowded, original, swap).execution!.links, [...original.execution!.links.slice(1), wire(`source-${count}`)]);
    assert.deepEqual(planS2MaterialInput(crowded, original, 'merge', 'candidates', [...current.selected].reverse(), current.base), [], 'Selection order does not recreate links');
    assert.equal(JSON.stringify(original), originalKey, 'Planning and application preserve the original graph');
    assert.throws(() => planS2MaterialInput(crowded, reduced, 'merge', 'candidates', [], current.base), /来源已变化/);
    if (count === 32) {
      assert.throws(() => planS2MaterialInput(crowded, original, 'merge', 'candidates', [...current.selected, id(`source-${count}`)], current.base), /数量/);
      const tooManyChanges = planS2MaterialInput(crowded, original, 'merge', 'candidates', [], current.base);
      assert.equal(tooManyChanges.length, 32);
      assert.throws(() => applyS2Commands(crowded, original, tooManyChanges), /12/, 'Large changes remain one rejected transaction, never split into partial commits');
      assert.equal(JSON.stringify(original), originalKey);
      const crowdedScene = createS2Scene({ source: 'custom', subject: '合成满额来源恢复', sceneSkill: 'S2', knowledgePoints: [] });
      crowdedScene.canvasWorkspace = crowded;
      const crowdedUi = harness({ initialDraft: crowdedScene });
      try {
        crowdedUi.labelControl('选择执行节点', 'select').props.onChange({ target: { value: 'merge' } }); crowdedUi.render();
        const first = crowdedUi.elements().find(element => element.type === 'input' && element.props.type === 'checkbox'
          && element.props['aria-label']?.includes('材料来源 · ') && element.props['aria-label'].includes('（步骤 1）'));
        assert.ok(first); assert.equal(first.props.checked, true);
        first.props.onChange({ target: { checked: false } }); crowdedUi.render();
        const after = crowdedUi.elements().find(element => element.type === 'run-summary')!.props.document;
        assert.deepEqual(after.execution.links, original.execution!.links.slice(1), 'Production checkbox can remove one source from a full 32-source input');
        assert.equal(crowdedUi.modelCalls(), 0); assert.equal(crowdedUi.saved.length, 0);
      } finally { crowdedUi.dispose(); }
    }
  }
  for (const value of [false, 0, null]) {
    const scalarRaw = structuredClone(definition);
    scalarRaw.initial.execution!.nodes.find(node => node.id === 'merge')!.bindings.candidates = { kind: 'literal', value };
    const scalar = readS2Definition(scalarRaw), scalarDoc = scalar.initial;
    const scalarInput = s2MaterialInput(scalar, scalarDoc, 'merge', 'candidates');
    const add = planS2MaterialInput(scalar, scalarDoc, 'merge', 'candidates', ['fixed', id('left')], scalarInput.base);
    assert.deepEqual(add.map(command => command.op), ['connect-ports'], 'Retaining false, zero or null emits no binding overwrite');
    const added = applyS2Commands(scalar, scalarDoc, add);
    assert.deepEqual(added.execution!.nodes.find(node => node.id === 'merge')!.bindings.candidates, { kind: 'literal', value });
    const addedInput = s2MaterialInput(scalar, added, 'merge', 'candidates');
    const removeOutput = planS2MaterialInput(scalar, added, 'merge', 'candidates', ['fixed'], addedInput.base);
    assert.deepEqual(removeOutput.map(command => command.op), ['disconnect-ports']);
    assert.deepEqual(applyS2Commands(scalar, added, removeOutput).execution!.nodes.find(node => node.id === 'merge')!.bindings.candidates, { kind: 'literal', value });
    const removeFixed = planS2MaterialInput(scalar, added, 'merge', 'candidates', [id('left')], addedInput.base);
    assert.deepEqual(removeFixed, [{ op: 'unbind-input', id: 'merge', portId: 'candidates' }]);
    assert.deepEqual(applyS2Commands(scalar, added, removeFixed).execution!.links, added.execution!.links);
  }

  const scene = createS2Scene({ source: 'custom', subject: '合成材料界面', sceneSkill: 'S2', knowledgePoints: [] }); scene.canvasWorkspace = definition;
  let host!: S2PluginHost;
  const ui = harness({ initialDraft: scene, onHost(value) { host = value; } });
  try {
    const checkbox = (part: string) => {
      const input = ui.elements().find(e => e.type === 'input' && e.props.type === 'checkbox' && e.props['aria-label']?.startsWith('候选方案的材料来源 · ') && e.props['aria-label'].includes(part));
      assert.ok(input, part); return input;
    };
    const focus = (value: string) => { ui.labelControl('选择执行节点', 'select').props.onChange({ target: { value } }); ui.render(); };
    const graph = () => ui.flow().props;
    const parameterState = () => {
      const event = host.prepare(null, { goal: definition.goal, ...definition.instructions }, '只读材料状态').interactions.controlStates
        .find(event => event.kind === 'parameter-control' && event.nodeId === 'merge' && event.portId === 'candidates');
      return event?.kind === 'parameter-control' ? event.state : undefined;
    };
    ui.button('开始试验').props.onClick(); ui.render(); focus('merge');
    assert.ok(ui.text().includes('多路同时命中会提示冲突'));
    assert.equal(checkbox('已填写的固定材料').props.checked, true);
    const stale = checkbox('方案乙').props.onChange;
    checkbox('方案甲').props.onChange({ target: { checked: true } }); ui.render();
    assert.deepEqual(graph().nodes.find((node: any) => node.id === 'merge').data.node.bindings.candidates, { kind: 'literal', value: { fixed: 'keep' } });
    assert.equal(parameterState(), 'committed', 'A retained literal plus a valid new wire is not an editor conflict');
    host.recordParameterControl('merge', 'candidates', s2ParameterSource(preserve, 'merge', 'candidates').key, 'submitted');
    assert.equal(parameterState(), 'conflict', 'Connecting a wire still blocks an editor submission, even with the current source');
    host.recordParameterControl('merge', 'candidates', s2ParameterSource(doc, 'merge', 'candidates').key, 'referenced');
    assert.equal(parameterState(), 'conflict', 'A stale source identity never reports a current reference');
    checkbox('已填写的固定材料').props.onChange({ target: { checked: false } }); ui.render();
    assert.equal(parameterState(), 'referenced', 'A valid output-only material selection is a reference');
    stale({ target: { checked: true } }); ui.render(); assert.equal(graph().edges.filter((edge: any) => edge.target === 'merge').length, 1);
    checkbox('方案乙').props.onChange({ target: { checked: true } }); ui.render();
    assert.equal(graph().edges.filter((edge: any) => edge.target === 'merge').length, 2);
    assert.equal(parameterState(), 'referenced', 'Multiple selected outputs remain a valid reference');
    assert.equal(host.history().length, 0); assert.equal(host.workflowHistory().length, 0); assert.equal(ui.modelCalls(), 0);
    ui.button('运行所选步骤').props.onClick();
    for (let i = 0; i < 15; i++) { await new Promise(resolve => setTimeout(resolve, 0)); ui.render(); }
    const run = host.workflowHistory().at(-1)!; assert.equal(run.status, 'succeeded');
    assert.equal(run.nodes.find(node => node.nodeId === 'right')!.status, 'skipped');
    const result = host.currentArtifact(run.nodes.find(node => node.nodeId === 'merge')!.artifactIds[0]);
    assert.equal(result.payload.kind, 'inline'); if (result.payload.kind === 'inline') assert.deepEqual(result.payload.value, { result: 'left', zero: 0, enabled: false, nullable: null });
    const calls = host.history().length;
    focus('ask');
    const textarea = ui.labelControl('填写提示内容', 'textarea'); const oldTextEdit = textarea.props.onChange;
    assert.equal(textarea.props['aria-label'], '填写提示内容'); assert.equal(textarea.props['aria-describedby'], 's2-material-note-ask-prompt');
    textarea.props.onChange({ target: { value: '  你希望先讨论什么？\n保留空白和 {{literal}}  ' } }); ui.render();
    assert.deepEqual(graph().nodes.find((node: any) => node.id === 'ask').data.node.bindings.prompt, { kind: 'literal', value: '  你希望先讨论什么？\n保留空白和 {{literal}}  ' });
    assert.equal(host.history().length, calls); assert.equal(host.workflowHistory().length, 1, 'Writing a question never opens a human wait or runs tools');
    ui.labelControl('为提示内容选择材料', 'select').props.onChange({ target: { value: JSON.stringify(['field', 'note', 'content']) } }); ui.render();
    oldTextEdit({ target: { value: '不能覆盖新的字段引用' } }); ui.render();
    assert.equal(graph().nodes.find((node: any) => node.id === 'ask').data.node.bindings.prompt.kind, 'field');
    ui.labelControl('为提示内容选择材料', 'select').props.onChange({ target: { value: 'manual' } }); ui.render();
    assert.equal(ui.labelControl('填写提示内容', 'textarea').props.value, '', 'Switching explicitly to manual never copies or guesses a source value');
    focus('merge'); const endedChoice = checkbox('方案乙').props.onChange;
    ui.button('结束试验').props.onClick(); ui.render(); endedChoice({ target: { checked: false } }); ui.render();
    assert.equal(checkbox('方案乙').props.disabled, true); assert.equal(graph().edges.filter((edge: any) => edge.target === 'merge').length, 2);
    assert.equal(ui.modelCalls(), 0);
  } finally { ui.dispose(); }
  assert.equal(network, 0);
  console.log('S2 materials passed: actual typed source catalogue, bounded single/multiple selection, differential 7/32-source edits and unchanged atomic limits, retained false/zero/null constants and wires, rejected sparse/duplicate/foreign sources, producer/source staleness vs layout, native production full-input checkbox/manual-text handlers, real exclusive-branch execution, exact native handoff, old/end callbacks and no implicit execution/model/network. Synthetic offline only.');
} finally { globalThis.fetch = previous; }
