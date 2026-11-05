import fs from 'node:fs/promises';
import path from 'node:path';
import type { NoteItem, TextbookReferenceIndexStatus, TextbookReferenceSearchResult } from '../../types.ts';
import { readTextbookBody } from '../../services/textbook/noteContent.ts';
import { atomicWriteTextFile } from '../atomicWrite.ts';
import { buildDf, bm25Score, tokenize, weightedFusion } from '../hybridSearch.ts';
import { cosineSimilarity } from './embedding.ts';
import { getBackgroundRagCompute } from './backgroundComputeBridge.ts';
import {
  TEXTBOOK_REFERENCE_MODEL,
  textbookReferenceHash,
  textbookReferenceSourceHash,
  type TextbookReferenceChunk,
  type TextbookReferenceChunkInput,
} from './textbookReferenceChunks.ts';

interface StoredChunk extends TextbookReferenceChunk { embedding: number[] }
interface Entry extends TextbookReferenceIndexStatus {
  title: string;
  regionId?: string;
  model: string;
  chunks: StoredChunk[];
}
interface StoreFile { schemaVersion: 1; entries: Entry[] }
interface PendingRequest { token: number; status: TextbookReferenceIndexStatus }

const validVector = (value: unknown): value is number[] => Array.isArray(value) && value.length === 384
  && value.every((item) => typeof item === 'number' && Number.isFinite(item)) && value.some((item) => item !== 0);
const publicStatus = (entry: TextbookReferenceIndexStatus): TextbookReferenceIndexStatus => ({
  noteId: entry.noteId,
  ...(entry.textbookId ? { textbookId: entry.textbookId } : {}),
  ...(entry.revisionId ? { revisionId: entry.revisionId } : {}),
  status: entry.status,
  sourceHash: entry.sourceHash,
  indexedAt: entry.indexedAt,
  chunkCount: entry.status === 'ready' ? entry.chunkCount : 0,
  ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
});
const errorCode = (error: unknown): NonNullable<TextbookReferenceIndexStatus['errorCode']> => {
  const message = error instanceof Error ? error.message : '';
  if (message === 'storage_unavailable') return 'storage_unavailable';
  if (message === 'index_budget_exceeded') return 'index_budget_exceeded';
  return 'embedding_unavailable';
};

function textbookInput(note: NoteItem): TextbookReferenceChunkInput | null | 'invalid' {
  if (note.noteType !== 'project' || !note.textbook) return null;
  const body = readTextbookBody(note.content || '', note.textbook);
  if (body === null) return 'invalid';
  return {
    noteId: note.id,
    title: note.title,
    textbookId: note.textbook.textbookId,
    revisionId: note.textbook.revisionId,
    regionId: note.textbook.regionId,
    body,
  };
}

/**
 * 项目教材索引是独立派生状态：不写回笔记，不与知识点索引混合。
 * 同一 sourceHash 的 failed/processing 状态不会被普通保存自动重试。
 */
