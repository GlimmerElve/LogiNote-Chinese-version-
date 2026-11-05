import assert from 'node:assert/strict';
import type { SceneSpec, SceneRunState, LlmCallRequest } from '../src/types';
import { parseSceneSpec, applySceneAssemblyPlan } from '../src/services/scene/sceneGenerator';
import { isScenePromptModuleEnabled, resolveSceneRuntimeContract } from '../src/services/scene/sceneRuntimeContract';
import { assembleSceneTurnContext, normalizeSceneTurnPlan as normalizePlan, prepareSceneTurnAgentContext as prepareContext, updateSceneWorkingMemory, type SceneTurnAgentDependencies } from '../src/services/scene/sceneTurnAgent';
import { generateGeneralTurn as generateTurn, buildGeneralTurnPrompt, buildGeneralTurnSystemPrompt } from '../src/services/scene/sceneDirector';
import { turnFixture, toolNeedFixture, withTurnFixture } from './scene-semantic-fixture';
const normalizeSceneTurnPlan = (raw: unknown, scene: SceneSpec, state: SceneRunState, evaluate = false) => normalizePlan(
  { ...toolNeedFixture(raw), understanding: turnFixture(scene, state, { evaluationRequested: evaluate }) }, scene, state);
const prepareSceneTurnAgentContext = (scene: SceneSpec, state: SceneRunState, dependencies: SceneTurnAgentDependencies = {}) =>
  prepareContext(scene, state, withTurnFixture(scene, state, dependencies));
const generateGeneralTurn = (scene: SceneSpec, state: SceneRunState, options: { dependencies: SceneTurnAgentDependencies }) =>
  generateTurn(scene, state, { ...options, dependencies: withTurnFixture(scene, state, options.dependencies) });
import { checkCompletion, createRunState } from '../src/services/scene/sceneRuntime';
import { extractSceneEvidence } from '../src/services/memory/evidenceExtractor';
import { gradeSceneObjectiveResponse, normalizeSceneObjectiveEvaluation } from '../src/services/scene/sceneAssessment';
import { emptyQaDocumentGraph } from '../src/services/agent/qaDocumentGraph';
import { normalizeQuestionSetEvaluation } from '../src/services/scene/sceneInteraction';

globalThis.fetch = async () => { throw new Error('Synthetic scene tests must not call network'); };
const spec = applySceneAssemblyPlan(parseSceneSpec(JSON.stringify({
  meta: { name: '物理答疑', subject: '物理', knowledgePoints: ['力'], goal: '解答问题' },
  task: '解释用户的问题', completion: { mode: 'signal', maxTurns: 8 },
  behavior: { recipeId: 'question-answer', kind: '问答', aiBehavior: '回答问题', userAction: '提问',
    evaluationRule: '不评价用户', progressionRule: '按需澄清与取材',
    interaction: { version: '1.0', allowedTypes: ['text'], defaultType: 'text', allowTextFallback: true } },
})), { subject: '物理', knowledgePoints: ['力'], recipeId: 'question-answer',
  requestedCapabilities: ['text'], requestedPromptModules: ['turn-agent-planning', 'resource-grounding'] });
const run: SceneRunState = { ...createRunState(spec), turnCount: 1, messages: [
  { id: 'u1', speakerType: 'user', speakerName: '用户', content: '我认为速度和加速度相同。请解释。', timestamp: new Date().toISOString() },
] };
const contract = resolveSceneRuntimeContract(spec);
assert.equal(contract.mode, 'qa');
assert.equal(contract.initiator, 'user');
assert.equal(contract.evaluation, 'none');
assert.equal(contract.completion, 'user-controlled');
assert.equal(contract.allowedActions.includes('evaluate'), false);
assert.equal(contract.allowedTools.includes('argument-chain'), false);
for (const malformed of [null, 'invalid', { allowedTools: 'knowledge-notes' }, { scope: [] },
  { scope: { noteIds: 'n1' } }, { allowedActions: 'respond' }, { allowTextFallback: 'false' },
  { completion: 'typo' }, { stages: [{ id: 'broken' }] }]) {
  assert.throws(() => resolveSceneRuntimeContract({ ...spec, runtimeContract: malformed as never }), /契约|阶段/,
    'malformed authority must fail closed instead of broadening permissions');
}
let oneStepReads = 0;
const oneStep = await prepareSceneTurnAgentContext({ ...spec, runtimeContract: { ...contract, maxPlanningSteps: 1 } }, run, {
  callLlm: async () => ({ content: '{"action":"respond","toolRequests":[{"id":"knowledge-notes","query":"加速度"}]}' }),
  searchNotes: async () => { oneStepReads++; return [{ noteId: 'n1', noteType: 'knowledge', title: '定义', snippet: '速度的变化率', score: 1 }]; },
});
assert.equal(oneStepReads, 1, 'last permitted planning step still executes authorized retrieval');
assert.match(oneStep.prefix, /速度的变化率/);
assert.equal(isScenePromptModuleEnabled({ ...spec, promptModuleIds: [] }, 'turn-agent-planning'), true,
  'required agent lifecycle cannot disappear on loaded scenes');
