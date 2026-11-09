import type { LlmCallRequest, LlmCallResponse, LlmImageInput } from '../../types';
import type { S2Json, S2PluginInvocation, S2PluginOutcome } from '../../types/sceneS2Plugin';
import { fitSceneContextBudget, type SceneContextBudgetDiagnostics } from './sceneContextBudget';
import { readSafeLlmHttpFailure } from '../llmHttpFailure';
import { validateLlmImages } from '../llmImages';
import { s2BuiltinPluginInstallation } from './sceneS2PluginRegistry';
import { isS2ModelSessionImplementation } from './sceneS2ModelBridge';

export interface S2ModelTestLimits { maxRequests: number; maxReservedOutputTokens: number; maxOutputTokens: number }
export type S2ModelTestParameterInput = { maxOutputTokens?: number; temperature?: number; thinkingMode?: 'enabled' | 'disabled' };
export type S2ModelTestParameters = S2ModelTestParameterInput & { maxOutputTokens: number };
export interface S2ModelTestClosure { code: 'MODEL_TEST_CLOSED' | 'MODEL_TEST_USAGE_EXCEEDED'; message: string }
export interface S2ModelTestRecord {
  id: string; nodeId: string; status: 'pending' | 'succeeded' | 'failed' | 'cancelled' | 'timed-out';
  /** Full received text, including a truncated/failed response. Never a downstream success artifact. */
  output: string; outputOmitted: number; outputComplete: boolean;
  prompt: string; input: string; imageIds: string[];
  parameters: S2ModelTestParameters;
  finishReason?: string; usage?: { promptTokens?: number; completionTokens?: number }; error?: string;
}
export interface S2ModelTestSessionOptions {
  sceneId: string; runId: string; resourceId: string; providerId: string; providerLabel: string; model: string;
  contextWindowTokens?: number; supportsImages?: boolean; supportsThinking?: boolean; limits: S2ModelTestLimits;
  invoke: (request: LlmCallRequest, options: { signal: AbortSignal }) => Promise<LlmCallResponse>;
}
export interface S2ModelTestPreview {
  prompt: string; input: string; providerLabel: string; model: string; maxOutputTokens: number;
  remainingRequests: number; remainingReservedOutputTokens: number; contextBudget?: SceneContextBudgetDiagnostics;
  imageIds: string[];
  parameters: S2ModelTestParameters; reservationOutputTokens: number;
}
export interface S2ModelTestSummary {
  active: boolean; sceneId: string; runId: string; resourceId: string; providerLabel: string; model: string;
  limits: S2ModelTestLimits; usedRequests: number; reservedOutputTokens: number; records: S2ModelTestRecord[];
  supportsImages: boolean; supportsThinking: boolean;
  closure?: S2ModelTestClosure;
}
const TEXT_LIMIT = 6000, TIMEOUT_MS = 120000;
function object(raw: unknown, allowed: string[], label: string): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Object.prototype.toString.call(raw) !== '[object Object]' || Reflect.ownKeys(raw).some(key => typeof key !== 'string' || !allowed.includes(key))) throw new Error(`S2 模型测试${label}字段无效`);
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  if (Object.values(descriptors).some(item => !item.enumerable || !('value' in item))) throw new Error(`S2 模型测试${label}仅接受显式数据字段`);
  return raw as Record<string, unknown>;
}
function named(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || raw.length > 120 || !/^[A-Za-z][A-Za-z0-9_-]*$/.test(raw) || ['constructor', 'prototype', '__proto__'].includes(raw)) throw new Error(`S2 模型测试${label}标识无效`);
  return raw;
}
function labelText(raw: unknown, label: string): string {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 200 || /[\u0000-\u001f]/u.test(raw)) throw new Error(`S2 模型测试${label}未配置或无效`);
  return raw;
}
function rawText(raw: unknown, required: boolean, label: string): string {
  if (typeof raw !== 'string' || raw.length > TEXT_LIMIT || required && !raw.trim()) throw new Error(`S2 模型测试${label}必须为${required ? '非空' : ''}完整文本（最多6000字），不裁剪原文`);
  return raw;
}
function integer(raw: unknown, min: number, max: number, label: string): number {
  if (!Number.isSafeInteger(raw) || Number(raw) < min || Number(raw) > max) throw new Error(`S2 模型测试${label}必须为${min}–${max}的整数，不自动增加或使用默认预算`);
  return Number(raw);
}
class ModelTestFailure extends Error { constructor(readonly code: string, message: string) { super(message); } }
/** Only explicit local data values. Never clamp, coerce or silently ignore an unsupported setting. */
export function readS2ModelTestParameters(raw: unknown, maxOutputTokens: number, supportsThinking: boolean): S2ModelTestParameters {
  const value = object(raw, ['maxOutputTokens', 'temperature', 'thinkingMode'], '参数');
  const result: S2ModelTestParameters = { maxOutputTokens: Object.hasOwn(value, 'maxOutputTokens')
    ? integer(value.maxOutputTokens, 256, maxOutputTokens, '输出长度') : maxOutputTokens };
  if (Object.hasOwn(value, 'temperature')) {
    if (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2) throw new Error('S2 模型测试随机性必须为0–2有限数，不夹值或自动改写');
    result.temperature = value.temperature;
  }
  if (Object.hasOwn(value, 'thinkingMode')) {
    if (!['enabled', 'disabled'].includes(value.thinkingMode as string)) throw new Error('S2 模型测试思考只能明确设为enabled或disabled；按模型默认时不提供此参数');
    if (!supportsThinking) throw new Error('当前固定模型传输未明确支持思考控制；未发送，不静默忽略、不更换模型');
    result.thinkingMode = value.thinkingMode as 'enabled' | 'disabled';
  }
  return result;
}

