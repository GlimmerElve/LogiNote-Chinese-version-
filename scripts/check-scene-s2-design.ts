import assert from 'node:assert/strict';
import type { LlmCallRequest, LlmCallResponse } from '../src/types';
import type { S2CanvasDefinition, S2DesignBrief } from '../src/types/sceneS2';
import { createS2Scene, designS2Canvas as designS2CanvasImplementation, reviewS2CanvasCandidate, readS2Scene, readS2Definition, exportS2Workspace, importS2Workspace, interactS2Canvas } from '../src/services/scene/sceneS2Canvas';
import { readS2DesignBrief, readS2DesignReview, s2DesignEvidencePaths, s2DesignProtocolFacts } from '../src/services/scene/sceneS2Design';
import { readS2TurnIntent } from '../src/services/scene/sceneS2Turn';
import { S2PluginHost } from '../src/services/scene/sceneS2PluginHost';
import { normalizeSceneSpec } from '../src/services/scene/sceneSkillStore';
import { syntheticS2Business } from './fixtures/s2-business-model';
import { recoverS2RedundantObjectClosers } from '../src/services/scene/sceneS2Output';
import { withS2DesignContext } from './fixtures/s2-design-context';
import { S2_BUILDER_CANVAS_RULES } from '../src/services/scene/sceneS2BuildContext';

// Historical complete-context parser/repair cases; default progressive discovery is tested separately.
// Every invoke remains visible and counted by the real builder.
const designS2Canvas = (...[scene, options]: Parameters<typeof designS2CanvasImplementation>) => designS2CanvasImplementation(scene, { ...options, review: true, disclosure: 'complete' });

