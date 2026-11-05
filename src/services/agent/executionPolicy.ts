import type { AgentExecutionMode } from '../../types';

export const MIN_AGENT_TOOL_CALLS = 4;
export const ABSOLUTE_MAX_AGENT_TOOL_CALLS = 48;
export const ABSOLUTE_MAX_AGENT_TOOL_ROUNDS = ABSOLUTE_MAX_AGENT_TOOL_CALLS + 1;

export interface AgentExecutionPolicy {
  mode: AgentExecutionMode;
  maxRounds: number;
  maxToolCalls: number;
  raisedForComplexWorkflow: boolean;
}

const MODE_BUDGETS: Record<AgentExecutionMode, Pick<AgentExecutionPolicy, 'maxRounds' | 'maxToolCalls'>> = {
  economy: { maxRounds: 4, maxToolCalls: 6 },
  standard: { maxRounds: 8, maxToolCalls: 12 },
  deep: { maxRounds: 12, maxToolCalls: 24 },
};

const COMPLEX_WORKFLOW_MINIMUMS: Record<string, Pick<AgentExecutionPolicy, 'maxRounds' | 'maxToolCalls'>> = {
  'personalized-textbook': { maxRounds: 8, maxToolCalls: 12 },
  'plan-planning': { maxRounds: 6, maxToolCalls: 10 },
  'study-task-generation': { maxRounds: 6, maxToolCalls: 10 },
  'resource-curation': { maxRounds: 6, maxToolCalls: 10 },
};

export function normalizeAgentExecutionMode(value: unknown): AgentExecutionMode {
  return value === 'economy' || value === 'deep' ? value : 'standard';
}

/** User preference only; malformed/legacy data cannot increase the budget. */
export function normalizeAgentToolCallLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= MIN_AGENT_TOOL_CALLS
    && value <= ABSOLUTE_MAX_AGENT_TOOL_CALLS ? value : undefined;
}

/** Resolve and freeze one run's budget before its first tool call. */
export function resolveAgentExecutionPolicy(value: unknown, skillId?: string, toolCallLimit?: unknown): AgentExecutionPolicy {
  const mode = normalizeAgentExecutionMode(value);
  const base = MODE_BUDGETS[mode];
  const minimum = skillId ? COMPLEX_WORKFLOW_MINIMUMS[skillId] : undefined;
  const customLimit = normalizeAgentToolCallLimit(toolCallLimit);
  if (customLimit !== undefined) return {
    mode, maxToolCalls: customLimit,
    // Single-tool rounds must be able to use the selected budget. Mode still
    // controls context handling; this does not change a child workflow's budget.
    maxRounds: Math.min(ABSOLUTE_MAX_AGENT_TOOL_ROUNDS, Math.max(base.maxRounds, customLimit + 1)),
    raisedForComplexWorkflow: false,
  };
  const maxRounds = Math.min(ABSOLUTE_MAX_AGENT_TOOL_ROUNDS, Math.max(base.maxRounds, minimum?.maxRounds || 0));
  const maxToolCalls = Math.min(ABSOLUTE_MAX_AGENT_TOOL_CALLS, Math.max(base.maxToolCalls, minimum?.maxToolCalls || 0));
  return { mode, maxRounds, maxToolCalls, raisedForComplexWorkflow: maxRounds > base.maxRounds || maxToolCalls > base.maxToolCalls };
}

export function agentExecutionModeSummary(mode: AgentExecutionMode, toolCallLimit?: number): string {
  const budget = resolveAgentExecutionPolicy(mode, undefined, toolCallLimit);
  return `\u6700\u591a ${budget.maxRounds} \u8f6e\u63a8\u7406 / ${budget.maxToolCalls} \u6b21\u5de5\u5177\u8c03\u7528`;
}
