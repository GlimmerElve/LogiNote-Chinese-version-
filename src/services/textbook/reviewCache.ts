import type { TextbookContext, TextbookJob, TextbookQuality, TextbookReviewFinding, TextbookReviewReport } from './generationTypes';
import { textbookHash } from './fingerprint';
import { assessTextbookQuality, TextbookReviewError, type TextbookReviewInput } from './quality';
import { TEXTBOOK_QUALITY_PROMPT } from '../../workflows/textbookPrompt';
import { textbookTeachingReviewPrompt } from './teachingPlan';
import { resolveTextbookPrompt } from '../../workflows/textbookPromptV2';
import type { TeachingBlueprint } from './generationTypes';
import { indexedTextbookReviewPrompt } from '../../workflows/textbookReviewPrompt';
import { resolveTextbookReviewReferences } from './reviewReferences';
import { usesProgressiveTextbookPrompt } from './promptVersion';

export function textbookReviewCriteria(job: Pick<TextbookJob, 'spec'>, blueprint: TeachingBlueprint): string {
  const base = textbookTeachingReviewPrompt(TEXTBOOK_QUALITY_PROMPT, blueprint);
  // v1/v2 checkpoints used the legacy key. Keep it byte-exact on resume rather
  // than triggering a new model call for an already grounded cached report.
  const criteria = job.spec.promptVersion === 3 || usesProgressiveTextbookPrompt(job.spec.promptVersion)
    ? resolveTextbookPrompt(base, job.spec.promptVersion, job.spec.visualCapabilitiesVersion) : base;
  return usesProgressiveTextbookPrompt(job.spec.promptVersion) ? indexedTextbookReviewPrompt(criteria) : criteria;
}

export function compactTextbookReviewContext(context: TextbookContext): TextbookContext {
  return { ...context, mastery: {}, warnings: [], personal: context.personal.map((item) => ({ ...item, reference: null })),
    previousLearning: context.previousLearning ? { ...context.previousLearning, endedAt: '', summary: '', unresolvedQuestions: [] } : undefined };
}
export interface TextbookReviewPlan {
  environmentHash: string; chapterHashes: Record<string, string>;
  changed: string[]; scoped: boolean; retained: TextbookReviewFinding[];
  input: TextbookReviewInput; cachedQuality?: TextbookQuality;
}
/** A complete grounded review can cover unchanged chapters. Cache invalidation is
 * content based, including sources/context/blueprint/review criteria, never timestamps. */
