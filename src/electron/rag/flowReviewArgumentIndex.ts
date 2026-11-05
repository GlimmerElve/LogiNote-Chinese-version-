import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { NoteItem } from '../../types';
import { savedFlowReviewGraphs, readSavedFlowGraphs, retrieveFlowReviewGraphs, type SavedFlowReviewGraph, type FlowReviewIndexStatus } from '../../services/cognition/flowReviewMaterials';
import { atomicWriteTextFile } from '../atomicWrite';
import { getBackgroundRagCompute } from './backgroundComputeBridge';

const MODEL = 'paraphrase-multilingual-MiniLM-L12-v2:mean-normalized:384:flow-review-v1';
interface Index { version: 1; model: string; sourceHash: string; graphs: SavedFlowReviewGraph[];
  vectors: Array<{ key: string; embedding: number[] }>; vectorStatus: 'ready' | 'unavailable'; updatedAt: string }
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const validVector = (v: unknown): v is number[] => Array.isArray(v) && v.length === 384 && v.every(Number.isFinite) && v.some(x => x !== 0);

/** Independent private derivative. Never writes a publication, cognition record, profile, or source note. */
export function createFlowReviewArgumentIndex(root: string, embed: (texts: string[]) => Promise<number[][]>) {
  if (!path.isAbsolute(root)) throw new Error('个人复盘图索引目录无效');
  const file = path.join(root, 'user-state', 'cognition-materials', 'flow-review-arguments.json');
  let queue: Promise<unknown> = Promise.resolve();
  let pending = 0;
  const serial = <T>(run: () => Promise<T>) => { const next = queue.catch(() => undefined).then(run); queue = next.catch(() => undefined); return next; };
  async function read(): Promise<Index | null> {
    try {
      const raw = JSON.parse(await fs.readFile(file, 'utf8')) as Index;
      if (raw.version !== 1 || raw.model !== MODEL || !Array.isArray(raw.vectors) || typeof raw.sourceHash !== 'string') throw new Error('invalid_flow_material_index');
      readSavedFlowGraphs(raw.graphs);
      return { ...raw, vectors: raw.vectors.filter(v => typeof v.key === 'string' && validVector(v.embedding)) };
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }
  async function persistGraphs(graphs: SavedFlowReviewGraph[], previous: Index | null, selectedKeys?: Set<string>) {
      const sourceHash = hash({ model: MODEL, graphs });
      if (previous?.sourceHash === sourceHash) return;
      const vectors = new Map((previous?.vectors || []).map(v => [v.key, v.embedding]));
      const texts = [...new Map(graphs.flatMap(g => g.nodes.map(n => {
        const text = `${g.title}\n${n.role}\n${n.text}`; return [hash(text), text] as const;
      }))).entries()];
      let available = true;
      const missing = texts.filter(([key]) => !vectors.has(key) && (!selectedKeys || selectedKeys.has(key)));
      try {
        for (let i = 0; i < missing.length; i += 16) {
          const batch = missing.slice(i, i + 16), embeddings = await embed(batch.map(([, text]) => text));
          if (embeddings.length !== batch.length || embeddings.some(v => !validVector(v))) throw new Error('embedding_unavailable');
          batch.forEach(([key], j) => vectors.set(key, embeddings[j]));
        }
      } catch { available = false; } // Lexical/graph retrieval still works; no cloud fallback or retry.
      available = available && texts.every(([key]) => vectors.has(key));
      const next: Index = { version: 1, model: MODEL, sourceHash, graphs,
        vectors: texts.flatMap(([key]) => vectors.has(key) ? [{ key, embedding: vectors.get(key)! }] : []),
        vectorStatus: available ? 'ready' : 'unavailable', updatedAt: new Date().toISOString() };
      await fs.mkdir(path.dirname(file), { recursive: true });
      await atomicWriteTextFile(file, JSON.stringify(next));
  }
  function syncNotes(notes: readonly NoteItem[]) {
    // Full reconciliation is for startup/migration only.
    const graphs = structuredClone(notes.flatMap(savedFlowReviewGraphs));
    pending++;
    return serial(async () => persistGraphs(graphs, await read())).finally(() => { pending--; });
  }
  function syncNote(note: NoteItem) {
    const id = note.id, graphs = structuredClone(savedFlowReviewGraphs(note));
    const selectedKeys = new Set(graphs.flatMap(graph => graph.nodes.map(node => hash(`${graph.title}\n${node.role}\n${node.text}`))));
    pending++;
    return serial(async () => {
      const previous = await read();
      await persistGraphs([...(previous?.graphs || []).filter(graph => graph.noteId !== id), ...graphs], previous, selectedKeys);
    }).finally(() => { pending--; });
  }
  function removeNote(noteId: string) {
    return serial(async () => {
      const previous = await read(); if (!previous?.graphs.some(graph => graph.noteId === noteId)) return;
      await persistGraphs(previous.graphs.filter(graph => graph.noteId !== noteId), previous, new Set());
    });
  }
  async function search(query: string) { await queue; return retrieveFlowReviewGraphs((await read())?.graphs || [], query, 2); }
  async function status(noteId?: string): Promise<FlowReviewIndexStatus> {
    const value = await read(), graphs = (value?.graphs || []).filter(g => noteId === undefined || g.noteId === noteId);
    return { graphCount: graphs.length, graphIds: graphs.map(g => g.argumentDocId),
      nodeCount: graphs.reduce((sum, g) => sum + g.nodes.length, 0), vectorStatus: value?.vectorStatus || 'missing', processing: pending > 0 };
  }
  return { syncNotes, syncNote, removeNote, search, status };
}

const roots = new Map<string, ReturnType<typeof createFlowReviewArgumentIndex>>();
let active: ReturnType<typeof createFlowReviewArgumentIndex> | undefined;
export function setFlowReviewArgumentDataRoot(root: string) {
  if (!root || !path.isAbsolute(root)) throw new Error('个人复盘图索引目录无效');
  const resolved = path.resolve(root);
  if (!roots.has(resolved)) roots.set(resolved, createFlowReviewArgumentIndex(resolved, async texts => {
    const background = getBackgroundRagCompute(); if (!background) throw new Error('embedding_unavailable');
    return background.embed(texts);
  }));
  active = roots.get(resolved);
}
export const syncSavedFlowReviewNotes = (notes: readonly NoteItem[]) => {
  if (!active) return Promise.reject(new Error('个人复盘图索引未初始化'));
  return active.syncNotes(notes);
};
export const syncSavedFlowReviewNote = (note: NoteItem) => {
  if (!active) return Promise.reject(new Error('个人复盘图索引未初始化'));
  return active.syncNote(note);
};
export const deleteSavedFlowReviewNote = (noteId: string) => {
  if (!active) return Promise.reject(new Error('个人复盘图索引未初始化'));
  return active.removeNote(noteId);
};
export const searchSavedFlowReviewArguments = (query: string) => {
  if (!active) return Promise.reject(new Error('个人复盘图索引未初始化'));
  return active.search(query);
};
export const getSavedFlowReviewStatus = (noteId: string) => {
  if (!active) return Promise.reject(new Error('个人复盘图索引未初始化'));
  return active.status(noteId);
};
