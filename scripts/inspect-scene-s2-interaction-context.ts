/** Offline, reproducible comparison against the exact five-block request captured
 * before progressive interaction disclosure. No model, network or user resources.
 * Run: node scripts/run-tsx-safe.cjs --no-scene-pack-bootstrap scripts/inspect-scene-s2-interaction-context.ts [--write]
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React from 'react';
import { activate } from '../src/interaction-packs/prompt-lab/entry';
import { scenePackEditorServices } from '../src/services/scene/scenePackEditorServices';
import { readSceneInteractionPack } from '../src/services/scene/sceneInteractionPackProtocol';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { installSceneInteractionCapabilities } from '../src/services/scene/sceneS2PluginRegistry';
import { compileS2PublicCanvas, projectS2PublicCanvas, publicS2Catalog, type S2PublicCanvas } from '../src/services/scene/sceneS2PublicAuthoring';
import { projectS2AgentComponents, S2_AGENT_COMPONENT_RULES } from '../src/services/scene/sceneS2AgentCatalog';
import { interactS2PublicScene, type S2InteractionOptions } from '../src/services/scene/sceneS2Interaction';
import { invokeS2InteractionModel } from '../src/services/scene/sceneS2Canvas';
import { readS2InteractionScope } from '../src/services/scene/sceneS2InteractionProtocol';
import { bindS2ArtifactContext } from '../src/services/scene/sceneS2ArtifactAccess';
import { withS2DesignContext } from './fixtures/s2-design-context';

const args = process.argv.slice(2);
assert(args.length <= 1 && args.every(arg => arg === '--write'), 'Only optional --write is supported');
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixturePath = path.join(repository, 'scripts/fixtures/s2-interaction-context-before.json');
const systemFixturePath = path.join(repository, 'scripts/fixtures/s2-interaction-system-before-slim.json');
const scopedFixturePath = path.join(repository, 'scripts/fixtures/s2-interaction-context-before-scoped.json');
const folder = path.join(repository, 'output/scene-s2-interaction-context-inspection');
const beforeFolder = path.join(folder, 'before');
const write = args.includes('--write');
type Capture = { system: string; input: Record<string, any>; rawInput: string; maxOutputTokens: number };
const count = (capture: Pick<Capture, 'system' | 'rawInput'>) => ({ systemChars: capture.system.length,
  inputChars: capture.rawInput.length, totalChars: capture.system.length + capture.rawInput.length });
const saved = (previous: number, current: number) => ({ chars: previous - current,
  percent: Number(((previous - current) / previous * 100).toFixed(2)) });
const previousFetch = globalThis.fetch;
let forbiddenNetworkCalls = 0;
globalThis.fetch = async () => { forbiddenNetworkCalls++; return assert.fail('Inspection forbids network, actual providers and user resources'); };

async function saveCapture(directory: string, capture: Capture, immutable = false) {
  await mkdir(directory, { recursive: true });
  for (const [name, value] of [['system-prompt.txt', capture.system], ['input.compact.json', capture.rawInput],
    ['input.readable.json', JSON.stringify(capture.input, null, 2)]]) {
    const destination = path.join(directory, name);
    try { await writeFile(destination, value, { encoding: 'utf8', ...(immutable ? { flag: 'wx' } : {}) }); }
    catch (error) {
      if (!immutable || (error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      assert.equal(await readFile(destination, 'utf8'), value, `Frozen capture cannot be overwritten: ${destination}`);
    }
  }
}

try {
  // Repository fixture is the actual synthetic request captured before this
  // change, copied verbatim into source once. Generated output is never input.
  const frozen = JSON.parse(await readFile(fixturePath, 'utf8')) as { system: string; input: Record<string, any> };
  assert.deepEqual(Object.keys(frozen).sort(), ['input', 'system']);
  const oldSystem = frozen.system, oldInput = frozen.input;
  const oldRawInput = JSON.stringify(oldInput);
  const baseline = { system: oldSystem, rawInput: oldRawInput };
  assert.deepEqual(count(baseline), { systemChars: 840, inputChars: 6058, totalChars: 6898 });
  assert.equal(oldInput.task, '解释当前画布');
  assert.deepEqual(oldInput.scope, { actions: ['reply', 'edit', 'execute'] });
  assert.deepEqual(oldInput.context.recentMessages, [{ role: 'user', content: '请保留原文。' }, { role: 'assistant', content: '会依据当前画布协作。' }]);
  const systemBefore = JSON.parse(await readFile(systemFixturePath, 'utf8'));
  const scopedBefore = JSON.parse(await readFile(scopedFixturePath, 'utf8'));
  assert.equal(scopedBefore.saved634.normal.system.length, 634);
  assert.equal(scopedBefore.immediateBefore.normal.requests[0].system.length, 701);
  for (const [name, expected] of [['prompt995', 995], ['beforeSystemSlim', 1052]] as const) {
    const previous = systemBefore[name];
    assert.equal(previous.system.length, expected, 'Use the frozen actual system, never a reconstructed short prompt');
    assert.equal(JSON.stringify(previous.input).length, 1943);
    assert.equal(previous.input.task, oldInput.task);
    assert.deepEqual(previous.input.scope, oldInput.scope);
    assert.deepEqual(previous.input.context.recentMessages, oldInput.context.recentMessages);
  }

  assert.equal(sceneInteractionPacks.catalog().length, 0, 'Run without automatic fixture package bootstrap');
  const pack = readSceneInteractionPack(activate({ editor: scenePackEditorServices, ui: { react: React } }));
  const packSnapshot = JSON.stringify({ manifest: pack.manifest, authoring: pack.authoring, description: pack.describe() });
  installSceneInteractionCapabilities(pack); sceneInteractionPacks.register(pack);
  const canvas: S2PublicCanvas = { version: 1, nodes: [
    { id: 'Prompt', componentId: 'content', position: { x: 0, y: 0 }, values: { content: '把资料归纳成三个要点。' } },
    { id: 'Compose', componentId: 'compose', position: { x: 320, y: 0 } },
    { id: 'Test', componentId: 'model-test', position: { x: 640, y: 0 } },
    { id: 'Result', componentId: 'result', position: { x: 960, y: 0 } },
    { id: 'Material', componentId: 'material-text', position: { x: 320, y: 260 }, values: { content: '' } },
  ], connections: [
    { source: { nodeId: 'Prompt', portId: 'content' }, target: { nodeId: 'Compose', portId: 'part1' } },
    { source: { nodeId: 'Compose', portId: 'text' }, target: { nodeId: 'Test', portId: 'prompt' } },
    { source: { nodeId: 'Material', portId: 'content' }, target: { nodeId: 'Test', portId: 'input' } },
    { source: { nodeId: 'Test', portId: 'text' }, target: { nodeId: 'Result', portId: 'text' } },
  ] };
  const config = compileS2PublicCanvas(pack, canvas, { goal: '理解提示词测试场景' });
  assert.deepEqual(projectS2PublicCanvas(pack, config.definition, config.document), oldInput.context.canvas, 'Same five blocks, positions, values and connections as the frozen before request');
  assert.equal(config.definition.goal, oldInput.context.goal);
  assert.deepEqual(config.definition.instructions, oldInput.context.instructions);
  assert.equal(pack.describe().assistant.instructions, oldInput.context.packageInstructions, 'Package instructions were not rewritten to reduce counts');
  const configSnapshot = JSON.stringify(config);
  const base = { pack, ...config, scope: readS2InteractionScope(oldInput.scope), origin: 'user' as const,
    history: structuredClone(oldInput.context.recentMessages) };

  const explanationReadRequest = { read: { values: [{ nodeId: 'Prompt', parameterIds: ['content'] }] } };
  async function capture(task: string, edit: boolean,
    overrides: Partial<Pick<S2InteractionOptions, 'definition' | 'document' | 'pluginContext' | 'scope'>> = {}, readExplanation = false) {
    const requests: Capture[] = [];
    const result = await withS2DesignContext(131072, () => interactS2PublicScene({ ...base, ...overrides, task,
      call: (system, input, tokens) => invokeS2InteractionModel(system, input, async request => {
        assert.equal(request.systemPromptOverride, system); assert.equal(request.userInput, JSON.stringify(input));
        assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
        requests.push({ system, input: JSON.parse(request.userInput), rawInput: request.userInput, maxOutputTokens: request.maxTokensOverride! });
        const response = readExplanation ? requests.length === 1 ? explanationReadRequest
          : { reply: `内容块原文是“${(input.context as any).recalled.values[0].value}”，它通过连线交给组装块。` }
          : !edit ? { reply: '这是一条提示词测试链路。' } : requests.length === 1
          ? { read: { interfaces: [{ componentId: 'content', parameters: ['content'] }] } }
          : { actions: [{ type: 'setValues', nodeId: 'Prompt', values: { content: '请用三个要点概括资料。' } }] };
        return { content: JSON.stringify(response), diagnostics: { finishReason: 'stop' } };
      }, undefined, tokens) }));
    return { requests, result };
  }
  const normal = await capture(oldInput.task, false);
  const explanationRead = await capture(oldInput.task, false, {}, true);
  assert.equal(explanationRead.requests.length, 2);
  assert.deepEqual(explanationRead.requests[0], normal.requests[0], 'Same task and fixture must produce identical first requests');
  const explained = explanationRead.requests[1].input.context;
  assert.deepEqual(explained.recalled.values, [{ nodeId: 'Prompt', parameterId: 'content', value: '把资料归纳成三个要点。' }]);
  assert.equal(explained.interfaces, undefined, 'Reading text for an explanation does not require parameter constraints');
  assert.equal(explained.components, undefined); assert.equal(explained.componentRules, undefined);
  assert.equal(explained.actionGuide, undefined, 'Reading source values must not disclose unrelated edit syntax');
  assert.equal(explanationRead.requests[1].input.task, oldInput.task);
  assert.deepEqual(explanationRead.requests[1].input.scope, oldInput.scope);
  assert.deepEqual(explained.recentMessages, oldInput.context.recentMessages);
  const editTask = '把Prompt的内容改成“请用三个要点概括资料。”，保留其他块和连线。';
  const editing = await capture(editTask, true);
  const replyOnly = await capture(oldInput.task, false, { scope: { actions: ['reply'] } });
  const editOnly = await capture(oldInput.task, false, { scope: { actions: ['reply', 'edit'] } });
  assert.equal(replyOnly.requests.length, 1); assert.equal(editOnly.requests.length, 1);
  assert.equal(normal.requests.length, 1); assert.equal(editing.requests.length, 2);
  for (const first of [normal.requests[0], editing.requests[0]]) {
    assert.equal(first.input.context.components, undefined, 'First call discloses no complete interfaces');
    assert.equal(first.input.context.interfaces, undefined, 'First call discloses no selected field constraints either');
    assert.equal(first.input.context.packageInstructions, undefined, 'First call does not preload the package manual');
    assert.equal(first.input.context.actionGuide, undefined, 'Deferred operation formats must not be moved into every initial input');
    assert.deepEqual(first.input.context.componentIndex.map((component: Record<string, unknown>) => Object.keys(component).sort()),
      Array.from({ length: pack.authoring!.components.length }, () => ['id', 'label', 'purpose']));
    assert.equal(first.input.context.canvas.representation, 'public-index');
    assert.deepEqual(first.input.context.canvas.connections, oldInput.context.canvas.connections);
    assert.deepEqual(first.input.context.canvas.nodes.map((node: any) => node.id), oldInput.context.canvas.nodes.map((node: any) => node.id));
    for (const node of first.input.context.canvas.nodes) assert(!Object.hasOwn(node, 'values'), 'First call never sends whole instance values');
    assert(!first.rawInput.includes('把资料归纳成三个要点。'), 'A short text value also remains on demand');
  }
  const disclosed = editing.requests[1].input.context;
  const publicComponents = projectS2AgentComponents(publicS2Catalog(pack)!.components);
  const content = publicComponents.find(component => component.id === 'content')!;
  assert.equal(disclosed.components, undefined, 'A selected parameter read does not send the complete component');
  assert.equal(disclosed.interfaces.length, 1); assert.equal(disclosed.interfaces[0].componentId, 'content');
  assert.equal(disclosed.interfaces[0].representation, 'selected-interface');
  assert.deepEqual(disclosed.interfaces[0].parameters, content.parameters, 'The one requested content parameter retains its complete current constraints');
  assert.deepEqual(disclosed.interfaces[0].parameters, oldInput.context.components.find((component: any) => component.id === 'content').parameters,
    'All constraints and defaults of the selected editable parameter remain exactly as before');
  assert.equal(disclosed.interfaces[0].inputs?.length ?? 0, 0); assert.equal(disclosed.interfaces[0].outputs?.length ?? 0, 0);
  assert.equal(disclosed.componentRules, S2_AGENT_COMPONENT_RULES);
  assert.equal(typeof disclosed.actionGuide, 'string', 'Successful editable parameter rules reveal only their needed operation formats');
  assert(disclosed.actionGuide.includes('setValues{'));
  assert(disclosed.actionGuide.includes('addNode{'));
  assert(!disclosed.actionGuide.includes('connect/'), 'A parameter-only read does not reveal wiring operation formats');
  assert.equal(editing.requests[1].input.task, editTask); assert.deepEqual(editing.requests[1].input.scope, oldInput.scope);
  assert.deepEqual(disclosed.recentMessages, oldInput.context.recentMessages);
  assert.equal(disclosed.packageInstructions, undefined, 'Only the requested component was disclosed');
  assert.equal(editing.result.actions?.[0].type, 'setValues');
  assert.equal(JSON.stringify(config), configSnapshot, 'The inspection neither edits nor executes the scene');
  assert.equal(JSON.stringify({ manifest: pack.manifest, authoring: pack.authoring, description: pack.describe() }), packSnapshot);
  assert.equal(forbiddenNetworkCalls, 0);

  // Different data sample, deliberately not presented as a before/after pair:
  // long current material and an existing complete result both stay index-only.
  const longCanvas = structuredClone(canvas);
  const materialText = '待测正文不可首轮注入'.repeat(600).slice(0, 6000);
  const resultText = '真实结果正文不可首轮注入'.repeat(600).slice(0, 6000);
  assert.equal(materialText.length, 6000); assert.equal(resultText.length, 6000);
  longCanvas.nodes.find(node => node.id === 'Material')!.values = { content: materialText };
  const longConfig = compileS2PublicCanvas(pack, longCanvas, { goal: config.definition.goal, instructions: config.definition.instructions });
  const resultId = 'artifact-LongDisclosureInspection';
  const resultContext = { outputIndex: [{ nodeId: 'Test', portId: 'text', type: { id: 'core.text', version: 1 }, artifactIds: [resultId], state: 'available' }],
    artifactCatalog: [{ id: resultId, type: { id: 'core.text', version: 1 }, source: { nodeId: 'Test' } }] } as unknown as NonNullable<S2InteractionOptions['pluginContext']>;
  bindS2ArtifactContext(resultContext, { output: () => [resultId], read: () => ({ protocolVersion: 1, id: resultId, complete: true,
    type: { id: 'core.text', version: 1 }, source: { sceneId: 'synthetic', runId: 'synthetic', nodeId: 'Test', revision: 0, kind: 'host' }, payload: { kind: 'inline', value: resultText } }) });
  const long = await capture(oldInput.task, false, { ...longConfig, pluginContext: resultContext });
  assert.equal(long.requests.length, 1); const longRequest = long.requests[0];
  assert(!longRequest.rawInput.includes(materialText.slice(0, 80))); assert(!longRequest.rawInput.includes(resultText.slice(0, 80)));
  assert.equal(longRequest.input.context.canvas.representation, 'public-index');
  assert.equal(longRequest.input.context.resultDetails, undefined, 'Result text is not automatically preloaded');
  assert.equal(JSON.stringify(config), configSnapshot); assert.equal(forbiddenNetworkCalls, 0);

  const reconstructedEditInput = { ...structuredClone(oldInput), task: editTask };
  const reconstructedEdit = { system: oldSystem, rawInput: JSON.stringify(reconstructedEditInput) };
  const normalAfter = count(normal.requests[0]);
  const fullSystem = normal.requests[0].system;
  const systemParagraphs = fullSystem.split('\n').map((text, index) => ({ index: index + 1, chars: text.length, text }));
  const systemSeparators = systemParagraphs.length - 1;
  assert.equal(systemParagraphs.reduce((sum, paragraph) => sum + paragraph.chars, systemSeparators), normalAfter.systemChars,
    'Count actual generated paragraphs, without assuming a constant protocol/fact/execution concatenation');
  const editAfter = editing.requests.map(count);
  const editCumulative = editAfter.reduce((sum, item) => ({ systemChars: sum.systemChars + item.systemChars,
    inputChars: sum.inputChars + item.inputChars, totalChars: sum.totalChars + item.totalChars }), { systemChars: 0, inputChars: 0, totalChars: 0 });
  const explanationReadPerCall = explanationRead.requests.map(count);
  const explanationReadCumulative = explanationReadPerCall.reduce((sum, item) => ({ systemChars: sum.systemChars + item.systemChars,
    inputChars: sum.inputChars + item.inputChars, totalChars: sum.totalChars + item.totalChars }), { systemChars: 0, inputChars: 0, totalChars: 0 });
  assert.deepEqual(normal.requests[0].input, scopedBefore.immediateBefore.normal.requests[0].input,
    'Scope-aware prompt generation cannot hide protocol text by relocating it into the initial input');
  const comparison = {
    measuredAt: new Date().toISOString(),
    counting: 'UTF-16 string.length; compact transport JSON; not tokens, UTF-8 bytes or formatted-file length. Counted at the actual invokeS2InteractionModel callback.',
    fixture: 'Identical five-block prompt scene, same positions/values/connections/goal/strategies, no selection/results/resources and the same two short history messages.',
    previousProgressive: { calls: 1, systemChars: 572, inputChars: 1865, totalChars: 2437,
      source: 'Historical actual v1 capture frozen in output/scene-s2-interaction-context-inspection/progressive-v1/; component and manual disclosure only, current values still preloaded.' },
    systemComposition: { mode: 'actual-scope-and-data-generated-message', totalChars: normalAfter.systemChars,
      paragraphs: systemParagraphs, separators: systemSeparators,
      note: 'Every paragraph in the real transport message is counted. No fixed constant/execution-rule concatenation is assumed. Applicable edit formats remain in the measured recalled input only after their complete rules are read.' },
    scopedPrompt: {
      fixtureSource: 'scripts/fixtures/s2-interaction-context-before-scoped.json',
      immediateBefore: { calls: 1, ...count(scopedBefore.immediateBefore.normal.requests[0]) },
      after: { calls: 1, ...normalAfter },
      saved: { system: saved(scopedBefore.immediateBefore.normal.requests[0].system.length, normalAfter.systemChars),
        input: saved(scopedBefore.immediateBefore.normal.requests[0].rawInput.length, normalAfter.inputChars),
        total: saved(count(scopedBefore.immediateBefore.normal.requests[0]).totalChars, normalAfter.totalChars) },
      historical634: { before: { calls: 1, ...count(scopedBefore.saved634.normal) }, after: { calls: 1, ...normalAfter },
        note: 'The current execution:on-demand context marker was already present in the immediate 701-character baseline; it was absent from the older 634 capture.' },
      sameTaskRead: { before: scopedBefore.immediateBefore.explanationRead.cumulative, after: explanationReadCumulative },
      editing: { before: scopedBefore.immediateBefore.editing.cumulative, after: editCumulative },
      initialInputUnchangedFromImmediateBefore: true,
      variants: {
        replyOnly: { scope: replyOnly.requests[0].input.scope, ...count(replyOnly.requests[0]) },
        editWithoutExecute: { scope: editOnly.requests[0].input.scope, ...count(editOnly.requests[0]) },
        note: 'Separate scope variants on the same source scene. They are not mixed into normal or two-round cumulative counts.',
      },
    },
    systemSlimming: {
      published995: { before: systemBefore.prompt995.counts, after: { calls: 1, ...normalAfter },
        saved: { system: saved(systemBefore.prompt995.counts.systemChars, normalAfter.systemChars),
          input: saved(systemBefore.prompt995.counts.inputChars, normalAfter.inputChars), total: saved(systemBefore.prompt995.counts.totalChars, normalAfter.totalChars) },
        sameTaskRead: { before: systemBefore.prompt995.explanationRead.cumulative, after: explanationReadCumulative },
        editing: { before: systemBefore.prompt995.editing.cumulative, after: editCumulative,
          note: 'Published 995-character historical capture; every current operation-guide character is included in the after total.' } },
      immediateBefore1052: { before: systemBefore.beforeSystemSlim.counts, after: { calls: 1, ...normalAfter },
        saved: { system: saved(systemBefore.beforeSystemSlim.counts.systemChars, normalAfter.systemChars),
          input: saved(systemBefore.beforeSystemSlim.counts.inputChars, normalAfter.inputChars), total: saved(systemBefore.beforeSystemSlim.counts.totalChars, normalAfter.totalChars) },
        note: 'Actual source just before system compression already contained a 57-character reminder and the concurrently introduced deferred action guide; its editing input is not claimed as the untouched prior implementation.' },
      fixtureSource: 'scripts/fixtures/s2-interaction-system-before-slim.json',
    },
    normal: { task: oldInput.task, before: { calls: 1, ...count(baseline), source: 'Frozen actual prior transport capture in scripts/fixtures/s2-interaction-context-before.json' },
      after: { calls: 1, ...normalAfter }, savedSincePreviousProgressive: { system: saved(572, normalAfter.systemChars), input: saved(1865, normalAfter.inputChars), total: saved(2437, normalAfter.totalChars) },
      saved: { system: saved(oldSystem.length, normalAfter.systemChars),
        input: saved(oldRawInput.length, normalAfter.inputChars), total: saved(count(baseline).totalChars, normalAfter.totalChars) } },
    explanationRead: { task: oldInput.task, calls: explanationRead.requests.length, perCall: explanationReadPerCall,
      cumulative: explanationReadCumulative, readRequest: explanationReadRequest,
      noteSynthetic: 'Same task, scene, scope and history as normal; both model responses are synthetic fixtures. First response requests only the Prompt.content value. Cumulative totals count each sent system and compact input, excluding model outputs.' },
    editing: { task: editTask, before: { calls: 1, ...count(reconstructedEdit),
      source: 'Reconstructed comparison: frozen prior system and input with only task changed; old engine was not rerun.' },
      after: { calls: editing.requests.length, perCall: editAfter, cumulative: editCumulative },
      deferredOperationGuide: { text: disclosed.actionGuide, chars: disclosed.actionGuide.length,
        serializedMemberChars: JSON.stringify('actionGuide').length + 1 + JSON.stringify(disclosed.actionGuide).length,
        note: 'Only included after the corresponding complete editable parameter rules are read; already counted in the second input and cumulative totals.' },
      cumulativeSaved: saved(count(reconstructedEdit).totalChars, editCumulative.totalChars),
      disclosedParameters: [{ componentId: 'content', parameters: ['content'] }],
      fieldAndLimitCheck: 'Only the requested content parameter is disclosed; its complete constraints/defaults deep-equal the frozen prior parameter and current public projection. Inputs/outputs and other interfaces are not sent; unified rules remain intact.' },
    longBodies: { task: oldInput.task, materialChars: materialText.length, resultChars: resultText.length, calls: 1, ...count(longRequest),
      bodiesInInitialRequest: false, note: 'Separate synthetic sample with 6000-character material and 6000-character existing result; not the same data as the before fixture and not a claimed before/after reduction.' },
    constraints: { packageGuideUnchanged: true, sceneUnchanged: true, callsSyntheticOnly: true, actualModelCalls: 0, networkCalls: 0, executionCalls: 0 },
  };
  if (write) {
    const after = path.join(folder, 'after');
    await saveCapture(beforeFolder, { ...baseline, input: oldInput, maxOutputTokens: 4096 }, true);
    await saveCapture(path.join(after, 'normal'), normal.requests[0]);
    await saveCapture(path.join(after, 'scope-reply-only'), replyOnly.requests[0]);
    await saveCapture(path.join(after, 'scope-edit-only'), editOnly.requests[0]);
    for (const [index, request] of explanationRead.requests.entries()) await saveCapture(path.join(after, `explanation-read-call-${index + 1}`), request);
    await saveCapture(path.join(after, 'long-bodies-index'), longRequest);
    for (const [index, request] of editing.requests.entries()) await saveCapture(path.join(after, `editing-call-${index + 1}`), request);
    await saveCapture(path.join(beforeFolder, 'editing-reconstructed'), { ...reconstructedEdit, input: reconstructedEditInput, maxOutputTokens: 4096 }, true);
    await writeFile(path.join(folder, 'comparison.json'), JSON.stringify(comparison, null, 2), 'utf8');
    await writeFile(path.join(folder, 'comparison.txt'), [
      '相同五块提示词实验场景：交互 Agent 渐进式披露前后对比',
      `普通解释：系统 ${oldSystem.length} -> ${normalAfter.systemChars}；输入 ${oldRawInput.length} -> ${normalAfter.inputChars}；总计 ${count(baseline).totalChars} -> ${normalAfter.totalChars} 字符（节省 ${comparison.normal.saved.total.percent}%）。`,
      `上一阶段渐进披露：系统572、输入1865、合计2437；本次合计 ${normalAfter.totalChars} 字符（中间阶段原文已冻结至 progressive-v1/）。`,
      `本轮按scope/数据裁剪：实际即时基线系统${count(scopedBefore.immediateBefore.normal.requests[0]).systemChars}、输入${count(scopedBefore.immediateBefore.normal.requests[0]).inputChars} → 系统${normalAfter.systemChars}、输入${normalAfter.inputChars}。首轮输入与即时基线逐项一致，未将系统说明挪入输入。`,
      `634字符为较早历史，实际原文冻结于prompt-634/；其输入1943未带后来增加的execution:on-demand。当前即时基线已是系统701、输入1967，原文冻结于before-scoped-prompt/，不把676或634冒称即时测量。`,
      `系统按实际生成的${systemParagraphs.length}段逐段计数：${systemParagraphs.map(paragraph => paragraph.chars).join('+')}，另加${systemSeparators}个换行；总计${normalAfter.systemChars}。无固定拼接假设。具体编辑格式已计入对应补读输入。`,
      `相同“解释当前画布”任务按需读正文：每轮 ${explanationReadPerCall.map(item => `系统${item.systemChars}+输入${item.inputChars}=${item.totalChars}`).join('；')}；累计系统${explanationReadCumulative.systemChars}、输入${explanationReadCumulative.inputChars}、合计${explanationReadCumulative.totalChars}。首轮与普通解释请求逐项相等；补读请求仅 read.values=[{nodeId:"Prompt",parameterIds:["content"]}]。`,
      '上述同任务补读由合成响应选择读取，仅统计实际发送的系统及紧凑输入正文，不包含模型返回字数；不是对真实模型是否会选择读取的评测。',
      `修改内容：旧请求 ${count(reconstructedEdit).totalChars} 字符；新请求 ${editAfter.map(item => item.totalChars).join(' + ')} = ${editCumulative.totalChars} 字符，${editing.requests.length} 次合成调用。`,
      '旧修改请求仅替换冻结输入的 task 重建，并未运行旧引擎。所有计数为实际传输正文的 UTF-16 字符数，不是 tokens；格式化缩进不计入。',
      `另一个长正文样本：6000字资料+6000字已有结果，首轮仅索引，系统${count(longRequest).systemChars}、输入${count(longRequest).inputChars}、合计${count(longRequest).totalChars}；与原样本数据不同，不作同比。`,
      '首轮不发送实例或结果正文，也没有actionGuide；编辑补读仅发送 content 参数的完整字段规则和默认值（与改造前深度相等）、统一字段说明及匹配的写值/配置新增格式，不附其他参数/输入/输出或接线格式。包说明及场景均未改写，未调用真实模型、网络或用户资料。',
    ].join('\n'), 'utf8');
  }
  console.log(JSON.stringify(comparison, null, 2));
} finally { globalThis.fetch = previousFetch; }
