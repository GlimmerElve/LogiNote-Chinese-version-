import assert from 'node:assert/strict';
import { generateQuickCheck, evaluateQuickCheck, applyQuickCheckAssessment, type QuickCheckQuestion } from '../src/services/quickCheck';
import { shuffleQuickCheckOptions, hasPositionDependentChoice } from '../src/services/quickCheck/optionOrder';
import { createSunkCostCard, sunkCostNote, sunkCostAnswers, sunkCostEvaluationFixture } from './fixtures/quick-check-sunk-cost';
import { quickCheckDesignFixture } from './fixtures/quick-check-design';
import { QuickCheckStore } from '../src/components/quickCheck/store';

globalThis.fetch = async () => assert.fail('No cloud or real vault in option-order tests');
const base = await createSunkCostCard(), original = JSON.stringify(base);
const correctText = base.questions[1].options!.find(option => option.id === 'D')!.text;

// Exhaust every Fisher-Yates draw path for two, three and four options. With a
// model that ALWAYS returns A, each displayed answer position has equal weight.
for (const count of [2, 3, 4]) {
  const question: QuickCheckQuestion = { ...base.questions[1], options: Array.from({ length: count }, (_, index) =>
    ({ id: 'ABCD'[index], text: `选项内容${index}` })), privateAnswer: { ...base.questions[1].privateAnswer, optionId: 'A' } };
  const paths: number[][] = [];
  function enumerate(upper: number, draws: number[]) {
    if (upper < 2) { paths.push(draws); return; }
    for (let pick = 0; pick < upper; pick++) enumerate(upper - 1, [...draws, pick]);
  }
  enumerate(count, []);
  const permutations = new Set<string>(), positions = new Map<string, number>();
  for (const path of paths) {
    let offset = 0;
    const shuffled = shuffleQuickCheckOptions(question, upper => {
      assert.equal(upper, count - offset); return path[offset++];
    });
    permutations.add(shuffled.options!.map(option => option.text).join('|'));
    const answer = shuffled.privateAnswer.optionId!;
    positions.set(answer, (positions.get(answer) || 0) + 1);
    assert.equal(shuffled.options!.find(option => option.id === answer)!.text, '选项内容0');
    assert.deepEqual(shuffled.options!.map(option => option.id), 'ABCD'.slice(0, count).split(''));
  }
  assert.equal(permutations.size, paths.length, 'each permutation corresponds to exactly one draw path');
  assert.deepEqual([...positions.values()], Array(count).fill(paths.length / count));
}
assert.equal(shuffleQuickCheckOptions(base.questions[0], () => assert.fail('no shuffle for open')), base.questions[0]);
assert.equal(shuffleQuickCheckOptions(base.questions[2], () => assert.fail('stable true/false order')), base.questions[2]);
assert.throws(() => shuffleQuickCheckOptions(base.questions[1], () => -1), /排序失败/u);
assert.throws(() => shuffleQuickCheckOptions(base.questions[1], upper => upper), /排序失败/u);
assert.equal(JSON.stringify(base), original);
assert.ok(hasPositionDependentChoice({ ...base.questions[1], privateAnswer: { ...base.questions[1].privateAnswer, explanation: '正确答案为A。' } }));
assert.ok(hasPositionDependentChoice({ ...base.questions[1], options: [{ id: 'A', text: '以上都正确' }] }));
assert.ok(!hasPositionDependentChoice({ ...base.questions[1], prompt: 'A组与B组接受不同处理，如何比较？',
  privateAnswer: { ...base.questions[1].privateAnswer, explanation: '比较两组条件；数列第一项是3。' } }));
for (const prompt of ['已知命题A与B均正确，下面哪个推导有效？', '集合A和B都符合约束，如何比较？',
  '方案A、B均正确，但成本不同，如何选择？']) {
  assert.ok(!hasPositionDependentChoice({ ...base.questions[1], prompt }), 'named domain objects are not choice positions');
}
assert.ok(hasPositionDependentChoice({ ...base.questions[1], options: [{ id: 'A', text: '选项A和选项B均正确' }] }));

// Production generation boundary shuffles AFTER validation and BEFORE contract
// freeze. Original D becomes C in this deterministic nonidentity permutation.
let generationCalls = 0;
const shuffled = await generateQuickCheck({ note: sunkCostNote, readers: { searchNotes: async () => [] }, optionRandomInt: () => 0,
  call: async request => { generationCalls++; return { content: JSON.stringify(quickCheckDesignFixture(request, { questions: base.questions })) }; } });
