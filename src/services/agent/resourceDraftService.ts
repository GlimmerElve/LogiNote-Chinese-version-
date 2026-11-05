import type { LocalFileType, NoteItem, ResourceItem, ResourceWorkbenchCommitEvent, UploadedDocument } from '../../types';
import { getLeafProjectNotesInScope, getProjectNotesInScope } from '../knowledgePointSelector';
import { resolveNoteByTitleOrAlias } from '../noteResolver';
import { extractWikiTargets } from '../planAdjustmentService';
import { projectPlanningContent } from '../textbook/noteContent';
import { automaticResourceAccessIssue, deriveResourcePreferenceSignals, getResourceStateSnapshot, normalizeResourceUrl, trustedResourceHosts, type ResourceStateFile } from '../resourceState';
import { automaticResourceContentIssue } from '../resourceContentAdmission';
import { automaticResourceIntentIssue, RESOURCE_CATEGORY_LABELS, resourceIdentity } from '../resourceCuration';
import type { TextbookManifest } from '../textbook/types';
import type {
  AgentLearningResourceInput,
  AgentProjectResourceDraftItem,
  AgentResourceDraftSession,
  AgentResourceDraftSummary,
} from './types';

export interface ResourceDraftMutationResult {
  notes: NoteItem[];
  changedProjectNotes: NoteItem[];
  summary: {
    scopeProjectTitle: string;
    projectCount: number;
    resourceCount: number;
    addedResourceCount: number;
    updatedResourceCount: number;
    removedResourceCount: number;
  };
}

export interface ConfirmedWorkbenchMutationResult {
  notes: NoteItem[];
  changedProjectNotes: NoteItem[];
  summary: {
    projectCount: number;
    onlineResourceCount: number;
    localResourceCount: number;
    addedResourceCount: number;
    updatedResourceCount: number;
  };
}

function requireScopeProject(notes: NoteItem[], scopeProjectTitle?: string, selectedProjectId?: string): NoteItem {
  const projects = notes.filter((note) => note.noteType === 'project');
  const scope = scopeProjectTitle?.trim()
    ? resolveNoteByTitleOrAlias(scopeProjectTitle, projects)
    : projects.find((note) => note.id === selectedProjectId);
  if (!scope) throw new Error(scopeProjectTitle ? `未找到项目笔记：${scopeProjectTitle}` : '请先选中一个项目板块');
  return scope;
}

function normalizedText(value: string): string {
  return value
    .replace(/^\s*[-*]\s*\[[ xX]\]\s*/, '')
    .replace(/\s*@due\s*\([^)]*\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

export function extractProjectTasks(content: string, textbook?: TextbookManifest): string[] {
  return projectPlanningContent(content, textbook).split(/\r?\n/).flatMap((line) => {
    const match = /^\s*[-*]\s*\[[ xX]\]\s+(.+?)\s*$/.exec(line);
    if (!match) return [];
    const task = match[1].replace(/\s*@due\s*\([^)]*\)\s*$/i, '').trim();
    return task ? [task] : [];
  });
}

function normalizedUrl(value: string, expectedKind?: ResourceItem['kind']): string {
  const raw = String(value || '').trim();
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`资源 URL 无效：${raw || '空值'}`); }
  const kind = expectedKind || (url.protocol === 'file:' ? 'local' : 'online');
  if (kind === 'online' && url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`在线资源仅支持 http/https：${raw}`);
  }
  if (kind === 'local' && url.protocol !== 'file:') throw new Error(`本地资源必须使用 file URL：${raw}`);
  url.hash = '';
  return url.href;
}

function tryNormalizedUrl(resource: ResourceItem): string | null {
  try { return normalizedUrl(resource.url, resource.kind); } catch { return null; }
}

function resolveScopedLeaf(notes: NoteItem[], session: AgentResourceDraftSession, title: string): NoteItem {
  const project = resolveNoteByTitleOrAlias(title, notes.filter((note) => note.noteType === 'project'));
  const leafIds = new Set(getLeafProjectNotesInScope(session.scopeProjectId, notes).map((note) => note.id));
  if (!project || !leafIds.has(project.id)) {
    throw new Error(`项目不属于锁定板块“${session.scopeProjectTitle}”的末级项目：${title}`);
  }
  return project;
}

