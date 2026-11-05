import { registerSceneInteractionPackIpc } from './sceneInteractionPackIpc';
import { registerH5pHost } from './h5pHost';
import { createMermaidProcessHost } from './mermaidProcess';
import { registerInteractiveFigureSandbox, setInteractiveFigureTheme } from './interactiveFigureSandbox';
import { InteractiveFigureStore } from './interactiveFigureStore';
import { interactiveFigureApproval } from './interactiveFigureApproval';
import { LearningPreparationQueue } from './learningPreparation';
import { prepareLearningStateMigration, copyLearningStateMigration } from './learningStateMigration';
import { preparationRoot, preparationGoal, mergePreparationResources, type LearningPreparationCommand } from '../services/progressiveLearning/preparation';
import { bindDownloadedProjectResources } from '../services/resourceDownloads';
import type { ResourceItem } from '../types';
import { classifyBrowserResource } from './resourceBrowserCore';
import { H5P_APPEARANCE_KEYS, normalizeH5pAppearance } from './h5pAppearance';
import {readCommunityLearningStatistics} from './communityLearningStatistics';
import { app, BrowserWindow, ipcMain, shell, dialog, session, nativeTheme, utilityProcess, safeStorage } from 'electron';
import {CommunityHost} from './communityHost';
import {communityDocumentAdapter} from './communityDocuments';
import {CommunityImportFence} from '../services/community/importSnapshot';
import { validateDocumentMaintenance, type DocumentMaintenanceCommand } from '../services/documentMaintenance';
import {RagComputeClient} from './ragComputeClient';
import { createApplicationShutdown, createExitRequestBroker, waitForShutdownStep } from './applicationShutdown';
import { acquireSingleInstance } from './singleInstance';
import { stopOwnedProcess, forceExitOwnApplication } from './ownedProcessShutdown';
import {setBackgroundRagCompute} from './rag/backgroundComputeBridge';
import { createArgumentEditorPersistence } from './argumentEditorPersistence';
import { loadFlowStatistics, recordFlowStatistics, backfillFlowStatistics } from './flowStatisticsStore';
import { spawn, type ChildProcess } from 'child_process';
import { autoUpdater } from 'electron-updater';
import path from 'path';
import os from 'os';
import net from 'net';
import fs from 'fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { configureWebAcquisition, webAcquisition } from './webAcquisition';
import { searchConceptEvidence } from './conceptWebResearch';
import { researchStormWeb } from './stormWebResearch';
import { researchPlanWeb } from './planWebResearch';
import { ResourceDownloadBatchStore, safeResourceDownloadError } from './resourceDownloadBatch';
import { downloadPublicResourceAttachment } from './resourceBrowser';
import { applyAgentTaskStatePatch, normalizeAgentTaskState, type AgentTaskStatePatch } from '../services/agent/taskStateCodec';
import { normalizeWindowTheme, resolvePreferredWindowTheme, windowThemeBackground, type WindowTheme } from '../services/ui/windowAppearance';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openSync, closeSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { serializeMetadata, deserializeVault, markdownFileMap } from '../services/vaultFsService';
import {
  splitUserStateFields,
  splitSharableFields,
  mergeNote,
  mergeLegacyNoteState,
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
  serializeStyleRawState,
  deserializeStyleRawState,
  serializeStyleSnapshotState,
  deserializeStyleSnapshotState,
  serializeStyleTrendState,
  deserializeStyleTrendState,
  serializeWordCloudState,
  deserializeWordCloudState,
  serializeLearningEpisodeState,
  deserializeLearningEpisodeState,
  USER_STATE_FILES,
} from '../services/userStateService';
import type { NoteItem, NoteRagIndexInput, UserNoteState, UploadedDocument, ResourceBrowserDownloadResult, ResourceWorkbenchCommitEvent, RagKnowledgeBatchCommit, RagKnowledgeDocumentStatus, RagKnowledgeSettings, DocumentSearchOptions } from '../types';
import {
  CURRENT_INDEX_SCHEMA_VERSION,
  setDataRoot,
  setModelsDir,
  readManifest,
  prepareDocumentManifestRecovery,
  commitDocumentSourceImports,
  updateManifest,
  deleteDocumentSourceFiles,
  deleteChunksFile,
  deleteStructuredDocumentFile,
  writeChunksFile,
  searchDocuments,
  vectorizeDocument,
  getDocumentsDir,
  getRagIndexDir,
  withDocumentSourceSnapshot,
  documentExists,
  getDocumentPreview,
  readChunksFile,
  generateEmbedding as generateRagEmbedding,
} from './ragIndex';
import { setPdfExtractScript } from './pdf';
import { readQaDocumentGraph } from './rag/qaDocumentGraphReader';
import {prepareDocumentGraphSource, commitDocumentGraph, recallDocumentGraphCandidates,listDocumentsWithGraphProgress} from './rag/documentGraphService';
import {prepareDocumentArgumentV5,commitDocumentArgumentV5,recallDocumentArgumentV5Bridges,resetDocumentArgumentV5,readDocumentArgumentV5View,recordDocumentArgumentV5Response} from './rag/documentArgumentV5Service';
import type {DocumentArgumentV5Commit} from '../services/documentArgumentV5Types';
import type {DocumentGraphCommit} from '../services/documentGraphTypes';
import {
  detectDocumentType,
  SUPPORTED_DOCUMENT_EXTENSIONS,
} from './documentParsers';
import { fingerprintMaterialSource, loadMaterial, materialVersion, prepareMaterial, materialMetadata, materialSourcePath } from './materialStore';
import { TextbookStore } from './textbookStore';
import { ProgressiveLearningStore } from './progressiveLearningStore';
import { ProgressiveDerivedQueue } from './progressiveDerivedQueue';
import { materializeProgressiveKnowledge } from './progressiveKnowledge';
import { readKnowledgeLifecycle } from './knowledgeLifecycle';
import type { ProgressiveCommand } from '../services/progressiveLearning/types';
import type { TextbookJobCommand } from '../services/textbook/generationTypes';
import { getMaterialCatalog, listMaterialDocuments, materialResult, prepareLocalMaterial, readMaterialPage, readMaterialImage } from './materialReader';
import { searchMaterialText } from './materialSearch';
import type { MaterialScope, MaterialCatalogRequest, MaterialReadRequest } from '../services/textbook/materialTypes';
import { atomicWriteTextFile } from './atomicWrite';
import { saveVaultSnapshot, withSavedVaultSnapshot, recoverVaultSnapshotInTransaction } from './vaultSnapshot';
import { saveVaultNotesDelta, validateVaultNotesDelta, readSavedVaultNotesByIds, readSavedVaultNoteIds } from './vaultNoteDelta';
import { createChangedNoteIndex, savedNoteIndexInput } from './changedNoteIndex';
import { acknowledgeNoteIndexCleanup, createNoteIndexCleanupWorker, readPendingNoteIndexCleanup, copyNoteIndexCleanupForMigration,
  validateNoteIndexCleanupIds } from './noteIndexCleanupJournal';
import { saveTextbookReadingPositions } from './textbookReadingSave';
import { savePersonalNoteState } from './personalNoteSave';
import { withRagSourceTransaction } from './ragSourceTransactions';
import { createArgumentProjectionEnvironmentRegistry } from './rag/argumentProjectionEnvironment';
import { createArgumentSearchBridge } from './rag/argumentSearchBridge';
import { readSavedArgumentReferenceNote, readSavedArgumentDocumentChunk } from './rag/argumentSavedSourceReader';
import { createArgumentQuestionRuntime } from './rag/argumentQuestionRuntime';
import { createArgumentReferenceBuildService } from './rag/argumentReferenceBuildService';
import { createArgumentReferenceRagBuildService } from './rag/argumentReferenceRagBuildService';
import { prepareStoredReferencePropositions } from './rag/referenceStoredPropositions';
import { createArgumentReferenceNoteSnapshotQueue } from './rag/argumentReferenceNoteObservations';
import type { ArgumentQuestionFrameSelectors } from '../services/argumentContext/questionBindingTypes';
import { loadCognition, mutateCognition } from './cognitionStore';
import { searchPersonalCognition } from './cognitionRetrieval';
import {
  commitKnowledgeBatch,
  deleteKnowledgeDocument,
  ensureKnowledgeJob,
  failKnowledgeBatch,
  getPendingKnowledgeBatch,
  readKnowledgeSettings,
  readKnowledgeStatus,
  recoverKnowledgeJobs,
  setKnowledgeDataRoot,
  writeKnowledgeSettings,
} from './rag/knowledgeStore.ts';
import { checkPublicResourceUrl } from './resourceHealth';
import {
  clearAllResourceAuthContainers,
  closeResourceBrowserSession,
  disposeResourceBrowserSessions,
  hasResourceWorkbenchAcceptedWrite,
  downloadResourceCandidate,
  beginResourceWorkbenchCommit,
  completeResourceWorkbenchCommit,
  getResourceWorkbenchPendingCommit,
  isResourceWorkbenchCommitActive,
  listResourceAuthContainers,
  openAuthenticatedCandidate,
  openResourceAuthContainer,
  removeResourceAuthContainer,
  resolveResourceAuthSession,
  scanResourceBrowserSession,
  searchConceptEvidenceInBrowser,
  navigateResourceWorkbench,
  searchResourcesInBrowser,
  setResourceWorkbenchDecision,
  setResourceWorkbenchDownload,
  updateResourceWorkbenchCommitState,
  setResourceBrowserUserStateDir,
  setResourceWorkbenchTheme,
  restoreResourceWorkbenchFocus,
} from './resourceBrowser';
import { initDataCenter, onWriteCommitted, getVersion as getDataVersion } from './dataCenter/store';
import { registerDataCenterHandlers } from './dataCenter/handlers';
import type { DataEntity } from './dataCenter/types';
import {
  proxyLlmRequest,
  streamLlmRequest,
  probeLlmRequest,
  discoverLlmModels,
  autoLink,
} from './apiHandlers';
import type {
  LlmIpcRequest,
  AutoLinkIpcRequest,
} from './ipcTypes';
import { assertLlmRequestProviderEnabled } from './llmProviderAuthority';
import {
  setNoteRagDataRoot,
  indexNote as noteRagIndexNote,
  indexNotes as noteRagIndexNotes,
  deleteNoteIndexes as noteRagDeleteIndexes,
  searchNotes as noteRagSearchNotes,
  getNoteIndexStatus,
} from './noteRag';
import { cleanupDeletedNoteIndexes } from './deletedNoteIndexCleanup';
import {
  getTextbookReferenceStatus,
  searchTextbookReferences,
  setTextbookReferenceDataRoot,
  syncTextbookReferenceNote,
  syncTextbookReferenceNotes,
  deleteTextbookReferenceNote,
} from './textbookReferenceRag.ts';
import { currentNoteReferenceInput, isCurrentNoteReferenceHit } from './rag/noteReferenceAuthority';
import { setFlowReviewArgumentDataRoot, syncSavedFlowReviewNotes, syncSavedFlowReviewNote, deleteSavedFlowReviewNote, getSavedFlowReviewStatus } from './rag/flowReviewArgumentIndex';
import {
  deleteUserArgumentNote,
  archiveLegacyUserArgumentShards,
  setUserArgumentDataRoot,
  syncUserArgumentNote,
  syncUserArgumentNotes,
} from './rag/userArgumentIndex.ts';
import { setCognitionMaterialDataRoot, syncCognitionMaterialNote, syncCognitionMaterialNotes,
  deleteCognitionMaterialNote, searchCognitionMaterials } from './cognitionMaterials.ts';
import {
  runSympyCommand,
  getSympyStatus,
  disposeSympyServer,
} from './sympyServer';
import type { ComputeCommand, ComputeIpcResponse } from '../types';
import { createDeferredNoteIndex } from '../services/deferredNoteIndex';
import { createStartupSnapshotTask } from './startupSnapshotTask';

// Keep multi-channel note updates in IPC arrival order, including full rebuilds
// and deletes, so an older graph rebuild cannot resurrect a newer deletion.
let noteSourceIndexQueue: Promise<unknown> = Promise.resolve();
function serializeNoteSourceIndex(work: () => Promise<void>): Promise<void> {
  const next = noteSourceIndexQueue.then(work);
  noteSourceIndexQueue = next.catch(() => undefined);
  return next;
}

const indexedSavedChannelKeys = new Map<string, string>();
const changedNoteIndex = createChangedNoteIndex({
  scope: () => JSON.stringify([getVaultRoot(), getUserStateDir(), referenceSourceWriteEpoch]),
  isCurrent: scope => !applicationExiting && !referenceEnvironmentSuspended
    && scope === JSON.stringify([getVaultRoot(), getUserStateDir(), referenceSourceWriteEpoch]),
  version: getDataVersion,
  read: ids => {
    const root = getVaultRoot(), states = getUserStateDir(), epoch = referenceSourceWriteEpoch;
    return readSavedVaultNotesByIds(root, states, ids, { isCurrent: () => !applicationExiting && !referenceEnvironmentSuspended
      && root === getVaultRoot() && states === getUserStateDir() && epoch === referenceSourceWriteEpoch });
  },
  sync: (channel, note) => {
    const input = savedNoteIndexInput(note);
    switch (channel) {
      case 'private-material': return syncCognitionMaterialNote(input);
      case 'knowledge': return noteRagIndexNote(input);
      case 'published-argument': return syncUserArgumentNote(input, generateRagEmbedding).then(() => {});
      case 'textbook': return syncTextbookReferenceNote(note);
      case 'flow-review': return syncSavedFlowReviewNote(note);
    }
  },
  retry: () => deferredChangedNoteIndex.request(),
});
const deferredChangedNoteIndex = createDeferredNoteIndex({
  run: () => serializeNoteSourceIndex(() => changedNoteIndex.run()),
  onError: () => console.warn('[note-rag] 变更笔记的后台索引待重试，已保存正文不受影响'),
});
const deferredNoteIndex: ReturnType<typeof createDeferredNoteIndex> = createDeferredNoteIndex({
  run: () => {
    const root = getVaultRoot(), states = getUserStateDir(), epoch = referenceSourceWriteEpoch;
    const current = () => !applicationExiting && !referenceEnvironmentSuspended && root === getVaultRoot()
      && states === getUserStateDir() && epoch === referenceSourceWriteEpoch;
    return serializeNoteSourceIndex(async () => {
      if (!current()) return;
      const version = getDataVersion(), notes = await loadMergedNotes();
      if (!current()) return;
      if (version !== getDataVersion()) { deferredNoteIndex.request(); return; }
      const inputs: NoteRagIndexInput[] = notes.map(note => ({ id: note.id, title: note.title, noteType: note.noteType,
        content: note.content, updatedAt: note.updatedAt, textbook: note.textbook, generatedContentBlocks: note.generatedContentBlocks,
        learningReviewRecords: note.learningReviewRecords, referenceSources: note.referenceSources,
        publishedArguments: (note.argumentDocs || []).flatMap(doc => doc.rag?.publishedSnapshot
          ? [{ argumentDocId: doc.doc_id, snapshot: doc.rag.publishedSnapshot }] : []) }));
      const snapshotKey = createHash('sha256').update(JSON.stringify([root, states, epoch, inputs])).digest('hex');
      const fresh = () => current() && version === getDataVersion();
      const channels = [
        ['private-material', () => syncCognitionMaterialNotes(inputs)],
        ['knowledge', () => noteRagIndexNotes(notes)],
        ['published-argument', () => syncUserArgumentNotes(inputs, generateRagEmbedding)],
        ['textbook', () => syncTextbookReferenceNotes(notes)],
        ['flow-review', () => syncSavedFlowReviewNotes(notes)],
      ] as const;
      const failures: Array<{ channel: string; error: unknown }> = [];
      for (const [channel, work] of channels) {
        if (!fresh()) { deferredNoteIndex.request(); return; }
        if (indexedSavedChannelKeys.get(channel) === snapshotKey) continue;
        try {
          await work();
          if (!fresh()) { deferredNoteIndex.request(); return; }
          indexedSavedChannelKeys.set(channel, snapshotKey);
          changedNoteIndex.remember(channel, notes);
        } catch (error) {
          if (!fresh()) { deferredNoteIndex.request(); return; }
          // One unavailable source must not block the other independent lanes.
          failures.push({ channel, error });
        }
      }
      if (failures.length) throw new AggregateError(failures.map(item => item.error),
        `note_index_channels_failed: ${failures.map(item => item.channel).join(',')}`);
    });
  },
  onError: () => console.warn('[note-rag] 后台索引未完成，已保存正文不受影响；可重试或重启后补齐'),
});

let noteCleanupWorker: { key: string; worker: ReturnType<typeof createNoteIndexCleanupWorker> } | undefined;
function resumeDeletedNoteIndexCleanup(): Promise<void> {
  if (referenceEnvironmentSuspended || applicationExiting) return Promise.resolve();
  const root = getVaultRoot(), states = getUserStateDir(), epoch = referenceSourceWriteEpoch;
  const key = JSON.stringify([root, states, epoch]);
  if (noteCleanupWorker?.key !== key) {
    noteCleanupWorker?.worker.stop();
    const isCurrent = () => !referenceEnvironmentSuspended && !applicationExiting
      && root === getVaultRoot() && states === getUserStateDir() && epoch === referenceSourceWriteEpoch;
    const worker = createNoteIndexCleanupWorker({
      isCurrent,
      read: () => readPendingNoteIndexCleanup(root, states, isCurrent),
      acknowledge: jobs => acknowledgeNoteIndexCleanup(root, states, jobs, isCurrent),
      clean: ids => serializeNoteSourceIndex(async () => {
        const version = getDataVersion();
        const currentVersion = () => isCurrent() && version === getDataVersion();
        await cleanupDeletedNoteIndexes(ids, {
          isCurrent: currentVersion,
          readLiveIds: () => readSavedVaultNoteIds(root, states, currentVersion),
          removeReferences: noteRagDeleteIndexes,
          removeDerivatives: async id => {
            await deleteUserArgumentNote(id);
            if (!currentVersion()) throw new Error('资料库已变化，后续索引清理已停止');
            await deleteCognitionMaterialNote(id);
            if (!currentVersion()) throw new Error('资料库已变化，后续索引清理已停止');
            await deleteTextbookReferenceNote(id);
            if (!currentVersion()) throw new Error('资料库已变化，后续索引清理已停止');
            await deleteSavedFlowReviewNote(id);
            changedNoteIndex.forget([id]);
          },
        });
      }),
    });
    noteCleanupWorker = { key, worker };
  }
  return noteCleanupWorker.worker.wake();
}
function retryDeletedNoteIndexCleanup(): void {
  void resumeDeletedNoteIndexCleanup().catch(error => console.warn('[note-rag] 待清理记录已保留，后续保存或重启将重试', error));
}

let sttProcess: ChildProcess | null = null;
let applicationExiting = false;
let sttPort: number = 0;
let mainWindow: BrowserWindow | null = null;
let mermaidProcess: ReturnType<typeof createMermaidProcessHost> | undefined;
let disposeInteractiveFigure: (() => void) | undefined;
let argumentWindow: BrowserWindow | null = null;
let cognitionWindow: BrowserWindow | null = null;
let cognitionWindowBusy = false;
const argumentPersistence = createArgumentEditorPersistence();
const pendingResourceWorkbenchCommits = new Map<string, string>();
let currentWindowTheme: WindowTheme = 'light';
let windowThemeReady = false;

function publishWindowTheme(theme: WindowTheme): void {
  currentWindowTheme = theme;
  windowThemeReady = true;
  setResourceWorkbenchTheme(theme);
  setInteractiveFigureTheme(theme);
  void h5pHost?.updateAppearance().catch(error => console.warn('[h5p] 主题同步失败', error));
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.setBackgroundColor(windowThemeBackground(theme));
    win.webContents.send('window:theme-changed', theme);
  }
}
const activeLlmRequests = new Map<string, AbortController>();
let h5pHost: ReturnType<typeof registerH5pHost> | undefined;
let scenePackHost: ReturnType<typeof registerSceneInteractionPackIpc> | undefined;
const stormSearchRequests = new Map<string, AbortController>();
const planSearchRequests = new Map<string, AbortController>();

function llmRequestKey(senderId: number, requestId: string): string {
  return `${senderId}:${requestId}`;
}
/** 待推送给编辑器窗口的数据（窗口尚未就绪时缓存） */
let pendingArgumentData: unknown = null;

// ===== Main owns scheduling/persistence; isolated utility processes own CPU work. =====
const vectorizationQueue: string[] = [];
let vectorizing = false;
let vectorizationDrain:Promise<void>=Promise.resolve();
let documentRecoveryWriting = false;
let activeVectorizationDocument:string|undefined;
let backgroundGeneration=0;
let documentCompute:RagComputeClient|undefined,embeddingCompute:RagComputeClient|undefined;
let progressiveDerived: ProgressiveDerivedQueue | undefined;
let progressiveLearning: ProgressiveLearningStore | undefined;
let learningPreparation: LearningPreparationQueue | undefined;
let learningMigrationPending = false;
const indexProgress=new Map<string,{completed:number;total:number}>();
function stopBackgroundCompute(){
  backgroundGeneration++;vectorizationQueue.length=0;indexProgress.clear();
  documentCompute?.cancelAll('资料库环境已变化，后台任务已停止');
  embeddingCompute?.cancelAll('资料库环境已变化，后台任务已停止');
  return Promise.all([vectorizationDrain, progressiveDerived?.stop(), learningPreparation?.stop()]).then(() => undefined);
}
function configureBackgroundCompute(){
  const configuration=()=>({modelsDir:resolveModelsDir(),pdfExtractScript:app.isPackaged
    ?path.join(process.resourcesPath,'python','pdf_extract.py'):path.join(app.getAppPath(),'python','pdf_extract.py')});
  const spawnCompute=(name:string)=>()=>utilityProcess.fork(path.join(__dirname,'rag-compute.cjs'),[],{
    serviceName:name,stdio:'ignore',execArgv:['--max-old-space-size=768'],
  });
  documentCompute=new RagComputeClient(spawnCompute('资料解析与正文索引'),configuration);
  embeddingCompute=new RagComputeClient(spawnCompute('本地检索与论证向量'),configuration);
  let lastNotification=0;
  setBackgroundRagCompute({
    parse:(filePath,fileType,docId)=>documentCompute!.run('parse',{filePath,fileType,docId}),
    vectorize:(docId,fileName,text,structured)=>documentCompute!.run('vectorize',{docId,fileName,text,structured},value=>{
      indexProgress.set(docId,value);
      if(Date.now()-lastNotification>1000||value.completed===value.total){lastNotification=Date.now();notifyRagChanged();}
    }),
    embed:texts=>embeddingCompute!.run('embed',{texts}),
    chunkTextbook:input=>embeddingCompute!.run('chunk-textbook',{input}),
  });
}

