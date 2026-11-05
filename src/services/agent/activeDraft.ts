import type { AgentRuntimeContext } from './types';

/** An editor-imported plan is still an uncommitted Agent workflow. */
export function hasActiveAgentDraft(ctx: AgentRuntimeContext): boolean {
  return Boolean(
    ctx.getPlanDraftSession()
    || ctx.getResourceDraftSession()
    || ctx.hasPendingPlanEditorDraft?.(),
  );
}
