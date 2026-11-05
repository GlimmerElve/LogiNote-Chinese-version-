import type { KnowledgePointMasteryResult } from '../types';
import { KnowledgeMasteryDetails } from './KnowledgeMasteryDetails';
import './ReviewResultSections.css';

/** Separate from legacy segment cards: their descendant flex styles break the layered table. */
export function ReviewMasteryResults({ results, warnings = [], feedbackAvailable = false, onQuickCheck, quickCheckDisabled = false }: {
  results: KnowledgePointMasteryResult[];
  warnings?: string[];
  feedbackAvailable?: boolean;
  onQuickCheck?: (result: KnowledgePointMasteryResult) => void;
  quickCheckDisabled?: boolean;
}) {
  const evaluated = results.filter(result => result.shadow);
  return <div className="review-mastery-results" aria-label="本次知识点分层评价">
    <h3 className="review-mastery-results-title">三层掌握情况</h3>
    {!!evaluated.length && <p className="review-mastery-results-note">{evaluated.some(result => result.shadow?.status === 'evaluated')
      ? '本次表现与累计掌握分开查看，保存后更新；未考查的层次保持原状。'
      : '本次未形成新的分层结论，以下保留已有掌握状态。'}</p>}
    {evaluated.map((result, index) => <article className="review-mastery-result-card" key={`${result.name}-${index}`}>
      <header className="review-mastery-card-heading"><h4>{result.name}</h4>
        {result.shadow?.overview && <span className="review-mastery-overview-badge">{result.shadow.overview.label}</span>}
      </header>
      <KnowledgeMasteryDetails result={result.shadow!} showOverview={false} />
      {onQuickCheck && <button type="button" className="quick-check-entry" disabled={quickCheckDisabled}
        onClick={() => onQuickCheck(result)}>保存并简测</button>}
    </article>)}
    {!evaluated.length && <p className="review-mastery-results-note">{feedbackAvailable
      ? '本次反馈已生成，但尚无足够证据更新长期掌握状态；原状态保留。'
      : '本次没有形成可核验的分层评价，原掌握状态保留。'}</p>}
    {!!warnings.length && <details className="review-mastery-results-warnings">
      <summary>为何部分掌握状态未更新</summary>
      {[...new Set(warnings)].map(warning => <p key={warning}>{warning}</p>)}
    </details>}
  </div>;
}
