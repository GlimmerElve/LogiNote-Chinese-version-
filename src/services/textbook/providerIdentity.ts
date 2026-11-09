import type { LlmProvider } from '../../types';
import { resolveProvider } from '../llmService';
import { requireLlmModel } from '../llmModelSelection';
import { ensureLlmSettingsLoaded } from '../llmStorage';
import { textbookHash } from './fingerprint';
import { defaultTextbookModelPolicy, type TextbookModelPolicy } from './modelPolicy';
import type { TextbookThinkingSnapshot } from './thinkingSnapshot';

export const textbookWorkflows = ['textbook-blueprint', 'textbook-chapter', 'textbook-quality'] as const;
export function localTextbookEndpoint(baseUrl: string): boolean {
  try { const url = new URL(baseUrl); return ['http:', 'https:'].includes(url.protocol) && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname); } catch { return false; }
}
export function captureTextbookProviders(allowCloud: boolean): Record<typeof textbookWorkflows[number], LlmProvider> {
  return Object.fromEntries(textbookWorkflows.map(workflow => {
    const provider = resolveProvider(workflow);
    if (!provider) throw new Error(`请先为 ${workflow} 配置可用模型`);
    requireLlmModel(provider);
    if (!allowCloud && !localTextbookEndpoint(provider.baseUrl)) throw new Error('当前教材模型不是本机服务，而本次范围仅允许本机模型。请切换为本机模型；若需要使用远程模型，重新准备并在生成确认卡中批准本次云端请求。');
    return [workflow, structuredClone(provider)];
  })) as Record<typeof textbookWorkflows[number], LlmProvider>;
}
export function hashTextbookProviders(captured: Record<typeof textbookWorkflows[number], LlmProvider>, modelPolicy: TextbookModelPolicy = defaultTextbookModelPolicy(), thinkingSnapshot?: TextbookThinkingSnapshot): Promise<string> {
  const providers = textbookWorkflows.map(workflow => {
    const provider = captured[workflow];
    return { workflow, id: provider.id, name: provider.name, apiType: provider.apiType, baseUrl: provider.baseUrl,
      apiKey: provider.apiKey, selectedModel: provider.selectedModel, models: provider.models,
      ...(provider.visionModels?.length ? { visionModels: provider.visionModels, visualPolicy: 1 } : {}) };
  });
  return textbookHash({ providers, modelPolicy, ...(thinkingSnapshot ? { thinkingSnapshot } : {}) });
}
export async function textbookProviderSnapshot(allowCloud: boolean, modelPolicy = defaultTextbookModelPolicy(), thinkingSnapshot?: TextbookThinkingSnapshot): Promise<string> {
  await ensureLlmSettingsLoaded();
  return hashTextbookProviders(captureTextbookProviders(allowCloud), modelPolicy, thinkingSnapshot);
}
