import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { parseSceneSpec, applySceneAssemblyPlan } from '../src/services/scene/sceneGenerator';
import { preflightSceneSpec } from '../src/services/scene/sceneAssembly';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { normalizeSceneSpec } from '../src/services/scene/sceneSkillStore';
import { SceneSpecPreview } from '../src/components/scene/SceneSpecPreview';
import { SceneChatView } from '../src/components/scene/SceneChatView';
import { SceneDynamicForm } from '../src/components/scene/SceneDynamicForm';
import { SceneExperimentLedger } from '../src/components/scene/SceneExperimentLedger';
import { SceneRichMessage } from '../src/components/scene/SceneRichMessage';
import { ScenePageErrorBoundary } from '../src/components/scene/ScenePageErrorBoundary';

globalThis.fetch = async () => assert.fail('Synthetic render diagnosis must not access the network');
const raw: any = {
  meta: { name: 'Synthetic prompt testing', subject: 'Synthetic only', goal: 'Check a prompt', knowledgePoints: [] },
  role: { name: 'Experiment host', attributes: [] }, userRole: 'Learner', situation: 'Synthetic prompt lab', task: 'Submit a synthetic prompt',
  resources: [], rules: [], metrics: [], events: [], completion: { mode: 'signal', maxTurns: 8 },
  behavior: { recipeId: 'agent-designed', kind: 'Prompt lab', aiBehavior: 'Discuss actual experiment results', userAction: 'Submit prompt or discuss',
    evaluationRule: 'No default learner score', progressionRule: 'Follow the user',
    interaction: { version: '1.0', allowedTypes: ['text'], defaultType: 'text', allowTextFallback: true } },
  experimentPolicy: { criteria: ['Output follows the synthetic request'], maxExperiments: 1, maxOutputTokens: 512, temperature: .2 },
  inputForm: { id: 'synthetic-prompt-form', title: 'Synthetic prompt input', fields: [
    { id: 'prompt', label: 'Prompt', kind: 'textarea', purpose: 'prompt', required: true, maxLength: 12000 },
    { id: 'input', label: 'Test input', kind: 'textarea', purpose: 'test-input', required: false, maxLength: 12000 },
    { id: 'format', label: 'Output format', kind: 'select', purpose: 'output-format', required: true, maxLength: 100,
      options: [{ value: 'text', label: 'Text' }, { value: 'json-object', label: 'JSON object' }] },
  ] },
};
function compile(value: unknown) {
  return applySceneAssemblyPlan(parseSceneSpec(JSON.stringify(value)), { subject: 'Synthetic only', knowledgePoints: [], sceneSkill: 'S1',
    recipeId: 'agent-designed', requestedCapabilities: ['text'],
    requestedPromptModules: ['role-context', 'scenario-framing', 'resource-grounding',
      'structured-interaction', 'turn-agent-planning', 'input-form', 'model-experiment'] });
}
function errorOf(render: () => unknown) {
  try { render(); return undefined; }
  catch (error) { return { name: error instanceof Error ? error.name : 'unknown', message: error instanceof Error ? error.message : String(error),
    frame: error instanceof Error ? error.stack?.split('\n').slice(1, 4).join('\n') : undefined }; }
}
const cases: Array<{ id: string; mutate: (value: any) => void; invalid?: 'compile' | 'preflight' }> = [
  { id: 'valid', mutate() {} },
  { id: 'role-name-object', mutate(value) { value.role.name = { label: 'Host' }; } },
  { id: 'user-role-object', mutate(value) { value.userRole = { label: 'Learner' }; } },
  { id: 'meta-name-object', mutate(value) { value.meta.name = { title: 'Prompt lab' }; } },
  { id: 'meta-goal-object', mutate(value) { value.meta.goal = { description: 'Check the prompt' }; } },
  { id: 'situation-object', mutate(value) { value.situation = { description: 'Prompt lab' }; } },
  { id: 'task-object', mutate(value) { value.task = { description: 'Submit a prompt' }; } },
  { id: 'resource-object', mutate(value) { value.resources = [{ title: 'Synthetic resource' }]; } },
  { id: 'knowledge-point-object', mutate(value) { value.meta.knowledgePoints = [{ title: 'Prompt engineering' }]; } },
  { id: 'opening-narrative-object', mutate(value) { value.openingNarrative = { text: 'A synthetic opening' }; } },
  { id: 'role-attribute-object', mutate(value) { value.role.attributes = [{ key: { name: 'Specialty' }, value: { name: 'Synthetic only' }, enabled: true }]; } },
  { id: 'long-nested-task-object', mutate(value) { value.task = { description: 'Synthetic task', steps: [{ text: 'x'.repeat(6200) }, { end: 'END-OF-TASK' }] }; } },
  { id: 'missing-input-form', invalid: 'compile', mutate(value) { delete value.inputForm; } },
  { id: 'input-form-label-object', invalid: 'compile', mutate(value) { value.inputForm.fields[0].label = { title: 'Prompt' }; } },
  { id: 'behavior-kind-object', invalid: 'preflight', mutate(value) { value.behavior.kind = { title: 'Prompt lab' }; } },
];
function renderStages(spec: ReturnType<typeof compile>) {
  const preflight = preflightSceneSpec(spec);
  const previewError = errorOf(() => renderToStaticMarkup(React.createElement(SceneSpecPreview, {
    spec: spec!, busy: false, onChange() {}, onStart() {}, onDelete() {},
  })));
  let run: ReturnType<typeof createRunState> | undefined;
  const createRunError = errorOf(() => { run = createRunState(spec!); });
  const chatError = run ? errorOf(() => renderToStaticMarkup(React.createElement(SceneChatView, {
    spec: spec!, run: run!, sending: false, hasPrevRun: false, onSend() {}, onInjectEvent() {}, onEnd() {}, onRerun() {},
  }))) : undefined;
  const firstReplyError = run ? errorOf(() => renderToStaticMarkup(React.createElement(SceneChatView, {
    spec: spec!, run: { ...run!, messages: [...run!.messages, { id: 'synthetic-first-reply', speakerType: 'role',
      speakerName: spec!.behavior?.kind || spec!.role.name, content: 'Synthetic first reply', timestamp: '' }] },
    sending: false, hasPrevRun: false, onSend() {}, onInjectEvent() {}, onEnd() {}, onRerun() {},
  }))) : undefined;
  return { preflightValid: preflight.valid, previewError, createRunError, chatError, firstReplyError };
}
const base = compile(raw);
const reports = cases.map(test => {
  const value = structuredClone(raw); test.mutate(value);
  let spec: ReturnType<typeof compile> | undefined;
  const parseError = errorOf(() => { spec = compile(value); });
  if (test.invalid === 'compile') {
    assert.ok(parseError, `${test.id}: malformed executable form must fail before entering the run`);
    return { id: test.id, rejectedAt: 'compile' };
  }
  assert.equal(parseError, undefined, `${test.id}: display compatibility must not fail scene parsing`);
  assert.ok(spec, `${test.id}: compiled specification exists`);
  const generated = renderStages(spec);
  if (test.invalid === 'preflight') {
    assert.equal(generated.preflightValid, false, `${test.id}: protocol identifiers remain strictly checked, not converted to display text`);
    return { id: test.id, rejectedAt: 'preflight' };
  }
  assert.deepEqual(generated, { preflightValid: true, previewError: undefined, createRunError: undefined,
    chatError: undefined, firstReplyError: undefined }, `${test.id}: generated scene preview/start/first reply render safely`);
  // Exercise the real saved-template loader normalizer separately, without writing any scene file.
  const historical = structuredClone(base) as any; test.mutate(historical);
  const loaded = normalizeSceneSpec(historical);
  assert.ok(loaded, `${test.id}: historical scene stays loadable`);
  assert.deepEqual(renderStages(loaded), generated, `${test.id}: loaded historical scene also renders safely`);
  assert.equal(JSON.stringify(spec).includes('[object Object]'), false, `${test.id}: structured display text is never implicitly coerced`);
  if (test.id === 'long-nested-task-object') {
    assert.equal(spec.task, JSON.stringify(value.task, null, 2), 'the full structured task survives without trimming');
    assert.equal(loaded.task, spec.task, 'historical loading preserves the full structured task too');
    assert.ok(spec.task.endsWith('\n}'));
    assert.ok(spec.task.includes('END-OF-TASK'));
  }
  return { id: test.id, generatedAndHistorical: 'preview/start/first-reply pass' };
});
const direct = {
  validForm: errorOf(() => renderToStaticMarkup(React.createElement(SceneDynamicForm, { form: raw.inputForm, disabled: false, onSubmit() {} }))),
  validLedger: errorOf(() => renderToStaticMarkup(React.createElement(SceneExperimentLedger, { records: [] }))),
  validRichMessage: errorOf(() => renderToStaticMarkup(React.createElement(SceneRichMessage, { content: 'Synthetic **markdown** and $x+1$.' }))),
};
assert.equal(direct.validForm, undefined); assert.equal(direct.validLedger, undefined); assert.equal(direct.validRichMessage, undefined);

