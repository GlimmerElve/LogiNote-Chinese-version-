import assert from 'node:assert/strict';
import { QuickCheckStore } from '../src/components/quickCheck/store';
import { evaluateQuickCheck, applyQuickCheckAssessment, type QuickCheckCall, type QuickCheckSession } from '../src/services/quickCheck';
import { createMasteryShadowState } from '../src/services/masteryShadow/stateMachine';
import type { NoteItem } from '../src/types';
import { quickCheckDesignFixture, generateQuickCheckFixture as generateQuickCheck } from './fixtures/quick-check-design';

globalThis.fetch = async () => assert.fail('No cloud or production storage in continuation regressions');
const at = '2026-10-19T00:00:00.000Z';
let notes: NoteItem[] = [{ id: 'isolated-continuation', title: '观察效应', noteType: 'knowledge',
  content: '## 定义\n知道受到观察可能改变行为。\n\n## 边界\n不能把这种变化直接当成干预效果。\n\n## 应用\n比较被观察与未被观察时，应控制观察条件。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at }];
const original = JSON.stringify(notes);
let generationCalls = 0, evaluationCalls = 0, commits = 0, malformed = false, partialCoverage = false;
const inputs: any[] = [];
const call: QuickCheckCall = async request => {
  const input = JSON.parse(request.userInput);
  if (!input.targets) { evaluationCalls++; assert.fail('skips must not request semantic grading'); }
  const round = ++generationCalls; inputs.push(input);
  assert.ok(!request.userInput.includes('privateAnswer'), 'never send retained answer keys');
  if (malformed) return { content: '{"protocol":"quick-check-card-v1","questions":[' };
  const raw = { protocol: 'quick-check-card-v1', questions: input.requestedSlots.map((id: string) => {
    const index = Number(id.slice(1)) - 1;
    const target = input.targets[partialCoverage ? 0 : index % input.targets.length];
    const reference = input.references.find((ref: { criterionIds: string[] }) => ref.criterionIds.includes(target.id));
    return { id, type: index ? 'choice' : 'open', prompt: `第${round}轮合成问题${index + 1}`,
      criterionIds: [target.id], referenceIds: [reference.id],
      ...(index ? { options: [{ id: 'A', text: '选项甲' }, { id: 'B', text: '选项乙' }] } : {}),
      privateAnswer: { ...(index ? { optionId: 'A' } : {}), explanation: '仅验证结构与状态流转，不代表语义评价。',
        referenceQuotes: [{ referenceId: reference.id, quote: reference.quote.slice(0, 160) }] } };
  }) };
  return { content: JSON.stringify(quickCheckDesignFixture(request, raw)).replace(/\}$/u, ',}') };
};
const memory = new Map<string, string>();
const storage = { getItem: (key: string) => memory.get(key) || null, setItem: (key: string, value: string) => { memory.set(key, value); } };
const runtime = { notes, getNotes: () => notes, onCommit: async (session: Parameters<typeof applyQuickCheckAssessment>[1],
  assessment: Parameters<typeof applyQuickCheckAssessment>[2]) => {
  commits++;
  const outcome = applyQuickCheckAssessment(notes, session, assessment);
  assert.equal(outcome.applied, false); assert.equal(outcome.reason, undefined);
  notes = outcome.notes; return outcome.result;
} };
const readers = { searchNotes: async () => [] };
const adapters = {
  generate: (options: Parameters<typeof generateQuickCheck>[0]) => generateQuickCheck({ ...options, call, readers }),
  evaluate: (session: Parameters<typeof evaluateQuickCheck>[0], answers: Parameters<typeof evaluateQuickCheck>[1], options: Parameters<typeof evaluateQuickCheck>[2]) =>
    evaluateQuickCheck(session, answers, { ...options, call }),
};
let store = new QuickCheckStore(runtime, 'isolated-continuation', storage, adapters);
const draft = () => store.getSnapshot().draft!;
async function until(state: string) {
  for (let tries = 0; tries < 200 && draft()?.phase !== state; tries++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(draft().phase, state, draft()?.error);
}
const skipped = (card: QuickCheckSession) => card.questions.map(q => ({ questionId: q.id, skipped: true }));
async function skipAll() { store.next(true); store.next(true); store.next(true); await until('result'); }
assert.ok(store.open({ noteId: notes[0].id })); await until('ready');
const first = structuredClone(draft().session!);
await skipAll();
assert.match(draft().result!.headline, /三题均已跳过/u);
store.continue(); store.continue(); await until('ready');
assert.equal(generationCalls, 1, 'all skips retain all three questions without any model request');
assert.notEqual(draft().session!.id, first.id);
assert.deepEqual(draft().session!.questions, first.questions);
assert.equal(draft().answers.length, 0); assert.equal(draft().result, undefined); assert.equal(draft().assessment, undefined);
store.close(); store.open({ noteId: notes[0].id }); assert.equal(generationCalls, 1);
store = new QuickCheckStore(runtime, 'isolated-continuation', storage, adapters);
store.open({ noteId: notes[0].id });
assert.deepEqual(draft().session!.questions, first.questions, 'reused questions survive reload');

// Per-question state invalidation: unrelated criterion changes cannot replace skipped questions.
const changed = structuredClone(notes[0]);
changed.dsrState = { difficulty: 5, stability: 2, reviewCount: 0, lastReviewedAt: null,
  consecutiveCorrect: 0, consecutiveWrong: 0, masteryShadow: createMasteryShadowState(changed.id) };
changed.dsrState.masteryShadow!.layers.reasoning.criteria!.reasoning_consistency.state = 'provisional';
const unchanged = await generateQuickCheck({ note: changed, reuseSkipped: { session: first, answers: skipped(first) }, call,
  readers: { searchNotes: async () => assert.fail('reusing all skipped questions needs no retrieval') } });
assert.equal(generationCalls, 1); assert.deepEqual(unchanged.questions, first.questions);
changed.dsrState.masteryShadow!.layers.concept.criteria!.concept_accuracy.state = 'provisional';
const selective = await generateQuickCheck({ note: changed, reuseSkipped: { session: first, answers: skipped(first) }, call, readers });
assert.deepEqual(inputs.at(-1).requestedSlots, ['Q1']);
assert.deepEqual(selective.questions.slice(1), first.questions.slice(1));
assert.notDeepEqual(selective.questions[0], first.questions[0]);
const partial = await generateQuickCheck({ note: notes[0], reuseSkipped: { session: first,
  answers: [{ questionId: 'Q1', text: 'old private student answer' }, { questionId: 'Q2', skipped: true }, { questionId: 'Q3', optionId: 'B' }] }, call, readers });
assert.deepEqual(inputs.at(-1).requestedSlots, ['Q1', 'Q3']);
assert.deepEqual(partial.questions[1], first.questions[1]);
assert.ok(!JSON.stringify(inputs.at(-1)).includes('old private student answer'));
const sourceChanged = { ...notes[0], content: notes[0].content + '\n新增原文条件。' };
await generateQuickCheck({ note: sourceChanged, reuseSkipped: { session: first, answers: skipped(first) }, call, readers });
assert.deepEqual(inputs.at(-1).requestedSlots, ['Q1', 'Q2', 'Q3']);

// Manual and Agent refresh never discard answers before explicit confirmation.
store.answer({ questionId: 'Q1', text: '尚未提交的回答' });
let before = generationCalls;
assert.ok(store.open({ noteId: notes[0].id, regenerate: true, source: 'agent' }));
assert.equal(draft().refreshConfirmation, true); assert.equal(generationCalls, before);
store.next(true); assert.equal(draft().step, 0, 'confirmation cannot be bypassed by a stale UI callback');
store.cancelRefresh(); assert.equal(draft().answers[0].text, '尚未提交的回答');
store.refresh(); store.confirmRefresh(); store.confirmRefresh(); await until('ready');
assert.equal(generationCalls, before + 1); assert.equal(draft().answers.length, 0);
assert.deepEqual(inputs.at(-1).requestedSlots, ['Q1', 'Q2', 'Q3']);
partialCoverage = true; store.refresh(); await until('ready'); partialCoverage = false;
assert.equal(draft().session!.targets.length, 1); assert.equal(draft().session!.uncoveredCriterionIds?.length, 2);
await skipAll();
before = generationCalls;
// A related state change forces skipped slots to be replaced; retry preserves old skipped input.
notes = [changed];
malformed = true; store.continue(); await until('error');
assert.equal(generationCalls, before + 2, 'one initial request plus at most one bounded format recovery'); assert.equal(draft().pendingRetake, true);
assert.match(draft().error!, /格式不完整/u);
const failedQuestions = structuredClone(draft().session!.questions);
store = new QuickCheckStore(runtime, 'isolated-continuation', storage, adapters);
store.open({ noteId: notes[0].id });
assert.equal(draft().phase, 'error'); assert.deepEqual(draft().session!.questions, failedQuestions);
malformed = false; store.retry(); await until('ready');
assert.equal(generationCalls, before + 3, 'one successful manual retry, never recursive retry or accidental old-answer grading');
assert.equal(draft().pendingRetake, false); assert.equal(draft().answers.length, 0);
// Reading references stays assisted even when a skipped question is reused.
store.assist(); await skipAll(); before = generationCalls;
store.continue(); await until('ready');
assert.equal(generationCalls, before); assert.equal(draft().assisted, true);
assert.equal(evaluationCalls, 0); assert.equal(commits, 3);
assert.equal(JSON.stringify(runtime.notes), original, 'no original note mutation or mastery writes for skips/refresh');
console.log('PASS actual store/core: all-skip zero calls; partial per-slot retention; criterion/source invalidation; manual/Agent confirmation; partial coverage; failed-retake cache/retry; no cloud/formal writes.');
