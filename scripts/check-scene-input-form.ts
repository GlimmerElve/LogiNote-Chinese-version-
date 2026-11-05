import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { LlmCallRequest, LlmCallResponse, SceneFormSubmission, SceneInputForm, SceneRunState, SceneSpec } from '../src/types';
import { normalizeSceneInputForm, readSceneFormSubmission, formatSceneFormSubmission, sceneInputForm } from '../src/services/scene/sceneInputForm';
import { designSceneBehavior, applySceneBehaviorDesign, type SceneBuildContext } from '../src/services/scene/sceneBuildAgent';
import { applySceneAssemblyPlan, generateScene, parseSceneSpec } from '../src/services/scene/sceneGenerator';
import { preflightSceneSpec, resolveSceneAssembly } from '../src/services/scene/sceneAssembly';
import { resolveSceneRuntimeContract } from '../src/services/scene/sceneRuntimeContract';
import { executeSceneExperiment, readSceneExperimentInput, closeSceneExperimentSession, sceneExperimentRecords } from '../src/services/scene/sceneExperiment';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { generateGeneralTurn } from '../src/services/scene/sceneDirector';
import { SceneDynamicForm } from '../src/components/scene/SceneDynamicForm';
import { understandingFixture } from './scene-semantic-fixture';
import { runSceneMultiAgent } from '../src/services/agent/sceneMultiAgent';
import { SceneUnderstandingError } from '../src/services/scene/sceneUnderstanding';
import { normalizeSceneTurnPlan } from '../src/services/scene/sceneTurnAgent';

globalThis.fetch = async () => assert.fail('Scene form checks are offline; no model, network, user data or storage calls');
const rawForm = {
  id: 'prompt-lab', title: 'Prompt lab', description: 'Submit exact text for an authorized experiment',
  fields: [
    { id: 'candidate', label: 'Candidate prompt', kind: 'textarea', required: true, maxLength: 12000, purpose: 'prompt', placeholder: 'Exact prompt' },
    { id: 'sample', label: 'Test input', kind: 'textarea', required: false, maxLength: 12000, purpose: 'test-input' },
    { id: 'format', label: 'Expected output', kind: 'select', required: true, maxLength: 100, purpose: 'output-format', options: [{ value: 'text', label: 'Plain text' }, { value: 'json-object', label: 'JSON object' }] },
    { id: 'context', label: 'Goal / notes', kind: 'text', required: false, maxLength: 12000, purpose: 'context' },
  ],
};
const form = normalizeSceneInputForm(rawForm);
assert.deepEqual(form.fields.map(field => field.kind), ['textarea', 'textarea', 'select', 'text']);
const withField = (patch: Record<string, unknown>) => ({ ...rawForm, fields: [{ ...rawForm.fields[0], ...patch }] });
const invalidSchemas: unknown[] = [null, [], {}, { ...rawForm, html: '<script>run()</script>' }, { ...rawForm, fields: [] },
  { ...rawForm, fields: Array.from({ length: 9 }, (_, i) => ({ ...rawForm.fields[0], id: `field-${i}` })) },
  { ...rawForm, fields: [rawForm.fields[0], rawForm.fields[0]] }, withField({ id: '__proto__' }), withField({ id: 'constructor' }),
  withField({ id: 'Bad ID' }), withField({ kind: 'file' }), withField({ kind: 'html' }), withField({ required: 'yes' }),
  withField({ purpose: 'api-key' }), withField({ label: 'x'.repeat(101) }), withField({ script: 'execute()' }),
  withField({ kind: ['text'] }), withField({ kind: { toString: () => 'text' } }),
  withField({ purpose: ['context'] }), withField({ purpose: { toString: () => 'context' } }),
  withField({ options: [{ value: 'x', label: 'x' }] }), withField({ kind: 'select', purpose: 'prompt', options: [{ value: 'x', label: 'x' }] }),
  withField({ kind: 'text', purpose: 'output-format' }),
  { ...rawForm, fields: [{ ...rawForm.fields[2], options: [] }] },
  { ...rawForm, fields: [{ ...rawForm.fields[2], options: [{ value: 'xml', label: 'XML' }] }] },
  { ...rawForm, fields: [{ ...rawForm.fields[2], options: [{ value: 'text', label: 'A' }, { value: 'text', label: 'B' }] }] },
  { ...rawForm, fields: [{ ...rawForm.fields[2], options: [{ value: 'text', label: 'A', script: 'execute()' }] }] },
  { ...rawForm, fields: [{ ...rawForm.fields[2], maxLength: 3 }] },
  { ...rawForm, fields: [rawForm.fields[0], { ...rawForm.fields[0], id: 'other-prompt' }] },
];
for (const schema of invalidSchemas) assert.throws(() => normalizeSceneInputForm(schema), 'unknown, unsafe, duplicate and unsupported schema must be rejected');
const manyOptions = { id: 'pick', label: 'Pick', kind: 'select', required: false, purpose: 'context', options: Array.from({ length: 13 }, (_, i) => ({ value: String(i), label: String(i) })) };
assert.throws(() => normalizeSceneInputForm({ ...rawForm, fields: [manyOptions] }));
assert.throws(() => normalizeSceneInputForm({ ...rawForm, fields: [{ ...manyOptions, options: [{ value: 'x', label: 'x'.repeat(101) }] }] }));
assert.equal(normalizeSceneInputForm(withField({ maxLength: undefined })).fields[0].maxLength, 4000);
assert.equal(normalizeSceneInputForm(withField({ maxLength: 99999 })).fields[0].maxLength, 12000);
assert.equal(normalizeSceneInputForm(withField({ maxLength: -1 })).fields[0].maxLength, 1);

