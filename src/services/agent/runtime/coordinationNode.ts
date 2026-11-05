import { runDomainMultiAgent, shouldRunDomainCoordination } from '../domainMultiAgent';
import { runSceneMultiAgent } from '../sceneMultiAgent';
import { executeAgentNode, throwIfAgentAborted } from './nodeRunner';
import type { AgentLlmCaller, AgentNodeExecutionContext, AgentRunState } from './types';

export async function runAgentCoordinationNode(
  state: AgentRunState,
  dependencies: { enabled?: boolean; callLlm: AgentLlmCaller },
  context: AgentNodeExecutionContext = {},
): Promise<AgentRunState> {
  return executeAgentNode(state, {
    id: 'coordinate',
    execute: async () => {
      if (!dependencies.enabled) return {};
      try {
        if (state.activeSkill?.id === 'scene-setup') {
          context.onActivity?.({ phase: 'coordinating' });
          const coordinated = await runSceneMultiAgent({
            userRequest: state.userText,
            memoryPrefix: state.memoryPrefix,
            conversation: state.inputHistory.filter(message => message.role !== 'tool').slice(-8)
              .map((message, index) => ({ sourceId: `history-${index}`, role: message.role as 'user' | 'assistant', text: message.content })),
            callLlm: dependencies.callLlm,
            runId: state.runId,
          });
          return {
            coordinationPrompt: coordinated.prompt,
            coordination: coordinated.coordination,
            systemPrompt: `${state.systemPrompt}${coordinated.prompt}`,
          };
        }
        if (!state.hasActiveDraft && shouldRunDomainCoordination(state.activeSkill?.id, state.userText)) {
          context.onActivity?.({ phase: 'coordinating' });
          const coordinated = await runDomainMultiAgent({
            skillId: state.activeSkill?.id,
            userRequest: state.userText,
            memoryPrefix: state.memoryPrefix,
            callLlm: dependencies.callLlm,
            runId: state.runId,
          });
          return {
            coordinationPrompt: coordinated.prompt,
            coordination: coordinated.coordination,
            systemPrompt: `${state.systemPrompt}${coordinated.prompt}`,
          };
        }
      } catch (error) {
        throwIfAgentAborted(context.signal);
        // A failed semantic gate cannot fall through to generic scene-tool matching.
        if (state.activeSkill?.id === 'scene-setup') throw error;
        console.warn(`[agent-coordinator] ${state.activeSkill?.id || 'general'} workflow degraded to the existing skill:`, error);
      }
      return {};
    },
  }, context);
}
