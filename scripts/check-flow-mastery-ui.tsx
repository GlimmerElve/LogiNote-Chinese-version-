import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { FlowResultView } from '../src/components/FlowResultView';
import { FlowAnalysisPanel } from '../src/components/FlowAnalysisPanel';
import { createFlowResultPreview } from './fixtures/flow-result-v2-preview';
import type { KnowledgePointMasteryResult } from '../src/types';
import { KnowledgeMasteryDetails } from '../src/components/KnowledgeMasteryDetails';

const fixture = createFlowResultPreview();
const item: KnowledgePointMasteryResult = {
  name: '确认偏误', level: 'concept', conceptDelta: 0, judgmentDelta: 0, reasoningDelta: 0,
  comment: '仅评价本次实际展示的层次。',
  shadow: { evaluationId: 'ui-fixture', status: 'evaluated', layers: {
    concept: { coverage: 'assessed', verdict: 'pass', state: 'provisional', reason: '用户解释与教材含义一致。',
      assessment: { criteria: [{ id: 'concept_accuracy', label: '概念含义', state: 'pass', reason: '语义核对结论。',
        referenceQuotes: [{ referenceId: 'R1', quote: '参考片段。<script>不执行</script>' }] }],
        evidence: [{ id: 'E1', quote: '用户原话：<script>不是代码</script>' }],
        references: [{ id: 'R1', label: '项目教材', quote: '参考片段。' }] } },
    judgment: { coverage: 'incidental', verdict: 'not_observed', state: 'confirmed', reason: '本次只提及，保持已有确认。' },
    reasoning: { coverage: 'not_tested', verdict: 'not_observed', state: 'unassessed', reason: '本次没有推导机会。' },
  } },
};
const report = { ...fixture.bundle.report,
  sections: [{ kind: 'mastery' as const, title: '知识点掌握度', items: [item], total: 1 }] };
const html = renderToStaticMarkup(<FlowResultView data={{ doc: fixture.bundle.argumentDoc, report,
  speakingContent: fixture.input.rawText, noteId: 'ui-project', noteTitle: '测试',
  createdAt: fixture.input.observedAt, entryMode: 'new' }}
  onChange={() => {}} onBack={() => {}} onSave={() => {}} onResubmit={() => {}} />);
for (const label of ['待确认', '已确认', '未评估', '待复核', '累计状态', '本次表现',
  '本次仅附带提及', '本次未展示', '查看评价依据', '概念含义', '语义核对结论。', '核对原话与参考资料', '项目教材', '参考片段。']) {
  assert.ok(html.includes(label), `result page must show ${label}`);
}
assert.ok(!html.includes('原始净分') && !html.includes('联动净分'), 'shadow zeros cannot masquerade as numeric mastery scores');
assert.ok(html.includes('&lt;script&gt;') && !html.includes('<script>不是代码'), 'evidence is rendered as text, never HTML');
assert.ok(html.includes('概念含义的参考依据') && html.includes('mastery-criterion-reference'));
assert.ok(html.includes('&lt;script&gt;不执行&lt;/script&gt;') && !html.includes('<script>不执行'), 'criterion excerpts are escaped plain text');
const problem = structuredClone(item.shadow!);
problem.layers.concept.state = 'needs_review';
problem.layers.concept.verdict = 'fail';
problem.layers.concept.assessment = undefined;
problem.layers.concept.reason = '第一个理由。；第二个理由。';
const problemHtml = renderToStaticMarkup(<KnowledgeMasteryDetails result={problem} />);
assert.ok(problemHtml.includes('is-needs_review') && problemHtml.includes('本次发现问题'));
assert.ok(problemHtml.includes('<li>第一个理由。</li>') && problemHtml.includes('<li>第二个理由。</li>'),
  'older joined reasons remain readable without fabricating missing criterion labels');
const panel = renderToStaticMarkup(<FlowAnalysisPanel speakingContent={fixture.input.rawText}
  noteTitle="测试" allNotes={[]} autoRun={false} initialReport={report} />);
assert.ok(panel.includes('待确认') && panel.includes('已确认') && panel.includes('未评估'));
assert.ok(!panel.includes('概念+0'));
console.log('PASS: result page and analysis panel show layer states, absent-performance reasons and preserved confirmations; no fake zero scores.');
