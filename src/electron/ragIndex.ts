import { promises as fs } from 'fs';
import path from 'path';
import type {
  UploadedDocument,
  DocumentChunk,
  DocumentSearchResult,
} from '../types';
import { tokenize, buildDf, bm25Score, weightedFusion } from './hybridSearch';

/**
 * 资料文档 RAG 后端（运行在 Electron 主进程）。
 *
 * 文件布局：
 * - `<dataRoot>/documents/`        原始上传文件（按 docId 保留扩展名）
 * - `<dataRoot>/rag-index/manifest.json`  文档元数据（UploadedDocument[]）
 * - `<dataRoot>/rag-index/chunks-<docId>.json`  单个文档的分块 + 向量
 *
 * dataRoot 由 main.ts 启动时通过 setDataRoot() 注入。
 */

let dataRoot = '';

export function setDataRoot(root: string): void {
  dataRoot = root;
}

function documentsDir(): string {
  return path.join(dataRoot, 'documents');
}

function ragIndexDir(): string {
  return path.join(dataRoot, 'rag-index');
}

async function ensureDirs(): Promise<void> {
  await fs.mkdir(documentsDir(), { recursive: true });
  await fs.mkdir(ragIndexDir(), { recursive: true });
}

export async function getDocumentsDir(): Promise<string> {
  await ensureDirs();
  return documentsDir();
}

export async function getRagIndexDir(): Promise<string> {
  await ensureDirs();
  return ragIndexDir();
}

/* ===== 分块 ===== */

const CHUNK_CHARS = 350;   // 单块字数上限（落在模型 512 token 内）
const OVERLAP_CHARS = 50;  // 相邻块重叠

interface Section {
  sectionPath: string;
  content: string;
}

/** 识别 Markdown 标题（# ～ ######），按层级构建 sectionPath */
function splitIntoSections(text: string): Section[] {
  const lines = text.split('\n');
  const sections: Section[] = [];
  const headingStack: string[] = [];
  let currentPath = '';
  let currentContent: string[] = [];

  const flush = () => {
    const body = currentContent.join('\n').trim();
    if (body) sections.push({ sectionPath: currentPath, content: body });
    currentContent = [];
  };

  for (const line of lines) {
    const m = line.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      flush();
      const level = m[1].length;
      headingStack.length = level - 1;
      headingStack.push(m[2].trim());
      currentPath = headingStack.join(' > ');
    } else {
      currentContent.push(line);
    }
  }
  flush();
  return sections;
}

/** 超长段按句子边界 + 重叠窗口切分 */
function splitBySentences(sectionPath: string, content: string): Section[] {
  // 保留分隔符切句（中文句号问号叹号、英文句点、换行）
  const sentences = content.split(/(?<=[。！？!?.\n])/);
  const out: Section[] = [];
  let buf = '';
  for (const s of sentences) {
    if (buf.trim() && (buf + s).length > CHUNK_CHARS) {
      out.push({ sectionPath, content: buf.trim() });
      // 重叠：保留块尾 OVERLAP_CHARS 作为下一块开头
      buf = buf.slice(-OVERLAP_CHARS) + s;
    } else {
      buf += s;
    }
  }
  if (buf.trim()) out.push({ sectionPath, content: buf.trim() });
  return out;
}

/** 长段切分：先按空行分段（段落语义优先），超长段落再按句子递归切 */
function splitLongSection(sectionPath: string, content: string): Section[] {
  const paragraphs = content
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out: Section[] = [];
  for (const para of paragraphs) {
    if (para.length <= CHUNK_CHARS) {
      out.push({ sectionPath, content: para });
    } else {
      out.push(...splitBySentences(sectionPath, para));
    }
  }
  return out;
}

/** 对外分块入口：结构优先 + 句子对齐 + 重叠 + sectionPath */
export function chunkText(text: string): Array<{ sectionPath: string; content: string }> {
  const raw = (text || '').replace(/\r\n/g, '\n').trim();
  if (!raw) return [];

  const sections = splitIntoSections(raw);
  const chunks: Array<{ sectionPath: string; content: string }> = [];
  for (const sec of sections) {
    if (sec.content.length <= CHUNK_CHARS) {
      chunks.push(sec);
    } else {
      chunks.push(...splitLongSection(sec.sectionPath, sec.content));
    }
  }
  return chunks;
}

