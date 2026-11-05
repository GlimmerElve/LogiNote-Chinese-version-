import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LlmCallRequest, SceneSpec } from '../src/types';
import { designSceneBehavior, applySceneBehaviorDesign, type SceneBuildContext, type SceneBuildDesign } from '../src/services/scene/sceneBuildAgent';
import { parseSceneSpec, applySceneAssemblyPlan } from '../src/services/scene/sceneGenerator';
import { normalizeSceneSpec } from '../src/services/scene/sceneSkillStore';
import { preflightSceneSpec } from '../src/services/scene/sceneAssembly';
import { resolveSceneRuntimeContract } from '../src/services/scene/sceneRuntimeContract';
import { buildS4AssistantContext } from '../src/services/scene/sceneS4AssistantContext';
import { buildAnalyzeInput } from '../src/services/scene/computeAnalyze';
import { buildHelpInput, requestHelp } from '../src/services/scene/sceneHelp';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { applyHelpPenalty, computeFinalScore } from '../src/services/scene/derivationRuntime';
import { s4HelpPenalty } from '../src/services/scene/sceneS4Policy';
import { SceneSpecPreview } from '../src/components/scene/SceneSpecPreview';
import { fitSceneContextBudget } from '../src/services/scene/sceneContextBudget';

globalThis.fetch = async () => assert.fail('S4 separation checks must stay offline');
const context: SceneBuildContext = { version: 1, userRequest: '合成数理画布任务', conversation: [], selectedSurface: 'S4', explicitSelections: {} };
const flow = { flowGuidance: 'FLOW_7481：允许合法的多条支路', evaluationRule: 'EVAL_7481：只解释前提链结果',
  progressionRule: 'PROGRESS_7481：先解释当前步骤再给提示', completionRule: 'COMPLETE_7481：不替换引擎判定', maxTurns: 30 };
const instructions = { aiBehavior: '数理助理', userAction: '在画布提交节点', understanding: 'UNDERSTAND_7481：辨识当前引用前提',
  planning: 'PLAN_7481：先讲几何直觉', response: 'RESPONSE_7481：用形象例子解释，不代判合法性' };
let design!: SceneBuildDesign;
for (const legacy of [{}, { stages: 'inactive legacy data', initialStageId: 123, answerFeedback: { correctness: 'unused' } },
  { stages: [{ id: 'start', goal: 'Start', allowedNext: [] }, { id: 'unused', goal: 'Unused', allowedNext: [] }], initialStageId: 'start' }]) {
  const calls: string[] = [];
  design = await designSceneBehavior(context, { invoke: async call => {
    const input = JSON.parse(call.userInput); calls.push(input.phase);
    if (input.phase === 'flow') {
      assert.doesNotMatch(call.systemPromptOverride!, /"stages":|"answerFeedback":/);
      return { content: JSON.stringify({ ...flow, ...legacy }) };
    }
    assert.equal(input.phase, 'instructions');
    assert.equal(input.priorArtifacts.flow.stages, undefined);
    assert.equal(input.priorArtifacts.flow.answerFeedback, undefined);
    return { content: JSON.stringify(instructions) };
  } });
  assert.deepEqual(calls, ['flow', 'instructions'], 'unused S1 fields cannot spend a repair request');
  assert.equal(design.flow.stages, undefined); assert.equal(design.flow.answerFeedback, undefined);
  const resumed = await designSceneBehavior(context, { recovery: { flow: { ...flow, ...legacy } as any, instructions, stages: {} },
    invoke: async () => assert.fail('accepted canvas design resumes without a new model call') });
  assert.equal(resumed.flow.stages, undefined); assert.equal(resumed.flow.answerFeedback, undefined);
}
for (const invalid of [{ ...flow, maxTurns: 0 }, { ...flow, flowGuidance: '' },
  { ...flow, flowGuidance: 'a'.repeat(2800), evaluationRule: 'b'.repeat(2800), progressionRule: 'c'.repeat(1000) }]) {
  let calls = 0;
  await assert.rejects(designSceneBehavior(context, { invoke: async () => {
    calls++; return { content: JSON.stringify(invalid) };
  } }), /invalid-flow|invalid-design/);
  assert.equal(calls, 2, 'S4 mathematical strategy and budget validation remains bounded');
}
for (const invalid of [
  { ...flow, answerFeedback: { correctness: 'immediate', explanation: 'immediate' } },
  { ...flow, answerFeedback: { correctness: 'immediate', explanation: 'immediate' }, stages: [
    { id: 'start', goal: 'Start', allowedNext: [] }, { id: 'unused', goal: 'Unused', allowedNext: [] }], initialStageId: 'start' },
]) {
  let calls = 0;
  await assert.rejects(designSceneBehavior({ ...context, selectedSurface: 'S1' }, { invoke: async () => {
    calls++; return { content: JSON.stringify(invalid) };
  } }), /invalid-flow/);
  assert.equal(calls, 2, 'S1 stage schema and reachability are still enforced');
}

