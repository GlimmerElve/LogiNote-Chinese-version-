import type { AgentRunNodeId } from '../types';

export const AGENT_GRAPH_START = '__start__' as const;
export const AGENT_GRAPH_END = '__end__' as const;

export type AgentGraphEndpoint = AgentRunNodeId | typeof AGENT_GRAPH_START | typeof AGENT_GRAPH_END;
export type AgentGraphSignal =
  | 'success'
  | 'answer-ready'
  | 'approval-required'
  | 'interrupted'
  | 'resumed'
  | 'failure';

export interface AgentGraphEdge {
  from: AgentGraphEndpoint;
  signal: AgentGraphSignal;
  to: AgentGraphEndpoint;
}

export interface AgentGraphTopology {
  version: 1;
  id: 'agent-run-v1';
  edges: readonly AgentGraphEdge[];
}

const MAIN_PATH_NODES: AgentRunNodeId[] = [
  'route', 'memory', 'coordinate', 'tool-loop', 'approval', 'final-answer', 'audit',
];

export const AGENT_RUN_GRAPH: AgentGraphTopology = {
  version: 1,
  id: 'agent-run-v1',
  edges: [
    { from: AGENT_GRAPH_START, signal: 'success', to: 'route' },
    { from: 'route', signal: 'success', to: 'memory' },
    { from: 'memory', signal: 'success', to: 'coordinate' },
    { from: 'coordinate', signal: 'success', to: 'tool-loop' },
    { from: 'tool-loop', signal: 'answer-ready', to: 'final-answer' },
    { from: 'tool-loop', signal: 'approval-required', to: 'approval' },
    { from: 'approval', signal: 'interrupted', to: 'audit' },
    { from: 'approval', signal: 'resumed', to: 'tool-loop' },
    { from: 'final-answer', signal: 'success', to: 'audit' },
    { from: 'audit', signal: 'success', to: AGENT_GRAPH_END },
    ...MAIN_PATH_NODES
      .filter((nodeId) => nodeId !== 'audit')
      .map((nodeId): AgentGraphEdge => ({ from: nodeId, signal: 'failure', to: 'audit' })),
  ],
};

export function validateAgentGraphTopology(topology: AgentGraphTopology): string[] {
  const errors: string[] = [];
  const edgeKeys = new Set<string>();
  topology.edges.forEach((edge) => {
    const key = `${edge.from}:${edge.signal}`;
    if (edgeKeys.has(key)) errors.push(`duplicate-edge:${key}`);
    edgeKeys.add(key);
    if (edge.from === AGENT_GRAPH_END) errors.push('edge-from-end');
    if (edge.to === AGENT_GRAPH_START) errors.push('edge-to-start');
  });
  if (!topology.edges.some((edge) => edge.from === AGENT_GRAPH_START && edge.to === 'route')) {
    errors.push('missing-start-route');
  }
  if (!topology.edges.some((edge) => edge.from === 'audit' && edge.to === AGENT_GRAPH_END)) {
    errors.push('missing-audit-end');
  }
  MAIN_PATH_NODES.forEach((nodeId) => {
    if (!topology.edges.some((edge) => edge.from === nodeId)) errors.push(`missing-outgoing:${nodeId}`);
  });
  return errors;
}

export function resolveAgentGraphTransition(
  from: AgentGraphEndpoint,
  signal: AgentGraphSignal,
  topology: AgentGraphTopology = AGENT_RUN_GRAPH,
): AgentGraphEndpoint {
  const matches = topology.edges.filter((edge) => edge.from === from && edge.signal === signal);
  if (matches.length !== 1) {
    throw new Error(`Agent 图缺少唯一边：${from} --${signal}--> ?`);
  }
  return matches[0].to;
}

export function assertAgentGraphTransition(
  from: AgentGraphEndpoint,
  signal: AgentGraphSignal,
  expected: AgentGraphEndpoint,
): void {
  const actual = resolveAgentGraphTransition(from, signal);
  if (actual !== expected) throw new Error(`Agent 图路由异常：期望 ${expected}，实际 ${actual}`);
}
