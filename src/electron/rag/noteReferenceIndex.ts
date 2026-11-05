import fs from 'node:fs/promises';
import path from 'node:path';
import type { NoteRagIndexInput, NoteReferenceIndexStatus, NoteReferenceSource, NoteSearchResult } from '../../types';
import { atomicWriteTextFile } from '../atomicWrite';
import { buildDf, bm25Score, tokenize, weightedFusion } from '../hybridSearch';
import { cosineSimilarity } from './embedding';
import { buildNoteReferenceChunks, noteReferenceSourceHash, noteReferenceSources, NOTE_REFERENCE_MODEL,
  noteReferenceHash, type NoteReferenceChunk } from './noteReferenceChunks';

interface StoredChunk extends NoteReferenceChunk { embedding: number[] }
interface Entry extends NoteReferenceIndexStatus {
  title: string;
  noteType: 'knowledge';
  model: string;
  referenceSources: NoteReferenceSource[];
  chunks: StoredChunk[];
}
interface File { schemaVersion: 2; entries: Entry[] }
interface Request { token: number; status: NoteReferenceIndexStatus; input?: NoteRagIndexInput }
type Embed = (text: string) => Promise<number[]>;
const validVector = (value: unknown): value is number[] => Array.isArray(value) && value.length === 384
  && value.every((item) => typeof item === 'number' && Number.isFinite(item)) && value.some((item) => item !== 0);
const code = (error: unknown): NonNullable<NoteReferenceIndexStatus['errorCode']> =>
  error instanceof Error && error.message === 'storage_unavailable' ? 'storage_unavailable'
    : error instanceof Error && error.message === 'index_budget_exceeded' ? 'index_budget_exceeded' : 'embedding_unavailable';
const publicStatus = (entry: NoteReferenceIndexStatus): NoteReferenceIndexStatus => ({ noteId: entry.noteId, status: entry.status,
  sourceHash: entry.sourceHash, sourceUpdatedAt: entry.sourceUpdatedAt, indexedAt: entry.indexedAt,
  chunkCount: entry.status === 'ready' ? entry.chunkCount : 0, ...(entry.errorCode ? { errorCode: entry.errorCode } : {}) });

