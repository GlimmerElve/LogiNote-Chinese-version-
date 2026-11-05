import type { NoteItem } from '../../types';

/** Autosave acknowledges the authoritative draft independently of broadcasting
 * it to every workspace. Body/time-only changes are already owned by the live
 * editor. All other fields (including derived links/tasks) still publish. */
export function shouldPublishNoteSnapshot(published: NoteItem[], prepared: NoteItem[]): boolean {
  if (published === prepared) return false;
  if (published.length !== prepared.length) return true;
  for (let index = 0; index < prepared.length; index++) {
    const before = published[index], after = prepared[index];
    if (before === after) continue;
    const keys = new Set([...Object.keys(before), ...Object.keys(after)] as Array<keyof NoteItem>);
    for (const key of keys) {
      if (key !== 'content' && key !== 'updatedAt' && before[key] !== after[key]) return true;
    }
  }
  return false;
}

/** Published snapshots can intentionally lag body-only autosaves. Editors must
 * always receive their own authoritative draft when keyboard ownership returns. */
export function resolveEditorNote(notes: NoteItem[], noteId?: string | null): NoteItem | null {
  return noteId ? notes.find(note => note.id === noteId) || null : null;
}
