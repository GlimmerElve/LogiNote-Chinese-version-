import { WebContentsView, session, type BrowserWindow, type IpcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import path from 'node:path';
import { validTextbookVisualKind, type TextbookVisualInput } from '../services/ui/textbookVisualTypes';

interface RenderInput extends TextbookVisualInput { requestId: string }
interface RenderResult { svg: string; readingWidth: number }
type Job = { key: string; owner: WebContents; input: RenderInput; sent?: boolean; resolve: (value: RenderResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; release: () => void };
const token = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{1,160}$/u.test(value);

/** An unattached WebContents with a private, non-persistent Session. It never
 * owns a native window or joins the main window's view/input tree. No note,
 * model, filesystem or application preload is exposed to the drawing runtime. */
export function createMermaidProcessHost(appRoot: string) {
  let worker: WebContentsView | undefined, ready = false, active: Job | undefined, disposed = false;
  const owned = new WeakSet<WebContents>(), jobs = new Map<string, Job>();
  const queue: Job[] = [];
  const drawingSession = session.fromPartition('loginote-mermaid-process');
  drawingSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  drawingSession.setPermissionCheckHandler(() => false);
  drawingSession.webRequest.onBeforeRequest((request, callback) => callback({ cancel: !request.url.startsWith('file:') }));
  const finish = (job: Job, error?: Error, result?: RenderResult) => {
    if (!jobs.delete(job.key)) return;
    clearTimeout(job.timer); job.release();
    const index = queue.indexOf(job); if (index >= 0) queue.splice(index, 1);
    if (active === job) active = undefined;
    if (error) job.reject(error); else job.resolve(result!);
  };
  const reset = () => {
    const previous = worker; worker = undefined; ready = false;
    if (previous && !previous.webContents.isDestroyed()) previous.webContents.close({ waitForBeforeUnload: false });
  };
  const failActive = (error: Error) => {
    const job = active; reset(); if (job) finish(job, error);
    pump();
  };
  const ensureWorker = () => {
    if (worker || disposed) return;
    const win = new WebContentsView({ webPreferences: { preload: path.join(appRoot, 'dist-electron', 'mermaid-preload.cjs'), session: drawingSession,
      nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false, spellcheck: false } });
    // Layout needs a bounded viewport, never a visible/focusable native window.
    // Deliberately do not add this view to any BrowserWindow.contentView.
    win.setBounds({ x: 0, y: 0, width: 960, height: 1000 });
    worker = win; owned.add(win.webContents);
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', event => event.preventDefault());
    win.webContents.on('will-attach-webview', event => event.preventDefault());
    win.webContents.on('render-process-gone', () => { if (worker === win) failActive(new Error('图示进程已停止，可重试加载；正文不受影响。')); });
    win.webContents.on('destroyed', () => { if (worker === win) failActive(new Error('图示进程已关闭，可重试加载。')); });
    void win.webContents.loadFile(path.join(appRoot, 'dist', 'mermaid-renderer.html')).catch(() => {
      if (worker === win) failActive(new Error('图示组件加载失败，请重试。'));
    });
  };
  function pump() {
    if (disposed) return;
    if (!active) active = queue.shift();
    if (!active) return;
    ensureWorker();
    if (!ready || !worker || worker.webContents.isDestroyed() || active.sent) return;
    // Refuse a shared renderer instead of pretending DOM isolation is a thread.
    if (worker.webContents.getOSProcessId() === active.owner.getOSProcessId()) {
      failActive(new Error('未能隔离图示进程，已跳过图示以保持页面可操作。')); return;
    }
    active.sent = true;
    worker.webContents.send('mermaid-worker:task', active.input);
  }
  return {
    owns: (window: BrowserWindow) => owned.has(window.webContents),
    register(ipcMain: IpcMain, trusted: (event: IpcMainInvokeEvent) => boolean) {
      ipcMain.handle('mermaid:render', (event, input: RenderInput) => {
        if (!trusted(event) || disposed) throw new Error('图示请求不可用');
        if (!input || !token(input.requestId) || !token(input.id) || typeof input.code !== 'string'
          || !validTextbookVisualKind(input.visualKind) || input.code.length > (input.visualKind && input.visualKind !== 'mermaid' ? 32_000 : 8_000)
          || input.width !== undefined && (!Number.isFinite(input.width) || input.width < 260 || input.width > 1000)
          || typeof input.dark !== 'boolean') throw new Error('图示请求无效');
        const key = `${event.sender.id}:${input.requestId}`;
        if (jobs.has(key) || jobs.size >= 16) throw new Error('图示任务正在处理，请稍后重试');
        return new Promise<RenderResult>((resolve, reject) => {
          const job: Job = { key, owner: event.sender, input, resolve, reject, timer: undefined!, release: () => {} };
          const cancel = () => {
            if (!jobs.has(key)) return;
            if (active === job) reset();
            finish(job, new Error('图示任务已取消')); pump();
          };
          event.sender.once('destroyed', cancel); event.sender.once('render-process-gone', cancel);
          job.release = () => { event.sender.removeListener('destroyed', cancel); event.sender.removeListener('render-process-gone', cancel); };
          job.timer = setTimeout(() => {
            if (active === job) reset();
            finish(job, new Error('图示加载超时，已保留源码；可重试加载图示。')); pump();
          }, 14000);
          jobs.set(key, job); queue.push(job); pump();
        });
      });
      ipcMain.on('mermaid:cancel', (event, requestId: unknown) => {
        if (!token(requestId)) return;
        const job = jobs.get(`${event.sender.id}:${requestId}`); if (!job) return;
        if (active === job) reset(); finish(job, new Error('图示任务已取消')); pump();
      });
      ipcMain.on('mermaid-worker:ready', event => {
        if (!worker || event.sender !== worker.webContents || event.senderFrame !== event.sender.mainFrame || ready) return;
        ready = true; pump();
      });
      ipcMain.on('mermaid-worker:reply', (event, value: RenderInput & RenderResult & { error?: string }) => {
        if (!worker || event.sender !== worker.webContents || event.senderFrame !== event.sender.mainFrame || !active || value?.requestId !== active.input.requestId) return;
        if (typeof value.error === 'string') { finish(active, new Error(value.error.slice(0, 500))); pump(); return; }
        if (typeof value.svg !== 'string' || value.svg.length > 1000000 || !Number.isFinite(value.readingWidth) || value.readingWidth < 1 || value.readingWidth > 4096) { failActive(new Error('图示返回结果无效')); return; }
        finish(active, undefined, { svg: value.svg, readingWidth: value.readingWidth }); pump();
      });
    },
    dispose() {
      disposed = true; reset();
      for (const job of [...jobs.values()]) finish(job, new Error('图示任务已停止'));
    },
  };
}