await withS2DesignContext(131072, async () => {
globalThis.fetch = async () => assert.fail('Offline S2 design tests must not call real models, notes or external services');
const scene = createS2Scene({ source: 'custom', subject: '合成工作流设计', sceneSkill: 'S2', knowledgePoints: ['只有标题，未读正文'],
  extraHints: '帮我搭建，先解释再决定是否运行；不得真实发送', roleHints: '担任协作教练，不强制用户手工操作' });
const original = readS2Scene(scene), snapshot = JSON.stringify(scene);
assert.equal(scene.referenceScope, undefined, 'Custom S2 design remains available without binding a project');
const sources = { task: scene.task, subject: scene.meta.subject, currentGoal: original.goal, currentPolicy: JSON.stringify(original.instructions), knowledgePointTitles: scene.meta.knowledgePoints };
const brief: S2DesignBrief = { goal: '协作设计和审阅工作流，不真实发送',
  requirements: [{ id: 'collaborate', source: 'task', quote: '帮我搭建', description: 'Agent可协作设计，不强制用户手工添加所有节点' },
    { id: 'discuss', source: 'task', quote: '先解释再决定是否运行', description: '允许只解释、不修改、不运行' }],
  userRole: '提出目标，修改或确认方案', agentRole: '协作设计、语义审阅、按需解释真实本地结果', assumptions: ['尚未确定输入格式'], openQuestions: ['希望模拟哪类输入？'],
  delivery: { initial: '可修改的协作起点', deferred: '先解释，随后由用户决定运行', source: 'task', quote: '先解释再决定是否运行' } };
const candidate: S2CanvasDefinition = { ...original, business: syntheticS2Business(original, brief), instructions: { understanding: '先判断需要解释还是协作修改，不凭关键词调用工具',
  planning: '用户可手工搭建或委托协作，改图和运行分别确认', response: '可只解释/举例/暂停；语义审阅不冒充执行，不真实发送；缺输入可后续确认' } };
const response = (value: unknown): LlmCallResponse => ({ content: JSON.stringify(value) } as LlmCallResponse);
const scopedBrief: S2DesignBrief = { ...brief, delivery: { initial: '提供可修改的协作起点与解释入口', deferred: '解释后由用户决定是否运行', source: 'task', quote: '先解释再决定是否运行' } };
assert.deepEqual(readS2DesignBrief(scopedBrief, sources).delivery, scopedBrief.delivery);
assert.throws(() => readS2DesignBrief({ ...scopedBrief, delivery: { ...scopedBrief.delivery, quote: '伪造的延期授权' } }, sources), /交付边界.*引用/);
assert.throws(() => readS2DesignBrief({ ...scopedBrief, delivery: { ...scopedBrief.delivery, allowedTools: ['network'] } }, sources), /未支持/);
assert.deepEqual(importS2Workspace(exportS2Workspace({ ...candidate, designBrief: scopedBrief }, candidate.initial)).designBrief?.delivery, scopedBrief.delivery);
let scopedReviews = 0; const scopedStages: string[] = [];
const scopedDesign = await designS2Canvas(scene, { invoke: async request => {
  const input = JSON.parse(request.userInput); scopedStages.push(input.stage);
  if (input.stage === 'understand') return response(scopedBrief);
  assert.deepEqual(input.designBrief.delivery, scopedBrief.delivery, 'Initial/deferred scope is inherited without an extra stage');
  if (input.stage === 'assemble') {
    if (input.feedback) assert.equal(input.feedback.verdict, 'revise');
    return response(candidate);
  }
  scopedReviews++;
  assert.match(request.systemPromptOverride!, /covered可表示.*可操作的练习承载点/);
  if (scopedReviews === 1) {
    assert.equal(input.previousSemanticReview, undefined);
    return response({ verdict: 'revise', factChecks: [], coverage: scopedBrief.requirements.map(r => ({ requirementId: r.id, status: 'missing', evidencePaths: ['/instructions/response'],
      evidenceQuotes: [{ path: '/instructions/response', quote: candidate.instructions.response }], reason: 'Synthetic missing explanation' })), feedback: 'Synthetic revise once' });
  }
  assert.equal(input.previousSemanticReview.verdict, 'revise');
  if (scopedReviews === 2) return response({ verdict: 'accept', factChecks: [], coverage: scopedBrief.requirements.map(r => ({ requirementId: r.id, status: 'covered', evidencePaths: ['/not-existing'], reason: 'Synthetic wrong path' })), feedback: 'Synthetic invalid format' });
  assert.ok(input.reviewFormatError);
  assert.equal(input.previousReview.verdict, 'accept', 'Invalid current format draft remains separate from prior semantic criteria');
  return response({ verdict: 'accept', factChecks: [], coverage: scopedBrief.requirements.map(r => ({ requirementId: r.id, status: 'covered', evidencePaths: ['/instructions/response'], reason: 'Synthetic scope handoff only' })), feedback: 'Synthetic accepted' });
} });
assert.deepEqual(scopedStages, ['understand', 'assemble', 'review', 'assemble', 'review', 'review']);
assert.deepEqual(scopedDesign.designBrief?.delivery, scopedBrief.delivery);
const accepted = (b = brief) => ({ verdict: 'accept', factChecks: [], coverage: b.requirements.map(item => ({ requirementId: item.id, status: 'covered', evidencePaths: ['/instructions/response'], reason: 'Synthetic protocol evidence; not live-model validation' })), feedback: '合成验收结果' });
let retrospectiveCalls = 0; const retrospectiveBefore = JSON.stringify(scopedDesign);
const retrospective = await reviewS2CanvasCandidate(sources, scopedDesign, accepted(scopedBrief), { invoke: async request => {
  assert.equal(request.maxTokensOverride, 8192, 'Read-only retrospective review uses the full review output allowance');
  retrospectiveCalls++; const input = JSON.parse(request.userInput);
  assert.equal(input.stage, 'review'); assert.equal(input.phase, 's2-design-scope-review');
  assert.equal(input.previousSemanticReview.verdict, 'accept');
  assert.deepEqual(input.designBrief.delivery, scopedBrief.delivery);
  assert.match(request.systemPromptOverride!, /covered可表示.*可操作的练习承载点/);
  assert.ok(!request.systemPromptOverride!.includes('S2插件协议v1'));
  assert.ok(!request.systemPromptOverride!.includes('S2自由组合规则'), 'Retrospective review must not receive action/dispatch instructions');
  return response(accepted(scopedBrief));
} });
assert.equal(retrospectiveCalls, 1); assert.equal(retrospective.verdict, 'accept');
assert.equal(JSON.stringify(scopedDesign), retrospectiveBefore, 'A retrospective verdict never commits a design or runs a host');
await reviewS2CanvasCandidate(sources, scopedDesign, undefined, { invoke: async request => {
  assert.equal(request.maxTokensOverride, 8192);
  const input = JSON.parse(request.userInput); assert.equal(input.previousSemanticReview, undefined, 'Blind contrast omits prior conclusions, not original requirements');
  assert.deepEqual(input.sources, sources); assert.deepEqual(input.candidate, scopedDesign);
  assert.ok(input.protocolFacts.dataFlow); return response(accepted(scopedBrief));
} });
await assert.rejects(() => reviewS2CanvasCandidate(sources, { ...scopedDesign, designBrief: { ...scopedBrief, delivery: { ...scopedBrief.delivery, quote: '伪造交付来源' } } }, undefined,
  { invoke: async () => assert.fail('Invalid saved source must fail before dispatch') }), /引用/);
const stages: string[] = [], progress: string[] = [];
const designed = await designS2Canvas(scene, { onProgress: (stage, attempt) => progress.push(`${stage}:${attempt}`), invoke: async request => {
  assert.equal(request.skipMemoryInjection, true); assert.equal(request.skipProfileInjection, true);
  assert.equal(request.context, undefined, 'A larger output budget does not require or inject project context');
  const input = JSON.parse(request.userInput); stages.push(input.stage);
  if (input.stage === 'understand') {
    assert.equal(input.pluginCatalog, undefined); assert.equal(input.current, undefined);
    assert.ok(!request.systemPromptOverride!.includes('S2插件协议v1'));
    assert.ok(!request.systemPromptOverride!.includes('S2自由组合规则'));
    assert.ok(!request.systemPromptOverride!.includes(S2_BUILDER_CANVAS_RULES), 'Understanding needs source meaning, not the canvas declaration protocol');
    assert.equal(input.sources.currentPolicy, sources.currentPolicy);
    assert.match(input.sourceRoles.currentPolicy, /不是搭建Agent/);
    assert.match(request.systemPromptOverride!, /绝不能把阶段说明抽取成用户需求/);
    assert.equal(request.maxTokensOverride, 8192); return response(brief);
  }
  assert.deepEqual(input.designBrief, brief); assert.ok(input.pluginCatalog.plugins.length > 0);
  if (input.stage === 'assemble') {
    assert.ok(request.systemPromptOverride!.includes(S2_BUILDER_CANVAS_RULES));
    assert.ok(!request.systemPromptOverride!.includes('S2插件协议v1'));
    assert.ok(!request.systemPromptOverride!.includes('S2自由组合规则'), 'Canvas declarations do not need the runtime dispatch manual');
    assert.equal(request.maxTokensOverride, 16384); return response(candidate);
  }
  assert.ok(!request.systemPromptOverride!.includes('S2插件协议v1'));
  assert.ok(!request.systemPromptOverride!.includes('S2自由组合规则'), 'Review is read-only while keeping catalog, original sources and host facts');
  assert.ok(!request.systemPromptOverride!.includes(S2_BUILDER_CANVAS_RULES));
  assert.equal(request.maxTokensOverride, 8192); assert.deepEqual(input.candidate.designBrief, brief);
  assert.equal(input.protocolFacts.origin, 'host-static-preflight'); assert.equal(input.protocolFacts.executed, false);
  assert.ok(request.systemPromptOverride!.includes('不要把links为空等同不可运行'));
  assert.ok(input.evidencePathCatalog.includes('/instructions/response'));
  assert.ok(!input.evidencePathCatalog.includes('/goal')); return response(accepted());
} });
assert.deepEqual(stages, ['understand', 'assemble', 'review']); assert.deepEqual(progress, ['understand:1', 'assemble:1', 'review:1']);
assert.deepEqual(designed.designBrief, brief); assert.equal(JSON.stringify(scene), snapshot);
assert.deepEqual(importS2Workspace(exportS2Workspace(designed, designed.initial)), designed);
assert.deepEqual(readS2Scene(normalizeSceneSpec({ ...scene, canvasWorkspace: designed })!), designed);
assert.deepEqual(readS2Definition(original), original, 'Existing templates without designBrief remain supported');
assert.throws(() => readS2DesignBrief({ ...brief, requirements: [{ ...brief.requirements[0], quote: 'fabricated user requirement' }] }, sources), /引用/);
assert.throws(() => readS2DesignBrief({ ...brief, requirements: [brief.requirements[0], brief.requirements[0]] }), /重复/);
assert.throws(() => readS2DesignBrief({ ...brief, permissions: ['network'] }), /未支持/);
assert.throws(() => readS2Definition({ ...original, designBrief: { ...brief, assumptions: Array(9).fill('x') } }), /列表/);
assert.ok(s2DesignEvidencePaths(designed).every(path => !path.startsWith('/designBrief') && !path.includes('/position')));
for (const bad of [
  { ...accepted(), coverage: [] },
  { ...accepted(), coverage: [accepted().coverage[0], accepted().coverage[0]] },
  { ...accepted(), coverage: accepted().coverage.map(item => ({ ...item, evidencePaths: ['/initial/nodes/100/values/missing'] })) },
  { ...accepted(), coverage: accepted().coverage.map(item => ({ ...item, evidencePaths: ['/goal'] })) },
  { ...accepted(), coverage: accepted().coverage.map(item => ({ ...item, status: 'unsupported' })) },
]) assert.throws(() => readS2DesignReview(bad, brief, designed));

// Review rejection can select a previously unselected installed component. It is still not a grant.
const parse = { pluginId: 'structured-data', pluginVersion: '1.0.0', capabilityId: 'parse-json' };
const repairedCandidate = { ...candidate, plugins: [parse] };
const reassembled: string[] = [];
const repaired = await designS2Canvas(scene, { invoke: async request => {
  const input = JSON.parse(request.userInput); reassembled.push(input.stage);
  if (input.stage === 'understand') return response(brief);
  if (input.stage === 'assemble') {
    if (!input.previousCandidate) return response(candidate);
    assert.equal(input.feedback.kind, 'semantic'); assert.equal(input.current.plugins, undefined);
    assert.ok(input.pluginCatalog.plugins.some((p: { id: string }) => p.id === 'structured-data'));
    assert.deepEqual(input.designBrief, brief); return response(repairedCandidate);
  }
  return response(input.candidate.plugins ? accepted() : { ...accepted(), verdict: 'revise', feedback: '合成：缺少用户输入的解析能力',
    coverage: accepted().coverage.map(item => ({ ...item, status: 'missing', evidencePaths: ['/instructions/response'], evidenceQuotes: [{ path: '/instructions/response', quote: candidate.instructions.response }] })) });
} });
assert.deepEqual(reassembled, ['understand', 'assemble', 'review', 'assemble', 'review']); assert.deepEqual(repaired.plugins, [parse]);
assert.equal(JSON.stringify(scene), snapshot);
// A field binding is a legal executable input, not a missing editor/output edge. No adapter/model runs.
const protocolCandidate = readS2Definition({ ...candidate, plugins: [parse], initial: { nodes: candidate.initial.nodes, edges: [], execution: { version: 1,
  nodes: [
    { id: 'bound', ...parse, position: { x: 300, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'goal', fieldId: 'content' } } },
    { id: 'incomplete', ...parse, position: { x: 600, y: 0 }, bindings: {} },
  ], links: [] } } });
const protocolFacts = s2DesignProtocolFacts(protocolCandidate);
assert.equal(protocolFacts.executed, false); assert.deepEqual(protocolFacts.targets[0], { nodeId: 'bound', protocolReady: true, dependencyNodeIds: ['bound'] });
assert.equal(protocolFacts.targets[1].protocolReady, false); assert.match(protocolFacts.targets[1].reason!, /必需|必填/);
const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const dataFlowCandidate = readS2Definition({ ...protocolCandidate, plugins: [parse, cap('validate', 'json-check'), cap('confirm', 'human-input'), cap('json-tree', 'structured-view')],
  initial: { ...protocolCandidate.initial, execution: { version: 1, nodes: [...protocolCandidate.initial.execution!.nodes,
    { id: 'syntax', ...cap('validate', 'json-check'), position: { x: 0, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'goal', fieldId: 'content' } } },
    { id: 'confirmRule', ...cap('confirm', 'human-input'), position: { x: 0, y: 0 }, bindings: { prompt: { kind: 'literal', value: '确认规则，不是判定记录' }, context: { kind: 'literal', value: [] } } },
    { id: 'show', ...cap('json-tree', 'structured-view'), position: { x: 0, y: 0 }, bindings: {} },
  ], links: [{ source: { nodeId: 'bound', portId: 'value' }, target: { nodeId: 'show', portId: 'value' } }] } } });
