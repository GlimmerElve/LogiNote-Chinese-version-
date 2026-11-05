import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NoteItem } from '../src/types';
import type { QuickCheckSession, QuickCheckAssessment, QuickCheckResult } from '../src/services/quickCheck';
import { QuickCheckStore, type QuickCheckAdapters, type QuickCheckRuntime } from '../src/components/quickCheck/store';
import { QuickCheckCard, QuickCheckProvider, QuickCheckButton } from '../src/components/quickCheck';
import { quickCheckQuestionReferences } from '../src/components/quickCheck/references';
import { KnowledgeMasteryStatus } from '../src/components/KnowledgeMasteryStatus';
import { planLegacyMasteryMigration } from '../src/services/masteryShadow/legacyMigration';

// Synthetic answers, in-memory cache and injected model boundaries only. Never
// connects to Electron, a real vault, network or a cloud model.
const note: NoteItem = { id: 'synthetic', title: '简测合成知识点', noteType: 'knowledge',
  content: '参考正文A', tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-18', updatedAt: '2026-10-18' };
const result: QuickCheckResult = { headline: '本次补齐了概念应用', remaining: ['适用边界'], nextAction: '换个情境确认适用条件', changed: true,
  details: [{ questionId: 'Q1', prompt: '如何应用？', answer: '独立回答', explanation: '提交后的解析专属文本' },
    { questionId: 'Q2', prompt: '如何辨别？', answer: '选项A', correct: false, referenceAnswer: 'B. 有据的正确选项', explanation: '本题需要修正。' },
    { questionId: 'Q3', prompt: '判断题？', answer: '选项A', referenceAnswer: 'B. 出题时的参考选项', explanation: '当前核验不足。' }] };
let generation = 0, evaluation = 0, commits = 0;
const histories: Array<string[] | undefined> = [];
let failGenerate = false, failEvaluate = false, failSave = false;
const makeSession = (n: NoteItem): QuickCheckSession => ({ version: 1, id: `S${++generation}`, noteId: n.id, noteTitle: n.title,
  sourceKey: n.content, masteryKey: n.updatedAt, createdAt: '2026-10-18', contractKey: 'synthetic-contract',
  targets: [{ id: 'concept_accuracy', label: '概念含义', layer: 'concept', state: 'unassessed' }],
  questions: [0, 1, 2].map(index => ({ id: `Q${index + 1}`, type: index === 0 ? 'application' : 'choice',
    prompt: index === 0 ? '如何应用？' : `辨别问题${index + 1}`, criterionIds: ['concept_accuracy'], referenceIds: ['REF1'],
    ...(index ? { options: [{ id: 'A', text: '选项A' }, { id: 'B', text: '选项B' }] } : {}),
    privateAnswer: { optionId: index ? 'A' : undefined, explanation: '绝不可提前泄露的答案', referenceQuotes: [{ referenceId: 'REF1', quote: '参考正文' }] } })),
  references: [{ id: 'REF1', tier: 3, sourceLabel: '知识点笔记', quote: '参考正文', criterionIds: ['concept_accuracy'] }] });
const adapters: Partial<QuickCheckAdapters> = {
  sourceKey: n => n.content, masteryKey: n => n.updatedAt,
  generate: async ({ note: n, previousQuestions }) => {
    if (failGenerate) throw new Error('合成出题失败'); histories.push(previousQuestions); return makeSession(n);
  },
  evaluate: async (session, answers) => {
    evaluation++;
    if (failEvaluate) throw new Error('合成评价失败');
    return { version: 1, sessionId: session.id, attemptId: `ATTEMPT-${session.id}`, answers, assessedAt: '2026-10-18',
      input: {}, evaluation: {} } as QuickCheckAssessment;
  },
};
const runtime: QuickCheckRuntime = { notes: [note], onCommit: async () => {
  commits++; if (failSave) throw new Error('合成保存失败'); return result;
} };
const cache = new Map<string, string>();
const storage = { getItem: (key: string) => cache.get(key) || null, setItem: (key: string, value: string) => { cache.set(key, value); } };
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const store = new QuickCheckStore(runtime, 'synthetic-vault-A', storage, adapters);
const current = () => store.getSnapshot().draft!;
function complete(s: QuickCheckStore) {
  s.answer({ questionId: 'Q1', text: '独立回答' }); s.next();
  s.answer({ questionId: 'Q2', optionId: 'A' }); s.next();
  s.answer({ questionId: 'Q3', optionId: 'B' }); s.next();
}
const card = () => renderToStaticMarkup(<QuickCheckCard draft={current()} onClose={() => store.close()} onAnswer={answer => store.answer(answer)}
  onRefresh={() => store.refresh()} onConfirmRefresh={store.confirmRefresh} onCancelRefresh={store.cancelRefresh}
  onFormulaDraftChange={latex => store.setFormulaDraft(latex)}
  onNext={skip => store.next(skip)} onAssist={() => store.assist()} onRetry={store.retry} onContinue={store.continue} />);

assert.equal(generation, 0, 'constructing a provider is passive');
assert.equal(store.open({ noteId: 'not-found' }), false);
assert.equal(store.open({ noteId: note.id, source: 'test' }), true);
store.open({ noteId: note.id, source: 'duplicate' });
await settle();
assert.equal(generation, 1, 'double open coalesces the in-flight generation');
assert.equal(current().phase, 'ready');
assert.equal(current().step, 0);
assert.match(card(), /重新出题/u, 'production card renders an accessible manual refresh button');
assert.ok(card().includes('<textarea'));
assert.ok(!card().includes('选项A') && !card().includes('绝不可提前泄露'), 'choices and answer keys are not in the open-question DOM');
store.next(); assert.equal(current().step, 0, 'blank is not implicitly submitted as wrong');
store.answer({ questionId: 'Q1', text: '保留的原答' });
store.close(); assert.equal(store.getSnapshot().open, false);
store.open({ noteId: note.id, criterionIds: ['concept_accuracy'], source: 'another-entry' });
assert.equal(generation, 1, 'all entry points resume the same unanswered card');
assert.equal(current().answers[0].text, '保留的原答');
store.next(); assert.equal(current().step, 1);
store.answer({ questionId: 'Q1', text: '看选项后试图改答' });
assert.equal(current().answers[0].text, '保留的原答', 'open response is locked once choices are visible');
assert.ok(!card().includes('<textarea') && card().includes('type="radio"'));
store.next(true); assert.equal(current().answers.find(a => a.questionId === 'Q2')?.skipped, true);
store.assist();
store.answer({ questionId: 'Q3', optionId: 'A' });
assert.ok(current().answers.every(a => a.assisted), 'opening reference marks past and future answers assisted');
failSave = true;
store.next(); store.next();
assert.equal(store.open({ noteId: note.id }), false, 'submission cannot switch or reopen a card');
store.close(); assert.equal(store.getSnapshot().open, true, 'saving cannot be silently closed');
await settle();
assert.equal(evaluation, 1, 'duplicate submit does not duplicate evaluation');
assert.equal(commits, 1); assert.equal(current().phase, 'error');
assert.ok(card().includes('重试保存'));
const attempt = current().assessment?.attemptId;
failSave = false;
store.retry(); store.retry(); await settle();
assert.equal(evaluation, 1, 'save retry reuses evaluation');
assert.equal(commits, 2); assert.equal(current().assessment?.attemptId, attempt);
assert.equal(current().phase, 'result');
assert.ok(card().includes('本次补齐了概念应用') && card().includes('仍需确认：适用边界'));
assert.ok(card().includes('<details') && card().includes('提交后的解析专属文本'));
assert.ok(card().includes('正确答案') && card().includes('B. 有据的正确选项'));
assert.ok(card().includes('出题参考答案（尚未核验）'), 'a withheld verdict never hides the draft reference key or falsely certifies it');
assert.ok(!card().includes('百分') && !card().includes('九项'));
store.close(); store.open({ noteId: note.id });
assert.equal(current().phase, 'result'); assert.equal(generation, 1, 'reopening a completed result is not another paid model call');
store.continue(); await settle();
assert.equal(generation, 2, 'only continue requests another card after completion');
assert.deepEqual(histories.at(-1), ['如何应用？', '辨别问题2', '辨别问题3'], 'the next generation sees prior stems, not prior answers');
assert.ok(!JSON.stringify(histories.at(-1)).includes('绝不可提前泄露') && !JSON.stringify(histories.at(-1)).includes('选项A'));
const continuedId = current().session!.id, callsBeforeResume = generation;
store.close(); store.open({ noteId: note.id }); await settle();
assert.equal(current().session!.id, continuedId); assert.equal(generation, callsBeforeResume, 'unanswered varied cards still resume without regeneration');
assert.deepEqual(current().previousQuestions, ['如何应用？', '辨别问题2', '辨别问题3']);

// Unanswered cards refresh on substantive mastery change; populated answers do
// not disappear, even if a note or another learning flow updates its mastery.
const updated = { ...note, updatedAt: 'changed-mastery' };
store.setRuntime({ ...runtime, notes: [updated] }); store.reconcileNotes(); await settle();
assert.equal(generation, 3); assert.equal(current().session?.masteryKey, updated.updatedAt);
store.answer({ questionId: 'Q1', text: '变化前已经填入的答案' });
const again = { ...updated, updatedAt: 'changed-again' };
store.setRuntime({ ...runtime, notes: [again] }); store.reconcileNotes(); await settle();
assert.equal(generation, 3); assert.equal(current().stale, true);
assert.equal(current().answers[0].text, '变化前已经填入的答案');
assert.ok(card().includes('下一张将按最新情况出题'));
store.close();
const reopened = new QuickCheckStore({ ...runtime, notes: [again] }, 'synthetic-vault-A', storage, adapters);
reopened.open({ noteId: note.id });
assert.equal(reopened.getSnapshot().draft?.answers[0].text, '变化前已经填入的答案', 'answers survive process recreation within the same vault');
assert.equal(reopened.getSnapshot().draft?.stale, true);
const otherVault = new QuickCheckStore(runtime, 'synthetic-vault-B', storage, adapters);
otherVault.open({ noteId: note.id }); await settle();
assert.equal(otherVault.getSnapshot().draft?.answers.length, 0, 'drafts never cross vault scope');

// Generation/evaluation failures retain input and can be retried independently.
failGenerate = true;
const failed = new QuickCheckStore(runtime, undefined, undefined, adapters);
failed.open({ noteId: note.id }); await settle(); assert.equal(failed.getSnapshot().draft?.phase, 'error');
failGenerate = false; failed.retry(); await settle(); assert.equal(failed.getSnapshot().draft?.phase, 'ready');
failEvaluate = true; complete(failed); await settle(); assert.equal(failed.getSnapshot().draft?.phase, 'error');
assert.equal(failed.getSnapshot().draft?.answers.length, 3);
failEvaluate = false; failed.retry(); await settle(); assert.equal(failed.getSnapshot().draft?.phase, 'result');

// All-skipped attempts are a valid response set, not three synthetic failures.
const skipped = new QuickCheckStore(runtime, undefined, undefined, adapters);
skipped.open({ noteId: note.id }); await settle(); skipped.next(true); skipped.next(true); skipped.next(true); await settle();
assert.ok(skipped.getSnapshot().draft?.assessment?.answers.every(answer => answer.skipped));

// Source mutation blocks stale evaluation locally while retaining the draft.
const staleSource = new QuickCheckStore(runtime, undefined, undefined, adapters);
staleSource.open({ noteId: note.id }); await settle();
staleSource.answer({ questionId: 'Q1', text: '原参考上的作答' });
staleSource.setRuntime({ ...runtime, notes: [{ ...note, content: '完全不同的新参考正文' }] }); staleSource.reconcileNotes();
const evaluationsBeforeStale = evaluation;
staleSource.next(); staleSource.next(true); staleSource.next(true); await settle();
assert.equal(staleSource.getSnapshot().draft?.errorStage, 'source'); assert.equal(evaluation, evaluationsBeforeStale);
assert.equal(staleSource.getSnapshot().draft?.answers[0].text, '原参考上的作答');
staleSource.retry(); await settle(); assert.equal(staleSource.getSnapshot().draft?.phase, 'ready');
assert.equal(staleSource.getSnapshot().draft?.answers.length, 0, 'explicit restart replaces the obsolete card');

let allowed = false;
const gated = new QuickCheckStore({ ...runtime, canOpen: () => allowed }, undefined, undefined, adapters);
assert.equal(gated.open({ noteId: note.id }), false); allowed = true; assert.equal(gated.open({ noteId: note.id }), true); await settle();
const providerHtml = renderToStaticMarkup(<QuickCheckProvider notes={[note]} onCommit={runtime.onCommit} storageScope="synthetic-ssr">
  <QuickCheckButton noteId={note.id} source="knowledge-note" />
</QuickCheckProvider>);
assert.ok(providerHtml.includes('定向简测') && providerHtml.includes('quick-check-entry'));
assert.ok(!providerHtml.includes('quick-check-dialog'), 'mounting passive entry points never opens a card');
assert.equal(renderToStaticMarkup(<QuickCheckButton noteId={note.id} />), '', 'previews without a global host hide the nonfunctional action');

// UI and store share the evaluator's 4000-character boundary. An older long
// cached draft is brought back to the editable open question, not locked away.
const lengthStore = new QuickCheckStore(runtime, undefined, undefined, adapters);
lengthStore.open({ noteId: note.id }); await settle();
lengthStore.answer({ questionId: 'Q1', text: '长'.repeat(4001) }); lengthStore.next();
assert.equal(lengthStore.getSnapshot().draft?.step, 0);
const longDraft = structuredClone(lengthStore.getSnapshot().draft!); longDraft.step = 1;
const longStorage = { getItem: () => JSON.stringify({ version: 1, entries: [longDraft] }), setItem: () => {} };
const longRestored = new QuickCheckStore(runtime, 'synthetic-long-cache', longStorage, adapters);
longRestored.open({ noteId: note.id });
assert.equal(longRestored.getSnapshot().draft?.step, 0);
assert.equal(longRestored.getSnapshot().draft?.answers[0].text?.length, 4001);
longRestored.answer({ questionId: 'Q1', text: '长'.repeat(4000) }); longRestored.next();
assert.equal(longRestored.getSnapshot().draft?.step, 1);
assert.ok(card().includes('maxLength="4000"') || card().includes('maxlength="4000"') || current().step !== 0);

// A damaged cache is discarded before it can reach .map() or React children.
for (const mutate of [
  (d: any) => { d.session.questions[1].options = { A: 'not-an-array' }; },
  (d: any) => { d.session.questions[1].options[0].text = { unexpected: 'object' }; },
  (d: any) => { d.session.targets[0].label = {}; },
  (d: any) => { d.answers = [{ questionId: 'Q2', optionId: 'OUTSIDE' }]; },
  (d: any) => { d.result = { ...result, remaining: [{}] }; },
  (d: any) => { d.previousQuestions = Array(7).fill('超量历史题干'); },
  (d: any) => { d.previousQuestions = [{ privateAnswer: '不能作为题干历史' }]; },
]) {
  const damaged = structuredClone(longDraft); mutate(damaged);
  const damagedStorage = { getItem: () => JSON.stringify({ version: 1, entries: [damaged] }), setItem: () => {} };
  const safe = new QuickCheckStore(runtime, 'synthetic-damaged', damagedStorage, adapters);
  const beforeOpen = generation;
  safe.open({ noteId: note.id }); await settle();
  assert.equal(generation, beforeOpen + 1, 'damaged cache is not reused');
  assert.equal(safe.getSnapshot().draft?.phase, 'ready');
}

// StrictMode-style effect replay reactivates a store, while a real unmount
// prevents an already pending model completion from persisting or committing.
const replayed = new QuickCheckStore(runtime, undefined, undefined, adapters);
replayed.activate(); replayed.dispose(); replayed.activate();
assert.equal(replayed.open({ noteId: note.id }), true); await settle();
assert.equal(replayed.getSnapshot().draft?.phase, 'ready');
// A review can save and immediately open a card before React's notes/effects
// catch up. The live getter is authoritative for generation and freshness.
let liveNotes = [{ ...note, updatedAt: 'saved-new-mastery', content: '刚保存后的参考正文' }];
const immediateAfterReview = new QuickCheckStore({ ...runtime, getNotes: () => liveNotes }, undefined, undefined, adapters);
immediateAfterReview.open({ noteId: note.id, source: 'review-result' }); await settle();
assert.equal(immediateAfterReview.getSnapshot().draft?.session?.masteryKey, 'saved-new-mastery');
assert.equal(immediateAfterReview.getSnapshot().draft?.session?.sourceKey, '刚保存后的参考正文');
liveNotes = [{ ...liveNotes[0], updatedAt: 'saved-again-before-effect' }];
immediateAfterReview.reconcileNotes(); await settle();
assert.equal(immediateAfterReview.getSnapshot().draft?.session?.masteryKey, 'saved-again-before-effect');
let resolvePending: ((session: QuickCheckSession) => void) | undefined;
let delayedWrites = 0;
const delayed = new QuickCheckStore(runtime, 'synthetic-pending', { getItem: () => null, setItem: () => { delayedWrites++; } },
  { ...adapters, generate: () => new Promise(resolve => { resolvePending = resolve; }) });
delayed.open({ noteId: note.id });
const writesAtUnmount = delayedWrites, commitsAtUnmount = commits;
delayed.dispose(); resolvePending!(makeSession(note)); await settle();
assert.equal(delayedWrites, writesAtUnmount); assert.equal(commits, commitsAtUnmount);
assert.equal(delayed.getSnapshot().draft?.phase, 'generating');

// Pending MathLive input is a real draft even before it is inserted into the
// text. It blocks skip/next, survives restart and prevents automatic replacement.
const formulaStore = new QuickCheckStore(runtime, 'synthetic-formula', storage, adapters);
formulaStore.open({ noteId: note.id }); await settle();
formulaStore.setFormulaDraft('\\frac{1}{2}');
assert.equal(formulaStore.getSnapshot().draft?.assisted, false, 'formula formatting is not assistance');
formulaStore.next(); formulaStore.next(true);
assert.equal(formulaStore.getSnapshot().draft?.step, 0, 'uninserted formulas cannot be skipped or locked away');
const formulaGeneration = generation;
formulaStore.setRuntime({ ...runtime, notes: [{ ...note, updatedAt: 'formula-mastery-changed' }] }); formulaStore.reconcileNotes(); await settle();
assert.equal(generation, formulaGeneration, 'formula-only drafts protect against automatic mastery refresh');
formulaStore.close();
const formulaRestored = new QuickCheckStore(runtime, 'synthetic-formula', storage, adapters);
formulaRestored.open({ noteId: note.id });
assert.equal(formulaRestored.getSnapshot().draft?.formulaDraft, '\\frac{1}{2}');
assert.equal(formulaRestored.getSnapshot().draft?.step, 0);
formulaRestored.answer({ questionId: 'Q1', text: '答案 $\\frac{1}{2}$' }); formulaRestored.next();
assert.equal(formulaRestored.getSnapshot().draft?.step, 0);
formulaRestored.setFormulaDraft(''); formulaRestored.next();
assert.equal(formulaRestored.getSnapshot().draft?.step, 1);
assert.equal(formulaRestored.getSnapshot().draft?.answers[0].assisted, false);

// Capacity prioritizes user input, never the newest card. The ninth request is
// refused until an unfinished draft is completed; old answers are not evicted.
const capacityNotes = Array.from({ length: 9 }, (_, i) => ({ ...note, id: `capacity-${i}`, title: `知识点${i}` }));
const capacity = new QuickCheckStore({ ...runtime, notes: capacityNotes }, 'synthetic-capacity', storage, adapters);
for (const candidate of capacityNotes.slice(0, 8)) {
  assert.equal(capacity.open({ noteId: candidate.id }), true); await settle();
  capacity.answer({ questionId: 'Q1', text: `未提交作答${candidate.id}` });
}
const capacityCalls = generation;
assert.equal(capacity.open({ noteId: capacityNotes[8].id }), false);
await settle(); assert.equal(generation, capacityCalls);
assert.ok(capacity.getSnapshot().draft?.cacheNotice?.includes('8 张未完成'));
capacity.open({ noteId: capacityNotes[0].id });
assert.equal(capacity.getSnapshot().draft?.answers[0].text, '未提交作答capacity-0');
complete(capacity); await settle();
assert.equal(capacity.open({ noteId: capacityNotes[8].id }), true); await settle();

// A too-large newer draft must not replace prior persisted unfinished answers.
let oversizedCache: string | null = null;
const oversizedNotes = [note, { ...note, id: 'oversized-next' }];
const oversized = new QuickCheckStore({ ...runtime, notes: oversizedNotes }, 'synthetic-byte-budget',
  { getItem: () => oversizedCache, setItem: (_key, value) => { oversizedCache = value; } },
  { ...adapters, generate: async ({ note: n }) => ({ ...makeSession(n), references: [{ id: 'REF1', tier: 3,
    sourceLabel: '合成大参考', quote: '原'.repeat(550000), criterionIds: ['concept_accuracy'] }] }) });
oversized.open({ noteId: note.id }); await settle(); oversized.answer({ questionId: 'Q1', text: '必须保留的第一份作答' });
const firstLargeCache = oversizedCache!;
oversized.open({ noteId: 'oversized-next' }); await settle(); oversized.answer({ questionId: 'Q1', text: '第二份当前窗口作答' });
assert.ok(oversized.getSnapshot().draft?.cacheNotice?.includes('当前窗口'));
assert.equal(oversizedCache, firstLargeCache, 'oversized protected drafts do not overwrite previously persisted answers');
assert.ok(oversizedCache!.includes('必须保留的第一份作答'));

// Keep at most the last two cards' distinct stems across repeated continues.
const variantRequests: string[][] = [];
const variants = new QuickCheckStore(runtime, 'synthetic-variants', storage, { ...adapters,
  generate: async ({ note: n, previousQuestions }) => {
    variantRequests.push(previousQuestions || []);
    const session = makeSession(n);
    return { ...session, questions: session.questions.map((question, index) => ({ ...question, prompt: `${session.id}的新情境${index + 1}` })) };
  } });
variants.open({ noteId: note.id }); await settle();
const seenStems: string[][] = [];
for (let round = 0; round < 3; round++) {
  seenStems.push(variants.getSnapshot().draft!.session!.questions.map(question => question.prompt));
  complete(variants); await settle(); variants.continue(); await settle();
}
assert.deepEqual(variantRequests[1], seenStems[0]);
assert.deepEqual(variantRequests[2], [...seenStems[0], ...seenStems[1]]);
assert.deepEqual(variantRequests[3], [...seenStems[1], ...seenStems[2]], 'older stems leave the bounded six-question history');
const variantsRestored = new QuickCheckStore(runtime, 'synthetic-variants', storage, adapters);
variantsRestored.open({ noteId: note.id });
assert.deepEqual(variantsRestored.getSnapshot().draft!.previousQuestions, variantRequests[3]);
const referenceFixture = makeSession(note);
referenceFixture.references = [
  { id: 'REF1', tier: 3, sourceId: 'NOTE1', sourceLabel: '笔记一', quote: '同一 参考片段' },
  { id: 'REF2', tier: 3, sourceId: 'NOTE1', sourceLabel: '笔记一', quote: '同一\n参考片段' },
  { id: 'REF3', tier: 3, sourceId: 'NOTE1', sourceLabel: '笔记一', quote: '下一题专用片段' },
  { id: 'REF4', tier: 3, sourceId: 'NOTE2', sourceLabel: '笔记二', quote: '同一 参考片段' },
];
const refQuestion = { ...referenceFixture.questions[0], referenceIds: ['REF1', 'REF2', 'REF4'] };
assert.deepEqual(quickCheckQuestionReferences(referenceFixture, refQuestion).map(ref => ref.id), ['REF1', 'REF4'],
  'display references are current-question scoped, identical same-source quotes deduped, independent sources retained');
assert.equal(referenceFixture.references.length, 4, 'display dedupe never rewrites frozen evaluator reference IDs');

// Switching cards keeps a completed background retake without stealing the dialog.
const secondNote = { ...note, id: 'synthetic-second-card' };
const pendingRetakes: Array<() => void> = [];
const switching = new QuickCheckStore({ ...runtime, notes: [note, secondNote] }, undefined, undefined, { ...adapters,
  generate: async options => {
    if (options.reuseSkipped) await new Promise<void>(resolve => pendingRetakes.push(resolve));
    return makeSession(options.note);
  } });
switching.open({ noteId: secondNote.id }); await settle();
const secondCardId = switching.getSnapshot().draft!.session!.id;
switching.open({ noteId: note.id }); await settle(); complete(switching); await settle();
switching.continue(); assert.equal(pendingRetakes.length, 1);
switching.open({ noteId: secondNote.id });
pendingRetakes[0](); await settle();
assert.equal(switching.getSnapshot().draft!.session!.id, secondCardId, 'late completion cannot steal another card');
switching.open({ noteId: note.id });
assert.equal(pendingRetakes.length, 1, 'a completed background retake is reused without a second generation');
assert.equal(switching.getSnapshot().draft!.phase, 'ready');
assert.equal(switching.getSnapshot().draft!.request.noteId, note.id);
const legacyDsr = { difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 1,
  consecutiveCorrect: 0, consecutiveWrong: 0, conceptMastery: 29, conceptMasterySamples: 4 };
const legacyState = planLegacyMasteryMigration([note], { [note.id]: { dsrState: legacyDsr } },
  { migrationId: 'synthetic-history', migratedAt: '2026-10-18T00:00:00Z' }).changes[0].after;
const historyNote = { ...note, dsrState: { ...legacyDsr, masteryShadow: legacyState } };
const historyMarkup = renderToStaticMarkup(<KnowledgeMasteryStatus note={historyNote} compact />);
assert.match(historyMarkup, /历史待复核/u, 'compact cards distinguish a migrated low score from a new confirmed error');
assert.match(historyMarkup, /不代表本次作答错误/u);
legacyState.layers.concept.criteria!.concept_accuracy.state = 'needs_review';
const failedMarkup = renderToStaticMarkup(<KnowledgeMasteryStatus note={historyNote} compact />);
assert.doesNotMatch(failedMarkup, /历史待复核/u, 'a real current failure cannot be hidden behind a historical label');
console.log('PASS quick-check UI/store: same-card resume, scoped persistence, 3-question lock, skip/assistance, failures, idempotent retry, mastery/source changes and passive SSR');
