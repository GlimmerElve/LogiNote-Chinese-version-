import assert from 'node:assert/strict';
import type { NoteItem } from '../src/types';
import { quickCheckTargets } from '../src/services/quickCheck';
import { createMasteryShadowState } from '../src/services/masteryShadow/stateMachine';
import { quickCheckStemKey, repeatedQuickCheckSlots } from '../src/services/quickCheck/diversity';
import { quickCheckDesignFixture, generateQuickCheckFixture as generateQuickCheck } from './fixtures/quick-check-design';

globalThis.fetch = async () => assert.fail('isolated contract tests must not call cloud');
const note: NoteItem = { id: 'generation-policy', title: '观察效应', noteType: 'knowledge',
  content: '## 含义\n意识到受到观察可能改变行为。\n## 边界\n不能只凭观察后成绩提高证明教学干预有效。\n## 应用\n比较时需区分观察条件。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-19', updatedAt: '2026-10-19' };
const progress = structuredClone(note), state = createMasteryShadowState(note.id);
progress.dsrState = { difficulty: 5, stability: 2, reviewCount: 0, lastReviewedAt: null,
  consecutiveCorrect: 0, consecutiveWrong: 0, masteryShadow: state };
for (const row of Object.values(state.layers.concept.criteria!)) {
  row.state = 'provisional'; row.independentPasses = 1; row.recentEvidenceIds = ['first'];
}
assert.deepEqual(quickCheckTargets(progress).map(row => row.id), ['concept_accuracy', 'concept_boundary', 'concept_application']);
state.layers.judgment.criteria!.judgment_accuracy.state = 'needs_review';
assert.deepEqual(quickCheckTargets(progress).map(row => row.id), ['concept_accuracy', 'concept_boundary', 'concept_application'],
  'pending confirmations precede known errors');
state.layers.concept.criteria!.concept_accuracy.state = 'unassessed';
state.layers.concept.criteria!.concept_accuracy.independentPasses = 0;
assert.deepEqual(quickCheckTargets(progress).map(row => row.id), ['concept_boundary', 'concept_application', 'judgment_accuracy'],
  'fill remaining slots with needs-review before unassessed');
assert.equal(quickCheckTargets(progress, ['reasoning_relevance'])[0].id, 'reasoning_relevance', 'explicit request overrides default priority');
for (const layer of Object.values(state.layers)) for (const row of Object.values(layer.criteria!)) {
  row.state = 'confirmed'; row.independentPasses = 2; row.recentEvidenceIds = ['confirmed'];
}
state.layers.reasoning.criteria!.reasoning_consistency.state = 'unassessed';
assert.deepEqual(quickCheckTargets(progress).map(row => row.id), ['reasoning_consistency'], 'do not fill gaps with confirmed targets');
assert.equal(quickCheckTargets(progress, ['concept_accuracy'])[0].id, 'concept_accuracy', 'explicit maintenance remains allowed');
assert.equal(quickCheckStemKey(' “ABC” 是什么？ '), quickCheckStemKey('abc是什么!'));
assert.deepEqual(repeatedQuickCheckSlots([{ id: 'Q1', prompt: '旧题？' }], ['旧题。'], []), ['Q1']);

let calls = 0;
const packets: any[] = [];
let repeatForever = false;
async function call(request: any) {
  const input = JSON.parse(request.userInput); packets.push(input); calls++;
  assert.match(request.systemPromptOverride, /参考资料是最高依据/);
  assert.match(request.systemPromptOverride, /新情境无需出现在引用原文里/);
  assert.match(request.systemPromptOverride, /译名辨认不能冒充条件判断/);
  assert.ok(input.targets.every((target: any) => target.question?.length));
  assert.ok(!request.userInput.includes('privateAnswer'), 'no retained answer keys sent');
  return { content: JSON.stringify(quickCheckDesignFixture(request, { questions: input.requestedSlots.map((id: string) => {
    const index = Number(id.slice(1)) - 1, target = input.targets[index % input.targets.length];
    const reference = input.references.find((ref: any) => ref.criterionIds.includes(target.id));
    const prompt = repeatForever || calls === 1 && id === 'Q2' ? '这是旧题？' : `新情境任务${calls}-${id}`;
    return { id, type: index ? 'choice' : 'application', prompt, criterionIds: [target.id], referenceIds: [reference.id],
      ...(index ? { options: [{ id: 'A', text: '符合' }, { id: 'B', text: '不符合' }] } : {}),
      privateAnswer: { ...(index ? { optionId: 'A' } : {}), explanation: '合成契约，不证明真实语义质量。',
        referenceQuotes: [{ referenceId: reference.id, quote: reference.quote.slice(0, 160) }] } };
  }) })) };
}
const card = await generateQuickCheck({ note, previousQuestions: ['这是旧题。'], readers: { searchNotes: async () => [] }, call });
assert.equal(calls, 2, 'one bounded replacement, not a new whole card');
assert.deepEqual(packets[1].requestedSlots, ['Q2']);
assert.deepEqual(packets[1].retainedQuestions.map((q: any) => q.id), ['Q1', 'Q3']);
assert.equal(card.questions[0].prompt, '新情境任务1-Q1');
assert.equal(card.questions[1].prompt, '新情境任务2-Q2');
const retained = await generateQuickCheck({ note, previousQuestions: card.questions.map(q => q.prompt),
  reuseSkipped: { session: card, answers: card.questions.map(q => ({ questionId: q.id, skipped: true })) },
  call: async () => assert.fail('all-skipped questions never regenerated'), readers: { searchNotes: async () => assert.fail('no retrieval') } });
assert.deepEqual(retained.questions, card.questions);
repeatForever = true; const before = calls;
await assert.rejects(() => generateQuickCheck({ note, previousQuestions: ['这是旧题。'], call,
  readers: { searchNotes: async () => [] } }), /仍返回重复题/);
assert.equal(calls, before + 2, 'no unbounded regeneration');
console.log('PASS reference/model division, real rubric injection, pending > needs-review > unassessed priority, explicit override, confirmed exclusion, bounded duplicate replacement, skip retention. Synthetic contracts only.');