export function summarizeResourceDraft(session: AgentResourceDraftSession): AgentResourceDraftSummary {
  return {
    sessionId: session.id,
    scopeProjectId: session.scopeProjectId,
    scopeProjectTitle: session.scopeProjectTitle,
    projectCount: session.projects.length,
    resourceCount: session.projects.reduce((sum, item) => sum + item.resources.length, 0),
    removalCount: session.projects.reduce((sum, item) => sum + (item.removeResourceUrls?.length || 0), 0),
    discoveredResourceCount: session.discoveredResources.length,
    selectedResourceCount: session.selectedResourceUrls.length,
    rejectedResourceCount: session.rejectedResourceUrls.length,
  };
}

/** 浏览器会话及持久分区只供本地 UI/主进程复用，不进入 LLM 工具结果。 */
export function stripResourceBrowserRuntime(resource: ResourceItem): ResourceItem {
  const {
    browserSessionId: _browserSessionId,
    browserPartition: _browserPartition,
    authContainerId: _authContainerId,
    ...safeResource
  } = resource;
  return safeResource.accessType === 'authenticated'
    ? { ...safeResource, description: undefined }
    : safeResource;
}

export function sanitizeResourceDraftForAgent(session: AgentResourceDraftSession): AgentResourceDraftSession {
  return {
    ...session,
    discoveredResources: session.discoveredResources.map(stripResourceBrowserRuntime),
    browserSessionIds: [],
  };
}

