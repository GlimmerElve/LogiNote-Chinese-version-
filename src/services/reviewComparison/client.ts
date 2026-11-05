import { searchNotes } from '../ragService';
import { previewDocument, searchDocuments } from '../documentRagClient';
import { loadPersonalCognition } from '../cognition/store';
import { readNotesForCognition } from '../storage';
import type { NoteItem } from '../../types';
import type { ReviewComparisonDependencies } from './types';

/** Authoritative read only. Desktop failures must not fall back to a stale browser vault. */
async function readReviewReferenceNotes(): Promise<NoteItem[]> {
  const electron = (window as unknown as { electronAPI?: { vault?: { loadVault?: () => Promise<unknown> } } }).electronAPI;
  if (!electron) return readNotesForCognition();
  if (!electron.vault?.loadVault) throw new Error('知识点正文读取接口不可用');
  const notes: unknown = await electron.vault.loadVault();
  if (!Array.isArray(notes)) throw new Error('知识点正文快照无效');
  return notes as NoteItem[];
}

export const reviewComparisonDependencies: ReviewComparisonDependencies = {
  readNotes: readReviewReferenceNotes,
  loadCognition: loadPersonalCognition,
  searchNotes,
  searchDocuments: (query, limit) => searchDocuments(query, limit, { mode: 'auto', expandGraph: true }),
  previewDocument,
};
