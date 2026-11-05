import { NoteItem, DueDateItem, VaultSettings, NoteEmbedding } from "../types";
import { getDefaultFlowSettings } from "./flowStorage";
import { saveSettingsState } from "./electronUserState";
import { migrateLearningContent, recoverLearningReviewReferences } from './textbook/migration';
import { recalculateBacklinks } from './noteMetadata';
import { prepareNotesMetadata } from './noteMetadataClient';
export { parseNoteMetadata, recalculateBacklinks } from './noteMetadata';
import { DEFAULT_AGENT_PERSONA, normalizeAgentPersona } from './agent/persona';
import { normalizeAgentToolCallLimit } from './agent/executionPolicy';
import { persistedNoteSaveBaseline as noteSaveBaseline, samePersistedNoteSource } from './noteSaveBaseline';
import type { VaultNotesDelta } from './vaultNoteDelta';
import { getKnowledgeLifecycle, nextKnowledgeLifecycle, setKnowledgeLifecycle, validateKnowledgeLifecycle } from './knowledgeLifecycle';

/**
 * 存储抽象接口（预留本地化部署）
 *
 * 桌面将已确认快照的差异发送到逐篇文件保存接口；浏览器按主键写入
 * IndexedDB。上层保留快照调用方式，但不再每次复制或写入全部正文。
 */
const DB_NAME = "LogiNoteVaultDB";
const DB_VERSION = 5;
const NOTES_STORE = "notes";
const EMBEDDINGS_STORE = "note-embeddings";
const CONTROL_STORE = 'vault-control';
const VAULT_CONTROL_KEY = 'vault';
const KNOWLEDGE_LIFECYCLE_KEY = 'knowledge-lifecycle';
const SETTINGS_KEY = "loginote_vault_settings_v1";
const LEGACY_NOTES_KEY = 'loginote_vault_notes';
let storageOwner: unknown;
let browserVaultInitialized = false;
let browserDirectoryInitialized = false;
let databasePromise: Promise<IDBDatabase> | undefined;
type UnconfirmedNativeSave = { owner: unknown; snapshot: NoteItem[] } &
  ({ kind: 'delta'; delta: VaultNotesDelta } | { kind: 'full' });
let unconfirmedNativeSave: UnconfirmedNativeSave | undefined;

function useStorageOwner(owner: unknown): void {
  if (storageOwner === owner) return;
  storageOwner = owner; noteSaveBaseline.reset(); unconfirmedNativeSave = undefined; setKnowledgeLifecycle(null);
}

/** An IPC rejection does not prove that no file was installed. Replay the exact
 * original intent first; only then can a reverted UI draft become a compensating
 * delta instead of being mistaken for an unchanged, already-saved snapshot. */
async function reconcileUnconfirmedNativeSave(vault: any): Promise<void> {
  const pending = unconfirmedNativeSave;
  if (!pending || pending.owner !== vault) return;
  if (pending.kind === 'delta') await vault.saveNotesDelta(pending.delta);
  else await vault.saveVault(pending.snapshot);
  if (storageOwner !== vault) throw new Error('笔记存储环境已变化，旧保存回执未写入新基线');
  if (pending.kind === 'delta') noteSaveBaseline.acknowledgeDelta(pending.delta);
  else noteSaveBaseline.acknowledge(pending.snapshot);
  if (unconfirmedNativeSave === pending) unconfirmedNativeSave = undefined;
}

function freezeChangedDelta(delta: VaultNotesDelta, snapshot: NoteItem[], owner: unknown): Extract<UnconfirmedNativeSave, { kind: 'delta' }> {
  // Only changed notes are copied. Long unrelated Markdown strings remain in
  // their existing immutable objects; no whole-vault deep clone is performed.
  const frozen = structuredClone(delta);
  const changed = new Map(frozen.upserts.map(entry => [entry.note.id, entry.note]));
  return { kind: 'delta', delta: frozen, owner, snapshot: snapshot.map(note => changed.get(note.id) || note) };
}

