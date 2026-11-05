import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import * as runtime from '../src/services/scene/sceneRuntime';
import { getPendingSceneInteraction } from '../src/services/scene/scenePendingTask';
import * as signals from '../src/services/scene/sceneSignal';
import { gradeSceneObjectiveResponse } from '../src/services/scene/sceneAssessment';
import { isScenePromptModuleEnabled, resolveSceneRuntimeContract } from '../src/services/scene/sceneRuntimeContract';
import { formatQuestionSetGradeFeedback } from '../src/services/scene/sceneInteraction';
import { formatSceneInteractionResponseContent as formatRealInteractionResponse } from '../src/services/scene/sceneInteraction';
import { normalizeSceneInteractionResponseV2 as normalizeRealInteractionResponse } from '../src/services/scene/sceneInteractionV2Adapter';
import { generateGeneralTurn as generateRealGeneralTurn } from '../src/services/scene/sceneDirector';
import { bindSceneProjectMaterials, getSceneProjectMaterials } from '../src/services/scene/sceneKnowledgePoints';
import { SceneClarificationRequired } from '../src/services/scene/sceneUnderstanding';
import { SceneBuildInterruptedError } from '../src/services/scene/sceneGenerator';
import { renderFinalSceneAnswerFeedback } from '../src/services/scene/sceneTeaching';
import { sceneInputForm, readSceneFormSubmission, formatSceneFormSubmission } from '../src/services/scene/sceneInputForm';
import { normalizeScenePresentation } from '../src/services/scene/scenePresentation';
import { resolveSceneInputAvailability } from '../src/services/scene/sceneInputAvailability';
import { understandingFixture } from './scene-semantic-fixture';

globalThis.fetch = async () => assert.fail('Runtime UI checks must not call network/model/storage');
const sourcePath = 'src/components/SceneMode.tsx';
const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
const body = source.statements.filter(node => !ts.isImportDeclaration(node) && !ts.isExportDeclaration(node))
  .map(node => node.getText(source)).join('\n').replace(/^export\s+/gm, '');
const compiled = ts.transpileModule(`${body}\nreturn SceneMode`, {compilerOptions: {
  target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.None,
}}).outputText;
const deferred = () => { let resolve!: (value: any) => void, reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject}; };
const flush = async () => {for (let i = 0; i < 12; i++) await Promise.resolve();};
const base: any = {sceneId: 'synthetic-scene', meta: {name: '用户调整后的场景', sceneSkill: 'S1', knowledgePoints: []},
  role: {name: '老师', attributes: []}, situation: '合成情境', task: '合成任务', resources: [], rules: [], metrics: [],
  completion: {mode: 'signal', maxTurns: 8}, events: [], evaluationDimensions: [], origin: 'new',
  engineConfig: {paradigm: 'single-role-dialogue'}, eventInjection: false};
type Tree = {type: any; props: any};
const React = {createElement: (type: any, props: any, ...children: any[]): Tree => ({type, props: {...props, children}})};
const all = (value: any): Tree[] => !value || typeof value !== 'object' ? [] : Array.isArray(value) ? value.flatMap(all) : [value, ...all(value.props?.children)];
function harness(initialDraft: any = base, initialRequest: any = {source: 'custom', subject: '合成任务', knowledgePoints: [], sceneSkill: 'S1'},
  initialNotes: any[] = [], initialDesign?: (input: any) => Promise<any>) {
  const slots: any[] = []; let cursor = 0, live = true, afterUnmount = 0;
  const pendingEffects: any[] = [], cleanups: any[] = [];
  let save: (draft: any) => Promise<any> = async draft => draft;
  let compute: (draft: any) => Promise<any> = async draft => ({...draft, compute: {given_nodes: []}});
  let reply: () => Promise<any> = async () => ({content: '老师的合成回应'});
  let manifest: () => Promise<any> = async () => ({scenes: []});
  let experimentSnapshot: (run: any) => any[] = () => [];
  const saved: any[] = [], computeCalls: any[] = [], computeSignals: AbortSignal[] = [], turns: any[] = [], manifests: any[] = [], sceneAgentCalls: any[] = [], metricCalls: any[] = [], generated: any[] = [], closedExperiments: string[] = [], completed: any[] = [];
  const onRunComplete = (value: any) => completed.push(value);
  const hooks = {
    useState(initial: any) {const i = cursor++; if (!(i in slots)) slots[i] = {value: typeof initial === 'function' ? initial() : initial};
      return [slots[i].value, (next: any) => {if (!live) afterUnmount++; slots[i].value = typeof next === 'function' ? next(slots[i].value) : next;}];},
    useRef(initial: any) {const i = cursor++; return slots[i] ||= {current: initial};},
    useEffect(effect: any, deps: any[]) {const i = cursor++; if (!slots[i] || deps.some((dep,j)=>dep!==slots[i].deps[j])) {
      slots[i] = {deps}; pendingEffects.push(() => {if (cleanups[i]) cleanups[i](); cleanups[i] = effect();});}},
  };
  const environment: any = {React, ...hooks, useLayoutEffect: hooks.useEffect, ...runtime, ...signals,
    getPendingSceneInteraction, gradeSceneObjectiveResponse, isScenePromptModuleEnabled, resolveSceneRuntimeContract, formatQuestionSetGradeFeedback,
    bindSceneProjectMaterials, getSceneProjectMaterials, SceneClarificationRequired, SceneBuildInterruptedError, renderFinalSceneAnswerFeedback,
    sceneInputForm, readSceneFormSubmission, formatSceneFormSubmission, normalizeScenePresentation, resolveSceneInputAvailability,
    closeSceneExperimentSession: (run: any) => closedExperiments.push(run.runId),
    sceneExperimentRecords: (run: any) => experimentSnapshot(run),
    Loader2: 'loader', ArrowLeft: 'arrow', SceneSpecPreview: 'preview', SceneChatView: 'chat', SceneDerivationView: 'canvas', SceneRerunPanel: 'rerun', ScenePageErrorBoundary: 'boundary',
    generateSceneId: () => 'synthetic-new', saveScene: () => assert.fail('unexpected direct write'),
    preflightSceneSpec: (spec: any) => ({valid: true, diagnostics: [], recipeId: spec.capabilityRecipeId || 'socratic-dialogue', enabledCapabilities: spec.capabilityIds || []}),
    recordSceneAssemblyAudit: async () => {}, recordSceneInteractionAudit: async () => {},
    loadManifest: async (opts: any) => {manifests.push(opts); return manifest();}, loadScene: async () => base,
    runSceneMultiAgent: async (input: any) => {
      sceneAgentCalls.push(input);
      if (initialDesign) return initialDesign(input);
      return {recommendation: {
        valid: true, sceneSkill: 'S1', recipeId: 'guided-practice',
        requestedCapabilities: ['text'],
        requestedPromptModules: ['turn-agent-planning', 'resource-grounding'],
        learningObjective: '合成学习目标', interactionPlan: '根据用户输入选择互动', constraints: [],
      }};
    },
    decideScene: async () => ({decision: 'generate'}), generateScene: async (options: any) => {generated.push(options); return base;}, adaptScene: async () => base,
    generateS4ComputeConfig: async ({spec, signal}: any) => {computeCalls.push(spec); computeSignals.push(signal); return compute(spec);},
    saveGeneratedScene: async (draft: any) => {saved.push(draft); return save(draft);},
    resolveSceneParadigm: () => 'general',
    generateGeneralTurn: async (spec: any, run: any, options: any) => {turns.push({spec, run, options}); return reply();},
    streamRoleReply: () => assert.fail('unexpected transport'),
    updateMetrics: async (spec: any, run: any) => {metricCalls.push(spec); return {metrics: run.metrics, deltas: [], triggeredEvents: []};},
    resolveSceneRuntimeInteractionProtocol: () => ({allowedTypes: ['text']}),
    normalizeSceneInteractionResponseV2: (response: any, directive: any) => response?.type === 'text' ? normalizeRealInteractionResponse(response, directive) : response,
    formatSceneInteractionResponseContent: (response: any, directive: any) => response?.type === 'text' ? formatRealInteractionResponse(response, directive) : '整卷作答',
    makeActionMessages: () => [], makeEndMessage: (content: string) => ({id: 'end', speakerType: 'system', content}),
    fireEvent: (event: any) => ({id: event.id, speakerType: 'event', content: event.description}), makeManualEvent: () => ({}),
    applyOverrides: (spec: any) => spec, diffMetrics: () => [], applyS4Completion: (_: any, run: any) => ({...run, status: 'success'}),
  };
  const Component = new Function(...Object.keys(environment), compiled)(...Object.values(environment));
  let nodes: Tree[] = [];
  const render = () => {cursor = 0; nodes = all(Component({allNotes: initialNotes, initialRequest, initialDraft, onExit: () => {}, onRunComplete})); pendingEffects.splice(0).forEach(effect=>effect());};
  const view = (type: string) => {const found = nodes.find(node=>node.type===type); assert.ok(found, `${type} available`); return found.props;};
  render(); render();
  return {render, view, saved, computeCalls, computeSignals, turns, manifests, sceneAgentCalls, metricCalls, generated, closedExperiments, completed,
    setSave(value: typeof save) {save = value;}, setCompute(value: typeof compute) {compute = value;}, setReply(value: typeof reply) {reply = value;}, setManifest(value: typeof manifest) {manifest = value;},
    setExperimentSnapshot(value: typeof experimentSnapshot) {experimentSnapshot = value;},
    get afterUnmount() {return afterUnmount;}, unmount() {live = false; cleanups.forEach(cleanup=>cleanup?.());}};
}

