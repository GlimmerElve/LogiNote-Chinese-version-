import assert from 'node:assert/strict';
import { masteryBaselineFixture, masteryComparisonFixture } from './fixtures/mastery-baselines';
import type { NoteItem, ReviewAnalysis, UserProfile } from '../src/types';
import type { ReviewEpisodeCapture } from '../src/services/memory/types';
import { freezeReviewAssessment } from '../src/services/reviewAssessment';
import { prepareReviewComparisonSession } from '../src/services/reviewComparison/session';
import { planReviewMastery, evaluateReviewMastery, recheckReviewMasteryReferences, applyReviewMasteryBatch } from '../src/services/masteryShadow/review';
import { prepareReviewExitOutcome } from '../src/services/ui/reviewExitWrite';
import { createMasteryShadowState } from '../src/services/masteryShadow/stateMachine';
import { readKnowledgeMastery } from '../src/services/masteryReadModel';
import { buildPlanPersonalizationPolicy } from '../src/services/memory/planPersonalization';
import { buildHomeViewModel } from '../src/services/homepage/homepageViewModel';
import { buildKnowledgeReviewCandidates } from '../src/services/reviewScheduler';
import { getNoteMasteryBand } from '../src/services/knowledgeGraphModel';
import { splitUserStateFields, splitSharableFields, serializeUserStateFile, deserializeUserStateFile, mergeNote } from '../src/services/userStateService';
import { extractReviewEvidence } from '../src/services/memory/evidenceExtractor';
import { applyProfileEvidenceGate } from '../src/services/profile/evidenceGateCore';
import { setMasteryLayerFixture } from './fixtures/mastery-evidence';

globalThis.fetch = async () => assert.fail('This test must never access the network or real vault');
const at = '2026-10-18T01:00:00Z';
function knowledge(id: string): NoteItem {
  return { id, title: id, content: `${id}是意识到受到观察后，行为可能发生改变；它不等于干预本身有效。`, noteType: 'knowledge',
    tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at,
    dsrState: { difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 0,
      consecutiveCorrect: 0, consecutiveWrong: 0, conceptMastery: 99, conceptMasterySamples: 3 } };
}
const notes: NoteItem[] = [{ ...knowledge('project'), noteType: 'project', links: ['效应甲', '效应乙'] }, knowledge('效应甲'), knowledge('效应乙')];
const unchanged = JSON.stringify(notes);
function episode(id: string, hintLevel: 0 | 1 = 0): ReviewEpisodeCapture {
  const names = ['效应甲'];
  const questions = ['请解释效应甲的核心含义和限定。', '再用自己的话说明效应甲的含义。'];
  const answers = ['人意识到被观察后，行为可能改变，但不能据此证明干预有效。', '被关注可能改变表现，需要排除这种影响，不能和干预效果混在一起。'];
  return { id, startedAt: at, endedAt: at, questionText: questions[0], knowledgeContext: '', masteryEligible: true,
    messages: questions.flatMap((content, index) => [{ id: `q${index}`, role: 'assistant' as const, content, timestamp: at },
      { id: `a${index}`, role: 'user' as const, content: answers[index], timestamp: at }]),
    answerEvidence: answers.map((answer, index) => ({ messageId: `a${index}`, answer, hintLevel, targetKnowledgeNames: names,
      questionIntent: { version: 1, questionMessageId: `q${index}`, knowledgeTargets: names, assessment: freezeReviewAssessment('definition', names) } })) };
}
const analysis: ReviewAnalysis = { accuracyScore: 90, completenessScore: 80, logicScore: 80, relevanceScore: 85,
  overallRating: 'good', feedback: '', suggestion: '', missingKnowledge: [] };
const dependencies = (snapshot: NoteItem[]) => ({ readNotes: async () => structuredClone(snapshot),
  loadCognition: async () => { assert.fail('No cognition target or personal graph is needed for mastery'); },
  searchNotes: async () => [], searchDocuments: async () => [], previewDocument: async () => { throw new Error('No external fixture'); } });
