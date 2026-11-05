import { NoteItem, NoteEmbedding, NoteRagIndexInput, NoteSearchResult, UserArgumentNodeHit, NoteReferencePassageRef } from "../types";
import { generateEmbedding, cosineSimilarity } from "./embeddingService";
import { readAllNoteEmbeddings, writeNoteEmbeddings, deleteNoteEmbeddings, deleteNoteEmbeddingsMany, readNotesForCognition } from "./storage";
import { hasSubstantiveReferenceText, referenceNoteContent } from './ragSourcePolicy';
import { createDeferredNoteIndex } from './deferredNoteIndex';

/**
 * 笔记 RAG 服务（P0）
 *
 * Electron 环境：走主进程 noteRag（中文模型 paraphrase-multilingual-MiniLM-L12-v2 + 混合检索），
 *   解决 renderer 旧实现「英文模型 + 纯 dense」导致的中文匹配不准问题。
 * Web 环境：回退浏览器端本地 embeddingService（保持原逻辑，兼容非 Electron 场景）。
 */

/* ===== Electron 主进程路径（优先） ===== */

function noteRagApi(): { index: (i: NoteRagIndexInput) => Promise<void>; indexAll: (inputs: NoteRagIndexInput[]) => Promise<void>; delete: (id: string) => Promise<void>; deleteMany?: (ids: string[]) => Promise<void>; search: (q: string, k?: number, options?: { allowedNoteIds: string[] }) => Promise<NoteSearchResult[]> } | null {
  const api = (window as any).electronAPI?.noteRag;
  return api || null;
}

/** Nonblocking maintenance wake-up, never a claim that an index is ready. */
export async function requestNoteIndexRefresh(): Promise<void> {
  const api = (window as any).electronAPI?.noteRag;
  if (api) await api.flushPending?.(); else browserNoteIndex.flush();
}

export async function setNoteIndexEditing(active: boolean): Promise<void> {
  const api = (window as any).electronAPI?.noteRag;
  if (api) await api.setEditing?.(active); else browserNoteIndex.setEditing(0, active);
}

let browserSavedNotes: NoteItem[] = [];
const browserNoteIndex = createDeferredNoteIndex({ run: () => indexAllNotes(browserSavedNotes),
  onError: () => console.warn('[note-rag] 后台索引失败，笔记已保存，可稍后重试') });
export function scheduleSavedBrowserNoteIndex(notes: NoteItem[]): void {
  browserSavedNotes = notes;
  browserNoteIndex.request();
}

/* ===== Web 端回退路径（原逻辑） ===== */

/** 已知的占位正文（新建笔记默认内容），不应纳入索引 */
const PLACEHOLDER_CONTENTS = new Set([
  '请对该知识点进行定义描述',
]);

/** 资料通道只读取知识点正文；用户论证图属于个人认知素材。 */
export function buildNoteRagContent(note: NoteItem): string {
  return referenceNoteContent(note);
}

/** 笔记正文与发布快照分通道同步：draft 从不出现在主进程论证 shard 中。 */
export function buildNoteRagIndexInput(note: NoteItem): NoteRagIndexInput {
  return {
    id: note.id,
    title: note.title,
    noteType: note.noteType,
    generatedContentBlocks: note.generatedContentBlocks,
    textbook: note.textbook,
    learningReviewRecords: note.learningReviewRecords,
    content: note.content || '',
    updatedAt: note.updatedAt,
    referenceSources: note.referenceSources,
    publishedArguments: (note.argumentDocs || []).flatMap((doc) => doc.rag?.publishedSnapshot
      ? [{ argumentDocId: doc.doc_id, snapshot: doc.rag.publishedSnapshot }]
      : []),
  };
}

