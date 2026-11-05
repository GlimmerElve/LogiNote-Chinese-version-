import assert from 'node:assert/strict';
import type { SceneMessage, SceneRunState, SceneSpec, SceneTeachingDirective, SceneTeachingInstructionUpdate } from '../src/types';
import { buildSceneTeachingContext, finalizeSceneTeachingState, resolveSceneTeachingState, sceneAnswerFeedbackView } from '../src/services/scene/sceneTeaching';
import { readSceneTeachingPolicyUpdates, resolveSceneTeachingConditionalPolicy } from '../src/services/scene/sceneTeachingPolicy';
import { readSceneUnderstanding } from '../src/services/scene/sceneUnderstanding';
import { fitSceneContextBudget } from '../src/services/scene/sceneContextBudget';
import { understandingFixture } from './scene-semantic-fixture';

globalThis.fetch = async () => assert.fail('Conditional teaching checks are strictly offline');
const stamp = '2026-10-16T00:00:00.000Z';
const spec = {
  sceneId: 'conditional-session', meta: { name: 'Synthetic conditional teaching', sceneSkill: 'S1', goal: 'Adaptive teaching', knowledgePoints: [] },
  task: 'Single choice is an answer control, not a fixed teaching workflow', role: { name: 'Tutor', attributes: [] },
  resources: [], rules: [], metrics: [], events: [], completion: { mode: 'signal', maxTurns: 100 },
  capabilityIds: ['single-choice'], promptModuleIds: ['structured-interaction', 'turn-agent-planning'],
  runtimeContract: { answerFeedback: { correctness: 'immediate', explanation: 'immediate' }, allowedTools: [],
    allowedInteractionTypes: ['single-choice'], scope: { noteIds: [], documentIds: [], cognitionRecordIds: [] } },
} as unknown as SceneSpec;
const deferred = { ...spec, runtimeContract: { ...spec.runtimeContract!,
  answerFeedback: { correctness: 'at-end' as const, explanation: 'at-end' as const } } };
const user = (id: string, content: string): SceneMessage => ({ id, content, speakerType: 'user', speakerName: 'User', timestamp: stamp, inputKind: 'conversation' });
function task(id: string): SceneMessage {
  return { id: 'task-' + id, content: 'Synthetic ratio question ' + id, speakerType: 'role', speakerName: 'Tutor', timestamp: stamp,
    interaction: { id, type: 'single-choice', assessment: 'objective', required: true, options: [{ id: 'a', label: '16' }, { id: 'b', label: '24' }] },
    objectiveEvaluation: { interactionId: id, type: 'single-choice', correctId: 'b', explanation: 'PRIVATE_REASON_' + id } };
}
function answer(id: string, correct: boolean): SceneMessage {
  return { ...user('answer-' + id, correct ? '选择24' : '选择16'), inputKind: 'response',
    interactionResponse: { interactionId: id, type: 'single-choice', selectedId: correct ? 'b' : 'a', submittedAt: stamp } };
}
function run(messages: SceneMessage[] = []): SceneRunState {
  return { runId: 'conditional-run', sceneId: spec.sceneId, sceneName: spec.meta.name, startedAt: stamp,
    status: 'running', turnCount: 0, metrics: [], events: [], messages };
}
function understand(value: SceneRunState, teaching?: SceneTeachingDirective, evaluationRequested = false) {
  const latest = value.messages.findLast(message => message.speakerType === 'user')!;
  return readSceneUnderstanding(understandingFixture(latest.id, latest.content, {
    intent: latest.interactionResponse ? 'answer' : 'follow-up', evaluationRequested, ...(teaching ? { teaching } : {}),
  }), new Map(value.messages.map(message => [message.id, message.content])), latest.id);
}
function update(value: SceneRunState, policy: Omit<SceneTeachingInstructionUpdate, 'source'>): SceneTeachingDirective {
  const latest = value.messages.findLast(message => message.speakerType === 'user')!;
  return { policyUpdates: [{ ...policy, source: { sourceMessageId: latest.id, quote: latest.content } }] };
}
function commit(value: SceneRunState, teaching?: SceneTeachingDirective, scene = spec): SceneRunState {
  return { ...value, teachingState: finalizeSceneTeachingState(undefined, scene, value, understand(value, teaching)) };
}
const conditional: Omit<SceneTeachingInstructionUpdate, 'source'> = {
  id: 'feedback-by-outcome', action: 'set', scope: 'session', instruction: '答对简短确认不解析，答错解释；主动追问可讲。',
  // Deliberately shuffled: matching priority must not depend on array order.
  rules: [{ when: 'on-request', explanation: 'immediate', responseStyle: 'explanation' },
    { when: 'incorrect', correctness: 'immediate', explanation: 'immediate', responseStyle: 'explanation' },
    { when: 'any', correctness: 'immediate', explanation: 'at-end', responseStyle: 'agent-decides' },
    { when: 'correct', explanation: 'on-request', responseStyle: 'brief-confirmation' }],
};
const originalText = '以后答对只简短确认，不解析；答错仍解释，我主动追问再讲。';
let persistent = run([user('instruction-original', originalText)]);
persistent = commit(persistent, update(persistent, conditional));
const specSnapshot = JSON.stringify(spec);
assert.equal(persistent.teachingState?.activeInstructions?.[0].source.quote, originalText);

