import type { NoteItem, VaultSettings } from '../../../types';
import { findNotesByTitleOrAlias, resolveNoteByTitleOrAlias } from '../../noteResolver';
import { prepareAgentNoteCreation } from '../noteCreation';
import { registerTool } from '../toolRegistry';
import { ACCENT_PRESETS, normalizeAccent } from '../../ui/accentAppearance';
import { prepareKnowledgeMerge } from '../../knowledgeMaintenance';

const THEMES = ['light', 'dark', 'system'] as const;

function text(value: unknown, label: string, maxLength: number): string {
  const result = typeof value === 'string' ? value.trim() : '';
  if (!result || result.length > maxLength) throw new Error(`${label}长度应为 1 到 ${maxLength} 个字符`);
  return result;
}

function stringList(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (!Array.isArray(value) || !value.length || value.length > maxItems) {
    throw new Error(`${label}必须包含 1 到 ${maxItems} 项`);
  }
  return [...new Set(value.map((item) => text(item, `${label}中的每一项`, maxLength)))];
}

function optionalStringList(value: unknown, label: string, maxItems: number, maxLength: number): string[] {
  if (value === undefined) return [];
  return stringList(value, label, maxItems, maxLength);
}

function resolveNotes(titles: string[], notes: NoteItem[]): NoteItem[] {
  const resolved = titles.map((title) => {
    const note = resolveNoteByTitleOrAlias(title, notes);
    if (!note) throw new Error(`未找到笔记：${title}`);
    return note;
  });
  return [...new Map(resolved.map((note) => [note.id, note])).values()];
}

function descendantIds(projectId: string, notes: NoteItem[]): string[] {
  const result: string[] = [];
  const queue = [projectId];
  while (queue.length) {
    const parentId = queue.shift()!;
    for (const note of notes) {
      if (note.parentId !== parentId || result.includes(note.id)) continue;
      result.push(note.id);
      queue.push(note.id);
    }
  }
  return result;
}

function resolveDeletion(args: Record<string, unknown>, notes: NoteItem[]): NoteItem[] {
  if (args.noteIds !== undefined && args.noteTitles !== undefined) throw new Error('请只使用稳定 ID 或明确标题中的一种选择方式');
  const titles = args.noteIds === undefined ? stringList(args.noteTitles, '待删除笔记', 50, 120) : [];
  const includeProjectDescendants = args.includeProjectDescendants === true;
  if (args.includeProjectDescendants !== undefined && typeof args.includeProjectDescendants !== 'boolean') {
    throw new Error('includeProjectDescendants 必须是布尔值');
  }
  const selected = args.noteIds === undefined ? resolveNotes(titles, notes)
    : stringList(args.noteIds, '待删除笔记 ID', 50, 200).map(id => {
      const note = notes.find(item => item.id === id); if (!note) throw new Error('部分目标笔记已不存在'); return note;
    });
  const selectedIds = new Set(selected.map((note) => note.id));
  for (const project of selected.filter((note) => note.noteType === 'project')) {
    const descendants = descendantIds(project.id, notes);
    if (descendants.some((id) => !selectedIds.has(id)) && !includeProjectDescendants) {
      throw new Error(`项目“${project.title}”包含下级项目或笔记；如需连同后代删除，必须明确设置 includeProjectDescendants=true`);
    }
    if (includeProjectDescendants) descendants.forEach((id) => selectedIds.add(id));
  }
  return notes.filter((note) => selectedIds.has(note.id));
}

const createNoteInput = (args: Record<string, unknown>, notes: NoteItem[]) => prepareAgentNoteCreation(args, notes).input;

function appearancePatch(args: Record<string, unknown>): Partial<Pick<VaultSettings, 'theme' | 'accentColor'>> {
  const patch: Partial<Pick<VaultSettings, 'theme' | 'accentColor'>> = {};
  if (args.theme !== undefined) {
    if (!THEMES.includes(args.theme as typeof THEMES[number])) throw new Error('主题模式无效');
    patch.theme = args.theme as typeof THEMES[number];
  }
  if (args.accentColor !== undefined) {
    patch.accentColor = normalizeAccent(args.accentColor);
  }
  if (!Object.keys(patch).length) throw new Error('没有提供要修改的外观设置');
  return patch;
}

