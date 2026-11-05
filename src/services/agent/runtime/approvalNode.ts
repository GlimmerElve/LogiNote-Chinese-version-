import type { AgentPendingApproval, AgentRuntimeMetrics } from '../types';
import type { AgentExecutionMode } from '../../../types';
import { createAgentRunCheckpoint } from './checkpoint';
import { executeAgentNode } from './nodeRunner';
import type { AgentNodeExecutionContext, AgentRunState } from './types';

export async function runAgentApprovalNode(
  state: AgentRunState,
  dependencies: {
    items: AgentPendingApproval['items'];
    systemPrompt: string;
    roundsUsed: number;
    executionMode: AgentExecutionMode;
    toolCallLimit?: number;
    postToolReviewEnabled?: boolean;
    runtimeMetrics: AgentRuntimeMetrics;
  },
  context: AgentNodeExecutionContext = {},
): Promise<AgentRunState> {
  return executeAgentNode(state, {
    id: 'approval',
    activityPhase: 'approval',
    execute: () => {
      const checkpointState: AgentRunState = {
        ...state,
        status: 'waiting-approval',
        systemPrompt: dependencies.systemPrompt,
        currentNode: 'approval',
        completedNodes: state.completedNodes.includes('approval')
          ? state.completedNodes
          : [...state.completedNodes, 'approval'],
      };
      const pendingApproval: AgentPendingApproval = {
        id: `${Date.now()}-${dependencies.items.map((item) => item.call.id).join('-')}`,
        items: dependencies.items,
        continuation: {
          userText: state.userText,
          systemPrompt: dependencies.systemPrompt,
          roundsUsed: dependencies.roundsUsed,
          executionMode: dependencies.executionMode,
          toolCallLimit: dependencies.toolCallLimit,
          skillId: state.activeSkill?.id,
          auditRunId: state.runId,
          postToolReviewEnabled: dependencies.postToolReviewEnabled,
          runtimeMetrics: { ...dependencies.runtimeMetrics },
          checkpoint: createAgentRunCheckpoint(checkpointState),
        },
      };
      return { status: 'waiting-approval', pendingApproval, systemPrompt: dependencies.systemPrompt };
    },
  }, context);
}

export async function runAgentApprovalResumeNode(
  state: AgentRunState,
  task: () => Promise<void>,
  context: AgentNodeExecutionContext = {},
): Promise<AgentRunState> {
  return executeAgentNode(state, {
    id: 'approval',
    activityPhase: 'approval',
    execute: async () => {
      await task();
      return { status: 'running', pendingApproval: undefined };
    },
  }, context);
}