/** Create first-use examples against the local day they are installed. Existing
 * notes are never passed through this factory, so real deadlines stay intact. */
export function createInitialNotes(now = new Date()): NoteItem[] {
  const timestamp = now.toISOString();
  const due = (offset: number) => {
    const date = new Date(now);
    date.setDate(date.getDate() + offset);
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  };
  return [
  {
    id: "note-guide-overview",
    title: "欢迎使用 · 功能总览",
    content: `# 欢迎使用 LogiNote Pro\n\n这是一款 iOS 风格的智能学习计划与知识管理笔记。\n\n## 它能帮你做什么\n1. 计划生成：输入目标，AI 自动拆解成结构化学习计划（见 [[创建你的学习计划]]）\n2. 知识记录：写笔记、建立双向链接、AI 一键逻辑分词（见 [[记录与关联知识笔记]]）\n3. 专注学习：心流模式 + 白噪音 + 语音复盘 + AI 分析（见 [[专注学习与智能复习]]）\n4. 智能复习：苏格拉底式追问、气泡复习、记忆曲线自动排期\n5. 知识图谱：自动生成笔记间的关系图谱\n6. 资源推荐：为项目推荐相关的学习资源\n\n从左侧「学习」板块开始，体验完整的学习闭环。`,
    noteType: "project",
    tags: ["指南", "功能总览"],
    links: [],
    backlinks: [],
    dueDates: [],
    pinned: true, isFavorite: true, color: "#3B82F6",
    createdAt: timestamp, updatedAt: timestamp
  },
  {
    id: "note-guide-plan",
    title: "创建你的学习计划",
    content: `# 创建你的学习计划\n\n在「学习 → 计划」中输入你的学习目标，AI 会自动拆解为分阶段、带截止日期的计划树。\n\n## 示例任务\n- [ ] 明确学习目标与范围 @due(${due(1)})\n- [ ] 拆解为阶段性里程碑 @due(${due(4)})\n- [ ] 为每个阶段安排知识点 @due(${due(8)})\n\n示例日期从首次使用当天起安排，你可以修改或删除这些任务。带 @due 的任务会自动汇总到「时间线」日历视图，支持勾选完成与截止提醒。`,
    noteType: "project", parentId: "note-guide-overview",
    tags: ["学习计划", "指南"],
    links: [],
    backlinks: [],
    dueDates: [],
    pinned: true, color: "#10B981",
    createdAt: timestamp, updatedAt: timestamp
  },
  {
    id: "note-guide-knowledge",
    title: "记录与关联知识笔记",
    content: `# 记录与关联知识笔记\n\n知识笔记用于沉淀概念与逻辑要点。\n\n## 双向链接\n用 [[欢迎使用 · 功能总览]] 这样的语法即可建立笔记间的跳转与反向链接。\n\n## AI 逻辑分词\n选中长文本，点击工具栏「AI 逻辑分词」，系统会自动提取概念、定义、逻辑流与学习计划。\n\n## 知识图谱\n所有笔记及其链接会沉淀为图谱节点，形成你的第二大脑。`,
    noteType: "knowledge",
    tags: ["知识笔记", "指南"],
    links: [],
    backlinks: [],
    dueDates: [],
    pinned: false, color: "#8B5CF6",
    createdAt: timestamp, updatedAt: timestamp
  },
  {
    id: "note-guide-study",
    title: "专注学习与智能复习",
    content: `# 专注学习与智能复习\n\n## 心流模式\n- 白噪音沉浸：雨声 / 溪流 / 篝火 等背景音\n- 语音复盘：费曼学习法口述所学，AI 自动分析逻辑漏洞与关联知识\n- 提问区：学习中的疑问即时 AI 解答\n- 总结区：沉淀本次学习要点\n\n## 智能复习\n- 苏格拉底式追问，引导你自主发现\n- 气泡复习\n- 根据记忆曲线（DSR）自动安排复习间隔\n\n从「学习」板块进入心流或复习，体验专注学习。`,
    noteType: "project", parentId: "note-guide-overview",
    tags: ["专注学习", "智能复习", "指南"],
    links: [],
    backlinks: [],
    dueDates: [],
    pinned: false, color: "#F59E0B",
    createdAt: timestamp, updatedAt: timestamp
  }
  ];
}