const base = parseSceneSpec(JSON.stringify({ meta: { name: '合成数学', subject: '数学', goal: 'GOAL_7481：求解未知量' },
  task: 'TASK_7481：给定2*x+3=7，求解x', rules: ['RULE_7481：先讲直观含义，再给当前步骤提示'],
  compute: { type: 'formula', operation: 'solve', expected_formula: 'x=2', expected_steps_count: 10,
    given: [{ name: '关系', display: '2*x+3=7' }], symbols: [{ name: 'x', kind: 'variable' }], boundary_conditions: [] },
  help: { base_help_count: 2, max_help_count: 2, difficulty_factor: 1, user_factor: 1, penalty_per_help: .4 },
  metrics: [{ id: 'proof', name: '推导', type: 'boolean', initial: true, target: true, source: 'engine', s4Binding: 'formula-correctness' },
    { id: 'independence', name: '独立性', type: 'continuous', initial: 1, target: .8, source: 'rule', s4Binding: 'independence-score', range: [0, 1] },
    { id: 'help-used', name: '求助次数', type: 'count', initial: 0, target: 2, source: 'rule', s4Binding: 'help-used' }],
}), 'S4');
const spec = applySceneAssemblyPlan(applySceneBehaviorDesign(base, design), { subject: '数学', knowledgePoints: [], sceneSkill: 'S4', recipeId: 'guided-derivation' });
spec.injectProfile = false;
const before = JSON.stringify(spec);
for (const old of [{ stages: [{ id: 'a', goal: 'A', allowedNext: [] }, { id: 'unused', goal: 'B', allowedNext: [] }], initialStageId: 'a' },
  { stages: 'unused', initialStageId: 'missing', answerFeedback: { correctness: 'unused', explanation: 'unused' } }]) {
  const scene = { ...spec, runtimeContract: { ...spec.runtimeContract, ...old } } as unknown as SceneSpec;
  assert.equal(preflightSceneSpec(scene).valid, true);
  const resolved = resolveSceneRuntimeContract(scene);
  assert.equal(resolved.stages, undefined); assert.equal(resolved.initialStageId, undefined); assert.equal(resolved.answerFeedback, undefined);
  assert.deepEqual(resolved.allowedActions, []); assert.deepEqual(resolved.allowedTools, []);
}
for (const allowedTools of [['model-experiment'], ['invented-tool']]) {
  assert.equal(preflightSceneSpec({ ...spec, runtimeContract: { ...spec.runtimeContract, allowedTools } } as unknown as SceneSpec).valid, false);
}
const s1 = parseSceneSpec(JSON.stringify({ meta: { name: 'S1', goal: 'Dialogue' }, task: 'Dialogue',
  behavior: { recipeId: 'agent-designed', kind: 'Dialogue', aiBehavior: '回应', userAction: '提问', evaluationRule: '按需评价', progressionRule: '按需继续',
    interaction: { allowedTypes: ['text'], defaultType: 'text', allowTextFallback: true } } }), 'S1');
