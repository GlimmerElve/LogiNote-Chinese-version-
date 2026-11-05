import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { deserializeLlmState } from '../src/services/userStateService.ts';
import type { LlmCallRequest, LlmCallResponse, LlmProvider } from '../src/types.ts';
import { readArgumentReferenceModel, invokeArgumentReferenceModel,
  type ArgumentReferenceModelAdapter, type ArgumentReferenceModelConfig } from '../src/electron/rag/argumentReferenceModel.ts';
import { proxyLlmRequest } from '../src/electron/apiHandlers.ts';
import { ARGUMENT_REFERENCE_QUALIFICATION_PROMPT } from '../src/electron/rag/argumentReferencePolicy.ts';
import { ARGUMENT_PROJECTION_EXTRACTION_PROMPT, ARGUMENT_PROJECTION_SELECTION_PROMPT, ARGUMENT_PROJECTION_REVIEW_PROMPT,
  ARGUMENT_PROJECTION_SOURCE_REVIEW_PROMPT, ARGUMENT_PROJECTION_TASK_REVIEW_PROMPT,
  type ArgumentProjectionModelRequest } from '../src/services/argumentContext/buildPrompts.ts';
import { SOURCE_PROPOSITION_DRAFT_PROMPT, SOURCE_PROPOSITION_SELECTION_PROMPT, SOURCE_PROPOSITION_PARENT_SELECTION_PROMPT,
  SOURCE_PROPOSITION_REVIEW_PROMPT, TASK_SOURCE_PROPOSITION_REVIEW_PROMPT } from '../src/services/reviewComparison/sourcePropositionBuild.ts';
import { FROZEN_ATOMIC_REFERENCE_EXTRACTION_PROMPT } from '../src/services/reviewComparison/frozenExtractionPrompt.ts';
import { FROZEN_PROPOSITION_REFERENCE_PROMPT } from '../src/services/reviewComparison/frozenPropositionReference.ts';
import { JSON_OBJECT_OUTPUT } from '../src/workflows/structuredOutput.ts';

/** Explicit synthetic acceptance only. Importing this module reads no settings or vault. */
export interface ReferenceRagAcceptanceModels {
  source: ArgumentReferenceModelConfig; answer: ArgumentReferenceModelConfig; fingerprint: string;
  assertCurrent(): Promise<void>;
}
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const fail = (code: string): never => { throw new Error(`reference_rag_acceptance_${code}`); };
const equal = (first: unknown, second: unknown) => JSON.stringify(first) === JSON.stringify(second);
const label = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 160
  && !/[\u0000-\u001f\u007f]/u.test(value);
async function regularBytes(filename: string): Promise<Buffer> {
  if (!path.isAbsolute(filename)) fail('configuration_unavailable');
  const directory = path.dirname(filename), root = path.parse(directory).root;
  let current = root;
  for (const part of [null, ...path.relative(root, directory).split(path.sep).filter(Boolean)]) {
    if (part !== null) current = path.join(current, part);
    const entry = await fs.lstat(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail('configuration_unavailable');
  }
  const before = await fs.lstat(filename);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 1024 * 1024) fail('configuration_unavailable');
  const handle = await fs.open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.size > 1024 * 1024 || actual.ino !== before.ino || actual.dev !== before.dev) fail('configuration_unavailable');
    const bytes = await handle.readFile(), after = await handle.stat();
    if (bytes.length > 1024 * 1024 || actual.size !== after.size || actual.mtimeMs !== after.mtimeMs
      || !Buffer.from(bytes.toString('utf8')).equals(bytes)) fail('configuration_unavailable');
    return bytes;
  } finally { await handle.close(); }
}
function checkConfig(value: ArgumentReferenceModelConfig): void {
  if (!value || !/^[a-f0-9]{64}$/u.test(value.fingerprint) || !label(value.providerLabel)
    || value.modelName !== 'deepseek-flash' || value.isRemote !== true || value.provider?.apiType !== 'openai-compatible'
    || value.provider.selectedModel !== 'deepseek-flash' || !Array.isArray(value.provider.models)
    || value.provider.models.some(model => !label(model)) || typeof value.provider.apiKey !== 'string'
    || !value.provider.apiKey.trim() || value.provider.apiKey.length > 2000 || /[\r\n\u0000]/u.test(value.provider.apiKey)) fail('configuration_unavailable');
  let url: URL; try { url = new URL(value.provider.baseUrl); } catch { return fail('configuration_unavailable'); }
  if (url.origin !== 'https://api.deepseek.com' || url.username || url.password || url.hash || url.search
    || !['/', '/v1', '/v1/'].includes(url.pathname)) fail('configuration_unavailable');
}
function answerConfig(provider: LlmProvider, fingerprint: string): ArgumentReferenceModelConfig {
  const result: ArgumentReferenceModelConfig = { fingerprint, providerLabel: provider.name,
    modelName: provider.selectedModel || provider.models[0], isRemote: true,
    provider: { apiType: provider.apiType, baseUrl: provider.baseUrl, apiKey: provider.apiKey,
      selectedModel: provider.selectedModel || provider.models[0], models: [...provider.models] } };
  checkConfig(result); return result;
}
/** Only an explicitly executed, cloud-authorized runner may call this private loader.
 * Nothing is copied into its synthetic roots; only opaque hashes leave the closure. */
