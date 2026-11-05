import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import type { LlmCallRequest, LlmCallResponse, SceneMessage, SceneRunState } from '../src/types';
import { applySceneAssemblyPlan, parseSceneSpec } from '../src/services/scene/sceneGenerator';
import { generateGeneralTurn } from '../src/services/scene/sceneDirector';
import { createRunState } from '../src/services/scene/sceneRuntime';
import { getPendingSceneInteraction, sceneInputFacts } from '../src/services/scene/scenePendingTask';
import { collectSceneAnswerRecords, sceneAnswerFeedbackView } from '../src/services/scene/sceneTeaching';
import { normalizeSceneUnderstandingEnvelope } from '../src/services/scene/sceneTurnAgent';
import { normalizeSceneTurnAttemptDiagnostic, sceneTurnAttemptDiagnostic, SceneTurnProtocolError } from '../src/services/scene/sceneTurnDiagnostics';
import type { SceneTurnAttemptDiagnostic } from '../src/services/scene/sceneTurnDiagnostics';
import { understandingFixture } from './scene-semantic-fixture';

globalThis.fetch = async () => assert.fail('Turn stability checks must never access the network');
const spec = applySceneAssemblyPlan(parseSceneSpec(JSON.stringify({
  meta: { name: 'Synthetic turn stability', subject: '比例', goal: '答题与讲解自主组织' }, task: 'Only single-choice answers; discussion is independent',
  behavior: { recipeId: 'agent-designed', kind: '学习', aiBehavior: 'Respond naturally', userAction: 'Answer or discuss',
    evaluationRule: 'Local objective checking', progressionRule: 'No forced new question after an answer',
    interaction: { version: '1.0', allowedTypes: ['single-choice'], defaultType: 'single-choice', allowTextFallback: false } },
  completion: { mode: 'signal', maxTurns: 30 }, runtimeContract: { mode: 'coaching', completion: 'user-controlled',
    evaluation: 'each-answer', allowedTools: [], maxToolCallsPerTurn: 0, answerFeedback: { correctness: 'immediate', explanation: 'immediate' } },
})), { subject: '比例', knowledgePoints: [], sceneSkill: 'S1', recipeId: 'agent-designed', requestedCapabilities: ['single-choice'],
  requestedPromptModules: ['structured-interaction', 'turn-agent-planning'] });