const exactPrompt = '  Output JSON only.\r\nKeep \\n and \\t as literal escapes.\n{"path":"C:\\\\tmp","quote":"\\\""}  ';
const exactInput = '\n  {"line":"a\\nb","path":"D:\\\\data"}\r\n  ';
const values = { candidate: exactPrompt, sample: exactInput, format: 'json-object', context: 'DO NOT USE THIS CONTEXT AS THE TARGET PROMPT' };
const submission = readSceneFormSubmission({ formId: form.id, values }, form);
assert.deepEqual(submission.values, values, 'submission preserves original spaces, CRLF, JSON and backslashes');
const formatted = formatSceneFormSubmission(form, submission);
assert.ok(formatted.includes(exactPrompt)); assert.ok(formatted.includes(exactInput));
assert.throws(() => readSceneFormSubmission({ formId: 'old-version', values }, form));
assert.throws(() => readSceneFormSubmission({ formId: form.id, values, endpoint: 'https://invalid.test' }, form));
assert.throws(() => readSceneFormSubmission({ formId: form.id, values: { ...values, rogue: 'x' } }, form));
assert.throws(() => readSceneFormSubmission({ formId: form.id, values: { ...values, candidate: ' \n ' } }, form));
assert.throws(() => readSceneFormSubmission({ formId: form.id, values: { ...values, sample: 123 } }, form));
assert.throws(() => readSceneFormSubmission({ formId: form.id, values: { ...values, format: 'xml' } }, form));
assert.throws(() => readSceneFormSubmission({ formId: form.id, values: { ...values, candidate: 'x'.repeat(12001) } }, form));
assert.throws(() => readSceneFormSubmission({ formId: form.id, values: { candidate: 'x'.repeat(12000), sample: 'x'.repeat(12000), format: 'text' } }, form), 'total submission limit is strict and never truncates');
assert.equal(readSceneFormSubmission({ formId: form.id, values: { candidate: 'x', format: 'text' } }, form).values.sample, '');

const rawScene = parseSceneSpec(JSON.stringify({ meta: { name: 'Synthetic form scene', subject: 'Prompt engineering', goal: 'Test user prompts' }, task: 'Collect exact user input',
  behavior: { recipeId: 'agent-designed', kind: 'Adaptive dialogue', aiBehavior: 'Understand the request', userAction: 'Submit text or a form', evaluationRule: 'No learning score', progressionRule: 'Follow the next request',
    interaction: { version: '1.0', allowedTypes: ['text'], defaultType: 'text', allowTextFallback: true } }, inputForm: form }));
const formOpts = { subject: rawScene.meta.subject, knowledgePoints: [], sceneSkill: 'S1' as const, recipeId: 'agent-designed' as const,
  requestedCapabilities: ['text' as const], requestedPromptModules: ['turn-agent-planning' as const, 'input-form' as const] };
const spec = applySceneAssemblyPlan(rawScene, formOpts);
assert.deepEqual(sceneInputForm(spec), form); assert.equal(preflightSceneSpec(spec).valid, true);
assert.equal(resolveSceneRuntimeContract(spec).allowedTools.includes('model-experiment'), false, 'a form is not a paid-model permission');
assert.equal(sceneInputForm({ ...spec, promptModuleIds: ['turn-agent-planning'] }), undefined);
assert.equal(sceneInputForm({ ...spec, meta: { ...spec.meta, sceneSkill: 'S4' } }), undefined);
assert.equal(resolveSceneAssembly({ sceneSkill: 'S4', recipeId: 'guided-derivation', requestedPromptModules: ['input-form'] }).valid, false);
assert.throws(() => sceneInputForm({ ...spec, inputForm: undefined }));
const strictChoice: SceneSpec = { ...spec, capabilityIds: ['single-choice'], behavior: { ...spec.behavior!, interaction: { version: '1.0' as const, allowedTypes: ['single-choice' as const], defaultType: 'single-choice' as const, allowTextFallback: false } }, runtimeContract: undefined };
assert.equal(sceneInputForm(strictChoice), undefined);
assert.equal(preflightSceneSpec(strictChoice).valid, false, 'forms cannot bypass a single-choice-only interaction contract');
assert.equal(sceneInputForm({ ...spec, runtimeContract: { ...spec.runtimeContract!, allowTextFallback: false } }), undefined);
assert.equal(sceneInputForm({ ...spec, runtimeContract: { ...spec.runtimeContract!, allowedInteractionTypes: ['single-choice'] } }), undefined);