const ui = harness(); const gate = deferred(); ui.setSave(() => gate.promise);
const consentUI = harness({ ...base, promptModuleIds: ['model-experiment'], experimentPolicy: { criteria: ['检查输出'], maxExperiments: 1, maxOutputTokens: 512, temperature: .2 } });
consentUI.view('preview').onStart(); await flush(); consentUI.render();
assert.equal(consentUI.saved.length, 0, 'paid experiment needs actual UI consent, not just model-selected modules');
consentUI.view('preview').onStart(true); await flush(); consentUI.render();
assert.equal(consentUI.saved.length, 1); assert.equal(consentUI.view('chat').run.experimentApproved, true);
const receiptUI = harness({ ...base, promptModuleIds: ['model-experiment'], experimentPolicy: { criteria: ['检查输出'], maxExperiments: 1, maxOutputTokens: 512, temperature: .2 } });
receiptUI.setReply(async () => { const call = receiptUI.turns.at(-1); call!.options.onExperiments([{ id: 'real-receipt', output: '实际返回' }]); throw new Error('最终回应失败'); });
receiptUI.view('preview').onStart(true); await flush(); receiptUI.render();
assert.equal(receiptUI.view('chat').run.experimentRecords[0].id, 'real-receipt', 'actual receipts survive a later conversational failure');
assert.equal(receiptUI.closedExperiments.length, 0, 'recoverable turn failure must retain its budget and retry cache');
const receiptRunId = receiptUI.view('chat').run.runId;
receiptUI.unmount();
assert.deepEqual(receiptUI.closedExperiments, [receiptRunId], 'unmount releases the current run, not the initial null run');

// The production start handler normalizes historical structured presentation
// values, and an explicit render-error return cancels only the current request.
// This hook/AST harness does not claim that React's browser boundary was mounted.
const structuredTask = {description: 'Submit a synthetic prompt', steps: ['Keep this complete task', 'Then discuss the output']};
const presentationUI = harness({...base, task: structuredTask});
assert.equal(presentationUI.view('preview').spec.task, JSON.stringify(structuredTask, null, 2));
assert.equal(presentationUI.view('boundary').section, 'preview');
presentationUI.view('preview').onStart(); await flush(); presentationUI.render();
assert.equal(presentationUI.saved[0].task, JSON.stringify(structuredTask, null, 2));
assert.equal(presentationUI.view('chat').spec.task, JSON.stringify(structuredTask, null, 2));
assert.equal(presentationUI.view('boundary').section, 'running');

const renderReturnUI = harness({...base, promptModuleIds: ['model-experiment'],
  experimentPolicy: {criteria: ['Synthetic only'], maxExperiments: 2, maxOutputTokens: 512, temperature: .2}});