export async function planTextbookReview(job: TextbookJob, full: TextbookReviewInput): Promise<TextbookReviewPlan> {
  const compact = compactTextbookReviewContext(full.context);
  const environmentHash = await textbookHash({ context: compact, blueprint: full.blueprint, sources: full.sources,
    criteria: textbookReviewCriteria(job, full.blueprint) });
  // Grounded old reports still cover identical books. A wire-format change must
  // not trigger a model call or discard a genuine saved blocker on restart.
  const legacyEnvironmentHash = job.spec.promptVersion === 4 ? await textbookHash({ context: compact, blueprint: full.blueprint, sources: full.sources,
    criteria: resolveTextbookPrompt(textbookTeachingReviewPrompt(TEXTBOOK_QUALITY_PROMPT, full.blueprint), 4, job.spec.visualCapabilitiesVersion) }) : undefined;
  const chapterHashes = Object.fromEntries(await Promise.all(full.chapters.map(async (chapter) => [chapter.id, await textbookHash(chapter)])));
  const cache = job.checkpoint.reviewCache;
  const eligible = !!cache && (cache.environmentHash === environmentHash || cache.environmentHash === legacyEnvironmentHash)
    && Object.keys(cache.chapterHashes).length === full.chapters.length;
  let changed = full.chapters.filter((chapter) => !eligible || cache.chapterHashes[chapter.id] !== chapterHashes[chapter.id]).map((chapter) => chapter.id);
  let retained: TextbookReviewFinding[] = [];
  let cachedQuality: TextbookQuality | undefined;
  if (eligible) {
    retained = cache.report.findings.filter((finding) => finding.target.kind !== 'chapter' || !changed.includes(finding.target.chapterId));
    try {
      // A retained cross-chapter quote may have changed in a repaired section.
      // Validate every anchor; if invalid, conservatively request a full review.
      cachedQuality = assessTextbookQuality({ ...cache.report, passed: !retained.some((item) => item.severity === 'blocker'), findings: retained }, full);
      if (!changed.length && cache.reviewDiagnostics?.length) cachedQuality.reviewDiagnostics = cache.reviewDiagnostics;
    } catch { changed = full.chapters.map((chapter) => chapter.id); retained = []; }
  }
  const scoped = eligible && changed.length > 0 && changed.length < full.chapters.length && !!cachedQuality;
  const neighbors = new Set<string>();
  for (const [index, chapter] of full.blueprint.chapters.entries()) if (changed.includes(chapter.id)) {
    if (index > 0) neighbors.add(full.blueprint.chapters[index - 1].id);
    if (index + 1 < full.blueprint.chapters.length) neighbors.add(full.blueprint.chapters[index + 1].id);
  }
  const used = new Set(full.blueprint.chapters.filter((chapter) => !scoped || changed.includes(chapter.id)).flatMap((chapter) => chapter.sourceIds));
  const input: TextbookReviewInput = { ...full, context: compact, sources: full.sources.filter((source) => used.has(source.sourceId)),
    chapters: scoped ? full.chapters.map((chapter) => changed.includes(chapter.id) || neighbors.has(chapter.id) ? chapter : { id: chapter.id, sections: { summary: chapter.sections.summary } }) : full.chapters };
  return { environmentHash, chapterHashes, changed, scoped, retained, input, cachedQuality: eligible && changed.length === 0 ? cachedQuality : undefined };
}
export function acceptTextbookReview(job: TextbookJob, plan: TextbookReviewPlan, raw: unknown, full: TextbookReviewInput): TextbookQuality {
  const fresh = assessTextbookQuality(resolveTextbookReviewReferences(raw, plan.input), plan.input);
  const scopedFindings = fresh.report!.findings.filter((finding, index) => {
    if (!plan.scoped || finding.target.kind === 'chapter' && plan.changed.includes(finding.target.chapterId)) return true;
    const message = '局部复核超出本次修改章节范围，不能据此改写已通过的内容';
    if (finding.severity === 'blocker') throw new TextbookReviewError(message,
      [{ findingIndex: index + 1, field: 'finding', message, disposition: 'needs_recheck' }]);
    (fresh.reviewDiagnostics ||= []).push({ findingIndex: index + 1, field: 'finding', message, disposition: 'ignored_advice' });
    return false;
  });
  const findings = [...(plan.scoped ? plan.retained : []), ...scopedFindings];
  const version = fresh.schemaVersion!;
  const report: TextbookReviewReport = { schemaVersion: version,
    passed: !findings.some((item) => item.severity === 'blocker'),
    findings: version === 3 ? findings.map((item) => ({ ...item, impact: item.impact || (item.severity === 'blocker' ? 'critical' : 'minor'), certainty: item.certainty || 'clear' })) : findings };
  const quality = assessTextbookQuality(report, full);
  if (fresh.reviewDiagnostics?.length) quality.reviewDiagnostics = fresh.reviewDiagnostics;
  // Never cache an invalid or partial report. A scoped report is merged with a
  // verified, complete predecessor before advancing this full-book checkpoint.
  job.checkpoint.reviewCache = { environmentHash: plan.environmentHash, chapterHashes: plan.chapterHashes, report: quality.report!,
    ...(quality.reviewDiagnostics?.length ? { reviewDiagnostics: quality.reviewDiagnostics } : {}) };
  return quality;
}
