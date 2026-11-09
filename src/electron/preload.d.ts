export {};

/** Electron 主进程暴露的 vault 文件系统能力 */
interface ElectronVaultApi {
  /** 读取整个 vault（metadata.json + notes/*.md 合并为 NoteItem[]） */
  loadVault(): Promise<unknown[]>;
  /** 保存整个快照，仅写变化文件；未引用的 Markdown 保留为可恢复原文。 */
  saveVault(notes: unknown[]): Promise<void>;
  /** Only changed note bodies cross IPC; unmentioned saved notes remain intact. */
  saveNotesDelta(delta: import('../services/vaultNoteDelta').VaultNotesDelta): Promise<void>;
  knowledgeLifecycle(): Promise<import('../services/knowledgeLifecycle').KnowledgeLifecycle>;
  /** 只原子更新个人阅读位置，不写正文/目录或启动 RAG。 */
  saveReadingPositions(updates: import('../services/textbook/readingState').TextbookReadingUpdate[]): Promise<void>;
  savePersonalState(patches: import('../services/personalNoteState').PersonalNotePatch[]): Promise<void>;
  /** 返回 vault 根目录绝对路径 */
  getVaultRoot(): Promise<string>;
}

/** Electron 主进程暴露的应用板块·场景 Skill 包读写能力（vault/scene-skills/） */
interface ElectronSceneSkillsApi {
  /** 返回场景包目录（不存在时自动创建），便于用户查看/备份 */
  getDir(): Promise<string>;
  /** 读取 manifest 索引；文件不存在或损坏时返回空骨架 */
  loadManifest(): Promise<unknown>;
  /** 覆盖写入 manifest 索引 */
  saveManifest(manifest: unknown): Promise<void>;
  /** 读取单个场景完整定义；不存在返回 null */
  loadScene(sceneId: string): Promise<unknown | null>;
  /** 写入单个场景完整定义 */
  saveScene(sceneId: string, spec: unknown): Promise<void>;
  /** 删除单个场景定义 */
  deleteScene(sceneId: string): Promise<void>;
  /** 读取角色模板库（全局共享）；文件不存在时返回空骨架 */
  loadRoles(): Promise<unknown>;
  /** 覆盖写入角色模板库 */
  saveRoles(file: unknown): Promise<void>;
}

/** Electron 主进程暴露的 SymPy 计算服务能力（S4 数理场景专用） */
interface ElectronComputeApi {
  /** 执行一条计算命令（内部带超时、id 配对与错误归一化） */
  run(req: unknown): Promise<{ ok: boolean; result?: unknown; error?: string; errorCode?: string }>;
  /** 查询服务是否已就绪（用于 UI 展示「计算引擎加载中」） */
  status(): Promise<{ ready: boolean; warming: boolean; error?: string }>;
}

/** Electron 主进程暴露的 STT 后端状态能力 */
interface ElectronSttApi {
  getStatus(): Promise<{ running: boolean; error?: string }>;
  getPort(): Promise<number>;
}

