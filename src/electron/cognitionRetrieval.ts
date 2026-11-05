import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicWriteTextFile } from './atomicWrite.ts';
import { COGNITION_INDEX_FILE_NAME, loadCognition, withCognitionFile } from './cognitionStore.ts';
import { generateEmbedding, cosineSimilarity } from './rag/embedding.ts';
import { latestCognition } from '../services/cognition/core.ts';
import { cognitionQueryTerms, currentCognitionItems, retrieveCurrentCognition, withCognitionNeighborhood } from '../services/cognition/retrieval.ts';
import type { CognitionHit, CognitionRetrieval } from '../services/cognition/retrieval.ts';
import type { CognitionFile } from '../services/cognition/types.ts';

const MODEL = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2:mean-normalized:384:prefix1000-v1';
const DIM = 384;
const MAX_NEW_VECTORS = 64;
const MIN_SIMILARITY = 0.45; // Conservative initial cutoff, not a calibrated probability.
type Encoder = (text: string) => Promise<number[]>;
interface VectorIndex { schemaVersion: 1; model: string; snapshot: string; entries: Array<{ key: string; vector: number[] }> }
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const identity = (hit: CognitionHit) => JSON.stringify([hit.recordId, hit.branchId, hit.nodeId]);
const embeddingText = (hit: CognitionHit) => hit.text; // No title-only semantic matches or historical observations.
const vectorKey = (hit: CognitionHit) => hash(JSON.stringify([identity(hit), embeddingText(hit)]));
const snapshot = (file: CognitionFile) => hash(JSON.stringify(file.records.map((r) => [r.id, r.withdrawn === true, latestCognition(r)])));
const validVector = (value: unknown): value is number[] => Array.isArray(value) && value.length === DIM
  && value.every((n) => typeof n === 'number' && Number.isFinite(n)) && value.some((n) => n !== 0);

async function readIndex(target: string, fingerprint: string): Promise<VectorIndex> {
  try {
    const raw = JSON.parse(await fs.readFile(target, 'utf-8')) as VectorIndex;
    if (raw.schemaVersion === 1 && raw.model === MODEL && raw.snapshot === fingerprint && Array.isArray(raw.entries)
      && raw.entries.every((e) => e && typeof e.key === 'string' && validVector(e.vector))) return raw;
  } catch { /* Derived data is disposable; source-file failures are never swallowed here. */ }
  return { schemaVersion: 1, model: MODEL, snapshot: fingerprint, entries: [] };
}

function lexical(file: CognitionFile, query: string, warning = ''): CognitionRetrieval {
  const result = retrieveCurrentCognition(file, query);
  return withCognitionNeighborhood(file, { ...result, warning: [warning, result.warning].filter(Boolean).join(' ') });
}

/** Reciprocal-rank fusion. Dense-only hits must pass a similarity threshold. */
function fuse(file: CognitionFile, query: string, items: CognitionHit[], vectors: Map<string, number[]>, qv: number[]): CognitionRetrieval {
  const sparse = retrieveCurrentCognition(file, query).items;
  const dense = items.map((hit) => ({ hit, similarity: cosineSimilarity(qv, vectors.get(vectorKey(hit)) || []) }))
    .filter((row) => row.similarity >= MIN_SIMILARITY).sort((a, b) => b.similarity - a.similarity).slice(0, 12);
  const ranks = new Map<string, { hit: CognitionHit; score: number }>();
  for (const list of [sparse, dense.map((row) => row.hit)]) list.forEach((hit, index) => {
    const key = identity(hit), previous = ranks.get(key);
    ranks.set(key, { hit, score: (previous?.score || 0) + 1 / (60 + index + 1) });
  });
  const hits = [...ranks.values()].sort((a, b) => b.score - a.score).slice(0, 4).map(({ hit, score }) => ({ ...hit, score }));
  const partial = items.some((hit) => !vectors.has(vectorKey(hit)));
  return withCognitionNeighborhood(file, { status: 'ready', method: 'local-hybrid-v1', fileRevision: file.revision, items: hits,
    warning: `${partial ? '向量索引尚未完成，本次召回可能遗漏；后续请求继续构建。' : ''}本地词项与向量融合仅表示相关，不判定冲突或事实。仅含有限一跳原始连线；截断或缺少条件时不可下定论。${hits.length ? '' : '未检索到相关认知不代表认知缺陷。'}` });
}

/** Test injection never changes production model choice; all production inference is offline. */
export async function searchPersonalCognition(directory: string, input: unknown, encode: Encoder = generateEmbedding, isCurrent: () => boolean = () => true): Promise<CognitionRetrieval> {
  if (typeof input !== 'string' || !input.trim()) throw new Error('个人认知检索问题不能为空');
  const query = input.trim().slice(0, 1000);
  const root = path.resolve(directory), target = path.join(root, COGNITION_INDEX_FILE_NAME);
  const file = await loadCognition(root, isCurrent);
  const items = currentCognitionItems(file);
  if (!items.length || !cognitionQueryTerms(query).length) return lexical(file, query);
  const fingerprint = snapshot(file);
  const cache = await readIndex(target, fingerprint);
  const keys = new Set(items.map(vectorKey));
  const vectors = new Map(cache.entries.filter((entry) => keys.has(entry.key)).map((entry) => [entry.key, entry.vector]));
  let qv: number[];
  try {
    // Strip comparison framing so it does not dominate a short topical query.
    qv = await encode(cognitionQueryTerms(query).join(' '));
    if (!validVector(qv)) throw new Error('invalid query vector');
    let added = 0;
    const deadline = Date.now() + 8000;
    for (const hit of items) {
      const key = vectorKey(hit);
      if (vectors.has(key)) continue;
      if (added >= MAX_NEW_VECTORS || Date.now() > deadline) break;
      const vector = await encode(embeddingText(hit));
      if (!validVector(vector)) throw new Error('invalid document vector');
      vectors.set(key, vector); added++;
    }
  } catch {
    return lexical(await loadCognition(root, isCurrent), query, '本地向量模型不可用或推理失败，已退回词项检索；未调用云端服务。');
  }
  // Inference runs outside the write lock. Never publish a result/index against a changed source.
  return withCognitionFile(root, async (current) => {
    if (snapshot(current) !== fingerprint) return lexical(current, query, '检索期间认知已变化，本次使用最新版本词项结果。');
    let cacheWarning = '';
    try {
      const existing = await readIndex(target, fingerprint);
      for (const entry of existing.entries) if (keys.has(entry.key) && !vectors.has(entry.key)) vectors.set(entry.key, entry.vector);
      const next: VectorIndex = { schemaVersion: 1, model: MODEL, snapshot: fingerprint,
        entries: [...vectors].map(([key, vector]) => ({ key, vector })) };
      await fs.mkdir(root, { recursive: true });
      await atomicWriteTextFile(target, JSON.stringify(next));
    } catch { cacheWarning = '派生索引未能缓存，本次使用内存结果。'; }
    const result = fuse(current, query, items, vectors, qv);
    return { ...result, warning: cacheWarning + result.warning };
  }, isCurrent);
}