assert.deepEqual(resolveSceneRuntimeContract({ ...spec, promptModuleIds: [] }).allowedTools, [],
  'required lifecycle does not grant optional data access');
const onRequest: SceneSpec = { ...spec, runtimeContract: { ...contract, evaluation: 'on-request', allowedActions: ['evaluate'] } };
assert.throws(() => normalizeSceneTurnPlan({ action: 'evaluate' }, onRequest, run), /未授权本轮/,
  'fallback action cannot bypass request-only evaluation');
assert.equal(normalizeSceneTurnPlan({ action: 'evaluate' }, onRequest, { ...run,
  messages: [{ ...run.messages[0], content: '请评价我的回答' }] }, true).action, 'evaluate');
const uninstalled = { ...spec, runtimeContract: undefined, behavior: { ...spec.behavior!,
  interaction: { version: '1.0', allowedTypes: ['unknown'], defaultType: 'unknown', allowTextFallback: false } } } as unknown as SceneSpec;
assert.throws(() => resolveSceneRuntimeContract(uninstalled), /禁止文本降级/);
const staged: SceneSpec = { ...spec, runtimeContract: { ...contract, initialStageId: 'clarify', stages: [
  { id: 'clarify', goal: '澄清问题', allowedNext: ['discuss'] },
  { id: 'discuss', goal: '讨论', allowedNext: ['wrap'] },
  { id: 'wrap', goal: '总结', allowedNext: [] },
] } };
assert.equal(normalizeSceneTurnPlan({ stageId: 'wrap' }, staged, run).stageId, 'clarify', 'cannot skip mandatory stage');
assert.equal(normalizeSceneTurnPlan({ stageId: 'discuss' }, staged, run).stageId, 'discuss');
assert.match(buildGeneralTurnSystemPrompt(spec), /优先回答用户/);

let calls = 0, noteQueries: string[] = [];
const loop = await prepareSceneTurnAgentContext(spec, run, {
  callLlm: async request => {
    const input = JSON.parse(request.userInput);
    calls++;
    if (calls === 1) return { content: JSON.stringify({ action: 'respond', toolRequests: [{ id: 'knowledge-notes', query: '速度' }] }) };
    assert.equal(input.toolResults.length, calls - 1, 'each planning step observes prior tool results');
    if (calls === 2) {
      assert.equal(input.toolResults[0].status, 'empty');
      return { content: JSON.stringify({ action: 'respond', toolRequests: [{ id: 'knowledge-notes', query: '速度与加速度区别' }] }) };
    }
    assert.equal(input.toolResults[1].status, 'ready');
    return { content: JSON.stringify({ action: 'respond', toolRequests: [], focus: '解释两者区别' }) };
  },
  searchNotes: async query => { noteQueries.push(query); return query === '速度' ? [] : [
    { noteId: 'n1', noteType: 'knowledge', title: '加速度', snippet: '加速度是速度的变化率。', score: 0.9 },
  ]; },
});
assert.deepEqual(noteQueries, ['速度', '速度与加速度区别']);
assert.equal(loop.trace.understandingSteps, 1);
assert.equal(loop.trace.planningSteps, 3, 'semantic understanding has its own step before the bounded observe/act steps');
assert.equal(loop.citations.length, 1);
assert.match(loop.prefix, /\[1\].*加速度/);
assert.equal(loop.plan.focus, spec.meta.goal, 'tool planner must retain the understood goal');
assert.equal(run.workingMemory, undefined, 'preparation never mutates committed run');

