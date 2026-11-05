import type { NoteItem } from '../types';
import { applyNoteMetadata, createNoteMetadataCalculator, type DerivedNoteMetadata, type NoteMetadataInput } from './noteMetadata';
import { noteMetadataInput, sameNoteMetadataInput } from './noteMetadataProtocol';

let worker: Worker | null = null, nextId = 0;
const pending = new Map<number, { resolve: (value: DerivedNoteMetadata[]) => void; reject: (error: Error) => void }>();
const prepared = new WeakMap<NoteItem[], Promise<NoteItem[]>>();
let posted = new Map<string, NoteMetadataInput>();
const calculateOffline = createNoteMetadataCalculator();

function metadataWorker(): Worker {
  if (worker) return worker;
  const instance = new Worker(new URL('./noteMetadataWorker.ts', import.meta.url), { type: 'module' });
  posted = new Map(); // A restarted worker needs a complete initial baseline.
  instance.onmessage = (event: MessageEvent<{ id: number; metadata: DerivedNoteMetadata[]; error?: string }>) => {
    const request = pending.get(event.data.id);
    if (!request) return;
    pending.delete(event.data.id);
    if (event.data.error) { posted = new Map(); request.reject(new Error(event.data.error)); } else request.resolve(event.data.metadata);
  };
  instance.onerror = () => {
    if (worker !== instance) return;
    worker = null; posted = new Map();
    instance.terminate();
    for (const request of pending.values()) request.reject(new Error('后台笔记解析失败，草稿已保留，请重试保存'));
    pending.clear();
  };
  worker = instance;
  return instance;
}

/** Cache only immutable snapshot identities. A changed draft always gets a new request. */
export function prepareNotesMetadata(notes: NoteItem[]): Promise<NoteItem[]> {
  const cached = prepared.get(notes);
  if (cached) return cached;
  const work = typeof Worker === 'undefined' ? Promise.resolve().then(() => applyNoteMetadata(notes, calculateOffline(notes)))
    : new Promise<DerivedNoteMetadata[]>((resolve, reject) => {
      const instance = metadataWorker(), id = ++nextId;
      pending.set(id, { resolve, reject });
      // FIFO messages carry only changed parsing inputs; unchanged long bodies
      // are neither cloned across threads nor parsed again on each auto-save.
      const next = new Map(notes.map(note => [note.id, noteMetadataInput(note)]));
      const changed = [...next.values()].filter(note => !posted.has(note.id) || !sameNoteMetadataInput(posted.get(note.id)!, note));
      try { instance.postMessage({ id, order: notes.map(note => note.id), notes: changed }); posted = next; }
      catch (error) { pending.delete(id); reject(error); }
    }).then(metadata => applyNoteMetadata(notes, metadata));
  const promise = work.then(result => { prepared.set(result, Promise.resolve(result)); return result; })
    .catch(error => { prepared.delete(notes); throw error; });
  prepared.set(notes, promise);
  return promise;
}

/** Maintenance parses only its selected target, without evicting the ordinary
 * editor worker's cached directory or causing the next save to resend the vault. */
export async function prepareSelectedNoteMetadata(notes: NoteItem[]): Promise<NoteItem[]> {
  if (!notes.length) return notes;
  if (typeof Worker === 'undefined') return applyNoteMetadata(notes, createNoteMetadataCalculator()(notes));
  const metadata = await new Promise<DerivedNoteMetadata[]>((resolve, reject) => {
    const instance = metadataWorker(), id = ++nextId; pending.set(id, { resolve, reject });
    try { instance.postMessage({ id, isolated: true, order: notes.map(note => note.id), notes: notes.map(noteMetadataInput) }); }
    catch (error) { pending.delete(id); reject(error); }
  });
  return applyNoteMetadata(notes, metadata);
}