export function createResourceDraftSession(
  notes: NoteItem[],
  input: {
    scopeProjectTitle?: string;
    selectedProjectId?: string;
    origin?: 'agent' | 'note-editor';
    directProjectTarget?: { taskText: string; knowledgeTitles: string[] };
  },
  now = new Date().toISOString(),
  id = `resource-draft-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
): AgentResourceDraftSession {
  const scope = requireScopeProject(notes, input.scopeProjectTitle, input.selectedProjectId);
  const scopedProjects = getProjectNotesInScope(scope.id, notes);
  return {
    id,
    scopeProjectId: scope.id,
    scopeProjectTitle: scope.title,
    origin: input.origin || 'agent',
    directProjectTarget: input.directProjectTarget ? {
      projectId: scope.id,
      taskText: String(input.directProjectTarget.taskText || '').trim(),
      knowledgeTitles: [...new Set(input.directProjectTarget.knowledgeTitles
        .map((title) => String(title || '').trim())
        .filter(Boolean))],
    } : undefined,
    baseProjectRevisions: Object.fromEntries(scopedProjects.map((project) => [project.id, project.updatedAt])),
    projects: [],
    discoveredResources: [],
    selectedResourceUrls: [],
    rejectedResourceUrls: [],
    browserSessionIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

export function assertResourceDraftFresh(notes: NoteItem[], session: AgentResourceDraftSession): void {
  const scope = notes.find((note) => note.id === session.scopeProjectId && note.noteType === 'project');
  if (!scope) throw new Error(`资源草案范围项目已不存在：${session.scopeProjectTitle}`);
  const current = getProjectNotesInScope(scope.id, notes);
  const baseIds = Object.keys(session.baseProjectRevisions);
  const currentIds = new Set(current.map((project) => project.id));
  if (current.length !== baseIds.length || baseIds.some((id) => !currentIds.has(id))) {
    throw new Error('资源草案创建后项目结构已变化，请放弃草案并重新生成');
  }
  const changed = current.find((project) => session.baseProjectRevisions[project.id] !== project.updatedAt);
  if (changed) throw new Error(`资源草案创建后项目“${changed.title}”已被修改，请放弃草案并重新生成`);
}

export function validateResourceSearchTarget(
  notes: NoteItem[],
  session: AgentResourceDraftSession,
  input: { projectTitle: string; taskText: string; knowledgeTitles: string[] },
): { project: NoteItem; taskText: string; knowledgeTitles: string[]; pathText: string; rootProjectTitle: string } {
  assertResourceDraftFresh(notes, session);
  if (session.origin === 'note-editor' && session.directProjectTarget) {
    const locked = session.directProjectTarget;
    const project = notes.find((note) => note.id === locked.projectId && note.noteType === 'project');
    if (!project || project.id !== session.scopeProjectId) throw new Error('项目页资源推荐目标已失效，请重新发起');
    const requestedProject = resolveNoteByTitleOrAlias(
      String(input.projectTitle || '').trim(),
      notes.filter((note) => note.noteType === 'project'),
    );
    if (!requestedProject || requestedProject.id !== project.id) throw new Error('项目页资源推荐只能写回当前锁定项目');
    if (normalizedText(String(input.taskText || '')) !== normalizedText(locked.taskText)) {
      throw new Error('项目页资源推荐主题与锁定目标不一致');
    }
    const requestedKnowledge = [...new Set((Array.isArray(input.knowledgeTitles) ? input.knowledgeTitles : [])
      .map((title) => String(title || '').trim())
      .filter(Boolean))];
    const allowedKnowledge = new Set(locked.knowledgeTitles.map((title) => title.toLocaleLowerCase()));
    if (requestedKnowledge.length === 0
      || requestedKnowledge.some((title) => !allowedKnowledge.has(title.toLocaleLowerCase()))) {
      throw new Error('项目页资源推荐的知识主题与锁定目标不一致');
    }
    const byId = new Map(notes.filter((note) => note.noteType === 'project').map((note) => [note.id, note]));
    const path: string[] = [];
    let current: NoteItem | undefined = project;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      path.unshift(current.title);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return {
      project,
      taskText: locked.taskText,
      knowledgeTitles: requestedKnowledge,
      pathText: path.join(' > '),
      rootProjectTitle: path[0] || project.title,
    };
  }
  const project = resolveScopedLeaf(notes, session, String(input.projectTitle || '').trim());
  const tasks = extractProjectTasks(project.content, project.textbook);
  const task = tasks.find((item) => normalizedText(item) === normalizedText(String(input.taskText || '')));
  if (!task) throw new Error(`项目“${project.title}”中不存在该学习任务：${input.taskText}`);
  const taskTargets = extractWikiTargets(task, notes);
  const knowledgeNotes = notes.filter((note) => note.noteType === 'knowledge');
  const requested = Array.isArray(input.knowledgeTitles) ? input.knowledgeTitles : [];
  if (requested.length === 0) throw new Error('资源至少要绑定一个任务中的知识点');
  const knowledgeTitles = requested.map((rawTitle) => {
    const title = String(rawTitle || '').trim();
    const target = taskTargets.find((item) => item.toLocaleLowerCase() === title.toLocaleLowerCase());
    const knowledge = target ? resolveNoteByTitleOrAlias(target, knowledgeNotes) : undefined;
    if (!knowledge) throw new Error(`知识点不在该任务的 wiki 链接中或笔记不存在：${title}`);
    return knowledge.title;
  });
  const byId = new Map(notes.filter((note) => note.noteType === 'project').map((note) => [note.id, note]));
  const path: string[] = [];
  let current: NoteItem | undefined = project;
  const visited = new Set<string>();
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    path.unshift(current.title);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return {
    project,
    taskText: task,
    knowledgeTitles: [...new Set(knowledgeTitles)],
    pathText: path.join(' > '),
    rootProjectTitle: path[0] || project.title,
  };
}

export function registerDiscoveredResources(
  notes: NoteItem[],
  session: AgentResourceDraftSession,
  resources: ResourceItem[],
  context?: { taskText: string; knowledgeTitles: string[] },
  now = new Date().toISOString(),
): AgentResourceDraftSession {
  assertResourceDraftFresh(notes, session);
  const byUrl = new Map(session.discoveredResources.map((resource) => [normalizedUrl(resource.url, 'online'), resource]));
  resources.forEach((resource) => {
    try {
      const url = normalizedUrl(resource.url, 'online');
      const title = String(resource.title || '').trim();
      if (title) byUrl.set(url, {
        title,
        url,
        platform: resource.platform,
        kind: 'online',
        projectTitle: resource.projectTitle,
        taskText: context?.taskText,
        knowledgeTitles: context?.knowledgeTitles,
        isFree: resource.isFree,
        verifiedAt: resource.verifiedAt,
        candidateId: resource.candidateId,
        sourcePageUrl: resource.sourcePageUrl,
        contentType: resource.contentType,
        contentLength: resource.contentLength,
        suggestedFileName: resource.suggestedFileName,
        fileExtension: resource.fileExtension,
        resourceType: resource.resourceType,
        detectedFrom: resource.detectedFrom,
        description: resource.description,
        isAttachment: resource.isAttachment,
        downloadable: resource.downloadable,
        indexable: resource.indexable,
        accessType: resource.accessType,
        accessHttpStatus: resource.accessHttpStatus,
        browserSessionId: resource.browserSessionId,
        browserPartition: resource.browserPartition,
        authContainerId: resource.authContainerId,
        fileType: resource.fileType,
      });
    } catch { /* 忽略搜索服务返回的非 http(s) 或损坏链接 */ }
  });
  return { ...session, discoveredResources: [...byUrl.values()], updatedAt: now };
}

function localFileType(document: UploadedDocument): LocalFileType {
  if (document.fileType === 'pdf') return 'pdf';
  if (document.fileType === 'image') return 'image';
  if (document.fileType === 'audio') return 'audio';
  if (document.fileType === 'video') return 'video';
  if (document.fileType === 'txt' || document.fileType === 'md') return 'text';
  if (['doc', 'docx', 'ppt', 'pptx', 'xls', 'xlsx'].includes(document.fileType)) return 'office';
  return 'other';
}

/**
 * 工作台的「确认并写回」是用户最终授权，不再经过 Agent 的「免费公开资源」自动推荐门禁。
 * 但仍严格校验锁定项目、真实任务及其 wiki 知识点，防止资源误归档到其他项目。
 */
export function applyConfirmedWorkbenchResources(
  notes: NoteItem[],
  session: AgentResourceDraftSession,
  payload: ResourceWorkbenchCommitEvent,
  now = new Date().toISOString(),
): ConfirmedWorkbenchMutationResult {
  assertResourceDraftFresh(notes, session);
  if (payload.draftSessionId !== session.id) throw new Error('资源工作台与当前草案不匹配');
  if (!Array.isArray(payload.selectedResources)) throw new Error('已选资源数据无效');

  const downloaded = new Map(payload.downloadedResources.map((item) => [item.candidateId, item.document]));
  const grouped = new Map<string, { project: NoteItem; resources: ResourceItem[] }>();
  let onlineResourceCount = 0;
  let localResourceCount = 0;

  payload.selectedResources.forEach((resource) => {
    const projectTitle = String(resource.projectTitle || '').trim();
    if (!projectTitle) throw new Error(`资源“${resource.title || resource.url}”缺少绑定项目，请重新搜索`);
    const target = validateResourceSearchTarget(notes, session, {
      projectTitle,
      taskText: String(resource.taskText || ''),
      knowledgeTitles: resource.knowledgeTitles || [],
    });
    const title = String(resource.title || '').trim();
    if (!title || title.length > 200 || /\r|\n/u.test(title)) throw new Error(`资源标题无效：${title || '空值'}`);

    const document = resource.candidateId ? downloaded.get(resource.candidateId) : undefined;
    let confirmed: ResourceItem;
    if (document) {
      confirmed = {
        title: document.fileName || title,
        url: `loginote-document://${document.id}`,
        platform: '本地资料库',
        kind: 'local',
        fileType: localFileType(document),
        documentId: document.id,
        sourceUrl: document.sourceUrl || normalizedUrl(resource.url, 'online'),
        taskText: target.taskText,
        knowledgeTitles: target.knowledgeTitles,
        reason: '用户在资源统筹工作台中确认下载并收录。',
        searchCategory: resource.searchCategory,
        collectionOrigin: 'user',
        verifiedAt: document.uploadAt,
        resourceType: resource.resourceType,
        contentType: resource.contentType,
        indexable: document.indexable,
      };
      localResourceCount += 1;
    } else {
      confirmed = {
        title,
        url: normalizedUrl(resource.url, 'online'),
        platform: resource.platform,
        kind: 'online',
        fileType: resource.fileType,
        taskText: target.taskText,
        knowledgeTitles: target.knowledgeTitles,
        reason: '用户在资源统筹工作台中明确确认收录。',
        collectionOrigin: 'user',
        searchCategory: resource.searchCategory,
        level: resource.level,
        language: resource.language,
        isFree: resource.isFree,
        verifiedAt: resource.verifiedAt || now,
        contentType: resource.contentType,
        resourceType: resource.resourceType,
        accessType: resource.accessType,
        accessHttpStatus: resource.accessHttpStatus,
      };
      onlineResourceCount += 1;
    }
    const entry = grouped.get(target.project.id) || { project: target.project, resources: [] };
    entry.resources.push(confirmed);
    grouped.set(target.project.id, entry);
  });

  let working = notes;
  let addedResourceCount = 0;
  let updatedResourceCount = 0;
  const changedProjectNotes: NoteItem[] = [];
  grouped.forEach(({ project: sourceProject, resources }) => {
    const current = working.find((note) => note.id === sourceProject.id) || sourceProject;
    const merged = new Map<string, ResourceItem>();
    (current.resources || []).forEach((resource, index) => {
      merged.set(tryNormalizedUrl(resource) || resource.url || `legacy-${index}`, resource);
    });
    resources.forEach((resource) => {
      const key = tryNormalizedUrl(resource) || resource.url;
      if (merged.has(key)) updatedResourceCount += 1;
      else addedResourceCount += 1;
      merged.set(key, resource);
    });
    const changed = { ...current, resources: [...merged.values()], updatedAt: now };
    working = working.map((note) => note.id === current.id ? changed : note);
    changedProjectNotes.push(changed);
  });

  return {
    notes: working,
    changedProjectNotes,
    summary: {
      projectCount: changedProjectNotes.length,
      onlineResourceCount,
      localResourceCount,
      addedResourceCount,
      updatedResourceCount,
    },
  };
}

