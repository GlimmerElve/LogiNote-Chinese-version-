import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { KnowledgePointMasteryResult, NoteItem, ReviewAnalysis } from '../src/types';
import type { LearningEpisode, ReviewEpisodeCapture } from '../src/services/memory/types';
import { commitReviewExitWrite, getReviewDraftForNote, prepareReviewExitOutcome, type ReviewExitProgress } from '../src/services/ui/reviewExitWrite';

globalThis.fetch = async () => assert.fail('Review exit checks cannot use the network');
function note(id: string, title = id): NoteItem {
  return { id, title, content: '保留正文', noteType: 'knowledge', tags: [], links: [], backlinks: [], dueDates: [],
    createdAt: '2026-10-01', updatedAt: '2026-10-01',
    dsrState: { difficulty: 5, stability: 2, reviewCount: 2, lastReviewedAt: null, consecutiveCorrect: 0, consecutiveWrong: 0 } };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => { resolve = yes; });
  return { resolve, promise };
}
const episode: ReviewEpisodeCapture = { id: 'review-save-fixture', startedAt: '2026-10-06T00:00:00Z', endedAt: '2026-10-06T00:10:00Z',
  questionText: '请解释', knowledgeContext: '测试知识', messages: [], masteryEligible: true };
const analysis: ReviewAnalysis = { accuracyScore: 80, completenessScore: 80, logicScore: 70, relevanceScore: 90,
  overallRating: 'good', feedback: '测试反馈', suggestion: '继续复习', missingKnowledge: [] };
const input = { noteId: 'a', noteTitle: '知识A', analysis, episode };
// Keep the frozen numeric writer covered only through its explicit rollback mode.
const previousMasteryMode = process.env.VITE_MASTERY_READ_MODE;
process.env.VITE_MASTERY_READ_MODE = 'legacy';
const original = [note('a', '知识A'), note('other')];
const prepared = prepareReviewExitOutcome(original, input);
assert.equal(original[0].dsrState!.reviewCount, 2, 'preparing cannot optimistically apply mastery');
assert.equal(prepared.notes[0].dsrState!.reviewCount, 3);
assert.equal(prepared.notes[0].content, original[0].content);
assert.equal(prepared.notes[1], original[1], 'unrelated note identity is preserved');
assert.equal(prepared.notes[0].dsrState!.conceptMasterySamples, undefined, 'no mastery evidence creates no mastery samples');
assert.deepEqual(prepared.learningChanges.map((item) => item.field), ['difficulty', 'stability']);
const ineligible = prepareReviewExitOutcome(original, { ...input, episode: { ...episode, masteryEligible: false } });
assert.equal(ineligible.notes[0], original[0]);
assert.deepEqual(ineligible.learningChanges, []);
const segment: KnowledgePointMasteryResult = { name: '知识A', level: 'concept', conceptDelta: 1, judgmentDelta: 0, reasoningDelta: 0, comment: '' };
const project = prepareReviewExitOutcome(original, { ...input, segmentMastery: [segment, segment] });
assert.equal(project.notes[0].dsrState!.reviewCount, 3, 'one resolved knowledge note is updated once even with duplicate segments');
assert.equal(project.learningChanges.length, 1);

