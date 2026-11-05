import type { LlmConversationMessage, LlmToolCall } from '../../types';
import type { AgentPendingApproval } from './types';
import { isRestorableAgentRunCheckpoint } from './runtime/checkpoint';
import { isAgentApprovalBinding } from './approvalBinding';
import { ABSOLUTE_MAX_AGENT_TOOL_ROUNDS, ABSOLUTE_MAX_AGENT_TOOL_CALLS, normalizeAgentExecutionMode, normalizeAgentToolCallLimit, resolveAgentExecutionPolicy } from './executionPolicy';

const STORAGE_KEY = 'loginote_agent_checkpoints_v1';
const MAX_FILE_CHARS = 512_000;
const MAX_MESSAGE_CHARS = 16_000;
const SENSITIVE_KEY = /api.?key|token|password|secret|authorization|cookie/i;

export const AGENT_CHECKPOINT_TTL_MS = 24 * 60 * 60 * 1000;

export interface PersistentAgentCheckpointRecord {
  version: 1;
  status: 'pending' | 'resolving';
  roleId: string;
  savedAt: string;
  expiresAt: string;
  approval: AgentPendingApproval;
  history: LlmConversationMessage[];
}

export interface AgentCheckpointFile {
  version: 1;
  pending: PersistentAgentCheckpointRecord | null;
  /** Independent execution lanes; pending remains a legacy/default projection. */
  byRole?: Record<string, PersistentAgentCheckpointRecord>;
}

export interface AgentCheckpointLoadResult {
  status: 'restored' | 'empty' | 'expired' | 'invalid' | 'interrupted';
  record?: PersistentAgentCheckpointRecord;
}

export function classifyAgentCheckpointRecord(
  record: PersistentAgentCheckpointRecord,
  roleId: string,
  now = Date.now(),
): AgentCheckpointLoadResult['status'] {
  if (record.roleId !== roleId) return 'invalid';
  if (Date.parse(record.expiresAt) <= now) return 'expired';
  if (record.status === 'resolving') return 'interrupted';
  return 'restored';
}

interface CheckpointApi {
  loadAgentCheckpoints?: () => Promise<unknown>;
  saveAgentCheckpoints?: (file: unknown) => Promise<void>;
}

function api(): CheckpointApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { electronAPI?: { userState?: CheckpointApi } }).electronAPI?.userState;
}

function containsSensitiveKey(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== 'object' || depth > 12) return false;
  if (Array.isArray(value)) return value.some((item) => containsSensitiveKey(item, depth + 1));
  return Object.entries(value).some(([key, item]) => SENSITIVE_KEY.test(key) || containsSensitiveKey(item, depth + 1));
}

function cloneArguments(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || containsSensitiveKey(value)) return null;
  try {
    const cloned = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    return cloned && typeof cloned === 'object' && !Array.isArray(cloned) ? cloned : null;
  } catch {
    return null;
  }
}

function cloneToolCall(value: unknown): LlmToolCall | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<LlmToolCall>;
  const args = cloneArguments(raw.arguments);
  if (!raw.id || !raw.name || !args) return null;
  return { id: String(raw.id).slice(0, 200), name: String(raw.name).slice(0, 120), arguments: args };
}

function compactMessage(message: LlmConversationMessage): LlmConversationMessage | null {
  if (!['user', 'assistant', 'tool'].includes(message.role)) return null;
  const toolCalls = message.toolCalls?.map(cloneToolCall).filter((item): item is LlmToolCall => Boolean(item));
  if (message.toolCalls?.length && toolCalls?.length !== message.toolCalls.length) return null;
  return {
    role: message.role,
    content: String(message.content || '').slice(0, MAX_MESSAGE_CHARS),
    toolCalls: toolCalls?.length ? toolCalls : undefined,
    toolCallId: message.toolCallId ? String(message.toolCallId).slice(0, 200) : undefined,
    toolName: message.toolName ? String(message.toolName).slice(0, 120) : undefined,
  };
}

/** Keep only the current user request and its complete assistant/tool exchange. */
export function compactAgentApprovalHistory(
  history: LlmConversationMessage[],
  approval: AgentPendingApproval,
): LlmConversationMessage[] {
  const approvalCallIds = new Set(approval.items.map((item) => item.call.id));
  let assistantIndex = -1;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    if (history[index].role === 'assistant' && history[index].toolCalls?.some((call) => approvalCallIds.has(call.id))) {
      assistantIndex = index;
      break;
    }
  }
  if (assistantIndex < 0) throw new Error('待审批历史缺少对应的工具调用');
  let startIndex = assistantIndex;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (history[index].role === 'user') {
      startIndex = index;
      break;
    }
  }
  // Approval exchanges are indivisible. The file-size ceiling bounds large groups.
  const compacted = history.slice(startIndex).map(compactMessage);
  if (compacted.some((message) => !message)) throw new Error('待审批历史包含不可持久化的工具参数');
  if (compacted[0]?.role !== 'user') compacted.unshift({ role: 'user', content: approval.continuation.userText.slice(0, MAX_MESSAGE_CHARS) });
  return compacted as LlmConversationMessage[];
}

