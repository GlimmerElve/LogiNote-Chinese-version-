import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, Info, Loader2 } from 'lucide-react';
import type { NoteItem, NoteReferenceIndexStatus as IndexStatus } from '../types';
import type { NoteSaveState } from '../services/ui/saveFeedback';
import { readNoteReferenceStatus, noteReferenceStatusLabel } from '../services/noteReferenceStatus';
import { indexNote } from '../services/ragService';

/** One quiet status line, independent of note saving and personal cognition. No extra admission dialog. */
export function NoteReferenceIndexStatus({ note, saveState }: { note: NoteItem; saveState?: NoteSaveState }) {
  const [status, setStatus] = useState<IndexStatus>({ noteId: note.id, status: 'queued', chunkCount: 0 });
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (note.noteType !== 'knowledge' || saveState === 'pending' || saveState === 'saving' || saveState === 'error') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = async () => {
      const value = await readNoteReferenceStatus(note);
      if (cancelled) return;
      setStatus(value);
      if (['queued', 'processing', 'legacy', 'missing'].includes(value.status)) timer = setTimeout(() => void read(), 1500);
    };
    void read();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [note.id, note.noteType, note.title, note.content, note.updatedAt, note.referenceSources, saveState, retry]);
  if (note.noteType !== 'knowledge') return null;
  const unsaved = saveState === 'pending' || saveState === 'saving' || saveState === 'error';
  const current = status.noteId === note.id && !unsaved ? status : { noteId: note.id, status: 'queued' as const, chunkCount: 0 };
  const busy = ['queued', 'processing', 'legacy'].includes(current.status);
  return <div className="mb-2 inline-flex flex-wrap items-center gap-1.5 text-xs text-[var(--ln-text-secondary)]"
    role="status" aria-live="polite" aria-atomic="true" title="参考索引只用于检索，不表示你已掌握，也不证明资料必然正确。">
    {current.status === 'failed' ? <AlertTriangle className="h-3 w-3" aria-hidden="true" />
      : busy ? <Loader2 className="h-3 w-3 animate-spin motion-reduce:animate-none" aria-hidden="true" />
      : current.status === 'ready' ? <Check className="h-3 w-3" aria-hidden="true" /> : <Info className="h-3 w-3" aria-hidden="true" />}
    <span>{unsaved ? '参考索引等待正文保存' : noteReferenceStatusLabel(current)}</span>
    {current.status === 'failed' && !unsaved && <button type="button"
      className="rounded border border-current px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ln-accent)]"
      onClick={() => {
        setStatus({ noteId: note.id, status: 'queued', chunkCount: 0 });
        void indexNote(note).catch(() => {}).finally(() => setRetry((value) => value + 1));
      }}>重试索引</button>}
  </div>;
}