function notifyRagChanged(): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('rag-docs:changed');
  }
}

async function persistKnowledgeStatus(status: RagKnowledgeDocumentStatus): Promise<void> {
  await updateManifest(status.docId, {
    knowledgeStatus: status.status,
    knowledgeGenerationId: status.generationId,
    knowledgeIndexedChunks: status.indexedChunks,
    knowledgeTotalChunks: status.totalChunks,
    knowledgeEntityCount: status.entityCount,
    knowledgeArgumentCount: status.argumentCount,
    knowledgeExtractorVersion: status.extractorVersion,
    knowledgePromptVersion: status.knowledgePromptVersion,
    knowledgeError: status.error,
  });
}

/** 处理单个文档的向量化：parse → chunk → embed → 写 chunks → ready */
async function processOneVectorization(docId: string): Promise<void> {
  const generation=backgroundGeneration;
  const check=async()=>{if(generation!==backgroundGeneration||referenceEnvironmentSuspended||!(await documentExists(docId)))throw new Error('资料已删除或处理环境变化，停止旧索引写入');};
  // 删除取消检查：若该文档已被删除，跳过并清理半成品
  if (!(await documentExists(docId))) {
    if(generation!==backgroundGeneration||referenceEnvironmentSuspended)return;
    await deleteChunksFile(docId);
    await deleteStructuredDocumentFile(docId);
    await deleteKnowledgeDocument(docId);
    return;
  }

  const manifest = await readManifest();
  const doc = manifest.find((d) => d.id === docId);
  if (!doc) return;
  await check();

  if (!doc.indexable) {
    await updateManifest(docId, { status: 'stored', chunkCount: 0, totalChars: 0, error: undefined });
    notifyRagChanged();
    return;
  }

  await updateManifest(docId, { status: 'processing', chunkCount: 0, totalChars: 0 });
  notifyRagChanged();

  try {
    // L0 原文先于 L1 向量落地，模型缺失时保留可定位的本地教材物料。
    const materialScope = { allowedDocIds: [docId] };
    const structured = await prepareMaterial(materialScope, docId,{assertCurrent:check});
    await check();
    const trimmed = structured.normalizedText.trim();
    if (!trimmed) {
      throw new Error(
        doc.fileType === 'pdf'
          ? '该 PDF 可能为扫描件或无可抽取文本层，暂不支持 OCR'
          : '文档内容为空',
      );
    }

    const chunks = await vectorizeDocument(docId, doc.fileName, structured.normalizedText, structured);
    if (chunks.length === 0) {
      throw new Error('未生成有效分块');
    }
    await loadMaterial(materialScope, docId, materialVersion(structured));
    await check();
    await writeChunksFile(docId, chunks,{assertCurrent:check});
    let knowledgePatch: Partial<UploadedDocument> = { knowledgeStatus: 'disabled' };
    try {
      const knowledgeSettings = await readKnowledgeSettings();
      if (knowledgeSettings.enabled && doc.processingPolicy !== 'body_only') {
        const knowledgeStatus = await ensureKnowledgeJob(docId, chunks, true);
        knowledgePatch = {
          knowledgeStatus: knowledgeStatus.status,
          knowledgeGenerationId: knowledgeStatus.generationId,
          knowledgeIndexedChunks: knowledgeStatus.indexedChunks,
          knowledgeTotalChunks: knowledgeStatus.totalChunks,
          knowledgeEntityCount: knowledgeStatus.entityCount,
          knowledgeArgumentCount: knowledgeStatus.argumentCount,
          knowledgeExtractorVersion: knowledgeStatus.extractorVersion,
          knowledgePromptVersion: knowledgeStatus.knowledgePromptVersion,
          knowledgeError: knowledgeStatus.error,
        };
      }
    } catch (knowledgeError) {
      knowledgePatch = {
        knowledgeStatus: 'failed',
        knowledgeError: knowledgeError instanceof Error ? knowledgeError.message : 'knowledge job 初始化失败',
      };
    }
    await check();
    await updateManifest(docId, {
      status: 'ready',
      chunkCount: chunks.length,
      totalChars: trimmed.length,
      indexSchemaVersion: CURRENT_INDEX_SCHEMA_VERSION,
      needsReindex: false,
      error: undefined,
      ...knowledgePatch,
    });
  } catch (e: any) {
    console.warn('[rag] 向量化失败:', doc.fileName, e?.message);
    if(generation===backgroundGeneration&&!referenceEnvironmentSuspended)await updateManifest(docId, { status: 'failed', error: e?.message || '向量化失败' });
  }
  indexProgress.delete(docId);
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
        activeVectorizationDocument=docId;
        try {
          await processOneVectorization(docId);
        } catch (e) {
          console.warn('[rag] 队列处理异常:', e);
        } finally {
          activeVectorizationDocument=undefined;
        }
      }
    }
  } finally {
    vectorizing = false;
  }
}

function enqueueVectorization(docId: string): void {
  if(activeVectorizationDocument===docId||vectorizationQueue.includes(docId))return;
  vectorizationQueue.push(docId);
  if(!vectorizing)vectorizationDrain=drainVectorizationQueue();
}

/** 物理存储文件名：docId + 原扩展名（避免原始文件名重名冲突） */
function storedFileName(id: string, ext: string): string {
  return `${id}${ext}`;
}

