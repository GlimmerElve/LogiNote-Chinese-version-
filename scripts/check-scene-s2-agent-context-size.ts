/** Offline context measurements at the real public builder call boundary.
 * Run with --no-scene-pack-bootstrap; --write saves fixture-only requests/reports.
 * Historical numbers below reconstruct the previous public format; they are not
 * a claim that an old checkout or a real language model was executed. */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { activate as activatePrompt } from '../src/interaction-packs/prompt-lab/entry';
import { activate as activateScale } from '../examples/scene-packs/number-scale/entry';
import type { SceneInteractionPack } from '../src/types/sceneInteractionPack';
import { readSceneInteractionPack } from '../src/services/scene/sceneInteractionPackProtocol';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { scenePackEditorServices } from '../src/services/scene/scenePackEditorServices';
import { buildS2PublicDesign } from '../src/services/scene/sceneS2PublicDesign';
import { createS2Scene, designS2Canvas } from '../src/services/scene/sceneS2Canvas';
import { compileS2PublicCanvas, projectS2PublicCanvas, publicS2Catalog, type S2PublicCanvas } from '../src/services/scene/sceneS2PublicAuthoring';
import { withS2DesignContext } from './fixtures/s2-design-context';

const args = process.argv.slice(2);
assert(args.every(arg => arg === '--write') && args.length <= 1, 'Usage: node scripts/run-tsx-safe.cjs --no-scene-pack-bootstrap scripts/check-scene-s2-agent-context-size.ts [--write]');
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const reportDirectory = path.join(repository, 'output/scene-s2-context-inspection');
const fixtureDirectory = path.join(reportDirectory, 'public-compact-requests');
const oldComposePrompt = `按目标搭建公开画布。返回{canvas:{version:1,nodes:[{id,componentId,position:{x,y},label?,readOnly?:布尔值,values?:{公开参数id:原生JSON值}}],connections:[{source:{nodeId,portId},target:{nodeId,portId}}]},instructions?:{understanding,planning,response}}。
只使用已读组件、公开参数和公开输入输出；连接输出到输入，保持类型和单路/多路约束。原生文字组件也通过同一接口添加、填写、连接；readOnly只用于内容实例，既有固定原文不得删除、替换或解锁。保留用户原文，缺少资料留入口；不用文字冒充连线，不编造运行结果。instructions仅为可选的场景内互动Agent策略，不强制固定教学或评判流程。不要输出底层能力、内部对象、代码或权限字段；实现映射与运行由本地程序完成。`;
const oldContinue = '需要补读时只能返回{read:{componentIds:[尚未读的组件id]}}，不能混合canvas或instructions。最多补读一批；不能猜未读接口。';
type Capture = { system: string; input: Record<string, unknown>; maxOutputTokens: number };
type TransportCapture = Capture & { userInput: string; skipMemoryInjection: boolean; skipProfileInjection: boolean };
const length = (system: string, input: unknown) => ({ systemChars: system.length, inputChars: JSON.stringify(input).length,
  totalChars: system.length + JSON.stringify(input).length });
const delta = (current: number, baseline: number) => ({ charsSaved: baseline - current, percentSaved: Number(((baseline - current) / baseline * 100).toFixed(2)) });
const oldFetch = globalThis.fetch;
let networkCalls = 0, runtimeCalls = 0, executionCalls = 0;
globalThis.fetch = async () => { networkCalls++; throw new Error('Context measurement forbids networks, providers and user resources'); };
const policy = { understanding: '按用户目标理解画布', planning: '按需帮助搭建', response: '只报告真实结果' };

