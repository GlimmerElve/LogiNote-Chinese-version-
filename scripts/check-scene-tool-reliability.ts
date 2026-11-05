import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { LlmCallResponse, NoteSearchResult, SceneExperimentInput, SceneRunState, SceneRuntimeToolId, SceneSpec } from '../src/types';
import { SceneChatView } from '../src/components/scene/SceneChatView';
import { parseSceneSpec } from '../src/services/scene/sceneGenerator';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { assembleSceneTurnContext, normalizeSceneTurnPlan, prepareSceneTurnAgentContext, type SceneTurnAgentDependencies, type SceneTurnToolRequest } from '../src/services/scene/sceneTurnAgent';
import { SCENE_TOOL_EXECUTION_CONTRACTS, runSceneToolExecution, SceneToolTimeoutError } from '../src/services/scene/sceneToolExecution';
import { readSceneCognitionResults, readSceneDocumentGraph, readSceneDocumentResults, readSceneNoteResults, readSceneProfileResult, SceneToolResultError } from '../src/services/scene/sceneToolResults';
import { emptyQaDocumentGraph } from '../src/services/agent/qaDocumentGraph';
import { closeSceneExperimentSession, sceneExperimentRecords } from '../src/services/scene/sceneExperiment';
import { turnFixture, toolNeedFixture } from './scene-semantic-fixture';

globalThis.fetch = async () => assert.fail('Tool reliability checks must remain synthetic/offline');
const base = parseSceneSpec(JSON.stringify({
  meta: { name: 'Synthetic tool reliability', subject: 'Synthetic', goal: 'Check isolated tools', knowledgePoints: [] },
  task: 'Use only synthetic data', completion: { mode: 'signal', maxTurns: 8 },
  behavior: { recipeId: 'question-answer', kind: 'QA', aiBehavior: 'Explain', userAction: 'Ask', evaluationRule: 'None', progressionRule: 'Choose freely',
    interaction: { version: '1.0', allowedTypes: ['text'], defaultType: 'text', allowTextFallback: true } },
}));
const spec: SceneSpec = { ...base, injectProfile: true,
  promptModuleIds: ['turn-agent-planning', 'resource-grounding', 'personal-cognition-grounding', 'profile-personalization'],
  runtimeContract: { ...base.runtimeContract!, maxToolCallsPerTurn: 5, maxPlanningSteps: 3 } };
const run: SceneRunState = { ...createRunState(spec), messages: [
  { id: 'synthetic-user', speakerType: 'user', speakerName: 'User', content: 'Explain this synthetic problem.', timestamp: '' },
] };
const plan = (scene: SceneSpec, state: SceneRunState, requests: SceneTurnToolRequest[]) => normalizeSceneTurnPlan({
  ...toolNeedFixture({ action: 'respond', toolRequests: requests }), understanding: turnFixture(scene, state, {
    informationGaps: [...turnFixture(scene, state).informationGaps, { id: 'experiment', kind: 'execution-result', description: 'Run synthetic trial' }],
  }),
}, scene, state);
const request = (id: SceneRuntimeToolId, query = 'synthetic'): SceneTurnToolRequest => ({ id, query });
const note: NoteSearchResult = { noteId: 'n-allowed', noteType: 'knowledge', title: 'Synthetic note', snippet: 'Synthetic note evidence.', score: .8 };
const doc = { docId: 'd-allowed', fileName: 'Synthetic document', chunkId: 'chunk-1', sectionPath: '', snippet: 'Synthetic document evidence.', score: .8 };
const graph = { ...emptyQaDocumentGraph('synthetic'), nodes: [{ docId: doc.docId, nodeId: 'node-1', chunkId: doc.chunkId,
  fileName: doc.fileName, sectionPath: '', type: 'claim' as never, text: 'Synthetic graph claim.', quote: 'Synthetic graph claim.' }],
  relations: [{ id: 'self', kind: 'relates' as const, from: ['node-1'], to: 'node-1' }] };
const cognition = { status: 'ready', items: [{ recordId: 'c-allowed', title: 'Personal view', text: 'Synthetic belief, not a fact.',
  stance: 'tentative', needsReview: true, context: '', score: .5, neighbors: [{ relation: 'support', text: 'Synthetic support.' }] }] };
