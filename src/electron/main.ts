import { app, BrowserWindow, ipcMain, shell, dialog, session } from 'electron';
import { spawn, type ChildProcess } from 'child_process';
import { autoUpdater } from 'electron-updater';
import path from 'path';
import os from 'os';
import net from 'net';
import fs from 'fs/promises';
import { openSync, closeSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { serializeMetadata, deserializeVault, markdownFileMap } from '../services/vaultFsService';
import {
  splitUserStateFields,
  splitSharableFields,
  mergeNote,
  hasAnyUserState,
  serializeUserStateFile,
  deserializeUserStateFile,
  serializeProfileState,
  deserializeProfileState,
  serializeSettingsState,
  deserializeSettingsState,
  serializeLlmState,
  deserializeLlmState,
  serializeMasteryTimelineState,
  deserializeMasteryTimelineState,
  USER_STATE_FILES,
} from '../services/userStateService';
import type { NoteItem, UserNoteState, UploadedDocument } from '../types';
import {
  setDataRoot,
  setModelsDir,
  readManifest,
  upsertManifestEntries,
  updateManifest,
  deleteManifestEntry,
  deleteChunksFile,
  writeChunksFile,
  searchDocuments,
  vectorizeDocument,
  getDocumentsDir,
  documentExists,
} from './ragIndex';
import { extractPdfText, setPdfExtractScript } from './pdf';
import {
  proxyLlmRequest,
  streamLlmRequest,
  probeLlmRequest,
  segmentText,
  autoLink,
  resourceSearch,
  conceptGeneration,
} from './apiHandlers';
import type {
  LlmIpcRequest,
  SegmentIpcRequest,
  AutoLinkIpcRequest,
  ResourceSearchIpcRequest,
  ConceptGenIpcRequest,
} from './ipcTypes';
import {
  setNoteRagDataRoot,
  indexNote as noteRagIndexNote,
  indexNotes as noteRagIndexNotes,
  deleteNoteIndex as noteRagDeleteIndex,
  searchNotes as noteRagSearchNotes,
} from './noteRag';

let sttProcess: ChildProcess | null = null;
let sttPort: number = 0;
let mainWindow: BrowserWindow | null = null;

// ===== 资料文档后台向量化队列（主进程内存队列，串行推进） =====
const vectorizationQueue: string[] = [];
let vectorizing = false;

function notifyRagChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rag-docs:changed');
  }
}

/** 处理单个文档的向量化：parse → chunk → embed → 写 chunks → ready */
async function processOneVectorization(docId: string): Promise<void> {
  // 删除取消检查：若该文档已被删除，跳过并清理半成品
  if (!(await documentExists(docId))) {
    await deleteChunksFile(docId);
    return;
  }

  const manifest = await readManifest();
  const doc = manifest.find((d) => d.id === docId);
  if (!doc) return;

  await updateManifest(docId, { status: 'processing', chunkCount: 0, totalChars: 0 });
  notifyRagChanged();

  try {
    // 解析文本：txt/md 直读，pdf 抽文本。物理文件按「docId + 扩展名」存储。
    const ext = doc.fileType === 'md' ? '.md' : doc.fileType === 'txt' ? '.txt' : '.pdf';
    const srcPath = path.join(await getDocumentsDir(), storedFileName(docId, ext));
    let text = '';
    if (doc.fileType === 'pdf') {
      text = await extractPdfText(srcPath);
    } else {
      text = await fs.readFile(srcPath, 'utf-8');
    }

    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error(
        doc.fileType === 'pdf'
          ? '该 PDF 可能为扫描件或无可抽取文本层，暂不支持 OCR'
          : '文档内容为空',
      );
    }

    const chunks = await vectorizeDocument(docId, doc.fileName, trimmed);
    if (chunks.length === 0) {
      throw new Error('未生成有效分块');
    }
    await writeChunksFile(docId, chunks);
    await updateManifest(docId, {
      status: 'ready',
      chunkCount: chunks.length,
      totalChars: trimmed.length,
      error: undefined,
    });
  } catch (e: any) {
    console.warn('[rag] 向量化失败:', doc.fileName, e?.message);
    await updateManifest(docId, { status: 'failed', error: e?.message || '向量化失败' });
  }
  notifyRagChanged();
}

