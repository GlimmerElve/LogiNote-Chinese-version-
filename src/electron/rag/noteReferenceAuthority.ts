import type { NoteItem, NoteRagIndexInput, NoteSearchResult } from '../../types';
import { noteReferenceSourceHash } from './noteReferenceChunks';

/** Renderer drafts are not reference originals. Only an acknowledged saved vault snapshot is indexed. */
export function currentNoteReferenceInput(requested: NoteRagIndexInput, notes: NoteItem[]): NoteRagIndexInput {
  const saved = notes.find((note) => note.id === requested.id);
  return saved ? { id: saved.id, title: saved.title, noteType: saved.noteType, content: saved.content,
    updatedAt: saved.updatedAt, referenceSources: saved.referenceSources }
    : { id: requested.id, title: requested.title, noteType: undefined, content: '' };
}
/** Source type, full-body fingerprint and saved version are authoritative, not derived-cache labels. */
export function isCurrentNoteReferenceHit(hit: NoteSearchResult, notes: NoteItem[]): boolean {
  const note = notes.find((item) => item.id === hit.noteId);
  return !!note && note.noteType === 'knowledge' && hit.noteType === 'knowledge' && hit.passage?.schemaVersion === 2
    && typeof hit.snippet === 'string' && !!hit.snippet.trim()
    && hit.passage.sourceHash === noteReferenceSourceHash(note) && hit.passage.sourceUpdatedAt === note.updatedAt
    && Number.isSafeInteger(hit.passage.textStart) && Number.isSafeInteger(hit.passage.textEnd)
    && hit.passage.textStart >= 0 && hit.passage.textEnd > hit.passage.textStart && hit.passage.textEnd <= note.content.length
    && note.content.slice(hit.passage.textStart, hit.passage.textEnd).startsWith(hit.snippet);
}
