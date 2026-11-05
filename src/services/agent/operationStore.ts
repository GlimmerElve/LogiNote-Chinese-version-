import type { WorkspaceNoteChange } from './workspaceOperations';
import { applyWorkspaceNoteChange } from './workspaceOperations';
import type { NoteItem } from '../../types';

export interface AgentOperationRecord { id: string; createdAt: string; status: 'prepared' | 'applied' | 'undone'; change: WorkspaceNoteChange }
interface OperationFile { version: 1; records: AgentOperationRecord[] }
const KEY = 'loginote-agent-operations-v1', LIMIT = 8_000_000;
interface OperationApi { loadAgentOperations(): Promise<unknown>; saveAgentOperations(file: unknown): Promise<void> }
function nativeApi(): OperationApi | undefined {
  if (typeof window === 'undefined') return undefined;
  const electron = (window as unknown as { electronAPI?: { userState?: Partial<OperationApi> } }).electronAPI;
  if (!electron) return undefined;
  if (!electron.userState?.loadAgentOperations || !electron.userState.saveAgentOperations) throw new Error('操作恢复需要更新后的桌面主程序，请重启应用');
  return electron.userState as OperationApi;
}
function normalize(value: unknown): OperationFile {
  if (value === null) return { version: 1, records: [] };
  const file = value as OperationFile;
  if (!file || file.version !== 1 || !Array.isArray(file.records) || JSON.stringify(file).length > LIMIT
    || file.records.some(record => !record || typeof record.id !== 'string' || !['prepared', 'applied', 'undone'].includes(record.status)
      || !record.change || !Array.isArray(record.change.before) || !Array.isArray(record.change.after)
      || [...record.change.before, ...record.change.after].some(note => !note || typeof note.id !== 'string' || typeof note.content !== 'string' || typeof note.title !== 'string'))) {
    throw new Error('操作恢复记录损坏，已停止写入，原记录保留');
  }
  return file;
}
export function createAgentOperationStore(storage: { read(): Promise<unknown>; write(file: OperationFile): Promise<void> }) {
  let queue: Promise<unknown> = Promise.resolve();
  const read = async () => normalize(await storage.read());
  const mutate = <T>(work: (file: OperationFile) => T) => {
    const next = queue.catch(() => {}).then(async () => {
      const file = await read(), result = work(file);
      if (JSON.stringify(file).length > LIMIT) throw new Error('恢复记录已达容量上限；本次未修改笔记，请先导出或整理恢复记录');
      await storage.write(file); return result;
    }); queue = next; return next;
  };
  return {
    list: async () => (await read()).records.map(({ id, createdAt, status, change }) => ({ id, createdAt, status, kind: change.kind, label: change.label, noteIds: [...new Set([...change.before, ...change.after].map(note => note.id))], titles: (change.before.length ? change.before : change.after).map(note => note.title) })),
    get: async (id: string) => { const record = (await read()).records.find(item => item.id === id); if (!record) throw new Error('找不到对应操作记录'); return record; },
    prepare: (change: WorkspaceNoteChange) => mutate(file => {
      const record: AgentOperationRecord = { id: `operation-${crypto.randomUUID()}`, createdAt: new Date().toISOString(), status: 'prepared', change: structuredClone(change) };
      file.records.push(record); return record;
    }),
    mark: (id: string, status: AgentOperationRecord['status']) => mutate(file => {
      const record = file.records.find(item => item.id === id); if (!record) throw new Error('操作记录丢失'); record.status = status;
    }),
  };
}
export const agentOperationStore = createAgentOperationStore({
  read: async () => { const api = nativeApi(); if (api) return api.loadAgentOperations(); return typeof localStorage === 'undefined' ? null : JSON.parse(localStorage.getItem(KEY) || 'null'); },
  write: async file => { const api = nativeApi(); if (api) await api.saveAgentOperations(file); else { if (typeof localStorage === 'undefined') throw new Error('操作恢复存储不可用'); localStorage.setItem(KEY, JSON.stringify(file)); } },
});

export function prepareOperationUndo(notes: NoteItem[], record: AgentOperationRecord): WorkspaceNoteChange {
  if (record.status === 'undone') throw new Error('该操作已经恢复');
  // A crash after saving notes but before marking applied is recoverable too.
  const change: WorkspaceNoteChange = { kind: 'restore', label: `恢复：${record.change.label}`, before: record.change.after, after: record.change.before,
    ...(record.change.knowledgeOnly ? { knowledgeOnly: true } : {}) };
  applyWorkspaceNoteChange(notes, change);
  for (const restored of change.after) {
    const collision = notes.find(note => note.id !== restored.id && (note.aliases || []).includes(restored.title) && !change.before.some(item => item.id === note.id));
    if (collision) throw new Error('恢复标题与现有别名冲突');
  }
  return change;
}

export async function commitAgentWorkspaceChange(change: WorkspaceNoteChange, deps: {
  readNotes(): NoteItem[]; saveAndApply(change: WorkspaceNoteChange): Promise<void>;
  store?: ReturnType<typeof createAgentOperationStore>; undoRecordId?: string;
}) {
  const store = deps.store || agentOperationStore;
  applyWorkspaceNoteChange(deps.readNotes(), change);
  const record = deps.undoRecordId ? await store.get(deps.undoRecordId) : await store.prepare(change);
  // Storage I/O can yield to UI edits. Recheck the targets, not an old whole-vault array.
  applyWorkspaceNoteChange(deps.readNotes(), change);
  await deps.saveAndApply(change);
  let recoveryStatus: 'saved' | 'prepared' = 'saved';
  try { await store.mark(record.id, deps.undoRecordId ? 'undone' : 'applied'); }
  catch { recoveryStatus = 'prepared'; /* The durable before/after still enables recovery. */ }
  return { operationId: record.id, recoveryStatus, changedNoteIds: [...new Set([...change.before, ...change.after].map(note => note.id))], changedTitles: (change.after.length ? change.after : change.before).map(note => note.title), saved: true };
}