/** Non-serializable, run-local approval and budget. Only an explicitly injected transport can execute. */
export class S2ModelTestSession {
  #active = true;
  #closure: S2ModelTestClosure | undefined;
  #closedListeners = new Set<(reason: S2ModelTestClosure) => void>();
  #scope: { sceneId: string; runId: string; resourceId: string };
  #provider: { id: string; label: string; model: string; contextWindowTokens?: number };
  #limits: S2ModelTestLimits;
  #invoke: S2ModelTestSessionOptions['invoke'];
  #supportsImages = false;
  #supportsThinking = false;
  #imageResolver?: (refs: S2Json[]) => LlmImageInput[];
  #usedRequests = 0;
  #reservedOutputTokens = 0;
  #records: S2ModelTestRecord[] = [];
  #controllers = new Set<AbortController>();
  #budgetFailures = new WeakSet<object>();
  #memo = new Map<string, { fingerprint: string; promise: Promise<S2PluginOutcome> }>();
  #invocationKeys = new Map<string, string>();
  constructor(options: S2ModelTestSessionOptions) {
    const value = object(options, ['sceneId', 'runId', 'resourceId', 'providerId', 'providerLabel', 'model', 'contextWindowTokens', 'supportsImages', 'supportsThinking', 'limits', 'invoke'], '会话');
    if (['sceneId', 'runId', 'resourceId', 'providerId', 'providerLabel', 'model', 'limits', 'invoke'].some(key => !Object.hasOwn(value, key))) throw new Error('S2 模型测试会话缺少显式配置，不从原型继承授权');
    this.#scope = { sceneId: named(value.sceneId, 'sceneId'), runId: named(value.runId, 'runId'), resourceId: named(value.resourceId, 'resourceId') };
    this.#provider = { id: labelText(value.providerId, '服务商标识'), label: labelText(value.providerLabel, '服务商名称'), model: labelText(value.model, '模型'),
      ...(value.contextWindowTokens === undefined ? {} : { contextWindowTokens: integer(value.contextWindowTokens, 4096, 2097152, '上下文窗口') }) };
    const limits = object(value.limits, ['maxRequests', 'maxReservedOutputTokens', 'maxOutputTokens'], '预算');
    if (['maxRequests', 'maxReservedOutputTokens', 'maxOutputTokens'].some(key => !Object.hasOwn(limits, key))) throw new Error('S2 模型测试必须显式给出全部预算字段，不从原型继承额度');
    this.#limits = { maxRequests: integer(limits.maxRequests, 1, 24, '请求次数'), maxReservedOutputTokens: integer(limits.maxReservedOutputTokens, 256, 48000, '总输出预留'), maxOutputTokens: integer(limits.maxOutputTokens, 256, 2048, '单次输出上限') };
    if (this.#limits.maxReservedOutputTokens < this.#limits.maxOutputTokens) throw new Error('S2 模型测试总输出预留不足一次完整输出，未建立授权');
    if (typeof value.invoke !== 'function') throw new Error('S2 模型测试必须显式提供调用器，不自动查找模型');
    this.#invoke = value.invoke as S2ModelTestSessionOptions['invoke'];
    if (value.supportsImages !== undefined && typeof value.supportsImages !== 'boolean') throw new Error('S2 模型图片能力必须来自固定模型配置');
    this.#supportsImages = value.supportsImages === true;
    if (value.supportsThinking !== undefined && typeof value.supportsThinking !== 'boolean') throw new Error('S2 模型思考控制必须来自固定模型传输配置');
    this.#supportsThinking = value.supportsThinking === true;
    Object.freeze(this);
  }
  get sceneId() { return this.#scope.sceneId; }
  get runId() { return this.#scope.runId; }
  get resourceId() { return this.#scope.resourceId; }
  summary(): S2ModelTestSummary {
    return structuredClone({ active: this.#active, ...this.#scope, providerLabel: this.#provider.label, model: this.#provider.model,
      limits: this.#limits, usedRequests: this.#usedRequests, reservedOutputTokens: this.#reservedOutputTokens, records: this.#records, supportsImages: this.#supportsImages, supportsThinking: this.#supportsThinking,
      ...(this.#closure ? { closure: this.#closure } : {}) });
  }
  /** Local lifecycle observation only. Does not grant access, reserve budget or execute a request. */
  subscribeClosed(listener: (reason: S2ModelTestClosure) => void): () => void {
    if (typeof listener !== 'function') throw new Error('模型测试关闭监听必须是本地函数');
    if (this.#closure) { try { listener(structuredClone(this.#closure)); } catch { /* Observers cannot alter the ledger or other observers. */ } return () => {}; }
    this.#closedListeners.add(listener);
    return () => { this.#closedListeners.delete(listener); };
  }
  #deactivate(reason: S2ModelTestClosure) {
    if (!this.#active) return;
    this.#active = false; this.#closure = structuredClone(reason);
    for (const controller of this.#controllers) controller.abort();
    const listeners = [...this.#closedListeners]; this.#closedListeners.clear();
    for (const listener of listeners) { try { listener(structuredClone(reason)); } catch { /* Lifecycle cleanup must reach every observer. */ } }
  }
  #requireActive() { if (!this.#active) throw new Error('S2 模型测试授权已关闭；保留原用量，不能恢复或重新使用'); }
  /** Host-only, once per live session. A serialized scene cannot provide this resolver or raw image data. */
  bindImageResolver(resolver: (refs: S2Json[]) => LlmImageInput[]) {
    this.#requireActive();
    if (this.#imageResolver || typeof resolver !== 'function' || this.#usedRequests) throw new Error('图片入口只能在本局模型会话开始时绑定一次');
    this.#imageResolver = resolver;
  }
  #prepare(prompt: string, input: string, imageRefs: S2Json[] = [], parameterInput: S2ModelTestParameterInput = {}) {
    this.#requireActive();
    rawText(prompt, true, '提示词'); rawText(input, false, '输入');
    const parameters = readS2ModelTestParameters(parameterInput, this.#limits.maxOutputTokens, this.#supportsThinking);
    if (!Array.isArray(imageRefs) || imageRefs.length > 1) throw new Error('S2 模型测试只接受至多一张本局图片');
    if (imageRefs.length && (!this.#supportsImages || !this.#imageResolver)) throw new Error('当前固定模型未明确支持图片输入或图片入口未授权；原图保留，不换模型、不OCR或丢图发送');
    const images = imageRefs.length ? validateLlmImages(this.#imageResolver!(structuredClone(imageRefs))) : [];
    if (images.length !== imageRefs.length) throw new Error('图片资源读取不完整，未发送请求');
    if (this.#usedRequests >= this.#limits.maxRequests || this.#reservedOutputTokens + this.#limits.maxOutputTokens > this.#limits.maxReservedOutputTokens) {
      const error = new Error('S2 模型测试本局请求或输出预留预算已用尽；失败和取消不退款'); this.#budgetFailures.add(error); throw error;
    }
    const request: LlmCallRequest = { providerId: this.#provider.id, model: this.#provider.model, workflow: 'scene-model-experiment',
      systemPromptOverride: prompt, userInput: input, maxTokensOverride: parameters.maxOutputTokens, tokenBudgetMode: 'total', thinkingPreference: 'default', skipMemoryInjection: true, skipProfileInjection: true,
      ...(parameters.temperature === undefined ? {} : { temperatureOverride: parameters.temperature }),
      ...(parameters.thinkingMode === undefined ? {} : { thinkingMode: parameters.thinkingMode }),
      ...(images.length ? { images: structuredClone(images) } : {}) };
    const fitted = fitSceneContextBudget(request, { provider: { contextWindowTokens: this.#provider.contextWindowTokens }, systemPrompt: prompt, maxOutputTokens: parameters.maxOutputTokens });
    if (fitted.request.systemPromptOverride !== prompt || fitted.request.userInput !== input) throw new Error('S2 模型测试必要原文被改变，未发送请求');
    return { ...fitted, parameters };
  }
  preview(prompt: string, input?: string, imageRefs: S2Json[] = [], parameters: S2ModelTestParameterInput = {}): S2ModelTestPreview {
    const actualInput = input === undefined ? '' : input, fitted = this.#prepare(prompt, actualInput, imageRefs, parameters);
    return structuredClone({ prompt, input: actualInput, providerLabel: this.#provider.label, model: this.#provider.model, maxOutputTokens: fitted.parameters.maxOutputTokens,
      parameters: fitted.parameters, reservationOutputTokens: this.#limits.maxOutputTokens,
      remainingRequests: this.#limits.maxRequests - this.#usedRequests, remainingReservedOutputTokens: this.#limits.maxReservedOutputTokens - this.#reservedOutputTokens,
      imageIds: (fitted.request.images ?? []).map(image => image.assetId),
      ...(fitted.diagnostics ? { contextBudget: fitted.diagnostics } : {}) });
  }
  /** Native preparation evidence only; matching an imported error message cannot acquire this category. */
  ownsBudgetFailure(error: unknown): boolean { return !!error && typeof error === 'object' && this.#budgetFailures.has(error); }
  /** Synchronous scope/preflight/reservation before yielding; identical calls share one operation, never a second request. */
  execute(call: S2PluginInvocation, inputs: Record<string, S2Json[]>, signal: AbortSignal): Promise<S2PluginOutcome> {
    this.#requireActive();
    if (!signal || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function' || typeof signal.aborted !== 'boolean') throw new Error('S2 模型测试缺少有效取消信号');
    if (signal.aborted) throw new DOMException('S2 模型测试已取消，未发送请求', 'AbortError');
    const invocation = object(call, ['protocolVersion', 'id', 'sceneId', 'runId', 'nodeId', 'revision', 'pluginId', 'pluginVersion', 'capabilityId', 'idempotencyKey', 'inputs'], '调用');
    if (['protocolVersion', 'id', 'sceneId', 'runId', 'nodeId', 'revision', 'pluginId', 'pluginVersion', 'capabilityId', 'idempotencyKey', 'inputs'].some(key => !Object.hasOwn(invocation, key))) throw new Error('S2 模型测试调用缺少显式字段');
    if (invocation.protocolVersion !== 1 || invocation.sceneId !== this.sceneId || invocation.runId !== this.runId) throw new Error('S2 模型测试调用不属于当前授权场景或运行局');
    if (!isS2ModelSessionImplementation(s2BuiltinPluginInstallation().descriptor(call))) throw new Error('S2 模型调用没有已安装的model-session@1宿主桥');
    named(invocation.id, '调用ID'); named(invocation.nodeId, '节点ID'); named(invocation.idempotencyKey, '幂等键'); integer(invocation.revision, 0, Number.MAX_SAFE_INTEGER, '修订号');
    const ports = ['prompt', 'input', 'image', 'maxOutputTokens', 'temperature', 'thinkingMode'];
    const refs = object(invocation.inputs, ports, '输入凭据'), values = object(inputs, ports, '输入');
    for (const key of ports) {
      const ids = Object.hasOwn(refs, key) ? refs[key] : undefined, resolved = Object.hasOwn(values, key) ? values[key] : undefined, required = key === 'prompt';
      if (ids !== undefined && (!Array.isArray(ids) || ids.length > 1 || ids.some(id => { named(id, '产物ID'); return false; }))
        || resolved !== undefined && (!Array.isArray(resolved) || resolved.length > 1)
        || required && (!Array.isArray(ids) || ids.length !== 1 || !Array.isArray(resolved) || resolved.length !== 1)
        || (Array.isArray(ids) ? ids.length : 0) !== (Array.isArray(resolved) ? resolved.length : 0)) throw new Error(`S2 模型测试${key}端口必须提供${required ? '一个' : '至多一个'}完整且匹配的输入`);
    }
    const prompt = rawText((values.prompt as S2Json[])[0], true, '提示词');
    const inputValues = Object.hasOwn(values, 'input') ? values.input as S2Json[] | undefined : undefined;
    const input = rawText(inputValues?.length ? inputValues[0] : '', false, '输入');
    const imageRefs = Object.hasOwn(values, 'image') ? values.image as S2Json[] : [];
    const parameters = Object.fromEntries(['maxOutputTokens', 'temperature', 'thinkingMode'].flatMap(key => {
      const items = Object.hasOwn(values, key) ? values[key] as S2Json[] : [];
      return items.length ? [[key, items[0]]] : [];
    })) as S2ModelTestParameterInput;
    const snapshot = structuredClone(call), key = snapshot.idempotencyKey;
    const fingerprint = JSON.stringify([snapshot.protocolVersion, snapshot.id, snapshot.sceneId, snapshot.runId, snapshot.nodeId, snapshot.revision,
      snapshot.pluginId, snapshot.pluginVersion, snapshot.capabilityId, snapshot.idempotencyKey, snapshot.inputs, prompt, input, imageRefs, parameters]);
    const previous = this.#memo.get(key), previousKey = this.#invocationKeys.get(snapshot.id);
    if (previousKey !== undefined && previousKey !== key || previous && previous.fingerprint !== fingerprint) throw new Error('S2 模型测试同调用或幂等键不能更换输入、节点或修订号');
    if (previous) return previous.promise.then(outcome => structuredClone(outcome));
    const { request, parameters: actualParameters } = this.#prepare(prompt, input, imageRefs, parameters);
    const record: S2ModelTestRecord = { id: snapshot.id, nodeId: snapshot.nodeId, status: 'pending', output: '', outputOmitted: 0, outputComplete: false,
      prompt, input, imageIds: (request.images ?? []).map(image => image.assetId), parameters: actualParameters };
    // No await or transport call may occur before both limits and the immutable memo identity are reserved.
    this.#usedRequests++; this.#reservedOutputTokens += this.#limits.maxOutputTokens; this.#records.push(record);
    const controller = new AbortController(); this.#controllers.add(controller);
    const promise = Promise.resolve().then(() => this.#run(snapshot, request, record, signal, controller));
    this.#invocationKeys.set(snapshot.id, key); this.#memo.set(key, { fingerprint, promise });
    return promise.then(outcome => structuredClone(outcome));
  }
  async #run(call: S2PluginInvocation, request: LlmCallRequest, record: S2ModelTestRecord, signal: AbortSignal, controller: AbortController): Promise<S2PluginOutcome> {
    let timedOut = false;
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted || !this.#active) controller.abort();
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, TIMEOUT_MS);
    let rejectAbort: (() => void) | undefined;
    try {
      const stopped = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(new ModelTestFailure(timedOut ? 'MODEL_TEST_TIMEOUT' : 'MODEL_TEST_CANCELLED', timedOut ? '模型测试已超时；保留用量，不自动重试' : '模型测试已取消；保留用量，不自动重试'));
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
      });
      if (controller.signal.aborted) rejectAbort!();
      const operation = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new ModelTestFailure('MODEL_TEST_CANCELLED', '模型测试已取消；保留用量，不自动重试');
        if (request.images?.length) {
          const refs = request.images.map(image => ({ resourceId: image.assetId }));
          const current = this.#imageResolver ? validateLlmImages(this.#imageResolver(refs)) : [];
          if (JSON.stringify(current) !== JSON.stringify(request.images)) throw new ModelTestFailure('MODEL_TEST_IMAGE_REVOKED', '已确认图片已经撤回或变化，未发送请求');
        }
        return this.#invoke(structuredClone(request), { signal: controller.signal });
      });
      const response = await Promise.race([operation, stopped]);
      const raw = response as LlmCallResponse & { refusal?: unknown; tool_calls?: unknown };
      const content = typeof raw?.content === 'string' ? raw.content : '';
      record.output = content; record.outputOmitted = 0;
      const finish = raw?.diagnostics?.finishReason;
      if (typeof finish === 'string') record.finishReason = /^[A-Za-z][A-Za-z0-9_ -]{0,79}$/.test(finish) ? finish : 'unrecognized';
      if (raw?.usage && typeof raw.usage === 'object') {
        const usage: NonNullable<S2ModelTestRecord['usage']> = {};
        for (const field of ['promptTokens', 'completionTokens'] as const) if (Number.isSafeInteger(raw.usage[field]) && raw.usage[field] >= 0) usage[field] = raw.usage[field];
        if (Object.keys(usage).length) record.usage = usage;
      }
      if (record.usage?.completionTokens !== undefined && record.usage.completionTokens > record.parameters.maxOutputTokens) throw new ModelTestFailure('MODEL_TEST_USAGE_EXCEEDED', '服务商报告的输出用量超过本次请求上限；已关闭本局模型权限，保留用量记录，不继续调用');
      if (controller.signal.aborted || !this.#active) throw new ModelTestFailure(timedOut ? 'MODEL_TEST_TIMEOUT' : 'MODEL_TEST_CANCELLED', '模型测试已停止；保留用量，不发布产物');
      const normalized = typeof finish === 'string' ? finish.trim().toLowerCase().replace(/[-\s]+/gu, '_') : '';
      const refusal = raw?.refusal ?? (raw?.diagnostics as Record<string, unknown> | undefined)?.refusal;
      if (refusal !== undefined && refusal !== null && refusal !== false && refusal !== '') throw new ModelTestFailure('MODEL_TEST_REFUSAL', '模型返回拒绝标记；保留已收到的原始文字，不发布成功产物');
      if (raw?.toolCalls !== undefined && (!Array.isArray(raw.toolCalls) || raw.toolCalls.length)
        || raw?.tool_calls !== undefined && (!Array.isArray(raw.tool_calls) || raw.tool_calls.length)) throw new ModelTestFailure('MODEL_TEST_TOOL_CALL', '模型返回工具调用而非完整文本；未运行工具或发布成功产物');
      if (!['stop', 'end_turn', 'stop_sequence', 'eos'].includes(normalized)) throw new ModelTestFailure('MODEL_TEST_INCOMPLETE', '模型未提供可确认的完整结束状态；保留已收到的全部原文，不判定服务商或内容错误，不发布产物');
      if (!content.trim() || content.length > TEXT_LIMIT) throw new ModelTestFailure('MODEL_TEST_OUTPUT_INVALID', '模型输出为空或超过6000字；保留已收到的全部原文，不截断后交给下游');
      record.status = 'succeeded'; record.outputComplete = true;
      return { status: 'succeeded', outputs: { text: [{ protocolVersion: 1, id: `artifact-${crypto.randomUUID()}`, type: { id: 'core.text', version: 1 }, complete: true,
        source: { sceneId: call.sceneId, runId: call.runId, nodeId: call.nodeId, revision: call.revision, kind: 'plugin', invocationId: call.id }, payload: { kind: 'inline', value: content } }] } };
    } catch (error) {
      const cancelled = controller.signal.aborted || !this.#active;
      const imageUnsupported = !!request.images?.length && error instanceof Error && error.message.includes('LLM_IMAGE_UNSUPPORTED:');
      const code = timedOut ? 'MODEL_TEST_TIMEOUT' : cancelled ? 'MODEL_TEST_CANCELLED' : error instanceof ModelTestFailure ? error.code : imageUnsupported ? 'MODEL_TEST_IMAGE_UNSUPPORTED' : 'MODEL_TEST_REQUEST_FAILED';
      const safeHttp = error instanceof Error ? readSafeLlmHttpFailure(error.message) : undefined;
      record.status = timedOut ? 'timed-out' : cancelled ? 'cancelled' : 'failed'; record.outputComplete = false;
      record.error = timedOut ? '模型测试已超时；调用可能已计费，保留用量，不自动重试'
        : cancelled ? '模型测试已取消；调用可能已计费，保留用量，不自动重试'
          : error instanceof ModelTestFailure ? error.message : imageUnsupported ? '服务端不支持本次图片输入；原图和用量记录保留，不更换模型、OCR、丢图发送或自动重试'
            : safeHttp?.detail || '模型测试请求未完成；保留用量和已收到的原文，不自动重试';
      if (code === 'MODEL_TEST_USAGE_EXCEEDED') this.#deactivate({ code, message: record.error });
      return { status: cancelled ? 'cancelled' : 'failed', outputs: {}, error: { code, message: record.error } };
    } finally {
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
      this.#controllers.delete(controller);
    }
  }
  close() { this.#deactivate({ code: 'MODEL_TEST_CLOSED', message: '模型测试授权已关闭；未发送的请求已停止，原用量与记录保留，不自动重试或重置预算' }); }
}
