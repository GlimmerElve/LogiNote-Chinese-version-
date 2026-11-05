import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewHub } from '../src/components/ReviewHub';
import type { NoteItem } from '../src/types';
import type { MasteryShadowLayerState } from '../src/services/masteryShadow/types';
import { createMasteryShadowState } from '../src/services/masteryShadow/stateMachine';
import { buildKnowledgeReviewCandidates, buildReviewSchedule, summarizeKnowledgeReviewMemory, summarizeKnowledgeReviewPool, type KnowledgeReviewStrategy } from '../src/services/reviewScheduler';
import { setMasteryLayerFixture } from './fixtures/mastery-evidence';

// Render the real review page from frozen synthetic notes. No storage, indexes,
// LLM or browser automation is involved; handlers/timers have a separate check.
const at = '2026-10-18T08:00:00.000Z';
const now = Date.parse(at);
function note(id: string, states?: MasteryShadowLayerState[], extra: Partial<NoteItem> = {}): NoteItem {
  const state = states ? createMasteryShadowState(id) : undefined;
  if (state) {
    for (const [index, layer] of (['concept', 'judgment', 'reasoning'] as const).entries()) {
      setMasteryLayerFixture(state, layer, states![index]);
    }
    state.appliedObservationIds = [`synthetic-${id}`];
  }
  return {
    id, title: id, noteType: 'knowledge', content: `${id} 的参考正文：解释概念、适用条件以及相关示例。`,
    tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at,
    dsrState: { difficulty: 5, stability: 10, lastReviewedAt: at, reviewCount: 2,
      consecutiveCorrect: 1, consecutiveWrong: 0, masteryShadow: state },
    ...extra,
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
const stable = note('Stable', ['confirmed', 'confirmed', 'confirmed']);
const memory = note('Memory', ['confirmed', 'confirmed', 'confirmed']);
memory.dsrState!.lastReviewedAt = '2025-01-01T00:00:00.000Z';
const notes = freeze([
  note('Verify', ['needs_review', 'confirmed', 'confirmed']),
  note('Confirm', ['provisional', 'unassessed', 'unassessed']),
  note('Unknown'), stable, memory,
  note('EmptyWeak', ['needs_review', 'confirmed', 'confirmed'], { content: '' }),
  note('PlaceholderWeak', ['provisional', 'unassessed', 'unassessed'], { content: '请对该知识点进行定义描述' }),
  note('Project', undefined, { noteType: 'project' }),
]);
const before = JSON.stringify(notes);
function render(allNotes: NoteItem[], strategy: KnowledgeReviewStrategy) {
  return renderToStaticMarkup(<ReviewHub allNotes={allNotes}
    launchRequest={{ id: `test-${strategy}`, scope: 'knowledge', strategy }} onEnterReview={() => {}} />);
}
function stat(html: string, label: string): number {
  const match = html.match(new RegExp(`<small>${label}</small><strong>(\\d+)</strong>`));
  assert.ok(match, `missing pool statistic ${label}`);
  return Number(match[1]);
}

const originalNow = Date.now;
const previousMode = process.env.VITE_MASTERY_READ_MODE;
try {
  Date.now = () => now;
  process.env.VITE_MASTERY_READ_MODE = 'current';
  assert.deepEqual(summarizeKnowledgeReviewPool(notes, now), { eligibleCount: 5, weakCount: 2, randomCount: 5 });
  for (const strategy of ['smart', 'weak', 'random'] as const) {
    const html = render(notes, strategy);
    assert.equal(stat(html, '薄弱知识'), 2, `${strategy}: empty or placeholder weak notes are not available candidates`);
    assert.equal(stat(html, '可随机抽取'), 5, `${strategy}: random is the full ready pool, not total minus due`);
    assert.equal(stat(html, '薄弱知识'), buildKnowledgeReviewCandidates(notes, 'weak', now).length);
    assert.equal(stat(html, '可随机抽取'), buildKnowledgeReviewCandidates(notes, 'random', now, () => 0).length);
    for (const label of ['智能抽取', '薄弱优先', '完全随机']) {
      assert.ok(html.includes(`>${label}</button>`), `${strategy}: selector ${label} remains available`);
    }
    assert.equal((html.match(/role="tab"/g) || []).length, 5, 'scope and strategy tabs retain semantic controls');
    assert.ok(html.includes('aria-label="知识点抽取方式"'));
    assert.ok(html.includes('aria-live="polite"'));
    assert.ok(html.includes('review-focus-card'));
    if (strategy === 'weak') {
      assert.ok(html.includes('只从待复核、待确认或需补强的知识点中选择'));
      assert.ok(html.includes('<h2>Verify</h2>'));
    }
    if (strategy === 'random') {
      assert.ok(html.includes('从全库正文可用的知识点中等概率抽取，可重复抽中'));
      assert.ok(html.includes('开始随机抽取') && html.includes('等待抽取'));
    }
  }

  const fresh = note('新知识点', undefined, { dsrState: undefined });
  const initialized = note('已初始化但未复习', undefined, { dsrState: { ...stable.dsrState!,
    lastReviewedAt: null, reviewCount: 0, masteryShadow: undefined } });
  const practiced = note('仅练习过', undefined, { dsrState: { ...initialized.dsrState!, lastPracticedAt: at } });
  const mixedMemory = [fresh, initialized, practiced, stable, memory];
  const mixedBefore = JSON.stringify(mixedMemory);
  for (const mode of ['current', 'legacy'] as const) {
    process.env.VITE_MASTERY_READ_MODE = mode;
    assert.deepEqual(summarizeKnowledgeReviewMemory([fresh], now), {
      firstReviewCount: 1, reviewedCount: 0, imminentCount: 0, imminentPercent: null,
    });
    assert.deepEqual(summarizeKnowledgeReviewMemory(mixedMemory, now), {
      firstReviewCount: 3, reviewedCount: 2, imminentCount: 1, imminentPercent: 50,
    }, 'new and practice-only notes do not enter the forgetting numerator or denominator');
    assert.deepEqual(summarizeKnowledgeReviewMemory([note('未补全', undefined, { content: '' })], now),
      mode === 'current' ? { firstReviewCount: 0, reviewedCount: 0, imminentCount: 0, imminentPercent: null }
        : { firstReviewCount: 0, reviewedCount: 1, imminentCount: 0, imminentPercent: 0 });
    const scheduled = buildReviewSchedule([fresh, initialized, practiced], now).knowledge;
    assert.equal(scheduled.length, 3, 'new notes remain available for a first review');
    assert.ok(scheduled.every(target => target.needsFirstReview && target.reason.startsWith('待首次复习')));
    const freshHtml = render([fresh], 'smart');
    assert.equal(stat(freshHtml, '今日复习池'), 1);
    assert.equal(stat(freshHtml, '即将遗忘'), 0);
    assert.ok(freshHtml.includes('待首次复习 1 个') && freshHtml.includes('暂无复习记录'));
    assert.match(freshHtml, /<small>即将遗忘<\/small><strong>0<\/strong><em>暂无复习记录<\/em>/,
      'the forgetting statistic does not reuse the unknown-memory scheduling prior');
    const mixedHtml = render(mixedMemory, 'smart');
    assert.ok(mixedHtml.includes('50% · 已复习'));
  }
  assert.equal(JSON.stringify(mixedMemory), mixedBefore, 'classification never creates a review record');
  process.env.VITE_MASTERY_READ_MODE = 'current';

  // Flow evidence may confirm all layers without an independent review. It is
  // stable in today's schedule, so its first-review status is not today's due subset.
  const flowOnly = note('复盘已确认但未独立复习', ['confirmed', 'confirmed', 'confirmed']);
  flowOnly.dsrState!.lastReviewedAt = null;
  flowOnly.dsrState!.reviewCount = 0;
  assert.equal(buildReviewSchedule([flowOnly], now).knowledge.length, 0);
  assert.equal(summarizeKnowledgeReviewMemory([flowOnly], now).firstReviewCount, 1,
    'the global first-review summary keeps its existing meaning');
  const flowOnlyHtml = render([flowOnly], 'smart');
  assert.equal(stat(flowOnlyHtml, '今日复习池'), 0);
  assert.ok(flowOnlyHtml.includes('待首次复习 0 个'), 'the card detail counts only its due review pool');
  const flowAndFreshHtml = render([flowOnly, fresh], 'smart');
  assert.equal(stat(flowAndFreshHtml, '今日复习池'), 1);
  assert.ok(flowAndFreshHtml.includes('待首次复习 1 个'), 'new notes remain in the due first-review subset');

  const emptyWeak = render([stable], 'weak');
  assert.equal(stat(emptyWeak, '薄弱知识'), 0);
  assert.equal(stat(emptyWeak, '可随机抽取'), 1);
  assert.ok(emptyWeak.includes('暂无待复核、待确认或需补强的知识点，可切换智能抽取或完全随机。'));
  assert.ok(!emptyWeak.includes('还没有可复习的知识点'), 'no weak candidate is not the same as no available knowledge');
  assert.ok(!emptyWeak.includes('review-focus-card') && !emptyWeak.includes('review-knowledge-start'));
  assert.ok(render([stable], 'smart').includes('review-focus-card'));
  assert.ok(render([stable], 'random').includes('开始随机抽取'));
  for (const strategy of ['smart', 'weak', 'random'] as const) {
    const empty = render([], strategy);
    assert.equal(stat(empty, '薄弱知识'), 0);
    assert.equal(stat(empty, '可随机抽取'), 0);
    assert.ok(!empty.includes('review-focus-card') && !empty.includes('review-knowledge-start'));
    assert.equal((empty.match(/role="tab"/g) || []).length, 5, 'an empty pool must not trap the selected strategy');
  }
  assert.equal(JSON.stringify(notes), before, 'renders and selectors must not mutate notes');
} finally {
  Date.now = originalNow;
  if (previousMode === undefined) delete process.env.VITE_MASTERY_READ_MODE;
  else process.env.VITE_MASTERY_READ_MODE = previousMode;
}
console.log('PASS: ReviewHub pools, first-review labels and evidence-based forgetting counts match their selectors.');
