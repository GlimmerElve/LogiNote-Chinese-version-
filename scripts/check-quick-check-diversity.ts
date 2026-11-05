import assert from 'node:assert/strict';
import type { NoteItem } from '../src/types';
import { applyQuickCheckAssessment, type QuickCheckHistoryItem, type QuickCheckTarget, type QuickCheckAssessment } from '../src/services/quickCheck';
import { quickCheckQuestionPlans, validQuickCheckHistory } from '../src/services/quickCheck/planning';
import { appendQuickCheckHistory, quickCheckHistorySnapshot } from '../src/services/quickCheck/history';
import { repeatedQuickCheckSlots } from '../src/services/quickCheck/diversity';
import { QuickCheckStore } from '../src/components/quickCheck/store';
import { quickCheckDesignFixture, generateQuickCheckFixture as generateQuickCheck } from './fixtures/quick-check-design';

globalThis.fetch = async () => assert.fail('No cloud or real vault in diversity contracts');
const targets: QuickCheckTarget[] = [
  { id: 'judgment_accuracy', label: '判断正确性', layer: 'judgment', state: 'provisional' },
  { id: 'reasoning_sufficiency', label: '依据充分性', layer: 'reasoning', state: 'needs_review' },
  { id: 'judgment_conditions', label: '条件与程度', layer: 'judgment', state: 'unassessed' },
];
const firstPlan = quickCheckQuestionPlans(targets, ['Q1', 'Q2', 'Q3'], [], []);
assert.equal(firstPlan[0].primaryCriterionId, 'reasoning_sufficiency', 'reasoning receives the open-answer opportunity');
assert.equal(new Set(firstPlan.map(plan => plan.operation)).size, 3, 'three different cognitive tasks, including both closed questions');
const history: QuickCheckHistoryItem[] = firstPlan.map((plan, index) => ({ prompt: `旧场景${index}`,
  criterionIds: [plan.primaryCriterionId], design: { operation: plan.operation, scenario: `旧案例的对象关系${index}`,
    focus: `原来的待判断命题${index}`, requiredDetail: `原案例必须处理的信息${index}` },
  gaps: index === 0 ? [{ id: 'reasoning_sufficiency', summary: '没有区分多个陈述是否来自同一来源。' }] : [] }));
const nextPlan = quickCheckQuestionPlans(targets, ['Q1', 'Q2', 'Q3'], history, []);
assert.ok(nextPlan.every(plan => !firstPlan.some(old => old.operation === plan.operation)), 'all three tasks rotate, not just Q1');
assert.match(nextPlan[0].gapToProbe!, /同一来源/u);
assert.match(nextPlan[0].purpose, /具体缺口/u);
assert.match(nextPlan[1].purpose, /独立确认/u);
assert.ok(validQuickCheckHistory(history));
assert.ok(!validQuickCheckHistory(Array(7).fill(history[0])));

// Different text and even different scene: repeating the same declared test
// proposition is still a duplicate. This is structural metadata, not NLP proof.
const old = history[1];
assert.deepEqual(repeatedQuickCheckSlots([{ id: 'Q2', prompt: '已完全换过文字的新问题',
  design: { ...old.design!, scenario: '另一个行业的新案例' } }], [], [], history), ['Q2']);
assert.deepEqual(repeatedQuickCheckSlots([{ id: 'Q3', prompt: '判断题换成了另一种句式',
  design: { ...history[2].design!, focus: '另一个命题但沿用旧场景' } }], [], [], history), ['Q3']);
const extra = { ...history[0], privateAnswer: 'NEVER_SEND_PRIVATE_KEY', studentAnswer: 'NEVER_SEND_STUDENT_TEXT' };
assert.ok(!JSON.stringify(quickCheckHistorySnapshot([extra])).includes('NEVER_SEND'));

// Only verified partial/fail gaps guide later tasks. An unverifiable answer is
// not converted into a recorded misconception, and no old answer is copied.
const receipt = { questionEvaluations: [{ questionId: 'Q1', evaluation: { criteria: [
  { id: 'judgment_accuracy', state: 'fail', reason: '已核验的具体判断问题' },
  { id: 'judgment_conditions', state: 'unverifiable', reason: '不是已核验的错误' },
] } }] } as unknown as QuickCheckAssessment;
const past = appendQuickCheckHistory([], { questions: [{ id: 'Q1', prompt: '旧任务', criterionIds: ['judgment_accuracy', 'judgment_conditions'] }] } as any, receipt);
assert.deepEqual(past[0].gaps, [{ id: 'judgment_accuracy', summary: '已核验的具体判断问题' }]);

const note: NoteItem = { id: 'isolated-diversity', title: '合成观察概念', noteType: 'knowledge',
  content: '## 定义\n观察条件可能改变表现。\n\n## 边界\n观察后表现变化不能单独证明干预有效。\n\n## 应用\n比较干预时需要区分观察条件，并检查支持判断的证据。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-19', updatedAt: '2026-10-19' };