function normalizeApproval(value: unknown, roleId: string): AgentPendingApproval | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as AgentPendingApproval;
  const continuation = raw.continuation;
  const checkpoint = continuation?.checkpoint;
  const runId = continuation?.auditRunId || raw.id;
  const budget = resolveAgentExecutionPolicy(continuation?.executionMode, continuation?.skillId, continuation?.toolCallLimit);
  if (
    !raw.id || !Array.isArray(raw.items) || raw.items.length < 1 || raw.items.length > ABSOLUTE_MAX_AGENT_TOOL_CALLS
    || !continuation || typeof continuation.userText !== 'string'
    || typeof continuation.systemPrompt !== 'string'
    || !Number.isInteger(continuation.roundsUsed)
    || continuation.roundsUsed < 0 || continuation.roundsUsed > ABSOLUTE_MAX_AGENT_TOOL_ROUNDS
    || continuation.roundsUsed > budget.maxRounds || raw.items.length > budget.maxToolCalls
    || (continuation.runtimeMetrics && (!Number.isInteger(continuation.runtimeMetrics.toolCalls)
      || continuation.runtimeMetrics.toolCalls < 0
      || continuation.runtimeMetrics.toolCalls + raw.items.length > budget.maxToolCalls))
    || (continuation.toolCallLimit !== undefined && normalizeAgentToolCallLimit(continuation.toolCallLimit) === undefined)
    || !isRestorableAgentRunCheckpoint(checkpoint, runId, roleId)
  ) return null;
  const items = raw.items.map((item) => {
    const call = cloneToolCall(item.call);
    if (!call || !isAgentApprovalBinding(item.binding) || typeof item.title !== 'string' || typeof item.description !== 'string') return null;
    return {
      call,
      binding: JSON.parse(JSON.stringify(item.binding)),
      title: item.title.slice(0, 300),
      description: item.description.slice(0, 1_200),
      impacts: Array.isArray(item.impacts)
        ? item.impacts.filter((impact): impact is string => typeof impact === 'string').map((impact) => impact.slice(0, 500)).slice(0, 30)
        : undefined,
    };
  });
  if (items.some((item) => !item)) return null;
  return {
    id: String(raw.id).slice(0, 500),
    items: items as AgentPendingApproval['items'],
    continuation: {
      userText: continuation.userText,
      systemPrompt: continuation.systemPrompt,
      roundsUsed: continuation.roundsUsed,
      skillId: continuation.skillId,
      auditRunId: continuation.auditRunId,
      postToolReviewEnabled: continuation.postToolReviewEnabled,
      executionMode: normalizeAgentExecutionMode(continuation.executionMode),
      toolCallLimit: normalizeAgentToolCallLimit(continuation.toolCallLimit),
      runtimeMetrics: continuation.runtimeMetrics ? { ...continuation.runtimeMetrics } : undefined,
      checkpoint,
    },
  };
}

export function buildPersistentAgentCheckpoint(input: {
  roleId: string;
  approval: AgentPendingApproval;
  history: LlmConversationMessage[];
  now?: number;
}): PersistentAgentCheckpointRecord {
  const now = input.now ?? Date.now();
  const approval = normalizeApproval(input.approval, input.roleId);
  if (!approval) throw new Error('待审批状态缺少有效 checkpoint，无法跨重启保存');
  const record: PersistentAgentCheckpointRecord = {
    version: 1,
    status: 'pending',
    roleId: input.roleId,
    savedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + AGENT_CHECKPOINT_TTL_MS).toISOString(),
    approval,
    history: compactAgentApprovalHistory(input.history, approval),
  };
  if (JSON.stringify(record).length > MAX_FILE_CHARS) throw new Error('待审批状态过大，无法安全持久化');
  return record;
}

