export type FormulaInsertion = { ok: true; value: string; cursor: number } | { ok: false; error: string };

export function bareAnswerFormula(source: string): string {
  let latex = source.trim();
  for (const [start, end] of [['$$', '$$'], ['\\[', '\\]'], ['\\(', '\\)'], ['$', '$']]) {
    if (latex.startsWith(start) && latex.endsWith(end) && latex.length >= start.length + end.length) {
      latex = latex.slice(start.length, -end.length).trim(); break;
    }
  }
  return latex;
}

/** Textarea coordinates are UTF-16 offsets, as are String.slice/length. */
export function insertAnswerFormula(value: string, latexSource: string, selection: { start: number; end: number },
  display = false, maxLength = 4000): FormulaInsertion {
  const latex = bareAnswerFormula(latexSource);
  if (!latex || !latex.replace(/\\placeholder(?:\[[^\]]*\])?\{[^}]*\}/gu, '').trim()) {
    return { ok: false, error: '请先输入公式，再插入回答。' };
  }
  const start = Math.min(value.length, Math.max(0, Number.isFinite(selection.start) ? Math.floor(selection.start) : value.length));
  const end = Math.min(value.length, Math.max(start, Number.isFinite(selection.end) ? Math.floor(selection.end) : start));
  const before = value.slice(0, start), after = value.slice(end);
  const insertion = display ? `${before && !before.endsWith('\n') ? '\n' : ''}$$\n${latex}\n$$${after && !after.startsWith('\n') ? '\n' : ''}` : `$${latex}$`;
  const next = before + insertion + after;
  if (next.length > maxLength) return { ok: false, error: `插入后将超过 ${maxLength} 字。请精简回答或公式；原文和公式草稿均未删减。` };
  return { ok: true, value: next, cursor: before.length + insertion.length };
}

export type AnswerPreviewPart = { kind: 'text'; value: string } | { kind: 'formula'; value: string; display: boolean };
/** Preview accepts only text and delimited math, never user-supplied HTML/Markdown. */
export function answerPreviewParts(value: string): AnswerPreviewPart[] {
  const parts: AnswerPreviewPart[] = [];
  const escaped = (index: number) => { let count = 0; for (let i = index - 1; i >= 0 && value[i] === '\\'; i--) count++; return count % 2 === 1; };
  let plainStart = 0;
  for (let i = 0; i < value.length; i++) {
    if (escaped(i)) continue;
    const dollar = value[i] === '$';
    const slash = value[i] === '\\' && (value[i + 1] === '(' || value[i + 1] === '[');
    if (!dollar && !slash) continue;
    const display = dollar ? value[i + 1] === '$' : value[i + 1] === '[';
    const length = slash || display ? 2 : 1;
    const closing = slash ? (display ? '\\]' : '\\)') : display ? '$$' : '$';
    let end = -1;
    for (let j = i + length; j < value.length; j++) {
      if (!display && value[j] === '\n') break;
      if (value.startsWith(closing, j) && !escaped(j)
        && (!dollar || display || (value[j + 1] !== '$' && (value[j - 1] !== '$' || escaped(j - 1))))) { end = j; break; }
    }
    if (end < 0 || !value.slice(i + length, end).trim()) continue;
    if (i > plainStart) parts.push({ kind: 'text', value: value.slice(plainStart, i) });
    parts.push({ kind: 'formula', value: value.slice(i + length, end), display });
    i = end + length - 1;
    plainStart = i + 1;
  }
  if (plainStart < value.length) parts.push({ kind: 'text', value: value.slice(plainStart) });
  return parts;
}