const userRequest = 'Build a dialogue scene with an input form whose fields suit the task';
let assembleAttempts = 0; const architecturePhases: string[] = [];
const architecture = await runSceneMultiAgent({ userRequest, sceneSkillConstraint: 'S1', callLlm: async call => {
  const input = JSON.parse(call.userInput); architecturePhases.push(input.phase);
  if (input.phase === 'understand') return { content: JSON.stringify({ sceneSkill: 'S1', understanding: understandingFixture('request', userRequest, { intent: 'build-scene', userGoal: userRequest }) }) };
  assert.equal(input.phase, 'assemble'); assembleAttempts++;
  if (assembleAttempts === 2) {
    assert.equal(input.outputRepair.code, 'unjustified-input-form');
    assert.match(input.outputRepair.detail, /module:input-form/, 'repair guidance names the exact required capability-plan module mapping');
  }
  return { content: JSON.stringify({ recipeId: 'agent-designed', requestedCapabilities: ['text'], requestedPromptModules: ['turn-agent-planning', 'input-form'],
    interactionPlan: 'Collect user input with a task-appropriate form', rationale: 'User requested a form, without granting model execution',
    capabilityPlan: { needs: [{ id: 'submit', goal: 'Submit exact task inputs', capabilityIds: assembleAttempts === 1 ? ['text'] : ['text', 'module:input-form'] }], missing: [] } }) };
} });
assert.deepEqual(architecturePhases, ['understand', 'assemble', 'assemble']);
assert.ok(architecture.recommendation.capabilityPlan.needs[0].capabilityIds.includes('module:input-form'));
assert.equal(architecture.recommendation.requestedPromptModules.includes('model-experiment'), false);
const context: SceneBuildContext = { version: 1, userRequest, conversation: [], selectedSurface: 'S1', explicitSelections: {},
  understanding: understandingFixture('request', userRequest, { intent: 'build-scene', userGoal: userRequest }),
  assembly: { recipeId: 'agent-designed', capabilities: ['text'], promptModules: ['turn-agent-planning', 'input-form'], interactionPlan: 'Read exact submitted form values' } };
const flow = { answerFeedback:{correctness:'immediate',explanation:'immediate'},flowGuidance: 'Understand the user before choosing the next step', evaluationRule: 'No default score', progressionRule: 'Use user intent', completionRule: 'User decides', maxTurns: 12, stages: [] };
const instructions = { aiBehavior: 'Help with the actual task', userAction: 'Submit text or exact form values', understanding: 'Interpret the user intent', planning: 'Use only approved tools', response: 'Answer the current need' };
const phases: string[] = [];
let flowCount = 0;
const design = await designSceneBehavior(context, { invoke: async call => {
  const input = JSON.parse(call.userInput); phases.push(input.phase); assert.equal(input.buildContext.userRequest, userRequest);
  if (input.phase === 'flow') {
    flowCount++;
    if (flowCount === 1) return { content: JSON.stringify(flow) };
    assert.equal(input.outputRepair.code, 'missing-input-form'); return { content: JSON.stringify({ ...flow, inputForm: form }) };
  }
  assert.equal(input.phase, 'instructions'); assert.deepEqual(normalizeSceneInputForm(input.priorArtifacts.flow.inputForm), form);
  return { content: JSON.stringify(instructions) };
} });
assert.deepEqual(phases, ['flow', 'flow', 'instructions']); assert.deepEqual(design.flow.inputForm, form);
assert.deepEqual(applySceneBehaviorDesign(rawScene, design).inputForm, form);
const buildPhases: string[] = [];
const generated = await generateScene({ ...formOpts, buildContext: context, manifest: { version: '1.0', updatedAt: '', scenes: [] }, callLlm: async call => {
  const input = JSON.parse(call.userInput); buildPhases.push(input.phase);
  if (input.phase === 'flow') return { content: JSON.stringify({ ...flow, inputForm: form }) };
  if (input.phase === 'instructions') return { content: JSON.stringify(instructions) };
  if (input.phase === 'generate') {
    assert.deepEqual(normalizeSceneInputForm(input.priorArtifacts.flow.inputForm), form);
    return { content: JSON.stringify({ ...rawScene, inputForm: { ...form, title: 'Conflicting later model guess' } }) };
  }
  assert.equal(input.phase, 'accept'); assert.deepEqual(normalizeSceneInputForm(input.scene.inputForm), form);
  assert.ok(input.criteria.some((criterion: { id: string }) => criterion.id === 'input-form-fit'));
  return { content: JSON.stringify({ coverage: input.criteria.map((criterion: { id: string }) => ({ id: criterion.id, satisfied: true,
    evidencePaths: ['scene.inputForm.fields[0].id', 'inputForm.fields.0.label'], detail: 'Synthetic exact-form coverage with safe indexed evidence paths' })), issues: [] }) };
} });
assert.deepEqual(buildPhases, ['flow', 'instructions', 'generate', 'accept']); assert.deepEqual(generated.inputForm, form);
assert.equal(generated.experimentPolicy, undefined); assert.equal(generated.runtimeContract!.allowedTools.includes('model-experiment'), false);

