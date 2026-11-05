import assert from 'node:assert/strict';
import { masteryBaselineFixture } from './fixtures/mastery-baselines';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { masteryReadMode } from '../src/services/masteryReadModel';
import { planReviewMastery, evaluateReviewMastery, applyReviewMasteryBatch, recheckReviewMasteryReferences, withReviewMasteryDisplayStates } from '../src/services/masteryShadow/review';
import { prepareReviewComparisonSession, recheckReviewComparisonSession } from '../src/services/reviewComparison/session';
import { normalizeReviewAnalysis, summarizeReviewEvidence, reviewEvidenceRequirement } from '../src/services/reviewEvidence';
import { parseJsonLenient } from '../src/services/reviewSegmentScoring';
import { freezeReviewAssessment } from '../src/services/reviewAssessment';
import { prepareReviewExitOutcome } from '../src/services/ui/reviewExitWrite';
import { buildKnowledgeStateContext } from '../src/services/memory/memoryContextBuilder';
import type { NoteItem, ReviewMessage } from '../src/types';
import type { ReviewAnswerEvidence, ReviewEpisodeCapture } from '../src/services/memory/types';
import { reviewFeedbackFromCriteria, evaluateReviewFeedback, type ReviewSessionFeedback } from '../src/services/masteryShadow/reviewFeedback';
import { buildReviewDraft, reviewDraftQuestionKey, reviewDraftTutorPrompt } from '../src/services/reviewDraft';