const openingReceipt = {id: 'opening-receipt', output: 'Already committed synthetic output'};
renderReturnUI.setReply(async () => {
  renderReturnUI.turns.at(-1)!.options.onExperiments([openingReceipt]);
  return {content: 'Synthetic opening with an already-committed result'};
});
renderReturnUI.view('preview').onStart(true); await flush(); renderReturnUI.render();
const returnRunId = renderReturnUI.view('chat').run.runId;
assert.equal(renderReturnUI.view('chat').run.experimentRecords[0].id, openingReceipt.id);
const renderReturnGate = deferred();
renderReturnUI.setReply(() => renderReturnGate.promise);
renderReturnUI.view('chat').onSend('Keep my submitted prompt and results even if the display fails');
renderReturnUI.render();
const returnCall = renderReturnUI.turns.at(-1)!;
const submittedBeforeReturn = renderReturnUI.view('chat').run.messages.findLast((message: any) => message.speakerType === 'user');
const completedReceipt = {id: 'finished-before-host-response', output: 'Synthetic result completed while host response is pending'};
returnCall.options.onExperiments([openingReceipt, completedReceipt]);
// No render here: the fallback callback still closes over the pre-receipt run.
// Returning must read the latest queued run rather than overwrite it with that stale closure.
const incompleteReceipt = {id: 'target-finished-judge-pending', output: 'Complete synthetic target output still awaiting independent review',
  status: 'failed', evaluation: [], error: 'Independent judge has not completed yet'};
const latestCompletedReceipt = {...completedReceipt, output: 'Latest executor snapshot of the completed result'};
let executorSnapshotsRead = 0;
renderReturnUI.setExperimentSnapshot(run => {
  executorSnapshotsRead++;
  assert.equal(run.runId, returnRunId);
  assert.equal(returnCall.options.signal.aborted, false, 'snapshot is read before abort/session cleanup can discard the executor ledger');
  return [openingReceipt, latestCompletedReceipt, incompleteReceipt];
});
const callsBeforeReturn = renderReturnUI.turns.length, savesBeforeReturn = renderReturnUI.saved.length;
renderReturnUI.view('boundary').onReturn(); renderReturnUI.render();
assert.equal(executorSnapshotsRead, 1);
assert.equal(returnCall.options.signal.aborted, true, 'explicit fallback return aborts the in-flight Agent call');
assert.equal(renderReturnUI.view('boundary').section, 'preview');
assert.equal(renderReturnUI.view('preview').busy, false);
assert.equal(renderReturnUI.turns.length, callsBeforeReturn, 'return-to-preview does not replay any model or experiment');
assert.equal(renderReturnUI.saved.length, savesBeforeReturn, 'return-to-preview does not write a new scene');
assert.equal(renderReturnUI.completed.length, 1);
const returnedRun = renderReturnUI.completed[0].run;
assert.equal(returnedRun.runId, returnRunId); assert.equal(returnedRun.status, 'success');
assert.equal(returnedRun.completionOutcome, 'stopped');
assert.equal(returnedRun.turnCount, 1);
assert.deepEqual(returnedRun.messages.filter((message: any) => message.speakerType === 'user'), [submittedBeforeReturn],
  'explicit return retains the already-submitted user turn exactly once');
assert.equal(returnedRun.messages.some((message: any) => message.isStreaming), false, 'abandoned streaming placeholders are removed');
assert.deepEqual(returnedRun.experimentRecords.map((record: any) => record.id), [openingReceipt.id, completedReceipt.id, incompleteReceipt.id],
  'completed and callback-not-yet-delivered paid receipts survive even when the independent judge or final response never arrives');
assert.deepEqual(returnedRun.experimentRecords.find((record: any) => record.id === completedReceipt.id), latestCompletedReceipt,
  'executor snapshot wins over an older callback record with the same id');
assert.deepEqual(returnedRun.experimentRecords.find((record: any) => record.id === incompleteReceipt.id), incompleteReceipt,
  'unreviewed target output remains incomplete rather than being silently dropped or claimed successful');
const returnedSnapshot = JSON.stringify(returnedRun);
returnCall.options.onExperiments([{id: 'late-cancelled-receipt', output: 'must not be committed'}]);
renderReturnGate.resolve({content: 'Late response must never replace the recovered preview'});
await flush(); renderReturnUI.render();
assert.equal(renderReturnUI.view('boundary').section, 'preview');
assert.equal(renderReturnUI.completed.length, 1);
assert.equal(JSON.stringify(renderReturnUI.completed[0].run), returnedSnapshot, 'late response/receipts cannot mutate the closed run');
renderReturnUI.setReply(async () => ({content: 'A deliberately started fresh run'}));
renderReturnUI.view('preview').onStart(true); await flush(); renderReturnUI.render();
assert.notEqual(renderReturnUI.view('chat').run.runId, returnRunId);
assert.equal(renderReturnUI.view('chat').run.turnCount, 0);
assert.deepEqual(renderReturnUI.view('chat').run.experimentRecords, [], 'starting again is an explicit fresh run, not a receipt replay');
const start = ui.view('preview').onStart; start(); start(); ui.render();
const dynamicForm = { id: 'case-form', title: 'Case input', fields: [
  { id: 'case', label: 'Case', kind: 'textarea', required: true, purpose: 'context', maxLength: 2000 }
] };
const formUI = harness({ ...base, capabilityRecipeId: 'agent-designed', promptModuleIds: ['turn-agent-planning', 'input-form'],
  inputForm: dynamicForm, behavior: { recipeId: 'agent-designed', kind: 'case', aiBehavior: 'Discuss case', userAction: 'Submit case',
    evaluationRule: 'No score', progressionRule: 'Follow user', interaction: { version: '1.0', allowedTypes: ['text'], defaultType: 'text', allowTextFallback: true } } });
formUI.view('preview').onStart(); await flush(); formUI.render();
formUI.view('chat').onSend('', undefined, { formId: 'wrong', values: { case: 'invalid' } }); await flush(); formUI.render();
assert.equal(formUI.view('chat').run.turnCount, 0, 'invalid form submissions cannot dispatch a turn');
const exactFormText = '  original case\nwith trailing spaces  ';
const formSender = formUI.view('chat').onSend;
const formValue = { formId: 'case-form', values: { case: exactFormText } };
formSender('', undefined, formValue); formSender('', undefined, formValue); await flush(); formUI.render();
assert.equal(formUI.view('chat').run.turnCount, 1, 'same-frame form submissions share the runtime lock');
assert.equal(formUI.view('chat').run.messages.findLast((message: any) => message.speakerType === 'user').formSubmission.values.case, exactFormText);
assert.equal(formUI.turns.length, 2, 'only opening plus one form turn execute');
assert.equal(formUI.view('chat').run.experimentApproved, false, 'a generic form cannot approve paid model experiments');
// A registered form and an unanswered objective task can coexist, but the form must not bypass that task.
const handoffUI = harness({ ...base, capabilityRecipeId: 'agent-designed', capabilityIds: ['text', 'single-choice'],
  promptModuleIds: ['turn-agent-planning', 'structured-interaction', 'input-form'], inputForm: dynamicForm,
  behavior: { recipeId: 'agent-designed', kind: 'case', aiBehavior: 'Use authorized inputs', userAction: 'Answer or discuss',
    evaluationRule: 'Local answer key', progressionRule: 'User-directed handoff',
    interaction: { version: '1.0', allowedTypes: ['text', 'single-choice'], defaultType: 'single-choice', allowTextFallback: true } } });
