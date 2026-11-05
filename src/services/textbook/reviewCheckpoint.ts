import type { TextbookJob } from './generationTypes';
import { TEXTBOOK_CHAPTER_SECTIONS } from './generationTypes';
import { assembleTextbook, validateBlueprint, validateChapter, validateTextbookContent } from './validation';
import { locateTextbookIssue, recordTextbookFailure, TextbookValidationError } from './repair';
import { assessTextbookQuality, recordUnreliableTextbookReview } from './quality';

/** Read-only public projection. Never migrate persisted jobs just to show a button. */
export function previewTextbookCodeRecovery(job: TextbookJob): TextbookJob | undefined {
  if (job.stage !== 'failed' || job.checkpoint.repair?.origin !== 'deterministic'
    || !job.checkpoint.repair.findings.some((finding) => finding.stage === 'chapters'
      && finding.section && !TEXTBOOK_CHAPTER_SECTIONS.includes(finding.section))) return;
  const candidate = structuredClone(job);
  return reconcileTextbookReviewCheckpoint(candidate) === 'retained' && !candidate.checkpoint.repair ? candidate : undefined;
}

/** Old reviewer prose did not prove a failure. Reproduce code errors, otherwise
 * keep every valid draft and review the current book without stale accusations. */
export function reconcileTextbookReviewCheckpoint(job: TextbookJob): 'retained' | 'reproduced' | null {
  const checkpoint = job.checkpoint;
  if (checkpoint.quality?.origin === 'deterministic' && !checkpoint.repair) {
    recordTextbookFailure(job, checkpoint.quality.findings || checkpoint.quality.issues.map((issue) => locateTextbookIssue(issue, checkpoint.blueprint)));
    return 'reproduced';
  }
  if (checkpoint.repair?.origin === 'deterministic') {
    // Older privacy scans parsed model-added fields as Markdown and recorded
    // impossible repair targets such as summaryTable. Revalidate the complete
    // draft before spending a repair round; never clear a real published error.
    const unsupportedTarget = checkpoint.repair.findings.length > 0 && checkpoint.repair.findings.every((finding) =>
      finding.stage === 'chapters' && finding.section && !TEXTBOOK_CHAPTER_SECTIONS.includes(finding.section));
    const pendingSections = Object.values(checkpoint.sectionRepairs || {}).flat();
    const complete = checkpoint.context && checkpoint.sources?.length && checkpoint.blueprint && checkpoint.chapters?.length === checkpoint.blueprint.chapters.length
      && checkpoint.blueprint.chapters.every((plan) => checkpoint.chapters!.some((chapter) => chapter.id === plan.id));
    if (!unsupportedTarget || !complete || pendingSections.some((section) => TEXTBOOK_CHAPTER_SECTIONS.includes(section))) return null;
    // A previous retry may already have queued an impossible patch and spent
    // its repair allowance. Remove only that stale queue, never reset usage.
    delete checkpoint.sectionRepairs;
  }
  if (checkpoint.repair?.origin === 'reviewer' && checkpoint.repair.applied) return null;
  if (checkpoint.repair?.origin === 'reviewer' || checkpoint.quality?.origin === 'reviewer') {
    if (checkpoint.quality?.status !== 'blocked' && !checkpoint.repair) return null;
    if (checkpoint.quality?.report?.schemaVersion === 2 && checkpoint.quality.reviewCriteriaVersion !== 3) {
      // Old opinions have no impact/certainty contract. Review the intact book
      // against the new standard BEFORE spending tokens on author revisions.
      recordUnreliableTextbookReview(job, '旧标准的语义否决需按新版学习可用标准重新复核；现有章节保留');
      delete checkpoint.reviewCache;
      return 'retained';
    }
    try {
      const { context, sources, blueprint, chapters } = checkpoint;
      if (!context || !sources || !blueprint || !chapters) throw new Error('Incomplete review context');
      const verified = assessTextbookQuality(checkpoint.quality?.report, { context, sources, blueprint, chapters });
      if (verified.passed) throw new Error('No grounded rejection');
      const artifactHash = checkpoint.quality?.artifactHash;
      const reviewCriteriaVersion = checkpoint.quality?.reviewCriteriaVersion;
      recordTextbookFailure(job, verified.findings!, 'reviewer');
      checkpoint.quality = { ...verified, artifactHash, reviewCriteriaVersion };
      return null;
    } catch {
      recordUnreliableTextbookReview(job, '已保存的复核否决无法在当前教材与原文中核验');
      return 'retained';
    }
  }
  if (!checkpoint.repair && checkpoint.quality?.passed !== false && !checkpoint.repairIssues?.length) return null;
  const { context, sources, blueprint, chapters = [] } = checkpoint;
  let stage: 'blueprint' | 'validating' = 'blueprint';
  try {
    if (context && sources && blueprint) {
      validateBlueprint(blueprint, context, sources);
      for (const chapter of chapters) {
        const plan = blueprint.chapters.find((plan) => plan.id === chapter.id);
        if (plan) validateChapter(chapter, plan.id, plan.sourceIds, sources.filter((source) => plan.sourceIds.includes(source.sourceId)).flatMap((source) => (source.assets || []).map((asset) => asset.id)), plan.writingPlan);
      }
      stage = 'validating';
      if (chapters.length === blueprint.chapters.length) validateTextbookContent(job, assembleTextbook(blueprint, chapters, sources));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '旧草稿确定性检查未通过';
    recordTextbookFailure(job, error instanceof TextbookValidationError ? error.findings : [{ stage, message }]);
    return 'reproduced';
  }
  delete checkpoint.repair; delete checkpoint.repairIssues; delete checkpoint.quality;
  return 'retained';
}