/* ===== 向量化 ===== */

let modelsDir = '';
let pipelinePromise: Promise<any> | null = null;

/** 由 main.ts 注入本地模型根目录（app.getAppPath()/models），实现离线加载 */
export function setModelsDir(dir: string): void {
  modelsDir = dir;
}

function getPipeline(): Promise<any> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const { pipeline, env } = await import('@xenova/transformers');
      // 指向本地 models 根目录，用模型 ID 加载（会拼成 models/Xenova/paraphrase...），并禁止联网
      env.localModelPath = modelsDir;
      env.allowRemoteModels = false;
      return pipeline('feature-extraction', 'Xenova/paraphrase-multilingual-MiniLM-L12-v2');
    })();
  }
  return pipelinePromise;
}

/** 生成 384 维归一化向量 */
export async function generateEmbedding(text: string): Promise<number[]> {
  const pipe = await getPipeline();
  const result = await pipe(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data as Float32Array);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** 切块并逐块向量化，返回 chunk 列表（不含落地） */
export async function vectorizeDocument(
  docId: string,
  fileName: string,
  text: string,
): Promise<DocumentChunk[]> {
  const pieces = chunkText(text);
  const chunks: DocumentChunk[] = [];
  for (let i = 0; i < pieces.length; i++) {
    const embedding = await generateEmbedding(pieces[i].content);
    chunks.push({
      id: `${docId}#${i}`,
      docId,
      fileName,
      index: i,
      sectionPath: pieces[i].sectionPath,
      content: pieces[i].content,
      embedding,
    });
  }
  return chunks;
}

/* ===== chunks 文件读写 ===== */

function chunksFile(docId: string): string {
  return path.join(ragIndexDir(), `chunks-${docId}.json`);
}

export async function writeChunksFile(docId: string, chunks: DocumentChunk[]): Promise<void> {
  await ensureDirs();
  await fs.writeFile(chunksFile(docId), JSON.stringify(chunks), 'utf-8');
}

export async function readChunksFile(docId: string): Promise<DocumentChunk[]> {
  try {
    const text = await fs.readFile(chunksFile(docId), 'utf-8');
    return JSON.parse(text) as DocumentChunk[];
  } catch {
    return [];
  }
}

/** 读取指定 docId 集合的所有 chunks（用于检索） */
async function readAllChunks(docIds: string[]): Promise<DocumentChunk[]> {
  const all: DocumentChunk[] = [];
  for (const id of docIds) {
    all.push(...(await readChunksFile(id)));
  }
  return all;
}

export async function deleteChunksFile(docId: string): Promise<void> {
  try {
    await fs.unlink(chunksFile(docId));
  } catch {
    /* 不存在则忽略 */
  }
}

/* ===== manifest（文档元数据） ===== */

function manifestFile(): string {
  return path.join(ragIndexDir(), 'manifest.json');
}

export async function readManifest(): Promise<UploadedDocument[]> {
  await ensureDirs();
  try {
    const text = await fs.readFile(manifestFile(), 'utf-8');
    const arr = JSON.parse(text);
    return Array.isArray(arr) ? (arr as UploadedDocument[]) : [];
  } catch {
    return [];
  }
}

export async function writeManifest(docs: UploadedDocument[]): Promise<void> {
  await ensureDirs();
  await fs.writeFile(manifestFile(), JSON.stringify(docs, null, 2), 'utf-8');
}

export async function upsertManifestEntries(entries: UploadedDocument[]): Promise<UploadedDocument[]> {
  const docs = await readManifest();
  const map = new Map(docs.map((d) => [d.id, d]));
  for (const e of entries) map.set(e.id, e);
  const next = Array.from(map.values());
  await writeManifest(next);
  return next;
}

export async function updateManifest(docId: string, patch: Partial<UploadedDocument>): Promise<void> {
  const docs = await readManifest();
  const idx = docs.findIndex((d) => d.id === docId);
  if (idx === -1) return;
  docs[idx] = { ...docs[idx], ...patch };
  await writeManifest(docs);
}

export async function deleteManifestEntry(docId: string): Promise<void> {
  const docs = await readManifest();
  await writeManifest(docs.filter((d) => d.id !== docId));
}

/** 判定文档是否仍存在于 manifest（删除取消检查） */
export async function documentExists(docId: string): Promise<boolean> {
  const docs = await readManifest();
  return docs.some((d) => d.id === docId);
}

/* ===== 检索 ===== */

export async function searchDocuments(query: string, k = 5): Promise<DocumentSearchResult[]> {
  const q = (query || '').trim();
  if (!q) return [];
  const qv = await generateEmbedding(q);

  const manifest = await readManifest();
  const readyIds = manifest.filter((d) => d.status === 'ready').map((d) => d.id);
  if (readyIds.length === 0) return [];

  const allChunks = await readAllChunks(readyIds);
  if (allChunks.length === 0) return [];

  // 稀疏检索：中文 bigram + 英文词的 BM25 分数
  const queryTokens = tokenize(q);
  const df = buildDf(allChunks.map((c) => c.content));
  const lens = allChunks.map((c) => Math.max(tokenize(c.content).length, 1));
  const avgLen = lens.reduce((a, b) => a + b, 0) / Math.max(allChunks.length, 1);
  const sparseScore = allChunks.map((c) =>
    bm25Score(queryTokens, c.content, df, allChunks.length, avgLen),
  );

  // 密集检索：余弦相似度
  const denseScore = allChunks.map((c) => cosineSimilarity(qv, c.embedding));

  // 相似度阈值：语义与关键词「都无关」的块直接丢弃（治本：压住纯语义误命中）
  const SEMANTIC_THRESHOLD = 0.28;
  const survivors = allChunks
    .map((c, i) => ({ chunk: c, dense: denseScore[i], sparse: sparseScore[i] }))
    .filter((r) => r.dense >= SEMANTIC_THRESHOLD || r.sparse > 0);

  if (survivors.length === 0) return [];

  // 加权融合：关键词分（0.65 权重）略占优，保留分数的绝对强弱（避免 RRF 排名稀释）
  const fused = weightedFusion(
    survivors.map((r) => ({ id: r.chunk.id, dense: r.dense, sparse: r.sparse })),
    0.35,
  );

  // 精确短语加成：完整命中查询串的块额外加分（去除空白后比较，区分「上游产业链」vs「产业链协同」）
  const qCompact = q.replace(/\s+/g, '');
  const scored = survivors
    .map((r) => {
      const contentCompact = r.chunk.content.replace(/\s+/g, '');
      const bonus = qCompact.length >= 2 && contentCompact.includes(qCompact) ? 0.5 : 0;
      return {
        docId: r.chunk.docId,
        fileName: r.chunk.fileName,
        chunkId: r.chunk.id,
        sectionPath: r.chunk.sectionPath,
        score: r.dense, // 保留语义分（0~1）供前端可选展示，排序以下方 fusedScore 为准
        fusedScore: (fused.get(r.chunk.id) || 0) + bonus,
        snippet: r.chunk.content.slice(0, 300),
      };
    })
    .sort((a, b) => b.fusedScore - a.fusedScore);

  // 同一文档最多保留 MAX_PER_DOC 块（放宽去重：单一资料也能返回多个相关段落）
  const MAX_PER_DOC = 3;
  const perDoc = new Map<string, number>();
  const deduped: DocumentSearchResult[] = [];
  for (const r of scored) {
    const cnt = perDoc.get(r.docId) || 0;
    if (cnt >= MAX_PER_DOC) continue;
    perDoc.set(r.docId, cnt + 1);
    deduped.push({
      docId: r.docId,
      fileName: r.fileName,
      chunkId: r.chunkId,
      sectionPath: r.sectionPath,
      score: r.score,
      snippet: r.snippet,
    });
    if (deduped.length >= k) break;
  }
  return deduped;
}