const stamp = '2026-10-16T00:00:00.000Z';
function choice(id: string) {
  return { id, type: 'single-choice' as const, assessment: 'objective' as const, required: true,
    options: [{ id: 'a', label: '16人' }, { id: 'b', label: '24人' }] };
}
function key(id: string) { return { interactionId: id, type: 'single-choice' as const, correctId: 'b', explanation: 'PRIVATE_KEY_EXPLANATION_' + id }; }
function task(id = 'pending-one'): SceneMessage {
  return { id: 'message-' + id, speakerType: 'role', speakerName: 'Tutor', timestamp: stamp,
    content: '40人中60%参加活动，有多少人？', interaction: choice(id), objectiveEvaluation: key(id) };
}
function user(id: string, content: string): SceneMessage {
  return { id, speakerType: 'user', speakerName: 'User', timestamp: stamp, inputKind: 'conversation', content };
}
function answer(id: string, selectedId = 'a'): SceneMessage {
  return { ...user('answer-' + id, '选择：' + selectedId), inputKind: 'response',
    interactionResponse: { interactionId: id, type: 'single-choice', selectedId, submittedAt: stamp } };
}
function state(messages: SceneMessage[]): SceneRunState { return { ...createRunState(spec), runId: 'stability-run', messages }; }
const pendingRun = () => state([task(), user('current-user', '先给提示，题目保留，不要换题。')]);
function newTask(id = 'new-task') { return { content: '下一道合成题', interaction: choice(id), evaluation: key(id) }; }
type Reply = Record<string, unknown> | string | { throwMessage: string };
async function invoke(run: SceneRunState, replies: Reply[], options: {
  expected?: 'keep' | 'replace' | 'cancel'; initialSemanticAction?: 'keep' | 'replace' | 'cancel';
  failBothSemanticAttempts?: boolean; firstFinishReason?: string; sinkThrows?: boolean;
  understandingReplies?: Array<Record<string, unknown>>;
} = {}) {
  const requests: LlmCallRequest[] = [], diagnostics: SceneTurnAttemptDiagnostic[] = [];
  let understands = 0, responses = 0;
  const call = async (request: LlmCallRequest): Promise<LlmCallResponse> => {
    requests.push(structuredClone(request));
    if (request.workflow === 'scene-turn-plan') {
      const payload = JSON.parse(request.userInput);
      assert.equal(payload.phase, 'understand', 'no tool planning is needed for these synthetic turns');
      understands++;
      if (options.understandingReplies) {
        const replay = options.understandingReplies[understands - 1];
        assert.ok(replay, 'unexpected extra semantic replay attempt');
        return { content: JSON.stringify(replay), diagnostics: { finishReason: 'stop' } };
      }
      const latest = run.messages.findLast(message => message.speakerType === 'user')!;
      const action = options.initialSemanticAction && (understands === 1 || options.failBothSemanticAttempts)
        ? options.initialSemanticAction : options.expected || 'keep';
      return { content: JSON.stringify({ understanding: understandingFixture(latest.id, latest.content, {
        intent: latest.interactionResponse ? 'answer' : 'help', pendingTaskAction: action,
      }), action: 'respond', responseGuidance: 'Synthetic response decision' }), diagnostics: { finishReason: 'stop' } };
    }
    assert.equal(request.workflow, 'scene-general-turn');
    const reply = replies[responses++];
    assert.notEqual(reply, undefined, 'unexpected extra model-response attempt');
    if (reply && typeof reply === 'object' && 'throwMessage' in reply) throw new Error(String(reply.throwMessage));
    return { content: typeof reply === 'string' ? reply : JSON.stringify(reply),
      usage: { promptTokens: 19, completionTokens: 13 },
      diagnostics: { finishReason: responses === 1 ? options.firstFinishReason || 'stop' : 'stop',
        reasoningTokens: 0, hadReasoningContent: false } };
  };
  let result: Awaited<ReturnType<typeof generateGeneralTurn>> | undefined, error: unknown;
  try { result = await generateGeneralTurn(spec, run, { dependencies: { callLlm: call }, onDiagnostic: value => {
    diagnostics.push(value); if (options.sinkThrows) throw new Error('PRIVATE_DIAGNOSTIC_SINK');
  } }); } catch (caught) { error = caught; }
  return { result, error, requests, diagnostics, understands, responses };
}
function repairHas(value: Awaited<ReturnType<typeof invoke>>, code: string, phase: 'respond' | 'understand' = 'respond') {
  const attempts = value.diagnostics.filter(diagnostic => diagnostic.phase === phase);
  assert.equal(attempts[0]?.outcome, 'repairing', code + ' first attempt');
  assert.ok(attempts[0].issues.some(issue => issue.code === code), code + ' precise issue');
  assert.equal(attempts[1]?.outcome, 'accepted', code + ' corrected attempt');
  const repair = value.requests.filter(request => phase === 'respond' ? request.workflow === 'scene-general-turn'
    : request.workflow === 'scene-turn-plan')[1];
  assert.ok(repair?.userInput.includes(code), code + ' must be returned to the repair request');
  assert.equal(value.error, undefined);
}

// Proven transport no-ops are accepted without a needless second response.
for (const taskUpdate of [null, { operation: 'keep' }, { operation: 'keep', interactionId: 'pending-one', sourceUserMessageId: 'current-user' }]) {
  const before = pendingRun(), snapshot = JSON.stringify(before);
  const value = await invoke(before, [{ content: '先从每一百份想起。', taskUpdate }]);
  assert.equal(value.error, undefined); assert.equal(value.responses, 1); assert.equal(value.result?.taskUpdate, undefined);
  assert.ok(value.diagnostics.find(diagnostic => diagnostic.phase === 'respond')?.normalizations?.includes(taskUpdate === null ? 'null-noop' : 'keep-noop'));
  assert.equal(JSON.stringify(before), snapshot); assert.equal(getPendingSceneInteraction(before)?.interaction?.id, 'pending-one');
}
const invalidKeep = await invoke(pendingRun(), [{ content: '提示', taskUpdate: { operation: 'keep', interactionId: 'other-task' } }, { content: '保留原题的提示。' }]);
repairHas(invalidKeep, 'invalid-keep-noop');

