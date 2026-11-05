import type { AgentRole, AgentWorkspaceSnapshot } from './types';

export const MAX_AGENT_CONVERSATIONS = 8;
export class ConversationLayoutError extends Error {}
export interface AgentConversation {
  id: string;
  title: string;
  workspace: AgentWorkspaceSnapshot;
  archived?: boolean;
}
export interface AgentConversationLayout { version: 1; activeId: string; tabs: AgentConversation[]; draftOwners?: { plan?: string; resource?: string } }
export function normalizeConversationLayout(raw: unknown): AgentConversationLayout | undefined {
  if (raw === undefined) return undefined;
  const file = raw as AgentConversationLayout;
  if (!file || file.version !== 1 || !Array.isArray(file.tabs) || !file.tabs.length || file.tabs.length > 32
    || file.tabs.some(tab => !tab || typeof tab !== 'object')
    || file.tabs.filter(t => !t.archived).length > MAX_AGENT_CONVERSATIONS
    || new Set(file.tabs.map(t => t?.id)).size !== file.tabs.length) throw new ConversationLayoutError('对话标签记录损坏，未覆盖原记录');
  const tabs = file.tabs.map(tab => {
    if (!tab || !/^[a-zA-Z0-9_-]{1,120}$/.test(tab.id) || ['__proto__', 'constructor', 'prototype'].includes(tab.id)
      || typeof tab.title !== 'string' || !tab.title.trim() || tab.title.length > 80
      || !tab.workspace || !Number.isSafeInteger(tab.workspace.revision) || typeof tab.workspace.view !== 'string') throw new ConversationLayoutError('对话标签格式无效');
    const snapshot = tab.workspace;
    for (const key of ['focusedNoteId', 'focusedNoteTitle', 'focusedNoteType'] as const)
      if (snapshot[key] !== undefined && (typeof snapshot[key] !== 'string' || snapshot[key]!.length > 1000)) throw new ConversationLayoutError('标签工作对象无效');
    if (tab.archived !== undefined && typeof tab.archived !== 'boolean') throw new ConversationLayoutError('标签归档状态无效');
    return { id: tab.id, title: tab.title.trim(), workspace: structuredClone(snapshot), ...(tab.archived ? { archived: true } : {}) };
  });
  if (!tabs.some(tab => tab.id === file.activeId && !tab.archived)) throw new ConversationLayoutError('当前对话标签不存在');
  if (file.draftOwners !== undefined && (!file.draftOwners || typeof file.draftOwners !== 'object' || Array.isArray(file.draftOwners))) throw new ConversationLayoutError('草稿所属标签无效');
  const draftOwners: { plan?: string; resource?: string } = {};
  for (const [kind, id] of Object.entries(file.draftOwners || {})) {
    if (!['plan', 'resource'].includes(kind)) throw new ConversationLayoutError('草稿类型无效');
    if (id === undefined) continue;
    if (!tabs.some(tab => tab.id === id && !tab.archived)) throw new ConversationLayoutError('草稿所属标签无效');
    draftOwners[kind as 'plan' | 'resource'] = id;
  }
  return { version: 1, activeId: file.activeId, tabs, ...(file.draftOwners ? { draftOwners } : {}) };
}
/** Existing APIs call this field roleId, but every runtime/persistence key is
 * the stable conversation ID. The capability template/model stays unchanged. */
export function roleForConversation(template: AgentRole, conversationId: string): AgentRole {
  return { ...template, id: conversationId, allowedTools: [...template.allowedTools],
    ...(template.skillToolCeiling ? { skillToolCeiling: [...template.skillToolCeiling] } : {}) };
}

/** Limits foreground Agent runs, not unrelated document/textbook workers. */
export function createConversationScheduler(limit = 2) {
  let active = 0;
  const queue: Array<() => void> = [];
  return {
    acquire(signal: AbortSignal): Promise<() => void> {
      return new Promise((resolve, reject) => {
        if (signal.aborted) { reject(signal.reason || new Error('已停止排队')); return; }
        const cancel = () => { const index = queue.indexOf(start); if (index >= 0) queue.splice(index, 1); reject(signal.reason || new Error('已停止排队')); };
        const start = () => {
          signal.removeEventListener('abort', cancel);
          if (signal.aborted) { reject(signal.reason); return; }
          active++; let released = false;
          resolve(() => { if (released) return; released = true; active--; queue.shift()?.(); });
        };
        if (active < limit) start(); else { queue.push(start); signal.addEventListener('abort', cancel, { once: true }); }
      });
    },
    running: () => active,
    waiting: () => queue.length,
  };
}
export const agentConversationScheduler = createConversationScheduler();