/** Electron 主进程暴露的 user-state 个人数据读写能力 */
interface ElectronUserStateApi {
  loadCognition(): Promise<import('../services/cognition/types').CognitionFile>;
  searchCognition(query: string): Promise<import('../services/cognition/retrieval').CognitionRetrieval>;
  mutateCognition(input: import('../services/cognition/types').CognitionMutation): Promise<import('../services/cognition/types').CognitionFile>;
  onCognitionChanged(callback: () => void): () => void;
  loadProfile(strict?: boolean): Promise<unknown>;
  saveProfile(profile: unknown, conceptAliasMap: unknown): Promise<void>;
  loadSettings(): Promise<unknown>;
  saveSettings(settings: unknown): Promise<void>;
  loadLlm(): Promise<unknown>;
  saveLlm(settings: unknown): Promise<void>;
  loadMasteryTimeline(strict?: boolean): Promise<unknown>;
  saveMasteryTimeline(file: unknown): Promise<void>;
  loadLearningEpisodes(strict?: boolean): Promise<unknown>;
  saveLearningEpisodes(file: unknown): Promise<void>;
  loadFlowStatistics(): Promise<import('../services/profile/flowStatistics').FlowStatisticsFile | null>;
  recordFlowStatistics(input: import('../services/profile/flowStatistics').FlowStatisticsSubmission): Promise<void>;
  loadStyleRaw(): Promise<unknown>;
  saveStyleRaw(file: unknown): Promise<void>;
  loadStyleSnapshot(strict?: boolean): Promise<unknown>;
  saveStyleSnapshot(file: unknown): Promise<void>;
  loadStyleTrend(strict?: boolean): Promise<unknown>;
  saveStyleTrend(file: unknown): Promise<void>;
  loadWordCloud(strict?: boolean): Promise<unknown>;
  saveWordCloud(file: unknown): Promise<void>;
  loadResourceState(): Promise<unknown>;
  saveResourceState(file: unknown): Promise<void>;
  loadAgentAudit(strict?: boolean): Promise<unknown>;
  saveAgentAudit(file: unknown): Promise<void>;
  loadAgentCheckpoints(): Promise<unknown>;
  saveAgentCheckpoints(file: unknown): Promise<void>;
  loadAgentWorkflowDrafts(): Promise<unknown>;
  saveAgentWorkflowDrafts(file: unknown): Promise<void>;
  loadAgentSessions(): Promise<unknown>;
  loadAgentOperations(): Promise<unknown>;
  saveAgentOperations(file: unknown): Promise<void>;
  saveAgentSessions(file: unknown): Promise<void>;
  getAgentTaskScope(): Promise<string>;
  loadAgentTaskState(): Promise<{ scopeId: string; state: unknown }>;
  saveAgentTaskState(scopeId: string, patch: import('../services/agent/taskStateCodec').AgentTaskStatePatch): Promise<void>;
  loadSceneInteractionAudit(strict?: boolean): Promise<unknown>;
  saveSceneInteractionAudit(file: unknown): Promise<void>;
  loadSceneAssemblyAudit(strict?: boolean): Promise<unknown>;
  saveSceneAssemblyAudit(file: unknown): Promise<void>;
  getRoot(): Promise<string>;
}

interface ElectronAgentApi {
  dataVersion(): Promise<number>;
  queryProfile(request?: { includeEvidence?: boolean }): Promise<{ text: string; details?: string[] }>;
  queryMastery(req: { noteTitles?: string[] }): Promise<{ rows: unknown[] }>;
  reviewQueue(): Promise<{ items: unknown[] }>;
  onDataChanged(callback: (payload: unknown) => void): () => void;
}

