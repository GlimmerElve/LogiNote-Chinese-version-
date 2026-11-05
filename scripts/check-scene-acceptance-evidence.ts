import assert from 'node:assert/strict';
import type { SceneSpec } from '../src/types';
import { applySceneAssemblyPlan, parseSceneSpec } from '../src/services/scene/sceneGenerator';
import { acceptSceneDesign, type SceneBuildDesign, type SceneBuildRecovery } from '../src/services/scene/sceneBuildAgent';
import { SceneSetupError } from '../src/services/scene/sceneSetupStage';
import { normalizeSceneEvidencePath, sceneEvidencePathExists, sceneAcceptanceEvidencePaths } from '../src/services/scene/sceneAcceptanceEvidence';
import { sceneAcceptancePatchTargets, isSceneCanvasProtocolPatchAllowed } from '../src/services/scene/sceneAcceptancePolicy';

globalThis.fetch = async () => assert.fail('Acceptance evidence checks must remain offline');
const pathFixture = { meta: { goal: 'Synthetic goal' }, inputForm: { fields: [{ id: 'prompt', label: '提示词' }] },
  rules: [], flags: false, count: 0, empty: '', absent: undefined, nullable: null };
for (const path of ['inputForm.fields.0.id', 'inputForm.fields[0].id', 'scene.inputForm.fields[0].id',
  '$.scene.inputForm.fields[0].id', 'scene["inputForm"]["fields"][0]["id"]',
  '/inputForm/fields/0/id', '#/scene/inputForm/fields/0/id']) {
  assert.equal(normalizeSceneEvidencePath(path), 'inputForm.fields.0.id');
  assert.equal(sceneEvidencePathExists(pathFixture, path), true);
}
for (const path of ['meta.goal', 'rules', 'flags', 'count', 'empty', 'nullable']) assert.equal(sceneEvidencePathExists(pathFixture, path), true);
for (const path of ['absent', 'rules.length', 'inputForm.fields[-1].id', 'inputForm.fields.1.id', 'inputForm.fields[*].id',
  'inputForm.fields[0].missing', '__proto__.polluted', 'constructor.name', 'meta.constructor', 'scene', '', 'task;alert(1)',
  'x'.repeat(201)]) assert.equal(sceneEvidencePathExists(pathFixture, path), false, path);
const index = sceneAcceptanceEvidencePaths(pathFixture);
Object.defineProperty(pathFixture, 'nonEnumerable', { value: 'not sent to reviewer', enumerable: false });
assert.equal(sceneEvidencePathExists(pathFixture, 'nonEnumerable'), false);
assert.ok(index.includes('inputForm.fields.0.id')); assert.ok(!index.includes('absent'));
assert.ok(index.every(path => sceneEvidencePathExists(JSON.parse(JSON.stringify(pathFixture)), path)));
assert.ok(sceneAcceptanceEvidencePaths({ many: Array.from({ length: 5000 }, (_, i) => ({ id: i, value: 'reference' })) }).length <= 128);

function fixture(skill: 'S1' | 'S4') {
  const scene = applySceneAssemblyPlan(parseSceneSpec(JSON.stringify({
    meta: { name: 'Synthetic evidence', subject: 'Learning', goal: '学习指定内容', sceneSkill: skill },
    task: '根据目标组织互动', rules: [], agentInstructions: { understanding: '理解输入', planning: '按目标规划', response: '回应用户' },
    ...(skill === 'S1' ? { behavior: { recipeId: 'agent-designed', kind: '对话', aiBehavior: '按需回应', userAction: '表达要求',
      evaluationRule: '不强制评分', progressionRule: '按用户意愿继续', interaction: { version: '1.0', allowedTypes: ['text'], defaultType: 'text', allowTextFallback: true } } } : {}),
    completion: { mode: 'signal', maxTurns: 12 },
  }), skill), { subject: 'Learning', knowledgePoints: [], sceneSkill: skill,
    recipeId: skill === 'S4' ? 'guided-derivation' : 'agent-designed', ...(skill === 'S1' ? { requestedCapabilities: ['text'] } : {}) });
  scene.inputForm = undefined; // An own-property omitted from the actual JSON sent to the reviewer.
  const design: SceneBuildDesign = {
    context: { version: 1, userRequest: '组织学习体验', conversation: [], selectedSurface: skill, explicitSelections: {},
      assembly: { recipeId: scene.capabilityRecipeId!, capabilities: scene.capabilityIds!, promptModules: scene.promptModuleIds!, interactionPlan: '尊重运行面' } },
    flow: { flowGuidance: '按目标推进', evaluationRule: '按实际证据评价', progressionRule: '尊重用户要求', completionRule: '用户结束', maxTurns: 12, stages: [] },
    instructions: { aiBehavior: '按需帮助', userAction: '表达要求', understanding: '理解', planning: '规划', response: '回应' },
  };
  return { scene, design };
}
type Mode = 'pass' | 'repair-path' | 'missing-field' | 'forged' | 'undefined' | 'empty-pass' | 'false-no-repair' | 'false-no-detail'
  | 's1-target-in-s4' | 'protocol-override';