// Exact echoes are discarded, never prepared again or committed as another key.
for (const withKey of [false, true]) {
  const before = pendingRun(), original = structuredClone(before);
  const echoed = getPendingSceneInteraction(before)!.interaction!;
  const value = await invoke(before, [{ content: '提示后仍作答原题。', interaction: echoed, ...(withKey ? { evaluation: key('pending-one') } : {}) }]);
  assert.equal(value.error, undefined); assert.equal(value.responses, 1);
  assert.equal(value.result?.interaction, undefined); assert.equal(value.result?.objectiveEvaluation, undefined);
  assert.equal(value.result?.interactionPreparation, undefined);
  assert.ok(value.diagnostics.at(-1)?.normalizations?.includes('pending-echo'));
  assert.deepEqual(before, original, 'echo must not mutate the original control or private key');
}
const changedControl = choice('pending-one'); changedControl.options[0].label = 'Changed option';
const controlMutation = await invoke(pendingRun(), [{ content: '提示', interaction: changedControl }, { content: '只解释，不改题。' }]);
repairHas(controlMutation, 'mutated-pending-echo');
const keyMutation = await invoke(pendingRun(), [{ content: '提示', interaction: choice('pending-one'),
  evaluation: { ...key('pending-one'), correctId: 'a' } }, { content: '只提示，不更改答案依据。' }]);
repairHas(keyMutation, 'mutated-pending-key');

// A semantic replacement requires a source-bound taskUpdate, not merely a new
// control. Task message IDs and interaction IDs remain separate namespaces.
const replacementRun = state([task(), user('replace-user', '把当前这道题换成另一道单选题。')]);
const replacement = { operation: 'replace', interactionId: 'pending-one', sourceUserMessageId: 'replace-user', reason: '用户明确换题' };
const missingUpdate = await invoke(replacementRun, [newTask(), { ...newTask(), taskUpdate: replacement }], { expected: 'replace' });
repairHas(missingUpdate, 'missing-task-update');
assert.equal(missingUpdate.result?.taskUpdate?.operation, 'replace');
assert.equal(missingUpdate.result?.interaction?.id, 'new-task');
assert.equal(missingUpdate.result?.objectiveEvaluation?.type, 'single-choice');
assert.equal(missingUpdate.result?.interactionPreparation?.interactionId, 'new-task');
const wrongId = await invoke(replacementRun, [{ ...newTask(), taskUpdate: { ...replacement, interactionId: 'message-pending-one' } },
  { ...newTask(), taskUpdate: replacement }], { expected: 'replace' });
repairHas(wrongId, 'wrong-pending-id');
const wrongSource = await invoke(replacementRun, [{ ...newTask(), taskUpdate: { ...replacement, sourceUserMessageId: 'old-user' } },
  { ...newTask(), taskUpdate: replacement }], { expected: 'replace' });
repairHas(wrongSource, 'invalid-task-source');
const mismatch = await invoke(replacementRun, [{ ...newTask(), taskUpdate: replacement }, { content: '当前语义决定保留原题。' }]);
repairHas(mismatch, 'task-action-mismatch');

// No pending task (including a just-submitted answer) cannot be replaced or
// cancelled. This must be repaired in understanding before response generation.
for (const noPending of [state([user('no-task', '继续一题。')]), state([task(), answer('pending-one')])]) {
  assert.equal(sceneInputFacts(noPending).canUpdatePending, false);
  const value = await invoke(noPending, [newTask('next-after-answer')], { initialSemanticAction: 'replace' });
  repairHas(value, 'invalid-pending-action', 'understand');
  assert.equal(value.understands, 2); assert.equal(value.responses, 1);
  assert.equal(value.result?.interaction?.id, 'next-after-answer');
}
const twiceBadSemantic = await invoke(state([user('no-pending-twice', '继续。')]), [], {
  initialSemanticAction: 'cancel', failBothSemanticAttempts: true,
});
assert.ok(twiceBadSemantic.error); assert.equal(twiceBadSemantic.responses, 0);
assert.equal(twiceBadSemantic.diagnostics.at(-1)?.outcome, 'rejected');

