import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import type { DocumentQueryIntent } from '../src/types.ts';
import { extractStructuredDocument } from '../src/electron/documentParsers.ts';
import { setPdfExtractScript } from '../src/electron/pdf.ts';
import {
  generateEmbedding,
  readManifest,
  searchDocuments,
  setDataRoot,
  setModelsDir,
  vectorizeDocument,
} from '../src/electron/ragIndex.ts';
import { setKnowledgeDataRoot } from '../src/electron/rag/knowledgeStore.ts';
import { setUserArgumentDataRoot } from '../src/electron/rag/userArgumentIndex.ts';
import { classifyDocumentQueryIntent } from '../src/electron/rag/knowledgeRetrieval.ts';
import {
  anonymizeBenchmarkId,
  inspectAnonymousRagCorpus,
} from '../src/electron/rag/realCorpusBenchmark.ts';
import {
  evaluateRetrievalGoldenSet,
  type RetrievalGoldenCase,
} from '../src/electron/rag/retrievalEvaluation.ts';

interface LocalLabelCase {
  id: string;
  query: string;
  expectedIntent?: DocumentQueryIntent;
  relevant: Array<{ chunkId: string; grade: 1 | 2 | 3 }>;
}

interface LocalLabelFile {
  version: 1;
  cases: LocalLabelCase[];
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

async function resolveDataRoot(): Promise<string> {
  const explicit = argument('--data-root');
  if (explicit?.trim()) return path.resolve(explicit.trim());
  const anchor = path.join(os.homedir(), '.logi-note', 'storage-config.json');
  try {
    const parsed = JSON.parse(await fs.readFile(anchor, 'utf-8')) as { dataRoot?: unknown };
    if (typeof parsed.dataRoot === 'string' && parsed.dataRoot.trim()) return path.resolve(parsed.dataRoot.trim());
  } catch {
    // 使用 Electron 默认 userData 目录。
  }
  return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'react-example');
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function summarizeTimes(values: number[], resultCounts: number[]) {
  return {
    samples: values.length,
    meanMs: values.length ? Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 10) / 10 : 0,
    p50Ms: Math.round(percentile(values, 0.50) * 10) / 10,
    p95Ms: Math.round(percentile(values, 0.95) * 10) / 10,
    meanResultCount: resultCounts.length
      ? Math.round((resultCounts.reduce((sum, value) => sum + value, 0) / resultCounts.length) * 10) / 10
      : 0,
  };
}

async function benchmarkSearch(readiness: 'empty' | 'passage_only' | 'unified_ready') {
  const coldStarted = performance.now();
  await generateEmbedding('本地 RAG 性能探针');
  const embeddingColdStartMs = Math.round((performance.now() - coldStarted) * 10) / 10;
  const probes = ['什么是这个主题的核心概念？', '为什么会得出这个结论？', '有哪些证据或反例？'];
  const modes = readiness === 'unified_ready'
    ? ['passage', 'auto', 'entity', 'argument'] as const
    : ['passage'] as const;
  const timings: Record<string, ReturnType<typeof summarizeTimes>> = {};
  for (const mode of modes) {
    const values: number[] = [];
    const resultCounts: number[] = [];
    for (let repeat = 0; repeat < 3; repeat += 1) {
      for (const query of probes) {
        const started = performance.now();
        const results = await searchDocuments(query, 5, { mode });
        values.push(performance.now() - started);
        resultCounts.push(results.length);
      }
    }
    timings[mode] = summarizeTimes(values, resultCounts);
  }
  return { embeddingColdStartMs, timings };
}

async function benchmarkIndex(dataRoot: string) {
  const manifest = await readManifest();
  const document = manifest.find((item) => item.status === 'ready' && item.indexable);
  if (!document) return { status: 'skipped', reason: 'no_ready_indexable_document' } as const;
  const storedPath = path.join(dataRoot, 'documents', `${document.id}${document.extension}`);
  try {
    await fs.access(storedPath);
  } catch {
    return { status: 'skipped', reason: 'stored_source_missing' } as const;
  }

  const parseStarted = performance.now();
  const structured = await extractStructuredDocument(storedPath, document.fileType, 'benchmark-document');
  const parseMs = performance.now() - parseStarted;
  const vectorStarted = performance.now();
  const chunks = await vectorizeDocument(
    'benchmark-document',
    `benchmark${document.extension}`,
    structured.normalizedText,
    structured,
  );
  const vectorizeMs = performance.now() - vectorStarted;
  return {
    status: 'measured',
    sourceType: document.fileType,
    sourceBytes: (await fs.stat(storedPath)).size,
    normalizedChars: structured.normalizedText.length,
    chunkCount: chunks.length,
    parseMs: Math.round(parseMs * 10) / 10,
    vectorizeMs: Math.round(vectorizeMs * 10) / 10,
    totalMs: Math.round((parseMs + vectorizeMs) * 10) / 10,
    serializedIndexBytes: Buffer.byteLength(JSON.stringify(chunks), 'utf-8'),
    writesPerformed: false,
  } as const;
}