/** 先收录链接，公开附件由调用方后续下载入库。认可站点的受限链接不授权自动登录、下载受限内容或读取。 */
export function applyTrustedAutoResources(
  notes: NoteItem[],
  session: AgentResourceDraftSession,
  resources: ResourceItem[],
  now = new Date().toISOString(),
  state: ResourceStateFile = getResourceStateSnapshot(),
): ConfirmedWorkbenchMutationResult {
  const hosts = trustedResourceHosts(state, notes);
  const blockedHosts = new Set(deriveResourcePreferenceSignals(Object.values(state.discoveryPreferences), Object.values(state.feedback)).blockedHosts.map(item => item.host));
  const rejectedUrls = new Set(Object.values(state.discoveryPreferences).filter(item => item.decision === 'rejected').map(item => resourceIdentity(item)));
  resources.forEach((resource) => {
    const target = validateResourceSearchTarget(notes, session, { projectTitle: resource.projectTitle || '',
      taskText: resource.taskText || '', knowledgeTitles: resource.knowledgeTitles || [] });
    if (automaticResourceAccessIssue(resource, hosts)
      || automaticResourceContentIssue(resource, { projectTitle: target.project.title, knowledgeTitles: target.knowledgeTitles })
      || automaticResourceIntentIssue(resource)
      || rejectedUrls.has(resourceIdentity(resource)) || blockedHosts.has(new URL(resource.url).hostname.toLocaleLowerCase())) {
      throw new Error(`资源“${resource.title || resource.url}”不符合自动收录准入条件`);
    }
  });
  const mutation = applyConfirmedWorkbenchResources(notes, session, {
    commitId: `trusted-auto-${Date.now()}`,
    sessionId: 'trusted-auto',
    draftSessionId: session.id,
    selectedResources: resources,
    rejectedResources: [],
    downloadedCandidateIds: [],
    downloadedResources: [],
    downloadErrors: [],
  }, now);
  const urls = new Set(resources.map((resource) => normalizedUrl(resource.url, 'online')));
  const notesWithReasons = mutation.notes.map((note) => {
    if (!mutation.changedProjectNotes.some((changed) => changed.id === note.id)) return note;
    return {
      ...note,
      resources: (note.resources || []).map((resource) => {
        const url = tryNormalizedUrl(resource);
        return url && urls.has(url)
          ? { ...resource, collectionOrigin: 'agent' as const, reason: `${resource.searchCategory ? `【${RESOURCE_CATEGORY_LABELS[resource.searchCategory]}】` : ''}${resources.find(item => normalizedUrl(item.url, 'online') === url)?.semanticReview?.reason || ''} ${resource.accessType === 'authenticated'
            ? '来自用户主动选择过的站点，仅推荐链接；打开后可能需要登录、验证或权限，系统未读取受限正文。'
            : resource.isFree === true
            ? 'Agent 根据历史资源偏好与公开免费安全门控自动收录。'
            : 'Agent 根据相关性与历史偏好推荐的公开可访问链接；免费性未确认，部分内容可能收费。'}` }
          : resource;
      }),
    };
  });
  return {
    ...mutation,
    notes: notesWithReasons,
    changedProjectNotes: mutation.changedProjectNotes.map((changed) => (
      notesWithReasons.find((note) => note.id === changed.id) || changed
    )),
  };
}

