import assert from 'node:assert/strict';
import { useLegacyS2Authoring } from './fixtures/s2-generic-canvas-ui';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import { createS2Scene, designS2Canvas, readS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { buildS2Design } from '../src/services/scene/sceneS2Design';
import { createS2DesignDisclosure, S2_DISCLOSURE_CONTINUE_PROMPT, S2_DISCLOSURE_NO_MORE_READS_PROMPT } from '../src/services/scene/sceneS2DesignDisclosure';
import { S2_BUILDER_CANVAS_RULES } from '../src/services/scene/sceneS2BuildContext';
import { describeSceneInteractionPack } from '../src/services/scene/sceneInteractionPackProtocol';
import { sceneInteractionPacks } from '../src/services/scene/sceneInteractionPacks';
import { s2BuiltinPluginRegistry, s2InstalledPluginCatalog } from '../src/services/scene/sceneS2PluginRegistry';
import { experimentDefinition } from './fixtures/s2-experiment';

// These saved native-protocol fixtures explicitly exercise the legacy adapter.
useLegacyS2Authoring();
globalThis.fetch = async () => assert.fail('Progressive disclosure checks never call network, actual models or personal sources');
const reference = { id: 'prompt-lab', version: '0.1.0' };
const scene = createS2Scene({ source: 'build', sceneSkill: 'S2', subject: '提示词渐进搭建', knowledgePoints: [],
  extraHints: '用户自行编辑和测试，助手按需帮助，不自动运行。', interactionPack: reference });
const current = readS2Scene(scene), before = JSON.stringify(scene);
const guide = describeSceneInteractionPack(sceneInteractionPacks.resolve(reference)), guideBefore = JSON.stringify(guide);
const catalog = s2InstalledPluginCatalog(reference), providers = s2BuiltinPluginRegistry().catalog();
const brief = { goal: '用户主导的提示词实验', requirements: [{ id: 'UserControl', source: 'task', quote: '用户自行编辑和测试', description: '用户主导实验' }],
  userRole: '编辑和确认测试', agentRole: '按需帮助', assumptions: [], openQuestions: [],
  delivery: { initial: '可操作的实验起点', deferred: '由用户编辑和测试', source: 'task', quote: '用户自行编辑和测试' } };
const candidate = structuredClone(experimentDefinition);
const response = (value: unknown): LlmCallResponse => ({ content: JSON.stringify(value) });
const selection = () => ({ read: { componentIds: ['compose', 'model-test'], sections: ['builder', 'combinations'], capabilities: candidate.plugins } });
const refs = (plugins: Array<{ id: string; version: string; capabilities: Array<{ id: string }> }>) => plugins.flatMap(plugin => plugin.capabilities.map(cap => `${plugin.id}@${plugin.version}/${cap.id}`)).sort();
const genericRefs = refs(s2InstalledPluginCatalog(null).plugins);
const recommendedRefs = [...candidate.plugins!,
  { pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-text' },
  { pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-image' },
].map(ref => `${ref.pluginId}@${ref.pluginVersion}/${ref.capabilityId}`).sort();
const componentIds = ['content', 'compose', 'model-test', 'result', 'material'];
function assertComposeReadProtocol(request: LlmCallRequest, callsRemaining: number, readsRemaining: number) {
  const input = JSON.parse(request.userInput), system = request.systemPromptOverride!;
  assert.equal(input.disclosurePhase, 'compose');
  assert.equal(input.modelCallsRemaining, callsRemaining, 'Remaining calls include every dispatched model request and exclude the current one');
  assert.equal(input.contextReadsRemaining, readsRemaining, 'Usable reads must reserve a subsequent compose call and any required review');
  if (readsRemaining > 0) {
    assert(system.includes(S2_DISCLOSURE_CONTINUE_PROMPT), 'A stateless compose/repair request must explain how to request more declarations');
    assert(!system.includes(S2_DISCLOSURE_NO_MORE_READS_PROMPT));
    for (const field of ['componentIds', 'sections', 'capabilities']) assert(system.includes(field), `Continuation request schema must include ${field}`);
    assert.match(S2_DISCLOSURE_CONTINUE_PROMPT, /只读|不执行/u);
    assert.match(S2_DISCLOSURE_CONTINUE_PROMPT, /不.*混|不能.*混/u, 'Read-only requests cannot be mixed with a scene or patch');
  } else {
    assert(system.includes(S2_DISCLOSURE_NO_MORE_READS_PROMPT), 'A final compose/repair request must explicitly stop further declaration reads');
    assert(!system.includes(S2_DISCLOSURE_CONTINUE_PROMPT));
    assert(S2_DISCLOSURE_NO_MORE_READS_PROMPT.includes('read'));
    assert(S2_DISCLOSURE_NO_MORE_READS_PROMPT.includes('blueprintRead'));
    assert.match(S2_DISCLOSURE_NO_MORE_READS_PROMPT, /禁止|不得|不能/u);
  }
}
const calls: LlmCallRequest[] = [];
const built = await designS2Canvas(scene, { invoke: async request => {
  calls.push(structuredClone(request)); const input = JSON.parse(request.userInput);
  assert.equal(input.sources.task, scene.task);
  if (input.stage === 'understand') { assert.equal(input.discoveryIndex, undefined); return response(brief); }
  if (input.disclosurePhase === 'select') {
    assert.deepEqual(refs(input.discoveryIndex.plugins), recommendedRefs, 'The prompt package exposes only its five supported building capabilities');
    assert.deepEqual(input.discoveryIndex.components.map((component: any) => component.id), componentIds);
    assert.deepEqual(input.discoveryIndex.components, guide.components.map(({ id, name, purpose }) => ({ id, name, purpose })));
    assert.equal(input.interactionPack, undefined); assert.equal(input.pluginCatalog, undefined); assert.equal(input.current, undefined);
    assert(!request.systemPromptOverride!.includes(S2_BUILDER_CANVAS_RULES));
    assert(!request.systemPromptOverride!.includes(guide.builder.assemble));
    assert(!request.systemPromptOverride!.includes(S2_DISCLOSURE_CONTINUE_PROMPT));
    assert(!request.systemPromptOverride!.includes(S2_DISCLOSURE_NO_MORE_READS_PROMPT), 'Initial selection stays index-only without compose-stage instructions');
    for (const component of input.discoveryIndex.components) assert.deepEqual(Object.keys(component).sort(), ['id', 'name', 'purpose']);
    for (const plugin of input.discoveryIndex.plugins) for (const cap of plugin.capabilities) assert.deepEqual(Object.keys(cap).sort(), ['id', 'kind', 'meaning']);
    return response(selection());
  }
  assert.equal(input.disclosurePhase, 'compose'); assert(request.systemPromptOverride!.includes(S2_BUILDER_CANVAS_RULES));
  assertComposeReadProtocol(request, 1, 1);
  assert.deepEqual(input.interactionPack.components.map((component: any) => component.id), ['compose', 'model-test']);
  assert.equal(input.interactionPack.assistant, undefined); assert.equal(input.interactionPack.operations, undefined);
  assert.equal(input.interactionPack.builder, undefined, 'Read assembly policy is compiled once, not repeated');
  assert.deepEqual(refs(input.pluginCatalog.plugins), candidate.plugins!.map(ref => `${ref.pluginId}@${ref.pluginVersion}/${ref.capabilityId}`).sort());
  assert.deepEqual(input.current, current); assert.deepEqual(input.designBrief, brief);
  return response(candidate);
} });
assert.deepEqual(calls.map(request => { const input = JSON.parse(request.userInput); return input.disclosurePhase ?? input.stage; }), ['understand', 'select', 'compose']);
assert.deepEqual(built.initial, candidate.initial); assert.equal(JSON.stringify(scene), before);

const wrongComponent = { read: { componentIds: ['human-input'], sections: ['builder'], capabilities: candidate.plugins } };
const correctedSelection = () => ({ read: { componentIds, sections: ['builder', 'combinations'], capabilities: candidate.plugins } });
const readRetryCalls: LlmCallRequest[] = [];
const afterReadRetry = await designS2Canvas(scene, { invoke: async request => {
  readRetryCalls.push(structuredClone(request)); const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(brief);
  if (input.disclosurePhase === 'select') {
    assert.deepEqual(input.discoveryIndex.components.map((component: any) => component.id), componentIds);
    assert.deepEqual(refs(input.discoveryIndex.plugins), recommendedRefs);
    assert.equal(input.current, undefined); assert.equal(input.interactionPack, undefined); assert.equal(input.pluginCatalog, undefined);
    assert(!request.systemPromptOverride!.includes(S2_BUILDER_CANVAS_RULES));
    assert(!request.systemPromptOverride!.includes(guide.builder.assemble));
    if (readRetryCalls.length === 2) { assert.equal(input.readRetry, undefined); return response(wrongComponent); }
    assert.equal(readRetryCalls.length, 3, 'Only one visible component-ID correction request is permitted');
    assert(input.readRetry && typeof input.readRetry === 'object', 'A corrective read stays an explicit index selection with readRetry evidence');
    assert.deepEqual(Object.keys(input.readRetry).sort(), ['code', 'componentId', 'message']);
    assert.equal(input.readRetry.code, 'COMPONENT_NOT_FOUND'); assert.equal(input.readRetry.componentId, 'human-input');
    assert.equal(typeof input.readRetry.message, 'string'); assert(input.readRetry.message.length > 0);
    for (const field of ['componentIds', 'sections', 'capabilities']) assert.deepEqual(input.readState?.[field] ?? [], [],
      'An invalid first read cannot partially publish components, policy or capabilities');
    assert.equal(input.readRetry.pluginCatalog, undefined); assert.equal(input.readRetry.interactionPack, undefined);
    return response(correctedSelection());
  }
  assert.equal(readRetryCalls.length, 4); assertComposeReadProtocol(request, 0, 0);
  assert.deepEqual(input.interactionPack.components.map((component: any) => component.id), componentIds);
  assert.deepEqual(input.readState.componentIds, componentIds);
  assert.deepEqual(refs(input.pluginCatalog.plugins), candidate.plugins!.map(ref => `${ref.pluginId}@${ref.pluginVersion}/${ref.capabilityId}`).sort());
  assert(!input.readState.componentIds.includes('human-input'));
  assert(!input.pluginCatalog.plugins.some((plugin: any) => plugin.id === 'human-input' || plugin.id === 'foreign'));
  return response(candidate);
} });
assert.deepEqual(readRetryCalls.map(request => { const input = JSON.parse(request.userInput); return input.disclosurePhase ?? input.stage; }),
  ['understand', 'select', 'select', 'compose']);
assert.deepEqual(afterReadRetry.initial, candidate.initial); assert.equal(JSON.stringify(scene), before);

let repeatedBadReadCalls = 0;
await assert.rejects(() => designS2Canvas(scene, { invoke: async request => {
  repeatedBadReadCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(brief);
  assert.equal(input.disclosurePhase, 'select', 'A second invalid selection must terminate before any compose request');
  assert.deepEqual(refs(input.discoveryIndex.plugins), recommendedRefs);
  if (repeatedBadReadCalls === 3) assert(input.readRetry);
  return response(wrongComponent);
} }), /不存在组件|组件说明.*不存在|Unknown component/u);
assert.equal(repeatedBadReadCalls, 3); assert.equal(JSON.stringify(scene), before);

for (const [name, readResponse, pattern] of [
  ['unread', { read: { sections: ['builder'], capabilities: [candidate.plugins![0]] } }, /接口详情尚未提供/],
  ['missing-builder', { read: { capabilities: candidate.plugins } }, /builder/],
  ['mixed', { ...selection(), version: 1 }, /不能混合/],
  ['foreign', { read: { sections: ['builder'], capabilities: [{ pluginId: 'foreign', pluginVersion: '1.0.0', capabilityId: 'run' }] } }, /目录范围/],
  ['skipped-discovery', candidate, /先选择读取/],
  ['duplicate-component', { read: { componentIds: ['compose', 'compose'], sections: ['builder'], capabilities: candidate.plugins } }, /重复/],
  ['duplicate-capability', { read: { sections: ['builder'], capabilities: [candidate.plugins![0], candidate.plugins![0]] } }, /重复/],
  ['unknown-component-with-foreign', { read: { componentIds: ['human-input'], sections: ['builder'],
    capabilities: [{ pluginId: 'foreign', pluginVersion: '1.0.0', capabilityId: 'run' }] } }, /目录范围|能力/],
] as const) {
  let count = 0;
  await assert.rejects(() => designS2Canvas(scene, { invoke: async request => {
    count++; const input = JSON.parse(request.userInput);
    return response(input.stage === 'understand' ? brief : input.disclosurePhase === 'select' ? readResponse : candidate);
  } }), pattern);
  assert.equal(count, name === 'unread' ? 3 : 2, 'Rejected reads/candidates do not trigger hidden extra calls');
  assert.equal(JSON.stringify(scene), before);
}

const extra = { pluginId: 'local-material', pluginVersion: '1.0.0', capabilityId: 'read-text' };
let incremental = 0;
await designS2Canvas(scene, { invoke: async request => {
  incremental++; const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(brief);
  if (input.disclosurePhase === 'select') return response(selection());
  if (incremental === 3) {
    assertComposeReadProtocol(request, 1, 1);
    return response({ read: { componentIds: ['result'], capabilities: [extra], sections: ['assistant'] } });
  }
  assertComposeReadProtocol(request, 0, 0);
  assert.deepEqual(input.interactionPack.components.map((component: any) => component.id), ['compose', 'model-test', 'result']);
  assert.equal(input.interactionPack.assistant.instructions, guide.assistant.instructions);
  assert.equal(refs(input.pluginCatalog.plugins).length, 4, 'Earlier selections persist across the second read');
  return response(candidate);
} });
assert.equal(incremental, 4);

let reviewedCalls = 0, reviewRounds = 0, reviewedAssemblies = 0;
const improved = structuredClone(candidate); improved.instructions.response += ' 保留用户主导并按需解释。';
const reviewed = await designS2Canvas(scene, { review: true, invoke: async request => {
  reviewedCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(brief);
  if (input.disclosurePhase === 'select') return response(selection());
  if (input.stage === 'assemble') {
    reviewedAssemblies++;
    assertComposeReadProtocol(request, reviewedAssemblies === 1 ? 3 : 1, reviewedAssemblies === 1 ? 1 : 0);
    assert.equal(refs(input.pluginCatalog.plugins).length, 3, 'Chosen interfaces remain available during semantic repair');
    assert.deepEqual(input.interactionPack.components.map((component: any) => component.id), ['compose', 'model-test']);
    return response(reviewedAssemblies === 1 ? candidate : improved);
  }
  reviewRounds++;
  const revise = reviewRounds === 1;
  return response({ verdict: revise ? 'revise' : 'accept', factChecks: [], feedback: '合成审查：保持用户主导',
    coverage: brief.requirements.map(item => ({ requirementId: item.id, status: revise ? 'missing' : 'covered', evidencePaths: ['/instructions/response'],
      ...(revise ? { evidenceQuotes: [{ path: '/instructions/response', quote: candidate.instructions.response }] } : {}), reason: '合成策略审查，仅验证调用边界' })) });
} });
assert.equal(reviewedCalls, 6); assert.equal(reviewRounds, 2); assert.equal(reviewedAssemblies, 2);
assert.equal(reviewed.instructions.response, improved.instructions.response);

let excessReads = 0;
await assert.rejects(() => designS2Canvas(scene, { invoke: async request => {
  excessReads++; const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(brief);
  return response(input.disclosurePhase === 'select' ? selection() : { read: { capabilities: [extra] } });
} }), /最多读取两批/);
assert.equal(excessReads, 4);

let capped = 0;
await assert.rejects(() => designS2Canvas(scene, { invoke: async request => {
  capped++; const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(brief);
  if (input.disclosurePhase === 'compose') assertComposeReadProtocol(request, capped === 3 ? 1 : 0, capped === 3 ? 1 : 0);
  if (input.disclosurePhase === 'select') return response(selection());
  return response(capped === 3 ? { ...candidate, version: 99 } : { read: { capabilities: [extra] } });
} }), /4次请求上限/);
assert.equal(capped, 4, 'A read during protocol repair is counted inside the same hard dispatch cap');

// A real format-repair dispatch consumes the same finite call budget. The next
// independent compose request must not advertise a read it cannot complete.
let selectionFormatCalls = 0;
await designS2Canvas(scene, { invoke: async request => {
  selectionFormatCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(brief);
  if (input.disclosurePhase === 'select') {
    assert.equal(input.interactionPack, undefined); assert.equal(input.pluginCatalog, undefined);
    if (selectionFormatCalls === 2) return { content: '{"read":' };
    assert.equal(selectionFormatCalls, 3); assert.equal(input.jsonFormatRepair.previousOutput, '{"read":');
    return response(selection());
  }
  assertComposeReadProtocol(request, 0, 0);
  return response(candidate);
} });
assert.equal(selectionFormatCalls, 4, 'Format repair plus discovery and compose share the existing hard call ceiling');

let retryAfterFormatCalls = 0;
await assert.rejects(() => designS2Canvas(scene, { invoke: async request => {
  retryAfterFormatCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(brief);
  assert.equal(input.disclosurePhase, 'select');
  if (retryAfterFormatCalls === 2) return { content: '{"read":' };
  assert.equal(retryAfterFormatCalls, 3, 'A read correction cannot dispatch without reserving the following compose request');
  return response(wrongComponent);
} }), /不存在组件|组件说明.*不存在|请求上限|请求额度|Unknown component/u);
assert.equal(retryAfterFormatCalls, 3); assert.equal(JSON.stringify(scene), before);

let composeFormatCalls = 0;
const brokenCandidateJson = JSON.stringify(candidate) + ',}';
await designS2Canvas(scene, { invoke: async request => {
  composeFormatCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(brief);
  if (input.disclosurePhase === 'select') return response(selection());
  if (composeFormatCalls === 3) {
    assertComposeReadProtocol(request, 1, 1);
    return { content: brokenCandidateJson };
  }
  assertComposeReadProtocol(request, 0, 0);
  assert.equal(input.jsonFormatRepair.previousOutput, brokenCandidateJson, 'Format repair receives the unchanged complete prior draft');
  assert.deepEqual(refs(input.pluginCatalog.plugins), candidate.plugins!.map(ref => `${ref.pluginId}@${ref.pluginVersion}/${ref.capabilityId}`).sort());
  return response(candidate);
} });
assert.equal(composeFormatCalls, 4, 'A compose-format repair keeps read details but cannot offer another unfinishable read');

for (const failure of ['transport', 'truncated', 'abort'] as const) {
  let count = 0; const controller = new AbortController();
  await assert.rejects(() => designS2Canvas(scene, { signal: controller.signal, invoke: async request => {
    count++; if (JSON.parse(request.userInput).stage === 'understand') return response(brief);
    if (failure === 'transport') throw new Error('Synthetic transport failure');
    if (failure === 'abort') controller.abort();
    return { ...response(selection()), ...(failure === 'truncated' ? { diagnostics: { finishReason: 'length' } } : {}) };
  } }), failure === 'transport' ? /transport/ : failure === 'truncated' ? /截断/ : /停止/);
  assert.equal(count, 2);
}

const plain = createS2Scene({ source: 'build', sceneSkill: 'S2', subject: '纯内容画布', knowledgePoints: [], interactionPack: null });
let plainCount = 0;
await designS2Canvas(plain, { invoke: async request => {
  plainCount++; const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response({ ...brief, requirements: [{ id: 'Content', source: 'subject', quote: '纯内容画布', description: '仅内容' }],
    delivery: { initial: '纯内容画布', deferred: '无', source: 'subject', quote: '纯内容画布' } });
  if (input.disclosurePhase === 'select') {
    assert.deepEqual(refs(input.discoveryIndex.plugins), genericRefs, 'A generic canvas without a package keeps its full original installed capability scope');
    return response({ read: {} });
  }
  assert.deepEqual(input.pluginCatalog.plugins, []); assert.equal(input.interactionPack, undefined);
  return response(readS2Scene(plain));
} });
assert.equal(plainCount, 3);

const sources = { task: scene.task, subject: scene.meta.subject, currentGoal: current.goal, currentPolicy: JSON.stringify(current.instructions), knowledgePointTitles: [] };
let blueprintReads = 0, blueprintCompiles = 0, blueprintCalls = 0;
await buildS2Design({ sources, current, packageGuide: guide, builderPolicy: guide.builder, pluginCatalog: {}, readDefinition: readS2Definition,
  disclosure: createS2DesignDisclosure({ catalog, allTypeProviders: providers, guide }),
  blueprints: { index: [{ id: 'synthetic-blueprint', version: '1.0.0' }], rules: '合成蓝图接口，仅核对合批读取，不代表真实蓝图效果。',
    read(raw) { blueprintReads++; assert.deepEqual(raw, { blueprintRead: [{ id: 'synthetic-blueprint', version: '1.0.0' }] });
      return { interfaces: [{ requiredCapabilities: candidate.plugins }, { requiredCapabilities: candidate.plugins }], complete: true }; },
    compile(raw) { blueprintCompiles++; return structuredClone(raw) as Record<string, unknown>; } },
  call: async (_prompt, data) => {
    blueprintCalls++; const input = data as any;
    if (input.stage === 'understand') return structuredClone(brief) as any;
    if (input.disclosurePhase === 'select') return { read: { sections: ['builder'] }, blueprintRead: [{ id: 'synthetic-blueprint', version: '1.0.0' }] };
    assert.equal(refs(input.pluginCatalog.plugins).length, 3, 'Blueprint required capabilities are included once without extra model round');
    assert.equal(input.blueprintReadAvailable, false); return structuredClone(candidate) as any;
  },
});
assert.equal(blueprintReads, 1); assert.equal(blueprintCompiles, 1); assert.equal(blueprintCalls, 3);

let badBlueprintReads = 0, badBlueprintCalls = 0;
await assert.rejects(() => buildS2Design({ sources, current, packageGuide: guide, builderPolicy: guide.builder, pluginCatalog: {}, readDefinition: readS2Definition,
  disclosure: createS2DesignDisclosure({ catalog, allTypeProviders: providers, guide }),
  blueprints: { index: [{ id: 'synthetic-blueprint', version: '1.0.0' }], rules: '合成蓝图接口，检查错误选读不会重放蓝图读取。',
    read() { badBlueprintReads++; return { interfaces: [{ requiredCapabilities: candidate.plugins }], complete: true }; },
    compile() { assert.fail('An invalid blueprint/component read cannot reach candidate compilation'); } },
  call: async (_prompt, data) => {
    badBlueprintCalls++; const input = data as any;
    if (input.stage === 'understand') return structuredClone(brief) as any;
    assert.equal(badBlueprintCalls, 2, 'A failed batch containing blueprintRead is never silently replayed');
    return { ...wrongComponent, blueprintRead: [{ id: 'synthetic-blueprint', version: '1.0.0' }] };
  },
}), /不存在组件/u);
assert.equal(badBlueprintCalls, 2); assert.equal(badBlueprintReads, 1, 'Already-read blueprint declarations are not read again during a component correction');
assert.equal(JSON.stringify(scene), before); assert.equal(JSON.stringify(describeSceneInteractionPack(sceneInteractionPacks.resolve(reference))), guideBefore);
console.log(`S2 progressive default passed: true five-component prompt index-only discovery (${calls[1].systemPromptOverride!.length} system / ${calls[1].userInput.length} input chars), one visible unknown-component reselect within the unchanged 4-call ceiling, second-bad/foreign/mixed/duplicate denial without authority expansion, selected descriptions/interfaces, incremental reads, generic full-scope pure-content canvas, coalesced blueprint dependencies, review/format-repair caps and abort/truncation/transport isolation. No model/network/material execution.`);