const read = async (id: SceneRuntimeToolId, raw: unknown) => assembleSceneTurnContext(spec, plan(spec, run, [request(id)]), {
  searchNotes: async () => raw as never,
  searchDocuments: async () => raw as never,
  readDocumentArguments: async () => raw as never,
  searchCognition: async () => raw as never,
  readProfile: async () => raw as never,
}, run);
const safeChat = (citations: import('../src/types').SceneCitation[]) => renderToStaticMarkup(createElement(SceneChatView, {
  spec, run: { ...run, messages: [...run.messages, { id: 'synthetic-answer', speakerType: 'role', speakerName: 'Tutor',
    content: 'Synthetic answer.', timestamp: '', citations }] }, sending: false, hasPrevRun: false,
  onSend() {}, onInjectEvent() {}, onEnd() {}, onRerun() {},
}));

// Formerly an object title entered ready citations and crashed real React rendering.
for (const raw of [[{ ...note, title: { text: 'BAD_TITLE' } }], [{ ...note, noteId: {} }], [{ ...note, score: '0.8' }],
  [{ ...note, snippet: {} }], [{ ...note, score: NaN }], { hits: [note] }, [{ ...note, matchKinds: 'note' }]]) {
  const result = await read('knowledge-notes', raw);
  assert.equal(result.trace.tools[0].status, 'unavailable'); assert.deepEqual(result.citations, []);
  assert.doesNotMatch(result.prefix, /BAD_TITLE|Synthetic note evidence/);
  assert.doesNotThrow(() => safeChat(result.citations));
}
for (const raw of [[{ ...doc, fileName: {} }], [{ ...doc, docId: {} }], [{ ...doc, chunkId: [] }], [{ ...doc, score: Infinity }],
  [{ ...doc, documentGraphAnchors: [{ docId: doc.docId, nodeId: {} }] }]]) {
  assert.equal((await read('documents', raw)).trace.tools[0].status, 'unavailable');
}
assert.deepEqual(readSceneNoteResults([note])[0].title, note.title);
assert.deepEqual(readSceneDocumentResults([doc])[0].fileName, doc.fileName);
assert.equal(readSceneProfileResult('Synthetic profile'), 'Synthetic profile');
assert.throws(() => readSceneProfileResult({ text: 'Malformed profile' }), SceneToolResultError);
for (const raw of [[], { status: ['ready'], items: [] }, { ...cognition, items: [{ ...cognition.items[0], title: {} }] },
  { ...cognition, items: [{ ...cognition.items[0], recordId: {} }] }, { ...cognition, items: [{ ...cognition.items[0], neighbors: 'bad' }] },
  { ...cognition, items: [{ ...cognition.items[0], stance: ['tentative'] }] }]) {
  assert.equal((await read('argument-chain', raw)).trace.tools[0].status, 'unavailable');
}
assert.equal(readSceneCognitionResults(cognition).items[0].text, cognition.items[0].text);
assert.equal((await read('learner-profile', { profile: 'Malformed' })).trace.tools[0].status, 'unavailable');
assert.equal((await read('learner-profile', '')).trace.tools[0].status, 'empty');
const graphHit = { ...doc, documentGraphAnchors: [{ docId: doc.docId, nodeId: 'node-1' }] };
for (const raw of [{ ...graph, nodes: [{ ...graph.nodes[0], fileName: {} }] }, { ...graph, nodes: {} },
  { ...graph, relations: [{ ...graph.relations[0], from: 'node-1' }] }, { ...graph, relations: [{ ...graph.relations[0], to: {} }] },
  { ...graph, nodes: [{ ...graph.nodes[0], sourceParts: [{ chunkId: doc.chunkId, sectionPath: '', quote: {} }] }] }]) {
  assert.throws(() => readSceneDocumentGraph(raw), SceneToolResultError);
  const result = await assembleSceneTurnContext(spec, plan(spec, run, [request('document-arguments')]), {
    searchDocuments: async () => [graphHit], readDocumentArguments: async () => raw as never,
  }, run);
  assert.equal(result.trace.tools[0].status, 'unavailable'); assert.deepEqual(result.citations, [], 'failed graph cannot leak partial search citations as ready evidence');
  assert.doesNotThrow(() => safeChat(result.citations));
}
const validGraph = await assembleSceneTurnContext(spec, plan(spec, run, [request('document-arguments')]), {
  searchDocuments: async () => [graphHit], readDocumentArguments: async () => graph,
}, run);
assert.equal(validGraph.trace.tools[0].status, 'ready');
assert.match(validGraph.prefix, /"to":"node-1"/, 'relation target is one ID, not an iterable of characters');
assert.doesNotThrow(() => safeChat(validGraph.citations));

