import type { AgentRunNodeId } from '../types';
import type { AgentNodeExecutionContext, AgentRunState, AgentRuntimeNode } from './types';

export function throwIfAgentAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('请求已停止', 'AbortError');
}

export async function executeAgentNodeTask<T>(
  state: AgentRunState,
  descriptor: { id: AgentRunNodeId; activityPhase?: AgentRuntimeNode['activityPhase'] },
  context: AgentNodeExecutionContext,
  task: () => Promise<T> | T,
): Promise<T> {
  throwIfAgentAborted(context.signal);
  const startedAt = Date.now();
  context.onNodeEvent?.({
    version: 1,
    runId: state.runId,
    nodeId: descriptor.id,
    status: 'started',
    occurredAt: new Date(startedAt).toISOString(),
  });
  if (descriptor.activityPhase) context.onActivity?.({ phase: descriptor.activityPhase });

  try {
    const result = await task();
    throwIfAgentAborted(context.signal);
    context.onNodeEvent?.({
      version: 1,
      runId: state.runId,
      nodeId: descriptor.id,
      status: 'completed',
      occurredAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt),
    });
    return result;
  } catch (error) {
    context.onNodeEvent?.({
      version: 1,
      runId: state.runId,
      nodeId: descriptor.id,
      status: 'failed',
      occurredAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - startedAt),
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    throw error;
  }
}

export async function executeAgentNode(
  state: AgentRunState,
  node: AgentRuntimeNode,
  context: AgentNodeExecutionContext = {},
): Promise<AgentRunState> {
  return executeAgentNodeTask(state, node, context, async () => {
    const patch = await node.execute(state, context);
    const completedNodes = state.completedNodes.includes(node.id)
      ? state.completedNodes
      : [...state.completedNodes, node.id];
    return {
      ...state,
      ...patch,
      currentNode: node.id,
      completedNodes,
    };
  });
}
