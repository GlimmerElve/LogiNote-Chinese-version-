import type { TextbookReferenceIndexStatus, TextbookReferenceSearchResult } from '../types.ts';

function api(): {
  search(query: string, k: number | undefined, allowedNoteIds: string[]): Promise<TextbookReferenceSearchResult[]>;
  status(noteId: string): Promise<TextbookReferenceIndexStatus>;
  rebuild(noteId: string): Promise<TextbookReferenceIndexStatus>;
} | undefined {
  return typeof window === 'undefined'
    ? undefined
    : (window as unknown as { electronAPI?: { textbookRag?: ReturnType<typeof api> } }).electronAPI?.textbookRag;
}

export async function searchProjectTextbooks(query: string, allowedNoteIds: string[], limit = 2): Promise<TextbookReferenceSearchResult[]> {
  const textbookApi = api();
  if (!textbookApi || !query.trim() || !allowedNoteIds.length) return [];
  return textbookApi.search(query, limit, [...new Set(allowedNoteIds)]);
}

export async function textbookReferenceStatus(noteId: string): Promise<TextbookReferenceIndexStatus> {
  return api()?.status(noteId) || { noteId, status: 'unavailable', chunkCount: 0 };
}

/** 只应由用户显式点击“重建教材索引”调用。 */
export async function rebuildTextbookReferenceIndex(noteId: string): Promise<TextbookReferenceIndexStatus> {
  const textbookApi = api();
  if (!textbookApi) return { noteId, status: 'unavailable', chunkCount: 0 };
  return textbookApi.rebuild(noteId);
}