async function check(skill: 'S1' | 'S4', mode: Mode) {
  const { scene, design } = fixture(skill);
  const original = JSON.stringify(scene);
  const phases: string[] = [];
  const recovery: SceneBuildRecovery = { stages: {} };
  let reviews = 0;
  const result = acceptSceneDesign(scene, design, { recovery, invoke: async call => {
    const input = JSON.parse(call.userInput); phases.push(input.phase);
    if (input.phase === 'repair') {
      if (mode === 'protocol-override') {
        assert.deepEqual(input.allowedTargets, ['completion']);
        return { content: JSON.stringify({ patch: { completion: { ...input.scene.completion, successExpression: 'LLM decides success' } } }) };
      }
      assert.equal(mode, 'missing-field'); assert.deepEqual(input.allowedTargets, ['task']);
      return { content: JSON.stringify({ patch: { task: '补齐目标对应的具体互动任务' } }) };
    }
    assert.equal(input.phase, 'accept'); reviews++;
    assert.ok(Array.isArray(input.availableEvidencePaths));
    assert.equal(input.evidencePathIndexComplete, false);
    for (const path of input.availableEvidencePaths) assert.ok(sceneEvidencePathExists(input.scene, path), path);
    assert.ok(!input.availableEvidencePaths.includes('inputForm'));
    assert.match(call.systemPromptOverride!, /缺项导致失败时evidencePaths可为\[\]/);
    if (skill === 'S4') {
      assert.equal(input.acceptanceParadigm, 'canvas-derivation');
      assert.equal(input.priorArtifacts.localProtocolProbes, undefined);
      assert.equal(input.priorArtifacts.canvasPreflight.engineExecuted, false);
      assert.equal(input.priorArtifacts.canvasPreflight.runtimeExecuted, false);
      assert.ok(!input.patchTargets.includes('behavior')); assert.ok(!input.patchTargets.includes('inputForm'));
      assert.ok(!input.patchTargets.includes('experimentPolicy')); assert.ok(!input.patchTargets.includes('events'));
      assert.match(call.systemPromptOverride!, /本次只验收S4数理画布范式/);
      assert.equal(input.scene.behavior, undefined);
      assert.ok(!input.availableEvidencePaths.some((path: string) => path.startsWith('behavior')));
      assert.doesNotMatch(call.systemPromptOverride!, /"evidencePaths":\["behavior.aiBehavior"\]/);
    } else {
      assert.ok(input.availableEvidencePaths.includes('behavior.aiBehavior'));
      assert.equal(input.acceptanceParadigm, 'interactive-agent');
      assert.ok(input.priorArtifacts.localProtocolProbes);
      assert.equal(input.priorArtifacts.canvasPreflight, undefined);
      assert.ok(input.patchTargets.includes('behavior')); assert.ok(input.patchTargets.includes('inputForm'));
      assert.match(call.systemPromptOverride!, /本次验收S1互动Agent范式/);
    }
    if (mode === 'repair-path' && reviews === 2) {
      assert.equal(input.outputRepair.code, 'invalid-acceptance-evidence');
      assert.match(input.outputRepair.detail, /coverage\[0\]\.evidencePaths\[0\]/);
      assert.match(input.outputRepair.detail, /behavior.inventedField/);
      assert.match(input.outputRepair.detail, /availableEvidencePaths/);
    }
    const missing = mode === 'missing-field' && input.revision === 0;
    const coverage = input.criteria.map((criterion: { id: string }, i: number) => {
      const failed = i === 0 && (missing || ['false-no-repair', 'false-no-detail', 's1-target-in-s4', 'protocol-override'].includes(mode));
      const invalid = i === 0 && (mode === 'forged' || (mode === 'repair-path' && reviews === 1));
      const empty = i === 0 && (failed || mode === 'empty-pass');
      return { id: criterion.id, satisfied: !failed,
        evidencePaths: empty ? [] : [invalid ? 'behavior.inventedField' : mode === 'undefined' ? 'inputForm' : '/scene/meta/goal'],
        ...(failed && mode !== 'false-no-detail' ? { detail: '缺少目标对应的具体互动任务，需补齐' } : {}) };
    });
    const issues = missing || ['false-no-detail', 's1-target-in-s4', 'protocol-override'].includes(mode)
      ? [{ criterionId: input.criteria[0].id, target: mode === 's1-target-in-s4' ? 'behavior' : mode === 'protocol-override' ? 'completion' : 'task', instruction: '补齐目标对应的具体互动任务' }] : [];
    return { content: JSON.stringify({ coverage, issues }) };
  } }, value => value);
  if (['forged', 'undefined', 'empty-pass', 'false-no-repair', 'false-no-detail', 's1-target-in-s4', 'protocol-override'].includes(mode)) {
    await assert.rejects(result, error => error instanceof SceneSetupError
      && error.code === (mode === 'false-no-repair' ? 'missing-repair-target' : ['s1-target-in-s4', 'protocol-override'].includes(mode) ? 'invalid-repair-target' : 'invalid-acceptance-evidence'));
    assert.deepEqual(phases, mode === 'protocol-override' ? ['accept', 'repair', 'repair'] : ['accept', 'accept'], 'malformed verdict or patch gets only the existing bounded format repair');
  } else {
    const accepted = await result;
    assert.equal(accepted.sceneId, scene.sceneId);
    assert.deepEqual(phases, mode === 'missing-field' ? ['accept', 'repair', 'accept'] : mode === 'repair-path' ? ['accept', 'accept'] : ['accept']);
    assert.ok(recovery.acceptance!.review!.coverage.every(item => item.satisfied && item.evidencePaths.includes('meta.goal')));
    if (mode === 'missing-field') assert.equal(accepted.task, '补齐目标对应的具体互动任务');
    else assert.equal(JSON.stringify(accepted), original);
  }
  assert.equal(JSON.stringify(scene), original, 'acceptance cannot mutate the source candidate');
}
for (const skill of ['S4', 'S1'] as const) for (const mode of ['pass', 'repair-path', 'missing-field', 'forged', 'undefined',
  'empty-pass', 'false-no-repair', 'false-no-detail'] as const) await check(skill, mode);
