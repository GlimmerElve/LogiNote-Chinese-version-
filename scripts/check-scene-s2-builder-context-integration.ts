// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import { useLegacyS2Authoring } from './fixtures/s2-generic-canvas-ui';
import type { LlmCallRequest } from '../src/types';
import { createS2Scene, designS2Canvas, readS2Scene } from '../src/services/scene/sceneS2Canvas';
import { S2_BUILDER_BOUNDARY, S2_BUILDER_CANVAS_RULES } from '../src/services/scene/sceneS2BuildContext';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { describeSceneInteractionPack } from '../src/services/scene/sceneInteractionPackProtocol';
import { s2InstalledPluginCatalog } from '../src/services/scene/sceneS2PluginRegistry';
import { fitSceneContextBudget } from '../src/services/scene/sceneContextBudget';
import { experimentDefinition } from './fixtures/s2-experiment';

// These saved native-protocol fixtures explicitly exercise the legacy adapter.
useLegacyS2Authoring();
globalThis.fetch = async () => assert.fail('Builder context integration must never use network or real models');
const reference = { id: 'prompt-lab', version: '0.1.0' };
const scene = createS2Scene({ source: 'build', sceneSkill: 'S2', subject: '提示词工程入门', knowledgePoints: [],
  extraHints: '搭建提示词实验，由用户编辑任务、确认测试并查看原文；不自动运行。', interactionPack: reference });
const original = JSON.stringify(scene), source = readS2Scene(scene);
const fullCatalog = s2InstalledPluginCatalog(reference), fullCatalogSnapshot = JSON.stringify(fullCatalog);
const guide = describeSceneInteractionPack(sceneInteractionPacks.resolve(reference)), guideSnapshot = JSON.stringify(guide);
const brief = { goal: '由用户操作的提示词实验', requirements: [{ id: 'Experiment', source: 'task',
  quote: '搭建提示词实验', description: '提供可操作的提示词实验' }], userRole: '编辑并确认测试', agentRole: '按需帮助',
  assumptions: [], openQuestions: [], delivery: { initial: '可操作的实验画布', deferred: '用户后续编辑并确认测试', source: 'task', quote: '由用户编辑任务、确认测试并查看原文' } };
const calls: LlmCallRequest[] = [];
await designS2Canvas(scene, { disclosure: 'complete', invoke: async request => {
  calls.push(structuredClone(request));
  const input = JSON.parse(request.userInput), system = request.systemPromptOverride!;
  assert(system.startsWith(S2_BUILDER_BOUNDARY));
  assert(!system.includes('S2自由组合规则')); assert(!system.includes('S2插件协议v1'));
  assert.equal(input.sources.task, scene.task); assert.deepEqual(input.sources.knowledgePointTitles, []);
  assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
  if (input.stage === 'understand') {
    assert.equal(input.interactionPack, undefined); assert.equal(input.pluginCatalog, undefined);
    return { content: JSON.stringify(brief) };
  }
  assert.equal(input.stage, 'assemble'); assert.equal(request.maxTokensOverride, 16384);
  assert.deepEqual(input.current, source); assert.deepEqual(input.designBrief, brief);
  assert(system.includes(S2_BUILDER_CANVAS_RULES));
  assert.equal(system.split(guide.builder.assemble).length, 2, 'The selected package assembly policy is compiled exactly once');
  assert.equal(input.interactionPack.builder, undefined);
  assert.deepEqual(input.interactionPack.components, guide.components);
  assert.deepEqual(input.interactionPack.combinations, guide.combinations);
  assert.deepEqual(input.interactionPack.operations, guide.operations.map(({ id, description }) => ({ id, description })));
  assert.equal(input.interactionPack.assistant.instructions, guide.assistant.instructions);
  const keys = (catalog: any) => catalog.plugins.flatMap((plugin: any) => plugin.capabilities.map((cap: any) => `${plugin.id}@${plugin.version}/${cap.id}`)).sort();
  assert.deepEqual(keys(input.pluginCatalog), keys(fullCatalog), 'No available capability is hidden to save context');
  assert(system.length < 5000, 'Ordinary builder system context stays below the former full runtime manual');
  const budget = fitSceneContextBudget(request, { provider: null });
  assert.equal(budget.request.userInput, request.userInput);
  assert.equal(budget.diagnostics!.contextWindowTokens, 65536);
  assert.equal(budget.diagnostics!.outputReserveTokens, 16384);
  assert.deepEqual(budget.diagnostics!.omittedContextIds, []);
  assert(budget.diagnostics!.estimatedTotalTokens <= 65536);
  return { content: JSON.stringify(experimentDefinition) };
} });
assert.deepEqual(calls.map(request => JSON.parse(request.userInput).stage), ['understand', 'assemble'], 'Compaction adds no model round or retry');
assert.equal(JSON.stringify(scene), original);
assert.equal(JSON.stringify(fullCatalog), fullCatalogSnapshot);
assert.equal(JSON.stringify(describeSceneInteractionPack(sceneInteractionPacks.resolve(reference))), guideSnapshot);
const assembly = calls[1];
console.log(`S2 builder complete-compatibility integration passed: ${assembly.systemPromptOverride!.length} system / ${assembly.userInput.length} input chars, exact sources and current canvas, unchanged capability choices/public guide, one policy copy, no runtime manual, default 64K with 16384 output and no omissions, exactly two mocked requests. No real model/network/notes.`);