const experimentSpec: SceneSpec = applySceneAssemblyPlan({ ...rawScene, experimentPolicy: { criteria: ['Output follows the submitted prompt'], maxExperiments: 2, maxOutputTokens: 256, temperature: .2 } },
  { ...formOpts, requestedPromptModules: [...formOpts.requestedPromptModules, 'model-experiment'] });
const run: SceneRunState = createRunState(experimentSpec); run.runId = 'synthetic-exact-form'; run.experimentApproved = true;
run.messages.push({ id: 'form-user', speakerType: 'user', speakerName: 'User', content: formatted, timestamp: '', formSubmission: submission });
const args = { promptSourceMessageId: 'form-user', promptFieldId: 'candidate', inputSourceMessageId: 'form-user', inputFieldId: 'sample', outputFormat: 'json-object' as const };
let targetCalls = 0, judgeCalls = 0;
const invoke = async (call: LlmCallRequest): Promise<LlmCallResponse> => {
  assert.equal(call.skipMemoryInjection, true); assert.equal(call.skipProfileInjection, true); assert.equal(call.tools, undefined); assert.equal(call.messages, undefined);
  if (call.workflow === 'scene-model-experiment') {
    targetCalls++; assert.equal(call.systemPromptOverride, exactPrompt); assert.equal(call.userInput, exactInput);
    assert.ok(!call.systemPromptOverride.includes(values.context)); assert.deepEqual(call.outputSchema, {});
    return { content: '{"ok":true}' };
  }
  judgeCalls++; assert.equal(call.workflow, 'scene-experiment-evaluate');
  const input = JSON.parse(call.userInput); assert.equal(input.testedPrompt, exactPrompt); assert.equal(input.testInput, exactInput);
  return { content: '{"checks":[{"index":0,"verdict":"met","evidence":"true","suggestion":"Repeat with other inputs"}]}' };
};
assert.throws(() => readSceneExperimentInput({ ...args, promptQuote: exactPrompt }));
assert.throws(() => readSceneExperimentInput({ ...args, inputQuote: exactInput }));
for (const outputFormat of [['json-object'], ['text'], { toString: () => 'json-object' }, null, 1]) {
  assert.throws(() => readSceneExperimentInput({ ...args, outputFormat }), 'experimental output format must be an actual string, not a coercible value');
}
await assert.rejects(executeSceneExperiment(experimentSpec, run, { ...args, promptFieldId: 'context' }, { invoke }));
await assert.rejects(executeSceneExperiment(experimentSpec, run, { ...args, inputFieldId: 'context' }, { invoke }));
await assert.rejects(executeSceneExperiment(experimentSpec, run, { ...args, promptFieldId: undefined, promptQuote: values.context }, { invoke }), 'a context quote cannot bypass its field purpose');
await assert.rejects(executeSceneExperiment(experimentSpec, run, { ...args, promptFieldId: undefined, promptQuote: exactPrompt.slice(0, 25) }, { invoke }), 'a partial prompt quote cannot silently test a different version of a submitted form');
await assert.rejects(executeSceneExperiment(experimentSpec, run, { ...args, inputFieldId: undefined, inputQuote: values.context }, { invoke }), 'a context quote cannot masquerade as a test-input field');
await assert.rejects(executeSceneExperiment(experimentSpec, run, { ...args, inputFieldId: undefined, inputQuote: exactPrompt }, { invoke }), 'a prompt quote cannot masquerade as a test-input field');
await assert.rejects(executeSceneExperiment(experimentSpec, run, { ...args, promptFieldId: 'unsubmitted-field' }, { invoke }));
await assert.rejects(executeSceneExperiment(experimentSpec, run, { ...args, outputFormat: 'text' }, { invoke }));
await assert.rejects(executeSceneExperiment({ ...experimentSpec, promptModuleIds: ['turn-agent-planning', 'model-experiment'] }, run, args, { invoke }));
await assert.rejects(executeSceneExperiment(spec, { ...run, sceneId: spec.sceneId }, args, { invoke }), 'a form alone does not grant an experiment');
await assert.rejects(executeSceneExperiment(experimentSpec, { ...run, messages: run.messages.map(message => message.id === 'form-user' ? { ...message, formSubmission: { ...submission, formId: 'old-form' } } : message) }, args, { invoke }));
await assert.rejects(executeSceneExperiment(experimentSpec, { ...run, messages: run.messages.map(message => message.id === 'form-user' ? { ...message, isStreaming: true } : message) }, args, { invoke }));
assert.equal(targetCalls, 0); assert.equal(judgeCalls, 0, 'invalid fields and scope never reach a model');
const record = await executeSceneExperiment(experimentSpec, run, args, { invoke });
assert.equal(record.status, 'complete'); assert.equal(record.prompt, exactPrompt); assert.equal(record.input, exactInput);
assert.equal(record.outputFormat, 'json-object'); assert.equal(targetCalls, 1); assert.equal(judgeCalls, 1);
const automaticallyBound = await executeSceneExperiment(experimentSpec, run, { promptSourceMessageId: 'form-user', promptFieldId: 'candidate', outputFormat: 'json-object' }, { invoke });
assert.equal(automaticallyBound.input, exactInput, 'omitting explicit input binds the complete submitted test-input field from the same form');
assert.equal(automaticallyBound.id, record.id); assert.equal(targetCalls, 1, 'explicit and automatic references to the same exact fields share retry deduplication');
const otherInput = '  An explicitly selected input from another submitted message.\r\n{"path":"X:\\\\sample"}  ';
const otherSubmission = readSceneFormSubmission({ formId: form.id, values: { ...values, sample: otherInput } }, form);
const crossRun: SceneRunState = { ...run, messages: [...run.messages, { id: 'cross-input-user', speakerType: 'user', speakerName: 'User', timestamp: '',
  content: formatSceneFormSubmission(form, otherSubmission), formSubmission: otherSubmission }] };
