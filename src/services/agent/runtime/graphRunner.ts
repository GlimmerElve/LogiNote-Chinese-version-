import type { AgentRunNodeId } from '../types';
import { AGENT_GRAPH_END, AGENT_GRAPH_START, resolveAgentGraphTransition } from './graphTopology';
import type { AgentNodeExecutionContext, AgentRunState } from './types';

export type AgentGraphNodeHandler = (
  state: AgentRunState,
  context: AgentNodeExecutionContext,
) => Promise<AgentRunState>;

/** Executes a deterministic graph segment until the next node is stopBefore. */
export async function runAgentGraphSegment(input: {
  state: AgentRunState;
  start: AgentRunNodeId;
  stopBefore: AgentRunNodeId;
  handlers: Partial<Record<AgentRunNodeId, AgentGraphNodeHandler>>;
  context?: AgentNodeExecutionContext;
}): Promise<AgentRunState> {
  let state = input.state;
  let current: AgentRunNodeId = input.start;
  const context = input.context || {};

  for (let hops = 0; hops < 16; hops += 1) {
    if (current === input.stopBefore) return state;
    const handler = input.handlers[current];
    if (!handler) throw new Error(`Agent 图节点未注册执行器：${current}`);
    state = await handler(state, context);
    const next = resolveAgentGraphTransition(current, 'success');
    if (next === AGENT_GRAPH_END) {
      throw new Error(`Agent 图在到达 ${input.stopBefore} 前提前结束`);
    }
    if (next === AGENT_GRAPH_START) throw new Error('Agent 图不允许返回起点');
    current = next;
  }

  throw new Error('Agent 图节点跳转超过安全上限');
}
