import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { NoteItem } from '../src/types';
import { KnowledgeMasteryStatus } from '../src/components/KnowledgeMasteryStatus';
import { readKnowledgeMastery } from '../src/services/masteryReadModel';
import { createMasteryShadowState } from '../src/services/masteryShadow/stateMachine';
import { MASTERY_SHADOW_LAYERS, type MasteryShadowLayerState } from '../src/services/masteryShadow/types';
import { HomeReviewEchoCard } from '../src/components/HomeReviewEchoCard';
import { buildHomeViewModel } from '../src/services/homepage/homepageViewModel';
import { createKnowledgeMasteryPagesFixture } from './fixtures/knowledge-mastery-pages';
import type { UserProfile } from '../src/types';
import { setMasteryLayerFixture } from './fixtures/mastery-evidence';

for (const [state, label, marker] of [
  ['unassessed', '未评估', '—'], ['provisional', '待确认', '◐'],
  ['confirmed', '已确认', '✓'], ['needs_review', '待复核', '!'],
] as const) {
  const mastery = createMasteryShadowState('ui');
  for (const layer of MASTERY_SHADOW_LAYERS) setMasteryLayerFixture(mastery, layer, state as MasteryShadowLayerState);
  const note: NoteItem = { id: 'ui', title: '测试概念', noteType: 'knowledge', content: '可读参考定义。',
    tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-18', updatedAt: '2026-10-18',
    dsrState: { difficulty: 5, stability: 10, lastReviewedAt: null, reviewCount: 0,
      consecutiveCorrect: 0, consecutiveWrong: 0, masteryShadow: mastery } };
  const html = renderToStaticMarkup(<KnowledgeMasteryStatus note={note} />);
  assert.ok(html.includes(label) && html.includes(marker));
  assert.ok(html.includes(readKnowledgeMastery(note).summary));
  assert.ok(!html.includes('%') && !html.includes('width:'), 'no fake mastery percent or progress fill');
  assert.ok(html.includes('目标未设置'));
  const compact = renderToStaticMarkup(<KnowledgeMasteryStatus note={note} compact />);
  assert.ok(compact.includes(label) && compact.includes(marker));
  for (const layer of ['概念', '判断', '推理']) assert.ok(compact.includes(layer));
  for (const verbose of ['目标未设置', '下一步', '尚无连续确认层级', 'knowledge-mastery-status-layers']) {
    assert.ok(!compact.includes(verbose), 'review card only displays the compact layer row');
  }
  const history = structuredClone(note);
  history.dsrState!.masteryShadow = undefined;
  history.dsrState!.conceptMastery = 99;
  const oldHtml = renderToStaticMarkup(<KnowledgeMasteryStatus note={history} />);
  assert.ok(oldHtml.includes('历史评分 99%') && oldHtml.includes('不换算为新确认状态'));
}
const notes = createKnowledgeMasteryPagesFixture();
const home = buildHomeViewModel(notes, { ability: {}, cognitiveStyle: {}, learningAbility: {} } as UserProfile, { version: 1, weeks: [] });
const reminder = renderToStaticMarkup(<HomeReviewEchoCard vm={home} onOpenReview={() => {}} />);
assert.ok(reminder.includes(`${home.reviewEchoes.length} 个知识点将在今天等待回响`));
assert.ok(!reminder.includes('知识点掌握状态统计') && !reminder.includes('knowledge-mastery-status'));
console.log('PASS: four states have distinct text and markers; history and unknown targets remain explicit; no score-to-state conversion.');
