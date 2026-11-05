import type { AgentReviewLaunchRequest } from './types';

/**
 * UI callbacks may receive a React click event as their first argument. Keep
 * those events from being mistaken for an Agent-authored review request.
 */
export function normalizeAgentReviewLaunchRequest(value: unknown): AgentReviewLaunchRequest | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.scope !== 'knowledge' && record.scope !== 'project') return undefined;
  if (record.strategy !== 'smart' && record.strategy !== 'weak' && record.strategy !== 'random') return undefined;
  const noteTitle = typeof record.noteTitle === 'string' ? record.noteTitle.trim() : '';
  return {
    scope: record.scope,
    strategy: record.strategy,
    ...(noteTitle ? { noteTitle } : {}),
  };
}
