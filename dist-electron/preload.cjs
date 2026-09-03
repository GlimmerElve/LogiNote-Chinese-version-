// src/electron/preload.ts
var import_electron = require("electron");
import_electron.contextBridge.exposeInMainWorld("electronAPI", {
  isElectron: true,
  platform: "electron",
  openExternal: (url) => import_electron.ipcRenderer.invoke("open-external", url),
  openDataFolder: () => import_electron.ipcRenderer.invoke("data:open-folder"),
  analysis: {
    exportReport: (content, fileName) => import_electron.ipcRenderer.invoke("analysis:export", content, fileName)
  },
  llm: {
    request: (req) => import_electron.ipcRenderer.invoke("llm:request", req),
    probe: (req) => import_electron.ipcRenderer.invoke("llm:probe", req),
    stream: (req) => import_electron.ipcRenderer.invoke("llm:stream-start", req),
    onChunk: (callback) => {
      const handler = (_e, payload) => callback(payload);
      import_electron.ipcRenderer.on("llm:stream-chunk", handler);
      return () => import_electron.ipcRenderer.removeListener("llm:stream-chunk", handler);
    },
    onEnd: (callback) => {
      const handler = (_e, payload) => callback(payload);
      import_electron.ipcRenderer.on("llm:stream-end", handler);
      return () => import_electron.ipcRenderer.removeListener("llm:stream-end", handler);
    },
    onError: (callback) => {
      const handler = (_e, payload) => callback(payload);
      import_electron.ipcRenderer.on("llm:stream-error", handler);
      return () => import_electron.ipcRenderer.removeListener("llm:stream-error", handler);
    }
  },
  ai: {
    segment: (req) => import_electron.ipcRenderer.invoke("ai:segment", req),
    autoLink: (req) => import_electron.ipcRenderer.invoke("ai:auto-link", req),
    resourceSearch: (req) => import_electron.ipcRenderer.invoke("ai:resource-search", req),
    conceptGeneration: (req) => import_electron.ipcRenderer.invoke("ai:concept-generation", req)
  },
  chooseLocalFiles: () => import_electron.ipcRenderer.invoke("resource:choose-local-files"),
  storage: {
    getRoot: () => import_electron.ipcRenderer.invoke("storage:get-root"),
    chooseFolder: () => import_electron.ipcRenderer.invoke("storage:choose-folder"),
    setRoot: (root, migrate) => import_electron.ipcRenderer.invoke("storage:set-root", root, migrate),
    reset: () => import_electron.ipcRenderer.invoke("storage:reset")
  },
  vault: {
    loadVault: () => import_electron.ipcRenderer.invoke("vault:load"),
    saveVault: (notes) => import_electron.ipcRenderer.invoke("vault:save", notes),
    getVaultRoot: () => import_electron.ipcRenderer.invoke("vault:get-root")
  },
  userState: {
    loadProfile: () => import_electron.ipcRenderer.invoke("user-state:load-profile"),
    saveProfile: (profile, conceptAliasMap) => import_electron.ipcRenderer.invoke("user-state:save-profile", profile, conceptAliasMap),
    loadSettings: () => import_electron.ipcRenderer.invoke("user-state:load-settings"),
    saveSettings: (settings) => import_electron.ipcRenderer.invoke("user-state:save-settings", settings),
    loadLlm: () => import_electron.ipcRenderer.invoke("user-state:load-llm"),
    saveLlm: (settings) => import_electron.ipcRenderer.invoke("user-state:save-llm", settings),
    loadMasteryTimeline: () => import_electron.ipcRenderer.invoke("user-state:load-mastery-timeline"),
    saveMasteryTimeline: (file) => import_electron.ipcRenderer.invoke("user-state:save-mastery-timeline", file),
    getRoot: () => import_electron.ipcRenderer.invoke("user-state:get-root")
  },
  stt: {
    getStatus: () => import_electron.ipcRenderer.invoke("stt:status"),
    getPort: () => import_electron.ipcRenderer.invoke("stt:get-port")
  },
  ragDocs: {
    chooseFiles: () => import_electron.ipcRenderer.invoke("ragDocs:choose-files"),
    upload: (filePaths) => import_electron.ipcRenderer.invoke("ragDocs:upload", filePaths),
    list: () => import_electron.ipcRenderer.invoke("ragDocs:list"),
    getStatus: (docId) => import_electron.ipcRenderer.invoke("ragDocs:status", docId),
    retry: (docId) => import_electron.ipcRenderer.invoke("ragDocs:retry", docId),
    delete: (docId) => import_electron.ipcRenderer.invoke("ragDocs:delete", docId),
    search: (query, k) => import_electron.ipcRenderer.invoke("ragDocs:search", query, k),
    onChanged: (callback) => {
      const handler = () => callback();
      import_electron.ipcRenderer.on("rag-docs:changed", handler);
      return () => import_electron.ipcRenderer.removeListener("rag-docs:changed", handler);
    }
  },
  noteRag: {
    index: (input) => import_electron.ipcRenderer.invoke("noteRag:index", input),
    indexAll: (inputs) => import_electron.ipcRenderer.invoke("noteRag:index-all", inputs),
    delete: (noteId) => import_electron.ipcRenderer.invoke("noteRag:delete", noteId),
    search: (query, k) => import_electron.ipcRenderer.invoke("noteRag:search", query, k)
  },
  updater: {
    getVersion: () => import_electron.ipcRenderer.invoke("updater:get-version"),
    check: () => import_electron.ipcRenderer.invoke("updater:check"),
    download: () => import_electron.ipcRenderer.invoke("updater:download"),
    quitAndInstall: () => import_electron.ipcRenderer.invoke("updater:quit-and-install"),
    onStatus: (callback) => {
      const handler = (_e, payload) => callback(payload);
      import_electron.ipcRenderer.on("updater:status", handler);
      return () => import_electron.ipcRenderer.removeListener("updater:status", handler);
    }
  },
  windowControls: {
    minimize: () => import_electron.ipcRenderer.send("window:minimize"),
    toggleMaximize: () => import_electron.ipcRenderer.send("window:maximize-toggle"),
    close: () => import_electron.ipcRenderer.send("window:close"),
    isMaximized: () => import_electron.ipcRenderer.invoke("window:is-maximized"),
    onMaximizedChange: (callback) => {
      const handler = (_e, maximized) => callback(maximized);
      import_electron.ipcRenderer.on("window:maximized-changed", handler);
      return () => import_electron.ipcRenderer.removeListener("window:maximized-changed", handler);
    },
    getBounds: () => import_electron.ipcRenderer.invoke("window:get-bounds"),
    setBounds: (bounds) => import_electron.ipcRenderer.send("window:set-bounds", bounds)
  }
});