// Actual synthetic cloud response shape from scene-stability-20261016-01:
// the model put correct, sourced teaching beside understanding, not inside it.
// This fixture is embedded so offline checks do not depend on ignored artifacts.
const replayUserId = 'stability-policy-and-harder-user';
const replayText = '接下来答对不用具体解释，只简短确认；答错仍要解释。我主动追问时可以讲解。下一题难度提高一点，至少两步相互依赖的比例推理；当前待答题保留。';
const actualCloudShape = {
  understanding: {
    pendingTaskAction: 'keep', intent: 'change-direction',
    userGoal: '设定后续答题反馈策略：答对只简短确认不解释、答错仍解释、主动追问时可讲解；并希望下一题难度提高为至少两步相互依赖的比例推理，同时保留当前待答题。',
    expectedExperience: '确认已理解并保存这些持续教学要求，不立即替换当前题，等待用户作答当前题后再按新策略反馈，并在之后出更难的题。',
    requirements: ['答对时只简短确认，不具体解释', '答错时仍要解释', '用户主动追问时可以讲解', '下一题难度提高，至少两步相互依赖的比例推理', '当前待答题保留'],
    exclusions: ['不替换当前待答题', '答对时不展开具体解释'], informationGaps: [], needsClarification: false,
    evaluationRequested: false, evidence: [{ sourceId: replayUserId, quote: replayText }],
  }, action: 'respond',
  responseGuidance: '简短确认已记录这些持续要求：答对只简短确认、答错仍解释、主动追问可讲解；下一题会提高为至少两步相互依赖的比例推理；当前待答题保留，请用户继续作答当前题。',
  teaching: { policyUpdates: [
    { id: 'feedback-correct-brief', action: 'set', scope: 'session', instruction: '答对时只简短确认，不具体解释；答错仍解释；用户主动追问时可讲解。',
      rules: [{ when: 'correct', correctness: 'immediate', explanation: 'on-request', responseStyle: 'brief-confirmation' },
        { when: 'incorrect', correctness: 'immediate', explanation: 'immediate', responseStyle: 'explanation' },
        { when: 'on-request', explanation: 'immediate', responseStyle: 'explanation' }],
      source: { sourceMessageId: replayUserId, quote: '接下来答对不用具体解释，只简短确认；答错仍要解释。我主动追问时可以讲解。' } },
    { id: 'next-task-harder-two-step', action: 'set', scope: 'session', instruction: '下一题难度提高，至少两步相互依赖的比例推理。',
      source: { sourceMessageId: replayUserId, quote: '下一题难度提高一点，至少两步相互依赖的比例推理；当前待答题保留。' } },
  ] },
};
const aliasRun = state([task(), user(replayUserId, replayText)]), aliasSnapshot = JSON.stringify(aliasRun);
const alias = await invoke(aliasRun, [{ content: '已记录，保留当前题。' }], { understandingReplies: [actualCloudShape] });
assert.equal(alias.error, undefined); assert.equal(alias.understands, 1);
assert.equal(alias.result?.teachingState?.activeInstructions?.length, 2, 'top-level teaching must not be silently dropped');
assert.equal(alias.result?.teachingState?.activeInstructions?.[0].rules[0].when, 'correct');
assert.ok(alias.diagnostics.find(diagnostic => diagnostic.phase === 'understand')?.normalizations?.includes('teaching-envelope'));
assert.equal(getPendingSceneInteraction(aliasRun)?.interaction?.id, 'pending-one');
assert.equal(JSON.stringify(aliasRun), aliasSnapshot);

// Protocol history must teach the same JSON envelope the response parser now
// expects. It must remain parseable after action appends and marked previews.
const historyNormal: SceneMessage = { ...task('history-normal'), interactionPreparation: {
  version: 1, interactionId: 'history-normal', sourceFingerprint: 'PRIVATE_LOCAL_RECEIPT', preparedFingerprint: 'PRIVATE_LOCAL_RECEIPT', orders: [],
} };
const historyLong: SceneMessage = { ...task('history-long'), content: 'LONG_HISTORY_TEXT_'.repeat(400), interactionPreparation: {
  version: 1, interactionId: 'history-long', sourceFingerprint: 'PRIVATE_LOCAL_RECEIPT_LONG', preparedFingerprint: 'PRIVATE_LOCAL_RECEIPT_LONG', orders: [],
} };
const historyRun = state([historyNormal,
  { id: 'normal-action', speakerType: 'action', speakerName: '', content: 'normal-history-action', timestamp: stamp },
  user('history-middle-user', '看过题面，先讨论。'), historyLong,
  { id: 'long-action', speakerType: 'action', speakerName: '', content: 'long-history-action', timestamp: stamp },
  user('history-last-user', '只继续交流，不创建新题。')]);