export function registerResourceBrowserSession(
  session: AgentResourceDraftSession,
  browserSessionId: string,
  now = new Date().toISOString(),
): AgentResourceDraftSession {
  const id = String(browserSessionId || '').trim();
  if (!id) return session;
  return {
    ...session,
    browserSessionIds: [...new Set([...session.browserSessionIds, id])],
    updatedAt: now,
  };
}

export function setResourceCandidateDecision(
  notes: NoteItem[],
  session: AgentResourceDraftSession,
  resource: ResourceItem,
  decision: 'selected' | 'rejected',
  now = new Date().toISOString(),
): AgentResourceDraftSession {
  assertResourceDraftFresh(notes, session);
  const url = normalizedUrl(resource.url, 'online');
  if (!session.discoveredResources.some((candidate) => normalizedUrl(candidate.url, 'online') === url)) {
    throw new Error('该资源尚未登记为本次搜索候选');
  }
  const selected = new Set(session.selectedResourceUrls.map((item) => normalizedUrl(item, 'online')));
  const rejected = new Set(session.rejectedResourceUrls.map((item) => normalizedUrl(item, 'online')));
  if (decision === 'selected') {
    selected.add(url);
    rejected.delete(url);
  } else {
    rejected.add(url);
    selected.delete(url);
  }
  return {
    ...session,
    selectedResourceUrls: [...selected],
    rejectedResourceUrls: [...rejected],
    updatedAt: now,
  };
}

