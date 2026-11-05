import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';
import type { SceneRunState } from '../src/types';
import { SceneChatView } from '../src/components/scene/SceneChatView';
import { SceneDynamicForm } from '../src/components/scene/SceneDynamicForm';
import { SceneInteractionInput, isSupportedStructuredInteraction } from '../src/components/scene/SceneInteractionInput';
import { SceneRichMessage } from '../src/components/scene/SceneRichMessage';
import { SceneMetricPanel } from '../src/components/scene/SceneMetricPanel';
import { SceneExperimentLedger } from '../src/components/scene/SceneExperimentLedger';
import { SceneWidgetContent, SceneWidgetErrorBoundary } from '../src/components/scene/SceneWidgetErrorBoundary';
import { parseSceneSpec, applySceneAssemblyPlan } from '../src/services/scene/sceneGenerator';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { getPendingSceneInteraction } from '../src/services/scene/scenePendingTask';
import { getUnifiedSceneRecipe } from '../src/services/scene/sceneCapabilityRegistry';
import { isScenePromptModuleEnabled, resolveSceneRuntimeContract } from '../src/services/scene/sceneRuntimeContract';
import { resolveSceneInputAvailability, sceneInputAvailabilityContext } from '../src/services/scene/sceneInputAvailability';
import { readSceneFormSubmission } from '../src/services/scene/sceneInputForm';

globalThis.fetch = async () => assert.fail('Widget reliability checks must not use network, real notes, or a model');
const spec = applySceneAssemblyPlan(parseSceneSpec(JSON.stringify({
  meta: { name: 'Synthetic component handoff', subject: 'Synthetic only', goal: 'Practice then refine a prompt', knowledgePoints: [] },
  role: { name: 'Tutor', attributes: [] }, userRole: 'Learner', situation: 'Synthetic lab', task: 'Discuss and practice',
  resources: ['Synthetic reference'], rules: [], metrics: [], events: [], completion: { mode: 'signal', maxTurns: 12 },
  behavior: { recipeId: 'agent-designed', kind: 'Tutor', aiBehavior: 'Follow the user', userAction: 'Answer or discuss',
    evaluationRule: 'Check submitted answers only', progressionRule: 'Keep unfinished tasks',
    interaction: { version: '1.0', allowedTypes: ['text', 'single-choice'], defaultType: 'single-choice', allowTextFallback: true } },
  inputForm: { id: 'synthetic-form', title: 'Synthetic prompt', fields: [
    { id: 'prompt', label: 'Prompt text', kind: 'textarea', purpose: 'context', required: true, maxLength: 4000 },
  ] },
})), { sceneSkill: 'S1', subject: 'Synthetic only', knowledgePoints: [], recipeId: 'agent-designed',
  requestedCapabilities: ['text', 'single-choice'], requestedPromptModules: ['turn-agent-planning', 'structured-interaction', 'input-form'] });
const run = createRunState(spec);
const question = { id: 'q1', type: 'single-choice' as const, instruction: 'Choose the supported answer', required: true,
  options: [{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }] };
run.messages.push({ id: 'question-message', speakerType: 'role', speakerName: 'Tutor', content: 'Synthetic question',
  timestamp: '', interaction: question });
const events: any[] = [];
const props = { spec, run, sending: false, hasPrevRun: false, onSend: (...args: any[]) => events.push(args),
  onInjectEvent() { assert.fail('unexpected event'); }, onEnd() { events.push('end'); }, onRerun() { assert.fail('unexpected rerun'); } };
const html = renderToStaticMarkup(React.createElement(SceneChatView, props));
assert.match(html, /role="radiogroup"/);
assert.match(html, /填写场景表单/);
assert.match(html, /当前原题仍待答/);
assert.match(html, /<form[^>]+aria-label="Synthetic prompt"[^>]+aria-busy="true"/);
assert.match(html, /<fieldset disabled=""/);
assert.match(html, /aria-label="场景交流"/);
assert.doesNotMatch(html.match(/<textarea[^>]+aria-label="场景交流"[^>]*>/)?.[0] || '', /disabled/);
const unavailable = resolveSceneInputAvailability(spec, run);
assert.equal(unavailable.formAvailable, false); assert.equal(unavailable.pendingInteractionId, 'q1');
assert.ok(unavailable.inputForm); assert.equal('inputForm' in sceneInputAvailabilityContext(spec, run), false);
const answered: SceneRunState = { ...run, messages: [...run.messages, { id: 'submitted', speakerType: 'user' as const, speakerName: 'Learner', content: 'A', timestamp: '',
  inputKind: 'response' as const, interactionResponse: { interactionId: 'q1', type: 'single-choice' as const, selectedId: 'a', submittedAt: '' } }] };