function install(raw: unknown): SceneInteractionPack {
  const checked = readSceneInteractionPack(raw);
  const fixture = { ...checked,
    createRuntime: () => { runtimeCalls++; return assert.fail('Measuring context must not start a package runtime'); },
    executeLocal: async () => { executionCalls++; return assert.fail('Measuring context must not execute a component'); },
  };
  installSceneInteractionCapabilities(fixture); sceneInteractionPacks.register(fixture);
  return sceneInteractionPacks.resolve({ id: checked.manifest.id, version: checked.manifest.version });
}
function promptCanvas(): S2PublicCanvas {
  return { version: 1, nodes: [
    { id: 'Prompt', componentId: 'content', position: { x: 0, y: 0 }, values: { content: '将下面的资料概括为三个要点。' } },
    { id: 'Compose', componentId: 'compose', position: { x: 320, y: 0 } },
    { id: 'Test', componentId: 'model-test', position: { x: 640, y: 0 }, values: { maxOutputTokens: 1024, temperature: 0.2 } },
    { id: 'Result', componentId: 'result', position: { x: 960, y: 0 } },
    { id: 'Material', componentId: 'material-text', position: { x: 320, y: 260 }, values: { content: '' } },
  ], connections: [
    { source: { nodeId: 'Prompt', portId: 'content' }, target: { nodeId: 'Compose', portId: 'part1' } },
    { source: { nodeId: 'Compose', portId: 'text' }, target: { nodeId: 'Test', portId: 'prompt' } },
    { source: { nodeId: 'Material', portId: 'content' }, target: { nodeId: 'Test', portId: 'input' } },
    { source: { nodeId: 'Test', portId: 'text' }, target: { nodeId: 'Result', portId: 'text' } },
  ] };
}
function scaleCanvas(): S2PublicCanvas {
  return { version: 1, nodes: [
    { id: 'Caption', componentId: 'caption', position: { x: 0, y: 0 }, values: { content: '结果' } },
    { id: 'Scale', componentId: 'scale', position: { x: 320, y: 0 }, values: { amount: 4, factor: 2.5 } },
    { id: 'Result', componentId: 'result', position: { x: 640, y: 0 } },
  ], connections: [
    { source: { nodeId: 'Caption', portId: 'content' }, target: { nodeId: 'Scale', portId: 'label' } },
    { source: { nodeId: 'Scale', portId: 'text' }, target: { nodeId: 'Result', portId: 'text' } },
  ] };
}