export async function loadReferenceRagAcceptanceModels(): Promise<ReferenceRagAcceptanceModels> {
  if (!process.argv.includes('--execute') || !process.argv.includes('--allow-cloud')) fail('configuration_read_not_authorized');
  try {
    const anchorPath = path.join(os.homedir(), '.logi-note', 'storage-config.json');
    const anchorBytes = await regularBytes(anchorPath), anchor = JSON.parse(anchorBytes.toString('utf8'));
    if (!anchor || typeof anchor.dataRoot !== 'string' || !path.isAbsolute(anchor.dataRoot)) fail('configuration_unavailable');
    const roots = { dataRoot: anchor.dataRoot, vaultRoot: path.join(anchor.dataRoot, 'vault'), userStateDir: path.join(anchor.dataRoot, 'user-state') };
    const settingsPath = path.join(roots.userStateDir, 'llm.json'), settingsBytes = await regularBytes(settingsPath);
    const raw = JSON.parse(settingsBytes.toString('utf8')), settings = deserializeLlmState(settingsBytes.toString('utf8'));
    if (raw?.version !== 1 || !settings || !Array.isArray(settings.providers) || settings.providers.length > 100
      || new Set(settings.providers.map(provider => provider?.id)).size !== settings.providers.length) fail('configuration_unavailable');
    const bound = settings.workflowBinding?.['review-scoring'], selected = bound ?? settings.defaultProviderId;
    if (!label(selected) || bound !== undefined && !label(bound)) fail('configuration_unavailable');
    const provider = settings.providers.find(candidate => candidate?.id === selected && candidate.enabled === true);
    if (!provider) fail('configuration_unavailable');
    const source = await readArgumentReferenceModel(roots); checkConfig(source);
    if (source.fingerprint !== sha(settingsBytes)) fail('configuration_changed');
    const answer = answerConfig(provider!, sha(settingsBytes));
    const fingerprint = sha(JSON.stringify([sha(anchorBytes), sha(settingsBytes)]));
    const assertCurrent = async () => {
      try {
        if (!equal(await regularBytes(anchorPath), anchorBytes) || !equal(await regularBytes(settingsPath), settingsBytes)) fail('configuration_changed');
      } catch { fail('configuration_changed'); }
    };
    await assertCurrent();
    return { source, answer, fingerprint, assertCurrent };
  } catch (error) {
    if (error instanceof Error && error.message === 'reference_rag_acceptance_configuration_changed') throw error;
    return fail('configuration_unavailable');
  }
}

