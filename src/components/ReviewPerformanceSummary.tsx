import type { ReviewAnalysis } from '../types';
import './ReviewResultSections.css';

/** Displays the existing review-scoring output; it does not calculate mastery. */
export function ReviewPerformanceSummary({ analysis }: { analysis: ReviewAnalysis }) {
  const items = [
    { label: '准确度', score: analysis.accuracyScore, evidence: analysis.scoreEvidence?.accuracy },
    { label: '完整性', score: analysis.completenessScore, evidence: analysis.scoreEvidence?.completeness },
    { label: '逻辑深度', score: analysis.logicScore, evidence: analysis.scoreEvidence?.logic },
    { label: '关联性', score: analysis.relevanceScore, evidence: analysis.scoreEvidence?.relevance },
  ];
  return <section className="review-performance-summary" aria-label="本次对话表现评分">
    <h3>本次对话表现</h3>
    <p className="review-performance-source">由旧版整体评价模型评分，各项满分 100；不是知识点掌握度，也不是上方三层状态的换算。</p>
    <div className="review-session-score-grid">
      {items.map(item => <div key={item.label}><strong>{item.score}</strong><span>{item.label}</span></div>)}
    </div>
    <div className="review-session-rating">本次表现（不等于长期掌握）：{
      analysis.overallRating === 'again' ? '需要重学' : analysis.overallRating === 'hard' ? '还需加强'
        : analysis.overallRating === 'good' ? '表现良好' : '表现充分'
    }</div>
    <details className="review-performance-evidence">
      <summary>查看分数来源与依据</summary>
      <p>依据本次对话、知识上下文及提示依赖，由整体评价模型给出。评级由程序按准确度 35%、完整性 25%、逻辑深度 25%、关联性 15% 加权计算。</p>
      <dl>{items.map(item => <div key={item.label}><dt>{item.label} · {item.score} / 100</dt>
        <dd>{item.evidence?.trim() || '模型未返回该项评分依据，不能据此核验分数。'}</dd></div>)}</dl>
      <p>保存后仍参与用户画像能力信号及复习间隔计算；知识点掌握状态由独立的三层证据评价更新。</p>
    </details>
  </section>;
}