function normalizeRecord(value: unknown): PersistentAgentCheckpointRecord | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Partial<PersistentAgentCheckpointRecord>;
  if (
    raw.version !== 1 || (raw.status !== 'pending' && raw.status !== 'resolving')
    || typeof raw.roleId !== 'string' || !raw.roleId
    || typeof raw.savedAt !== 'string' || !Number.isFinite(Date.parse(raw.savedAt))
    || typeof raw.expiresAt !== 'string' || !Number.isFinite(Date.parse(raw.expiresAt))
    || !Array.isArray(raw.history)
  ) return null;
  const approval = normalizeApproval(raw.approval, raw.roleId);
  if (!approval) return null;
  let history: LlmConversationMessage[];
  try { history = compactAgentApprovalHistory(raw.history as LlmConversationMessage[], approval); }
  catch { return null; }
  const record: PersistentAgentCheckpointRecord = {
    version: 1,
    status: raw.status,
    roleId: raw.roleId,
    savedAt: raw.savedAt,
    expiresAt: raw.expiresAt,
    approval,
    history,
  };
  return JSON.stringify(record).length <= MAX_FILE_CHARS ? record : null;
}

function normalizeFile(raw: unknown): AgentCheckpointFile {
  const input = raw as Partial<AgentCheckpointFile> | null;
  const byRole: Record<string, PersistentAgentCheckpointRecord> = Object.create(null);
  if (input?.byRole && typeof input.byRole === 'object') {
    for (const [key, value] of Object.entries(input.byRole)) {
      const record = normalizeRecord(value);
      if (record && record.roleId === key) byRole[key] = record;
    }
  } else {
    const legacy = normalizeRecord(input?.pending);
    if (legacy) byRole[legacy.roleId] = legacy;
  }
  return { version: 1, byRole, pending: byRole.default || Object.values(byRole)[0] || null };
}
function readLocal(): AgentCheckpointFile {
  if (typeof localStorage === 'undefined') return { version: 1, pending: null };
  try {
    return normalizeFile(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'));
  } catch {
    return { version: 1, pending: null };
  }
}

async function readFile(): Promise<AgentCheckpointFile> {
  const electron = api();
  if (electron?.loadAgentCheckpoints) {
    try {
      const raw = await electron.loadAgentCheckpoints();
      if (raw) return normalizeFile(raw);
    } catch (error) {
      console.warn('[agent-checkpoint] load failed:', error);
    }
  }
  return readLocal();
}

async function writeFile(file: AgentCheckpointFile): Promise<void> {
  if (JSON.stringify(file, null, 2).length > MAX_FILE_CHARS) throw new Error('待审批状态超出512KB安全存储上限；其它标签原检查点保留');
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(file));
  const electron = api();
  if (electron?.saveAgentCheckpoints) {
    try {
      await electron.saveAgentCheckpoints(file);
    } catch (error) {
      if (typeof localStorage !== 'undefined') localStorage.removeItem(STORAGE_KEY);
      throw error;
    }
  }
}

let checkpointWrites: Promise<unknown> = Promise.resolve();
function mutateCheckpoints<T>(work: (file: AgentCheckpointFile) => Promise<T>): Promise<T> {
  const operation = checkpointWrites.catch(() => {}).then(async () => work(normalizeFile(await readFile())));
  checkpointWrites = operation;
  return operation;
}
function projected(file: AgentCheckpointFile): AgentCheckpointFile {
  return { ...file, pending: file.byRole?.default || Object.values(file.byRole || {})[0] || null };
}

export async function savePendingAgentCheckpoint(input: {
  roleId: string;
  approval: AgentPendingApproval;
  history: LlmConversationMessage[];
}): Promise<PersistentAgentCheckpointRecord> {
  const record = buildPersistentAgentCheckpoint(input);
  await mutateCheckpoints(async file => {
    file.byRole ||= {}; file.byRole[input.roleId] = record;
    await writeFile(projected(file));
  });
  return record;
}

export async function markAgentCheckpointResolving(approvalId: string): Promise<void> {
  return mutateCheckpoints(async file => {
  const record = Object.values(file.byRole || {}).find(row => row.approval.id === approvalId);
  if (!record || record.status !== 'pending') {
    throw new Error('待审批 checkpoint 已失效，请重新发起操作');
  }
  file.byRole![record.roleId] = { ...record, status: 'resolving' };
  await writeFile(projected(file));
  });
}

export async function clearPendingAgentCheckpoint(roleId?: string): Promise<void> {
  return mutateCheckpoints(async file => {
    if (roleId) delete file.byRole![roleId]; else file.byRole = {};
    await writeFile(projected(file));
  });
}

export async function loadPendingAgentCheckpoint(
  roleId: string,
  now = Date.now(),
): Promise<AgentCheckpointLoadResult> {
  await checkpointWrites.catch(() => {});
  const file = normalizeFile(await readFile());
  const record = file.byRole?.[roleId];
  if (!record) return { status: 'empty' };
  const status = classifyAgentCheckpointRecord(record, roleId, now);
  if (status !== 'restored') {
    await clearPendingAgentCheckpoint(roleId);
    return { status };
  }
  return { status: 'restored', record };
}