// The in-app checkpoint retains the successful notes stage across a failed record write.
let visible = original;
let noteWrites = 0, recordWrites = 0;
const progress: ReviewExitProgress = {};
const noteGate = deferred(), recordGate = deferred();
let rejectRecord = true;
const dependencies = {
  persistNotes: async () => {
    noteWrites++;
    await noteGate.promise;
    const outcome = prepareReviewExitOutcome(visible, input);
    visible = outcome.notes;
    return outcome;
  },
  persistEpisode: async () => { recordWrites++; await recordGate.promise; if (rejectRecord) throw new Error('记录磁盘不可写'); },
};
const first = commitReviewExitWrite(progress, dependencies);
assert.equal(commitReviewExitWrite(progress, dependencies), first, 'double confirmation shares one pending save');
assert.equal(visible, original);
assert.equal(recordWrites, 0);
noteGate.resolve();
await Promise.resolve(); await Promise.resolve();
assert.equal(visible[0].dsrState!.reviewCount, 3);
assert.equal(progress.completed, undefined, 'records must save before exit can finish');
recordGate.resolve();
await assert.rejects(first, /记录磁盘不可写/);
assert.equal(progress.pending, undefined, 'failure unlocks retry');
assert.equal(noteWrites, 1);
visible = visible.map((item) => item.id === 'a' ? { ...item, content: '保存失败期间的最新正文' } : item);
rejectRecord = false;
await commitReviewExitWrite(progress, dependencies);
assert.equal(noteWrites, 1, 'record retry must not repeat mastery');
assert.equal(recordWrites, 2);
assert.equal(visible[0].dsrState!.reviewCount, 3);
assert.equal(visible[0].content, '保存失败期间的最新正文');
assert.equal(progress.completed, true);
await commitReviewExitWrite(progress, dependencies);
assert.equal(recordWrites, 2, 'completed exit cannot write again');

const failedNotes: ReviewExitProgress = {};
let retriedNotes = 0, prematureRecords = 0;
let failNotes = true;
const noteFailureDependencies = {
  persistNotes: async () => { retriedNotes++; if (failNotes) throw new Error('笔记不可写'); return prepared; },
  persistEpisode: async () => { prematureRecords++; },
};
await assert.rejects(commitReviewExitWrite(failedNotes, noteFailureDependencies), /笔记不可写/);
assert.equal(failedNotes.outcome, undefined);
assert.equal(prematureRecords, 0);
failNotes = false;
await commitReviewExitWrite(failedNotes, noteFailureDependencies);
assert.equal(retriedNotes, 2);
assert.equal(prematureRecords, 1);

const saved = (id: string, noteId: string, updatedAt: string, content?: string): LearningEpisode => ({
  id, noteId, type: 'review', status: 'completed', title: '测试', startedAt: updatedAt, endedAt: updatedAt, createdAt: updatedAt, updatedAt,
  ...(content ? { draftAnswer: { id: `draft-${id}`, timestamp: updatedAt, content } } : {}),
});
const raw = `  原始草稿\n${'原文'.repeat(500)}\n`;
const savedDraft = saved('old', 'a', '2026-10-05', raw);
assert.equal(getReviewDraftForNote([savedDraft, saved('unrelated', 'b', '2026-10-07', '其他笔记')], 'a')?.draft.content, raw);
assert.equal(getReviewDraftForNote([savedDraft, saved('new', 'a', '2026-10-06')], 'a'), null, 'a later submitted session cannot resurrect an older draft');
assert.equal(getReviewDraftForNote([savedDraft], 'unknown'), null, 'draft binding is an exact note identity, not a title match');

const app = readFileSync('src/App.tsx', 'utf8');
const callback = app.slice(app.indexOf('  const handleExitReview = '), app.indexOf('  // ===== 论证编辑闭环'));
assert.match(callback, /await commitReviewExitWrite/);
assert.match(callback, /persistNotes: \(\) => persistPlanMutation\(\(current\) => prepareReviewExitOutcome\(current/);
assert.match(callback, /await saveEpisodeWithProfileEvidence/);
assert.doesNotMatch(callback, /void ingestProfileSignals/, 'Profile durability belongs to the awaited exit stage, not a detached notification');
assert.ok(callback.indexOf('setCurrentView(reviewReturnView)') > callback.indexOf('await commitReviewExitWrite'), 'navigation follows successful persistence');
assert.doesNotMatch(callback, /handleUpdateNote\(/, 'no optimistic mastery updates before save');
console.log('Review exit checks passed: awaited persistence, stage-safe retry, no duplicate mastery, live content and exact-note draft recovery.');
if (previousMasteryMode === undefined) delete process.env.VITE_MASTERY_READ_MODE;
else process.env.VITE_MASTERY_READ_MODE = previousMasteryMode;
await import('./check-flow-result-write');
