import type { NoteItem } from '../../types';
import { recalculateBacklinks } from '../storage';
import { personalNotePatches } from '../personalNoteState';

export interface PlanWriter {
  readNotes: () => NoteItem[];
  saveNotes: (notes: NoteItem[]) => Promise<unknown>;
  applyNotes: (notes: NoteItem[]) => void;
  beforeSave?: () => void;
  trySavePersonal?: (before: NoteItem[], next: NoteItem[]) => Promise<boolean>;
}

function revision(note: NoteItem): string {
  // Backlinks are derived from other notes, not an edit to this plan.
  const { links: _links, backlinks: _backlinks, ...data } = note;
  return JSON.stringify(data);
}

function scopeRevision(notes: NoteItem[], rootId?: string): string {
  if (!rootId) return '';
  const included = new Set([rootId]);
  let found = true;
  while (found) {
    found = false;
    for (const note of notes) {
      if (note.noteType === 'project' && note.parentId && included.has(note.parentId) && !included.has(note.id)) {
        included.add(note.id); found = true;
      }
    }
  }
  return JSON.stringify(notes.filter((note) => included.has(note.id))
    .map((note) => [note.id, revision(note)]).sort((a, b) => a[0].localeCompare(b[0])));
}

/** A confirmed plan becomes visible only after saving; unrelated live edits survive. */
export async function commitPlanWrite<T extends { notes: NoteItem[] }>(
  writer: PlanWriter,
  prepare: (notes: NoteItem[]) => T,
  rootId?: string,
): Promise<T> {
  const base = writer.readNotes();
  const mutation = prepare(base);
  const original = new Map(base.map((note) => [note.id, note]));
  const candidate = new Map(mutation.notes.map((note) => [note.id, note]));
  if (candidate.size !== mutation.notes.length || mutation.notes.some((note) => !note.id)) throw new Error('计划包含重复或缺失的项目标识，请修正草图后重试');
  // Removing a block from a plan may clear dates, never delete a note.
  if (base.some((note) => !candidate.has(note.id))) throw new Error('计划调整不能删除原有笔记');
  const patches = mutation.notes.filter((note) => !original.has(note.id) || revision(original.get(note.id)!) !== revision(note));
  const baseline = scopeRevision(base, rootId);
  let attemptedSave = false;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const current = writer.readNotes();
      if (scopeRevision(current, rootId) !== baseline) throw new Error('该计划在保存期间发生了修改；草图已保留，请重新载入最新计划后确认');
      const currentById = new Map(current.map((note) => [note.id, note]));
      for (const patch of patches) {
        const before = original.get(patch.id);
        const latest = currentById.get(patch.id);
        if (before ? !latest || revision(before) !== revision(latest) : Boolean(latest)) {
          throw new Error('目标笔记在保存期间发生了修改；未覆盖最新内容，草图已保留');
        }
      }
      const replacements = new Map(patches.map((note) => [note.id, note]));
      const projected = [
        ...current.map((note) => replacements.get(note.id) || note),
        ...patches.filter((note) => !currentById.has(note.id)),
      ];
      const personalOnly = personalNotePatches(current, projected) !== null;
      const next = personalOnly ? projected : recalculateBacklinks(projected);
      writer.beforeSave?.();
      // A rejected compare-and-set did not write a candidate. Do not compensate
      // it with a full stale snapshot and defeat its conflict protection.
      if (!personalOnly || !await writer.trySavePersonal?.(current, next)) {
        attemptedSave = true;
        await writer.saveNotes(next);
      }
      if (writer.readNotes() !== current) continue;
      writer.applyNotes(next);
      return { ...mutation, notes: next };
    }
    throw new Error('其他编辑仍在进行，草图已保留，请稍后重试保存');
  } catch (error) {
    // A disk writer may have completed a stale candidate or partially failed.
    // Keep visible data authoritative and compensate when storage is available.
    if (attemptedSave) {
      try { await writer.saveNotes(writer.readNotes()); } catch { /* Retry stays available in the editor. */ }
    }
    throw error;
  }
}