/** Electron 主进程暴露的资料文档 RAG 能力 */
interface ElectronRagDocsApi {
  /** Changes when the active storage environment is stopped or replaced. */
  processingContext(): Promise<string>;
  /** 弹出资料与附件选择框，返回绝对路径数组；取消返回 [] */
  chooseFiles(): Promise<string[]>;
  /** 上传资料文档，返回上传结果 */
  upload(filePaths: string[]): Promise<{ ok: boolean; documents?: unknown[]; error?: string }>;
  /** 列出全部资料文档元数据 */
  list(): Promise<unknown[]>;
  /** 设置单份资料的用户分类；空值移回“未分类”。 */
  setCategory(docId: string, category?: string): Promise<void>;
  maintain(input: import('../services/documentMaintenance').DocumentMaintenanceCommand): Promise<void>;
  materialList(scope: import('../services/textbook/materialTypes').MaterialScope): Promise<import('../services/textbook/materialTypes').MaterialResult<import('../services/textbook/materialTypes').MaterialDocumentSummary[]>>;
  materialPrepare(scope: import('../services/textbook/materialTypes').MaterialScope, docId: string): Promise<import('../services/textbook/materialTypes').MaterialResult<import('../services/textbook/materialTypes').MaterialDocumentSummary>>;
  materialCatalog(request: import('../services/textbook/materialTypes').MaterialCatalogRequest): Promise<import('../services/textbook/materialTypes').MaterialResult<import('../services/textbook/materialTypes').MaterialCatalog>>;
  materialRead(request: import('../services/textbook/materialTypes').MaterialReadRequest): Promise<import('../services/textbook/materialTypes').MaterialResult<import('../services/textbook/materialTypes').MaterialPage>>;
  materialSearch(request: import('../services/textbook/materialTypes').MaterialSearchRequest): Promise<import('../services/textbook/materialTypes').MaterialResult<import('../services/textbook/materialTypes').MaterialSearch>>;
  materialImage(request: import('../services/textbook/materialTypes').MaterialImageRequest): Promise<import('../services/textbook/materialTypes').MaterialResult<import('../services/textbook/materialTypes').MaterialImage>>;
  /** 查看抽取后的有限文本分块，不包含向量或原始绝对路径 */
  preview(docId: string, chunkId?: string): Promise<{ ok: boolean; preview?: unknown; error?: string }>;
  /** 查询单文档向量化状态 */
  getStatus(docId: string): Promise<{ status: string; chunkCount: number; totalChars: number; error?: string;
    parseStatus?: import('../types').UploadedDocument['parseStatus']; parseError?: string; parsedAt?: string }>;
  /** 重试失败文档 */
  retry(docId: string): Promise<void>;
  resetArgumentV5?(docId:string):Promise<void>;
  argumentV5View?(docId:string):Promise<import('../services/documentArgumentV5Types').DocumentArgumentGraphView>;
  /** 使用系统默认应用打开资料原文件 */
  open(docId: string): Promise<{ ok: boolean; error?: string }>;
  readingSource(docId: string): Promise<import('../services/textbook/materialTypes').MaterialResult<import('../services/textbook/materialTypes').DocumentReadingSource>>;
  /** 删除文档及其向量分块 */
  delete(docId: string): Promise<void>;
  /** 检索资料文档（仅 ready） */
  search(query: string, k?: number, options?: import('../types').DocumentSearchOptions): Promise<unknown[]>;
  readArgumentEvidence?(anchors: import('../services/agent/qaDocumentGraph').QaGraphAnchor[], query?:string, intentQuery?:string): Promise<import('../services/agent/qaDocumentGraph').QaDocumentGraph>;
  recallDocumentGraphCandidates?(input: import('../services/documentGraphTypes').DocumentGraphCommit,targetIds:string[]): Promise<Record<string,string[]>>;
  prepareDocumentGraph?(docId: string): Promise<import('../services/documentGraphTypes').DocumentGraphSourceSnapshot>;
  prepareArgumentV5?(docId: string): Promise<import('../services/documentArgumentV5Types').DocumentArgumentV5Snapshot>;
  commitArgumentV5?(input: import('../services/documentArgumentV5Types').DocumentArgumentV5Commit,environmentId:string): Promise<{revision:string;nodes:number;relations:number}>;
  recordArgumentV5Response?(input:import('../services/documentArgumentV5Types').DocumentArgumentV5ResponseRecord,environmentId:string):Promise<void>;
  recallArgumentV5Bridges?(input: import('../services/documentArgumentV5Types').DocumentArgumentV5Commit,environmentId:string): Promise<import('../services/documentArgumentV5Pipeline').DocumentArgumentBridgeTask[]>;
  commitDocumentGraph?(input: import('../services/documentGraphTypes').DocumentGraphCommit,environmentId?:string): Promise<{revision:string;nodes:number;relations:number}>;
  /** 订阅资料变化，返回取消订阅函数 */
  onChanged(callback: () => void): () => void;
}

/** Electron 主进程暴露的 LLM 转发能力 */
interface ElectronLlmApi {
  request(req: unknown): Promise<unknown>;
  probe(req: unknown): Promise<import('./ipcTypes').LlmProbeResponse>;
  models(req: unknown): Promise<{ ok: boolean; models: string[]; error?: string }>;
  stream(req: unknown): Promise<string>;
  cancel(requestId: string): Promise<boolean>;
  onChunk(callback: (payload: { streamId: string; chunk: unknown }) => void): () => void;
  onEnd(callback: (payload: { streamId: string }) => void): () => void;
  onError(callback: (payload: { streamId: string; message: string; cancelled?: boolean }) => void): () => void;
}

