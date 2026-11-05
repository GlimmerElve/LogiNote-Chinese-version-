import type { LlmConversationMessage } from '../../../types';
import type { AgentActiveSkillRef, AgentRole, AgentRunCheckpoint, AgentRunNodeId } from '../types';
import { createAgentRunState, type AgentRunState } from './types';
import { isAgentSequenceExecution } from '../skillSequence';

const VALID_NODE_IDS = new Set<AgentRunNodeId>([
  'route', 'memory', 'coordinate', 'tool-loop', 'approval', 'final-answer', 'audit',
]);

export function createAgentRunCheckpoint(state: AgentRunState): AgentRunCheckpoint {
  return {
    version: 1,
    runId: state.runId,
    createdAt: state.createdAt,
    userText: state.userText,
    baseRoleId: state.baseRoleId,
    activeSkill: state.activeSkill ? { ...state.activeSkill } : undefined,
    hasActiveDraft: state.hasActiveDraft,
    systemPrompt: state.systemPrompt,
    dataVersionBefore: state.dataVersionBefore,
    completedNodes: [...state.completedNodes],
    sequenceExecution: state.sequenceExecution ? { ...state.sequenceExecution } : undefined,
  };
}

export function isRestorableAgentRunCheckpoint(
  checkpoint: AgentRunCheckpoint | undefined,
  expectedRunId: string,
  expectedRoleId: string,
): checkpoint is AgentRunCheckpoint {
  return Boolean(
    checkpoint
    && checkpoint.version === 1
    && checkpoint.runId === expectedRunId
    && checkpoint.baseRoleId === expectedRoleId
    && checkpoint.userText.trim()
    && checkpoint.userText.length <= 12_000
    && checkpoint.systemPrompt.length <= 100_000
    && Array.isArray(checkpoint.completedNodes)
    && (!checkpoint.sequenceExecution || (isAgentSequenceExecution(checkpoint.sequenceExecution)
      && checkpoint.sequenceExecution.skillId === checkpoint.activeSkill?.id)),
  );
}

/** Restore progress only. Current role and Skill remain authoritative for permissions. */
export function restoreAgentRunCheckpoint(input: {
  checkpoint?: AgentRunCheckpoint;
  expectedRunId: string;
  role: AgentRole;
  effectiveRole: AgentRole;
  activeSkill?: AgentActiveSkillRef;
  hasActiveDraft: boolean;
  history: LlmConversationMessage[];
  fallbackUserText: string;
  fallbackSystemPrompt: string;
}): AgentRunState {
  const checkpoint = input.checkpoint;
  if (!isRestorableAgentRunCheckpoint(checkpoint, input.expectedRunId, input.role.id)) {
    return {
      ...createAgentRunState({
        runId: input.expectedRunId,
        createdAt: new Date().toISOString(),
        userText: input.fallbackUserText,
        role: input.role,
        history: input.history,
      }),
      effectiveRole: input.effectiveRole,
      activeSkill: input.activeSkill,
      hasActiveDraft: input.hasActiveDraft,
      systemPrompt: input.fallbackSystemPrompt,
      completedNodes: ['route', 'memory'],
      currentNode: 'memory',
    };
  }

  const completedNodes = checkpoint.completedNodes
    .filter((nodeId): nodeId is AgentRunNodeId => VALID_NODE_IDS.has(nodeId))
    .filter((nodeId, index, nodes) => nodes.indexOf(nodeId) === index);
  return {
    ...createAgentRunState({
      runId: checkpoint.runId,
      createdAt: checkpoint.createdAt,
      userText: checkpoint.userText,
      role: input.role,
      history: input.history,
    }),
    effectiveRole: input.effectiveRole,
    activeSkill: input.activeSkill,
    hasActiveDraft: input.hasActiveDraft,
    systemPrompt: checkpoint.systemPrompt,
    dataVersionBefore: checkpoint.dataVersionBefore,
    sequenceExecution: checkpoint.sequenceExecution,
    completedNodes,
    currentNode: completedNodes.at(-1),
  };
}
