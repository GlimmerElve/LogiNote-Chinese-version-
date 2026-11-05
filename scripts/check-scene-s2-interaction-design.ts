import assert from 'node:assert/strict';
import type { SceneInteractionPackDefinition } from '../src/types/sceneInteractionPack';
import type { S2CanvasDefinition } from '../src/types/sceneS2';
import type { S2InteractionConfig } from '../src/types/sceneS2Interaction';
import { readSceneInteractionPack } from '../src/services/scene/sceneInteractionPackProtocol';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { compileS2PublicCanvas, projectS2PublicCanvas, publicS2Catalog, type S2PublicCanvas } from '../src/services/scene/sceneS2PublicAuthoring';
import { buildS2PublicDesign, type S2PublicDesignOptions } from '../src/services/scene/sceneS2PublicDesign';
import { prepareS2PublicDefinition } from '../src/services/scene/sceneS2PublicSession';
import { readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { validateS2PublicInteraction } from '../src/services/scene/sceneS2InteractionEvents';
import { S2InteractionProtocolError } from '../src/services/scene/sceneS2InteractionProtocol';
import { createS2PublicRepair, S2PublicDesignValidationError } from '../src/services/scene/sceneS2PublicRepair';
import { projectS2AgentComponents } from '../src/services/scene/sceneS2AgentCatalog';

const previousFetch = globalThis.fetch;
globalThis.fetch = async () => assert.fail('Interaction design checks prohibit network, actual models and user material reads');
const raw: SceneInteractionPackDefinition = {
  manifest: { protocolVersion: 1, id: 'interaction-design-pack', version: '1.0.0', name: '通用自动交互搭建', paradigm: 'S2', paradigmApiVersion: 1, requiredServices: ['execution'] },
  interaction: { version: 1, events: [{ id: 'interaction-design-pack.note.changed', purpose: '公开文字块变化后按场景任务响应',
    dataSchema: { kind: 'object', fields: { text: { kind: 'string', maxLength: 100 } }, required: ['text'] } }] },
  capabilities: [{ protocolVersion: 1, id: 'interaction-design-tools', version: '1.0.0', label: 'PRIVATE_IMPLEMENTATION', meaning: 'PRIVATE_IMPLEMENTATION',
    dependencies: [{ id: 'core', version: '1.0.0' }], dataTypes: [], capabilities: [{ id: 'echo', kind: 'transform', meaning: 'PRIVATE_IMPLEMENTATION', effect: 'pure',
      permissions: [], confirmation: 'none', retry: 'manual-only', timeoutMs: 1000,
      inputs: [{ id: 'text', label: '文字', meaning: '保持原文', type: { id: 'core.text', version: 1 }, required: true, multiple: false }],
      outputs: [{ id: 'text', label: '输出', meaning: '完整文字', type: { id: 'core.text', version: 1 }, required: true, multiple: false }] }] }],
  authoring: { version: 1, components: [
    { id: 'note', label: '文字块', purpose: '编辑一份原文', implementation: { kind: 'content', blockType: { id: 'text', label: '文字', fields: [{ id: 'content', label: '内容', kind: 'multiline' }] } },
      parameters: ['content'], inputs: [], outputs: ['content'], defaults: { content: '' } },
    { id: 'worker', label: '执行块', purpose: '执行原文处理并返回结果', implementation: { kind: 'capability', pluginId: 'interaction-design-tools', pluginVersion: '1.0.0', capabilityId: 'echo' },
      parameters: [], inputs: ['text'], outputs: ['text'] },
  ], internal: { blockTypes: [], document: { nodes: [], edges: [], execution: { version: 1, nodes: [{ id: 'PrivateWorker', pluginId: 'interaction-design-tools',
    pluginVersion: '1.0.0', capabilityId: 'echo', position: { x: -500, y: 0 }, bindings: { text: { kind: 'literal', value: 'PRIVATE_FIXED_VALUE' } } }], links: [] } } } },
  validate: () => [], createRuntime: () => assert.fail('Building must not start a package runtime'), executeLocal: async () => assert.fail('Building must not execute a component'),
};
const pack = readSceneInteractionPack(raw); installSceneInteractionCapabilities(pack); sceneInteractionPacks.register(pack);
const policy = { understanding: '理解当前目标', planning: '只按明确任务搭建', response: '依据真实结果回答' };
const canvas = (): S2PublicCanvas => ({ version: 1, nodes: [
  { id: 'Note', componentId: 'note', position: { x: 0, y: 0 }, values: { content: '保留完整原文 $& {{literal}}' } },
  { id: 'Worker', componentId: 'worker', position: { x: 350, y: 0 } },
], connections: [{ source: { nodeId: 'Note', portId: 'content' }, target: { nodeId: 'Worker', portId: 'text' } }] });
const current = compileS2PublicCanvas(pack, canvas(), { goal: '通用自动事件与交互任务', instructions: policy }).definition;
const rule = (task = '解释本次真实结果'): S2InteractionConfig => ({ version: 1, triggers: [{ id: 'Explain', on: { event: 's2.node.succeeded', nodeId: 'Worker' }, task,
  scope: { actions: ['reply'], nodeIds: [] } }] });
const customRule: S2InteractionConfig = { version: 1, triggers: [{ id: 'Changed', on: { event: 'interaction-design-pack.note.changed', nodeId: 'Note' }, task: '解释当前文字' }] };
const original = readS2Definition({ ...current, interaction: rule() });
const originalSnapshot = JSON.stringify(original);
type RecordCall = { prompt: string; input: Record<string, unknown> };
async function build(response: (input: Record<string, any>, attempt: number) => Record<string, unknown>, source = current, review = false) {
  const records: RecordCall[] = []; let compose = 0;
  const call: S2PublicDesignOptions['call'] = async (prompt, input) => {
    records.push({ prompt, input: structuredClone(input) });
    assert(!JSON.stringify(input).includes('PRIVATE_IMPLEMENTATION'));
    assert(!JSON.stringify(input).includes('PRIVATE_FIXED_VALUE'));
    if (input.authoringPhase === 'select') {
      for (const item of input.publicComponentIndex as any[]) assert.deepEqual(Object.keys(item).sort(), ['id', 'label', 'purpose']);
      assert(!Object.hasOwn(input, 'interactionEvents'), 'First discovery remains a component index');
      return { componentIds: ['note', 'worker'] };
    }
    for (const item of input.interactionEvents as any[]) assert.deepEqual(Object.keys(item).sort(), ['id', 'purpose']);
    assert.deepEqual((input.interactionEvents as any[]).map(item => item.id), ['s2.node.succeeded', 's2.node.failed', 'interaction-design-pack.note.changed']);
    if (input.authoringPhase === 'compose') { assert(prompt.includes('triggers:[]') && prompt.includes('4000')); compose++; }
    return response(input, compose);
  };
  const definition = await buildS2PublicDesign({ pack, current: source, sources: { task: '按需求搭建，必要时配置自动解释', subject: '自动交互',
    currentGoal: source.goal, currentPolicy: '', knowledgePointTitles: [] }, call, ...(review ? { review: true } : {}) });
  return { definition, records };
}
try {
  const basic = await build(() => ({ canvas: canvas() }));
  assert.equal(basic.records.length, 2); assert.equal(basic.definition.interaction, undefined, 'Fresh building never invents automatic rules');
  const configured = await build(() => ({ canvas: canvas(), interaction: rule() }));
  assert.equal(configured.records.length, 2, 'Optional rules do not add default model calls or review');
  assert.deepEqual(configured.definition.interaction, rule()); validateS2PublicInteraction(pack, configured.definition);
  const custom = await build(() => ({ canvas: canvas(), interaction: customRule }));
  assert.deepEqual(custom.definition.interaction, customRule, 'Declared package events are reusable without S2 business edits');
  const retained = await build(() => ({ canvas: canvas() }), original);
  assert.deepEqual(retained.records[1].input.currentInteraction, rule()); assert.deepEqual(retained.definition.interaction, rule());
  const cleared = await build(() => ({ canvas: canvas(), interaction: { version: 1, triggers: [] } }), original);
  assert.deepEqual(cleared.definition.interaction, { version: 1, triggers: [] });

  let reviews = 0;
  const reviewed = await build((input, attempt) => {
    if (input.authoringPhase === 'review') {
      assert.deepEqual(input.interaction, rule('按审查候选的任务解释')); return { approved: ++reviews === 2, feedback: '调整位置' };
    }
    if (attempt === 1) return { canvas: canvas(), interaction: rule('按审查候选的任务解释') };
    assert.deepEqual(input.currentInteraction, rule('按审查候选的任务解释'));
    assert(input.previousCanvas); return { canvas: canvas() };
  }, original, true);
  assert.equal(reviewed.records.length, 5); assert.deepEqual(reviewed.definition.interaction, rule('按审查候选的任务解释'));

  const badEvent = rule(); badEvent.triggers[0].on.event = 'unknown.event';
  const repaired = await build((input, attempt) => {
    if (attempt === 1) return { canvas: canvas(), interaction: badEvent };
    assert.equal(input.repair.issue.code, 'INTERACTION_REFERENCE'); assert.equal(input.repair.issue.path, '/interaction/triggers/0/on/event');
    assert.deepEqual(input.repair.candidate.interaction, badEvent); return { canvas: canvas(), interaction: rule() };
  });
  assert.equal(repaired.records.length, 3); assert.deepEqual(repaired.definition.interaction, rule());
  const preservedThroughRepair = await build((input, attempt) => {
    if (attempt === 1) { const invalid = canvas(); invalid.nodes[0].position.x = 100001; return { canvas: invalid, interaction: rule() }; }
    assert.deepEqual(input.repair.candidate.interaction, rule()); return { canvas: canvas() };
  });
  assert.deepEqual(preservedThroughRepair.definition.interaction, rule(), 'Repairing canvas fields preserves a previously proposed optional interaction');

  const withoutWorker = (): S2PublicCanvas => ({ version: 1, nodes: canvas().nodes.filter(node => node.id !== 'Worker'), connections: [] });
  await assert.rejects(build(() => ({ canvas: withoutWorker() }), original), /INTERACTION_REFERENCE/, 'Removing an event source requires explicit rule repair');
  const removed = await build((input, attempt) => {
    if (attempt === 1) return { canvas: withoutWorker() };
    assert.deepEqual(input.currentInteraction, rule()); return { canvas: withoutWorker(), interaction: { version: 1, triggers: [] } };
  }, original);
  assert.deepEqual(removed.definition.interaction?.triggers, []);

  for (const invalid of [
    badEvent,
    { ...rule(), triggers: [{ ...rule().triggers[0], on: { event: 's2.node.succeeded', nodeId: 'Note' } }] },
    { ...rule(), triggers: [{ ...rule().triggers[0], on: { event: 's2.node.succeeded', nodeId: 'PrivateWorker' } }] },
    { ...rule(), triggers: [{ ...rule().triggers[0], scope: { actions: ['reply'], nodeIds: ['PrivateWorker'] } }] },
    { ...rule(), triggers: [{ ...rule().triggers[0], scope: { actions: ['invent'] } }] },
    { ...rule(), triggers: [{ ...rule().triggers[0], task: 'x'.repeat(4001) }] },
  ]) await assert.rejects(build(() => ({ canvas: canvas(), interaction: invalid })), /INTERACTION_/);

  const restored = prepareS2PublicDefinition(pack, original);
  assert.deepEqual(restored.interaction, rule()); assert.equal(prepareS2PublicDefinition(pack, original, { fresh: true }).interaction, undefined);
  assert.throws(() => prepareS2PublicDefinition(pack, readS2Definition({ ...current, interaction: badEvent })), /INTERACTION_REFERENCE/);
  assert.throws(() => prepareS2PublicDefinition(pack, readS2Definition({ ...current, interaction: { version: 1, triggers: [
    { id: 'Private', on: { event: 's2.node.succeeded', nodeId: 'PrivateWorker' }, task: '不应公开' },
  ] } })), /INTERACTION_SCOPE/);

  const details = projectS2AgentComponents(publicS2Catalog(pack)!.components);
  const dirty = { canvas: canvas(), interaction: { ...rule(), hidden: 'DO_NOT_ECHO', triggers: [{ ...rule().triggers[0], secret: 'DO_NOT_ECHO',
    on: { ...rule().triggers[0].on, private: 'DO_NOT_ECHO' }, scope: { actions: ['reply'], nodeIds: [], grant: 'DO_NOT_ECHO' } }] } };
  const safe = createS2PublicRepair(new S2InteractionProtocolError('INTERACTION_FIELD', '/interaction', 'PRIVATE_NATIVE_ERROR'), dirty, details)!;
  assert(safe); assert.deepEqual(safe.candidate.interaction, rule()); assert(!JSON.stringify(safe).includes('DO_NOT_ECHO')); assert(!JSON.stringify(safe).includes('PRIVATE_NATIVE_ERROR'));
  assert.equal(createS2PublicRepair(new S2InteractionProtocolError('INTERACTION_FIELD', '/native/PrivateWorker', 'PRIVATE_NATIVE_ERROR'), dirty, details), undefined);
  const legacyRepair = createS2PublicRepair(new S2PublicDesignValidationError('PUBLIC_FIELD', '/canvas', 'PRIVATE_NATIVE_ERROR'), { canvas: canvas() }, details)!;
  assert.deepEqual(Object.keys(legacyRepair.candidate), ['canvas'], 'Existing repair envelopes stay unchanged without optional rules');

  const promptPack = sceneInteractionPacks.resolve({ id: 'prompt-lab', version: '0.1.0' });
  const promptCanvas: S2PublicCanvas = { version: 1, nodes: [
    { id: 'Prompt', componentId: 'content', position: { x: 0, y: 0 }, values: { content: '概括为三点' } },
    { id: 'Assemble', componentId: 'compose', position: { x: 300, y: 0 } },
    { id: 'Test', componentId: 'model-test', position: { x: 600, y: 0 } },
    { id: 'Result', componentId: 'result', position: { x: 900, y: 0 } },
  ], connections: [
    { source: { nodeId: 'Prompt', portId: 'content' }, target: { nodeId: 'Assemble', portId: 'part1' } },
    { source: { nodeId: 'Assemble', portId: 'text' }, target: { nodeId: 'Test', portId: 'prompt' } },
    { source: { nodeId: 'Test', portId: 'text' }, target: { nodeId: 'Result', portId: 'text' } },
  ] };
  const promptInitial = compileS2PublicCanvas(promptPack, promptCanvas, { goal: '测试提示词后解释真实返回', instructions: policy }).definition;
  let promptCalls = 0;
  const promptDefinition = await buildS2PublicDesign({ pack: promptPack, current: promptInitial,
    sources: { task: '测试后由助手解释', subject: '提示词实验', currentGoal: promptInitial.goal, currentPolicy: '', knowledgePointTitles: [] },
    async call(_prompt, input) {
      promptCalls++;
      if (input.authoringPhase === 'select') return { componentIds: ['content', 'compose', 'model-test', 'result'] };
      return { canvas: promptCanvas, interaction: { version: 1, triggers: [{ id: 'ExplainTest', on: { event: 's2.node.succeeded', nodeId: 'Test' }, task: '结合本次输入解释真实结果' }] } };
    } });
  assert.equal(promptCalls, 2); validateS2PublicInteraction(promptPack, promptDefinition);
  assert.deepEqual(projectS2PublicCanvas(promptPack, promptDefinition, promptDefinition.initial), projectS2PublicCanvas(promptPack, promptInitial, promptInitial.initial));
  assert(!promptPack.describe().assistant.instructions.includes('@1.0.0/'));
  assert(promptPack.describe().assistant.instructions.includes('公开actions'));
  assert.equal(JSON.stringify(original), originalSnapshot, 'Build, validation, repair and session preparation never modify the source');
  console.log('S2 interaction design passed: minimal select/event indices, default two calls, optional/retained/cleared rules, package and builtin events, review and one repair, explicit source removal, public/private validation, fresh/import sessions and prompt-lab regression. Synthetic local responses only.');
} finally { globalThis.fetch = previousFetch; }
