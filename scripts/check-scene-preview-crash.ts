import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SceneSpec } from '../src/types';
import { SceneSpecPreview } from '../src/components/scene/SceneSpecPreview';
import { SceneChatView } from '../src/components/scene/SceneChatView';
import { parseSceneSpec, applySceneAssemblyPlan } from '../src/services/scene/sceneGenerator';
import { preflightSceneSpec } from '../src/services/scene/sceneAssembly';
import { normalizeSceneSpec } from '../src/services/scene/sceneSkillStore';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { normalizeScenePresentation, scenePresentationText, SCENE_PRESENTATION_TEXT_RULE } from '../src/services/scene/scenePresentation';

// Regression for model/legacy object text formerly crashing only after "save and start".
// Synthetic renderer probes only: no real user notes, disk saves, GUI or model request.
globalThis.fetch = async () => assert.fail('Render crash probes must stay offline');
const base = {
  meta: { name: 'Synthetic prompt learning', subject: 'Prompt design', goal: 'Improve prompts', knowledgePoints: [] },
  task: 'Discuss a prompt', role: { name: 'Tutor', attributes: [] }, userRole: 'Learner',
  behavior: { recipeId: 'agent-designed', kind: 'Dialogue', aiBehavior: 'Discuss', userAction: 'Ask',
    evaluationRule: 'None', progressionRule: 'Follow the user',
    interaction: { version: '1.0', allowedTypes: ['text'], defaultType: 'text', allowTextFallback: true } },
  completion: { mode: 'signal', maxTurns: 12 },
  runtimeContract: { stages: [{ id: 'dialogue', goal: 'Discuss prompts', allowedNext: [] }], initialStageId: 'dialogue' },
};
const opts = { sceneSkill: 'S1' as const, subject: 'Prompt design', knowledgePoints: [], recipeId: 'agent-designed' as const,
  requestedCapabilities: ['text' as const], requestedPromptModules: ['turn-agent-planning' as const] };
const preview = (spec: SceneSpec) => renderToStaticMarkup(createElement(SceneSpecPreview, {
  spec, busy: false, onChange() {}, onStart() {}, onDelete() {},
}));
const chat = (spec: SceneSpec) => renderToStaticMarkup(createElement(SceneChatView, {
  spec, run: createRunState(spec), sending: false, hasPrevRun: false, onSend() {}, onInjectEvent() {}, onEnd() {}, onRerun() {},
}));
const compile = (value: unknown, extraModules: Array<'role-context' | 'scenario-framing' | 'resource-grounding'> = []) => applySceneAssemblyPlan(parseSceneSpec(JSON.stringify(value)), {
  ...opts, requestedPromptModules: ['turn-agent-planning', ...extraModules],
});
const safe = compile(base);
assert.ok(preflightSceneSpec(safe).valid);
assert.doesNotThrow(() => preview(safe)); assert.doesNotThrow(() => chat(safe));
assert.equal(safe.meta.name, base.meta.name); assert.equal(safe.meta.goal, base.meta.goal);
assert.equal(safe.task, base.task); assert.equal(safe.behavior?.aiBehavior, base.behavior.aiBehavior);
const cases = [
  ['meta.name', { ...base, meta: { ...base.meta, name: { title: 'Structured title' } } }, []],
  ['meta.goal', { ...base, meta: { ...base.meta, goal: { description: 'Structured goal' } } }, []],
  ['task', { ...base, task: { instruction: 'Structured task' } }, []],
  ['role.name', { ...base, role: { name: { label: 'Structured role' }, attributes: [] } }, ['role-context']],
  ['userRole', { ...base, userRole: { name: 'Structured user role' } }, ['role-context']],
  ['situation', { ...base, situation: { background: 'Structured context' } }, ['scenario-framing']],
  ['resources[0]', { ...base, resources: [{ title: 'Reference', content: 'Synthetic content' }] }, ['resource-grounding']],
  ['meta.knowledgePoints[0]', { ...base, meta: { ...base.meta, knowledgePoints: [{ title: 'Structured point' }] } }, []],
] as const;
for (const [field, value, modules] of cases) {
  const scene = compile(value, [...modules]);
  assert.ok(preflightSceneSpec(scene).valid, `${field}: compatible display repair cannot disable valid interaction`);
  assert.doesNotThrow(() => preview(scene), `${field}: generated preview is safe`);
  const saved = normalizeSceneSpec(JSON.parse(JSON.stringify(scene)))!;
  assert.ok(saved && preflightSceneSpec(saved).valid);
  assert.doesNotThrow(() => chat(saved), `${field}: generated and saved first chat render is safe`);
  const oldFile = { ...scene, ...value, meta: { ...scene.meta, ...value.meta }, sceneId: scene.sceneId };
  const compatible = normalizeSceneSpec(JSON.parse(JSON.stringify(oldFile)))!;
  assert.ok(compatible && preflightSceneSpec(compatible).valid);
  assert.doesNotThrow(() => preview(compatible), `${field}: existing structured display field loads safely`);
  assert.doesNotThrow(() => chat(compatible), `${field}: existing scene starts safely without editing its saved file`);
}