export const INITIAL_NOTES: NoteItem[] = createInitialNotes();

export const DEFAULT_SETTINGS: VaultSettings = {
  theme: "light", accentColor: 'emerald', localOnly: false,
  enableEncryption: false, cloudSyncEnabled: true, autoAiSegment: true,
  dueNotification: true, fontSize: 16,
  resourceCollectionMode: 'review',
  resourceFormatPreference: 'adaptive',
  agentExecutionMode: 'standard',
  agentPersona: DEFAULT_AGENT_PERSONA,
  graphPhysics: { repulsion: 300, linkDistance: 120, showTagsInGraph: true },
  flowSettings: getDefaultFlowSettings(),
};

function openDB(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  const pending = new Promise<IDBDatabase>((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error("IndexedDB is not supported")); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    let blocked = false;
    request.onupgradeneeded = (e: any) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(NOTES_STORE)) {
        db.createObjectStore(NOTES_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(EMBEDDINGS_STORE)) {
        db.createObjectStore(EMBEDDINGS_STORE, { keyPath: "noteId" });
      }
      if (!db.objectStoreNames.contains(CONTROL_STORE)) db.createObjectStore(CONTROL_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => {
      const db = request.result;
      if (blocked) { db.close(); return; }
      db.onversionchange = () => { db.close(); databasePromise = undefined; };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => { blocked = true; reject(new Error('笔记数据库升级被其他窗口阻挡，请关闭旧窗口后重试')); };
  });
  databasePromise = pending.catch(error => { databasePromise = undefined; throw error; });
  return databasePromise;
}

export function toggleTaskInNoteContent(content: string, taskId: string, taskText: string, dueDate: string): string {
  const lines = content.split("\n"); let matchedIdx = -1;
  const indexMatch = taskId.match(/-(\d+)$/);
  if (indexMatch) {
    const lineIndex = parseInt(indexMatch[1], 10);
    if (lineIndex >= 0 && lineIndex < lines.length) {
      if (lines[lineIndex].includes(`@due(${dueDate})`) || (dueDate && lines[lineIndex].includes(dueDate))) matchedIdx = lineIndex;
    }
  }
  if (matchedIdx === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`@due(${dueDate})`) || (dueDate && lines[i].includes(dueDate))) {
        if (!taskText || lines[i].includes(taskText.slice(0, 8))) { matchedIdx = i; break; }
      }
    }
  }
  if (matchedIdx === -1 && dueDate) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(`@due(${dueDate})`)) { matchedIdx = i; break; }
    }
  }
  if (matchedIdx !== -1) {
    const origLine = lines[matchedIdx]; const isCompleted = /^[-*]\s*\[[xX]\]/.test(origLine.trim());
    if (isCompleted) lines[matchedIdx] = origLine.replace(/^([-*]\s*)\[[xX]\]/, "$1[ ]");
    else if (/^[-*]\s*\[\s*\]/.test(origLine.trim())) lines[matchedIdx] = origLine.replace(/^([-*]\s*)\[\s*\]/, "$1[x]");
    else { const leadingSpace = origLine.match(/^\s*/)?.[0] || ""; const textWithoutBullet = origLine.trim().replace(/^[-*]\s*/, ""); lines[matchedIdx] = `${leadingSpace}- [x] ${textWithoutBullet}`; }
  }
  return lines.join("\n");
}

function migrateNoteData(note: any): NoteItem {
  return recoverLearningReviewReferences(migrateLearningContent({
    ...note,
    noteType: note.noteType || "knowledge",
    parentId: note.parentId || undefined,
    // 清理曾错误写入普通任务列表的过渡版复习提醒；复习排期现由 reviewScheduler 实时派生。
    dueDates: (note.dueDates || []).filter((item: DueDateItem) => !item.id.startsWith('auto-review-')),
  }));
}