globalThis.fetch = async () => assert.fail('UI handler verification must be model/network/vault free');
const source = ts.createSourceFile('ReviewChat.tsx', readFileSync('src/components/ReviewChat.tsx', 'utf8'), ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
function handler(name: string) {
  let expression = '';
  const visit = (node: ts.Node) => { if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) expression = node.initializer!.getText(source); ts.forEachChild(node, visit); };
  visit(source); assert.ok(expression);
  return expression;
}
function execute(code: string, environment: Record<string, unknown>): (...args: unknown[]) => Promise<void> {
  const compiled = ts.transpileModule(`const tested = ${code};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(environment), `${compiled}\nreturn tested;`)(...Object.values(environment));
}
const at = new Date().toISOString();
const note: NoteItem = { id: 'point', title: '霍桑效应', noteType: 'knowledge', content: '意识到被关注或观察可能改变行为，不能把这种变化直接视为干预有效。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at };
const project: NoteItem = { ...note, id: 'project', title: '学习项目', noteType: 'project', links: [note.title] };
const questions = ['请解释霍桑效应的含义和限定。', '请再次说明被关注和干预有效的区别。'];
const answers = ['人知道自己受到观察，表现可能改变；因此不能把表现变化直接归功于干预本身。', '要把被关注引起的变化和干预有效区分开来，最好对照两组受到的关注程度。'];
const messages: ReviewMessage[] = questions.flatMap((content, index) => [{ id: `q${index}`, role: 'tutor', content, timestamp: at },
  { id: `a${index}`, role: 'user', content: answers[index], timestamp: at }]);
const evidence: ReviewAnswerEvidence[] = answers.map((answer, index) => ({ messageId: `a${index}`, answer, hintLevel: 0,
  targetKnowledgeNames: [note.title], questionIntent: { version: 1, questionMessageId: `q${index}`, knowledgeTargets: [note.title],
    assessment: freezeReviewAssessment('definition', [note.title]) } }));
const dependencies = { readNotes: async () => [project, note], loadCognition: async () => assert.fail('No cognition read'),
  searchNotes: async () => [], searchDocuments: async () => [], previewDocument: async () => { throw new Error('no document fixture'); } };
const masteryRef: { current?: ReturnType<typeof planReviewMastery> } = {};
const comparisonRef: { current?: Awaited<ReturnType<typeof prepareReviewComparisonSession>> } = {};
let analysis: ReturnType<typeof normalizeReviewAnalysis> | null = null;
let results: ReturnType<typeof applyReviewMasteryBatch>['results'] = [];
let ended = false, scoring = false, error: unknown = null, semanticCalls = 0, performanceCalls = 0;
let feedbackCalls = 0;
let feedback: ReviewSessionFeedback | undefined;
const feedbackRef: { current?: ReviewSessionFeedback } = {};
const base = { previewOnly: false, materialOpen: { isBusy: () => false }, tutorOperationRef: { current: false },
  isDiscardingDraft: false, buildReviewDraft, lastQuestionIntentRef: { current: evidence.at(-1)!.questionIntent! },
  reviewDraftQuestionKey, reviewDraftTutorPrompt, currentQuestionTextRef: { current: questions.at(-1)! },
  hintLevel: 0, consultedMaterialIds: [], consumedDraftIdsRef: { current: new Set<string>() },
  isTutorResponding: false, isScoring: false, sessionEnded: false, messages, finishLock: { current: false }, exitSaveError: '',
  previewMessages: [], setIsScoring: (value: boolean) => { scoring = value; }, setError: (value: unknown) => { error = value; },
  answerEvidenceRef: { current: evidence }, summarizeReviewEvidence, reviewEvidenceRequirement,
  argumentQuestionClient: { verifyAnswers: async () => {} }, prepareReviewComparisonSession, reviewComparisonDependencies: dependencies,
  sessionIdRef: { current: 'ui-session' }, sessionStartedAtRef: { current: at }, openingQuestion: { cleanText: questions[0] }, knowledgeContext: note.content,
  reviewComparisonRef: comparisonRef, reviewMasteryRef: masteryRef, isProjectReview: true, projectKnowledgeNotes: [note], allNotes: [project, note], noteId: project.id,
  reviewFeedbackRef: feedbackRef, reviewFeedbackFromCriteria,
  setSessionFeedback: (value: ReviewSessionFeedback) => { feedback = value; },
  evaluateReviewFeedbackWithModel: async (capture: ReviewEpisodeCapture) => {
    feedbackCalls++;
    return evaluateReviewFeedback(capture, async () => ({ feedback: '本次已说明被观察与干预效果的区别。', suggestion: '下次检验一个反例。', evidenceQuotes: [answers[0]] }));
  },
  masteryReadMode, planReviewMastery, applyReviewMasteryBatch, withReviewMasteryDisplayStates, parseJsonLenient, normalizeReviewAnalysis,
  segmentsRef: { current: [] }, scoreReviewSegmentsInParallel: () => assert.fail('Current mode must not send legacy segment requests'),
  setSegmentMasteryResults: (value: typeof results) => { results = value; }, setFinalAnalysis: (value: typeof analysis) => { analysis = value; },
  setSessionEnded: (value: boolean) => { ended = value; }, noteTitle: project.title,
  callLLMStream: async (request: { workflow: string; thinkingMode: string }) => {
    performanceCalls++; assert.equal(request.workflow, 'review-scoring'); assert.equal(request.thinkingMode, 'disabled');
    let read = false;
    return { getReader: () => ({ read: async () => read ? { done: true } : (read = true, { done: false, value: { text: JSON.stringify({
      accuracyScore: 85, completenessScore: 80, logicScore: 80, relevanceScore: 85, feedback: '本次回答有据。', suggestion: '', missingKnowledge: [] }) } }),
      releaseLock() {} }) };
  },
  evaluateReviewMasteryWithModel: async (batch: ReturnType<typeof planReviewMastery>) => evaluateReviewMastery(batch, async ({ userInput }) => {
    semanticCalls++; const input = JSON.parse(userInput);
    return { protocol: 'mastery-shadow-evaluator-v1', evaluationId: input.evaluationId, knowledgePointId: input.knowledgePointId,
      baselines: masteryBaselineFixture(input),
      evidence: [{ id: 'E1', quote: answers[0] }], criteria: input.criteria.map((row: { id: string }) => ({ id: row.id, state: 'pass',
        evidenceIds: ['E1'], referenceIds: ['REF1'], referenceQuotes: [{ referenceId: 'REF1', quote: input.references[0].quote.slice(0, 180) }],
        reason: '与题目参考含义一致。' })), summary: '概念要求有据通过。' };
  }),
};
await execute(handler('handleEndSession'), base)();
assert.equal(error, null); assert.equal(ended, true); assert.equal(scoring, false);
assert.equal(performanceCalls, 0, 'current mode never calls the retired review-scoring workflow');
assert.equal(semanticCalls, 1, 'two rounds share one per-target semantic call');
assert.equal(feedbackCalls, 0, 'successful criteria reuse their feedback without another request');
assert.equal(analysis, null); assert.equal(feedback?.source, 'criteria');
assert.equal(results[0].shadow!.layers.concept.state, 'provisional');
assert.equal(results[0].shadow!.layers.judgment.state, 'unassessed');

let saved: ReviewEpisodeCapture | undefined;
let savedNotes: NoteItem[] = [project, note];
await execute(handler('handleFinishReview'), { ...base, isScoring: false, finalAnalysis: analysis, segmentMasteryResults: results,
  allowCognitionLeave: () => true, finishedRef: { current: false }, setIsSavingCognition() {}, setCognitionError() {}, setExitSaveError() {},
  onExitSaveStateChange() {}, isListening: false, userInputRef: { current: '尚未发送的草稿不得参与评分' }, draftAnswerRef: { current: undefined },
  finishEndedAtRef: { current: undefined }, recheckReviewComparisonSession, recheckReviewMasteryReferences, collectCognition: false,
  captureReviewCognition: async (_episode: unknown, _note: unknown, enabled: boolean) => assert.equal(enabled, true,
    'production review answers enter source-bound cognition automatically; this fixture substitutes only the local write boundary'),
  onReviewComplete: async (_analysis: unknown, _segments: unknown, capture: ReviewEpisodeCapture) => {
    saved = capture; savedNotes = prepareReviewExitOutcome(savedNotes, { noteId: project.id, noteTitle: project.title, analysis,
      segmentMastery: results, episode: capture }).notes;
  }, recordReviewActivity: async () => {},
})();
assert.ok(saved?.masteryAssessment, 'actual exit callback carries semantic receipt to App');
assert.equal(saved.reviewFeedback?.status, 'available');
assert.ok(saved.draftAnswer && !saved.masteryAssessment.items[0].input.answer.includes(saved.draftAnswer.content));
assert.equal(savedNotes[1].dsrState!.masteryShadow!.layers.concept.state, 'provisional');
const context = buildKnowledgeStateContext(savedNotes, [note.id]);
assert.ok(context.text.includes('概念待确认') && context.text.includes('判断未评估'));
assert.ok(!context.text.includes('概念掌握 0%'));
const withoutMarkers = structuredClone(evidence);
for (const answer of withoutMarkers) answer.questionIntent!.assessment = freezeReviewAssessment(undefined, [note.title]);
error = null;
await execute(handler('handleEndSession'), { ...base, answerEvidenceRef: { current: withoutMarkers },
  reviewComparisonRef: { current: undefined }, reviewMasteryRef: { current: undefined } })();
assert.equal(error, null); assert.equal(feedbackCalls, 1);
assert.equal(performanceCalls, 0); assert.equal(semanticCalls, 1, 'missing metadata never invents a grading task');
assert.equal(results.length, 1); assert.equal(results[0].shadow?.status, 'failed');
assert.equal(feedback?.source, 'semantic_feedback');
assert.ok(feedback?.feedback.includes('区别'), 'missing hidden markers still allow ordinary feedback');
console.log('PASS: actual ReviewChat score → reference-backed evaluator → result projection → finish callback → current-state save and Agent context; no legacy segment requests, no drafts graded, zero network/user writes.');