const flowBefore = JSON.stringify(dataFlowCandidate), flow = s2DesignProtocolFacts(dataFlowCandidate).dataFlow;
const syntaxFlow = flow.find(n => n.nodeId === 'syntax')!, parseFlow = flow.find(n => n.nodeId === 'bound')!;
assert.deepEqual(syntaxFlow.inputs[0].boundSource, parseFlow.inputs[0].boundSource);
assert.deepEqual(syntaxFlow.outputs[0].consumers, [], 'Sharing text is NOT syntax→parse wiring');
assert.deepEqual(parseFlow.outputs[0].consumers, [{ nodeId: 'show', portId: 'value' }]);
assert.deepEqual(flow.find(n => n.nodeId === 'show')!.inputs[0].linkedSources, [{ kind: 'execution-output', nodeId: 'bound', portId: 'value' }]);
const confirmFlow = flow.find(n => n.nodeId === 'confirmRule')!;
assert.equal(confirmFlow.outputs[0].type.id, 'human-input.decision', 'Rule confirmation cannot masquerade as structured records');
assert.deepEqual(confirmFlow.inputs.find(p => p.portId === 'context')!.boundSource, { kind: 'literal', valuePath: '/initial/execution/nodes/3/bindings/context/value' });
assert.equal(flow.find(n => n.nodeId === 'incomplete')!.inputs[0].unbound, true);
assert.equal(JSON.stringify(dataFlowCandidate), flowBefore);
const blankPath = '/initial/execution/nodes/1/bindings';
assert.ok(s2DesignEvidencePaths(protocolCandidate).includes(blankPath));
assert.ok(s2DesignEvidencePaths(protocolCandidate).includes('/initial/execution/links'));
const blankReview = { ...accepted(), coverage: accepted().coverage.map(item => ({ ...item,
  evidencePaths: [blankPath, '/instructions/planning'] })) };
