import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { LlmProvider } from '../../types.ts';
import { deserializeLlmState, USER_STATE_FILES } from '../../services/userStateService.ts';
import type { ArgumentProjectionModelRequest } from '../../services/argumentContext/buildPrompts.ts';
import type { ArgumentProjectionRoots } from './argumentProjectionEnvironment.ts';
import type { LlmIpcRequest } from '../ipcTypes.ts';
import { proxyLlmRequest } from '../apiHandlers.ts';
import { assertLlmProviderEnabled } from '../../services/llmProviderSelection.ts';

/** Host private: the fingerprint binds the complete saved settings, including credentials. Never send this config through IPC. */
export interface ArgumentReferenceModelConfig {
  fingerprint: string; providerLabel: string; modelName: string; isRemote: boolean;
  provider: LlmIpcRequest['provider'];
  /** Private host-side authority for a delayed invocation; never exposed to renderer. */
  authority?: { userStateDir: string; providerId: string };
}
export interface ArgumentReferenceModelAdapter {
  read(roots: ArgumentProjectionRoots): Promise<ArgumentReferenceModelConfig>;
  invoke(config: ArgumentReferenceModelConfig, request: ArgumentProjectionModelRequest, signal: AbortSignal): Promise<string>;
}
const fail = (): never => { throw new Error('argument_reference_model_unavailable'); };
const safeLabel = (value: unknown, maximum = 160): value is string => typeof value === 'string' && !!value.trim()
  && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value) && !/^(?:[a-z]:[\\/]|[\\/])/iu.test(value);
function checkProvider(provider: LlmProvider): void {
  if (!provider || provider.enabled !== true || !safeLabel(provider.id) || !safeLabel(provider.name)
    || !['openai-compatible', 'anthropic', 'gemini', 'ollama'].includes(provider.apiType)
    || !Array.isArray(provider.models) || provider.models.length > 100 || provider.models.some(model => !safeLabel(model))
    || provider.selectedModel !== undefined && !safeLabel(provider.selectedModel)) fail();
  if (typeof provider.baseUrl !== 'string' || provider.baseUrl.length > 2000 || /[\u0000-\u0020\u007f]/u.test(provider.baseUrl)) fail();
  let url: URL; try { url = new URL(provider.baseUrl); } catch { return fail(); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash || url.search) fail();
  if (typeof provider.apiKey !== 'string' || provider.apiKey.length > 2000 || /[\r\n\u0000]/u.test(provider.apiKey)
    || provider.apiType !== 'ollama' && !provider.apiKey.trim()) fail();
  if (!provider.selectedModel && !provider.models.length) fail();
}
async function settingsBytes(userStateDir: string): Promise<Buffer> {
  if (!path.isAbsolute(userStateDir)) return fail();
  // Walk all parents; a captured root may still have been replaced by a symlink.
  const absolute = path.resolve(userStateDir), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of [null, ...path.relative(parsed.root, absolute).split(path.sep).filter(Boolean)]) {
    if (part !== null) current = path.join(current, part);
    const stat = await fs.lstat(current); if (!stat.isDirectory() || stat.isSymbolicLink()) fail();
  }
  const target = path.join(absolute, USER_STATE_FILES.llm), initial = await fs.lstat(target);
  if (!initial.isFile() || initial.isSymbolicLink() || initial.size > 1024 * 1024) fail();
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size > 1024 * 1024 || actual.ino !== initial.ino || actual.dev !== initial.dev) fail();
    const bytes = await handle.readFile();
    if (bytes.length > 1024 * 1024 || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) fail();
    return bytes;
  } finally { await handle.close(); }
}
export async function readArgumentReferenceModel(roots: ArgumentProjectionRoots): Promise<ArgumentReferenceModelConfig> {
  try {
    const bytes = await settingsBytes(roots.userStateDir), raw = JSON.parse(bytes.toString('utf8'));
    if (!raw || raw.version !== 1) return fail();
    const settings = deserializeLlmState(bytes.toString('utf8'));
    if (!settings || !Array.isArray(settings.providers) || settings.providers.length > 100 || !settings.workflowBinding
      || typeof settings.workflowBinding !== 'object' || Array.isArray(settings.workflowBinding)) return fail();
    const bound = settings.workflowBinding['document-knowledge-extract'], selectedId = bound || settings.defaultProviderId;
    if (bound !== undefined && !safeLabel(bound)) return fail();
    if (selectedId !== undefined && !safeLabel(selectedId)) return fail();
    // Explicit configured bindings do not silently switch to a different service when disabled/missing.
    const enabled = settings.providers.filter(provider => provider?.enabled === true);
    const provider = selectedId ? enabled.find(provider => provider.id === selectedId) : enabled[0];
    if (!provider || new Set(settings.providers.map(provider => provider?.id)).size !== settings.providers.length) return fail();
    checkProvider(provider);
    const after = await settingsBytes(roots.userStateDir); if (!after.equals(bytes)) return fail();
    const url = new URL(provider.baseUrl), host = url.hostname.toLowerCase();
    const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1';
    return { fingerprint: createHash('sha256').update(bytes).digest('hex'), providerLabel: provider.name,
      modelName: provider.selectedModel || provider.models[0], isRemote: !local,
      provider: { id: provider.id, apiType: provider.apiType, baseUrl: provider.baseUrl, apiKey: provider.apiKey,
        selectedModel: provider.selectedModel || provider.models[0], models: [...provider.models] },
      authority: { userStateDir: roots.userStateDir, providerId: provider.id } };
  } catch { return fail(); }
}

/** Exactly one non-streaming request. No profiles, memories, histories, tools, prompts from renderer or retries. */
export async function invokeArgumentReferenceModel(config: ArgumentReferenceModelConfig, request: ArgumentProjectionModelRequest,
  signal: AbortSignal): Promise<string> {
  if (signal.aborted) throw new Error('argument_reference_cancelled');
  if (config.authority) {
    try {
      const bytes = await settingsBytes(config.authority.userStateDir);
      if (JSON.parse(bytes.toString('utf8'))?.version !== 1) return fail();
      assertLlmProviderEnabled(deserializeLlmState(bytes.toString('utf8')), config.authority.providerId);
    } catch { return fail(); }
  }
  if (signal.aborted) throw new Error('argument_reference_cancelled');
  const response = await proxyLlmRequest({ provider: structuredClone(config.provider), systemPrompt: request.systemPrompt,
    userInput: request.userInput, temperature: 0, maxTokens: 12000, thinkingMode: 'disabled', outputSchema: { type: 'object' } }, signal);
  if (signal.aborted) throw new Error('argument_reference_cancelled');
  if (response.toolCalls?.length || typeof response.content !== 'string' || !response.content.trim()
    || response.content.length > 96000 || ['length', 'max_tokens', 'MAX_TOKENS'].includes(response.diagnostics?.finishReason ?? '')) {
    throw new Error('argument_reference_model_response_invalid');
  }
  return response.content;
}
export const argumentReferenceModel: ArgumentReferenceModelAdapter = { read: readArgumentReferenceModel, invoke: invokeArgumentReferenceModel };
