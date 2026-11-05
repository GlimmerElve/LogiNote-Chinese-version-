import assert from 'node:assert/strict';
import type { SceneRuntimeContract, SceneSpec } from '../src/types';
import type { SceneBuildContext } from '../src/services/scene/sceneBuildAgent';
import { applySceneAssemblyPlan, parseSceneSpec } from '../src/services/scene/sceneGenerator';
import { preflightSceneSpec, resolveSceneAssembly } from '../src/services/scene/sceneAssembly';
import { assertSceneBuildAuthority, captureSceneBuildAuthority } from '../src/services/scene/sceneBuildAuthority';
import { resolveSceneBuildPermissionPool } from '../src/services/scene/sceneBuildPermissionPool';
import { resolveSceneRuntimeContract, SCENE_S4_RUNTIME_CONTRACT_DESIGN } from '../src/services/scene/sceneRuntimeContract';
import { createRunState } from '../src/services/scene/sceneRuntime';

globalThis.fetch = async () => assert.fail('S4 contract checks must remain offline');

const raw = {
  meta: { name: 'Synthetic derivation', subject: 'Algebra', goal: 'Derive x = 2' },
  situation: 'Given x + 1 = 3', task: 'Derive x = 2',
  compute: { type: 'formula', operation: 'solve', expected_formula: 'x = 2',
    symbols: [{ name: 'x', type: 'real' }], given: [{ name: 'relation', display: 'x + 1 = 3' }], boundary_conditions: [] },
  help: { max_helps: 2 },
};
const scene = parseSceneSpec(JSON.stringify(raw), 'S4');
const before = JSON.stringify(scene);
const runtime = resolveSceneRuntimeContract(scene);
assert.equal(JSON.stringify(scene), before, 'Contract resolution cannot mutate the problem or reference answer');
assert.equal(runtime.mode, 'derivation');
assert.deepEqual(runtime.allowedTools, []);
assert.deepEqual(runtime.allowedActions, []);
assert.deepEqual(runtime.allowedInteractionTypes, []);
assert.deepEqual(runtime.allowedQuestionItemTypes, []);
assert.equal(runtime.allowConversation, false);
assert.equal(runtime.allowTextFallback, false);
assert.equal(runtime.maxToolCallsPerTurn, 0);
assert.equal(runtime.maxPlanningSteps, 0);
assert.equal(runtime.maxUserTasksPerTurn, 0);

// The regression fixture: an empty S4 interaction list used to fail as "no executable interaction".
const empty = { ...scene, runtimeContract: { mode: 'derivation', allowedInteractionTypes: [], allowedActions: [], allowedTools: [] } as unknown as SceneRuntimeContract };
assert.doesNotThrow(() => resolveSceneRuntimeContract(empty));
assert.equal(preflightSceneSpec(empty).valid, true);
assert.equal(preflightSceneSpec({ ...empty, compute: undefined }, { allowDeferredCompute: true }).valid, true);
assert.equal(preflightSceneSpec({ ...empty, compute: undefined }).valid, false, 'Start still requires compute');
assert.ok(createRunState(empty).canvas, 'Real S4 canvas initialization remains available');

// Known S1 metadata was produced by older S4 compilers. Accept only known shapes, and
// project them DOWN to a canvas contract instead of granting invented text or tool access.
const legacy: SceneSpec = { ...scene, injectProfile: true,
  promptModuleIds: ['structured-interaction', 'resource-grounding', 'profile-personalization'],
  referenceScope: { projectId: 'project', noteIds: ['note-1', 'note-2'], documentIds: ['doc-1'] },
  runtimeContract: { version: '1.0', mode: 'derivation', initiator: 'agent',
    allowedTools: ['knowledge-notes', 'documents', 'document-arguments', 'learner-profile'],
    allowedActions: ['respond', 'clarify', 'challenge', 'evaluate', 'advance', 'summarize', 'finish'],
    allowedInteractionTypes: ['text'], allowedQuestionItemTypes: ['single-choice', 'multiple-choice', 'true-false'],
    allowTextFallback: true, allowConversation: true,
    scope: { noteIds: ['note-1', 'outside'], documentIds: [], cognitionRecordIds: [] },
    evaluation: 'each-answer', completion: 'objective', maxToolCallsPerTurn: 3, maxPlanningSteps: 3, maxUserTasksPerTurn: 1,
    flowGuidance: 'Legacy derivation guidance' },
};
const projected = resolveSceneRuntimeContract(legacy);
assert.deepEqual(projected.allowedInteractionTypes, []);
assert.deepEqual(projected.allowedActions, []);
assert.deepEqual(projected.allowedTools, []);
assert.deepEqual(projected.allowedQuestionItemTypes, []);
assert.deepEqual(projected.scope, { noteIds: ['note-1'], documentIds: [], cognitionRecordIds: [] });
assert.equal(projected.allowConversation, false);
assert.equal(projected.maxToolCallsPerTurn, 0);
assert.equal(legacy.runtimeContract?.allowedInteractionTypes[0], 'text', 'Compatibility is read-only');
assert.ok(preflightSceneSpec(legacy).diagnostics.some(issue => issue.code === 'canvas-contract-projected' && issue.severity === 'warning'));
assert.deepEqual(resolveSceneRuntimeContract({ ...legacy, runtimeContract: projected }), projected, 'Canvas projection is idempotent');