assert.equal(preflightSceneSpec({ ...s1, runtimeContract: { stages: [{ id: 'a', goal: 'A', allowedNext: [] },
  { id: 'unused', goal: 'B', allowedNext: [] }], initialStageId: 'a' } as any }).valid, false);
assert.throws(() => resolveSceneRuntimeContract({ ...s1, runtimeContract: { answerFeedback: { correctness: 'unused' } } as any }), /answerFeedback/);
assert.equal(buildS4AssistantContext(s1, 'help'), '');

const markers = ['GOAL_7481', 'TASK_7481', 'RULE_7481', 'FLOW_7481', 'EVAL_7481', 'PROGRESS_7481', 'COMPLETE_7481',
  'UNDERSTAND_7481', 'PLAN_7481', 'RESPONSE_7481'];
for (const scene of [spec, normalizeSceneSpec(JSON.parse(JSON.stringify(spec)))!]) {
  const run = createRunState(scene);
  for (const input of [buildHelpInput({ spec: scene, run, currentNodeId: null, query: '解释' }),
    buildAnalyzeInput({ spec: scene, run, node: run.canvas!.nodes[0], userExpr: '2*x=4',
      premiseVerdict: { legit: 'legit', code: 'synthetic' }, strategy: 'premise_synthetic' })]) {
    for (const marker of markers) assert.ok(input.includes(marker), `actual helper/analyzer input omitted ${marker}`);
    assert.match(input, /数学合法性只由已连接前提的引擎判定/);
    assert.match(input, /不得调用额外工具、改变权限/);
    assert.doesNotMatch(input, /"expected_formula"|"expected_steps"/);
  }
}
assert.equal(JSON.stringify(spec), before);
const longPolicy = '长策略原文_7481：' + 'x'.repeat(10000);
const longSpec = { ...spec, agentInstructions: { ...spec.agentInstructions!, response: longPolicy } };
const longInput = buildHelpInput({ spec: longSpec, run: createRunState(longSpec), currentNodeId: null, query: '当前请求必须保留' });
assert.ok(longInput.includes(longPolicy), 'assistant compilation cannot silently clip a protected strategy');
assert.throws(() => fitSceneContextBudget({ providerId: '', model: '', workflow: 'scene-help', userInput: longInput },
  { provider: { contextWindowTokens: 4096 }, maxOutputTokens: 1024, systemPrompt: 'Fixed constraints' }), /预算/);

const run = createRunState(spec);
// Help must preserve real engine evidence, not a configured initial=true without proof.
assert.equal(run.metrics.find(item => item.metricId === 'proof')!.value, false);
run.canvas!.nodes.push({id:'verified',type:'formula',position:{x:300,y:0},data:{label:'合成已验证步骤',latex:'2*x=4',status:'pass',frozen:false,
  verification:{formula_correct:true,dimension_check:true,verdictSource:'premise',feedback:'synthetic engine evidence'}}});
