import type { LlmCallRequest, LlmCallResponse, LlmProvider } from '../../types';
import { getWorkflowById } from '../../workflows/workflowRegistry';
import { ensureJsonObjectPrompt } from '../../workflows/structuredOutput';
import { ensureLlmSettingsLoaded, readLlmSettingsForUse } from '../llmStorage';

/** Local planning ceiling, NOT the discovered capacity of an unknown model. */
export const SCENE_LOCAL_CONTEXT_LIMIT = 65536;
export interface SceneContextBudgetDiagnostics {
  method: 'character-estimate-v1'; capacitySource: 'provider-configured' | 'local-planning-limit';
  contextWindowTokens: number; estimatedInputTokens: number; outputReserveTokens: number;
  safetyReserveTokens: number; estimatedTotalTokens: number; droppedHistoryMessages: number;
  omittedContextIds: string[];
  repairOutputCapped?: boolean;
  requestedOutputTokens?: number;
}
export interface SceneContextBudgetOptions {
  provider?: Pick<LlmProvider, 'contextWindowTokens'> | null;
  systemPrompt?: string; maxOutputTokens?: number; outputSchema?: object;
}
export class SceneContextBudgetError extends Error {
  constructor(readonly code: 'protected-context-too-large' | 'invalid-context-window' | 'invalid-context-parts',
    readonly diagnostics?: SceneContextBudgetDiagnostics) {
    super(code === 'protected-context-too-large'
      ? '场景必要上下文与输出预留超过本地估算预算；已保留最新输入、场景约束及实验原文。请核对模型上下文配置或缩小本次材料后重试。'
      : code === 'invalid-context-window' ? '场景模型上下文配置无效，请填写 4096–2097152 的整数。'
        : '场景辅助上下文声明无效；未裁剪必要输入，也未发送模型请求。');
    this.name = 'SceneContextBudgetError';
  }
}
export const isSceneContextWorkflow = (workflow: string) => workflow === 'agent-scene-setup' || workflow.startsWith('scene-');
/** Heuristic only; not tokenizer accuracy, billing usage, or a capacity guarantee. */
export const estimateSceneTextTokens = (text: string) => Math.ceil(text.length * 1.2);
const serialized = (value: unknown) => value === undefined ? '' : JSON.stringify(value);
function rootObject(text: string): Record<string, unknown> | undefined {
  try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : undefined; }
  catch { return undefined; }
}
export function estimateSceneRequestTokens(request: LlmCallRequest, options: SceneContextBudgetOptions = {}): number {
  const workflow = getWorkflowById(request.workflow);
  const schema = options.outputSchema ?? request.outputSchema ?? workflow?.outputSchema;
  const prompt = ensureJsonObjectPrompt(options.systemPrompt ?? (request.systemPromptOverride || workflow?.systemPrompt || ''), schema);
  return estimateSceneTextTokens([prompt, request.userInput, serialized(request.context), serialized(request.tools),
    serialized(schema), serialized(request.messages), serialized(request.agentMessages)].join('\n'))
    + 128 + (request.messages?.length || 0) * 32 + (request.agentMessages?.length || 0) * 64 + (request.images?.length || 0) * 4096;
}
export function fitSceneContextBudget(request: LlmCallRequest, options: SceneContextBudgetOptions = {}): {
  request: LlmCallRequest; diagnostics?: SceneContextBudgetDiagnostics;
} {
  if (!isSceneContextWorkflow(request.workflow)) return { request };
  const configured = options.provider?.contextWindowTokens;
  if (configured !== undefined && (!Number.isSafeInteger(configured) || configured < 4096 || configured > 2097152)) {
    throw new SceneContextBudgetError('invalid-context-window');
  }
  const limit = configured ?? SCENE_LOCAL_CONTEXT_LIMIT;
  const output = options.maxOutputTokens ?? request.maxTokensOverride ?? getWorkflowById(request.workflow)?.defaultParams.maxTokens ?? 4096;
  if (!Number.isFinite(output) || output <= 0) throw new SceneContextBudgetError('invalid-context-parts');
  const repairBase = request.sceneRepairBaseOutputTokens;
  if (repairBase !== undefined && (!Number.isSafeInteger(repairBase) || repairBase < 256 || repairBase > output)) {
    throw new SceneContextBudgetError('invalid-context-parts');
  }
  const result: LlmCallRequest = { ...request, ...(request.messages ? { messages: request.messages.map(message => ({ ...message })) } : {}) };
  const blocks = request.sceneOptionalContext || [];
  const fields = request.sceneOptionalJsonFields || [];
  if (!Array.isArray(blocks) || blocks.length > 32 || blocks.some(block => !block || !/^[\w.-]{1,100}$/u.test(block.id)
    || typeof block.text !== 'string' || (block.sourceIds !== undefined && (!Array.isArray(block.sourceIds)
      || block.sourceIds.some(id => typeof id !== 'string' || id.length > 200))))
    || new Set(blocks.map(block => block.id)).size !== blocks.length
    || !Array.isArray(fields) || fields.some(field => field !== 'recentInteraction')) {
    throw new SceneContextBudgetError('invalid-context-parts');
  }
  const original = rootObject(request.userInput);
  if (fields.length && !original) throw new SceneContextBudgetError('invalid-context-parts');
  if (blocks.length && original && Object.prototype.hasOwnProperty.call(original, 'optionalContextBlocks')) {
    throw new SceneContextBudgetError('invalid-context-parts');
  }
  const retained = [...blocks], omittedFields = new Set<string>();
  const diagnostics: SceneContextBudgetDiagnostics = { method: 'character-estimate-v1',
    capacitySource: configured === undefined ? 'local-planning-limit' : 'provider-configured', contextWindowTokens: limit,
    estimatedInputTokens: 0, outputReserveTokens: Math.max(256, Math.min(32768, Math.round(output))),
    safetyReserveTokens: Math.max(512, Math.ceil(limit * .1)), estimatedTotalTokens: 0,
    droppedHistoryMessages: 0, omittedContextIds: [] };
  const render = () => {
    const omitted = [...diagnostics.omittedContextIds, ...(diagnostics.droppedHistoryMessages ? ['history-messages:' + diagnostics.droppedHistoryMessages] : [])];
    if (original && (blocks.length || omitted.length)) {
      const root = { ...original }; for (const field of omittedFields) delete root[field];
      if (retained.length) root.optionalContextBlocks = retained;
      if (omitted.length) root.contextBudgetOmissions = [...(Array.isArray(root.contextBudgetOmissions) ? root.contextBudgetOmissions : []), ...omitted];
      result.userInput = JSON.stringify(root);
    } else {
      result.userInput = [retained.length ? retained.map(block => '[辅助上下文 ' + block.id + (block.sourceIds?.length ? '；来源 ' + block.sourceIds.join(',') : '') + ']\n' + block.text).join('\n\n') : '',
        omitted.length ? '[上下文预算说明：已省略 ' + omitted.join(', ') + '；缺失历史不得当作不存在或已验证。]' : '', request.userInput].filter(Boolean).join('\n\n');
    }
    diagnostics.estimatedInputTokens = estimateSceneRequestTokens(result, options);
    diagnostics.estimatedTotalTokens = diagnostics.estimatedInputTokens + diagnostics.outputReserveTokens + diagnostics.safetyReserveTokens;
  };
  render();
  const experiment = request.workflow === 'scene-model-experiment' || request.workflow === 'scene-experiment-evaluate';
  if (!experiment && !request.agentMessages?.length) {
    while (diagnostics.estimatedTotalTokens > limit && result.messages?.length) {
      result.messages.shift(); diagnostics.droppedHistoryMessages++; render();
    }
    while (diagnostics.estimatedTotalTokens > limit && retained.length) {
      diagnostics.omittedContextIds.push(retained.shift()!.id); render();
    }
    for (const field of fields) {
      if (diagnostics.estimatedTotalTokens <= limit) break;
      if (!Object.prototype.hasOwnProperty.call(original, field)) continue;
      omittedFields.add(field); diagnostics.omittedContextIds.push('json:' + field); render();
    }
  }
  if (diagnostics.estimatedTotalTokens > limit) {
    if (!experiment && repairBase !== undefined && repairBase < output) {
      const fallback = fitSceneContextBudget({ ...request, maxTokensOverride: repairBase, sceneRepairBaseOutputTokens: undefined },
        { ...options, maxOutputTokens: repairBase });
      if (fallback.diagnostics) { fallback.diagnostics.repairOutputCapped = true; fallback.diagnostics.requestedOutputTokens = output; }
      return fallback;
    }
    throw new SceneContextBudgetError('protected-context-too-large', diagnostics);
  }
  delete result.sceneOptionalContext; delete result.sceneOptionalJsonFields;
  delete result.sceneRepairBaseOutputTokens;
  return { request: result, diagnostics };
}
export function withSceneContextBudget(invoke: (request: LlmCallRequest) => Promise<LlmCallResponse>,
  options?: SceneContextBudgetOptions | ((request: LlmCallRequest) => SceneContextBudgetOptions)) {
  return async (request: LlmCallRequest): Promise<LlmCallResponse> => {
    let effective = typeof options === 'function' ? options(request) : options;
    if (effective === undefined && isSceneContextWorkflow(request.workflow) && typeof localStorage !== 'undefined') {
      try {
        await ensureLlmSettingsLoaded(); const settings = readLlmSettingsForUse();
        const provider = selectLlmProvider(settings, request.workflow);
        effective = { provider };
      } catch { /* Pure Node fixtures/absent settings use the explicit local planning limit. */ }
    }
    const fitted = fitSceneContextBudget(request, effective);
    const response = await invoke(fitted.request);
    if (!fitted.diagnostics) return response;
    const inner = response.diagnostics?.sceneContextBudget;
    const combined = inner ? { ...fitted.diagnostics, ...inner,
      droppedHistoryMessages: fitted.diagnostics.droppedHistoryMessages + inner.droppedHistoryMessages,
      omittedContextIds: [...new Set([...fitted.diagnostics.omittedContextIds, ...inner.omittedContextIds])],
    } : fitted.diagnostics;
    return { ...response, diagnostics: { ...response.diagnostics, sceneContextBudget: combined } };
  };
}
import { selectLlmProvider } from '../llmProviderSelection';
