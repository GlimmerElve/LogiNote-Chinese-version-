import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { masteryReferencePreview } from '../services/ui/masteryReferencePreview';
import './KnowledgeMasteryDetails.css';

/** Present the original model input on demand, not as a fabricated sentence-level citation. */
export function MasteryReferenceContext({ reference }: { reference: { label: string; quote: string; locator?: string } }) {
  const reading = masteryReferencePreview(reference.quote);
  return <div className="mastery-reference">
    <strong>{reference.label}</strong>
    <small>{reading.characterCount} 字符的引用上下文{reference.locator ? ` · ${reference.locator}` : ''}</small>
    <p className="mastery-reference-preview">{reading.preview || '暂无可读预览，请展开查看参考上下文。'}</p>
    {(reading.truncated || reading.characterCount > 220 || !reading.preview) && <details className="mastery-reference-full">
      <summary>展开本次参考上下文</summary>
      <div className="mastery-reference-context" role="region" aria-label={`${reference.label}的参考上下文`} tabIndex={0}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml
          allowedElements={['p', 'strong', 'em', 'del', 'ul', 'ol', 'li', 'blockquote', 'code', 'pre',
            'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'a']}
          components={{ a: ({ children }) => <span>{children}</span>,
            h1: ({ children }) => <h5>{children}</h5>, h2: ({ children }) => <h5>{children}</h5>,
            h3: ({ children }) => <h5>{children}</h5>, h4: ({ children }) => <h5>{children}</h5> }}>
          {reference.quote}
        </ReactMarkdown>
      </div>
    </details>}
  </div>;
}
