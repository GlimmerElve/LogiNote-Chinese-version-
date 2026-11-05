import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  isElectron: true,
  platform: 'electron',
  learningPreparation: {
    command: (input: import('../services/progressiveLearning/preparation').LearningPreparationCommand) => ipcRenderer.invoke('learning-preparation:command', input),
    materials: (projectId: string) => ipcRenderer.invoke('learning-preparation:materials', projectId),
    onChange: (callback: (rootId: string, change?: import('../services/progressiveLearning/preparation').PreparedResourceChange) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, id: string, change?: import('../services/progressiveLearning/preparation').PreparedResourceChange) => callback(id, change);
      ipcRenderer.on('learning-preparation:changed', receive); return () => ipcRenderer.removeListener('learning-preparation:changed', receive);
    },
  },
  mermaid: {
    render: (input: import('../services/ui/textbookVisualTypes').TextbookVisualInput & { requestId: string }) => ipcRenderer.invoke('mermaid:render', input),
    cancel: (requestId: string) => ipcRenderer.send('mermaid:cancel', requestId),
  },
  interactiveFigure: {
    preflight: (html: string): Promise<void> => ipcRenderer.invoke('interactive-figure:preflight', html),
    diagnose: (html: string): Promise<import('./interactiveFigureSandbox').FigureDiagnosticResult> => ipcRenderer.invoke('interactive-figure:diagnose', html),
    portable: (html: string): Promise<{ html: string; license: string }> => ipcRenderer.invoke('interactive-figure:portable', html),
    read: (key: string): Promise<import('./interactiveFigureStore').FigureArtifact | null> => ipcRenderer.invoke('interactive-figure:artifact', { op: 'read', key }),
    write: (key: string, artifact: import('./interactiveFigureStore').FigureArtifact): Promise<void> => ipcRenderer.invoke('interactive-figure:artifact', { op: 'write', key, artifact }),
    compareReady: (key: string, expected: import('./interactiveFigureStore').FigureArtifact, artifact: import('./interactiveFigureStore').FigureArtifact): Promise<boolean> => ipcRenderer.invoke('interactive-figure:artifact', { op: 'compareReady', key, expected, artifact }),
    listManual: (key: string): Promise<import('./interactiveFigureStore').ManualFigure[]> => ipcRenderer.invoke('interactive-figure:artifact', { op: 'listManual', key }),
    addManual: (key: string, artifact: import('./interactiveFigureStore').ManualFigure): Promise<import('./interactiveFigureStore').ManualFigure[]> => ipcRenderer.invoke('interactive-figure:artifact', { op: 'addManual', key, artifact }),
    describe: (key: string): Promise<import('./interactiveFigureStore').FigureSummary> => ipcRenderer.invoke('interactive-figure:artifact', { op: 'describe', key }),
    clearUnfinished: (key: string, manual?: { indexKey: string; brief: string; keepTombstone?: boolean }): Promise<{ restored: boolean; items?: import('./interactiveFigureStore').ManualFigure[] }> => ipcRenderer.invoke('interactive-figure:artifact', { op: 'clearUnfinished', key, artifact: manual }),
    open: (input: { html: string; bounds: import('./interactiveFigureSandbox').FigureSandboxBounds }) => ipcRenderer.invoke('interactive-figure:open', input),
    bounds: (bounds: import('./interactiveFigureSandbox').FigureSandboxBounds) => ipcRenderer.invoke('interactive-figure:bounds', bounds),
    visible: (visible: boolean) => ipcRenderer.invoke('interactive-figure:visible', visible),
    close: () => ipcRenderer.invoke('interactive-figure:close'),
    onFailure: (callback: (reason: string) => void) => {
      const receive = (_event: Electron.IpcRendererEvent, reason: string) => callback(reason);
      ipcRenderer.on('interactive-figure:failure', receive); return () => ipcRenderer.removeListener('interactive-figure:failure', receive);
    },
  },
  community: {
    setFocus:(enabled:boolean)=>ipcRenderer.invoke('community:focus',enabled),
    prepareLink:(url:string)=>ipcRenderer.invoke('community:prepare-link',url),
    openLink:(url:string)=>ipcRenderer.invoke('community:open-link',url),
    references:()=>ipcRenderer.invoke('community:references'),
    snapshot:(id:string)=>ipcRenderer.invoke('community:snapshot',id),
    state:()=>ipcRenderer.invoke('community:state'),connect:()=>ipcRenderer.invoke('community:connect'),disconnect:()=>ipcRenderer.invoke('community:disconnect'),
    catalog:()=>ipcRenderer.invoke('community:catalog'),prepare:(input:unknown)=>ipcRenderer.invoke('community:prepare',input),chooseFile:()=>ipcRenderer.invoke('community:choose-file'),
    publish:(input:unknown)=>ipcRenderer.invoke('community:publish',input),receiveNow:()=>ipcRenderer.invoke('community:receive'),templates:()=>ipcRenderer.invoke('community:templates'),activateTemplate:(input:unknown)=>ipcRenderer.invoke('community:activate',input),
    onNotesChanged:(callback:()=>void)=>{const handler=()=>callback();ipcRenderer.on('community:notes-changed',handler);return()=>ipcRenderer.removeListener('community:notes-changed',handler);},
  },
  applicationExit: {
    onRequest: (callback: (request: { requestId: string; phase: 'prepare' | 'commit' | 'force' | 'cancel' }) => void) => {
      const handler = (_event: unknown, request: { requestId: string; phase: 'prepare' | 'commit' | 'force' | 'cancel' }) => callback(request);
      ipcRenderer.on('application:exit-request', handler);
      return () => ipcRenderer.removeListener('application:exit-request', handler);
    },
    respond: (reply: { requestId: string; ok: boolean; backgroundTasks?: number; error?: string }) => ipcRenderer.send('application:exit-ready', reply),
  },
  appearance: {
    initialTheme: process.argv.includes('--loginote-theme=dark') ? 'dark'
      : process.argv.includes('--loginote-theme=light') ? 'light' : undefined,
    getTheme: () => ipcRenderer.invoke('window:theme-get'),
    updateTheme: (theme: 'light' | 'dark') => ipcRenderer.invoke('window:theme-update', theme),
    onThemeChanged: (callback: (theme: unknown) => void) => {
      const handler = (_event: unknown, theme: unknown) => callback(theme);
      ipcRenderer.on('window:theme-changed', handler);
      return () => ipcRenderer.removeListener('window:theme-changed', handler);
    },
  },
  progressiveLearning: {
    onChange: (callback:(projectNoteId:string,reason?:'review'|'knowledge')=>void)=>{
      const listener=(_event:Electron.IpcRendererEvent,id:string,reason?:'review'|'knowledge')=>callback(id,reason);
      ipcRenderer.on('progressive-learning:changed',listener);return ()=>ipcRenderer.removeListener('progressive-learning:changed',listener);
    },
    command: (input: import('../services/progressiveLearning/types').ProgressiveCommand) => ipcRenderer.invoke('progressive-learning:command', input),
    derived: (input: { op: 'status' | 'retry' | 'search'; projectNoteId: string; query?: string }) => ipcRenderer.invoke('progressive-learning:derived', input),
    onKnowledge: (callback: (notes: import('../types').NoteItem[], change?: import('../services/progressiveLearning/knowledgeProjection').ProgressiveKnowledgeChange) => void) => {
      const handler = (_event: unknown, notes: import('../types').NoteItem[], change?: import('../services/progressiveLearning/knowledgeProjection').ProgressiveKnowledgeChange) => callback(notes, change);
      ipcRenderer.on('progressive-learning:knowledge', handler);
      return () => ipcRenderer.removeListener('progressive-learning:knowledge', handler);
    },
  },
  textbook: {
    figureApproval: (input: { jobId: string; projectId: string; bodyDigest: string }) => ipcRenderer.invoke('textbook:figure-approval', input),
    requestStop: (jobId: string) => ipcRenderer.invoke('textbook:request-stop', jobId),
    onStopRequested: (callback: (request: import('../services/textbook/stop').TextbookStopRequest) => void) => {
      const handler = (_event: unknown, request: import('../services/textbook/stop').TextbookStopRequest) => callback(request);
      ipcRenderer.on('textbook:stop-requested', handler);
      return () => ipcRenderer.removeListener('textbook:stop-requested', handler);
    },
    supplement: (input: import('../services/textbook/supplement').TextbookSupplementRequest) => ipcRenderer.invoke('textbook:supplement', input),
    readBoundUrl: (input: import('../services/textbook/webTypes').TextbookWebReadRequest) => ipcRenderer.invoke('textbook:read-bound-url', input),
    cancelWebRead: (jobId: string, token: string) => ipcRenderer.invoke('textbook:cancel-web-read', jobId, token),
    readWebEvidence: (input: import('../services/textbook/webTypes').TextbookWebEvidenceRequest) => ipcRenderer.invoke('textbook:read-web-evidence', input),
    list: (projectNoteId: string) => ipcRenderer.invoke('textbook:list', projectNoteId),
    command: (input: import('../services/textbook/generationTypes').TextbookJobCommand) => ipcRenderer.invoke('textbook:command', input),
    sourceHash: (scope: import('../services/textbook/materialTypes').MaterialScope, docId: string) => ipcRenderer.invoke('textbook:source-hash', scope, docId),
  },
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),
  openDataFolder: () => ipcRenderer.invoke('data:open-folder'),
  analysis: {
    exportReport: (content: string, fileName: string) => ipcRenderer.invoke('analysis:export', content, fileName),
  },
  llm: {
    request: (req: unknown) => ipcRenderer.invoke('llm:request', req),
    probe: (req: unknown) => ipcRenderer.invoke('llm:probe', req),
    models: (req: unknown) => ipcRenderer.invoke('llm:models', req),
    stream: (req: unknown) => ipcRenderer.invoke('llm:stream-start', req),
    cancel: (requestId: string) => ipcRenderer.invoke('llm:cancel', requestId),
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
    onError: (callback: (payload: { streamId: string; message: string; cancelled?: boolean }) => void) => {
      const handler = (_e: unknown, payload: { streamId: string; message: string; cancelled?: boolean }) => callback(payload);
      ipcRenderer.on('llm:stream-error', handler);
      return () => ipcRenderer.removeListener('llm:stream-error', handler);
    },
  },
  ai: {
    autoLink: (req: unknown) => ipcRenderer.invoke('ai:auto-link', req),
  },
  chooseLocalFiles: () => ipcRenderer.invoke('resource:choose-local-files'),
  checkResourceHealth: (url: string) => ipcRenderer.invoke('resource:check-health', url),
  resourceDownloads: {
    prepare: (input: { projectId: string; urls?: string[] }) => ipcRenderer.invoke('resource-download:prepare', input),
    execute: (planId: string) => ipcRenderer.invoke('resource-download:execute', planId),
    executeAutomatic: (planId: string) => ipcRenderer.invoke('resource-download:execute-automatic', planId),
    release: (planId: string) => ipcRenderer.invoke('resource-download:release', planId),
    cancel: (planId: string) => ipcRenderer.invoke('resource-download:cancel', planId),
  },
  resourceBrowser: {
    search: (request: unknown) => ipcRenderer.invoke('resource-browser:search', request),
    scan: (sessionId: string) => ipcRenderer.invoke('resource-browser:scan', sessionId),
    authorize: (request: { sessionId: string; candidateId: string }) => ipcRenderer.invoke('resource-browser:authorize', request),
    download: (request: { sessionId: string; candidateId: string }) => ipcRenderer.invoke('resource-browser:download', request),
    close: (sessionId: string) => ipcRenderer.invoke('resource-browser:close', sessionId),
    listAuthContainers: () => ipcRenderer.invoke('resource-browser:auth-list'),
    resolveAuthSession: (url: string) => ipcRenderer.invoke('resource-browser:auth-resolve', url),
    openAuthContainer: (containerId: string) => ipcRenderer.invoke('resource-browser:auth-open', containerId),
    removeAuthContainer: (containerId: string) => ipcRenderer.invoke('resource-browser:auth-remove', containerId),
    onCandidateDecision: (callback: (payload: unknown) => void) => {
      const handler = (_e: unknown, payload: unknown) => callback(payload);
      ipcRenderer.on('resource-browser:candidate-decision', handler);
      return () => ipcRenderer.removeListener('resource-browser:candidate-decision', handler);
    },
    onClosed: (callback: (payload: unknown) => void) => {
      const handler = (_e: unknown, payload: unknown) => callback(payload);
      ipcRenderer.on('resource-browser:closed', handler);
      return () => ipcRenderer.removeListener('resource-browser:closed', handler);
    },
  },
  conceptResearch: {
    search: (term: string, aliases?: string[], requestId?: string) => ipcRenderer.invoke('concept-research:search', term, aliases, requestId),
    cancel: (requestId: string) => ipcRenderer.invoke('concept-research:cancel', requestId),
  },
  stormResearch: {
    search: (subject: string, requestId: string) => ipcRenderer.invoke('storm-research:search', subject, requestId),
    cancel: (requestId: string) => ipcRenderer.invoke('storm-research:cancel', requestId),
  },
  planResearch: {
    search: (subject: string, requestId: string) => ipcRenderer.invoke('plan-research:search', subject, requestId),
    cancel: (requestId: string) => ipcRenderer.invoke('plan-research:cancel', requestId),
  },
  resourceWorkbench: {
    navigate: (request: { sessionId: string; action: string; value?: string }) => ipcRenderer.invoke('resource-workbench:navigate', request),
    setDecision: (request: { sessionId: string; candidateId: string; decision: 'selected' | 'rejected' | null }) => ipcRenderer.invoke('resource-workbench:decision', request),
    setDownload: (request: { sessionId: string; candidateId: string; enabled: boolean }) => ipcRenderer.invoke('resource-workbench:download-toggle', request),
    scan: (sessionId: string) => ipcRenderer.invoke('resource-browser:scan', sessionId),
    authorize: (request: { sessionId: string; candidateId: string }) => ipcRenderer.invoke('resource-browser:authorize', request),
    commit: (sessionId: string) => ipcRenderer.invoke('resource-workbench:commit', sessionId),
    completeCommit: (request: { sessionId: string; commitId: string; ok: boolean; message?: string }) => ipcRenderer.invoke('resource-workbench:commit-applied', request),
    close: () => ipcRenderer.send('window:close'),
    onState: (callback: (payload: unknown) => void) => {
      const handler = (_e: unknown, payload: unknown) => callback(payload);
      ipcRenderer.on('resource-workbench:state', handler);
      return () => ipcRenderer.removeListener('resource-workbench:state', handler);
    },
    onCommitted: (callback: (payload: unknown) => void) => {
      const handler = (_e: unknown, payload: unknown) => callback(payload);
      ipcRenderer.on('resource-workbench:committed', handler);
      return () => ipcRenderer.removeListener('resource-workbench:committed', handler);
    },
  },
  storage: {
    recoverDocuments: () => ipcRenderer.invoke('storage:recover-documents'),
    getRoot: () => ipcRenderer.invoke('storage:get-root'),
    chooseFolder: () => ipcRenderer.invoke('storage:choose-folder'),
    setRoot: (root: string, migrate: boolean) => ipcRenderer.invoke('storage:set-root', root, migrate),
    reset: () => ipcRenderer.invoke('storage:reset'),
  },
  vault: {
    loadVault: () => ipcRenderer.invoke('vault:load'),
    saveVault: (notes: unknown[]) => ipcRenderer.invoke('vault:save', notes),
    saveNotesDelta: (delta: import('../services/vaultNoteDelta').VaultNotesDelta) => ipcRenderer.invoke('vault:save-delta', delta),
    knowledgeLifecycle: () => ipcRenderer.invoke('vault:knowledge-lifecycle'),
    saveReadingPositions: (updates: import('../services/textbook/readingState').TextbookReadingUpdate[]) => ipcRenderer.invoke('vault:save-reading-positions', updates),
    savePersonalState: (patches: import('../services/personalNoteState').PersonalNotePatch[]) => ipcRenderer.invoke('vault:save-personal-state', patches),
    getVaultRoot: () => ipcRenderer.invoke('vault:get-root'),
  },
  userState: {
    loadCognition: () => ipcRenderer.invoke('user-state:load-cognition'),
    searchCognition: (query: string) => ipcRenderer.invoke('user-state:search-cognition', query),
    mutateCognition: (input: unknown) => ipcRenderer.invoke('user-state:mutate-cognition', input),
    onCognitionChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('user-state:cognition-changed', handler);
      return () => ipcRenderer.removeListener('user-state:cognition-changed', handler);
    },
    loadProfile: (strict?: boolean) => ipcRenderer.invoke('user-state:load-profile', strict),
    saveProfile: (profile: unknown, conceptAliasMap: unknown) => ipcRenderer.invoke('user-state:save-profile', profile, conceptAliasMap),
    loadSettings: () => ipcRenderer.invoke('user-state:load-settings'),
    saveSettings: (settings: unknown) => ipcRenderer.invoke('user-state:save-settings', settings),
    loadLlm: () => ipcRenderer.invoke('user-state:load-llm'),
    saveLlm: (settings: unknown) => ipcRenderer.invoke('user-state:save-llm', settings),
    loadMasteryTimeline: (strict?: boolean) => ipcRenderer.invoke('user-state:load-mastery-timeline', strict),
    saveMasteryTimeline: (file: unknown) => ipcRenderer.invoke('user-state:save-mastery-timeline', file),
    loadLearningEpisodes: (strict?: boolean) => ipcRenderer.invoke('user-state:load-learning-episodes', strict),
    saveLearningEpisodes: (file: unknown) => ipcRenderer.invoke('user-state:save-learning-episodes', file),
    loadFlowStatistics: () => ipcRenderer.invoke('user-state:load-flow-statistics'),
    recordFlowStatistics: (input: unknown) => ipcRenderer.invoke('user-state:record-flow-statistics', input),
    loadStyleRaw: () => ipcRenderer.invoke('user-state:load-style-raw'),
    saveStyleRaw: (file: unknown) => ipcRenderer.invoke('user-state:save-style-raw', file),
    loadStyleSnapshot: (strict?: boolean) => ipcRenderer.invoke('user-state:load-style-snapshot', strict),
    saveStyleSnapshot: (file: unknown) => ipcRenderer.invoke('user-state:save-style-snapshot', file),
    loadStyleTrend: (strict?: boolean) => ipcRenderer.invoke('user-state:load-style-trend', strict),
    saveStyleTrend: (file: unknown) => ipcRenderer.invoke('user-state:save-style-trend', file),
    loadWordCloud: (strict?: boolean) => ipcRenderer.invoke('user-state:load-wordcloud', strict),
    saveWordCloud: (file: unknown) => ipcRenderer.invoke('user-state:save-wordcloud', file),
    loadResourceState: () => ipcRenderer.invoke('user-state:load-resource-state'),
    saveResourceState: (file: unknown) => ipcRenderer.invoke('user-state:save-resource-state', file),
    loadAgentAudit: (strict?: boolean) => ipcRenderer.invoke('user-state:load-agent-audit', strict),
    saveAgentAudit: (file: unknown) => ipcRenderer.invoke('user-state:save-agent-audit', file),
    loadAgentCheckpoints: () => ipcRenderer.invoke('user-state:load-agent-checkpoints'),
    saveAgentCheckpoints: (file: unknown) => ipcRenderer.invoke('user-state:save-agent-checkpoints', file),
    loadAgentWorkflowDrafts: () => ipcRenderer.invoke('user-state:load-agent-workflow-drafts'),
    saveAgentWorkflowDrafts: (file: unknown) => ipcRenderer.invoke('user-state:save-agent-workflow-drafts', file),
    loadAgentSessions: () => ipcRenderer.invoke('user-state:load-agent-sessions'),
    loadAgentOperations: () => ipcRenderer.invoke('user-state:load-agent-operations'),
    saveAgentOperations: (file: unknown) => ipcRenderer.invoke('user-state:save-agent-operations', file),
    saveAgentSessions: (file: unknown) => ipcRenderer.invoke('user-state:save-agent-sessions', file),
    getAgentTaskScope: () => ipcRenderer.invoke('user-state:agent-task-scope'),
    loadAgentTaskState: () => ipcRenderer.invoke('user-state:load-agent-tasks'),
    saveAgentTaskState: (scopeId: string, patch: import('../services/agent/taskStateCodec').AgentTaskStatePatch) => ipcRenderer.invoke('user-state:save-agent-tasks', scopeId, patch),
    loadSceneInteractionAudit: (strict?: boolean) => ipcRenderer.invoke('user-state:load-scene-interaction-audit', strict),
    saveSceneInteractionAudit: (file: unknown) => ipcRenderer.invoke('user-state:save-scene-interaction-audit', file),
    loadSceneAssemblyAudit: (strict?: boolean) => ipcRenderer.invoke('user-state:load-scene-assembly-audit', strict),
    saveSceneAssemblyAudit: (file: unknown) => ipcRenderer.invoke('user-state:save-scene-assembly-audit', file),
    getRoot: () => ipcRenderer.invoke('user-state:get-root'),
  },
  cognitionManager: {
    open: () => ipcRenderer.invoke('cognition-manager:open'),
    setBusy: (busy: boolean) => ipcRenderer.send('cognition-manager:busy', busy),
  },
  agent: {
    dataVersion: () => ipcRenderer.invoke('agent:data-version'),
    queryProfile: (request?: { includeEvidence?: boolean }) => ipcRenderer.invoke('agent:query-profile', request),
    queryMastery: (req: unknown) => ipcRenderer.invoke('agent:query-mastery', req),
    reviewQueue: () => ipcRenderer.invoke('agent:review-queue'),
    onDataChanged: (callback: (payload: unknown) => void) => {
      const handler = (_e: unknown, payload: unknown) => callback(payload);
      ipcRenderer.on('agent:data-changed', handler);
      return () => ipcRenderer.removeListener('agent:data-changed', handler);
    },
  },
  sceneInteractionPacks: {
    importPackage: () => ipcRenderer.invoke('scene-interaction-packs:import'),
    list: () => ipcRenderer.invoke('scene-interaction-packs:list'),
    load: (ref: { id: string; version: string }) => ipcRenderer.invoke('scene-interaction-packs:load', ref),
    readMaterial: (ref: { id: string; version: string }, id: string) => ipcRenderer.invoke('scene-interaction-packs:read-material', ref, id),
  },
  h5p: {
    list: () => ipcRenderer.invoke('h5p:list'),
    importPackage: () => ipcRenderer.invoke('h5p:import'),
    open: (id: string) => ipcRenderer.invoke('h5p:open', id),
    restart: (id: string) => ipcRenderer.invoke('h5p:restart', id),
  },
  sceneSkills: {
    getDir: () => ipcRenderer.invoke('scene-skills:get-dir'),
    loadManifest: () => ipcRenderer.invoke('scene-skills:load-manifest'),
    saveManifest: (manifest: unknown) => ipcRenderer.invoke('scene-skills:save-manifest', manifest),
    loadScene: (sceneId: string) => ipcRenderer.invoke('scene-skills:load-scene', sceneId),
    saveScene: (sceneId: string, spec: unknown) => ipcRenderer.invoke('scene-skills:save-scene', sceneId, spec),
    deleteScene: (sceneId: string) => ipcRenderer.invoke('scene-skills:delete-scene', sceneId),
    loadRoles: () => ipcRenderer.invoke('scene-skills:load-roles'),
    saveRoles: (file: unknown) => ipcRenderer.invoke('scene-skills:save-roles', file),
  },
  // S4 数理场景：SymPy 计算服务
  compute: {
    run: (req: unknown) => ipcRenderer.invoke('scene-compute:run', req),
    status: () => ipcRenderer.invoke('scene-compute:status'),
  },
  stt: {
    getStatus: () => ipcRenderer.invoke('stt:status'),
    getPort: () => ipcRenderer.invoke('stt:get-port'),
  },
  ragDocs: {
    processingContext:()=>ipcRenderer.invoke('ragDocs:processing-context'),
    chooseFiles: () => ipcRenderer.invoke('ragDocs:choose-files'),
    upload: (filePaths: string[]) => ipcRenderer.invoke('ragDocs:upload', filePaths),
    list: () => ipcRenderer.invoke('ragDocs:list'),
    setCategory: (docId: string, category?: string) => ipcRenderer.invoke('ragDocs:set-category', docId, category),
    maintain: (input: import('../services/documentMaintenance').DocumentMaintenanceCommand) => ipcRenderer.invoke('ragDocs:maintain', input),
    materialList: (scope: import('../services/textbook/materialTypes').MaterialScope) => ipcRenderer.invoke('ragDocs:material-list', scope),
    materialPrepare: (scope: import('../services/textbook/materialTypes').MaterialScope, docId: string) => ipcRenderer.invoke('ragDocs:material-prepare', scope, docId),
    materialCatalog: (request: import('../services/textbook/materialTypes').MaterialCatalogRequest) => ipcRenderer.invoke('ragDocs:material-catalog', request),
    materialRead: (request: import('../services/textbook/materialTypes').MaterialReadRequest) => ipcRenderer.invoke('ragDocs:material-read', request),
    materialSearch: (request: import('../services/textbook/materialTypes').MaterialSearchRequest) => ipcRenderer.invoke('ragDocs:material-search', request),
    materialImage: (request: import('../services/textbook/materialTypes').MaterialImageRequest) => ipcRenderer.invoke('ragDocs:material-image', request),
    preview: (docId: string, chunkId?: string) => ipcRenderer.invoke('ragDocs:preview', { docId, chunkId }),
    getStatus: (docId: string) => ipcRenderer.invoke('ragDocs:status', docId),
    retry: (docId: string) => ipcRenderer.invoke('ragDocs:retry', docId),
    resetArgumentV5: (docId:string)=>ipcRenderer.invoke('ragDocs:reset-argument-v5',docId),
    argumentV5View: (docId:string)=>ipcRenderer.invoke('ragDocs:argument-v5-view',docId),
    open: (docId: string) => ipcRenderer.invoke('ragDocs:open', docId),
    readingSource: (docId: string) => ipcRenderer.invoke('ragDocs:reading-source', docId),
    delete: (docId: string) => ipcRenderer.invoke('ragDocs:delete', docId),
    search: (query: string, k?: number, options?: unknown) => ipcRenderer.invoke('ragDocs:search', query, k, options),
    readArgumentEvidence: (anchors: unknown, query?:string, intentQuery?:string) => ipcRenderer.invoke('ragDocs:read-argument-evidence', anchors, query, intentQuery),
    recallDocumentGraphCandidates: (input: unknown, targetIds:string[]) => ipcRenderer.invoke('ragDocs:graph-candidates', input,targetIds),
    prepareDocumentGraph: (docId: string) => ipcRenderer.invoke('ragDocs:prepare-document-graph', docId),
    commitDocumentGraph: (input: unknown, environmentId?:string) => ipcRenderer.invoke('ragDocs:commit-document-graph', input,environmentId),
    prepareArgumentV5: (docId: string) => ipcRenderer.invoke('ragDocs:prepare-argument-v5', docId),
    commitArgumentV5: (input: unknown, environmentId: string) => ipcRenderer.invoke('ragDocs:commit-argument-v5', input, environmentId),
    recordArgumentV5Response: (input: unknown, environmentId:string)=>ipcRenderer.invoke('ragDocs:record-argument-v5-response',input,environmentId),
    recallArgumentV5Bridges: (input: unknown, environmentId: string) => ipcRenderer.invoke('ragDocs:argument-v5-bridges', input, environmentId),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('rag-docs:changed', handler);
      return () => ipcRenderer.removeListener('rag-docs:changed', handler);
    },
  },
  argumentContext: {
    getEnvironment: (selection?: import('./rag/argumentLearningScope').ArgumentEnvironmentSelection) => ipcRenderer.invoke('argument-context:get-environment', selection),
    read: (request: import('./rag/argumentProjectionRuntime').ArgumentProjectionReadonlyRequest) => ipcRenderer.invoke('argument-context:read', request),
    freezeQuestion: (environmentId: string, selectors: import('../services/argumentContext/questionBindingTypes').ArgumentQuestionFrameSelectors) => ipcRenderer.invoke('argument-context:freeze-question', environmentId, selectors),
    verifyQuestion: (environmentId: string, receipt: import('../services/argumentContext/questionReceipt').ArgumentQuestionReceipt) => ipcRenderer.invoke('argument-context:verify-question', environmentId, receipt),
    readQuestion: (environmentId: string, receipt: import('../services/argumentContext/questionReceipt').ArgumentQuestionReceipt) => ipcRenderer.invoke('argument-context:read-question', environmentId, receipt),
    readQuestionPropositions: (environmentId: string, receipt: import('../services/argumentContext/questionReceipt').ArgumentQuestionReceipt) => ipcRenderer.invoke('argument-context:read-question-propositions', environmentId, receipt),
  },
  argumentReference: {
    getEnvironment: () => ipcRenderer.invoke('argument-reference:get-environment'),
    prepare: (request: import('../services/argumentContext/referenceBuildTypes').ArgumentReferenceBuildSourceRequest) => ipcRenderer.invoke('argument-reference:prepare', request),
    status: (request: import('../services/argumentContext/referenceBuildTypes').ArgumentReferenceBuildSourceRequest) => ipcRenderer.invoke('argument-reference:status', request),
    run: (request: import('../services/argumentContext/referenceBuildTypes').ArgumentReferenceBuildRunRequest) => ipcRenderer.invoke('argument-reference:run', request),
    cancel: (request: import('../services/argumentContext/referenceBuildTypes').ArgumentReferenceBuildCancelRequest) => ipcRenderer.invoke('argument-reference:cancel', request),
    onChanged: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('argument-reference:changed', handler);
      return () => ipcRenderer.removeListener('argument-reference:changed', handler);
    },
    onInvalidated: (callback: () => void) => {
      const handler = () => callback();
      ipcRenderer.on('argument-reference:invalidated', handler);
      return () => ipcRenderer.removeListener('argument-reference:invalidated', handler);
    },
  },
  argumentReferenceRag: {
    getEnvironment: () => ipcRenderer.invoke('argument-reference-rag:get-environment'),
    prepare: (request: import('../services/argumentContext/referenceBuildTypes').ArgumentReferenceBuildSourceRequest) => ipcRenderer.invoke('argument-reference-rag:prepare', request),
    status: (request: import('../services/argumentContext/referenceBuildTypes').ArgumentReferenceBuildSourceRequest) => ipcRenderer.invoke('argument-reference-rag:status', request),
    run: (request: import('../services/argumentContext/referenceRagBuildTypes').ArgumentReferenceRagBuildRunRequest) => ipcRenderer.invoke('argument-reference-rag:run', request),
    cancel: (request: import('../services/argumentContext/referenceBuildTypes').ArgumentReferenceBuildCancelRequest) => ipcRenderer.invoke('argument-reference-rag:cancel', request),
    onChanged: (callback: () => void) => {
      const handler = () => callback(); ipcRenderer.on('argument-reference:changed', handler);
      return () => ipcRenderer.removeListener('argument-reference:changed', handler);
    },
    onInvalidated: (callback: () => void) => {
      const handler = () => callback(); ipcRenderer.on('argument-reference:invalidated', handler);
      return () => ipcRenderer.removeListener('argument-reference:invalidated', handler);
    },
  },
  ragKnowledge: {
    getSettings: () => ipcRenderer.invoke('ragKnowledge:get-settings'),
    setEnabled: (input: unknown) => ipcRenderer.invoke('ragKnowledge:set-enabled', input),
    getStatus: (docId: string) => ipcRenderer.invoke('ragKnowledge:get-status', docId),
    getPendingBatch: (maxChunks?: number) => ipcRenderer.invoke('ragKnowledge:get-pending-batch', maxChunks),
    commitBatch: (input: unknown) => ipcRenderer.invoke('ragKnowledge:commit-batch', input),
    markBatchFailed: (input: unknown) => ipcRenderer.invoke('ragKnowledge:mark-batch-failed', input),
    retryDocument: (docId: string) => ipcRenderer.invoke('ragKnowledge:retry-document', docId),
  },
  noteRag: {
    flushPending: () => ipcRenderer.invoke('noteRag:flush-pending'),
    setEditing: (active: boolean) => ipcRenderer.invoke('noteRag:editing', active),
    index: (input: import('../types').NoteRagIndexInput) => ipcRenderer.invoke('noteRag:index', input),
    indexAll: (inputs: import('../types').NoteRagIndexInput[]) => ipcRenderer.invoke('noteRag:index-all', inputs),
    delete: (noteId: string) => ipcRenderer.invoke('noteRag:delete', noteId),
    deleteMany: (noteIds: string[]) => ipcRenderer.invoke('noteRag:delete-many', noteIds),
    search: (query: string, k?: number, options?: { argumentEnvironmentId: string } | { allowedNoteIds: string[] }) => ipcRenderer.invoke('noteRag:search', query, k, options),
    status: (noteId: string) => ipcRenderer.invoke('noteRag:status', noteId),
    flowReviewStatus: (noteId: string) => ipcRenderer.invoke('noteRag:flow-review-status', noteId),
  },
  textbookRag: {
    search: (query: string, k: number | undefined, allowedNoteIds: string[]) => ipcRenderer.invoke('textbookRag:search', query, k, allowedNoteIds),
    status: (noteId: string) => ipcRenderer.invoke('textbookRag:status', noteId),
    rebuild: (noteId: string) => ipcRenderer.invoke('textbookRag:rebuild', noteId),
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
  argument: {
    open: (payload: unknown) => ipcRenderer.invoke('argument-editor:open', payload),
    save: (payload: unknown) => ipcRenderer.invoke('argument-editor:save', payload),
    delete: (docId: string) => ipcRenderer.invoke('argument-editor:delete', { docId }),
    writeApplied: (payload: unknown) => ipcRenderer.invoke('argument-editor:write-applied', payload),
    close: () => ipcRenderer.invoke('argument-editor:close'),
    openNote: (noteId: string) => ipcRenderer.invoke('argument-editor:open-note', noteId),
    onData: (callback: (data: unknown) => void) => {
      const handler = (_e: unknown, data: unknown) => callback(data);
      ipcRenderer.on('argument-editor:data', handler);
      return () => ipcRenderer.removeListener('argument-editor:data', handler);
    },
    onSaved: (callback: (payload: unknown) => void) => {
      const handler = (_e: unknown, payload: unknown) => callback(payload);
      ipcRenderer.on('argument-editor:saved', handler);
      return () => ipcRenderer.removeListener('argument-editor:saved', handler);
    },
    onDeleted: (callback: (payload: unknown) => void) => {
      const handler = (_e: unknown, payload: unknown) => callback(payload);
      ipcRenderer.on('argument-editor:deleted', handler);
      return () => ipcRenderer.removeListener('argument-editor:deleted', handler);
    },
    onOpenNote: (callback: (payload: unknown) => void) => {
      const handler = (_e: unknown, payload: unknown) => callback(payload);
      ipcRenderer.on('argument-editor:open-note', handler);
      return () => ipcRenderer.removeListener('argument-editor:open-note', handler);
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
