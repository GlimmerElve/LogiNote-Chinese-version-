import { NoteItem, DueDateItem, VaultSettings, NoteEmbedding } from "../types";
import { getDefaultFlowSettings } from "./flowStorage";
import { saveSettingsState } from "./electronUserState";
import { normalizeLinkTarget } from "./noteResolver";

/**
 * 存储抽象接口（预留本地化部署）
 *
 * 当前实现：后端 `data/vault.json` 单文件存储（方案 A）。
 * 未来本地化部署时，替换为「每个项目一个文件夹」的 FileSystemProvider，
 * 上层调用（loadNotesFromStorage / saveAllNotesToStorage）无需改动。
 */
export interface VaultStorageProvider {
  loadNotes(): Promise<NoteItem[]>;
  saveNotes(notes: NoteItem[]): Promise<void>;
}

const DB_NAME = "LogiNoteVaultDB";
const DB_VERSION = 4;
const NOTES_STORE = "notes";
const EMBEDDINGS_STORE = "note-embeddings";
const SETTINGS_KEY = "loginote_vault_settings_v1";

// Default Initial Vault Seed Notes（首次启动的通用功能引导示例）
export const INITIAL_NOTES: NoteItem[] = [
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
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z"
  },
  {
    id: "note-guide-plan",
    title: "创建你的学习计划",
    content: `# 创建你的学习计划\n\n在「学习 → 计划」中输入你的学习目标，AI 会自动拆解为分阶段、带截止日期的计划树。\n\n## 示例任务\n- [ ] 明确学习目标与范围 @due(2026-08-20)\n- [ ] 拆解为阶段性里程碑 @due(2026-08-23)\n- [ ] 为每个阶段安排知识点 @due(2026-08-27)\n\n带 @due 的任务会自动汇总到「时间线」日历视图，支持勾选完成与截止提醒。`,
    noteType: "project", parentId: "note-guide-overview",
    tags: ["学习计划", "指南"],
    links: [],
    backlinks: [],
    dueDates: [],
    pinned: true, color: "#10B981",
    createdAt: "2026-01-02T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z"
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
    createdAt: "2026-01-03T00:00:00.000Z", updatedAt: "2026-01-03T00:00:00.000Z"
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
    createdAt: "2026-01-04T00:00:00.000Z", updatedAt: "2026-01-04T00:00:00.000Z"
  }
];