const crossRecord = await executeSceneExperiment(experimentSpec, crossRun, { ...args, inputSourceMessageId: 'cross-input-user' }, { invoke: async call => {
  if (call.workflow === 'scene-model-experiment') {
    targetCalls++; assert.equal(call.systemPromptOverride, exactPrompt); assert.equal(call.userInput, otherInput); return { content: '{"ok":true}' };
  }
  judgeCalls++; const input = JSON.parse(call.userInput); assert.equal(input.testedPrompt, exactPrompt); assert.equal(input.testInput, otherInput);
  return { content: '{"checks":[{"index":0,"verdict":"met","evidence":"true","suggestion":"Repeat with other inputs"}]}' };
} });
assert.equal(crossRecord.status, 'complete'); assert.equal(crossRecord.prompt, exactPrompt); assert.equal(crossRecord.input, otherInput);
assert.equal(targetCalls, 2); assert.equal(judgeCalls, 2, 'an explicit cross-message input takes precedence over same-form automatic binding');
closeSceneExperimentSession(run);

// All controller phases use bounded navigation previews; only the target and independent judge see full tested text.
const promptSentinel = 'FORM_PROMPT_AFTER_301_SENTINEL';
const inputSentinel = 'FORM_INPUT_AFTER_301_SENTINEL';
const contextSentinel = 'FORM_CONTEXT_AFTER_301_SENTINEL';
const longPrompt = 'p'.repeat(301) + promptSentinel + '\r\n  Preserve this exact ending: \\n {"k":"v"}  ';
const longInput = 'i'.repeat(301) + inputSentinel + '\n {"line":"a\\nb"}  ';
const longValues = { candidate: longPrompt, sample: longInput, format: 'json-object', context: 'c'.repeat(301) + contextSentinel };
const longSubmission = readSceneFormSubmission({ formId: form.id, values: longValues }, form);
const longRun = createRunState(experimentSpec); longRun.runId = 'synthetic-long-form-controller'; longRun.experimentApproved = true;
longRun.messages.push({ id: 'long-form-user', speakerType: 'user', speakerName: 'User', timestamp: '', content: formatSceneFormSubmission(form, longSubmission), formSubmission: longSubmission });
const longArgs = { ...args, promptSourceMessageId: 'long-form-user', inputSourceMessageId: 'long-form-user' };
const controllerPhases: string[] = []; let longPlanCalls = 0, longTargets = 0, longJudges = 0;
const turn = await generateGeneralTurn(experimentSpec, longRun, { dependencies: {
  searchNotes: async () => assert.fail('form experimentation cannot silently read notes'),
  experimentCallLlm: async call => {
    if (call.workflow === 'scene-model-experiment') {
      longTargets++; assert.equal(call.systemPromptOverride, longPrompt); assert.equal(call.userInput, longInput);
      return { content: '{"ok":true}' };
    }
    longJudges++; assert.equal(call.workflow, 'scene-experiment-evaluate');
    const input = JSON.parse(call.userInput); assert.equal(input.testedPrompt, longPrompt); assert.equal(input.testInput, longInput);
    return { content: '{"checks":[{"index":0,"verdict":"met","evidence":"true","suggestion":"Test another input"}]}' };
  },
  callLlm: async call => {
    const serializedCall = JSON.stringify(call);
    for (const sentinel of [promptSentinel, inputSentinel, contextSentinel]) assert.equal(serializedCall.includes(sentinel), false,
      'form field text beyond the 300-character preview must not leak into controller input or messages');
    if (call.workflow !== 'scene-turn-plan') {
      controllerPhases.push('respond'); assert.equal(call.workflow, 'scene-general-turn');
      assert.ok(call.messages?.length, 'the responder history path is included in the bounded-context check');
      return { content: '{"content":"The actual experiment completed. Review its receipt before revising."}' };
    }
    const input = JSON.parse(call.userInput); controllerPhases.push(input.phase);
    if (input.phase === 'understand') return { content: JSON.stringify({ action: 'respond', understanding: understandingFixture('long-form-user', longPrompt.slice(0, 60), {
      userGoal: 'Run the exact submitted form fields', expectedExperience: 'A real experiment followed by grounded feedback',
      informationGaps: [{ id: 'execute', kind: 'execution-result', description: 'The requested experiment has not run yet' }],
    }) }) };
    assert.equal(input.phase, 'plan'); longPlanCalls++;
    if (longPlanCalls === 2) {
      assert.equal(input.outputRepair.code, 'invalid-experiment-request');
      assert.equal(typeof input.outputRepair.detail, 'string'); assert.ok(input.outputRepair.detail.length > 0);
      assert.equal(longTargets, 0, 'invalid first plan is repaired before any experiment executes');
    }
    return { content: JSON.stringify({ action: 'respond', toolRequests: longPlanCalls <= 2 ? [{ id: 'model-experiment', query: 'Run the submitted form', needId: 'execute', reason: 'Obtain an actual model response',
      experiment: longPlanCalls === 1 ? { ...longArgs, promptQuote: longPrompt.slice(0, 60) } : longArgs }] : [] }) };
  },
} });
assert.deepEqual(controllerPhases, ['understand', 'plan', 'plan', 'plan', 'respond']); assert.equal(longTargets, 1); assert.equal(longJudges, 1);
assert.equal(turn.experiments?.length, 1); assert.equal(turn.experiments![0].prompt, longPrompt); assert.equal(turn.experiments![0].input, longInput);
assert.deepEqual(longRun.messages.at(-1)!.formSubmission, longSubmission, 'bounded model projections never mutate the submitted original');
closeSceneExperimentSession(longRun);

