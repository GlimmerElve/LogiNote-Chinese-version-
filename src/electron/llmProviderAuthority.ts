import type { LlmSettings } from '../types';
import type { LlmIpcRequest } from './ipcTypes';
import { assertLlmProviderEnabled } from '../services/llmProviderSelection';

/** The desktop transport rechecks saved enablement, including requests from stale windows. */
export async function assertLlmRequestProviderEnabled(request: LlmIpcRequest,
  readSettings: () => Promise<LlmSettings | null>): Promise<void> {
  // Protocol adapters and older isolated callers have no saved supplier identity.
  // Every production renderer supplies its configured supplier ID.
  if (request.provider.id === undefined) return;
  if (typeof request.provider.id !== 'string' || !request.provider.id.trim()) throw new Error('模型供应商身份无效，请重新选择供应商。');
  assertLlmProviderEnabled(await readSettings(), request.provider.id);
}