async function evaluated(snapshot: NoteItem[], capture: ReviewEpisodeCapture, verdict: 'pass' | 'fail' | 'not_observed' = 'pass') {
  const session = await prepareReviewComparisonSession(capture, dependencies(snapshot), { targetScopeNoteIds: ['效应甲', '效应乙'] });
  const planned = planReviewMastery(snapshot, 'project', capture, session);
  assert.equal(planned.items.length, 1, 'same-target same-session rounds are one independent sample');
  assert.deepEqual(planned.items[0].input.task.requiredLayers, ['concept']);
  const batch = await evaluateReviewMastery(planned, async ({ userInput }) => {
    const input = JSON.parse(userInput);
    assert.ok(input.answer.includes(capture.answerEvidence![0].answer));
    assert.ok(!userInput.includes('personal') && !userInput.includes('conceptMastery'), 'no cognition graph or old scores as grading references');
    return { protocol: 'mastery-shadow-evaluator-v1', evaluationId: input.evaluationId, knowledgePointId: input.knowledgePointId,
      evidence: [{ id: 'E1', quote: capture.answerEvidence![0].answer }], baselines: masteryBaselineFixture(input),
      criteria: input.criteria.map((criterion: { id: string }) => ({ id: criterion.id, state: verdict, evidenceIds: ['E1'],
        comparison: verdict === 'fail' ? masteryComparisonFixture(input, criterion.id, ['E1']) : undefined,
        referenceIds: input.references.map((reference: { id: string }) => reference.id),
        referenceQuotes: input.references.slice(0, 3).map((reference: { id: string; quote: string }) => ({ referenceId: reference.id, quote: reference.quote.slice(0, 180) })),
        reason: '本次原话与给定参考的对应要求核对。' })), summary: '仅评价本次概念要求。' };
  });
  return recheckReviewMasteryReferences(batch, dependencies(snapshot));
}
const first = episode('session-1');
first.masteryAssessment = await evaluated(notes, first);
const firstOutcome = prepareReviewExitOutcome(notes, { noteId: 'project', noteTitle: 'project', analysis, segmentMastery: [], episode: first });
const noOldScores = prepareReviewExitOutcome(notes, { noteId: 'project', noteTitle: 'project', analysis: null, segmentMastery: [], episode: first });
assert.deepEqual(noOldScores.notes, firstOutcome.notes, 'current mastery and memory scheduling never require retired four-score analysis');
const signals = extractReviewEvidence({ episodeId: first.id, observedAt: at, messages: first.messages, analysis: null,
  knowledgePoints: ['效应甲'], masteryEvaluations: noOldScores.masteryEvaluations }).profileSignals;
assert.deepEqual(signals.filter(signal => signal.dimension === 'ability').map(signal => signal.indicator), ['conceptClarity']);
assert.ok(signals.filter(signal => signal.dimension === 'ability').every(signal => signal.rubricVersion === 'review-criteria-v2'));
const profileFixture = { analysisCount: 0, updatedAt: at,
  ability: { conceptClarity: 50, judgmentReasonableness: 50, reasoningValidity: 50, evidenceCount: 0, evidenceChars: 0 },
  cognitiveStyle: {}, learningAbility: { domains: [] }, evidenceGate: { version: 1, processedEpisodeIds: [], aggregates: {} } } as unknown as UserProfile;