const historyReplay = await invoke(historyRun, [{ content: '可以继续讨论。' }]);
assert.equal(historyReplay.error, undefined);
const responseRequest = historyReplay.requests.find(request => request.workflow === 'scene-general-turn')!;
const assistantHistory = responseRequest.messages!.filter(message => message.role === 'assistant');
assert.equal(assistantHistory.length, 2);
const envelopes = assistantHistory.map(message => JSON.parse(message.content));
assert.ok(envelopes[0].content.includes('normal-history-action'));
assert.equal(envelopes[0].interaction.id, 'history-normal');
assert.equal(envelopes[1].historyPreview, 'truncated-not-full-task');
assert.ok(envelopes[1].content.length <= 4400);
assert.equal(envelopes[1].interaction, undefined, 'a marked preview is not a partial executable task');
for (const envelope of envelopes) {
  assert.ok(Object.keys(envelope).every(field => ['content', 'interaction', 'historyPreview'].includes(field)));
  assert.equal(envelope.evaluation, undefined); assert.equal(envelope.interactionPreparation, undefined);
}
assert.ok(!JSON.stringify(assistantHistory).includes('PRIVATE_KEY_EXPLANATION_'));
assert.ok(!JSON.stringify(assistantHistory).includes('PRIVATE_LOCAL_RECEIPT'));
assert.equal(responseRequest.thinkingMode, 'disabled'); assert.equal(responseRequest.temperatureOverride, 0.4);
assert.ok(responseRequest.systemPromptOverride!.includes('先精确计算再设计干扰项'));
assert.ok(responseRequest.systemPromptOverride!.includes('本地只按已存答案键核对'));

