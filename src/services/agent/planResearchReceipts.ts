import { validatePlanResearch, type PlanResearchBundle } from '../planResearch';
import type { AgentRuntimeContext } from './types';

// Only real IPC results are stored; the model cannot submit its own source list.
const receipts = new Map<string, { owner: string | AgentRuntimeContext; expiresAt: number; bundle: PlanResearchBundle }>();
const ownerOf = (ctx: AgentRuntimeContext) => ctx.getConversationId?.() || ctx;
export function rememberPlanResearch(ctx: AgentRuntimeContext, bundle: PlanResearchBundle, now = Date.now()): string {
  for (const [id, receipt] of receipts) if (receipt.expiresAt <= now) receipts.delete(id);
  if (receipts.size >= 32) receipts.delete(receipts.keys().next().value!);
  const id = crypto.randomUUID();
  receipts.set(id, { owner: ownerOf(ctx), expiresAt: now + 60 * 60_000, bundle: validatePlanResearch(bundle, bundle.subject) });
  return id;
}
export function readPlanResearch(ctx: AgentRuntimeContext, id: unknown, now = Date.now()): PlanResearchBundle {
  const receipt = typeof id === 'string' ? receipts.get(id) : undefined;
  if (!receipt || receipt.owner !== ownerOf(ctx) || receipt.expiresAt <= now) {
    throw new Error('缺少本对话的有效规划检索记录，请先调用 research_learning_plan；用户明确不要联网时才选择 offlineDraft。');
  }
  return structuredClone(receipt.bundle);
}
