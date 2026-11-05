import { registerTool } from '../toolRegistry';
import { generateTextbook, prepareTextbook, queryTextbookState, textbookApprovalSnapshot, textbookConfirmation } from '../../textbook/generation';
import { listTextbookJobs, textbookJobCommand, requestTextbookStop } from '../../textbook/jobClient';
import { safeTextbookWebError, safeTextbookTaskError } from '../../textbook/webErrors';
import { sanitizeTextbookProgressDiagnostics } from '../../textbook/progress';
import { textbookHash } from '../../textbook/fingerprint';
import { validateTextbookChapterRegeneration, validatePublishedChapterRegeneration } from '../../textbook/chapterRegeneration';
import type { TextbookDraftCachePreview, TextbookDraftCacheSelection } from '../../textbook/generationTypes';
import { canonicalAgentValue } from '../approvalBinding';
import { registerTextbookEditTools } from './textbookEditTools';

function jobId(args: Record<string, unknown>): string {
  if (typeof args.jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/u.test(args.jobId)) throw new Error('需要此前准备工具返回的教材任务 jobId');
  return args.jobId;
}
const projectProperty = { projectNoteId: { type: 'string', description: '真实项目笔记的稳定 ID；省略则使用当前选中的项目，不按标题模糊匹配' } };
const jobSchema = { type: 'object', required: ['jobId'], properties: { jobId: { type: 'string' } }, additionalProperties: false };
function chapterIds(args: Record<string, unknown>): string[] {
  if (!Array.isArray(args.chapterIds) || !args.chapterIds.length || args.chapterIds.length > 6
    || args.chapterIds.some((id) => typeof id !== 'string')) throw new Error('请选择真实教学蓝图中的章节编号');
  return args.chapterIds as string[];
}
const cacheClearApprovals = new Map<string, TextbookDraftCachePreview>();
function cacheSelection(args: Record<string, unknown>): TextbookDraftCacheSelection {
  if (!['all_generated', 'selected_chapters', 'backups_only'].includes(String(args.scope))) throw new Error('请明确清理整份生成缓存、指定章节还是旧章备份');
  return { scope: args.scope as TextbookDraftCacheSelection['scope'], ...(args.chapterIds !== undefined ? { chapterIds: chapterIds(args) } : {}) };
}
const clearCacheKey = (args: Record<string, unknown>) => canonicalAgentValue({ jobId: jobId(args), ...cacheSelection(args) });
const chapterApprovals = new Map<string, { revisionId?: string; published: boolean }>();
export function registerTextbookTools(): void {
  registerTextbookEditTools();
  registerTool({ name: 'stop_textbook_job', description: '用户明确要求停止一项正在运行的教材任务时，按查询返回的真实 jobId 请求停止，无需再次确认。不停止其它任务，不归档、清理或重生成，不删除已保存检查点和累计用量。返回 stopping 只是请求已送达，不保证请求立即终止；用 query_textbook_job 复核。已发模型请求可能仍产生用量，已进入持久化的教材保存不能撤销。组合任务应优先 stop_background_workflow，避免只停子任务而保留外层流程。',
    parameters: jobSchema, location: 'renderer', permission: 'navigation', execute: async (args, ctx) => {
      const id = jobId(args), { job } = await textbookJobCommand({ op: 'get', jobId: id });
      if (!ctx.getNotes().some(note => note.id === job.spec.projectNoteId && note.noteType === 'project')) throw new Error('教材任务所属项目已失效，请先检查任务范围');
      return { ...await requestTextbookStop(id), savedResultsRetained: true, usageRetained: true,
        notice: '停止请求不等于回滚或已经停止；已进入保存的操作可能完成，请查询原任务状态。' };
    } });
  registerTool({ name: 'query_project_textbook', description: '查询目标项目是否已有教材、关联知识点、本地资料元数据、当前项目及逐级父项目继承的 documentBindings/effectiveDocumentIds（含绑定来源）、已绑定 URL 元数据与同根项目复习建议。不扩展到兄弟或其他项目，不生成、不联网。',
    parameters: { type: 'object', properties: projectProperty, additionalProperties: false }, location: 'renderer', permission: 'readonly',
    execute: (args, ctx) => queryTextbookState(ctx, typeof args.projectNoteId === 'string' ? args.projectNoteId : undefined) });
  registerTool({ name: 'prepare_project_textbook', description: '锁定教材项目、本地资料、绑定URL、可选联网补缺主题和模型范围；allowedDocIds省略时使用当前项目及逐级父项目绑定的本地资料，不使用兄弟/其它项目资料；显式数组优先。父项目URL不自动继承。相同范围复用原任务、草稿和用量，不重复生成；已有完整教材继续阅读。准备阶段不联网、不调用模型或写教材。新任务经同一生成确认卡批准后，本地优先，按物料缺口读取绑定URL并最多两次短词搜索补充正文、表格和本地图片附件；补缺失败跳过，不阻断已有物料生成。readBoundUrls默认true；用户要求仅本地/仅知识点时传false，同时关闭主动补缺。旧任务不自动获得新联网许可。allowCloud建议省略，由当前配置识别本机/远程，在generate_project_textbook同一确认卡中批准模型数据发送和写入，不另行口头询问云端许可；用户明确拒绝远程时传false，不可绕过。网页物料读取与云端模型许可独立。',
    parameters: { type: 'object', properties: { ...projectProperty, allowedDocIds: { type: 'array', maxItems: 12, items: { type: 'string' } }, allowCloud: { type: 'boolean' }, readBoundUrls: { type: 'boolean' } }, additionalProperties: false },
    location: 'renderer', permission: 'navigation',
    execute: (args, ctx) => prepareTextbook(ctx, { projectNoteId: typeof args.projectNoteId === 'string' ? args.projectNoteId : undefined,
      allowedDocIds: args.allowedDocIds as string[] | undefined, allowCloud: args.allowCloud as boolean | undefined, readBoundUrls: args.readBoundUrls !== false }) });
  registerTool({ name: 'generate_project_textbook', description: '通过同一确认卡合并批准本任务云端模型数据发送范围和教材生成写入，无需先口头询问云端许可。必须经用户确认后才读取限定证据并调用模型生成蓝图、章节、质量校验及写入教材区域；定位到小节的错误仅修该节，复用未修改章节的复核缓存。非关键/不确定改进建议不触发重写。失败保留同任务检查点，继续需确认但不另问云端许可；累计 token、请求和修订到限停止，不自动新建任务绕过限额。',
    parameters: jobSchema, location: 'renderer', permission: 'write', requiresConfirmation: true,
    approvalSnapshot: (args, ctx) => textbookApprovalSnapshot(ctx, jobId(args)),
    confirmation: (args) => textbookConfirmation(jobId(args)),
    execute: (args, ctx, execution) => generateTextbook(ctx, jobId(args), execution?.signal) });
  registerTool({ name: 'regenerate_textbook_chapters', description: '用户明确要求重跑指定章节时使用，必须确认。支持原未发布草稿或与生成快照一致的已发布教材；人工改过的教材拒绝覆盖，改用局部编辑。已发布时沿用原蓝图、证据、教学上下文和累计预算，私有备份旧正文，原教材保持可读；仅选定章节可变化，目录、其它章节和来源清单必须逐段保持不变。完整校验后核对确认版本再替换；失败保留原教材和检查点，generate_project_textbook续办原jobId，不重复申请重跑。未发布草稿仍按承接依赖重生成。不能绕过质检修订上限。',
    parameters: { type: 'object', required: ['jobId', 'chapterIds'], properties: { jobId: { type: 'string' }, chapterIds: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' } } }, additionalProperties: false },
    location: 'renderer', permission: 'write', requiresConfirmation: true,
    approvalSnapshot: async (args, ctx) => {
      const id = jobId(args), ids = chapterIds(args); const { job } = await textbookJobCommand({ op: 'get', jobId: id });
      const note = ctx.getNotes().find(item => item.id === job.spec.projectNoteId);
      const published = job.stage === 'published';
      if (published) {
        if (!note) throw new Error('原教材所属项目已不存在');
        validatePublishedChapterRegeneration(job, note, ids);
      } else validateTextbookChapterRegeneration(job, ids);
      if (chapterApprovals.size >= 80) chapterApprovals.clear();
      chapterApprovals.set(canonicalAgentValue(args), { published, ...(published ? { revisionId: note!.textbook!.revisionId } : {}) });
      return { scope: await textbookApprovalSnapshot(ctx, id), draft: await textbookHash(job), chapterIds: ids };
    },
    confirmation: (args) => ({ ...textbookConfirmation(jobId(args)), title: `仅重新生成指定章节：${chapterIds(args).join('、')}`,
      description: chapterApprovals.get(canonicalAgentValue(args))?.published
        ? `原任务 ${jobId(args)}；保留已发布教材可读、私有备份旧正文，复用原教学上下文和限定来源，仅重做所选章节，不改目录及其它章节。质检通过且原版本未变时才替换。`
        : `原任务 ${jobId(args)}；仅清理并重做选定章节，先保存私有备份。蓝图、物料及其它章节保留；若重做非末章且小结改变，只更新承接受影响的后续章节。质量校验通过后才写入笔记。`,
      impacts: [...textbookConfirmation(jobId(args)).impacts, '这是用户指定的重新生成请求，不自动反复修订；沿用原请求/token 总预算，不清零已消耗用量。'] }),
    execute: (args, ctx, execution) => {
      const approval = chapterApprovals.get(canonicalAgentValue(args));
      if (!approval) throw new Error('章节重生成确认已失效，请重新查询并确认');
      return generateTextbook(ctx, jobId(args), execution?.signal, undefined, chapterIds(args), approval.revisionId);
    } });
  registerTool({ name: 'archive_textbook_job', description: '经用户确认归档或恢复尚未发布的教材任务。归档隐藏待执行任务，保留章节、草稿、来源快照与用量，可恢复；不永久删除、不改项目笔记、不调用模型。运行中先停止，不擅自停止任务。archived=false 恢复原任务，不清零预算。',
    parameters: { type: 'object', required: ['jobId', 'archived'], properties: { jobId: { type: 'string' }, archived: { type: 'boolean' } }, additionalProperties: false },
    location: 'renderer', permission: 'write', requiresConfirmation: true,
    approvalSnapshot: async (args, ctx) => {
      const { job } = await textbookJobCommand({ op: 'get', jobId: jobId(args) });
      if (!ctx.getNotes().some((note) => note.id === job.spec.projectNoteId && note.noteType === 'project')) throw new Error('教材任务所属项目已失效');
      return { jobId: job.id, projectNoteId: job.spec.projectNoteId, draft: await textbookHash(job) };
    },
    confirmation: (args) => ({ title: args.archived === true ? '归档未完成教材任务（可恢复）' : '恢复已归档教材任务',
      description: `仅处理原任务 ${jobId(args)}，不删除已生成章节，不修改项目笔记，不调用模型。`, impacts: ['草稿、原章节、来源快照及累计用量完整保留。', '归档后可恢复同一任务；恢复不重新生成、不重置预算。'] }),
    execute: async (args) => {
      if (typeof args.archived !== 'boolean') throw new Error('请明确归档还是恢复任务');
      const { job } = await textbookJobCommand({ op: 'archive', jobId: jobId(args), archived: args.archived });
      return { status: job.archivedAt ? 'archived' : 'restored', jobId: job.id, recoverable: true, chaptersRetained: job.checkpoint.chapters?.length || 0, modelCalled: false, noteChanged: false };
    } });
  registerTool({ name: 'clear_textbook_draft_cache', description: '用户明确要求删除未完成教材任务中缓存的重复章节时使用，必须确认且不可撤销。按真实 jobId 选定：all_generated 清空全部生成章节、整本草稿、旧章备份与复核缓存并归档该任务；selected_chapters 只清所选章节及其旧备份，同时移除包含这些章的整本草稿和复核缓存；backups_only 只删除重跑备份，不改当前章节和质检结果。运行中/已发布或已被项目教材引用的任务拒绝清理。原资料、来源快照、蓝图、其它任务、笔记和累计用量不动；不调用模型、不自动重生成。不得按同名标题猜测重复目标，先查询并确认保留哪份任务。',
    parameters: { type: 'object', required: ['jobId', 'scope'], properties: { jobId: { type: 'string' }, scope: { type: 'string', enum: ['all_generated', 'selected_chapters', 'backups_only'] }, chapterIds: { type: 'array', minItems: 1, maxItems: 6, items: { type: 'string' } } }, additionalProperties: false },
    location: 'renderer', permission: 'write', requiresConfirmation: true,
    approvalSnapshot: async (args, ctx) => {
      const reply = await textbookJobCommand({ op: 'preview-clear-cache', jobId: jobId(args), ...cacheSelection(args) });
      if (!reply.cacheClear || !ctx.getNotes().some((note) => note.id === reply.cacheClear!.projectNoteId && note.noteType === 'project')) throw new Error('教材缓存所属项目已失效，请先检查目标');
      if (cacheClearApprovals.size >= 128) cacheClearApprovals.delete(cacheClearApprovals.keys().next().value!);
      cacheClearApprovals.set(clearCacheKey(args), reply.cacheClear);
      // Exclude preview timestamps/byte estimates from approval identity. The
      // entire actual private job is bound by revision; never expose its text.
      const { revision, jobId: id, projectNoteId, chapterIds: chapters, backupChapterIds, scope } = reply.cacheClear;
      return { revision, jobId: id, projectNoteId, chapters, backupChapterIds, scope };
    },
    confirmation: (args) => {
      const preview = cacheClearApprovals.get(clearCacheKey(args));
      return { title: '永久清理教材草稿缓存（不可撤销）',
        description: `任务 ${jobId(args)}${preview ? ` · ${preview.projectTitle}` : ''}；${args.scope === 'all_generated' ? '清空本任务生成缓存并归档' : args.scope === 'backups_only' ? '仅删除旧章备份' : `只删除章节 ${chapterIds(args).join('、')} 的缓存及备份`}。不删除其它任务或项目笔记。`,
        impacts: [`删除当前章 ${preview?.chapterIds.length ?? '待核验'} 个、旧章备份 ${preview?.backupChapterIds.length ?? '待核验'} 个${preview?.clearsAssembledBody ? '，并移除包含旧章节的整本草稿及复核缓存' : ''}。`,
          '清理后的章节和备份不能恢复；这不同于仅归档隐藏。原资料、蓝图、网页来源快照与累计用量保留。', '不调用模型、不自动重生成。以后恢复或继续仍需独立确认，且不会清零预算。'] };
    },
    execute: async (args) => {
      const approved = cacheClearApprovals.get(clearCacheKey(args));
      if (!approved) throw new Error('教材缓存清理确认已失效，请重新检查并确认；未删除任何缓存');
      const reply = await textbookJobCommand({ op: 'clear-cache', jobId: jobId(args), ...cacheSelection(args), expectedRevision: approved.revision });
      cacheClearApprovals.delete(clearCacheKey(args));
      const result = reply.cacheClear!;
      return { status: result.hasContent ? 'cache_cleared' : 'no_generated_cache', jobId: result.jobId,
        chapterIdsCleared: result.chapterIds, backupChapterIdsCleared: result.backupChapterIds, archived: !!reply.job.archivedAt,
        freedBytes: result.freedBytes, reversible: false, sourceMaterialsRetained: true, usageRetained: true, modelCalled: false, noteChanged: false };
    } });
  registerTool({ name: 'query_textbook_job', description: '读取教材任务的进度与错误，不返回私人画像、认知原话或教材草稿。', parameters: jobSchema, location: 'renderer', permission: 'readonly',
    execute: async (args) => { const { job } = await textbookJobCommand({ op: 'get', jobId: jobId(args) });
      const summary = (await listTextbookJobs(job.spec.projectNoteId)).find((item) => item.jobId === job.id);
      return { jobId: job.id, projectNoteId: job.spec.projectNoteId, title: job.spec.projectTitle, stage: job.stage, attempt: job.attempt, archivedAt: job.archivedAt,
        completedChapters: summary?.progress?.completed ?? job.checkpoint.chapters?.length ?? 0, totalChapters: job.checkpoint.blueprint?.chapters.length || 0,
        error: (summary?.progress?.error || job.error) ? safeTextbookTaskError(summary?.progress?.error || job.error!) : undefined,
        progress: summary?.progress ? sanitizeTextbookProgressDiagnostics(summary.progress) : undefined,
        chapters: job.checkpoint.blueprint?.chapters.map(({ id, title }) => ({ id, title })),
        publishedRevision: job.checkpoint.publishedRevision ? { baseRevisionId: job.checkpoint.publishedRevision.revisionId,
          chapterIds: job.checkpoint.publishedRevision.chapterIds, oldTextbookRetained: job.stage !== 'published' } : undefined,
        materialStatus: job.checkpoint.webReads?.map((item) => ({ id: item.id, title: item.title, status: item.status,
          error: item.error ? safeTextbookWebError(item.error) : undefined })), repairTargets: summary?.progress?.repairTargets || job.checkpoint.repair?.findings.map((finding) => ({ stage: finding.stage, chapterId: finding.chapterId, section: finding.section })) }; } });
  registerTool({ name: 'open_project_textbook', description: '按稳定项目 ID 打开已有教材所在项目，不重复生成。', parameters: { type: 'object', required: ['projectNoteId'], properties: projectProperty, additionalProperties: false },
    location: 'renderer', permission: 'navigation', execute: (args, ctx) => {
      const id = String(args.projectNoteId || '');
      if (!ctx.getNotes().find((note) => note.id === id && note.noteType === 'project')?.textbook || !ctx.openTextbookProject?.(id)) throw new Error('教材不存在或当前不能打开目标项目');
      return { opened: true, projectNoteId: id }; } });
}
