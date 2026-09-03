export {};

/** Electron 主进程暴露的 vault 文件系统能力 */
interface ElectronVaultApi {
  /** 读取整个 vault（metadata.json + notes/*.md 合并为 NoteItem[]） */
  loadVault(): Promise<unknown[]>;
  /** 保存整个 vault（写 metadata.json + 分别写/删除 notes/*.md） */
  saveVault(notes: unknown[]): Promise<void>;
  /** 返回 vault 根目录绝对路径 */
  getVaultRoot(): Promise<string>;
}

/** Electron 主进程暴露的 STT 后端状态能力 */
interface ElectronSttApi {
  getStatus(): Promise<{ running: boolean; error?: string }>;
  getPort(): Promise<number>;
}

/** Electron 主进程暴露的 user-state 个人数据读写能力 */
interface ElectronUserStateApi {
  loadProfile(): Promise<unknown>;
  saveProfile(profile: unknown, conceptAliasMap: unknown): Promise<void>;
  loadSettings(): Promise<unknown>;
  saveSettings(settings: unknown): Promise<void>;
  loadLlm(): Promise<unknown>;
  saveLlm(settings: unknown): Promise<void>;
  loadMasteryTimeline(): Promise<unknown>;
  saveMasteryTimeline(file: unknown): Promise<void>;
  getRoot(): Promise<string>;
}

/** Electron 主进程暴露的资料文档 RAG 能力 */
interface ElectronRagDocsApi {
  /** 弹出文件选择框（多选 txt/md/pdf），返回绝对路径数组；取消返回 [] */
  chooseFiles(): Promise<string[]>;
  /** 上传资料文档，返回上传结果 */
  upload(filePaths: string[]): Promise<{ ok: boolean; documents?: unknown[]; error?: string }>;
  /** 列出全部资料文档元数据 */
  list(): Promise<unknown[]>;
  /** 查询单文档向量化状态 */
  getStatus(docId: string): Promise<{ status: string; chunkCount: number; totalChars: number; error?: string }>;
  /** 重试失败文档 */
  retry(docId: string): Promise<void>;
  /** 删除文档及其向量分块 */
  delete(docId: string): Promise<void>;
  /** 检索资料文档（仅 ready） */
  search(query: string, k?: number): Promise<unknown[]>;
  /** 订阅资料变化，返回取消订阅函数 */
  onChanged(callback: () => void): () => void;
}

/** Electron 主进程暴露的 LLM 转发能力 */
interface ElectronLlmApi {
  request(req: unknown): Promise<unknown>;
  probe(req: unknown): Promise<boolean>;
  stream(req: unknown): Promise<string>;
  onChunk(callback: (payload: { streamId: string; chunk: unknown }) => void): () => void;
  onEnd(callback: (payload: { streamId: string }) => void): () => void;
  onError(callback: (payload: { streamId: string; message: string }) => void): () => void;
}

/** Electron 主进程暴露的 AI 服务能力 */
interface ElectronAiApi {
  segment(req: unknown): Promise<unknown>;
  autoLink(req: unknown): Promise<{ updatedContent: string; addedLinks: string[] }>;
  resourceSearch(req: unknown): Promise<{ markdown: string; resources: unknown[] }>;
  conceptGeneration(req: unknown): Promise<{ content: string }>;
}

/** Electron 主进程暴露的软件更新能力 */
interface ElectronUpdaterApi {
  getVersion(): Promise<string>;
  check(): Promise<{ ok: boolean; message: string }>;
  download(): Promise<{ ok: boolean; message: string }>;
  quitAndInstall(): void;
  onStatus(callback: (payload: unknown) => void): () => void;
}

/** Electron 主进程暴露的笔记本体 RAG 能力 */
interface ElectronNoteRagApi {
  /** 索引/更新单篇笔记向量 */
  index(input: { id: string; title: string; content: string }): Promise<void>;
  /** 批量索引（全量重建） */
  indexAll(inputs: Array<{ id: string; title: string; content: string }>): Promise<void>;
  /** 删除单篇笔记向量 */
  delete(noteId: string): Promise<void>;
  /** 混合检索笔记（中文模型 + BM25 + 加权融合） */
  search(query: string, k?: number): Promise<Array<{ noteId: string; title: string; score: number; snippet: string }>>;
}

/** Electron 主进程暴露的心流分析导出能力 */
interface ElectronAnalysisApi {
  /** 将 Markdown 内容导出到用户指定目录下的 AnalysisResult 文件夹 */
  exportReport(content: string, fileName: string): Promise<{ ok: boolean; path?: string; error?: string }>;
}

/** Electron 无边框窗口控制能力 */
interface ElectronWindowControlsApi {
  /** 最小化当前窗口 */
  minimize(): void;
  /** 最大化/还原切换 */
  toggleMaximize(): void;
  /** 关闭当前窗口 */
  close(): void;
  /** 查询当前窗口是否最大化 */
  isMaximized(): Promise<boolean>;
  /** 订阅最大化状态变化，返回取消订阅函数 */
  onMaximizedChange(callback: (maximized: boolean) => void): () => void;
  /** 获取窗口当前边界（屏幕坐标 + 尺寸），用于边缘缩放热区 */
  getBounds(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  /** 设置窗口边界（手动边缘缩放） */
  setBounds(bounds: { x: number; y: number; width: number; height: number }): void;
}

interface ElectronApi {
  isElectron: boolean;
  platform: 'electron' | 'web';
  /** 用系统默认浏览器打开外部链接 */
  openExternal(url: string): Promise<void>;
  /** 打开数据目录（vault/ 与 user-state/ 的父级），作为导出/备份入口 */
  openDataFolder(): Promise<{ ok: boolean; error?: string }>;
  /** 弹出系统文件选择框，选择本地学习资源（多选），返回绝对路径数组；取消返回 [] */
  chooseLocalFiles(): Promise<string[]>;
  storage: {
    getRoot(): Promise<{ root: string; custom: boolean }>;
    chooseFolder(): Promise<string | null>;
    setRoot(root: string, migrate: boolean): Promise<{ ok: boolean; error?: string }>;
    reset(): Promise<{ ok: boolean; error?: string }>;
  };
  vault?: ElectronVaultApi;
  userState?: ElectronUserStateApi;
  analysis?: ElectronAnalysisApi;
  llm?: ElectronLlmApi;
  ai?: ElectronAiApi;
  stt?: ElectronSttApi;
  ragDocs?: ElectronRagDocsApi;
  noteRag?: ElectronNoteRagApi;
  updater?: ElectronUpdaterApi;
  windowControls?: ElectronWindowControlsApi;
}

interface Window {
  electronAPI?: ElectronApi;
}