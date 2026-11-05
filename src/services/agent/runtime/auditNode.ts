import { recordAgentApprovalAudit, recordAgentTurnAudit } from '../auditStore';
import type { AgentPendingApproval, AgentTurnResult } from '../types';
import { AGENT_GRAPH_END, assertAgentGraphTransition } from './graphTopology';
import { executeAgentNode } from './nodeRunner';
import type { AgentNodeExecutionContext, AgentRunState } from './types';

export async function runAgentTurnAuditNode(
  state: AgentRunState,
  dependencies: { roleId: string; result?: AgentTurnResult; error?: unknown },
  context: AgentNodeExecutionContext = {},
): Promise<AgentRunState> {
  return executeAgentNode(state, {
    id: 'audit',
    execute: async () => {
      try {
        await recordAgentTurnAudit({
          id: state.runId,
          roleId: dependencies.roleId,
          userRequest: state.userText,
          createdAt: state.createdAt,
          dataVersionBefore: state.dataVersionBefore,
          memoryTrace: state.memoryTrace,
          result: dependencies.result,
          error: dependencies.error,
        });
      } catch (error) {
        console.warn('[agent-audit] record turn failed:', error);
      }
      assertAgentGraphTransition('audit', 'success', AGENT_GRAPH_END);
      return {
        status: dependencies.error
          ? (dependencies.error instanceof DOMException && dependencies.error.name === 'AbortError' ? 'cancelled' : 'failed')
          : dependencies.result?.pendingApproval
            ? 'waiting-approval'
            : 'completed',
      };
    },
  }, context);
}

export async function runAgentApprovalAuditNode(
  state: AgentRunState,
  dependencies: {
    approval: AgentPendingApproval;
    approved: boolean;
    result?: AgentTurnResult;
    error?: unknown;
  },
  context: AgentNodeExecutionContext = {},
): Promise<AgentRunState> {
  return executeAgentNode(state, {
    id: 'audit',
    execute: async () => {
      try {
        await recordAgentApprovalAudit({
          runId: state.runId,
          approval: dependencies.approval,
          approved: dependencies.approved,
          result: dependencies.result,
          error: dependencies.error,
        });
      } catch (error) {
        console.warn('[agent-audit] record approval failed:', error);
      }
      assertAgentGraphTransition('audit', 'success', AGENT_GRAPH_END);
      return { status: dependencies.error ? 'failed' : 'completed' };
    },
  }, context);
}
