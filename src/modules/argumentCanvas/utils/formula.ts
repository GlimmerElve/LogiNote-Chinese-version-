/**
 * LaTeX 公式渲染工具（从 argument-editor-standalone 迁移）
 *
 * 文本中 $...$ 之间视为行内公式，$$...$$ 视为块级公式。
 */

import katex from 'katex';

export interface FormulaChunk {
  type: 'text' | 'math';
  content: string;
  display?: boolean;
}

export function splitFormulaChunks(text: string): FormulaChunk[] {
  const chunks: FormulaChunk[] = [];
  const blockRegex = /\$\$([\s\S]+?)\$\$/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(text)) !== null) {
    const before = text.slice(lastIndex, match.index);
    chunks.push(...splitInline(before));
    chunks.push({ type: 'math', content: match[1], display: true });
    lastIndex = match.index + match[0].length;
  }

  const rest = text.slice(lastIndex);
  chunks.push(...splitInline(rest));

  return chunks.filter((c) => c.type === 'math' || c.content.length > 0);
}

function splitInline(text: string): FormulaChunk[] {
  const chunks: FormulaChunk[] = [];
  const inlineRegex = /\$([^$\n]+?)\$/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      chunks.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    chunks.push({ type: 'math', content: match[1], display: false });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    chunks.push({ type: 'text', content: text.slice(lastIndex) });
  }
  return chunks;
}

export function renderMathToHtml(tex: string, display = false): string {
  try {
    return katex.renderToString(tex, { throwOnError: false, displayMode: display });
  } catch {
    return tex;
  }
}

export function renderTextWithMath(text: string): string {
  const chunks = splitFormulaChunks(text);
  return chunks
    .map((c) => {
      if (c.type === 'math') return renderMathToHtml(c.content, c.display);
      return escapeHtml(c.content);
    })
    .join('');
}

const AMP = String.fromCharCode(38);
const HTML_ESCAPES: Record<string, string> = {
  '&': `${AMP}amp;`,
  '<': `${AMP}lt;`,
  '>': `${AMP}gt;`,
  '"': `${AMP}quot;`,
  "'": `${AMP}#39;`,
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] || ch);
}