const invalidPlanRun = createRunState(experimentSpec); invalidPlanRun.runId = 'synthetic-invalid-form-plan'; invalidPlanRun.experimentApproved = true;
invalidPlanRun.messages.push({ ...longRun.messages.at(-1)!, id: 'invalid-plan-user' });
const invalidPlanPhases: string[] = []; let invalidPlanAttempts = 0, invalidPlanExperiments = 0;
await assert.rejects(generateGeneralTurn(experimentSpec, invalidPlanRun, { dependencies: {
  experimentCallLlm: async () => { invalidPlanExperiments++; assert.fail('two invalid plans must stop without executing an experiment'); },
  callLlm: async call => {
    assert.equal(call.workflow, 'scene-turn-plan', 'invalid plans never reach the response generator');
    const input = JSON.parse(call.userInput); invalidPlanPhases.push(input.phase);
    if (input.phase === 'understand') return { content: JSON.stringify({ action: 'respond', understanding: understandingFixture('invalid-plan-user', longPrompt.slice(0, 60), {
      informationGaps: [{ id: 'execute', kind: 'execution-result', description: 'The requested experiment needs an actual result' }],
    }) }) };
    assert.equal(input.phase, 'plan'); invalidPlanAttempts++;
    if (invalidPlanAttempts === 2) assert.equal(input.outputRepair.code, 'invalid-experiment-request');
    return { content: JSON.stringify({ action: 'respond', toolRequests: [{ id: 'model-experiment', query: 'Invalid synthetic request', needId: 'execute', reason: 'Obtain a result',
      experiment: { ...longArgs, promptSourceMessageId: 'invalid-plan-user', inputSourceMessageId: 'invalid-plan-user', promptQuote: longPrompt.slice(0, 60) } }] }) };
  },
} }), error => error instanceof SceneUnderstandingError && error.code === 'invalid-experiment-request');
assert.deepEqual(invalidPlanPhases, ['understand', 'plan', 'plan']); assert.equal(invalidPlanAttempts, 2); assert.equal(invalidPlanExperiments, 0);
assert.deepEqual(sceneExperimentRecords(invalidPlanRun), [], 'rejected plan arguments never reserve or fabricate an experiment receipt');
closeSceneExperimentSession(invalidPlanRun);

const implicitRun = createRunState(experimentSpec); implicitRun.runId = 'synthetic-form-compiled-request'; implicitRun.experimentApproved = true;
implicitRun.messages.push({ id: 'implicit-form-user', speakerType: 'user', speakerName: 'User', timestamp: '', content: formatted, formSubmission: submission });
const implicitUnderstanding = understandingFixture('implicit-form-user', exactPrompt.slice(0, 50), {
  informationGaps: [{ id: 'execute', kind: 'execution-result', description: 'Need a real execution result for this submitted form' }],
});
const selectedTool = { id: 'model-experiment', query: 'Run the current submitted form', needId: 'execute', reason: 'The user requested an actual test' };
const implicitPlan = normalizeSceneTurnPlan({ action: 'respond', understanding: implicitUnderstanding, toolRequests: [selectedTool] }, experimentSpec, implicitRun);
assert.deepEqual(implicitPlan.toolRequests[0].experiment, { promptSourceMessageId: 'implicit-form-user', promptFieldId: 'candidate',
  inputSourceMessageId: 'implicit-form-user', inputFieldId: 'sample', outputFormat: 'json-object' }, 'a selected experiment may compile safe references from validated purpose fields without copying text');