let simpleCalls = 0;
await prepareSceneTurnAgentContext(spec, run, {
  callLlm: async () => { simpleCalls++; return { content: '{"action":"respond","toolRequests":[]}' }; },
  searchNotes: async () => assert.fail('simple response should not retrieve'),
});
assert.equal(simpleCalls, 1);
let passageCalls = 0;
const passages = await prepareSceneTurnAgentContext(spec, run, {
  callLlm: async () => ({ content: JSON.stringify({ action: 'respond', toolRequests: ++passageCalls <= 2
    ? [{ id: 'knowledge-notes', query: 'part-' + passageCalls }] : [] }) }),
  searchNotes: async query => [{ noteId: 'same-note', noteType: 'knowledge', title: '运动', snippet: query, score: 1 }],
});
assert.deepEqual(passages.citations.map(c => [c.index, c.snippet]), [[1, 'part-1'], [2, 'part-2']],
  'requerying a note must preserve distinct supporting passages with stable citations');
assert.match(passages.prefix, /part-1/); assert.match(passages.prefix, /part-2/);

const restricted: SceneSpec = { ...spec, runtimeContract: { ...contract, allowedTools: ['knowledge-notes'], scope: { noteIds: ['allowed'] } } };
const forged = normalizeSceneTurnPlan({ action: 'evaluate', toolRequests: [
  { id: 'learner-profile', query: 'secret' }, { id: 'knowledge-notes', query: 'force', scope: { noteIds: ['denied'] } },
] }, restricted, run);
assert.equal(forged.action, 'respond');
assert.deepEqual(forged.toolRequests.map(r => r.id), ['knowledge-notes']);
const scoped = await assembleSceneTurnContext(restricted, forged, { searchNotes: async () => [
  { noteId: 'denied', noteType: 'knowledge', title: '禁止资料', snippet: 'must not appear', score: 1 },
  { noteId: 'allowed', noteType: 'knowledge', title: '允许资料', snippet: 'allowed text', score: 0.8 },
] });
assert.equal(scoped.citations.length, 1);
assert.doesNotMatch(scoped.prefix, /must not appear/);
await assert.rejects(() => assembleSceneTurnContext(restricted, { ...forged, toolRequests: [{ id: 'learner-profile', query: 'secret' }] }), /未授权工具/);

let repeats = 0;
const repeated = await prepareSceneTurnAgentContext(spec, run, {
  callLlm: async () => ({ content: '{"action":"respond","toolRequests":[{"id":"knowledge-notes","query":"same"}]}' }),
  searchNotes: async () => { repeats++; return []; },
});
assert.equal(repeats, 1, 'identical tool calls must not loop');
assert.equal(repeated.trace.budgetExhausted, true);
const failed = await assembleSceneTurnContext(spec, normalizeSceneTurnPlan({ toolRequests: [{ id: 'knowledge-notes', query: 'q' }] }, spec, run), {
  searchNotes: async () => { throw new Error('storage offline'); },
});
assert.equal(failed.trace.tools[0].status, 'unavailable');
assert.match(failed.prefix, /不能当作空库/);

const documentSpec: SceneSpec = { ...spec, runtimeContract: { ...contract,
  allowedTools: ['document-arguments'], scope: { documentIds: ['d-allowed'] } } };
let graphReads = 0;
const documents = await assembleSceneTurnContext(documentSpec, normalizeSceneTurnPlan({ toolRequests: [
  { id: 'document-arguments', query: '速度与加速度' },
] }, documentSpec, run), {
  searchDocuments: async (_query, _k, options) => {
    assert.deepEqual(options.allowedDocIds, ['d-allowed']);
    return [
      { docId: 'd-denied', fileName: 'private', chunkId: 'x', sectionPath: '', snippet: 'not authorized', score: 1 },
      { docId: 'd-allowed', fileName: 'physics', chunkId: 'c1', sectionPath: '', snippet: 'velocity change', score: 0.8,
        documentGraphAnchors: [{ docId: 'd-allowed', nodeId: 'dg5:n1' }] },
    ];
  },
  readDocumentArguments: async anchors => {
    graphReads++; assert.deepEqual(anchors, [{ docId: 'd-allowed', nodeId: 'dg5:n1' }]);
    return { ...emptyQaDocumentGraph('test'), nodes: [{ docId: 'd-allowed', nodeId: 'dg5:n1', chunkId: 'c1',
      fileName: 'physics', sectionPath: '', text: '速度改变产生加速度', quote: '速度改变产生加速度', type: 'claim' as never }] };
  },
});
assert.equal(graphReads, 1);
assert.equal(documents.citations[0].sourceType, 'document');
assert.match(documents.prefix, /已保存的论证结构/);
assert.ok(documents.citations.some(c => c.snippet === '速度改变产生加速度'), 'expanded graph evidence has its own citation');
assert.doesNotMatch(documents.prefix, /not authorized/);
const emptyDocuments = await assembleSceneTurnContext({ ...documentSpec, runtimeContract: { ...documentSpec.runtimeContract!, scope: { documentIds: [] } } },
  normalizeSceneTurnPlan({ toolRequests: [{ id: 'document-arguments', query: 'q' }] }, documentSpec, run), {
    searchDocuments: async () => assert.fail('explicit empty scope cannot invoke retrieval'),
    readDocumentArguments: async () => assert.fail('explicit empty scope cannot invoke graph read'),
  });
