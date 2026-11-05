import React, { useMemo } from 'react';
import { prepareFormula, type PreparedFormula } from '../../services/textbook/formulaRenderer';

export interface FormulaBlockProps { latex: string; displayMode?: boolean; inlineContainer?: boolean; prepared?: PreparedFormula }
/** MathLive remains the editor. Reading uses static, non-trusting KaTeX with MathML. */
export function FormulaBlock({ latex, displayMode = false, inlineContainer = false, prepared }: FormulaBlockProps) {
  const result = useMemo(() => {
    if (prepared?.latex === latex && prepared.displayMode === displayMode) return prepared;
    return prepareFormula(latex, displayMode);
  }, [latex, displayMode, prepared]);
  if (result.error) return displayMode && !inlineContainer
    ? <div className="textbook-format-error" role="status"><p>公式无法渲染；可以在笔记中修改源码。</p><details><summary>查看公式源码</summary><pre><code>{latex}</code></pre><small>{result.error}</small></details></div>
    : <code className="textbook-formula-error" title={result.error}>{latex}</code>;
  if (displayMode && inlineContainer) return <span className="textbook-formula textbook-formula-display" dangerouslySetInnerHTML={{ __html: result.html! }} />;
  return displayMode
    ? <div className="textbook-formula textbook-formula-display" dangerouslySetInnerHTML={{ __html: result.html! }} />
    : <span className="textbook-formula textbook-formula-inline" dangerouslySetInnerHTML={{ __html: result.html! }} />;
}
