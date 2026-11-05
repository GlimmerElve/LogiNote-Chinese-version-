// Fixed synthetic replies below intentionally test complete-catalogue compatibility, not progressive discovery.
import assert from 'node:assert/strict';
import { createS2Scene, designS2Canvas as designS2CanvasImplementation, readS2Definition } from '../src/services/scene/sceneS2Canvas';
import { readS2DesignBrief, readS2DesignReview, s2DesignProtocolFacts } from '../src/services/scene/sceneS2Design';
import { readS2DesignFactChecks } from '../src/services/scene/sceneS2DesignEvidence';
import type { S2DesignBrief } from '../src/types/sceneS2';
import { syntheticS2Business } from './fixtures/s2-business-model';
import { S2_BUILDER_CANVAS_RULES } from '../src/services/scene/sceneS2BuildContext';
import { S2_PLUGIN_PROTOCOL_RULES } from '../src/services/scene/sceneS2PluginProtocol';
import { S2_WORKFLOW_AGENT_RULES } from '../src/services/scene/sceneS2Workflow';
import { fitSceneContextBudget, SceneContextBudgetError, withSceneContextBudget } from '../src/services/scene/sceneContextBudget';
import type { LlmCallRequest } from '../src/types';
import { withS2DesignContext } from './fixtures/s2-design-context';
const designS2Canvas = (...[scene, options]: Parameters<typeof designS2CanvasImplementation>) => designS2CanvasImplementation(scene, { ...options, review: true, disclosure: 'complete' });
globalThis.fetch = async () => assert.fail('Offline only; no model, notes, profile or external sources');
const scene = createS2Scene({ source: 'custom', sceneSkill: 'S2', subject: '合成留白练习', knowledgePoints: [],
  extraHints: '给我不完整的流程练习，先只提供可运行的解析局部，保留结果入口让我补齐；只解释规则不等于筛选记录。' });
const cap = (capabilityId: string, pluginId = 'structured-data') => ({ pluginId, pluginVersion: '1.0.0', capabilityId });
const badProse = '当前顺序为：语法检查→解析→展示。confirmRule读取解析后的记录数组，确认结果是合格记录数组。';
const goodProse = '语法检查与解析分别读取原文；只有解析→JSON展示有数据线。confirmRule目前展示固定示例，输出是确认决定，不筛选记录。合格记录可由用户在toTable.value参数中填写，toTable.table与tableView.table待用户连线；这些是练习，不是已经完成的业务校验。';
const candidate = readS2Definition({ version: 1, goal: '提供不完整练习',
  instructions: { understanding: '先理解练习目标', planning: badProse, response: '按需解释、协作；不自动执行' },
  blockTypes: [{ id: 'text', label: '内容', fields: [{ id: 'content', label: '原文', kind: 'multiline' }] }],
  plugins: [cap('parse-json'), cap('validate', 'json-check'), cap('confirm', 'human-input'), cap('json-tree', 'structured-view'), cap('to-table'), cap('table', 'structured-view')],
  initial: { nodes: [
    { id: 'records', type: 'text', position: { x: 0, y: 0 }, values: { content: '[{"score":120}]' } },
    { id: 'exercise', type: 'text', position: { x: 0, y: 200 }, values: { content: '合格记录由用户补齐到toTable.value；表格连线也由用户补。既有参数编辑入口可用于练习，不要求初稿自动判定。' } },
  ], edges: [], execution: { version: 1, nodes: [
    { id: 'syntax', ...cap('validate', 'json-check'), position: { x: 100, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'records', fieldId: 'content' } } },
    { id: 'parse', ...cap('parse-json'), position: { x: 200, y: 0 }, bindings: { text: { kind: 'field', nodeId: 'records', fieldId: 'content' } } },
    { id: 'show', ...cap('json-tree', 'structured-view'), position: { x: 300, y: 0 }, bindings: {} },
    { id: 'confirmRule', ...cap('confirm', 'human-input'), position: { x: 0, y: 200 }, bindings: { prompt: { kind: 'literal', value: '仅确认规则' }, context: { kind: 'literal', value: [{ score: 120 }] } } },
    { id: 'toTable', ...cap('to-table'), position: { x: 200, y: 200 }, bindings: {} },
    { id: 'tableView', ...cap('table', 'structured-view'), position: { x: 300, y: 200 }, bindings: {} },
  ], links: [{ source: { nodeId: 'parse', portId: 'value' }, target: { nodeId: 'show', portId: 'value' } }] } } });