/** The control record is committed with the notes, including an explicitly
 * empty vault. A stale legacy JSON export must never resurrect deleted notes. */
const directoryKey = (id: string) => `source:${id}`;
const directoryRecord = (note: NoteItem) => ({ id: directoryKey(note.id), noteId: note.id, title: note.title,
  updatedAt: note.updatedAt, links: note.links });
const validDirectoryRecord = (value: any): boolean => Boolean(value && typeof value.noteId === 'string'
  && value.id === directoryKey(value.noteId) && typeof value.title === 'string' && typeof value.updatedAt === 'string'
  && Array.isArray(value.links) && value.links.every((link: unknown) => typeof link === 'string'));
async function readBrowserVault(): Promise<{ initialized: boolean; directoryReady: boolean; notes: NoteItem[] }> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([NOTES_STORE, CONTROL_STORE], 'readonly');
    const notes = tx.objectStore(NOTES_STORE).getAll();
    const control = tx.objectStore(CONTROL_STORE).getAll();
    tx.oncomplete = () => {
      const rows = control.result || [], marker = rows.find(row => row.id === VAULT_CONTROL_KEY);
      const directory = new Map<string, ReturnType<typeof directoryRecord>>(rows.filter(validDirectoryRecord).map(row => [row.noteId, row]));
      const source = (notes.result || []) as NoteItem[];
      resolve({ initialized: marker?.version === 2 || marker?.version === 3,
        directoryReady: marker?.version === 3 && source.every(note => directory.has(note.id)),
        notes: source.map(note => {
          const metadata = directory.get(note.id);
          return metadata?.title === note.title && metadata.updatedAt === note.updatedAt
            ? { ...note, links: metadata.links } : note;
        }) });
    };
    tx.onerror = () => reject(tx.error || new Error('读取本地笔记失败，原数据已保留'));
    tx.onabort = () => reject(tx.error || new Error('读取本地笔记已中止，原数据已保留'));
  });
}