assert.equal(emptyDocuments.trace.tools[0].status, 'empty', 'empty permission scope is not a storage failure');

const aborted = new AbortController(); aborted.abort();
await assert.rejects(() => prepareSceneTurnAgentContext(spec, run, { signal: aborted.signal,
  callLlm: async () => assert.fail('aborted work cannot start') }), { name: 'AbortError' });

const memory = updateSceneWorkingMemory({
  focus: '速度区别', observations: [{ text: '可能混淆两个概念', sourceMessageIds: ['u1'] }, { text: '无依据', sourceMessageIds: ['missing'] }],
  userStatements: [{ quote: '我认为速度和加速度相同。', sourceMessageId: 'u1' }, { quote: '我已经精通物理', sourceMessageId: 'u1' }],
}, run);
assert.equal(memory.observations.length, 1);
assert.equal(memory.userStatements.length, 1);
const requests: LlmCallRequest[] = [];
const result = await generateGeneralTurn(spec, { ...run, workingMemory: memory }, { dependencies: {
  callLlm: async request => {
    requests.push(request);
    return { content: request.workflow === 'scene-turn-plan'
      ? '{"action":"respond","toolRequests":[]}'
      : '{"content":"速度描述运动快慢，加速度描述速度如何变化。","endReason":"已答完"}' };
  },
} });
assert.equal(requests.length, 2);
assert.equal(result.endReason, undefined, 'answering a question cannot close user-controlled conversation');
assert.equal(requests.every(r => r.skipMemoryInjection), true);
assert.match(requests[1].userInput, /速度区别/);
assert.equal(result.workingMemory?.userStatements.length, 1);
for (const malformed of ['{}', '{"content":"   "}', '{"content":"正文","interaction":42}', '{"endReason":"已答完"}']) {
  let attempts = 0;
  await assert.rejects(() => generateGeneralTurn(spec, run, { dependencies: { callLlm: async request => {
    if (request.workflow === 'scene-turn-plan') return { content: '{"action":"respond","toolRequests":[]}' };
    attempts++; return { content: malformed };
  } } }), /契约校验/);
  assert.equal(attempts, 2, 'empty or malformed output is repaired once, never committed as a placeholder reply');
}

const choiceSpec: SceneSpec = { ...spec, runtimeContract: { ...contract, mode: 'coaching', evaluation: 'each-answer', completion: 'objective',
  allowedTools: [], allowedInteractionTypes: ['single-choice'], allowTextFallback: false },
  behavior: { ...spec.behavior!, interaction: { version: '1.0', allowedTypes: ['single-choice'], defaultType: 'single-choice', allowTextFallback: false } } };
const narrowedSpec: SceneSpec = { ...choiceSpec, behavior: { ...choiceSpec.behavior!, interaction: {
  version: '1.0', allowedTypes: ['multiple-choice', 'single-choice'], defaultType: 'multiple-choice', allowTextFallback: false,
} } };
assert.match(buildGeneralTurnSystemPrompt(narrowedSpec), /默认：single-choice/);
assert.doesNotMatch(buildGeneralTurnPrompt(narrowedSpec, run), /multiple-choice|其它操作必须改写成文本/);
assert.match(buildGeneralTurnPrompt(narrowedSpec, run), /不得用文本输入替代指定题型的作答控件/);
const contaminated: SceneSpec = { ...spec, openingNarrative: '不该出现的旁白', events: [
  { id: 'event', description: '不该出现的事件', trigger: { type: 'turn', turn: 1 }, fired: false },
] };
assert.equal(createRunState(contaminated).messages.length, 0);
assert.equal(createRunState(contaminated).events.length, 0);
let replies = 0;
await assert.rejects(() => generateGeneralTurn(choiceSpec, run, { dependencies: { callLlm: async request => {
  if (request.workflow === 'scene-turn-plan') return { content: '{"action":"advance","toolRequests":[]}' };
  replies++;
  return { content: '{"content":"请选择","interaction":{"id":"bad","type":"multiple-choice","options":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"required":true}}' };
} } }), /契约校验/);
assert.equal(replies, 2, 'repair once, then retain submitted turn for retry');

const choice = { id: 'q1', type: 'single-choice' as const, required: true, assessment: 'objective' as const,
  options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] };