assert.equal(resolveSceneInputAvailability(spec, answered).formAvailable, true);
const answeredHtml = renderToStaticMarkup(React.createElement(SceneChatView, { ...props, run: answered }));
assert.match(answeredHtml, /<form[^>]+aria-label="Synthetic prompt"[^>]+aria-busy="false"/);
assert.equal(resolveSceneInputAvailability(spec, { ...run, retiredInteractionIds: ['q1'] }).formAvailable, true);
assert.equal(resolveSceneInputAvailability(spec, { ...run, status: 'success' }).formAvailable, false);
const textRun: SceneRunState = { ...run, messages: [{ ...run.messages[0], interaction: { id: 'text-q', type: 'text' as const, instruction: 'Explain', required: true } }] };
assert.equal(resolveSceneInputAvailability(spec, textRun).formAvailable, true, 'a text task does not block the independently authorized form');
textRun.messages.push({ id: 'form-response', speakerType: 'user', speakerName: 'Learner', content: 'Synthetic form', timestamp: '',
  formSubmission: { formId: 'synthetic-form', values: { prompt: 'Synthetic only' } } });
assert.equal(getPendingSceneInteraction(textRun)?.interaction?.id, 'text-q', 'a form is not an answer to the pending text task');
for (const broken of [null, { title: { invalid: true } }, { ...spec.inputForm, fields: null }]) {
  const state = resolveSceneInputAvailability({ ...spec, inputForm: broken as any }, answered);
  assert.equal(state.formAvailable, false); assert.match(state.formBlockedReason || '', /表单配置未通过/);
  assert.doesNotThrow(() => renderToStaticMarkup(React.createElement(SceneChatView, { ...props, spec: { ...spec, inputForm: broken as any } })));
}
assert.equal(resolveSceneInputAvailability({ ...spec, runtimeContract: { ...spec.runtimeContract!, allowTextFallback: false } }, answered).formAvailable, false);

// Exercise the actual function with a tiny hook host, retaining state slots across
// rerenders. This tests production element identity and handlers, not browser E2E.
function compileComponent(path: string, name: string, environment: Record<string, unknown>) {
  const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  const body = source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
    .map(node => node.getText(source)).join('\n').replace(/^export\s+/gm, '');
  const compiled = ts.transpileModule(body + '\nreturn ' + name, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.None,
  } }).outputText;
  return new Function(...Object.keys(environment), compiled)(...Object.values(environment));
}
function hookHost() {
  let cursor = 0; const slots: any[] = [];
  return { reset() { cursor = 0; }, hooks: {
    useState(initial: any) { const index = cursor++; if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], (next: any) => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }]; },
    useRef(initial: any) { const index = cursor++; return slots[index] ||= { current: initial }; },
    useEffect() {}, useId() { return 'synthetic-control'; },
  } };
}
const host = hookHost();
const icons = Object.fromEntries(['Send', 'Loader2', 'Zap', 'Square', 'RotateCcw', 'Trophy', 'XCircle', 'PanelLeftClose', 'PanelLeftOpen',
  'Target', 'Clock3', 'UserRound', 'Bot', 'BookOpen', 'CircleHelp', 'Flag'].map(name => [name, 'span']));
const Chat = compileComponent('src/components/scene/SceneChatView.tsx', 'SceneChatView', { React, ...host.hooks, ...icons,
  resolveSceneInputAvailability, isSupportedStructuredInteraction, SceneInteractionInput, getUnifiedSceneRecipe,
  isScenePromptModuleEnabled, resolveSceneRuntimeContract, getPendingSceneInteraction, useDialog() {},
  SceneMetricPanel, SceneRichMessage, SceneExperimentLedger, SceneDynamicForm, SceneWidgetContent, SceneWidgetErrorBoundary });
