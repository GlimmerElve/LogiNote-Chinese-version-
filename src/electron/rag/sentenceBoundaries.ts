/** Shared by L1 chunking and L2 sentence IDs. Never rewrites the source string. */
export const TEXT_SEGMENTATION_VERSION = 2;

export interface TextRange { start: number; end: number }

function periodEndsSentence(text: string, index: number): boolean {
  const before = text.slice(0, index);
  const after = text.slice(index + 1).trimStart();
  // PDF layout may wrap even a decimal; neither 0.180 nor 0.\n180 is a boundary.
  if (/\d$/u.test(before) && /^\d/u.test(after)) return false;
  if (/[A-Za-z0-9]/u.test(text[index + 1] || '')) return false; // domains, e.g., U.S.
  const word = before.match(/([A-Za-z]+)$/u)?.[1] || '';
  if (after && /^(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|Fig|Figs|Eq|Eqs|Vol|No|vs|etc|al)$/iu.test(word)) return false;
  if (/^[A-Z]$/u.test(word) && /^[A-Z]/u.test(after)) return false; // P. C. Nemov
  if (/(?:\b[A-Za-z]\.)+[A-Za-z]$/u.test(before) && after) return false;
  return true;
}

/** Single line breaks are layout, not sentence boundaries. Blank lines are optional hard paragraphs. */
export function sentenceRanges(text: string, paragraphBreaks = true): TextRange[] {
  const ranges: TextRange[] = [];
  let start = 0;
  const flush = (end: number) => {
    let left = start;
    let right = end;
    while (left < right && /\s/u.test(text[left])) left += 1;
    while (right > left && /\s/u.test(text[right - 1])) right -= 1;
    if (right > left) ranges.push({ start: left, end: right });
    start = end;
  };
  for (let i = 0; i < text.length; i += 1) {
    if (paragraphBreaks && text[i] === '\n' && /^\n[ \t]*\n/u.test(text.slice(i))) {
      flush(i);
      continue;
    }
    const terminal = /[。！？!?；;]/u.test(text[i]) || (text[i] === '.' && periodEndsSentence(text, i));
    if (!terminal) continue;
    let end = i + 1;
    while (end < text.length && /[。！？!?；;.”’"'）)\]】]/u.test(text[end])) end += 1;
    flush(end);
    i = end - 1;
  }
  flush(text.length);
  return ranges;
}

export function endsWithSentenceBoundary(text: string, followingText = ''): boolean {
  const trimmed = text.trimEnd().replace(/[”’"'）)\]】]+$/gu, '');
  const index = trimmed.length - 1;
  return index >= 0 && (/[。！？!?；;]/u.test(trimmed[index])
    || (trimmed[index] === '.' && periodEndsSentence(trimmed + followingText, index)));
}
