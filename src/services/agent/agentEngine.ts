import type { AgentExecutionMode, LlmConversationMessage } from '../../types';
import { wantsCognitionComparison } from '../cognition/retrieval';
import { resolveInquiryQuestion } from '../cognition/inquiry';
import { runCognitionInquiry } from './cognitionInquiry';
import { callLLM } from '../llmService';
import { saveLearningEpisode } from '../memory/episodeStore';
import { readAgentDataVersion, recordAgentTurnAudit } from './auditStore';
import { hasActiveAgentDraft } from './activeDraft';
import { applyAgentSkill, getAgentSkill, isAgentSelfMetaQuestion } from './skillRegistry';
import { buildQaLearningEpisode, readQaEvidenceResult } from './qaMemory';
import {
  buildPostToolReviewPrompt,
  createPostToolReviewState,
  runPostToolReviews,
  type PostToolReviewState,
} from './postToolReview';
import { runAgentApprovalNode, runAgentApprovalResumeNode } from './runtime/approvalNode';
import { runAgentApprovalAuditNode, runAgentTurnAuditNode } from './runtime/auditNode';
import { restoreAgentRunCheckpoint } from './runtime/checkpoint';
import { runAgentCoordinationNode } from './runtime/coordinationNode';
import { runAgentFinalAnswerNode } from './runtime/finalAnswerNode';
import { runAgentGraphSegment } from './runtime/graphRunner';
import { assertAgentGraphTransition, resolveAgentGraphTransition } from './runtime/graphTopology';
import { runAgentMemoryNode } from './runtime/memoryNode';
import { throwIfAgentAborted } from './runtime/nodeRunner';
import { runAgentRouteNode } from './runtime/routeNode';
import { runAgentToolLoopNode } from './runtime/toolLoopNode';
import {
  createAgentRunState,
  type AgentLlmCaller,
  type AgentNodeEvent,
  type AgentRunState,
} from './runtime/types';
import {
  describeToolConfirmation,
  executeTool,
  executeApprovedToolBatch,
  getTool,
  listToolsForRole,
  toolRequiresApproval,
  toLlmTools,
} from './toolRegistry';
import type {
  AgentPendingApproval,
  AgentObservedOutcome,
  AgentActivityUpdate,
  AgentRole,
  AgentRuntimeContext,
  AgentRuntimeMetrics,
  AgentToolStep,
  AgentTurnResult,
} from './types';
import { AGENT_BASE_SYSTEM_PROMPT } from '../../workflows/agentPrompt';
import { buildAgentReplyPolicy, resolveAgentQaQuestion } from './replyPolicy';
import { localDateString, validateCreatePlanDatesForRequest } from './temporalContext';
import { agentToolEffectKey, createAgentApprovalBinding, validateAgentApprovalBinding } from './approvalBinding';
import { agentActionRecoveryReason, reconcileAgentActionReply, verifyAgentObservedOutcome } from './actionOutcome';
import { AgentRunFailure, type AgentRunRecovery } from './runRecovery';
import { constrainAgentSequenceCall, type AgentSequenceExecution } from './skillSequence';
import { createQaSupplementSession, QA_SUPPLEMENT_TOOL, QA_SUPPLEMENT_GUIDANCE, type QaSupplementResult } from './qaSupplement';
import { searchDocuments, readDocumentArgumentEvidence } from '../documentRagClient';
import { normalizeAgentExecutionMode, normalizeAgentToolCallLimit, resolveAgentExecutionPolicy } from './executionPolicy';
import { compactAgentConversationContext } from './conversationContext';
import { AGENT_OPERATION_TOOLS, expandAgentCapabilities, agentToolAvailabilityError } from './capabilities';
import { AGENT_WORKFLOW_GUIDANCE } from './workflowToolNames';
import { CAPACITY_GUIDANCE } from '../learningCapacity';
import { isCognitionManagerOpenRequest } from '../cognition/managerWindow';
import { COGNITION_READ_GUIDANCE, isCognitionTopologyRequest } from './cognitionReadPolicy';

const DEFAULT_TOOLS = [
  'query_cognition', 'prepare_cognition_change', 'commit_cognition_change',
  'open_cognition_manager',
  ...AGENT_OPERATION_TOOLS,
  'query_project_textbook', 'read_project_textbook', 'edit_project_textbook', 'prepare_project_textbook', 'generate_project_textbook', 'regenerate_textbook_chapters', 'archive_textbook_job', 'clear_textbook_draft_cache', 'query_textbook_job', 'open_project_textbook',
  'create_knowledge_note',
  'query_learner_profile', 'query_mastery', 'get_review_queue', 'search_notes', 'search_documents', 'retrieve_qa_evidence',
  'query_plan_workspace', 'query_plan_portfolio', 'query_plan_tasks', 'adjust_plan_task', 'create_project_plan', 'research_learning_plan', 'query_project_learning_context', 'query_knowledge_notes',
  'query_leaf_project_task_scope', 'append_project_study_tasks', 'append_project_study_task_batch',
  'start_project_task_draft', 'query_project_task_draft', 'stage_project_study_task_batch',
  'stage_project_structure_patches', 'stage_plan_settings_patch', 'stage_plan_milestone_patches',
  'stage_plan_execution_patches', 'start_plan_portfolio_draft', 'stage_plan_portfolio_patches',
  'commit_project_task_draft', 'discard_project_task_draft',
  'start_project_resource_draft', 'query_project_resource_context', 'search_online_learning_resources',
  'query_resource_feedback', 'check_project_resource_health',
  'prepare_project_resource_downloads', 'download_project_resources',
  'query_project_resource_draft', 'stage_project_resource_batch',
  'commit_project_resource_draft', 'discard_project_resource_draft',
  'navigate', 'open_note', 'enter_learning_mode',
  'update_agent_persona',
  'read_notes', 'create_note', 'delete_notes', 'rename_project', 'update_appearance',
];
const GENERAL_TOOLS = [
  'query_cognition',
  'open_cognition_manager',
  ...AGENT_OPERATION_TOOLS,
  'query_learner_profile', 'query_mastery', 'get_review_queue', 'search_notes', 'search_documents',
  'query_plan_workspace', 'query_plan_portfolio', 'query_plan_tasks', 'query_project_learning_context', 'query_knowledge_notes', 'query_leaf_project_task_scope',
  'navigate', 'open_note', 'enter_learning_mode',
  'update_agent_persona',
  'read_notes', 'create_note', 'delete_notes', 'rename_project', 'update_appearance',
];
// 资源草案通常需要“锁定→读取→检索→暂存→确认→总结”，给确认恢复预留轮次。
export const AGENT_ROLES: Record<'default', AgentRole> = {
  default: {
    id: 'default',
    name: '学习助手',
    memoryWorkflow: 'agent-chat',
    allowedTools: GENERAL_TOOLS,
    skillToolCeiling: DEFAULT_TOOLS,
    systemPrompt: `${AGENT_BASE_SYSTEM_PROMPT}\n\n${AGENT_WORKFLOW_GUIDANCE}\n\n${CAPACITY_GUIDANCE}\n\n${COGNITION_READ_GUIDANCE}`,
  },
};

