/** Source-local UTF-16 intervals. IDs identify original text, never model paraphrases or truth. */
export interface ReviewQuoteSource { id: string; kind: 'answer' | 'reference' | 'personal_node' | 'personal_context'; text: string; truncated: boolean }
export interface ReviewQuoteAnchor { id: string; sourceId: string; start: number; end: number; text: string }
export const REVIEW_ANCHOR_LIMITS = { anchors: 768, sourceCharacters: 60000, quoteCharacters: 600, axisCharacters: 200 } as const;
const splitsSurrogate = (text: string, at: number) => at > 0 && at < text.length
  && /[\uD800-\uDBFF]/u.test(text[at - 1]) && /[\uDC00-\uDFFF]/u.test(text[at]);

/** Deterministic citation candidates; exceeding budgets holds the channel, never silently prunes it. */
export function buildReviewQuoteAnchors(sources: ReviewQuoteSource[], required: Array<{ sourceId: string; start: number; end: number }> = []) {
  if (new Set(sources.map((s) => s.id)).size !== sources.length
    || sources.reduce((sum, s) => sum + s.text.length, 0) > REVIEW_ANCHOR_LIMITS.sourceCharacters) throw new Error('anchor_budget_exceeded');
  const anchors: ReviewQuoteAnchor[] = [], keys = new Set<string>();
  const add = (source: ReviewQuoteSource, start: number, end: number) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end > source.text.length || end <= start
      || splitsSurrogate(source.text, start) || splitsSurrogate(source.text, end)) throw new Error('invalid_anchor_interval');
    if (end - start > REVIEW_ANCHOR_LIMITS.quoteCharacters || !source.text.slice(start, end).trim()) return;
    const key = JSON.stringify([source.id, start, end]);
    if (keys.has(key)) return;
    if (anchors.length >= REVIEW_ANCHOR_LIMITS.anchors) throw new Error('anchor_budget_exceeded');
    keys.add(key); anchors.push({ id: `Q${anchors.length + 1}`, sourceId: source.id, start, end, text: source.text.slice(start, end) });
  };
  // Required claim intervals are exact extraction spans, including a selected repeated occurrence.
  for (const range of required) {
    const source = sources.find((s) => s.id === range.sourceId);
    if (!source || range.end - range.start > 600) throw new Error('invalid_anchor_interval');
    add(source, range.start, range.end);
  }
  for (const source of sources) {
    if (!source.text.length) continue;
    add(source, 0, source.text.length);
    const sentences: Array<{ start: number; end: number }> = [];
    let start = 0;
    for (const match of source.text.matchAll(/[。！？；;\n]/gu)) {
      const end = match.index! + match[0].length;
      sentences.push({ start, end }); start = end;
    }
    if (start < source.text.length) sentences.push({ start, end: source.text.length });
    for (let i = 0; i < sentences.length; i++) {
      // Contiguous windows can cover a premise, rule and conclusion without stitching quotes.
      for (let count = 1; count <= 4 && i + count <= sentences.length; count++) add(source, sentences[i].start, sentences[i + count - 1].end);
    }
    let clauseStart = 0;
    for (const match of source.text.matchAll(/[，,：:。！？；;\n]/gu)) {
      const at = match.index!;
      if (at > clauseStart) add(source, clauseStart, at);
      add(source, clauseStart, at + match[0].length); clauseStart = at + match[0].length;
    }
    if (clauseStart < source.text.length) add(source, clauseStart, source.text.length);
    // Long clauses still have bounded original intervals for axis citations. No text normalization.
    for (let from = 0; from < source.text.length;) {
      let end = Math.min(source.text.length, from + REVIEW_ANCHOR_LIMITS.axisCharacters);
      if (splitsSurrogate(source.text, end)) end--;
      add(source, from, end); from = end;
    }
  }
  return anchors;
}

export function readReviewQuoteAnchor(
  id: unknown, anchors: ReviewQuoteAnchor[], sourceIds: string[], max: number,
  within?: { sourceId: string; start: number; end: number },
): ReviewQuoteAnchor {
  const anchor = anchors.find((a) => a.id === id);
  if (!anchor) throw new Error('unknown_quote_anchor');
  if (!sourceIds.includes(anchor.sourceId)) throw new Error('wrong_quote_source');
  if (anchor.text.length > max) throw new Error('quote_anchor_too_long');
  if (within && (anchor.sourceId !== within.sourceId || anchor.start < within.start || anchor.end > within.end)) throw new Error('quote_anchor_outside_claim');
  return anchor;
}
