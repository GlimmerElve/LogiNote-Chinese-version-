import type { FC } from 'react';
import { ArrowRight } from 'lucide-react';
import type { HomeViewModel } from '../services/homepage/homepageViewModel';

/** Pure homepage reminder: the caller supplies the already computed read model. */
export const HomeReviewEchoCard: FC<{ vm: HomeViewModel; onOpenReview: () => void }> = ({ vm, onOpenReview }) => {
  const echoes = vm.reviewEchoes;
  const preview = echoes.slice(0, 3);
  return (
    <section className="quiet-home-review-card" aria-labelledby="quiet-home-review-title">
      <div className="quiet-home-review-mark" aria-hidden="true">
        <span /><span /><span /><i /><i />
      </div>
      <div className="quiet-home-review-copy">
        <h2 id="quiet-home-review-title">
          {echoes.length > 0 ? `${echoes.length} 个知识点将在今天等待回响` : '今天没有待复习的知识点'}
        </h2>
        {preview.length > 0 ? (
          <div className="quiet-home-review-preview" aria-label="待复习知识点预览">
            {preview.map((item) => <span key={item.noteId}>{item.title}</span>)}
            {echoes.length > preview.length && <span>还有 {echoes.length - preview.length} 个</span>}
          </div>
        ) : (
          <p>让知识在时间里，慢慢长成自己的样子。</p>
        )}
      </div>
      <button type="button" className="quiet-home-review-action" onClick={onOpenReview}>
        {echoes.length > 0 ? '去复习' : '进入复习'}<ArrowRight aria-hidden="true" />
      </button>
    </section>
  );
};
