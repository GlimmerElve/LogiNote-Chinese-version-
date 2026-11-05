/** Prefer the persisted teaching goal; never use raw HTML as a title. */
export function interactiveFigureTitle(goal: string | undefined, brief: string, pageTitle: string): string {
  const fallback = /^(?:根据本页教材的核心内容生成交互图[。.!！]?|交互探索)$/u.test(brief.trim()) ? `${pageTitle}交互图` : brief;
  const clean = (goal?.trim() || fallback || '交互图').replace(/[\r\n\t]+/gu, ' ')
    .replace(/\$+/gu, '').replace(/\\[()[\]]/gu, '').replace(/\*\*/gu, '').replace(/`/gu, '').replace(/\s+/gu, ' ').trim();
  const chars = Array.from(clean || '交互图');
  return chars.length > 30 ? `${chars.slice(0, 30).join('')}…` : chars.join('');
}
