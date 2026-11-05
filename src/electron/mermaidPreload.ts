import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('logiMermaidWorker', {
  onTask: (callback: (input: import('../services/ui/textbookVisualTypes').TextbookVisualInput & { requestId: string }) => void) => {
    const receive = (_event: Electron.IpcRendererEvent, input: Parameters<typeof callback>[0]) => callback(input);
    ipcRenderer.on('mermaid-worker:task', receive);
    return () => ipcRenderer.removeListener('mermaid-worker:task', receive);
  },
  ready: () => ipcRenderer.send('mermaid-worker:ready'),
  reply: (result: unknown) => ipcRenderer.send('mermaid-worker:reply', result),
});