let calls = 0, repeatQ2Once = false;
const packets: any[] = [];
const call = async (request: any) => {
  const input = JSON.parse(request.userInput); packets.push(input); calls++;
  assert.match(request.systemPromptOverride, /Q2\/Q3也不得重复同一命题/u);
  assert.match(request.systemPromptOverride, /不能在题干先告诉/u);
  assert.ok(!request.userInput.includes('NEVER_SEND'));
  const raw = quickCheckDesignFixture(request, { questions: input.requestedSlots.map((id: string) => {
    const index = Number(id.slice(1)) - 1, target = input.targets[index % input.targets.length];
    const ref = input.references.find((ref: any) => ref.criterionIds.includes(target.id));
    return { id, type: index ? 'choice' : 'open', prompt: `合成任务${calls}-${id}，本题用于验证协议轮换而非真实语义质量`,
      criterionIds: [target.id], referenceIds: [ref.id],
      ...(index ? { options: [{ id: 'A', text: '方案甲' }, { id: 'B', text: '方案乙' }] } : {}),
      privateAnswer: { ...(index ? { optionId: 'A' } : {}), explanation: '合成传输契约，不代表语义正确性。',
        referenceQuotes: [{ referenceId: ref.id, quote: ref.quote.slice(0, 160) }] } };
  }) });
  if (repeatQ2Once && raw.questions.some((question: any) => question.id === 'Q2')) {
    repeatQ2Once = false;
    raw.questions.find((question: any) => question.id === 'Q2')!.design.focus = input.recentDesigns[1].design.focus;
  }
  return { content: JSON.stringify(raw) };
};
const readers = { searchNotes: async () => [] };
const first = await generateQuickCheck({ note, readers, call });
assert.equal(calls, 1);
assert.ok(first.questions.every(question => question.design));
const recent = appendQuickCheckHistory([], first);
repeatQ2Once = true;
const second = await generateQuickCheck({ note, readers, call, recentQuestions: recent, previousQuestions: first.questions.map(question => question.prompt) });
assert.equal(calls, 3, 'one replacement for the repeated closed question only');
assert.deepEqual(packets[2].requestedSlots, ['Q2']);
assert.deepEqual(packets[2].retainedQuestions.map((question: any) => question.id), ['Q1', 'Q3']);
assert.equal(second.questions[0].prompt, '合成任务2-Q1，本题用于验证协议轮换而非真实语义质量');
assert.equal(second.questions[2].prompt, '合成任务2-Q3，本题用于验证协议轮换而非真实语义质量');
assert.notEqual(second.questions[1].design!.focus, first.questions[1].design!.focus);

// Real store persistence carries design history through refresh and restart;
// all-skipped cards still retain their questions without any generation call.
const cache = new Map<string, string>();
const storage = { getItem: (key: string) => cache.get(key) || null, setItem: (key: string, value: string) => { cache.set(key, value); } };
const runtime = { notes: [note], onCommit: async (session: any, assessment: any) => applyQuickCheckAssessment([note], session, assessment).result };
const adapters = { generate: (options: any) => generateQuickCheck({ ...options, readers, call }) };
let store = new QuickCheckStore(runtime, 'isolated-design-history', storage, adapters);
async function until(phase: string) {
  for (let attempt = 0; attempt < 150 && store.getSnapshot().draft?.phase !== phase; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(store.getSnapshot().draft?.phase, phase, store.getSnapshot().draft?.error);
}
store.open({ noteId: note.id }); await until('ready');
const storeFirst = structuredClone(store.getSnapshot().draft!.session!);
store.refresh(); await until('ready');
assert.deepEqual(store.getSnapshot().draft!.recentQuestions, appendQuickCheckHistory([], storeFirst));
assert.ok(packets.at(-1).recentDesigns.length === 3);
store.dispose();
const beforeRestore = calls;
store = new QuickCheckStore(runtime, 'isolated-design-history', storage, adapters);
store.open({ noteId: note.id }); await until('ready');
assert.equal(calls, beforeRestore, 'restart resumes, not generates');
assert.equal(store.getSnapshot().draft!.recentQuestions!.length, 3);
const beforeSkip = structuredClone(store.getSnapshot().draft!.session!.questions);
store.next(true); store.next(true); store.next(true); await until('result');
store.continue(); await until('ready');
assert.equal(calls, beforeRestore, 'all skipped questions still reused');
assert.deepEqual(store.getSnapshot().draft!.session!.questions, beforeSkip);
assert.equal(store.getSnapshot().draft!.recentQuestions!.length, 6);
store.dispose();
assert.equal(note.dsrState, undefined);
console.log('PASS all-slot task rotation, specific gap guidance, closed-question focus/scene duplicates, targeted replacement, bounded history, no answer leakage, restart persistence and skip retention. Synthetic contracts only; real model diversity not yet measured.');