const handoffQuestion = {id: 'before-form', type: 'single-choice', assessment: 'objective', required: true,
  options: [{id: 'a', label: 'A'}, {id: 'b', label: 'B'}]};
handoffUI.setReply(async () => ({content: 'Synthetic pending question', interaction: handoffQuestion,
  objectiveEvaluation: {interactionId: handoffQuestion.id, type: 'single-choice', correctId: 'a', explanation: 'Synthetic key'}}));
handoffUI.view('preview').onStart(); await flush(); handoffUI.render();
assert.equal(resolveSceneInputAvailability(handoffUI.view('chat').spec, handoffUI.view('chat').run).formAvailable, false);
const beforeBlockedForm = JSON.stringify(handoffUI.view('chat').run);
handoffUI.view('chat').onSend('', undefined, formValue); await flush(); handoffUI.render();
assert.equal(handoffUI.turns.length, 1, 'a blocked form cannot dispatch a paid/model turn');
assert.equal(JSON.stringify(handoffUI.view('chat').run), beforeBlockedForm, 'a blocked form cannot consume a round or alter the original task');
handoffUI.setReply(async () => {
  const source = handoffUI.turns.at(-1)!.run.messages.findLast((message: any) => message.speakerType === 'user');
  return {content: 'Synthetic confirmation of the user-requested cancellation', taskUpdate: {
    operation: 'cancel', interactionId: handoffQuestion.id, sourceUserMessageId: source.id, reason: 'User explicitly requested form handoff'}};
});
handoffUI.view('chat').onSend('取消当前题，切换到已授权表单。', undefined, undefined, 'conversation');
await flush(); handoffUI.render();
assert.equal(handoffUI.view('chat').run.turnCount, 0, 'a handoff request is conversation, not an answer');
assert.equal(resolveSceneInputAvailability(handoffUI.view('chat').spec, handoffUI.view('chat').run).formAvailable, true);
assert.equal(getPendingSceneInteraction(handoffUI.view('chat').run), undefined);
assert.ok(handoffUI.view('chat').run.messages.some((message: any) => message.interaction?.id === handoffQuestion.id), 'retired task remains in the audit/history');
handoffUI.setReply(async () => ({content: 'Synthetic response to the exact submitted form'}));
handoffUI.view('chat').onSend('', undefined, formValue); await flush(); handoffUI.render();
assert.equal(handoffUI.turns.length, 3, 'only opening, explicit handoff and authorized form submission execute');
assert.equal(handoffUI.view('chat').run.turnCount, 1);
assert.equal(handoffUI.view('chat').run.messages.at(-2).formSubmission.values.case, exactFormText);
assert.equal(ui.saved.length, 1, 'synchronous lock prevents same-frame duplicate starts');
assert.equal(ui.view('preview').busy, true, 'editing and start controls disabled during persistence');
gate.reject(new Error('合成磁盘保存失败')); await flush(); ui.render();
assert.match(ui.view('preview').startError, /保存失败/); assert.equal(ui.view('preview').spec.meta.name, base.meta.name);
assert.equal(ui.turns.length, 0, 'failed persistence never starts model/runtime');
ui.setSave(async draft=>draft); ui.view('preview').onStart(); await flush(); ui.render();
assert.equal(ui.view('chat').run.messages.filter((m:any)=>m.speakerType==='role').length, 1);
assert.equal(ui.turns.length, 1);
const failure = deferred(); ui.setReply(()=>failure.promise);
const send = ui.view('chat').onSend; send('已经提交的答案'); send('同帧重复'); ui.render();
assert.equal(ui.view('chat').sending, true); failure.reject(new Error('合成回合失败')); await flush(); ui.render();
assert.equal(ui.view('chat').run.turnCount, 1);
assert.equal(ui.view('chat').run.messages.filter((m:any)=>m.speakerType==='user').length, 1);
assert.match(ui.view('chat').turnError, /回合失败/);
ui.setReply(async()=>({content: '恢复后的回应', workingMemory: {focus: '本轮已恢复', pendingQuestions: [], resolvedQuestions: [], observations: [], userStatements: [], lastStrategy: '回应', updatedAtTurn: 1}})); ui.view('chat').onRetryTurn(); await flush(); ui.render();
assert.equal(ui.view('chat').run.turnCount, 1, 'reply retry cannot create a second submitted answer');
assert.equal(ui.view('chat').run.messages.filter((m:any)=>m.speakerType==='user').length, 1);
assert.equal(ui.view('chat').turnError, '');
assert.equal(ui.view('chat').run.workingMemory.focus, '本轮已恢复', 'work memory commits together with a successful reply');

const reviseUI = harness(base);
reviseUI.view('preview').onStart(); await flush(); reviseUI.render();
reviseUI.setReply(async () => { throw new Error('Synthetic context limit'); });
reviseUI.view('chat').onSend('original oversized request'); await flush(); reviseUI.render();
const originalSubmission = reviseUI.view('chat').run.messages.findLast((message: any) => message.speakerType === 'user');
const callsBeforeRevision = reviseUI.turns.length;
reviseUI.view('chat').onReviseTurn(); reviseUI.render();
assert.equal(reviseUI.view('chat').turnError, '');
assert.equal(reviseUI.turns.length, callsBeforeRevision, 'releasing recovery never executes a model or paid trial');
assert.equal(reviseUI.view('chat').run.messages.find((message: any) => message.id === originalSubmission.id).content, originalSubmission.content);
reviseUI.setReply(async () => ({ content: 'Recovered with the revised input' }));
reviseUI.view('chat').onSend('shorter correction'); await flush(); reviseUI.render();
assert.equal(reviseUI.view('chat').run.turnCount, 2, 'a deliberate correction is a new user turn, not a duplicated retry');
assert.equal(reviseUI.view('chat').run.messages.filter((message: any) => message.speakerType === 'user').length, 2);
assert.equal(reviseUI.view('chat').run.messages.findLast((message: any) => message.speakerType === 'user').content, 'shorter correction');

