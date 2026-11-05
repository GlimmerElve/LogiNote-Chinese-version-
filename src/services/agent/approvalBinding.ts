import type { LlmToolCall } from '../../types';
import type { AgentApprovalBinding, AgentApprovalItem, AgentRuntimeContext } from './types';
import { getTool, describeToolConfirmation } from './toolRegistry';

export function canonicalAgentValue(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
}

async function fingerprint(value: unknown): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new Error('无法安全校验确认内容，请重新发起操作。');
  const bytes = new TextEncoder().encode(canonicalAgentValue(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createAgentApprovalBinding(call: LlmToolCall, ctx: AgentRuntimeContext): Promise<AgentApprovalBinding> {
  const definition = getTool(call.name);
  const kind = definition?.bindsDraft;
  const draft = kind === 'plan' ? ctx.getPlanDraftSession() : kind === 'resource' ? ctx.getResourceDraftSession() : null;
  if (kind && !draft) throw new Error('待确认操作依赖的草案已失效，请重新发起。');
  // Capture synchronously before hashing yields to other UI events.
  const scopedCall = () => ({ name: call.name, arguments: call.arguments,
    ...(ctx.getConversationId ? { conversationId: ctx.getConversationId() } : {}) });
  const argumentsSnapshot = canonicalAgentValue(scopedCall());
  const draftSnapshot = draft ? canonicalAgentValue(draft) : undefined;
  const binding: AgentApprovalBinding = {
    version: 1,
    argumentsFingerprint: await fingerprint(argumentsSnapshot),
    ...(definition?.approvalSnapshot ? { stateFingerprint: await fingerprint(await definition.approvalSnapshot(call.arguments, ctx)) } : {}),
    ...(kind && draft && draftSnapshot ? { draft: { kind, id: draft.id, fingerprint: await fingerprint(draftSnapshot) } } : {}),
  };
  const latestDraft = kind === 'plan' ? ctx.getPlanDraftSession() : kind === 'resource' ? ctx.getResourceDraftSession() : null;
  if (canonicalAgentValue(scopedCall()) !== argumentsSnapshot
    || (kind && canonicalAgentValue(latestDraft) !== draftSnapshot)) {
    throw new Error('校验期间提交内容发生变化，请重新检查并确认。');
  }
  return binding;
}

export function isAgentApprovalBinding(value: unknown): value is AgentApprovalBinding {
  const binding = value as AgentApprovalBinding | undefined;
  return !!binding && binding.version === 1 && /^[a-f0-9]{64}$/u.test(binding.argumentsFingerprint)
    && (!binding.stateFingerprint || /^[a-f0-9]{64}$/u.test(binding.stateFingerprint))
    && (!binding.draft || (['plan', 'resource'].includes(binding.draft.kind)
      && typeof binding.draft.id === 'string' && !!binding.draft.id && /^[a-f0-9]{64}$/u.test(binding.draft.fingerprint)));
}

export async function validateAgentApprovalBinding(item: AgentApprovalItem, ctx: AgentRuntimeContext): Promise<void> {
  if (!isAgentApprovalBinding(item.binding)) throw new Error('这条确认来自旧版本或已失效，请重新生成并确认。');
  const definition = getTool(item.call.name);
  if (definition?.requiresExplicitApproval) {
    const expected = describeToolConfirmation(definition, item.call.arguments, ctx);
    if (canonicalAgentValue({ title: item.title, description: item.description, impacts: item.impacts }) !== canonicalAgentValue(expected)) {
      throw new Error('确认卡展示内容已变化或被截断，请重新生成完整预览后确认。');
    }
  }
  const current = await createAgentApprovalBinding(item.call, ctx);
  if (canonicalAgentValue(current) !== canonicalAgentValue(item.binding)) {
    throw new Error('草案、范围或提交内容已发生变化；本次未执行，请重新检查并确认。');
  }
}

/** This key lives only in the current run; raw parameters never enter audit records. */
export function agentToolEffectKey(call: LlmToolCall): string {
  return canonicalAgentValue({ name: call.name, arguments: call.arguments });
}