function normalizeArgumentHits(value: unknown): UserArgumentNodeHit[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hits = value.slice(0, 8).flatMap((item): UserArgumentNodeHit[] => {
    if (!item || typeof item !== 'object') return [];
    const candidate = item as Partial<UserArgumentNodeHit>;
    const mainTypes = new Set(['定义', '命名', '对比', '假设', '举例', '事实陈述', '推理', '反例削弱', '建议对策']);
    if (typeof candidate.argumentId !== 'string' || typeof candidate.argumentDocId !== 'string'
      || typeof candidate.revisionHash !== 'string' || typeof candidate.nodeId !== 'string'
      || typeof candidate.text !== 'string' || !mainTypes.has(candidate.mainType || '')
      || !['concept', 'judgment', 'logic'].includes(candidate.layer || '')
      || !['direct', 'expanded'].includes(candidate.match || '')) return [];
    const sources = Array.isArray(candidate.sources) ? candidate.sources.slice(0, 20).flatMap((source) => {
      if (!source || typeof source !== 'object') return [];
      const item = source as NonNullable<UserArgumentNodeHit['sources']>[number];
      if ((item.type !== 'note' && item.type !== 'document') || typeof item.entityId !== 'string'
        || typeof item.quote !== 'string' || typeof item.verifiedAt !== 'string'
        || (item.type === 'document' && typeof item.chunkId !== 'string')) return [];
      return [{
        type: item.type,
        entityId: item.entityId.slice(0, 500),
        chunkId: item.chunkId?.slice(0, 500),
        title: item.title?.slice(0, 500),
        quote: item.quote.trim().slice(0, 5000),
        sectionPath: Array.isArray(item.sectionPath) ? item.sectionPath.slice(0, 20).map((part) => String(part).slice(0, 500)) : undefined,
        verifiedAt: item.verifiedAt,
      }];
    }) : undefined;
    return [{
      argumentId: candidate.argumentId.slice(0, 500),
      argumentDocId: candidate.argumentDocId.slice(0, 200),
      revisionHash: candidate.revisionHash.slice(0, 200),
      nodeId: candidate.nodeId.slice(0, 200),
      mainType: candidate.mainType!,
      layer: candidate.layer!,
      text: candidate.text.trim().slice(0, 900),
      match: candidate.match!,
      relationDirection: ['supports', 'supported_by', 'opposes', 'opposed_by'].includes(candidate.relationDirection || '')
        ? candidate.relationDirection
        : undefined,
      sources: sources?.length ? sources : undefined,
    }];
  });
  return hits.length ? hits : undefined;
}

/** Electron IPC / 本地索引共用的检索结果信任边界。 */
export function normalizeNoteSearchResults(value: unknown, limit = 5): NoteSearchResult[] {
  if (!Array.isArray(value)) return [];
  const safeLimit = Math.max(0, Math.floor(limit));
  if (safeLimit === 0) return [];
  const seen = new Set<string>();
  const normalized: NoteSearchResult[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const candidate = item as Partial<NoteSearchResult>;
    const noteId = typeof candidate.noteId === 'string' ? candidate.noteId.trim() : '';
    const title = typeof candidate.title === 'string' ? candidate.title.trim() : '';
    const snippet = typeof candidate.snippet === 'string' ? candidate.snippet.trim().slice(0, 500) : '';
    const score = typeof candidate.score === 'number' && Number.isFinite(candidate.score)
      ? Math.max(0, Math.min(1, candidate.score))
      : NaN;
    // Fail closed for old/mixed IPC results even during a derived index rebuild.
    if (candidate.noteType !== 'knowledge' || candidate.evidenceOrigin === 'user-argument-doc'
      || (Array.isArray(candidate.matchKinds) && candidate.matchKinds.includes('argument')) || candidate.argumentHits?.length) continue;
    if (!noteId || !title || !snippet || !Number.isFinite(score) || seen.has(noteId)) continue;
    let passage: NoteReferencePassageRef | undefined;
    if (candidate.passage !== undefined) {
      const p = candidate.passage;
      if (!p || typeof p !== 'object' || p.schemaVersion !== 2 || typeof p.chunkId !== 'string' || !p.chunkId
        || typeof p.sourceHash !== 'string' || !/^[a-f0-9]{64}$/u.test(p.sourceHash)
        || !Number.isSafeInteger(p.textStart) || !Number.isSafeInteger(p.textEnd) || p.textStart < 0 || p.textEnd <= p.textStart
        || typeof p.sectionPath !== 'string' || typeof p.forcedSplit !== 'boolean'
        || !['definition', 'condition', 'fact', 'example', 'reasoning', 'sources', 'general'].includes(p.sectionKind)
        || (p.sourceUpdatedAt !== undefined && typeof p.sourceUpdatedAt !== 'string')) continue;
      passage = { schemaVersion: 2, chunkId: p.chunkId.slice(0, 100), sourceHash: p.sourceHash,
        sourceUpdatedAt: p.sourceUpdatedAt, textStart: p.textStart, textEnd: p.textEnd,
        sectionPath: p.sectionPath.slice(0, 1000), sectionKind: p.sectionKind, forcedSplit: p.forcedSplit };
    }
    seen.add(noteId);
    const matchKinds = Array.isArray(candidate.matchKinds)
      ? [...new Set(candidate.matchKinds.filter((kind): kind is 'note' | 'argument' => kind === 'note' || kind === 'argument'))]
      : undefined;
    const evidenceOrigin = candidate.evidenceOrigin === 'note-passage' || candidate.evidenceOrigin === 'user-argument-doc'
      ? candidate.evidenceOrigin
      : undefined;
    const admission = candidate.admission === 'admitted' || candidate.admission === 'limited' ? candidate.admission : undefined;
    const evidenceGrade = ['A', 'B', 'C', 'ungraded'].includes(candidate.evidenceGrade || '')
      ? candidate.evidenceGrade
      : undefined;
    const result: NoteSearchResult = { noteId, noteType: 'knowledge', title, snippet, score };
    if (passage) result.passage = passage;
    if (matchKinds?.length) result.matchKinds = matchKinds;
    const argumentHits = normalizeArgumentHits(candidate.argumentHits);
    if (argumentHits) result.argumentHits = argumentHits;
    const relationSummary = typeof candidate.relationSummary === 'string'
      ? candidate.relationSummary.trim().slice(0, 700)
      : '';
    if (relationSummary) result.relationSummary = relationSummary;
    if (evidenceOrigin) result.evidenceOrigin = evidenceOrigin;
    if (admission) result.admission = admission;
    if (evidenceGrade) result.evidenceGrade = evidenceGrade;
    normalized.push(result);
    if (normalized.length >= safeLimit) break;
  }
  return normalized;
}