const strictBehavior = {recipeId: 'guided-practice', kind: '练习', aiBehavior: '出题', userAction: '选择',
  evaluationRule: '核对答案', progressionRule: '按需下一题', interaction: {
    version: '1.0', allowedTypes: ['single-choice'], defaultType: 'single-choice', allowTextFallback: false,
  }};
const strict = harness({...base, capabilityRecipeId: 'guided-practice', promptModuleIds: ['turn-agent-planning', 'structured-interaction'],
  behavior: strictBehavior, eventInjection: true});
const strictQuestion = {id: 'q1', type: 'single-choice', required: true, options: [{id: 'a', label: 'A'}, {id: 'b', label: 'B'}]};
strict.setReply(async()=>({content: '请选择', interaction: strictQuestion, objectiveEvaluation: {interactionId: 'q1', type: 'single-choice', correctId: 'a', explanation: 'Synthetic correct answer'}}));
strict.view('preview').onStart(); await flush(); strict.render();
assert.equal(typeof strict.view('chat').onReviseTurn, 'function', 'strict answer types do not forbid recovery through conversation');
assert.equal(strict.metricCalls.length, 0, 'disabled metric module cannot run an extra evaluator');
strict.view('chat').onSend('用文本绕过单选'); await flush(); strict.render();
strict.view('chat').onSend('', undefined, formValue); await flush(); strict.render();
assert.equal(strict.view('chat').run.turnCount, 0, 'strict scene rejects raw text at dispatch, not only in visible UI');
strict.view('chat').onSend('', {interactionId: 'q1', type: 'multiple-choice', selectedIds: ['a'], submittedAt: ''});
await flush(); strict.render(); assert.equal(strict.view('chat').run.turnCount, 0, 'unauthorized response type is rejected');
strict.view('chat').onInjectEvent('没有授权的事件'); strict.render();
assert.equal(strict.view('chat').run.messages.some((m:any)=>m.speakerType==='event'), false);
strict.setReply(async () => ({ content: '先看题干条件，下一题再提高难度。' }));
strict.view('chat').onSend('请给提示，下一题更难', undefined, undefined, 'conversation');
await flush(); strict.render();
const discussion = strict.view('chat').run.messages.findLast((message: any) => message.speakerType === 'user');
assert.ok(discussion, JSON.stringify({ run: strict.view('chat').run, error: strict.view('chat').turnError, contract: resolveSceneRuntimeContract(strict.view('chat').spec) }));
assert.equal(discussion.inputKind, 'conversation');
assert.equal(discussion.interactionResponse, undefined); assert.equal(discussion.objectiveAssessment, undefined);
assert.equal(strict.view('chat').run.turnCount, 0, 'conversation consumes no answer round');
assert.equal(getPendingSceneInteraction(strict.view('chat').run)?.interaction?.id, 'q1', 'original task survives a plain text hint');
const beforeMixed = strict.turns.length;
strict.view('chat').onSend('mixed payload', {interactionId: 'q1', type: 'single-choice', selectedId: 'a', submittedAt: ''}, undefined, 'conversation');
await flush(); strict.render(); assert.equal(strict.turns.length, beforeMixed, 'conversation cannot smuggle an answer');
strict.view('chat').onSend('', {interactionId: 'q1', type: 'single-choice', selectedId: 'a', submittedAt: ''});
await flush(); strict.render(); assert.equal(strict.view('chat').run.turnCount, 1, 'authorized structured answer still advances');
assert.equal(strict.view('chat').run.messages.findLast((message: any) => message.interactionResponse)?.objectiveAssessment?.correct, true,
  'only the submitted answer invokes local per-task grading');

// Text answers and free teaching instructions traverse distinct production
// SceneMode handlers. The policy response below uses the real core service with
// synthetic understanding/respond results, not a model, storage or network call.
const textBehavior = {recipeId:'agent-designed',kind:'文本讲解练习',aiBehavior:'按用户需要讲解',userAction:'作答或交流',
 evaluationRule:'不默认评分',progressionRule:'由Agent自主组织',interaction:{version:'1.0',allowedTypes:['text'],defaultType:'text',allowTextFallback:true}};
const textSpec = {...base,capabilityRecipeId:'agent-designed',capabilityIds:['text'],behavior:textBehavior,
 promptModuleIds:['structured-interaction','turn-agent-planning'],runtimeContract:{allowConversation:true,allowedTools:[],allowedInteractionTypes:['text'],
  allowTextFallback:true,scope:{noteIds:[],documentIds:[],cognitionRecordIds:[]},maxToolCallsPerTurn:0,completion:'user-controlled'}};
const textUI = harness(textSpec),textTask={id:'text-explanation-task',type:'text',required:true,placeholder:'请写下你的理解'};
textUI.setReply(async()=>({content:'请用自己的话解释百分比。',interaction:textTask}));
textUI.view('preview').onStart();await flush();textUI.render();
const textSceneSnapshot=JSON.stringify(textUI.view('chat').spec),textPolicyText='以后解释请多用生活类比和形象例子，但保留这道原题。';
const textPolicyInstruction='后续讲解多使用生活类比和形象例子；不更换当前任务，不扩大任何权限。';
const textReplyGate=deferred(),textRequests:any[]=[];let waitForPolicyReply=true;
const realTextReply=async()=>{
 const current=textUI.turns.at(-1)!;
 return generateRealGeneralTurn(current.spec,current.run,{dependencies:{callLlm:async request=>{
  textRequests.push(request);
  const latest=current.run.messages.findLast((message:any)=>message.speakerType==='user')!;
  if(request.workflow==='scene-turn-plan'){
   const payload=JSON.parse(request.userInput);assert.equal(payload.phase,'understand');
   const teaching=latest.inputKind==='conversation'&&latest.content===textPolicyText?{policyUpdates:[{
    id:'vivid-explanations',action:'set' as const,scope:'session' as const,instruction:textPolicyInstruction,
    source:{sourceMessageId:latest.id,quote:latest.content},
   }]}:undefined;
   return {content:JSON.stringify({understanding:understandingFixture(latest.id,latest.content,{intent:latest.interactionResponse?'answer':'change-direction',
    ...(teaching?{teaching}:{})}),action:'respond'})};
  }
  assert.equal(request.workflow,'scene-general-turn');
  if(waitForPolicyReply)return textReplyGate.promise;
  return {content:JSON.stringify({content:'已收到你的解释，我们可以继续用生活例子讨论。'})};
 }}});
};
const settleText=async()=>{for(let index=0;index<24;index++){await flush();textUI.render();if(!textUI.view('chat').sending)return;}
 assert.fail('synthetic text core turn did not settle');};