assert.equal(readS2DesignReview(blankReview, brief, protocolCandidate).verdict, 'accept');
const localReadinessReview = { ...blankReview, coverage: blankReview.coverage.map(item => ({ ...item,
  evidencePaths: [blankPath, '/initial/execution/nodes/0'] })) };
assert.equal(readS2DesignReview(localReadinessReview, brief, protocolCandidate).verdict, 'accept', 'A valid nonempty local target can coexist with an unrelated unbound exercise node');
const emptyContent = structuredClone(protocolCandidate); emptyContent.initial.nodes[0].values.content = '';
assert.ok(s2DesignEvidencePaths(emptyContent).includes('/initial/nodes/0/values/content'));
assert.equal(readS2DesignReview({ ...blankReview, coverage: blankReview.coverage.map(item => ({ ...item,
  evidencePaths: ['/initial/nodes/0/values/content', '/blockTypes/0/fields/0/kind'] })) }, brief, emptyContent).verdict, 'accept');
assert.equal(readS2DesignReview({ ...blankReview, coverage: blankReview.coverage.map(item => ({ ...item,
  evidencePaths: ['/initial/nodes/0/values/content'] })) }, brief, emptyContent).verdict, 'accept', 'Host validates existence; the review model judges whether blank input meets the specific requirement');
