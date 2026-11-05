import assert from 'node:assert/strict';
import type { SceneInteractionType, ScenePromptModuleId, SceneQuestionSetItem, SceneSpec } from '../src/types';
import { parseSceneSpec } from '../src/services/scene/sceneGenerator';
import { preflightSceneSpec, resolveSceneAssembly } from '../src/services/scene/sceneAssembly';
import { compactSceneBuildProtocolProbes, probeSceneBuildProtocol } from '../src/services/scene/sceneBuildProtocolProbes';
import { SCENE_CAPABILITY_IDS, SCENE_PROMPT_MODULE_IDS } from '../src/services/scene/sceneCapabilityRegistry';
import { buildSceneAbilityCatalog } from '../src/services/scene/sceneAbilityCatalog';
import { SCENE_CAPABILITY_EXECUTION_CONTRACTS, SCENE_MODULE_EXECUTION_CONTRACTS, validateSceneExecutionCombination } from '../src/services/scene/sceneExecutionRegistry';
import { resolveSceneRuntimeContract } from '../src/services/scene/sceneRuntimeContract';

globalThis.fetch = async () => assert.fail('Combination protocol checks must remain offline');
const types: SceneInteractionType[] = ['text', 'single-choice', 'multiple-choice', 'ordering', 'fill-blanks', 'question-set'];
const children: Array<SceneQuestionSetItem['type']> = ['single-choice', 'multiple-choice', 'true-false'];
const modules: ScenePromptModuleId[] = ['turn-agent-planning', 'structured-interaction'];
const form = { id: 'synthetic-form', title: 'Synthetic material', fields: [
  { id: 'material', label: 'Material', kind: 'textarea', purpose: 'context', required: true, maxLength: 300 },
  { id: 'format', label: 'Format', kind: 'select', purpose: 'context', required: true, maxLength: 20, options: [{ value: 'plain', label: 'Plain' }] },
] };
function fixture(allowed: SceneInteractionType[], options: { form?: boolean; childTypes?: Array<SceneQuestionSetItem['type']>; conversation?: boolean } = {}): SceneSpec {
  const selectedModules = [...modules, ...(options.form ? ['input-form' as const] : [])];
  return parseSceneSpec(JSON.stringify({ meta: { name: 'Synthetic component compatibility', subject: 'Synthetic', goal: 'Validate execution contracts' },
    task: 'Synthetic only', capabilityRecipeId: 'agent-designed', capabilityIds: allowed, promptModuleIds: selectedModules,
    behavior: { recipeId: 'agent-designed', kind: 'Synthetic', aiBehavior: 'Use allowed components as needed', userAction: 'Answer or discuss',
      evaluationRule: 'Local objective grading', progressionRule: 'Agent chooses teaching behavior',
      interaction: { version: '1.0', allowedTypes: allowed, defaultType: allowed[0], allowTextFallback: allowed.includes('text') } },
    runtimeContract: { version: '1.0', mode: 'coaching', allowedTools: [], allowedInteractionTypes: allowed,
      allowedQuestionItemTypes: options.childTypes || children, evaluation: 'on-request', completion: 'user-controlled',
      allowTextFallback: allowed.includes('text'), allowConversation: options.conversation !== false,
      maxToolCallsPerTurn: 2, maxPlanningSteps: 2, maxUserTasksPerTurn: 12 }, inputForm: options.form ? form : undefined,
    completion: { mode: 'signal', maxTurns: 100 },
  }));
}

assert.deepEqual(Object.keys(SCENE_CAPABILITY_EXECUTION_CONTRACTS).sort(), [...SCENE_CAPABILITY_IDS].sort());
assert.deepEqual(Object.keys(SCENE_MODULE_EXECUTION_CONTRACTS).sort(), [...SCENE_PROMPT_MODULE_IDS].sort());
const catalog = JSON.parse(buildSceneAbilityCatalog('S1'));
assert.equal(catalog.modules.find((entry: { id: string }) => entry.id === 'module:input-form').execution.uiSlots[0], 'form');
assert.equal(catalog.tools.find((entry: { id: string }) => entry.id === 'tool:model-experiment').execution.effect, 'budgeted-model-experiment');
assert.match(catalog.composition.formHandoff, /不能自动取消原题/u);