/** One root, one writer. The factory permits offline tests without loading a model or touching the user vault. */
export function createNoteReferenceIndex(root: string, embed: Embed, options: {
  write?: (file: string, content: string) => Promise<unknown>;
} = {}) {
  if (!root || !path.isAbsolute(root)) throw new Error('参考索引目录未初始化');
  const file = path.join(root, 'note-embeddings.json');
  const requests = new Map<string, Request>();
  let sequence = 0, queue: Promise<unknown> = Promise.resolve(), legacyText: string | undefined;
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => {}).then(run); queue = next.catch(() => {}); return next;
  };
  async function read(): Promise<File> {
    let raw: unknown;
    try {
      const text = await fs.readFile(file, 'utf8'); raw = JSON.parse(text);
      if (Array.isArray(raw)) legacyText = text;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 2, entries: [] }; throw new Error('storage_unavailable'); }
    // Only explicitly typed historical knowledge rows survive as legacy. They are not searched until rebuilt.
    if (Array.isArray(raw)) return { schemaVersion: 2, entries: raw.filter((row) => row?.noteType === 'knowledge'
      && typeof row.noteId === 'string' && typeof row.title === 'string' && Array.isArray(row.embedding))
      .filter((row, index, rows) => rows.findIndex((other) => other.noteId === row.noteId) === index)
      .map((row) => ({ noteId: row.noteId, title: row.title, noteType: 'knowledge', model: 'legacy', status: 'legacy',
        chunkCount: 0, referenceSources: [], chunks: [] })) };
    const value = raw as File;
    if (!value || value.schemaVersion !== 2 || !Array.isArray(value.entries)) throw new Error('storage_unavailable');
    const ids = new Set<string>();
    for (const entry of value.entries) {
      if (!entry || entry.noteType !== 'knowledge' || typeof entry.noteId !== 'string' || ids.has(entry.noteId)
        || typeof entry.title !== 'string' || !['processing', 'ready', 'failed', 'empty', 'legacy'].includes(entry.status)
        || !Array.isArray(entry.chunks) || !Array.isArray(entry.referenceSources)
        || entry.chunks.length > 2000 || (entry.sourceUpdatedAt !== undefined && typeof entry.sourceUpdatedAt !== 'string')
        || !Number.isSafeInteger(entry.chunkCount) || entry.chunkCount < 0
        || (entry.status === 'ready' && (entry.model !== NOTE_REFERENCE_MODEL || !/^[a-f0-9]{64}$/u.test(entry.sourceHash || '')
          || entry.chunkCount !== entry.chunks.length))) throw new Error('storage_unavailable');
      ids.add(entry.noteId);
      const chunkIds = new Set<string>();
      for (const chunk of entry.chunks) {
        if (!chunk || typeof chunk.chunkId !== 'string' || chunkIds.has(chunk.chunkId) || typeof chunk.content !== 'string'
          || !Number.isSafeInteger(chunk.textStart) || !Number.isSafeInteger(chunk.textEnd) || chunk.textStart < 0
          || chunk.textEnd - chunk.textStart !== chunk.content.length || typeof chunk.embeddingText !== 'string'
          || !/^[a-f0-9]{64}$/u.test(chunk.embeddingKey) || !validVector(chunk.embedding)
          || chunk.embeddingKey !== noteReferenceHash({ model: NOTE_REFERENCE_MODEL, text: chunk.embeddingText })
          || typeof chunk.sectionPath !== 'string' || typeof chunk.forcedSplit !== 'boolean'
          || !['definition', 'condition', 'fact', 'example', 'reasoning', 'sources', 'general'].includes(chunk.sectionKind)
          || !Array.isArray(chunk.citationIds)) throw new Error('storage_unavailable');
        chunkIds.add(chunk.chunkId);
      }
    }
    return value;
  }
  async function write(value: File) {
    try {
      await fs.mkdir(root, { recursive: true });
      if (legacyText !== undefined) {
        const backup = path.join(root, `note-embeddings.legacy-${noteReferenceHash(legacyText).slice(0, 24)}.json`);
        try { await fs.access(backup); }
        catch { await (options.write || atomicWriteTextFile)(backup, legacyText); }
        legacyText = undefined;
      }
      await (options.write || atomicWriteTextFile)(file, JSON.stringify(value));
    }
    catch { throw new Error('storage_unavailable'); }
  }
  const current = (id: string, token: number) => requests.get(id)?.token === token;
  async function status(noteId: string): Promise<NoteReferenceIndexStatus> {
    const pending = requests.get(noteId);
    if (pending && ['queued', 'processing', 'failed'].includes(pending.status.status)) return publicStatus(pending.status);
    try {
      const entry = (await read()).entries.find((item) => item.noteId === noteId);
      if (!entry) return { noteId, status: 'missing', chunkCount: 0 };
      return entry.status === 'processing' ? { ...publicStatus(entry), status: 'failed', errorCode: 'interrupted' } : publicStatus(entry);
    } catch { return { noteId, status: 'failed', errorCode: 'storage_unavailable', chunkCount: 0 }; }
  }
  function index(raw: NoteRagIndexInput): Promise<void> {
    const input = structuredClone(raw);
    if (!input || typeof input.id !== 'string' || !input.id.trim() || input.id.length > 300
      || typeof input.title !== 'string' || typeof input.content !== 'string') return Promise.reject(new Error('参考笔记载荷无效'));
    const token = ++sequence;
    const request: Request = { token, input, status: { noteId: input.id, status: 'queued', chunkCount: 0,
      sourceUpdatedAt: input.updatedAt, sourceHash: noteReferenceSourceHash(input) } };
    requests.set(input.id, request);
    return serial(async () => {
      if (!current(input.id, token)) return;
      let data: File | undefined, previous: Entry | undefined;
      try {
        data = await read(); if (!current(input.id, token)) return;
        previous = data.entries.find((item) => item.noteId === input.id);
        if (input.noteType !== 'knowledge') {
          data.entries = data.entries.filter((entry) => entry.noteId !== input.id);
          if (previous) await write(data);
          if (current(input.id, token)) request.status = { noteId: input.id, status: 'empty', chunkCount: 0 };
          return;
        }
        const sourceHash = request.status.sourceHash!;
        if (previous?.status === 'ready' && previous.sourceHash === sourceHash && previous.sourceUpdatedAt === input.updatedAt) {
          request.status = publicStatus(previous); return;
        }
        const pieces = buildNoteReferenceChunks(input);
        const processing: Entry = { noteId: input.id, title: input.title, noteType: 'knowledge', model: NOTE_REFERENCE_MODEL,
          status: 'processing', chunkCount: 0, sourceHash, sourceUpdatedAt: input.updatedAt,
          referenceSources: noteReferenceSources(input), chunks: previous?.chunks || [] };
        data.entries = [...data.entries.filter((entry) => entry.noteId !== input.id), processing];
        request.status = publicStatus(processing); await write(data);
        const cache = new Map((previous?.model === NOTE_REFERENCE_MODEL ? previous.chunks : []).map((chunk) => [chunk.embeddingKey, chunk.embedding]));
        const chunks: StoredChunk[] = [];
        for (const piece of pieces) {
          if (!current(input.id, token)) return;
          const embedding = cache.get(piece.embeddingKey) || await embed(piece.embeddingText);
          if (!validVector(embedding)) throw new Error('embedding_unavailable');
          if (!current(input.id, token)) return;
          cache.set(piece.embeddingKey, embedding); chunks.push({ ...piece, embedding: [...embedding] });
        }
        if (!current(input.id, token)) return;
        const ready: Entry = { ...processing, status: chunks.length ? 'ready' : 'empty', chunks, chunkCount: chunks.length,
          indexedAt: new Date().toISOString() };
        data.entries = data.entries.map((entry) => entry.noteId === input.id ? ready : entry);
        await write(data);
        if (current(input.id, token)) request.status = publicStatus(ready);
      } catch (error) {
        if (!current(input.id, token)) return;
        request.status = { ...request.status, status: 'failed', chunkCount: 0, errorCode: code(error) };
        // Preserve the previous complete vectors for a retry, but never serve them as the new version.
        if (data) {
          const failed: Entry = { ...request.status, title: input.title, noteType: 'knowledge', model: NOTE_REFERENCE_MODEL,
            referenceSources: noteReferenceSources(input), chunks: previous?.chunks || [] };
          data.entries = [...data.entries.filter((entry) => entry.noteId !== input.id), failed];
          await write(data).catch(() => {});
        }
        throw new Error(request.status.errorCode);
      }
    });
  }
  function remove(noteId: string): Promise<void> {
    return removeMany([noteId]);
  }
  function removeMany(noteIds: string[]): Promise<void> {
    if (!Array.isArray(noteIds) || noteIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 300)) {
      return Promise.reject(new Error('笔记 ID 无效'));
    }
    const removals = new Map([...new Set(noteIds)].map(noteId => {
      const request: Request = { token: ++sequence, status: { noteId, status: 'queued', chunkCount: 0 } };
      requests.set(noteId, request);
      return [noteId, request] as const;
    }));
    if (!removals.size) return Promise.resolve();
    return serial(async () => {
      try {
        if (![...removals].some(([id, request]) => current(id, request.token))) return;
        const data = await read();
        const entries = data.entries.filter(entry => {
          const request = removals.get(entry.noteId);
          return !request || !current(entry.noteId, request.token);
        });
        // One batch, one rewrite; absent project indexes require no disk write.
        if (entries.length !== data.entries.length) await write({ ...data, entries });
        for (const [id, request] of removals) if (current(id, request.token)) requests.delete(id);
      } catch {
        for (const [id, request] of removals) if (current(id, request.token)) {
          request.status = { noteId: id, status: 'failed', errorCode: 'storage_unavailable', chunkCount: 0 };
        }
        throw new Error('storage_unavailable');
      }
    });
  }
  function indexAll(raw: NoteRagIndexInput[]): Promise<void> {
    const inputs = structuredClone(raw), live = new Set(inputs.filter((note) => note.noteType === 'knowledge').map((note) => note.id));
    const pending = inputs.map(index), cutoff = sequence;
    const prune = serial(async () => {
      const data = await read();
      const entries = data.entries.filter((entry) => live.has(entry.noteId) || (requests.get(entry.noteId)?.token || 0) > cutoff);
      if (entries.length !== data.entries.length) await write({ ...data, entries });
    });
    return Promise.allSettled([...pending, prune]).then((results) => {
      if (results.some((result) => result.status === 'rejected')) throw new Error('index_unavailable');
    });
  }
  async function count() { return (await read()).entries.filter((entry) => entry.status === 'ready' || entry.status === 'legacy').length; }
  async function search(query: string, queryVector: number[], limit = 5, allowedNoteIds?: string[]): Promise<NoteSearchResult[]> {
    // Host-owned stable IDs only. Freeze before reading; undefined retains the legacy corpus.
    const selectedIds = allowedNoteIds === undefined ? undefined : new Set(allowedNoteIds);
    if (selectedIds?.size === 0) return [];
    const safeLimit = Math.max(0, Math.min(20, Number.isFinite(limit) ? Math.floor(limit) : 5));
    if (!query.trim() || !safeLimit) return [];
    // Limit the candidate corpus BEFORE DF/BM25, dense ranking, fusion and top-k. Filtering
    // global top-k afterwards lets another project's high-ranked hits suppress this scope.
    const entries = (await read()).entries.filter((entry) => (!selectedIds || selectedIds.has(entry.noteId))
      && entry.status === 'ready' && entry.model === NOTE_REFERENCE_MODEL
      && (!requests.has(entry.noteId) || (requests.get(entry.noteId)!.status.status === 'ready'
        && requests.get(entry.noteId)!.status.sourceHash === entry.sourceHash)));
    const rows = entries.flatMap((entry) => entry.chunks.map((chunk) => ({ entry, chunk })));
    const texts = rows.map(({ chunk }) => chunk.embeddingText), df = buildDf(texts), queryTokens = tokenize(query);
    const avgLen = texts.reduce((sum, text) => sum + tokenize(text).length, 0) / Math.max(texts.length, 1);
    // A failed/invalid local query embedding must not suppress otherwise valid lexical hits.
    const vector = validVector(queryVector) ? queryVector : [];
    const ranked = rows.map((row) => ({ ...row, dense: Math.max(0, cosineSimilarity(vector, row.chunk.embedding)),
      sparse: bm25Score(queryTokens, row.chunk.embeddingText, df, rows.length, avgLen) }))
      .filter((row) => row.dense >= 0.25 || row.sparse > 0);
    const scores = weightedFusion(ranked.map((row) => ({ id: `${row.entry.noteId}/${row.chunk.chunkId}`, dense: row.dense, sparse: row.sparse })), 0.35);
    ranked.sort((left, right) => (scores.get(`${right.entry.noteId}/${right.chunk.chunkId}`) || 0)
      - (scores.get(`${left.entry.noteId}/${left.chunk.chunkId}`) || 0));
    const seen = new Set<string>();
    return ranked.filter(({ entry }) => !seen.has(entry.noteId) && !!seen.add(entry.noteId)).slice(0, safeLimit).map(({ entry, chunk, dense }) => ({
      noteId: entry.noteId, noteType: 'knowledge', title: entry.title, score: dense, snippet: chunk.content.slice(0, 450),
      matchKinds: ['note'], evidenceOrigin: 'note-passage', passage: { schemaVersion: 2, chunkId: chunk.chunkId,
        sourceHash: entry.sourceHash!, sourceUpdatedAt: entry.sourceUpdatedAt, textStart: chunk.textStart, textEnd: chunk.textEnd,
        sectionPath: chunk.sectionPath, sectionKind: chunk.sectionKind, forcedSplit: chunk.forcedSplit } }));
  }
  return { index, indexAll, remove, removeMany, status, search, count };
}
