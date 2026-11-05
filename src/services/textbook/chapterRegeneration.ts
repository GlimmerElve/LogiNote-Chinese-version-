import type { TextbookJob } from './generationTypes';
import { textbookCostLimits, TextbookBudgetError } from './cost';
import type { NoteItem } from '../../types';
import { readTextbookBody } from './noteContent';
import { textbookSections } from './markdown';

/** Verify actual Markdown spans, not just structured chapter IDs. */
export function assertPublishedRevisionBody(job: TextbookJob, body: string): void {
  const revision = job.checkpoint.publishedRevision;
  if (!revision) return;
  const manifest = { chapters: job.checkpoint.blueprint!.chapters, revisionId: revision.revisionId };
  const oldBody = revision.body.trim(), nextBody = body.trim();
  const before = textbookSections(oldBody, manifest), after = textbookSections(nextBody, manifest);
  if (!before.length || before.length !== after.length || before.some((section, index) => section.title !== after[index].title || section.chapterId !== after[index].chapterId)
    || oldBody.slice(0, before[0].start) !== nextBody.slice(0, after[0].start)
    || revision.chapterIds.some(id => before.filter(section => section.chapterId === id).length !== 1)) throw new Error('章节重生成改变了目录或篇首内容，未替换已发布教材');
  for (const [index, section] of before.entries()) if (!section.chapterId || !revision.chapterIds.includes(section.chapterId)) {
    if (oldBody.slice(section.start, before[index + 1]?.start) !== nextBody.slice(after[index].start, after[index + 1]?.start)) throw new Error('重生成涉及未批准章节或来源清单，旧教材保留');
  }
}

export function validatePublishedChapterRegeneration(job: TextbookJob, note: NoteItem, chapterIds: string[]): void {
  if (job.stage !== 'published' || note.id !== job.spec.projectNoteId || note.textbook?.generationJobId !== job.id
    || !job.checkpoint.body || readTextbookBody(note.content, note.textbook) !== job.checkpoint.body.trim()) {
    throw new Error('已发布教材与原生成快照不一致，不能覆盖人工修改；请先使用局部教材编辑');
  }
  const chapters = job.checkpoint.blueprint?.chapters.map(({ id, title }) => ({ id, title }));
  if (JSON.stringify(note.textbook.chapters) !== JSON.stringify(chapters)) throw new Error('教材目录与原蓝图不一致，未重排大纲');
  validateTextbookChapterRegeneration({ ...job, stage: 'context' }, chapterIds);
}

export function validateTextbookChapterRegeneration(job: TextbookJob, chapterIds: string[]): void {
  if (job.archivedAt || job.stage === 'published') throw new Error('只支持未归档、尚未发布的教材草稿；不会改动已写入的教材');
  const plans = job.checkpoint.blueprint?.chapters;
  if (!job.checkpoint.context || !job.checkpoint.sources?.length || !plans
    || !Array.isArray(chapterIds) || !chapterIds.length || chapterIds.length > 6 || new Set(chapterIds).size !== chapterIds.length
    || chapterIds.some((id) => !plans.some((plan) => plan.id === id))) throw new Error('请从已有教学蓝图选择真实章节编号；不新建蓝图或扩大资料范围');
  if (job.checkpoint.chapterRegeneration?.pendingIds.length) throw new Error('已有按章重生成请求尚未完成，请使用同一任务继续，不重复清理章节');
  const cost = job.checkpoint.cost, limits = textbookCostLimits(job);
  if (cost && cost.requests >= limits.maxRequests) throw new TextbookBudgetError('requests');
  if (cost && cost.promptTokens + cost.completionTokens + cost.reservedTokens >= limits.maxTotalTokens) throw new TextbookBudgetError('tokens');
  if (plans.some((plan) => !chapterIds.includes(plan.id) && !job.checkpoint.chapters?.some((chapter) => chapter.id === plan.id))) {
    throw new Error('其它章节仍未生成完成，请先恢复原任务或一并明确选择缺失章节；不会擅自生成未选择的缺失章节');
  }
}

/** Called only inside a newly approved execution lease, before any model call.
 * This is a user-requested generation, not an automatic quality repair round;
 * all request/token reservations continue to use the original task's ledger. */
export function queueTextbookChapterRegeneration(job: TextbookJob, chapterIds: string[]): void {
  validateTextbookChapterRegeneration(job, chapterIds);
  const checkpoint = job.checkpoint;
  checkpoint.chapterRegeneration = { requestedIds: [...chapterIds], pendingIds: [...chapterIds], requestedAt: new Date().toISOString(),
    previousChapters: structuredClone((checkpoint.chapters || []).filter((chapter) => chapterIds.includes(chapter.id))) };
  checkpoint.chapters = (checkpoint.chapters || []).filter((chapter) => !chapterIds.includes(chapter.id));
  clearRegeneratingChapterFailures(job);
  delete checkpoint.body; delete checkpoint.quality;
}

/** A failed explicit regeneration stays a pending generation, not an invented
 * automatic whole-book repair. Genuine failures elsewhere are retained. */
export function clearRegeneratingChapterFailures(job: TextbookJob): void {
  const pending = job.checkpoint.chapterRegeneration?.pendingIds || [];
  if (!pending.length) return;
  const repair = job.checkpoint.repair;
  if (repair) {
    repair.findings = repair.findings.filter((finding) => finding.stage !== 'chapters' || !pending.includes(finding.chapterId || ''));
    if (!repair.findings.length) { delete job.checkpoint.repair; delete job.checkpoint.repairIssues; }
    else job.checkpoint.repairIssues = repair.findings.map((finding) => finding.message);
  }
  for (const id of pending) delete job.checkpoint.sectionRepairs?.[id];
}