try {
  assert.deepEqual(sceneInteractionPacks.catalog(), [], 'Use --no-scene-pack-bootstrap so this measurement installs only its explicit fixtures');
  const services = { editor: scenePackEditorServices, ui: { react: React } };
  const prompt = install(activatePrompt(services)), scale = install(activateScale(services));
  const scenarios = [
    { id: 'prompt-common-five', pack: prompt, selected: ['content', 'compose', 'model-test', 'result', 'material-text'], canvas: promptCanvas(), task: '搭建提示词测试场景，预置可编辑提示词、待测文字资料和模型参数，通过连线组装并显示返回。' },
    { id: 'prompt-all-seven', pack: prompt, selected: prompt.authoring!.components.map(component => component.id), canvas: promptCanvas(), task: '搭建提示词测试场景，保留文字、文件、图片资料的组件选择，使用文字资料连接当前测试流程。' },
    { id: 'number-scale-three', pack: scale, selected: scale.authoring!.components.map(component => component.id), canvas: scaleCanvas(), task: '搭建数值缩放场景，输入数值4和倍数2.5，连接结果名称与完整文字结果展示。' },
  ];
  const reports: unknown[] = [];
  for (const scenario of scenarios) {
    const current = compileS2PublicCanvas(scenario.pack, { version: 1, nodes: [], connections: [] }, { goal: scenario.task, instructions: policy }).definition;
    const captures: Capture[] = [];
    const before = JSON.stringify({ authoring: scenario.pack.authoring, current });
    const result = await buildS2PublicDesign({ pack: scenario.pack, current,
      sources: { task: scenario.task, subject: '离线上下文测量', currentGoal: current.goal, currentPolicy: 'PRIVATE_FIXTURE_POLICY', knowledgePointTitles: [] },
      call: async (system, input, maxOutputTokens) => {
        captures.push({ system, input: structuredClone(input), maxOutputTokens });
        if (input.authoringPhase === 'select') return { componentIds: scenario.selected };
        assert.equal(input.authoringPhase, 'compose');
        return { canvas: structuredClone(scenario.canvas) };
      } });
    assert.equal(captures.length, 2, 'Normal public design consists of selection and composition');
    assert.equal(JSON.stringify({ authoring: scenario.pack.authoring, current }), before);
    const projected = projectS2PublicCanvas(scenario.pack, result, result.initial);
    assert.deepEqual(projected.connections.map(item => JSON.stringify(item)).sort(), scenario.canvas.connections.map(item => JSON.stringify(item)).sort());
    assert.deepEqual(projected.nodes.map(node => `${node.id}:${node.componentId}`).sort(), scenario.canvas.nodes.map(node => `${node.id}:${node.componentId}`).sort());
    // Capture the real terminal adapter as well. Its system wrapper is observed
    // from the actual request, never reconstructed or estimated. The capacity
    // fixture replaces localStorage for this call so no user model settings are read.
    const scene = createS2Scene({ source: 'build', sceneSkill: 'S2', subject: '离线上下文测量', knowledgePoints: [],
      interactionPack: { id: scenario.pack.manifest.id, version: scenario.pack.manifest.version } });
    scene.task = scenario.task; scene.canvasWorkspace = structuredClone(current);
    const sceneBefore = JSON.stringify(scene), transport: TransportCapture[] = [];
    const transportResult = await withS2DesignContext(131072, () => designS2Canvas(scene, { invoke: async request => {
      const input = JSON.parse(request.userInput) as Record<string, unknown>;
      assert.equal(typeof request.systemPromptOverride, 'string');
      assert(request.skipMemoryInjection && request.skipProfileInjection);
      transport.push({ system: request.systemPromptOverride!, userInput: request.userInput, input,
        maxOutputTokens: request.maxTokensOverride!, skipMemoryInjection: true, skipProfileInjection: true });
      return { content: JSON.stringify(input.authoringPhase === 'select' ? { componentIds: scenario.selected } : { canvas: structuredClone(scenario.canvas) }),
        diagnostics: { finishReason: 'stop' } };
    } }));
    assert.equal(JSON.stringify(scene), sceneBefore); assert.equal(transport.length, 2);
    assert.deepEqual(transportResult, result, 'Both observed boundaries compile the same public scenario');
    for (let i = 0; i < captures.length; i++) {
      assert.deepEqual(transport[i].input, captures[i].input, 'Transport capture must use the same task, goal, current canvas and public details');
      assert(transport[i].system.endsWith(captures[i].system), 'The measured terminal system includes the actual builder prompt');
    }
    const full = publicS2Catalog(scenario.pack)!.components.map(({ group: _group, ...component }) => component);
    const index = full.map(({ id, label, purpose }) => ({ id, label, purpose }));
    const selectedFull = scenario.selected.map(id => full.find(component => component.id === id)!);
    // The previous catalog omitted the new meanings/native-field rules. Rebuild
    // that exact parameter field set rather than claiming equal information.
    const historicalDetails = selectedFull.map(component => ({ ...component, parameters: component.parameters.map(parameter => ({
      id: parameter.id, label: parameter.label, type: parameter.type, schema: parameter.schema, required: parameter.required,
      ...(Object.hasOwn(parameter, 'allowBlank') ? { allowBlank: parameter.allowBlank } : {}),
      ...(Object.hasOwn(parameter, 'default') ? { default: structuredClone(parameter.default) } : {}),
    })) }));
    const [selection, compose] = captures;
    const historicalCompose = { stage: 'assemble', authoringPhase: 'compose', sources: compose.input.sources,
      publicComponentIndex: index, components: historicalDetails, readState: { componentIds: scenario.selected }, current: compose.input.current,
      contextReadsRemaining: 1, modelCallsRemaining: 2 };
    const historicalComposeSystem = `${oldComposePrompt}\n${oldContinue}`;
    const currentSelection = length(selection.system, selection.input), currentCompose = length(compose.system, compose.input);
    const equivalentFullCompose = length(compose.system, { ...compose.input, components: selectedFull });
    const historicalComposeSize = length(historicalComposeSystem, historicalCompose);
    const detailWithoutTypeMeaning = structuredClone(compose.input.components) as Array<{ parameters: Array<{ typeMeaning?: string }> }>;
    let typeMeaningEntries = 0;
    for (const component of detailWithoutTypeMeaning) for (const parameter of component.parameters) if (Object.hasOwn(parameter, 'typeMeaning')) {
      delete parameter.typeMeaning; typeMeaningEntries++;
    }
    const currentTotal = currentSelection.totalChars + currentCompose.totalChars;
    const historicalTotal = currentSelection.totalChars + historicalComposeSize.totalChars;
    const equivalentTotal = currentSelection.totalChars + equivalentFullCompose.totalChars;
    reports.push({ id: scenario.id, pack: { id: scenario.pack.manifest.id, version: scenario.pack.manifest.version }, selected: scenario.selected,
      indexChars: JSON.stringify(index).length,
      details: { historicalChars: JSON.stringify(historicalDetails).length, completeCurrentChars: JSON.stringify(selectedFull).length,
        agentChars: JSON.stringify(compose.input.components).length,
        retainedTypeMeanings: { entries: typeMeaningEntries, chars: JSON.stringify(compose.input.components).length - JSON.stringify(detailWithoutTypeMeaning).length } },
      requests: { selection: currentSelection, compose: currentCompose, historicalCompose: historicalComposeSize, equivalentFullCompose },
      transport: { boundary: 'Actual designS2Canvas invoke request; current implementation only',
        selection: length(transport[0].system, transport[0].input), compose: length(transport[1].system, transport[1].input),
        totalChars: transport.reduce((sum, capture) => sum + capture.system.length + capture.userInput.length, 0),
        sameInputsAsBuilder: true, observedSystemWrapperCharsPerRequest: transport.map((capture, i) => capture.system.length - captures[i].system.length) },
      total: { currentChars: currentTotal, historicalChars: historicalTotal, equivalentFullChars: equivalentTotal,
        vsHistorical: delta(currentTotal, historicalTotal), vsEquivalentFull: delta(currentTotal, equivalentTotal) },
      assertions: { builderCalls: captures.length, transportCalls: transport.length, locallyCompiled: true, sourceUnchanged: true } });
    assert(currentCompose.inputChars < equivalentFullCompose.inputChars, 'The common projection must reduce an equivalent complete-detail request');
    for (const capture of captures) assert(!JSON.stringify(capture).includes('PRIVATE_FIXTURE_POLICY'));
    if (args.includes('--write')) {
      await mkdir(fixtureDirectory, { recursive: true });
      await writeFile(path.join(fixtureDirectory, `${scenario.id}.json`), JSON.stringify({ current: captures, transport,
        historicalCompose: { system: historicalComposeSystem, input: historicalCompose },
        equivalentFullCompose: { system: compose.system, input: { ...compose.input, components: selectedFull } } }, null, 2) + '\n');
    }
  }
  assert.equal(networkCalls, 0); assert.equal(runtimeCalls, 0); assert.equal(executionCalls, 0);
  const report = { measurement: 'JavaScript UTF-16 string lengths, not tokenizer counts. requests/total measure buildS2PublicDesign options.call; transport separately measures actual designS2Canvas invoke systemPromptOverride and userInput.',
    baseline: { historical: 'Reconstructed pre-compaction public format and prompt, using its former parameter field set; selection uses the current unchanged light index. Not an old-checkout execution.',
      equivalentFull: 'Same current system prompt, request metadata, selected components and newly completed meanings/constraints; only compact details replaced by complete public details (local menu group excluded).' },
    limits: 'Synthetic structurally valid Agent replies verify context contents and local compilation. No real-model comprehension or task-success claim.',
    guards: { networkCalls, runtimeCalls, executionCalls, inputSource: 'Explicit repository fixtures only; no user vault/resource API is called',
      modelCapacitySource: 'In-memory synthetic localStorage fixture; no real user model settings' }, scenarios: reports };
  if (args.includes('--write')) {
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(path.join(reportDirectory, 'public-compact-report.json'), JSON.stringify(report, null, 2) + '\n');
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally { globalThis.fetch = oldFetch; }
