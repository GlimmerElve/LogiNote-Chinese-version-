import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { parseSceneSpec } from '../src/services/scene/sceneGenerator';
import { preflightSceneSpec, resolveSceneAssembly } from '../src/services/scene/sceneAssembly';
import { s4AllowedNodeTypes, s4SubmissionLimit, isS4ReferenceUnlocked, unlockS4ReferenceAnswer } from '../src/services/scene/sceneS4Policy';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { applyS4Completion, checkS4Completion, s4SubmissionCount } from '../src/services/scene/derivationRuntime';
import { isSceneOutputTruncated } from '../src/services/scene/sceneOutputSafety';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SceneSpecPreview } from '../src/components/scene/SceneSpecPreview';

globalThis.fetch = async () => assert.fail('S4 lifecycle regressions must remain offline');
const scene = parseSceneSpec(JSON.stringify({meta: {name: '合成推导', subject: '数学', goal: '求解x'},
  task: '2*x=4，求x', metrics: [], completion: {mode: 'signal', maxTurns: 2},
  compute: {type: 'formula', operation: 'solve', expected_formula: 'x=2', expected_steps: ['2*x=4', 'x=2'],
    given: [{name: '关系', display: '2*x=4'}], symbols: [{name: 'x', kind: 'variable'}]},
}), 'S4');
const proposal = resolveSceneAssembly({sceneSkill: 'S4', recipeId: 'guided-derivation', requestedCapabilities: []});
assert.equal(proposal.valid, true, 'design proposals still assemble required components');
for (const capabilityIds of [[], ['compute-help'], ...proposal.requiredCapabilities.map(missing => proposal.requiredCapabilities.filter(id => id !== missing))]) {
  const spec = {...scene, capabilityIds} as typeof scene;
  const before = JSON.stringify(spec), result = preflightSceneSpec(spec);
  assert.equal(result.valid, false);
  for (const missing of proposal.requiredCapabilities.filter(id => !spec.capabilityIds!.includes(id))) {
    assert.ok(result.diagnostics.some(issue => issue.code === 'missing-required-capability' && issue.capabilityId === missing));
    assert.ok(!result.enabledCapabilities.includes(missing), 'preflight cannot report implied grants as active');
  }
  assert.equal(JSON.stringify(spec), before, 'preflight cannot mutate stored permission');
}
const explicit = {...scene, capabilityIds: proposal.requiredCapabilities};
assert.equal(preflightSceneSpec(explicit).valid, true);
assert.equal(s4AllowedNodeTypes(explicit).includes('assumption'), false);
const legacy = {...scene, capabilityIds: undefined};
assert.equal(preflightSceneSpec(legacy).valid, true);
assert.ok(preflightSceneSpec(legacy).enabledCapabilities.includes('assumption-node'));
assert.ok(s4AllowedNodeTypes(legacy).includes('assumption'));
assert.ok(preflightSceneSpec(legacy).enabledCapabilities.includes('compute-help'));
const preview = renderToStaticMarkup(createElement(SceneSpecPreview, {
  spec: {...legacy, promptModuleIds: [], completion: {...legacy.completion, maxTurns: 2}}, busy: false, onChange() {}, onStart() {}, onDelete() {},
}));
assert.match(preview, /最多接收 2 次节点验证提交/);
assert.match(preview, /编辑、求助和讲解不计入次数/);
assert.doesNotMatch(preview, /结束由对话自然推进决定|最多 2 回合|信号判定模式/);

const run = createRunState(scene);
const exhausted = {...run, turnCount: 0, derivationEvents: [
  {type: 'node_submit', nodeId: 'a', latex: 'x', at: ''}, {type: 'node_submit', nodeId: 'a', latex: 'x+1', at: ''},
]} as typeof run;
assert.equal(s4SubmissionCount(exhausted), 2, 'historical events recover missing S4 counters');
assert.equal(checkS4Completion({...scene, completion: {...scene.completion, maxTurns: 2}}, exhausted).status, 'failure');
assert.equal(s4SubmissionCount({...run, turnCount: 4}), 4, 'mirror count remains backward compatible');
assert.equal(s4SubmissionCount({...run, turnCount: Number.NaN}), 0);
assert.equal(s4SubmissionLimit({...scene, completion: {...scene.completion, maxTurns: Number.NaN}}), 12);