interface ElectronRagKnowledgeApi {
  getSettings(): Promise<import('../types').RagKnowledgeSettings>;
  setEnabled(input: import('../types').RagKnowledgeSettings): Promise<import('../types').RagKnowledgeSettings>;
  getStatus(docId: string): Promise<import('../types').RagKnowledgeDocumentStatus>;
  getPendingBatch(maxChunks?: number): Promise<import('../types').RagKnowledgePendingChunk[]>;
  commitBatch(input: import('../types').RagKnowledgeBatchCommit): Promise<import('../types').RagKnowledgeDocumentStatus>;
  markBatchFailed(input: { docId: string; generationId: string; chunkIds: string[]; error: string }): Promise<import('../types').RagKnowledgeDocumentStatus>;
  retryDocument(docId: string): Promise<import('../types').RagKnowledgeDocumentStatus>;
}

/** Electron 主进程暴露的 AI 服务能力 */
interface ElectronAiApi {
  autoLink(req: unknown): Promise<{ updatedContent: string; addedLinks: string[] }>;
}

interface ElectronResourceBrowserApi {
  search(req: {
    projectTitle: string;
    taskText: string;
    knowledgeTitles: string[];
    maxResults?: number;
    draftSessionId?: string;
    interactionMode?: 'review' | 'auto';
    source?: 'agent' | 'note-editor' | 'concept-fill';
    queryOverride?: string;
  }): Promise<{
    sessionId: string;
    query: string;
    searchPageUrl: string;
    resources: unknown[];
    markdown: string;
  }>;
  scan(sessionId: string): Promise<{ sessionId: string; pageUrl: string; resources: unknown[] }>;
  authorize(req: { sessionId: string; candidateId: string }): Promise<{
    canceled?: boolean;
    container?: unknown;
    resource?: unknown;
  }>;
  download(req: { sessionId: string; candidateId: string }): Promise<{
    ok: boolean;
    canceled?: boolean;
    document?: unknown;
    error?: string;
  }>;
  close(sessionId: string): Promise<boolean>;
  listAuthContainers(): Promise<unknown[]>;
  resolveAuthSession(url: string): Promise<import('../types').ResourceAuthSessionResolution | null>;
  openAuthContainer(containerId: string): Promise<{ ok: boolean; sessionId?: string; error?: string }>;
  removeAuthContainer(containerId: string): Promise<boolean>;
  onCandidateDecision(callback: (payload: import('../types').ResourceBrowserCandidateDecisionEvent) => void): () => void;
  onClosed(callback: (payload: import('../types').ResourceBrowserClosedEvent) => void): () => void;
}

interface ElectronResourceWorkbenchApi {
  navigate(req: { sessionId: string; action: 'back' | 'forward' | 'reload' | 'home' | 'go' | 'open-candidate' | 'switch-tab' | 'search-variant'; value?: string }): Promise<boolean>;
  setDecision(req: { sessionId: string; candidateId: string; decision: 'selected' | 'rejected' | null }): Promise<import('../types').ResourceWorkbenchState>;
  setDownload(req: { sessionId: string; candidateId: string; enabled: boolean }): Promise<import('../types').ResourceWorkbenchState>;
  scan(sessionId: string): Promise<import('../types').ResourceBrowserScanResult>;
  authorize(req: { sessionId: string; candidateId: string }): Promise<{
    canceled?: boolean;
    container?: import('../types').ResourceAuthContainer;
    resource?: import('../types').ResourceItem;
  }>;
  commit(sessionId: string): Promise<{ ok: boolean; pendingApply?: boolean; canceled?: boolean; error?: string }>;
  completeCommit(req: { sessionId: string; commitId: string; ok: boolean; message?: string }): Promise<boolean>;
  close(): void;
  onState(callback: (payload: import('../types').ResourceWorkbenchState) => void): () => void;
  onCommitted(callback: (payload: import('../types').ResourceWorkbenchCommitEvent) => void): () => void;
}

