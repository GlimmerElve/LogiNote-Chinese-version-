import { AlertCircle, CheckCircle2 } from 'lucide-react';
import './ReviewResultSections.css';

export function ReviewResultHeading({ available }: { available: boolean }) {
  return <header className="review-result-heading">
    <div className="review-result-heading-copy">
      <span className="review-result-eyebrow">REVIEW NOTES</span>
      <h2>本次复习反馈</h2>
      <p>看见已经形成的理解，也留意下一步可以补充的地方。</p>
    </div>
    <span className={`review-result-status${available ? '' : ' is-pending'}`}>
      {available ? <CheckCircle2 aria-hidden="true" /> : <AlertCircle aria-hidden="true" />}
      {available ? '反馈已生成' : '评价暂未完成'}
    </span>
  </header>;
}