// SSR does not invoke React error boundaries. Prove the real component error first, then test
// the boundary's classification/fallback/retry methods directly; do not claim browser catch E2E.
const broken = { ...base, task: { description: 'PRIVATE-SYNTHETIC-CONTENT' } } as unknown as typeof base;
const brokenRun = createRunState(base);
let actualError: unknown;
try { renderToStaticMarkup(React.createElement(SceneChatView, { spec: broken, run: brokenRun, sending: false,
  hasPrevRun: false, onSend() {}, onInjectEvent() {}, onEnd() {}, onRerun() {} })); }
catch (error) { actualError = error; }
assert.ok(actualError instanceof Error && actualError.message.startsWith('Objects are not valid as a React child'),
  'a deliberately unnormalized object still reproduces the concrete original React throw');
let returned = false;
const boundary = new ScenePageErrorBoundary({ children: React.createElement('span', {}, 'Preserved content'),
  section: 'running', onReturn() { returned = true; } });
boundary.state = ScenePageErrorBoundary.getDerivedStateFromError(actualError);
assert.equal(boundary.state.code, 'invalid-display-value');
const fallback = renderToStaticMarkup(React.createElement(React.Fragment, {}, boundary.render()));
assert.match(fallback, /role="alert"/);
assert.match(fallback, /invalid-display-value/);
assert.doesNotMatch(fallback, /PRIVATE-SYNTHETIC-CONTENT|description|Objects are not valid/);
const diagnostics: unknown[][] = [], previousError = console.error;
try {
  console.error = (...args: unknown[]) => { diagnostics.push(args); };
  boundary.componentDidCatch(actualError, { componentStack: 'PRIVATE-SYNTHETIC-STACK' });
} finally { console.error = previousError; }
assert.deepEqual(diagnostics, [['[scene-render]', { section: 'running', code: 'invalid-display-value' }]],
  'render diagnostics must contain safe codes only, not raw scene contents or stack');
const fallbackTree = boundary.render() as React.ReactElement<any>;
const actionRow = React.Children.toArray(fallbackTree.props.children).find(child =>
  React.isValidElement<{ className?: string }>(child) && child.props.className === 'scene-loading-actions') as React.ReactElement<any>;
assert.ok(actionRow);
const buttons = React.Children.toArray(actionRow.props.children) as React.ReactElement<any>[];
boundary.setState = ((state: any) => { boundary.state = { ...boundary.state, ...state }; }) as typeof boundary.setState;
buttons[0].props.onClick();
assert.equal(boundary.state.code, null, 'retry clears display failure without replaying any scene or model operation');
buttons[1].props.onClick();
assert.equal(returned, true, 'fallback exposes a usable return control');
assert.equal(ScenePageErrorBoundary.getDerivedStateFromError(new Error('PRIVATE-SYNTHETIC-PROVIDER-ERROR')).code, 'render-error');
console.log(JSON.stringify({ boundary: 'Synthetic actual React SSR plus direct boundary-method regression only; no real notes, saved user scene, model calls, filesystem persistence or browser E2E.',
  reports, direct: 'form/ledger/rich-message pass', fallback: 'safe classification, diagnostics, retry and return pass' }, null, 2));