const brief: S2DesignBrief = { goal: '可运行解析局部加练习入口', requirements: [
  { id: 'local', description: '初稿可运行局部', source: 'task', quote: '先只提供可运行的解析局部' },
  { id: 'exercise', description: '留给用户补齐结果', source: 'task', quote: '保留结果入口让我补齐' },
], userRole: '练习和确认', agentRole: '解释和按需协作', assumptions: [], openQuestions: [],
  delivery: { initial: '可运行解析局部与可编辑结果入口', deferred: '记录处理和表格连线由用户练习，不在初稿填出答案', source: 'task', quote: '先只提供可运行的解析局部，保留结果入口让我补齐' } };
candidate.business = syntheticS2Business(candidate, brief);
const quote = (quote: string) => ({ path: '/instructions/planning', quote });
const checks = [
  { ...quote('当前顺序为：语法检查→解析→展示'), claim: { kind: 'data-link', source: { nodeId: 'syntax', portId: 'assessment' }, target: { nodeId: 'parse', portId: 'text' }, present: true }, matches: false },
  { ...quote('confirmRule读取解析后的记录数组'), claim: { kind: 'input-source', nodeId: 'confirmRule', portId: 'context', source: { kind: 'execution-output', nodeId: 'parse', portId: 'value' } }, matches: false },
  { ...quote('确认结果是合格记录数组'), claim: { kind: 'port-type', nodeId: 'confirmRule', portId: 'decision', direction: 'output', type: { id: 'structured-data.value', version: 1 } }, matches: false },
];
const coverage = brief.requirements.map(r => ({ requirementId: r.id, status: 'covered', evidencePaths: ['/initial/nodes/1/values/content', '/initial/execution/nodes/4/bindings'], reason: 'Synthetic scoped exercise coverage, NOT evidence of actual semantic accuracy' }));
const response = (v: unknown) => ({ content: JSON.stringify(v) });
assert.deepEqual(readS2DesignFactChecks(checks, candidate), checks);
for (let i = 0; i < checks.length; i++) assert.throws(() => readS2DesignFactChecks([{ ...checks[i], matches: true }], candidate), /与真实画布不符/);
assert.throws(() => readS2DesignReview({ verdict: 'accept', coverage, factChecks: checks, feedback: 'bad' }, brief, candidate, { strictEvidence: true }), /图文结构事实不一致/);
const actual = [
  { ...quote('confirmRule目前展示固定示例'), claim: { kind: 'input-source', nodeId: 'confirmRule', portId: 'context', source: { kind: 'literal' } }, matches: true },
  { ...quote('语法检查与解析分别读取原文'), claim: { kind: 'input-source', nodeId: 'parse', portId: 'text', source: { kind: 'field', nodeId: 'records', fieldId: 'content' } }, matches: true },
  { ...quote('输出是确认决定'), claim: { kind: 'port-type', nodeId: 'confirmRule', portId: 'decision', direction: 'output', type: { id: 'human-input.decision', version: 1 } }, matches: true },
];
const corrected = readS2Definition({ ...candidate, instructions: { ...candidate.instructions, planning: goodProse } });
assert.equal(readS2DesignFactChecks(actual, corrected).every(x => x.matches), true);
// Facts cannot establish the semantic correspondence between an arbitrary quote and a claim.
// Positive fixtures must quote the actual matching statement, not disguise contrary prose as a pass.
const dependency = (nodeId: string, dependsOnNodeId: string, present: boolean, matches: boolean) => ({
  ...quote('当前顺序为：语法检查→解析→展示'), claim: { kind: 'execution-dependency', nodeId, dependsOnNodeId, present }, matches,
});
assert.equal(readS2DesignFactChecks([dependency('parse', 'syntax', true, false)], candidate)[0].matches, false, 'Shared fields do not establish execution order');
const conditionalRaw = structuredClone(candidate);
conditionalRaw.initial.execution!.nodes.find(node => node.id === 'parse')!.when = { nodeId: 'syntax', portId: 'assessment', pointer: '/status', equals: 'pass', match: true };
const conditional = readS2Definition(conditionalRaw), conditionalBefore = JSON.stringify(conditional);
assert.equal(readS2DesignFactChecks([dependency('parse', 'syntax', true, true), dependency('show', 'syntax', true, true), dependency('syntax', 'show', false, true)], conditional).length, 3);
assert.deepEqual(s2DesignProtocolFacts(conditional).dataFlow.find(node => node.nodeId === 'parse')!.conditionSource,
  { nodeId: 'syntax', portId: 'assessment', pointer: '/status', equals: 'pass', match: true }, 'Show the actual condition, not just its source');