/** 串行消费队列 */
async function drainVectorizationQueue(): Promise<void> {
  if (vectorizing) return;
  vectorizing = true;
  try {
    while (vectorizationQueue.length > 0) {
      const docId = vectorizationQueue.shift();
      if (docId) {
        try {
          await processOneVectorization(docId);
        } catch (e) {
          console.warn('[rag] 队列处理异常:', e);
        }
      }
    }
  } finally {
    vectorizing = false;
  }
}

function enqueueVectorization(docId: string): void {
  vectorizationQueue.push(docId);
  void drainVectorizationQueue();
}

/** 根据扩展名推导 fileType */
function detectFileType(fileName: string): 'txt' | 'md' | 'pdf' | null {
  const ext = path.extname(fileName).toLowerCase();
  if (ext === '.txt') return 'txt';
  if (ext === '.md' || ext === '.markdown') return 'md';
  if (ext === '.pdf') return 'pdf';
  return null;
}

/** 物理存储文件名：docId + 原扩展名（避免原始文件名重名冲突） */
function storedFileName(id: string, ext: string): string {
  return `${id}${ext}`;
}

/** 启动恢复：把残留 processing 重置为 pending 并重新入队 */
async function recoverProcessingDocs(): Promise<void> {
  try {
    const manifest = await readManifest();
    for (const d of manifest) {
      if (d.status === 'processing') {
        await updateManifest(d.id, { status: 'pending' });
        enqueueVectorization(d.id);
      }
    }
  } catch (e) {
    console.warn('[rag] 启动恢复扫描失败:', e);
  }
}

// ===== 数据根目录：整体搬迁 userData =====
// 锚点配置固定放在用户主目录（不受 userData 移动影响），启动最早阶段读取，
// 通过 app.setPath('userData') 把 vault/user-state/缓存/localStorage/IndexedDB 一并落到自定义盘。
const ANCHOR_DIR = path.join(os.homedir(), '.logi-note');
const ANCHOR_FILE = path.join(ANCHOR_DIR, 'storage-config.json');

