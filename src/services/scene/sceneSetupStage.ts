import type { LlmCallRequest, LlmCallResponse } from '../../types';
import { parseJsonLenient } from '../reviewSegmentScoring';
import { SceneUnderstandingError } from './sceneUnderstanding';
import { readSafeLlmHttpFailure } from '../llmHttpFailure';
import { isSceneOutputTruncated } from './sceneOutputSafety';
import { SceneContextBudgetError, withSceneContextBudget } from './sceneContextBudget';

export type SceneSetupStage = 'understand' | 'assemble' | 'review' | 'flow' | 'instructions' | 'generate' | 'accept' | 'repair';
export interface SceneSetupDiagnostic {
  stage: SceneSetupStage; code: string; attempt: number; retrying: boolean;
  requestedMaxTokens?: number; maxTokens?: number; outputChars?: number;
  completionTokens?: number; reasoningTokens?: number; hadReasoningContent?: boolean;
  finishReason?: string;
  /** Requested policy, not a claim that an arbitrary provider applied it. */
  thinkingModeRequested?: 'enabled' | 'disabled' | 'provider-default';
}
/** Private per-logical-stage cursor. Explicit retries reuse the last budget, not a fresh repair allowance. */
export interface SceneSetupRetryState {
  version: 1; attempt: 1 | 2; calls: number; maxTokens: number;
  repair?: { code: string; detail: string };
  repairBaseOutputTokens?: number;
  /** New cursors preserve adaptive response budgets; old cursors stay exact. */
  tokenBudgetMode?: 'response' | 'total';
}
const LABELS = { understand: '需求理解', assemble: '能力装配', review: '组合检查', flow: '流程设计', instructions: '行为指令设计',
  generate: '完整生成', accept: '语义验收', repair: '定向修复' };
const TOKENS: Record<SceneSetupStage, number> = { understand: 4096, assemble: 4096, review: 4096,
  flow: 6144, instructions: 8192, generate: 16384, accept: 6144, repair: 16384 };