assert.equal(readS2DesignFactChecks([checks[0]], conditional)[0].matches, false, 'A condition is not a data link');
assert.equal(readS2DesignFactChecks([{ ...quote('当前顺序为：语法检查→解析→展示'), claim: actual[1].claim, matches: true }], conditional)[0].matches, true, 'A condition does not replace the text input binding');
assert.equal(JSON.stringify(conditional), conditionalBefore, 'Static fact checking neither runs nor rewrites the graph');
for (const bad of [
  { ...checks[0], claim: { ...checks[0].claim, source: { nodeId: 'missing', portId: 'assessment' }, present: false }, matches: true },
  { ...checks[0], claim: { ...checks[0].claim, target: { nodeId: 'parse', portId: 'missing' }, present: false }, matches: true },
  { ...checks[1], claim: { ...checks[1].claim, source: { kind: 'field', nodeId: 'records', fieldId: 'missing' } } },
  { ...checks[2], claim: { ...checks[2].claim, portId: 'missing' } },
  dependency('parse', 'missing', false, true), dependency('parse', 'parse', false, true),
  { ...dependency('parse', 'syntax', true, true), claim: { ...dependency('parse', 'syntax', true, true).claim, grant: true } },
]) assert.throws(() => readS2DesignFactChecks([bad], conditional), /不存在|自身|字段无效/);
for (const bad of [
  { ...checks[0], quote: '拼接…不存在原文' }, { ...checks[0], path: '/__proto__/planning' }, { ...checks[0], path: 'D:/secret.txt' },
  { ...checks[0], claim: { ...checks[0].claim, execute: true } }, { ...checks[0], allowedTools: ['network'] },
]) assert.throws(() => readS2DesignFactChecks([bad], candidate));
assert.throws(() => readS2DesignReview({ verdict: 'revise', coverage: coverage.map(c => ({ ...c, status: 'missing' })), factChecks: [], feedback: '没有说明' }, brief, candidate, { strictEvidence: true }), /必须引用相关实际说明原文/);
assert.throws(() => readS2DesignReview({ verdict: 'revise', coverage: coverage.map(c => ({ ...c, status: 'missing', evidenceQuotes: [{ path: '/initial/nodes/1/values/content', quote: '不存在的说明' }] })), factChecks: [], feedback: '没有说明' }, brief, candidate, { strictEvidence: true }), /连续原文/);
const emptyExercise = structuredClone(corrected); emptyExercise.initial.nodes[1].values.content = '';
const coveredValues = coverage.map(c => ({ ...c, evidencePaths: ['/initial/execution/nodes/0/pluginId', '/initial/nodes/1/values/content'],
  evidenceQuotes: [{ path: '/initial/execution/nodes/0/pluginId', quote: 'json-check' }, { path: '/initial/nodes/1/values/content', quote: '' }] }));
