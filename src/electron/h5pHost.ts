import { BrowserWindow, dialog, session, type IpcMain, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createH5pStore } from './h5pStore';
import { H5P_LIMITS } from './h5pPackage';
import { startH5pServer } from './h5pServer';
import { normalizeH5pAppearance, type H5pAppearance } from './h5pAppearance';

export function h5pWindowPreferences(partition: string) {
  return { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false,
    navigateOnDragDrop: false, devTools: false };
}
export function h5pRequestAllowed(url: string, base: string) {
  return url.startsWith(base) || url === 'about:blank' || /^(?:data|blob):/u.test(url);
}
function bounded<T>(operation: Promise<T>, timeout = 4000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('H5P 进度保存超时')), timeout); })])
    .finally(() => clearTimeout(timer));
}

/** H5P never shares the main renderer's preload, origin, cookies or IPC identity. */
export function registerH5pHost(ipc: Pick<IpcMain, 'handle'>, options: {
  root: () => string; assets: string; parent: () => BrowserWindow | null;
  styles?: string; appearance?: () => Promise<H5pAppearance>;
  allowed: (event: IpcMainInvokeEvent) => boolean; current: () => string;
  /** Isolated native acceptance only; production defaults to visible. */
  visible?: boolean;
}) {
  let pendingImport = false, pendingOpen = false, stopping = false;
  let pendingReads = 0;
  let pendingRecovery = false;
  let appearanceRevision = 0;
  const stores = new Map<string, ReturnType<typeof createH5pStore>>();
  const windows = new Map<string, { window: BrowserWindow; checkpoint: () => Promise<void>; close: () => Promise<void>; setAppearance: (value: H5pAppearance) => void }>();
  const store = () => {
    const root = options.root();
    if (!stores.has(root)) stores.set(root, createH5pStore(root));
    return stores.get(root)!;
  };
  const allowed = (event: IpcMainInvokeEvent) => {
    if (stopping || !options.allowed(event)) throw new Error('当前窗口或应用状态不允许操作 H5P');
  };
  ipc.handle('h5p:list', async event => {
    allowed(event); pendingReads++;
    try { return await store().list(); } finally { pendingReads--; }
  });
  ipc.handle('h5p:restart', async (event, id: unknown) => {
    allowed(event);
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw new Error('H5P 包编号无效');
    if (pendingRecovery || pendingOpen || windows.has(id)) throw new Error('请先关闭此 H5P 场景或等待当前操作完成');
    pendingRecovery = true;
    const root = options.root(), epoch = options.current(), target = store();
    const current = () => !stopping && options.allowed(event) && options.root() === root && options.current() === epoch && !windows.has(id);
    try {
      const { descriptor } = await target.load(id);
      const result = await dialog.showMessageBox(options.parent()!, { type: 'warning', title: '备份并重新开始',
        message: `备份“${descriptor.title}”的当前进度并从头开始？`,
        detail: '原进度（包括损坏记录）会原样移到 user-state/h5p/backups/，不会永久删除。场景包和其他场景进度不变。',
        buttons: ['取消', '备份并重新开始'], defaultId: 0, cancelId: 0, noLink: true });
      if (result.response !== 1) return { canceled: true };
      if (!current()) throw new Error('应用或存储状态已变化，未重置进度');
      return await target.restartProgress(id, current);
    } finally { pendingRecovery = false; }
  });
  ipc.handle('h5p:import', async event => {
    allowed(event);
    if (pendingImport) throw new Error('H5P 正在导入，请稍后重试');
    pendingImport = true;
    const root = options.root(), identity = options.current(), target = store();
    const current = () => !stopping && options.allowed(event) && options.root() === root && options.current() === identity;
    try {
      const picked = await dialog.showOpenDialog(options.parent()!, { title: '导入 H5P 场景包', properties: ['openFile'], filters: [{ name: 'H5P 场景包', extensions: ['h5p'] }] });
      if (picked.canceled || !picked.filePaths[0]) return { canceled: true };
      const file = picked.filePaths[0], info = await fs.lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > H5P_LIMITS.archive) throw new Error('请选取 128 MB 以内的普通 H5P 文件');
      const confirm = await dialog.showMessageBox(options.parent()!, { type: 'warning', title: '导入第三方 H5P 场景',
        message: '仅导入你信任来源的场景包',
        detail: 'H5P 依赖含 JavaScript，会在隔离窗口运行。程序会检查包结构和依赖，但不会审计场景代码的教学质量或安全性。\n本阶段禁止外网请求，不读取笔记、认知库或模型密钥。进度和得分仅是场景自身报告，不写入掌握度。\n不会自动下载缺失依赖；带外链视频或其他联网能力的内容可能无法运行。',
        buttons: ['取消', '信任来源并导入'], defaultId: 0, cancelId: 0, noLink: true });
      if (confirm.response !== 1) return { canceled: true };
      if (!current()) throw new Error('存储或应用状态已变化，请重新导入');
      // Read only the one native-selected file. There is no arbitrary path IPC.
      const handle = await fs.open(file, 'r');
      let bytes: Buffer;
      try {
        const selected = await handle.stat();
        if (!selected.isFile() || selected.size !== info.size || selected.mtimeMs !== info.mtimeMs || selected.size > H5P_LIMITS.archive) throw new Error('所选文件已变化，请重新选择');
        bytes = Buffer.alloc(selected.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) throw new Error('文件读取不完整'); offset += read.bytesRead;
        }
        const after = await handle.stat();
        if (after.size !== selected.size || after.mtimeMs !== selected.mtimeMs) throw new Error('所选文件读取期间已变化');
      } finally { await handle.close(); }
      return { package: await target.importBytes(bytes, current) };
    } finally { pendingImport = false; }
  });
  ipc.handle('h5p:open', async (event, id: unknown) => {
    allowed(event);
    if (typeof id !== 'string' || !/^[a-f0-9]{64}$/u.test(id)) throw new Error('H5P 包编号无效');
    const existing = windows.get(id);
    if (existing) { if (options.visible !== false) { existing.window.show(); existing.window.focus(); } return {}; }
    if (pendingOpen || pendingRecovery || windows.size >= 2) throw new Error('请等待场景打开或先关闭其他 H5P 场景');
    pendingOpen = true;
    const root = options.root(), epoch = options.current(), target = store();
    let service: Awaited<ReturnType<typeof startH5pServer>> | undefined;
    let window: BrowserWindow | undefined;
    try {
      const { archive, files, descriptor } = await target.load(id);
      if (descriptor.missing.length) throw new Error(`缺少兼容依赖，未运行：${descriptor.missing.join('、')}`);
      await fs.access(path.join(options.assets, 'main.bundle.js'));
      const progress = await target.progress(id);
      if (stopping || !options.allowed(event) || options.root() !== root || options.current() !== epoch) throw new Error('存储或应用状态已变化，请重新打开');
      const appearance = options.appearance ? await bounded(options.appearance(), 1500).catch(() => undefined) : undefined;
      if (stopping || options.root() !== root || options.current() !== epoch) throw new Error('应用状态已变化，请重新打开');
      service = await startH5pServer({ archive, files, assets: options.assets, styles: options.styles, appearance, progress,
        readProgress: () => target.progress(id), save: input => target.saveProgress(id, input) });
      const partition = `h5p-local-${randomUUID()}`, sandboxSession = session.fromPartition(partition, { cache: false });
      sandboxSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      sandboxSession.setPermissionCheckHandler(() => false);
      sandboxSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !h5pRequestAllowed(details.url, service!.url) }));
      sandboxSession.on('will-download', event => event.preventDefault());
      window = new BrowserWindow({ width: 1100, height: 800, minWidth: 480, minHeight: 400, show: false,
        backgroundColor: appearance?.theme === 'dark' ? '#171c18' : '#fbf8f1',
        title: `${descriptor.title} · H5P`, webPreferences: h5pWindowPreferences(partition) });
      const win = window, server = service;
      win.webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
      win.setMenu(null); win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-attach-webview', event => event.preventDefault());
      const navigation = (event: Electron.Event, url: string) => { if (url.split('#')[0] !== server.url) event.preventDefault(); };
      win.webContents.on('will-navigate', navigation); win.webContents.on('will-redirect', navigation);
      let closed = false, closing: Promise<void> | undefined;
      const checkpoint = () => bounded((async () => {
        if (win.isDestroyed() || win.webContents.isDestroyed()) return;
        await win.webContents.executeJavaScript('Promise.resolve(window.logiH5pCheckpoint?.())', true);
        await target.flush(id);
      })());
      const close = (confirmFailure = false) => {
        // Save, timeout and the native decision are one operation. Both repeated
        // close events and application shutdown join it, including its dialog.
        if (closing) return closing;
        closing = Promise.resolve().then(checkpoint).catch(async error => {
          if (win.isDestroyed()) return;
          if (!confirmFailure) throw error;
          const result = await dialog.showMessageBox(win, { type: 'warning', title: 'H5P 进度尚未保存',
            message: '保存失败或超时，是否放弃本次未保存进度并关闭？', detail: '此前已保存进度保留，可返回场景重试保存。',
            buttons: ['返回重试', '放弃未保存进度并关闭'], defaultId: 0, cancelId: 0, noLink: true });
          if (win.isDestroyed()) return;
          if (result.response !== 1) throw error;
          target.acknowledgeSaveFailure(id);
        }).then(() => { if (!win.isDestroyed()) { closed = true; win.destroy(); } })
          .finally(() => { closing = undefined; });
        return closing;
      };
      win.on('close', event => {
        if (closed) return;
        event.preventDefault();
        void close(true).catch(() => {}); // Cancellation retains the window; the next close may retry.
      });
      win.on('closed', () => { windows.delete(id); void server.close(); void sandboxSession.clearStorageData().catch(() => {}); });
      windows.set(id, { window: win, checkpoint, close, setAppearance: server.setAppearance });
      await win.loadURL(server.url); if (options.visible !== false) win.show();
      return {};
    } catch (error) {
      if (window && !window.isDestroyed()) window.destroy();
      await service?.close(); throw error;
    } finally { pendingOpen = false; }
  });
  return {
    async updateAppearance() {
      if (stopping || !options.appearance) return;
      const revision = ++appearanceRevision;
      const appearance = await bounded(options.appearance(), 1500);
      if (revision !== appearanceRevision || stopping) return;
      const safe = normalizeH5pAppearance(appearance.theme, appearance.tokens);
      await Promise.all([...windows.values()].map(async ({ window, setAppearance }) => {
        setAppearance(safe);
        if (!window.isDestroyed() && !window.webContents.isDestroyed())
          await window.webContents.executeJavaScript(`window.logiH5pAppearance?.(${JSON.stringify(safe).replace(/</gu, '\\u003c')})`).catch(() => {});
      }));
    },
    busy: () => pendingImport || pendingOpen || pendingRecovery || pendingReads > 0 || [...stores.values()].some(value => value.busy()),
    hasWindows: () => windows.size > 0,
    async shutdown() {
      stopping = true;
      await Promise.all([...windows.values()].map(value => value.close()));
      await Promise.all([...stores.values()].map(value => value.flush()));
    },
    forceClose() { stopping = true; for (const value of windows.values()) value.window.destroy(); },
  };
}