const badContracts: Array<[Record<string, unknown>, RegExp]> = [
  [{ allowedTools: ['unknown-tool'] }, /allowedTools/],
  [{ allowedTools: ['model-experiment'] }, /model-experiment/],
  [{ allowedInteractionTypes: ['canvas-node'] }, /allowedInteractionTypes/],
  [{ allowedActions: ['execute-python'] }, /allowedActions/],
  [{ allowedQuestionItemTypes: ['essay'] }, /allowedQuestionItemTypes/],
  [{ allowConversation: 'yes' }, /allowConversation/],
  [{ scope: { noteIds: 'all' } }, /ID 白名单/],
  [{ scope: { noteIds: [null] } }, /ID 白名单/],
  [{ scope: { hiddenPrivateIds: ['private'] } }, /scope.*未知字段/],
  [{ unrestrictedTools: true }, /未知字段/],
  [{ maxToolCallsPerTurn: Number.NaN }, /maxToolCallsPerTurn/],
];
for (const [contract, message] of badContracts) {
  const malformed = { ...scene, runtimeContract: contract as unknown as SceneRuntimeContract };
  assert.throws(() => resolveSceneRuntimeContract(malformed), message);
  const check = preflightSceneSpec(malformed, { allowDeferredCompute: true });
  assert.equal(check.valid, false);
  assert.ok(check.diagnostics.some(issue => issue.code === 'invalid-runtime-contract' && message.test(issue.message)), 'Preflight preserves the concrete error');
}
assert.throws(() => resolveSceneRuntimeContract({ ...scene, referenceScope: { projectId: 'p', noteIds: 'all', documentIds: [] } as never }), /ID 白名单/);

const assembly = resolveSceneAssembly({ sceneSkill: 'S4', recipeId: 'guided-derivation', requestedCapabilities: [], requestedPromptModules: ['structured-interaction'] });
assert.equal(assembly.valid, true);
assert.ok(!assembly.enabledCapabilities.includes('text'));
const context: SceneBuildContext = { version: 1, userRequest: 'Derive the equation on a canvas', conversation: [], selectedSurface: 'S4',
  explicitSelections: { capabilities: assembly.enabledCapabilities, promptModules: assembly.enabledPromptModules },
  assembly: { recipeId: 'guided-derivation', capabilities: assembly.enabledCapabilities, promptModules: assembly.enabledPromptModules, interactionPlan: 'Canvas nodes' } };
const compiled = applySceneAssemblyPlan({ ...scene, referenceScope: legacy.referenceScope, runtimeContract: { ...runtime, scope: projected.scope } }, {
  subject: 'Algebra', knowledgePoints: [], sceneSkill: 'S4', recipeId: 'guided-derivation',
  requestedCapabilities: assembly.enabledCapabilities, requestedPromptModules: assembly.enabledPromptModules,
});
const authority = captureSceneBuildAuthority(compiled, context);
assert.deepEqual(authority.toolCeiling, []);
assert.deepEqual(authority.interactionCeiling, []);
assert.deepEqual(authority.questionItemTypeCeiling, []);
assert.equal(authority.allowConversation, false);
assert.doesNotThrow(() => assertSceneBuildAuthority(compiled, authority));
assert.throws(() => assertSceneBuildAuthority({ ...compiled, runtimeContract: { ...compiled.runtimeContract!, scope: { ...projected.scope, noteIds: ['note-1', 'note-2'] } } }, authority), /白名单/);
assert.throws(() => assertSceneBuildAuthority({ ...compiled, capabilityIds: [...compiled.capabilityIds!, 'compute-help'] }, authority), /组件/);
assert.throws(() => assertSceneBuildAuthority({ ...compiled, promptModuleIds: [...compiled.promptModuleIds!, 'resource-grounding'] }, authority), /模块/);
const pool = resolveSceneBuildPermissionPool('S4', context, assembly.enabledCapabilities, assembly.enabledPromptModules, ['text'], ['single-choice']);
assert.deepEqual(pool.interactionTypes, []);
assert.deepEqual(pool.questionItemTypes, []);

// This fix must never relax S1 objective task or interaction requirements.
const s1 = parseSceneSpec(JSON.stringify({ meta: { name: 'S1', goal: 'Choose' }, task: 'Choose',
  behavior: { recipeId: 'agent-designed', kind: 'practice', interaction: { allowedTypes: ['single-choice'], defaultType: 'single-choice', allowTextFallback: false } },
  runtimeContract: { allowedInteractionTypes: [] } }), 'S1');
assert.throws(() => resolveSceneRuntimeContract(s1), /未授权可执行的互动方式/);
assert.match(SCENE_S4_RUNTIME_CONTRACT_DESIGN, /不得为满足空交互而补 text/);
console.log('S4 runtime contract passed: empty canvas protocol, legacy down-projection, strict unknown/paid/scope rejection, local canvas initialization, frozen authority and unchanged S1 validation. Offline synthetic data only.');
