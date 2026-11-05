import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { MetricSpec, SceneSpec } from '../src/types';
import { SceneSpecPreview } from '../src/components/scene/SceneSpecPreview';
import { parseSceneSpec } from '../src/services/scene/sceneGenerator';
import { normalizeSceneSpec } from '../src/services/scene/sceneSkillStore';
import { preflightSceneSpec } from '../src/services/scene/sceneAssembly';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { checkS4Completion, computeMaxHelp, deriveEngineMetricRaw, updateS4Metrics } from '../src/services/scene/derivationRuntime';
import { s4GoalAssessment } from '../src/services/scene/sceneS4Goal';
import { isS4HelpAuthorized, resolveS4MetricBinding, s4AllowedNodeTypes, isS4CanvasChangeAuthorized } from '../src/services/scene/sceneS4Policy';
import { analyzeStep, analyzeAssumptionStep } from '../src/services/scene/computeAnalyze';
import { collectBranchPremises } from '../src/services/scene/premiseChain';
import { buildHelpInput, requestHelp } from '../src/services/scene/sceneHelp';
import { SCENE_COMPUTE_GENERATE_PROMPT, SCENE_COMPUTE_ADAPT_PROMPT, SCENE_COMPUTE_CONFIG_PROMPT, SCENE_HELP_PROMPT } from '../src/workflows/sceneComputePrompt';

globalThis.fetch = async () => assert.fail('S4 policy regressions must remain offline');
const metric: MetricSpec = { id: 'custom-proof', name: '自定义数学判据', description: '前提链合法性',
  source: 'engine', s4Binding: 'formula-correctness', type: 'boolean', initial: false, target: true };
const spec = parseSceneSpec(JSON.stringify({
  meta: { name: '合成数理场景', subject: '数学', goal: '证明指定关系' },
  situation: '给定一个代数关系', task: '推导最终关系', metrics: [metric],
  compute: { type: 'formula', operation: 'solve', expected_formula: 'x=183719', expected_steps_count: 10,
    given: [{ name: '前提', display: 'x>0' }], symbols: [{ name: 'x', kind: 'variable' }], boundary_conditions: [],
    expected_steps: [{ display: 'PRIVATE_STEP_DISPLAY_7295', symbolic: 'PRIVATE_STEP_SYMBOLIC_7295' }] },
  help: { base_help_count: 3, max_help_count: 3, difficulty_factor: 1, user_factor: 1, penalty_per_help: .1 },
}), 'S4');
// Use a known step count after parsing; the parser aligns it with supplied reference steps.
spec.compute!.expected_steps_count = 10;
assert.equal(preflightSceneSpec(spec).valid, true);
const snapshot = JSON.stringify(spec);
for (const saved of [spec, normalizeSceneSpec(JSON.parse(snapshot))!]) {
  for (const startError of [undefined, '合成保存失败，请重试']) {
    const html = renderToStaticMarkup(createElement(SceneSpecPreview, {
      spec: saved, busy: false, startError, onChange() {}, onStart() {}, onDelete() {},
    }));
    for (const secret of ['183719', 'PRIVATE_STEP_DISPLAY_7295', 'PRIVATE_STEP_SYMBOLIC_7295']) {
      assert.ok(!html.includes(secret), `private compute cannot enter preview DOM: ${secret}`);
    }
    assert.match(html, /标准答案与参考步骤在预览中保持隐藏/);
    assert.doesNotMatch(html, /1e-9|小数近似会被判为不等价/);
    assert.equal(saved.compute!.expected_formula, 'x=183719', 'privacy is display-only, not deletion or regeneration');
  }
}
assert.equal(JSON.stringify(spec), snapshot, 'preview is read-only');

const verdict = { formula_correct: true, dimension_check: true, verdictSource: 'premise' as const, feedback: '合成前提链已验证' };
for (const definition of [metric, { ...metric, id: 'proof_validity', name: '推导合法', s4Binding: undefined },
  { ...metric, id: 'renamed-again', name: '任意显示名称' }]) {
  const scene = { ...spec, metrics: [definition] };
  const run = createRunState(scene);
  run.canvas!.nodes.push({ id: 'done', type: 'conclusion', position: { x: 400, y: 40 },
    data: { label: '结论', latex: 'x=183719', status: 'pass', frozen: false, verification: verdict } });
  run.canvas!.edges.push({ id: 'premise', source: run.canvas!.nodes[0].id, target: 'done', type: 'derivation' });
  run.canvas!.nodes.find(node=>node.id==='done')!.data.verification = {...verdict,goalAssessment:s4GoalAssessment(scene,run,'done',{status:'achieved',reason:'synthetic coverage'})};
  assert.equal(checkS4Completion(scene, run).status, 'success', 'live verified proof outranks a stale metric mirror');
  assert.equal(checkS4Completion(scene, updateS4Metrics(scene, run, verdict)).status, 'success', 'renaming cannot stall a verified branch');
}
for (const definition of [
  { ...metric, s4Binding: 'invented' }, { ...metric, source: 'rule' }, { ...metric, type: 'count' },
  { ...metric, id: 'unmapped', name: '未知', s4Binding: undefined },
]) {
  const result = preflightSceneSpec({ ...spec, metrics: [definition as MetricSpec] }, { allowDeferredCompute: true });
  assert.ok(result.diagnostics.some(item => item.code === 'invalid-s4-metric-binding' && item.severity === 'error'));
}
assert.equal(resolveS4MetricBinding({ ...metric, id: 'unrelated', name: '不影响', source: 'rule', type: 'count', s4Binding: 'help-used' }), 'help-used');
assert.equal(deriveEngineMetricRaw({ ...metric, type: 'continuous', s4Binding: 'numerical-error' }, verdict), undefined,
  'no invented numerical evidence when engine did not provide it');
