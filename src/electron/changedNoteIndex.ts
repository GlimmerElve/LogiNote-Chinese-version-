import { createHash } from 'node:crypto';
import type { NoteItem, NoteRagIndexInput } from '../types';
import { projectMaterialRows } from '../services/ragSourcePolicy';
import { savedFlowReviewGraphs } from '../services/cognition/flowReviewMaterials';
import { readTextbookBody } from '../services/textbook/noteContent';
import { noteReferenceSourceDescriptor } from '../services/noteReferenceSource';

export const NOTE_INDEX_CHANNELS = ['private-material', 'knowledge', 'published-argument', 'textbook', 'flow-review'] as const;
export type NoteIndexChannel = typeof NOTE_INDEX_CHANNELS[number];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sourceKeys = new WeakMap<NoteItem, Record<NoteIndexChannel, string>>();

export function savedNoteIndexInput(note: NoteItem): NoteRagIndexInput {
  return { id: note.id, title: note.title, noteType: note.noteType, content: note.content, updatedAt: note.updatedAt,
    textbook: note.textbook, generatedContentBlocks: note.generatedContentBlocks, learningReviewRecords: note.learningReviewRecords,
    referenceSources: note.referenceSources, publishedArguments: (note.argumentDocs || []).flatMap(doc => doc.rag?.publishedSnapshot
      ? [{ argumentDocId: doc.doc_id, snapshot: doc.rag.publishedSnapshot }] : []) };
}

/** Each lane hashes its own semantic input, excluding timestamps, selection and
 * learning scores. A plain body edit cannot rebuild an unchanged saved graph. */
export function savedNoteIndexKeys(note: NoteItem): Record<NoteIndexChannel, string> {
  const cached = sourceKeys.get(note); if (cached) return cached;
  const input = savedNoteIndexInput(note);
  const keys = {
    'private-material': hash(projectMaterialRows(input)),
    knowledge: hash(noteReferenceSourceDescriptor(input)),
    'published-argument': hash([note.title, input.publishedArguments]),
    textbook: hash(note.noteType === 'project' && note.textbook
      ? [note.title, note.textbook.textbookId, note.textbook.revisionId, note.textbook.regionId, readTextbookBody(note.content, note.textbook)] : null),
    'flow-review': hash(savedFlowReviewGraphs(note)),
  };
  sourceKeys.set(note, keys); return keys;
}

/** Scheduling/leases remain owned by createDeferredNoteIndex. This state keeps
 * only dirty IDs/lane tokens and tiny success fingerprints, never old bodies. */
export function createChangedNoteIndex(options: {
  scope: () => string; isCurrent: (scope: string) => boolean; version: () => number;
  read: (ids: string[]) => Promise<NoteItem[]>;
  sync: (channel: NoteIndexChannel, note: NoteItem) => Promise<void>;
  retry: () => void;
}) {
  let scope = '', serial = 0;
  const pending = new Map<string, Map<NoteIndexChannel, number>>(), receipts = new Map<string, Map<NoteIndexChannel, string>>();
  const enter = () => {
    const current = options.scope();
    if (scope !== current) { scope = current; pending.clear(); receipts.clear(); }
    return current;
  };
  const claim = (id: string, channels: readonly NoteIndexChannel[]) => {
    if (!channels.length) return false;
    const lanes = pending.get(id) || new Map<NoteIndexChannel, number>();
    for (const channel of channels) lanes.set(channel, ++serial);
    pending.set(id, lanes); return true;
  };
  const ack = (id: string, channel: NoteIndexChannel, token: number) => {
    const lanes = pending.get(id); if (lanes?.get(channel) !== token) return;
    lanes.delete(channel); if (!lanes.size) pending.delete(id);
  };
  return {
    request(next: readonly NoteItem[], previous: readonly NoteItem[]) {
      enter(); const before = new Map(previous.map(note => [note.id, note])); let requested = false;
      for (const note of next) {
        const old = before.get(note.id), afterKeys = savedNoteIndexKeys(note), priorKeys = old && savedNoteIndexKeys(old);
        requested = claim(note.id, NOTE_INDEX_CHANNELS.filter(channel => !priorKeys || priorKeys[channel] !== afterKeys[channel])) || requested;
      }
      for (const note of previous) if (!next.some(item => item.id === note.id)) { pending.delete(note.id); receipts.delete(note.id); }
      return requested;
    },
    requestIds(ids: readonly string[]) { enter(); for (const id of ids) claim(id, NOTE_INDEX_CHANNELS); },
    remember(channel: NoteIndexChannel, notes: readonly NoteItem[]) {
      enter(); for (const note of notes) {
        const known = receipts.get(note.id) || new Map<NoteIndexChannel, string>(); known.set(channel, savedNoteIndexKeys(note)[channel]); receipts.set(note.id, known);
      }
    },
    forget(ids: readonly string[]) { enter(); for (const id of ids) { pending.delete(id); receipts.delete(id); } },
    isPending: () => { enter(); return pending.size > 0; },
    async run() {
      const startedScope = enter(), version = options.version();
      if (!pending.size || !options.isCurrent(startedScope)) return;
      const snapshot = new Map([...pending].map(([id, lanes]) => [id, new Map(lanes)]));
      const fresh = () => options.isCurrent(startedScope) && startedScope === options.scope() && version === options.version();
      const notes = await options.read([...snapshot.keys()]);
      if (!fresh()) { if (options.isCurrent(startedScope)) options.retry(); return; }
      const byId = new Map(notes.map(note => [note.id, note])), failures: unknown[] = [];
      for (const [id, lanes] of snapshot) {
        const note = byId.get(id);
        if (!note) { for (const [channel, token] of lanes) ack(id, channel, token); receipts.delete(id); continue; }
        const keys = savedNoteIndexKeys(note);
        for (const [channel, token] of lanes) {
          if (!fresh()) { if (options.isCurrent(startedScope)) options.retry(); return; }
          if (receipts.get(id)?.get(channel) === keys[channel]) { ack(id, channel, token); continue; }
          try {
            await options.sync(channel, note);
            if (!fresh()) { if (options.isCurrent(startedScope)) options.retry(); return; }
            const known = receipts.get(id) || new Map<NoteIndexChannel, string>(); known.set(channel, keys[channel]); receipts.set(id, known);
            ack(id, channel, token);
          } catch (error) {
            if (!fresh()) { if (options.isCurrent(startedScope)) options.retry(); return; }
            failures.push(error); // Independent lanes still run; failed tokens remain pending.
          }
        }
      }
      if (failures.length) throw new AggregateError(failures, 'changed_note_index_partial_failure');
    },
  };
}
