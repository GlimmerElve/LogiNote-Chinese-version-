import type { TextbookDraftCacheSelection, TextbookJob } from './generationTypes';

/** Only generated payloads. Original/frozen material, scope and cost stay intact. */
export function clearTextbookDraftCache(job: TextbookJob, selection: TextbookDraftCacheSelection, at: string): {
  job: TextbookJob; chapterIds: string[]; backupChapterIds: string[]; clearsAssembledBody: boolean; hasContent: boolean;
} {
  if (job.stage === 'published') throw new Error('已发布教材不能通过草稿缓存清理入口处理');
  if (!['all_generated', 'selected_chapters', 'backups_only'].includes(selection.scope)) throw new Error('教材缓存清理范围无效');
  const plans = job.checkpoint.blueprint?.chapters || [];
  if (selection.scope === 'selected_chapters') {
    if (!Array.isArray(selection.chapterIds) || !selection.chapterIds.length || selection.chapterIds.length > 6
      || new Set(selection.chapterIds).size !== selection.chapterIds.length
      || selection.chapterIds.some((id) => typeof id !== 'string' || !plans.some((plan) => plan.id === id))) {
      throw new Error('请选择已有教学蓝图中的真实章节编号');
    }
  } else if (selection.chapterIds !== undefined) throw new Error('非指定章节清理不能携带章节编号');
  const candidate = structuredClone(job), checkpoint = candidate.checkpoint;
  const selected = new Set(selection.chapterIds);
  const chapterIds = selection.scope === 'backups_only' ? [] : (checkpoint.chapters || [])
    .filter((chapter) => selection.scope === 'all_generated' || selected.has(chapter.id)).map((chapter) => chapter.id);
  const backupChapterIds = (checkpoint.chapterRegeneration?.previousChapters || [])
    .filter((chapter) => selection.scope !== 'selected_chapters' || selected.has(chapter.id)).map((chapter) => chapter.id);
  const clearsAssembledBody = selection.scope !== 'backups_only' && checkpoint.body !== undefined;
  const hasContent = chapterIds.length > 0 || backupChapterIds.length > 0 || clearsAssembledBody
    || (selection.scope === 'all_generated' && !!(checkpoint.quality || checkpoint.reviewCache));
  if (!hasContent) return { job: candidate, chapterIds, backupChapterIds, clearsAssembledBody, hasContent };
  if (selection.scope !== 'backups_only') {
    checkpoint.chapters = (checkpoint.chapters || []).filter((chapter) => !chapterIds.includes(chapter.id));
    const clearedIds = selection.scope === 'all_generated' ? plans.map((plan) => plan.id) : [...selected];
    for (const id of clearedIds) { delete checkpoint.chapterInputs?.[id]; delete checkpoint.sectionRepairs?.[id]; }
    if (selection.scope === 'all_generated') {
      delete checkpoint.chapterInputs; delete checkpoint.sectionRepairs; delete checkpoint.repair; delete checkpoint.repairIssues;
    } else if (checkpoint.repair) {
      checkpoint.repair.findings = checkpoint.repair.findings.filter((finding) => finding.stage !== 'chapters' || !selected.has(finding.chapterId || ''));
      if (!checkpoint.repair.findings.length) { delete checkpoint.repair; delete checkpoint.repairIssues; }
      else checkpoint.repairIssues = checkpoint.repair.findings.map((finding) => finding.message);
    }
    if (!checkpoint.repair) delete checkpoint.repairIssues;
    // Full-book caches/review quotes may contain any removed chapter. Never
    // leave a hidden duplicate or reuse its old validation verdict.
    delete checkpoint.body; delete checkpoint.quality; delete checkpoint.reviewCache;
    if (checkpoint.chapterRegeneration) {
      if (selection.scope === 'all_generated') delete checkpoint.chapterRegeneration;
      else {
        checkpoint.chapterRegeneration.pendingIds = checkpoint.chapterRegeneration.pendingIds.filter((id) => !selected.has(id));
        checkpoint.chapterRegeneration.requestedIds = checkpoint.chapterRegeneration.requestedIds.filter((id) => !selected.has(id));
      }
    }
    candidate.stage = 'cancelled'; delete candidate.error;
    if (selection.scope === 'all_generated') candidate.archivedAt ||= at;
  }
  if (checkpoint.chapterRegeneration) checkpoint.chapterRegeneration.previousChapters = checkpoint.chapterRegeneration.previousChapters
    .filter((chapter) => !backupChapterIds.includes(chapter.id));
  candidate.cacheClearHistory = [...(candidate.cacheClearHistory || []), { at, scope: selection.scope, chapterIds, backupChapterIds }].slice(-8);
  candidate.updatedAt = at;
  return { job: candidate, chapterIds, backupChapterIds, clearsAssembledBody, hasContent };
}
