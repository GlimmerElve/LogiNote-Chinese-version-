import type { NoteItem, DueDateItem } from '../types';
import { assertOptionalBackupNoteData } from './noteJsonBackupValidation';

export const MAX_NOTE_BACKUP_BYTES = 50 * 1024 * 1024;
export type NoteBackupRestoreMode = 'missing' | 'replace';
export interface NoteBackupRestoreResult { added: number; replaced: number; skipped: number }
export interface NoteBackupRestoreRequest {
  notes: NoteItem[];
  mode: NoteBackupRestoreMode;
  /** The preview's baseline, checked again before replacing any live note. */
  expected: NoteItem[];
}
const record = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 240
  && value.trim() === value && !/[<>:"/\\|?*\u0000-\u001f]/u.test(value) && !/[. ]$/u.test(value)
  && !/^(?:\.{1,2}|__proto__|constructor|prototype|con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value);
function strings(value: unknown, name: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error(`${name}必须是文字数组`);
  return value;
}
function date(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
function validateNote(value: unknown, index: number): NoteItem {
  const fail = (message: string): never => { throw new Error(`第 ${index + 1} 篇笔记：${message}`); };
  if (!record(value)) fail('格式不正确');
  const note = value as Record<string, any>;
  if (!identifier(note.id)) fail('编号无效，不能用于本地笔记文件');
  if (typeof note.title !== 'string' || typeof note.content !== 'string') fail('缺少标题或正文');
  if (!['project', 'knowledge'].includes(note.noteType)) fail('笔记类型无效');
  if (typeof note.createdAt !== 'string' || !Number.isFinite(Date.parse(note.createdAt))
    || typeof note.updatedAt !== 'string' || !Number.isFinite(Date.parse(note.updatedAt))) fail('创建或修改时间无效');
  if (note.parentId !== undefined && !identifier(note.parentId)) fail('父项目编号无效');
  for (const key of ['textbook', 'planMeta', 'dsrState', 'textbookReadingState', 'learningContentMigration']) {
    if (note[key] !== undefined && !record(note[key])) fail(`${key}格式不正确`);
  }
  for (const key of ['resources', 'referenceSources', 'argumentDocs', 'learningReviewRecords', 'questions']) {
    if (note[key] !== undefined && (!Array.isArray(note[key]) || note[key].some(item => !record(item)))) fail(`${key}格式不正确`);
  }
  if (note.textbook && (note.textbook.schemaVersion !== 1 || ['textbookId', 'regionId', 'revisionId'].some(key => typeof note.textbook[key] !== 'string')
    || ['chapters', 'sources', 'assets'].some(key => note.textbook[key] !== undefined && !Array.isArray(note.textbook[key])))) fail('教材清单格式不正确');
  if (note.argumentDocs?.some(doc => typeof doc.doc_id !== 'string' || !Array.isArray(doc.nodes) || !Array.isArray(doc.edges))) fail('论证图格式不正确');
  for (const key of ['pinned', 'isFavorite']) if (note[key] !== undefined && typeof note[key] !== 'boolean') fail(`${key}格式不正确`);
  if (!Array.isArray(note.dueDates)) fail('计划任务格式不正确');
  try { assertOptionalBackupNoteData(note); }
  catch (error) { fail(error instanceof Error ? error.message : '附带数据格式不正确'); }
  const dueDates = note.dueDates.map((task: unknown): DueDateItem => {
    if (!record(task) || typeof task.id !== 'string' || typeof task.taskText !== 'string' || !date(task.dueDate)
      || typeof task.completed !== 'boolean' || !['high', 'medium', 'low'].includes(task.priority)) fail('计划任务字段无效');
    return { ...(task as DueDateItem), noteId: note.id, noteTitle: note.title };
  });
  return { ...note, tags: strings(note.tags, '标签'), links: strings(note.links, '链接'), backlinks: strings(note.backlinks, '反向链接'),
    ...(note.aliases === undefined ? {} : { aliases: strings(note.aliases, '别名') }),
    ...(note.generatedContentBlocks === undefined ? {} : { generatedContentBlocks: strings(note.generatedContentBlocks, '生成内容标记') }), dueDates } as NoteItem;
}
/** Reads the exact note-array format exported by both old and current clients. */
export function parseNoteJsonBackup(text: string): NoteItem[] {
  if (new TextEncoder().encode(text).byteLength > MAX_NOTE_BACKUP_BYTES) throw new Error('笔记备份超过 50 MB，请拆分后恢复');
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/u, ''), (key, item) => {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('备份包含不支持的对象字段');
      return item;
    });
  } catch (error) { throw new Error(`无法读取 JSON 笔记备份：${error instanceof Error ? error.message : '文件格式不正确'}`); }
  if (!Array.isArray(value)) throw new Error('请选择“导出全部笔记 (JSON)”生成的笔记数组；数据目录的 metadata.json 不能单独恢复正文');
  if (!value.length || value.length > 10_000) throw new Error('备份需包含 1 至 10,000 篇笔记');
  const notes = value.map(validateNote), ids = new Set<string>();
  for (const note of notes) {
    const key = note.id.toLowerCase();
    if (ids.has(key)) throw new Error('备份包含重复编号（含大小写冲突），尚未写入任何笔记');
    ids.add(key);
  }
  return notes;
}
export function noteBackupPreview(current: NoteItem[], incoming: NoteItem[]): { added: number; existing: number } {
  const ids = new Set(current.map(note => note.id));
  const existing = incoming.filter(note => ids.has(note.id)).length;
  return { added: incoming.length - existing, existing };
}
const revision = ({ links: _links, backlinks: _backlinks, ...note }: NoteItem) => JSON.stringify(note);
/** Pure preparation: never deletes current notes, and never replaces without the
 * explicit mode plus the preview baseline. The existing write queue commits it. */
