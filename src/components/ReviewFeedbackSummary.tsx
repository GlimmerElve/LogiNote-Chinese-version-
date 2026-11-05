import type { ReviewSessionFeedback } from '../services/masteryShadow/reviewFeedback';
import './ReviewResultSections.css';

export function ReviewFeedbackSummary({ feedback }: { feedback?: ReviewSessionFeedback }) {
  return <section className="review-feedback-summary" aria-label="本次回答反馈">
    <h3>本次回答反馈</h3>
    <p>{feedback?.feedback || '本次评价暂未完成，原掌握状态保留。'}</p>
    {!!feedback?.suggestion && <div className="review-feedback-next"><strong>下一步</strong><p>{feedback.suggestion}</p></div>}
    {feedback?.source === 'semantic_feedback' && <small>这是对本次回答的语义反馈，不单独计入长期掌握或画像。</small>}
    {!!feedback?.omittedTurns && <small>本次反馈仅覆盖预算内的完整轮次，另有 {feedback.omittedTurns} 轮未纳入；原作答保留。</small>}
    {!!feedback?.evidenceQuotes.length && <details><summary>查看本次引用的原话</summary>
      {feedback.evidenceQuotes.map((quote, index) => <blockquote key={index}>{quote}</blockquote>)}
    </details>}
  </section>;
}