// Persistent typed instructions are not summaries in a six-turn history window.
for (let index = 1; index <= 24; index++) {
  const id = 'round-' + index, correct = index % 2 === 0;
  persistent = { ...persistent, turnCount: index, messages: [...persistent.messages, task(id), answer(id, correct)] };
  persistent = commit(persistent);
  const feedback = sceneAnswerFeedbackView(spec, persistent, 'answer-' + id)!;
  assert.equal(feedback.correct, correct);
  assert.equal(Boolean(feedback.explanation), !correct, 'only incorrect answers receive automatic private explanations');
  const context = buildSceneTeachingContext(spec, persistent);
  assert.equal(context.discussion?.feedbackPolicy.responseStyle, correct ? 'brief-confirmation' : 'explanation');
  assert.equal(context.activeInstructions?.[0].source.sourceMessageId, 'instruction-original');
  if (index === 8 || index === 21) {
    // Stronger than optional-context pruning: remove the original source from
    // retained message history, keeping the locally validated policy receipt.
    persistent = { ...persistent, messages: persistent.messages.slice(-4) };
    assert.ok(!persistent.messages.some(message => message.id === 'instruction-original'));
    const protectedContext = buildSceneTeachingContext(spec, persistent);
    assert.equal(protectedContext.activeInstructions?.[0].source.quote, originalText);
    const fitted = fitSceneContextBudget({ providerId: '', model: '', workflow: 'scene-turn-plan',
      systemPromptOverride: 'Respect the protected teaching instructions.', maxTokensOverride: 512,
      userInput: JSON.stringify({ teachingContext: protectedContext, recentInteraction: ['X'.repeat(18000)] }),
      sceneOptionalJsonFields: ['recentInteraction'], messages: [{ role: 'user', content: 'Y'.repeat(18000) }] },
    { provider: { contextWindowTokens: 16384 } });
    assert.deepEqual(JSON.parse(fitted.request.userInput).teachingContext, JSON.parse(JSON.stringify(protectedContext)));
    assert.equal(JSON.parse(fitted.request.userInput).recentInteraction, undefined);
  }
}
assert.equal(JSON.stringify(spec), specSnapshot, 'teaching policy cannot alter tools, data scope, answer controls, or scene configuration');