let combinations = 0, formCombinations = 0, childCombinations = 0;
for (let mask = 1; mask < 1 << types.length; mask++) {
  const allowed = types.filter((_type, index) => mask & 1 << index);
  for (const withForm of [false, ...(allowed.includes('text') ? [true] : [])]) {
    const spec = fixture(allowed, { form: withForm });
    const before = JSON.stringify(spec), authority = resolveSceneRuntimeContract(spec);
    const flight = preflightSceneSpec(spec);
    assert.equal(flight.valid, true, JSON.stringify(flight.diagnostics));
    const probes = probeSceneBuildProtocol(spec);
    assert.equal(probes.passed, true, JSON.stringify(probes.cases.filter(item => item.status === 'failed')));
    assert.deepEqual([...probes.coverage.testedInteractionTypes].sort(), [...allowed].sort());
    assert.deepEqual([...probes.coverage.testedQuestionItemTypes].sort(), allowed.includes('question-set') ? [...children].sort() : []);
    assert.equal(probes.actualToolCalls, 0); assert.equal(probes.semanticAccuracyEvaluated, false); assert.equal(probes.uiEvaluated, false);
    const compact = compactSceneBuildProtocolProbes(probes);
    assert.deepEqual(compact.coverage, probes.coverage); assert.equal(compact.caseCount, probes.cases.length); assert.deepEqual(compact.failures, []);
    assert.equal(compact.fixtures.reduce((sum, item) => sum + item.passed + item.failed + item.skipped, 0), probes.cases.length);
    assert.ok(JSON.stringify(compact).length < JSON.stringify(probes).length, 'Reviewer sees bounded summaries, not repeated passing detail');
    assert.equal(JSON.stringify(spec), before, 'Preflight and probes cannot rewrite permissions, data or teaching policy');
    assert.deepEqual(resolveSceneRuntimeContract(spec), authority);
    for (const type of allowed) assert.ok(probes.cases.some(item => item.id.startsWith('type:' + type) && item.id.endsWith(':answer-resolves-task') && item.status === 'passed'));
    if (withForm && allowed.some(type => type !== 'text')) {
      for (const ending of [':form-waits-with-task', ':form-after-answer', ':form-after-cancel']) assert.ok(probes.cases.some(item => item.id.endsWith(ending) && item.status === 'passed'));
      formCombinations++;
    }
    combinations++;
  }
}
for (let mask = 1; mask < 1 << children.length; mask++) {
  const allowedChildren = children.filter((_type, index) => mask & 1 << index);
  const spec = fixture(['question-set'], { childTypes: allowedChildren });
  const probes = probeSceneBuildProtocol(spec);
  assert.equal(probes.passed, true);
  assert.deepEqual(probes.coverage.testedQuestionItemTypes, allowedChildren);
  childCombinations++;
}

const unavailableForm = resolveSceneAssembly({ sceneSkill: 'S1', recipeId: 'agent-designed',
  requestedCapabilities: ['single-choice'], requestedPromptModules: [...modules, 'input-form'] });
assert.equal(unavailableForm.valid, false); assert.ok(unavailableForm.diagnostics.some(item => item.code === 'missing-execution-dependency'));
assert.deepEqual(unavailableForm.enabledCapabilities, ['single-choice'], 'Dependency errors never grant text permission automatically');
assert.ok(validateSceneExecutionCombination(['single-choice'], [], SCENE_CAPABILITY_IDS).some(issue => issue.dependency === 'module:structured-interaction'));
assert.ok(validateSceneExecutionCombination(['formula-node'], [], SCENE_CAPABILITY_IDS).some(issue => issue.dependency === 'mathlive-editor'));
const noBoolean = SCENE_CAPABILITY_IDS.filter(id => id !== 'true-false');
assert.equal(preflightSceneSpec(fixture(['question-set']), { installedCapabilities: noBoolean }).valid, false);
assert.equal(preflightSceneSpec(fixture(['question-set'], { childTypes: ['single-choice'] }), { installedCapabilities: noBoolean }).valid, true,
  'Missing unselected child adapters cannot force extra capabilities or reject an authorized narrower combination');

const staged = fixture(['single-choice']);
staged.runtimeContract = { ...staged.runtimeContract!, stages: [
  { id: 'start', goal: 'Start', allowedNext: [] }, { id: 'unreachable', goal: 'Unused branch', allowedNext: ['start'] },
], initialStageId: 'start' };
assert.equal(preflightSceneSpec(staged).valid, false);
assert.ok(preflightSceneSpec(staged).diagnostics.some(item => item.code === 'unreachable-stage'));
assert.equal(probeSceneBuildProtocol(staged).cases.find(item => item.id === 'explicit-stage-reachability')?.status, 'failed');
assert.deepEqual(compactSceneBuildProtocolProbes(probeSceneBuildProtocol(staged)).failures,
  probeSceneBuildProtocol(staged).cases.filter(item => item.status === 'failed'), 'Every failure reason remains intact for directed repair');
staged.runtimeContract.stages![0].allowedNext = ['unreachable'];
assert.equal(preflightSceneSpec(staged).valid, true, 'A reachable cycle is a legitimate iterative teaching flow');
assert.equal(probeSceneBuildProtocol(staged).passed, true);
const legacy = parseSceneSpec(JSON.stringify({ meta: { name: 'Legacy', subject: 'Synthetic', goal: 'Discuss' }, task: 'Discuss' }));
assert.equal(preflightSceneSpec(legacy).valid, true, 'Legacy scenes without explicit custom stages stay compatible');
const narrowed = fixture(types);
narrowed.runtimeContract = { ...narrowed.runtimeContract!, allowedInteractionTypes: ['single-choice'] };
assert.deepEqual(probeSceneBuildProtocol(narrowed).coverage.testedInteractionTypes, ['single-choice'], 'Probes cannot use merely installed but unauthorized components');
const noConversation = probeSceneBuildProtocol(fixture(['single-choice'], { conversation: false }));
assert.equal(noConversation.passed, true); assert.ok(noConversation.cases.some(item => item.id.endsWith(':conversation-controls') && item.status === 'skipped'));
assert.equal(noConversation.cases.some(item => item.id.endsWith(':validated-cancel')), false, 'Closed conversation permission is not widened for probes');
console.log('Scene combinations passed: ' + combinations + ' actual-component combinations, ' + formCombinations + ' form/task handoffs, ' + childCombinations
  + ' child whitelists, dependency rejection, stage reachability, permission immutability. Local protocols only; zero tool/model calls and no UI or semantic evaluation.');
