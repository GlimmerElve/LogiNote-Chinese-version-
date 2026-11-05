import { assembleMemoryContext } from '../../memory/memoryContextBuilder';
import { executeAgentNode } from './nodeRunner';
import type { AgentNodeExecutionContext, AgentRunState } from './types';
import type { NoteItem } from '../../../types';

export async function runAgentMemoryNode(
  state: AgentRunState,
  dependencies: { memoryPrefixLoader?: () => Promise<string>; getNotes?: () => NoteItem[] } = {},
  context: AgentNodeExecutionContext = {},
): Promise<AgentRunState> {
  return executeAgentNode(state, {
    id: 'memory',
    activityPhase: 'memory',
    execute: async () => {
      if (state.effectiveRole.toolScope === 'cognition') return { memoryPrefix: '', memoryTrace: undefined, systemPrompt: state.effectiveRole.systemPrompt };
      if (dependencies.memoryPrefixLoader) {
        const memoryPrefix = await dependencies.memoryPrefixLoader();
        return {
          memoryPrefix,
          memoryTrace: undefined,
          systemPrompt: memoryPrefix
            ? `${state.effectiveRole.systemPrompt}\n\n${memoryPrefix}`
            : state.effectiveRole.systemPrompt,
        };
      }
      const memory = await assembleMemoryContext({
        workflow: state.effectiveRole.memoryWorkflow,
        query: state.userText,
        notes: dependencies.getNotes?.(),
      });
      return {
        memoryPrefix: memory.prefix,
        memoryTrace: memory.trace,
        systemPrompt: memory.prefix
          ? `${state.effectiveRole.systemPrompt}\n\n${memory.prefix}`
          : state.effectiveRole.systemPrompt,
      };
    },
  }, context);
}
