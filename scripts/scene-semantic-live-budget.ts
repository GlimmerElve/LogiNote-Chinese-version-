export interface SceneLiveBudgetLimits { maxCalls: number; maxOutputTokensTotal: number; maxOutputTokensPerCall: number }
export interface SceneLiveApprovalUsage { calls: number; outputTokensReserved: number }
/** Independent IPC/HTTP reservations catch helpers that unexpectedly issue multiple network requests. */
export function createSceneLiveDispatchBudget(limits: SceneLiveBudgetLimits, prior: SceneLiveApprovalUsage = { calls: 0, outputTokensReserved: 0 }) {
  if (![limits.maxCalls, limits.maxOutputTokensTotal, limits.maxOutputTokensPerCall, prior.calls, prior.outputTokensReserved].every(Number.isSafeInteger)
    || limits.maxCalls < 1 || limits.maxOutputTokensTotal < 1 || limits.maxOutputTokensPerCall < 256 || limits.maxOutputTokensPerCall > 3072
    || prior.calls < 0 || prior.outputTokensReserved < 0 || prior.calls + limits.maxCalls > 24
    || prior.outputTokensReserved + limits.maxOutputTokensTotal > 48000) throw new Error('INVALID_APPROVAL_BUDGET');
  const counters = { ipc: { calls: 0, output: 0 }, http: { calls: 0, output: 0 } };
  return {
    reserve(kind: 'ipc' | 'http', maxOutputTokens: number) {
      const current = counters[kind];
      if (!current || !Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 256 || maxOutputTokens > limits.maxOutputTokensPerCall
        || current.calls >= limits.maxCalls || current.output + maxOutputTokens > limits.maxOutputTokensTotal) throw new Error('LIVE_DISPATCH_BUDGET_EXHAUSTED');
      current.calls++; current.output += maxOutputTokens;
    },
    snapshot() {
      return { ipcCalls: counters.ipc.calls, fetchCalls: counters.http.calls, reservedIpcOutputTokens: counters.ipc.output,
        reservedFetchOutputTokens: counters.http.output, approvalUsage: {
          calls: prior.calls + Math.max(counters.ipc.calls, counters.http.calls),
          outputTokensReserved: prior.outputTokensReserved + Math.max(counters.ipc.output, counters.http.output),
        } };
    },
  };
}