interface ElectronConceptResearchApi {
  search(term: string, aliases?: string[], requestId?: string): Promise<import('../types').ConceptSourceEvidence[]>;
  cancel(requestId: string): Promise<boolean>;
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
  /** Editing lease pauses scheduled maintenance; explicit rebuilds are unchanged. */
  setEditing(active: boolean): Promise<void>;
  flushPending(): Promise<void>;
  flowReviewStatus(noteId: string): Promise<import('../services/cognition/flowReviewMaterials').FlowReviewIndexStatus>;
  /** 索引/更新单篇笔记向量 */
  index(input: import('../types').NoteRagIndexInput): Promise<void>;
  /** 批量索引（全量重建） */
  indexAll(inputs: import('../types').NoteRagIndexInput[]): Promise<void>;
  /** 删除单篇笔记向量 */
  delete(noteId: string): Promise<void>;
  /** 批量清理已从保存快照移除的笔记索引，不删除仍存活的笔记索引。 */
  deleteMany(noteIds: string[]): Promise<void>;
  /** 混合检索笔记（中文模型 + BM25 + 加权融合） */
  search(query: string, k?: number, options?: { argumentEnvironmentId: string } | { allowedNoteIds: string[] }): Promise<import('../types').NoteSearchResult[]>;
  status(noteId: string): Promise<import('../types').NoteReferenceIndexStatus>;
}

interface ElectronTextbookRagApi {
  search(query: string, k: number | undefined, allowedNoteIds: string[]): Promise<import('../types').TextbookReferenceSearchResult[]>;
  status(noteId: string): Promise<import('../types').TextbookReferenceIndexStatus>;
  /** 唯一绕过幂等状态的入口；由用户显式操作触发。 */
  rebuild(noteId: string): Promise<import('../types').TextbookReferenceIndexStatus>;
}