// An explanation request is local and different from merely asking whether an
// answer was correct. It never changes the stored session rule.
const asked = { ...persistent, messages: [...persistent.messages, user('explain-current', '这道已答题我想听一下为什么。')] };
const explanation = understand(asked, { explanationRequested: true });
assert.ok(sceneAnswerFeedbackView(spec, asked, 'answer-round-24', explanation)?.explanation);
assert.equal(sceneAnswerFeedbackView(spec, asked, 'answer-round-22', explanation)?.explanation, undefined);
assert.equal(buildSceneTeachingContext(spec, asked, explanation).discussion?.feedbackPolicy.responseStyle, 'explanation');
assert.deepEqual(resolveSceneTeachingState(spec, asked, explanation).activeInstructions, persistent.teachingState?.activeInstructions);
const evaluated = { ...persistent, messages: [...persistent.messages, user('evaluate-current', '只告诉我刚才答得对不对，不用讲解析。')] };
assert.equal(sceneAnswerFeedbackView(spec, evaluated, 'answer-round-24', understand(evaluated, undefined, true))?.explanation, undefined);

// Negative/quoted synthetic semantic decisions carry no policy mutation. These
// are plumbing fixtures, not proof of real-model negation comprehension.
for (const text of ['别人说“答对不用讲”，我并没有这个要求。', '不要改成答对不讲，我是在引用一个例子。']) {
  const negative = { ...persistent, messages: [...persistent.messages, user('negative-' + text.length, text)] };
  assert.deepEqual(resolveSceneTeachingState(spec, negative, understand(negative)).activeInstructions, persistent.teachingState?.activeInstructions);
}

// Current semantic requests alone cannot unlock a separately sourced at-end
// requirement. A newer explicit instruction replaces older conditional rules.
const lockedInput = { ...persistent, messages: [...persistent.messages, user('lock-feedback', '改一下，这局所有对错和解析都最后再给，取消刚才的条件区别。')] };
const lock = { ...conditional, instruction: '本局所有结果最后公开', rules: [{ when: 'any' as const, correctness: 'at-end' as const, explanation: 'at-end' as const }] };
const locked = commit(lockedInput, update(lockedInput, lock));
const follow = { ...locked, messages: [...locked.messages, user('ask-without-revoke', '继续说说这一题。')] };
assert.equal(sceneAnswerFeedbackView(spec, follow, 'answer-round-24', understand(follow, { explanationRequested: true })), undefined);
assert.equal(locked.teachingState?.activeInstructions?.length, 1);
assert.equal(locked.teachingState?.activeInstructions?.[0].source.sourceMessageId, 'lock-feedback');
const revokedInput = { ...locked, messages: [...locked.messages, user('revoke-feedback', '撤销本局所有结果最后公开的要求，恢复原来的默认反馈。')] };
const revoked = commit(revokedInput, update(revokedInput, { id: conditional.id, action: 'revoke', scope: 'session' }));
assert.equal(revoked.teachingState?.activeInstructions?.length, 0);
assert.equal(revoked.teachingState?.instructionChanges?.at(-1)?.source.sourceMessageId, 'revoke-feedback');
assert.ok(sceneAnswerFeedbackView(spec, revoked, 'answer-round-24')?.explanation);

// Newer explicit sources win over an older instruction's more-specific rule.
const priority = resolveSceneTeachingConditionalPolicy({ correctness: 'immediate', explanation: 'immediate' }, [
  persistent.teachingState!.activeInstructions![0],
  { id: 'newer', scope: 'session', instruction: 'Delay all results', rules: lock.rules,
    source: { sourceMessageId: 'newer-user', quote: 'Delay all results' }, acceptedOrder: 2 },
], { interactionId: 'round-24', outcome: 'correct', explanationRequested: true, currentUserMessageId: 'newer-user' });
assert.equal(priority.explanation, 'at-end');

// Task is local even when bound before an answer; no unsubmitted answer key is
// exposed. The next task continues under the untouched session defaults.
let local = run([task('local'), user('local-policy', '仅这题答对不用解析，下一题照常。')]);
local = commit(local, update(local, { ...conditional, id: 'local-only', scope: 'task', interactionId: 'local' }));
assert.equal(sceneAnswerFeedbackView(spec, local, 'missing-answer'), undefined);
assert.ok(!JSON.stringify(buildSceneTeachingContext(spec, local)).includes('PRIVATE_REASON_local'));
local = commit({ ...local, messages: [...local.messages, answer('local', true)] });
assert.equal(sceneAnswerFeedbackView(spec, local, 'answer-local')?.explanation, undefined);
local = commit({ ...local, messages: [...local.messages, task('after-local'), answer('after-local', true)] });
assert.ok(sceneAnswerFeedbackView(spec, local, 'answer-after-local')?.explanation);

