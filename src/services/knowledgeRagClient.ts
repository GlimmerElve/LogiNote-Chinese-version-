import type {
  RagKnowledgeBatchCommit,
  RagKnowledgeDocumentStatus,
  RagKnowledgePendingChunk,
  RagKnowledgeSettings,
} from '../types';

function api() {
  return (window as any).electronAPI?.ragKnowledge;
}

export function isKnowledgeRagAvailable(): boolean {
  return !!api();
}

export async function getKnowledgeSettings(): Promise<RagKnowledgeSettings> {
  return await api()?.getSettings() || { enabled: false, processingMode: 'local-only' };
}

export async function setKnowledgeSettings(settings: RagKnowledgeSettings): Promise<RagKnowledgeSettings> {
  const target = api();
  if (!target) throw new Error('知识抽取仅在桌面版可用');
  return target.setEnabled(settings);
}

export async function getKnowledgeStatus(docId: string): Promise<RagKnowledgeDocumentStatus> {
  const target = api();
  if (!target) return { docId, status: 'disabled', indexedChunks: 0, failedChunks: 0, totalChunks: 0 };
  return target.getStatus(docId);
}

export async function getPendingKnowledgeBatch(maxChunks = 4): Promise<RagKnowledgePendingChunk[]> {
  return await api()?.getPendingBatch(maxChunks) || [];
}

export async function commitKnowledgeBatch(input: RagKnowledgeBatchCommit): Promise<RagKnowledgeDocumentStatus> {
  const target = api();
  if (!target) throw new Error('知识抽取仅在桌面版可用');
  return target.commitBatch(input);
}

export async function markKnowledgeBatchFailed(input: {
  docId: string;
  generationId: string;
  chunkIds: string[];
  error: string;
}): Promise<RagKnowledgeDocumentStatus> {
  const target = api();
  if (!target) throw new Error('知识抽取仅在桌面版可用');
  return target.markBatchFailed(input);
}

export async function retryKnowledgeDocument(docId: string): Promise<RagKnowledgeDocumentStatus> {
  const target = api();
  if (!target) throw new Error('知识抽取仅在桌面版可用');
  return target.retryDocument(docId);
}
