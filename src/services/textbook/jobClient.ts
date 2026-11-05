import type { TextbookJobCommand, TextbookJobReply, TextbookJobSummary } from './generationTypes';
import type { MaterialScope } from './materialTypes';
import type { TextbookWebEvidenceRequest, TextbookWebReadRequest, TextbookWebSnapshot } from './webTypes';
import type { TextbookStopRequest, TextbookStopReply } from './stop';
type TextbookApi = { command(input: TextbookJobCommand): Promise<TextbookJobReply>; sourceHash(scope: MaterialScope, docId: string): Promise<string>; list(projectNoteId: string): Promise<TextbookJobSummary[]>;
  requestStop?(jobId: string): Promise<TextbookStopReply>;
  onStopRequested?(listener: (request: TextbookStopRequest) => void): () => void;
  readBoundUrl?(input: TextbookWebReadRequest): Promise<TextbookWebSnapshot>;
  supplement?(input: import('./supplement').TextbookSupplementRequest): Promise<import('./supplement').TextbookSupplementResult>;
  cancelWebRead?(jobId: string, token: string): Promise<void>;
  readWebEvidence?(input: TextbookWebEvidenceRequest): Promise<{ text: string; nextCursor?: number }> };
function api(): TextbookApi | undefined {
  return typeof window === 'undefined' ? undefined : (window as unknown as { electronAPI?: { textbook?: TextbookApi } }).electronAPI?.textbook;
}

export async function textbookJobCommand(input: TextbookJobCommand): Promise<TextbookJobReply> {
  const bridge = api();
  if (!bridge) throw new Error('教材生成需要桌面端私有任务存储，请重启更新后的桌面应用');
  return bridge.command(input);
}
export async function textbookDocumentHash(scope: MaterialScope, docId: string): Promise<string> {
  const bridge = api();
  if (!bridge) throw new Error('教材物料校验接口不可用');
  return bridge.sourceHash(scope, docId);
}
export async function listTextbookJobs(projectNoteId: string): Promise<TextbookJobSummary[]> {
  const bridge = api();
  return bridge?.list ? bridge.list(projectNoteId) : [];
}
export function textbookJobListingAvailable(): boolean { return typeof api()?.list === 'function'; }
export async function requestTextbookStop(jobId: string): Promise<TextbookStopReply> {
  const bridge = api();
  if (!bridge?.requestStop) throw new Error('教材停止接口不可用，请重启更新后的桌面应用；未把停止请求当作已停止');
  return bridge.requestStop(jobId);
}
export function subscribeTextbookStop(listener: (request: TextbookStopRequest) => void): () => void {
  return api()?.onStopRequested?.(listener) || (() => {});
}
export async function readTextbookBoundUrl(input: TextbookWebReadRequest, signal?: AbortSignal): Promise<TextbookWebSnapshot> {
  const bridge = api(); if (!bridge?.readBoundUrl) throw new Error('教材网页读取接口不可用，请重启更新后的桌面应用');
  signal?.throwIfAborted();
  const cancel = () => { void bridge.cancelWebRead?.(input.jobId, input.token).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try { const result = await bridge.readBoundUrl(input); signal?.throwIfAborted(); return result; }
  finally { signal?.removeEventListener('abort', cancel); }
}
export async function readTextbookWebEvidence(input: TextbookWebEvidenceRequest): Promise<{ text: string; nextCursor?: number }> {
  const bridge = api(); if (!bridge?.readWebEvidence) throw new Error('网页快照阅读接口不可用，请重启更新后的桌面应用');
  return bridge.readWebEvidence(input);
}
export async function supplementTextbookMaterials(input: import('./supplement').TextbookSupplementRequest, signal?: AbortSignal): Promise<import('./supplement').TextbookSupplementResult> {
  const bridge = api(); if (!bridge?.supplement) throw new Error('联网补缺接口不可用，使用已有物料继续');
  signal?.throwIfAborted();
  const cancel = () => { void bridge.cancelWebRead?.(input.jobId, input.token).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try { const result = await bridge.supplement(input); signal?.throwIfAborted(); return result; }
  finally { signal?.removeEventListener('abort', cancel); }
}
