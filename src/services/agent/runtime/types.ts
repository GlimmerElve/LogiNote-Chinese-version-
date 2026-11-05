import type {
  AgentCitation,
  LlmCallRequest,
  LlmCallResponse,
  LlmConversationMessage,
} from '../../../types';
import type { MemoryContextTrace } from '../../memory/memoryContextBuilder';
import type { AgentSequenceExecution } from '../skillSequence';
import type {
  AgentActiveSkillRef,
  AgentActivityPhase,
  AgentActivityUpdate,
  AgentCoordinationSummary,
  AgentPendingApproval,
  AgentObservedOutcome,
  AgentRole,
  AgentRuntimeMetrics,
  AgentRunNodeId,
  AgentRunStatus,
} from '../types';

export const AGENT_RUN_STATE_VERSION = 1 as const;

/**
 * Serializable state shared by deterministic Agent nodes. Runtime services,
 * callbacks and AbortSignals deliberately stay in AgentNodeExecutionContext.
 */
export interface AgentRunState {
  version: typeof AGENT_RUN_STATE_VERSION;
  runId: string;
  createdAt: string;
  status: AgentRunStatus;
  userText: string;
  baseRoleId: string;
  effectiveRole: AgentRole;
  inputHistory: LlmConversationMessage[];
  preferredSkillId?: string;
  activeSkill?: AgentActiveSkillRef;
  /** Context-complete form of this turn for retrieval/tool arguments. */
  standaloneRequest?: string;
  /** A semantic router found multiple plausible referents; tools must wait for clarification. */
  contextClarificationNeeded?: boolean;
  hasActiveDraft: boolean;
  /** Cost of the optional semantic Skill router before the tool loop. */
  routingMetrics: AgentRuntimeMetrics;
  memoryPrefix: string;
  memoryTrace?: MemoryContextTrace;
  coordinationPrompt: string;
  coordination?: AgentCoordinationSummary;
  systemPrompt: string;
  dataVersionBefore?: number;
  observedOutcome?: AgentObservedOutcome;
  sequenceExecution?: AgentSequenceExecution;
  draftReply?: string;
  finalReply?: string;
  finalCitations?: AgentCitation[];
  postToolCoordinationRuns: AgentCoordinationSummary[];
  pendingApproval?: AgentPendingApproval;
  currentNode?: AgentRunNodeId;
  completedNodes: AgentRunNodeId[];
}

export type AgentLlmCaller = (request: LlmCallRequest) => Promise<LlmCallResponse>;

export interface AgentNodeEvent {
  version: 1;
  runId: string;
  nodeId: AgentRunNodeId;
  status: 'started' | 'completed' | 'failed';
  occurredAt: string;
  durationMs?: number;
  /** Error class only. Prompts, model output and tool payloads are never emitted. */
  errorName?: string;
}

export interface AgentNodeExecutionContext {
  signal?: AbortSignal;
  onActivity?: (activity: AgentActivityUpdate) => void;
  onNodeEvent?: (event: AgentNodeEvent) => void;
}

export interface AgentRuntimeNode {
  id: AgentRunNodeId;
  activityPhase?: AgentActivityPhase;
  execute: (
    state: AgentRunState,
    context: AgentNodeExecutionContext,
  ) => Promise<Partial<AgentRunState>> | Partial<AgentRunState>;
}

export function createAgentRunState(input: {
  runId: string;
  createdAt: string;
  userText: string;
  role: AgentRole;
  history: LlmConversationMessage[];
}): AgentRunState {
  return {
    version: AGENT_RUN_STATE_VERSION,
    runId: input.runId,
    createdAt: input.createdAt,
    status: 'running',
    userText: input.userText,
    baseRoleId: input.role.id,
    effectiveRole: { ...input.role, allowedTools: [...input.role.allowedTools] },
    inputHistory: [...input.history],
    hasActiveDraft: false,
    routingMetrics: { llmCalls: 0, toolCalls: 0, promptTokens: 0, completionTokens: 0 },
    memoryPrefix: '',
    coordinationPrompt: '',
    systemPrompt: input.role.systemPrompt,
    postToolCoordinationRuns: [],
    completedNodes: [],
  };
}