assert.equal(readS2DesignReview({ verdict: 'accept', coverage: coveredValues, factChecks: [], feedback: '仅检查真实引用协议，不证明语义覆盖' }, brief, emptyExercise, { strictEvidence: true }).verdict, 'accept');
assert.throws(() => readS2DesignReview({ verdict: 'accept', coverage: coveredValues, factChecks: [], feedback: 'bad' }, brief, corrected, { strictEvidence: true }), /连续原文/, 'Empty quote cannot prove nonempty content');
assert.throws(() => readS2DesignReview({ verdict: 'revise', coverage: coveredValues.map(c => ({ ...c, status: 'missing' })), factChecks: [], feedback: 'bad' }, brief, emptyExercise, { strictEvidence: true }), /连续原文/, 'A missing rationale still requires actual explanatory prose');
assert.throws(() => readS2DesignReview({ verdict: 'revise', coverage, factChecks: [], feedback: '全部已满足，只是建议增加插件' }, brief, corrected, { strictEvidence: true }), /revise须指出/);
const reviewSources = { task: scene.task, subject: scene.meta.subject, currentGoal: candidate.goal, currentPolicy: '', knowledgePointTitles: [] };
const sourceIssue = { source: 'task', quote: '只解释规则不等于筛选记录', reason: 'Synthetic original-source omission, not a new business workflow requirement' };
const sourceReview = { verdict: 'revise', coverage, factChecks: [], sourceIssues: [sourceIssue], feedback: '对照真实原文修正漏项' };
assert.equal(readS2DesignReview(sourceReview, brief, corrected, { strictEvidence: true, sources: reviewSources }).verdict, 'revise', 'Coverage of an incomplete brief does not erase omitted original requirements');
assert.throws(() => readS2DesignReview({ ...sourceReview, verdict: 'accept' }, brief, corrected, { strictEvidence: true, sources: reviewSources }), /原文遗漏/);
assert.throws(() => readS2DesignReview({ ...sourceReview, sourceIssues: [{ ...sourceIssue, quote: '并不存在的用户要求' }] }, brief, corrected, { strictEvidence: true, sources: reviewSources }), /原始来源/);
assert.throws(() => readS2DesignReview(sourceReview, brief, corrected, { strictEvidence: true }), /原始来源/);
const advisoryStages: string[] = []; let advisoryReviews = 0;
const advisoryFixed = await designS2Canvas(scene, { disclosure: 'complete', invoke: async request => {
  const input = JSON.parse(request.userInput); advisoryStages.push(input.stage);
  if (input.stage === 'understand') return response(brief);
  if (input.stage === 'assemble') return response(corrected);
  if (++advisoryReviews === 1) return response({ verdict: 'revise', coverage, factChecks: [], feedback: '全部满足，但建议增加更多插件' });
  assert.match(input.reviewFormatError, /revise须指出/);
  return response({ verdict: 'accept', coverage, factChecks: [], feedback: '可选优化不阻断验收；这仍只是合成审查结果' });
} });
assert.deepEqual(advisoryStages, ['understand', 'assemble', 'review', 'review'], 'An inconsistent verdict repairs the reviewer, not a valid scene');
assert.deepEqual(advisoryFixed.initial, corrected.initial);
const { delivery: _, ...legacyBrief } = brief;
assert.equal(readS2DesignBrief(legacyBrief).delivery, undefined, 'Legacy source remains readable without fabricating scope');
assert.throws(() => readS2DesignBrief(legacyBrief, undefined, { requireDelivery: true }), /必须明确delivery/);

