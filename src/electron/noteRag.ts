import { promises as fs } from 'fs';
import path from 'path';
import { generateEmbedding, cosineSimilarity } from './ragIndex';
import { tokenize, buildDf, bm25Score, weightedFusion } from './hybridSearch';

/**
 * 笔记本体 RAG（运行在 Electron 主进程）。
 *
 * 与资料文档 RAG 共用同一套中文嵌入模型（paraphrase-multilingual-MiniLM-L12-v2）
 * 与同一个 hybridSearch 混合检索工具，解决 renderer 端旧实现的三个缺陷：
 *   1. 英文模型 all-MiniLM-L6-v2 对中文区分度极差；
 *   2. 纯 dense 检索、无关键词兜底、无阈值；
 *   3. renderer 无法离线加载本地模型。
 *
 * 存储：`<dataRoot>/note-embeddings.json`（NoteRagRecord[]，key 语义为 noteId）。
 */

interface NoteRagRecord {
  noteId: string;
  title: string;
  /** 用于 BM25 与展示的文本（标题 + 截断正文） */
  text: string;
  snippet: string;
  embedding: number[];
  updatedAt: string;
}

export interface NoteRagIndexInput {
  id: string;
  title: string;
  content: string;
}

export interface NoteRagSearchResult {
  noteId: string;
  title: string;
  score: number;
  snippet: string;
}

let dataRoot = '';

export function setNoteRagDataRoot(root: string): void {
  dataRoot = root;
}

function dbFile(): string {
  return path.join(dataRoot, 'note-embeddings.json');
}

async function readAll(): Promise<NoteRagRecord[]> {
  try {
    const text = await fs.readFile(dbFile(), 'utf-8');
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? (arr as NoteRagRecord[]) : [];
  } catch {
    return [];
  }
}

async function writeAll(records: NoteRagRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(dbFile()), { recursive: true });
  await fs.writeFile(dbFile(), JSON.stringify(records), 'utf-8');
}

/** 已知占位正文（新建笔记默认内容），不应纳入索引 */
const PLACEHOLDER_CONTENTS = new Set(['请对该知识点进行定义描述']);

/** 去除 markdown 符号、HTML 标签、base64 内嵌图，仅保留实质文字 */
function cleanForEmbedding(c: string): string {
  return (c || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/data:image\/[^)\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 拼接用于嵌入与检索的文本：标题 + 正文（正文过长截取首部） */
function buildEmbeddingText(title: string, content: string): string {
  const body = cleanForEmbedding(content);
  const truncated = body.length > 800 ? body.slice(0, 800) : body;
  return `${title}\n${truncated}`;
}

/** 判断笔记是否有值得索引的实质正文 */
function hasSubstantiveContent(content: string): boolean {
  const raw = (content || '').trim();
  if (!raw) return false;
  if (PLACEHOLDER_CONTENTS.has(raw)) return false;
  return cleanForEmbedding(raw).length >= 2;
}

export async function indexNote(input: NoteRagIndexInput): Promise<void> {
  const records = await readAll();
  const idx = records.findIndex((r) => r.noteId === input.id);

  if (!hasSubstantiveContent(input.content)) {
    // 无实质正文：移除过期索引
    if (idx !== -1) {
      records.splice(idx, 1);
      await writeAll(records);
    }
    return;
  }

  const text = buildEmbeddingText(input.title, input.content);
  const embedding = await generateEmbedding(text);
  if (!embedding || embedding.length === 0) {
    console.warn('[note-rag] 嵌入生成失败，跳过索引:', input.title);
    return;
  }

  const record: NoteRagRecord = {
    noteId: input.id,
    title: input.title,
    text,
    snippet: text.slice(0, 200),
    embedding,
    updatedAt: new Date().toISOString(),
  };

  if (idx !== -1) records[idx] = record;
  else records.push(record);
  await writeAll(records);
}

/** 批量索引（全量重建用）。逐条复用 indexNote，串行推进避免模型并发峰值。 */
export async function indexNotes(inputs: NoteRagIndexInput[]): Promise<void> {
  for (const input of inputs) {
    try {
      await indexNote(input);
    } catch (e) {
      console.warn('[note-rag] 索引失败:', input.title, e);
    }
  }
}

export async function deleteNoteIndex(noteId: string): Promise<void> {
  const records = await readAll();
  await writeAll(records.filter((r) => r.noteId !== noteId));
}

export async function countNotes(): Promise<number> {
  return (await readAll()).length;
}

/** 语义 + 关键词混合检索，返回与 query 最相关的 top-k 篇笔记 */
export async function searchNotes(query: string, k = 5): Promise<NoteRagSearchResult[]> {
  const q = (query || '').trim();
  if (!q) return [];

  const records = await readAll();
  if (records.length === 0) return [];

  const qv = await generateEmbedding(q);
  if (!qv || qv.length === 0) return [];

  // 稀疏：BM25（对 title + 正文）
  const queryTokens = tokenize(q);
  const texts = records.map((r) => r.text);
  const df = buildDf(texts);
  const lens = texts.map((t) => Math.max(tokenize(t).length, 1));
  const avgLen = lens.reduce((a, b) => a + b, 0) / Math.max(records.length, 1);
  const sparse = records.map((r) =>
    bm25Score(queryTokens, r.text, df, records.length, avgLen),
  );

  // 密集：余弦
  const dense = records.map((r) => cosineSimilarity(qv, r.embedding));

  // 阈值过滤：语义与关键词「都无关」的直接丢弃
  const SEMANTIC_THRESHOLD = 0.25;
  const survivors = records
    .map((r, i) => ({ r, dense: dense[i], sparse: sparse[i] }))
    .filter((x) => x.dense >= SEMANTIC_THRESHOLD || x.sparse > 0);

  if (survivors.length === 0) return [];

  // 加权融合：关键词分（0.65 权重）略占优
  const fused = weightedFusion(
    survivors.map((x) => ({ id: x.r.noteId, dense: x.dense, sparse: x.sparse })),
    0.35,
  );

  // 精确短语加成
  const qCompact = q.replace(/\s+/g, '');

  return survivors
    .map((x) => {
      const textCompact = x.r.text.replace(/\s+/g, '');
      const bonus = qCompact.length >= 2 && textCompact.includes(qCompact) ? 0.5 : 0;
      return {
        noteId: x.r.noteId,
        title: x.r.title,
        score: x.dense,
        snippet: x.r.snippet,
        fusedScore: (fused.get(x.r.noteId) || 0) + bonus,
      };
    })
    .sort((a, b) => b.fusedScore - a.fusedScore)
    .slice(0, k)
    .map(({ noteId, title, score, snippet }) => ({ noteId, title, score, snippet }));
}