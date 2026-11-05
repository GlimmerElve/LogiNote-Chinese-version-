/** Relay only acknowledges a write after the main renderer has persisted it. */
interface Sender {
  isDestroyed(): boolean;
  send(channel: string, payload: unknown): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  removeListener(event: string, listener: (...args: any[]) => void): unknown;
}
export interface ArgumentWriteResult { ok: boolean; error?: string }

export function createArgumentEditorPersistence() {
  let pending: { id: string; editor: Sender; target: Sender; finish: (result: ArgumentWriteResult) => void } | null = null;
  let sequence = 0;
  return {
    busy: () => pending !== null,
    request(editor: Sender, target: Sender, channel: string, payload: unknown): Promise<ArgumentWriteResult> {
      if (pending) return Promise.resolve({ ok: false, error: '正在保存或删除，请等待当前操作完成。' });
      if (target.isDestroyed() || editor.isDestroyed()) return Promise.resolve({ ok: false, error: '主窗口不可用，内容仍保留在编辑器中。' });
      return new Promise((resolve) => {
        const id = `argument-write-${Date.now()}-${++sequence}`;
        const interrupted = () => finish({ ok: false, error: '保存回执中断，可能已经写入。编辑内容仍保留，请核对原笔记后重试。' });
        const navigated = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => {
          if (mainFrame && !inPlace) interrupted();
        };
        const finish = (result: ArgumentWriteResult) => {
          if (pending?.id !== id) return;
          pending = null;
          for (const sender of [editor, target]) {
            sender.removeListener('destroyed', interrupted);
            sender.removeListener('render-process-gone', interrupted);
            sender.removeListener('did-start-navigation', navigated);
          }
          resolve(result);
        };
        pending = { id, editor, target, finish };
        for (const sender of [editor, target]) {
          sender.on('destroyed', interrupted);
          sender.on('render-process-gone', interrupted);
          sender.on('did-start-navigation', navigated);
        }
        try { target.send(channel, { ...(payload as object), requestId: id }); }
        catch { interrupted(); }
      });
    },
    acknowledge(sender: Sender, raw: unknown): boolean {
      const reply = raw as { requestId?: unknown; ok?: unknown; error?: unknown } | null;
      if (!pending || sender !== pending.target || reply?.requestId !== pending.id || typeof reply.ok !== 'boolean') return false;
      pending.finish({ ok: reply.ok, error: typeof reply.error === 'string' ? reply.error.slice(0, 1000) : undefined });
      return true;
    },
  };
}
