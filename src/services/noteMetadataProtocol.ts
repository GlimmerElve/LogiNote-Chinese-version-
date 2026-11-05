import type { NoteItem } from '../types';
import { createNoteMetadataCalculator, type NoteMetadataInput } from './noteMetadata';

export interface NoteMetadataRequest { id: number; order: string[]; notes: NoteMetadataInput[]; isolated?: boolean }
export function noteMetadataInput(note: NoteItem): NoteMetadataInput {
  return { id: note.id, title: note.title, content: note.content, noteType: note.noteType, projectRole: note.projectRole,
    aliases: note.aliases, dueDates: note.dueDates, textbook: note.textbook };
}
export function sameNoteMetadataInput(a: NoteMetadataInput, b: NoteMetadataInput): boolean {
  return a.id === b.id && a.title === b.title && a.content === b.content && a.noteType === b.noteType && a.projectRole === b.projectRole
    && Boolean(a.textbook) === Boolean(b.textbook) && a.textbook?.regionId === b.textbook?.regionId
    && (a.aliases === b.aliases || JSON.stringify(a.aliases) === JSON.stringify(b.aliases))
    && (a.dueDates === b.dueDates || JSON.stringify(a.dueDates) === JSON.stringify(b.dueDates));
}
/** Worker-local state, no disk/network and no historical document versions. */
export function createNoteMetadataSession(calculate = createNoteMetadataCalculator()) {
  let current = new Map<string, NoteMetadataInput>();
  return (request: NoteMetadataRequest) => {
    const changed = new Map(request.notes.map(note => [note.id, note]));
    const notes = request.order.map(id => {
      const note = changed.get(id) || current.get(id);
      if (!note) throw new Error('后台笔记快照缺失，草稿已保留，请重试保存');
      return note;
    });
    if (new Set(request.order).size !== notes.length) throw new Error('后台笔记身份重复，草稿已保留');
    // Keep even a parse-failed snapshot synchronized: the next request can retry
    // it or replace it. Only a successful result is acknowledged to the caller.
    current = new Map(notes.map(note => [note.id, note]));
    return calculate(notes);
  };
}
