import React, { useContext } from 'react';
import type { Element } from 'hast';
import { InteractiveFigureContext } from './InteractiveFigureContext';
import { textbookQuoteKind } from '../../services/textbook/quoteKind';
export { textbookQuoteKind } from '../../services/textbook/quoteKind';

/** Recognize an exact, bold first-paragraph label; ordinary quotations stay ordinary. */
export function TextbookQuote({ node, children }: { node?: Element; children?: React.ReactNode }) {
  const kind = textbookQuoteKind(node);
  const interaction = useContext(InteractiveFigureContext);
  const plain = (value: any): string => value.type === 'text' ? value.value : (value.children || []).map(plain).join('');
  const paragraphs = node?.children.filter(child => child.type === 'element') || [];
  const brief = node?.data?.readingQuoteBrief ?? paragraphs.slice(1).map(plain).join(' ').trim();
  return <blockquote className={kind ? `textbook-rich-quote textbook-rich-${kind}` : undefined}
    data-reading-continuation={node?.data?.readingContinuation || undefined}
    data-reading-fragment-tail={node?.properties['data-reading-fragment-tail'] || undefined}>{children}
    {kind === 'interactive' && !node?.data?.readingContinuation && interaction && brief && <button type="button" className="textbook-interactive-open" onClick={() => interaction.open(brief)}>打开交互探索</button>}
  </blockquote>;
}