const longTask = { title: 'Nested task', steps: [{ instruction: 'Task detail '.repeat(2500) + 'FULL_TASK_END_SENTINEL', outputs: ['one', 'two'] }], constraints: { limit: null } };
const structured = normalizeScenePresentation({ ...base, task: longTask, role: { name: 'Tutor', attributes: [{ id: 'a1', key: 'Style', value: { full: 'Keep all role details' }, enabled: false }] },
  resources: [{ title: 'Reference', detail: ['first', 'last'] }], rules: [{ instruction: 'Keep this rule' }],
  extras: { information: { nested: ['keep', 'everything'] } }, evaluationDimensions: [{ label: 'Complete explanation' }] });
assert.equal(typeof structured.task, 'string');
assert.deepEqual(JSON.parse(structured.task as unknown as string), longTask);
assert.ok((structured.task as unknown as string).includes('FULL_TASK_END_SENTINEL'));
assert.ok((structured.task as unknown as string).length > 24000, 'compatibility conversion cannot silently truncate long historical content');
assert.equal(structured.role.attributes[0].enabled, false); assert.equal(structured.role.attributes[0].id, 'a1');
assert.deepEqual(normalizeScenePresentation(structured), structured, 'display conversion is idempotent');
assert.doesNotMatch(JSON.stringify(structured), /\[object Object\]/);
for (const value of [null, undefined]) assert.equal(scenePresentationText(value), '');
assert.equal(scenePresentationText(' unchanged \ntext '), ' unchanged \ntext ');
assert.equal(scenePresentationText(false), 'false'); assert.equal(scenePresentationText(0), '0');
const nullFields = normalizeSceneSpec({ ...safe, task: null, userRole: null, situation: null, openingNarrative: null,
  resources: null, rules: null, evaluationDimensions: null, role: null,
  meta: { ...safe.meta, name: null, subject: null, goal: null, knowledgePoints: null } })!;
assert.equal(nullFields.task, ''); assert.deepEqual(nullFields.resources, []); assert.equal(nullFields.role.name, 'NPC');
assert.equal(nullFields.meta.name, '未命名场景'); assert.doesNotThrow(() => preview(nullFields)); assert.doesNotThrow(() => chat(nullFields));
const legacyRole = normalizeSceneSpec({ ...safe, behavior: undefined, capabilityRecipeId: undefined,
  role: { id: 'legacy-role', name: { label: 'Historical tutor' }, attributes: [
    { id: 'tone', key: { label: 'Tone' }, value: { style: 'Patient', detail: '<script>not executable</script>' }, enabled: true },
  ] } })!;
assert.equal(legacyRole.role.attributes[0].id, 'tone'); assert.equal(legacyRole.role.attributes[0].enabled, true);
const legacyMarkup = preview(legacyRole);
assert.ok(legacyMarkup.includes('Historical tutor') && legacyMarkup.includes('Patient'));
assert.ok(!legacyMarkup.includes('<script>not executable</script>'));
assert.doesNotThrow(() => chat(legacyRole));
const cycle: any = {}; cycle.self = cycle;
assert.throws(() => scenePresentationText(cycle), /无法转换为完整文本/, 'unsupported local cyclic objects cannot pretend conversion succeeded');

// The presentation layer cannot add/normalize permissions, tools, item types, grading or experiment budgets.
const protectedFields = { runtimeContract: { allowedTools: [], allowedInteractionTypes: ['single-choice'], scope: { noteIds: ['one'] },
  maxToolCallsPerTurn: 0, answerFeedback: { correctness: 'at-end', explanation: 'at-end' } },
  capabilityPlan: { needs: [{ id: 'only', goal: 'Only one kind', capabilityIds: ['single-choice'] }], missing: [] },
  behavior: { interaction: { allowedTypes: ['single-choice'], allowTextFallback: false } },
  inputForm: { id: 'original-form', fields: [] }, experimentPolicy: { maxExperiments: 2, maxOutputTokens: 512, criteria: ['Original'] },
  compute: { expected_formula: 'x+1' }, help: { max_help_count: 2 }, state: { status: 'running' } };
const preserved = normalizeScenePresentation({ ...base, ...protectedFields, task: longTask });
for (const field of Object.keys(protectedFields) as Array<keyof typeof protectedFields>) assert.equal(preserved[field], protectedFields[field]);
assert.match(SCENE_PRESENTATION_TEXT_RULE, /task是一段完整任务文字，不是对象/);
assert.match(SCENE_PRESENTATION_TEXT_RULE, /必须是字符串数组/);
console.log('Scene presentation regression passed: eight former post-start crash shapes, complete long structured task preservation, existing-file compatibility, idempotence, safe actual preview/chat SSR and untouched authority/grade/state objects. Synthetic only.');
