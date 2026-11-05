import assert from 'node:assert/strict';
import type { SceneInteractionPackDefinition, ScenePackAuthoringCatalog } from '../src/types/sceneInteractionPack';
import type { S2BlockType, S2CanvasDefinition, S2Document } from '../src/types/sceneS2';
import type { S2PluginManifest } from '../src/types/sceneS2Plugin';
import { readSceneInteractionPack } from '../src/services/scene/sceneInteractionPackProtocol';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { applyS2Commands, createS2Scene, designS2Canvas, exportS2Workspace, importS2WorkspaceWithPack, readS2Definition, readS2Document } from '../src/services/scene/sceneS2Canvas';
import { assertS2PublicEdit, compileS2PublicCanvas, projectS2PublicCanvas, type S2PublicCanvas } from '../src/services/scene/sceneS2PublicAuthoring';
import { prepareS2PublicDefinition } from '../src/services/scene/sceneS2PublicSession';
import { mutateS2Batch } from '../src/services/scene/sceneS2Layout';
import { createUndoHistory, moveUndoHistory, recordUndoHistory } from '../src/services/ui/undoHistory';
import { withS2DesignContext } from './fixtures/s2-design-context';

// Exercise production parsers, persistence, edit guards and model adapters.
// Agent replies and model capacity are synthetic; no user resource APIs exist here.
const priorFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Authoring checks prohibit network or actual model calls');
const markers = ['PRIVATE_FIXED_VALUE', 'PRIVATE_INTERNAL_TEXT', 'PRIVATE_INTERNAL_RUNTIME', 'PRIVATE_PACKAGE_GUIDE'];
const nativeType: S2BlockType = { id: 'sharedText', label: '共享文本实现', fields: [{ id: 'content', label: '正文', kind: 'multiline' }] };
const otherType: S2BlockType = { id: 'otherText', label: '其它文本实现', fields: [{ id: 'content', label: '正文', kind: 'multiline' }] };
const plugin: S2PluginManifest = { protocolVersion: 1, id: 'authoring-fixes-tools', version: '1.0.0', label: '内部执行实现', meaning: 'PRIVATE_PACKAGE_GUIDE',
  dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [{ id: 'authoring-fixes-tools.count', version: 1, meaning: '本次次数', schema: { kind: 'number', integer: true, minimum: 0, maximum: 9 } }],
  capabilities: [{ id: 'execute', kind: 'transform', meaning: 'PRIVATE_PACKAGE_GUIDE', effect: 'pure', permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000,
    inputs: [
      { id: 'text', label: '原文', meaning: '原样提供输入', type: { id: 'core.text', version: 1 }, required: true, multiple: false },
      { id: 'amount', label: '次数', meaning: '零至九的整数', type: { id: 'authoring-fixes-tools.count', version: 1 }, required: false, multiple: false },
      { id: 'countInput', label: '连接的次数', meaning: '只通过连线接收零至九的整数', type: { id: 'authoring-fixes-tools.count', version: 1 }, required: false, multiple: false },
      { id: 'secret', label: '内部配置', meaning: 'PRIVATE_PACKAGE_GUIDE', type: { id: 'core.text', version: 1 }, required: false, multiple: false },
    ], outputs: [{ id: 'text', label: '返回原文', meaning: '完整输入文字', type: { id: 'core.text', version: 1 }, required: true, multiple: false }] }],
};
const capability = { pluginId: plugin.id, pluginVersion: plugin.version, capabilityId: 'execute' };
const component = (id: string, label: string, blockType = nativeType): ScenePackAuthoringCatalog['components'][number] => ({
  id, label, purpose: '承载本实例的原文', implementation: { kind: 'content', blockType }, inputs: [], outputs: ['content'], parameters: ['content'], defaults: { content: '' },
});
const processor = (id: string, label: string): ScenePackAuthoringCatalog['components'][number] => ({
  id, label, purpose: '按可编辑次数处理所连原文', implementation: { kind: 'capability', ...capability },
  inputs: ['text', 'countInput'], outputs: ['text'], parameters: ['amount'], defaults: { amount: 0, secret: 'PRIVATE_FIXED_VALUE' },
});
const definition: SceneInteractionPackDefinition = { manifest: { protocolVersion: 1, id: 'authoring-fixes-pack', version: '1.0.0', name: '独立公开搭建回归', paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] },
  capabilities: [plugin], authoring: { version: 1, components: [component('note', '普通内容'), component('material', '待测资料'),
    processor('processorA', '第一处理'), processor('processorB', '第二处理'), component('other', '其它内容', otherType)],
    internal: { blockTypes: [nativeType], document: { nodes: [{ id: 'InternalText', type: nativeType.id, position: { x: -600, y: -400 }, values: { content: 'PRIVATE_INTERNAL_TEXT' } }], edges: [],
      execution: { version: 1, nodes: [{ id: 'InternalRuntime', ...capability, position: { x: -200, y: -400 }, bindings: { text: { kind: 'literal', value: 'PRIVATE_INTERNAL_RUNTIME' }, secret: { kind: 'literal', value: 'PRIVATE_FIXED_VALUE' } } }], links: [] } } } },
  validate: () => [], createRuntime: () => assert.fail('Authoring must not create a runtime'), executeLocal: async () => assert.fail('Authoring must not execute a component'),
};
const pack = readSceneInteractionPack(definition); installSceneInteractionCapabilities(pack); sceneInteractionPacks.register(pack);
const reference = { id: pack.manifest.id, version: pack.manifest.version };
const policy: S2CanvasDefinition['instructions'] = { understanding: '理解公开原文', planning: '按需搭建', response: '只报告真实情况' };
const current = compileS2PublicCanvas(pack, { version: 1, nodes: [], connections: [] }, { goal: '按目标构建两条独立文字处理链', instructions: policy }).definition;
const chosen = ['note', 'material', 'processorA', 'processorB'];
const canvas = (): S2PublicCanvas => ({ version: 1, nodes: [
  { id: 'Note', componentId: 'note', label: '我的同名组件', position: { x: 40, y: 60 }, values: { content: '第一份原文 $& {{literal}}' } },
  { id: 'Material', componentId: 'material', label: '我的同名组件', position: { x: 40, y: 350 }, values: { content: '第二份原文\n保持完整' } },
  { id: 'ProcessorA', componentId: 'processorA', label: '我的同名组件', position: { x: 390, y: 60 }, values: { amount: 3 } },
  { id: 'ProcessorB', componentId: 'processorB', label: '我的同名组件', position: { x: 390, y: 350 }, values: { amount: 5 } },
], connections: [
  { source: { nodeId: 'Note', portId: 'content' }, target: { nodeId: 'ProcessorA', portId: 'text' } },
  { source: { nodeId: 'Material', portId: 'content' }, target: { nodeId: 'ProcessorB', portId: 'text' } },
] });
const publicOnly = (value: unknown) => { const text = JSON.stringify(value); for (const marker of markers) assert(!text.includes(marker), `Internal data leaked: ${marker}`); };
const normalized = (value: S2PublicCanvas) => ({ ...value, nodes: [...value.nodes].sort((a, b) => a.id.localeCompare(b.id)), connections: [...value.connections].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });

try {
  // Logical IDs survive arbitrary labels in two native aliases and two aliases
  // of the same execution capability; labels are never identity witnesses.
  const logical = canvas();
  const compiled = compileS2PublicCanvas(pack, logical, { goal: current.goal, instructions: policy });
  assert.deepEqual(normalized(projectS2PublicCanvas(pack, compiled.definition, compiled.document)), normalized(logical));
  const saved = readS2Definition(JSON.parse(JSON.stringify(compiled.definition)));
  assert.deepEqual(normalized(projectS2PublicCanvas(pack, saved, saved.initial)), normalized(logical));
  const imported = importS2WorkspaceWithPack(exportS2Workspace(compiled.definition, compiled.document, reference));
  assert.deepEqual(imported.interactionPack, reference);
  assert.deepEqual(normalized(projectS2PublicCanvas(pack, imported.definition, imported.definition.initial)), normalized(logical));
  const copied = readS2Document(mutateS2Batch(compiled.document, { kind: 'copy', nodeIds: logical.nodes.map(node => node.id), delta: { x: 800, y: 0 } }), compiled.definition);
  assertS2PublicEdit(pack, compiled, { definition: compiled.definition, document: copied });
  const copies = projectS2PublicCanvas(pack, compiled.definition, copied).nodes.filter(node => !logical.nodes.some(original => original.id === node.id));
  assert.equal(copies.length, logical.nodes.length);
  assert.deepEqual(copies.map(node => node.componentId).sort(), chosen.slice().sort());
  let history = createUndoHistory(compiled.document);
  history = recordUndoHistory(history, copied);
  history = moveUndoHistory(history, 'undo');
  assert.deepEqual(normalized(projectS2PublicCanvas(pack, compiled.definition, history.present)), normalized(logical));
  history = moveUndoHistory(history, 'redo');
  assert.deepEqual(projectS2PublicCanvas(pack, compiled.definition, history.present).nodes.map(node => node.componentId).sort(), [...chosen, ...chosen].sort());

  const rejectMutation = (mutate: (document: S2Document) => void) => {
    const changed = structuredClone(compiled.document); mutate(changed);
    assert.throws(() => assertS2PublicEdit(pack, compiled, { definition: compiled.definition, document: changed }));
    assert.throws(() => projectS2PublicCanvas(pack, compiled.definition, changed));
  };
  rejectMutation(document => { document.nodes.find(node => node.id === 'Material')!.componentId = 'hidden'; });
  rejectMutation(document => { document.nodes.find(node => node.id === 'Material')!.componentId = 'other'; });
  rejectMutation(document => { document.execution!.nodes.find(node => node.id === 'ProcessorA')!.componentId = 'note'; });
  rejectMutation(document => { document.nodes.find(node => node.id === 'InternalText')!.componentId = 'note'; });
  rejectMutation(document => { document.nodes.find(node => node.id === 'InternalText')!.values.content = '篡改内部'; });
  assert.throws(() => applyS2Commands(compiled.definition, compiled.document, [{ op: 'batch-nodes', action: { kind: 'copy', nodeIds: ['InternalText'] } }], compiled.definition.initial, reference));

  const legacy = structuredClone(compiled.document);
  for (const node of [...legacy.nodes, ...legacy.execution!.nodes]) delete node.componentId;
  legacy.nodes.find(node => node.id === 'Note')!.label = '普通内容';
  legacy.nodes.find(node => node.id === 'Material')!.label = '待测资料';
  legacy.execution!.nodes.find(node => node.id === 'ProcessorA')!.presentation!.label = '第一处理';
  legacy.execution!.nodes.find(node => node.id === 'ProcessorB')!.presentation!.label = '第二处理';
  assert.deepEqual(projectS2PublicCanvas(pack, compiled.definition, legacy).nodes.map(node => node.componentId).sort(), chosen.slice().sort());
  legacy.nodes.find(node => node.id === 'Material')!.readOnly = true;
  const legacyDefinition = readS2Definition({ ...compiled.definition, initial: legacy });
  const preparedLegacy = prepareS2PublicDefinition(pack, legacyDefinition);
  assert.equal(preparedLegacy.initial.nodes.find(node => node.id === 'Material')!.componentId, 'material');
  assert.equal(preparedLegacy.initial.nodes.find(node => node.id === 'Material')!.readOnly, true);
  assert.equal(legacyDefinition.initial.nodes.find(node => node.id === 'Material')!.componentId, undefined, 'Migration never mutates the source definition');
  assert.deepEqual(preparedLegacy.initial.execution!.nodes.find(node => node.id === 'InternalRuntime'), legacy.execution!.nodes.find(node => node.id === 'InternalRuntime'));
  const ambiguous = structuredClone(legacy); ambiguous.nodes.find(node => node.id === 'Material')!.label = '无唯一身份';
  assert.throws(() => projectS2PublicCanvas(pack, compiled.definition, ambiguous), /歧义|唯一|ambiguous/i);
  const uniqueCanvas: S2PublicCanvas = { version: 1, nodes: [{ id: 'Other', componentId: 'other', label: '任意名字', position: { x: 0, y: 0 }, values: { content: '唯一实现' } }], connections: [] };
  const unique = compileS2PublicCanvas(pack, uniqueCanvas, { goal: current.goal });
  delete unique.document.nodes.find(node => node.id === 'Other')!.componentId;
  assert.equal(projectS2PublicCanvas(pack, unique.definition, unique.document).nodes[0].componentId, 'other');

  await withS2DesignContext(131072, async () => {
    const scene = createS2Scene({ source: 'build', sceneSkill: 'S2', subject: '独立公开搭建', knowledgePoints: [], interactionPack: reference });
    scene.canvasWorkspace = structuredClone(current); scene.task = current.goal;
    const original = JSON.stringify(scene);
    let normalCompose: { system: string; input: Record<string, unknown> } | undefined;
    for (const mode of ['default', 'disabled', 'enabled', 'reject-once', 'reject-always', 'abort', 'budget'] as const) {
      const phases: string[] = []; let reviews = 0, compositions = 0;
      const controller = new AbortController();
      const work = () => designS2Canvas(scene, { ...(mode === 'default' ? {} : { review: mode !== 'disabled' }), signal: controller.signal,
        invoke: async request => {
          const input = JSON.parse(request.userInput); publicOnly(input); publicOnly(request.systemPromptOverride);
          phases.push(input.authoringPhase);
          if (input.authoringPhase === 'select') return { content: JSON.stringify({ componentIds: mode === 'budget' ? chosen.filter(id => id !== 'processorB') : chosen }), diagnostics: { finishReason: 'stop' } };
          if (input.authoringPhase === 'review') {
            reviews++; if (mode === 'abort') controller.abort();
            return { content: JSON.stringify({ approved: !['reject-always', 'budget'].includes(mode) && !(mode === 'reject-once' && reviews === 1), feedback: '保持两条原文链及对应布局' }), diagnostics: { finishReason: 'stop' } };
          }
          compositions++;
          if (mode === 'default') normalCompose = { system: request.systemPromptOverride!, input: structuredClone(input) };
          if (mode === 'budget' && compositions === 1) return { content: JSON.stringify({ read: { componentIds: ['processorB'] } }), diagnostics: { finishReason: 'stop' } };
          return { content: JSON.stringify({ canvas: canvas() }), diagnostics: { finishReason: 'stop' } };
        } });
      if (['reject-always', 'abort', 'budget'].includes(mode)) await assert.rejects(work, /审查|停止|abort|上限/i);
      else {
        const result = await work();
        assert.deepEqual(normalized(projectS2PublicCanvas(pack, result, result.initial)), normalized(canvas()));
      }
      assert.equal(JSON.stringify(scene), original, 'No design/review branch mutates the input scene');
      assert(phases.length <= (mode === 'default' || mode === 'disabled' ? 4 : 6));
      if (mode === 'default' || mode === 'disabled') assert.deepEqual(phases, ['select', 'compose']);
      if (mode === 'enabled') assert.deepEqual(phases, ['select', 'compose', 'review']);
      if (mode === 'reject-once' || mode === 'reject-always') assert.deepEqual(phases, ['select', 'compose', 'review', 'compose', 'review']);
      if (mode === 'budget') assert.equal(phases.length, 6);
    }

    for (const kind of ['numeric', 'unknown-parameter', 'wrong-port', 'second-failure'] as const) {
      const phases: string[] = []; let compositions = 0;
      const work = () => designS2Canvas(scene, { invoke: async request => {
        const input = JSON.parse(request.userInput); publicOnly(input); publicOnly(request.systemPromptOverride);
        phases.push(input.authoringPhase);
        if (input.authoringPhase === 'select') {
          assert(!Object.hasOwn(input, 'repair'));
          return { content: JSON.stringify({ componentIds: chosen }), diagnostics: { finishReason: 'stop' } };
        }
        compositions++;
        if (compositions === 1) {
          assert.deepEqual({ system: request.systemPromptOverride, input }, normalCompose, 'Normal requests gain no repair payload or system instructions');
          const bad = canvas();
          if (kind === 'unknown-parameter') bad.nodes[2].values!.hiddenControl = 'not-public';
          else if (kind === 'wrong-port') bad.connections[0].target.portId = 'ghost';
          else bad.nodes[2].values!.amount = 'not-a-number';
          return { content: JSON.stringify({ canvas: bad }), diagnostics: { finishReason: 'stop' } };
        }
        assert(input.repair && input.repair.issue && input.repair.candidate, 'An independent repair request receives a concrete issue and the full public candidate');
        assert(!Object.hasOwn(input, 'feedback'), 'The same failure is not repeated as generic feedback');
        assert.equal(typeof input.repair.issue.code, 'string');
        assert.equal(typeof input.repair.issue.reason, 'string');
        assert(input.repair.issue.reason.length > 0 && input.repair.issue.reason.length <= 240);
        const candidate = input.repair.candidate.canvas as S2PublicCanvas;
        assert.deepEqual(candidate.nodes.map(node => [node.id, node.componentId, node.label, node.position]), canvas().nodes.map(node => [node.id, node.componentId, node.label, node.position]));
        assert.deepEqual(candidate.nodes.slice(0, 2).map(node => node.values), canvas().nodes.slice(0, 2).map(node => node.values), 'Both original texts survive the failed design and repair round');
        assert.deepEqual(candidate.nodes[3].values, canvas().nodes[3].values);
        const fixed = structuredClone(candidate);
        if (kind === 'wrong-port') {
          assert(input.repair.issue.path.startsWith('/canvas/connections/0'));
          assert.deepEqual(candidate.connections.slice(1), canvas().connections.slice(1));
          fixed.connections[0].target.portId = 'text';
        } else {
          assert(input.repair.issue.path.startsWith('/canvas/nodes/2/values'));
          assert.deepEqual(candidate.connections, canvas().connections);
          if (kind === 'unknown-parameter') {
            assert(input.repair.issue.path.includes('hiddenControl'));
            assert(!Object.hasOwn(candidate.nodes[2].values!, 'hiddenControl'), 'Unpublished parameter values are not reflected into the repair candidate');
          } else {
            assert.equal(input.repair.issue.path, '/canvas/nodes/2/values/amount');
            assert.equal(candidate.nodes[2].values!.amount, 'not-a-number');
            if (kind !== 'second-failure') fixed.nodes[2].values!.amount = 3;
          }
        }
        return { content: JSON.stringify({ canvas: fixed }), diagnostics: { finishReason: 'stop' } };
      } });
      if (kind === 'second-failure') await assert.rejects(work);
      else {
        const result = await work();
        assert.deepEqual(normalized(projectS2PublicCanvas(pack, result, result.initial)), normalized(canvas()));
      }
      assert.deepEqual(phases, ['select', 'compose', 'compose']);
      assert.equal(JSON.stringify(scene), original, 'A second failure never commits any partial scene');
    }

    // Each endpoint below is real and public. These cases distinguish semantic
    // type mismatch, multiple execution sources at a single input, and cycles
    // from unknown-port or literal/field-binding conflicts.
    const extraProcessor = (id: string, componentId: string, y: number): S2PublicCanvas['nodes'][number] => ({
      id, componentId, label: '新增公开处理', position: { x: 740, y }, values: { amount: 2 },
    });
    const wire = (source: string, target: string): S2PublicCanvas['connections'][number] => ({
      source: { nodeId: source, portId: 'text' }, target: { nodeId: target, portId: 'text' },
    });
    for (const code of ['PUBLIC_CONNECTION_TYPE', 'PUBLIC_CONNECTION_CARDINALITY', 'PUBLIC_CONNECTION_CYCLE'] as const) {
      const bad = canvas();
      if (code === 'PUBLIC_CONNECTION_TYPE') bad.connections.push({ source: { nodeId: 'Note', portId: 'content' }, target: { nodeId: 'ProcessorA', portId: 'countInput' } });
      else if (code === 'PUBLIC_CONNECTION_CARDINALITY') {
        bad.nodes.push(extraProcessor('ProcessorC', 'processorA', 60));
        bad.connections.push(wire('ProcessorA', 'ProcessorC'), wire('ProcessorB', 'ProcessorC'));
      } else {
        bad.nodes.push(extraProcessor('ProcessorC', 'processorA', 60), extraProcessor('ProcessorD', 'processorB', 350));
        bad.connections.push(wire('ProcessorC', 'ProcessorD'), wire('ProcessorD', 'ProcessorC'));
      }
      assert.throws(() => compileS2PublicCanvas(pack, bad, { goal: current.goal }), error => !!error && typeof error === 'object' && 'code' in error && error.code === code,
        `${code}: the public compiler must identify the actual connection error, not an incidental native/field conflict`);
      const expected = structuredClone(bad); expected.connections.pop();
      const phases: string[] = []; let compositions = 0;
      const result = await designS2Canvas(scene, { invoke: async request => {
        const input = JSON.parse(request.userInput); publicOnly(input); publicOnly(request.systemPromptOverride);
        phases.push(input.authoringPhase);
        if (input.authoringPhase === 'select') return { content: JSON.stringify({ componentIds: chosen }), diagnostics: { finishReason: 'stop' } };
        compositions++;
        if (compositions === 1) {
          assert.deepEqual({ system: request.systemPromptOverride, input }, normalCompose);
          return { content: JSON.stringify({ canvas: bad }), diagnostics: { finishReason: 'stop' } };
        }
        assert.equal(input.repair.issue.code, code);
        assert.equal(input.repair.issue.path, `/canvas/connections/${bad.connections.length - 1}`);
        assert.equal(typeof input.repair.issue.reason, 'string');
        assert(input.repair.issue.reason.length > 0 && input.repair.issue.reason.length <= 240);
        assert.deepEqual(input.repair.candidate.canvas, bad, 'The entire proposed public graph is available without dropping correct neighboring edges');
        const corrected = structuredClone(input.repair.candidate.canvas) as S2PublicCanvas;
        // Repair only the edge identified by the public issue. All original
        // texts, aliases, positions, values and neighboring connections remain.
        corrected.connections.splice(Number(input.repair.issue.path.split('/').at(-1)), 1);
        return { content: JSON.stringify({ canvas: corrected }), diagnostics: { finishReason: 'stop' } };
      } });
      assert.deepEqual(normalized(projectS2PublicCanvas(pack, result, result.initial)), normalized(expected));
      assert.deepEqual(phases, ['select', 'compose', 'compose']);
      assert.equal(JSON.stringify(scene), original);
    }
  });
  console.log('S2 authoring fixes passed: stable native/execution public identities through labels, persistence, copy and history; explicit invalid/private identities denied; bounded legacy inference; actual adapter optional review and bounded atomic failure; targeted public repair with complete candidate/text/layout/connections, no internal data and unchanged normal context. Offline only.');
} finally { globalThis.fetch = priorFetch; }