assert.equal(readS2DesignReview({ ...blankReview, coverage: blankReview.coverage.map(item => ({ ...item, evidencePaths: [blankPath] })) }, brief, protocolCandidate).verdict, 'accept');
assert.throws(() => readS2DesignReview({ ...blankReview, coverage: blankReview.coverage.map(item => ({ ...item, evidencePaths: ['/initial/execution/nodes/9/bindings', '/instructions/planning'] })) }, brief, protocolCandidate), /证据/);
assert.throws(() => readS2Definition({ ...candidate, plugins: [{ pluginId: 'core', pluginVersion: '1.0.0', capabilityId: 'multiline' }] }), /未安装|允许/);
const tree = { pluginId: 'structured-view', pluginVersion: '1.0.0', capabilityId: 'json-tree' };
assert.throws(() => readS2Definition({ ...candidate, plugins: [tree], initial: { nodes: candidate.initial.nodes, edges: [], execution: { version: 1,
  nodes: [{ id: 'treeView', ...tree, position: { x: 0, y: 0 }, bindings: { value: { kind: 'field', nodeId: 'goal', fieldId: 'content' } } }], links: [] } } }),
  /treeView.*bindings.value.*core.text@1.*structured-data.value@1/, 'Targeted repair feedback names node, port, provided and required types');