interface ElectronArgumentApi {
  open(payload: unknown): Promise<void>;
  save(payload: unknown): Promise<{ ok: boolean; error?: string }>;
  delete(docId: string): Promise<{ ok: boolean; error?: string }>;
  writeApplied(payload: unknown): Promise<boolean>;
  close(): Promise<boolean>;
  openNote(noteId: string): Promise<void>;
  onData(callback: (payload: unknown) => void): () => void;
  onSaved(callback: (payload: unknown) => void): () => void;
  onDeleted(callback: (payload: unknown) => void): () => void;
  onOpenNote(callback: (payload: unknown) => void): () => void;
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
  interactiveFigure?: {
    preflight?(html: string): Promise<void>;
    diagnose?(html: string): Promise<import('./interactiveFigureSandbox').FigureDiagnosticResult>;
    portable?(html: string): Promise<{ html: string; license: string }>;
    read(key: string): Promise<import('./interactiveFigureStore').FigureArtifact | null>;
    write(key: string, artifact: import('./interactiveFigureStore').FigureArtifact): Promise<void>;
    compareReady?(key: string, expected: import('./interactiveFigureStore').FigureArtifact, artifact: import('./interactiveFigureStore').FigureArtifact): Promise<boolean>;
    listManual?(key: string): Promise<import('./interactiveFigureStore').ManualFigure[]>;
    addManual?(key: string, artifact: import('./interactiveFigureStore').ManualFigure): Promise<import('./interactiveFigureStore').ManualFigure[]>;
    describe?(key: string): Promise<import('./interactiveFigureStore').FigureSummary>;
    clearUnfinished?(key: string, manual?: { indexKey: string; brief: string; keepTombstone?: boolean }): Promise<{ restored: boolean; items?: import('./interactiveFigureStore').ManualFigure[] }>;
    open(input: { html: string; bounds: import('./interactiveFigureSandbox').FigureSandboxBounds }): Promise<{ processId: number }>;
    bounds(bounds: import('./interactiveFigureSandbox').FigureSandboxBounds): Promise<void>;
    visible(visible: boolean): Promise<void>;
    close(): Promise<void>;
    onFailure(callback: (reason: string) => void): () => void;
  };
  learningPreparation?: import('../services/progressiveLearning/preparation').LearningPreparationApi;
  mermaid?: {
    render(input: { requestId: string; id: string; code: string; dark: boolean }): Promise<{ svg: string; readingWidth: number }>;
    cancel(requestId: string): void;
  };
  community?: import('../services/community/desktopTypes').CommunityDesktopApi & {onNotesChanged(callback:()=>void):()=>void};
  cognitionManager?: { open(): Promise<void>; setBusy(busy: boolean): void };
  applicationExit?: {
    onRequest(callback: (request: { requestId: string; phase: 'prepare' | 'commit' | 'force' | 'cancel' }) => void): () => void;
    respond(reply: { requestId: string; ok: boolean; backgroundTasks?: number; error?: string }): void;
  };
  isElectron: boolean;
  platform: 'electron' | 'web';
  /** 用系统默认浏览器打开外部链接 */
  openExternal(url: string): Promise<void>;
  /** 打开数据目录（vault/ 与 user-state/ 的父级），作为导出/备份入口 */
  openDataFolder(): Promise<{ ok: boolean; error?: string }>;
  /** 弹出系统文件选择框，选择本地学习资源（多选），返回绝对路径数组；取消返回 [] */
  chooseLocalFiles(): Promise<string[]>;
  checkResourceHealth(url: string): Promise<{
    url: string;
    status: 'available' | 'redirected' | 'restricted' | 'broken' | 'temporary-error';
    checkedAt: string;
    httpStatus?: number;
    finalUrl?: string;
    contentType?: string;
    contentLength?: number;
    suggestedFileName?: string;
    error?: string;
  }>;
  storage: {
    recoverDocuments(): Promise<{ ok: boolean; recovered?: number; skipped?: number; canceled?: boolean; error?: string }>;
    getRoot(): Promise<{ root: string; custom: boolean }>;
    chooseFolder(): Promise<string | null>;
    setRoot(root: string, migrate: boolean): Promise<{ ok: boolean; error?: string }>;
    reset(): Promise<{ ok: boolean; error?: string }>;
  };
  vault?: ElectronVaultApi;
  userState?: ElectronUserStateApi;
  appearance?: import('../services/ui/windowAppearance').WindowAppearanceApi;
  agent?: ElectronAgentApi;
  analysis?: ElectronAnalysisApi;
  llm?: ElectronLlmApi;
  ai?: ElectronAiApi;
  resourceBrowser?: ElectronResourceBrowserApi;
  resourceDownloads?: import('../services/agent/resourceDownloadClient').ResourceDownloadApi;
  conceptResearch?: ElectronConceptResearchApi;
  h5p?: import('../types/h5p').H5pLocalApi;
  stormResearch?: {
    search(subject: string, requestId: string): Promise<import('../services/stormResearch').StormResearchBundle>;
    cancel(requestId: string): Promise<boolean>;
  };
  planResearch?: {
    search(subject: string, requestId: string): Promise<import('../services/planResearch').PlanResearchBundle>;
    cancel(requestId: string): Promise<boolean>;
  };
  resourceWorkbench?: ElectronResourceWorkbenchApi;
  sceneSkills?: ElectronSceneSkillsApi;
  sceneInteractionPacks?: {
    importPackage(): Promise<{ canceled?: boolean; manifest?: import('../types/sceneInteractionPack').SceneInteractionPackManifest; alreadyInstalled?: boolean }>;
    list(): Promise<{ managed: boolean; packs: import('../types/sceneInteractionPack').SceneInteractionPackManifest[]; errors: string[] }>;
    load(ref: import('../types/sceneInteractionPack').SceneInteractionPackRef): Promise<{ manifest: import('../types/sceneInteractionPack').SceneInteractionPackManifest; codeBase64: string; styles: string }>;
    readMaterial(ref: import('../types/sceneInteractionPack').SceneInteractionPackRef, id: string): Promise<{ dataBase64: string }>;
  };
  compute?: ElectronComputeApi;
  stt?: ElectronSttApi;
  ragDocs?: ElectronRagDocsApi;
  progressiveLearning?: import('../services/progressiveLearning/types').ProgressiveLearningApi;
  textbook?: {
    figureApproval(input: { jobId: string; projectId: string; bodyDigest: string }): Promise<{ allowCloud: boolean; providerHash: string; modelPolicy?: import('../services/textbook/modelPolicy').TextbookModelPolicy; thinkingSnapshot?: import('../services/textbook/thinkingSnapshot').TextbookThinkingSnapshot }>;
    requestStop(jobId: string): Promise<import('../services/textbook/stop').TextbookStopReply>;
    onStopRequested(listener: (request: import('../services/textbook/stop').TextbookStopRequest) => void): () => void;
    supplement(input: import('../services/textbook/supplement').TextbookSupplementRequest): Promise<import('../services/textbook/supplement').TextbookSupplementResult>;
    readBoundUrl(input: import('../services/textbook/webTypes').TextbookWebReadRequest): Promise<import('../services/textbook/webTypes').TextbookWebSnapshot>;
    cancelWebRead(jobId: string, token: string): Promise<void>;
    readWebEvidence(input: import('../services/textbook/webTypes').TextbookWebEvidenceRequest): Promise<{ text: string; nextCursor?: number }>;
    list(projectNoteId: string): Promise<import('../services/textbook/generationTypes').TextbookJobSummary[]>;
    command(input: import('../services/textbook/generationTypes').TextbookJobCommand): Promise<import('../services/textbook/generationTypes').TextbookJobReply>;
    sourceHash(scope: import('../services/textbook/materialTypes').MaterialScope, docId: string): Promise<string>;
  };
  /** Host-issued saved learning-note/library scope; no publication or qualification authority. */
  argumentContext?: {
    getEnvironment(selection?: import('./rag/argumentLearningScope').ArgumentEnvironmentSelection): Promise<import('./rag/argumentProjectionEnvironment').ArgumentProjectionEnvironmentReply>;
    read(request: import('./rag/argumentProjectionRuntime').ArgumentProjectionReadonlyRequest): Promise<
      import('./rag/argumentProjectionRuntime').ArgumentProjectionReadonlyResponse | { status: 'held'; reasonCode: string }>;
    freezeQuestion(environmentId: string, selectors: import('../services/argumentContext/questionBindingTypes').ArgumentQuestionFrameSelectors): Promise<import('../services/argumentContext/questionReceipt').ArgumentQuestionReceipt>;
    verifyQuestion(environmentId: string, receipt: import('../services/argumentContext/questionReceipt').ArgumentQuestionReceipt): Promise<import('../services/argumentContext/questionReceipt').ArgumentQuestionReceiptVerification>;
    readQuestion(environmentId: string, receipt: import('../services/argumentContext/questionReceipt').ArgumentQuestionReceipt): Promise<import('../services/argumentContext/referenceDisclosure').ArgumentReferenceDisclosureReply>;
    readQuestionPropositions(environmentId: string, receipt: import('../services/argumentContext/questionReceipt').ArgumentQuestionReceipt): Promise<import('../services/argumentContext/referencePropositionReceipt').ArgumentReferencePropositionDisclosureReply>;
  };
  ragKnowledge?: ElectronRagKnowledgeApi;
  /** Explicit source processing; renderer cannot submit prompts, model settings, qualification or review tickets. */
  argumentReference?: import('../services/argumentContext/referenceBuildClient').ArgumentReferenceBuildApi & {
    onChanged(callback: () => void): () => void;
    onInvalidated(callback: () => void): () => void;
  };
  /** Explicit new five/two-request consent; never reuse a legacy three-request ticket. */
  argumentReferenceRag?: import('../services/argumentContext/referenceRagBuildTypes').ArgumentReferenceRagBuildApi & {
    onChanged(callback: () => void): () => void;
    onInvalidated(callback: () => void): () => void;
  };
  noteRag?: ElectronNoteRagApi;
  textbookRag?: ElectronTextbookRagApi;
  argument?: ElectronArgumentApi;
  updater?: ElectronUpdaterApi;
  windowControls?: ElectronWindowControlsApi;
}

declare global {
  interface Window {
    electronAPI?: ElectronApi;
  }
}