export function createTextbookReferenceIndex(root: string) {
  if (!root || !path.isAbsolute(root)) throw new Error('教材索引目录未初始化');
  const file = path.join(root, 'textbook-reference-embeddings.json');
  const requests = new Map<string, PendingRequest>();
  let sequence = 0;
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.catch(() => undefined).then(run);
    queue = next.catch(() => undefined);
    return next;
  };
  async function read(): Promise<StoreFile> {
    try {
      const parsed = JSON.parse(await fs.readFile(file, 'utf8')) as StoreFile;
      if (!parsed || parsed.schemaVersion !== 1 || !Array.isArray(parsed.entries)) throw new Error('storage_unavailable');
      const ids = new Set<string>();
      for (const entry of parsed.entries) {
        if (!entry || typeof entry.noteId !== 'string' || ids.has(entry.noteId) || typeof entry.title !== 'string'
          || !['processing', 'ready', 'failed', 'empty', 'invalid'].includes(entry.status)
          || !Array.isArray(entry.chunks) || !Number.isSafeInteger(entry.chunkCount) || entry.chunkCount < 0
          || entry.chunks.length > 2500 || (entry.status === 'ready' && (entry.model !== TEXTBOOK_REFERENCE_MODEL
            || typeof entry.textbookId !== 'string' || typeof entry.revisionId !== 'string' || typeof entry.regionId !== 'string'
            || entry.chunkCount !== entry.chunks.length || !/^[a-f0-9]{64}$/u.test(entry.sourceHash || '')))) {
          throw new Error('storage_unavailable');
        }
        ids.add(entry.noteId);
        const chunkIds = new Set<string>();
        for (const chunk of entry.chunks) {
          if (!chunk || typeof chunk.chunkId !== 'string' || chunkIds.has(chunk.chunkId) || typeof chunk.content !== 'string'
            || !Number.isSafeInteger(chunk.textStart) || !Number.isSafeInteger(chunk.textEnd)
            || chunk.textStart < 0 || chunk.textEnd - chunk.textStart !== chunk.content.length
            || typeof chunk.embeddingText !== 'string' || !/^[a-f0-9]{64}$/u.test(chunk.embeddingKey)
            || chunk.embeddingKey !== textbookReferenceHash({ model: TEXTBOOK_REFERENCE_MODEL, text: chunk.embeddingText })
            || typeof chunk.sectionPath !== 'string' || typeof chunk.sectionKind !== 'string'
            || typeof chunk.forcedSplit !== 'boolean' || !validVector(chunk.embedding)) throw new Error('storage_unavailable');
          chunkIds.add(chunk.chunkId);
        }
      }
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, entries: [] };
      if (error instanceof Error && error.message === 'storage_unavailable') throw error;
      throw new Error('storage_unavailable');
    }
  }
  async function write(value: StoreFile): Promise<void> {
    try {
      await fs.mkdir(root, { recursive: true });
      await atomicWriteTextFile(file, JSON.stringify(value));
    } catch { throw new Error('storage_unavailable'); }
  }
  async function quarantineCorruptStore(): Promise<void> {
    try { await read(); return; }
    catch (error) {
      if (!(error instanceof Error) || error.message !== 'storage_unavailable') throw error;
    }
    try {
      const raw = await fs.readFile(file, 'utf8');
      const backup = path.join(root, `textbook-reference-embeddings.corrupt-${textbookReferenceHash(raw).slice(0, 20)}.json`);
      try { await fs.access(backup); await fs.unlink(file); }
      catch { await fs.rename(file, backup); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('storage_unavailable');
    }
  }
  const current = (noteId: string, token: number) => requests.get(noteId)?.token === token;

  async function status(noteId: string): Promise<TextbookReferenceIndexStatus> {
    const pending = requests.get(noteId);
    if (pending && ['queued', 'processing', 'failed'].includes(pending.status.status)) return publicStatus(pending.status);
    try {
      const entry = (await read()).entries.find((item) => item.noteId === noteId);
      if (!entry) return { noteId, status: 'missing', chunkCount: 0 };
      return entry.status === 'processing'
        ? { ...publicStatus(entry), status: 'failed', errorCode: 'interrupted' }
        : publicStatus(entry);
    } catch { return { noteId, status: 'unavailable', chunkCount: 0, errorCode: 'storage_unavailable' }; }
  }

  function syncNote(raw: NoteItem, force = false): Promise<void> {
    const note = structuredClone(raw);
    const input = textbookInput(note);
    const token = ++sequence;
    const sourceHash = input && input !== 'invalid' ? textbookReferenceSourceHash(input)
      : input === 'invalid' && note.textbook ? textbookReferenceHash({ noteId: note.id, textbook: note.textbook, invalid: true }) : undefined;
    const request: PendingRequest = { token, status: {
      noteId: note.id,
      textbookId: note.textbook?.textbookId,
      revisionId: note.textbook?.revisionId,
      status: 'queued',
      sourceHash,
      chunkCount: 0,
    } };
    requests.set(note.id, request);
    return serial(async () => {
      if (!current(note.id, token)) return;
      let data: StoreFile | undefined;
      let previous: Entry | undefined;
      try {
        data = await read();
        previous = data.entries.find((entry) => entry.noteId === note.id);
        if (!input) {
          if (previous) {
            data.entries = data.entries.filter((entry) => entry.noteId !== note.id);
            await write(data);
          }
          requests.delete(note.id);
          return;
        }
        if (input === 'invalid') {
          const invalid: Entry = {
            ...request.status,
            title: note.title,
            regionId: note.textbook?.regionId,
            model: TEXTBOOK_REFERENCE_MODEL,
            status: 'invalid',
            chunkCount: 0,
            errorCode: 'invalid_textbook',
            chunks: [],
          };
          if (previous?.status !== 'invalid' || previous.sourceHash !== sourceHash) {
            data.entries = [...data.entries.filter((entry) => entry.noteId !== note.id), invalid];
            await write(data);
          }
          request.status = publicStatus(invalid);
          return;
        }
        // Ordinary note saves stop here. Review-block changes do not alter this hash.
        if (!force && previous?.sourceHash === sourceHash) {
          if (previous.title !== note.title) {
            previous.title = note.title; await write(data);
          }
          if (previous.status === 'ready' || previous.status === 'empty') request.status = publicStatus(previous);
          else request.status = { ...publicStatus(previous), status: 'failed',
            errorCode: previous.status === 'processing' ? 'interrupted' : previous.errorCode || 'embedding_unavailable' };
          return;
        }
        const background = getBackgroundRagCompute();
        if (!background) throw new Error('embedding_unavailable');
        const processing: Entry = {
          noteId: input.noteId,
          textbookId: input.textbookId,
          revisionId: input.revisionId,
          regionId: input.regionId,
          title: input.title,
          model: TEXTBOOK_REFERENCE_MODEL,
          status: 'processing',
          sourceHash,
          chunkCount: 0,
          chunks: previous?.chunks || [],
        };
        data.entries = [...data.entries.filter((entry) => entry.noteId !== note.id), processing];
        request.status = publicStatus(processing);
        await write(data);
        const pieces = await background.chunkTextbook(input);
        if (!current(note.id, token)) return;
        const cache = new Map(!force && previous?.model === TEXTBOOK_REFERENCE_MODEL
          ? previous.chunks.map((chunk) => [chunk.embeddingKey, chunk.embedding] as const) : []);
        const missing = pieces.filter((piece) => !cache.has(piece.embeddingKey));
        const vectors = missing.length ? await background.embed(missing.map((piece) => piece.embeddingText)) : [];
        if (vectors.length !== missing.length || vectors.some((vector) => !validVector(vector))) throw new Error('embedding_unavailable');
        missing.forEach((piece, index) => cache.set(piece.embeddingKey, vectors[index]));
        const chunks: StoredChunk[] = pieces.map((piece) => ({ ...piece, embedding: [...cache.get(piece.embeddingKey)!] }));
        if (!current(note.id, token)) return;
        const ready: Entry = {
          ...processing,
          status: chunks.length ? 'ready' : 'empty',
          chunkCount: chunks.length,
          chunks,
          indexedAt: new Date().toISOString(),
        };
        data.entries = data.entries.map((entry) => entry.noteId === note.id ? ready : entry);
        await write(data);
        if (current(note.id, token)) request.status = publicStatus(ready);
      } catch (error) {
        if (!current(note.id, token)) return;
        const failed: Entry = {
          ...request.status,
          title: note.title,
          regionId: note.textbook?.regionId,
          model: TEXTBOOK_REFERENCE_MODEL,
          status: 'failed',
          chunkCount: 0,
          errorCode: errorCode(error),
          chunks: previous?.chunks || [],
        };
        request.status = publicStatus(failed);
        if (data) {
          data.entries = [...data.entries.filter((entry) => entry.noteId !== note.id), failed];
          await write(data).catch(() => undefined);
        }
        throw new Error(failed.errorCode);
      }
    });
  }

  async function syncNotes(notes: readonly NoteItem[]): Promise<void> {
    const snapshot = structuredClone(notes);
    const textbooks = snapshot.filter((note) => note.noteType === 'project' && note.textbook);
    const live = new Set(textbooks.map((note) => note.id));
    // The index is disposable derived data. Preserve a corrupt copy for diagnosis,
    // then allow this startup/save pass to rebuild it once from current textbooks.
    await quarantineCorruptStore();
    await Promise.allSettled(textbooks.map((note) => syncNote(note)));
    await serial(async () => {
      const data = await read();
      const entries = data.entries.filter((entry) => live.has(entry.noteId));
      if (entries.length !== data.entries.length) await write({ ...data, entries });
    });
  }

  async function search(query: string, limit = 3, allowedNoteIds?: readonly string[]): Promise<TextbookReferenceSearchResult[]> {
    const q = query.trim();
    const safeLimit = Math.max(0, Math.min(12, Math.trunc(limit)));
    const allowed = allowedNoteIds === undefined ? undefined : new Set(allowedNoteIds);
    if (!q || !safeLimit || allowed?.size === 0) return [];
    const entries = (await read()).entries.filter((entry) => entry.status === 'ready'
      && entry.model === TEXTBOOK_REFERENCE_MODEL && (!allowed || allowed.has(entry.noteId))
      && (!requests.has(entry.noteId) || requests.get(entry.noteId)?.status.sourceHash === entry.sourceHash
        && requests.get(entry.noteId)?.status.status === 'ready'));
    const rows = entries.flatMap((entry) => entry.chunks.map((chunk) => ({ entry, chunk })));
    if (!rows.length) return [];
    const background = getBackgroundRagCompute();
    const queryVector = background ? (await background.embed([q]).catch(() => [[]]))[0] || [] : [];
    const texts = rows.map((row) => row.chunk.embeddingText);
    const df = buildDf(texts), queryTokens = tokenize(q);
    const averageLength = texts.reduce((sum, text) => sum + tokenize(text).length, 0) / Math.max(1, texts.length);
    const vector = validVector(queryVector) ? queryVector : [];
    const ranked = rows.map((row) => ({
      ...row,
      dense: vector.length ? Math.max(0, cosineSimilarity(vector, row.chunk.embedding)) : 0,
      sparse: bm25Score(queryTokens, row.chunk.embeddingText, df, rows.length, averageLength),
    })).filter((row) => row.dense >= 0.25 || row.sparse > 0);
    const scores = weightedFusion(ranked.map((row) => ({ id: `${row.entry.noteId}/${row.chunk.chunkId}`, dense: row.dense, sparse: row.sparse })), 0.35);
    return ranked.sort((left, right) => (scores.get(`${right.entry.noteId}/${right.chunk.chunkId}`) || 0)
      - (scores.get(`${left.entry.noteId}/${left.chunk.chunkId}`) || 0)).slice(0, safeLimit).map(({ entry, chunk, dense }) => ({
        noteId: entry.noteId,
        textbookId: entry.textbookId!,
        revisionId: entry.revisionId!,
        title: entry.title,
        score: dense,
        snippet: chunk.content.slice(0, 650),
        chunkId: chunk.chunkId,
        sourceHash: entry.sourceHash!,
        textStart: chunk.textStart,
        textEnd: chunk.textEnd,
        sectionPath: chunk.sectionPath,
        sectionKind: chunk.sectionKind,
        forcedSplit: chunk.forcedSplit,
      }));
  }

  function removeNote(noteId: string): Promise<void> {
    requests.delete(noteId);
    return serial(async () => {
      const data = await read(), entries = data.entries.filter(entry => entry.noteId !== noteId);
      if (entries.length !== data.entries.length) await write({ ...data, entries });
    });
  }
  return { syncNote, syncNotes, removeNote, status, search };
}