const original = JSON.stringify(candidate), stages: string[] = []; let reviews = 0, assemblies = 0;
let richRepairRequest: LlmCallRequest | undefined;
// Capture this legacy private-reference repair with an explicitly declared provider
// window, then check the complete request against the default window below as well.
// Ordinary cases above stay at 64K; a compact catalogue may make this case fit too.
const fixed = await withS2DesignContext(131072, () => designS2Canvas(scene, { disclosure: 'complete', invoke: async request => {
  const input = JSON.parse(request.userInput); stages.push(input.stage);
  assert.equal(request.systemPromptOverride!.includes(S2_BUILDER_CANVAS_RULES), input.stage === 'assemble', 'Only assembly and its repairs receive the declarative canvas schema');
  assert.ok(!request.systemPromptOverride!.includes(S2_PLUGIN_PROTOCOL_RULES));
  assert.ok(!request.systemPromptOverride!.includes(S2_WORKFLOW_AGENT_RULES), 'Design stages do not receive the interaction execution manual');
  if (input.stage === 'understand') return response(brief);
  if (input.stage === 'assemble') {
    if (++assemblies === 1) return response(candidate);
    richRepairRequest = structuredClone(request);
    assert.equal(input.feedback.verdict, 'revise'); assert.equal(input.feedback.factChecks.length, 3);
    assert.deepEqual(input.previousCandidate, candidate, 'Targeted repair must retain the complete original candidate');
    assert.match(input.repairContext.evidencePathCatalogScope, /仅索引审查引用路径/);
    assert.match(input.repairContext.evidencePathCatalogScope, /完整候选.*previousCandidate/);
    assert.deepEqual(new Set(input.repairContext.evidencePathCatalog), new Set([...coverage.flatMap(item => item.evidencePaths), '/instructions/planning']));
    return response({ repair: { operations: [{ op: 'replace', path: '/instructions/planning', value: goodProse }] } });
  }
  if (++reviews === 1) return response({ verdict: 'accept', coverage, factChecks: checks.map(c => ({ ...c, matches: true })), feedback: 'Synthetic wrong factual review' });
  if (reviews === 2) {
    assert.match(input.reviewFormatError, /与真实画布不符/);
    return response({ verdict: 'revise', coverage, factChecks: checks, feedback: '修改说明与实际参数来源的矛盾，不要求补成完整筛选流程' });
  }
  assert.equal(input.candidate.instructions.planning, goodProse);
  return response({ verdict: 'accept', coverage, factChecks: [{ ...quote('confirmRule目前展示固定示例'), claim: actual[0].claim, matches: true }], feedback: 'Synthetic: corrected prose, intentional exercise blank retained' });
} }));
assert.deepEqual(stages, ['understand', 'assemble', 'review', 'review', 'assemble', 'review']);
assert.deepEqual(fixed.initial, candidate.initial, 'Fix is allowed to correct prose instead of forcing new business nodes or fake dependencies');
assert.equal(fixed.instructions.planning, goodProse); assert.equal(JSON.stringify(candidate), original);
assert.deepEqual(fixed.designBrief!.delivery, brief.delivery);
assert.ok(richRepairRequest);
const richRequestBefore = JSON.stringify(richRepairRequest);
let dispatchedDefaultCalls = 0;
let budgetFailure: SceneContextBudgetError | undefined;
let defaultDiagnostics: ReturnType<typeof fitSceneContextBudget>['diagnostics'];
try { defaultDiagnostics = fitSceneContextBudget(richRepairRequest, { provider: null }).diagnostics; }
catch (error) {
  assert.ok(error instanceof SceneContextBudgetError);
  budgetFailure = error; defaultDiagnostics = error.diagnostics;
}
assert.equal(defaultDiagnostics!.contextWindowTokens, 65536);
assert.equal(defaultDiagnostics!.outputReserveTokens, 16384);
assert.equal(defaultDiagnostics!.safetyReserveTokens, 6554);
const defaultCall = withSceneContextBudget(async request => {
  dispatchedDefaultCalls++;
  assert.deepEqual(request, richRepairRequest, 'An accepted request reaches the model boundary complete and unchanged');
  return { content: '{}' };
}, { provider: null });
if (budgetFailure) {
  assert.equal(budgetFailure.code, 'protected-context-too-large');
  await assert.rejects(defaultCall(richRepairRequest), error => error instanceof SceneContextBudgetError && error.code === 'protected-context-too-large');
  assert.equal(dispatchedDefaultCalls, 0, 'An oversized rich request is rejected before any model call');
} else {
  await defaultCall(richRepairRequest);
  assert.equal(dispatchedDefaultCalls, 1, 'A rich request that fits after compaction is dispatched exactly once');
}
assert.equal(JSON.stringify(richRepairRequest), richRequestBefore, 'Budget handling never truncates the full candidate, sources or review facts');
assert.equal(JSON.stringify(candidate), original);
let missingScopeCalls = 0;
await assert.rejects(() => designS2Canvas(scene, { disclosure: 'complete', invoke: async request => {
  missingScopeCalls++; assert.equal(JSON.parse(request.userInput).stage, 'understand'); return response(legacyBrief);
} }), /必须明确delivery/);
assert.equal(missingScopeCalls, 2, 'Missing scope gets only the existing one format repair; no assembly or automatic default');
console.log('S2 design consistency passed: required fresh delivery + legacy reads, grounded quotes, recomputed link/source/type/data-control dependencies, actual condition predicates, phantom-endpoint rejection, read-only review prompts, bounded six-call prose-only fix and intentional exercise gaps retained. Synthetic decisions only; NO real-model or execution claim.');