async function writeBrowserDelta(delta: VaultNotesDelta, snapshot: NoteItem[]): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([NOTES_STORE, CONTROL_STORE], 'readwrite');
    const notes = tx.objectStore(NOTES_STORE);
    const control = tx.objectStore(CONTROL_STORE);
    let conflict: Error | undefined;
    const abort = (message: string) => { conflict = new Error(message); tx.abort(); };
    const checked = (work: () => void) => {
      if (conflict) return;
      try { work(); }
      catch (error) {
        conflict = error instanceof Error ? error : new Error('本地笔记校验失败，草稿已保留');
        tx.abort();
      }
    };
    const seed = new Map<string, ReturnType<typeof directoryRecord>>();
    if (!browserDirectoryInitialized) for (const note of snapshot) {
      const metadata = directoryRecord(note); seed.set(note.id, metadata);
      const request = control.get(metadata.id);
      request.onsuccess = () => checked(() => {
        if (!validDirectoryRecord(request.result)) control.put(metadata);
      });
    }
    // Read only changed primary keys in the same transaction. Another tab may
    // have edited a target since this renderer's last acknowledgement.
    for (const { note, before } of delta.upserts) {
      const request = notes.get(note.id);
      request.onsuccess = () => checked(() => {
        const current = request.result as NoteItem | undefined;
        if (current && samePersistedNoteSource(current, note)) { control.put(directoryRecord(note)); return; }
        if (before ? !current || !samePersistedNoteSource(current, before) : Boolean(current)) {
          abort('目标笔记已在其他窗口发生变化，草稿已保留，请重新核对后保存'); return;
        }
        notes.put(note);
        control.put(directoryRecord(note));
      });
    }
    for (const { id, before } of delta.removed) {
      const request = notes.get(id);
      request.onsuccess = () => checked(() => {
        if (!request.result) return;
        if (!samePersistedNoteSource(request.result, before)) {
          abort('待删除笔记已在其他窗口发生变化，原笔记已保留'); return;
        }
        notes.delete(id);
        control.delete(directoryKey(id));
      });
    }
    for (const item of delta.derivedLinks || []) {
      const request = control.get(directoryKey(item.id));
      request.onsuccess = () => checked(() => {
        const metadata = validDirectoryRecord(request.result) ? request.result : seed.get(item.id);
        if (!metadata || metadata.title !== item.expectedTitle || metadata.updatedAt !== item.expectedUpdatedAt) {
          abort('关联笔记已在其他窗口发生变化，未覆盖新的链接目录'); return;
        }
        control.put({ ...metadata, links: item.links });
      });
    }
    if (delta.removed.some(entry => entry.before.noteType === 'knowledge') || delta.upserts.some(entry => !entry.before && entry.note.noteType === 'knowledge')) {
      const request = control.get(KNOWLEDGE_LIFECYCLE_KEY);
      request.onsuccess = () => checked(() => { const lifecycle = nextKnowledgeLifecycle(validateKnowledgeLifecycle(request.result?.value), delta);
        control.put({ id: KNOWLEDGE_LIFECYCLE_KEY, value: lifecycle }); });
    }
    control.put({ id: VAULT_CONTROL_KEY, version: 3 });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(conflict || tx.error || new Error('本地笔记保存失败，草稿已保留'));
    tx.onabort = () => reject(conflict || tx.error || new Error('本地笔记保存已中止，草稿已保留'));
  });
  browserVaultInitialized = true;
  browserDirectoryInitialized = true;
  // This is migration cleanup only. Never serialize the entire vault here.
  try { localStorage.removeItem(LEGACY_NOTES_KEY); } catch { /* The canonical IDB marker still wins. */ }
}

/* ===== 向量索引（note-embeddings store）读写辅助 ===== */

/** 读取所有笔记向量索引（供 RAG 检索） */
export async function readAllNoteEmbeddings(): Promise<NoteEmbedding[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDINGS_STORE, "readonly");
    const req = tx.objectStore(EMBEDDINGS_STORE).getAll();
    req.onsuccess = () => resolve((req.result as NoteEmbedding[]) || []);
    req.onerror = () => reject(req.error);
  });
}

/** 批量写入笔记向量索引（按 noteId 覆盖） */
export async function writeNoteEmbeddings(embeddings: NoteEmbedding[]): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDINGS_STORE, "readwrite");
    const store = tx.objectStore(EMBEDDINGS_STORE);
    for (const emb of embeddings) store.put(emb);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** 删除指定笔记的向量索引（按 noteId 主键直接删除） */
export async function deleteNoteEmbeddings(noteId: string): Promise<void> {
  return deleteNoteEmbeddingsMany([noteId]);
}

