import type { NoteItem } from '../types';

const sourceFields = ['title', 'content', 'tags', 'aliases', 'noteType', 'projectRole', 'parentId', 'resources', 'referenceSources'] as const;
const equal = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
const sameSource = (a: NoteItem, b: NoteItem) => sourceFields.every(field => equal(a[field], b[field]));
const nameKey = (value: string) => value.trim().toLowerCase();

export interface NoteSaveRecoveryResult {
  notes: NoteItem[];
  copiedIds: string[];
  retainedNewIds: string[];
  count: number;
  message: string;
}

/** Prepare, but do not write, a recovery merge. Saved notes remain authoritative;
 * genuinely unsaved source edits become standalone reference-only drafts. */
export function prepareNoteSaveRecovery(drafts: readonly NoteItem[], saved: readonly NoteItem[],
  baseline?: readonly NoteItem[], now = new Date().toISOString()): NoteSaveRecoveryResult {
  const previous = baseline && new Map(baseline.map(note => [note.id, note]));
  const disk = new Map(saved.map(note => [note.id, note]));
  const ids = new Set(saved.map(note => note.id.toLowerCase()));
  const titles = new Set(saved.flatMap(note => [note.title, ...(note.aliases || [])]).map(nameKey));
  const notes = [...saved], copiedIds: string[] = [], retainedNewIds: string[] = [];
  let serial = 0;
  const uniqueId = () => {
    let value: string;
    do { value = `note-recovered-${now.replace(/[^0-9]/gu, '')}-${++serial}`; } while (ids.has(value.toLowerCase()));
    ids.add(value.toLowerCase()); return value;
  };
  const uniqueTitle = (title: string, copy: boolean) => {
    const base = title.trim() || '未命名笔记';
    let value = copy ? `${base}（未保存草稿）` : base;
    if (!titles.has(nameKey(value))) { titles.add(nameKey(value)); return value; }
    let suffix = 2;
    do { value = `${base}（未保存草稿 ${suffix++}）`; } while (titles.has(nameKey(value)));
    titles.add(nameKey(value)); return value;
  };
  const contentOnly = (draft: NoteItem, id: string, title: string): NoteItem => {
    // These tags point to historical records/managed regions belonging to the
    // original note. Preserve their text without activating those old bindings.
    let content = draft.content;
    if (draft.aliases?.length) content += `\n\n> 原笔记别名（仅供恢复）：${draft.aliases.join('、')}`;
    if (draft.parentId) content += `\n\n> 原项目 ID（未建立绑定）：${draft.parentId}`;
    content = content.replace(/<(\/?(?:TextbookBoundary|LearningReviewBlock|ArgumentBlock)\b)/gu, '&lt;$1');
    return { id, title, content, noteType: 'project', projectRole: 'reference',
      tags: [...new Set([...(draft.tags || []), '未保存草稿'])], links: [], backlinks: [], dueDates: [],
      ...(draft.resources ? { resources: draft.resources.map(resource => ({ ...resource })) } : {}),
      ...(draft.referenceSources ? { referenceSources: draft.referenceSources.map(source => ({ ...source })) } : {}),
      createdAt: now, updatedAt: now };
  };
  for (const draft of drafts) {
    const current = disk.get(draft.id), before = previous?.get(draft.id);
    if (current && sameSource(draft, current)) continue; // Includes lost-success replies.
    const locallyChanged = previous ? !before || !sameSource(draft, before) : true;
    if (!locallyChanged) continue; // A newer saved version is not a local draft.
    if (!current && !before && !ids.has(draft.id.toLowerCase())) {
      ids.add(draft.id.toLowerCase());
      notes.push(contentOnly(draft, draft.id, uniqueTitle(draft.title, false)));
      retainedNewIds.push(draft.id);
    } else {
      const id = uniqueId(); notes.push(contentOnly(draft, id, uniqueTitle(draft.title, true))); copiedIds.push(id);
    }
  }
  const count = copiedIds.length + retainedNewIds.length;
  return { notes, copiedIds, retainedNewIds, count,
    message: count ? `已重新读取已保存的笔记，并保留 ${count} 篇未保存内容为独立资料草稿；原学习记录与计划绑定未复制。`
      : '已重新读取已保存的笔记；没有需要另存的源内容草稿。' };
}
