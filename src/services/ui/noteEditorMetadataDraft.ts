import type { NoteItem } from '../../types';

type Metadata = Pick<NoteItem, 'tags' | 'aliases'>;
export interface NoteEditorMetadataDraft {
  noteId: string | null;
  baseline: Metadata;
  patch: Partial<Metadata>;
}
export const sameEditorMetadataList = (a: string[] | undefined, b: string[] | undefined): boolean =>
  (a?.length || 0) === (b?.length || 0) && (a || []).every((item, index) => item === b?.[index]);

export function createNoteEditorMetadataDraft(note: NoteItem | null): NoteEditorMetadataDraft {
  return { noteId: note?.id ?? null, baseline: { tags: note?.tags || [], aliases: note?.aliases }, patch: {} };
}

/** A changed received field is a published draft or a newer external edit. Either
 * settles this overlay; unrelated body/resource publications must not clear it. */
export function reconcileNoteEditorMetadataDraft(draft: NoteEditorMetadataDraft, note: NoteItem | null): void {
  if (draft.noteId !== (note?.id ?? null)) {
    Object.assign(draft, createNoteEditorMetadataDraft(note));
    return;
  }
  for (const field of ['tags', 'aliases'] as const) {
    if (!sameEditorMetadataList(draft.baseline[field], note?.[field])) delete draft.patch[field];
  }
  draft.baseline = { tags: note?.tags || [], aliases: note?.aliases };
}

export function recordNoteEditorMetadataDraft(draft: NoteEditorMetadataDraft, note: NoteItem, patch: Partial<Metadata>): void {
  reconcileNoteEditorMetadataDraft(draft, note);
  for (const field of ['tags', 'aliases'] as const) {
    if (!(field in patch)) continue;
    if (sameEditorMetadataList(patch[field], draft.baseline[field])) delete draft.patch[field];
    else draft.patch[field] = patch[field];
  }
}

export function applyNoteEditorMetadataDraft(note: NoteItem, draft: NoteEditorMetadataDraft): NoteItem {
  return draft.noteId === note.id ? { ...note, ...draft.patch } : note;
}