// Local schema errors get one directed reassembly, not a semantic acceptance of an invalid scene.
let assemblies = 0;
await designS2Canvas(scene, { invoke: async request => {
  const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(brief);
  if (input.stage === 'assemble') {
    if (++assemblies === 1) return response({ ...candidate, plugins: [{ ...parse, pluginId: 'invented' }] });
    assert.equal(input.feedback.kind, 'protocol'); assert.match(input.feedback.message, /未安装/);
    assert.deepEqual(input.previousCandidate, { ...candidate, plugins: [{ ...parse, pluginId: 'invented' }] });
    assert.deepEqual(input.sources, sources); assert.deepEqual(input.designBrief, brief);
    assert.ok(input.pluginCatalog, 'Full installed selection scope remains available, not the invalid first selection');
    assert.ok(request.systemPromptOverride!.includes(S2_BUILDER_CANVAS_RULES), 'Repairs retain the complete declaration protocol');
    assert.ok(!request.systemPromptOverride!.includes('S2自由组合规则'));
    assert.ok(!request.systemPromptOverride!.includes('S2插件协议v1'), 'Repair does not restore the runtime dispatch manual');
    return response(candidate);
  }
  return response(accepted());
} });
assert.equal(assemblies, 2);
// Bad reviewer paths repair the review itself, without destroying a valid assembly.
const reviewerStages: string[] = []; let reviews = 0;
await designS2Canvas(scene, { invoke: async request => {
  const input = JSON.parse(request.userInput); reviewerStages.push(input.stage);
  if (input.stage === 'understand') return response(brief);
  if (input.stage === 'assemble') return response(candidate);
  if (++reviews === 1) return response({ ...accepted(), coverage: accepted().coverage.map(item => ({ ...item, evidencePaths: ['/fake'] })) });
  assert.match(input.reviewFormatError, /证据/); assert.ok(input.previousReview); return response(accepted());
} });
assert.deepEqual(reviewerStages, ['understand', 'assemble', 'review', 'review']);
let maxCalls = 0, maxReviews = 0;
await designS2Canvas(scene, { invoke: async request => {
  maxCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(brief);
  if (input.stage === 'assemble') return response(candidate);
  if (++maxReviews === 1) return response({ ...accepted(), coverage: [] });
  if (maxReviews === 2) return response({ ...accepted(), verdict: 'revise', feedback: '一次合成重装配', coverage: accepted().coverage.map(item => ({ ...item,
    status: 'missing', evidenceQuotes: [{ path: '/instructions/response', quote: candidate.instructions.response }] })) });
  return response(accepted());
} });
assert.equal(maxCalls, 6, 'One reviewer-format repair and one reassembly stay within six requests');
let rejectedCalls = 0;
await assert.rejects(() => designS2Canvas(scene, { invoke: async request => {
  rejectedCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'understand') return response(brief);
  if (input.stage === 'assemble') return response(candidate);
  return response({ ...accepted(), verdict: 'revise', feedback: '真实发送服务未安装', coverage: accepted().coverage.map(item => ({ ...item, status: 'unsupported', evidencePaths: [] })) });
} }), /已重装配一次.*真实发送/);
assert.equal(rejectedCalls, 5); assert.equal(JSON.stringify(scene), snapshot);
for (const abortStage of ['understand', 'assemble', 'review']) {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(() => designS2Canvas(scene, { signal: controller.signal, invoke: async request => {
    calls++; const input = JSON.parse(request.userInput); if (input.stage === abortStage) controller.abort();
    return response(input.stage === 'understand' ? brief : input.stage === 'assemble' ? candidate : accepted());
  } }), /停止/);
  assert.equal(calls, ['understand', 'assemble', 'review'].indexOf(abortStage) + 1);
}
for (const truncatedStage of ['understand', 'assemble', 'review']) {
  let truncatedCalls = 0;
  await assert.rejects(() => designS2Canvas(scene, { invoke: async request => {
    truncatedCalls++;
    const input = JSON.parse(request.userInput), result = response(input.stage === 'understand' ? brief : input.stage === 'assemble' ? candidate : accepted());
    return input.stage === truncatedStage ? { ...result, diagnostics: { finishReason: 'length' } } as LlmCallResponse : result;
  } }), /截断/);
  assert.equal(truncatedCalls, ['understand', 'assemble', 'review'].indexOf(truncatedStage) + 1, 'Raised output budgets do not add truncation retries');
  assert.equal(JSON.stringify(scene), snapshot, 'A truncated stage never commits a partial design');
}