const gated = applyProfileEvidenceGate(profileFixture, { episodeId: first.id, signals, sampleChars: 300 });
assert.ok(gated.profile.evidenceGate!.aggregates['ability:conceptClarity:review-criteria-v2'], 'new criterion quality occupies its own profile cohort');
assert.equal(gated.profile.ability.conceptClarity, 50, 'one new sample cannot replace the long-term profile');
const nextSignals = signals.filter(signal => signal.dimension === 'ability').map(signal => ({ ...signal, sourceEpisodeId: 'profile-next', value: 0 }));
const changedGate = applyProfileEvidenceGate(gated.profile, { episodeId: 'profile-next', signals: nextSignals, sampleChars: 300 });
assert.equal(changedGate.profile.evidenceGate!.aggregates['ability:conceptClarity:review-criteria-v2'].status, 'trusted', 'valid progress/regression is not rejected merely for spanning the quality scale');
assert.ok(Math.abs(changedGate.profile.ability.conceptClarity - 50) <= 6, 'existing bounded profile smoothing remains active');
const a = (snapshot: NoteItem[]) => snapshot.find(note => note.id === '效应甲')!;
assert.equal(a(firstOutcome.notes).dsrState!.masteryShadow!.layers.concept.state, 'provisional');
assert.equal(a(firstOutcome.notes).dsrState!.masteryShadow!.layers.concept.criteria!.concept_accuracy.independentPasses, 1);
assert.equal(a(firstOutcome.notes).dsrState!.masteryShadow!.layers.concept.criteria!.concept_accuracy.state, 'confirmed', 'a sufficient independent definition confirms meaning once, not the entire layer');
assert.equal(a(firstOutcome.notes).dsrState!.masteryShadow!.layers.concept.criteria!.concept_application.state, 'unassessed', 'unasked application is never manufactured');
assert.equal(a(firstOutcome.notes).dsrState!.masteryShadow!.layers.judgment.state, 'unassessed');
assert.equal(a(firstOutcome.notes).dsrState!.conceptMastery, 99, 'old percentage is read-only history');
assert.equal(a(firstOutcome.notes).dsrState!.reviewCount, 1);
assert.equal(firstOutcome.notes.find(note => note.id === '效应乙'), notes[2], 'uncovered siblings are not scored or scheduled');
const replay = prepareReviewExitOutcome(firstOutcome.notes, { noteId: 'project', noteTitle: 'project', analysis, segmentMastery: [], episode: first });
assert.deepEqual(replay.notes, firstOutcome.notes, 'persistent observation and memory receipts suppress repeated save');
const privateState = deserializeUserStateFile(serializeUserStateFile({ '效应甲': splitUserStateFields(a(firstOutcome.notes)) }));
const reloaded = notes.map(note => note.id === '效应甲' ? mergeNote(splitSharableFields(note), privateState[note.id]) : note);
const reloadedReplay = prepareReviewExitOutcome(reloaded, { noteId: 'project', noteTitle: 'project', analysis, segmentMastery: [], episode: first });
assert.deepEqual(reloadedReplay.notes, reloaded, 'reload preserves both mastery and memory idempotence');
assert.ok(!JSON.stringify(splitSharableFields(a(firstOutcome.notes))).includes('masteryShadow'), 'private mastery must not leak into shareable note content');
assert.ok(extractReviewEvidence({ episodeId: first.id, observedAt: at, messages: first.messages, analysis,
  knowledgePoints: ['效应甲'] }).profileSignals.every(signal => signal.dimension !== 'knowledge_mastery'), 'overall scores are not smuggled back into mastery via memory');

const second = episode('session-2');
second.masteryAssessment = await evaluated(firstOutcome.notes, second);
let secondOutcome = prepareReviewExitOutcome(firstOutcome.notes, { noteId: 'project', noteTitle: 'project', analysis, segmentMastery: [], episode: second });
assert.equal(a(secondOutcome.notes).dsrState!.masteryShadow!.layers.concept.state, 'provisional', 'repeated definitions cannot certify application');
assert.equal(a(secondOutcome.notes).dsrState!.masteryShadow!.layers.concept.criteria!.concept_accuracy.state, 'confirmed');
for (const id of ['application-1', 'application-2']) {
  const application = episode(id);
  application.messages = application.messages.map(message => message.role === 'assistant' ? { ...message, content: '请举一个应用该效应的课堂实例。' }
    : { ...message, content: '老师在场观察时学生更认真，这种变化不一定来自教学方法本身，需作对照。' });
  application.answerEvidence = application.answerEvidence!.map((row, index) => ({ ...row,
    answer: application.messages[index * 2 + 1].content,
    questionIntent: { ...row.questionIntent!, assessment: freezeReviewAssessment('example', ['效应甲']) } }));
  application.masteryAssessment = await evaluated(secondOutcome.notes, application);
  secondOutcome = prepareReviewExitOutcome(secondOutcome.notes, { noteId: 'project', noteTitle: 'project', analysis: null, episode: application });
}
assert.equal(a(secondOutcome.notes).dsrState!.masteryShadow!.layers.concept.state, 'confirmed');
assert.equal(readKnowledgeMastery(a(secondOutcome.notes)).confirmedLevel, 1, 'higher levels are not inferred');
assert.equal(secondOutcome.masteredCount, 0, 'concept-only is not a full three-layer confirmation');
const third = episode('session-3');
third.masteryAssessment = await evaluated(secondOutcome.notes, third, 'fail');
const pending = applyReviewMasteryBatch(secondOutcome.notes, 'project', third);
assert.equal(a(pending.notes).dsrState!.masteryShadow!.layers.concept.state, 'confirmed', 'one natural failure retains old confirmation');
assert.equal(readKnowledgeMastery(a(pending.notes)).reviewCategory, 'verify');
const fourth = episode('session-4');
fourth.masteryAssessment = await evaluated(pending.notes, fourth, 'fail');
assert.equal(a(applyReviewMasteryBatch(pending.notes, 'project', fourth).notes).dsrState!.masteryShadow!.layers.concept.state, 'needs_review');

