import { executeAgentNode } from './nodeRunner';
import type { AgentNodeExecutionContext, AgentRunState } from './types';

export interface AgentToolLoopExecution<T> {
  state: AgentRunState;
  value: T;
}

export async function runAgentToolLoopNode<T>(
  state: AgentRunState,
  task: () => Promise<T>,
  context: AgentNodeExecutionContext = {},
): Promise<AgentToolLoopExecution<T>> {
  let value: T | undefined;
  const nextState = await executeAgentNode(state, {
    id: 'tool-loop',
    execute: async () => {
      value = await task();
      return {};
    },
  }, context);
  return { state: nextState, value: value as T };
}
