import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ReviewMasteryResults } from '../src/components/ReviewMasteryResults';
import { ReviewPerformanceSummary } from '../src/components/ReviewPerformanceSummary';
import { ReviewFeedbackSummary } from '../src/components/ReviewFeedbackSummary';
import { ReviewResultHeading } from '../src/components/ReviewResultHeading';
import { normalizeReviewAnalysis } from '../src/services/reviewEvidence';
import type { KnowledgePointMasteryResult } from '../src/types';

globalThis.fetch = async () => assert.fail('Result rendering must not call a model or read live data');
const result: KnowledgePointMasteryResult = { name: '待确认的知识点', level: 'none', comment: '', conceptDelta: 0, judgmentDelta: 0, reasoningDelta: 0,
  shadow: { evaluationId: 'ui-only', status: 'evaluated', layers: {
    concept: { state: 'provisional', coverage: 'assessed', verdict: 'pass', reason: '有据通过' },
    judgment: { state: 'unassessed', coverage: 'not_tested', verdict: 'not_observed', reason: '未检验，原状态保留' },
    reasoning: { state: 'unassessed', coverage: 'not_tested', verdict: 'not_observed', reason: '未检验，原状态保留' },
  } } };
const before = JSON.stringify(result);
const html = renderToStaticMarkup(<ReviewMasteryResults results={[result]} warnings={['参考资料不足', '参考资料不足']} />);
assert.ok(html.includes('review-mastery-result-card') && !html.includes('review-session-segments'), 'new result never inherits legacy descendant flex rules');
assert.ok(!html.includes('class="knowledge-mastery-status"'), 'review does not repeat the full overview inside another card');
assert.ok(html.includes('<h3 class="review-mastery-results-title">三层掌握情况</h3>') && html.includes('<h4>待确认的知识点</h4>'));
const heading = renderToStaticMarkup(<ReviewResultHeading available={false} />);
assert.ok(heading.includes('<h2>本次复习反馈</h2>') && heading.includes('评价暂未完成'));
assert.equal((html.match(/role="row"/g) || []).length, 4, 'header plus three vertical rows');
assert.ok(html.includes('待确认') && html.includes('未评估') && html.includes('本次通过'));
assert.equal((html.match(/参考资料不足/g) || []).length, 1);
assert.ok(html.includes('查看评价依据') && !html.includes('<details open'), 'evidence remains collapsed');
assert.equal(before, JSON.stringify(result));
const empty = renderToStaticMarkup(<ReviewMasteryResults results={[{ ...result, shadow: undefined }]} />);
assert.ok(empty.includes('本次没有形成可核验的分层评价'));
const feedbackOnly = renderToStaticMarkup(<><ReviewFeedbackSummary feedback={{ version: 1, status: 'available', source: 'semantic_feedback',
  feedback: '已解释概念，本次未展开适用范围。', suggestion: '补充一个限定。', evidenceQuotes: [] }} />
  <ReviewMasteryResults results={[]} feedbackAvailable warnings={['题目标记缺失，仅给反馈，不改变掌握状态。']} /></>);
assert.ok(feedbackOnly.includes('本次反馈已生成') && feedbackOnly.includes('不单独计入长期掌握或画像'));
assert.ok(!feedbackOnly.includes('review-session-score-grid') && !feedbackOnly.includes('需要重学'));
assert.ok(feedbackOnly.includes('为何部分掌握状态未更新') && !feedbackOnly.includes('<details open'));
const multiple = renderToStaticMarkup(<ReviewMasteryResults results={[result, { ...result, name: '另一知识点' }]} />);
assert.equal((multiple.match(/<article /g) || []).length, 2);

const analysis = normalizeReviewAnalysis({ accuracyScore: 65, completenessScore: 55, logicScore: 55, relevanceScore: 70,
  scoreEvidence: { accuracy: '原话中给出了定义，但缺少适用条件。' } });
assert.equal(analysis.overallRating, 'good'); // weighted 60.75, not mastery-state conversion
const performance = renderToStaticMarkup(<ReviewPerformanceSummary analysis={analysis} />);
for (const label of ['准确度', '完整性', '逻辑深度', '关联性', '旧版整体评价模型', '满分 100', '查看分数来源与依据', '用户画像能力信号及复习间隔']) {
  assert.ok(performance.includes(label), label);
}
assert.ok(performance.includes('原话中给出了定义，但缺少适用条件。'));
assert.equal((performance.match(/模型未返回该项评分依据/g) || []).length, 3, 'never invent missing evidence');
assert.ok(!performance.includes('<details open'));
const chat = readFileSync('src/components/ReviewChat.tsx', 'utf8');
assert.ok(chat.includes('<ReviewMasteryResults results={segmentMasteryResults}'));
assert.ok(chat.includes('<ReviewPerformanceSummary analysis={finalAnalysis}'));
console.log('PASS: isolated current-result cards, three-layer table, multiple/empty/error states, unchanged scores and explicit scoring provenance/evidence.');
