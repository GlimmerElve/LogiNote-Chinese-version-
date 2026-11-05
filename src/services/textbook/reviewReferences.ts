import type { TextbookReviewBasis, TextbookReviewTarget } from './generationTypes';
import { TextbookReviewError, type TextbookReviewInput } from './quality';

type Segment = { ref: string; text: string };
type Reference = { text: string; target?: TextbookReviewTarget; basis: TextbookReviewBasis };

/** Replace, rather than duplicate, original strings. Segments remain exact slices,
 * including Markdown/LaTeX; the model never has to reproduce their punctuation. */
export function indexTextbookReview(input: TextbookReviewInput) {
  const references = new Map<string, Reference>();
  const counts: Record<string, number> = {};
  const segments = (text: string, prefix: string, create: (quote: string) => Omit<Reference, 'text'>): Segment[] => {
    if (!text.trim()) return [];
    const result: Segment[] = [];
    for (let start = 0; start < text.length;) {
      let end = Math.min(start + 1000, text.length);
      if (end < text.length) {
        const newline = text.lastIndexOf('\n', end - 1);
        if (newline >= start + 500) end = newline + 1;
        if (text.length - end < 8) end = text.length;
      }
      const quote = text.slice(start, end);
      const ref = `${prefix}${counts[prefix] = (counts[prefix] || 0) + 1}`;
      references.set(ref, { text: quote, ...create(quote) });
      result.push({ ref, text: quote }); start = end;
    }
    return result;
  };
  const target = (text: string, create: (quote: string) => TextbookReviewTarget) => segments(text, 'T', quote => {
    const location = create(quote); return { target: location, basis: { kind: 'textbook', target: location } };
  });
  const request = { ...input,
    context: { ...input.context, project: { ...input.context.project,
      tasks: input.context.project.tasks.map((text, index) => segments(text, 'K', quote => ({ basis: { kind: 'task', index, quote } }))) },
      personal: input.context.personal.map(item => ({ ...item, text: segments(item.text, 'P', quote => ({ basis: { kind: 'personal', evidenceId: item.evidenceId, quote } })) })),
      previousLearning: input.context.previousLearning ? { ...input.context.previousLearning,
        title: segments(input.context.previousLearning.title, 'H', quote => ({ basis: { kind: 'previous_learning', quote } })) } : undefined },
    blueprint: { ...input.blueprint,
      objectives: input.blueprint.objectives.map(item => ({ ...item, text: target(item.text, quote => ({ kind: 'objective', id: item.id, quote })) })),
      focuses: input.blueprint.focuses.map(item => ({ ...item,
        description: target(item.description, quote => ({ kind: 'focus', id: item.id, field: 'description', quote })),
        strategy: target(item.strategy, quote => ({ kind: 'focus', id: item.id, field: 'strategy', quote })) })),
      chapters: input.blueprint.chapters.map(item => ({ ...item, bridge: target(item.bridge, quote => ({ kind: 'bridge', chapterId: item.id, quote })) })) },
    chapters: input.chapters.map(chapter => ({ ...chapter, sections: Object.fromEntries(Object.entries(chapter.sections)
      .map(([section, text]) => [section, target(text || '', quote => ({ kind: 'chapter', chapterId: chapter.id,
        section: section as keyof typeof chapter.sections, quote }))])) })),
    sources: input.sources.map(source => ({ ...source, text: segments(source.text, 'S', quote => ({ basis: { kind: 'source', sourceId: source.sourceId, quote } })) })),
  };
  return { request, references };
}

/** Resolve to the existing grounded, persisted v3 format. Legacy reports remain
 * supported; IDs are local to this exact input and are never saved as evidence. */
export function resolveTextbookReviewReferences(raw: unknown, input: TextbookReviewInput): unknown {
  if (!raw || typeof raw !== 'object' || (raw as { schemaVersion?: unknown }).schemaVersion !== 4) return raw;
  const report = raw as { passed?: unknown; findings?: unknown; issues?: unknown };
  if (typeof report.passed !== 'boolean' || !Array.isArray(report.findings) || report.findings.length > 20) throw new TextbookReviewError('质量复核编号报告格式无效');
  const { references } = indexTextbookReview(input);
  const resolve = (value: unknown, asTarget: boolean, index: number, field: string) => {
    const item = value as { ref?: unknown; quote?: unknown } | null;
    const reference = typeof item?.ref === 'string' ? references.get(item.ref) : undefined;
    const fail = (message: string): never => { throw new TextbookReviewError(message,
      [{ findingIndex: index + 1, field, message, disposition: 'needs_recheck', ...(typeof item?.quote === 'string' ? { quote: item.quote.slice(0, 240) } : {}) }]); };
    if (!reference || asTarget && !reference.target) return fail('复核引用了不存在或用途错误的位置编号');
    if (item!.quote !== undefined && (typeof item!.quote !== 'string' || !item!.quote.trim() || item!.quote.length > 1200
      || !reference.text.replace(/\s+/gu, ' ').includes(item!.quote.replace(/\s+/gu, ' ').trim()))) return fail('复核编号内的可选引文与原文不符');
    const quote = typeof item!.quote === 'string' ? item!.quote : reference.text;
    if (asTarget) return { ...reference.target!, quote };
    return reference.basis.kind === 'textbook' ? { kind: 'textbook', target: { ...reference.basis.target, quote } } : { ...reference.basis, quote };
  };
  // Each resolution error is kept on the finding for the assessor. This lets
  // malformed advice be ignored without concealing an invalid critical blocker.
  return { ...report, schemaVersion: 3, findings: report.findings.map((value, index) => {
    if (!value || typeof value !== 'object') return value;
    const finding = value as Record<string, unknown>;
    try { return { ...finding, target: resolve(finding.target, true, index, 'target.ref'),
      basis: Array.isArray(finding.basis) ? finding.basis.map((item, i) => resolve(item, false, index, `basis[${i}].ref`)) : finding.basis }; }
    catch (error) {
      if (!(error instanceof TextbookReviewError)) throw error;
      const location = references.get((finding.target as { ref?: string })?.ref || '')?.target;
      if (location?.kind === 'chapter') error.diagnostics = error.diagnostics.map(item => ({ ...item, chapterId: location.chapterId, section: location.section }));
      return { ...finding, ...(location ? { target: location } : {}), referenceError: error };
    }
  }) };
}