// Review snapshots only currently answered tasks and expires on the next user
// input, rather than becoming a permanent session or task disclosure override.
let review = run([task('review-wrong'), answer('review-wrong', false), task('review-right'), answer('review-right', true),
  user('review-now', '只在这次把当前错题讲讲，后面仍最后分析。')]);
const reviewDirective = update(review, { id: 'review-once', action: 'set', scope: 'review', target: 'incorrect',
  rules: [{ when: 'any', correctness: 'immediate', explanation: 'immediate', responseStyle: 'explanation' }] });
const reviewUnderstanding = understand(review, reviewDirective);
assert.ok(sceneAnswerFeedbackView(deferred, review, 'answer-review-wrong', reviewUnderstanding)?.explanation);
assert.equal(sceneAnswerFeedbackView(deferred, review, 'answer-review-right', reviewUnderstanding), undefined);
review = commit(review, reviewDirective, deferred);
assert.deepEqual(review.teachingState?.activeInstructions?.[0].interactionIds, ['review-wrong']);
review = { ...review, messages: [...review.messages, user('after-review', '继续下一步。')] };
assert.equal(sceneAnswerFeedbackView(deferred, review, 'answer-review-wrong'), undefined);
assert.equal(resolveSceneTeachingState(deferred, review).activeInstructions?.length, 0);

// Old feedback fields and the new conditional strategy share a stable local
// acceptance clock, not positions in optional/pruned message history.
let crossed = run([task('crossed'), answer('crossed', true), user('old-local', '先只把这道题的解析现在给我。')]);
crossed = commit(crossed, { feedback: { scope: 'task', interactionId: 'crossed', correctness: 'immediate', explanation: 'immediate' } });
assert.equal(crossed.teachingState?.taskFeedback?.[0].acceptedOrder, 1);
crossed = { ...crossed, messages: [...crossed.messages, user('new-session', '改为本局所有结果最后公开，先不要继续展示这题解析。')] };
crossed = commit(crossed, update(crossed, { id: 'global-late', action: 'set', scope: 'session', rules: lock.rules }));
assert.equal(crossed.teachingState?.activeInstructions?.[0].acceptedOrder, 2);
assert.equal(sceneAnswerFeedbackView(spec, crossed, 'answer-crossed'), undefined, 'new session overrides old local feedback');
crossed = { ...crossed, messages: crossed.messages.filter(message => message.id !== 'old-local') };
assert.equal(sceneAnswerFeedbackView(spec, crossed, 'answer-crossed'), undefined, 'priority survives removal of the old source from history');
crossed = { ...crossed, messages: [...crossed.messages, user('new-local', '但这道已答题现在给我解析，其他题仍最后公开。')] };
const newerLocal: SceneTeachingDirective = { feedback: { scope: 'task', interactionId: 'crossed', correctness: 'immediate', explanation: 'immediate' } };
crossed = commit(crossed, newerLocal);
assert.equal(crossed.teachingState?.policyOrder, 3);
assert.ok(sceneAnswerFeedbackView(spec, crossed, 'answer-crossed')?.explanation, 'new local request overrides older global rule only for its task');
crossed = commit(crossed, newerLocal);
assert.equal(crossed.teachingState?.policyOrder, 3, 'replaying the same verified request is idempotent');
crossed = { ...crossed, messages: [...crossed.messages, user('newer-global', '再次统一改为全部结果最后公开。')] };
crossed = commit(crossed, { feedback: { scope: 'session', correctness: 'at-end', explanation: 'at-end' } });
assert.equal(crossed.teachingState?.feedbackSource?.acceptedOrder, 4);
assert.equal(sceneAnswerFeedbackView(spec, crossed, 'answer-crossed'), undefined, 'new legacy session change also overrides older conditional and local sources');
crossed = { ...crossed, messages: [...crossed.messages, user('same-source-exception', '本局都最后公开，但仅这道题现在讲解。')] };
crossed = commit(crossed, { ...update(crossed, { id: 'global-late', action: 'set', scope: 'session', rules: lock.rules }),
  feedback: { scope: 'task', interactionId: 'crossed', correctness: 'immediate', explanation: 'immediate' } });