async function importRagDocumentPaths(
  filePaths: unknown,
  sourceUrl?: string,
): Promise<{ ok: boolean; documents?: UploadedDocument[]; error?: string }> {
  try {
    if (referenceEnvironmentSuspended) return { ok: false, error: '存储操作中，请稍后上传' };
    const writeEpoch = referenceSourceWriteEpoch;
    const paths = Array.isArray(filePaths) ? (filePaths as string[]).filter((item) => typeof item === 'string') : [];
    if (paths.length === 0) return { ok: false, error: '未选择文件' };

    const created: UploadedDocument[] = [];
    const sources: string[] = [];
    for (const src of paths) {
      const fileName = path.basename(src);
      const descriptor = detectDocumentType(fileName);
      if (!descriptor) {
        console.warn('[rag] 跳过不支持的格式:', fileName);
        continue;
      }
      const stat = await fs.stat(src);
      if (stat.size > 100 * 1024 * 1024) {
        console.warn('[rag] 跳过超过 100 MB 的文件:', fileName);
        continue;
      }
      const id = `doc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      sources.push(src);
      created.push({
        id,
        fileName,
        fileType: descriptor.fileType,
        extension: descriptor.extension,
        indexable: descriptor.indexable,
        size: stat.size,
        status: descriptor.indexable ? 'pending' : 'stored',
        chunkCount: 0,
        totalChars: 0,
        knowledgeStatus: 'disabled',
        sourceUrl,
        uploadAt: new Date().toISOString(),
      });
    }
    if (created.length === 0) return { ok: false, error: '没有可保存的支持文件，或文件超过 100 MB' };
    await commitDocumentSourceImports(created.map((document, index) => ({ document, sourcePath: sources[index] })),
      () => !referenceEnvironmentSuspended && writeEpoch === referenceSourceWriteEpoch);
    referenceEnvironments.revoke();
    revokeReferenceBuilds();
    created.filter((document) => document.indexable).forEach((document) => enqueueVectorization(document.id));
    notifyRagChanged();
    return { ok: true, documents: created };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : '上传失败' };
  }
}

/** Local body work only. Never resumes a paid argument extraction request. */
async function recoverBodyIndexQueue(isCurrent:()=>boolean=()=>!referenceEnvironmentSuspended):Promise<void>{
  if(!isCurrent())return;
  const manifest=await readManifest();
  for(const d of manifest){
    if(!isCurrent())return;
    if(d.indexable&&(d.status==='processing'||d.status==='pending')){
      await updateManifest(d.id,{status:'pending'});
      if(isCurrent())enqueueVectorization(d.id);
    }
  }
  notifyRagChanged();
}

/** Startup recovery also initializes existing local knowledge job metadata. */
async function recoverProcessingDocs(): Promise<void> {
  try {
    await recoverBodyIndexQueue();
    const manifest = await readManifest();
    await recoverKnowledgeJobs(manifest.filter((doc) => doc.indexable).map((doc) => doc.id));
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

// The lock belongs to the selected data directory. Take it before ready-time
// IPC, recovery queues, Python services, or the main window can be initialized.
const singleInstance = acquireSingleInstance({
  app,
  getWindow: () => mainWindow,
  canActivate: () => !applicationExiting && applicationShutdown.getPhase() === 'idle',
});

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

/** 应用板块·场景 Skill 包目录（<vaultRoot>/scene-skills，随 vault 导出/迁移） */
function getSceneSkillsDir(): string {
  return path.join(getVaultRoot(), 'scene-skills');
}

/** 确保场景包目录存在（首次调用自动递归创建 manifest 所在目录与 scenes/ 子目录） */
async function ensureSceneSkillsDir(): Promise<string> {
  const dir = getSceneSkillsDir();
  await fs.mkdir(path.join(dir, 'scenes'), { recursive: true });
  return dir;
}

/** 场景 id 安全校验：仅允许字母/数字/连字符/下划线，防止路径穿越 */
function safeSceneId(sceneId: unknown): string {
  const id = typeof sceneId === 'string' ? sceneId : '';
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error('非法场景 id');
  return id;
}

function getUserStateDir(): string {
  return path.join(getDataRoot(), 'user-state');
}

let referenceEnvironmentSuspended = false;
let referenceSourceWriteEpoch = 0;
const startupFlowStatistics = createStartupSnapshotTask<{
  notes: NoteItem[]; vaultRoot: string; userStateDirectory: string;
}>({
  scope: () => applicationExiting || referenceEnvironmentSuspended ? undefined
    : JSON.stringify([getVaultRoot(), getUserStateDir(), referenceSourceWriteEpoch]),
  run: ({ notes, vaultRoot, userStateDirectory }, isCurrent) =>
    withRagSourceTransaction([vaultRoot, userStateDirectory], async () => {
      if (!isCurrent()) return;
      await backfillFlowStatistics(userStateDirectory, notes);
    }),
  onError: () => console.warn('[flow-statistics] 复盘统计恢复未完成，原事件和旧周报未改动'),
});
const referenceEnvironments = createArgumentProjectionEnvironmentRegistry(() => ({
  dataRoot: getDataRoot(), vaultRoot: getVaultRoot(), userStateDir: getUserStateDir(),
}), () => !referenceEnvironmentSuspended);
const referenceQuestions = createArgumentQuestionRuntime(referenceEnvironments, { preparePropositions: prepareStoredReferencePropositions });
// Build confirmations must not replace an in-progress review's fixed-reference lease.
const referenceBuildEnvironments = createArgumentProjectionEnvironmentRegistry(() => ({
  dataRoot: getDataRoot(), vaultRoot: getVaultRoot(), userStateDir: getUserStateDir(),
}), () => !referenceEnvironmentSuspended);
const referenceBuilds = createArgumentReferenceBuildService({ environments: referenceBuildEnvironments, draftProtocol: 'selection-v2',
  reviewProtocol: 'task-grounded-v3' });
const referenceRagBuilds = createArgumentReferenceRagBuildService({ environments: referenceBuildEnvironments, structure: referenceBuilds,
  propositionDraftProtocol: 'owned-parent-choice-v3' });
const referenceNoteSnapshotSaves = createArgumentReferenceNoteSnapshotQueue();
function revokeReferenceBuilds(owner?: number): void {
  referenceRagBuilds.revoke(owner);
  referenceBuilds.revoke(owner);
  referenceBuildEnvironments.revoke(owner);
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()
    && (owner === undefined || mainWindow.webContents.id === owner)) mainWindow.webContents.send('argument-reference:invalidated');
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

async function readUserStateFileIfExists(fileName: string, directory = getUserStateDir(), strict = false): Promise<string | null> {
  try {
    return await fs.readFile(path.join(directory, fileName), 'utf-8');
  } catch (error) {
    if (strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return null;
  }
}

const userStateWriteQueues = new Map<string, Promise<void>>();

function mapEntityFromFileName(fileName: string): DataEntity | null {
  if (fileName === USER_STATE_FILES.noteStates) return 'notes';
  if (fileName === USER_STATE_FILES.profile || fileName === USER_STATE_FILES.styleSnapshot) return 'profile';
  if (fileName === USER_STATE_FILES.learningEpisodes) return 'episodes';
  return null;
}

async function writeUserStateFileUnlocked(directory: string, fileName: string, content: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true });
  const strategy = await atomicWriteTextFile(path.join(directory, fileName), content);
  if (strategy === 'copy-fallback') {
    console.warn(`[user-state] Windows 文件锁阻止原子替换，已安全覆盖写入: ${fileName}`);
  }
}

async function writeUserStateFile(fileName: string, content: string): Promise<void> {
  if (referenceEnvironmentSuspended) throw new Error('存储操作中，请稍后保存');
  const writeEpoch = referenceSourceWriteEpoch;
  const directory = getUserStateDir(), target = path.join(directory, fileName);
  const previous = userStateWriteQueues.get(target) || Promise.resolve();
  const write = previous.catch(() => {}).then(() => withRagSourceTransaction([directory], async () => {
    if (referenceEnvironmentSuspended || writeEpoch !== referenceSourceWriteEpoch) throw new Error('rag_source_environment_changed');
    return writeUserStateFileUnlocked(directory, fileName, content);
  }));
  userStateWriteQueues.set(target, write);
  try {
    await write;
    try { onWriteCommitted(mapEntityFromFileName(fileName)); } catch { /* 数据中心失效失败不得影响已完成的用户数据写入 */ }
  } finally {
    if (userStateWriteQueues.get(target) === write) userStateWriteQueues.delete(target);
  }
}

/** Wait for earlier model edits before checking an incoming renderer's saved supplier. */
async function readLlmProviderAuthoritySettings() {
  const directory = getUserStateDir();
  const queued = userStateWriteQueues.get(path.join(directory, USER_STATE_FILES.llm));
  if (queued) await queued;
  const text = await readUserStateFileIfExists(USER_STATE_FILES.llm, directory, true);
  if (directory !== getUserStateDir()) throw new Error('模型配置的资料库已变化，请重新打开后重试。');
  const settings = text === null ? null : deserializeLlmState(text);
  if (text !== null && (!settings || !Array.isArray(settings.providers))) throw new Error('模型配置文件格式错误，请重新读取模型配置。');
  return settings;
}

/**
 * 一次性迁移 + 读取合并：读 vault（仅内容）与 user-state（个人状态），合并出完整 NoteItem[]。
 * 兼容旧版：若 metadata.json 里仍混有个人字段（旧格式），自动剥离到 user-state。
 */
async function loadMergedNotes(): Promise<NoteItem[]> {
  if (referenceEnvironmentSuspended) throw new Error('存储操作中，请稍后读取');
  const readEpoch = referenceSourceWriteEpoch;
  const root = getVaultRoot(), userStateDirectory = getUserStateDir();
  return withSavedVaultSnapshot(root, userStateDirectory, async () => {
  await fs.mkdir(path.join(root, 'notes'), { recursive: true });

  let contentNotes: NoteItem[] = [];
  let metaText: string;
  try {
    metaText = await fs.readFile(path.join(root, 'metadata.json'), 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const files = await fs.readdir(path.join(root, 'notes'));
    if (files.some(file => file.endsWith('.md'))) throw new Error('笔记索引缺失，但正文仍存在；未初始化或覆盖笔记库');
    return [];
  }
  {
    const metadata = JSON.parse(metaText);
    if (!metadata || typeof metadata.notesMeta !== 'object' || metadata.notesMeta === null || Array.isArray(metadata.notesMeta)) {
      throw new Error('笔记索引格式错误，未初始化或覆盖笔记库');
    }
    const notesDir = path.join(root, 'notes');
    const files = await fs.readdir(notesDir);
    const mdMap = new Map<string, string>();
    for (const f of files) {
      if (f.endsWith('.md')) {
        mdMap.set(f, await fs.readFile(path.join(notesDir, f), 'utf-8'));
      }
    }
    // deserializeVault 返回的是 metadata 里的字段（旧格式可能含个人字段）
    for (const id of Object.keys(metadata.notesMeta)) {
      if (!mdMap.has(`${id}.md`)) throw new Error(`笔记正文缺失（${id}），未以空白正文替换`);
    }
    contentNotes = deserializeVault(metaText, mdMap);
  }

  // 是否旧格式混有个人字段 → 触发迁移
  let needsMigration = false;
  for (const n of contentNotes) {
    if (hasAnyUserState(splitUserStateFields(n))) {
      needsMigration = true;
      break;
    }
  }

  // Permission/parse errors must not erase learning completion state.
  let stateText: string | null = null;
  try { stateText = await fs.readFile(path.join(userStateDirectory, USER_STATE_FILES.noteStates), 'utf-8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (stateText !== null) {
    const stateFile = JSON.parse(stateText);
    if (!stateFile || typeof stateFile.noteStates !== 'object' || stateFile.noteStates === null || Array.isArray(stateFile.noteStates)) {
      throw new Error('笔记学习状态格式错误，未覆盖原有状态');
    }
  }
  let noteStates: Record<string, UserNoteState> = stateText ? deserializeUserStateFile(stateText) : {};

  if (needsMigration) {
    // 旧格式：把混在 metadata 里的个人字段剥出来写进 user-state，metadata 重写为纯内容
    const mergedStates: Record<string, UserNoteState> = {};
    for (const n of contentNotes) {
      const st = splitUserStateFields(n);
      if (hasAnyUserState(st)) mergedStates[n.id] = mergeLegacyNoteState(st, noteStates[n.id]);
    }
    noteStates = { ...noteStates, ...mergedStates };
    contentNotes = contentNotes.map(splitSharableFields);
  }

  // Validate every merged note before removing any legacy inline source. A damaged
  // or unsupported private snapshot must fail without erasing the valid old copy.
  const mergedNotes = contentNotes.map((n) => mergeNote(n, noteStates[n.id]));
  if (needsMigration) {
    const personalText = serializeUserStateFile(noteStates);
    const metadataText = serializeMetadata(contentNotes);
    await writeUserStateFileUnlocked(userStateDirectory, USER_STATE_FILES.noteStates, personalText);
    // Private state remains first, so a failed metadata replacement retains a valid source.
    await atomicWriteTextFile(path.join(root, 'metadata.json'), metadataText);
  }
  return mergedNotes;
  }, () => !referenceEnvironmentSuspended && readEpoch === referenceSourceWriteEpoch);
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
  if (applicationExiting) return;
  const isPackaged = app.isPackaged;
  const modelsDir = resolveModelsDir();
  const logPath = path.join(getDataRoot(), 'stt_server.log');

  try {
    sttPort = await getFreePort();
  } catch (e) {
    console.warn('[stt] 获取空闲端口失败，使用默认 8765:', e);
    sttPort = 8765;
  }
  // A close during the asynchronous port probe must not spawn an orphan later.
  if (applicationExiting) return;

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
      if (sttProcess === child) sttProcess = null;
    });
    child.on('exit', (code) => {
      console.log('[stt] STT 后端退出，code =', code);
      if (sttProcess === child) sttProcess = null;
    });
  } catch (e) {
    console.warn('[stt] spawn 异常:', e);
  }
}

const communityImportFence=new CommunityImportFence();
let communityHost:CommunityHost|null=null;
function registerCommunityHost():void{
  const api=process.env.LOGINOTE_COMMUNITY_API_URL?.replace(/\/$/,'')||(!app.isPackaged?'http://127.0.0.1:5180/api/community/v1':'');
  const origin=process.env.LOGINOTE_COMMUNITY_WEB_ORIGIN||(api.startsWith('http://127.0.0.1:5180/')?'http://127.0.0.1:5174':api?new URL(api).origin:'');
  communityHost=new CommunityHost({apiUrl:api,origin,
    environment:()=>{if(referenceEnvironmentSuspended||applicationExiting)throw Error('存储正在切换，请稍后操作。');return {vaultRoot:getVaultRoot(),userStateDir:getUserStateDir(),dataRoot:getDataRoot(),epoch:referenceSourceWriteEpoch};},
    loadNotes:loadMergedNotes,
    progressiveTeaching:id=>progressiveLearning?.exportTeaching(id)||Promise.resolve(null),
    readLearningStatistics:environment=>readCommunityLearningStatistics(environment.userStateDir),
    changeNotes:async(change,isCurrent)=>{await referenceNoteSnapshotSaves.run(async()=>{if(!isCurrent()||referenceEnvironmentSuspended)throw Error('知识库已切换。');const notes=await loadMergedNotes();const next=change(notes);if(next!==notes){communityImportFence.observe(notes,next);referenceBuilds.observeNoteSnapshot(next,notes);referenceRagBuilds.observeNoteSnapshot(next,notes);await saveVaultSnapshot(getVaultRoot(),getUserStateDir(),next,atomicWriteTextFile,()=>!referenceEnvironmentSuspended&&isCurrent());}});onWriteCommitted('notes');mainWindow?.webContents.send('community:notes-changed');},
    ...communityDocumentAdapter(enqueueVectorization,()=>{referenceEnvironments.revoke();revokeReferenceBuilds();notifyRagChanged();}),
    encrypt:value=>safeStorage.isEncryptionAvailable()?safeStorage.encryptString(value).toString('base64'):null,
    decrypt:value=>{if(!safeStorage.isEncryptionAvailable())throw Error('安全存储不可用。');return safeStorage.decryptString(Buffer.from(value,'base64'));},
  });
  const trusted=(event:Electron.IpcMainInvokeEvent)=>{if(!mainWindow||event.sender!==mainWindow.webContents||event.senderFrame!==event.sender.mainFrame)throw Error('社区操作仅限主窗口。');return communityHost!;};
  ipcMain.handle('community:state',event=>trusted(event).state());
  ipcMain.handle('community:connect',event=>trusted(event).connect());
  ipcMain.handle('community:disconnect',event=>trusted(event).disconnect());
  ipcMain.handle('community:focus',(event,enabled)=>trusted(event).setFocus(enabled));
  ipcMain.handle('community:references',event=>trusted(event).references());
  ipcMain.handle('community:snapshot',(event,id)=>trusted(event).snapshot(id));
  ipcMain.handle('community:catalog',event=>trusted(event).catalog());
  ipcMain.handle('community:prepare',(event,input)=>trusted(event).prepare(input));
  ipcMain.handle('community:prepare-link',(event,url)=>trusted(event).prepareLink(url));
  ipcMain.handle('community:open-link',async(event,url)=>shell.openExternal(trusted(event).checkedLink(url)));
  ipcMain.handle('community:choose-file',async event=>{const host=trusted(event);const selected=await dialog.showOpenDialog(mainWindow!,{title:'选择要分享的主资源',properties:['openFile'],filters:[{name:'社区资源',extensions:['pdf','md','txt','docx','pptx','doc','ppt','xlsx','xls','zip','png','jpg','jpeg','webp']}]});if(selected.canceled||!selected.filePaths[0])return null;return host.prepareFile(selected.filePaths[0]);});
  ipcMain.handle('community:publish',(event,input)=>trusted(event).publish(input));
  ipcMain.handle('community:receive',event=>trusted(event).receiveNow());
  ipcMain.handle('community:templates',event=>trusted(event).templates());
  ipcMain.handle('community:activate',(event,input)=>trusted(event).activateTemplate(input));
  communityHost.start();
}

function registerIpcHandlers(): void {
  const resourceDownloadBatches = new ResourceDownloadBatchStore({ notes: loadMergedNotes, scope: getDataRoot,
    documents: readManifest, download: (resource, signal) => downloadPublicResourceAttachment(resource, mainWindow, signal),
    documentExists: async document => {
      if (!/^doc-[a-zA-Z0-9_-]+$/u.test(document.id) || !/^\.[a-z0-9]+$/iu.test(document.extension)) return false;
      try { return (await fs.stat(path.join(await getDocumentsDir(), document.id + document.extension))).isFile(); } catch { return false; }
    },
    importFile: (file, url) => importRagDocumentPaths([file], url) });
  const downloadOwners = new Set<number>();
  const preparationOwner = -1;
  const preparationCurrent = () => !referenceEnvironmentSuspended && !applicationExiting && !learningMigrationPending;
  const preparationAutomatic = async () => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.settings, getUserStateDir(), true);
    return !!text && deserializeSettingsState(text)?.resourceCollectionMode === 'auto';
  };
  const updatePreparedRoot = (rootId: string, change: (note: NoteItem) => NoteItem, allowed: () => void) => referenceNoteSnapshotSaves.run(async () => {
    allowed(); if (!preparationCurrent()) throw Error('资料准备环境已变化，请重启软件后继续');
    const [before] = await readSavedVaultNotesByIds(getVaultRoot(), getUserStateDir(), [rootId]);
    if (!before || before.parentId || !before.planMeta) throw Error('根项目不存在，未绑定资料');
    const note = change(before); if (note === before) return;
    await saveVaultNotesDelta(getVaultRoot(), getUserStateDir(), { upserts: [{ before, note }], removed: [] }, { isCurrent: preparationCurrent });
    onWriteCommitted('notes');
    mainWindow?.webContents.send('learning-preparation:changed', rootId, { noteId: rootId, before: before.resources || [], resources: note.resources || [], updatedAt: note.updatedAt });
  });
  learningPreparation = new LearningPreparationQueue(getUserStateDir(), {
    current: preparationCurrent, automatic: preparationAutomatic,
    notes: id => readSavedVaultNotesByIds(getVaultRoot(), getUserStateDir(), [id]),
    changed: id => mainWindow?.webContents.send('learning-preparation:changed', id),
    search: async (title, signal) => {
      const hits = await webAcquisition.search(`${[...title].slice(0, 100).join('')} 教材 公开课 学习资料`, 'agent-resource-curation', { count: 8, needContent: true, signal });
      if (hits) {
        const resources: ResourceItem[] = [];
        for (const hit of hits.slice(0, 6)) {
          signal.throwIfAborted(); const health = await checkPublicResourceUrl(hit.url); signal.throwIfAborted();
          if (!['available', 'redirected'].includes(health.status)) continue;
          const info = classifyBrowserResource({ title: hit.title, url: health.finalUrl || hit.url, contentType: health.contentType, downloadName: health.suggestedFileName });
          resources.push({ ...info, title: hit.title, url: hit.url, kind: 'online', accessType: 'public', verifiedAt: health.checkedAt,
            description: (hit.content || hit.snippet).slice(0, 1800), platform: new URL(hit.url).hostname });
          if (resources.length === 3) break;
        }
        return resources;
      }
      const result = await searchResourcesInBrowser({ projectTitle: title, rootProjectTitle: title, taskText: `学习${title}`, knowledgeTitles: [title],
        interactionMode: 'auto', source: 'note-editor', draftSessionId: `preparation-${randomUUID()}`, maxResults: 8 }, mainWindow, false, signal);
      closeResourceBrowserSession(result.sessionId); return result.resources;
    },
    collect: async (job, resources, signal) => {
      const allowed = () => { signal.throwIfAborted(); if (!preparationCurrent()) throw Error('资料准备环境已变化'); };
      const permitted = async () => { allowed(); if (job.automatic && !await preparationAutomatic()) throw Error('自动收录已关闭'); };
      await permitted();
      await updatePreparedRoot(job.rootId, note => { if (preparationGoal(note) !== job.title) throw Error('学习目标已变化，未绑定旧推荐'); return mergePreparationResources(note, resources); }, allowed);
      const [latest] = await readSavedVaultNotesByIds(getVaultRoot(), getUserStateDir(), [job.rootId]);
      const pending = resources.map(resource => resource.url).filter(url => latest?.resources?.some(resource => resource.kind !== 'local' && resource.url === url));
      if (!pending.length) return resources.length;
      const plan = await resourceDownloadBatches.prepare(preparationOwner, job.rootId, pending, signal);
      const cancel = () => resourceDownloadBatches.cancel(preparationOwner, plan.id); signal.addEventListener('abort', cancel, { once: true });
      try {
        if (!plan.files.length) return resources.length;
        const result = await resourceDownloadBatches.execute(preparationOwner, plan.id, permitted);
        await permitted();
        if (result.items.some(item => item.document)) await updatePreparedRoot(job.rootId, note => bindDownloadedProjectResources([note], plan, result).notes[0], allowed);
        if (result.stopped || result.items.some(item => item.error)) throw Error('部分附件下载未完成，原链接已保留；可重试失败项');
        return resources.length;
      } finally { signal.removeEventListener('abort', cancel); resourceDownloadBatches.release(preparationOwner, plan.id); }
    },
  });
  const preparationCaller = (event: Electron.IpcMainInvokeEvent) => {
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame || !preparationCurrent()) throw Error('资料准备仅限主窗口；存储变化后请重启软件');
  };
  ipcMain.handle('learning-preparation:command', async (event, input: LearningPreparationCommand) => {
    preparationCaller(event);
    if (!input || !['status', 'enqueue', 'retry', 'accept', 'upload'].includes(input.op)) throw Error('资料准备操作无效');
    if (input.op !== 'upload') return learningPreparation!.command(input);
    await learningPreparation!.command({ op: 'status', rootId: input.rootId });
    const selection = await dialog.showOpenDialog(mainWindow!, { title: '为根项目添加教材', properties: ['openFile', 'multiSelections'] });
    if (!selection.canceled && selection.filePaths.length) {
      preparationCaller(event); const imported = await importRagDocumentPaths(selection.filePaths.slice(0, 8));
      if (!imported.ok) throw Error(imported.error || '教材入库未完成');
      const resources: ResourceItem[] = (imported.documents || []).map(document => ({ title: document.fileName, documentId: document.id, kind: 'local', url: `loginote-document://${document.id}`, platform: '本地资料库', indexable: document.indexable }));
      await updatePreparedRoot(input.rootId, note => mergePreparationResources(note, resources), () => preparationCaller(event));
    }
    return learningPreparation!.command({ op: 'status', rootId: input.rootId });
  });
  ipcMain.handle('learning-preparation:materials', async (event, projectId: string) => {
    preparationCaller(event);
    const chain: NoteItem[] = [], seen = new Set<string>(); let id = projectId;
    while (id && chain.length < 30 && !seen.has(id)) { seen.add(id); const [note] = await readSavedVaultNotesByIds(getVaultRoot(), getUserStateDir(), [id]); if (!note || note.noteType !== 'project') return []; chain.push(note); id = note.parentId || ''; }
    const root = chain.at(-1); if (!root || root.parentId || !root.planMeta) return [];
    const job = await learningPreparation!.command({ op: 'status', rootId: root.id });
    const bound = new Set(chain.flatMap(note => (note.resources || []).flatMap(resource => [resource.url, resource.sourceUrl || ''])));
    return (job?.candidates || []).filter(candidate => bound.has(candidate.url) && candidate.description?.trim()).slice(0, 2)
      .map((candidate, index) => ({ id: `W${index + 1}`, title: candidate.title, kind: 'web', text: `搜索摘要（不是网页全文，仅限以下片段支持的内容）：\n${candidate.description}`, locator: candidate.url }));
  });
  void learningPreparation.recover().then(async () => {
    // A marker saved with the confirmed plan closes the crash gap between plan
    // publication and enqueue. Old plans without the marker are never mass-searched.
    const metadata = JSON.parse(await fs.readFile(path.join(getVaultRoot(), 'metadata.json'), 'utf8'));
    for (const note of Object.values(metadata.notesMeta || {}) as NoteItem[]) if (!note.parentId && note.planMeta?.resourcePreparationVersion === 1)
      await learningPreparation!.command({ op: 'enqueue', rootId: note.id });
  }).catch(error => console.warn('[learning-preparation] 资料准备可稍后重试:', error));
  const resourceDownloadOwner = (event: Electron.IpcMainInvokeEvent) => {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents !== event.sender) throw new Error('下载只能从主窗口的确认流程执行');
    const owner = event.sender.id;
    if (!downloadOwners.has(owner)) {
      downloadOwners.add(owner);
      event.sender.once('destroyed', () => { resourceDownloadBatches.releaseOwner(owner); downloadOwners.delete(owner); });
      event.sender.on('did-start-navigation', (_e, _url, inPlace, isMainFrame) => {
        if (isMainFrame && !inPlace) resourceDownloadBatches.releaseOwner(owner);
      });
    }
    return owner;
  };
  ipcMain.handle('resource-download:prepare', async (event, input: { projectId?: unknown; urls?: unknown }) => {
    try {
      const owner = resourceDownloadOwner(event);
      const plan = await resourceDownloadBatches.prepare(owner, String(input?.projectId || ''), input?.urls as string[] | undefined);
      if (event.sender.isDestroyed()) { resourceDownloadBatches.releaseOwner(owner); throw new Error('主窗口已退出，预览已失效'); }
      return plan;
    } catch (error) { throw new Error(safeResourceDownloadError(error)); }
  });
  ipcMain.handle('resource-download:execute', async (event, id: unknown) => {
    try { return await resourceDownloadBatches.execute(resourceDownloadOwner(event), String(id || '')); }
    catch (error) { throw new Error(safeResourceDownloadError(error)); }
  });
  ipcMain.handle('resource-download:execute-automatic', async (event, id: unknown) => {
    try {
      const owner = resourceDownloadOwner(event);
      return await resourceDownloadBatches.execute(owner, String(id || ''), async () => {
        const text = await readUserStateFileIfExists(USER_STATE_FILES.settings, getUserStateDir(), true);
        if (!text || deserializeSettingsState(text)?.resourceCollectionMode !== 'auto') throw new Error('自动收录已关闭，停止自动下载；原链接保留');
      });
    } catch (error) { throw new Error(safeResourceDownloadError(error)); }
  });
  ipcMain.handle('resource-download:cancel', (event, id: unknown) => { resourceDownloadBatches.cancel(resourceDownloadOwner(event), String(id || '')); });
  ipcMain.handle('resource-download:release', (event, id: unknown) => { resourceDownloadBatches.release(resourceDownloadOwner(event), String(id || '')); });
  ipcMain.handle('open-external', (_e, url: string) => shell.openExternal(url));

  // ===== LLM / AI 服务（迁移自 server.ts，渲染进程通过 IPC 调用） =====
  ipcMain.handle('llm:request', async (event, req: LlmIpcRequest) => {
    await assertLlmRequestProviderEnabled(req, readLlmProviderAuthoritySettings);
    const requestId = req.requestId || `llm-request-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const key = llmRequestKey(event.sender.id, requestId);
    const controller = new AbortController();
    const abortWhenRendererCloses = () => controller.abort();
    activeLlmRequests.set(key, controller);
    event.sender.once('destroyed', abortWhenRendererCloses);
    try {
      return await proxyLlmRequest(req, controller.signal);
    } finally {
      activeLlmRequests.delete(key);
      event.sender.removeListener('destroyed', abortWhenRendererCloses);
    }
  });
  ipcMain.handle('llm:probe', async (_e, req: LlmIpcRequest) => {
    await assertLlmRequestProviderEnabled(req, readLlmProviderAuthoritySettings);
    return probeLlmRequest(req);
  });
  ipcMain.handle('llm:models', async (_e, req: LlmIpcRequest) => {
    await assertLlmRequestProviderEnabled(req, readLlmProviderAuthoritySettings);
    return discoverLlmModels(req);
  });

  ipcMain.handle('llm:cancel', (event, requestId: string) => {
    if (!requestId) return false;
    const controller = activeLlmRequests.get(llmRequestKey(event.sender.id, requestId));
    if (!controller) return false;
    controller.abort();
    return true;
  });

  ipcMain.handle('llm:stream-start', async (_e, req: LlmIpcRequest) => {
    await assertLlmRequestProviderEnabled(req, readLlmProviderAuthoritySettings);
    const sender = _e.sender;
    const streamId = `llm-stream-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const key = llmRequestKey(sender.id, streamId);
    const controller = new AbortController();
    const abortWhenRendererCloses = () => controller.abort();
    activeLlmRequests.set(key, controller);
    sender.once('destroyed', abortWhenRendererCloses);
    void streamLlmRequest(req, (chunk) => {
      if (!sender.isDestroyed()) {
        sender.send('llm:stream-chunk', { streamId, chunk });
      }
    }, controller.signal)
      .then((diagnostics) => {
        if (diagnostics && !sender.isDestroyed()) sender.send('llm:stream-chunk', {
          streamId,
          chunk: { type: 'diagnostics', text: '', diagnostics },
        });
        if (!sender.isDestroyed()) sender.send('llm:stream-end', { streamId });
      })
      .catch((err) => {
        if (!sender.isDestroyed()) sender.send('llm:stream-error', {
          streamId,
          message: controller.signal.aborted ? '请求已停止' : (err as Error).message || '流式请求失败',
          cancelled: controller.signal.aborted,
        });
      })
      .finally(() => {
        activeLlmRequests.delete(key);
        sender.removeListener('destroyed', abortWhenRendererCloses);
      });
    return streamId;
  });

  ipcMain.handle('ai:auto-link', async (_e, req: AutoLinkIpcRequest) => autoLink(req));

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

  // ===== 论证结构编辑器独立窗口（开窗 + 数据推送 + 保存/删除回传） =====
  ipcMain.handle('argument-editor:open', (e, payload: unknown): void => {
    if (e.sender !== mainWindow?.webContents) throw new Error('无权打开论证编辑器');
    if (argumentPersistence.busy()) throw new Error('请等待论证编辑器的保存或删除完成');
    if (argumentWindow && !argumentWindow.isDestroyed()) {
      argumentWindow.show();
      argumentWindow.focus();
      // Keep the existing draft; opening another graph cannot silently replace it.
      return;
    }
    pendingArgumentData = payload;
    createArgumentWindow();
  });

  ipcMain.handle('argument-editor:save', (e, payload: any) => {
    const initial = pendingArgumentData as any;
    if (e.sender !== argumentWindow?.webContents || !mainWindow || mainWindow.isDestroyed()
      || payload?.doc?.doc_id !== initial?.doc?.doc_id || payload?.noteId !== initial?.noteId) {
      return { ok: false, error: '保存目标已失效，未写入其他笔记。' };
    }
    return argumentPersistence.request(e.sender, mainWindow.webContents, 'argument-editor:saved', {
      ...payload, entryMode: initial.entryMode,
    });
  });
  ipcMain.handle('argument-editor:delete', (e, payload: any) => {
    const initial = pendingArgumentData as any;
    if (e.sender !== argumentWindow?.webContents || !mainWindow || mainWindow.isDestroyed()
      || payload?.docId !== initial?.doc?.doc_id || !initial?.noteId) {
      return { ok: false, error: '删除目标已失效，未删除其他笔记。' };
    }
    return argumentPersistence.request(e.sender, mainWindow.webContents, 'argument-editor:deleted', {
      docId: payload.docId, noteId: initial.noteId,
    });
  });
  ipcMain.handle('argument-editor:write-applied', (e, payload: unknown) => argumentPersistence.acknowledge(e.sender, payload));
  ipcMain.handle('argument-editor:close', (e) => {
    if (e.sender !== argumentWindow?.webContents || argumentPersistence.busy()) return false;
    argumentWindow.close();
    return true;
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

  ipcMain.handle('resource:check-health', async (_e, url: unknown) => {
    if (typeof url !== 'string' || !url.trim()) {
      return { url: '', status: 'temporary-error', checkedAt: new Date().toISOString(), error: '链接为空' };
    }
    return checkPublicResourceUrl(url.trim());
  });

  ipcMain.handle('resource-browser:search', async (_e, request: unknown) => {
    const result = await searchResourcesInBrowser(request, mainWindow);
    const mode = request && typeof request === 'object'
      ? (request as { interactionMode?: unknown }).interactionMode
      : undefined;
    if (mode === 'auto') closeResourceBrowserSession(result.sessionId);
    return result;
  });

  const conceptResearchRequests = new Map<string, AbortController>();
  ipcMain.handle('concept-research:cancel', (_e, requestId: unknown) => {
    if (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/u.test(requestId)) return false;
    const controller = conceptResearchRequests.get(`${_e.sender.id}:${requestId}`);
    controller?.abort(); return Boolean(controller);
  });
  ipcMain.handle('concept-research:search', async (_e, term: unknown, aliases: unknown, requestId?: unknown) => {
    const title = typeof term === 'string' ? term : '';
    const names = Array.isArray(aliases) ? aliases.filter((alias): alias is string => typeof alias === 'string') : [];
    if (requestId !== undefined && (typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/u.test(requestId))) throw new Error('概念检索请求编号无效');
    const key = `${_e.sender.id}:${requestId || randomUUID()}`;
    if (conceptResearchRequests.has(key) || conceptResearchRequests.size >= 64) throw new Error('概念检索正在执行，请稍后重试');
    const controller = new AbortController(), cancel = () => controller.abort();
    conceptResearchRequests.set(key, controller);
    _e.sender.once('destroyed', cancel);
    try { return await searchConceptEvidence(title, names,
      (term, aliases) => searchConceptEvidenceInBrowser(term, aliases, mainWindow, controller.signal), undefined, controller.signal); }
    finally { _e.sender.removeListener('destroyed', cancel); conceptResearchRequests.delete(key); }
  });

  ipcMain.handle('resource-browser:scan', async (_e, sessionId: unknown) => (
    scanResourceBrowserSession(typeof sessionId === 'string' ? sessionId : '')
  ));

  ipcMain.handle('resource-workbench:navigate', async (_e, request: unknown) => {
    const value = request && typeof request === 'object'
      ? request as { sessionId?: unknown; action?: unknown; value?: unknown }
      : {};
    const actions = new Set(['back', 'forward', 'reload', 'home', 'go', 'open-candidate', 'switch-tab', 'search-variant']);
    const action = String(value.action || '');
    if (!actions.has(action)) throw new Error('未知的资源工作台导航操作');
    return navigateResourceWorkbench(
      String(value.sessionId || ''),
      action as 'back' | 'forward' | 'reload' | 'home' | 'go' | 'open-candidate' | 'switch-tab' | 'search-variant',
      typeof value.value === 'string' ? value.value : undefined,
    );
  });

  ipcMain.handle('resource-workbench:decision', (_e, request: unknown) => {
    const value = request && typeof request === 'object'
      ? request as { sessionId?: unknown; candidateId?: unknown; decision?: unknown }
      : {};
    const decision = value.decision === null ? null : String(value.decision || '');
    if (decision !== null && decision !== 'selected' && decision !== 'rejected') throw new Error('未知的资源选择');
    return setResourceWorkbenchDecision(
      String(value.sessionId || ''),
      String(value.candidateId || ''),
      decision as 'selected' | 'rejected' | null,
    );
  });

  ipcMain.handle('resource-workbench:download-toggle', (_e, request: unknown) => {
    const value = request && typeof request === 'object'
      ? request as { sessionId?: unknown; candidateId?: unknown; enabled?: unknown }
      : {};
    return setResourceWorkbenchDownload(
      String(value.sessionId || ''),
      String(value.candidateId || ''),
      value.enabled === true,
    );
  });

  ipcMain.handle('resource-workbench:commit', async (event, sessionId: unknown) => {
    const id = typeof sessionId === 'string' ? sessionId : '';
    if (pendingResourceWorkbenchCommits.has(id)) {
      return { ok: false, error: '本批资源正在确认或写入项目，请稍候' };
    }
    const commitId = `resource-commit-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    const target = mainWindow;
    let handedOff = false;
    let stopWatching = () => {};
    const ownsCommit = () => pendingResourceWorkbenchCommits.get(id) === commitId
      && isResourceWorkbenchCommitActive(id, commitId);
    const assertCurrentCommit = () => {
      if (!ownsCommit()) throw new Error('资源工作台已关闭或本次提交已失效');
      if (!target || mainWindow !== target || target.isDestroyed() || target.webContents.isDestroyed()) {
        throw new Error('主窗口不可用，未能写入项目');
      }
    };
    try {
      const pending = getResourceWorkbenchPendingCommit(id);
      if (pending.selectedResources.length === 0 && pending.rejectedResources.length === 0) {
        return { ok: false, error: '请先在右侧至少选择一个资源或标记一项不感兴趣' };
      }
      const host = BrowserWindow.fromWebContents(event.sender);
      if (!host || host !== pending.state.window || host.isDestroyed() || host.webContents !== event.sender) {
        return { ok: false, error: '请在对应资源工作台中确认本次选择' };
      }
      if (!target || target.isDestroyed()) return { ok: false, error: '主窗口不可用，未能写入项目' };
      // 在第一个 await 前预留本批次；原生确认框和网页右键入口共用同一把锁。
      pendingResourceWorkbenchCommits.set(id, commitId);
      beginResourceWorkbenchCommit(id, commitId, () => {
        stopWatching();
        if (pendingResourceWorkbenchCommits.get(id) === commitId) pendingResourceWorkbenchCommits.delete(id);
      });
      const receiverGone = () => {
        if (!ownsCommit()) return;
        updateResourceWorkbenchCommitState(id, commitId,
          '主窗口已退出或重新加载，写回结果未能确认；请核对项目资源后再重试。', null);
      };
      const receiverNavigating = (details: { isMainFrame: boolean; isSameDocument: boolean }) => {
        if (details.isMainFrame && !details.isSameDocument) receiverGone();
      };
      target.webContents.on('destroyed', receiverGone);
      target.webContents.on('render-process-gone', receiverGone);
      target.webContents.on('did-start-navigation', receiverNavigating);
      stopWatching = () => {
        target.webContents.removeListener('destroyed', receiverGone);
        target.webContents.removeListener('render-process-gone', receiverGone);
        target.webContents.removeListener('did-start-navigation', receiverNavigating);
      };
      const confirmation = await dialog.showMessageBox(host, {
        type: 'question',
        title: '确认资源统筹结果',
        message: `将 ${pending.selectedResources.length} 个已选资源收录到对应项目，并记录 ${pending.rejectedResources.length} 条“不感兴趣”偏好？`,
        detail: pending.downloadCandidateIds.length
          ? `其中 ${pending.downloadCandidateIds.length} 个文件将下载到本地资料库，并以本地资料引用写入项目资源栏；其余已选项写入 URL。`
          : pending.state.request.source === 'note-editor'
            ? '这是最终收录确认。成功后工作台会自动关闭，资源会显示在当前项目笔记中。'
            : '这是最终收录确认。成功后工作台会自动关闭，Agent 将继续后续处理。',
        buttons: ['取消', '确认并写回'],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      });
      assertCurrentCommit();
      restoreResourceWorkbenchFocus(id, commitId);
      if (confirmation.response !== 1) {
        updateResourceWorkbenchCommitState(id, commitId, '已取消写回，原选择已保留，可继续调整。', null);
        return { ok: false, canceled: true };
      }

      updateResourceWorkbenchCommitState(id, commitId, '正在下载所选资料…', 'preparing');
      const downloadedResources: ResourceWorkbenchCommitEvent['downloadedResources'] = [];
      const downloadErrors: Array<{ candidateId: string; message: string }> = [];
      for (const candidateId of pending.downloadCandidateIds) {
        assertCurrentCommit();
        let downloadedPath = '';
        try {
          const downloaded = await downloadResourceCandidate(id, candidateId, host, true);
          if (!downloaded.filePath) throw new Error('下载没有生成本地文件');
          downloadedPath = downloaded.filePath;
          assertCurrentCommit();
          const imported = await importRagDocumentPaths([downloaded.filePath], downloaded.sourceUrl);
          assertCurrentCommit();
          if (!imported.ok) throw new Error(imported.error || '资料入库失败');
          const document = imported.documents?.[0];
          if (!document) throw new Error('资料入库后未返回文档记录');
          downloadedResources.push({ candidateId, document });
        } catch (error) {
          assertCurrentCommit();
          downloadErrors.push({ candidateId, message: error instanceof Error ? error.message : String(error) });
        } finally {
          if (downloadedPath) {
            await fs.unlink(downloadedPath).catch(() => {});
            await fs.rmdir(path.dirname(downloadedPath)).catch(() => {});
          }
        }
      }
      assertCurrentCommit();
      const payload: ResourceWorkbenchCommitEvent = {
        commitId,
        sessionId: id,
        draftSessionId: pending.state.request.draftSessionId,
        selectedResources: pending.selectedResources,
        rejectedResources: pending.rejectedResources,
        downloadedCandidateIds: downloadedResources.map((item) => item.candidateId),
        downloadedResources,
        downloadErrors,
      };
      if (mainWindow !== target || target.isDestroyed() || target.webContents.isDestroyed()) {
        throw new Error('主窗口不可用，未能写入项目');
      }
      updateResourceWorkbenchCommitState(id, commitId, '正在写入项目资源栏，请等待保存结果…', 'applying');
      target.webContents.send('resource-workbench:committed', payload);
      handedOff = true;
      return { ok: true, pendingApply: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      updateResourceWorkbenchCommitState(id, commitId, `${message}；选择已保留，恢复后可重试。`, null);
      return { ok: false, error: message };
    } finally {
      if (!handedOff) stopWatching();
      if (!handedOff && pendingResourceWorkbenchCommits.get(id) === commitId) {
        pendingResourceWorkbenchCommits.delete(id);
      }
    }
  });

  ipcMain.handle('resource-workbench:commit-applied', (event, raw: unknown) => {
    const value = raw && typeof raw === 'object'
      ? raw as { sessionId?: unknown; commitId?: unknown; ok?: unknown; message?: unknown }
      : {};
    const id = String(value.sessionId || '');
    const commitId = String(value.commitId || '');
    if (!id || !mainWindow || mainWindow.webContents !== event.sender
      || pendingResourceWorkbenchCommits.get(id) !== commitId
      || !isResourceWorkbenchCommitActive(id, commitId, true)) return false;
    pendingResourceWorkbenchCommits.delete(id);
    const message = String(value.message || '').trim();
    if (value.ok !== true) {
      updateResourceWorkbenchCommitState(id, commitId, message || '项目资源写入失败，请修正后重试。', null);
      return false;
    }
    completeResourceWorkbenchCommit(id, commitId, message || '资源已写入项目。');
    closeResourceBrowserSession(id);
    return true;
  });

  ipcMain.handle('resource-browser:authorize', async (event, request: unknown) => {
    const value = request && typeof request === 'object'
      ? request as { sessionId?: unknown; candidateId?: unknown }
      : {};
    return openAuthenticatedCandidate(
      typeof value.sessionId === 'string' ? value.sessionId : '',
      typeof value.candidateId === 'string' ? value.candidateId : '',
      BrowserWindow.fromWebContents(event.sender) || mainWindow,
    );
  });

  ipcMain.handle('resource-browser:auth-list', async () => listResourceAuthContainers());
  ipcMain.handle('resource-browser:auth-resolve', async (_e, rawUrl: unknown) => (
    resolveResourceAuthSession(typeof rawUrl === 'string' ? rawUrl : '')
  ));
  ipcMain.handle('resource-browser:auth-open', async (_e, containerId: unknown) => (
    openResourceAuthContainer(typeof containerId === 'string' ? containerId : '', mainWindow)
  ));
  ipcMain.handle('resource-browser:auth-remove', async (_e, containerId: unknown): Promise<boolean> => {
    const id = typeof containerId === 'string' ? containerId : '';
    const container = (await listResourceAuthContainers()).find((item) => item.id === id);
    if (!container) return false;
    const confirmation = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
      type: 'warning',
      title: '删除网站登录容器',
      message: `删除 ${container.name} 的本地登录状态？`,
      detail: '这会清除该隔离容器中的 Cookie、LocalStorage、IndexedDB 与缓存，但不会删除项目资源或已下载资料。',
      buttons: ['取消', '删除登录数据'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    return confirmation.response === 1 ? removeResourceAuthContainer(id) : false;
  });

  ipcMain.handle('resource-browser:close', async (_e, sessionId: unknown): Promise<boolean> => {
    const id = typeof sessionId === 'string' ? sessionId : '';
    return closeResourceBrowserSession(id);
  });

  ipcMain.handle('resource-browser:download', async (
    _e,
    request: unknown,
  ): Promise<ResourceBrowserDownloadResult> => {
    const value = request && typeof request === 'object'
      ? request as { sessionId?: unknown; candidateId?: unknown }
      : {};
    let downloadedPath = '';
    try {
      const downloaded = await downloadResourceCandidate(
        typeof value.sessionId === 'string' ? value.sessionId : '',
        typeof value.candidateId === 'string' ? value.candidateId : '',
        mainWindow,
      );
      if (downloaded.canceled) return { ok: false, canceled: true };
      if (!downloaded.filePath) return { ok: false, error: '下载没有生成本地文件' };
      downloadedPath = downloaded.filePath;
      const imported = await importRagDocumentPaths([downloaded.filePath], downloaded.sourceUrl);
      if (!imported.ok) return { ok: false, error: imported.error || '资料入库失败' };
      const fileName = path.basename(downloaded.filePath);
      const document = imported.documents?.find((item) => item.fileName === fileName);
      return { ok: true, document };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '下载入库失败' };
    } finally {
      if (downloadedPath) {
        await fs.unlink(downloadedPath).catch(() => {});
        await fs.rmdir(path.dirname(downloadedPath)).catch(() => {});
      }
    }
  });

  ipcMain.handle('argument-editor:open-note', (_e, noteId: unknown): void => {
    const value = typeof noteId === 'string' ? noteId.trim().slice(0, 300) : '';
    if (!value || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('argument-editor:open-note', { noteId: value });
    mainWindow.show();
    mainWindow.focus();
  });

  ipcMain.handle('storage:set-root', async (_e, newRoot: unknown, migrate: boolean): Promise<{ ok: boolean; error?: string }> => {
    if (learningMigrationPending) return { ok: false, error: '已更改存储目录，请先重启软件后再更改。' };
    if (h5pHost?.hasWindows() || h5pHost?.busy() || scenePackHost?.busy()) return { ok: false, error: '请先结束交互包导入并关闭 H5P 场景窗口，再更改存储路径' };
    if (referenceEnvironmentSuspended || documentRecoveryWriting) return { ok: false, error: '存储操作中，请稍后重试' };
    let interrupted:Promise<void>|undefined,oldProcessingRoot:string|undefined,interruptedGeneration:number|undefined,succeeded=false;
    try {
      const target = typeof newRoot === 'string' && newRoot.trim() ? path.resolve(newRoot.trim()) : '';
      if (!target) return { ok: false, error: '目标路径无效' };

      const oldRoot = getDataRoot();
      if (target === oldRoot) return { ok: true };

      // Drain buffered reading/answer/restatement state before the copy fence.
      // A disposed Flow may still own a registered, pending save participant.
      if (mainWindow && !mainWindow.isDestroyed()) await exitRequests.request(mainWindow.webContents, 'prepare');
      referenceEnvironmentSuspended = true;
      referenceSourceWriteEpoch++;
      interrupted=stopBackgroundCompute();oldProcessingRoot=oldRoot;interruptedGeneration=backgroundGeneration;
      referenceEnvironments.revoke();
      referenceQuestions.revoke();
      revokeReferenceBuilds();

      // 目标目录本身即 userData 根：vault/、user-state/、缓存/localStorage/IndexedDB 都放这里
      await interrupted;
      await progressiveLearning?.idle();
      await withRagSourceTransaction([oldRoot, getVaultRoot(), getUserStateDir(), target], async () => {
        if (migrate) {
          await recoverVaultSnapshotInTransaction(getVaultRoot(), getUserStateDir());
          const learning = await prepareLearningStateMigration(getUserStateDir(), path.join(target, 'user-state'));
          await migrateDataTo(oldRoot, target);
          await copyLearningStateMigration(learning);
          await copyNoteIndexCleanupForMigration(getVaultRoot(), getUserStateDir(), path.join(target, 'vault'), path.join(target, 'user-state'));
        } else await fs.mkdir(target, { recursive: true });
        // set-root only changes the NEXT launch anchor; the running roots remain unchanged.
        saveAnchorConfig(target);
        // Further course writes to the old root would miss the completed copy.
        // Normal application close remains available; learning resumes after restart.
        learningMigrationPending = true;
      });

      // 只写锚点配置，下次启动由 applyCustomUserDataPath() 生效（app.setPath 必须在 ready 前调用）
      succeeded=true;return { ok: true };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    } finally {
      referenceEnvironmentSuspended = false;
      if(interrupted&&!succeeded){
        const isCurrent=()=>!referenceEnvironmentSuspended&&backgroundGeneration===interruptedGeneration&&getDataRoot()===oldProcessingRoot;
        // Wait for the old consumer to release activeVectorizationDocument before
        // re-enqueueing it; otherwise dedup would silently drop its recovery.
        void interrupted.then(()=>recoverBodyIndexQueue(isCurrent)).catch(error=>console.warn('[rag] 迁移失败后恢复正文队列失败:',error));
        void interrupted.then(() => progressiveDerived?.resume()).catch(error => console.warn('[progressive-derived] 恢复失败:', error));
        void interrupted.then(() => learningPreparation?.recover()).catch(error => console.warn('[learning-preparation] 恢复失败:', error));
      }
    }
  });

  // 清空所有数据（恢复初始化）：删除数据本体目录 + 清空 Chromium 存储，保留自定义路径锚点
  ipcMain.handle('storage:reset', async (): Promise<{ ok: boolean; error?: string }> => {
    if (h5pHost?.hasWindows() || h5pHost?.busy() || scenePackHost?.busy()) return { ok: false, error: '请先结束交互包导入并关闭 H5P 场景窗口，再清空数据' };
    if (referenceEnvironmentSuspended || documentRecoveryWriting) return { ok: false, error: '存储操作中，请稍后重试' };
    try {
      const root = path.resolve(getDataRoot()), vaultDirectory = path.resolve(root, 'vault'), userStateDirectory = path.resolve(root, 'user-state'), h5pDirectory = path.resolve(root, 'h5p');
      if (!isSubPath(vaultDirectory, root) || !isSubPath(userStateDirectory, root) || !isSubPath(h5pDirectory, root)) throw new Error('数据重置目标越界');
      referenceEnvironmentSuspended = true;
      referenceSourceWriteEpoch++;
      stopBackgroundCompute();
      referenceEnvironments.revoke();
      referenceQuestions.revoke();
      revokeReferenceBuilds();
      await clearAllResourceAuthContainers();
      await withRagSourceTransaction([root, vaultDirectory, userStateDirectory], async () => {
        await fs.rm(vaultDirectory, { recursive: true, force: true });
        await fs.rm(userStateDirectory, { recursive: true, force: true });
        await fs.rm(h5pDirectory, { recursive: true, force: true });
      });
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
    } finally {
      referenceEnvironmentSuspended = false;
    }
  });

  ipcMain.handle('vault:load', async (): Promise<unknown[]> => {
    const vaultRoot = getVaultRoot(), userStateDirectory = getUserStateDir();
    const statisticsScope = JSON.stringify([vaultRoot, userStateDirectory, referenceSourceWriteEpoch]);
    const notes = await loadMergedNotes();
    retryDeletedNoteIndexCleanup(); // Also follows recovery of an interrupted vault delta.
    // Reuse this recovered, successful read only for historical statistics. Later
    // loads/saves still read saved originals; this is not a persistent vault cache.
    startupFlowStatistics.offer(statisticsScope, { notes, vaultRoot, userStateDirectory });
    return notes;
  });

  ipcMain.handle('vault:save-reading-positions', async (_e, updates: unknown): Promise<void> => {
    if (referenceEnvironmentSuspended) throw new Error('存储操作中，请稍后保存');
    const root = getVaultRoot(), states = getUserStateDir(), writeEpoch = referenceSourceWriteEpoch;
    const snapshot = structuredClone(updates);
    const isCurrent = () => !referenceEnvironmentSuspended && writeEpoch === referenceSourceWriteEpoch && root === getVaultRoot();
    await referenceNoteSnapshotSaves.run(() => saveTextbookReadingPositions(root, states, snapshot, isCurrent));
    try { onWriteCommitted('notes'); } catch { /* Derived cache failure cannot undo an acknowledged private write. */ }
  });

  ipcMain.handle('vault:save', async (_e, notes: unknown[]): Promise<void> => {
    if (referenceEnvironmentSuspended) throw new Error('存储操作中，请稍后保存');
    // Freeze the caller's complete snapshot before the first awaited saved read.
    const noteList = structuredClone((notes || []) as NoteItem[]);
    const root = getVaultRoot(), userStateDirectory = getUserStateDir();
    const writeEpoch = referenceSourceWriteEpoch;
    referenceEnvironments.revoke();
    // A full snapshot also saves personal activity and unrelated notes. Do not abort
    // consented BUILD tickets for those writes. The unchanged source coordinator and
    // each build's exact source/provenance/scope rechecks reject real source changes.
    await referenceNoteSnapshotSaves.run(async () => {
      if (referenceEnvironmentSuspended || writeEpoch !== referenceSourceWriteEpoch || root !== getVaultRoot()) {
        throw new Error('rag_source_environment_changed');
      }
      const previousNotes = await loadMergedNotes();
      const protectedSnapshot=communityImportFence.merge(noteList,previousNotes);noteList.splice(0,noteList.length,...protectedSnapshot);
      if (referenceEnvironmentSuspended || writeEpoch !== referenceSourceWriteEpoch || root !== getVaultRoot()) {
        throw new Error('rag_source_environment_changed');
      }
      // Only changed source/dependency content identities revoke matching build
      // observations. The queue preserves observed B → A ordering across two saves;
      // it is not a source lock and cannot nest public source transactions.
      referenceBuilds.observeNoteSnapshot(noteList, previousNotes);
      referenceRagBuilds.observeNoteSnapshot(noteList, previousNotes);
      await saveVaultSnapshot(root, userStateDirectory, noteList, atomicWriteTextFile,
        () => !referenceEnvironmentSuspended && writeEpoch === referenceSourceWriteEpoch);
    });
    onWriteCommitted('notes');
    retryDeletedNoteIndexCleanup();
    // Refresh idle source/dependency summaries after the committed snapshot. This
    // notification does not revoke or restart any prepared/consented build ticket.
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('argument-reference:changed');
    }
    // Saving is authoritative; reference indexing is a derived, local background task.
    // A failed embedding must never turn a successful vault write into "save failed".
    if (root === getVaultRoot() && writeEpoch === referenceSourceWriteEpoch && !referenceEnvironmentSuspended) {
      deferredNoteIndex.request();
    }
  });

  ipcMain.handle('vault:knowledge-lifecycle', async () => {
    if (referenceEnvironmentSuspended) throw Error('存储操作中，请稍后读取');
    const root = getUserStateDir();
    return withSavedVaultSnapshot(getVaultRoot(), root, () => readKnowledgeLifecycle(root));
  });
  ipcMain.handle('vault:save-delta', async (_e, input: unknown): Promise<void> => {
    if (referenceEnvironmentSuspended) throw new Error('存储操作中，请稍后保存');
    // No complete note array crosses this path. Freeze only changed-note data.
    const delta = validateVaultNotesDelta(input);
    if (!delta.upserts.length && !delta.removed.length && !delta.derivedLinks?.length) return;
    const root = getVaultRoot(), states = getUserStateDir(), epoch = referenceSourceWriteEpoch;
    const isCurrent = () => !referenceEnvironmentSuspended && epoch === referenceSourceWriteEpoch && root === getVaultRoot();
    referenceEnvironments.revoke();
    await referenceNoteSnapshotSaves.run(() => saveVaultNotesDelta(root, states, delta, {
      isCurrent,
      observe: (next, previous) => {
        // Missing IDs in a delta are retained, including unobserved new community
        // imports. Explicit removals validate their saved provenance in the store.
        referenceBuilds.observeNoteDelta(next, previous);
        referenceRagBuilds.observeNoteDelta(next, previous);
      },
    }));
    onWriteCommitted('notes');
    retryDeletedNoteIndexCleanup();
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('argument-reference:changed');
    }
    if (isCurrent()) {
      const before = delta.upserts.flatMap(entry => entry.before ? [entry.before] : []);
      const next = delta.upserts.map(entry => entry.note);
      changedNoteIndex.forget(delta.removed.map(entry => entry.id));
      if (changedNoteIndex.request(next, before)) deferredChangedNoteIndex.request();
      for (const entry of delta.upserts) if (!entry.note.parentId && entry.note.planMeta?.resourcePreparationVersion === 1
        && (!entry.before?.planMeta?.resourcePreparationVersion || entry.note.title !== entry.before.title))
        void learningPreparation?.command({ op: 'enqueue', rootId: entry.note.id }).catch(error => console.warn('[learning-preparation] 计划已保存，资料可稍后重试:', error));
    }
  });

  ipcMain.handle('vault:save-personal-state', async (_e, patches: unknown): Promise<void> => {
    if (referenceEnvironmentSuspended) throw new Error('存储操作中，请稍后保存');
    const root = getVaultRoot(), states = getUserStateDir(), epoch = referenceSourceWriteEpoch;
    const snapshot = structuredClone(patches);
    const isCurrent = () => !referenceEnvironmentSuspended && epoch === referenceSourceWriteEpoch && root === getVaultRoot();
    await referenceNoteSnapshotSaves.run(() => savePersonalNoteState(root, states, snapshot, isCurrent));
    try { onWriteCommitted('notes'); } catch { /* Personal state is already durable. */ }
  });

  ipcMain.handle('vault:get-root', async (): Promise<string> => getVaultRoot());

  // Read-only reference-library service. No caller scope, publication or review route.
  const referenceCallerAllowed = (event: Electron.IpcMainInvokeEvent) => {
    if (referenceEnvironmentSuspended || !mainWindow || mainWindow.isDestroyed()
      || event.sender.id !== mainWindow.webContents.id || event.senderFrame !== event.sender.mainFrame) return false;
    try {
      const url = new URL(event.senderFrame.url);
      return url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === path.resolve(app.getAppPath(), 'dist', 'index.html');
    } catch { return false; }
  };
  h5pHost = registerH5pHost(ipcMain, {
    root: getDataRoot, assets: app.isPackaged ? path.join(process.resourcesPath, 'h5p-player') : path.join(app.getAppPath(), 'node_modules', 'h5p-standalone', 'dist'), parent: () => mainWindow,
    styles: app.isPackaged ? path.join(process.resourcesPath, 'h5p-player', 'theme.css') : path.join(app.getAppPath(), 'src', 'styles', 'design-tokens.css'),
    appearance: async () => {
      let tokens: unknown;
      try { tokens = await mainWindow?.webContents.executeJavaScript(`Object.fromEntries(${JSON.stringify(H5P_APPEARANCE_KEYS)}.map(key=>[key,getComputedStyle(document.documentElement).getPropertyValue(key).trim()]))`); } catch { /* Theme CSS supplies defaults if the main renderer is unavailable. */ }
      return normalizeH5pAppearance(currentWindowTheme, tokens);
    },
    allowed: event => referenceCallerAllowed(event) && !applicationExiting && applicationShutdown.getPhase() === 'idle',
    current: () => `${getDataRoot()}:${referenceSourceWriteEpoch}`,
  });
  let documentRecoveryPending = false;
  ipcMain.handle('plan-research:cancel', (event, requestId: unknown) => {
    if (typeof requestId !== 'string') return false;
    const controller = planSearchRequests.get(`${event.sender.id}:${requestId}`);
    controller?.abort(); return Boolean(controller);
  });
  ipcMain.handle('plan-research:search', async (event, subject: unknown, requestId: unknown) => {
    if (!referenceCallerAllowed(event) || applicationExiting || applicationShutdown.getPhase() !== 'idle'
      || typeof subject !== 'string' || !subject.trim() || [...subject.trim()].length > 120 || /[\r\n\u0000]/u.test(subject)
      || typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/u.test(requestId)) throw new Error('规划检索请求或窗口状态无效');
    const key = `${event.sender.id}:${requestId}`;
    if (planSearchRequests.size >= 4 || planSearchRequests.has(key)) throw new Error('规划联网检索正在执行，请稍后重试');
    const controller = new AbortController(), cancel = () => controller.abort();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    planSearchRequests.set(key, controller); event.sender.once('destroyed', cancel);
    try {
      return await researchPlanWeb(subject, (term, queries, abort) =>
        searchConceptEvidenceInBrowser(term, [], mainWindow, abort, { queries, strictBody: true }), signal);
    } finally { event.sender.removeListener('destroyed', cancel); planSearchRequests.delete(key); }
  });
  ipcMain.handle('storm-research:cancel', (event, requestId: unknown) => {
    if (typeof requestId !== 'string') return false;
    const controller = stormSearchRequests.get(`${event.sender.id}:${requestId}`);
    controller?.abort(); return Boolean(controller);
  });
  ipcMain.handle('storm-research:search', async (event, subject: unknown, requestId: unknown) => {
    if (!referenceCallerAllowed(event) || applicationShutdown.getPhase() !== 'idle'
      || typeof subject !== 'string' || !subject.trim() || subject.length > 500
      || typeof requestId !== 'string' || !/^[a-f0-9-]{36}$/u.test(requestId)) throw new Error('STORM 检索请求或窗口状态无效');
    const key = `${event.sender.id}:${requestId}`;
    if (stormSearchRequests.size >= 4 || stormSearchRequests.has(key)) throw new Error('STORM 联网检索正在执行，请稍后重试');
    const controller = new AbortController(), cancel = () => controller.abort();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180_000)]);
    stormSearchRequests.set(key, controller); event.sender.once('destroyed', cancel);
    try {
      return await researchStormWeb(subject, (term, queries, abort) =>
        searchConceptEvidenceInBrowser(term, [], mainWindow, abort, { queries, strictBody: true }), signal);
    } finally { event.sender.removeListener('destroyed', cancel); stormSearchRequests.delete(key); }
  });
  ipcMain.handle('storage:recover-documents', async (event) => {
    if (!referenceCallerAllowed(event) || documentRecoveryPending || applicationShutdown.getPhase() !== 'idle') {
      return { ok: false, error: '当前不能恢复资料，请返回主窗口并等待存储或退出操作结束' };
    }
    documentRecoveryPending = true;
    const root = getDataRoot(), generation = backgroundGeneration, epoch = referenceSourceWriteEpoch;
    const isCurrent = () => referenceCallerAllowed(event) && root === getDataRoot()
      && generation === backgroundGeneration && epoch === referenceSourceWriteEpoch
      && !applicationExiting && applicationShutdown.getPhase() === 'idle';
    try {
      const recovery = await prepareDocumentManifestRecovery();
      if (!isCurrent()) throw new Error('数据目录或处理状态已变化，请重新扫描');
      if (!recovery.count) return { ok: true, recovered: 0, skipped: recovery.skipped };
      const confirmation = await dialog.showMessageBox(mainWindow!, {
        type: 'question', title: '恢复遗漏资料',
        message: `发现 ${recovery.count} 个未登记文件，是否补录到资料库？`,
        detail: `${recovery.names.join('\n')}${recovery.count > recovery.names.length ? '\n…仅显示前 20 个文件' : ''}\n\n跳过 ${recovery.skipped} 项不支持、冲突或不安全的文件。\n保留现有清单与项目绑定，不改动原文件。缺失的原名称、分类和绑定无法自动还原，补录项归入“待整理”。不会复用旧索引、自动解析、生成论证图或调用模型；需要时在资料页手动建立索引。`,
        buttons: ['取消', '确认补录'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (confirmation.response !== 1) return { ok: true, canceled: true };
      documentRecoveryWriting = true;
      const recovered = await recovery.commit(isCurrent);
      notifyRagChanged();
      return { ok: true, recovered, skipped: recovery.skipped };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : '恢复资料失败，未启动索引任务' };
    } finally { documentRecoveryPending = false; documentRecoveryWriting = false; }
  });
  ipcMain.handle('argument-context:get-environment', async (event, ...args: unknown[]) => {
    if (!referenceCallerAllowed(event) || args.length > 1) return { status: 'held', reasonCode: 'environment_unavailable' };
    return referenceEnvironments.getEnvironment(event.sender.id, args[0]);
  });
  ipcMain.handle('argument-context:read', async (event, request: unknown, ...args: unknown[]) => {
    if (!referenceCallerAllowed(event) || args.length) return { status: 'held', reasonCode: 'environment_unavailable' };
    return referenceEnvironments.execute(event.sender.id, request);
  });
  ipcMain.handle('argument-context:freeze-question', async (event, environmentId: unknown, selectors: unknown, ...args: unknown[]) => {
    if (!referenceCallerAllowed(event) || args.length || typeof environmentId !== 'string')
      return { version: 1, status: 'held', originQuestionMessageId: 'unavailable', reasons: ['environment_unavailable'] };
    return referenceQuestions.prepare(event.sender.id, environmentId, selectors as ArgumentQuestionFrameSelectors);
  });
  ipcMain.handle('argument-context:verify-question', async (event, environmentId: unknown, receipt: unknown, ...args: unknown[]) => {
    if (!referenceCallerAllowed(event) || args.length || typeof environmentId !== 'string') return { status: 'held', reasons: ['environment_unavailable'] };
    return referenceQuestions.verify(event.sender.id, environmentId, receipt);
  });
  ipcMain.handle('argument-context:read-question', async (event, environmentId: unknown, receipt: unknown, ...args: unknown[]) => {
    if (!referenceCallerAllowed(event) || args.length || typeof environmentId !== 'string') return { status: 'held', reasons: ['environment_unavailable'] };
    return referenceQuestions.read(event.sender.id, environmentId, receipt);
  });
  // Read retained pre-question anchors only. No renderer candidate/review/publish route.
  ipcMain.handle('argument-context:read-question-propositions', async (event, environmentId: unknown, receipt: unknown, ...args: unknown[]) => {
    if (!referenceCallerAllowed(event) || args.length || typeof environmentId !== 'string') return { status: 'held', reasons: ['environment_unavailable'] };
    return referenceQuestions.readPropositions(event.sender.id, environmentId, receipt);
  });

  // Selectors + explicit per-source consent only; the host owns prompts, saved model,
  // source review, extraction, independent audit and publication. No raw publish IPC.
  ipcMain.handle('argument-reference:get-environment', async (event, ...args: unknown[]) => {
    if (!referenceCallerAllowed(event) || args.length) return { status: 'held', reasonCode: 'environment_changed' };
    referenceBuilds.revoke(event.sender.id);
    referenceRagBuilds.revoke(event.sender.id);
    return referenceBuildEnvironments.getEnvironment(event.sender.id, { kind: 'library' });
  });
  ipcMain.handle('argument-reference:prepare', async (event, request: unknown, ...args: unknown[]) => {
    if (!referenceCallerAllowed(event) || args.length) return { status: 'held', reasonCode: 'environment_changed' };
    return referenceBuilds.prepare(event.sender.id, request);
  });
  ipcMain.handle('argument-reference:status', async (event, request: unknown, ...args: unknown[]) => {
    if (!referenceCallerAllowed(event) || args.length) return { status: 'held', reasonCode: 'environment_changed' };
    return referenceBuilds.status(event.sender.id, request);
  });
  ipcMain.handle('argument-reference:run', async (event, request: unknown, ...args: unknown[]) => {
    if (!referenceCallerAllowed(event) || args.length) return { status: 'held', reasonCode: 'environment_changed' };
    const reply = await referenceBuilds.run(event.sender.id, request);
    // Notify summaries only. Ordinary document/note indices and all mastery writers stay unchanged.
    if (!event.sender.isDestroyed()) event.sender.send('argument-reference:changed');
    return reply;
  });
  ipcMain.handle('argument-reference:cancel', async (event, request: unknown, ...args: unknown[]) => {
    if (!referenceCallerAllowed(event) || args.length) return { status: 'held', reasonCode: 'environment_changed' };
    return referenceBuilds.cancel(event.sender.id, request);
  });

  // One explicit combined consent. Missing structures use up to three source/
  // graph requests plus two proposition requests; already reviewed graphs use
  // only the latter two. No caller-supplied text, votes, prompts or publication.
  ipcMain.handle('argument-reference-rag:get-environment', async (event, ...args: unknown[]) => {
    if (!referenceCallerAllowed(event) || args.length) return { status: 'held', reasonCode: 'environment_changed' };
    referenceBuilds.revoke(event.sender.id); referenceRagBuilds.revoke(event.sender.id);
    return referenceBuildEnvironments.getEnvironment(event.sender.id, { kind: 'library' });
  });
  ipcMain.handle('argument-reference-rag:prepare', async (event, request: unknown, ...args: unknown[]) => {
    if (!referenceCallerAllowed(event) || args.length) return { status: 'held', reasonCode: 'environment_changed' };
    return referenceRagBuilds.prepare(event.sender.id, request);
  });
  ipcMain.handle('argument-reference-rag:status', async (event, request: unknown, ...args: unknown[]) => {
    if (!referenceCallerAllowed(event) || args.length) return { status: 'held', reasonCode: 'environment_changed' };
    return referenceRagBuilds.status(event.sender.id, request);
  });
  ipcMain.handle('argument-reference-rag:run', async (event, request: unknown, ...args: unknown[]) => {
    if (!referenceCallerAllowed(event) || args.length) return { status: 'held', reasonCode: 'environment_changed' };
    const reply = await referenceRagBuilds.run(event.sender.id, request);
    if (!event.sender.isDestroyed()) event.sender.send('argument-reference:changed');
    return reply;
  });
  ipcMain.handle('argument-reference-rag:cancel', async (event, request: unknown, ...args: unknown[]) => {
    if (!referenceCallerAllowed(event) || args.length) return { status: 'held', reasonCode: 'environment_changed' };
    return referenceRagBuilds.cancel(event.sender.id, request);
  });

  // ===== 应用板块：场景 Skill 包（<vaultRoot>/scene-skills/）=====
  // 目录约定：manifest.json（索引）+ scenes/{sceneId}.json（完整 SceneSpec）
  // 写入顺序由渲染层保证：先写 scene 文件，再 upsert manifest（防悬空引用）
  scenePackHost = registerSceneInteractionPackIpc(ipcMain, { root: path.join(app.getPath('userData'), 'scene-interaction-packs'),
    seed: app.isPackaged ? path.join(process.resourcesPath, 'scene-interaction-packs') : path.join(app.getAppPath(), 'output/scene-interaction-packs'),
    refreshSeed: !app.isPackaged, parent: () => mainWindow,
    allowed: event => referenceCallerAllowed(event) && !applicationExiting && applicationShutdown.getPhase() === 'idle',
    current: () => `${app.getPath('userData')}:${referenceSourceWriteEpoch}` });
  ipcMain.handle('scene-skills:get-dir', async (): Promise<string> => ensureSceneSkillsDir());

  ipcMain.handle('scene-skills:load-manifest', async (): Promise<unknown> => {
    try {
      const dir = await ensureSceneSkillsDir();
      const text = await fs.readFile(path.join(dir, 'manifest.json'), 'utf-8');
      return JSON.parse(text);
    } catch (error) {
      // Only a genuinely absent index is empty. Corruption/permissions must reach the picker.
      if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') {
        return { version: '1.0', updatedAt: new Date().toISOString(), scenes: [] };
      }
      throw error;
    }
  });

  ipcMain.handle('scene-skills:save-manifest', async (_e, manifest: unknown): Promise<void> => {
    const dir = await ensureSceneSkillsDir();
    await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
  });

  ipcMain.handle('scene-skills:load-scene', async (_e, sceneId: unknown): Promise<unknown | null> => {
    try {
      const dir = await ensureSceneSkillsDir();
      const text = await fs.readFile(path.join(dir, 'scenes', `${safeSceneId(sceneId)}.json`), 'utf-8');
      return JSON.parse(text);
    } catch {
      return null;
    }
  });

  ipcMain.handle('scene-skills:save-scene', async (_e, sceneId: unknown, spec: unknown): Promise<void> => {
    const dir = await ensureSceneSkillsDir();
    await fs.writeFile(path.join(dir, 'scenes', `${safeSceneId(sceneId)}.json`), JSON.stringify(spec, null, 2), 'utf-8');
  });

  ipcMain.handle('scene-skills:delete-scene', async (_e, sceneId: unknown): Promise<void> => {
    const dir = await ensureSceneSkillsDir();
    await fs.rm(path.join(dir, 'scenes', `${safeSceneId(sceneId)}.json`), { force: true });
  });

  // 角色模板库（全局共享，vault/scene-skills/roles.json）
  ipcMain.handle('scene-skills:load-roles', async (): Promise<unknown> => {
    try {
      const dir = await ensureSceneSkillsDir();
      const text = await fs.readFile(path.join(dir, 'roles.json'), 'utf-8');
      return JSON.parse(text);
    } catch {
      return { version: '1.0', updatedAt: new Date().toISOString(), roles: [] };
    }
  });

  ipcMain.handle('scene-skills:save-roles', async (_e, file: unknown): Promise<void> => {
    const dir = await ensureSceneSkillsDir();
    await fs.writeFile(path.join(dir, 'roles.json'), JSON.stringify(file, null, 2), 'utf-8');
  });

  // ===== S4 数理场景：SymPy 计算服务（新增，不改动既有 scene-skills:* 语义）=====
  ipcMain.handle('scene-compute:run', async (_e, req: unknown): Promise<ComputeIpcResponse> => {
    try {
      const r = (req || {}) as { cmd?: string; args?: Record<string, unknown> };
      if (!r.cmd) return { ok: false, error: '缺少 cmd', errorCode: 'PROTOCOL_ERROR' };
      return await runSympyCommand(r.cmd as ComputeCommand, r.args || {});
    } catch (e) {
      return { ok: false, error: (e as Error)?.message || '未知错误', errorCode: 'INTERNAL_ERROR' };
    }
  });

  ipcMain.handle('scene-compute:status', (): { ready: boolean; warming: boolean; error?: string } => getSympyStatus());

  // ===== user-state 独立读写 IPC（profile / settings / llm / flow-sessions） =====
  ipcMain.handle('user-state:load-cognition', () => {
    if (referenceEnvironmentSuspended) throw new Error('存储操作中，请稍后读取认知库');
    const directory = getUserStateDir(), epoch = referenceSourceWriteEpoch;
    return loadCognition(directory, () => !referenceEnvironmentSuspended && epoch === referenceSourceWriteEpoch && directory === getUserStateDir());
  });
  ipcMain.handle('user-state:search-cognition', async (_e, query: unknown) => {
    if (referenceEnvironmentSuspended) throw new Error('存储操作中，请稍后检索认知');
    const directory = getUserStateDir(), epoch = referenceSourceWriteEpoch;
    const result = await searchPersonalCognition(directory, query, undefined, () => !referenceEnvironmentSuspended && epoch === referenceSourceWriteEpoch && directory === getUserStateDir());
    if (typeof query !== 'string' || !query.trim()) return result;
    try {
      const materials = await searchCognitionMaterials(query.slice(0, 1000));
      const version = getDataVersion(), notes = await loadMergedNotes();
      if (referenceEnvironmentSuspended || epoch !== referenceSourceWriteEpoch || directory !== getUserStateDir()
        || version !== getDataVersion()) throw new Error('个人素材来源已变化');
      const live = new Set(notes.map(note => note.id));
      return { ...result, materialsStatus: 'ready', materials: materials.filter(hit => live.has(hit.noteId)) };
    } catch {
      return { ...result, materialsStatus: 'unavailable', warning: `${result.warning}个人素材读取失败，不等于没有素材。` };
    }
  });
  ipcMain.handle('user-state:mutate-cognition', async (_e, input: unknown) => {
    if (referenceEnvironmentSuspended) throw new Error('存储操作中，请稍后保存认知');
    const scope = (input as { storageScopeId?: unknown })?.storageScopeId;
    if (scope !== undefined && (typeof scope !== 'string' || scope !== taskScope())) throw new Error('学习表达不属于当前资料库，未写入');
    const directory = getUserStateDir(), epoch = referenceSourceWriteEpoch;
    const next = await mutateCognition(directory, input, () => !referenceEnvironmentSuspended && epoch === referenceSourceWriteEpoch && directory === getUserStateDir());
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send('user-state:cognition-changed');
      } catch { /* A closing window must not turn a committed transaction into a reported failure. */ }
    }
    // Profile facet changed, without changing mastery or objective RAG indices.
    try { onWriteCommitted('profile'); } catch { /* The private write already succeeded. */ }
    return next;
  });
  ipcMain.handle('user-state:load-profile', async (_e, strict = false): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.profile, getUserStateDir(), strict);
    const parsed = text === null ? null : deserializeProfileState(text);
    if (strict && text !== null && (!parsed?.profile?.ability || !parsed.profile.cognitiveStyle)) throw new Error('画像文件格式无效');
    return parsed;
  });

  ipcMain.handle('user-state:save-profile', async (_e, profile: unknown, conceptAliasMap: unknown): Promise<void> => {
    await writeUserStateFile(USER_STATE_FILES.profile, serializeProfileState(profile as never, (conceptAliasMap as Record<string, string>) || {}));
  });

  ipcMain.handle('user-state:load-settings', async (): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.settings, getUserStateDir(), true);
    if (text === null) return null;
    const parsed = JSON.parse(text);
    if (!parsed?.appSettings || typeof parsed.appSettings !== 'object' || Array.isArray(parsed.appSettings)) throw new Error('应用设置文件格式错误，未覆盖原设置');
    return parsed.appSettings;
  });

  ipcMain.handle('user-state:save-settings', async (_e, settings: unknown): Promise<void> => {
    await writeUserStateFile(USER_STATE_FILES.settings, serializeSettingsState(settings as never));
  });

  ipcMain.handle('user-state:load-llm', async (): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.llm, getUserStateDir(), true);
    if (text === null) return null;
    let value: unknown;
    try { value = JSON.parse(text)?.settings; } catch { throw new Error('模型配置文件格式错误，未覆盖原配置'); }
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as any).providers)) throw new Error('模型配置文件格式错误，未覆盖原配置');
    return value;
  });

  ipcMain.handle('user-state:save-llm', async (_e, settings: unknown): Promise<void> => {
    revokeReferenceBuilds();
    await writeUserStateFile(USER_STATE_FILES.llm, serializeLlmState(settings as never));
  });

  ipcMain.handle('user-state:load-mastery-timeline', async (_e, strict?: boolean): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.masteryTimeline, getUserStateDir(), strict === true);
    const value = text ? deserializeMasteryTimelineState(text) : null;
    if (strict === true && text !== null && value === null) throw new Error('学习周报文件格式错误');
    return value;
  });

  ipcMain.handle('user-state:save-mastery-timeline', async (_e, file: unknown): Promise<void> => {
    await writeUserStateFile(USER_STATE_FILES.masteryTimeline, serializeMasteryTimelineState(file as never));
  });

  ipcMain.handle('user-state:load-learning-episodes', async (_e, strict?: boolean): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.learningEpisodes, getUserStateDir(), strict === true);
    const value = text !== null ? deserializeLearningEpisodeState(text, strict === true) : null;
    if (strict === true && text !== null && value === null) throw new Error('学习事件文件格式无效');
    return value;
  });

  ipcMain.handle('user-state:save-learning-episodes', async (_e, file: unknown): Promise<void> => {
    await writeUserStateFile(USER_STATE_FILES.learningEpisodes, serializeLearningEpisodeState(file as never));
  });
  ipcMain.handle('user-state:load-flow-statistics', async (event) => {
    if (!referenceCallerAllowed(event)) throw new Error('复盘统计读取请求无效');
    const directory = getUserStateDir(), value = await loadFlowStatistics(directory);
    if (!referenceCallerAllowed(event) || directory !== getUserStateDir()) throw new Error('复盘统计来源已变化');
    return value;
  });
  ipcMain.handle('user-state:record-flow-statistics', async (event, input: unknown) => {
    if (!referenceCallerAllowed(event)) throw new Error('复盘统计写入请求无效');
    const directory = getUserStateDir(), epoch = referenceSourceWriteEpoch;
    return withRagSourceTransaction([directory], async () => {
      if (!referenceCallerAllowed(event) || directory !== getUserStateDir() || epoch !== referenceSourceWriteEpoch) throw new Error('复盘统计来源已变化');
      await recordFlowStatistics(directory, input);
    });
  });

  ipcMain.handle('user-state:load-style-raw', async (): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.styleRaw);
    return text ? deserializeStyleRawState(text) : null;
  });

  ipcMain.handle('user-state:save-style-raw', async (_e, file: unknown): Promise<void> => {
    await writeUserStateFile(USER_STATE_FILES.styleRaw, serializeStyleRawState(file as never));
  });

  ipcMain.handle('user-state:load-style-snapshot', async (_e, strict?: boolean): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.styleSnapshot, getUserStateDir(), strict === true);
    const value = text ? deserializeStyleSnapshotState(text) : null;
    if (strict === true && text !== null && value === null) throw new Error('表达快照文件格式错误');
    return value;
  });

  ipcMain.handle('user-state:save-style-snapshot', async (_e, file: unknown): Promise<void> => {
    await writeUserStateFile(USER_STATE_FILES.styleSnapshot, serializeStyleSnapshotState(file as never));
  });

  ipcMain.handle('user-state:load-style-trend', async (_e, strict?: boolean): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.styleTrend, getUserStateDir(), strict === true);
    const value = text ? deserializeStyleTrendState(text) : null;
    if (strict === true && text !== null && value === null) throw new Error('表达历史文件格式错误');
    return value;
  });

  ipcMain.handle('user-state:save-style-trend', async (_e, file: unknown): Promise<void> => {
    await writeUserStateFile(USER_STATE_FILES.styleTrend, serializeStyleTrendState(file as never));
  });

  ipcMain.handle('user-state:load-wordcloud', async (_e, strict?: boolean): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.wordCloud, getUserStateDir(), strict === true);
    const value = text ? deserializeWordCloudState(text) : null;
    if (strict === true && text !== null && value === null) throw new Error('词云文件格式错误');
    return value;
  });

  ipcMain.handle('user-state:save-wordcloud', async (_e, file: unknown): Promise<void> => {
    await writeUserStateFile(USER_STATE_FILES.wordCloud, serializeWordCloudState(file as never));
  });

  ipcMain.handle('user-state:load-resource-state', async (): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.resourceState);
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  });

  ipcMain.handle('user-state:save-resource-state', async (_e, file: unknown): Promise<void> => {
    await writeUserStateFile(USER_STATE_FILES.resourceState, JSON.stringify(file, null, 2));
  });

  ipcMain.handle('user-state:load-agent-audit', async (_e, strict?: boolean): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.agentAudit, getUserStateDir(), strict === true);
    if (text === null) return null;
    try {
      const value = JSON.parse(text);
      if (strict === true && (!value || !Array.isArray(value.runs) || (value.handoffs !== undefined && !Array.isArray(value.handoffs)))) throw new Error('审计记录格式错误');
      return value;
    } catch { if (strict === true) throw new Error('审计记录格式错误'); return null; }
  });

  ipcMain.handle('user-state:save-agent-audit', async (_e, file: unknown): Promise<void> => {
    await writeUserStateFile(USER_STATE_FILES.agentAudit, JSON.stringify(file, null, 2));
  });

  ipcMain.handle('user-state:load-agent-checkpoints', async (): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.agentCheckpoints);
    if (!text || text.length > 512_000) return null;
    try { return JSON.parse(text); } catch { return null; }
  });

  ipcMain.handle('user-state:save-agent-checkpoints', async (_e, file: unknown): Promise<void> => {
    const serialized = JSON.stringify(file, null, 2);
    if (serialized.length > 512_000) throw new Error('Agent checkpoint 文件超过 512 KB 安全上限');
    await writeUserStateFile(USER_STATE_FILES.agentCheckpoints, serialized);
  });

  ipcMain.handle('user-state:load-agent-workflow-drafts', async (): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.agentWorkflowDrafts);
    if (!text || text.length > 2_000_000) return null;
    try { return JSON.parse(text); } catch { return null; }
  });

  ipcMain.handle('user-state:save-agent-workflow-drafts', async (_e, file: unknown): Promise<void> => {
    const serialized = JSON.stringify(file, null, 2);
    if (serialized.length > 2_000_000) throw new Error('Agent 工作流草稿文件超过 2 MB 安全上限');
    await writeUserStateFile(USER_STATE_FILES.agentWorkflowDrafts, serialized);
  });

  ipcMain.handle('user-state:load-agent-sessions', async (): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.agentSessions);
    if (!text || text.length > 2_000_000) return null;
    try { return JSON.parse(text); } catch { return null; }
  });

  ipcMain.handle('user-state:load-agent-operations', async (): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.agentOperations, getUserStateDir(), true);
    if (text === null) return null;
    if (text.length > 8_000_000) throw new Error('Agent 操作恢复记录超过容量上限');
    return JSON.parse(text);
  });
  ipcMain.handle('user-state:save-agent-operations', async (_e, file: unknown): Promise<void> => {
    const serialized = JSON.stringify(file);
    if (serialized.length > 8_000_000) throw new Error('Agent 操作恢复记录超过容量上限');
    await writeUserStateFile(USER_STATE_FILES.agentOperations, serialized);
  });

  ipcMain.handle('user-state:save-agent-sessions', async (_e, file: unknown): Promise<void> => {
    const serialized = JSON.stringify(file, null, 2);
    if (serialized.length > 2_000_000) throw new Error('Agent session file exceeds the 2 MB safety limit');
    await writeUserStateFile(USER_STATE_FILES.agentSessions, serialized);
  });

  // Opaque, stable storage identity survives restarts; navigation is NOT identity.
  const taskScope = () => 'tasks-' + createHash('sha256').update(JSON.stringify([getDataRoot(), getVaultRoot(), getUserStateDir()])).digest('hex');
  ipcMain.handle('user-state:agent-task-scope', (event) => {
    if ((!referenceCallerAllowed(event) && !isCognitionWindowCaller(event)) || referenceEnvironmentSuspended) throw new Error('任务存储环境暂不可用');
    return taskScope();
  });
  ipcMain.handle('user-state:load-agent-tasks', async (event) => {
    const cognitionCaller = isCognitionWindowCaller(event);
    if ((!referenceCallerAllowed(event) && !cognitionCaller) || referenceEnvironmentSuspended) throw new Error('任务存储环境暂不可用');
    const scopeId = taskScope(), epoch = referenceSourceWriteEpoch, directory = getUserStateDir();
    const text = await readUserStateFileIfExists(USER_STATE_FILES.agentTasks, directory, true);
    if (scopeId !== taskScope() || epoch !== referenceSourceWriteEpoch || referenceEnvironmentSuspended) throw new Error('任务存储环境发生变化');
    if (text && text.length > 2_000_000) throw new Error('任务恢复文件超过容量');
    const state = normalizeAgentTaskState(text === null ? null : JSON.parse(text));
    return { scopeId, state: cognitionCaller ? { version: 1, documents: [], sequences: {}, ...(state.cognitionAssistant ? { cognitionAssistant: state.cognitionAssistant } : {}) } : state };
  });
  ipcMain.handle('user-state:save-agent-tasks', async (event, scopeId: string, patch: AgentTaskStatePatch) => {
    const cognitionCaller = isCognitionWindowCaller(event);
    if ((!referenceCallerAllowed(event) && !cognitionCaller) || (cognitionCaller && patch?.kind !== 'cognition-assistant')
      || referenceEnvironmentSuspended || scopeId !== taskScope()) throw new Error('任务不属于当前资料库或认知助手范围');
    if (patch?.kind === 'documents' && (!Array.isArray(patch.jobs) || patch.jobs.some(job => job.scopeId !== scopeId))) throw new Error('资料任务缺少可靠的资料库绑定');
    const epoch = referenceSourceWriteEpoch, directory = getUserStateDir(), target = path.join(directory, USER_STATE_FILES.agentTasks);
    // Category patches are merged under the same lock: queue progress cannot
    // overwrite a newer sequence checkpoint, nor can a stale library write.
    const previous = userStateWriteQueues.get(target) || Promise.resolve();
    const write = previous.catch(() => {}).then(() => withRagSourceTransaction([directory], async () => {
      if (referenceEnvironmentSuspended || epoch !== referenceSourceWriteEpoch || scopeId !== taskScope()) throw new Error('任务存储环境发生变化');
      const text = await readUserStateFileIfExists(USER_STATE_FILES.agentTasks, directory, true);
      if (text && text.length > 2_000_000) throw new Error('任务恢复文件超过容量');
      const next = applyAgentTaskStatePatch(text === null ? null : JSON.parse(text), patch);
      await writeUserStateFileUnlocked(directory, USER_STATE_FILES.agentTasks, JSON.stringify(next));
    }));
    userStateWriteQueues.set(target, write);
    try { await write; } finally { if (userStateWriteQueues.get(target) === write) userStateWriteQueues.delete(target); }
  });

  ipcMain.handle('user-state:load-scene-interaction-audit', async (_e, strict?: boolean): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.sceneInteractionAudit, getUserStateDir(), strict === true);
    if (text === null) return null;
    try {
      const value = JSON.parse(text);
      if (strict === true && (!value || !Array.isArray(value.events))) throw new Error('审计记录格式错误');
      return value;
    } catch { if (strict === true) throw new Error('审计记录格式错误'); return null; }
  });

  ipcMain.handle('user-state:save-scene-interaction-audit', async (_e, file: unknown): Promise<void> => {
    await writeUserStateFile(USER_STATE_FILES.sceneInteractionAudit, JSON.stringify(file, null, 2));
  });

  ipcMain.handle('user-state:load-scene-assembly-audit', async (_e, strict?: boolean): Promise<unknown> => {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.sceneAssemblyAudit, getUserStateDir(), strict === true);
    if (text === null) return null;
    try {
      const value = JSON.parse(text);
      if (strict === true && (!value || !Array.isArray(value.events))) throw new Error('审计记录格式错误');
      return value;
    } catch { if (strict === true) throw new Error('审计记录格式错误'); return null; }
  });

  ipcMain.handle('user-state:save-scene-assembly-audit', async (_e, file: unknown): Promise<void> => {
    await writeUserStateFile(USER_STATE_FILES.sceneAssemblyAudit, JSON.stringify(file, null, 2));
  });

  ipcMain.handle('user-state:get-root', async (): Promise<string> => getUserStateDir());

  ipcMain.handle('stt:status', (): { running: boolean } => ({
    running: sttProcess !== null && sttProcess.exitCode === null,
  }));
  ipcMain.handle('stt:get-port', (): number => sttPort);

  // ===== 资料文档 RAG（upload / list / status / retry / delete / search / choose） =====

  // 弹出文件选择框：可索引文档与仅保存附件共用统一资料库。
  ipcMain.handle('ragDocs:choose-files', async (): Promise<string[]> => {
    const res = await dialog.showOpenDialog({
      title: '选择资料或附件',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '支持的资料与附件', extensions: SUPPORTED_DOCUMENT_EXTENSIONS },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (res.canceled || res.filePaths.length === 0) return [];
    return res.filePaths;
  });

  // 上传：复制原始文件到 documents/，写 pending manifest，立即返回，后台入队
  ipcMain.handle('ragDocs:upload', async (_e, filePaths: unknown) => importRagDocumentPaths(filePaths));

  // 列表
  ipcMain.handle('ragDocs:list', async (): Promise<UploadedDocument[]> => (await listDocumentsWithGraphProgress())
    .map(doc=>({...doc,...(indexProgress.has(doc.id)?{bodyIndexProgress:indexProgress.get(doc.id)}:{})})));
  ipcMain.handle('ragDocs:set-category', async (_e, docId: unknown, category: unknown): Promise<void> => {
    const id = String(docId || '');
    const next = typeof category === 'string' ? category.trim() : '';
    if (!id || next.length > 80 || /[\u0000-\u001f\u007f]/u.test(next)) throw new Error('资料分类名称无效');
    if (!(await readManifest()).some((doc) => doc.id === id)) throw new Error('资料不存在');
    await updateManifest(id, { category: next || undefined });
    notifyRagChanged();
  });
  ipcMain.handle('ragDocs:processing-context',()=>String(backgroundGeneration));
  let maintenanceLane: Promise<unknown> = Promise.resolve();
  ipcMain.handle('ragDocs:maintain', (_e, input: DocumentMaintenanceCommand): Promise<void> => {
    const run = maintenanceLane.catch(() => {}).then(async () => {
      if (referenceEnvironmentSuspended) throw new Error('存储操作中，请稍后维护资料');
      const generation = backgroundGeneration;
      const doc = (await listDocumentsWithGraphProgress()).find(item => item.id === input?.documentId);
      validateDocumentMaintenance(input, doc, String(backgroundGeneration));
      if (generation !== backgroundGeneration || referenceEnvironmentSuspended) throw new Error('资料处理环境已变化，请重新确认');
      if (input.operation === 'category') await updateManifest(input.documentId, { category: input.category || undefined });
      else {
        await updateManifest(input.documentId, { status: 'pending', error: undefined });
        if (generation !== backgroundGeneration) throw new Error('资料处理环境已变化，未启动索引任务');
        enqueueVectorization(input.documentId);
      }
      notifyRagChanged();
    });
    maintenanceLane = run;
    return run;
  });

  // 教材物料专用接口：只接受资料 ID 范围，不接受任意文件路径，不改变旧 preview/search 默认值。
  ipcMain.handle('ragDocs:material-list', async (_e, scope: MaterialScope) => materialResult(() => listMaterialDocuments(scope)));
  ipcMain.handle('ragDocs:material-prepare', async (_e, scope: MaterialScope, docId: string) => {
    const result = await materialResult(() => prepareLocalMaterial(scope, docId));
    notifyRagChanged();
    return result;
  });
  ipcMain.handle('ragDocs:material-catalog', async (_e, request: MaterialCatalogRequest) => materialResult(() => getMaterialCatalog(request)));
  ipcMain.handle('ragDocs:material-read', async (_e, request: MaterialReadRequest) => materialResult(() => readMaterialPage(request)));
  ipcMain.handle('ragDocs:material-search', async (_e, request: import('../services/textbook/materialTypes').MaterialSearchRequest) =>
    withDocumentSourceSnapshot(() => materialResult(() => searchMaterialText(request))));
  ipcMain.handle('ragDocs:material-image', async (_e, request: import('../services/textbook/materialTypes').MaterialImageRequest) =>
    withDocumentSourceSnapshot(() => materialResult(() => readMaterialImage(request))));
  const textbookStore = new TextbookStore(getUserStateDir());
  const progressiveVaultRoot = getVaultRoot(), progressiveUserStateRoot = getUserStateDir();
  const progressiveEnvironmentCurrent = () => !referenceEnvironmentSuspended
    && !learningMigrationPending && progressiveVaultRoot === getVaultRoot() && progressiveUserStateRoot === getUserStateDir();
  const progressiveStore = new ProgressiveLearningStore(progressiveUserStateRoot, {
    isCurrent: progressiveEnvironmentCurrent,
    changed: id => progressiveDerived?.notify(id),
    reviewChanged: id => { if(mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('progressive-learning:changed',id); },
    knowledgeIds: async (id,pageId,pageHash) => (await progressiveDerived?.statuses(id))?.find(job=>job.pageId===pageId&&job.pageHash===pageHash&&job.knowledgeReady)?.knowledgeIds||[],
    canBegin: projectNoteId => {
      if (textbookStore.hasRunningProject(projectNoteId)) throw new Error('该项目的原教材任务仍在运行，请等待或停止后再进入渐进学习。');
    },
    // Only the metadata index and selected source note are read; never load all note bodies.
    readTarget: async projectNoteId => withSavedVaultSnapshot(progressiveVaultRoot, progressiveUserStateRoot, async () => {
      if (!progressiveEnvironmentCurrent()) throw new Error('学习存储环境已变化。');
      const metadata = JSON.parse(await fs.readFile(path.join(progressiveVaultRoot, 'metadata.json'), 'utf8'));
      if (metadata?.version !== 1 || !metadata.notesMeta || typeof metadata.notesMeta !== 'object' || Array.isArray(metadata.notesMeta)) throw new Error('笔记目录不可读取，未建立课程。');
      const record = Object.hasOwn(metadata.notesMeta, projectNoteId) ? metadata.notesMeta[projectNoteId] : undefined;
      if (!record || record.noteType !== 'project' || record.projectRole === 'reference') throw new Error('只有学习叶子项目可以建立渐进课程。');
      const isLeaf = !Object.values(metadata.notesMeta).some((entry: any) => entry?.parentId === projectNoteId && entry.noteType === 'project' && entry.projectRole !== 'reference');
      const notesRoot = path.resolve(progressiveVaultRoot, 'notes');
      const noteFile = path.resolve(notesRoot, `${projectNoteId}.md`);
      if (path.dirname(noteFile) !== notesRoot) throw new Error('项目正文路径无效。');
      const noteStat = await fs.lstat(noteFile);
      if (!noteStat.isFile() || noteStat.isSymbolicLink() || noteStat.size > 5_000_000) throw new Error('项目正文不可读取。');
      const content = await fs.readFile(noteFile, 'utf8');
      const note = { ...record, id: projectNoteId, content, dueDates: record.dueDates || [] } as NoteItem;
      let root = note;
      const visited = new Set([note.id]);
      while (root.parentId && Object.hasOwn(metadata.notesMeta, root.parentId)) {
        const parent = metadata.notesMeta[root.parentId];
        if (parent?.noteType !== 'project' || parent.projectRole === 'reference') break;
        if (visited.has(root.parentId)) throw new Error('项目目录包含循环，未建立课程。');
        visited.add(root.parentId);
        root = { ...parent, id: root.parentId, content: '', dueDates: parent.dueDates || [] } as NoteItem;
      }
      if (!progressiveEnvironmentCurrent()) throw new Error('学习存储环境已变化。');
      return { note, root, isLeaf };
    }),
  });
  progressiveLearning = progressiveStore;
  progressiveDerived = new ProgressiveDerivedQueue(progressiveUserStateRoot, {
    store: progressiveStore, isCurrent: progressiveEnvironmentCurrent,
    event:event=>{if(event.operation==='knowledge-ready'&&mainWindow&&!mainWindow.isDestroyed())mainWindow.webContents.send('progressive-learning:changed',event.projectNoteId,'knowledge');},
    linkKnowledge: (projectId, courseId, _page, concepts) => referenceNoteSnapshotSaves.run(() =>
      materializeProgressiveKnowledge(progressiveVaultRoot, progressiveUserStateRoot, projectId, courseId, concepts,
        progressiveEnvironmentCurrent, (created, change) => {
          onWriteCommitted('notes');
          const upserts = [...created, ...(change ? [change.note] : [])], previous = change ? [change.before] : [];
          referenceBuilds.observeNoteDelta(upserts, previous); referenceRagBuilds.observeNoteDelta(upserts, previous);
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('progressive-learning:knowledge', created, change);
          if (changedNoteIndex.request(upserts, [])) deferredChangedNoteIndex.request();
        })),
  });
  void progressiveDerived.recover().catch(error => console.warn('[progressive-derived] 恢复后台任务失败:', error));
  ipcMain.handle('progressive-learning:derived', async (event, input: { op: string; projectNoteId: string; query?: string }) => {
    if (!referenceCallerAllowed(event) || !progressiveEnvironmentCurrent() || !input
      || !['status', 'retry', 'search'].includes(input.op) || typeof input.projectNoteId !== 'string'
      || input.projectNoteId.length > 300) throw Error('后台页面请求无效');
    await progressiveStore.command({ op: 'load', projectNoteId: input.projectNoteId }, event.sender.id);
    if (input.op === 'retry') { progressiveDerived!.notify(input.projectNoteId, true); return true; }
    return input.op === 'status' ? progressiveDerived!.statuses(input.projectNoteId)
      : progressiveDerived!.search(input.projectNoteId, input.query || '');
  });
  // Old whole-book claims and new course begins share an admission order.
  let teachingAdmission: Promise<unknown> = Promise.resolve();
  const admitTeaching = <T,>(work: () => Promise<T>): Promise<T> => {
    const next = teachingAdmission.catch(() => {}).then(work); teachingAdmission = next; return next;
  };
  const progressiveOwners = new Set<number>();
  ipcMain.handle('progressive-learning:command', async (event, input: ProgressiveCommand) => {
    if (learningMigrationPending) throw new Error('已更改存储目录，请先重启软件后继续学习。');
    if (!referenceCallerAllowed(event) || !progressiveEnvironmentCurrent()) throw new Error('当前窗口不能访问渐进学习记录。');
    if (!progressiveOwners.has(event.sender.id)) {
      const owner = event.sender.id; progressiveOwners.add(owner);
      event.sender.once('destroyed', () => { progressiveStore.releaseOwner(owner); progressiveOwners.delete(owner); });
      event.sender.on('render-process-gone', () => progressiveStore.releaseOwner(owner));
      event.sender.on('did-start-navigation', details => {
        if (details.isMainFrame && !details.isSameDocument) progressiveStore.releaseOwner(owner);
      });
    }
    const work = () => progressiveStore.command(input, event.sender.id);
    return input?.op === 'begin' || input?.op === 'next' ? admitTeaching(work) : work();
  });
  const textbookOwners = new Set<number>();
  ipcMain.handle('textbook:request-stop', async (event, jobId: string) => {
    if (!referenceCallerAllowed(event)) throw new Error('当前窗口不能停止教材任务');
    return textbookStore.requestStop(jobId, (owner, request) => {
      const target = BrowserWindow.getAllWindows().find(window => !window.isDestroyed() && window.webContents.id === owner);
      if (!target || target.webContents.isDestroyed()) return false;
      target.webContents.send('textbook:stop-requested', request); return true;
    });
  });
  ipcMain.handle('textbook:read-bound-url', async (event, input: import('../services/textbook/webTypes').TextbookWebReadRequest) => textbookStore.readBoundUrl(input, event.sender.id, loadMergedNotes));
  ipcMain.handle('textbook:supplement', async (event, input: import('../services/textbook/supplement').TextbookSupplementRequest) => textbookStore.supplement(input, event.sender.id, loadMergedNotes));
  ipcMain.handle('textbook:cancel-web-read', async (event, jobId: string, token: string) => textbookStore.cancelWebRead(jobId, token, event.sender.id));
  ipcMain.handle('textbook:read-web-evidence', async (_event, input: import('../services/textbook/webTypes').TextbookWebEvidenceRequest) => textbookStore.readWebEvidence(input, loadMergedNotes));
  ipcMain.handle('textbook:figure-approval', async (event, input: { jobId?: unknown; projectId?: unknown; bodyDigest?: unknown }) => {
    if (applicationExiting || referenceEnvironmentSuspended || event.sender !== mainWindow?.webContents
      || event.senderFrame !== event.sender.mainFrame || !isTrustedRendererLocation(event.senderFrame.url) || typeof input?.jobId !== 'string') throw Error('无法验证教材生成许可');
    const { job } = await textbookStore.command({ op: 'get', jobId: input.jobId }, event.sender.id, loadMergedNotes);
    return interactiveFigureApproval(job, input.projectId, input.bodyDigest);
  });
  ipcMain.handle('textbook:command', async (event, input: TextbookJobCommand) => {
    if (!textbookOwners.has(event.sender.id)) {
      textbookOwners.add(event.sender.id);
      const owner = event.sender.id;
      event.sender.once('destroyed', () => { textbookStore.releaseOwner(owner); textbookOwners.delete(owner); });
      event.sender.on('render-process-gone', () => textbookStore.releaseOwner(owner));
      event.sender.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) textbookStore.releaseOwner(owner);
      });
    }
    if (input?.op === 'claim') return admitTeaching(async () => {
      const { job } = await textbookStore.command({ op: 'get', jobId: input.jobId }, event.sender.id, loadMergedNotes);
      if (await progressiveStore.hasCourse(job.spec.projectNoteId)) throw new Error('该项目已有渐进课程，请在心流中继续；原教材草稿已保留。');
      return textbookStore.command(input, event.sender.id, loadMergedNotes);
    });
    return textbookStore.command(input, event.sender.id, loadMergedNotes);
  });
  ipcMain.handle('textbook:source-hash', async (_e, scope: MaterialScope, docId: string) => fingerprintMaterialSource(scope, docId));
  ipcMain.handle('textbook:list', async (_e, projectNoteId: string) => textbookStore.list(projectNoteId));

  ipcMain.handle('ragDocs:preview', async (_e, input: string | { docId?: string; chunkId?: string }) => {
    const docId = typeof input === 'string' ? input : String(input?.docId || '');
    const chunkId = typeof input === 'string' ? undefined : String(input?.chunkId || '') || undefined;
    const preview = await getDocumentPreview(docId, 40, chunkId);
    if (!preview) return { ok: false, error: '资料不存在' };
    const graphDoc=(await listDocumentsWithGraphProgress()).find(d=>d.id===docId);
    return { ok: true, preview:{...preview,document:graphDoc||preview.document} };
  });

  // 单文档状态
  ipcMain.handle('ragDocs:status', async (_e, docId: string) => {
    const docs = await readManifest();
    const d = docs.find((x) => x.id === docId);
    if (!d) return { status: 'failed' as const, chunkCount: 0, totalChars: 0, error: '文档不存在' };
    return { status: d.status, chunkCount: d.chunkCount, totalChars: d.totalChars, error: d.error,
      parseStatus: d.parseStatus, parseError: d.parseError, parsedAt: d.parsedAt };
  });

  // 重试失败文档
  ipcMain.handle('ragDocs:retry', async (_e, docId: string): Promise<void> => {
    const doc = (await readManifest()).find((item) => item.id === docId);
    if (!doc?.indexable) return;
    // Body-only rebuild. A graph remains usable only if its source fingerprint still matches.
    await updateManifest(docId, { status: 'pending', error: undefined });
    enqueueVectorization(docId);
    notifyRagChanged();
  });

  // 删除：原始文件 + manifest + chunks
  ipcMain.handle('ragDocs:delete', async (_e, docId: string): Promise<void> => {
    if (referenceEnvironmentSuspended) throw new Error('存储操作中，请稍后删除');
    referenceEnvironments.revoke();
    revokeReferenceBuilds();
    await deleteDocumentSourceFiles(docId);
    await deleteKnowledgeDocument(docId);
    notifyRagChanged();
  });

  ipcMain.handle('ragDocs:reading-source', async (event, docId: string) => materialResult(async () => {
    if (!referenceCallerAllowed(event) || referenceEnvironmentSuspended) throw new Error('reader_unavailable');
    const epoch = referenceSourceWriteEpoch;
    const doc = await materialMetadata({ allowedDocIds: [docId] }, docId);
    const file = await materialSourcePath(doc);
    if (referenceEnvironmentSuspended || epoch !== referenceSourceWriteEpoch) throw new Error('reader_environment_changed');
    return doc.fileType === 'pdf' && doc.extension === '.pdf'
      ? { docId: doc.id, fileName: doc.fileName, kind: 'pdf' as const, url: pathToFileURL(file).href }
      : { docId: doc.id, fileName: doc.fileName, kind: 'text' as const };
  }));

  ipcMain.handle('ragDocs:open', async (_e, docId: string): Promise<{ ok: boolean; error?: string }> => {
    const doc = (await readManifest()).find((item) => item.id === String(docId || ''));
    if (!doc) return { ok: false, error: '资料不存在' };
    const filePath = path.join(await getDocumentsDir(), storedFileName(doc.id, doc.extension));
    const error = await shell.openPath(filePath);
    return error ? { ok: false, error } : { ok: true };
  });

  // 检索（仅 ready 文档）
  ipcMain.handle('ragDocs:reset-argument-v5',async(event,docId:string)=>{
    if(!referenceCallerAllowed(event)||referenceEnvironmentSuspended)throw new Error('document_graph_unavailable');
    // Invalidate in-flight graph commits before resetting work-in-progress.
    referenceSourceWriteEpoch++;
    await resetDocumentArgumentV5(docId);notifyRagChanged();
  });
  ipcMain.handle('ragDocs:argument-v5-view',async(event,docId:string)=>{
    if(!referenceCallerAllowed(event)||referenceEnvironmentSuspended)throw new Error('document_graph_unavailable');
    const epoch=referenceSourceWriteEpoch,result=await readDocumentArgumentV5View(docId);
    if(referenceEnvironmentSuspended||epoch!==referenceSourceWriteEpoch)throw new Error('document_graph_environment_changed');
    return result;
  });
  ipcMain.handle('ragDocs:prepare-document-graph', async (event, docId: string) => {
    if (!referenceCallerAllowed(event) || referenceEnvironmentSuspended) throw new Error('document_graph_unavailable');
    const epoch=referenceSourceWriteEpoch, result=await prepareDocumentGraphSource(docId);
    if (referenceEnvironmentSuspended || epoch!==referenceSourceWriteEpoch) throw new Error('document_graph_environment_changed');
    return {...result,environmentId:String(epoch)};
  });
  ipcMain.handle('ragDocs:prepare-argument-v5', async (event, docId: string) => {
    if (!referenceCallerAllowed(event) || referenceEnvironmentSuspended) throw new Error('document_graph_unavailable');
    const epoch=referenceSourceWriteEpoch, result=await prepareDocumentArgumentV5(docId);
    if (referenceEnvironmentSuspended || epoch!==referenceSourceWriteEpoch) throw new Error('document_graph_environment_changed');
    return {...result,environmentId:String(epoch)};
  });
  ipcMain.handle('ragDocs:commit-argument-v5', async (event, input: DocumentArgumentV5Commit, environmentId: string) => {
    if (!referenceCallerAllowed(event) || referenceEnvironmentSuspended || environmentId!==String(referenceSourceWriteEpoch)) throw new Error('document_graph_unavailable');
    const epoch=referenceSourceWriteEpoch;
    const result=await commitDocumentArgumentV5(input,{assertEnvironment:()=>{
      if (!referenceCallerAllowed(event) || referenceEnvironmentSuspended || epoch!==referenceSourceWriteEpoch) throw new Error('document_graph_environment_changed');
    }});
    notifyRagChanged(); return result;
  });
  ipcMain.handle('ragDocs:record-argument-v5-response',async(event,input:import('../services/documentArgumentV5Types').DocumentArgumentV5ResponseRecord,environmentId:string)=>{
    const assertEnvironment=()=>{
      if(!referenceCallerAllowed(event)||referenceEnvironmentSuspended||environmentId!==String(referenceSourceWriteEpoch))throw new Error('document_graph_environment_changed');
    };
    assertEnvironment();await recordDocumentArgumentV5Response(input,assertEnvironment);
  });
  ipcMain.handle('ragDocs:argument-v5-bridges', async (event, input: DocumentArgumentV5Commit, environmentId: string) => {
    if (!referenceCallerAllowed(event) || referenceEnvironmentSuspended || environmentId!==String(referenceSourceWriteEpoch)) throw new Error('document_graph_unavailable');
    const epoch=referenceSourceWriteEpoch, result=await recallDocumentArgumentV5Bridges(input);
    if (referenceEnvironmentSuspended || epoch!==referenceSourceWriteEpoch) throw new Error('document_graph_environment_changed');
    return result;
  });
  ipcMain.handle('ragDocs:commit-document-graph', async (event, input: DocumentGraphCommit,environmentId?:string) => {
    if (!referenceCallerAllowed(event) || referenceEnvironmentSuspended) throw new Error('document_graph_unavailable');
    if(input.build&&environmentId!==String(referenceSourceWriteEpoch))throw new Error('document_graph_environment_changed');
    const epoch=referenceSourceWriteEpoch;
    const result=await commitDocumentGraph(input,{assertEnvironment:() => {
      if (referenceEnvironmentSuspended || epoch!==referenceSourceWriteEpoch || !referenceCallerAllowed(event)) throw new Error('document_graph_environment_changed');
    }});
    notifyRagChanged(); return result;
  });
  ipcMain.handle('ragDocs:graph-candidates', async(event,input:DocumentGraphCommit,targetIds:string[])=>{
    if(!referenceCallerAllowed(event)||referenceEnvironmentSuspended)throw new Error('document_graph_unavailable');
    const epoch=referenceSourceWriteEpoch,result=await recallDocumentGraphCandidates(input,targetIds);
    if(referenceEnvironmentSuspended||epoch!==referenceSourceWriteEpoch)throw new Error('document_graph_environment_changed');return result;
  });
  ipcMain.handle('ragDocs:read-argument-evidence', async (event, anchors: unknown, query?:string, intentQuery?:string) => {
    if (!referenceCallerAllowed(event) || referenceEnvironmentSuspended) throw new Error('qa_graph_reader_unavailable');
    const epoch = referenceSourceWriteEpoch;
    const result = await readQaDocumentGraph(anchors,query,undefined,{intentQuery});
    if (referenceEnvironmentSuspended || epoch !== referenceSourceWriteEpoch) throw new Error('qa_graph_source_environment_changed');
    return result;
  });
  ipcMain.handle('ragDocs:search', async (event, query: string, k?: number, options?: DocumentSearchOptions): Promise<unknown[]> => {
    if (options?.argumentEnvironmentId === undefined) return searchDocuments(query, typeof k === 'number' ? k : 5, options);
    if (!referenceCallerAllowed(event) || typeof options.argumentEnvironmentId !== 'string') return [];
    try {
      return await referenceEnvironments.withEnvironment(event.sender.id, options.argumentEnvironmentId, async (runtime, roots, scope) => {
        const allowedDocIds = scope.allowedDocIds.filter(id => options.allowedDocIds === undefined || options.allowedDocIds.includes(id));
        const hits = await searchDocuments(query, typeof k === 'number' ? k : 5, { ...options, allowedDocIds });
        return createArgumentSearchBridge({ environmentId: options.argumentEnvironmentId!, store: runtime.store,
          readSavedDocumentChunk: (docId, chunkId) => readSavedArgumentDocumentChunk(roots.dataRoot, docId, chunkId) }).attachDocumentHits(hits);
      });
    } catch { return []; }
  });

  // ===== L2 knowledge 索引任务协议（模型提交标签，主进程回填证据并校验） =====
  ipcMain.handle('ragKnowledge:get-settings', async (): Promise<RagKnowledgeSettings> => readKnowledgeSettings());

  ipcMain.handle('ragKnowledge:set-enabled', async (_e, input: Partial<RagKnowledgeSettings>) => {
    const settings = await writeKnowledgeSettings({
      enabled: input?.enabled === true,
      processingMode: input?.processingMode === 'allow-cloud' ? 'allow-cloud' : 'local-only',
    });
    const docs = (await readManifest()).filter((doc) => doc.indexable && doc.status === 'ready' && !doc.needsReindex);
    if (!settings.enabled) {
      await recoverKnowledgeJobs(docs.map((doc) => doc.id));
    }
    for (const doc of docs) {
      const status = settings.enabled
        ? await ensureKnowledgeJob(doc.id, await readChunksFile(doc.id))
        : await readKnowledgeStatus(doc.id);
      await persistKnowledgeStatus(status);
    }
    notifyRagChanged();
    return settings;
  });

  ipcMain.handle('ragKnowledge:get-status', async (_e, docId: string) => {
    return readKnowledgeStatus(String(docId || ''));
  });

  ipcMain.handle('ragKnowledge:get-pending-batch', async (_e, maxChunks?: number) => {
    const readyIds = (await readManifest())
      .filter((doc) => doc.indexable && doc.status === 'ready' && !doc.needsReindex)
      .map((doc) => doc.id);
    const batch = await getPendingKnowledgeBatch(readyIds, readChunksFile, maxChunks);
    for (const docId of new Set(batch.map((item) => item.docId))) {
      await persistKnowledgeStatus(await readKnowledgeStatus(docId));
    }
    if (batch.length > 0) notifyRagChanged();
    return batch;
  });

  ipcMain.handle('ragKnowledge:commit-batch', async (_e, input: RagKnowledgeBatchCommit) => {
    if (!input || typeof input.docId !== 'string' || typeof input.generationId !== 'string' || !Array.isArray(input.items)) {
      throw new Error('knowledge commit 参数无效');
    }
    const status = await commitKnowledgeBatch(input, readChunksFile);
    await persistKnowledgeStatus(status);
    notifyRagChanged();
    return status;
  });

  ipcMain.handle('ragKnowledge:mark-batch-failed', async (_e, input: {
    docId?: string;
    generationId?: string;
    chunkIds?: string[];
    error?: string;
  }) => {
    if (!input?.docId || !input.generationId || !Array.isArray(input.chunkIds)) {
      throw new Error('knowledge failure 参数无效');
    }
    const status = await failKnowledgeBatch(input.docId, input.generationId, input.chunkIds, input.error || '知识抽取失败');
    await persistKnowledgeStatus(status);
    notifyRagChanged();
    return status;
  });

  ipcMain.handle('ragKnowledge:retry-document', async (_e, docId: string) => {
    const document = (await readManifest()).find((doc) => doc.id === String(docId || '') && doc.status === 'ready');
    if (!document) throw new Error('仅能重试 L1 已就绪的资料');
    const status = await ensureKnowledgeJob(document.id, await readChunksFile(document.id), true);
    await persistKnowledgeStatus(status);
    notifyRagChanged();
    return status;
  });

  // ===== 笔记本体 RAG（主进程中文模型 + 混合检索） =====
  ipcMain.handle('noteRag:flush-pending', () => { deferredNoteIndex.flush(); deferredChangedNoteIndex.flush(); });
  const editingSenders = new Set<number>();
  ipcMain.handle('noteRag:editing', (event, active: unknown) => {
    if (!referenceCallerAllowed(event) || typeof active !== 'boolean') return;
    const owner = event.sender.id;
    if (active && !editingSenders.has(owner)) {
      editingSenders.add(owner);
      event.sender.once('destroyed', () => { editingSenders.delete(owner); deferredNoteIndex.setEditing(owner, false); deferredChangedNoteIndex.setEditing(owner, false); });
    }
    deferredNoteIndex.setEditing(owner, active);
    deferredChangedNoteIndex.setEditing(owner, active);
  });
  ipcMain.handle('noteRag:index', async (_e, input: NoteRagIndexInput): Promise<void> => {
    return serializeNoteSourceIndex(async () => {
      const root = getVaultRoot(), states = getUserStateDir(), epoch = referenceSourceWriteEpoch, version = getDataVersion();
      const current = () => !referenceEnvironmentSuspended && root === getVaultRoot() && states === getUserStateDir()
        && epoch === referenceSourceWriteEpoch && version === getDataVersion();
      const notes = await readSavedVaultNotesByIds(root, states, [input?.id], { isCurrent: current });
      currentNoteReferenceInput(input, notes); // Renderer data cannot authorize indexing an unsaved body.
      changedNoteIndex.requestIds([input.id]);
      await changedNoteIndex.run();
    });
  });

  ipcMain.handle('noteRag:index-all', async (_e, inputs: NoteRagIndexInput[]): Promise<void> => {
    return serializeNoteSourceIndex(async () => {
      await syncCognitionMaterialNotes(inputs);
      const root = getVaultRoot(), version = getDataVersion(), notes = await loadMergedNotes();
      let referenceError: unknown;
      try {
        if (root !== getVaultRoot()) throw new Error('参考索引目录已切换');
        if (version !== getDataVersion()) throw new Error('参考原文读取期间已更新');
        await noteRagIndexNotes(notes);
      } catch (error) { referenceError = error; }
      await syncUserArgumentNotes(inputs, generateRagEmbedding);
      await syncSavedFlowReviewNotes(notes);
      await archiveLegacyUserArgumentShards().catch((error) => console.warn('[cognition-materials] 旧衍生索引归档未完成:', error));
      if (referenceError) throw referenceError;
    });
  });

  const deleteSavedNoteIndexes = (noteIds: unknown): Promise<void> => {
    validateNoteIndexCleanupIds(noteIds);
    // IPC only wakes already durable jobs; it cannot invent deletion authority.
    return resumeDeletedNoteIndexCleanup();
  };
  ipcMain.handle('noteRag:delete', async (_e, noteId: string): Promise<void> => deleteSavedNoteIndexes([noteId]));
  ipcMain.handle('noteRag:delete-many', async (_e, noteIds: unknown): Promise<void> => deleteSavedNoteIndexes(noteIds));

  ipcMain.handle('noteRag:search', async (event, query: string, k?: number, options?: { argumentEnvironmentId: string } | { allowedNoteIds: string[] }): Promise<unknown[]> => {
    const searchCurrent = async (allowedNoteIds?: string[]) => {
      const root = getVaultRoot(), states = getUserStateDir(), epoch = referenceSourceWriteEpoch;
      const hits = await noteRagSearchNotes(query, typeof k === 'number' ? k : 5, allowedNoteIds);
      const version = getDataVersion();
      const current = () => !referenceEnvironmentSuspended && root === getVaultRoot() && states === getUserStateDir()
        && epoch === referenceSourceWriteEpoch && version === getDataVersion();
      if (!current()) return [];
      // Validate only ranked candidates against their saved originals. A short
      // memory lookup must not deserialize every Markdown body in the vault.
      const notes = await readSavedVaultNotesByIds(root, states, [...new Set(hits.map(hit => hit.noteId))], { isCurrent: current });
      return current() ? hits.filter((hit) => isCurrentNoteReferenceHit(hit, notes)) : [];
    };
    if (options === undefined) return searchCurrent();
    if (options && Object.keys(options).join() === 'allowedNoteIds' && 'allowedNoteIds' in options) {
      // This only narrows the already-public reference search; it never grants an argument-environment lease.
      if (!referenceCallerAllowed(event) || !Array.isArray(options.allowedNoteIds) || options.allowedNoteIds.length > 100
        || options.allowedNoteIds.some(id => typeof id !== 'string' || !id.trim() || id.length > 500)) return [];
      if (!options.allowedNoteIds.length) return [];
      return searchCurrent([...new Set(options.allowedNoteIds)]);
    }
    if (!referenceCallerAllowed(event) || !options || !('argumentEnvironmentId' in options) || Object.keys(options).join() !== 'argumentEnvironmentId' || typeof options.argumentEnvironmentId !== 'string') return [];
    try {
      return await referenceEnvironments.withEnvironment(event.sender.id, options.argumentEnvironmentId, async (runtime, roots, scope) => {
        // Scope BEFORE ranking: another project's global top-k cannot crowd out
        // this learning activity's references. Caller supplies a lease, not IDs.
        const currentHits = await searchCurrent(scope.allowedNoteIds);
        return createArgumentSearchBridge({ environmentId: options.argumentEnvironmentId, store: runtime.store,
          readSavedKnowledgeNote: id => readSavedArgumentReferenceNote({ ...roots, scope }, id) })
          .attachNoteHits(currentHits.filter(hit => scope.allowedNoteIds.includes(hit.noteId)));
      });
    } catch { return []; }
  });
  ipcMain.handle('noteRag:status', async (_e, noteId: string) => {
    if (typeof noteId !== 'string' || !noteId.trim() || noteId.length > 300) throw new Error('笔记 ID 无效');
    return getNoteIndexStatus(noteId);
  });
  ipcMain.handle('noteRag:flow-review-status', async (event, noteId: string) => {
    if (!mainWindow || event.sender.id !== mainWindow.webContents.id || event.senderFrame !== event.sender.mainFrame
      || typeof noteId !== 'string' || !noteId || noteId.length > 300) throw new Error('个人素材索引读取请求无效');
    return getSavedFlowReviewStatus(noteId);
  });

  // ===== 受管项目教材 RAG（独立派生索引） =====
  ipcMain.handle('textbookRag:search', async (event, query: string, k?: number, allowedNoteIds?: string[]) => {
    if (!referenceCallerAllowed(event) || typeof query !== 'string' || !Array.isArray(allowedNoteIds)
      || allowedNoteIds.length > 50 || allowedNoteIds.some((id) => typeof id !== 'string' || !id.trim() || id.length > 500)) return [];
    if (!allowedNoteIds.length) return [];
    const root = getVaultRoot(), version = getDataVersion();
    const hits = await searchTextbookReferences(query, typeof k === 'number' ? k : 3, [...new Set(allowedNoteIds)]);
    return root === getVaultRoot() && version === getDataVersion() ? hits : [];
  });
  ipcMain.handle('textbookRag:status', async (event, noteId: string) => {
    if (!referenceCallerAllowed(event) || typeof noteId !== 'string' || !noteId.trim() || noteId.length > 500) {
      throw new Error('项目笔记 ID 无效');
    }
    return getTextbookReferenceStatus(noteId);
  });
  ipcMain.handle('textbookRag:rebuild', async (event, noteId: string) => {
    if (!referenceCallerAllowed(event) || typeof noteId !== 'string' || !noteId.trim() || noteId.length > 500) {
      throw new Error('项目笔记 ID 无效');
    }
    const note = (await loadMergedNotes()).find((item) => item.id === noteId && item.noteType === 'project' && item.textbook);
    if (!note) throw new Error('项目尚未生成可索引教材');
    await syncTextbookReferenceNote(note, true);
    return getTextbookReferenceStatus(noteId);
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
  ipcMain.handle('cognition-manager:open', async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame
      || !isTrustedRendererLocation(event.senderFrame.url)) throw new Error('无权打开个人认知窗口');
    if (cognitionWindow && !cognitionWindow.isDestroyed()) { cognitionWindow.show(); cognitionWindow.focus(); return; }
    const win = new BrowserWindow({ width: 1280, height: 850, minWidth: 720, minHeight: 560, title: '个人认知 · LogiNote',
      show: false, backgroundColor: windowThemeBackground(currentWindowTheme),
      webPreferences: { preload: path.join(app.getAppPath(), 'dist-electron', 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
        additionalArguments: windowThemeReady ? [`--loginote-theme=${currentWindowTheme}`] : [] } });
    cognitionWindow = win; cognitionWindowBusy = false; installMainWindowNavigationGuard(win);
    win.on('close', event => { if (cognitionWindowBusy) event.preventDefault(); });
    win.webContents.on('will-prevent-unload', event => {
      if (cognitionWindowBusy) return;
      const choice = dialog.showMessageBoxSync(win, { type: 'question', title: '尚有未保存的理解', message: '要放弃本窗口尚未保存的编辑并退出吗？',
        buttons: ['继续编辑', '放弃编辑并退出'], defaultId: 0, cancelId: 0 });
      if (choice === 1 && !cognitionWindowBusy) event.preventDefault();
    });
    win.on('closed', () => { if (cognitionWindow === win) { cognitionWindow = null; cognitionWindowBusy = false; } });
    try { await win.loadFile(path.join(app.getAppPath(), 'dist', 'cognition.html')); win.show(); win.focus(); }
    catch (error) { if (!win.isDestroyed()) win.destroy(); throw error; }
  });
  ipcMain.on('cognition-manager:busy', (event, value: unknown) => {
    if (isCognitionWindowCaller(event) && typeof value === 'boolean') cognitionWindowBusy = value;
  });
  ipcMain.handle('window:theme-get', () => currentWindowTheme);
  ipcMain.handle('window:theme-update', (event, value: unknown): boolean => {
    const theme = normalizeWindowTheme(value);
    // 独立窗口只跟随主窗口，不建立第二套偏好，也不允许网页修改应用外观。
    if (!theme || !mainWindow || mainWindow.isDestroyed()
      || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) return false;
    if (!windowThemeReady || theme !== currentWindowTheme) publishWindowTheme(theme);
    return true;
  });
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

function createArgumentWindow(): void {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 960,
    minHeight: 640,
    // 原生标题栏：独立工具窗口需可拖动到主窗口之外，并自带关闭/最小化
    resizable: true,
    title: '论证结构编辑器',
    backgroundColor: windowThemeBackground(currentWindowTheme),
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist-electron', 'preload.cjs'),
      additionalArguments: windowThemeReady ? [`--loginote-theme=${currentWindowTheme}`] : [],
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
    },
  });

  argumentWindow = win;
  win.on('close', (event) => {
    // A native close must not interrupt an accepted write.
    if (argumentPersistence.busy()) event.preventDefault();
  });
  win.webContents.on('will-prevent-unload', (event) => {
    if (argumentPersistence.busy()) return;
    const response = dialog.showMessageBoxSync(win, {
      type: 'question', title: '尚有未保存的修改',
      message: '退出会放弃本窗口中未保存的编辑，是否继续？',
      buttons: ['继续编辑', '放弃修改并退出'], defaultId: 0, cancelId: 0,
    });
    if (response === 1 && !argumentPersistence.busy()) event.preventDefault();
  });
  win.on('closed', () => {
    if (argumentWindow === win) {
      argumentWindow = null;
      pendingArgumentData = null;
    }
  });

  // 页面加载完成后，把缓存的数据推送给编辑器窗口
  win.webContents.on('did-finish-load', () => {
    if (pendingArgumentData) {
      win.webContents.send('argument-editor:data', pendingArgumentData);
    }
  });

  win.loadFile(path.join(app.getAppPath(), 'dist', 'argument-editor.html'));
}

function isTrustedRendererLocation(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== 'file:') return false;
    const rendererRoot = path.resolve(app.getAppPath(), 'dist');
    const candidate = path.resolve(fileURLToPath(url));
    return candidate === rendererRoot || candidate.startsWith(`${rendererRoot}${path.sep}`);
  } catch {
    return false;
  }
}

/** This grants only scope identity/busy signalling, not any reference-library authority. */
function isCognitionWindowCaller(event: Pick<Electron.IpcMainInvokeEvent, 'sender' | 'senderFrame'>): boolean {
  if (!cognitionWindow || cognitionWindow.isDestroyed() || event.sender !== cognitionWindow.webContents
    || event.senderFrame !== event.sender.mainFrame) return false;
  try { const url = new URL(event.senderFrame.url); return url.protocol === 'file:'
    && path.resolve(fileURLToPath(url)) === path.resolve(app.getAppPath(), 'dist', 'cognition.html'); } catch { return false; }
}

/** A frameless app window must never be replaced by an arbitrary web page. */
function installMainWindowNavigationGuard(win: BrowserWindow): void {
  const openExternalSafely = (rawUrl: string) => {
    try {
      const url = new URL(rawUrl);
      if (!['http:', 'https:'].includes(url.protocol)) return;
      void shell.openExternal(url.href).catch((error) => console.warn('[navigation] 打开外部链接失败', error));
    } catch {
      // Invalid or non-public links stay inside the note as inert text.
    }
  };

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalSafely(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedRendererLocation(url)) return;
    event.preventDefault();
    openExternalSafely(url);
  });
  win.webContents.on('before-input-event', (event, input) => {
    if (isTrustedRendererLocation(win.webContents.getURL())) return;
    const wantsReturn = input.type === 'keyDown'
      && (input.key === 'Escape' || (input.alt && input.key === 'ArrowLeft'));
    if (!wantsReturn || !win.webContents.canGoBack()) return;
    event.preventDefault();
    win.webContents.goBack();
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    backgroundColor: windowThemeBackground(currentWindowTheme),
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
      additionalArguments: windowThemeReady ? [`--loginote-theme=${currentWindowTheme}`] : [],
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
  win.on('close', (event) => {
    if (process.platform !== 'darwin' && applicationShutdown.getPhase() !== 'ready') {
      event.preventDefault();
      void applicationShutdown.request();
      return;
    }
    if (!argumentPersistence.busy()) return;
    event.preventDefault();
    dialog.showMessageBoxSync(win, {
      type: 'info', title: '正在保存论证内容',
      message: '请等待独立编辑器的保存结果返回后，再关闭主窗口。',
      buttons: ['返回页面'], defaultId: 0, cancelId: 0,
    });
  });

  installMainWindowNavigationGuard(win);

  win.webContents.on('will-prevent-unload', () => {
    // Do not override renderer protection: scene/review/cognition guards also own it.
    dialog.showMessageBoxSync(win, {
      type: 'info', title: '当前页面暂不能退出',
      message: '请返回页面处理未保存的内容，或先结束当前学习。',
      detail: '笔记或应用设置保存失败时，请返回页面重试保存；场景需完成后点击“退出场景”。',
      buttons: ['返回页面'], defaultId: 0, cancelId: 0,
    });
  });
  win.webContents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) { referenceEnvironments.revoke(win.webContents.id); referenceQuestions.revoke(win.webContents.id); revokeReferenceBuilds(win.webContents.id); }
  });
  win.webContents.once('destroyed', () => { referenceEnvironments.revoke(win.webContents.id); referenceQuestions.revoke(win.webContents.id); revokeReferenceBuilds(win.webContents.id); });
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  win.loadFile(path.join(app.getAppPath(), 'dist', 'index.html'));
  singleInstance.windowReady();
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

app.whenReady().then(async () => {
  if (!singleInstance.primary) return;
  setDataRoot(getDataRoot());
  setKnowledgeDataRoot(getDataRoot());
  setUserArgumentDataRoot(getDataRoot());
  setFlowReviewArgumentDataRoot(getDataRoot());
  setCognitionMaterialDataRoot(getDataRoot());
  setResourceBrowserUserStateDir(getUserStateDir());
  configureWebAcquisition(readLlmProviderAuthoritySettings);
  try {
    const text = await readUserStateFileIfExists(USER_STATE_FILES.settings);
    const settings = text ? deserializeSettingsState(text) : null;
    const storedTheme = settings?.theme === 'system' ? resolvePreferredWindowTheme('system', nativeTheme.shouldUseDarkColors) : normalizeWindowTheme(settings?.theme);
    if (storedTheme) publishWindowTheme(storedTheme);
  } catch (error) {
    console.warn('[appearance] 无法读取初始主题，使用默认主题', error);
  }
  setModelsDir(resolveModelsDir());
  setPdfExtractScript(app.isPackaged
    ? path.join(process.resourcesPath, 'python', 'pdf_extract.py')
    : path.join(app.getAppPath(), 'python', 'pdf_extract.py'));
  if (applicationExiting) return;
  configureBackgroundCompute();
  setNoteRagDataRoot(getDataRoot());
  setTextbookReferenceDataRoot(getDataRoot());
  void spawnSttServer();
  // S4 math starts on the first compute request, not on application startup.
  registerIpcHandlers();
  mermaidProcess = createMermaidProcessHost(app.getAppPath());
  mermaidProcess.register(ipcMain, event => event.senderFrame === event.sender.mainFrame
    && event.sender !== undefined && (event.sender === mainWindow?.webContents || event.sender === argumentWindow?.webContents || event.sender === cognitionWindow?.webContents)
    && isTrustedRendererLocation(event.senderFrame.url));
  disposeInteractiveFigure = registerInteractiveFigureSandbox(ipcMain, event => event.senderFrame === event.sender.mainFrame
    && event.sender === mainWindow?.webContents && isTrustedRendererLocation(event.senderFrame.url));
  ipcMain.handle('interactive-figure:artifact', async (event, input: unknown) => {
    if (applicationExiting || referenceEnvironmentSuspended || event.sender !== mainWindow?.webContents
      || event.senderFrame !== event.sender.mainFrame || !isTrustedRendererLocation(event.senderFrame.url)) throw Error('交互图附件操作不可用');
    const request = input as { op?: unknown; key?: unknown; artifact?: unknown; expected?: unknown } | null;
    if (!request || !['read', 'write', 'listManual', 'addManual', 'describe', 'clearUnfinished', 'compareReady'].includes(request.op as string)) throw Error('交互图附件请求无效');
    const root = getUserStateDir(), epoch = referenceSourceWriteEpoch, store = new InteractiveFigureStore(root);
    const current = () => !applicationExiting && !referenceEnvironmentSuspended && root === getUserStateDir() && epoch === referenceSourceWriteEpoch;
    if (request.op === 'read') { const html = await store.read(request.key); if (!current()) throw Error('数据位置已变化'); return html; }
    if (request.op === 'listManual') { const items = await store.listManual(request.key); if (!current()) throw Error('数据位置已变化'); return items; }
    if (request.op === 'describe') { const summary = await store.describe(request.key); if (!current()) throw Error('数据位置已变化'); return summary; }
    if (!current()) throw Error('数据位置已变化');
    if (request.op === 'addManual') { const items = await store.addManual(request.key, request.artifact); if (!current()) throw Error('数据位置已变化'); return items; }
    if (request.op === 'clearUnfinished') { const result = await store.clearUnfinished(request.key, request.artifact as { indexKey: unknown; brief: unknown; keepTombstone?: boolean } | undefined); if (!current()) throw Error('数据位置已变化'); return result; }
    if (request.op === 'compareReady') { const result = await store.compareReady(request.key, request.expected, request.artifact); if (!current()) throw Error('数据位置已变化'); return result; }
    await store.write(request.key, request.artifact);
    if (!current()) throw Error('数据位置已变化，附件未绑定当前页面');
    return null;
  });
  initDataCenter({ vaultRoot: getVaultRoot(), userStateDir: getUserStateDir() });
  retryDeletedNoteIndexCleanup();
  registerDataCenterHandlers(ipcMain, () => mainWindow);
  try{registerCommunityHost();}catch{console.warn('community_unavailable: inspect the dedicated community URL configuration');}
  registerWindowControls();
  registerUpdaterEvents();
  recoverProcessingDocs();
  createWindow();
  // 启动时只补齐缺失或源已变的教材索引；相同 sourceHash 不分块、不向量化，
  // 同源失败/中断项也不在每次启动时自动重试。
  deferredNoteIndex.request(); // Reconstruct unfinished maintenance from acknowledged saved originals.
});

const exitRequests = createExitRequestBroker();
ipcMain.on('application:exit-ready', (event, reply: unknown) => exitRequests.acknowledge(event.sender.id, reply));
const exitWindowStates = new Map<BrowserWindow, boolean>();
const applicationShutdown = createApplicationShutdown({
  freeze: (value) => {
    if (value) for (const win of BrowserWindow.getAllWindows()) {
      if (!exitWindowStates.has(win)) exitWindowStates.set(win, win.isEnabled());
      win.setEnabled(false);
    }
    else {
      for (const [win, enabled] of exitWindowStates) if (!win.isDestroyed()) win.setEnabled(enabled);
      exitWindowStates.clear();
    }
  },
  assertNoAcceptedWrites: () => {
    if (h5pHost?.busy()) throw new Error('H5P 导入、打开或进度保存正在进行，请稍后退出');
    if (scenePackHost?.busy()) throw new Error('S2 交互包正在导入，请等待完成后退出');
    if (documentRecoveryWriting) throw new Error('资料清单正在保存，请稍后退出');
    if (referenceEnvironmentSuspended) throw new Error('资料存储环境正在变更，请等待完成后再退出');
    if (argumentPersistence.busy() || hasResourceWorkbenchAcceptedWrite()) throw new Error('正在保存论证或写回资源，请等待结果返回后再退出');
  },
  prepareRenderer: async () => {
    if (!mainWindow || mainWindow.isDestroyed()) return { backgroundTasks: 0 };
    return exitRequests.request(mainWindow.webContents, 'prepare');
  },
  assertWindowsReady: async () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed() || mermaidProcess?.owns(win)) continue;
      // Use the actual beforeunload guards without unloading ANY window. Dirty
      // auxiliary editors therefore cannot lose their main-window save receiver.
      const ready = await win.webContents.executeJavaScript(`(() => { const event = new Event('beforeunload', { cancelable: true }); return window.dispatchEvent(event) && !event.defaultPrevented; })()`);
      if (ready !== true) throw new Error('仍有未保存的内容或未结束的学习会话，请返回对应窗口处理后再退出');
    }
  },
  confirmBackgroundStop: async (count) => {
    const result = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
      type: 'question', title: '退出 LogiNote',
      message: `仍有 ${count} 项助手或资料后台任务，是否停止并退出？`,
      detail: '已保存的章节、批次和任务进度保留；下次打开后需要明确继续。关闭助手或切换页面不会触发这项停止操作。',
      buttons: ['继续运行', '停止并退出', '强制退出…'], defaultId: 0, cancelId: 0, noLink: true,
    });
    return result.response === 2 ? 'force' : result.response === 1;
  },
  commitRenderer: async () => {
    if (mainWindow && !mainWindow.isDestroyed()) await exitRequests.request(mainWindow.webContents, 'commit');
  },
  flushNativeWrites: async () => {
    // Observe a stable empty queue; do not swallow a failed accepted save.
    for (let attempt = 0; attempt < 5; attempt++) {
      const writes = [...userStateWriteQueues.values()];
      if (!writes.length) return;
      await Promise.all(writes);
    }
    if (userStateWriteQueues.size) throw new Error('数据仍在保存，请稍后退出');
  },
  stopOwnedServices: async () => {
    mermaidProcess?.dispose();
    disposeInteractiveFigure?.();
    await learningPreparation?.stop();
    for (const controller of planSearchRequests.values()) controller.abort();
    for (const controller of stormSearchRequests.values()) controller.abort();
    applicationExiting = true;
    deferredNoteIndex.stop(); deferredChangedNoteIndex.stop();
    noteCleanupWorker?.worker.stop(); // Pending batches remain durable; never wait on an embedding here.
    backgroundGeneration++; vectorizationQueue.length = 0; indexProgress.clear();
    const progressiveStop = progressiveDerived?.stop();
    const ownedStt = sttProcess;
    const services = [
      ['H5P 场景进度', () => h5pHost?.shutdown()],
      ['资料解析进程', () => documentCompute?.shutdown()],
      ['本地检索与向量进程', () => embeddingCompute?.shutdown()],
      ['数学计算服务', () => disposeSympyServer()],
      ['语音识别服务', () => stopOwnedProcess(ownedStt).then(() => { if (sttProcess === ownedStt) sttProcess = null; })],
      ['资料索引收尾', () => vectorizationDrain],
      ['渐进课程后台收尾', () => progressiveStop],
    ] as const;
    const results = await Promise.allSettled(services.map(async ([name, stop]) => {
      try { await waitForShutdownStep(Promise.resolve().then(stop), name, 8000); } catch (error) { throw new Error(`${name}：${error instanceof Error ? error.message : String(error)}`); }
    }));
    const failures = results.flatMap(result => result.status === 'rejected' ? [String(result.reason instanceof Error ? result.reason.message : result.reason)] : []);
    if (failures.length) throw new Error(failures.join('\n'));
    await disposeResourceBrowserSessions();
    // Temporary flow partition only: preserve explicitly authorized login containers.
    const flowPartition = session.fromPartition('persist:flow-resource');
    // Chromium still owns native callbacks until these promises settle. Starting
    // cleanup and immediately destroying the Session crashes Windows on restart.
    // Disposable cache failures do not veto an otherwise safely prepared exit.
    await flowPartition.clearCache().catch(error => console.warn('[application-exit] temporary cache cleanup:', error));
    await flowPartition.clearStorageData().catch(error => console.warn('[application-exit] temporary storage cleanup:', error));
  },
  quit: () => app.quit(),
  confirmForceQuit: async () => {
    const result = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
      type: 'warning', title: '确认强制退出 LogiNote',
      message: '立即取消后台处理，并强制关闭本应用及其子进程？',
      detail: '不会等待生成、索引或保存完成。已保存的笔记与任务检查点保留；尚未保存的编辑、当前生成内容和正在写入的数据可能丢失或不完整。\n\n下次启动会恢复可用的已保存记录：支持检查点的任务需手动继续，未保存部分可能需要重跑；不能保证从中断瞬间无损恢复。',
      buttons: ['取消', '强制退出'], defaultId: 0, cancelId: 0, noLink: true,
    });
    return result.response === 1;
  },
  forceQuit: async () => {
    for (const controller of planSearchRequests.values()) controller.abort();
    h5pHost?.forceClose();
    for (const controller of stormSearchRequests.values()) controller.abort();
    applicationExiting = true;
    deferredNoteIndex.stop(); deferredChangedNoteIndex.stop(); noteCleanupWorker?.worker.stop();
    backgroundGeneration++; vectorizationQueue.length = 0; indexProgress.clear();
    // Signal abort/checkpoint handlers, but NEVER wait for model completion or
    // flush success on this explicitly destructive path.
    if (mainWindow && !mainWindow.isDestroyed()) {
      try { mainWindow.webContents.send('application:exit-request', { requestId: `force-exit-${Date.now()}`, phase: 'force' }); } catch { /* Renderer may have crashed. */ }
    }
    // Also attempt handle-bound cancellation before the tree fallback (e.g. if
    // taskkill is unavailable). Do not allow SymPy/compute exit listeners to restart.
    await forceExitOwnApplication(() => app.exit(0), {
      stopOwnedServices: async (timeoutMs) => {
        const stop = (child: Parameters<typeof stopOwnedProcess>[0]) => stopOwnedProcess(child, { timeoutMs });
        const results = await Promise.allSettled([documentCompute?.shutdown(stop), embeddingCompute?.shutdown(stop),
          disposeSympyServer({ timeoutMs }), stop(sttProcess)]);
        const failures = results.flatMap(result => result.status === 'rejected' ? [String(result.reason)] : []);
        if (failures.length) throw new Error(failures.join('\n'));
      },
    });
  },
  failed: async (error, stoppingStarted, stage) => {
    console.warn('[application-exit] shutdown incomplete:', error);
    if (!stoppingStarted) applicationExiting = false;
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('application:exit-request', { requestId: `exit-cancel-${Date.now()}`, phase: 'cancel' });
    const result = await dialog.showMessageBox(mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined, {
      type: 'info', title: '尚未退出 LogiNote',
      message: stoppingStarted ? '后台收尾或保存尚未完成，应用仍保持打开。请检查任务进度后重试退出。' : '还有保存或学习会话未完成，应用仍保持打开。请处理后再退出。',
      detail: `未完成阶段：${stage}\n${(error instanceof Error ? error.message : String(error)).slice(0,1000)}\n\n可返回处理后重试关闭；若不想继续等待，可选择强制退出并确认数据风险。`,
      buttons: ['返回应用', '强制退出…'], defaultId: 0, cancelId: 0, noLink: true,
    });
    return result.response === 1;
  },
});
app.on('before-quit', (event) => {
  communityHost?.stop();
  if (applicationShutdown.getPhase() === 'ready') return;
  event.preventDefault(); void applicationShutdown.request();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void applicationShutdown.request();
  }
});
