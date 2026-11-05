export interface ReferenceEvidenceSpan {
  textStart: number; textEnd: number; sectionPath: string; forcedSplit?: boolean;
}

/** Format/structure checks only, never a local semantic truth or sufficiency classifier. */
export function referenceProseKind(text: string, sectionPath = ''): 'content' | 'limitation' | 'meta' {
  const plain = text.replace(/\[\[([^\]]+)\]\]/gu, '$1').trim();
  // Editorial source-coverage notes are not the concept's own limitations.
  // Keep actual scientific/usage boundaries even under the same heading.
  const sourceCommentary = /(?:^| > )(?:证据限制|来源说明|资料说明|整理说明|编者注)$/u.test(sectionPath)
    && plain.split(/\r?\n/u).filter(line => line.trim()).every(line =>
      /^\s*(?:[-*]\s*)?(?:来源\s*\d+|各来源|本整理|本资料|原文)/u.test(line));
  if (!plain || sourceCommentary || /(?:^| > )(?:学习目标|本章目标|学习计划|参考文献|来源|sources?|references?)$/iu.test(sectionPath)
    || /^(?:#{1,6}\s+[^\n]+\s*)+$/u.test(plain)
    || /^(?:```(?:json|mermaid|jsx?|tsx?|html)|\{\s*"|\[\s*(?:\{|\x22)|"[a-zA-Z]+"\s*:)/u.test(plain)
    || /^观察问题[：:]/u.test(plain)) return 'meta';
  if (/(?:^|\n)```\s*$/mu.test(plain) && !/^```(?:math|latex)?\s*\r?\n/u.test(plain)) return 'meta';
  const sentences = plain.split(/(?<=[。！？])\s*/u).filter(Boolean);
  if (sentences.length && sentences.every(sentence =>
    /^(?:先把.{0,60}(?:并排|放好)|(?:下表|上表|如下|下面|以下).{0,160}(?:整理|对照|呈现|列出|展示)|(?:本章|本节|这一章).{0,60}(?:将学习|学习目标)|[-*]\s*能(?:够|说明|解释|区分|设计))/u.test(sentence))) return 'meta';
  return /证据(?:未提供|不足|边界)|资料不足|尚不足以|不能推广|无法据此/u.test(plain) ? 'limitation' : 'content';
}

/** Restore only bounded local continuity from the CURRENT source. Never cut a table or clause
 * to fit a budget, cross a heading, or treat a neighbouring user's answer as a reference. */
export function selectReferenceEvidence(body: string, span: ReferenceEvidenceSpan, maxChars = 1400) {
  let start = span.textStart, end = span.textEnd;
  if (start < 0 || end <= start || end > body.length || end - start > maxChars) return undefined;
  const text = () => body.slice(start, end);
  const floor = Math.max(0, start - maxChars);
  const firstBreak = body.indexOf('\n', floor);
  const nearbyStart = floor === 0 ? 0 : firstBreak >= 0 && firstBreak < start ? firstBreak + 1 : start;
  const nearbyEnd = Math.min(body.length, end + maxChars);
  const blocks = [...body.slice(nearbyStart, nearbyEnd).matchAll(/[^\r\n]+(?:\r?\n(?!\r?\n)[^\r\n]+)*/gu)]
    .map(match => ({ start: nearbyStart + match.index!, end: nearbyStart + match.index! + match[0].length, text: match[0] }));
  const focus = blocks.findIndex(block => block.start <= start && block.end >= end);
  const sameHeading = (from: number, to: number) => !/(?:^|\n)#{1,6}\s/u.test(body.slice(from, to));
  if (span.forcedSplit && focus >= 0) {
    const paragraph = blocks[focus];
    if (paragraph.end - paragraph.start > maxChars) return undefined;
    start = paragraph.start; end = paragraph.end;
  }
  // Indexed rows can start inside a Markdown table; include its complete header and rows.
  if (focus >= 0 && /^\s*\|/u.test(blocks[focus].text)) {
    const table = blocks[focus];
    if (!/^\s*\|?\s*:?-{2,}.*\|/mu.test(table.text) || table.end - table.start > maxChars) return undefined;
    start = table.start; end = table.end;
  }
  const kind = referenceProseKind(text(), span.sectionPath);
  if (kind === 'meta') {
    // A transition pointing to a table is useful only together with the actual table.
    const next = blocks[focus + 1];
    if (focus < 0 || !/下表|如下|下面|以下/u.test(text()) || !next || !/^\s*\|/u.test(next.text)
      || !/^\s*\|?\s*:?-{2,}.*\|/mu.test(next.text) || next.end - start > maxChars
      || !sameHeading(start, next.end) || /学习目标|本章目标/u.test(span.sectionPath)) return undefined;
    end = next.end;
  }
  if (focus >= 0 && (span.forcedSplit || /^(?:这|该|它|其|因此|所以|其中|上述)/u.test(text().trim()))) {
    const previous = blocks[focus - 1];
    if (previous && end - previous.start <= maxChars && sameHeading(previous.start, end)
      && referenceProseKind(previous.text, span.sectionPath) !== 'meta') start = previous.start;
  }
  if (span.forcedSplit && focus >= 0) {
    const next = blocks[focus + 1];
    if (next && next.end - start <= maxChars && sameHeading(start, next.end)
      && referenceProseKind(next.text, span.sectionPath) !== 'meta') end = next.end;
  }
  const result = body.slice(start, end);
  if (referenceProseKind(result, span.sectionPath) === 'meta') return undefined;
  return { text: result, textStart: start, textEnd: end, kind: referenceProseKind(result, span.sectionPath) };
}

/** Callers restrict body size before this read-only fallback. Offsets remain exact UTF-16. */
export function referenceParagraphs(body: string) {
  let sectionPath = '';
  return [...body.matchAll(/[^\r\n]+(?:\r?\n(?!\r?\n)[^\r\n]+)*/gu)].flatMap(match => {
    if (/^#{1,6}\s/u.test(match[0])) {
      sectionPath = match[0].split(/\r?\n/u).filter(line => /^#{1,6}\s/u.test(line)).at(-1)!.replace(/^#+\s*/u, '');
    }
    return [{ textStart: match.index!, textEnd: match.index! + match[0].length, sectionPath }];
  });
}
