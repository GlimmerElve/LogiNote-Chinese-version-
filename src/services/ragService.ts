import { NoteItem, NoteEmbedding, NoteSearchResult } from "../types";
import { generateEmbedding, cosineSimilarity } from "./embeddingService";
import { readAllNoteEmbeddings, writeNoteEmbeddings, deleteNoteEmbeddings } from "./storage";

/**
 * 笔记 RAG 服务（P0）
 *
 * Electron 环境：走主进程 noteRag（中文模型 paraphrase-multilingual-MiniLM-L12-v2 + 混合检索），
 *   解决 renderer 旧实现「英文模型 + 纯 dense」导致的中文匹配不准问题。
 * Web 环境：回退浏览器端本地 embeddingService（保持原逻辑，兼容非 Electron 场景）。
 */

/* ===== Electron 主进程路径（优先） ===== */

function noteRagApi(): { index: (i: { id: string; title: string; content: string }) => Promise<void>; indexAll: (inputs: Array<{ id: string; title: string; content: string }>) => Promise<void>; delete: (id: string) => Promise<void>; search: (q: string, k?: number) => Promise<NoteSearchResult[]> } | null {
  const api = (window as any).electronAPI?.noteRag;
  return api || null;
}

/* ===== Web 端回退路径（原逻辑） ===== */

/** 已知的占位正文（新建笔记默认内容），不应纳入索引 */
const PLACEHOLDER_CONTENTS = new Set([
  '请对该知识点进行定义描述',
]);

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
  const raw = (note.content || '').trim();
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
  const body = cleanForEmbedding(note.content || '');
  const truncated = body.length > 800 ? body.slice(0, 800) : body;
  return `${note.title}\n${truncated}`;
}

/** 为单篇笔记建立/更新索引；无实质正文则移除过期索引 */
export async function indexNote(note: NoteItem): Promise<void> {
  const api = noteRagApi();
  if (api) {
    await api.index({ id: note.id, title: note.title, content: note.content });
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
    title: note.title,
    snippet: text.slice(0, 200),
    embedding,
    updatedAt: new Date().toISOString(),
  };
  await writeNoteEmbeddings([record]);
}

/** 全量重建索引（Electron 主进程用中文模型批量重建，Web 端逐条回退） */
export async function indexAllNotes(notes: NoteItem[]): Promise<void> {
  const api = noteRagApi();
  if (api) {
    await api.indexAll(notes.map((n) => ({ id: n.id, title: n.title, content: n.content })));
    return;
  }
  for (const n of notes) {
    try {
      await indexNote(n);
    } catch (e) {
      console.warn('[rag] 重建索引失败:', n.title, e);
    }
  }
}

/** 语义检索：返回与 query 最相关的 top-k 篇笔记 */
export async function searchNotes(query: string, k: number = 5): Promise<NoteSearchResult[]> {
  const api = noteRagApi();
  if (api) {
    return api.search(query, k);
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

  const scored = all
    .map(e => ({
      noteId: e.noteId,
      title: e.title,
      snippet: e.snippet,
      score: cosineSimilarity(queryVec, e.embedding),
    }))
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);

  return scored;
}

/** 删除指定笔记的索引 */
export async function deleteNoteIndex(noteId: string): Promise<void> {
  const api = noteRagApi();
  if (api) {
    await api.delete(noteId);
    return;
  }
  await deleteNoteEmbeddings(noteId);
}

/** 从检索结果拼接一段适合注入 LLM 上下文的文本 */
export function buildRagContext(results: NoteSearchResult[], topN: number = 3): string {
  if (!results || results.length === 0) return '';
  const parts = results.slice(0, topN).map((r, i) =>
    `${i + 1}. 笔记「${r.title}」（相关度 ${(r.score * 100).toFixed(1)}%）：${r.snippet}`
  );
  return `以下是从用户笔记库中检索到的相关知识点，请结合这些内容回答：\n${parts.join('\n')}`;
}