export function prepareNoteBackupRestore(current: NoteItem[], request: NoteBackupRestoreRequest): NoteBackupRestoreResult & { notes: NoteItem[] } {
  if (!['missing', 'replace'].includes(request.mode)) throw new Error('请选择恢复方式');
  const byId = new Map(current.map(note => [note.id, note]));
  const portableIds = new Map(current.map(note => [note.id.toLowerCase(), note.id]));
  const expected = new Map(request.expected.map(note => [note.id, note]));
  const changes = new Map<string, NoteItem>();
  let added = 0, replaced = 0, skipped = 0;
  for (const note of request.notes) {
    if (portableIds.has(note.id.toLowerCase()) && portableIds.get(note.id.toLowerCase()) !== note.id) throw new Error('备份编号与现有笔记存在大小写冲突，未覆盖本地笔记');
    const existing = byId.get(note.id);
    if (existing && request.mode === 'missing') { skipped++; continue; }
    if (request.mode === 'replace') {
      const before = expected.get(note.id);
      if (Boolean(existing) !== Boolean(before) || existing && before && revision(existing) !== revision(before)) throw new Error('预览后有笔记发生变化，请取消后重新选择备份，未覆盖最新内容');
    }
    changes.set(note.id, note);
    if (existing) replaced++; else added++;
  }
  const notes = [...current.map(note => changes.get(note.id) || note), ...request.notes.filter(note => changes.has(note.id) && !byId.has(note.id))];
  const parents = new Map(notes.map(note => [note.id, note.parentId]));
  for (const id of changes.keys()) {
    const seen = new Set<string>(); let cursor: string | undefined = id;
    while (cursor && parents.has(cursor)) {
      if (seen.has(cursor)) throw new Error('备份恢复会形成循环父项目，尚未写入任何笔记');
      seen.add(cursor); cursor = parents.get(cursor);
    }
  }
  return { notes, added, replaced, skipped };
}