function collect(value: any): React.ReactElement<any>[] {
  if (Array.isArray(value)) return value.flatMap(collect);
  if (!React.isValidElement(value)) return [];
  const element = value as React.ReactElement<any>;
  if (element.type === SceneWidgetContent) return [element, ...collect(element.props.children())];
  return [element, ...collect(element.props.children)];
}
function chatTree(next: any = {}) { host.reset(); return Chat({ ...props, ...next }); }
let elements = collect(chatTree());
const formElement = elements.find(node => node.type === SceneDynamicForm)!;
assert.ok(formElement); assert.equal(formElement.props.disabled, true);
formElement.props.onSubmit({ formId: 'synthetic-form', values: { prompt: 'must not submit' } });
assert.equal(events.length, 0, 'an unavailable form callback fails closed even when invoked directly');
const originalFormKey = formElement.key;
for (const next of [{ sending: true }, { turnError: 'Synthetic timeout' }, { run: answered }, { run: { ...run, retiredInteractionIds: ['q1'] } }]) {
  elements = collect(chatTree(next));
  const persistentForm = elements.find(node => node.type === SceneDynamicForm)!;
  assert.ok(persistentForm, 'temporary errors and task handoff keep the form mounted');
  assert.equal(persistentForm.key, originalFormKey, 'a reply, blocked form, or request failure does not reset form identity');
  assert.equal(elements.find(node => node.type === SceneWidgetErrorBoundary && node.props.widget === 'form')?.key, run.runId + ':form');
}
elements = collect(chatTree({ run: answered }));
elements.find(node => node.type === SceneDynamicForm)!.props.onSubmit({ formId: 'synthetic-form', values: { prompt: 'Synthetic only' } });
assert.equal(events.length, 1); events.length = 0;
const conversation = elements.find(node => node.type === 'textarea' && node.props['aria-label'] === '场景交流')!;
conversation.props.onChange({ target: { value: 'Keep the current question and explain an example' } });
elements = collect(chatTree());
const keyboardConversation = elements.find(node => node.type === 'textarea' && node.props['aria-label'] === '场景交流')!;
let prevented = 0;
keyboardConversation.props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: true }, preventDefault() { prevented++; } });
assert.equal(events.length, 0, 'IME Enter never submits');
keyboardConversation.props.onKeyDown({ key: 'Enter', shiftKey: false, nativeEvent: { isComposing: false, keyCode: 13 }, preventDefault() { prevented++; } });
assert.equal(events.length, 1); assert.equal(events[0][3], 'conversation'); assert.equal(events[0][1], undefined); assert.equal(events[0][2], undefined);
assert.equal(prevented, 1); events.length = 0;

// Form values survive disable/enable updates under that same element identity.
const formHost = hookHost();
const Form = compileComponent('src/components/scene/SceneDynamicForm.tsx', 'SceneDynamicForm', { React, ...formHost.hooks, readSceneFormSubmission });
const formProps = { form: unavailable.inputForm!, disabled: false, onSubmit() { assert.fail('no implicit submit'); } };
const formTree = (disabled: boolean) => { formHost.reset(); return Form({ ...formProps, disabled }); };
collect(formTree(false)).find(node => node.type === 'textarea')!.props.onChange({ target: { value: 'Unsubmitted synthetic draft' } });
assert.equal(collect(formTree(true)).find(node => node.type === 'textarea')!.props.value, 'Unsubmitted synthetic draft');
assert.equal(collect(formTree(false)).find(node => node.type === 'textarea')!.props.value, 'Unsubmitted synthetic draft');