export class SceneSetupError extends Error {
  constructor(readonly stage: SceneSetupStage, readonly code: string, detail: string, readonly attempts = 1) {
    super(`场景${LABELS[stage]}失败 [${code}]：${detail}`); this.name = 'SceneSetupError';
  }
}
function checkAbort(signal?: AbortSignal) { if (signal?.aborted) throw new DOMException('搭建已停止', 'AbortError'); }
function json(response: LlmCallResponse): Record<string, unknown> {
  const value = response.parsedJson ?? parseJsonLenient(response.content);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SceneUnderstandingError('模型响应必须是 JSON 对象。', 'invalid-json');
  return value as Record<string, unknown>;
}
/** Only malformed model output gets one repair; transport/auth failures are not disguised as missing user information. */
export async function runSceneSetupStage<T>(input: {
  stage: SceneSetupStage; request: LlmCallRequest; invoke: (request: LlmCallRequest) => Promise<LlmCallResponse>;
  validate: (raw: Record<string, unknown>) => T; maxOutputChars: number; signal?: AbortSignal;
  onStage?: (stage: SceneSetupStage) => void;
  onDiagnostic?: (diagnostic: SceneSetupDiagnostic) => void;
  resume?: SceneSetupRetryState;
  onRetryState?: (state: SceneSetupRetryState) => void;
}): Promise<{ payload: T; llmCalls: number }> {
  const baseTokens = input.request.maxTokensOverride ?? TOKENS[input.stage];
  if (input.resume && (input.resume.version !== 1 || ![1, 2].includes(input.resume.attempt)
    || !Number.isInteger(input.resume.calls) || input.resume.calls < 0
    || !Number.isInteger(input.resume.maxTokens) || input.resume.maxTokens < 1 || input.resume.maxTokens > 32768
    || input.resume.tokenBudgetMode !== undefined && !['response', 'total'].includes(input.resume.tokenBudgetMode))) {
    throw new SceneSetupError(input.stage, 'invalid-resume-state', '阶段恢复状态无效，未发送模型请求。');
  }
  const state: SceneSetupRetryState = input.resume ? structuredClone(input.resume)
    : { version: 1, attempt: 1, calls: 0, maxTokens: baseTokens, tokenBudgetMode: input.request.tokenBudgetMode || 'response' };
  state.tokenBudgetMode ||= 'total';
  let repair = state.repair;
  let llmCalls = 0;
  const invoke = withSceneContextBudget(input.invoke);
  input.onStage?.(input.stage);
  for (let attempt = state.attempt; attempt <= 2; attempt++) {
    checkAbort(input.signal);
    let response: LlmCallResponse;
    try {
      let userInput = input.request.userInput;
      if (repair) {
        try { userInput = JSON.stringify({ ...JSON.parse(userInput), outputRepair: { ...repair, attempt, instruction: '保留原目标和显式约束，仅修复指出字段或压缩摘要；不是要求用户补资料。' } }); }
        catch { userInput += `\n\n【输出格式修复，仅重试一次】${JSON.stringify(repair)}`; }
      }
      state.attempt = attempt as 1 | 2;
      state.calls++;
      state.repair = repair;
      input.onRetryState?.(structuredClone(state));
      llmCalls++;
      response = await invoke({ ...input.request, maxTokensOverride: state.maxTokens, temperatureOverride: 0.2,
        tokenBudgetMode: state.tokenBudgetMode,
        sceneRepairBaseOutputTokens: state.repairBaseOutputTokens, userInput });
      checkAbort(input.signal);
    } catch (error) {
      checkAbort(input.signal);
      if (error instanceof SceneContextBudgetError) throw error;
      if (error instanceof Error && error.name === 'AbortError') throw error;
      const message = error instanceof Error ? error.message : '';
      const status = /\b([45]\d\d)\b/u.exec(message)?.[1];
      const safeFailure = readSafeLlmHttpFailure(message);
      const code = status ? `model-http-${status}` : /未找到可用.*LLM|未配置|模型配置/u.test(message) ? 'model-not-configured' : 'model-request-failed';
      // Never surface raw provider URLs, credentials or payloads.
      const detail = status ? `模型服务返回 HTTP ${status}：${safeFailure?.detail || '请求被拒绝；需要检查请求参数或服务商配置。'}` : code === 'model-not-configured'
        ? '没有可用的模型配置，请检查场景搭设工作流绑定。' : '模型调用未成功，请检查连接、超时和服务状态；这不是需求缺少信息。';
      input.onDiagnostic?.({ stage: input.stage, code, attempt, retrying: false });
      throw new SceneSetupError(input.stage, code, detail, attempt);
    }
    const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
    const rawReason = response.diagnostics?.finishReason?.trim().toLowerCase().replace(/[-\s]+/gu, '_');
    const finishReason = rawReason === undefined ? undefined : ['stop', 'length', 'max_tokens', 'max_output_tokens', 'end_turn', 'tool_calls', 'eos_token'].includes(rawReason) ? rawReason : 'other';
    const usageDiagnostic: Omit<SceneSetupDiagnostic, 'stage' | 'code' | 'attempt' | 'retrying'> = {
      requestedMaxTokens: state.maxTokens,
      maxTokens: finite(response.diagnostics?.sceneContextBudget?.outputReserveTokens) ?? state.maxTokens,
      outputChars: response.content.length, completionTokens: finite(response.usage?.completionTokens),
      reasoningTokens: finite(response.diagnostics?.reasoningTokens),
      hadReasoningContent: typeof response.diagnostics?.hadReasoningContent === 'boolean' ? response.diagnostics.hadReasoningContent : undefined,
      finishReason, thinkingModeRequested: input.request.thinkingMode ?? 'provider-default',
    };
    input.onDiagnostic?.({ stage: input.stage, code: 'model-response', attempt, retrying: false, ...usageDiagnostic });
    try {
      if (isSceneOutputTruncated(response)) {
        throw new SceneUnderstandingError('模型输出达到长度上限；保持全部约束并返回完整结构。', 'output-truncated');
      }
      let raw: Record<string, unknown>;
      try { raw = json(response); } catch { throw new SceneUnderstandingError('模型没有返回完整有效的 JSON 对象。', 'invalid-json'); }
      const payload = input.validate(raw);
      if (JSON.stringify(payload).length > input.maxOutputChars) throw new SceneUnderstandingError('摘要超出阶段预算，请缩短描述和引用，不删除约束。', 'output-too-large');
      return { payload, llmCalls };
    } catch (error) {
      if (!(error instanceof SceneUnderstandingError)) throw error;
      repair = { code: error.code, detail: error.message };
      state.repair = repair;
      if (attempt === 1) {
        state.attempt = 2;
        if (error.code === 'output-truncated') {
          state.repairBaseOutputTokens = baseTokens;
          state.maxTokens = Math.min(32768, baseTokens * 2);
        }
      }
      input.onRetryState?.(structuredClone(state));
      input.onDiagnostic?.({ stage: input.stage, code: error.code, attempt, retrying: attempt === 1, ...usageDiagnostic });
      if (attempt === 2) throw new SceneSetupError(input.stage, error.code, `模型输出修复后仍未通过检查：${error.message}`, attempt);
    }
  }
  throw new SceneSetupError(input.stage, 'stage-incomplete', '本阶段未完成。');
}
