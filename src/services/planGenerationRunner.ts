import type { LlmCallRequest, LlmCallResponse } from '../types';
import { readSafeLlmHttpFailure } from './llmHttpFailure';
import { isPlanGenerationTruncated, readPlanGenerationResponse } from './planGenerationResponse';

export const PLAN_GENERATION_BASE_TOKENS = 12288;
export const PLAN_GENERATION_RETRY_TOKENS = 16384;
const COMPATIBILITY_TOKENS = 8192;
const MAX_CALLS = 3;

/** A local recovery policy cursor, not discovered model-capacity metadata. */
export interface PlanGenerationRetryState {
  maxTokens: number;
  compact: boolean;
  ceiling?: number;
  /** Missing only in pre-adaptation cursors: those retain exact total limits. */
  tokenBudgetMode?: 'response' | 'total';
}

const COMPACT_JSON = '\n\n【计划输出长度约束】只输出一个紧凑、完整的 JSON 对象。省略无用的空字段、null、重复元信息和排版缩进，不写教材正文或长篇解释。保留用户完整学习目标、硬约束、先修与必修要求、真实来源编号，以及核心和扩展范围；不得通过删除必要内容或放宽约束来压缩计划。信息不足时仍按原 question 协议提出必要追问。';
const OUTPUT_RECOVERY = '\n\n【完整重生成，仅一次截断恢复】上一次输出达到长度上限；不要续写任何残片，不要重复已输出的前缀。请从头返回一个可独立解析的完整 JSON 对象，进一步缩短字段表述并省略非必要空字段，但必须保留原目标、全部明确约束、真实先修和必修范围。不得默默缩小学习目标，也不要为了恢复而跳过必要澄清。';

function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('计划生成已停止', 'AbortError');
}

function tokenBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 256 && value <= 32768;
}

function copyState(state: PlanGenerationRetryState): PlanGenerationRetryState {
  return { maxTokens: state.maxTokens, compact: state.compact, ...(state.ceiling === undefined ? {} : { ceiling: state.ceiling }),
    ...(state.tokenBudgetMode === undefined ? {} : { tokenBudgetMode: state.tokenBudgetMode }) };
}

async function invokeCancellable(
  invoke: (request: LlmCallRequest) => Promise<LlmCallResponse>, request: LlmCallRequest, signal?: AbortSignal,
): Promise<LlmCallResponse> {
  checkAbort(signal);
  if (!signal) return invoke(request);
  let stop!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new DOMException('计划生成已停止', 'AbortError'));
    signal.addEventListener('abort', stop, { once: true });
  });
  try {
    return await Promise.race([Promise.resolve().then(() => { checkAbort(signal); return invoke(request); }), cancelled]);
  } finally { signal.removeEventListener('abort', stop); }
}

/** At most one truncation recovery plus one compatibility fallback. Transport,
 * safety and ordinary JSON failures never spend a second model call. */