// One broken/hung reader must not prevent the next authorized tool from running.
let nextCalls = 0;
const failed = await assembleSceneTurnContext(spec, plan(spec, run, [request('knowledge-notes'), request('documents')]), {
  searchNotes: async () => { throw new Error('RAW_PROVIDER_SECRET_DO_NOT_SHOW'); },
  searchDocuments: async () => { nextCalls++; return [doc]; },
}, run);
assert.deepEqual(failed.trace.tools.map(tool => tool.status), ['unavailable', 'ready']);
assert.equal(nextCalls, 1); assert.doesNotMatch(failed.prefix, /RAW_PROVIDER_SECRET/);
let lateResolve!: (notes: NoteSearchResult[]) => void;
let timedOutSignal: AbortSignal | undefined;
const timeout = await assembleSceneTurnContext(spec, plan(spec, run, [request('knowledge-notes'), request('documents')]), {
  toolTimeoutMs: { 'knowledge-notes': 10 },
  searchNotes: async (_q, _k, options) => { timedOutSignal = options?.signal; return new Promise(resolve => { lateResolve = resolve; }); },
  searchDocuments: async () => [doc],
}, run);
assert.equal(timedOutSignal?.aborted, true);
assert.deepEqual(timeout.trace.tools.map(tool => tool.status), ['unavailable', 'ready']);
assert.match(timeout.prefix, /超时/);
const timeoutSnapshot = structuredClone(timeout);
lateResolve([{ ...note, title: 'LATE_NOTE_MUST_NOT_APPEAR' }]); await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(timeout, timeoutSnapshot); assert.doesNotMatch(timeout.prefix, /LATE_NOTE/);
let graphDispatches = 0, searchResolve!: (hits: typeof graphHit[]) => void;
const graphTimeout = await assembleSceneTurnContext(spec, plan(spec, run, [request('document-arguments')]), {
  toolTimeoutMs: { 'document-arguments': 10 }, searchDocuments: async () => new Promise(resolve => { searchResolve = resolve; }),
  readDocumentArguments: async () => { graphDispatches++; return graph; },
}, run);
searchResolve([graphHit]); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(graphTimeout.trace.tools[0].status, 'unavailable'); assert.equal(graphDispatches, 0, 'late search cannot dispatch graph stage after deadline');
const abortController = new AbortController(); let abortSignal: AbortSignal | undefined, abortResolve!: (hits: NoteSearchResult[]) => void;
let abortedNextCalls = 0;
const aborting = assembleSceneTurnContext(spec, plan(spec, run, [request('knowledge-notes'), request('documents')]), {
  signal: abortController.signal,
  searchNotes: async (_q, _k, options) => { abortSignal = options?.signal; return new Promise(resolve => { abortResolve = resolve; }); },
  searchDocuments: async () => { abortedNextCalls++; return [doc]; },
}, run);
await new Promise(resolve => setTimeout(resolve, 0)); abortController.abort();
await assert.rejects(aborting, { name: 'AbortError' }); assert.equal(abortSignal?.aborted, true);
abortResolve([note]); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(abortedNextCalls, 0, 'cancelled round cannot continue dispatching tools');

let duplicateReads = 0;
const dedup = await assembleSceneTurnContext(spec, plan(spec, run, [request('knowledge-notes'), request('knowledge-notes')]), {
  searchNotes: async () => { duplicateReads++; return [note]; },
}, run);
assert.equal(duplicateReads, 1); assert.equal(dedup.trace.tools.length, 1);
let duplicateFailedReads = 0, step = 0;
const loop = await prepareSceneTurnAgentContext(spec, run, {
  callLlm: async call => {
    const input = JSON.parse(call.userInput);
    assert.ok(input.inputAvailability && !('inputForm' in input.inputAvailability));
    if (input.phase === 'understand') return { content: JSON.stringify({ understanding: turnFixture(spec, run), action: 'respond' }) };
    step++;
    if (step > 1) assert.equal(input.toolResults[0].status, 'unavailable');
    return { content: JSON.stringify(toolNeedFixture({ action: 'respond', toolRequests: [request('knowledge-notes')] })) };
  },
  searchNotes: async () => { duplicateFailedReads++; throw new Error('synthetic unavailable'); },
});
assert.equal(duplicateFailedReads, 1); assert.equal(loop.trace.budgetExhausted, true);

