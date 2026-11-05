import type { NoteItem, SceneInitialRequest, SceneSpec, ViewMode } from '../../types';
import type { PlanBuilderDraftValue } from '../../components/PlanBuilder';
import type { PublishedPlanEditorValue } from '../publishedPlanEditor';
import type { AgentPlanDraftSession, AgentResourceDraftSession } from './types';
import { sanitizeResourceDraftForAgent } from './resourceDraftService';

const STORAGE_KEY = 'loginote_agent_workflow_drafts_v1';
const MAX_FILE_CHARS = 2_000_000;
export const AGENT_WORKFLOW_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type AgentWorkflowResumeView = Extract<ViewMode, 'home' | 'editor' | 'timeline' | 'plan' | 'learn' | 'scene'>;

export interface AgentPlanEditorDraftState {
  newPlanDraft: { id: string; value: PlanBuilderDraftValue } | null;
  editorQueue: PublishedPlanEditorValue[];
  editingPlanRootId: string | null;
  baseProjectRevisions: Record<string, string>;
}

export interface AgentScenePreviewDraftState {
  request: SceneInitialRequest;
  draft: SceneSpec;
}

export interface AgentWorkflowDraftRecord {
  version: 1;
  savedAt: string;
  expiresAt: string;
  planDraftSession: AgentPlanDraftSession | null;
  resourceDraftSession: AgentResourceDraftSession | null;
  planEditor: AgentPlanEditorDraftState | null;
  scenePreview: AgentScenePreviewDraftState | null;
  context: {
    view: AgentWorkflowResumeView;
    activeNoteId: string | null;
    planWorkspaceFocusId: string | null;
  };
}

export interface AgentWorkflowDraftFile {
  version: 1;
  savedAt: string;
  active: AgentWorkflowDraftRecord | null;
}

export interface AgentWorkflowDraftLoadResult {
  status: 'restored' | 'empty' | 'expired' | 'invalid';
  record?: AgentWorkflowDraftRecord;
}

interface WorkflowDraftApi {
  loadAgentWorkflowDrafts?: () => Promise<unknown>;
  saveAgentWorkflowDrafts?: (file: unknown) => Promise<void>;
}

function api(): WorkflowDraftApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { electronAPI?: { userState?: WorkflowDraftApi } }).electronAPI?.userState;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isObject(value) && Object.values(value).every((item) => typeof item === 'string');
}

