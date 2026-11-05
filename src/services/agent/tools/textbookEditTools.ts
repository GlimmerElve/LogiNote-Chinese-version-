import type { AgentRuntimeContext } from '../types';
import { registerTool } from '../toolRegistry';
import { listTextbookJobs } from '../../textbook/jobClient';
import { publishedTextbook, readPublishedTextbook, preparePublishedTextbookEdit, type TextbookEditInput } from '../../textbook/editing';
import { readSourceEvidence } from '../../textbook/sourceEvidence';
import { safeTextbookTaskError } from '../../textbook/webErrors';

const properties = { projectNoteId: { type: 'string', description: '目标项目稳定ID，不按同名标题猜测' } };
function target(args: Record<string, unknown>, ctx: AgentRuntimeContext) { return args.projectNoteId ?? ctx.getActiveNote?.()?.id; }
function prepare(args: Record<string, unknown>, ctx: AgentRuntimeContext) {
  if (Object.keys(args).some(key => !['projectNoteId', 'expectedRevisionId', 'replacements', 'appendText'].includes(key))) throw new Error('教材编辑包含未授权参数');
  return preparePublishedTextbookEdit(ctx.getNotes(), args as unknown as TextbookEditInput);
}
export function registerTextbookEditTools(deps: { listJobs: typeof listTextbookJobs; preflight: (markdown: string) => Promise<void>; readEvidence?: typeof readSourceEvidence } = {
  listJobs: listTextbookJobs,
  preflight: async (markdown: string) => { const { assertMdxNoteImportable } = await import('../../../components/mdxNotePreflight'); assertMdxNoteImportable(markdown); },
}): void {
  const ready = async (projectNoteId: string, ctx: AgentRuntimeContext) => {
    const { manifest } = publishedTextbook(ctx.getNotes(), projectNoteId);
    const jobs = await deps.listJobs(projectNoteId);
    if (jobs.some(job => job.jobId === manifest.generationJobId && job.stage !== 'published')) throw new Error('原教材任务的写入回执尚未完成，请先继续原任务完成核验，再局部编辑');
  };
  registerTool({ name: 'read_project_textbook', description: '分页读取已经写入项目笔记的教材正文、目录偏移、revisionId和授权来源/素材编号。传 sourceId 时只读取该教材已引用的版本绑定原文（cursor续读）；本地网页快照离线复用，不新联网。知识点/资料已变化则说明无法核对，不用搜索摘要或私人任务替代。不返回私人复盘或任务草稿。修改教材先读取本工具，不凭记忆改写。',
    parameters: { type: 'object', additionalProperties: false, properties: { ...properties, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 16000 }, sourceId: { type: 'string' }, cursor: { type: 'integer', minimum: 0 } } },
    location: 'renderer', permission: 'readonly', execute: async (args, ctx) => {
      if (args.sourceId === undefined) {
        if (args.cursor !== undefined) throw new Error('教材正文使用 offset，原文来源续读才使用 cursor');
        return readPublishedTextbook(ctx.getNotes(), target(args, ctx), args.offset, args.limit);
      }
      if (typeof args.sourceId !== 'string' || args.offset !== undefined || args.limit !== undefined
        || args.cursor !== undefined && (!Number.isSafeInteger(args.cursor) || (args.cursor as number) < 0)) throw new Error('来源读取参数无效');
      const { note, manifest } = publishedTextbook(ctx.getNotes(), target(args, ctx));
      const source = manifest.sources?.find(item => item.sourceId === args.sourceId);
      if (!source) throw new Error('该来源不在目标教材的已发布引用范围内');
      const result = await (deps.readEvidence || readSourceEvidence)(source, ctx.getNotes(), args.cursor as number | undefined, note.id)
        .catch(error => { throw new Error(safeTextbookTaskError(error instanceof Error ? error.message : String(error))); });
      if (publishedTextbook(ctx.getNotes(), note.id).manifest.revisionId !== manifest.revisionId) throw new Error('读取期间教材版本变化，请重新核对');
      return { projectNoteId: note.id, revisionId: manifest.revisionId, sourceId: source.sourceId, title: source.title, version: source.version,
        text: result.text.slice(0, 16000), ...(result.text.length > 16000 ? { truncated: true, notice: '返回原文前16000字符；更长内容请在来源阅读器核对，不冒充已读全文' } : { nextCursor: result.nextCursor }) };
    } });
  registerTool({ name: 'edit_project_textbook', description: '经独立确认后局部修改已写入教材的文字、公式、图示完整围栏，或追加三级标题的补充。不重生成整本、不调用教材模型、不修改任务草稿/预算。先read_project_textbook，传其项目ID和revisionId；oldText须在教材正文唯一且替换范围不重叠。保留一/二级目录、来源清单、图片ID、教材边界及外部笔记/复盘；引用只能使用已有来源，不能捏造来源或私人证据。保存后返回operationId可恢复，不宣称重新通过整本语义审核。',
    parameters: { type: 'object', required: ['projectNoteId', 'expectedRevisionId'], additionalProperties: false, properties: {
      ...properties, expectedRevisionId: { type: 'string' }, appendText: { type: 'string', maxLength: 16000 },
      replacements: { type: 'array', minItems: 1, maxItems: 10, items: { type: 'object', required: ['oldText', 'newText'], additionalProperties: false,
        properties: { oldText: { type: 'string', minLength: 1, maxLength: 16000 }, newText: { type: 'string', maxLength: 16000 } } } },
    } }, location: 'renderer', permission: 'write', requiresConfirmation: true,
    approvalSnapshot: async (args, ctx) => {
      const change = prepare(args, ctx); await ready(change.before[0].id, ctx); await deps.preflight(change.after[0].content);
      return { before: change.before };
    },
    confirmation: (args, ctx) => {
      if (!ctx) throw new Error('工作区不可用'); const change = prepare(args, ctx);
      return { title: change.label, description: '只替换已定位片段或在教材末尾补充，保留其它章节、来源、任务与私人复盘；保存恢复记录。',
        impacts: [
          ...(Array.isArray(args.replacements) ? args.replacements.map((item: { oldText: string; newText: string }) => `替换“${item.oldText.slice(0, 240)}” → “${item.newText.slice(0, 240)}”`) : []),
          ...(typeof args.appendText === 'string' ? [`教材末尾补充：${args.appendText.slice(0, 400)}`] : []),
          '建立新阅读版本；历史复盘版本保留。只做格式/来源范围检查，不重跑生成或整本语义审核，不能据此保证新事实和公式正确。',
        ] };
    },
    execute: async (args, ctx, execution) => {
      if (!ctx.applyWorkspaceNoteChange) throw new Error('教材修改保存接口不可用');
      const change = prepare(args, ctx); execution?.signal?.throwIfAborted();
      await ready(change.before[0].id, ctx); await deps.preflight(change.after[0].content); execution?.signal?.throwIfAborted();
      const result = await ctx.applyWorkspaceNoteChange(change);
      if (!result.saved || !result.operationId) throw new Error('教材修改尚未确认保存，不能报告完成；请检查保存状态');
      return { ...result, status: 'textbook_edited', projectNoteId: change.after[0].id, revisionId: change.after[0].textbook!.revisionId,
        wholeBookRegenerated: false, semanticReviewPerformed: false };
    },
  });
}
