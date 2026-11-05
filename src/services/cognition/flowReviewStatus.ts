import type { FlowReviewIndexStatus } from './flowReviewMaterials';

export async function readFlowReviewIndexStatus(noteId: string): Promise<FlowReviewIndexStatus | null> {
  const api = typeof window === 'undefined' ? undefined : (window as unknown as { electronAPI?: {
    noteRag?: { flowReviewStatus?: (id: string) => Promise<FlowReviewIndexStatus> } } }).electronAPI?.noteRag;
  if (!api?.flowReviewStatus) return null;
  const value = await api.flowReviewStatus(noteId);
  if (!value || !Array.isArray(value.graphIds) || value.graphIds.some(id => typeof id !== 'string')
    || !Number.isSafeInteger(value.graphCount) || value.graphCount < 0 || value.graphCount !== value.graphIds.length
    || !Number.isSafeInteger(value.nodeCount) || value.nodeCount < 0
    || !['ready', 'unavailable', 'missing'].includes(value.vectorStatus) || typeof value.processing !== 'boolean') throw new Error('个人素材索引状态无效');
  return value;
}