// An experiment timeout is NOT a new trial on retry. Preserve target output if only the judge hangs.
const experimentSpec: SceneSpec = { ...spec, promptModuleIds: [...spec.promptModuleIds!, 'model-experiment'],
  experimentPolicy: { maxExperiments: 2, maxOutputTokens: 256, temperature: .2, criteria: ['Say SYNTHETIC_OK'] },
  runtimeContract: { ...spec.runtimeContract!, allowedTools: ['model-experiment', 'knowledge-notes'] } };
const experimentRun: SceneRunState = { ...createRunState(experimentSpec), runId: 'tool-reliability-experiment', experimentApproved: true,
  messages: [{ id: 'trial-user', speakerType: 'user', speakerName: 'User', content: 'Run this exact prompt: Say SYNTHETIC_OK', timestamp: '' }] };
const args: SceneExperimentInput = { promptSourceMessageId: 'trial-user', promptQuote: 'Say SYNTHETIC_OK', outputFormat: 'text' };
const trialRequest: SceneTurnToolRequest = { id: 'model-experiment', query: 'Run synthetic trial', needId: 'experiment', reason: 'Check real synthetic execution receipt', experiment: args };
const trialPlan = plan(experimentSpec, experimentRun, [trialRequest, request('knowledge-notes')]);
let targetCalls = 0, judgeCalls = 0, lateJudge!: (value: LlmCallResponse) => void, judgeSignal: AbortSignal | undefined;
const deps: SceneTurnAgentDependencies = { toolTimeoutMs: { 'model-experiment': 15 }, searchNotes: async () => [note],
  experimentCallLlm: async (call, options) => {
    if (call.workflow === 'scene-model-experiment') { targetCalls++; return { content: 'SYNTHETIC_OK' }; }
    judgeCalls++; judgeSignal = options?.signal; return new Promise(resolve => { lateJudge = resolve; });
  } };
const timedTrial = await assembleSceneTurnContext(experimentSpec, trialPlan, deps, experimentRun);
assert.deepEqual(timedTrial.trace.tools.map(tool => tool.status), ['unavailable', 'ready']);
assert.equal(judgeSignal?.aborted, true); assert.equal(targetCalls, 1); assert.equal(judgeCalls, 1);
await new Promise(resolve => setTimeout(resolve, 0));
const receipts = sceneExperimentRecords(experimentRun);
assert.equal(receipts.length, 1); assert.equal(receipts[0].status, 'failed'); assert.equal(receipts[0].output, 'SYNTHETIC_OK');
assert.match(timedTrial.prefix, /SYNTHETIC_OK|执行记录摘要/);
const retry = await assembleSceneTurnContext(experimentSpec, trialPlan, {
  ...deps, experimentCallLlm: async () => assert.fail('timed-out experiment must reuse the failed receipt, not dispatch again'),
}, experimentRun);
assert.equal(retry.trace.tools[0].status, 'unavailable'); assert.equal(targetCalls, 1); assert.equal(judgeCalls, 1);
const receiptSnapshot = sceneExperimentRecords(experimentRun);
lateJudge({ content: '{"checks":[{"index":0,"verdict":"met","evidence":"SYNTHETIC_OK","suggestion":""}]}' });
await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(sceneExperimentRecords(experimentRun), receiptSnapshot, 'late judge cannot upgrade a cancelled receipt');
const wrongInputPlan = plan(experimentSpec, experimentRun, [{ ...trialRequest,
  experiment: { ...args, inputSourceMessageId: 'trial-user', inputQuote: 'MISSING_INPUT_MUST_NOT_BORROW_RECEIPT' } }]);
const wrongInput = await assembleSceneTurnContext(experimentSpec, wrongInputPlan, deps, experimentRun);
assert.equal(wrongInput.trace.tools[0].status, 'unavailable');
assert.doesNotMatch(wrongInput.prefix, /SYNTHETIC_OK|执行记录摘要/, 'failed different-input request must not attach a prior same-prompt receipt');
await assert.rejects(() => assembleSceneTurnContext(experimentSpec, trialPlan, deps, { ...experimentRun, experimentApproved: false }), /未授权/);
closeSceneExperimentSession(experimentRun);

const limitedSpec: SceneSpec = { ...experimentSpec, experimentPolicy: { ...experimentSpec.experimentPolicy!, maxExperiments: 1 } };
const inputRun: SceneRunState = { ...experimentRun, runId: 'tool-reliability-input-source', messages: [{ ...experimentRun.messages[0],
  content: experimentRun.messages[0].content + '\nINPUT_A' }] };
