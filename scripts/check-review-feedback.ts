import assert from 'node:assert/strict';
import { buildReviewFeedbackRequest, evaluateReviewFeedback, reviewFeedbackFromCriteria } from '../src/services/masteryShadow/reviewFeedback';
import type { ReviewEpisodeCapture } from '../src/services/memory/types';
import { freezeReviewAssessment } from '../src/services/reviewAssessment';
import { buildReviewReferenceCatalog, freezeReviewReferenceRubric, bindReviewReferenceItems } from '../src/services/reviewReferenceRubric';
import { prepareReviewComparisonSession } from '../src/services/reviewComparison/session';
import { planReviewMastery, withReviewMasteryDisplayStates } from '../src/services/masteryShadow/review';
import { prepareReviewExitOutcome } from '../src/services/ui/reviewExitWrite';
import type { NoteItem } from '../src/types';

globalThis.fetch = async () => assert.fail('Feedback tests must not access model/network or live storage');
const at = '2026-10-18T00:00:00Z';
const episode: ReviewEpisodeCapture = { id: 'feedback-only', startedAt: at, endedAt: at,
  questionText: '请说明怎样应用这个效应。', knowledgeContext: '意识到被观察可能改变行为，不等于干预有效。', masteryEligible: false,
  messages: [{ id: 'q', role: 'assistant', content: '请说明怎样应用这个效应。', timestamp: at },
    { id: 'a', role: 'user', content: '知道被关注可能改变表现，但不能只凭表现改变就说干预有效。', timestamp: at }] };
const original = JSON.stringify(episode);
const request = buildReviewFeedbackRequest(episode);
assert.ok(request.userInput.includes(episode.messages[1].content));
assert.ok(!request.userInput.includes('conceptMastery') && !request.userInput.includes('accuracyScore'));
let calls = 0;
const result = await evaluateReviewFeedback(episode, async () => {
  calls++;
  return { feedback: '已区分行为改变与干预有效，但还未说明控制方法。', suggestion: '补充一个对照情境。',
    evidenceQuotes: [episode.messages[1].content, '模型编造的用户原话'], accuracyScore: 30 };
});
assert.equal(calls, 1); assert.equal(result.status, 'available');
assert.deepEqual(result.evidenceQuotes, [episode.messages[1].content]);
assert.ok(!('accuracyScore' in result) && !('masteryAssessment' in result));
assert.equal(JSON.stringify(episode), original);
const failed = await evaluateReviewFeedback(episode, async () => { throw Error('simulated transport failure'); });
assert.equal(failed.status, 'unavailable'); assert.ok(failed.feedback.includes('不能据此判定不掌握'));
const empty = await evaluateReviewFeedback({ ...episode, messages: [] }, async () => assert.fail('No answer means no request'));
assert.equal(empty.status, 'unavailable');
const long = buildReviewFeedbackRequest({ ...episode, knowledgeContext: ('完整参考段落，说明适用条件与局限。\n\n').repeat(900),
  messages: Array.from({ length: 14 }, (_, index) => ({ id: `a${index}`, role: 'user' as const, content: `第${index}次完整作答。`, timestamp: at })) });
const payload = JSON.parse(long.userInput);
assert.equal(payload.turns.length, 12); assert.equal(long.omittedTurns, 2);
assert.ok(payload.referenceExcerpts.reduce((sum: number, text: string) => sum + text.length, 0) <= 6000);
assert.equal(reviewFeedbackFromCriteria({ version: 1, sessionId: 'x', noteId: 'x', sourceKey: '', observedAt: at, items: [], warnings: [] }), undefined);

const note: NoteItem = { id: 'point', title: '霍桑效应', noteType: 'knowledge', content: '意识到被观察可能改变行为，不等于干预有效。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at };
const assessment = freezeReviewAssessment('definition', [note.title]);
const catalog = await buildReviewReferenceCatalog([note], [note.title], [note.id]);
const missing = freezeReviewReferenceRubric(undefined, assessment, catalog);
const capture: ReviewEpisodeCapture = { ...episode, masteryEligible: true, answerEvidence: [{ messageId: 'a', answer: episode.messages[1].content,
  hintLevel: 0, targetKnowledgeNames: [note.title], questionIntent: { version: 1, questionMessageId: 'q', knowledgeTargets: [note.title], assessment, referenceRubric: missing } }] };
const dependencies = (notes: NoteItem[]) => ({ readNotes: async () => notes, loadCognition: async () => assert.fail('not a reference'),
  searchNotes: async () => [], searchDocuments: async () => [], previewDocument: async () => assert.fail('not used') });
const session = await prepareReviewComparisonSession(capture, dependencies([note]), { targetScopeNoteIds: [note.id] });
assert.equal(session.packets[0].preparation.mastery, 'held', 'other review consumers keep their strict contract');
const planned = planReviewMastery([note], note.id, capture, session);
assert.equal(planned.items.length, 1, 'missing fine-grained selection does not discard a frozen task and readable canonical reference');
assert.equal(planned.items[0].input.references[0].quote, note.content);
const displayOnly = withReviewMasteryDisplayStates([], [note], note.id, capture);
assert.equal(displayOnly.length, 1); assert.equal(displayOnly[0].shadow!.status, 'failed');
assert.equal(displayOnly[0].shadow!.layers.concept.state, 'unassessed');
assert.equal(displayOnly[0].shadow!.layers.reasoning.verdict, 'unverifiable');
assert.deepEqual(prepareReviewExitOutcome([note], { noteId: note.id, noteTitle: note.title, analysis: null,
  segmentMastery: displayOnly, episode: { ...capture, reviewFeedback: result } }).notes, [note], 'displayed existing states and semantic feedback cannot masquerade as write evidence');
const staleCapture = structuredClone(capture);
staleCapture.answerEvidence![0].questionIntent!.referenceRubric!.reason = 'source_changed';
const staleSession = await prepareReviewComparisonSession(staleCapture, dependencies([note]), { targetScopeNoteIds: [note.id] });
assert.equal(planReviewMastery([note], note.id, staleCapture, staleSession).items.length, 0, 'a changed source cannot use the missing-selection fallback');

// Selected question-time material near the end must survive a different retrieval window at grading time.
const longNote = { ...note, content: (`应用说明：${episode.questionText} ${episode.messages[1].content}\n\n`).repeat(100)
  + '关键定义：被观察可能改变行为，而非干预有效。\n\n关键限定：这是一种倾向，不是每次必然发生。' };
const longCatalog = await buildReviewReferenceCatalog([longNote], [note.title], [note.id], '关键定义 关键限定');
const candidate = longCatalog.candidates.find(row => row.quote.includes('关键定义'))!;
assert.ok(candidate);
const selected = freezeReviewReferenceRubric(`concept_meaning=${candidate.candidateId};concept_boundary=${candidate.candidateId}`, assessment, longCatalog);
assert.equal(selected.status, 'fixed');
const longCapture = structuredClone(capture);
longCapture.answerEvidence![0].questionIntent!.referenceRubric = selected;
const longSession = await prepareReviewComparisonSession(longCapture, dependencies([longNote]), { targetScopeNoteIds: [note.id] });
assert.equal(longSession.packets[0].preparation.mastery, 'pending_alignment');
assert.equal(bindReviewReferenceItems(longSession.packets[0]).length, 2);
assert.ok(longSession.packets[0].references.some(row => row.textStart === candidate.start && row.text === candidate.quote));
console.log('PASS: missing markers still produce bounded semantic feedback; feedback has no write authority; frozen tasks use canonical references without optional K# selection; verified selected intervals survive retrieval-window changes; stale sources remain held.');