assert.equal(generationCalls, 1);
assert.equal(shuffled.questions[1].privateAnswer.optionId, 'C');
assert.equal(shuffled.questions[1].options!.find(option => option.id === 'C')!.text, correctText);
assert.deepEqual(shuffled.questions[2], base.questions[2], 'true/false is not reordered');
const answers = sunkCostAnswers.map(answer => answer.questionId === 'Q2' ? { ...answer, optionId: 'C' } : answer);
let gradingCalls = 0;
const assessment = await evaluateQuickCheck(shuffled, answers, { call: async request => {
  gradingCalls++;
  assert.ok(!request.userInput.includes('privateAnswer'));
  const input = JSON.parse(request.userInput);
  const raw = sunkCostEvaluationFixture(request);
  for (const row of raw.questionEvaluations) if (row.questionId === 'Q2') {
    const task = input.questionTasks.find((task: any) => task.questionId === row.questionId);
    const independentlyLocated = /^([ABCD])\. 过去无法收回的投入不应决定未来选择，但过去的错误仍需复盘$/mu.exec(task.task.prompt)?.[1];
    assert.equal(independentlyLocated, 'C', 'grader receives displayed order, not the generator order');
    row.answerKey!.optionId = independentlyLocated!;
    row.answerKey!.explanation = '独立核对当前选项的具体含义，不使用出题旧字母。';
    for (const criterion of row.result.criteria) { criterion.state = 'pass'; delete criterion.comparison; criterion.reason = '所选内容与资料中的边界一致。'; }
  }
  return { content: JSON.stringify(raw) };
} });
assert.equal(gradingCalls, 1);
const committed = applyQuickCheckAssessment([sunkCostNote], shuffled, assessment);
assert.ok(committed.applied);
assert.equal(committed.result.details[1].correct, true);
assert.equal(committed.result.details[1].referenceAnswer, `C. ${correctText}`);
assert.equal(committed.notes[0].dsrState!.masteryShadow!.layers.concept.criteria!.concept_boundary.independentPasses, 1);
assert.equal(applyQuickCheckAssessment(committed.notes, shuffled, JSON.parse(JSON.stringify(assessment))).notes, committed.notes);

// If a grader retains an old-letter bias inconsistent with its own verdict,
// retry only that question once; never silently reinterpret the user's letter.
let conflictCalls = 0;
const recovered = await evaluateQuickCheck(shuffled, answers, { call: async request => {
  conflictCalls++;
  const input = JSON.parse(request.userInput), raw = sunkCostEvaluationFixture(request);
  if (conflictCalls === 2) assert.deepEqual(input.questionTasks.map((task: any) => task.questionId), ['Q2']);
  for (const row of raw.questionEvaluations) if (row.questionId === 'Q2') {
    row.answerKey!.optionId = conflictCalls === 1 ? 'A' : 'C';
    row.answerKey!.explanation = '独立核对当前选项含义。';
    for (const criterion of row.result.criteria) { criterion.state = 'pass'; delete criterion.comparison; criterion.reason = '当前选择满足本题资料要求。'; }
  }
  return { content: JSON.stringify(raw) };
} });
assert.equal(conflictCalls, 2);
assert.equal(applyQuickCheckAssessment([sunkCostNote], shuffled, recovered).result.details[1].referenceAnswer, `C. ${correctText}`);

// All skipped/retained questions keep their displayed order; no model or random
// calls are allowed on that path, even when the new RNG would move every option.
const retained = await generateQuickCheck({ note: sunkCostNote, reuseSkipped: { session: shuffled,
  answers: shuffled.questions.map(question => ({ questionId: question.id, skipped: true })) },
  readers: { searchNotes: async () => assert.fail('no retrieval') }, call: async () => assert.fail('no generation'),
  optionRandomInt: () => assert.fail('never reshuffle retained choices') });
assert.deepEqual(retained.questions, shuffled.questions);

// Cache/reopen preserves both ordering and an in-progress selected ID.
const cache = new Map<string, string>();
const storage = { getItem: (key: string) => cache.get(key) || null, setItem: (key: string, value: string) => { cache.set(key, value); } };
const runtime = { notes: [sunkCostNote], onCommit: async () => committed.result };
const adapters = { generate: async () => shuffled };
let store = new QuickCheckStore(runtime, 'isolated-option-order', storage, adapters);
store.open({ noteId: sunkCostNote.id });
await new Promise(resolve => setTimeout(resolve, 0));
store.answer(answers[0]); store.next(); store.answer(answers[1]); store.close(); store.dispose();
store = new QuickCheckStore(runtime, 'isolated-option-order', storage, { generate: async () => assert.fail('cached card must resume') });
store.open({ noteId: sunkCostNote.id });
assert.deepEqual(store.getSnapshot().draft!.session!.questions, shuffled.questions);
assert.equal(store.getSnapshot().draft!.answers.find(answer => answer.questionId === 'Q2')!.optionId, 'C');
store.dispose();
console.log('PASS uniform option positions for all 2/3/4-option permutations, remapped keys, displayed-order grading, correct feedback/mastery writes, replay, cache resume and skip retention. Synthetic only.');