const withInput: SceneTurnToolRequest = { ...trialRequest,
  experiment: { ...args, inputSourceMessageId: 'trial-user', inputQuote: 'INPUT_A' } };
let distinctTargets = 0;
const completeDeps: SceneTurnAgentDependencies = { experimentCallLlm: async call => {
  if (call.workflow === 'scene-model-experiment') { distinctTargets++; return { content: 'SYNTHETIC_INPUT_RECEIPT' }; }
  return { content: '{"checks":[{"index":0,"verdict":"unmet","evidence":"","suggestion":"Synthetic check"}]}' };
} };
const canonical = plan(limitedSpec, inputRun, [withInput]);
const reordered: SceneExperimentInput = { outputFormat: 'text', inputQuote: 'INPUT_A', inputSourceMessageId: 'trial-user',
  promptQuote: 'Say SYNTHETIC_OK', promptSourceMessageId: 'trial-user' };
const complete = await assembleSceneTurnContext(limitedSpec, { ...canonical,
  toolRequests: [...canonical.toolRequests, { ...canonical.toolRequests[0], experiment: reordered }] }, completeDeps, inputRun);
assert.equal(complete.trace.tools.length, 1, 'field-order changes cannot bypass canonical experiment deduplication');
assert.equal(distinctTargets, 1); assert.equal(complete.trace.tools[0].status, 'ready');
const noInput = await assembleSceneTurnContext(limitedSpec, plan(limitedSpec, inputRun, [trialRequest]), completeDeps, inputRun);
assert.equal(noInput.trace.tools[0].status, 'unavailable'); assert.equal(distinctTargets, 1);
assert.doesNotMatch(noInput.prefix, /SYNTHETIC_INPUT_RECEIPT|执行记录摘要/, 'budget failure with no input cannot borrow a receipt generated with INPUT_A');
assert.equal(sceneExperimentRecords(inputRun)[0].output, 'SYNTHETIC_INPUT_RECEIPT', 'prior valid receipt remains in its authoritative ledger');
closeSceneExperimentSession(inputRun);

const cancelledRun: SceneRunState = { ...experimentRun, runId: 'tool-reliability-cancelled-target' };
const trialAbort = new AbortController(); let targetResolve!: (response: LlmCallResponse) => void, targetSignal: AbortSignal | undefined;
let cancelledDispatches = 0;
const cancelledTrial = assembleSceneTurnContext(experimentSpec, plan(experimentSpec, cancelledRun, [trialRequest]), {
  signal: trialAbort.signal, experimentCallLlm: async (_call, options) => {
    cancelledDispatches++; targetSignal = options?.signal; return new Promise(resolve => { targetResolve = resolve; });
  },
}, cancelledRun);
await new Promise(resolve => setTimeout(resolve, 0)); trialAbort.abort();
await assert.rejects(cancelledTrial, { name: 'AbortError' });
await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(targetSignal?.aborted, true); assert.equal(sceneExperimentRecords(cancelledRun).length, 1);
const cancelledSnapshot = sceneExperimentRecords(cancelledRun);
assert.equal(cancelledSnapshot[0].status, 'failed'); assert.equal(cancelledSnapshot[0].output, '');
targetResolve({ content: 'LATE_TARGET_MUST_NOT_REPLACE_RECEIPT' }); await new Promise(resolve => setTimeout(resolve, 0));
assert.deepEqual(sceneExperimentRecords(cancelledRun), cancelledSnapshot);
await assembleSceneTurnContext(experimentSpec, plan(experimentSpec, cancelledRun, [trialRequest]), {
  experimentCallLlm: async () => assert.fail('cancelled target cannot be replayed in the same round'),
}, cancelledRun);
assert.equal(cancelledDispatches, 1); closeSceneExperimentSession(cancelledRun);
for (const [id, contract] of Object.entries(SCENE_TOOL_EXECUTION_CONTRACTS)) {
  assert.ok(contract.timeoutMs > 0 && Number.isFinite(contract.timeoutMs), id);
}
await assert.rejects(() => runSceneToolExecution('knowledge-notes', () => new Promise(() => {}), { timeoutMs: 1 }), SceneToolTimeoutError);
console.log('Scene tool reliability passed: strict transport fields and actual citation SSR, graph/cognition/profile validation, throw/hang isolation, forwarded cancellation, late-result exclusion, canonical deduplication, and timed-out experiments retain receipts/output without replay. Synthetic offline IO only.');