// Execute the actual legacy history/streamRoleReply AST with a mocked transport,
// preserving its plain-history contract without opening a stream to a provider.
const directorFile = 'src/services/scene/sceneDirector.ts';
const directorSource = ts.createSourceFile(directorFile, readFileSync(directorFile, 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
const legacyDeclarations = ['buildChatHistory', 'streamRoleReply'].map(name => {
  const declaration = directorSource.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(declaration, 'actual legacy declaration ' + name);
  return declaration!.getText(directorSource).replace(/^export\s+/u, '');
});
const legacyCode = ts.transpileModule(legacyDeclarations.join('\n') + '\nreturn streamRoleReply;', {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const legacyRequests: LlmCallRequest[] = [];
const legacyEnvironment = { sceneAnswerFeedbackView,
  buildSceneExperimentMessagePreview: () => { throw new Error('No experiment forms in this legacy fixture'); },
  buildRoleSystemPrompt: () => 'Synthetic legacy role instructions',
  callLLMStream: async (request: LlmCallRequest) => { legacyRequests.push(request);
    return new ReadableStream({ start(controller) { controller.close(); } }); },
};
const legacyReply = new Function(...Object.keys(legacyEnvironment), legacyCode)(...Object.values(legacyEnvironment));
await legacyReply(spec, historyRun);
assert.equal(legacyRequests.length, 1); assert.equal(legacyRequests[0].workflow, 'scene-role-reply');
const legacyAssistant = legacyRequests[0].messages!.filter(message => message.role === 'assistant');
assert.equal(legacyAssistant.length, 2);
assert.ok(legacyAssistant[0].content.includes('[结构化交互]'));
assert.ok(legacyAssistant[0].content.includes('normal-history-action'));
assert.ok(legacyAssistant[1].content.includes('long-history-action'));
assert.throws(() => JSON.parse(legacyAssistant[0].content), 'legacy role replies retain their plain-history contract');
assert.ok(!JSON.stringify(legacyAssistant).includes('PRIVATE_KEY_EXPLANATION_'));
assert.ok(!JSON.stringify(legacyAssistant).includes('PRIVATE_LOCAL_RECEIPT'));
const conflicting = { ...actualCloudShape, understanding: { ...actualCloudShape.understanding, teaching: { progression: 'pause' } } };
const conflict = await invoke(aliasRun, [{ content: '已修复教学指令位置。' }], { understandingReplies: [conflicting, actualCloudShape] });
repairHas(conflict, 'conflicting-teaching-envelope', 'understand');
assert.throws(() => normalizeSceneUnderstandingEnvelope(conflicting), /冲突/);
const forgedAlias = structuredClone(actualCloudShape);
forgedAlias.teaching.policyUpdates[0].source.sourceMessageId = 'older-or-assistant-source';
const forgedSource = await invoke(aliasRun, [], { understandingReplies: [forgedAlias, forgedAlias] });
assert.ok(forgedSource.error); assert.equal(forgedSource.responses, 0, 'a placement alias must not bypass latest-user provenance');
assert.ok(forgedSource.diagnostics.every(diagnostic => diagnostic.phase !== 'respond'));
assert.ok(forgedSource.diagnostics.at(-1)?.issues.some(issue => issue.code === 'invalid-teaching-state'));
assert.equal(JSON.stringify(aliasRun), aliasSnapshot);

// Local preparation is post-validation, occurs once, and ignores forged model
// receipts. A repair must not shuffle once for rejected data and again for valid data.
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
let randomCalls = 0;
Object.defineProperty(globalThis, 'crypto', { configurable: true, value: { getRandomValues: (array: Uint32Array) => {
  randomCalls++; array.fill(0); return array;
} } });
try {
  const ready = state([user('new-control-user', '来一道单选题。')]);
  const forged = { version: 1, interactionId: 'prepared-new', sourceFingerprint: 'FORGED_MODEL_RECEIPT', preparedFingerprint: 'FORGED', orders: [] };
  const value = await invoke(ready, [{ content: 'Invalid missing key', interaction: choice('prepared-new'), interactionPreparation: forged },
    { ...newTask('prepared-new'), interactionPreparation: forged }]);
  repairHas(value, 'invalid-objective-key');
  assert.equal(randomCalls, 1, 'prepare only the accepted output once');
  assert.notEqual(value.result?.interactionPreparation?.sourceFingerprint, forged.sourceFingerprint);
  assert.deepEqual(value.result?.interactionPreparation?.orders[0].ids, ['b', 'a']);
  assert.equal(value.result?.objectiveEvaluation?.type === 'single-choice' && value.result.objectiveEvaluation.correctId, 'b');
} finally {
  if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
  else Reflect.deleteProperty(globalThis, 'crypto');
}

// Structured diagnostics keep protocol facts and token metadata, not the raw
// reply, answer key, private task ID, transport headers, or provider error text.
const secrets = ['PRIVATE_RESPONSE_BODY', 'PRIVATE_PROVIDER_ERROR', 'PRIVATE_AUTH_HEADER', 'PRIVATE_KEY_EXPLANATION_'];
const malformed = await invoke(pendingRun(), ['PRIVATE_RESPONSE_BODY invalid JSON', { content: '已修复，继续提示。' }]);
repairHas(malformed, 'invalid-json');
assert.ok(!JSON.stringify(malformed.diagnostics).includes('PRIVATE_RESPONSE_BODY'));
const transport = await invoke(pendingRun(), [{ throwMessage: 'PRIVATE_PROVIDER_ERROR PRIVATE_AUTH_HEADER' }]);
assert.ok(transport.error); assert.equal(transport.diagnostics.at(-1)?.outcome, 'failed');
assert.ok(secrets.every(secret => !JSON.stringify(transport.diagnostics).includes(secret)));
const normalized = normalizeSceneTurnAttemptDiagnostic({ phase: 'respond', attempt: 1, outcome: 'rejected', inputKind: 'conversation',
  hasSubmittedAnswer: false, hasPendingTask: true, issues: [{ code: 'invalid-json', path: 'response' }],
  requestedInteractionType: 'private_note_slug', finishReason: 'private_reason_slug', content: 'PRIVATE_RESPONSE_BODY',
  evaluation: key('private-task-id'), apiKey: 'PRIVATE_AUTH_HEADER', promptTokens: 7, completionTokens: 9 });
assert.ok(normalized); assert.equal(normalized!.promptTokens, 7); assert.equal(normalized!.completionTokens, 9);
assert.ok(!JSON.stringify(normalized).includes('private_note_slug'), 'unknown model type must be classified, not logged verbatim');
assert.ok(!JSON.stringify(normalized).includes('private_reason_slug'), 'unknown provider finish reason must be classified');
assert.ok(secrets.every(secret => !JSON.stringify(normalized).includes(secret)));
const diagnostic = sceneTurnAttemptDiagnostic({ phase: 'respond', attempt: 1, outcome: 'accepted', run: pendingRun(),
  envelope: { content: 'PRIVATE_RESPONSE_BODY', interaction: choice('private-task-id'), evaluation: key('private-task-id') },
  response: { content: 'PRIVATE_RESPONSE_BODY', diagnostics: { finishReason: 'stop', reasoningTokens: 4, hadReasoningContent: true } },
  request: { maxTokensOverride: 1024 } });
assert.equal(diagnostic.reasoningTokens, 4); assert.equal(diagnostic.hadReasoningContent, true);
assert.ok(!JSON.stringify(diagnostic).includes('private-task-id'));
assert.ok(secrets.every(secret => !JSON.stringify(diagnostic).includes(secret)));
const hostileSink = await invoke(pendingRun(), [{ content: '诊断记录失败不能破坏合法回应。' }], { sinkThrows: true });
assert.equal(hostileSink.error, undefined);
const rejected = await invoke(pendingRun(), [{ content: 'Bad one', interaction: { ...choice('x'), assessment: undefined } },
  { content: 'Bad two', interaction: { ...choice('y'), assessment: undefined } }]);
assert.ok(rejected.error instanceof SceneTurnProtocolError);
assert.equal((rejected.error as SceneTurnProtocolError).attempts.length, 2);
assert.ok(secrets.every(secret => !JSON.stringify((rejected.error as SceneTurnProtocolError).attempts).includes(secret)));

// A single real core-service session: answer -> discuss/new task -> answer ->
// discuss only. The second answer still matches its locally prepared key by ID.
let session = state([task('session-first'), answer('session-first')]); session.turnCount = 1;
async function commit(replies: Reply[]) {
  const value = await invoke(session, replies);
  assert.equal(value.error, undefined); assert.ok(value.result);
  const result = value.result!;
  session = { ...session, teachingState: result.teachingState, workingMemory: result.workingMemory,
    messages: [...session.messages, { id: 'assistant-' + session.messages.length, speakerType: 'role', speakerName: 'Tutor',
      timestamp: stamp, content: result.content, interaction: result.interaction, objectiveEvaluation: result.objectiveEvaluation,
      interactionPreparation: result.interactionPreparation, discussionInteractionId: result.discussionInteractionId }] };
  return value;
}
await commit([{ content: '这次核对不正确，先讨论百分比基数。' }]);
assert.equal(getPendingSceneInteraction(session), undefined);
session.messages.push(user('session-discuss-one', '解释一下基数，再给我一道单选检验。'));
await commit([newTask('session-second')]);
assert.equal(getPendingSceneInteraction(session)?.interaction?.id, 'session-second');
session.messages.push(answer('session-second', 'b')); session.turnCount++;
await commit([{ content: '正确，先停在这里，等你决定下一步。', taskUpdate: null }]);
assert.equal(getPendingSceneInteraction(session), undefined);
session.messages.push(user('session-discuss-two', '我对刚才的理由还有一个问题，先讨论，不出新题。'));
await commit([{ content: '可以，我们继续讨论刚才的理由。' }]);
assert.equal(getPendingSceneInteraction(session), undefined);
assert.equal(session.turnCount, 2);
assert.deepEqual(collectSceneAnswerRecords(session).map(record => record.objectiveGrade?.correct), [false, true]);
console.log('Scene turn stability passed: no-op/echo normalization, source-bound replacement repair, semantic action guards, post-validation preparation, redacted diagnostics and one-session answer/discussion continuity. Offline synthetic decisions, not browser or cloud-model evidence.');