assert.equal(normalizeSceneTurnPlan({ action: 'respond', understanding: implicitUnderstanding, toolRequests: [] }, experimentSpec, implicitRun).toolRequests.length, 0,
  'the form compiler never selects an experiment tool automatically');
const noExperimentPermission: SceneSpec = { ...experimentSpec, promptModuleIds: ['turn-agent-planning', 'input-form'] };
assert.equal(normalizeSceneTurnPlan({ action: 'respond', understanding: implicitUnderstanding, toolRequests: [selectedTool] }, noExperimentPermission, implicitRun).toolRequests.length, 0,
  'compiling form references cannot bypass the tool module whitelist');
const noPromptPurpose: SceneSpec = { ...experimentSpec, inputForm: normalizeSceneInputForm({ ...rawForm, fields: rawForm.fields.map(field => field.id === 'candidate' ? { ...field, purpose: 'context' } : field) }) };
assert.throws(() => normalizeSceneTurnPlan({ action: 'respond', understanding: implicitUnderstanding, toolRequests: [selectedTool] }, noPromptPurpose, implicitRun),
  error => error instanceof SceneUnderstandingError && error.code === 'invalid-experiment-request', 'a general context form cannot fabricate a prompt-purpose field');
const noSubmittedForm: SceneRunState = { ...implicitRun, messages: implicitRun.messages.map(message => ({ ...message, formSubmission: undefined })) };
assert.throws(() => normalizeSceneTurnPlan({ action: 'respond', understanding: implicitUnderstanding, toolRequests: [selectedTool] }, experimentSpec, noSubmittedForm),
  error => error instanceof SceneUnderstandingError && error.code === 'invalid-experiment-request', 'ordinary chat text cannot trigger form-only argument compilation');
assert.throws(() => normalizeSceneTurnPlan({ action: 'respond', understanding: implicitUnderstanding, toolRequests: [{ ...selectedTool, experiment: {} }] }, experimentSpec, implicitRun),
  error => error instanceof SceneUnderstandingError && error.code === 'invalid-experiment-request', 'an explicitly malformed experiment is not replaced by a form fallback');
let implicitPlanCalls = 0, implicitTargets = 0, implicitJudges = 0;
const implicitTurn = await generateGeneralTurn(experimentSpec, implicitRun, { dependencies: {
  experimentCallLlm: async call => {
    if (call.workflow === 'scene-model-experiment') {
      implicitTargets++; assert.equal(call.systemPromptOverride, exactPrompt); assert.equal(call.userInput, exactInput); return { content: '{"ok":true}' };
    }
    implicitJudges++; const input = JSON.parse(call.userInput); assert.equal(input.testedPrompt, exactPrompt); assert.equal(input.testInput, exactInput);
    return { content: '{"checks":[{"index":0,"verdict":"met","evidence":"true","suggestion":"Try another sample"}]}' };
  },
  callLlm: async call => {
    if (call.workflow !== 'scene-turn-plan') return { content: '{"content":"The authorized form experiment was executed once."}' };
    const input = JSON.parse(call.userInput);
    if (input.phase === 'understand') return { content: JSON.stringify({ action: 'respond', understanding: implicitUnderstanding }) };
    implicitPlanCalls++; return { content: JSON.stringify({ action: 'respond', toolRequests: implicitPlanCalls === 1 ? [selectedTool] : [] }) };
  },
} });
assert.equal(implicitPlanCalls, 2); assert.equal(implicitTargets, 1); assert.equal(implicitJudges, 1);
assert.equal(implicitTurn.experiments?.length, 1); assert.equal(implicitTurn.experiments![0].prompt, exactPrompt); assert.equal(implicitTurn.experiments![0].input, exactInput);
closeSceneExperimentSession(implicitRun);

const markup = renderToStaticMarkup(createElement(SceneDynamicForm, { form, disabled: true, onSubmit() {} }));
assert.match(markup, /aria-busy="true"/); assert.match(markup, /<fieldset disabled=""/); assert.match(markup, /<button[^>]*disabled=""/);
assert.equal((markup.match(/<label /g) || []).length, form.fields.length);
for (const match of markup.matchAll(/<label for="([^"]+)"/g)) assert.ok(markup.includes(`id="${match[1]}"`), 'each accessible label targets a rendered control');
assert.equal((markup.match(/required=""/g) || []).length, 2);
assert.match(markup, /<textarea/); assert.match(markup, /<select/); assert.match(markup, /<input/); assert.match(markup, /aria-describedby=/);
const unsafeTextForm = normalizeSceneInputForm({ ...rawForm, title: '<script>title()</script>', description: '<img src=x onerror=evil()>', fields: [{ id: 'safe', label: '<script>label()</script>', kind: 'text', required: true, placeholder: '<img src=x>' }] });
const escaped = renderToStaticMarkup(createElement(SceneDynamicForm, { form: unsafeTextForm, disabled: false, onSubmit() {} }));
assert.ok(escaped.includes('&lt;script&gt;')); assert.equal(escaped.includes('<script>'), false); assert.equal(escaped.includes('<img '), false);

