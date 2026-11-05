export interface SearchSnippet {
  text: string;
  hitStart?: number;
}

function queryTerms(query: string): string[] {
  const compact = query.replace(/\s+/gu, '');
  const cjk = Array.from(compact.matchAll(/[\u3400-\u9fff]{2,}/gu)).flatMap((match) => {
    const value = match[0];
    return value.length <= 4
      ? [value]
      : Array.from({ length: value.length - 1 }, (_, index) => value.slice(index, index + 2));
  });
  const latin = query.toLocaleLowerCase().match(/[a-z0-9]{2,}/gu) || [];
  return Array.from(new Set([compact, ...cjk, ...latin].filter((term) => term.length >= 2)));
}

/** 构造围绕实际命中位置的短摘录；返回位置供后续 UI 高亮。 */
export function buildSearchSnippet(content: string, query: string, maxChars = 360): SearchSnippet {
  const source = String(content || '');
  const lower = source.toLocaleLowerCase();
  const terms = queryTerms(query).sort((a, b) => b.length - a.length);
  let hit = -1;
  for (const term of terms) {
    hit = lower.indexOf(term.toLocaleLowerCase());
    if (hit >= 0) break;
  }
  if (hit < 0) hit = 0;
  if (source.length <= maxChars) return { text: source, hitStart: source ? hit : undefined };

  let start = Math.max(0, hit - Math.floor(maxChars * 0.38));
  let end = Math.min(source.length, start + maxChars);
  start = Math.max(0, end - maxChars);
  if (start > 0) {
    const boundary = source.slice(start, Math.min(hit, start + 80)).search(/[。！？!?；;\.\n]\s*/u);
    if (boundary >= 0) start += boundary + 1;
  }
  if (end < source.length) {
    const tail = source.slice(Math.max(hit, end - 80), end);
    const matches = Array.from(tail.matchAll(/[。！？!?；;\.\n]/gu));
    if (matches.length > 0) end = Math.max(hit + 1, end - tail.length + (matches.at(-1)?.index || 0) + 1);
  }
  return {
    text: `${start > 0 ? '…' : ''}${source.slice(start, end).trim()}${end < source.length ? '…' : ''}`,
    hitStart: hit,
  };
}
