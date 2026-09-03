import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: 'electron',
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  openDataFolder: () => ipcRenderer.invoke('data:open-folder'),
  analysis: {
    exportReport: (content: string, fileName: string) => ipcRenderer.invoke('analysis:export', content, fileName),
  },
  llm: {
    request: (req: unknown) => ipcRenderer.invoke('llm:request', req),
    probe: (req: unknown) => ipcRenderer.invoke('llm:probe', req),
    stream: (req: unknown) => ipcRenderer.invoke('llm:stream-start', req),
    onChunk: (callback: (payload: { streamId: string; chunk: unknown }) => void) => {
      const handler = (_e: unknown, payload: { streamId: string; chunk: unknown }) => callback(payload);
      ipcRenderer.on('llm:stream-chunk', handler);
      return () => ipcRenderer.removeListener('llm:stream-chunk', handler);
    },
    onEnd: (callback: (payload: { streamId: string }) => void) => {
      const handler = (_e: unknown, payload: { streamId: string }) => callback(payload);
      ipcRenderer.on('llm:stream-end', handler);
      return () => ipcRenderer.removeListener('llm:stream-end', handler);
    },
    onError: (callback: (payload: { streamId: string; message: string }) => void) => {
      const handler = (_e: unknown, payload: { streamId: string; message: string }) => callback(payload);
      ipcRenderer.on('llm:stream-error', handler);
      return () => ipcRenderer.removeListener('llm:stream-error', handler);
    },
  },
  ai: {
    segment: (req: unknown) => ipcRenderer.invoke('ai:segment', req),
    autoLink: (req: unknown) => ipcRenderer.invoke('ai:auto-link', req),
    resourceSearch: (req: unknown) => ipcRenderer.invoke('ai:resource-search', req),
    conceptGeneration: (req: unknown) => ipcRenderer.invoke('ai:concept-generation', req),
  },
  chooseLocalFiles: () => ipcRenderer.invoke('resource:choose-local-files'),
  storage: {
    getRoot: () => ipcRenderer.invoke('storage:get-root'),
    chooseFolder: () => ipcRenderer.invoke('storage:choose-folder'),
    setRoot: (root: string, migrate: boolean) => ipcRenderer.invoke('storage:set-root', root, migrate),
    reset: () => ipcRenderer.invoke('storage:reset'),
  },
  vault: {
    loadVault: () => ipcRenderer.invoke('vault:load'),
    saveVault: (notes: unknown[]) => ipcRenderer.invoke('vault:save', notes),
    getVaultRoot: () => ipcRenderer.invoke('vault:get-root'),
  },
  userState: {
    loadProfile: () => ipcRenderer.invoke('user-state:load-profile'),
    saveProfile: (profile: unknown, conceptAliasMap: unknown) => ipcRenderer.invoke('user-state:save-profile', profile, conceptAliasMap),
    loadSettings: () => ipcRenderer.invoke('user-state:load-settings'),
    saveSettings: (settings: unknown) => ipcRenderer.invoke('user-state:save-settings', settings),
    loadLlm: () => ipcRenderer.invoke('user-state:load-llm'),
    saveLlm: (settings: unknown) => ipcRenderer.invoke('user-state:save-llm', settings),
    loadMasteryTimeline: () => ipcRenderer.invoke('user-state:load-mastery-timeline'),
    saveMasteryTimeline: (file: unknown) => ipcRenderer.invoke('user-state:save-mastery-timeline', file),
    getRoot: () => ipcRenderer.invoke('user-state:get-root'),
  },
  stt: {
    getStatus: () => ipcRenderer.invoke('stt:status'),
    getPort: () => ipcRenderer.invoke('stt:get-port'),
  },
  ragDocs: {
    chooseFiles: () => ipcRenderer.invoke('ragDocs:choose-files'),
    upload: (filePaths: string[]) => ipcRenderer.invoke('ragDocs:upload', filePaths),
    list: () => ipcRenderer.invoke('ragDocs:list'),
    getStatus: (docId: string) => ipcRenderer.invoke('ragDocs:status', docId),
    retry: (docId: string) => ipcRenderer.invoke('ragDocs:retry', docId),
    delete: (docId: string) => ipcRenderer.invoke('ragDocs:delete', docId),
    search: (query: string, k?: number) => ipcRenderer.invoke('ragDocs:search', query, k),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('rag-docs:changed', handler);
      return () => ipcRenderer.removeListener('rag-docs:changed', handler);
    },
  },
  noteRag: {
    index: (input: { id: string; title: string; content: string }) => ipcRenderer.invoke('noteRag:index', input),
    indexAll: (inputs: Array<{ id: string; title: string; content: string }>) => ipcRenderer.invoke('noteRag:index-all', inputs),
    delete: (noteId: string) => ipcRenderer.invoke('noteRag:delete', noteId),
    search: (query: string, k?: number) => ipcRenderer.invoke('noteRag:search', query, k),
  },
  updater: {
    getVersion: () => ipcRenderer.invoke('updater:get-version'),
    check: () => ipcRenderer.invoke('updater:check'),
    download: () => ipcRenderer.invoke('updater:download'),
    quitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),
    onStatus: (callback: (payload: unknown) => void) => {
      const handler = (_e: unknown, payload: unknown) => callback(payload);
      ipcRenderer.on('updater:status', handler);
      return () => ipcRenderer.removeListener('updater:status', handler);
    },
  },
  windowControls: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:maximize-toggle'),
    close: () => ipcRenderer.send('window:close'),
    isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
    onMaximizedChange: (callback: (maximized: boolean) => void) => {
      const handler = (_e: unknown, maximized: boolean) => callback(maximized);
      ipcRenderer.on('window:maximized-changed', handler);
      return () => ipcRenderer.removeListener('window:maximized-changed', handler);
    },
    getBounds: () => ipcRenderer.invoke('window:get-bounds'),
    setBounds: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.send('window:set-bounds', bounds),
  },
});