const sourceStages = ['quality', 'structure-draft', 'structure-review', 'proposition-draft', 'proposition-review'] as const;
type SourceStage = typeof sourceStages[number];
type Stage = SourceStage | 'answer-extract' | 'answer-review';
type Context = { kind: 'source' | 'answer'; id: string };
export interface ReferenceRagAcceptanceStage extends Context {
  stage: Stage; status: 'dispatched' | 'completed' | 'failed'; milliseconds: number;
  systemChars: number; userChars: number; promptTokens: number | null; completionTokens: number | null; totalTokens: number | null;
  finishReason: string | null;
}
export interface ReferenceRagAcceptanceTransportOptions {
  signal: AbortSignal; assertFrozen(): Promise<void>; save(name: string, value: unknown): Promise<void>;
}
let installed = false;
function closed(raw: unknown, keys: readonly string[]): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
    || Reflect.ownKeys(raw).some(key => typeof key !== 'string')
    || Object.values(Object.getOwnPropertyDescriptors(raw)).some(item => !item.enumerable || !Object.hasOwn(item, 'value'))
    || Object.keys(raw).sort().join('|') !== [...keys].sort().join('|')) fail('request_contract_failed');
}
function checkedText(value: unknown, maximum: number): asserts value is string {
  if (typeof value !== 'string') return fail('request_contract_failed');
  if (!value.trim() || value.length > maximum) return fail('request_contract_failed');
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++index); if (!(next >= 0xdc00 && next <= 0xdfff)) fail('request_contract_failed');
    } else if (code >= 0xdc00 && code <= 0xdfff) fail('request_contract_failed');
  }
}
function sourceStage(request: ArgumentProjectionModelRequest): SourceStage {
  closed(request, ['stage', 'bindingId', 'systemPrompt', 'userInput', 'skipMemoryInjection', 'skipProfileInjection', 'thinkingMode']);
  checkedText(request.userInput, 96000); checkedText(request.systemPrompt, 16000); checkedText(request.bindingId, 300);
  if (request.skipMemoryInjection !== true || request.skipProfileInjection !== true || request.thinkingMode !== 'disabled'
    || request.userInput.length + request.systemPrompt.length > 96000) fail('request_contract_failed');
  const stages: [string, SourceStage, 'extract' | 'review'][] = [
    [ARGUMENT_REFERENCE_QUALIFICATION_PROMPT, 'quality', 'review'], [ARGUMENT_PROJECTION_EXTRACTION_PROMPT, 'structure-draft', 'extract'],
    [ARGUMENT_PROJECTION_SELECTION_PROMPT, 'structure-draft', 'extract'], [SOURCE_PROPOSITION_SELECTION_PROMPT, 'proposition-draft', 'extract'],
    [ARGUMENT_PROJECTION_SOURCE_REVIEW_PROMPT, 'structure-review', 'review'], [SOURCE_PROPOSITION_PARENT_SELECTION_PROMPT, 'proposition-draft', 'extract'],
    [ARGUMENT_PROJECTION_TASK_REVIEW_PROMPT, 'structure-review', 'review'],
    [ARGUMENT_PROJECTION_REVIEW_PROMPT, 'structure-review', 'review'], [SOURCE_PROPOSITION_DRAFT_PROMPT, 'proposition-draft', 'extract'],
    [SOURCE_PROPOSITION_REVIEW_PROMPT, 'proposition-review', 'review'],
    [TASK_SOURCE_PROPOSITION_REVIEW_PROMPT, 'proposition-review', 'review'] ];
  const selected = stages.find(([prompt]) => request.systemPrompt === prompt);
  if (!selected || request.stage !== selected[2]) fail('request_contract_failed');
  JSON.parse(request.userInput); return selected![1];
}
function answerStage(request: LlmCallRequest): 'answer-extract' | 'answer-review' {
  closed(request, ['providerId', 'model', 'workflow', 'userInput', 'systemPromptOverride', 'outputSchema', 'maxTokensOverride',
    'thinkingMode', 'skipMemoryInjection', 'skipProfileInjection']);
  checkedText(request.userInput, 60000); checkedText(request.systemPromptOverride, 16000);
  if (request.providerId !== '' || request.model !== '' || request.workflow !== 'review-scoring'
    || request.maxTokensOverride !== 4096 || request.thinkingMode !== 'disabled' || request.skipMemoryInjection !== true
    || request.skipProfileInjection !== true || !equal(request.outputSchema, JSON_OBJECT_OUTPUT)) fail('request_contract_failed');
  JSON.parse(request.userInput);
  if (request.systemPromptOverride === FROZEN_ATOMIC_REFERENCE_EXTRACTION_PROMPT) return 'answer-extract';
  if (request.systemPromptOverride === FROZEN_PROPOSITION_REFERENCE_PROMPT) return 'answer-review';
  return fail('request_contract_failed');
}
const usage = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let cancel!: () => void;
  const halted = new Promise<never>((_, reject) => {
    cancel = () => reject(signal.reason instanceof Error ? signal.reason : new Error('reference_rag_acceptance_request_aborted'));
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
  });
  try { return await Promise.race([promise, halted]); }
  finally { signal.removeEventListener('abort', cancel); }
}
async function boundedBody(response: Response, signal: AbortSignal): Promise<Uint8Array> {
  const reader = response.body?.getReader(); if (!reader) return fail('provider_response_missing');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const part = await abortable(reader.read(), signal); if (part.done) break; bytes += part.value.length;
      if (bytes > 1024 * 1024) { await reader.cancel(); fail('provider_response_budget_exceeded'); } chunks.push(part.value); }
    return Buffer.concat(chunks);
  } finally { if (signal.aborted) void reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** Captures the production proxy's sole fetch, not a parallel bespoke model client.
 * Models/fixtures own no ambient network capability outside an active dispatch. */
export function createReferenceRagAcceptanceTransport(original: ReferenceRagAcceptanceModels, options: ReferenceRagAcceptanceTransportOptions) {
  if (installed) fail('transport_already_installed');
  const source = structuredClone(original.source), answer = structuredClone(original.answer);
  checkConfig(source); checkConfig(answer);
  const assertCurrent = original.assertCurrent.bind(original), assertFrozen = options.assertFrozen.bind(options), save = options.save.bind(options);
  const outer = options.signal, nativeFetch = globalThis.fetch;
  let context: Context | undefined, pending: { config: ArgumentReferenceModelConfig; stage: Stage; system: string; user: string;
    signal: AbortSignal; claimed: boolean } | undefined;
  let activeAbort: (() => void) | undefined;
  let calls = 0, restored = false, stopped = false, stopReason: string | undefined;
  const stages: ReferenceRagAcceptanceStage[] = [], orders = new Map<string, number>();
  const stop = (code: string): never => { stopped = true; stopReason ??= code; throw new Error(stopReason); };
  const live = (signal?: AbortSignal) => {
    if (restored) fail('run_stopped');
    if (stopped) throw new Error(stopReason ?? 'reference_rag_acceptance_run_stopped');
    if (outer.aborted || signal?.aborted) stop(signal?.reason instanceof Error && /^reference_rag_acceptance_[a-z0-9_]+$/u.test(signal.reason.message)
      ? signal.reason.message : 'reference_rag_acceptance_run_aborted');
  };
  const current = async (signal?: AbortSignal) => {
    live(signal); if (globalThis.fetch !== wrapper) stop('reference_rag_acceptance_transport_replaced');
    try { await assertCurrent(); } catch { stop('reference_rag_acceptance_configuration_changed'); }
    try { await assertFrozen(); } catch { stop('reference_rag_acceptance_frozen_code_changed'); }
    live(signal); if (globalThis.fetch !== wrapper) stop('reference_rag_acceptance_transport_replaced');
  };
  const wrapper: typeof fetch = async (url, init) => {
    let record: ReferenceRagAcceptanceStage | undefined, started = 0;
    try {
      const active = context, dispatch = pending;
      if (!active || !dispatch || dispatch.claimed) fail('implicit_network_forbidden');
      live(dispatch.signal);
      const endpoint = `${dispatch.config.provider.baseUrl.replace(/\/+$/u, '')}/chat/completions`;
      if (typeof url !== 'string' || url !== endpoint || !init || init.method !== 'POST' || typeof init.body !== 'string') fail('request_contract_failed');
      const headers = new Headers(init.headers);
      if ([...headers.keys()].sort().join('|') !== 'authorization|content-type' || headers.get('content-type') !== 'application/json'
        || headers.get('authorization') !== `Bearer ${dispatch.config.provider.apiKey}`) fail('request_contract_failed');
      const body = JSON.parse(init.body);
      const expected = { model: 'deepseek-flash', messages: [{ role: 'system', content: dispatch.system }, { role: 'user', content: dispatch.user }],
        temperature: active.kind === 'source' ? 0 : 0.1, max_tokens: active.kind === 'source' ? 12000 : 4096,
        response_format: { type: 'json_object' }, thinking: { type: 'disabled' } };
      if (!equal(body, expected)) fail('request_contract_failed');
      for (const key of [source.provider.apiKey, answer.provider.apiKey]) if (dispatch.system.includes(key) || dispatch.user.includes(key)) fail('private_content_forbidden');
      const identity = `${active.kind}/${active.id}`, previous = orders.get(identity), index = active.kind === 'source'
        ? sourceStages.indexOf(dispatch.stage as SourceStage) : dispatch.stage === 'answer-extract' ? 0 : 1;
      if (index < 0 || (previous === undefined ? active.kind === 'source' ? ![0, 3].includes(index) : index !== 0 : index !== previous + 1)
        || stages.filter(row => row.kind === active.kind && row.id === active.id).length >= (active.kind === 'source' ? 5 : 2)
        || calls >= 31) fail('approved_budget_or_stage_exceeded');
      dispatch.claimed = true;
      await current(dispatch.signal);
      const name = `${active.kind}-${active.id}-${dispatch.stage}`;
      await save(`request-${name}.json`, { kind: active.kind, id: active.id, stage: dispatch.stage,
        systemPrompt: dispatch.system, userInput: dispatch.user, body });
      await current(dispatch.signal);
      // Nothing awaited between actual attempt accounting and native transport.
      started = performance.now(); calls++; orders.set(identity, index);
      record = { ...active, stage: dispatch.stage, status: 'dispatched', milliseconds: 0, systemChars: dispatch.system.length,
        userChars: dispatch.user.length, promptTokens: null, completionTokens: null, totalTokens: null, finishReason: null };
      stages.push(record);
      const response = await abortable(nativeFetch(url, { ...init, redirect: 'error', signal: dispatch.signal }), dispatch.signal);
      if (!response.ok) fail(`provider_http_${response.status}`);
      const bytes = await boundedBody(response, dispatch.signal), raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      record.milliseconds = Math.round(performance.now() - started);
      record.promptTokens = usage(raw?.usage?.prompt_tokens); record.completionTokens = usage(raw?.usage?.completion_tokens);
      record.totalTokens = usage(raw?.usage?.total_tokens); record.finishReason = label(raw?.choices?.[0]?.finish_reason) ? raw.choices[0].finish_reason : null;
      const content = raw?.choices?.[0]?.message?.content;
      if (typeof content === 'string' && [source.provider.apiKey, answer.provider.apiKey].some(key => content.includes(key))) fail('private_content_forbidden');
      await save(`response-${name}.json`, { content: typeof content === 'string' ? content : null,
        finishReason: record.finishReason, usage: { promptTokens: record.promptTokens, completionTokens: record.completionTokens, totalTokens: record.totalTokens } });
      await current(dispatch.signal); record.status = 'completed';
      return new Response(bytes, { status: response.status, headers: { 'content-type': 'application/json' } });
    } catch (error) {
      if (record) { record.status = 'failed'; record.milliseconds = Math.round(performance.now() - started); }
      const code = error instanceof Error && /^reference_rag_acceptance_[a-z0-9_]+$/u.test(error.message)
        ? error.message : 'reference_rag_acceptance_transport_failure';
      return stop(code);
    }
  };
  globalThis.fetch = wrapper; installed = true;
  const dispatch = async <T>(config: ArgumentReferenceModelConfig, stage: Stage, system: string, user: string,
    signal: AbortSignal | undefined, work: (combined: AbortSignal) => Promise<T>): Promise<T> => {
    if (!context || pending) fail('dispatch_context_unavailable');
    const controller = new AbortController(), cancel = () => controller.abort(new Error('reference_rag_acceptance_request_aborted'));
    const cancelRun = () => controller.abort(new Error('reference_rag_acceptance_run_aborted'));
    activeAbort = cancelRun;
    const timer = setTimeout(() => controller.abort(new Error('reference_rag_acceptance_request_timeout')), 60000);
    outer.addEventListener('abort', cancelRun, { once: true }); signal?.addEventListener('abort', cancel, { once: true });
    if (outer.aborted) cancelRun(); else if (signal?.aborted) cancel();
    try {
      await current(controller.signal); pending = { config, stage, system, user, signal: controller.signal, claimed: false };
      const response = await work(controller.signal);
      if (!pending.claimed) fail('production_dispatch_missing');
      await current(controller.signal); return response;
    } catch (error) {
      // Valid HTTP may contain an empty/truncated/model-invalid content string.
      // Keep that independent sample held without treating it as a network failure.
      if (error instanceof Error && ['argument_reference_model_response_invalid', 'reference_rag_acceptance_provider_response_invalid'].includes(error.message)) {
        throw new Error('reference_rag_acceptance_model_response_invalid');
      }
      return stop(error instanceof Error && /^reference_rag_acceptance_[a-z0-9_]+$/u.test(error.message)
        ? error.message : 'reference_rag_acceptance_transport_failure');
    } finally {
      controller.abort(); clearTimeout(timer); outer.removeEventListener('abort', cancelRun); signal?.removeEventListener('abort', cancel); pending = undefined; activeAbort = undefined;
    }
  };
  const sourceAdapter: ArgumentReferenceModelAdapter = {
    read: async () => { await current(); return structuredClone(source); },
    invoke: async (config, request, signal) => {
      let captured: ArgumentProjectionModelRequest, stage: SourceStage;
      try {
        if (context?.kind !== 'source' || !equal(config, source)) fail('dispatch_context_unavailable');
        captured = structuredClone(request); stage = sourceStage(captured);
      } catch { return stop('reference_rag_acceptance_request_contract_failed'); }
      return dispatch(source, stage, captured.systemPrompt, captured.userInput, signal,
        combined => invokeArgumentReferenceModel(structuredClone(source), captured, combined));
    },
  };
  const answerCaller = async (request: LlmCallRequest, settings?: { signal?: AbortSignal }): Promise<LlmCallResponse> => {
    let captured: LlmCallRequest, stage: 'answer-extract' | 'answer-review';
    try { if (context?.kind !== 'answer') fail('dispatch_context_unavailable'); captured = structuredClone(request); stage = answerStage(captured); }
    catch { return stop('reference_rag_acceptance_request_contract_failed'); }
    return dispatch(answer, stage, captured.systemPromptOverride!, captured.userInput, settings?.signal, async combined => {
      const response = await proxyLlmRequest({ provider: structuredClone(answer.provider), systemPrompt: captured.systemPromptOverride!,
        userInput: captured.userInput, temperature: 0.1, maxTokens: 4096, thinkingMode: 'disabled', outputSchema: JSON_OBJECT_OUTPUT }, combined);
      if (response.toolCalls?.length || typeof response.content !== 'string' || !response.content.trim()
        || response.content.length > 96000 || ['length', 'max_tokens', 'MAX_TOKENS'].includes(response.diagnostics?.finishReason ?? '')) fail('provider_response_invalid');
      return { content: response.content, diagnostics: response.diagnostics };
    });
  };
  return {
    sourceAdapter, answerCaller,
    async withContext<T>(value: Context, work: () => Promise<T>): Promise<T> {
      closed(value, ['kind', 'id']);
      if (!['source', 'answer'].includes(value.kind) || typeof value.id !== 'string' || !/^[A-Za-z0-9_-]{1,60}$/u.test(value.id)
        || context || pending) fail('dispatch_context_unavailable');
      live(); context = structuredClone(value);
      try { return await work(); } finally { context = undefined; }
    },
    summary: () => ({ calls, stages: structuredClone(stages), ...(stopReason ? { stopReason } : {}) }),
    restore() { if (restored) return; restored = true; stopped = true; activeAbort?.(); if (globalThis.fetch === wrapper) globalThis.fetch = nativeFetch; installed = false; },
  };
}