async function readLabels(filePath: string): Promise<LocalLabelFile> {
  const parsed = JSON.parse(await fs.readFile(path.resolve(filePath), 'utf-8')) as Partial<LocalLabelFile>;
  if (parsed.version !== 1 || !Array.isArray(parsed.cases)) throw new Error('标签文件格式无效');
  const valid = parsed.cases.every((item) => Boolean(
    item && typeof item.id === 'string' && item.id.trim()
    && typeof item.query === 'string' && item.query.trim()
    && Array.isArray(item.relevant) && item.relevant.length > 0
    && item.relevant.every((entry) => entry && typeof entry.chunkId === 'string'
      && (entry.grade === 1 || entry.grade === 2 || entry.grade === 3)),
  ));
  if (!valid) throw new Error('标签文件包含无效查询或相关性标注');
  return parsed as LocalLabelFile;
}

async function evaluateLocalLabels(filePath: string, corpusFingerprint: string) {
  const labels = await readLabels(filePath);
  const cases: RetrievalGoldenCase[] = [];
  const anonymousRankings: Array<Record<string, unknown>> = [];
  const searchTimes: number[] = [];
  for (const item of labels.cases) {
    const expectedIntent = item.expectedIntent || classifyDocumentQueryIntent(item.query);
    const started = performance.now();
    const [passage, entity, argumentResults] = await Promise.all([
      searchDocuments(item.query, 20, { mode: 'passage' }),
      searchDocuments(item.query, 20, { mode: 'entity' }),
      searchDocuments(item.query, 20, { mode: 'argument' }),
    ]);
    searchTimes.push(performance.now() - started);
    const locatable = [...passage, ...entity, ...argumentResults]
      .filter((result) => result.sourceLocators?.length)
      .map((result) => result.chunkId);
    const relevance = Object.fromEntries(item.relevant.map((entry) => [entry.chunkId, entry.grade])) as Record<string, 1 | 2 | 3>;
    const goldenCase: RetrievalGoldenCase = {
      id: anonymizeBenchmarkId(item.id, corpusFingerprint),
      query: item.query,
      expectedIntent,
      relevance,
      locatableChunkIds: [...new Set(locatable)],
      channels: {
        passage: passage.map((result) => result.chunkId),
        entity: entity.map((result) => result.chunkId),
        argument: argumentResults.map((result) => result.chunkId),
      },
    };
    cases.push(goldenCase);
    anonymousRankings.push({
      caseId: goldenCase.id,
      expectedIntent,
      relevantCount: item.relevant.length,
      passage: goldenCase.channels.passage.map((id) => anonymizeBenchmarkId(id, corpusFingerprint)),
      entity: goldenCase.channels.entity.map((id) => anonymizeBenchmarkId(id, corpusFingerprint)),
      argument: goldenCase.channels.argument.map((id) => anonymizeBenchmarkId(id, corpusFingerprint)),
    });
  }
  const report = evaluateRetrievalGoldenSet(cases, { k: 5 });
  return {
    status: cases.length >= 20 ? 'measured' : 'insufficient_data',
    reason: cases.length >= 20 ? undefined : 'fewer_than_20_labeled_queries',
    queryCount: cases.length,
    intentAccuracy: report.intentAccuracy,
    baseline: report.baseline,
    unified: report.unified,
    meanThreeChannelSearchMs: searchTimes.length
      ? Math.round((searchTimes.reduce((sum, value) => sum + value, 0) / searchTimes.length) * 10) / 10
      : 0,
    anonymousRankings,
  };
}

async function main(): Promise<void> {
  const dataRoot = await resolveDataRoot();
  const modelsDir = path.resolve(argument('--models-dir') || path.join(process.cwd(), 'models'));
  setDataRoot(dataRoot);
  setKnowledgeDataRoot(dataRoot);
  setUserArgumentDataRoot(dataRoot);
  setModelsDir(modelsDir);
  setPdfExtractScript(path.resolve(process.cwd(), 'python', 'pdf_extract.py'));

  const corpus = await inspectAnonymousRagCorpus(dataRoot);
  const report: Record<string, unknown> = {
    reportVersion: 1,
    privacy: 'aggregate-only; paths, titles, queries, content and raw ids omitted',
    corpus,
  };
  if (hasFlag('--measure-search')) report.searchBenchmark = await benchmarkSearch(corpus.readiness);
  if (hasFlag('--measure-index')) report.indexBenchmark = await benchmarkIndex(dataRoot);
  const labelsPath = argument('--labels');
  if (labelsPath) {
    report.labeledEvaluation = corpus.readiness === 'unified_ready'
      ? await evaluateLocalLabels(labelsPath, corpus.corpusFingerprint)
      : { status: 'insufficient_data', reason: 'no_active_knowledge_shard' };
  }
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : '真实 RAG 基准执行失败');
  process.exitCode = 1;
});