export const DEFAULT_SETTINGS: VaultSettings = {
  theme: "light", accentColor: "indigo", localOnly: false,
  enableEncryption: false, cloudSyncEnabled: true, autoAiSegment: true,
  dueNotification: true, fontSize: 16,
  graphPhysics: { repulsion: 300, linkDistance: 120, showTagsInGraph: true },
  flowSettings: getDefaultFlowSettings(),
};

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) { reject(new Error("IndexedDB is not supported")); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e: any) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(NOTES_STORE)) {
        db.createObjectStore(NOTES_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(EMBEDDINGS_STORE)) {
        db.createObjectStore(EMBEDDINGS_STORE, { keyPath: "noteId" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function parseNoteMetadata(note: NoteItem): { links: string[]; dueDates: DueDateItem[] } {
  const linkRegex = /\[\[([^\]#|]+)(?:#[^\]|]+)?(?:\|[^\]]+)?\]\]/g;
  const linksSet = new Set<string>();
  const lines = note.content.split("\n");
  const cleanedLines = lines.filter(line => !line.includes("data:image"));
  const cleanedContent = cleanedLines.join("\n");
  let match;
  while ((match = linkRegex.exec(cleanedContent)) !== null) {
    if (match[1] && match[1].trim()) linksSet.add(match[1].trim());
  }
  const dueDates: DueDateItem[] = [];
  lines.forEach((line, idx) => {
    const dueMatch = line.match(/(.*?)(?:@due\(([\d\-]+)\))/i);
    if (dueMatch) {
      const rawText = dueMatch[1].trim().replace(/^[-*]\s*(\[[ xX]\])?\s*/, "");
      const isCompleted = /^[-*]\s*\[[xX]\]/.test(line.trim());
      dueDates.push({
        id: `due-${note.id}-${idx}`, noteId: note.id, noteTitle: note.title,
        taskText: rawText || note.title, dueDate: dueMatch[2].trim(),
        completed: isCompleted,
        priority: line.includes("【高】") || line.includes("High") ? "high" : "medium"
      });
    }
  });
  return { links: Array.from(linksSet), dueDates };
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

export function recalculateBacklinks(notes: NoteItem[]): NoteItem[] {
  const backlinksMap = new Map<string, Set<string>>();
  const parsedCache = new Map<string, { links: string[]; dueDates: DueDateItem[] }>();
  const notesWithLinks = notes.map((sourceNote) => {
    const parsed = parseNoteMetadata(sourceNote);
    parsedCache.set(sourceNote.id, parsed);
    // 把 links 中出现的别名归一到「原名」标题，保证反链/图谱指向同一笔记对象
    const normalizedLinks = parsed.links.map((t) => normalizeLinkTarget(t, notes));
    normalizedLinks.forEach((targetTitle) => {
      if (!backlinksMap.has(targetTitle)) backlinksMap.set(targetTitle, new Set());
      backlinksMap.get(targetTitle)!.add(sourceNote.title);
    });
    return { ...sourceNote, links: normalizedLinks };
  });
  return notesWithLinks.map((note) => {
    const blSet = backlinksMap.get(note.title) || new Set();
    const parsed = parsedCache.get(note.id)!;
    const existingIds = new Set(note.dueDates.map(d => d.id));
    const newDueDates = parsed.dueDates.filter(d => !existingIds.has(d.id));
    return { ...note, backlinks: Array.from(blSet), dueDates: [...note.dueDates, ...newDueDates] };
  });
}

function migrateNoteData(note: any): NoteItem {
  return { ...note, noteType: note.noteType || "knowledge", parentId: note.parentId || undefined };
}

async function readIndexedDbNotes(): Promise<NoteItem[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(NOTES_STORE, "readonly");
    const req = tx.objectStore(NOTES_STORE).getAll();
    req.onsuccess = () => resolve((req.result as any[]) || []);
    req.onerror = () => reject(req.error);
  });
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
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(EMBEDDINGS_STORE, "readwrite");
    tx.objectStore(EMBEDDINGS_STORE).delete(noteId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadNotesFromStorage(): Promise<NoteItem[]> {
  // 0) Electron 文件系统优先（md + metadata.json）
  const va = (window as any).electronAPI?.vault;
  if (va?.loadVault) {
    try {
      const arr = await va.loadVault();
      if (Array.isArray(arr) && arr.length > 0) {
        return recalculateBacklinks(arr.map(migrateNoteData));
      }
    } catch (e) { console.warn('[vault] electron fs load failed', e); }
  }

  // 1) 回退 localStorage（旧版保存逻辑在文件保存成功时仅写 localStorage，是最新的本地快照）
  const local = localStorage.getItem("loginote_vault_notes");
  if (local) {
    try {
      const parsed = JSON.parse(local);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const finalNotes = recalculateBacklinks(parsed.map(migrateNoteData));
        saveAllNotesToStorage(finalNotes).catch(() => {}); // 回填后端文件作为唯一数据源
        return finalNotes;
      }
    } catch (err) { console.warn("localStorage parse failed", err); }
  }

  // 2) 回退 IndexedDB
  try {
    const idxNotes = await readIndexedDbNotes();
    if (idxNotes.length > 0) {
      const finalNotes = recalculateBacklinks(idxNotes.map(migrateNoteData));
      saveAllNotesToStorage(finalNotes).catch(() => {}); // 回填后端文件作为唯一数据源
      return finalNotes;
    }
  } catch (e) { console.warn("IndexedDB load failed", e); }

  // 3) 所有数据源均为空：仅此时视为首次使用，初始化种子数据
  const initialNotes = recalculateBacklinks(INITIAL_NOTES);
  saveAllNotesToStorage(initialNotes).catch(() => {});
  return initialNotes;
}

export async function saveAllNotesToStorage(notes: NoteItem[]): Promise<void> {
  const updatedNotes = recalculateBacklinks(notes);

  // Electron 文件系统优先
  const va = (window as any).electronAPI?.vault;
  if (va?.saveVault) {
    try {
      await va.saveVault(updatedNotes);
      return;
    } catch (e) { console.warn('[vault] electron fs save failed', e); }
  }

  try {
    const db = await openDB();
    const tx = db.transaction(NOTES_STORE, "readwrite"); const store = tx.objectStore(NOTES_STORE); store.clear();
    for (const note of updatedNotes) store.put(note);
    await new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  } catch (e) { console.warn("IndexedDB save failed, using localStorage fallback", e); }
  localStorage.setItem("loginote_vault_notes", JSON.stringify(updatedNotes));
}

export function loadSettingsFromStorage(): VaultSettings {
  const data = localStorage.getItem(SETTINGS_KEY);
  if (data) {
    try {
      const merged = { ...DEFAULT_SETTINGS, ...JSON.parse(data) };
      // 迁移旧枚举 fontSize（'small' | 'medium' | 'large'）→ 数值（px）
      if (typeof merged.fontSize !== "number") {
        merged.fontSize =
          merged.fontSize === "small" ? 14 :
          merged.fontSize === "large" ? 18 : 16;
      }
      return merged;
    } catch (e) {}
  }
  return DEFAULT_SETTINGS;
}

export function saveSettingsToStorage(settings: VaultSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  // 同步写缓存（立即生效），异步落盘 user-state 文件（持久化权威）
  saveSettingsState(settings).catch(() => {});
}