/** One IndexedDB transaction for a deleted subtree, not one database open per note. */
export async function deleteNoteEmbeddingsMany(noteIds: string[]): Promise<void> {
  if (!noteIds.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDINGS_STORE, "readwrite");
    for (const id of new Set(noteIds)) tx.objectStore(EMBEDDINGS_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Private recall fallback: read only; never seed, migrate or backfill the vault. */
export async function readNotesForCognition(): Promise<NoteItem[]> {
  const electron = (window as unknown as { electronAPI?: { vault?: { loadVault?: () => Promise<NoteItem[]> } } }).electronAPI;
  if (electron) {
    if (!electron.vault?.loadVault) throw new Error('桌面笔记读取接口不可用，未读取浏览器旧缓存');
    const notes = await electron.vault.loadVault();
    if (!Array.isArray(notes)) throw new Error('私人笔记快照无效');
    return prepareNotesMetadata(notes);
  }
  const browser = await readBrowserVault();
  if (browser.initialized) return prepareNotesMetadata(browser.notes);
  const local = localStorage.getItem(LEGACY_NOTES_KEY);
  if (local !== null) {
    const raw = JSON.parse(local);
    if (Array.isArray(raw)) return raw;
    throw new Error('笔记快照格式错误');
  }
  return browser.notes;
}

export async function loadNotesFromStorage(): Promise<NoteItem[]> {
  // 0) Electron 文件系统优先（md + metadata.json）
  const va = (window as any).electronAPI?.vault;
  if (va?.loadVault) {
    try {
      useStorageOwner(va);
      // Reads that establish a new baseline share the persistence queue. A late
      // load reply must not replace a newer acknowledged save's baseline.
      const read = vaultSaveQueue.catch(() => {}).then(async () => {
        const arr = await va.loadVault();
        if (!Array.isArray(arr)) throw new Error('笔记库返回格式错误，未初始化或覆盖数据');
        if (storageOwner !== va) throw new Error('笔记存储环境已变化，旧读取回执未写入新基线');
        if (va.knowledgeLifecycle) setKnowledgeLifecycle(await va.knowledgeLifecycle());
        noteSaveBaseline.acknowledge(arr); unconfirmedNativeSave = undefined;
        return prepareNotesMetadata(arr.map(migrateNoteData));
      });
      vaultSaveQueue = read.then(() => {}, () => {});
      return await read;
    } catch (e) { console.warn('[vault] electron fs load failed', e); throw e; }
  }

  useStorageOwner('browser');
  const browser = await readBrowserVault();
  browserVaultInitialized = browser.initialized;
  browserDirectoryInitialized = browser.directoryReady;
  noteSaveBaseline.acknowledge(browser.notes);
  await refreshKnowledgeLifecycle();
  if (browser.initialized) {
    const finalNotes = await prepareNotesMetadata(browser.notes.map(migrateNoteData));
    // Persist one-time content migrations, but derived graph-only changes do no IO.
    await saveAllNotesToStorage(finalNotes);
    return finalNotes;
  }

  // A pre-v5 JSON cache is imported once into an atomic IDB transaction.
  const local = localStorage.getItem(LEGACY_NOTES_KEY);
  if (local !== null) {
    try {
      const parsed = JSON.parse(local);
      if (!Array.isArray(parsed)) throw new Error('本地笔记快照格式错误，未初始化或覆盖数据');
      const finalNotes = await prepareNotesMetadata(parsed.map(migrateNoteData));
      await saveAllNotesToStorage(finalNotes); // Migration must succeed before editing.
      return finalNotes;
    } catch (err) { console.warn("localStorage load failed", err); throw err; }
  }

  // Existing IndexedDB without a control record is upgraded without a full clear.
  if (browser.notes.length > 0) {
    const finalNotes = await prepareNotesMetadata(browser.notes.map(migrateNoteData));
    await saveAllNotesToStorage(finalNotes);
    return finalNotes;
  }

  // 3) 所有数据源均为空：仅此时视为首次使用，初始化种子数据
  const initialNotes = recalculateBacklinks(createInitialNotes());
  await saveAllNotesToStorage(initialNotes);
  return initialNotes;
}

let vaultSaveQueue: Promise<void> = Promise.resolve();
export async function refreshKnowledgeLifecycle(): Promise<void> {
  const api = typeof window !== 'undefined' ? (window as any).electronAPI?.vault : undefined;
  if (api?.knowledgeLifecycle) { setKnowledgeLifecycle(await api.knowledgeLifecycle()); return; }
  if (api) return;
  const db = await openDB();
  const value = await new Promise<unknown>((resolve, reject) => { const request = db.transaction(CONTROL_STORE, 'readonly').objectStore(CONTROL_STORE).get(KNOWLEDGE_LIFECYCLE_KEY);
    request.onsuccess = () => resolve(request.result?.value); request.onerror = () => reject(request.error); });
  setKnowledgeLifecycle(value);
}

/** An explicit selected-object transaction. No whole-array metadata pass,
 * snapshot fallback or all-notes indexing wake-up is permitted on this path. */
export function saveSelectedKnowledgeDelta(delta: VaultNotesDelta): Promise<void> {
  const work = vaultSaveQueue.catch(() => {}).then(async () => {
    if ([...delta.upserts.map(entry => entry.note), ...delta.removed.map(entry => entry.before)].some(note => note.noteType !== 'knowledge')) throw Error('此操作只能修改知识点对象');
    const api = (window as any).electronAPI?.vault;
    if (api) {
      useStorageOwner(api); await reconcileUnconfirmedNativeSave(api);
      if (!api.saveNotesDelta) throw Error('当前主程序缺少增量保存接口，请重启应用');
      const request = freezeChangedDelta(delta, delta.upserts.map(entry => entry.note), api); unconfirmedNativeSave = request;
      const lifecycle = nextKnowledgeLifecycle(getKnowledgeLifecycle(), request.delta);
      await api.saveNotesDelta(request.delta);
      if (storageOwner !== api) throw Error('笔记存储环境已变化');
      noteSaveBaseline.acknowledgeDelta(request.delta); if (unconfirmedNativeSave === request) unconfirmedNativeSave = undefined;
      setKnowledgeLifecycle(lifecycle);
    } else { useStorageOwner('browser'); const lifecycle = nextKnowledgeLifecycle(getKnowledgeLifecycle(), delta);
      await writeBrowserDelta(delta, []); noteSaveBaseline.acknowledgeDelta(delta); setKnowledgeLifecycle(lifecycle); }
    // A failed cache refresh cannot turn a committed deletion into a failed
    // save and make the UI restore objects which were already removed on disk.
    await refreshKnowledgeLifecycle().catch(() => console.warn('[knowledge-maintenance] 对象已保存，迁移记录缓存待刷新'));
  });
  vaultSaveQueue = work; return work;
}
export function saveAllNotesToStorage(notes: NoteItem[]): Promise<void> {
  // Deltas must use the preceding acknowledged baseline, even after failure.
  const write = vaultSaveQueue.catch(() => {}).then(() => writeAllNotesToStorage(notes));
  vaultSaveQueue = write;
  return write;
}
async function writeAllNotesToStorage(notes: NoteItem[]): Promise<void> {
  const updatedNotes = await prepareNotesMetadata(notes);

  // Electron 文件系统优先
  const va = (window as any).electronAPI?.vault;
  if (va) {
    useStorageOwner(va);
    await reconcileUnconfirmedNativeSave(va);
    // 桌面写入失败不能由浏览器缓存冒充成功；调用方保留草稿并允许重试。
    const delta = noteSaveBaseline.delta(updatedNotes);
    if (delta && !delta.upserts.length && !delta.removed.length && !delta.derivedLinks?.length) {
      noteSaveBaseline.acknowledge(updatedNotes); return;
    }
    if (delta && va.saveNotesDelta) {
      const request = freezeChangedDelta(delta, updatedNotes, va);
      unconfirmedNativeSave = request;
      await va.saveNotesDelta(request.delta);
      if (storageOwner !== va) throw new Error('笔记存储环境已变化，旧保存回执未写入新基线');
      noteSaveBaseline.acknowledgeDelta(request.delta);
      if (unconfirmedNativeSave === request) unconfirmedNativeSave = undefined;
      return;
    } else {
      if (!va.saveVault) throw new Error('桌面笔记保存接口不可用，请重启更新后的应用');
      const request: UnconfirmedNativeSave = { kind: 'full', owner: va, snapshot: updatedNotes };
      unconfirmedNativeSave = request;
      await va.saveVault(request.snapshot);
      if (storageOwner !== va) throw new Error('笔记存储环境已变化，旧保存回执未写入新基线');
      if (unconfirmedNativeSave === request) unconfirmedNativeSave = undefined;
    }
    noteSaveBaseline.acknowledge(updatedNotes);
    return;
  }

  useStorageOwner('browser');
  let delta = noteSaveBaseline.delta(updatedNotes);
  if (!delta) {
    const browser = await readBrowserVault();
    browserVaultInitialized = browser.initialized;
    browserDirectoryInitialized = browser.directoryReady;
    noteSaveBaseline.acknowledge(browser.notes);
    delta = noteSaveBaseline.delta(updatedNotes)!;
  }
  if (!browserVaultInitialized || !browserDirectoryInitialized || delta.upserts.length || delta.removed.length || delta.derivedLinks?.length)
    await writeBrowserDelta(delta, updatedNotes);
  noteSaveBaseline.acknowledge(updatedNotes);
  // Browser fallback follows the same save-first/idle-index policy. The dynamic
  // import avoids a storage ↔ RAG initialization cycle and is not awaited by save.
  if (typeof document !== 'undefined') void import('./ragService').then(service => service.scheduleSavedBrowserNoteIndex(updatedNotes))
    .catch(() => console.warn('[note-rag] 后台索引尚未排队，笔记已保存'));
}

export function loadSettingsFromStorage(): VaultSettings {
  try {
    const data = localStorage.getItem(SETTINGS_KEY);
    return data === null ? DEFAULT_SETTINGS : normalizeAppSettings(JSON.parse(data));
  } catch { return DEFAULT_SETTINGS; }
}

export function normalizeAppSettings(raw: unknown): VaultSettings {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('应用设置格式错误');
  const merged = { ...DEFAULT_SETTINGS, ...raw } as VaultSettings;
  if (!(typeof merged.learningWeeklyBudgetMinutes === 'number' && Number.isInteger(merged.learningWeeklyBudgetMinutes)
    && merged.learningWeeklyBudgetMinutes >= 5 && merged.learningWeeklyBudgetMinutes <= 10080)) delete merged.learningWeeklyBudgetMinutes;
  const legacySize: unknown = merged.fontSize;
  merged.fontSize = typeof legacySize === 'number' && Number.isFinite(legacySize)
    ? Math.max(12, Math.min(28, legacySize)) : legacySize === 'small' ? 14 : legacySize === 'large' ? 18 : 16;
  if (!['light', 'dark', 'system'].includes(merged.theme)) merged.theme = DEFAULT_SETTINGS.theme;
  if (!['indigo', 'purple', 'emerald', 'coral', 'rose', 'amber', 'teal', 'slate'].includes(merged.accentColor || '')) {
    merged.accentColor = DEFAULT_SETTINGS.accentColor;
  }
  if (merged.resourceCollectionMode !== 'auto') merged.resourceCollectionMode = 'review';
  if (!['adaptive', 'video', 'reading', 'practice', 'paper'].includes(merged.resourceFormatPreference || '')) merged.resourceFormatPreference = 'adaptive';
  if (!['economy', 'standard', 'deep'].includes(merged.agentExecutionMode || '')) {
    merged.agentExecutionMode = DEFAULT_SETTINGS.agentExecutionMode;
  }
  const toolLimit = normalizeAgentToolCallLimit(merged.agentToolCallLimit);
  if (toolLimit === undefined) delete merged.agentToolCallLimit;
  else merged.agentToolCallLimit = toolLimit;
  merged.agentPersona = normalizeAgentPersona((raw as Record<string, unknown>).agentPersona);
  return merged;
}

/** Authoritative startup read; never write defaults over a delayed/failed file read. */
export async function loadAppSettingsFromStorage(): Promise<VaultSettings> {
  const api = (window as any).electronAPI?.userState;
  if (api?.loadSettings) {
    const raw = await api.loadSettings();
    if (raw !== null) {
      const settings = normalizeAppSettings(raw);
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      return settings;
    }
  }
  const cached = localStorage.getItem(SETTINGS_KEY);
  return cached === null ? DEFAULT_SETTINGS : normalizeAppSettings(JSON.parse(cached));
}

export async function saveSettingsToStorage(settings: VaultSettings): Promise<void> {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  await saveSettingsState(settings);
}