const evaluation = normalizeSceneObjectiveEvaluation({ interactionId: 'q1', type: 'single-choice', correctId: 'b', explanation: '由定义得到' }, choice);
assert.ok(evaluation);
assert.equal(normalizeSceneObjectiveEvaluation({ interactionId: 'q1', type: 'single-choice', correctId: 'forged' }, choice), undefined);
const multi = { ...choice, type: 'multiple-choice' as const, minSelections: 2, maxSelections: 2 };
assert.equal(normalizeSceneObjectiveEvaluation({ interactionId: 'q1', type: 'multiple-choice', correctIds: ['a'] }, multi), undefined,
  'answer key must be achievable under the selection constraints');
assert.ok(normalizeSceneObjectiveEvaluation({ interactionId: 'q1', type: 'multiple-choice', correctIds: ['a', 'b'] }, multi));
const multiPaper = { id: 'paper', type: 'question-set' as const, required: true, submissionMode: 'batch' as const, feedbackMode: 'after-submit' as const,
  items: [{ ...multi, content: '选两项' }, { id: 'q2', type: 'true-false' as const, content: '判断', required: true }] };
const multiPaperKey = { interactionId: 'paper', type: 'question-set', items: [
  { itemId: 'q1', type: 'multiple-choice', correctIds: ['a'] }, { itemId: 'q2', type: 'true-false', correctValue: true },
] };
assert.equal(normalizeQuestionSetEvaluation(multiPaperKey, multiPaper), undefined, 'batch keys obey selection limits too');
assert.equal(normalizeQuestionSetEvaluation({ ...multiPaperKey, items: [...multiPaperKey.items,
  { itemId: 'extra', type: 'true-false', correctValue: true }] }, multiPaper), undefined, 'extra grading items are rejected');
assert.equal(gradeSceneObjectiveResponse({ interactionId: 'q1', type: 'single-choice', selectedId: 'a', submittedAt: '' }, evaluation)?.correct, false);
const gradedRun: SceneRunState = { ...run, messages: [{ ...run.messages[0],
  objectiveAssessment: { interactionId: 'q1', correct: false, explanation: '由定义得到' } }] };
await prepareSceneTurnAgentContext(choiceSpec, gradedRun, { callLlm: async request => {
  const input = JSON.parse(request.userInput);
  assert.equal(input.recentInteraction[0].assessment.correct, false, 'planner receives machine grading before choosing next action');
  return { content: '{"action":"advance","toolRequests":[]}' };
} });

const validChoice = await generateGeneralTurn(choiceSpec, gradedRun, { dependencies: { callLlm: async request => ({
  content: request.workflow === 'scene-turn-plan' ? '{"action":"advance","toolRequests":[]}'
    : JSON.stringify({ content: '下一道题', interaction: choice, evaluation }),
}) } });
assert.equal(validChoice.objectiveEvaluation?.type, 'single-choice');
assert.doesNotMatch(validChoice.content, /correctId|由定义得到/);
const usedIdRun: SceneRunState = { ...gradedRun, messages: [...gradedRun.messages,
  { id: 'assistant-old', speakerType: 'role', speakerName: '老师', content: '旧题', interaction: choice, timestamp: '' }] };
await assert.rejects(() => generateGeneralTurn(choiceSpec, usedIdRun, { dependencies: { callLlm: async request => ({
  content: request.workflow === 'scene-turn-plan' ? '{"action":"advance","toolRequests":[]}'
    : JSON.stringify({ content: '重复 id 的新题', interaction: choice, evaluation }),
}) } }), /契约校验/, 'reused directive IDs must not leave later questions permanently unanswerable');

const stopped = checkCompletion(spec, run, { userIntentEnd: true });
assert.equal(stopped.completionOutcome, 'stopped');
const limited = checkCompletion(spec, { ...run, turnCount: 8 });
assert.equal(limited.completionOutcome, 'limit-reached');
const evidence = extractSceneEvidence({ episodeId: 'test', observedAt: new Date().toISOString(), spec, run: limited });
assert.equal(evidence.evidenceSnippets[0].type, 'observation');
assert.equal(checkCompletion(spec, run, { signalReason: '回答完毕' }).status, 'running');
assert.equal(checkCompletion(choiceSpec, run, { signalReason: '目标完成' }).completionOutcome, 'completed');
console.log('Scene turn agent passed: multi-step observation, direct response, scope/tool enforcement, bounded loops, abort, grounded local memory, strict output repair and neutral session endings. Synthetic IO only.');
