import katex from 'katex';
import 'katex/contrib/mhchem';
/** Same extension in material renderability checks and the textbook reader. */
export default katex;

export interface PreparedFormula {
  latex: string;
  displayMode: boolean;
  html?: string;
  error?: string;
}

/** Recover repeated JSON escaping in a simple inline formula. Matrix/aligned
 * row separators are intentional and are never normalized by this adapter. */
export function normalizeReadingLatex(latex: string, displayMode = false): string {
  if (displayMode || /\\(?:begin|end)\s*\{/u.test(latex) || /[\r\n]/u.test(latex)) return latex;
  return latex.replace(/(?<!\\)\\\\(?=(?:xi|alpha|beta|gamma|delta|epsilon|varepsilon|theta|lambda|mu|pi|sigma|tau|phi|omega|in|notin|neq|ne|leq|geq|le|ge|to|infty|frac|sqrt|sin|cos|tan|log|ln|exp|left|right|cdot|times)\b)/gu, '\\');
}

/** Safe static math. Long-reader callers invoke this in their dedicated worker. */
export function prepareFormula(latex: string, displayMode = false): PreparedFormula {
  try {
    if (!latex.trim() || latex.length > 16_000) throw new Error('公式为空或超过长度限制');
    const html = katex.renderToString(normalizeReadingLatex(latex, displayMode), { displayMode, throwOnError: true, trust: false,
      strict: 'error', output: 'htmlAndMathml', maxExpand: 1_000, maxSize: 20 });
    return { latex, displayMode, html };
  } catch (error) {
    return { latex, displayMode, error: error instanceof Error ? error.message : '公式无法渲染' };
  }
}