const errorScene: SceneSpec = { ...spec, metrics: [{ ...metric, type: 'continuous', initial: 1, target: .05, s4Binding: 'numerical-error' }] };
for (const definition of [errorScene.metrics[0], { ...metric, s4Binding: 'dimension-check' as const },
  { ...metric, type: 'count' as const, s4Binding: 'boundary-count' as const }]) {
  const unavailable = preflightSceneSpec({ ...spec, metrics: [definition] }, { allowDeferredCompute: true });
  assert.equal(unavailable.valid, false, 'historical bindings without live producers cannot become mandatory completion conditions');
  assert.ok(unavailable.diagnostics.some(item => item.code === 'invalid-s4-metric-binding' && item.message.includes('测量数据源')));
}
const errorRun = createRunState(errorScene);
errorRun.canvas!.nodes.push({ id: 'done', type: 'conclusion', position: { x: 400, y: 40 },
  data: { label: '结论', latex: 'x=183719', status: 'pass', frozen: false, verification: verdict } });
errorRun.canvas!.edges.push({ id: 'premise', source: errorRun.canvas!.nodes[0].id, target: 'done', type: 'derivation' });
errorRun.canvas!.nodes.find(node=>node.id==='done')!.data.verification = {...verdict,goalAssessment:s4GoalAssessment(errorScene,errorRun,'done',{status:'achieved',reason:'synthetic coverage'})};
assert.equal(checkS4Completion(errorScene, updateS4Metrics(errorScene, errorRun, { ...verdict, numerical_error: .01 })).status, 'success');
assert.equal(checkS4Completion(errorScene, updateS4Metrics(errorScene, errorRun, { ...verdict, numerical_error: .1 })).status, 'running', 'error limits are upper bounds, not lower bounds');
assert.equal(preflightSceneSpec({ ...spec, meta: { ...spec.meta, sceneSkill: 'S1' }, capabilityRecipeId: undefined,
  behavior: undefined, runtimeContract: undefined, metrics: [{ ...metric, s4Binding: 'invented' } as unknown as MetricSpec] }).valid, true,
  'S4 binding validation cannot constrain legacy S1 metrics');

const legacyRun = createRunState(spec);
assert.equal(isS4HelpAuthorized(spec), true, 'legacy absent list retains old permission');
assert.equal(computeMaxHelp(spec), 2);
let calls = 0;
const caller: NonNullable<Parameters<typeof requestHelp>[0]['callLlm']> = async request => {
  calls++;
  assert.equal(request.workflow, 'scene-help');
  assert.equal(request.skipMemoryInjection, true);
  assert.equal(request.skipProfileInjection, true);
  return { content: JSON.stringify({ latex: 'x+1>1', reason: '合成下一步' }) } as any;
};
for (const denied of [
  { ...spec, capabilityIds: [] },
  { ...spec, capabilityIds: ['formula-node', 'step-submit'] },
]) {
  const scene = denied as SceneSpec;
  assert.equal(isS4HelpAuthorized(scene), false);
  assert.equal(computeMaxHelp(scene), 0);
  assert.equal(createRunState(scene).canvas!.maxHelp, 0);
  const result = await requestHelp({ spec: scene, run: legacyRun, currentNodeId: null, query: '提示', callLlm: caller });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.reason, 'not-authorized');
}
assert.equal(calls, 0, 'even stale run quota cannot bypass component authorization');
for (const help of [{ ...spec.help!, max_help_count: 0 }, { ...spec.help!, base_help_count: 0 }]) {
  const scene = { ...spec, help };
  assert.equal(computeMaxHelp(scene), 0);
  assert.equal((await requestHelp({ spec: scene, run: legacyRun, currentNodeId: null, query: '', callLlm: caller })).ok, false);
}
for (const run of [{ ...legacyRun, status: 'success' as const }, { ...legacyRun, sceneId: 'other' }]) {
  const result = await requestHelp({ spec, run, currentNodeId: null, query: '', callLlm: caller });
  assert.equal(result.ok, false); if (!result.ok) assert.equal(result.reason, 'inactive');
}
assert.equal(calls, 0);
const active = { ...spec, capabilityIds: ['compute-help'] as SceneSpec['capabilityIds'] };
const success = await requestHelp({ spec: active, run: legacyRun, currentNodeId: null, query: '只提示下一步', callLlm: caller });
assert.equal(success.ok, true); assert.equal(calls, 1);
if (success.ok) { assert.equal(success.nextRun.canvas!.helpUsed, 1); assert.equal(success.remaining, 1); }
assert.equal(legacyRun.canvas!.helpUsed, 0, 'service preserves original input state');
const beforeFailure = JSON.stringify(legacyRun);
for (const finishReason of ['length', 'max_tokens', 'MAX-OUTPUT-TOKENS', 'max_completion_tokens', 'token limit']) {
  for (const content of [JSON.stringify({latex: 'x=2', reason: '看似完整'}), '{"latex":"x=2"']) {
    let attempts = 0;
    const truncated = await requestHelp({spec, run: legacyRun, currentNodeId: null, query: '合成截断', callLlm: async () => {
      attempts++; return {content, diagnostics: {finishReason}} as any;
    }});
    assert.equal(truncated.ok, false);
    if (!truncated.ok) assert.equal(truncated.reason, 'truncated');
    assert.equal(attempts, 1); assert.equal(JSON.stringify(legacyRun), beforeFailure);
  }
}