const auto = applyS4Completion(scene, {...exhausted, endedByUser: false});
assert.equal(auto.status, 'failure'); assert.equal(isS4ReferenceUnlocked(auto), false);
const revealed = unlockS4ReferenceAnswer(scene, auto);
assert.equal(isS4ReferenceUnlocked(revealed), true);
assert.deepEqual({...revealed, s4ReferenceUnlocked: undefined}, {...auto, s4ReferenceUnlocked: undefined}, 'consent changes no lifecycle, score, counters or events');
assert.equal(revealed.endedByUser, false, 'viewing an answer cannot rewrite automatic completion as a user ending');
assert.equal(unlockS4ReferenceAnswer(scene, revealed), revealed, 'consent is idempotent');
assert.equal(unlockS4ReferenceAnswer(scene, run), run, 'running scenes cannot unlock');
assert.equal(unlockS4ReferenceAnswer({...scene, sceneId: 'other'}, auto), auto);
assert.equal(unlockS4ReferenceAnswer({...scene, meta: {...scene.meta, sceneSkill: 'S1'}}, auto), auto);
assert.equal(isS4ReferenceUnlocked({...run, s4ReferenceUnlocked: true}), false);
assert.equal(isS4ReferenceUnlocked(applyS4Completion(scene, run, {userIntentEnd: true})), true, 'manual ending keeps prior behavior');

// Execute production functions with synthetic IO, not reimplementations of their decision logic.
const source = ts.createSourceFile('compute.ts', readFileSync('src/services/scene/computeAnalyze.ts', 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
function loadFunction(name: string, env: Record<string, unknown>): any {
  const declaration = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)!;
  assert.ok(declaration);
  const js = ts.transpileModule(declaration.getText(source).replace(/^export\s+/, '') + '\nreturn ' + name,
    {compilerOptions: {target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None}}).outputText;
  return new Function(...Object.keys(env), js)(...Object.values(env));
}
for (const finishReason of ['length', 'max_tokens', 'MAX-OUTPUT-TOKENS', 'max_completion_tokens', 'token limit', 'stop']) {
  for (const content of [JSON.stringify({sympy_expr: 'x+1', confidence: .99}), '{"sympy_expr":"x+1"']) {
    if (finishReason === 'stop' && !content.endsWith('}')) continue;
    let engineCalls = 0, llmCalls = 0;
    const resolve = loadFunction('resolveNodeExpression', {
      isSceneOutputTruncated, buildSessionSymbols: () => [], buildParseInput: () => 'synthetic input',
      parseJsonLenient: JSON.parse, PARSE_MIN_CONFIDENCE: .6, humanizeComputeError: (message: string) => message,
      parseExpression: async (raw: string) => ++engineCalls === 1 ? {ok: false, error: 'synthetic'} : {ok: true, result: {sympyExpr: raw}},
      callLLM: async () => {llmCalls++; return {content, diagnostics: {finishReason}};},
    });
    const result = await resolve({type: 'formula', data: {latex: 'x^2+2*x+1'}}, scene);
    assert.equal(result.ok, finishReason === 'stop');
    assert.equal(llmCalls, 1, 'truncation never triggers the automatic engine-repair retry');
    assert.equal(engineCalls, finishReason === 'stop' ? 2 : 1, 'cut output never reaches expression verification');
    if (finishReason !== 'stop') assert.match(result.error, /截断/);
  }
  let feedbackCalls = 0;
  const qualitative = loadFunction('requestQualitativeFeedback', {isSceneOutputTruncated,
    buildAnalyzeInput: () => 'synthetic input', parseJsonLenient: JSON.parse,
    callLLM: async () => {feedbackCalls++; return {content: JSON.stringify({feedback: 'MODEL_FEEDBACK'}), diagnostics: {finishReason}};},
  });
  const analysis = loadFunction('analyzeStep', {
    nodePermissionFailure: () => undefined, resolveNodeExpression: async () => ({ok: true, expr: 'x=2'}),
    collectBranchPremises: () => ({ignoredAncestorIds: [], facts: [], assumptions: [], domains: [], globalDomains: []}),
    judgeStepLegitimacy: async () => ({legit: 'illegal', code: 'synthetic'}),
    legitFeedback: () => ({status: 'fail', text: 'LOCAL_ENGINE_FEEDBACK'}), requestQualitativeFeedback: qualitative,
  });
  const feedback = await analysis({spec: scene, run, node: {id: 'step', type: 'formula', data: {latex: 'x=2'}}, sessionId: 'synthetic'});
  assert.equal(feedback.verification.feedback, finishReason === 'stop' ? 'MODEL_FEEDBACK' : 'LOCAL_ENGINE_FEEDBACK');
  assert.equal(feedback.verification.formula_correct, false, 'neither truncation nor the LLM changes the engine verdict');
  assert.equal(feedback.status, 'fail'); assert.equal(feedbackCalls, 1);
}
console.log('S4 lifecycle passed: explicit permissions fail closed, legacy/proposal compatibility, event-backed submission counts, post-terminal reference consent without lifecycle rewrites, truncated formula/feedback rejection and local verdict fallback. Offline synthetic IO only.');