export function trimQaConversationHistory(
  history: LlmConversationMessage[],
  maxMessages = 8,
  maxChars = 4000,
): LlmConversationMessage[] {
  const candidates = history.filter((message) => (
    (message.role === 'user' || message.role === 'assistant')
    && Boolean(message.content?.trim())
    && !message.toolCalls?.length
  ));
  const kept: LlmConversationMessage[] = [];
  let chars = 0;
  for (let index = candidates.length - 1; index >= 0 && kept.length < maxMessages && chars < maxChars; index -= 1) {
    const message = candidates[index];
    const available = maxChars - chars;
    const content = message.content.trim().slice(0, available);
    if (!content) break;
    kept.unshift({ role: message.role, content, citations: message.citations, cognitionReferences: message.cognitionReferences, cognitionInquiry: message.cognitionInquiry });
    chars += content.length;
  }
  return kept;
}

/** Trim history without splitting an assistant tool call from its tool results. */
export function trimAgentConversationHistory(
  history: LlmConversationMessage[],
  maxMessages = 30,
): LlmConversationMessage[] {
  const groups: LlmConversationMessage[][] = [];
  for (let index = 0; index < history.length; index += 1) {
    const message = history[index];
    if (message.role === 'tool') continue;
    const group = [message];
    if (message.role === 'assistant' && message.toolCalls?.length) {
      let cursor = index + 1;
      while (cursor < history.length && history[cursor].role === 'tool') {
        group.push(history[cursor]);
        cursor += 1;
      }
      index = cursor - 1;
    }
    groups.push(group);
  }

  const kept: LlmConversationMessage[][] = [];
  let count = 0;
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index];
    if (kept.length > 0 && count + group.length > maxMessages) break;
    kept.unshift(group);
    count += group.length;
    if (count >= maxMessages) break;
  }
  return kept.flat();
}

export { repairFalseActiveSkillDenial } from './runtime/finalAnswerNode';

interface LoopInput {
  runState: AgentRunState;
  role: AgentRole;
  userText: string;
  messages: LlmConversationMessage[];
  ctx: AgentRuntimeContext;
  systemPrompt: string;
  startRound: number;
  executionMode: AgentExecutionMode;
  toolCallLimit?: number;
  initialTrace?: AgentToolStep[];
  activeSkill?: { id: string; name: string };
  auditRunId: string;
  enablePostToolReview?: boolean;
  signal?: AbortSignal;
  callLlm?: AgentLlmCaller;
  onStep?: (step: AgentToolStep) => void;
  onActivity?: (activity: AgentActivityUpdate) => void;
  onNodeEvent?: (event: AgentNodeEvent) => void;
  initialRuntimeMetrics?: AgentRuntimeMetrics;
  initialPostToolReviewState?: PostToolReviewState;
}

interface LoopOutcomeBase {
  messages: LlmConversationMessage[];
  trace: AgentToolStep[];
  postToolReviewState: PostToolReviewState;
  runtimeMetrics: AgentRuntimeMetrics;
}

interface FinalLoopOutcome extends LoopOutcomeBase {
  kind: 'answer-ready';
  draftAnswer: string;
  mode: 'complete' | 'truncated';
}

interface ApprovalLoopOutcome extends LoopOutcomeBase {
  kind: 'approval-required';
  reply: string;
  items: AgentPendingApproval['items'];
  systemPrompt: string;
  roundsUsed: number;
  executionMode: AgentExecutionMode;
  toolCallLimit?: number;
}

type LoopOutcome = FinalLoopOutcome | ApprovalLoopOutcome;

interface AgentLoopExecutionResult {
  state: AgentRunState;
  result: AgentTurnResult;
}

function toolResultContent(value: unknown): string {
  try { return JSON.stringify(value ?? null); } catch { return JSON.stringify({ error: '工具结果无法序列化' }); }
}

function appendToolResult(
  messages: LlmConversationMessage[],
  step: AgentToolStep,
): void {
  messages.push({
    role: 'tool',
    toolCallId: step.call.id,
    toolName: step.call.name,
    content: toolResultContent({ ok: step.ok, result: step.result, error: step.error }),
  });
}

/** Restore successful steps from this request's complete local tool exchanges. */
function completedRunSteps(history: LlmConversationMessage[]): AgentToolStep[] {
  let start = history.length - 1;
  while (start >= 0 && history[start].role !== 'user') start--;
  const current = history.slice(Math.max(0, start));
  const calls = new Map(current.flatMap((message) => message.toolCalls || []).map((call) => [call.id, call]));
  const steps: AgentToolStep[] = [];
  for (const message of current) {
    if (message.role !== 'tool' || !message.toolCallId) continue;
    const call = calls.get(message.toolCallId);
    if (!call) continue;
    try {
      const saved = JSON.parse(message.content) as { ok?: boolean; result?: unknown };
      if (saved.ok !== true) continue;
      steps.push({ call, ok: true, result: saved.result,
        ...(getTool(call.name)?.permission !== 'readonly' ? { effectKey: agentToolEffectKey(call) } : {}) });
    } catch { /* A clipped/invalid result cannot authorize replay suppression. */ }
  }
  return steps;
}