type Tree = { type: unknown; props: Record<string, any> };
const fakeReact = { createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Tree => ({ type, props: { ...props, children } }) };
const flatten = (node: unknown): Tree[] => !node || typeof node !== 'object' ? [] : Array.isArray(node) ? node.flatMap(flatten) : [node as Tree, ...flatten((node as Tree).props?.children)];
const formSourcePath = 'src/components/scene/SceneDynamicForm.tsx';
const formSource = ts.createSourceFile(formSourcePath, readFileSync(formSourcePath, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const body = formSource.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)).map(node => node.getText(formSource)).join('\n').replace(/^export\s+/gm, '');
const compiled = ts.transpileModule(`${body}\nreturn SceneDynamicForm`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.None } }).outputText;
const slots: any[] = []; const effects: Array<() => void> = []; let cursor = 0; let disabled = false;
let initialSubmission: SceneFormSubmission | undefined;
const hooks = {
  useId() { cursor++; return 'synthetic-form-id'; },
  useState(initial: unknown) { const i = cursor++; if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }; return [slots[i].value, (next: any) => { slots[i].value = typeof next === 'function' ? next(slots[i].value) : next; }]; },
  useRef(initial: unknown) { const i = cursor++; return slots[i] ||= { current: initial }; },
  useEffect(effect: () => void, deps: unknown[]) { const i = cursor++; if (!slots[i] || deps.some((dep, index) => dep !== slots[i].deps[index])) { slots[i] = { deps }; effects.push(effect); } },
};
const environment = { React: fakeReact, ...hooks, readSceneFormSubmission };
const Component = new Function(...Object.keys(environment), compiled)(...Object.values(environment)) as (props: Record<string, unknown>) => Tree;
const submitted: SceneFormSubmission[] = []; let tree: Tree[] = [];
const render = () => { cursor = 0; tree = flatten(Component({ form, disabled, initialSubmission, onSubmit: (value: SceneFormSubmission) => submitted.push(value) })); effects.splice(0).forEach(effect => effect()); };
const control = (fieldId: string) => { const node = tree.find(node => node.props.id === `synthetic-form-id-${fieldId}`); assert.ok(node); return node.props; };
const submitEvent = () => { const node = tree.find(node => node.type === 'form'); assert.ok(node); return node.props.onSubmit as (event: { preventDefault(): void }) => void; };
const event = { preventDefault() {} };
render(); submitEvent()(event); render(); assert.equal(submitted.length, 0); assert.ok(tree.some(node => node.props.role === 'alert'), 'invalid required input is surfaced accessibly');
for (const [id, value] of Object.entries(values)) { control(id).onChange({ target: { value } }); render(); }
const send = submitEvent(); send(event); send(event); assert.equal(submitted.length, 1, 'same-frame double submit is synchronously locked');
assert.deepEqual(submitted[0], submission);
disabled = true; render(); submitEvent()(event); assert.equal(submitted.length, 1);
for (const [id, value] of Object.entries(values)) assert.equal(control(id).value, value, 'draft survives sending / response latency');
disabled = false; render(); assert.equal(control('candidate').value, exactPrompt, 'draft remains after a failed or completed response');
submitEvent()(event); assert.equal(submitted.length, 2, 'explicit resubmission after the disabled cycle is permitted');
slots.length = 0; initialSubmission = submission; render();
for (const [id, value] of Object.entries(values)) assert.equal(control(id).value, value, 'remount after a response failure restores exact submitted field values');
control('candidate').onChange({ target: { value: 'An unsent revision after restoration' } }); render();
initialSubmission = { ...submission, values: { ...values, candidate: 'A different prop value' } }; render();
assert.equal(control('candidate').value, 'An unsent revision after restoration', 'rerenders do not replace an in-progress draft with initial payload');
slots.length = 0; initialSubmission = { ...submission, formId: 'another-form-version' }; render();
for (const field of form.fields) assert.equal(control(field.id).value, '', 'a different form version cannot populate this form');
slots.length = 0; initialSubmission = { ...submission, values: { ...values, rogue: 'unrecognized field' } }; render();
for (const field of form.fields) assert.equal(control(field.id).value, '', 'invalid stored payload is ignored rather than trusting its field schema');
slots.length = 0; initialSubmission = undefined; render();
for (const field of form.fields) assert.equal(control(field.id).value, '', 'a separately mounted new run without a submitted payload begins empty');

console.log('Scene input form passed: strict declarative schema, exact raw field preservation, length/total bounds, module and interaction gates, staged design repair and full compilation, no implicit experiment grant, exact authorized field execution, accessible escaped rendering, same-frame submission lock and retained drafts. Synthetic offline decisions only.');