function validateResource(
  notes: NoteItem[],
  session: AgentResourceDraftSession,
  project: NoteItem,
  raw: AgentLearningResourceInput,
  now: string,
): AgentLearningResourceInput {
  const title = String(raw?.title || '').trim();
  const reason = String(raw?.reason || '').trim();
  if (!title || title.length > 200 || /\r|\n/.test(title)) throw new Error(`资源标题无效：${title || '空值'}`);
  if (!reason || reason.length > 300 || /\r|\n/.test(reason)) throw new Error(`资源“${title}”需要 300 字以内的推荐理由`);
  const target = validateResourceSearchTarget(notes, session, {
    projectTitle: project.title,
    taskText: String(raw.taskText || ''),
    knowledgeTitles: raw.knowledgeTitles,
  });
  const kind = raw.kind || (String(raw.url || '').trim().toLocaleLowerCase().startsWith('file:') ? 'local' : 'online');
  if (kind !== 'online' && kind !== 'local') throw new Error(`资源类型无效：${String(kind)}`);
  const url = normalizedUrl(raw.url, kind);
  const existingUrls = new Set((project.resources || []).map(tryNormalizedUrl).filter((value): value is string => Boolean(value)));
  const existingResource = (project.resources || []).find((resource) => tryNormalizedUrl(resource) === url);
  const discovered = session.discoveredResources.find((resource) => normalizedUrl(resource.url, 'online') === url);
  if (kind === 'online') {
    if (session.rejectedResourceUrls.some((item) => normalizedUrl(item, 'online') === url)) {
      throw new Error(`用户已明确将该候选标记为不感兴趣：${url}`);
    }
    if (raw.isFree !== true) throw new Error(`在线资源必须明确为免费：${title}`);
    const searchedForTask = discovered?.taskText
      ? normalizedText(discovered.taskText) === normalizedText(target.taskText)
      : false;
    if (!existingUrls.has(url) && !searchedForTask) throw new Error(`在线资源不在该任务的本次真实搜索结果中：${url}`);
    if (!existingUrls.has(url) && discovered?.isFree !== true) {
      throw new Error(`该搜索候选仅确认可访问，尚未确认免费，不能自动写入资源草案：${url}`);
    }
  } else if (!existingUrls.has(url)) {
    throw new Error(`Agent 不能创建未由用户添加的本地文件资源：${url}`);
  }
  const levels = new Set(['beginner', 'intermediate', 'advanced']);
  if (raw.level && !levels.has(raw.level)) throw new Error(`资源难度无效：${raw.level}`);
  return {
    title,
    url,
    platform: raw.platform ? String(raw.platform).trim() : undefined,
    kind,
    collectionOrigin: existingResource?.collectionOrigin || 'agent',
    fileType: discovered?.fileType || existingResource?.fileType || raw.fileType,
    documentId: existingResource?.documentId,
    sourceUrl: existingResource?.sourceUrl,
    contentType: discovered?.contentType || existingResource?.contentType,
    contentLength: discovered?.contentLength || existingResource?.contentLength,
    suggestedFileName: discovered?.suggestedFileName || existingResource?.suggestedFileName,
    fileExtension: discovered?.fileExtension || existingResource?.fileExtension,
    resourceType: discovered?.resourceType || existingResource?.resourceType,
    detectedFrom: discovered?.detectedFrom || existingResource?.detectedFrom,
    description: discovered?.description || existingResource?.description,
    isAttachment: discovered?.isAttachment ?? existingResource?.isAttachment,
    downloadable: discovered?.downloadable ?? existingResource?.downloadable,
    indexable: discovered?.indexable ?? existingResource?.indexable,
    accessType: discovered?.accessType || existingResource?.accessType,
    accessHttpStatus: discovered?.accessHttpStatus ?? existingResource?.accessHttpStatus,
    taskText: target.taskText,
    knowledgeTitles: target.knowledgeTitles,
    reason,
    level: raw.level,
    language: raw.language ? String(raw.language).trim() : undefined,
    isFree: kind === 'online' ? true : raw.isFree,
    verifiedAt: kind === 'online' ? discovered?.verifiedAt || now : raw.verifiedAt || existingResource?.verifiedAt,
  };
}