function isPlanDraftSession(value: unknown): value is AgentPlanDraftSession {
  if (!isObject(value)) return false;
  return typeof value.id === 'string'
    && typeof value.scopeProjectId === 'string'
    && typeof value.scopeProjectTitle === 'string'
    && typeof value.mode === 'string'
    && typeof value.purpose === 'string'
    && isStringRecord(value.baseProjectRevisions)
    && Array.isArray(value.projects)
    && Array.isArray(value.createKnowledgeNotes)
    && Array.isArray(value.structurePatches)
    && Array.isArray(value.milestonePatches)
    && Array.isArray(value.executionPatches)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isResourceDraftSession(value: unknown): value is AgentResourceDraftSession {
  if (!isObject(value)) return false;
  return typeof value.id === 'string'
    && typeof value.scopeProjectId === 'string'
    && typeof value.scopeProjectTitle === 'string'
    && isStringRecord(value.baseProjectRevisions)
    && Array.isArray(value.projects)
    && value.projects.every((item) => isObject(item) && typeof item.projectTitle === 'string' && Array.isArray(item.resources))
    && Array.isArray(value.discoveredResources)
    && Array.isArray(value.selectedResourceUrls)
    && Array.isArray(value.rejectedResourceUrls)
    && Array.isArray(value.browserSessionIds)
    && typeof value.createdAt === 'string'
    && typeof value.updatedAt === 'string';
}

function isPlanBuilderDraftValue(value: unknown): value is PlanBuilderDraftValue {
  return isObject(value)
    && Array.isArray(value.tree)
    && value.tree.length === 1
    && isObject(value.tree[0])
    && isObject(value.planMeta);
}

function isPublishedEditorValue(value: unknown): value is PublishedPlanEditorValue {
  return isObject(value)
    && typeof value.rootId === 'string'
    && Array.isArray(value.tree)
    && value.tree.length === 1
    && isObject(value.tree[0])
    && isObject(value.planMeta)
    && Array.isArray(value.projectCatalog)
    && (value.agentEditorDraftId === undefined || (typeof value.agentEditorDraftId === 'string' && value.agentEditorDraftId.length <= 200));
}

function normalizePlanEditor(value: unknown): AgentPlanEditorDraftState | null {
  if (!isObject(value) || !Array.isArray(value.editorQueue) || !isStringRecord(value.baseProjectRevisions)) return null;
  const editorQueue = value.editorQueue.filter(isPublishedEditorValue);
  if (editorQueue.length !== value.editorQueue.length) return null;
  const newPlanDraft = value.newPlanDraft === null
    ? null
    : isObject(value.newPlanDraft)
      && typeof value.newPlanDraft.id === 'string'
      && isPlanBuilderDraftValue(value.newPlanDraft.value)
      ? { id: value.newPlanDraft.id, value: value.newPlanDraft.value }
      : undefined;
  if (newPlanDraft === undefined) return null;
  const editingPlanRootId = value.editingPlanRootId === null
    ? null
    : typeof value.editingPlanRootId === 'string' ? value.editingPlanRootId : undefined;
  if (editingPlanRootId === undefined || (!newPlanDraft && editorQueue.length === 0)) return null;
  return { newPlanDraft, editorQueue, editingPlanRootId, baseProjectRevisions: value.baseProjectRevisions };
}

function isSceneRequest(value: unknown): value is SceneInitialRequest {
  if (!isObject(value)) return false;
  return ['existing', 'build', 'auto', 'custom'].includes(String(value.source || ''))
    && typeof value.subject === 'string'
    && Array.isArray(value.knowledgePoints)
    && value.knowledgePoints.every((item) => typeof item === 'string');
}

function isSceneSpec(value: unknown): value is SceneSpec {
  if (!isObject(value) || !isObject(value.meta) || !isObject(value.role) || !isObject(value.completion)) return false;
  return typeof value.sceneId === 'string'
    && typeof value.version === 'string'
    && typeof value.meta.name === 'string'
    && Array.isArray(value.meta.knowledgePoints)
    && Array.isArray(value.role.attributes)
    && Array.isArray(value.resources)
    && Array.isArray(value.rules)
    && Array.isArray(value.metrics)
    && Array.isArray(value.events);
}

function normalizeScenePreview(value: unknown): AgentScenePreviewDraftState | null {
  if (!isObject(value) || !isSceneRequest(value.request) || !isSceneSpec(value.draft)) return null;
  return { request: value.request, draft: value.draft };
}

const RESUME_VIEWS = new Set<AgentWorkflowResumeView>(['home', 'editor', 'timeline', 'plan', 'learn', 'scene']);

function normalizeRecord(value: unknown): AgentWorkflowDraftRecord | null {
  if (!isObject(value)
    || value.version !== 1
    || typeof value.savedAt !== 'string'
    || typeof value.expiresAt !== 'string'
    || !Number.isFinite(Date.parse(value.savedAt))
    || !Number.isFinite(Date.parse(value.expiresAt))
    || !isObject(value.context)
    || !RESUME_VIEWS.has(value.context.view as AgentWorkflowResumeView)) return null;
  const planDraftSession = value.planDraftSession === null ? null : isPlanDraftSession(value.planDraftSession) ? value.planDraftSession : undefined;
  const resourceDraftSession = value.resourceDraftSession === null ? null : isResourceDraftSession(value.resourceDraftSession) ? value.resourceDraftSession : undefined;
  const planEditor = value.planEditor === null ? null : normalizePlanEditor(value.planEditor);
  const scenePreview = value.scenePreview === null ? null : normalizeScenePreview(value.scenePreview);
  if (planDraftSession === undefined || resourceDraftSession === undefined || (value.planEditor !== null && !planEditor) || (value.scenePreview !== null && !scenePreview)) return null;
  const activeNoteId = value.context.activeNoteId === null ? null : typeof value.context.activeNoteId === 'string' ? value.context.activeNoteId : undefined;
  const planWorkspaceFocusId = value.context.planWorkspaceFocusId === null ? null : typeof value.context.planWorkspaceFocusId === 'string' ? value.context.planWorkspaceFocusId : undefined;
  if (activeNoteId === undefined || planWorkspaceFocusId === undefined) return null;
  const record: AgentWorkflowDraftRecord = {
    version: 1,
    savedAt: value.savedAt,
    expiresAt: value.expiresAt,
    planDraftSession,
    resourceDraftSession: resourceDraftSession ? sanitizeResourceDraftForAgent(resourceDraftSession) : null,
    planEditor,
    scenePreview,
    context: { view: value.context.view as AgentWorkflowResumeView, activeNoteId, planWorkspaceFocusId },
  };
  return JSON.stringify(record).length <= MAX_FILE_CHARS ? record : null;
}

export function buildPlanEditorBaseRevisions(notes: NoteItem[], rootIds: string[]): Record<string, string> {
  const roots = new Set(rootIds.filter(Boolean));
  const included = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const note of notes) {
      if (note.noteType !== 'project' || included.has(note.id)) continue;
      if (roots.has(note.id) || (note.parentId && included.has(note.parentId))) {
        included.add(note.id);
        changed = true;
      }
    }
  }
  return Object.fromEntries(notes
    .filter((note) => note.noteType === 'project' && included.has(note.id))
    .map((note) => [note.id, note.updatedAt]));
}

