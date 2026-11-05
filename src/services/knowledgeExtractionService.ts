import type { RagKnowledgeChunkExtraction, RagKnowledgePendingChunk } from '../types';
import { callLLM, resolveProvider } from './llmService';
import { ensureLlmSettingsLoaded } from './llmStorage';
import { DOCUMENT_KNOWLEDGE_EXTRACT_PROMPT } from '../workflows/documentKnowledgeExtractPrompt';
import {
  commitKnowledgeBatch,
  getKnowledgeSettings,
  getPendingKnowledgeBatch,
  markKnowledgeBatchFailed,
} from './knowledgeRagClient';

export interface KnowledgeExtractionRunResult {
  requested: number;
  committed: number;
  failed: number;
}

function isLoopbackUrl(value: string): boolean {
  try {
    const hostname = new URL(value).hostname.toLocaleLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname === '[::1]';
  } catch {
    return false;
  }
}

function parseJsonObject(content: string): Record<string, unknown> {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '');
  const parsed = JSON.parse(trimmed) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('抽取结果不是 JSON 对象');
  return parsed as Record<string, unknown>;
}

function normalizeExtraction(chunk: RagKnowledgePendingChunk, raw: unknown): RagKnowledgeChunkExtraction {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    // 不信任模型返回的 chunkId；固定使用主进程发放的任务 ID。
    chunkId: chunk.chunkId,
    entityMentions: (Array.isArray(value.entityMentions) ? value.entityMentions : []) as RagKnowledgeChunkExtraction['entityMentions'],
    entityRelations: (Array.isArray(value.entityRelations) ? value.entityRelations : []) as RagKnowledgeChunkExtraction['entityRelations'],
    argumentUnits: (Array.isArray(value.argumentUnits) ? value.argumentUnits : []) as RagKnowledgeChunkExtraction['argumentUnits'],
    argumentEdges: (Array.isArray(value.argumentEdges) ? value.argumentEdges : []) as RagKnowledgeChunkExtraction['argumentEdges'],
  };
}

async function extractChunk(chunk: RagKnowledgePendingChunk): Promise<RagKnowledgeChunkExtraction> {
  const response = await callLLM({
    providerId: '',
    model: '',
    workflow: 'document-knowledge-extract',
    // Legacy maintenance only. The document page now runs the v5 compact pipeline.
    systemPromptOverride: DOCUMENT_KNOWLEDGE_EXTRACT_PROMPT,
    maxTokensOverride: 8192,
    temperatureOverride: 0.1,
    userInput: JSON.stringify({
      chunkId: chunk.chunkId,
      sectionPath: chunk.sectionPath,
      sentences: chunk.sentences,
    }),
    skipMemoryInjection: true,
    skipProfileInjection: true,
    thinkingMode: 'disabled',
  });
  const parsed = response.parsedJson && typeof response.parsedJson === 'object'
    ? response.parsedJson
    : parseJsonObject(response.content || '');
  return normalizeExtraction(chunk, parsed);
}

/** 由用户显式触发一个小批次；不在后台隐式向云端发送资料。 */
export async function processNextKnowledgeBatch(maxChunks = 2): Promise<KnowledgeExtractionRunResult> {
  const settings = await getKnowledgeSettings();
  if (!settings.enabled) throw new Error('请先开启实体与论证知识层');
  await ensureLlmSettingsLoaded();
  const provider = resolveProvider('document-knowledge-extract');
  if (!provider) throw new Error('请先为“资料·实体与论证抽取”配置 LLM 服务商');
  if (settings.processingMode === 'local-only' && (provider.apiType !== 'ollama' || !isLoopbackUrl(provider.baseUrl))) {
    throw new Error('“仅本地”模式只允许连接 localhost/127.0.0.1 的 Ollama；当前绑定不会被调用');
  }

  const batch = await getPendingKnowledgeBatch(Math.max(1, Math.min(4, maxChunks)));
  const successful: Array<{ chunk: RagKnowledgePendingChunk; extraction: RagKnowledgeChunkExtraction }> = [];
  let failed = 0;
  for (const chunk of batch) {
    try {
      successful.push({ chunk, extraction: await extractChunk(chunk) });
    } catch (error) {
      failed += 1;
      try {
        await markKnowledgeBatchFailed({
          docId: chunk.docId,
          generationId: chunk.generationId,
          chunkIds: [chunk.chunkId],
          error: error instanceof Error ? error.message : '知识抽取失败',
        });
      } catch (markError) {
        console.warn('[knowledge-extraction] 记录失败状态失败:', markError);
      }
    }
  }

  const groups = new Map<string, typeof successful>();
  for (const item of successful) {
    const key = `${item.chunk.docId}\n${item.chunk.generationId}`;
    groups.set(key, [...(groups.get(key) || []), item]);
  }
  let committed = 0;
  for (const items of groups.values()) {
    const first = items[0].chunk;
    try {
      await commitKnowledgeBatch({
        docId: first.docId,
        generationId: first.generationId,
        items: items.map((item) => item.extraction),
      });
      committed += items.length;
    } catch (error) {
      failed += items.length;
      try {
        await markKnowledgeBatchFailed({
          docId: first.docId,
          generationId: first.generationId,
          chunkIds: items.map((item) => item.chunk.chunkId),
          error: error instanceof Error ? error.message : '知识校验或写入失败',
        });
      } catch (markError) {
        console.warn('[knowledge-extraction] 记录校验失败状态失败:', markError);
      }
    }
  }
  return { requested: batch.length, committed, failed };
}