textUI.setReply(realTextReply);
const textSend=textUI.view('chat').onSend;
textSend(textPolicyText,undefined,undefined,'conversation');
textSend(textPolicyText,undefined,undefined,'conversation');
textUI.render();assert.equal(textUI.view('chat').sending,true);
const duringPolicy=textUI.view('chat').run;
assert.equal(duringPolicy.turnCount,0);assert.equal(duringPolicy.messages.filter((message:any)=>message.speakerType==='user').length,1);
const textDiscussion=duringPolicy.messages.findLast((message:any)=>message.speakerType==='user');
assert.equal(textDiscussion.inputKind,'conversation');assert.equal(textDiscussion.interactionResponse,undefined);
assert.equal(textDiscussion.formSubmission,undefined);assert.equal(textDiscussion.objectiveAssessment,undefined);
assert.equal(getPendingSceneInteraction(duringPolicy)?.interaction?.id,textTask.id);
textUI.view('chat').onSend('不能在等待时提交', {interactionId:textTask.id,type:'text',value:'等待中答案',submittedAt:''});
assert.equal(textUI.turns.length,2,'same-frame discussion and busy answer share the synchronous runtime lock');
textReplyGate.resolve({content:JSON.stringify({content:'已记住，之后用生活例子解释，原题保留。'})});waitForPolicyReply=false;
await settleText();
const policyRun=textUI.view('chat').run;
assert.equal(policyRun.turnCount,0);assert.equal(getPendingSceneInteraction(policyRun)?.interaction?.id,textTask.id);
assert.equal(policyRun.teachingState.activeInstructions[0].instruction,textPolicyInstruction);
assert.deepEqual(policyRun.teachingState.activeInstructions[0].rules,[],'free explanation style is not limited to responseStyle enum values');
assert.equal(policyRun.teachingState.activeInstructions[0].scope,'session');
assert.equal(policyRun.teachingState.activeInstructions[0].source.sourceMessageId,textDiscussion.id);
assert.equal(policyRun.teachingState.activeInstructions[0].source.quote,textPolicyText);
assert.ok(textRequests.find(request=>request.workflow==='scene-general-turn').userInput.includes(textPolicyInstruction));
assert.equal(JSON.stringify(textUI.view('chat').spec),textSceneSnapshot,'conversation cannot change tools, materials, controls or scene configuration');

// Recovery keeps both the original task and already-accepted policy; a failed
// response cannot turn a discussion into an answer or bypass its retry gate.
textUI.setReply(async()=>{throw new Error('Synthetic text discussion failure');});
textUI.view('chat').onSend('我还想补充一句，先不作答。',undefined,undefined,'conversation');await flush();textUI.render();
assert.match(textUI.view('chat').turnError,/discussion failure/);assert.equal(textUI.view('chat').run.turnCount,0);
const textCallsBeforeRecovery=textUI.turns.length;
textUI.view('chat').onSend('错误未处理时不得继续',undefined,undefined,'conversation');await flush();textUI.render();
assert.equal(textUI.turns.length,textCallsBeforeRecovery);
textUI.view('chat').onReviseTurn();textUI.render();assert.equal(textUI.view('chat').turnError,'');
assert.equal(getPendingSceneInteraction(textUI.view('chat').run)?.interaction?.id,textTask.id);
textUI.setReply(realTextReply);
const savedTextDraft='我的答案草稿：百分比表示每一百份中的份数。',textResponse={interactionId:textTask.id,type:'text',value:savedTextDraft,submittedAt:'2026-10-16T00:00:00.000Z'};
const answerTextSend=textUI.view('chat').onSend;answerTextSend(savedTextDraft,textResponse);answerTextSend(savedTextDraft,textResponse);
await settleText();
assert.equal(textUI.view('chat').run.turnCount,1);
const actualTextAnswers=textUI.view('chat').run.messages.filter((message:any)=>message.interactionResponse);
assert.equal(actualTextAnswers.length,1);assert.equal(actualTextAnswers[0].interactionResponse.value,savedTextDraft);
assert.equal(actualTextAnswers[0].content,savedTextDraft);assert.notEqual(actualTextAnswers[0].inputKind,'conversation');
assert.equal(getPendingSceneInteraction(textUI.view('chat').run),undefined);
assert.equal(textUI.view('chat').run.teachingState.activeInstructions[0].instruction,textPolicyInstruction);
assert.equal(textUI.metricCalls.length,0);
textUI.setReply(async()=>({content:'停止并总结本局。',userRequestedEnd:true}));
await textUI.view('chat').onEnd();await flush();textUI.render();
assert.equal(textUI.view('chat').run.completionOutcome,'stopped');
const endedTextCalls=textUI.turns.length;
textUI.view('chat').onSend('结束后不能借交流续聊',undefined,undefined,'conversation');await flush();textUI.render();
assert.equal(textUI.turns.length,endedTextCalls);
const deniedText=harness({...textSpec,runtimeContract:{...textSpec.runtimeContract,allowConversation:false}});
deniedText.setReply(async()=>({content:'请作答文本任务。',interaction:textTask}));deniedText.view('preview').onStart();await flush();deniedText.render();
deniedText.view('chat').onSend(textPolicyText,undefined,undefined,'conversation');await flush();deniedText.render();
assert.equal(deniedText.turns.length,1);assert.equal(getPendingSceneInteraction(deniedText.view('chat').run)?.interaction?.id,textTask.id);

const lifecycle = harness({...base, capabilityRecipeId: 'guided-practice', behavior: strictBehavior,
  promptModuleIds: ['turn-agent-planning', 'structured-interaction', 'metric-state']});