async function continueAgentLoopInternal(input: LoopInput): Promise<LoopOutcome> {
  throwIfAgentAborted(input.signal);
  const trace = [...(input.initialTrace || [])];
  const allowedDefinitions = listToolsForRole(expandAgentCapabilities(input.role, trace));
  const allowedNames = new Set(allowedDefinitions.map((tool) => tool.name));
  const modelToolDefinitions = input.activeSkill?.id === 'personalized-qa'
    ? allowedDefinitions.filter((tool) => tool.name !== 'retrieve_qa_evidence')
    : allowedDefinitions;
  let tools = toLlmTools(modelToolDefinitions);
  const messages = [...input.messages];
  const invoke = input.callLlm || ((request: Parameters<typeof callLLM>[0]) => (
    callLLM(request, { signal: input.signal })
  ));
  const postToolReviewState = input.initialPostToolReviewState || createPostToolReviewState();
  const runtimeMetrics: AgentRuntimeMetrics = {
    llmCalls: input.initialRuntimeMetrics?.llmCalls || 0,
    toolCalls: input.initialRuntimeMetrics?.toolCalls || 0,
    promptTokens: input.initialRuntimeMetrics?.promptTokens || 0,
    completionTokens: input.initialRuntimeMetrics?.completionTokens || 0,
  };
  const executionPolicy = resolveAgentExecutionPolicy(input.executionMode, input.activeSkill?.id, input.toolCallLimit);
  const budgetReply = `本次执行已达到预算（最多 ${executionPolicy.maxRounds} 轮推理、${executionPolicy.maxToolCalls} 次工具调用）。已完成的结果会保留；如需继续，请核对剩余任务，或为新请求调整工具调用预算。`;
  let actionRepairUsed = false;
  let lengthRepairUsed = false;
  let actionCorrection = '';
  const completedEffects = new Map(trace.filter((step) => step.ok && step.effectKey).map((step) => [step.effectKey!, step]));
  const deniedTools = new Set<string>();

  if (runtimeMetrics.toolCalls >= executionPolicy.maxToolCalls || input.startRound >= executionPolicy.maxRounds) {
    return { kind: 'answer-ready', draftAnswer: budgetReply, mode: 'truncated', messages, trace, postToolReviewState, runtimeMetrics };
  }
  const inquiry = resolveInquiryQuestion(input.userText, input.runState.inputHistory);
  if (isCognitionManagerOpenRequest(input.userText) && input.role.allowedTools.includes('open_cognition_manager')) {
    const call = { id: `cognition-window-${Date.now()}`, name: 'open_cognition_manager', arguments: {} };
    const executed = await executeTool(call.name, call.arguments, input.ctx);
    const step = { call, ...executed }; trace.push(step); input.onStep?.(step); runtimeMetrics.toolCalls++;
    return { kind: 'answer-ready', draftAnswer: executed.ok ? '已打开个人认知图谱窗口。' : `窗口未能打开：${executed.error}`,
      mode: 'complete', messages, trace, postToolReviewState, runtimeMetrics };
  }
  const cognitionTopology = isCognitionTopologyRequest(input.userText) || isCognitionTopologyRequest(input.runState.standaloneRequest || '');
  if (input.activeSkill?.id === 'personalized-qa' && inquiry && !cognitionTopology) {
    input.onActivity?.({ phase: 'tool', toolName: 'read_cognition_page' });
    const answer = await runCognitionInquiry({ ...inquiry, replyRequest: input.userText, continuePage: /^(?:继续|下一页|还有呢|还有哪些)/u.test(input.userText),
      allowedTools: new Set(input.role.allowedTools), ctx: input.ctx, callLlm: invoke, signal: input.signal,
      budget: { toolCalls: executionPolicy.maxToolCalls - runtimeMetrics.toolCalls, rounds: executionPolicy.maxRounds - input.startRound },
      onStep: (step) => { trace.push(step); runtimeMetrics.toolCalls++; input.onStep?.(step); },
    });
    postToolReviewState.cognitionInquiry = answer;
    runtimeMetrics.llmCalls += answer.llmCalls; runtimeMetrics.promptTokens += answer.promptTokens; runtimeMetrics.completionTokens += answer.completionTokens;
    return { kind: 'answer-ready', draftAnswer: answer.budgetExhausted ? `${answer.answer}\n\n${budgetReply}` : answer.answer,
      mode: answer.budgetExhausted ? 'truncated' : 'complete', messages, trace, postToolReviewState, runtimeMetrics };
  }

  if (input.activeSkill?.id === 'personalized-qa'
    && !cognitionTopology
    && !isAgentSelfMetaQuestion(input.userText, input.ctx.getAgentPersona?.()?.displayName)
    && !postToolReviewState.qaEvidence) {
    const question = input.runState.standaloneRequest
      || resolveAgentQaQuestion(input.userText, input.runState.inputHistory);
    const scope = /当前(?:笔记|页面)|这篇笔记|本篇笔记/u.test(question) && input.ctx.getActiveNote?.()
      ? 'current-note'
      : 'global';
    const call = {
      id: `qa-evidence-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: 'retrieve_qa_evidence',
      arguments: { question, scope, ...(wantsCognitionComparison(question) ? { includePersonalCognition: true } : {}) },
    };
    input.onActivity?.({ phase: 'tool', toolName: call.name });
    throwIfAgentAborted(input.signal);
    const result = allowedNames.has(call.name)
      ? await executeTool(call.name, call.arguments, input.ctx)
      : { ok: false, error: '个性化答疑证据检索工具不可用' };
    const step: AgentToolStep = { call, ...result };
    trace.push(step);
    runtimeMetrics.toolCalls += 1;
    input.onStep?.(step);
    throwIfAgentAborted(input.signal);
    try {
      await runPostToolReviews({
        skillId: input.activeSkill.id,
        userRequest: question,
        steps: [step],
        state: postToolReviewState,
        auditRunId: input.auditRunId,
        callLlm: input.callLlm,
        allowLlmReviews: Boolean(input.enablePostToolReview),
      });
    } catch (error) {
      throwIfAgentAborted(input.signal);
      console.warn('[agent-qa-preflight] evidence review failed:', error);
    }
  }

  const initialEvidence = [...trace].reverse().find(s => s.ok && s.call.name === 'retrieve_qa_evidence');
  const qaBase = readQaEvidenceResult(initialEvidence?.result);
  const qaSupplement = input.activeSkill?.id === 'personalized-qa' && allowedNames.has('retrieve_qa_evidence') && qaBase
    ? createQaSupplementSession(qaBase, {search: (q, k) => searchDocuments(q, k, {mode: 'auto', expandGraph: true}), readGraph: readDocumentArgumentEvidence},
      trace.some(s => s.call.name === QA_SUPPLEMENT_TOOL.name))
    : undefined;

  for (let round = input.startRound; round < executionPolicy.maxRounds; round += 1) {
    throwIfAgentAborted(input.signal);
    if (runtimeMetrics.toolCalls >= executionPolicy.maxToolCalls) {
      return { kind: 'answer-ready', draftAnswer: budgetReply, mode: 'truncated', messages, trace,
        postToolReviewState, runtimeMetrics: { ...runtimeMetrics } };
    }
    input.onActivity?.({ phase: 'reasoning' });
    const postToolReviewPrompt = buildPostToolReviewPrompt(postToolReviewState);
    const resourceWritebackVerified = verifyAgentObservedOutcome(input.runState.observedOutcome, input.ctx);
    const observedOutcomePrompt = resourceWritebackVerified && input.runState.observedOutcome?.kind === 'resource-writeback'
      ? `\n【已核对的页面操作结果】资源工作台已按用户确认收录 ${input.runState.observedOutcome!.resourceCount} 个资源，项目资源栏中仍可核对。简洁汇总即可，不要重新收录；如还有未处理任务，只继续剩余任务。`
      : '';
    let response: Awaited<ReturnType<typeof invoke>>;
    try { response = await invoke({
      providerId: '',
      model: '',
      workflow: 'agent-chat',
      maxTokensOverride: input.activeSkill?.id === 'plan-planning'
        ? 16384
        : input.activeSkill?.id === 'study-task-generation'
          ? 12288
          : input.activeSkill?.id === 'resource-curation'
            ? 8192
            : undefined,
      userInput: input.userText,
      systemPromptOverride: `${input.systemPrompt}${postToolReviewPrompt}${observedOutcomePrompt}${qaSupplement ? QA_SUPPLEMENT_GUIDANCE : ''}\n\n${buildAgentReplyPolicy(input.userText)}${actionCorrection}`,
      skipMemoryInjection: true,
      thinkingMode: input.activeSkill?.id === 'plan-planning' ? 'disabled' : undefined,
      tools: qaSupplement?.available ? [...tools, QA_SUPPLEMENT_TOOL] : tools,
      agentMessages: messages,
    }); } catch (error) {
      throwIfAgentAborted(input.signal);
      throw new AgentRunFailure(error, {
        state: input.runState, messages, trace, roundsUsed: round, executionMode: executionPolicy.mode,
        toolCallLimit: input.toolCallLimit,
        metrics: { ...runtimeMetrics }, reviews: postToolReviewState,
        planDraftId: input.ctx.getPlanDraftSession()?.id, resourceDraftId: input.ctx.getResourceDraftSession()?.id,
      });
    }
    throwIfAgentAborted(input.signal);
    runtimeMetrics.llmCalls += 1;
    runtimeMetrics.promptTokens += response.usage?.promptTokens || 0;
    runtimeMetrics.completionTokens += response.usage?.completionTokens || 0;
    if (response.diagnostics?.finishReason === 'length') {
      if (!lengthRepairUsed && ['plan-planning', 'study-task-generation'].includes(input.activeSkill?.id || '') && round + 1 < executionPolicy.maxRounds) {
        lengthRepairUsed = true;
        actionCorrection = '\n【输出修正】上一响应被长度限制截断，系统没有执行其中任何操作。请给出完整、紧凑的工具参数；计划只保留必要结构和简洁验收成果，任务按工具允许的批次生成，不写长篇说明、不重复已成功步骤。不能拼接或假定截断内容已生效。';
        continue;
      }
      return { kind: 'answer-ready', draftAnswer: '模型输出达到长度上限，结果未完整返回。本次未执行截断响应中的操作；此前已完成的步骤仍保留，请缩小本次生成范围。',
        mode: 'truncated', messages, trace, postToolReviewState, runtimeMetrics: { ...runtimeMetrics } };
    }
    // 私人认知只能由真实用户请求驱动的预检开启，模型不能自行打开该通道。
    const calls = (response.toolCalls || []).map((call) => call.name === 'retrieve_qa_evidence'
      ? { ...call, arguments: {
        ...call.arguments,
        question: input.runState.standaloneRequest
          || resolveAgentQaQuestion(input.userText, input.runState.inputHistory),
        includePersonalCognition: false,
        personalCognitionOnly: false,
      } }
      : call.name === 'query_learner_profile' ? { ...call, arguments: { ...call.arguments, includeEvidence: false } } : call);
    if (calls.length === 0) {
      const outcomeContext = {
        resourceWritebackVerified: verifyAgentObservedOutcome(input.runState.observedOutcome, input.ctx),
        existingPlanPreview: Boolean(input.ctx.hasPendingPlanEditorDraft?.())
          && /^(?:继续|下一步|查看|提交|确认)[。！!？?\s]*$/u.test(input.userText),
      };
      const reason = agentActionRecoveryReason(response.content, input.activeSkill?.id, trace, outcomeContext);
      if (reason && !actionRepairUsed && round + 1 < executionPolicy.maxRounds) {
        actionRepairUsed = true;
        actionCorrection = `\n\n【本地执行校验】${reason} 已成功的操作不要重复执行。现在调用对应工具继续完成任务，或简洁说明真实阻断；不能只承诺会继续。`;
        continue;
      }
      return {
        kind: 'answer-ready',
        draftAnswer: reconcileAgentActionReply(response.content, input.activeSkill?.id, trace, outcomeContext),
        mode: 'complete',
        messages,
        trace,
        postToolReviewState,
        runtimeMetrics: { ...runtimeMetrics },
      };
    }

    messages.push({ role: 'assistant', content: response.content || '', toolCalls: calls });
    const approvalItems: AgentPendingApproval['items'] = [];
    const roundSteps: AgentToolStep[] = [];
    let repeatedDenialError: string | undefined;
    let toolBudgetExhausted = false;

    for (const call of calls) {
      throwIfAgentAborted(input.signal);
      // Approval items reserve budget now because they execute after confirmation.
      if (runtimeMetrics.toolCalls + approvalItems.length >= executionPolicy.maxToolCalls) {
        toolBudgetExhausted = true;
        const step: AgentToolStep = { call, ok: false, error: '本次 Agent 工具调用预算已用完，未执行该调用。' };
        trace.push(step);
        roundSteps.push(step);
        input.onStep?.(step);
        appendToolResult(messages, step);
        continue;
      }
      if (call.name === QA_SUPPLEMENT_TOOL.name && qaSupplement) {
        input.onActivity?.({phase: 'tool', toolName: call.name});
        let step: AgentToolStep;
        try { step = {call, ok: true, result: await qaSupplement.execute(call.arguments)}; }
        catch (error) { step = {call, ok: false, error: error instanceof Error ? error.message : String(error)}; }
        trace.push(step); roundSteps.push(step); runtimeMetrics.toolCalls++; input.onStep?.(step);
        // The next system evidence block contains the merged graph. Do not repeat the whole packet in tool history.
        appendToolResult(messages, step.ok ? {...step, result: {
          ...(step.result as QaSupplementResult).supplement,
          message: '本轮合并证据包已更新；读取系统中的参考来源和保存图。仍缺少材料时说明缺口，不再补查。',
        }} : step);
        throwIfAgentAborted(input.signal);
        if (step.ok) {
          const oldCitationIds = new Set(postToolReviewState.qaEvidence?.sources.map(s => s.sourceId));
          const previouslyAllowed = new Set(postToolReviewState.qaEvidence?.review.supportedCitationIds);
          const previousRisks = postToolReviewState.qaEvidence?.review.risks || [];
          // Refresh citation/graph context without a second reviewer request. The real trace keeps the actual tool name.
          await runPostToolReviews({skillId: input.activeSkill?.id, userRequest: input.userText,
            steps: [{...step, call: {...call, name: 'retrieve_qa_evidence'}}], state: postToolReviewState,
            auditRunId: input.auditRunId, allowLlmReviews: false});
          // A deterministic supplement cannot silently re-admit sources rejected by the first semantic review.
          if (postToolReviewState.qaEvidence) {
            postToolReviewState.qaEvidence.review.supportedCitationIds =
              postToolReviewState.qaEvidence.review.supportedCitationIds.filter(id => !oldCitationIds.has(id) || previouslyAllowed.has(id));
            postToolReviewState.qaEvidence.review.risks = [...new Set([...previousRisks,
              ...postToolReviewState.qaEvidence.review.risks, '新增材料尚未经过独立语义复核；回答须根据实际原文判断。'])];
          }
        }
        continue;
      }
      try {
        // Fill a missing scope by stable ID, never by the currently open page.
        if (!completedEffects.has(agentToolEffectKey(call))) {
          call.arguments = constrainAgentSequenceCall(call, input.runState.sequenceExecution, input.ctx).arguments;
        }
      } catch (error) {
        const step: AgentToolStep = { call, ok: false, error: error instanceof Error ? error.message : String(error) };
        trace.push(step); roundSteps.push(step); runtimeMetrics.toolCalls++; input.onStep?.(step); appendToolResult(messages, step);
        continue;
      }
      const registeredDefinition = allowedNames.has(call.name) ? getTool(call.name) : undefined;
      const definition = registeredDefinition?.requiresCognitionContext && input.activeSkill?.id !== 'cognition-management' ? undefined : registeredDefinition;
      const requestConstraintError = call.name === 'create_project_plan'
        ? validateCreatePlanDatesForRequest({
          args: call.arguments,
          userText: input.userText,
          history: input.runState.inputHistory,
          today: localDateString(new Date(input.runState.createdAt)),
        })
        : undefined;
      if (definition && requestConstraintError) {
        const step: AgentToolStep = { call, ok: false, error: requestConstraintError };
        trace.push(step);
        runtimeMetrics.toolCalls += 1;
        roundSteps.push(step);
        input.onStep?.(step);
        appendToolResult(messages, step);
        continue;
      }
      const effectKey = definition && definition.permission !== 'readonly' ? agentToolEffectKey(call) : undefined;
      const prior = effectKey ? completedEffects.get(effectKey) : undefined;
      if (definition && !prior && toolRequiresApproval(definition, call.arguments, input.ctx)) {
        const binding = await createAgentApprovalBinding(call, input.ctx);
        approvalItems.push({ call, ...describeToolConfirmation(definition, call.arguments, input.ctx), binding });
        continue;
      }

      input.onActivity?.({ phase: 'tool', toolName: call.name });
      const repeatedDenial = !definition && deniedTools.has(call.name);
      if (!definition) deniedTools.add(call.name);
      const result = prior ? { ok: true, result: prior.result }
        : definition
        ? await executeTool(call.name, call.arguments, input.ctx, { signal: input.signal, cognitionContext: input.activeSkill?.id === 'cognition-management' })
        : { ok: false, error: registeredDefinition?.requiresCognitionContext
          ? '个人认知写入必须来自明确的认知整理请求，不能由其它Skill附带触发；未执行。'
          : agentToolAvailabilityError(input.role, call.name) };
      const step: AgentToolStep = { call, ...result, effectKey, ...(prior ? { reused: true } : {}) };
      if (step.ok && effectKey) completedEffects.set(effectKey, step);
      trace.push(step);
      runtimeMetrics.toolCalls += 1;
      roundSteps.push(step);
      input.onStep?.(step);
      appendToolResult(messages, step);
      if (repeatedDenial) repeatedDenialError = result.error;
      if (step.ok && call.name === 'discover_agent_capabilities') {
        const discovered = listToolsForRole(expandAgentCapabilities(input.role, trace));
        discovered.forEach(tool => allowedNames.add(tool.name));
        tools = toLlmTools(input.activeSkill?.id === 'personalized-qa'
          ? discovered.filter(tool => tool.name !== 'retrieve_qa_evidence') : discovered);
      }
      throwIfAgentAborted(input.signal);
    }

    if (repeatedDenialError && !approvalItems.length && roundSteps.every(item => !item.ok)) {
      return { kind: 'answer-ready', draftAnswer: `${repeatedDenialError}\n已停止重复尝试。${trace.some(item => item.ok && getTool(item.call.name)?.permission === 'write') ? '此前已完成的操作保留。' : '本次没有执行写入。'}`,
        mode: 'complete', messages, trace, postToolReviewState, runtimeMetrics: { ...runtimeMetrics } };
    }
    if (input.enablePostToolReview && roundSteps.length > 0) {
      try {
        input.onActivity?.({ phase: 'reviewing' });
        await runPostToolReviews({
          skillId: input.activeSkill?.id,
          userRequest: input.userText,
          steps: roundSteps,
          state: postToolReviewState,
          auditRunId: input.auditRunId,
          callLlm: input.callLlm,
        });
      } catch (error) {
        throwIfAgentAborted(input.signal);
        console.warn('[agent-post-tool-review] review failed; continuing with validated tool results:', error);
      }
    }

    if (approvalItems.length > 0) {
      return {
        kind: 'approval-required',
        reply: '请确认下面的操作及影响范围，确认前不会执行这些操作。',
        items: approvalItems,
        systemPrompt: `${input.systemPrompt}${buildPostToolReviewPrompt(postToolReviewState)}`,
        roundsUsed: round + 1,
        executionMode: executionPolicy.mode,
        toolCallLimit: input.toolCallLimit,
        messages,
        trace,
        postToolReviewState,
        runtimeMetrics: { ...runtimeMetrics },
      };
    }
    if (toolBudgetExhausted) {
      return { kind: 'answer-ready', draftAnswer: budgetReply, mode: 'truncated', messages, trace,
        postToolReviewState, runtimeMetrics: { ...runtimeMetrics } };
    }
  }

  return {
    kind: 'answer-ready',
    draftAnswer: '本次处理达到步骤上限，尚未完成全部请求。已完成的操作仍保留；请缩小剩余任务范围后继续。',
    mode: 'truncated',
    messages,
    trace,
    postToolReviewState,
    runtimeMetrics: { ...runtimeMetrics },
  };
}

async function continueAgentLoop(input: LoopInput): Promise<AgentLoopExecutionResult> {
  const execution = await runAgentToolLoopNode(input.runState, () => continueAgentLoopInternal(input), {
    signal: input.signal,
    onActivity: input.onActivity,
    onNodeEvent: input.onNodeEvent,
  });
  let runState = execution.state;
  const outcome = execution.value;
  const nextNode = resolveAgentGraphTransition('tool-loop', outcome.kind);

  if (outcome.kind === 'approval-required') {
    if (nextNode !== 'approval') throw new Error(`Agent 图工具循环出口异常：${nextNode}`);
    runState = await runAgentApprovalNode(runState, {
      items: outcome.items,
      systemPrompt: outcome.systemPrompt,
      roundsUsed: outcome.roundsUsed,
      executionMode: outcome.executionMode,
      toolCallLimit: outcome.toolCallLimit,
      postToolReviewEnabled: input.enablePostToolReview,
      runtimeMetrics: outcome.runtimeMetrics,
    }, {
      signal: input.signal,
      onActivity: input.onActivity,
      onNodeEvent: input.onNodeEvent,
    });
    assertAgentGraphTransition('approval', 'interrupted', 'audit');
    // A pending confirmation must retain every successful effect of THIS run,
    // including early rounds, so resuming cannot silently replay forgotten writes.
    const requestStart = outcome.messages.map((message) => message.role).lastIndexOf('user');
    const approvalHistory = requestStart >= 0
      ? [...trimAgentConversationHistory(outcome.messages.slice(0, requestStart), 12), ...outcome.messages.slice(requestStart)]
      : outcome.messages;
    return {
      state: runState,
      result: {
        reply: outcome.reply,
        updatedHistory: approvalHistory,
        toolTrace: outcome.trace,
        truncated: false,
        activeSkill: input.activeSkill,
        pendingApproval: runState.pendingApproval,
        coordinationRuns: [...outcome.postToolReviewState.coordinationRuns],
        runtimeMetrics: { ...outcome.runtimeMetrics },
      },
    };
  }

  if (nextNode !== 'final-answer') throw new Error(`Agent 图工具循环出口异常：${nextNode}`);
  let draftAnswer = outcome.draftAnswer;
  if (input.activeSkill?.id === 'cognition-management') {
    const commits = outcome.trace.filter(step => step.call.name === 'commit_cognition_change');
    const saved = commits.filter(step => step.ok && (step.result as { saved?: unknown } | undefined)?.saved === true);
    const failed = commits.filter(step => !step.ok);
    if (failed.length) draftAnswer = `${saved.length ? `已保存 ${saved.length} 项经你确认的变更；` : ''}另有认知变更未保存：${failed.at(-1)!.error || '保存未成功'}。未保存部分需要重新预览并确认，不会自动换目标重试。`;
    else if (saved.length) draftAnswer = '已按你确认的具体变更更新个人认知库，旧版本已保留；来源笔记和掌握度未改动。';
    else if (outcome.trace.some(step => step.ok && step.call.name === 'prepare_cognition_change')) draftAnswer = '本轮只生成了变更预览，尚未提交确认，也未修改认知库。';
  }
  runState = await runAgentFinalAnswerNode(runState, {
    draftAnswer,
    mode: outcome.mode,
    enablePostToolReview: input.enablePostToolReview,
    postToolReviewState: outcome.postToolReviewState,
    callLlm: input.callLlm,
  }, {
    signal: input.signal,
    onActivity: input.onActivity,
    onNodeEvent: input.onNodeEvent,
  });
  assertAgentGraphTransition('final-answer', 'success', 'audit');
  const reply = runState.finalReply || (outcome.mode === 'complete'
    ? '我暂时没有得到可用结果。'
    : '本次工具调用达到上限，请缩小问题范围后重试。');
  const cognitionReferences = outcome.postToolReviewState.cognitionInquiry?.references || outcome.postToolReviewState.qaEvidence?.personalCognition?.items.map(({ recordId, revisionId, branchId, nodeId }) => ({ recordId, revisionId, branchId, nodeId }));
  outcome.messages.push({ role: 'assistant', content: reply, citations: runState.finalCitations,
    ...(outcome.postToolReviewState.cognitionInquiry?.cursor ? { cognitionInquiry: outcome.postToolReviewState.cognitionInquiry.cursor } : {}),
    ...(cognitionReferences?.length ? { cognitionReferences } : {}) });
  return {
    state: runState,
    result: {
      reply,
      updatedHistory: trimAgentConversationHistory(outcome.messages),
      toolTrace: outcome.trace,
      truncated: outcome.mode === 'truncated',
      activeSkill: input.activeSkill,
      coordinationRuns: [...runState.postToolCoordinationRuns],
      runtimeMetrics: { ...outcome.runtimeMetrics },
    },
  };
}

export async function runAgentTurn(input: {
  role: AgentRole;
  userText: string;
  history: LlmConversationMessage[];
  ctx: AgentRuntimeContext;
  /** Internal UI routing hint. When present, the named registered Skill is activated for this turn. */
  requestedSkillId?: string;
  /** Previous turn's Skill is a continuity hint, not a forced override. */
  preferredSkillId?: string;
  /** Trusted completion metadata from an application workflow, not chat text. */
  observedOutcome?: AgentObservedOutcome;
  sequenceExecution?: AgentSequenceExecution;
  callLlm?: AgentLlmCaller;
  memoryPrefixLoader?: () => Promise<string>;
  /** Enables bounded specialist orchestration for skills with a registered workflow. */
  enableMultiAgent?: boolean;
  signal?: AbortSignal;
  onStep?: (step: AgentToolStep) => void;
  onActivity?: (activity: AgentActivityUpdate) => void;
  onNodeEvent?: (event: AgentNodeEvent) => void;
}): Promise<AgentTurnResult> {
  const userText = input.userText.trim();
  if (!userText) throw new Error('请输入问题');
  // Snapshot before ANY await: changing settings in another tab never alters this
  // run, its confirmation continuation or a retry after a transport failure.
  const executionMode = normalizeAgentExecutionMode(input.ctx.getAgentExecutionMode?.());
  const toolCallLimit = normalizeAgentToolCallLimit(input.ctx.getAgentToolCallLimit?.());
  const auditRunId = `agent-run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const createdAt = new Date().toISOString();
  let dataVersionBefore: number | undefined;
  let runState = createAgentRunState({
    runId: auditRunId,
    createdAt,
    userText,
    role: input.role,
    history: input.history,
  });

  try {
    throwIfAgentAborted(input.signal);
    const callLlm: AgentLlmCaller = input.callLlm || ((request) => callLLM(request, { signal: input.signal }));
    input.onActivity?.({ phase: 'syncing' });
    await input.ctx.ensureDataFresh();
    throwIfAgentAborted(input.signal);
    dataVersionBefore = await readAgentDataVersion();
    runState = { ...runState, dataVersionBefore,
      ...(input.observedOutcome ? { observedOutcome: structuredClone(input.observedOutcome) } : {}) };
    try {
      await recordAgentTurnAudit({
        id: auditRunId,
        roleId: input.role.id,
        userRequest: userText,
        createdAt,
        dataVersionBefore,
      });
    } catch (error) { console.warn('[agent-audit] record turn start failed:', error); }

    const nodeContext = {
      signal: input.signal,
      onActivity: input.onActivity,
      onNodeEvent: input.onNodeEvent,
    };
    runState = await runAgentGraphSegment({
      state: runState,
      start: 'route',
      stopBefore: 'tool-loop',
      context: nodeContext,
      handlers: {
        route: (state, context) => runAgentRouteNode(state, {
          baseRole: input.role,
          ctx: input.ctx,
          requestedSkillId: input.requestedSkillId,
          preferredSkillId: input.preferredSkillId,
          callLlm,
        }, context),
        memory: (state, context) => runAgentMemoryNode(state, {
          memoryPrefixLoader: input.memoryPrefixLoader,
          getNotes: () => input.ctx.getNotes(),
        }, context),
        coordinate: (state, context) => runAgentCoordinationNode(state, {
          enabled: input.enableMultiAgent,
          callLlm,
        }, context),
      },
    });
    const skill = runState.activeSkill ? getAgentSkill(runState.activeSkill.id) : undefined;
    if (input.sequenceExecution) {
      if (input.sequenceExecution.skillId !== skill?.id) throw new Error('连续任务与当前 Skill 不一致，未执行操作');
      runState = { ...runState, sequenceExecution: { ...input.sequenceExecution },
        systemPrompt: `${runState.systemPrompt}\n【连续任务边界】本轮仅执行 ${skill.id} 环节。后续环节由本地调度器按实际保存结果交接，不在本轮提前执行、声称完成或要求用户重新描述整个任务。${input.sequenceExecution.scopeProjectId ? `项目范围锁定为稳定 ID ${input.sequenceExecution.scopeProjectId}，读取真实数据并沿用该范围。` : ''}` };
    }
    const effectiveRole = runState.effectiveRole;
    const coordination = runState.coordination;
    const systemPrompt = runState.systemPrompt;
    const priorHistory = skill?.id === 'personalized-qa'
      ? trimQaConversationHistory(input.history)
      : compactAgentConversationContext(input.history, executionMode);
    const loopExecution = await continueAgentLoop({
      ...input,
      runState,
      role: effectiveRole,
      userText,
      systemPrompt,
      startRound: 0,
      messages: [...priorHistory, { role: 'user', content: userText }],
      activeSkill: skill ? { id: skill.id, name: skill.name } : undefined,
      auditRunId,
      executionMode,
      toolCallLimit,
      enablePostToolReview: input.enableMultiAgent,
      callLlm,
      initialRuntimeMetrics: runState.routingMetrics,
    });
    runState = loopExecution.state;
    const result = loopExecution.result;
    const postToolCoordinationRuns = result.coordinationRuns || [];
    result.coordination = coordination;
    result.coordinationRuns = [
      ...(coordination ? [coordination] : []),
      ...postToolCoordinationRuns,
    ];
    result.auditRunId = auditRunId;
    if (skill?.id === 'personalized-qa' && !isAgentSelfMetaQuestion(userText, input.ctx.getAgentPersona?.()?.displayName)
      && !result.pendingApproval && !resolveInquiryQuestion(userText, input.history)) {
      const evidenceStep = [...result.toolTrace].reverse().find((step) => step.ok && ['retrieve_qa_evidence', QA_SUPPLEMENT_TOOL.name].includes(step.call.name));
      const evidence = readQaEvidenceResult(evidenceStep?.result);
      try {
        await saveLearningEpisode(buildQaLearningEpisode({ question: userText, answer: result.reply, evidence }));
      } catch (error) {
        console.warn('[agent-qa] save compact episode failed:', error);
      }
      result.updatedHistory = trimQaConversationHistory(result.updatedHistory);
    }
    input.onActivity?.({ phase: 'finalizing' });
    runState = await runAgentTurnAuditNode(runState, { roleId: input.role.id, result }, {
      onNodeEvent: input.onNodeEvent,
    });
    return result;
  } catch (error) {
    await runAgentTurnAuditNode(runState, { roleId: input.role.id, error }, {
      onNodeEvent: input.onNodeEvent,
    });
    throw error;
  }
}

/** Continue the same run after an explicitly requested retry; never replay successful effects. */
export async function resumeAgentTurn(input: {
  role: AgentRole; recovery: AgentRunRecovery; ctx: AgentRuntimeContext; callLlm?: AgentLlmCaller;
  signal?: AbortSignal; onStep?: (step: AgentToolStep) => void; onActivity?: (activity: AgentActivityUpdate) => void;
}): Promise<AgentTurnResult> {
  const recovery = input.recovery;
  if (recovery.state.baseRoleId !== input.role.id) throw new Error('助手权限已变化，请重新发起请求。');
  await input.ctx.ensureDataFresh();
  throwIfAgentAborted(input.signal);
  if (recovery.planDraftId !== input.ctx.getPlanDraftSession()?.id
    || recovery.resourceDraftId !== input.ctx.getResourceDraftSession()?.id) {
    throw new Error('业务草案已切换，不能沿用旧任务重试；请重新发起请求。');
  }
  const skill = input.role.toolScope === 'cognition' ? getAgentSkill('cognition-management') : recovery.state.activeSkill ? getAgentSkill(recovery.state.activeSkill.id) : undefined;
  const role = skill ? applyAgentSkill(input.role, skill) : input.role;
  let state: AgentRunState = { ...recovery.state, effectiveRole: role, status: 'running' };
  try {
    const execution = await continueAgentLoop({ ...input, role, runState: state, userText: state.userText,
      messages: recovery.messages, systemPrompt: `${state.systemPrompt}\n【续跑】同一请求从失败点恢复。已成功步骤不可重复执行；如需核对，请读取最新数据。`,
      startRound: recovery.roundsUsed, initialTrace: recovery.trace, activeSkill: state.activeSkill,
      auditRunId: state.runId, initialRuntimeMetrics: recovery.metrics, initialPostToolReviewState: recovery.reviews,
      executionMode: recovery.executionMode,
      toolCallLimit: recovery.toolCallLimit,
    });
    state = execution.state;
    execution.result.auditRunId = state.runId;
    await runAgentTurnAuditNode(state, { roleId: input.role.id, result: execution.result });
    return execution.result;
  } catch (error) {
    await runAgentTurnAuditNode(state, { roleId: input.role.id, error });
    throw error;
  }
}

export async function resolveAgentApproval(input: {
  role: AgentRole;
  approval: AgentPendingApproval;
  approved: boolean;
  history: LlmConversationMessage[];
  ctx: AgentRuntimeContext;
  callLlm?: AgentLlmCaller;
  signal?: AbortSignal;
  onStep?: (step: AgentToolStep) => void;
  onActivity?: (activity: AgentActivityUpdate) => void;
  onNodeEvent?: (event: AgentNodeEvent) => void;
}): Promise<AgentTurnResult> {
  const auditRunId = input.approval.continuation.auditRunId || input.approval.id;
  let resumedState = createAgentRunState({
    runId: auditRunId,
    createdAt: new Date().toISOString(),
    userText: input.approval.continuation.userText,
    role: input.role,
    history: input.history,
  });
  try {
    throwIfAgentAborted(input.signal);
    input.onActivity?.({ phase: 'syncing' });
    if (input.approved) await input.ctx.ensureDataFresh();
    const skill = input.role.toolScope === 'cognition' ? getAgentSkill('cognition-management') : input.approval.continuation.skillId
      ? getAgentSkill(input.approval.continuation.skillId)
      : undefined;
    let effectiveRole = expandAgentCapabilities(skill ? applyAgentSkill(input.role, skill) : input.role, completedRunSteps(input.history));
    // A long history may have compacted the discovery exchange. The visible,
    // fingerprint-bound approval can reconstruct only those exact commands,
    // and only inside the current role ceiling (never a saved permission list).
    if (effectiveRole.allowedTools.includes('discover_agent_capabilities')) {
      const ceiling = new Set(effectiveRole.skillToolCeiling || effectiveRole.allowedTools);
      effectiveRole = { ...effectiveRole, allowedTools: [...new Set([
        ...effectiveRole.allowedTools,
        ...input.approval.items.filter(item => item.binding && ceiling.has(item.call.name)).map(item => item.call.name),
      ])] };
    }
    const allowedNames = new Set(listToolsForRole(effectiveRole).map((tool) => tool.name));
    if (input.approved) {
      // Atomic tool groups cannot be interleaved with unrelated writes on one
      // card. Reject before any effects instead of promising cross-tool atomicity.
      for (const name of new Set(input.approval.items.map(item => item.call.name))) {
        if (allowedNames.has(name) && getTool(name)?.executeApprovedBatch
          && input.approval.items.filter(item => item.call.name === name).length > 1
          && input.approval.items.some(item => item.call.name !== name)) throw new Error('批量认知变更不能混合其他操作，请分开预览并确认；本次未写入');
      }
      // Validate all currently authorized writes before any side effect. Out-of-
      // scope calls are still rejected by the permission check, never executed.
      for (const item of input.approval.items) {
        const definition = allowedNames.has(item.call.name) ? getTool(item.call.name) : undefined;
        if (definition && (definition.permission === 'write' || definition.requiresConfirmation)) {
          await validateAgentApprovalBinding(item, input.ctx);
          constrainAgentSequenceCall(item.call, input.approval.continuation.checkpoint?.sequenceExecution, input.ctx);
        }
      }
    }
    const messages = [...input.history];
    const trace: AgentToolStep[] = completedRunSteps(messages);
    const resumedMetrics: AgentRuntimeMetrics = {
      llmCalls: input.approval.continuation.runtimeMetrics?.llmCalls || 0,
      toolCalls: input.approval.continuation.runtimeMetrics?.toolCalls || 0,
      promptTokens: input.approval.continuation.runtimeMetrics?.promptTokens || 0,
      completionTokens: input.approval.continuation.runtimeMetrics?.completionTokens || 0,
    };
    const activeSkill = skill ? { id: skill.id, name: skill.name } : undefined;
    resumedState = restoreAgentRunCheckpoint({
      checkpoint: input.approval.continuation.checkpoint,
      expectedRunId: auditRunId,
      role: input.role,
      effectiveRole,
      activeSkill,
      hasActiveDraft: hasActiveAgentDraft(input.ctx),
      history: input.history,
      fallbackUserText: input.approval.continuation.userText,
      fallbackSystemPrompt: input.approval.continuation.systemPrompt,
    });
    const nodeContext = {
      signal: input.signal,
      onActivity: input.onActivity,
      onNodeEvent: input.onNodeEvent,
    };
    resumedState = await runAgentApprovalResumeNode(resumedState, async () => {
      const recordResult = (item: AgentPendingApproval['items'][number], result: { ok: boolean; result?: unknown; error?: string }) => {
        const step: AgentToolStep = { call: item.call, ...result, ...(result.ok ? { effectKey: agentToolEffectKey(item.call) } : {}) };
        trace.push(step); resumedMetrics.toolCalls += 1; input.onStep?.(step); appendToolResult(messages, step);
      };
      const batchName = input.approval.items[0]?.call.name;
      const atomicBatch = input.approved && input.approval.items.length > 1 && input.approval.items.every(item => item.call.name === batchName)
        && allowedNames.has(batchName) && getTool(batchName)?.executeApprovedBatch;
      if (atomicBatch) {
        for (const item of input.approval.items) {
          throwIfAgentAborted(input.signal);
          await validateAgentApprovalBinding(item, input.ctx);
          constrainAgentSequenceCall(item.call, resumedState.sequenceExecution, input.ctx);
        }
        throwIfAgentAborted(input.signal);
        input.onActivity?.({ phase: 'tool', toolName: batchName });
        const result = await executeApprovedToolBatch(batchName, input.approval.items.map(item => item.call.arguments), input.ctx,
          { signal: input.signal, userApproved: true, cognitionContext: activeSkill?.id === 'cognition-management' });
        input.approval.items.forEach((item, index) => recordResult(item, result.ok ? { ok: true, result: result.results![index] } : { ok: false, error: result.error }));
        // All receipts are recorded before honoring stop: an atomic write that
        // already completed must never be reported as partly applied or undone.
        throwIfAgentAborted(input.signal);
      } else for (const item of input.approval.items) {
        throwIfAgentAborted(input.signal);
        const definition = allowedNames.has(item.call.name) ? getTool(item.call.name) : undefined;
        let result: { ok: boolean; result?: unknown; error?: string };
        if (!input.approved) {
          result = { ok: false, error: '用户已取消该操作' };
        } else if (!definition || (definition.permission !== 'write' && !definition.requiresConfirmation)) {
          result = { ok: false, error: `操作授权已失效：${item.call.name}` };
        } else {
          await validateAgentApprovalBinding(item, input.ctx);
          constrainAgentSequenceCall(item.call, resumedState.sequenceExecution, input.ctx);
          throwIfAgentAborted(input.signal);
          input.onActivity?.({ phase: 'tool', toolName: item.call.name });
          result = await executeTool(item.call.name, item.call.arguments, input.ctx, { signal: input.signal, userApproved: true, cognitionContext: activeSkill?.id === 'cognition-management' });
        }
        recordResult(item, result);
        throwIfAgentAborted(input.signal);
      }
      await input.ctx.ensureDataFresh();
    }, nodeContext);
    if (!input.approved) {
      const reply = '已取消本次待确认操作，未执行其中的写入。草案保留，你可以修改要求后重新提交。';
      messages.push({ role: 'assistant', content: reply });
      const result: AgentTurnResult = { reply, updatedHistory: trimAgentConversationHistory(messages), toolTrace: trace,
        truncated: false, activeSkill, auditRunId, runtimeMetrics: resumedMetrics };
      await runAgentApprovalAuditNode(resumedState, { approval: input.approval, approved: false, result });
      return result;
    }
    assertAgentGraphTransition('approval', 'resumed', 'tool-loop');
    const loopExecution = await continueAgentLoop({
      runState: resumedState,
      role: effectiveRole,
      userText: resumedState.userText,
      messages,
      ctx: input.ctx,
      systemPrompt: resumedState.systemPrompt,
      startRound: input.approval.continuation.roundsUsed,
      initialTrace: trace,
      callLlm: input.callLlm,
      signal: input.signal,
      onStep: input.onStep,
      onActivity: input.onActivity,
      onNodeEvent: input.onNodeEvent,
      activeSkill,
      auditRunId,
      executionMode: normalizeAgentExecutionMode(input.approval.continuation.executionMode),
      toolCallLimit: normalizeAgentToolCallLimit(input.approval.continuation.toolCallLimit),
      enablePostToolReview: input.approval.continuation.postToolReviewEnabled,
      initialRuntimeMetrics: resumedMetrics,
    });
    resumedState = loopExecution.state;
    const result = loopExecution.result;
    result.auditRunId = auditRunId;
    input.onActivity?.({ phase: 'finalizing' });
    resumedState = await runAgentApprovalAuditNode(resumedState, {
      approval: input.approval,
      approved: input.approved,
      result,
    }, { onNodeEvent: input.onNodeEvent });
    return result;
  } catch (error) {
    await runAgentApprovalAuditNode(resumedState, {
      approval: input.approval,
      approved: input.approved,
      error,
    }, { onNodeEvent: input.onNodeEvent });
    throw error;
  }
}