const hinted = episode('hinted', 1);
hinted.masteryAssessment = await evaluated(notes, hinted);
const assisted = applyReviewMasteryBatch(notes, 'project', hinted);
assert.equal(a(assisted.notes).dsrState!.masteryShadow!.layers.concept.state, 'provisional');
assert.equal(a(assisted.notes).dsrState!.masteryShadow!.layers.concept.independentPasses, 0, 'hinted passes cannot confirm');
const none = episode('not-observed');
none.masteryAssessment = await evaluated(secondOutcome.notes, none, 'not_observed');
assert.deepEqual(a(applyReviewMasteryBatch(secondOutcome.notes, 'project', none).notes).dsrState!.masteryShadow!.layers,
  a(secondOutcome.notes).dsrState!.masteryShadow!.layers, 'not observed does not degrade any layer');

const changed = notes.map(note => note.id === '效应甲' ? { ...note, content: '修改后的新教材基线' } : note);
const stale = { ...first, masteryAssessment: await recheckReviewMasteryReferences(first.masteryAssessment, dependencies(changed)) };
assert.ok(stale.masteryAssessment.items[0].error);
assert.equal(a(applyReviewMasteryBatch(changed, 'project', stale).notes).dsrState!.masteryShadow, undefined);
assert.equal(applyReviewMasteryBatch(notes.filter(note => note.id !== '效应甲'), 'project', first).notes.length, 2, 'late reply never resurrects deleted notes');
const spoofed = structuredClone(first);
spoofed.answerEvidence![0].answer = '替换后的答案';
assert.equal(applyReviewMasteryBatch(notes, 'project', spoofed).notes, notes, 'a changed answer cannot acquire old evaluation');
const oldNumericOnly = prepareReviewExitOutcome(notes, { noteId: '效应甲', noteTitle: '效应甲', analysis,
  segmentMastery: [{ name: '效应甲', level: 'reasoning', conceptDelta: 100, judgmentDelta: 100, reasoningDelta: 100, comment: '旧数值样本' }], episode: episode('numeric-only') });
assert.equal(a(oldNumericOnly.notes).dsrState!.conceptMastery, 99);
assert.equal(a(oldNumericOnly.notes).dsrState!.masteryShadow, undefined, 'legacy deltas do not create a new state');
const crossTurnQuote = structuredClone(first);
crossTurnQuote.masteryAssessment!.items[0].evaluation!.evidence[0].quote = crossTurnQuote.masteryAssessment!.items[0].input.answer;
assert.equal(a(applyReviewMasteryBatch(notes, 'project', crossTurnQuote).notes).dsrState!.masteryShadow!.layers.concept.state,
  'unassessed', 'synthetic cross-turn quote cannot become valid mastery evidence');
assert.equal(JSON.stringify(notes), unchanged, 'all preparation is immutable');