function readAnchorConfig(): { dataRoot?: string } {
  try {
    return JSON.parse(readFileSync(ANCHOR_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveAnchorConfig(dataRoot: string): void {
  mkdirSync(ANCHOR_DIR, { recursive: true });
  writeFileSync(ANCHOR_FILE, JSON.stringify({ dataRoot }, null, 2), 'utf-8');
}

/** 必须在任何 app.getPath('userData') 调用之前执行（整体搬迁 userData） */
function applyCustomUserDataPath(): void {
  const cfg = readAnchorConfig();
  if (cfg.dataRoot && typeof cfg.dataRoot === 'string' && cfg.dataRoot.trim()) {
    try {
      app.setPath('userData', path.resolve(cfg.dataRoot.trim()));
    } catch (e) {
      console.warn('[storage] 设置自定义数据路径失败:', e);
    }
  }
}
applyCustomUserDataPath();

function getDataRoot(): string {
  return app.getPath('userData');
}

let vaultRoot = '';

function getVaultRoot(): string {
  if (!vaultRoot) {
    vaultRoot = path.join(getDataRoot(), 'vault');
  }
  return vaultRoot;
}

async function ensureVaultDir(): Promise<string> {
  const root = getVaultRoot();
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.join(root, 'notes'), { recursive: true });
  return root;
}

function getUserStateDir(): string {
  return path.join(getDataRoot(), 'user-state');
}

/** 判断 child 是否位于 parent 目录内部（用于防递归复制） */
function isSubPath(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** 尽力逐项复制目录内容；单文件锁定/失败时跳过（仅缓存类可重建，不影响核心数据） */
async function copyDirBestEffort(src: string, dst: string, isTop = true): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  let entries: Array<{ name: string; isDirectory: boolean }> = [];
  try {
    const list = await fs.readdir(src, { withFileTypes: true });
    entries = list.map((d) => ({ name: d.name, isDirectory: d.isDirectory() }));
  } catch {
    return;
  }
  for (const ent of entries) {
    const s = path.join(src, ent.name);
    const d = path.join(dst, ent.name);
    // 顶层防递归：跳过目标目录自身（当目标位于源内部时）
    if (isTop && isSubPath(d, src)) continue;
    try {
      if (ent.isDirectory) {
        await copyDirBestEffort(s, d, false);
      } else {
        await fs.copyFile(s, d);
      }
    } catch {
      // 单个文件被占用（常见于 Chromium 缓存的 lock 文件）：跳过，可重建
    }
  }
}

/** 整体复制旧 userData 目录的全部内容（vault/user-state/缓存/IndexedDB/localStorage 一并迁移） */
async function migrateDataTo(oldRoot: string, newRoot: string): Promise<void> {
  // 防递归：目标不能位于旧数据目录内部
  if (isSubPath(newRoot, oldRoot)) {
    throw new Error('目标文件夹不能位于当前数据目录内，请选择其它位置');
  }
  await copyDirBestEffort(oldRoot, newRoot);
}

async function ensureUserStateDir(): Promise<string> {
  const dir = getUserStateDir();
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function readUserStateFileIfExists(fileName: string): Promise<string | null> {
  try {
    return await fs.readFile(path.join(getUserStateDir(), fileName), 'utf-8');
  } catch {
    return null;
  }
}

async function writeUserStateFile(fileName: string, content: string): Promise<void> {
  await ensureUserStateDir();
  await fs.writeFile(path.join(getUserStateDir(), fileName), content, 'utf-8');
}

/**
 * 一次性迁移 + 读取合并：读 vault（仅内容）与 user-state（个人状态），合并出完整 NoteItem[]。
 * 兼容旧版：若 metadata.json 里仍混有个人字段（旧格式），自动剥离到 user-state。
 */
async function loadMergedNotes(): Promise<NoteItem[]> {
  await ensureVaultDir();
  const root = getVaultRoot();

  let contentNotes: NoteItem[] = [];
  try {
    const metaText = await fs.readFile(path.join(root, 'metadata.json'), 'utf-8');
    const notesDir = path.join(root, 'notes');
    const files = await fs.readdir(notesDir);
    const mdMap = new Map<string, string>();
    for (const f of files) {
      if (f.endsWith('.md')) {
        mdMap.set(f, await fs.readFile(path.join(notesDir, f), 'utf-8'));
      }
    }
    // deserializeVault 返回的是 metadata 里的字段（旧格式可能含个人字段）
    contentNotes = deserializeVault(metaText, mdMap);
  } catch {
    return [];
  }

  // 是否旧格式混有个人字段 → 触发迁移
  let needsMigration = false;
  for (const n of contentNotes) {
    if (hasAnyUserState(splitUserStateFields(n))) {
      needsMigration = true;
      break;
    }
  }

  const stateText = await readUserStateFileIfExists(USER_STATE_FILES.noteStates);
  let noteStates: Record<string, UserNoteState> = stateText ? deserializeUserStateFile(stateText) : {};

  if (needsMigration) {
    // 旧格式：把混在 metadata 里的个人字段剥出来写进 user-state，metadata 重写为纯内容
    const mergedStates: Record<string, UserNoteState> = {};
    for (const n of contentNotes) {
      const st = splitUserStateFields(n);
      if (hasAnyUserState(st)) mergedStates[n.id] = st;
    }
    noteStates = { ...noteStates, ...mergedStates };
    await writeUserStateFile(USER_STATE_FILES.noteStates, serializeUserStateFile(noteStates));
    // 重写 metadata 为纯内容（白名单）
    const sharable = contentNotes.map(splitSharableFields);
    await fs.writeFile(path.join(root, 'metadata.json'), serializeMetadata(sharable), 'utf-8');
    contentNotes = sharable;
  }

  // 合并个人状态回完整笔记
  return contentNotes.map((n) => mergeNote(n, noteStates[n.id]));
}

/** 打包态与开发态统一的模型根目录 */
function resolveModelsDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'models')
    : path.join(app.getAppPath(), 'models');
}

/** 获取一个空闲 TCP 端口（先 bind 再释放，交给子进程使用） */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** 启动本地 STT 后端（动态端口；打包态 spawn 独立 exe，开发态 spawn python 脚本） */
async function spawnSttServer(): Promise<void> {
  const isPackaged = app.isPackaged;
  const modelsDir = resolveModelsDir();
  const logPath = path.join(getDataRoot(), 'stt_server.log');

  try {
    sttPort = await getFreePort();
  } catch (e) {
    console.warn('[stt] 获取空闲端口失败，使用默认 8765:', e);
    sttPort = 8765;
  }

  // 用 openSync 打开真实文件描述符（整数 fd），避免传入未打开的 WriteStream（fd 为 null）
  let logFd: number | null = null;
  try {
    logFd = openSync(logPath, 'a');
  } catch (e) {
    console.warn('[stt] 打开日志文件失败，改用忽略输出:', e);
    logFd = null;
  }

  try {
    const env = { ...process.env, LOGINOTE_MODELS_DIR: modelsDir };
    const stdio: ('ignore' | number)[] = logFd !== null ? ['ignore', logFd, logFd] : ['ignore', 'ignore', 'ignore'];
    let child: ChildProcess;
    if (isPackaged) {
      const sttExe = path.join(process.resourcesPath, 'stt_server', 'stt_server.exe');
      child = spawn(sttExe, ['--port', String(sttPort)], { env, stdio, windowsHide: true });
    } else {
      const sttScript = path.join(app.getAppPath(), 'python', 'stt_server.py');
      child = spawn('python', [sttScript, '--port', String(sttPort)], { env, stdio, windowsHide: true });
    }
    sttProcess = child;

    // 子进程已持有 fd 副本，父进程可关闭自己这份，避免句柄泄漏
    if (logFd !== null) {
      try { closeSync(logFd); } catch { /* ignore */ }
    }

    child.on('error', (err) => {
      console.warn('[stt] STT 后端启动失败:', err.message);
      sttProcess = null;
    });
    child.on('exit', (code) => {
      console.log('[stt] STT 后端退出，code =', code);
      sttProcess = null;
    });
  } catch (e) {
    console.warn('[stt] spawn 异常:', e);
  }
}

function registerIpcHandlers(): void {
  ipcMain.handle('open-external', (_e, url: string) => shell.openExternal(url));

  // ===== LLM / AI 服务（迁移自 server.ts，渲染进程通过 IPC 调用） =====
  ipcMain.handle('llm:request', async (_e, req: LlmIpcRequest) => proxyLlmRequest(req));
  ipcMain.handle('llm:probe', async (_e, req: LlmIpcRequest) => probeLlmRequest(req));

  ipcMain.handle('llm:stream-start', async (_e, req: LlmIpcRequest) => {
    const sender = _e.sender;
    const streamId = `llm-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    void streamLlmRequest(req, (chunk) => {
      if (!sender.isDestroyed()) {
        sender.send('llm:stream-chunk', { streamId, chunk });
      }
    })
      .then(() => {
        if (!sender.isDestroyed()) sender.send('llm:stream-end', { streamId });
      })
      .catch((err) => {
        if (!sender.isDestroyed()) sender.send('llm:stream-error', { streamId, message: (err as Error).message || '流式请求失败' });
      });
    return streamId;
  });

  ipcMain.handle('ai:segment', async (_e, req: SegmentIpcRequest) => segmentText(req));
  ipcMain.handle('ai:auto-link', async (_e, req: AutoLinkIpcRequest) => autoLink(req));
  ipcMain.handle('ai:resource-search', async (_e, req: ResourceSearchIpcRequest) => resourceSearch(req));
  ipcMain.handle('ai:concept-generation', async (_e, req: ConceptGenIpcRequest) => conceptGeneration(req));

  // 打开数据目录（vault/ 与 user-state/ 的父级），作为「导出/备份」入口，让用户自行拷贝管理
  ipcMain.handle('data:open-folder', async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const dir = getDataRoot();
      const err = await shell.openPath(dir);
      return { ok: !err, error: err || undefined };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // 导出心流复盘分析结果为 Markdown 文件到用户指定目录下的 AnalysisResult 文件夹
  ipcMain.handle('analysis:export', async (_e, content: unknown, fileName: unknown): Promise<{ ok: boolean; path?: string; error?: string }> => {
    try {
      const md = typeof content === 'string' ? content : '';
      if (!md) return { ok: false, error: '导出内容为空' };
      const name = typeof fileName === 'string' && fileName.trim()
        ? fileName.trim().replace(/[\\/:*?"<>|]/g, '_')
        : '分析报告.md';
      const baseName = name.endsWith('.md') ? name : `${name}.md`;

      const res = await dialog.showOpenDialog({
        title: '选择导出目录（将生成 AnalysisResult 文件夹）',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (res.canceled || res.filePaths.length === 0) return { ok: false, error: '已取消' };

      const analysisDir = path.join(res.filePaths[0], 'AnalysisResult');
      await fs.mkdir(analysisDir, { recursive: true });
      const targetPath = path.join(analysisDir, baseName);
      await fs.writeFile(targetPath, md, 'utf-8');
      return { ok: true, path: targetPath };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // ===== 自定义数据存储路径（整体搬迁 userData，重启生效） =====
  ipcMain.handle('storage:get-root', async (): Promise<{ root: string; custom: boolean }> => ({
    root: getDataRoot(),
    custom: !!readAnchorConfig().dataRoot,
  }));

  ipcMain.handle('storage:choose-folder', async (): Promise<string | null> => {
    const res = await dialog.showOpenDialog({
      title: '选择数据存储文件夹（建议选非系统盘，如 D 盘）',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (res.canceled || res.filePaths.length === 0) return null;
    return res.filePaths[0];
  });

  // 选择本地学习资源文件（多选），返回绝对路径数组；取消返回 []
  ipcMain.handle('resource:choose-local-files', async (): Promise<string[]> => {
    const res = await dialog.showOpenDialog({
      title: '选择本地学习资源',
      properties: ['openFile', 'multiSelections'],
    });
    if (res.canceled || res.filePaths.length === 0) return [];
    return res.filePaths;
  });

  ipcMain.handle('storage:set-root', async (_e, newRoot: unknown, migrate: boolean): Promise<{ ok: boolean; error?: string }> => {
    try {
      const target = typeof newRoot === 'string' && newRoot.trim() ? path.resolve(newRoot.trim()) : '';
      if (!target) return { ok: false, error: '目标路径无效' };

      const oldRoot = getDataRoot();
      if (target === oldRoot) return { ok: true };

      // 目标目录本身即 userData 根：vault/、user-state/、缓存/localStorage/IndexedDB 都放这里
      if (migrate) {
        await migrateDataTo(oldRoot, target);
      } else {
        await fs.mkdir(target, { recursive: true });
      }

      // 只写锚点配置，下次启动由 applyCustomUserDataPath() 生效（app.setPath 必须在 ready 前调用）
      saveAnchorConfig(target);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  // 清空所有数据（恢复初始化）：删除数据本体目录 + 清空 Chromium 存储，保留自定义路径锚点
  ipcMain.handle('storage:reset', async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      const root = getDataRoot();
      await fs.rm(path.join(root, 'vault'), { recursive: true, force: true });
      await fs.rm(path.join(root, 'user-state'), { recursive: true, force: true });
      // 清空 localStorage / IndexedDB / Cache 等浏览器存储
      try {
        await session.defaultSession.clearStorageData({
          storages: ['localstorage', 'indexdb', 'cachestorage', 'websql', 'serviceworkers', 'shadercache'],
        });
        await session.defaultSession.clearCache();
      } catch (e) {
        console.warn('[storage] 清理浏览器存储失败（可忽略）:', e);
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  });

  ipcMain.handle('vault:load', async (): Promise<unknown[]> => {
    return loadMergedNotes();
  });

  ipcMain.handle('vault:save', async (_e, notes: unknown[]): Promise<void> => {
    const noteList = (notes || []) as NoteItem[];
    const root = await ensureVaultDir();

    // 1) 内容写 vault/（metadata 只含白名单 + 各 .md）
    const sharable = noteList.map(splitSharableFields);
    const notesDir = path.join(root, 'notes');
    await fs.writeFile(path.join(root, 'metadata.json'), serializeMetadata(sharable), 'utf-8');
    const existing = await fs.readdir(notesDir);
    for (const f of existing) {
      if (f.endsWith('.md')) {
        await fs.unlink(path.join(notesDir, f));
      }
    }
    const mdMap = markdownFileMap(sharable);
    for (const [file, content] of mdMap) {
      await fs.writeFile(path.join(notesDir, file), content, 'utf-8');
    }

    // 2) 个人状态写 user-state/user-state.json
    const noteStates: Record<string, UserNoteState> = {};
    for (const n of noteList) {
      const st = splitUserStateFields(n);
      if (hasAnyUserState(st)) noteStates[n.id] = st;
    }
    await writeUserStateFile(USER_STATE_FILES.noteStates, serializeUserStateFile(noteStates));
  });

  ipcMain.handle('vault:get-root', async (): Promise<string> => getVaultRoot());

  // ===== user-state 独立读写 IPC（profile / settings / llm / flow-sessions） =====
  ipcMain.handle('user-state:load-profile', async (): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.profile);
    return text ? deserializeProfileState(text) : null;
  });

  ipcMain.handle('user-state:save-profile', async (_e, profile: unknown, conceptAliasMap: unknown): Promise<void> => {
    await writeUserStateFile(USER_STATE_FILES.profile, serializeProfileState(profile as never, (conceptAliasMap as Record<string, string>) || {}));
  });

  ipcMain.handle('user-state:load-settings', async (): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.settings);
    return text ? deserializeSettingsState(text) : null;
  });

  ipcMain.handle('user-state:save-settings', async (_e, settings: unknown): Promise<void> => {
    await writeUserStateFile(USER_STATE_FILES.settings, serializeSettingsState(settings as never));
  });

  ipcMain.handle('user-state:load-llm', async (): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.llm);
    return text ? deserializeLlmState(text) : null;
  });

  ipcMain.handle('user-state:save-llm', async (_e, settings: unknown): Promise<void> => {
    await writeUserStateFile(USER_STATE_FILES.llm, serializeLlmState(settings as never));
  });

  ipcMain.handle('user-state:load-mastery-timeline', async (): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.masteryTimeline);
    return text ? deserializeMasteryTimelineState(text) : null;
  });

  ipcMain.handle('user-state:save-mastery-timeline', async (_e, file: unknown): Promise<void> => {
    await writeUserStateFile(USER_STATE_FILES.masteryTimeline, serializeMasteryTimelineState(file as never));
  });

  ipcMain.handle('user-state:get-root', async (): Promise<string> => getUserStateDir());

  ipcMain.handle('stt:status', (): { running: boolean } => ({
    running: sttProcess !== null && sttProcess.exitCode === null,
  }));
  ipcMain.handle('stt:get-port', (): number => sttPort);

  // ===== 资料文档 RAG（upload / list / status / retry / delete / search / choose） =====

  // 弹出文件选择框（多选，限定 txt/md/pdf），返回绝对路径数组
  ipcMain.handle('ragDocs:choose-files', async (): Promise<string[]> => {
    const res = await dialog.showOpenDialog({
      title: '选择资料文档（txt / md / pdf）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '支持的文档', extensions: ['txt', 'md', 'markdown', 'pdf'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return [];
    return res.filePaths;
  });

  // 上传：复制原始文件到 documents/，写 pending manifest，立即返回，后台入队
  ipcMain.handle('ragDocs:upload', async (_e, filePaths: unknown): Promise<{ ok: boolean; documents?: UploadedDocument[]; error?: string }> => {
    try {
      const paths = Array.isArray(filePaths) ? (filePaths as string[]).filter((p) => typeof p === 'string') : [];
      if (paths.length === 0) return { ok: false, error: '未选择文件' };

      const docsDir = await getDocumentsDir();
      const created: UploadedDocument[] = [];
      for (const src of paths) {
        const fileName = path.basename(src);
        const type = detectFileType(fileName);
        if (!type) {
          console.warn('[rag] 跳过不支持的格式:', fileName);
          continue;
        }
        const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const ext = path.extname(fileName).toLowerCase() || (type === 'md' ? '.md' : type === 'txt' ? '.txt' : '.pdf');
        const stored = storedFileName(id, ext);
        await fs.copyFile(src, path.join(docsDir, stored));

        const stat = await fs.stat(src);
        const doc: UploadedDocument = {
          id,
          fileName,
          fileType: type,
          size: stat.size,
          status: 'pending',
          chunkCount: 0,
          totalChars: 0,
          uploadAt: new Date().toISOString(),
        };
        created.push(doc);
      }

      if (created.length === 0) return { ok: false, error: '没有可上传的文档（仅支持 txt / md / pdf）' };

      const all = await upsertManifestEntries(created);
      created.forEach((d) => enqueueVectorization(d.id));
      notifyRagChanged();
      return { ok: true, documents: all };
    } catch (e: any) {
      return { ok: false, error: e?.message || '上传失败' };
    }
  });

  // 列表
  ipcMain.handle('ragDocs:list', async (): Promise<UploadedDocument[]> => readManifest());

  // 单文档状态
  ipcMain.handle('ragDocs:status', async (_e, docId: string) => {
    const docs = await readManifest();
    const d = docs.find((x) => x.id === docId);
    if (!d) return { status: 'failed' as const, chunkCount: 0, totalChars: 0, error: '文档不存在' };
    return { status: d.status, chunkCount: d.chunkCount, totalChars: d.totalChars, error: d.error };
  });

  // 重试失败文档
  ipcMain.handle('ragDocs:retry', async (_e, docId: string): Promise<void> => {
    await updateManifest(docId, { status: 'pending', error: undefined });
    enqueueVectorization(docId);
    notifyRagChanged();
  });

  // 删除：原始文件 + manifest + chunks
  ipcMain.handle('ragDocs:delete', async (_e, docId: string): Promise<void> => {
    const docs = await readManifest();
    const d = docs.find((x) => x.id === docId);
    if (d) {
      const ext = d.fileType === 'md' ? '.md' : d.fileType === 'txt' ? '.txt' : '.pdf';
      try {
        await fs.unlink(path.join(await getDocumentsDir(), storedFileName(docId, ext)));
      } catch {
        /* 原文件可能已不存在 */
      }
    }
    await deleteChunksFile(docId);
    await deleteManifestEntry(docId);
    notifyRagChanged();
  });

  // 检索（仅 ready 文档）
  ipcMain.handle('ragDocs:search', async (_e, query: string, k?: number): Promise<unknown[]> => {
    return searchDocuments(query, typeof k === 'number' ? k : 5);
  });

  // ===== 笔记本体 RAG（主进程中文模型 + 混合检索） =====
  ipcMain.handle('noteRag:index', async (_e, input: { id: string; title: string; content: string }): Promise<void> => {
    await noteRagIndexNote(input);
  });

  ipcMain.handle('noteRag:index-all', async (_e, inputs: Array<{ id: string; title: string; content: string }>): Promise<void> => {
    await noteRagIndexNotes(inputs);
  });

  ipcMain.handle('noteRag:delete', async (_e, noteId: string): Promise<void> => {
    await noteRagDeleteIndex(noteId);
  });

  ipcMain.handle('noteRag:search', async (_e, query: string, k?: number): Promise<unknown[]> => {
    return noteRagSearchNotes(query, typeof k === 'number' ? k : 5);
  });

  // ===== 软件更新（electron-updater，GitHub Releases） =====
  ipcMain.handle('updater:get-version', () => app.getVersion());

  ipcMain.handle('updater:check', async (): Promise<{ ok: boolean; message: string }> => {
    try {
      const result = await autoUpdater.checkForUpdates();
      return { ok: true, message: result?.updateInfo?.version ? `发现新版本 ${result.updateInfo.version}` : '已是最新版本' };
    } catch (e) {
      return { ok: false, message: (e as Error)?.message || '检查更新失败（尚未配置发布源）' };
    }
  });

  ipcMain.handle('updater:download', async (): Promise<{ ok: boolean; message: string }> => {
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true, message: '更新已开始下载' };
    } catch (e) {
      return { ok: false, message: (e as Error)?.message || '下载更新失败' };
    }
  });

  ipcMain.handle('updater:quit-and-install', () => {
    autoUpdater.quitAndInstall(false, true);
  });
}

/** 窗口控制（无边框标题栏）：最小化 / 最大化·还原 / 关闭 / 查询最大化状态 */
function registerWindowControls(): void {
  const winOf = (sender: Electron.WebContents): BrowserWindow | null =>
    BrowserWindow.fromWebContents(sender);

  ipcMain.on('window:minimize', (e) => {
    winOf(e.sender)?.minimize();
  });

  ipcMain.on('window:maximize-toggle', (e) => {
    const win = winOf(e.sender);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });

  ipcMain.on('window:close', (e) => {
    winOf(e.sender)?.close();
  });

  ipcMain.handle('window:is-maximized', (e): boolean => {
    return winOf(e.sender)?.isMaximized() ?? false;
  });

  ipcMain.handle('window:get-bounds', (e) => {
    const win = winOf(e.sender);
    return win ? win.getBounds() : null;
  });

  ipcMain.on('window:set-bounds', (e, bounds: { x: number; y: number; width: number; height: number }) => {
    const win = winOf(e.sender);
    if (!win || win.isMaximized()) return;
    win.setBounds(bounds);
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1000,
    minHeight: 620,
    frame: false,
    transparent: false,
    hasShadow: false,
    resizable: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist-electron', 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  // 最大化状态变化 → 推送渲染进程，用于切换还原图标、去除圆角与 10px 热区
  const pushMaximized = (): void => {
    if (!win.isDestroyed()) {
      win.webContents.send('window:maximized-changed', win.isMaximized());
    }
  };
  win.on('maximize', pushMaximized);
  win.on('unmaximize', pushMaximized);

  mainWindow = win;
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
}

/** 注册 autoUpdater 事件 → 推送渲染进程（设置面板「软件更新」卡片订阅） */
function registerUpdaterEvents(): void {
  const send = (payload: unknown) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('updater:status', payload);
    }
  };
  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-available', (info: any) => send({ state: 'available', version: info?.version }));
  autoUpdater.on('update-not-available', (info: any) => send({ state: 'up-to-date', version: info?.version }));
  autoUpdater.on('download-progress', (p: any) => send({ state: 'downloading', percent: p?.percent ?? 0 }));
  autoUpdater.on('update-downloaded', (info: any) => send({ state: 'downloaded', version: info?.version }));
  autoUpdater.on('error', (err: any) => send({ state: 'error', message: err?.message }));
}

app.whenReady().then(() => {
  setDataRoot(getDataRoot());
  setModelsDir(resolveModelsDir());
  setPdfExtractScript(app.isPackaged
    ? path.join(process.resourcesPath, 'python', 'pdf_extract.py')
    : path.join(app.getAppPath(), 'python', 'pdf_extract.py'));
  setNoteRagDataRoot(getDataRoot());
  void spawnSttServer();
  registerIpcHandlers();
  registerWindowControls();
  registerUpdaterEvents();
  recoverProcessingDocs();
  createWindow();
});

app.on('before-quit', () => {
  if (sttProcess) {
    try {
      sttProcess.kill();
    } catch {
      /* ignore */
    }
    sttProcess = null;
  }

  // 退出时自动清理心流资源 webview 分区的网页缓存（保留 Code Cache / GPU，避免缓存越积越多）
  try {
    const flowPartition = session.fromPartition('persist:flow-resource');
    flowPartition.clearCache().catch(() => {});
    flowPartition.clearStorageData().catch(() => {});
  } catch {
    /* ignore */
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});