export function registerWorkspaceTools(): void {
  const merge = (args: Record<string, unknown>, ctx: import('../types').AgentRuntimeContext) => {
    if (!Array.isArray(args.sourceIds) || args.sourceIds.some(id => typeof id !== 'string')
      || args.targetId !== undefined && typeof args.targetId !== 'string' || args.targetTitle !== undefined && typeof args.targetTitle !== 'string') throw Error('请提供明确来源ID和目标名称或ID');
    return prepareKnowledgeMerge(ctx.getNotes(), { sourceIds: args.sourceIds as string[], targetId: args.targetId as string | undefined, targetTitle: args.targetTitle as string | undefined });
  };
  registerTool({ name: 'merge_knowledge_notes',
    description: '将用户明确指定的知识点笔记按来源标题分节合入一个新建或已有目标，原文/公式/代码保留，然后移除来源。仅处理sourceIds和目标，不搜索或改写项目正文，不调用模型，不重建全库索引；使用同一本地流程，保存后可凭operationId整体撤销。先list_notes/read_notes确定对象，不自行扩大范围。',
    parameters: { type: 'object', additionalProperties: false, required: ['sourceIds'], properties: {
      sourceIds: { type: 'array', minItems: 1, maxItems: 30, uniqueItems: true, items: { type: 'string' } },
      targetId: { type: 'string', description: '已有目标的稳定ID；与targetTitle至少提供一项' },
      targetTitle: { type: 'string', maxLength: 120, description: '新建或复用的目标知识点名称；存在同名知识点时合入已有对象' } } },
    location: 'renderer', permission: 'write', approvalSnapshot: (args, ctx) => merge(args, ctx).before,
    confirmation: (args, ctx) => { if (!ctx) throw Error('工作区尚未就绪'); const change = merge(args, ctx), target = change.after[0];
      return { title: change.label, description: '原文按来源分节迁移，移除来源知识点，可整体撤销。项目正文和原有Wiki保持原样。',
        impacts: [...change.before.map(note => `《${note.title}》 · ${note.id}`), `目标：《${target.title}》 · ${target.content.length} 字符`,
          `${change.knowledgeMerges!.length} 篇来源将移除；只更新目标及所选对象索引。`, '既有学习记录保存在私人恢复记录中，不平均或提升掌握度。'] }; },
    execute: (args, ctx) => { if (!ctx.applyWorkspaceNoteChange) throw Error('当前环境缺少知识点整理保存接口'); return ctx.applyWorkspaceNoteChange(merge(args, ctx)); } });
  registerTool({
    name: 'read_notes',
    description: '按标题或别名读取一到四篇现有笔记的正文和基本元数据，也可读取当前焦点笔记。适合先理解、汇总、改写或据此创建新笔记；不要用 search_notes 的片段替代明确要求的完整笔记读取。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        noteTitles: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' } },
        noteIds: { type: 'array', minItems: 1, maxItems: 4, items: { type: 'string' }, description: '稳定 ID，不能与 noteTitles 同时提供' },
        offset: { type: 'integer', minimum: 0, description: '正文字符偏移；长文按返回的 nextOffset 继续读取' },
        useCurrentNote: { type: 'boolean', description: '为 true 时读取当前焦点笔记' },
      },
    },
    location: 'renderer', permission: 'readonly',
    execute: (args, ctx) => {
      if (args.noteIds !== undefined && args.noteTitles !== undefined) throw new Error('请只提供 ID 或标题中的一种');
      const offset = args.offset === undefined ? 0 : args.offset;
      if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new Error('正文读取偏移无效');
      const requested = Array.isArray(args.noteTitles) ? stringList(args.noteTitles, '待读取笔记', 4, 120) : [];
      const activeNote = ctx.getActiveNote?.();
      const targets = args.noteIds !== undefined ? stringList(args.noteIds, '待读取笔记 ID', 4, 200).map(id => {
        const note = ctx.getNotes().find(item => item.id === id); if (!note) throw new Error('目标笔记不存在'); return note;
      }) : requested.length ? resolveNotes(requested, ctx.getNotes())
        : args.useCurrentNote === true && activeNote ? [activeNote] : [];
      if (!targets.length) throw new Error('没有指定可读取的笔记，也没有当前焦点笔记');
      let remaining = 30000;
      return {
        notes: targets.map((note) => {
          const start = Math.min(offset as number, note.content.length);
          const content = note.content.slice(start, start + Math.max(0, remaining));
          remaining -= content.length;
          return {
            id: note.id, title: note.title, noteType: note.noteType, projectRole: note.projectRole, parentId: note.parentId,
            tags: note.tags, aliases: note.aliases || [], content, offset: start, truncated: start + content.length < note.content.length,
            ...(start + content.length < note.content.length ? { nextOffset: start + content.length } : {}),
            updatedAt: note.updatedAt,
          };
        }),
      };
    },
  });

  registerTool({
    name: 'create_note',
    description: '创建知识笔记或项目笔记，支持 Markdown/Mermaid 正文。普通资料、图谱、时间轴等子项目须显式 projectRole=reference，可放在计划的根/中间/叶子项目下，无需任务或排期，不改变原学习叶子；真正拆分学习项目仍走计划结构草案。创建前必须确认。',
    parameters: {
      type: 'object', required: ['title', 'content', 'noteType'], additionalProperties: false,
      properties: {
        title: { type: 'string' }, content: { type: 'string' },
        noteType: { type: 'string', enum: ['knowledge', 'project'] },
        projectRole: { type: 'string', enum: ['learning', 'reference'], description: '项目用途：reference 是不参与学习计划的资料型项目；省略保持旧学习项目语义。知识笔记不填。' },
        parentProjectId: { type: 'string', description: '优先使用 list_notes 返回的父项目稳定 ID；与标题二选一' },
        parentProjectTitle: { type: 'string', description: '可选的现有父项目标题' },
        tags: { type: 'array', maxItems: 12, items: { type: 'string' } },
        sourceNoteTitles: { type: 'array', maxItems: 4, items: { type: 'string' }, description: '正文依据的来源笔记标题，仅用于确认卡披露' },
      },
    },
    location: 'renderer', permission: 'write',
    approvalSnapshot: (args, ctx) => {
      const notes = ctx.getNotes();
      const input = createNoteInput(args, notes);
      const sourceNoteTitles = optionalStringList(args.sourceNoteTitles, '来源笔记', 4, 120);
      const sources = sourceNoteTitles.length ? resolveNotes(sourceNoteTitles, notes) : [];
      const parent = input.parentProjectId
        ? notes.find(note => note.id === input.parentProjectId)
        : undefined;
      return {
        title: input.title, projectRole: input.projectRole,
        parent: parent ? { id: parent.id, title: parent.title, updatedAt: parent.updatedAt } : null,
        sources: sources.map((note) => ({ id: note.id, title: note.title, updatedAt: note.updatedAt })),
      };
    },
    confirmation: (args, ctx) => {
      const input = createNoteInput(args, ctx?.getNotes() || []);
      const sources = optionalStringList(args.sourceNoteTitles, '来源笔记', 4, 120);
      return {
        title: '确认创建笔记',
        description: `将创建${input.noteType === 'project' ? input.projectRole === 'reference' ? '资料型项目' : '学习项目' : '知识'}笔记“${input.title}”，正文约 ${input.content.length} 字。`,
        impacts: [
          ...(input.parentProjectId ? [`父项目：${ctx?.getNotes().find(note => note.id === input.parentProjectId)?.title} · ${input.parentProjectId}`] : []),
          ...(input.projectRole === 'reference' ? ['仅组织资料正文，不新增学习任务、不改变原学习叶子、排期或学习负荷。'] : []),
          ...(sources.length ? [`内容依据：${sources.join('、')}`] : []),
          '确认前不会写入或打开新笔记。',
        ],
      };
    },
    execute: (args, ctx) => {
      if (!ctx.createNote) throw new Error('当前环境未开放通用笔记创建能力');
      return ctx.createNote(createNoteInput(args, ctx.getNotes()));
    },
  });

  registerTool({
    name: 'delete_notes',
    description: '按标题或别名批量移除现有笔记，桌面端先持久化可恢复记录并返回 operationId。项目含后代时须明确连同移除；执行前确认精确对象。恢复使用 list_agent_operations 和 undo_agent_operation。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        noteTitles: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' } },
        noteIds: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string' }, description: '批量操作优先使用 list_notes 返回的稳定 ID；与 noteTitles 二选一' },
        includeProjectDescendants: { type: 'boolean', description: '仅在用户明确要求删除整个项目树时设为 true' },
      },
    },
    location: 'renderer', permission: 'write',
    approvalSnapshot: (args, ctx) => resolveDeletion(args, ctx.getNotes()),
    confirmation: (args, ctx) => {
      const targets = resolveDeletion(args, ctx?.getNotes() || []);
      return {
        title: targets.length > 1 ? `确认删除 ${targets.length} 篇笔记` : '确认删除笔记',
        description: `将移出当前笔记库并保留恢复记录：${targets.slice(0, 8).map((note) => `“${note.title}”`).join('、')}${targets.length > 8 ? ` 等 ${targets.length} 篇` : ''}。`,
        impacts: [
          ...targets.map(note => `《${note.title}》 · ${note.id}`),
          `${targets.filter((note) => note.noteType === 'project').length} 个项目，${targets.filter((note) => note.noteType === 'knowledge').length} 篇知识笔记。`,
          '先保存完整笔记及个人状态恢复记录，再移除笔记和检索索引；可凭 operationId 恢复。',
        ],
      };
    },
    execute: (args, ctx) => {
      if (!ctx.deleteNotes) throw new Error('当前环境未开放批量删除能力');
      const targets = resolveDeletion(args, ctx.getNotes());
      return ctx.deleteNotes({ noteIds: targets.map((note) => note.id), includeProjectDescendants: args.includeProjectDescendants === true });
    },
  });

  registerTool({
    name: 'rename_project',
    description: '修改一个现有项目的名称，保留原名称为别名以维持旧 wiki 链接；执行前必须由用户确认。',
    parameters: {
      type: 'object', required: ['projectTitle', 'newTitle'], additionalProperties: false,
      properties: { projectTitle: { type: 'string' }, newTitle: { type: 'string' } },
    },
    location: 'renderer', permission: 'write',
    approvalSnapshot: (args, ctx) => {
      const project = resolveNoteByTitleOrAlias(text(args.projectTitle, '项目名称', 120), ctx.getNotes());
      return project ? { id: project.id, title: project.title, updatedAt: project.updatedAt } : null;
    },
    confirmation: (args, ctx) => {
      const project = resolveNoteByTitleOrAlias(text(args.projectTitle, '项目名称', 120), ctx?.getNotes() || []);
      if (!project || project.noteType !== 'project') throw new Error(`未找到项目：${String(args.projectTitle || '')}`);
      const nextTitle = text(args.newTitle, '新项目名称', 120);
      if (findNotesByTitleOrAlias(nextTitle, (ctx?.getNotes() || []).filter(note => note.id !== project.id)).length) throw new Error(`新名称已被其他笔记使用：${nextTitle}`);
      return {
        title: '确认修改项目名称',
        description: `将项目“${project.title}”更名为“${nextTitle}”。`,
        impacts: ['项目 ID、层级和任务保持不变。', `原名称“${project.title}”会保留为别名，以兼容旧链接。`],
      };
    },
    execute: (args, ctx) => {
      if (!ctx.renameProject) throw new Error('当前环境未开放项目改名能力');
      const project = resolveNoteByTitleOrAlias(text(args.projectTitle, '项目名称', 120), ctx.getNotes());
      if (!project || project.noteType !== 'project') throw new Error(`未找到项目：${String(args.projectTitle || '')}`);
      return ctx.renameProject({ projectId: project.id, title: text(args.newTitle, '新项目名称', 120) });
    },
  });

  registerTool({
    name: 'update_appearance',
    description: '修改软件明暗主题或强调色。支持浅色、深色、跟随系统；强调色支持预设和 #RRGGBB 自定义颜色，明暗模式自动适配可读性。确认后持久保存。',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        theme: { type: 'string', enum: [...THEMES] },
        accentColor: { type: 'string', description: `支持 ${ACCENT_PRESETS.join('、')} 预设或 #RRGGBB 自定义颜色；明暗模式自动调整可读性。` },
      },
    },
    location: 'renderer', permission: 'write',
    approvalSnapshot: (_args, ctx) => ctx.getAppearance?.() || null,
    confirmation: (args, ctx) => {
      const patch = appearancePatch(args);
      const current = ctx?.getAppearance?.();
      return {
        title: '确认调整软件外观',
        description: '确认后立即应用并保存到本机设置。',
        impacts: [
          ...(patch.theme ? [`主题模式：${current?.theme || '未知'} → ${patch.theme}`] : []),
          ...(patch.accentColor ? [`主题色：${current?.accentColor || 'emerald'} → ${patch.accentColor}`] : []),
        ],
      };
    },
    execute: (args, ctx) => {
      if (!ctx.updateAppearance) throw new Error('当前环境未开放外观修改能力');
      return ctx.updateAppearance(appearancePatch(args));
    },
  });
}
