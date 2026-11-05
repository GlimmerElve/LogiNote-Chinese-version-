import assert from 'node:assert/strict';
import { applyS2DesignRepair } from '../src/services/scene/sceneS2DesignRepair';
import { createS2Scene, designS2Canvas as designS2CanvasImplementation, readS2Scene, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import type { S2CanvasDefinition } from '../src/types/sceneS2';
import { s2DesignBindingIssues, s2DesignConnectionIssues } from '../src/services/scene/sceneS2Design';
import { syntheticS2Business } from './fixtures/s2-business-model';
import { fitSceneContextBudget, SceneContextBudgetError, withSceneContextBudget } from '../src/services/scene/sceneContextBudget';
import { readS2Workflow } from '../src/services/scene/sceneS2Workflow';
import { S2PluginProtocolError } from '../src/services/scene/sceneS2PluginProtocol';
import type { LlmCallRequest } from '../src/types';
import { withS2DesignContext } from './fixtures/s2-design-context';
import { S2_BUILDER_CANVAS_RULES } from '../src/services/scene/sceneS2BuildContext';

// Historical complete-context repair cases retain their original, fully counted request sequence.
const designS2Canvas = (...[scene, options]: Parameters<typeof designS2CanvasImplementation>) => designS2CanvasImplementation(scene, { ...options, review: true, disclosure: 'complete' });

await withS2DesignContext(131072, async () => {
globalThis.fetch = async () => assert.fail('S2 design repair checks must not use network, notes or profiles');
const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成练习', knowledgePoints: [], extraHints: '先提示再协作；不要自动运行' });
const legacyCurrent = readS2Scene(scene);
const current = { ...legacyCurrent, business: syntheticS2Business(legacyCurrent, { requirements: [{ id: 'hint' }] } as any) }, snapshot = JSON.stringify(current);
const badBindings = { initial: { execution: { nodes: [
  { id: 'wrongTable', pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'to-table', bindings: { value: { kind: 'field', nodeId: 'input', fieldId: 'text' } } },
  { id: 'wrongSim', pluginId: 'workflow-simulation', pluginVersion: '1.0.0', capabilityId: 'step', bindings: { input: { kind: 'field', nodeId: 'input', fieldId: 'text' } } },
], links: [{ source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'wrongTable', portId: 'value' } }] } } };
const bindingSnapshot = JSON.stringify(badBindings), bindingIssues = s2DesignBindingIssues(badBindings) as any[];
assert.equal(bindingIssues.length, 2);
assert.equal(bindingIssues[0].bindingPath, '/initial/execution/nodes/0/bindings/value');
assert.deepEqual(bindingIssues[0].incomingLinkPaths, ['/initial/execution/links/0']);
assert.equal(bindingIssues[1].bindingPath, '/initial/execution/nodes/1/bindings/input');
const duplicateSource = structuredClone(badBindings) as any;
duplicateSource.initial.execution.nodes[0].bindings.value = { kind: 'literal', value: [] };
assert.equal((s2DesignBindingIssues(duplicateSource)[0] as any).issue, 'multiple-input-sources');
assert.equal(JSON.stringify(badBindings), bindingSnapshot, 'Diagnostics cannot apply a patch or run anything');
const bothScopes = { ...badBindings, business: { completion: { reference: structuredClone(badBindings.initial) } } };
const scopedIssues = s2DesignBindingIssues(bothScopes) as any[];
assert.equal(scopedIssues.length, 4);
assert.equal(scopedIssues[2].bindingPath, '/business/completion/reference/execution/nodes/0/bindings/value');
assert.deepEqual(scopedIssues[2].incomingLinkPaths, ['/business/completion/reference/execution/links/0']);
const fakeLink = structuredClone(bothScopes) as any;
fakeLink.business.completion.reference.execution.nodes[0].bindings.value = { kind: 'link', nodeId: 'parse', portId: 'value' };
const fakeIssue = (s2DesignBindingIssues(fakeLink) as any[]).find(issue => issue.bindingPath === '/business/completion/reference/execution/nodes/0/bindings/value');
assert.equal(fakeIssue.issue, 'unsupported-binding-kind'); assert.match(fakeIssue.rule, /不支持kind=link/);
assert.equal((s2DesignBindingIssues({ business: bothScopes.business }) as any[]).length, 2, 'Private reference is checked even without a public initial graph');
for (const malformed of [null, {}, { initial: { execution: { nodes: [null, {}, { bindings: {} }], links: [null] } } }]) assert.doesNotThrow(() => s2DesignBindingIssues(malformed));
const patch = (...operations: unknown[]) => ({ repair: { operations } });
const wrongControl = { initial: { execution: { version: 1, nodes: [
  { id: 'confirm', pluginId: 'human-input', pluginVersion: '1.0.0', capabilityId: 'confirm', bindings: {} },
  { id: 'text', pluginId: 'text-template', pluginVersion: '1.0.0', capabilityId: 'render', bindings: {} },
], links: [{ source: { nodeId: 'confirm', portId: 'decision' }, target: { nodeId: 'text', portId: 'template' } }] } } };
const wrongBoth = { ...wrongControl, business: { completion: { reference: structuredClone(wrongControl.initial) } } };
const controlSnapshot = JSON.stringify(wrongBoth), connectionIssues = s2DesignConnectionIssues(wrongBoth) as any[];
assert.equal(connectionIssues.length, 2); assert.equal(connectionIssues[0].linkPath, '/initial/execution/links/0');
assert.equal(connectionIssues[1].linkPath, '/business/completion/reference/execution/links/0');
assert.deepEqual(connectionIssues[0].source.type, { id: 'human-input.decision', version: 1 });
assert.deepEqual(connectionIssues[0].target.type, { id: 'core.text', version: 1 });
assert.match(connectionIssues[0].rule, /不只是执行顺序箭头/); assert.match(connectionIssues[0].rule, /when/);
assert.equal(JSON.stringify(wrongBoth), controlSnapshot);
const conditionalOnly = structuredClone(wrongControl) as any;
conditionalOnly.initial.execution.links = [];
conditionalOnly.initial.execution.nodes[1].bindings = { template: { kind: 'literal', value: '合成正文' }, variables: { kind: 'literal', value: {} } };
conditionalOnly.initial.execution.nodes[1].when = { nodeId: 'confirm', portId: 'decision', pointer: '/approved', equals: true, match: true };
assert.deepEqual(s2DesignConnectionIssues(conditionalOnly), [], 'A genuine control condition is not a mismatched data link');
for (const malformed of [null, {}, { initial: { execution: { nodes: [null], links: [null, {}, { source: {}, target: {} }] } } }]) assert.doesNotThrow(() => s2DesignConnectionIssues(malformed));
const materialCandidate = { ...structuredClone(wrongBoth), blockTypes: [{ id: 'text', fields: [{ id: 'body' }] }] } as any;
materialCandidate.initial.nodes = [{ id: 'publicText', type: 'text', values: { body: 'SYNTHETIC_MATERIAL_MUST_NOT_BE_COPIED_TO_DIAGNOSTICS' } }];
materialCandidate.business.completion.reference.nodes = [{ id: 'privateText', type: 'text', values: { body: 'SYNTHETIC_PRIVATE_MATERIAL' } }];
const replacementIssues = s2DesignConnectionIssues(materialCandidate) as any[];
for (const [index, id] of ['publicText', 'privateText'].entries()) {
  const state = replacementIssues[index].afterRemovingLink;
  assert.equal(state.requiredInputWithoutDeclaredSource, true); assert.equal(state.bindingPresent, false);
  assert.deepEqual(state.typeCompatibleCandidates, [{ kind: 'field', nodeId: id, fieldId: 'body' }]);
  assert.equal(state.candidateIndexOmitted, false);
}
assert(!JSON.stringify(replacementIssues).includes('SYNTHETIC_'), 'Candidate discovery returns identities, never material values or private answers');
const shifted = structuredClone(materialCandidate);
shifted.initial.execution.nodes.unshift(null);
assert.equal((s2DesignConnectionIssues(shifted)[0] as any).afterRemovingLink.bindingPath, '/initial/execution/nodes/2/bindings/template', 'Malformed neighboring items must not shift real patch paths');
const alreadyBound = structuredClone(materialCandidate);
alreadyBound.initial.execution.nodes[1].bindings.template = { kind: 'literal', value: '' };
assert.equal((s2DesignConnectionIssues(alreadyBound)[0] as any).afterRemovingLink.requiredInputWithoutDeclaredSource, false, 'An existing empty-string literal is still a declared source');
const many = structuredClone(materialCandidate);
many.initial.nodes = Array.from({ length: 16 }, (_, i) => ({ id: `material${i}`, type: 'text', values: { body: 'not disclosed' } }));
many.initial.execution.links = Array.from({ length: 12 }, (_, i) => ({ source: { nodeId: 'confirm', portId: 'decision' }, target: { nodeId: `target${i}`, portId: 'template' } }));
many.initial.execution.nodes = [many.initial.execution.nodes[0], ...Array.from({ length: 12 }, (_, i) => ({ ...many.initial.execution.nodes[1], id: `target${i}` }))];
const bounded = s2DesignConnectionIssues(many) as any[];
assert(bounded.some(issue => issue.afterRemovingLink.candidateIndexOmitted));
const candidateLists = bounded.flatMap(issue => issue.afterRemovingLink.typeCompatibleCandidates);
assert(candidateLists.length <= 24); assert(candidateLists.reduce((sum, candidate) => sum + JSON.stringify(candidate).length, 0) <= 4000);
// The host still rejects removal-only repair; a chosen replacement plus the independent control condition is valid.
const completeDoc = structuredClone(materialCandidate.initial);
completeDoc.nodes[0].position = { x: 0, y: 0 };
completeDoc.execution.nodes.forEach((node: any) => { node.position = { x: 0, y: 0 }; });
completeDoc.execution.nodes[0].bindings = { prompt: { kind: 'literal', value: '是否继续？' } };
completeDoc.execution.nodes[1].bindings = { variables: { kind: 'literal', value: {} } };
completeDoc.execution.nodes[1].when = { nodeId: 'confirm', portId: 'decision', pointer: '/approved', equals: true, match: true };
completeDoc.execution.links = [];
const installed = completeDoc.execution.nodes.map(({ pluginId, pluginVersion, capabilityId }: any) => ({ pluginId, pluginVersion, capabilityId }));
assert.throws(() => readS2Workflow(completeDoc.execution, completeDoc, installed, true),
  error => error instanceof S2PluginProtocolError && error.code === 'MISSING_INPUT' && error.field === 'text.template');
completeDoc.execution.nodes[1].bindings.template = { kind: 'field', nodeId: 'publicText', fieldId: 'body' };
assert.doesNotThrow(() => readS2Workflow(completeDoc.execution, completeDoc, installed, true));
const replace = (path: string, value: unknown) => ({ op: 'replace', path, value });
const add = (path: string, value: unknown) => ({ op: 'add', path, value });
const remove = (path: string) => ({ op: 'remove', path });
const revised = applyS2DesignRepair(current, patch(replace('/instructions/response', '先提示，不给完整答案')));
assert.equal((revised.instructions as any).response, '先提示，不给完整答案');
assert.deepEqual(revised.initial, current.initial); assert.equal(JSON.stringify(current), snapshot);
assert.notEqual(revised.initial, current.initial, 'The repair candidate is detached from the original');
const withNode = applyS2DesignRepair(current, patch(add('/initial/nodes/-', { id: 'extra', type: 'text', position: { x: 100, y: 300 }, values: { content: '新增说明' } })));
assert.equal((withNode.initial as any).nodes.length, 2);
const inserted = applyS2DesignRepair(withNode, patch(add('/initial/nodes/1', { id: 'middle', type: 'text', position: { x: 20, y: 20 }, values: { content: '中间' } }), remove('/initial/nodes/0')));
assert.deepEqual((inserted.initial as any).nodes.map((n: any) => n.id), ['middle', 'extra']);
assert.equal(readS2Definition(inserted).initial.nodes.length, 2);
const objectAdded = applyS2DesignRepair(current, patch(add('/goal', '显式替换已有目标')));
assert.equal(objectAdded.goal, '显式替换已有目标'); assert.equal(JSON.stringify(current), snapshot);
const withLinks = { ...current, initial: { ...current.initial, execution: { version: 1, nodes: [], links: [] } } };
const linksAdded = applyS2DesignRepair(withLinks, patch(add('/initial/execution/links', [])));
assert.deepEqual((linksAdded.initial as any).execution.links, [], 'Adding an existing object member is a replacement, not an array insertion');
assert.deepEqual(readS2Definition(linksAdded).initial.execution, { version: 1, nodes: [], links: [] });
// Standard Pointer escaping is decoded exactly once, never as an expression or prototype traversal.
const raw = { initial: { 'a/b': { '~x': 'old' } } };
assert.equal(((applyS2DesignRepair(raw, patch(replace('/initial/a~1b/~0x', 'new'))).initial as any)['a/b'])['~x'], 'new');
for (const bad of [
  patch(), patch(...Array(13).fill(replace('/goal', 'x'))), { ...patch(replace('/goal', 'x')), goal: 'mixed full draft' },
  { repair: { operations: [], permissions: [] } }, patch({ op: ['replace'], path: '/goal', value: 'x' }),
  patch(replace('', 'x')), patch(replace('/', 'x')), patch(replace('/designBrief/goal', 'x')), patch(replace('/version', 2)),
  patch(add('/grant', {})), patch(add('/initial/__proto__/polluted', true)), patch(add('/initial/constructor/polluted', true)),
  patch(add('/initial/prototype', {})), patch(replace('/initial/unknown/field', 'x')), patch(replace('/initial/~3', 'x')),
  patch(replace('/initial/absent', 'x')), patch(remove('/initial/absent')),
  patch(replace('/initial/nodes/-', {})), patch(remove('/initial/nodes/-')), patch(add('/initial/nodes/9', {})),
  patch(add('/initial/nodes/01', {})), patch(replace('/initial/nodes/-1', {})), patch(replace('/initial/nodes/1e0', {})),
  patch({ op: 'remove', path: '/goal', value: null }), patch({ op: 'replace', path: '/goal' }),
  patch({ op: 'execute', path: '/initial', value: {} }), patch({ op: 'replace', path: '/goal', value: 'x', permission: 'network' }),
  patch(replace('/instructions/response', 'should not commit'), remove('/initial/missing')),
]) {
  assert.throws(() => applyS2DesignRepair(current, bad)); assert.equal(JSON.stringify(current), snapshot, 'All operations fail atomically');
}
assert.equal(({} as any).polluted, undefined);
const forged = applyS2DesignRepair(current, patch(add('/plugins', [{ pluginId: 'external', pluginVersion: '1', capabilityId: 'send' }])));
assert.throws(() => readS2Definition(forged), /未安装|允许/);
const cycle = applyS2DesignRepair(current, patch(add('/initial/edges/-', { id: 'bad', source: 'goal', target: 'goal', label: 'bad' })));
assert.throws(() => readS2Definition(cycle), /端点/);

const response = (content: unknown) => ({ content: JSON.stringify(content) });
const brief = { goal: '按原文目标搭建', requirements: [{ id: 'hint', source: 'task', quote: '先提示再协作', description: '先提示，再按明确委托协作' }],
  userRole: '学习者', agentRole: '协作教练', assumptions: [], openQuestions: [], delivery: { initial: '搭建协作起点', deferred: '先提示再协作', source: 'task', quote: '先提示再协作' } };
const review = (verdict: 'accept' | 'revise') => ({ verdict, factChecks: [], coverage: [{ requirementId: 'hint', status: verdict === 'accept' ? 'covered' : 'missing',
  evidencePaths: ['/instructions/response'], ...(verdict === 'revise' ? { evidenceQuotes: [{ path: '/instructions/response', quote: current.instructions.response }] } : {}),
  reason: '合成缺口：回复策略需先提示' }], feedback: '先提示，不给完整答案' });
// Regression for real dispatch failures: protect a complete large candidate/format output,
// but do not stack the entire first-assembly manual on top of it during repair.
const large = structuredClone(current);
large.initial.nodes[0].values.content = '合成材料'.repeat(1450);
large.business.completion.reference.nodes[0].values.content = '私有参考'.repeat(1450);
large.business.knowledge = [{ id: 'LargeKnowledge', title: '合成业务知识', content: '业务知识'.repeat(700) }];
readS2Definition(large);
let initialAssemblyRequest: LlmCallRequest | undefined, largeAssemblyRequest: LlmCallRequest | undefined;
for (const failure of ['protocol', 'json'] as const) {
  let count = 0, repairReached = false;
  const invalid = { ...large, initial: { ...large.initial, plugins: [] } };
  const previousOutput = JSON.stringify(large) + ',}';
  const result = await designS2Canvas(scene, { invoke: async request => {
    const input = JSON.parse(request.userInput);
    assert.equal(request.maxTokensOverride, input.stage === 'assemble' ? 16384 : 8192,
      'Initial and repaired stages keep the full output allowance for a complete large candidate');
    if (input.stage === 'understand') return response(brief);
    if (input.stage === 'assemble') {
      if (++count === 1) {
        initialAssemblyRequest ??= structuredClone(request);
        return failure === 'protocol' ? response(invalid) : { content: previousOutput };
      }
      repairReached = true;
      largeAssemblyRequest ??= structuredClone(request);
      assert.equal(request.maxTokensOverride, 16384, 'Protocol and JSON repairs must not fall back to a smaller assembly budget');
      if (failure === 'protocol') assert.deepEqual(input.previousCandidate, invalid);
      else assert.equal(input.jsonFormatRepair.previousOutput, previousOutput);
      const fitted = fitSceneContextBudget(request, { provider: { contextWindowTokens: 131072 } });
      assert.equal(fitted.diagnostics!.omittedContextIds.length, 0);
      assert.equal(fitted.diagnostics!.outputReserveTokens, 16384);
      assert.ok(request.systemPromptOverride!.includes(S2_BUILDER_CANVAS_RULES), 'Both repair paths retain the canvas declaration contract');
      assert.ok(!request.systemPromptOverride!.includes('S2自由组合规则'));
      assert.ok(!request.systemPromptOverride!.includes('S2插件协议v1'), 'Repairs omit local runtime bookkeeping instructions');
      return failure === 'protocol' ? response(patch(remove('/initial/plugins'))) : response(large);
    }
    return response(review('accept'));
  } });
  assert.equal(repairReached, true); assert.equal(count, 2);
  assert.equal(result.initial.nodes[0].values.content, large.initial.nodes[0].values.content);
  assert.deepEqual(result.business!.completion.reference, large.business.completion.reference);
}
// Compact declarations make room for the routine initial request at 64K.
// Rich legacy candidates use the actual estimated capacity, never clipping a
// protected source or reducing the output/safety reserve to make a fixture fit.
assert(initialAssemblyRequest); assert(largeAssemblyRequest);
const defaultRequestSnapshot = JSON.stringify(largeAssemblyRequest), defaultSceneSnapshot = JSON.stringify(scene);
let defaultDispatches = 0;
const defaultGuard = withSceneContextBudget(async () => { defaultDispatches++; return { content: '{}' }; }, { provider: null });
const defaultFit = fitSceneContextBudget(initialAssemblyRequest, { provider: null });
assert.equal(defaultFit.diagnostics!.capacitySource, 'local-planning-limit');
assert.equal(defaultFit.diagnostics!.contextWindowTokens, 65536);
assert.equal(defaultFit.diagnostics!.outputReserveTokens, 16384);
assert.equal(defaultFit.diagnostics!.safetyReserveTokens, 6554);
assert.deepEqual(defaultFit.diagnostics!.omittedContextIds, []);
assert.equal(defaultFit.request.userInput, initialAssemblyRequest.userInput);
await defaultGuard(initialAssemblyRequest); assert.equal(defaultDispatches, 1);
let richFit: ReturnType<typeof fitSceneContextBudget> | undefined;
try { richFit = fitSceneContextBudget(largeAssemblyRequest, { provider: null }); }
catch (error) {
  assert(error instanceof SceneContextBudgetError); assert.equal(error.code, 'protected-context-too-large');
  assert(error.diagnostics!.estimatedTotalTokens > error.diagnostics!.contextWindowTokens);
}
if (richFit) {
  assert.equal(richFit.request.userInput, largeAssemblyRequest.userInput);
  assert.equal(richFit.diagnostics!.outputReserveTokens, 16384);
  assert.equal(richFit.diagnostics!.safetyReserveTokens, 6554);
  assert.deepEqual(richFit.diagnostics!.omittedContextIds, []);
  await defaultGuard(largeAssemblyRequest);
  assert.equal(defaultDispatches, 2, 'A complete legacy request fitting the real 64K budget may dispatch');
} else {
  await assert.rejects(defaultGuard(largeAssemblyRequest), error => {
    assert(error instanceof SceneContextBudgetError); assert.equal(error.code, 'protected-context-too-large');
    assert.equal(error.diagnostics!.contextWindowTokens, 65536);
    assert.equal(error.diagnostics!.outputReserveTokens, 16384); assert.equal(error.diagnostics!.safetyReserveTokens, 6554);
    return true;
  });
  assert.equal(defaultDispatches, 1, 'A legacy request exceeding the real 64K budget cannot dispatch');
}
const dispatchesBeforeOversized = defaultDispatches;
const oversizedInput = JSON.parse(largeAssemblyRequest.userInput);
oversizedInput.sources.task += '\n' + '完整保留的合成需求'.repeat(5000);
const oversizedRequest = { ...largeAssemblyRequest, userInput: JSON.stringify(oversizedInput) };
const oversizedSnapshot = JSON.stringify(oversizedRequest);
await assert.rejects(defaultGuard(oversizedRequest), error => {
  assert(error instanceof SceneContextBudgetError); assert.equal(error.code, 'protected-context-too-large');
  assert.equal(error.diagnostics!.capacitySource, 'local-planning-limit'); assert.equal(error.diagnostics!.contextWindowTokens, 65536);
  assert.equal(error.diagnostics!.outputReserveTokens, 16384); assert.equal(error.diagnostics!.safetyReserveTokens, 6554);
  return true;
});
assert.equal(defaultDispatches, dispatchesBeforeOversized, 'Oversized protected sources do not reach the underlying invoker');
assert.equal(JSON.stringify(oversizedRequest), oversizedSnapshot);
assert.equal(JSON.stringify(largeAssemblyRequest), defaultRequestSnapshot);
assert.equal(JSON.stringify(scene), defaultSceneSnapshot); assert.equal(JSON.stringify(current), snapshot);
let assemblies = 0, reviews = 0; const stages: string[] = [];
const built = await designS2Canvas(scene, { invoke: async request => {
  const input = JSON.parse(request.userInput); stages.push(input.stage);
  if (input.stage === 'understand') return response(brief);
  assert.equal(input.designBrief.requirements[0].quote, '先提示再协作');
  if (input.stage === 'assemble') {
    assert.equal(request.maxTokensOverride, 16384, 'Semantic reassembly retains the same complete-design allowance');
    if (++assemblies === 1) return response(current);
    assert.equal(input.feedback.kind, 'semantic'); assert.equal(input.repairContext.origin, 'host-repair-context');
    assert.equal(input.repairContext.requirements[0].requirement.quote, '先提示再协作');
    assert.equal(input.repairContext.protocolFacts.executed, false);
    assert.ok(input.repairContext.evidencePathCatalog.includes('/instructions/response'));
    assert.deepEqual(input.previousCandidate, current);
    assert.ok(request.systemPromptOverride!.includes('可以重装配'));
    return response(patch(replace('/instructions/response', '先提示，不给完整答案')));
  }
  if (++reviews === 1) return response(review('revise'));
  assert.equal(input.candidate.instructions.response, '先提示，不给完整答案');
  assert.deepEqual(input.candidate.initial, current.initial); return response(review('accept'));
} });
assert.deepEqual(stages, ['understand', 'assemble', 'review', 'assemble', 'review']);
assert.deepEqual(built.designBrief, brief); assert.equal(JSON.stringify(current), snapshot);

// Repair a malformed hierarchy without silently normalizing it or regenerating unchanged content.
// This case checks the prompt pack's compact repair wording; the other repair cases remain generic S2.
let protocolAssemblies = 0;
await designS2Canvas({ ...scene, interactionPack: { id: 'prompt-lab', version: '0.1.0' } }, { invoke: async request => {
  const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(brief);
  if (input.stage === 'review') return response(review('accept'));
  if (++protocolAssemblies === 1) return response({ ...current, initial: { ...current.initial, plugins: [] },
    business: { ...current.business, completion: { ...current.business.completion, coverage: [] } } });
  assert.equal(input.feedback.kind, 'protocol'); assert.match(input.repairContext.protocolError, /plugins/);
  assert.ok(request.systemPromptOverride!.includes(S2_BUILDER_CANVAS_RULES));
  assert.ok(input.pluginCatalog.plugins.some((plugin: any) => plugin.id === 'workflow-merge'), 'The real merge contract remains available during repair');
  assert.match(request.systemPromptOverride!, /不顺带加入business、私有完成图、coverage/);
  assert.equal(input.repairContext.protocolFacts, undefined);
  assert.deepEqual(input.repairContext.businessDesignIssues.filter((issue: any) => issue.code === 'missing-requirement-coverage')
    .map((issue: any) => issue.requirementId), ['hint'], 'Fail-fast hierarchy error must not hide an independently known coverage omission');
  assert.equal(input.previousCandidate.business.completion.coverage.length, 0, 'Host reports missing coverage but never fills it for the Agent');
  return response(patch(remove('/initial/plugins'), add('/plugins', []),
    replace('/business/completion/coverage', current.business.completion.coverage)));
} });
assert.equal(protocolAssemblies, 2);
// A corrected component selection is allowed, but only the reviewed installed catalog passes.
let selections = 0;
const selected = await designS2Canvas(scene, { invoke: async request => {
  const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(brief);
  if (input.stage === 'review') return response(review(++selections === 1 ? 'revise' : 'accept'));
  return response(input.previousCandidate ? patch(add('/plugins', [{ pluginId: 'human-input', pluginVersion: '1.0.0', capabilityId: 'confirm' }])) : current);
} });
assert.equal(selected.plugins![0].pluginId, 'human-input', 'Patch is not locked to initial component selection and is not a runtime grant');
for (const mode of ['first-turn-patch', 'forged-plugin', 'bad-second-operation', 'change-brief'] as const) {
  let calls = 0;
  await assert.rejects(() => designS2Canvas(scene, { invoke: async request => {
    calls++; const input = JSON.parse(request.userInput);
    if (input.stage === 'understand') return response(brief);
    if (input.stage === 'review') return response(review('revise'));
    if (!input.previousCandidate) return response(mode === 'first-turn-patch' ? patch(replace('/goal', 'x')) : current);
    return response(mode === 'forged-plugin' ? patch(add('/plugins', [{ pluginId: 'external', pluginVersion: '1', capabilityId: 'send' }]))
      : mode === 'change-brief' ? patch(replace('/designBrief/goal', 'overwrite'))
      : patch(replace('/instructions/response', 'not committed'), remove('/initial/absent')));
  } }), /原画布未修改/);
  assert(calls <= 5); assert.equal(JSON.stringify(current), snapshot);
}
const controller = new AbortController(); let abortAssemblies = 0;
await assert.rejects(() => designS2Canvas(scene, { signal: controller.signal, invoke: async request => {
  const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(brief);
  if (input.stage === 'review') return response(review('revise'));
  if (++abortAssemblies === 1) return response(current);
  controller.abort(); return response(patch(replace('/instructions/response', 'not committed')));
} }), /停止/);
assert.equal(JSON.stringify(current), snapshot);
// A concatenated source quote repairs the UNACCEPTED brief once, before any component selection.
const briefStages: string[] = [];
const sourceFixed = await designS2Canvas(scene, { invoke: async request => {
  const input = JSON.parse(request.userInput); briefStages.push(input.stage);
  if (input.stage === 'understand') {
    assert.equal(input.pluginCatalog, undefined); assert.equal(input.current, undefined);
    if (briefStages.length === 1) return response({ ...brief, requirements: [{ ...brief.requirements[0], quote: '拼接的假引用' }] });
    assert.match(input.understandingFormatError, /引用不在原始输入/);
    assert.equal(input.previousBrief.requirements[0].quote, '拼接的假引用');
    return response(brief);
  }
  return response(input.stage === 'assemble' ? current : review('accept'));
} });
assert.deepEqual(briefStages, ['understand', 'understand', 'assemble', 'review']); assert.deepEqual(sourceFixed.designBrief, brief);
let repeatedBriefCalls = 0;
await assert.rejects(() => designS2Canvas(scene, { invoke: async () => {
  repeatedBriefCalls++; return response({ ...brief, requirements: [{ ...brief.requirements[0], quote: '拼接的假引用' }] });
} }), /引用不在原始输入/);
assert.equal(repeatedBriefCalls, 2, 'No unbounded semantic understanding retry');
let sharedCalls = 0;
await assert.rejects(() => designS2Canvas(scene, { invoke: async request => {
  sharedCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(input.previousBrief ? brief : { ...brief, requirements: [{ ...brief.requirements[0], quote: '拼接的假引用' }] });
  if (input.stage === 'assemble') return response(current);
  return response({ ...review('accept'), coverage: [] });
} }), /共享格式修复额度已用完/);
assert.equal(sharedCalls, 4, 'Brief and reviewer share one format-repair allowance; no extra model budget');
// Protocol formatting and substantive redesign each get one chance, inside the same SIX total calls.
let combinedAssemblies = 0, combinedReviews = 0; const combinedStages: string[] = [];
const combined = await designS2Canvas(scene, { invoke: async request => {
  const input = JSON.parse(request.userInput); combinedStages.push(input.stage);
  if (input.stage === 'understand') return response(brief);
  if (input.stage === 'review') {
    if (combinedReviews) assert.equal(input.previousSemanticReview.verdict, 'revise', 'Semantic repair reviewer receives its previous criteria');
    return response(review(++combinedReviews === 1 ? 'revise' : 'accept'));
  }
  if (++combinedAssemblies === 1) return response({ ...current, initial: { ...current.initial, plugins: [] } });
  if (combinedAssemblies === 2) { assert.equal(input.feedback.kind, 'protocol'); return response(patch(remove('/initial/plugins'))); }
  assert.equal(input.feedback.kind, 'semantic'); assert.equal(input.repairContext.requirements[0].requirement.quote, '先提示再协作');
  return response(patch(replace('/instructions/response', '先提示，不给完整答案')));
} });
assert.deepEqual(combinedStages, ['understand', 'assemble', 'assemble', 'review', 'assemble', 'review']);
assert.equal(combined.instructions.response, '先提示，不给完整答案');
let cappedCalls = 0, cappedAssemblies = 0;
await assert.rejects(() => designS2Canvas(scene, { invoke: async request => {
  cappedCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(input.previousBrief ? brief : { ...brief, requirements: [{ ...brief.requirements[0], quote: '不存在的引用' }] });
  if (input.stage === 'review') return response(review('revise'));
  if (++cappedAssemblies === 1) return response({ ...current, initial: { ...current.initial, plugins: [] } });
  if (cappedAssemblies === 2) return response(patch(remove('/initial/plugins')));
  return response(patch(replace('/instructions/response', '尚未验收，不可提交')));
} }), /6次请求上限.*原画布未修改/);
assert.equal(cappedCalls, 6); assert.equal(cappedAssemblies, 3); assert.equal(JSON.stringify(current), snapshot);
// A complete but malformed JSON response used to fail before the stage's schema-repair gate.
for (const brokenStage of ['understand', 'assemble', 'review']) {
  const seen: string[] = []; let broken = false;
  const repairedJson = await designS2Canvas(scene, { invoke: async request => {
    const input = JSON.parse(request.userInput); seen.push(input.stage);
    assert.equal(request.maxTokensOverride, input.stage === 'assemble' ? 16384 : 8192,
      'Same-stage JSON repair preserves the raised understanding, assembly and review budgets');
    const value = input.stage === 'understand' ? brief : input.stage === 'assemble' ? current : review('accept');
    if (input.stage === brokenStage && !broken) { broken = true; return { content: JSON.stringify(value) + ',}' }; }
    if (input.jsonFormatRepair) {
      assert.equal(input.stage, brokenStage); assert.equal(input.jsonFormatRepair.previousOutput, JSON.stringify(value) + ',}');
      assert.equal(input.sources.task, scene.task); assert.equal(input.sources.subject, scene.meta.subject);
      assert.equal(request.systemPromptOverride!.includes('S2插件协议v1'), false, 'Format repair must not duplicate first-assembly protocol manuals');
      if (brokenStage === 'assemble') {
        assert.match(request.systemPromptOverride!, /jsonFormatRepair只用于修复同阶段上次完整输出的JSON语法\/对象格式/);
        assert.ok(input.pluginCatalog); assert.deepEqual(input.designBrief, brief);
      }
    }
    return response(value);
  } });
  assert.equal(seen.length, 4); assert.equal(seen.filter(s => s === brokenStage).length, 2);
  assert.deepEqual(repairedJson.initial, current.initial); assert.equal(JSON.stringify(current), snapshot);
}
let invalidBriefAfterJson = 0;
await assert.rejects(() => designS2Canvas(scene, { invoke: async () => {
  invalidBriefAfterJson++;
  return invalidBriefAfterJson === 1 ? { content: JSON.stringify(brief) + ',}' } : response({ ...brief, delivery: undefined });
} }), /共享格式修复额度已用完/);
assert.equal(invalidBriefAfterJson, 2, 'JSON syntax and brief schema share one allowance, not one each');
let invalidJsonAfterBrief = 0;
await assert.rejects(() => designS2Canvas(scene, { invoke: async request => {
  invalidJsonAfterBrief++; const input = JSON.parse(request.userInput);
  return input.stage === 'understand' ? response(input.previousBrief ? brief : { ...brief, delivery: undefined }) : { content: JSON.stringify(current) + ',}' };
} }), /共享格式修复额度已用完/);
assert.equal(invalidJsonAfterBrief, 3, 'Prior schema repair cannot silently grant a JSON repair');
let invalidJsonTwice = 0;
await assert.rejects(() => designS2Canvas(scene, { invoke: async () => { invalidJsonTwice++; return { content: '{"goal":' }; } }), /JSON/);
assert.equal(invalidJsonTwice, 2, 'Bad JSON twice stops, without automatic third dispatch');
for (const failure of ['truncated', 'transport', 'aborted'] as const) {
  let count = 0; const controller = new AbortController();
  await assert.rejects(() => designS2Canvas(scene, { signal: controller.signal, invoke: async () => {
    count++;
    if (failure === 'transport') throw new Error('synthetic transport failure');
    if (failure === 'aborted') controller.abort();
    return { content: '{"goal":', diagnostics: { finishReason: failure === 'truncated' ? 'length' : 'stop' } } as any;
  } }), /截断|transport|停止/);
  assert.equal(count, 1, 'Incomplete/transport/abort errors never enter complete-output JSON repair');
}
console.log('S2 directed design repair passed: exact atomic JSON Pointers, array insertion/removal/escaping, prototype/root/authority/sparse-array rejection, immutable original, host source-grounded repair context, protocol and semantic repairs, fresh component selection under registry validation, first-turn/full-output boundaries and abort. Synthetic only; no model or IO.');
});