function validateRemovalUrls(project: NoteItem, rawUrls: string[] | undefined): string[] {
  if (rawUrls === undefined) return [];
  if (!Array.isArray(rawUrls) || rawUrls.length > 15) {
    throw new Error(`项目“${project.title}”待移除资源必须是最多 15 个 URL`);
  }
  const existingUrls = new Set((project.resources || []).map(tryNormalizedUrl).filter((value): value is string => Boolean(value)));
  const normalized = rawUrls.map((raw) => normalizedUrl(String(raw || '')));
  if (new Set(normalized).size !== normalized.length) throw new Error(`项目“${project.title}”存在重复的待移除资源`);
  const missing = normalized.find((url) => !existingUrls.has(url));
  if (missing) throw new Error(`项目“${project.title}”中不存在待移除资源：${missing}`);
  return normalized;
}

export function stageResourceDraftBatch(
  notes: NoteItem[],
  session: AgentResourceDraftSession,
  projects: AgentProjectResourceDraftItem[],
  now = new Date().toISOString(),
): AgentResourceDraftSession {
  assertResourceDraftFresh(notes, session);
  if (!Array.isArray(projects) || projects.length < 1 || projects.length > 5) {
    throw new Error('一个资源草案批次必须包含 1 至 5 个末级项目');
  }
  const nextProjects = [...session.projects];
  const batchIds = new Set<string>();
  projects.forEach((item) => {
    const project = resolveScopedLeaf(notes, session, String(item?.projectTitle || '').trim());
    if (batchIds.has(project.id)) throw new Error(`资源批次中存在重复项目：${project.title}`);
    batchIds.add(project.id);
    if (!Array.isArray(item.resources) || item.resources.length > 15) {
      throw new Error(`项目“${project.title}”resources 必须是最多 15 个资源的数组`);
    }
    const resources = item.resources.map((resource) => validateResource(notes, session, project, resource, now));
    const removeResourceUrls = validateRemovalUrls(project, item.removeResourceUrls);
    if (resources.length === 0 && removeResourceUrls.length === 0) {
      throw new Error(`项目“${project.title}”至少要暂存一个资源或移除一个已有资源`);
    }
    const seenUrls = new Set<string>();
    const perTask = new Map<string, number>();
    resources.forEach((resource) => {
      const url = normalizedUrl(resource.url, resource.kind);
      if (seenUrls.has(url)) throw new Error(`项目“${project.title}”存在重复资源：${url}`);
      seenUrls.add(url);
      const key = normalizedText(resource.taskText);
      const count = (perTask.get(key) || 0) + 1;
      if (count > 3) throw new Error(`每条学习任务最多推荐 3 个资源：${resource.taskText}`);
      perTask.set(key, count);
    });
    const overlap = removeResourceUrls.find((url) => seenUrls.has(url));
    if (overlap) throw new Error(`同一资源不能在一个草案中同时更新和移除：${overlap}`);
    const canonical = { projectTitle: project.title, resources, removeResourceUrls };
    const index = nextProjects.findIndex((existing) => {
      const resolved = resolveNoteByTitleOrAlias(existing.projectTitle, notes.filter((note) => note.noteType === 'project'));
      return resolved?.id === project.id;
    });
    if (index >= 0) nextProjects[index] = canonical;
    else nextProjects.push(canonical);
  });
  return { ...session, projects: nextProjects, updatedAt: now };
}