assert.equal(crossed.teachingState?.policyOrder, 5);
assert.equal(crossed.teachingState?.activeInstructions?.find(item => item.id === 'global-late')?.acceptedOrder, 5);
assert.equal(crossed.teachingState?.taskFeedback?.[0].acceptedOrder, 5);
assert.ok(sceneAnswerFeedbackView(spec, crossed, 'answer-crossed')?.explanation, 'same-source task exception is more specific than session');
const legacy = run([task('legacy'), answer('legacy', true), user('migrate-source', '从现在起全部结果最后公开。')]);
legacy.teachingState = { notes: [], taskFeedback: [{ interactionId: 'legacy', correctness: 'immediate', explanation: 'immediate',
  sourceMessageId: 'pruned-legacy-source', quote: 'Old task feedback' }] };
const migrated = commit(legacy, update(legacy, { id: 'new-global', action: 'set', scope: 'session', rules: lock.rules }));
assert.equal(migrated.teachingState?.policyOrder, 1);
assert.equal(sceneAnswerFeedbackView(spec, migrated, 'answer-legacy'), undefined, 'unversioned old state is order zero, not a permanent overriding exception');

// Provenance, scope and capacity fail closed without changing the input state.
const badSource = update(asked, conditional);
badSource.policyUpdates![0].source.sourceMessageId = 'instruction-original';
assert.throws(() => resolveSceneTeachingState(spec, asked, understand(asked, badSource)), /最新真实用户/);
const assistantSource = { ...badSource, policyUpdates: [{ ...badSource.policyUpdates![0], source: { sourceMessageId: 'task-round-24', quote: 'Synthetic ratio' } }] };
assert.throws(() => resolveSceneTeachingState(spec, asked, understand(asked, assistantSource)), /最新真实用户/);
const answerInjection = update(persistent, conditional);
assert.throws(() => resolveSceneTeachingState(spec, persistent, understand(persistent, answerInjection)), /选择答案/);
assert.throws(() => readSceneTeachingPolicyUpdates([{ ...conditional, allowedTools: ['model-experiment'], source: { sourceMessageId: 'x', quote: 'x' } }]), /字段/);
assert.throws(() => readSceneTeachingPolicyUpdates([{ ...conditional, rules: [{ when: ['correct'], explanation: 'immediate' }], source: { sourceMessageId: 'x', quote: 'x' } }]), /条件/);
const unknownRevoke = update(asked, { id: 'unknown', action: 'revoke', scope: 'session' });
assert.throws(() => resolveSceneTeachingState(spec, asked, understand(asked, unknownRevoke)), /已知/);
let capacity = run();
for (let index = 0; index < 8; index++) {
  capacity = { ...capacity, messages: [...capacity.messages, user('capacity-' + index, '本局保留要求 ' + index)] };
  capacity = commit(capacity, update(capacity, { id: 'instruction-' + index, action: 'set', scope: 'session', instruction: 'Scoped requirement ' + index }));
}
capacity = { ...capacity, messages: [...capacity.messages, user('capacity-overflow', '再添加一项，不要丢弃旧要求。')] };
const before = JSON.stringify(capacity);
assert.throws(() => resolveSceneTeachingState(spec, capacity, understand(capacity,
  update(capacity, { id: 'ninth', action: 'set', scope: 'session', instruction: 'Ninth requirement' }))), /超过8项/);
assert.equal(JSON.stringify(capacity), before);
assert.equal(capacity.teachingState?.activeInstructions?.length, 8);
assert.equal(JSON.stringify(spec), specSnapshot);
console.log('Scene conditional teaching checks passed: 24 answer rounds, history pruning, sourced updates/revocation, outcome/request priority, task/review isolation and permission/capacity guards. Synthetic semantic fixtures, not a cloud semantic evaluation.');