// Independent runtime semantics. These stubs test wiring and fail-closed boundaries, not language quality.
const discuss = { understanding: '解释并举例，不修改、不运行', desiredOutcome: '理解工作流', actions: ['reply'], constraints: ['保留画布', '不运行'], questions: [] };
const answer = { understanding: discuss.understanding, plan: '只解释', reply: '这里给出形象的例子。', commands: [], pluginRequests: [] };
const runtimeScene = { ...scene, canvasWorkspace: designed }, runtimeStages: string[] = [];
const host = new S2PluginHost(scene.sceneId, designed.plugins); host.setDocument(designed.initial);
const pluginContext = host.prepare(null, { goal: designed.goal, ...designed.instructions }, '解释');
const result = await interactS2Canvas(runtimeScene, designed.initial, '先解释一下，举个形象的例子，不要改图或执行', null, [], { pluginContext, invoke: async request => {
  const input = JSON.parse(request.userInput); runtimeStages.push(input.stage); assert.deepEqual(input.designBrief, brief);
  if (input.stage === 'turn-understand') {
    assert.equal(input.pluginCatalog, undefined); assert.equal(input.pluginContext, undefined);
    assert.ok(!request.systemPromptOverride!.includes('S2插件协议v1')); return response(discuss);
  }
  assert.deepEqual(input.intent, discuss); assert.ok(input.pluginContext); return response(answer);
} });
assert.deepEqual(result, answer); assert.deepEqual(runtimeStages, ['turn-understand', 'turn-act']); assert.equal(host.history().length, 0);
assert.equal(host.remainingCalls, 64);
let omittedCommandCalls = 0;
const { commands: _emptyCommands, ...plainAnswer } = answer;
const plain = await interactS2Canvas(runtimeScene, designed.initial, '只解释，不改图', null, [], { invoke: async request => {
  omittedCommandCalls++; return response(JSON.parse(request.userInput).stage === 'turn-understand' ? discuss : plainAnswer);
} });
assert.deepEqual(plain.commands, []); assert.equal(omittedCommandCalls, 2, 'No paid format repair merely to add an omitted empty commands array');
let nullCommandCalls = 0;
const fixedNull = await interactS2Canvas(runtimeScene, designed.initial, '只解释', null, [], { invoke: async request => {
  nullCommandCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'turn-understand') return response(discuss);
  return response(input.responseRepair ? plainAnswer : { ...plainAnswer, commands: null });
} });
assert.equal(nullCommandCalls, 3); assert.deepEqual(fixedNull.commands, [], 'Explicit malformed null is not normalized into a silent no-op');
let repairedTurnCalls = 0;
assert.deepEqual(await interactS2Canvas(runtimeScene, designed.initial, '只解释', null, [], { invoke: async request => {
  repairedTurnCalls++; const input = JSON.parse(request.userInput);
  if (input.stage === 'turn-understand') return response(discuss);
  if (!input.responseRepair) return response({ ...answer, commands: [{ op: 'update-node', id: 'goal', values: { content: 'not requested' } }] });
  assert.match(input.responseRepair.error, /本轮意图不包含改图/); assert.deepEqual(input.intent, discuss);
  assert.equal(input.current.nodes[0].values.content, original.initial.nodes[0].values.content); return response(answer);
} }), answer);
assert.equal(repairedTurnCalls, 3, 'Repair a bad proposal once without changing intent or applying the first draft');
for (const unwanted of [{ commands: [{ op: 'update-node', id: 'goal', values: { content: 'bad' } }] }, { executionRequest: { targetNodeIds: ['x'], reason: 'bad' } }]) {
  await assert.rejects(() => interactS2Canvas(runtimeScene, designed.initial, '解释，不修改或执行', null, [], { invoke: async request =>
    response(JSON.parse(request.userInput).stage === 'turn-understand' ? discuss : { ...answer, ...unwanted }) }), /本轮意图不包含/);
}
const edits = { ...discuss, understanding: '协作补充方案', actions: ['reply', 'edit'] };
const proposed = await interactS2Canvas(runtimeScene, designed.initial, '帮我补充一个方案块', null, [], { invoke: async request => {
  const input = JSON.parse(request.userInput);
  if (input.stage === 'turn-proposal-review') return response({ verdict: 'accept', reason: 'Synthetic source-bound proposal check', evidence: [{ sourceId: 'query', quote: '补充一个方案块' }] });
  if (input.stage === 'turn-understand') return response(edits);
  return response({ ...answer, commands: [{ op: 'add-node', node: { id: 'proposal', type: 'text', position: { x: 300, y: 100 }, values: { content: '方案' } } }] });
} });
assert.equal(proposed.commands.length, 1); assert.equal(designed.initial.nodes.length, 1, 'Collaboration is still a confirmed proposal, never an implicit edit');
assert.throws(() => readS2TurnIntent({ ...discuss, commands: [] }), /语义阶段/);
assert.throws(() => readS2TurnIntent({ ...discuss, actions: ['network'] }), /动作/);
let intentCalls = 0;
await assert.rejects(() => interactS2Canvas(runtimeScene, designed.initial, 'bad', null, [], { invoke: async () => { intentCalls++; return response({ ...discuss, pluginRequests: [] }); } }), /语义阶段/);
assert.equal(intentCalls, 1);
const stop = new AbortController();
await assert.rejects(() => interactS2Canvas(runtimeScene, designed.initial, 'stop', null, [], { signal: stop.signal, invoke: async () => { stop.abort(); return response(discuss); } }), /停止/);
for (const failureStage of ['turn-understand', 'turn-act']) {
  for (const failure of ['transport', 'truncated']) {
    let calls = 0;
    await assert.rejects(() => interactS2Canvas(runtimeScene, designed.initial, 'explain', null, [], { invoke: async request => {
      calls++; const input = JSON.parse(request.userInput);
      if (input.stage !== failureStage) return response(discuss);
      if (failure === 'transport') throw new Error('synthetic transport failure');
      return { ...response(failureStage === 'turn-understand' ? discuss : answer), diagnostics: { finishReason: 'length' } } as LlmCallResponse;
    } }), /transport failure|截断/);
    assert.equal(calls, failureStage === 'turn-understand' ? 1 : 2, 'No transport/truncation retry');
  }
}
assert.equal(JSON.stringify(scene), snapshot); host.close();
let richUnderstandingCalls = 0;
await assert.rejects(() => designS2Canvas({ ...scene, task: `${scene.task}\n${'长需求'.repeat(300)}` }, { invoke: async request => {
  richUnderstandingCalls++;
  assert.equal(JSON.parse(request.userInput).stage, 'understand');
  assert.equal(request.maxTokensOverride, 8192, 'Long and short source-bound requirements share the full understanding allowance without changing tool authority');
  return { content: '{}', diagnostics: { finishReason: 'length' } } as LlmCallResponse;
} }), /截断/);
assert.equal(richUnderstandingCalls, 1, 'A larger allowance must not turn truncation into an automatic retry or apply partial JSON');
const intactObject = { text: 'JSON braces } and escaped quote " are content', nested: { list: [1, 2] } };
for (const closers of ['}', '}}', '} \n } \t }']) {
  assert.deepEqual(recoverS2RedundantObjectClosers(JSON.stringify(intactObject) + closers), intactObject);
}
for (const malformed of ['{"missing":', '{"x":1}} ,"permission":true}', '{}{}', '{} trailer }', '[]}', '"text"}',
  '{} }}}}', '{"x":"unterminated}', '{"x":1},"y":2}', ' '.repeat(64001) + '{} }']) {
  assert.equal(recoverS2RedundantObjectClosers(malformed), undefined, 'Never infer values, ignore meaningful suffixes or accept a partial document');
}
const closerStages: string[] = [];
await designS2Canvas(scene, { invoke: async request => {
  const input = JSON.parse(request.userInput); closerStages.push(input.stage);
  if (input.stage === 'understand') return { content: JSON.stringify(brief) + '}' } as LlmCallResponse;
  if (input.stage === 'assemble') return response(candidate);
  return response({ verdict: 'accept', factChecks: [], coverage: brief.requirements.map(item => ({ requirementId: item.id,
    status: 'covered', evidencePaths: ['/instructions/response'], reason: 'Synthetic only' })), feedback: 'Synthetic only' });
} });
assert.deepEqual(closerStages, ['understand', 'assemble', 'review'], 'Complete-object syntax recovery does not skip schema validation or independent acceptance');
console.log('S2 semantic design/turn passed: tool-free understanding, grounded requirements, staged assembly and independent coverage review, real field evidence, bounded reassembly with catalog reselection, reviewer-only repair, abort/truncation atomicity, enlarged uniform design output budgets without project binding, saved design context and legacy templates, independent per-turn intent, discuss-only/no-edit/no-execute and collaboration proposals. Synthetic protocol tests only; no live-model semantic quality claim.');
});