/** 去除 markdown 符号、HTML 标签、base64 内嵌图与空白，仅保留实际文字 */
function normalizeContent(c: string): string {
  return (c || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/data:image\/[^)\s]+/g, ' ')
    .replace(/[#>*_`\-[\]()\s]/g, '')
    .trim();
}

/** 判断笔记是否有值得索引的实质正文 */
function hasSubstantiveContent(note: NoteItem): boolean {
  const raw = buildNoteRagContent(note).trim();
  if (!raw) return false;
  if (PLACEHOLDER_CONTENTS.has(raw)) return false;
  return normalizeContent(raw).length >= 2;
}

/** 轻量清洗：去除 HTML 标签与 base64 内嵌数据体，保留正常文字与标点（供向量化使用） */
function cleanForEmbedding(c: string): string {
  return (c || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/data:image\/[^)\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 拼接用于嵌入的文本：标题 + 正文（正文过长时截取首部） */
function buildEmbeddingText(note: NoteItem): string {
  return `${note.title}\n${cleanForEmbedding(buildNoteRagContent(note)).slice(0, 600)}`;
}

/** 为单篇笔记建立/更新索引；无实质正文则移除过期索引 */
export async function indexNote(note: NoteItem): Promise<void> {
  const api = noteRagApi();
  if (api) {
    await api.index(buildNoteRagIndexInput(note));
    return;
  }

  if (!hasSubstantiveContent(note)) {
    await deleteNoteEmbeddings(note.id);
    return;
  }
  const text = buildEmbeddingText(note);
  const embedding = await generateEmbedding(text);
  if (!embedding || embedding.length === 0) {
    console.warn('[rag] 嵌入生成失败，跳过索引:', note.title);
    return;
  }
  const record: NoteEmbedding = {
    noteId: note.id,
    noteType: 'knowledge',
    title: note.title,
    snippet: text.slice(0, 200),
    embedding,
    updatedAt: new Date().toISOString(),
    sourceUpdatedAt: note.updatedAt,
  };
  await writeNoteEmbeddings([record]);
}

/** 全量重建索引（Electron 主进程用中文模型批量重建，Web 端逐条回退） */
export async function indexAllNotes(notes: NoteItem[]): Promise<void> {
  const api = noteRagApi();
  if (api) {
    await api.indexAll(notes.map(buildNoteRagIndexInput));
    return;
  }
  const existing = new Map((await readAllNoteEmbeddings()).map(item => [item.noteId, item]));
  for (const n of notes) {
    const old = existing.get(n.id);
    if (old?.sourceUpdatedAt === n.updatedAt && old.noteType === n.noteType && old.title === n.title) continue;
    try {
      await indexNote(n);
    } catch (e) {
      console.warn('[rag] 重建索引失败:', n.title, e);
    }
  }
  const live = new Set(notes.filter((n) => n.noteType === 'knowledge').map((n) => n.id));
  for (const old of await readAllNoteEmbeddings()) {
    if (!live.has(old.noteId) || old.noteType !== 'knowledge') await deleteNoteEmbeddings(old.noteId);
  }
}

/** 语义检索：返回与 query 最相关的 top-k 篇笔记 */
export async function searchNotes(query: string, k: number = 5, options?: { allowedNoteIds?: string[] }): Promise<NoteSearchResult[]> {
  const allowed = options?.allowedNoteIds;
  if (allowed?.length === 0) return [];
  const api = noteRagApi();
  if (api) {
    const hits = await api.search(query, k, allowed ? { allowedNoteIds: allowed } : undefined);
    return normalizeNoteSearchResults(hits, Array.isArray(hits) ? hits.length : k)
      .filter(hit => (!allowed || allowed.includes(hit.noteId)) && hasSubstantiveReferenceText(hit.snippet)).slice(0, k);
  }

  const q = query.trim();
  if (!q) return [];

  const queryVec = await generateEmbedding(q);
  if (!queryVec || queryVec.length === 0) {
    console.warn('[rag] query 向量化失败');
    return [];
  }

  const all = await readAllNoteEmbeddings();
  if (all.length === 0) return [];
  let saved: Map<string, NoteItem>;
  try { saved = new Map((await readNotesForCognition()).map(note => [note.id, note])); }
  catch { return []; } // Missing/malformed saved authority cannot validate an older cache.

  const scored = all
    .filter((e) => { const source = saved.get(e.noteId); return source?.noteType === 'knowledge'
      && e.sourceUpdatedAt === source.updatedAt && e.title === source.title
      && e.noteType === 'knowledge' && (!allowed || allowed.includes(e.noteId)) && hasSubstantiveReferenceText(e.snippet); })
    .map(e => ({
      noteId: e.noteId,
      noteType: 'knowledge' as const,
      title: e.title,
      snippet: e.snippet,
      score: cosineSimilarity(queryVec, e.embedding),
    }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return normalizeNoteSearchResults(scored, k);
}

/** 删除指定笔记的索引 */
export async function deleteNoteIndex(noteId: string): Promise<void> {
  return deleteNoteIndexes([noteId]);
}

export async function deleteNoteIndexes(noteIds: string[]): Promise<void> {
  const ids = [...new Set(noteIds)];
  if (!ids.length) return;
  const api = noteRagApi();
  if (api) {
    if (api.deleteMany) await api.deleteMany(ids);
    else for (const id of ids) await api.delete(id);
    return;
  }
  await deleteNoteEmbeddingsMany(ids);
}

/** Desktop searches validate saved live sources, so derived maintenance need not
 * hold the deletion dialog/write queue. Web awaits its bounded IDB transaction
 * because its legacy search has no saved-source authority check. */
export async function finishDeletedNoteIndexCleanup(noteIds: string[]): Promise<void> {
  if (!noteRagApi()) return deleteNoteIndexes(noteIds);
  void deleteNoteIndexes(noteIds).catch(error => {
    // A later saved-snapshot/index-all sync prunes these same stale derivatives.
    console.warn('[note-rag] 笔记已删除，派生索引清理待后续同步重试', error);
  });
}

/** 从检索结果拼接一段适合注入 LLM 上下文的文本 */
export function buildRagContext(results: NoteSearchResult[], topN: number = 3): string {
  const reference = normalizeNoteSearchResults(results, topN);
  if (!reference.length) return '';
  const parts = reference.map((r, i) =>
    `${i + 1}. 笔记「${r.title}」（相关度 ${(r.score * 100).toFixed(1)}%）：${r.snippet}`
  );
  return `以下是知识点笔记中的参考材料，未经自动事实验证，不代表用户个人立场：\n${parts.join('\n')}`;
}