lifecycle.setReply(async () => ({ content: 'Original task', interaction: strictQuestion }));
lifecycle.view('preview').onStart(); await flush(); lifecycle.render();
const metricCallsBeforeDiscussion = lifecycle.metricCalls.length;
const harderQuestion = { ...strictQuestion, id: 'q2' };
lifecycle.setReply(async () => ({ content: 'Replacement task', interaction: harderQuestion,
  taskUpdate: { operation: 'replace', interactionId: 'q1', sourceUserMessageId: 'upstream-validated', reason: 'Synthetic validated replacement' } }));
lifecycle.view('chat').onSend('换掉当前题', undefined, undefined, 'conversation'); await flush(); lifecycle.render();
assert.deepEqual(lifecycle.view('chat').run.retiredInteractionIds, ['q1']);
assert.equal(getPendingSceneInteraction(lifecycle.view('chat').run)?.interaction?.id, 'q2');
assert.equal(lifecycle.view('chat').run.turnCount, 0);
assert.equal(lifecycle.metricCalls.length, metricCallsBeforeDiscussion, 'discussion cannot invoke the learning evaluator');
lifecycle.setReply(async () => ({ content: 'Cancelled', taskUpdate: { operation: 'cancel', interactionId: 'q2', sourceUserMessageId: 'upstream-validated', reason: 'Synthetic validated cancellation' } }));
lifecycle.view('chat').onSend('取消当前题，解释概念', undefined, undefined, 'conversation'); await flush(); lifecycle.render();
assert.deepEqual(lifecycle.view('chat').run.retiredInteractionIds, ['q1', 'q2']);
assert.equal(getPendingSceneInteraction(lifecycle.view('chat').run), undefined);
lifecycle.setReply(async () => ({ content: 'Closing summary', userRequestedEnd: true }));
lifecycle.view('chat').onSend('总结并结束', undefined, undefined, 'conversation'); await flush(); lifecycle.render();
assert.equal(lifecycle.view('chat').run.completionOutcome, 'stopped');
assert.equal(lifecycle.view('chat').run.turnCount, 0);


const denied = harness({...base, capabilityRecipeId: 'guided-practice', behavior: strictBehavior,
  runtimeContract: { allowConversation: false }, promptModuleIds: ['turn-agent-planning', 'structured-interaction']});
denied.setReply(async () => ({ content: '选择', interaction: strictQuestion }));
denied.view('preview').onStart(); await flush(); denied.render();
assert.equal(denied.view('chat').onReviseTurn, undefined);
denied.view('chat').onSend('不能越过禁聊权限', undefined, undefined, 'conversation');
await flush(); denied.render(); assert.equal(denied.turns.length, 1);

const batch = harness({...base, capabilityRecipeId: 'batch-assessment', behavior: {...strictBehavior, recipeId: 'batch-assessment',
  interaction: {version: '1.0', allowedTypes: ['question-set'], defaultType: 'question-set', allowTextFallback: false}}});
const paper = {id: 'paper', type: 'question-set', required: true, submissionMode: 'batch', feedbackMode: 'after-submit',
  items: [{...strictQuestion, id: 'q1', content: '题一'}, {id: 'q2', type: 'true-false', content: '题二', required: true}]};
batch.setReply(async()=>({content: '请作答', interaction: paper, interactionEvaluation: {interactionId: 'paper', type: 'question-set',
  items: [{itemId: 'q1', type: 'single-choice', correctId: 'a'}, {itemId: 'q2', type: 'true-false', correctValue: true}]}}));
batch.view('preview').onStart(); await flush(); batch.render();
batch.setReply(async()=>({content:'整卷作答已接收，按用户需要继续讨论，不强制结束。'}));
batch.view('chat').onSend('', {interactionId: 'paper', type: 'question-set', submittedAt: '', answers: [
  {itemId: 'q1', type: 'single-choice', selectedId: 'a'}, {itemId: 'q2', type: 'true-false', value: true},
]}); await flush(); batch.render();
assert.equal(batch.turns.length, 2, 'batch submission continues through the Agent, not a fixed local ending');
assert.equal(batch.view('chat').run.status, 'running');
batch.setReply(async()=>({content:'综合分析后结束。',userRequestedEnd:true}));
await batch.view('chat').onEnd(); await flush(); batch.render();
assert.equal(batch.turns.length, 3);
assert.equal(batch.view('chat').run.completionOutcome, 'stopped');
assert.match(batch.view('chat').run.messages.find((message:any)=>message.id==='answer-feedback:'+batch.view('chat').run.runId).content, /2\s*\/\s*2/);

const s4 = harness({...base, meta: {...base.meta, sceneSkill: 'S4'}});
s4.setCompute(async()=>{throw new Error('合成配置失败');}); s4.view('preview').onStart(); await flush(); s4.render();
assert.match(s4.view('preview').startError, /配置失败/); assert.equal(s4.view('preview').spec.meta.name, base.meta.name);
s4.setCompute(async spec=>({...spec, compute: {given_nodes: [], difficulty: 1}}));
s4.setSave(async()=>{throw new Error('合成保存失败');}); s4.view('preview').onStart(); await flush(); s4.render();
assert.ok(s4.view('preview').spec.compute, 'generated compute retained after save failure');
s4.setSave(async draft=>draft); s4.view('preview').onStart(); await flush(); s4.render();
assert.equal(s4.computeCalls.length, 2, 'save retry does not regenerate already computed configuration');
assert.equal(s4.turns.length, 0, 'S4 start does not call dialogue model');

const abandoned = harness({...base, meta: {...base.meta, sceneSkill: 'S4'}}); const late = deferred();
abandoned.setCompute(()=>late.promise); abandoned.view('preview').onStart(); abandoned.unmount(); late.resolve({...base, compute: {given_nodes: []}}); await flush();
assert.equal(abandoned.computeSignals[0].aborted, true, 'leaving S4 cancels the remaining compute configuration request');
assert.equal(abandoned.saved.length, 0, 'abandoned generation cannot initiate persistence'); assert.equal(abandoned.afterUnmount, 0);
const departedTurn = harness(); const lateReply = deferred(); departedTurn.setReply(()=>lateReply.promise);
departedTurn.view('preview').onStart(); await flush(); departedTurn.unmount(); lateReply.resolve({content: '迟到回复'}); await flush();
assert.equal(departedTurn.turns[0].options.signal.aborted, true, 'leaving the scene cancels remaining agent work');
assert.equal(departedTurn.afterUnmount, 0, 'late model reply cannot update unmounted component');
const generation = harness(null, {source: 'auto', knowledgePoints: [], subject: '合成主题'}); await flush(); generation.render();
assert.equal(generation.sceneAgentCalls.length, 1, 'automatic S1 generation is assembled by the scene architect agent');
assert.equal(generation.sceneAgentCalls[0].sceneSkillConstraint, 'S1');
assert.deepEqual(generation.manifests, [{strict: true}], 'generation reads library strictly, not fallback empty');
const selectedRecipeGeneration = harness(null, {source: 'auto', subject: '自由讨论', knowledgePoints: [], recipeId: 'free-dialogue'});
await flush(); selectedRecipeGeneration.render();
assert.equal(selectedRecipeGeneration.sceneAgentCalls.length, 1, 'a preselected recipe cannot skip semantic understanding');
assert.equal(selectedRecipeGeneration.sceneAgentCalls[0].recipeConstraint, 'free-dialogue');