run.canvas!.edges.push({id:'verified-edge',source:run.canvas!.nodes[0].id,target:'verified',type:'derivation'});
run.metrics = run.metrics.map(item=>item.metricId==='proof'?{...item,value:true}:item);
const request: LlmCallRequest[] = [];
const caller: NonNullable<Parameters<typeof requestHelp>[0]['callLlm']> = async call => {
  request.push(call);
  for (const marker of markers) assert.ok(call.userInput.includes(marker));
  return { content: JSON.stringify({ latex: '2x=4', reason: '合成提示' }) };
};
const first = await requestHelp({ spec, run, query: '提示', currentNodeId: null, callLlm: caller });
assert.equal(first.ok, true);
if (!first.ok) throw new Error('Synthetic help failed');
assert.equal(first.nextRun.canvas!.independenceScore, .6);
assert.equal(first.nextRun.metrics.find(item => item.metricId === 'independence')!.value, .6);
assert.equal(first.nextRun.metrics.find(item => item.metricId === 'help-used')!.value, 1);
assert.equal(first.nextRun.metrics.find(item => item.metricId === 'proof')!.value, true, 'help cannot fabricate or replace an engine verdict');
assert.equal(computeFinalScore({ ...spec, metrics: [] }, first.nextRun), .66);
const second = await requestHelp({ spec, run: first.nextRun, query: '再提示', currentNodeId: null, callLlm: caller });
assert.equal(second.ok, true);
if (!second.ok) throw new Error('Synthetic second help failed');
assert.equal(second.nextRun.canvas!.independenceScore, .2);
assert.equal(computeFinalScore({ ...spec, metrics: [] }, second.nextRun), .22);
assert.equal(run.canvas!.independenceScore, 1);
assert.equal(applyHelpPenalty(run.canvas!).independenceScore, .9, 'legacy default remains .1');
assert.equal(applyHelpPenalty(run.canvas!, { help: { ...spec.help!, penalty_per_help: 0 } }).independenceScore, 1);
assert.equal(s4HelpPenalty({ help: { penalty_per_help: 2 } }), 1);
assert.equal(s4HelpPenalty({ help: { penalty_per_help: Number.NaN } }), .1);
const failureSnapshot = JSON.stringify(first.nextRun);
assert.equal((await requestHelp({ spec, run: first.nextRun, query: '失败', currentNodeId: null, callLlm: async () => { throw new Error('synthetic'); } })).ok, false);
assert.equal(JSON.stringify(first.nextRun), failureSnapshot);

const html = renderToStaticMarkup(createElement(SceneSpecPreview, { spec, busy: false, onChange() {}, onStart() {}, onDelete() {} }));
assert.match(html, /type="number" min="0" max="1"/); assert.match(html, /每次求助扣 0.4/);
assert.match(html, /aria-describedby="scene-s4-help-policy"/);
const previewSource = ts.createSourceFile('preview.tsx', readFileSync('src/components/scene/SceneSpecPreview.tsx', 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
let penaltyInput: ts.JsxSelfClosingElement | undefined;
const visit = (node: ts.Node) => { if (ts.isJsxSelfClosingElement(node) && node.tagName.getText(previewSource) === 'input'
  && node.getText(previewSource).includes('penalty_per_help')) penaltyInput = node; ts.forEachChild(node, visit); };
visit(previewSource); assert.ok(penaltyInput);
const blur = penaltyInput.attributes.properties.find(item => ts.isJsxAttribute(item) && item.name.getText(previewSource) === 'onBlur') as ts.JsxAttribute;
const handler = (blur.initializer as ts.JsxExpression).expression!.getText(previewSource);
const code = ts.transpileModule(`return (${handler})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const changes: SceneSpec[] = []; let error = '';
const onBlur = new Function('spec', 'onChange', 's4HelpPenalty', 'setHelpPenaltyError', code)(spec, (next: SceneSpec) => changes.push(next), s4HelpPenalty, (next: string) => { error = next; });
for (const value of ['', '-1', '2', 'NaN']) {
  const event = { target: { value } }; onBlur(event); assert.ok(error); assert.equal(event.target.value, '0.4');
}
assert.equal(changes.length, 0);
onBlur({ target: { value: '0' } }); assert.equal(error, ''); assert.equal(changes[0].help!.penalty_per_help, 0);
console.log('S4 separation passed: independent no-stage flow/resume schema, inert legacy S1 lifecycle, unchanged permission and S1 gates, complete saved assistant context in actual inputs, configured/default/zero penalties, immediate rule metrics, unchanged engine evidence, failure integrity and accessible preview handlers. Offline synthetic IO only.');
