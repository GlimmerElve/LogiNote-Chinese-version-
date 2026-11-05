import type { NoteItem, NoteReferenceIndexStatus } from '../types';
import { noteReferenceSourceDescriptor } from './noteReferenceSource';

export async function readNoteReferenceStatus(note: NoteItem): Promise<NoteReferenceIndexStatus> {
  note = structuredClone(note);
  const api = (window as any).electronAPI?.noteRag;
  if (!api?.status) return { noteId: note.id, status: 'unavailable', chunkCount: 0 };
  try {
    const raw: NoteReferenceIndexStatus = await api.status(note.id);
    if (raw?.noteId !== note.id || !['missing', 'queued', 'processing', 'ready', 'failed', 'empty', 'legacy', 'unavailable'].includes(raw.status)
      || !Number.isSafeInteger(raw.chunkCount) || raw.chunkCount < 0) throw new Error('invalid_index_status');
    if (raw.status === 'ready' && (typeof raw.sourceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(raw.sourceHash))) throw new Error('invalid_index_status');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(noteReferenceSourceDescriptor(note))));
    const expected = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
    // Editing state is not the saved indexed version, even if a caller forgot to change updatedAt.
    if (['ready', 'empty'].includes(raw.status) && (raw.sourceUpdatedAt !== note.updatedAt || raw.sourceHash !== expected)) {
      return { noteId: note.id, status: 'queued', chunkCount: 0 };
    }
    return { noteId: raw.noteId, status: raw.status, chunkCount: raw.status === 'ready' ? raw.chunkCount : 0,
      sourceHash: raw.sourceHash, sourceUpdatedAt: raw.sourceUpdatedAt, indexedAt: raw.indexedAt,
      ...(raw.errorCode && ['embedding_unavailable', 'storage_unavailable', 'index_budget_exceeded', 'interrupted', 'index_unavailable'].includes(raw.errorCode)
        ? { errorCode: raw.errorCode } : {}) };
  } catch { return { noteId: note.id, status: 'failed', errorCode: 'index_unavailable', chunkCount: 0 }; }
}
export function noteReferenceStatusLabel(status: NoteReferenceIndexStatus): string {
  switch (status.status) {
    case 'ready': return `参考索引已就绪 · ${status.chunkCount} 块`;
    case 'queued': return '参考索引等待更新';
    case 'processing': return '正在本地建立参考索引';
    case 'empty': return '暂无可索引的参考正文';
    case 'legacy': return '参考索引等待全文重建';
    case 'failed': return '参考索引未就绪，正文不受影响';
    case 'unavailable': return '全文参考索引需桌面版支持';
    default: return '参考索引尚未建立';
  }
}
