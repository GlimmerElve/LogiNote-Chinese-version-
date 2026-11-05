import type { LlmConversationMessage } from '../../types';
import { ConversationLayoutError, normalizeConversationLayout, type AgentConversationLayout } from './conversations';

const STORAGE_KEY = 'loginote_agent_sessions_v1';
const MAX_FILE_CHARS = 2_000_000;
const MAX_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 16_000;

export interface PersistentAgentSession {
  version: 1;
  roleId: string;
  savedAt: string;
  workspaceContextKey: string;
  activeSkillId?: string;
  activeSkillName?: string;
  messages: LlmConversationMessage[];
  /** Only this format guarantees that messages belong to one work object. */
  contextVersion?: 1;
  /** Display-only transcript from earlier work objects; never model context. */
  previousMessages?: LlmConversationMessage[];
}

interface AgentSessionFile {
  version: 1;
  sessions: Record<string, PersistentAgentSession>;
  conversations?: AgentConversationLayout;
}

interface SessionApi {
  loadAgentSessions?: () => Promise<unknown>;
  saveAgentSessions?: (file: unknown) => Promise<void>;
}

function api(): SessionApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { electronAPI?: { userState?: SessionApi } }).electronAPI?.userState;
}

function compactVisibleMessages(history: LlmConversationMessage[]): LlmConversationMessage[] {
  return history
    .filter((message) => (message.role === 'user' || message.role === 'assistant') && Boolean(message.content?.trim()))
    .slice(-MAX_MESSAGES)
    .map((message) => ({
      role: message.role,
      content: message.content.trim().slice(0, MAX_MESSAGE_CHARS),
      citations: message.citations,
      cognitionReferences: message.cognitionReferences,
      cognitionInquiry: message.cognitionInquiry,
    }));
}

function normalizeSession(value: unknown, roleId: string): PersistentAgentSession | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PersistentAgentSession>;
  if (
    raw.version !== 1 || raw.roleId !== roleId || !Array.isArray(raw.messages)
    || typeof raw.savedAt !== 'string' || !Number.isFinite(Date.parse(raw.savedAt))
    || typeof raw.workspaceContextKey !== 'string'
  ) return null;
  const legacyMessages = compactVisibleMessages(raw.messages as LlmConversationMessage[]);
  const scoped = raw.contextVersion === 1;
  const messages = scoped ? legacyMessages : [];
  const remaining = MAX_MESSAGES - messages.length;
  const oldTranscript = Array.isArray(raw.previousMessages) ? compactVisibleMessages(raw.previousMessages) : [];
  // Old releases mixed work objects in messages. Preserve the transcript, but
  // never infer which old operational facts belong to the currently bound ID.
  const previousMessages = remaining > 0 ? [...oldTranscript, ...(scoped ? [] : legacyMessages)].slice(-remaining) : [];
  if (!messages.length && !previousMessages.length) return null;
  const session: PersistentAgentSession = {
    version: 1,
    roleId,
    savedAt: raw.savedAt,
    workspaceContextKey: raw.workspaceContextKey.slice(0, 500),
    activeSkillId: scoped && typeof raw.activeSkillId === 'string' ? raw.activeSkillId.slice(0, 120) : undefined,
    activeSkillName: scoped && typeof raw.activeSkillName === 'string' ? raw.activeSkillName.slice(0, 200) : undefined,
    messages,
    contextVersion: 1,
    ...(previousMessages.length ? { previousMessages } : {}),
  };
  return JSON.stringify(session).length <= MAX_FILE_CHARS ? session : null;
}

function readLocal(): AgentSessionFile {
  if (typeof localStorage === 'undefined') return { version: 1, sessions: {} };
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as { sessions?: Record<string, unknown>; conversations?: unknown } | null;
    const sessions: Record<string, PersistentAgentSession> = {};
    for (const [roleId, value] of Object.entries(parsed?.sessions || {})) {
      const normalized = normalizeSession(value, roleId);
      if (normalized) sessions[roleId] = normalized;
    }
    return { version: 1, sessions, conversations: normalizeConversationLayout(parsed?.conversations) };
  } catch (error) {
    if (error instanceof ConversationLayoutError) throw error;
    return { version: 1, sessions: {} };
  }
}

async function readFile(): Promise<AgentSessionFile> {
  const electron = api();
  if (electron?.loadAgentSessions) {
    try {
      const parsed = await electron.loadAgentSessions() as { sessions?: Record<string, unknown>; conversations?: unknown } | null;
      if (parsed) {
        const sessions: Record<string, PersistentAgentSession> = {};
        for (const [roleId, value] of Object.entries(parsed.sessions || {})) {
          const normalized = normalizeSession(value, roleId);
          if (normalized) sessions[roleId] = normalized;
        }
        return { version: 1, sessions, conversations: normalizeConversationLayout(parsed.conversations) };
      }
    } catch (error) {
      if (error instanceof ConversationLayoutError) throw error;
      console.warn('[agent-session] load failed:', error);
    }
  }
  return readLocal();
}

async function writeFile(file: AgentSessionFile): Promise<void> {
  const serialized = JSON.stringify(file);
  if (serialized.length > MAX_FILE_CHARS) throw new Error('Agent session exceeds the 2 MB safety limit');
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, serialized);
  const electron = api();
  if (electron?.saveAgentSessions) await electron.saveAgentSessions(file);
}

let pendingSessionWrite=Promise.resolve();
export const flushAgentSessionWrites=()=>pendingSessionWrite;
function mutateSession(work:()=>Promise<void>):Promise<void>{
  const write=pendingSessionWrite.catch(()=>{}).then(work);pendingSessionWrite=write;return write;
}
export async function loadAgentSession(roleId: string): Promise<PersistentAgentSession | null> {
  await pendingSessionWrite.catch(()=>{});
  const file = await readFile();
  return normalizeSession(file.sessions[roleId], roleId);
}

export async function saveAgentSession(input: {
  roleId: string;
  workspaceContextKey: string;
  activeSkillId?: string;
  activeSkillName?: string;
  history: LlmConversationMessage[];
  previousHistory?: LlmConversationMessage[];
}): Promise<void> {
  const messages = compactVisibleMessages(input.history);
  const remaining = MAX_MESSAGES - messages.length;
  const previousMessages = remaining > 0 ? compactVisibleMessages(input.previousHistory || []).slice(-remaining) : [];
  if (!messages.length && !previousMessages.length) return clearAgentSession(input.roleId);
  return mutateSession(async()=>{
  const file = await readFile();
  file.sessions[input.roleId] = {
    version: 1,
    roleId: input.roleId,
    savedAt: new Date().toISOString(),
    workspaceContextKey: input.workspaceContextKey.slice(0, 500),
    activeSkillId: input.activeSkillId?.slice(0, 120),
    activeSkillName: input.activeSkillName?.slice(0, 200),
    messages,
    contextVersion: 1,
    ...(previousMessages.length ? { previousMessages } : {}),
  };
  await writeFile(file);
  });
}

export async function clearAgentSession(roleId: string): Promise<void> {
  return mutateSession(async()=>{
  const file = await readFile();
  delete file.sessions[roleId];
  await writeFile(file);
  });
}

export async function loadAgentConversations(): Promise<AgentConversationLayout | undefined> {
  await pendingSessionWrite.catch(() => {});
  return (await readFile()).conversations;
}
export function saveAgentConversations(layout: AgentConversationLayout): Promise<void> {
  const snapshot = normalizeConversationLayout(layout)!;
  return mutateSession(async () => {
    const file = await readFile(); file.conversations = snapshot; await writeFile(file);
  });
}