await check('S4', 's1-target-in-s4'); await check('S4', 'protocol-override');
const canvas = fixture('S4').scene;
assert.ok(!sceneAcceptancePatchTargets(canvas).includes('behavior'));
assert.ok(sceneAcceptancePatchTargets(fixture('S1').scene).includes('behavior'));
assert.equal(isSceneCanvasProtocolPatchAllowed(canvas, { completion: { ...canvas.completion, maxTurns: 20 } }), true);
for (const maxTurns of [0, 101, '20', null]) assert.equal(isSceneCanvasProtocolPatchAllowed(canvas, { completion: { ...canvas.completion, maxTurns } }), false);
assert.equal(isSceneCanvasProtocolPatchAllowed(canvas, { runtimeContract: { ...canvas.runtimeContract, flowGuidance: '允许多条合法支路' } }), true);
assert.equal(isSceneCanvasProtocolPatchAllowed(canvas, { runtimeContract: { ...canvas.runtimeContract, allowedActions: ['advance'], flowGuidance: '不能接管画布' } }), false);
assert.equal(isSceneCanvasProtocolPatchAllowed(canvas, { runtimeContract: { ...canvas.runtimeContract, allowedTools: {}, flowGuidance: '无效类型' } }), false);
console.log('Scene acceptance evidence passed: actual serialized path index, S1/S4-specific examples, definite path normalization, absent-field repair, canonical checkpoint evidence, precise bounded format repair, strict forged/undefined/empty-pass rejection and immutable candidate. Synthetic offline decisions only.');
