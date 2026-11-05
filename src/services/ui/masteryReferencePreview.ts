/** Reading aid only: never changes a model reference, a citation, or an assessment. */
export function masteryReferencePreview(original: string, limit = 160) {
  const text = original.split(/\n\s*\n/u).filter(block => !/^\s*#{1,6}\s+[^\n]+\s*$/u.test(block)).join('\n\n')
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu, (_match, title: string, alias?: string) => alias || title)
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')
    .replace(/<[^>]*>/gu, '')
    .replace(/```[^\n]*\n?/gu, '')
    .replace(/^(?:\s*#{1,6}\s+|\s*>\s*|\s*[-+*]\s+)/gmu, '')
    .replace(/(\*\*|__)(.*?)\1/gu, '$2').replace(/`([^`]+)`/gu, '$1')
    .replace(/\s+/gu, ' ').trim();
  const chars = Array.from(text);
  const sentences = text.match(/[^。！？!?]+(?:[。！？!?]+|$)/gu) || [];
  let preview = '';
  for (const sentence of sentences.slice(0, 2)) {
    if (Array.from(preview + sentence).length > Math.max(1, limit - 1)) break;
    preview += sentence;
  }
  if (!preview && chars.length) preview = chars.slice(0, Math.max(1, limit - 1)).join('');
  if (chars.length <= limit && sentences.length <= 2) preview = text;
  const truncated = preview.length < text.length;
  return { preview: preview.trim() + (truncated ? '…' : ''), truncated, characterCount: Array.from(original).length };
}