const requiredOnly = {...spec, capabilityIds: ['given-node', 'formula-node', 'conclusion-node', 'step-submit', 'premise-validation'] as SceneSpec['capabilityIds']};
assert.ok(!s4AllowedNodeTypes(requiredOnly).includes('assumption'));
assert.ok(s4AllowedNodeTypes(spec).includes('assumption'), 'absent legacy list keeps assumptions available');
const assumption: any = {id: 'historical-assumption', type: 'assumption', position: {x: 10, y: 10},
  data: {latex: 'x>0', status: 'pass', frozen: false,verification:verdict}};
const downstream: any = {...assumption, id: 'downstream', type: 'formula', data: {...assumption.data, latex: 'x+1>1', status: 'draft'}};
const branch = {...legacyRun, canvas: {...legacyRun.canvas!, nodes: [...legacyRun.canvas!.nodes, assumption, downstream],
  edges: [{id: 'branch', source: assumption.id, target: downstream.id, type: 'derivation' as const}]}};
assert.deepEqual(collectBranchPremises(downstream, branch.canvas, requiredOnly).assumptions, []);
assert.ok(collectBranchPremises(downstream, branch.canvas, requiredOnly).ignoredAncestorIds.includes(assumption.id));
assert.deepEqual(collectBranchPremises(downstream, branch.canvas, spec).assumptions, ['x>0']);
for (const analyzer of [analyzeStep, analyzeAssumptionStep]) {
  for (const node of [assumption, downstream]) {
    const denied = await analyzer({spec: requiredOnly, run: branch, node, sessionId: 'offline-no-io'});
    assert.equal(denied.status, 'warn'); assert.equal(denied.verification.verdictSource, 'none');
    assert.match(denied.verification.feedback, /未启用/);
    assert.deepEqual(denied.metricUpdates, []);
  }
}
const allowedTypes = s4AllowedNodeTypes(requiredOnly);
assert.equal(isS4CanvasChangeAuthorized(legacyRun.canvas!, branch.canvas, allowedTypes), false);
assert.equal(isS4CanvasChangeAuthorized(branch.canvas, {...branch.canvas, nodes: branch.canvas.nodes.filter(n => n.id !== assumption.id), edges: []}, allowedTypes), true);
assert.equal(isS4CanvasChangeAuthorized(branch.canvas, {...branch.canvas, nodes: branch.canvas.nodes.map(n => n.id === assumption.id ? {...n, data: {...n.data, latex: 'x<0'}} : n)}, allowedTypes), false);
assert.equal((await requestHelp({ spec, run: legacyRun, currentNodeId: null, query: '',
  callLlm: async () => { throw new Error('synthetic failure'); } })).ok, false);
assert.equal(JSON.stringify(legacyRun), beforeFailure, 'failed help cannot consume quota');
const input = buildHelpInput({ spec, run: legacyRun, currentNodeId: null, query: '解释近似' });
assert.match(input, /前提链/); assert.match(input, /近似条件、精度及误差/);
assert.doesNotMatch(input, /1e-9|不要写小数近似/);
for (const prompt of [SCENE_COMPUTE_GENERATE_PROMPT, SCENE_COMPUTE_ADAPT_PROMPT]) assert.match(prompt, /s4Binding/);
for (const prompt of [SCENE_COMPUTE_CONFIG_PROMPT, SCENE_HELP_PROMPT]) assert.doesNotMatch(prompt, /1e-9|大概率判为不等价/);
console.log('S4 policy passed: private saved/retry preview, stable renamed/legacy metric binding, invalid binding preflight, capability and zero-budget gates in UI policy/service, inactive-run rejection, success/failure quota integrity, premise-chain prompts and S1 isolation. Offline synthetic IO only.');