export function isPlanEditorDraftFresh(notes: NoteItem[], state: AgentPlanEditorDraftState): boolean {
  if (state.editorQueue.length === 0) return Boolean(state.newPlanDraft);
  const current = buildPlanEditorBaseRevisions(notes, state.editorQueue.map((item) => item.rootId));
  const previousIds = Object.keys(state.baseProjectRevisions);
  return Object.keys(current).length === previousIds.length
    && previousIds.every((id) => current[id] === state.baseProjectRevisions[id]);
}

export function buildAgentWorkflowDraftFile(input: {
  planDraftSession: AgentPlanDraftSession | null;
  resourceDraftSession: AgentResourceDraftSession | null;
  planEditor: AgentPlanEditorDraftState | null;
  scenePreview: AgentScenePreviewDraftState | null;
  context: AgentWorkflowDraftRecord['context'];
  now?: number;
}): AgentWorkflowDraftFile {
  const hasDraft = Boolean(input.planDraftSession || input.resourceDraftSession || input.planEditor || input.scenePreview);
  const now = input.now ?? Date.now();
  const savedAt = new Date(now).toISOString();
  if (!hasDraft) return { version: 1, savedAt, active: null };
  const planEditor = input.planEditor;
  const active: AgentWorkflowDraftRecord = {
    version: 1,
    savedAt,
    expiresAt: new Date(now + AGENT_WORKFLOW_DRAFT_TTL_MS).toISOString(),
    planDraftSession: input.planDraftSession,
    resourceDraftSession: input.resourceDraftSession ? sanitizeResourceDraftForAgent(input.resourceDraftSession) : null,
    planEditor,
    scenePreview: input.scenePreview,
    context: input.context,
  };
  if (JSON.stringify(active).length > MAX_FILE_CHARS) throw new Error('Agent 工作流草稿超过 2 MB 安全上限');
  return { version: 1, savedAt, active };
}

function readLocal(): { version?: unknown; savedAt?: unknown; active?: unknown } | null {
  if (typeof localStorage === 'undefined') return null;
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as { version?: unknown; savedAt?: unknown; active?: unknown } | null;
  } catch {
    return null;
  }
}

function fileTimestamp(file: { savedAt?: unknown; active?: unknown } | null): number {
  if (!file) return 0;
  const value = typeof file.savedAt === 'string'
    ? file.savedAt
    : isObject(file.active) && typeof file.active.savedAt === 'string' ? file.active.savedAt : '';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function readFile(): Promise<{ version?: unknown; savedAt?: unknown; active?: unknown } | null> {
  const local = readLocal();
  const electron = api();
  if (electron?.loadAgentWorkflowDrafts) {
    try {
      const raw = await electron.loadAgentWorkflowDrafts() as { version?: unknown; savedAt?: unknown; active?: unknown } | null;
      if (raw || local) return fileTimestamp(local) > fileTimestamp(raw) ? local : raw;
    } catch (error) {
      console.warn('[agent-workflow-draft] load failed:', error);
    }
  }
  return local;
}

let writeQueue: Promise<void> = Promise.resolve();

export function cacheAgentWorkflowDraftFile(file: AgentWorkflowDraftFile): void {
  const serialized = JSON.stringify(file);
  if (serialized.length > MAX_FILE_CHARS) throw new Error('Agent 工作流草稿超过 2 MB 安全上限');
  if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, serialized);
}

async function writeElectronFile(file: AgentWorkflowDraftFile): Promise<void> {
  const electron = api();
  if (electron?.saveAgentWorkflowDrafts) await electron.saveAgentWorkflowDrafts(file);
}

export async function saveAgentWorkflowDraftFile(file: AgentWorkflowDraftFile): Promise<void> {
  cacheAgentWorkflowDraftFile(file);
  const next = writeQueue.catch(() => {}).then(() => writeElectronFile(file));
  writeQueue = next;
  await next;
}

export async function clearAgentWorkflowDraftState(): Promise<void> {
  await saveAgentWorkflowDraftFile({ version: 1, savedAt: new Date().toISOString(), active: null });
}

export async function loadAgentWorkflowDraftState(now = Date.now()): Promise<AgentWorkflowDraftLoadResult> {
  const file = await readFile();
  if (!file || file.active === null || file.active === undefined) return { status: 'empty' };
  if (file.version !== 1 || typeof file.savedAt !== 'string' || !Number.isFinite(Date.parse(file.savedAt))) {
    await clearAgentWorkflowDraftState();
    return { status: 'invalid' };
  }
  const normalized = normalizeRecord(file.active);
  if (!normalized) {
    await clearAgentWorkflowDraftState();
    return { status: 'invalid' };
  }
  if (Date.parse(normalized.expiresAt) <= now) {
    await clearAgentWorkflowDraftState();
    return { status: 'expired' };
  }
  return { status: 'restored', record: normalized };
}