// SSR does not run React's browser error-boundary lifecycle. Check each actual
// descendant SSR separately and substitute the actual class fallback at its
// nearest boundary; this verifies containment topology without claiming E2E.
const failures: string[] = [];
function isolate(value: any): any {
  if (Array.isArray(value)) return value.map(isolate);
  if (!React.isValidElement(value)) return value;
  const element = value as React.ReactElement<any>;
  if (element.type === SceneWidgetErrorBoundary) {
    try { const safeChildren = isolate(element.props.children);
      const fragment = React.createElement(React.Fragment, { key: element.key }, ...(Array.isArray(safeChildren) ? safeChildren : [safeChildren]));
      renderToStaticMarkup(fragment); return fragment; }
    catch { failures.push(element.props.widget); const boundary = new SceneWidgetErrorBoundary(element.props);
      boundary.state = SceneWidgetErrorBoundary.getDerivedStateFromError(new Error('Synthetic render fault')); return boundary.render(); }
  }
  if (element.type === SceneWidgetContent) return isolate(element.props.children());
  const children = isolate(element.props.children);
  return React.cloneElement(element, undefined, ...(Array.isArray(children) ? children : [children]));
}
const faultRun = structuredClone(run) as any;
faultRun.messages[0].citations = [{ noteId: 'synthetic-note', sourceType: 'note', index: 1, snippet: 'Synthetic only', score: .5, title: { unexpected: 'object' } }];
const containedHtml = renderToStaticMarkup(isolate(chatTree({ run: faultRun })));
assert.ok(failures.includes('citations'));
assert.equal(failures.includes('message-list'), false, 'a bad citation display cannot replace the entire transcript');
assert.match(containedHtml, /引用依据暂时无法显示/); assert.match(containedHtml, /aria-label="场景交流"/);
assert.match(containedHtml, /结束场景/); assert.match(containedHtml, /role="radiogroup"/); assert.match(containedHtml, /填写场景表单/);
assert.equal(events.length, 0, 'display faults do not submit, end, or call a model');
for (const fault of [
  { widget: 'message', run: { ...run, messages: [...run.messages, { id: 'bad-message', speakerType: 'role', speakerName: 'Tutor',
    content: { invalid: 'not text' }, timestamp: '' }, { id: 'good-after-bad', speakerType: 'role', speakerName: 'Tutor',
    content: 'GOOD_MESSAGE_AFTER_BAD_WIDGET', timestamp: '' }] } },
  { widget: 'metrics', spec: { ...spec, metrics: [{ id: 'bad-metric', name: { invalid: 'not text' }, type: 'count', initial: 0, target: 1 }] } },
  { widget: 'experiment-ledger', spec: { ...spec, promptModuleIds: [...spec.promptModuleIds!, 'model-experiment'],
    experimentPolicy: { criteria: ['Synthetic check'], maxExperiments: 1, maxOutputTokens: 512, temperature: .2 } },
    run: { ...run, experimentRecords: [{ id: 'broken-ledger-record', evaluation: null }] } },
]) {
  failures.length = 0;
  const safeHtml = renderToStaticMarkup(isolate(chatTree(fault)));
  assert.ok(failures.includes(fault.widget), fault.widget + ': fault belongs to its local boundary');
  assert.equal(failures.includes('message-list'), false);
  assert.match(safeHtml, /aria-label="场景交流"/); assert.match(safeHtml, /结束场景/); assert.match(safeHtml, /role="radiogroup"/);
  if (fault.widget === 'message') assert.match(safeHtml, /GOOD_MESSAGE_AFTER_BAD_WIDGET/);
}
const boundary = new SceneWidgetErrorBoundary({ widget: 'form', label: '场景表单', children: React.createElement('div', null, 'Recovered'),
  onFocusConversation() { events.push('focus-only'); } });
boundary.state = SceneWidgetErrorBoundary.getDerivedStateFromError(new Error('secret must not be shown'));
const fallback = boundary.render();
const fallbackMarkup = renderToStaticMarkup(React.createElement(React.Fragment, null, fallback));
assert.match(fallbackMarkup, /role="alert"/); assert.doesNotMatch(fallbackMarkup, /secret must not be shown/);
const actions = collect(fallback).filter(node => node.type === 'button');
assert.equal(actions[0].props.type, 'button');
boundary.setState = ((next: any) => { boundary.state = { ...boundary.state, ...next }; }) as any;
actions[0].props.onClick(); assert.equal(boundary.state.failed, false); assert.equal(events.length, 0);
assert.match(renderToStaticMarkup(React.createElement(React.Fragment, null, boundary.render())), /Recovered/);
actions[1].props.onClick(); assert.deepEqual(events, ['focus-only']);
console.log('Scene widget reliability passed: real composite SSR, fail-closed shared input facts, persistent form drafts and keys, IME-safe independent conversation, local containment topology, accessible display-only recovery. Synthetic offline checks; not browser E2E.');