const paired = episode('per-point-failure');
for (const answer of paired.answerEvidence!) {
  answer.targetKnowledgeNames = ['效应甲', '效应乙'];
  answer.questionIntent!.knowledgeTargets = ['效应甲', '效应乙'];
  answer.questionIntent!.assessment = freezeReviewAssessment('definition', answer.targetKnowledgeNames);
}
const pairSession = await prepareReviewComparisonSession(paired, dependencies(notes), { targetScopeNoteIds: ['效应甲', '效应乙'] });
const pairPlan = planReviewMastery(notes, 'project', paired, pairSession);
assert.equal(pairPlan.items.length, 2);
let inFlight = 0, peak = 0;
paired.masteryAssessment = await evaluateReviewMastery(pairPlan, async ({ userInput }) => {
  inFlight++; peak = Math.max(peak, inFlight);
  try {
    await Promise.resolve();
    const input = JSON.parse(userInput);
    if (input.knowledgePointId === '效应乙') throw new Error('isolated model failure');
    return { protocol: 'mastery-shadow-evaluator-v1', evaluationId: input.evaluationId, knowledgePointId: input.knowledgePointId,
      evidence: [{ id: 'E1', quote: paired.answerEvidence![0].answer }],
      baselines: masteryBaselineFixture(input),
      criteria: input.criteria.map((criterion: { id: string }) => ({ id: criterion.id, state: 'pass', evidenceIds: ['E1'], referenceIds: ['REF1'],
        referenceQuotes: [{ referenceId: 'REF1', quote: input.references[0].quote.slice(0, 180) }], reason: '本地模拟核对。' })), summary: '仅成功知识点有据更新。' };
  } finally { inFlight--; }
});
assert.equal(peak, 2, 'per-point requests are bounded to two in flight');
const isolated = applyReviewMasteryBatch(notes, 'project', paired);
assert.equal(a(isolated.notes).dsrState!.masteryShadow!.layers.concept.state, 'provisional');
assert.equal(isolated.notes.find(note => note.id === '效应乙')!.dsrState!.masteryShadow, undefined, 'one model failure cannot discard a valid sibling');
const missingTask = episode('missing-task');
for (const answer of missingTask.answerEvidence!) answer.questionIntent!.assessment = freezeReviewAssessment(undefined, answer.targetKnowledgeNames);
const missingSession = await prepareReviewComparisonSession(missingTask, dependencies(notes), { targetScopeNoteIds: ['效应甲'] });
assert.equal(planReviewMastery(notes, 'project', missingTask, missingSession).items.length, 0, 'no retroactive task invention or extra model request');

const profile = { ability: {}, cognitiveStyle: {}, learningAbility: { domains: [] } } as UserProfile;
const known = structuredClone(knowledge('known'));
known.dsrState!.conceptMastery = 1;
known.dsrState!.masteryShadow = createMasteryShadowState(known.id);
for (const layer of ['concept', 'judgment', 'reasoning'] as const) setMasteryLayerFixture(known.dsrState!.masteryShadow, layer, 'confirmed');
known.dsrState!.lastReviewedAt = new Date().toISOString();
known.dsrState!.stability = 30;
const policy = buildPlanPersonalizationPolicy({ profile, habits: null, relevantKnowledgeNotes: [known, notes[2]], query: '' });
assert.ok(policy.decisions.some(row => row.id === 'knowledge-transfer-known'), 'new confirmation overrides low historical scores in planning');
assert.ok(policy.decisions.some(row => row.id === 'knowledge-diagnose-效应乙'), 'old high score does not become current confirmation');
const home = buildHomeViewModel(secondOutcome.notes, profile, { version: 1, weeks: [] });
assert.equal(home.knowledgeMastery.highestConfirmedLevel.concept, 1);
assert.equal(getNoteMasteryBand(a(secondOutcome.notes)), readKnowledgeMastery(a(secondOutcome.notes)).band);
assert.ok(buildKnowledgeReviewCandidates(secondOutcome.notes, 'smart').some(row => row.noteId === '效应甲' && row.mastery?.confirmedLevel === 1));
console.log('PASS: review semantic evaluation → immutable save → persistent replay protection → home/review/graph/plan reads; absent/assisted/stale/deleted/legacy inputs preserve states. No network or user data.');