export async function runPlanGeneration(input: {
  request: LlmCallRequest;
  invoke: (request: LlmCallRequest) => Promise<LlmCallResponse>;
  signal?: AbortSignal;
  resume?: PlanGenerationRetryState;
  onState?: (state: PlanGenerationRetryState) => void;
  onProgress?: (message: string) => void;
}): Promise<{ parsed: Record<string, any>; calls: number; recovered: boolean }> {
  checkAbort(input.signal);
  if (input.request.workflow !== 'plan-generation') throw new Error('计划恢复器不能用于其他工作流。');
  const initialTokens = input.request.maxTokensOverride ?? PLAN_GENERATION_BASE_TOKENS;
  if (!tokenBudget(initialTokens) || input.resume && (!tokenBudget(input.resume.maxTokens)
    || typeof input.resume.compact !== 'boolean'
    || input.resume.tokenBudgetMode !== undefined && !['response', 'total'].includes(input.resume.tokenBudgetMode)
    || input.resume.ceiling !== undefined && (!tokenBudget(input.resume.ceiling) || input.resume.maxTokens > input.resume.ceiling))) {
    throw new Error('计划输出预算或恢复状态无效，未发送模型请求。');
  }
  const original = structuredClone(input.request);
  let state: PlanGenerationRetryState = input.resume ? copyState(input.resume)
    : { maxTokens: initialTokens, compact: false, tokenBudgetMode: input.request.tokenBudgetMode || 'response' };
  state.tokenBudgetMode = state.ceiling !== undefined ? 'total' : state.tokenBudgetMode || 'total';
  let calls = 0, truncationRecovered = false, compatibilityUsed = false;
  let lastAcceptedTokens: number | undefined;
  const exhausted = () => new Error('模型输出被截断，已停止自动重试。当前草图与输入已保留；可检查模型输出配置或修改后手动重试。');

  while (calls < MAX_CALLS) {
    checkAbort(input.signal);
    input.onState?.(copyState(state));
    checkAbort(input.signal);
    const recovering = calls > 0 || state.compact;
    const request: LlmCallRequest = {
      ...structuredClone(original),
      userInput: original.userInput + COMPACT_JSON + (state.compact ? OUTPUT_RECOVERY : ''),
      maxTokensOverride: state.maxTokens,
      // New cursors retain their response allowance across resume. Legacy
      // cursors and provider compatibility ceilings remain exact total caps.
      tokenBudgetMode: state.tokenBudgetMode,
      ...(recovering ? { temperatureOverride: Math.min(0.3, Math.max(0, original.temperatureOverride ?? 0.2)), thinkingMode: 'disabled' as const } : {}),
    };
    calls++;
    let response: LlmCallResponse;
    try {
      response = await invokeCancellable(input.invoke, request, input.signal);
      checkAbort(input.signal);
    } catch (error) {
      checkAbort(input.signal);
      const failure = readSafeLlmHttpFailure(error instanceof Error ? error.message : String(error));
      if (!compatibilityUsed && calls < MAX_CALLS && failure
        && ['max-tokens-invalid', 'context-too-long'].includes(failure.reason)) {
        const fallback = Math.min(lastAcceptedTokens ?? COMPATIBILITY_TOKENS, state.maxTokens);
        if (fallback < state.maxTokens) {
          compatibilityUsed = true;
          state = { maxTokens: fallback, compact: state.compact, tokenBudgetMode: 'total',
            ceiling: Math.min(state.ceiling ?? fallback, fallback) };
          input.onState?.(copyState(state));
          checkAbort(input.signal);
          input.onProgress?.('模型服务不接受较高输出预算，正在使用兼容额度重新请求；本轮仅回退一次。');
          checkAbort(input.signal);
          continue;
        }
      }
      throw error;
    }
    lastAcceptedTokens = state.maxTokens;
    if (isPlanGenerationTruncated(response)) {
      const next: PlanGenerationRetryState = { maxTokens: Math.min(state.ceiling ?? 32768, Math.max(state.maxTokens, PLAN_GENERATION_RETRY_TOKENS)),
        compact: true, tokenBudgetMode: state.tokenBudgetMode, ...(state.ceiling === undefined ? {} : { ceiling: state.ceiling }) };
      if (truncationRecovered || calls >= MAX_CALLS || next.maxTokens === state.maxTokens && state.compact) throw exhausted();
      truncationRecovered = true;
      state = next;
      input.onState?.(copyState(state));
      checkAbort(input.signal);
      input.onProgress?.('模型输出达到长度上限，正在按恢复预算紧凑重生成完整计划；本轮仅恢复一次。');
      checkAbort(input.signal);
      continue;
    }
    const parsed = readPlanGenerationResponse(response);
    checkAbort(input.signal);
    return { parsed, calls, recovered: calls > 1 || Boolean(input.resume?.compact) };
  }
  throw exhausted();
}