export function buildResourceDraftMutation(
  notes: NoteItem[],
  session: AgentResourceDraftSession,
  now = new Date().toISOString(),
): ResourceDraftMutationResult {
  assertResourceDraftFresh(notes, session);
  if (session.projects.length === 0) throw new Error('资源草案中还没有任何资源');
  const changedProjectNotes: NoteItem[] = [];
  let working = notes;
  let resourceCount = 0;
  let addedResourceCount = 0;
  let updatedResourceCount = 0;
  let removedResourceCount = 0;
  session.projects.forEach((item) => {
    const sourceProject = resolveScopedLeaf(notes, session, item.projectTitle);
    const staged = item.resources.map((resource) => validateResource(notes, session, sourceProject, resource, now));
    const removals = new Set(validateRemovalUrls(sourceProject, item.removeResourceUrls));
    const project = working.find((note) => note.id === sourceProject.id) || sourceProject;
    const merged = new Map<string, ResourceItem>();
    (project.resources || []).forEach((resource, index) => {
      const url = tryNormalizedUrl(resource);
      if (url && removals.has(url)) {
        removedResourceCount += 1;
        return;
      }
      merged.set(url || `legacy-${index}-${resource.url}`, resource);
    });
    staged.forEach((resource) => {
      const url = normalizedUrl(resource.url, resource.kind);
      if (merged.has(url)) updatedResourceCount += 1;
      else addedResourceCount += 1;
      merged.set(url, { ...resource, verifiedAt: resource.kind === 'online' ? now : resource.verifiedAt });
    });
    const changed = { ...project, resources: [...merged.values()], updatedAt: now };
    working = working.map((note) => note.id === project.id ? changed : note);
    changedProjectNotes.push(changed);
    resourceCount += staged.length;
  });
  return {
    notes: working,
    changedProjectNotes,
    summary: {
      scopeProjectTitle: session.scopeProjectTitle,
      projectCount: changedProjectNotes.length,
      resourceCount,
      addedResourceCount,
      updatedResourceCount,
      removedResourceCount,
    },
  };
}
