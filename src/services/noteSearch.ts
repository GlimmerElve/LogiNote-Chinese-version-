import type { NoteItem } from '../types';

const searchText = (value: string): string => value.normalize('NFKC').toLocaleLowerCase().trim();
const tagText = (value: string): string => searchText(value).replace(/^#+\s*/u, '');

/** Shared by the note navigator and global search. A leading # explicitly
 * searches tags; ordinary queries also find titles, aliases and note text. */
export function matchesNoteSearch(note: Pick<NoteItem, 'title' | 'content' | 'aliases' | 'tags'>, query: string): boolean {
  const normalized = searchText(query);
  if (!normalized) return true;
  const tags = (note.tags || []).map(tagText);
  if (normalized.startsWith('#')) {
    const tag = tagText(normalized);
    return tags.some(value => Boolean(value) && value.includes(tag));
  }
  return tags.some(tag => tag.includes(normalized))
    || [note.title, note.content, ...(note.aliases || [])].some(value => searchText(value).includes(normalized));
}
