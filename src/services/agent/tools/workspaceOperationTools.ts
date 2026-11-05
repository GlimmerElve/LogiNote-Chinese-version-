import type { AgentRuntimeContext } from '../types';
import { registerTool } from '../toolRegistry';
import { prepareNoteEdit, prepareNoteMove } from '../workspaceOperations';
import { agentOperationStore, prepareOperationUndo } from '../operationStore';

function id(value: unknown): string { if (typeof value !== 'string' || !value.trim() || value.length > 200) throw new Error('请使用查询结果中的稳定对象 ID'); return value; }
const undoPreviews = new Map<string, { label: string; titles: string[] }>();
function edit(args: Record<string, unknown>, ctx: AgentRuntimeContext) {
  for (const name of ['pinned', 'isFavorite']) if (args[name] !== undefined && typeof args[name] !== 'boolean') throw new Error('置顶与收藏必须是布尔值');
  for (const name of ['title', 'appendText']) if (args[name] !== undefined && typeof args[name] !== 'string') throw new Error('标题与追加正文必须是文本');
  if (args.replacements !== undefined && !Array.isArray(args.replacements)) throw new Error('replacements 必须是数组');
  if (args.tags !== undefined && !Array.isArray(args.tags)) throw new Error('tags 必须是数组');
  if (args.aliases !== undefined && !Array.isArray(args.aliases)) throw new Error('aliases 必须是数组');
  return prepareNoteEdit(ctx.getNotes(), { ...args, noteId: id(args.noteId) } as Parameters<typeof prepareNoteEdit>[1]);
}
function move(args: Record<string, unknown>, ctx: AgentRuntimeContext) {
  if (!Array.isArray(args.noteIds)) throw new Error('请选择待移动笔记');
  return prepareNoteMove(ctx.getNotes(), args.noteIds.map(id), args.parentProjectId === null ? null : id(args.parentProjectId));
}
export function registerWorkspaceOperationTools() {
  registerTool({ name: 'list_notes', description: '分页列出真实笔记和项目的稳定 ID、标题、父项目、标签、创建/修改时间。用于批量选择、检查重复标题、项目层级管理；无正文、无模型调用。未指定过滤条件时列出全部。',
    parameters: { type: 'object', additionalProperties: false, properties: { parentProjectId: { type: ['string', 'null'] }, noteType: { type: 'string', enum: ['project', 'knowledge'] }, titleContains: { type: 'string' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 100 } } },
    location: 'renderer', permission: 'readonly', execute: (args, ctx) => {
      const offset = args.offset === undefined ? 0 : args.offset, limit = args.limit === undefined ? 50 : args.limit;
      if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100) throw new Error('分页参数无效');
      if (args.noteType !== undefined && !['project', 'knowledge'].includes(String(args.noteType))) throw new Error('笔记类型无效');
      if (args.titleContains !== undefined && typeof args.titleContains !== 'string') throw new Error('标题筛选无效');
      if (args.parentProjectId !== undefined && args.parentProjectId !== null && !ctx.getNotes().some(note => note.id === args.parentProjectId && note.noteType === 'project')) throw new Error('父项目不存在');
      const matches = ctx.getNotes().filter(note => (args.noteType === undefined || note.noteType === args.noteType)
        && (args.parentProjectId === undefined || (note.parentId || null) === args.parentProjectId)
        && (typeof args.titleContains !== 'string' || note.title.toLocaleLowerCase().includes(args.titleContains.toLocaleLowerCase())));
      return { total: matches.length, notes: matches.slice(offset as number, (offset as number) + (limit as number)).map(note => ({ id: note.id, title: note.title, noteType: note.noteType, projectRole: note.noteType === 'project' ? note.projectRole || 'learning' : undefined, parentId: note.parentId, tags: note.tags, aliases: note.aliases, pinned: note.pinned === true, isFavorite: note.isFavorite === true, hasTextbook: Boolean(note.textbook), createdAt: note.createdAt, updatedAt: note.updatedAt })),
        ...((offset as number) + (limit as number) < matches.length ? { nextOffset: (offset as number) + (limit as number) } : {}) };
    },
  });
  registerTool({ name: 'update_note', description: '按稳定笔记 ID 精确修改正文片段、追加内容、改标题、标签、别名、置顶或收藏。aliases 是完整替换后的别名列表，空数组清空；先读取现有别名再增删，不覆盖未要求移除的名称。先 read_notes 读取正文；oldText 必须在当前正文唯一出现。保留受管教材、复盘和论证块，改名保留旧名为别名。确认后保存对象级恢复记录，返回 operationId。',
    parameters: { type: 'object', required: ['noteId'], additionalProperties: false, properties: {
      noteId: { type: 'string' }, title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' }, maxItems: 30 }, pinned: { type: 'boolean' }, isFavorite: { type: 'boolean' }, appendText: { type: 'string' },
      aliases: { type: 'array', maxItems: 30, items: { type: 'string', minLength: 1, maxLength: 120 }, description: '完整的新别名列表；[] 清空。不得与其它笔记标题或别名冲突；同时改名仍自动保留旧标题。' },
      replacements: { type: 'array', maxItems: 20, items: { type: 'object', required: ['oldText', 'newText'], additionalProperties: false, properties: { oldText: { type: 'string' }, newText: { type: 'string' } } } },
    } }, location: 'renderer', permission: 'write',
    approvalSnapshot: (args, ctx) => edit(args, ctx).before,
    confirmation: (args, ctx) => {
      if (!ctx) throw new Error('工作区不可用'); const change = edit(args, ctx);
      return { title: change.label, description: '只修改指定字段和精确正文片段，保存后可通过操作记录恢复。', impacts: [
        ...(args.title !== undefined ? [`标题：${change.before[0].title} → ${change.after[0].title}`] : []),
        ...(Array.isArray(args.replacements) ? args.replacements.map((item: { oldText: string; newText: string }) => `替换“${item.oldText.slice(0, 240)}” → “${item.newText.slice(0, 240)}”`) : []),
        ...(typeof args.appendText === 'string' ? [`追加：${args.appendText.slice(0, 400)}`] : []),
        ...(args.tags !== undefined ? [`标签：${change.after[0].tags.join('、')}`] : []),
        ...(args.aliases !== undefined ? [`别名：${change.before[0].aliases?.join('、') || '无'} → ${change.after[0].aliases?.join('、') || '无'}`, '移除别名可能使仅使用该名称的旧 Wiki 链接不再指向本笔记；正文链接不会批量改写。'] : []),
        ...(args.pinned !== undefined ? [`置顶：${args.pinned ? '是' : '否'}`] : []),
        ...(args.isFavorite !== undefined ? [`收藏：${args.isFavorite ? '是' : '否'}`] : []),
      ] };
    },
    execute: (args, ctx) => { if (!ctx.applyWorkspaceNoteChange) throw new Error('笔记修改接口不可用'); return ctx.applyWorkspaceNoteChange(edit(args, ctx)); },
  });
  registerTool({ name: 'move_notes', description: '批量将稳定 ID 的笔记移到指定父项目，parentProjectId=null 表示根目录。确认时绑定父项目和所有笔记，防止循环。纯资料型项目可在计划内移动，不改变学习叶子及排期；包含学习项目的层级变更仍须走 plans 结构草案。移动可能改变继承资料的来源，确认后可恢复。',
    parameters: { type: 'object', required: ['noteIds', 'parentProjectId'], additionalProperties: false, properties: { noteIds: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } }, parentProjectId: { type: ['string', 'null'] } } },
    location: 'renderer', permission: 'write', approvalSnapshot: (args, ctx) => { const change = move(args, ctx); return { notes: change.before, parents: change.dependencies }; },
    confirmation: (args, ctx) => { if (!ctx) throw new Error('工作区不可用'); const change = move(args, ctx); return { title: change.label, description: '正文和稳定 ID 保留；修改父项目归属并保存恢复记录。', impacts: [...change.before.map(note => `《${note.title}》`), '所属祖先变化可能改变继承的本地资料范围，不复制资料、不改变学习排期。'] }; },
    execute: (args, ctx) => { if (!ctx.applyWorkspaceNoteChange) throw new Error('笔记移动接口不可用'); return ctx.applyWorkspaceNoteChange(move(args, ctx)); },
  });
  registerTool({ name: 'list_agent_operations', description: '读取由 Agent 笔记增删改及移动产生的本地操作记录摘要，用于找回已移除笔记、撤销改名或正文修改。只返回 ID、标题与状态，不返回私人快照正文。',
    parameters: { type: 'object', additionalProperties: false, properties: { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } } }, location: 'renderer', permission: 'readonly', execute: async args => {
      const offset = args.offset === undefined ? 0 : args.offset, limit = args.limit === undefined ? 20 : args.limit;
      if (!Number.isSafeInteger(offset) || (offset as number) < 0 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 50) throw new Error('分页参数无效');
      const records = (await agentOperationStore.list()).reverse();
      return { total: records.length, operations: records.slice(offset as number, (offset as number) + (limit as number)),
        ...((offset as number) + (limit as number) < records.length ? { nextOffset: (offset as number) + (limit as number) } : {}) };
    },
  });
  registerTool({ name: 'undo_agent_operation', description: '按 operationId 恢复一次笔记操作，仅作用于该次操作涉及的对象。当前对象与保存后的版本不一致、标题冲突、父项目不存在时拒绝覆盖。需确认；不改变其他笔记或学习记录。',
    parameters: { type: 'object', required: ['operationId'], additionalProperties: false, properties: { operationId: { type: 'string' } } }, location: 'renderer', permission: 'write',
    approvalSnapshot: async (args, ctx) => {
      const record = await agentOperationStore.get(id(args.operationId)); const change = prepareOperationUndo(ctx.getNotes(), record);
      if (undoPreviews.size > 100) undoPreviews.clear();
      undoPreviews.set(record.id, { label: record.change.label, titles: [...new Set([...change.before, ...change.after].map(note => `《${note.title}》 · ${note.id}`))] });
      return { record, current: ctx.getNotes().filter(note => [...change.before, ...change.after].some(item => item.id === note.id)) };
    },
    confirmation: args => { const preview = undoPreviews.get(id(args.operationId)); if (!preview) throw new Error('恢复预览尚未校验'); return { title: `恢复：${preview.label}`, description: '只恢复以下笔记；存在后续编辑时停止，不覆盖新内容。', impacts: preview.titles }; },
    execute: async (args, ctx) => { if (!ctx.undoWorkspaceOperation) throw new Error('操作恢复接口不可用'); return ctx.undoWorkspaceOperation(id(args.operationId)); },
  });
}