const projectNotes: any[] = [{id: 'social', title: '社会心理学效应', noteType: 'project', content: '', links: []},
  ...Array.from({length: 34}, (_, i) => ({id: 'social-' + i, title: '效应' + i, noteType: 'knowledge', parentId: 'social',
    content: i % 2 ? '' : '不应整体发送给模型的本地正文', links: [], tags: [], backlinks: []}))];
const projectRequest = {source: 'build', subject: '社会心理学效应', knowledgePoints: projectNotes.slice(1).map(note=>note.title),
  recipeId: 'guided-practice', requestedCapabilities: ['single-choice'], extraHints: '只要单选题，多出几道难度高的', sceneSkill: 'S1', taskBinding: {noteId: 'social'}};
const scopedGeneration = harness(null, projectRequest, projectNotes); await flush(); scopedGeneration.render();
assert.deepEqual(scopedGeneration.sceneAgentCalls[0].materialSummary, {candidateCount: 34, usableCount: 17, emptyCount: 17});
assert.equal(scopedGeneration.view('preview').spec.referenceScope.noteIds.length, 17);
assert.doesNotMatch(JSON.stringify(scopedGeneration.sceneAgentCalls[0]), /不应整体发送给模型的本地正文/);
assert.match(scopedGeneration.generated[0].extraHints, /空内容 17 个/);
const sharedBuildContext = {version: 1, userRequest: '保留这个未压缩的原始要求', conversation: [],
  explicitSelections: {capabilities: ['single-choice']}};
const inherited = harness(null, projectRequest, projectNotes, async () => ({buildContext: sharedBuildContext,
  recommendation: {valid: true, sceneSkill: 'S1', recipeId: 'guided-practice', requestedCapabilities: ['single-choice'],
    requestedPromptModules: ['turn-agent-planning', 'structured-interaction'], learningObjective: '目标', interactionPlan: '逐题单选', constraints: []}}));
await flush(); inherited.render();
assert.deepEqual(inherited.generated[0].buildContext, sharedBuildContext, 'UI transfers original brief, not just the short interaction summary');
assert.equal(inherited.generated[0].signal, inherited.sceneAgentCalls[0].signal, 'all build phases share cancellation');
inherited.generated[0].onStage('accept'); inherited.render();
assert.equal(inherited.afterUnmount, 0);

let clarificationRounds = 0;
const clarification = harness(null, {...projectRequest, source: 'auto'}, projectNotes, async () => {
  if (++clarificationRounds === 1) throw new SceneClarificationRequired('两个指定子主题相互冲突，要保留哪一个？');
  return {recommendation: {valid: true, sceneSkill: 'S1', recipeId: 'guided-practice', requestedCapabilities: ['single-choice'],
    requestedPromptModules: ['turn-agent-planning', 'structured-interaction'], learningObjective: '合成目标', interactionPlan: '逐题单选', constraints: []}};
});
await flush(); clarification.render();
assert.equal(clarification.view('form')['aria-label'], '补充场景条件');
assert.equal(clarification.generated.length, 0, 'genuine ambiguity cannot proceed to generation');
assert.ok(clarification.view('textarea')['aria-describedby']);
clarification.view('textarea').onChange({target: {value: '保留第一个子主题，仍然只出单选题'}}); clarification.render();
clarification.view('form').onSubmit({preventDefault() {}}); await flush(); clarification.render();
assert.equal(clarification.view('preview').spec.referenceScope.noteIds.length, 17);
assert.match(clarification.sceneAgentCalls[1].userRequest, /只要单选题，多出几道难度高的/);
assert.match(clarification.sceneAgentCalls[1].userRequest, /保留第一个子主题/);
assert.deepEqual(clarification.sceneAgentCalls[1].requestedCapabilities, ['single-choice']);
clarification.view('preview').onRegenerate(); await flush(); clarification.render();
assert.match(clarification.sceneAgentCalls[2].userRequest, /保留第一个子主题/, 'regeneration keeps prior clarified requirements');

const setupLate = deferred();
const leavingSetup = harness(null, {...projectRequest, source: 'auto'}, projectNotes, () => setupLate.promise);
leavingSetup.unmount();
assert.equal(leavingSetup.sceneAgentCalls[0].signal.aborted, true);
setupLate.reject(new DOMException('已取消', 'AbortError')); await flush();
assert.equal(leavingSetup.afterUnmount, 0);

const chatSource = readFileSync('src/components/scene/SceneChatView.tsx', 'utf8');
assert.match(chatSource, /hasPrevRun && finished/);
assert.match(chatSource, /message\.isStreaming\s*\|\| typeof message\.content !== 'string' \|\| message\.content\.trim\(\)/, 'empty placeholders stay hidden and malformed content reaches its own error boundary');
assert.match(chatSource, /aria-label="本轮回答"/);
assert.match(chatSource, /useDialog\(roleDrawerOpen, roleRailRef/);
assert.match(chatSource, /useState\(isNarrowRoleRail\)/, 'narrow role rail starts collapsed');
assert.match(chatSource, /aria-modal=\{roleDrawerOpen \|\| undefined\}/);
assert.match(readFileSync('src/components/scene/SceneSpecPreview.tsx', 'utf8'), /startErrorRef\.current\?\.focus/);
console.log('Scene runtime UI passed: start lock, save failure/draft retention, S4 compute retry, no duplicate answers, turn recovery, late-result protection, strict reads and terminal-only rerun. All IO/model calls are synthetic.');
await import('./check-scene-derivation-ui');
await import('./check-scene-math-editor-ui');
await import('./check-scene-curves-ui');
