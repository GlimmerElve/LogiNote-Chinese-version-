import { app, BrowserWindow, Menu, WebContentsView, dialog, session as electronSession, type Session, type WebContents } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { normalizeWindowTheme, windowThemeBackground, type WindowTheme } from '../services/ui/windowAppearance';
import type {
  ConceptSourceEvidence,
  ResourceAuthContainer,
  ResourceBrowserScanResult,
  ResourceBrowserSearchRequest,
  ResourceBrowserSearchResult,
  ResourceCandidateDecision,
  ResourceItem,
  ResourceSearchCategory,
  ResourceSearchTab,
  ResourceWorkbenchState,
} from '../types';
import { assertSafePublicUrl, checkPublicResourceUrl } from './resourceHealth';
import { automaticResourceAccessIssue } from '../services/resourceState';
import { atomicWriteTextFile } from './atomicWrite';
import { assertResourceDownloadFile } from './resourceDownloadValidation';
import { webAcquisition } from './webAcquisition';
import { stormPublicationDate } from '../services/stormResearch';
import { inferWebEvidenceKind } from '../services/webEvidenceKind';
import { attemptWebApi } from './webApiFallback';
import { automaticResourceContentIssue } from '../services/resourceContentAdmission';
import { automaticResourceIntentIssue, isDownloadableLearningResource } from '../services/resourceCuration';
import { validateResourceSemanticPlan } from '../services/resourceSemanticSearch';
import { discoverAcademicReferences } from './resourceAcademicSources';
import { resourceWorkbenchLayout } from '../services/ui/resourceWorkbenchLayout';
import { createResourceSessionCleanup } from './resourceSessionCleanup';
import {
  buildConceptSearchQueries,
  buildBingSearchUrl,
  buildResourceSearchQuery,
  buildResourceSearchTabs,
  classifyBrowserResource,
  cleanConceptEvidenceText,
  conceptEvidenceRelevanceScore,
  findResourceAuthContainerForUrl,
  inferResourceIsFree,
  extractResourceCoreTerm,
  isExpectedBingSearch,
  type BingSearchSnapshot,
  normalizeBrowserCandidates,
  safeAttachmentFileName,
  sanitizeSourcePageUrl,
} from './resourceBrowserCore';

const RESOURCE_TYPE_LABELS: Record<NonNullable<ResourceItem['resourceType']>, string> = {
  webpage: '网页', article: '文章', video: '视频', audio: '音频', pdf: 'PDF',
  presentation: '演示文稿', document: '文档', image: '图片', archive: '压缩包', other: '其他',
};

interface PendingDownload {
  url: string;
  targetPath: string;
  resolve: (filePath: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  cancel?: () => void;
}

interface BrowserSearchSession {
  id: string;
  partition: string;
  browserSession: Session;
  window: BrowserWindow | null;
  browserView: WebContentsView | null;
  feedbackTarget: BrowserWindow | null;
  candidates: Map<string, ResourceItem>;
  request: ResourceBrowserSearchRequest;
  persistent: boolean;
  authContainerId?: string;
  nextCandidateNumber: number;
  pendingDownload?: PendingDownload;
  pendingDecisions: Map<string, ResourceCandidateDecision>;
  pendingDownloadCandidateIds: Set<string>;
  /** 搜索页自动提取的候选；用户主动扫描或右键添加不进入此集合，因此不受自动额度限制。 */
  automaticCandidateIds: Set<string>;
  query: string;
  searchPageUrl: string;
  searchTabs?: ResourceSearchTab[];
  activeSearchTabId?: ResourceSearchCategory;
  busy?: boolean;
  commit?: { id: string; phase: 'confirming' | 'preparing' | 'applying'; onClosed: () => void };
  /** 已在当前隔离分区中加载过中文 Bing 页面，可复用其地区与会话上下文。 */
  bingContextReady?: boolean;
  /** Never expose or extract a mismatched first response, even when q is correct. */
  searchResultReady?: boolean;
  transportOnly?: boolean;
  /** Internal only: concept fallback must not re-enter the failing API. */
  browserOnly?: boolean;
  apiSearchAbort?: AbortController;
}

const sessions = new Map<string, BrowserSearchSession>();
const resourceSessionCleanup = createResourceSessionCleanup();

function assertResourceSessionEditable(state: BrowserSearchSession): void {
  if (sessions.get(state.id) !== state || !state.window || state.window.isDestroyed()) {
    throw new Error('资源工作台已经关闭');
  }
  if (state.commit) throw new Error('本批资源正在确认或写回，请完成当前操作后再调整');
}

function cancelResourceSessionCommit(state: BrowserSearchSession): void {
  state.apiSearchAbort?.abort();
  const commit = state.commit;
  state.commit = undefined;
  commit?.onClosed();
  if (state.pendingDownload) {
    const pending = state.pendingDownload;
    state.pendingDownload = undefined;
    clearTimeout(pending.timer);
    pending.reject(new Error('浏览器会话已关闭'));
    pending.cancel?.();
  }
}
const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
const AUTH_CONTAINER_FILE = 'resource-auth-containers.json';
let resourceBrowserUserStateDir = '';
let resourceWorkbenchTheme: WindowTheme = 'light';

export function setResourceWorkbenchTheme(value: WindowTheme): void {
  resourceWorkbenchTheme = normalizeWindowTheme(value) || 'light';
}

export function restoreResourceWorkbenchFocus(sessionId: string, commitId?: string): void {
  const state = sessions.get(sessionId), win = state?.window;
  if (!state || !win || win.isDestroyed() || win.webContents.isDestroyed() || !win.isFocused()) return;
  if (commitId ? state.commit?.id !== commitId : Boolean(state.commit)) return;
  // 只把已激活工作台的键盘交还前端控件，不拉起窗口或抢走其他应用焦点。
  win.webContents.focus();
}

export function setResourceBrowserUserStateDir(userStateDir: string): void {
  resourceBrowserUserStateDir = path.resolve(userStateDir);
}

function authContainerPath(): string {
  if (!resourceBrowserUserStateDir) throw new Error('资源浏览器个人数据目录尚未初始化');
  return path.join(resourceBrowserUserStateDir, AUTH_CONTAINER_FILE);
}

function normalizeAuthContainers(value: unknown): ResourceAuthContainer[] {
  if (!value || typeof value !== 'object') return [];
  const records = Array.isArray(value) ? value : (value as { containers?: unknown }).containers;
  if (!Array.isArray(records)) return [];
  return records.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const item = raw as Partial<ResourceAuthContainer>;
    try {
      const origin = new URL(String(item.origin || '')).origin;
      const id = String(item.id || '').trim();
      if (!id || !/^auth-[a-f0-9]{16}$/u.test(id)) return [];
      return [{
        id,
        name: String(item.name || new URL(origin).hostname).trim().slice(0, 80),
        origin,
        partition: `persist:resource-auth-${id}`,
        createdAt: String(item.createdAt || new Date().toISOString()),
        lastUsedAt: String(item.lastUsedAt || item.createdAt || new Date().toISOString()),
      }];
    } catch { return []; }
  });
}

export async function listResourceAuthContainers(): Promise<ResourceAuthContainer[]> {
  try {
    const text = await fs.readFile(authContainerPath(), 'utf-8');
    return normalizeAuthContainers(JSON.parse(text));
  } catch {
    return [];
  }
}

async function saveResourceAuthContainers(containers: ResourceAuthContainer[]): Promise<void> {
  const target = authContainerPath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await atomicWriteTextFile(target, JSON.stringify({ version: 1, containers }, null, 2));
}

function authContainerId(origin: string): string {
  return `auth-${createHash('sha256').update(origin).digest('hex').slice(0, 16)}`;
}

async function copyOriginCookies(source: Session, target: Session, url: URL): Promise<number> {
  if (source === target) return 0;
  const cookies = await source.cookies.get({ url: url.toString() });
  let copied = 0;
  for (const cookie of cookies) {
    const hostname = String(cookie.domain || url.hostname).replace(/^\./u, '');
    const protocol = cookie.secure ? 'https:' : url.protocol;
    try {
      await target.cookies.set({
        url: `${protocol}//${hostname}${cookie.path || '/'}`,
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain || undefined,
        path: cookie.path || '/',
        secure: cookie.secure,
        httpOnly: cookie.httpOnly,
        expirationDate: cookie.session ? undefined : cookie.expirationDate,
        sameSite: cookie.sameSite,
      });
      copied += 1;
    } catch {
      // 个别受站点策略保护的 Cookie 可能无法迁移；其余 Cookie 仍可继续保存。
    }
  }
  await target.cookies.flushStore();
  return copied;
}

export async function resolveResourceAuthSession(rawUrl: string): Promise<{
  authContainerId: string;
  origin: string;
  partition: string;
} | null> {
  const container = findResourceAuthContainerForUrl(await listResourceAuthContainers(), rawUrl);
  return container ? {
    authContainerId: container.id,
    origin: container.origin,
    partition: container.partition,
  } : null;
}

function createSessionId(): string {
  return `resource-browser-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function ensureRequest(value: unknown): ResourceBrowserSearchRequest {
  const raw = (value && typeof value === 'object' ? value : {}) as Partial<ResourceBrowserSearchRequest>;
  const projectTitle = String(raw.projectTitle || '').trim();
  const taskText = String(raw.taskText || '').trim();
  const knowledgeTitles = Array.isArray(raw.knowledgeTitles)
    ? raw.knowledgeTitles.map((item) => String(item || '').trim()).filter(Boolean).slice(0, 10)
    : [];
  if (!projectTitle || !taskText || knowledgeTitles.length === 0) {
    throw new Error('资源搜索必须绑定项目、学习任务和至少一个知识点');
  }
  const requestedTargets = raw.automaticTargets && typeof raw.automaticTargets === 'object'
    ? raw.automaticTargets
    : {};
  const automaticTargets = Object.fromEntries((['encyclopedia', 'video', 'materials', 'practice', 'paper'] as ResourceSearchCategory[])
    .flatMap((category) => {
      const target = Number(requestedTargets[category]);
      return Number.isFinite(target) && target > 0 ? [[category, Math.max(1, Math.min(6, Math.floor(target)))]] : [];
    })) as Partial<Record<ResourceSearchCategory, number>>;
  const trustedHosts = [...new Set((Array.isArray(raw.trustedResourceHosts) ? raw.trustedResourceHosts : [])
    .filter((host): host is string => typeof host === 'string')
    .map(host => host.toLocaleLowerCase().trim())
    .filter(host => host.length <= 253 && /^[a-z0-9.-]+$/u.test(host) && !host.startsWith('.') && !host.endsWith('.')))].slice(0, 500);
  return {
    projectTitle,
    rootProjectTitle: String(raw.rootProjectTitle || '').trim().slice(0, 160) || undefined,
    taskText,
    knowledgeTitles,
    maxResults: Math.max(1, Math.min(20, Number(raw.maxResults) || 12)),
    automaticTargets: Object.keys(automaticTargets).length ? automaticTargets : undefined,
    trustedResourceHosts: trustedHosts,
    draftSessionId: String(raw.draftSessionId || '').trim().slice(0, 160) || undefined,
    interactionMode: raw.interactionMode === 'auto' ? 'auto' : 'review',
    semanticPlan: raw.interactionMode === 'auto' && raw.semanticPlan ? validateResourceSemanticPlan(raw.semanticPlan) : undefined,
    source: raw.source === 'note-editor' || raw.source === 'concept-fill' ? raw.source : 'agent',
    queryOverride: String(raw.queryOverride || '').replace(/\s+/gu, ' ').trim().slice(0, 240) || undefined,
  };
}

function installSessionGuards(state: BrowserSearchSession): void {
  const ses = state.browserSession;
  ses.setPermissionCheckHandler(() => false);
  ses.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*.bing.com/*'] }, (details, callback) => {
    callback({
      requestHeaders: {
        ...details.requestHeaders,
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.5',
      },
    });
  });
  ses.webRequest.onBeforeRequest((details, callback) => {
    if (/^(?:data|blob):/iu.test(details.url)) {
      callback({ cancel: false });
      return;
    }
    void assertSafePublicUrl(details.url)
      .then(() => callback({ cancel: false }))
      .catch(() => callback({ cancel: true }));
  });
  ses.on('will-download', (event, item) => {
    const pending = state.pendingDownload;
    const urlChain = item.getURLChain();
    const requestedUrl = item.getURL();
    if (!pending || (requestedUrl !== pending.url && !urlChain.includes(pending.url))) {
      event.preventDefault();
      return;
    }
    item.setSavePath(pending.targetPath);
    pending.cancel = () => item.cancel();
    item.on('updated', () => {
      const total = item.getTotalBytes();
      if (total > MAX_DOWNLOAD_BYTES || item.getReceivedBytes() > MAX_DOWNLOAD_BYTES) item.cancel();
    });
    item.once('done', (_doneEvent, status) => {
      clearTimeout(pending.timer);
      if (state.pendingDownload === pending) state.pendingDownload = undefined;
      if (status === 'completed') pending.resolve(pending.targetPath);
      else pending.reject(new Error(status === 'cancelled' ? '下载已取消或文件超过 100 MB' : `下载失败：${status}`));
    });
  });
}

function resourceWorkbenchState(state: BrowserSearchSession, notice?: string, busy = Boolean(state.busy)): ResourceWorkbenchState {
  const guest = state.browserView?.webContents;
  const tabs = state.searchTabs?.map((tab) => ({
    ...tab,
    candidateCount: [...state.candidates.values()].filter((item) => item.searchCategory === tab.id).length,
  }));
  return {
    sessionId: state.id,
    draftSessionId: state.request.draftSessionId,
    projectTitle: state.request.projectTitle,
    taskText: state.request.taskText,
    knowledgeTitles: state.request.knowledgeTitles,
    query: state.query,
    searchTabs: tabs,
    activeSearchTabId: state.activeSearchTabId,
    currentUrl: guest && !guest.isDestroyed() ? (/^data:/u.test(guest.getURL()) ? `API 搜索：${state.query}` : guest.getURL()) : state.searchPageUrl,
    canGoBack: Boolean(guest && !guest.isDestroyed() && guest.navigationHistory.canGoBack()),
    canGoForward: Boolean(guest && !guest.isDestroyed() && guest.navigationHistory.canGoForward()),
    resources: [...state.candidates.values()],
    decisions: Object.fromEntries(state.pendingDecisions),
    downloadCandidateIds: [...state.pendingDownloadCandidateIds],
    notice,
    busy: Boolean(busy || state.commit),
  };
}

function pushResourceWorkbenchState(state: BrowserSearchSession, notice?: string, busy?: boolean): void {
  if (typeof busy === 'boolean') state.busy = busy;
  const win = state.window;
  if (win && !win.isDestroyed()) {
    win.webContents.send('resource-workbench:state', resourceWorkbenchState(state, notice));
  }
}

function layoutResourceWorkbench(state: BrowserSearchSession): void {
  const win = state.window;
  const view = state.browserView;
  if (!win || win.isDestroyed() || !view) return;
  const [width, height] = win.getContentSize();
  view.setBounds(resourceWorkbenchLayout(width, height, Boolean(state.searchTabs?.length)).page);
}

function createSearchWindow(state: BrowserSearchSession, parent?: BrowserWindow | null): BrowserWindow {
  const win = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1040,
    minHeight: 640,
    title: 'Loginote · 学习资源统筹工作台',
    backgroundColor: windowThemeBackground(resourceWorkbenchTheme),
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist-electron', 'preload.cjs'),
      additionalArguments: [`--loginote-theme=${resourceWorkbenchTheme}`],
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
    },
  });
  const view = new WebContentsView({
    webPreferences: {
      partition: state.partition,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  state.feedbackTarget = parent && !parent.isDestroyed() ? parent : state.feedbackTarget;
  state.window = win;
  state.browserView = view;
  // 首次查询会先在同一隔离分区初始化 Bing 中文会话；初始化页不应闪给用户。
  if (state.searchTabs?.length && state.request.interactionMode !== 'auto' && !state.bingContextReady) {
    view.setVisible(false);
  }
  win.contentView.addChildView(view);
  layoutResourceWorkbench(state);

  const guest = view.webContents;
  guest.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (['http:', 'https:'].includes(parsed.protocol)) {
        queueMicrotask(() => {
          if (!guest.isDestroyed()) void guest.loadURL(parsed.toString());
        });
      }
    } catch { /* ignore invalid popup URLs */ }
    return { action: 'deny' };
  });
  guest.on('will-navigate', (event, url) => {
    try {
      if (!['http:', 'https:'].includes(new URL(url).protocol)) event.preventDefault();
    } catch {
      event.preventDefault();
    }
  });
  guest.on('before-input-event', (event, input) => {
    const key = input.key.toLocaleLowerCase();
    if (input.alt && key === 'arrowleft' && guest.navigationHistory.canGoBack()) {
      event.preventDefault();
      guest.navigationHistory.goBack();
    } else if (input.alt && key === 'arrowright' && guest.navigationHistory.canGoForward()) {
      event.preventDefault();
      guest.navigationHistory.goForward();
    } else if ((input.control || input.meta) && key === 'r') {
      event.preventDefault();
      guest.reload();
    }
  });
  guest.on('context-menu', (_event, params) => {
    const targetUrl = String(params.linkURL || params.pageURL || '').trim();
    if (!/^https?:\/\//iu.test(targetUrl)) return;
    const targetLabel = params.linkURL ? '此链接' : '当前页面';
    const applyDecision = async (decision: 'selected' | 'rejected') => {
      try {
        assertResourceSessionEditable(state);
        const resource = await registerCandidateUrl(
          state,
          targetUrl,
          String(params.linkText || params.selectionText || '').trim(),
          String(params.pageURL || '').trim(),
        );
        assertResourceSessionEditable(state);
        state.pendingDecisions.set(resource.candidateId!, decision);
        if (decision === 'rejected') state.pendingDownloadCandidateIds.delete(resource.candidateId!);
        pushResourceWorkbenchState(state, decision === 'selected'
          ? `已将“${resource.title}”加入待确认清单。`
          : `已将“${resource.title}”标记为不感兴趣；确认前仍可撤销。`);
      } catch (error) {
        pushResourceWorkbenchState(state, error instanceof Error ? error.message : String(error));
      }
    };
    Menu.buildFromTemplate([
      { label: `加入资源备选（${targetLabel}）`, enabled: !state.commit, click: () => { void applyDecision('selected'); } },
      { label: `不感兴趣（${targetLabel}）`, enabled: !state.commit, click: () => { void applyDecision('rejected'); } },
      { type: 'separator', visible: Boolean(params.selectionText) },
      { role: 'copy', visible: Boolean(params.selectionText) },
    ]).popup({ window: win });
  });
  const pushNavigation = () => {
    const activeTab = state.searchTabs?.find((tab) => tab.id === state.activeSearchTabId);
    if (activeTab && !guest.isDestroyed()) activeTab.currentUrl = guest.getURL() || activeTab.searchPageUrl;
    pushResourceWorkbenchState(state);
  };
  guest.on('did-navigate', pushNavigation);
  guest.on('did-navigate-in-page', pushNavigation);
  guest.on('did-finish-load', pushNavigation);
  win.on('resize', () => layoutResourceWorkbench(state));
  win.webContents.on('did-finish-load', () => {
    layoutResourceWorkbench(state);
    pushResourceWorkbenchState(
      state,
      state.request.source === 'note-editor'
        ? '在左侧浏览网页，在右侧选择资源；只有点击“确认并写回”后才会更新当前项目。'
        : '在左侧浏览网页，在右侧选择资源；只有点击“确认并写回”后才会更新 Agent 草案。',
    );
    if (state.request.interactionMode !== 'auto' && !win.isVisible()) win.show();
  });
  win.on('close', (event) => {
    // 已交给主窗口的写回不能通过关闭工作台撤销；必须等真正的保存结果。
    if (state.commit?.phase === 'applying') {
      event.preventDefault();
      pushResourceWorkbenchState(state, '资源正在写回项目，请等待保存结果后再关闭。');
    }
  });
  win.on('closed', () => {
    cancelResourceSessionCommit(state);
    if (state.feedbackTarget && !state.feedbackTarget.isDestroyed()) {
      state.feedbackTarget.webContents.send('resource-browser:closed', {
        sessionId: state.id,
        draftSessionId: state.request.draftSessionId,
        interactionMode: state.request.interactionMode || 'review',
      });
    }
    if (state.browserView === view) state.browserView = null;
    state.window = null;
    if (!guest.isDestroyed()) guest.close();
    if (!state.persistent) void resourceSessionCleanup.schedule(state.browserSession);
    sessions.delete(state.id);
  });
  void win.loadFile(path.join(app.getAppPath(), 'dist', 'resource-workbench.html'));
  return win;
}

async function waitForPage(contents: WebContents, url: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('搜索页面加载超时')), 30_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      contents.removeListener('did-finish-load', onLoaded);
      contents.removeListener('did-fail-load', onFailed);
      error ? reject(error) : resolve();
    };
    const onLoaded = () => finish();
    const onFailed = (_event: unknown, code: number, description: string, validatedUrl: string, isMainFrame: boolean) => {
      if (isMainFrame) finish(new Error(`搜索页面加载失败（${code}）：${description || validatedUrl}`));
    };
    contents.once('did-finish-load', onLoaded);
    contents.on('did-fail-load', onFailed);
    void contents.loadURL(url).catch((error) => finish(error instanceof Error ? error : new Error(String(error))));
  });
}

const BING_ZH_CONTEXT_URL = 'https://cn.bing.com/?mkt=zh-CN&cc=CN&setlang=zh-Hans';

async function ensureBingSearchContext(state: BrowserSearchSession, contents: WebContents): Promise<void> {
  if (state.bingContextReady) return;
  try {
    await waitForPage(contents, BING_ZH_CONTEXT_URL);
  } catch (error) {
    // 初始化页偶发失败时仍允许正式搜索继续；正式请求会保留显式中文市场参数。
    console.warn('[resource-browser] Bing 中文会话初始化失败，将使用带市场参数的直接查询：', error);
  } finally {
    state.bingContextReady = true;
  }
}

/**
 * 尽量通过 Bing 页面自身的表单提交查询。这与用户在搜索框再次点击搜索的路径
 * 一致，可避免隔离分区首次直接 URL 请求只按首个宽泛词返回结果。
 */
async function trySubmitBingSearchForm(contents: WebContents, query: string): Promise<boolean> {
  let cancelNavigation = () => {};
  const navigation = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Bing 页面内搜索提交超时')), 30_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      contents.removeListener('did-finish-load', onLoaded);
      contents.removeListener('did-fail-load', onFailed);
      error ? reject(error) : resolve();
    };
    const onLoaded = () => finish();
    const onFailed = (_event: unknown, code: number, description: string, validatedUrl: string, isMainFrame: boolean) => {
      if (isMainFrame) finish(new Error(`Bing 页面内搜索失败（${code}）：${description || validatedUrl}`));
    };
    cancelNavigation = () => finish();
    contents.once('did-finish-load', onLoaded);
    contents.on('did-fail-load', onFailed);
  });
  void navigation.catch(() => {}); // Observe early timeouts while executeJavaScript is pending.
  try {
    const serializedQuery = JSON.stringify(String(query || '').trim());
    const submitted = Boolean(await contents.executeJavaScript(`(() => {
      const input = document.querySelector('form[action*="/search"] input[name="q"], input[name="q"]');
      const form = input?.form;
      if (!input || !form) return false;
      const action = new URL(form.action, location.href);
      if (!/(?:^|\\.)bing\\.com$/.test(action.hostname) || action.pathname !== '/search') return false;
      // The site's form otherwise drops the explicit Chinese market used by
      // the fallback URL, especially on the first anonymous request.
      for (const [name, value] of [['mkt','zh-CN'],['cc','CN'],['setlang','zh-Hans']]) {
        let field = form.querySelector('input[name="' + name + '"]');
        if (!field) { field = document.createElement('input'); field.type = 'hidden'; field.name = name; form.append(field); }
        field.value = value;
      }
      input.focus();
      input.value = ${serializedQuery};
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const submitter = form.querySelector('#sb_form_go, button[type="submit"], input[type="submit"]');
      if (typeof form.requestSubmit === 'function') form.requestSubmit(submitter || undefined);
      else if (submitter && typeof submitter.click === 'function') submitter.click();
      else form.submit();
      return true;
    })()`, true));
    if (!submitted) {
      cancelNavigation();
      return false;
    }
    await navigation;
    return true;
  } catch {
    cancelNavigation();
    await navigation.catch(() => {});
    return false;
  }
}

async function loadBingSearch(
  state: BrowserSearchSession,
  contents: WebContents,
  query: string,
  fallbackUrl = buildBingSearchUrl(query),
  coreTerm = '',
): Promise<void> {
  state.searchResultReady = false;
  if (coreTerm) state.browserView?.setVisible(false);
  await ensureBingSearchContext(state, contents);
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!await trySubmitBingSearchForm(contents, query)) await waitForPage(contents, fallbackUrl);
    const snapshot = await contents.executeJavaScript(`(() => {
      const nodes = [...document.querySelectorAll('#b_results li.b_algo')];
      const results = nodes.filter(node => node.querySelector('h2 a[href]'));
      return { url: location.href, input: document.querySelector('input[name="q"]')?.value || '',
        resultText: results.slice(0, 10).map(node => [node.querySelector('h2')?.textContent || '', node.querySelector('.b_caption p')?.textContent || ''].join(' ')).join(' ').slice(0, 10000),
        resultCount: results.length, emptyResults: !!document.querySelector('#b_results .b_no') };
    })()`, true) as BingSearchSnapshot;
    if (isExpectedBingSearch(snapshot, query, coreTerm)) {
      state.searchResultReady = true;
      if (state.request.interactionMode !== 'auto') state.browserView?.setVisible(true);
      return;
    }
    if (attempt === 0) pushResourceWorkbenchState(state, '首次结果与完整搜索词不一致，正在后台重新提交相同词条…', true);
  }
  throw new Error('搜索结果仍未匹配完整词条，已停止展示和自动提取；请重试当前搜索。');
}

async function extractCandidates(contents: WebContents): Promise<Array<{
  title: string;
  url: string;
  description?: string;
  detectedFrom?: 'link';
}>> {
  return contents.executeJavaScript(`(() => {
    if (document.querySelector('#b_results .b_no') && !document.querySelector('#b_results li.b_algo h2 a[href]')) return [];
    const selectors = ['li.b_algo h2 a[href]', '#b_results h2 a[href]', 'main h2 a[href]', 'main h3 a[href]'];
    const nodes = selectors.flatMap((selector) => Array.from(document.querySelectorAll(selector)));
    const source = nodes.length ? nodes : Array.from(document.querySelectorAll('main a[href], #b_content a[href]'));
    return source.slice(0, 80).map((node) => {
      const result = node.closest('li.b_algo, .b_algo, article, section');
      const snippet = result?.querySelector('.b_caption p, p, [data-snippet]');
      return {
        title: String(node.textContent || node.getAttribute('aria-label') || '').trim(),
        url: String(node.href || ''),
        description: String(snippet?.textContent || snippet?.getAttribute('data-snippet') || '').trim(),
        detectedFrom: 'link'
      };
    });
  })()`, true) as Promise<Array<{ title: string; url: string }>>;
}

type ResourceSearchPlan = {
  query: string;
  searchPageUrl: string;
  category?: ResourceSearchCategory;
  label?: string;
  variantId?: string;
};

/** Inert local result page: no provider key, script, remote image or injected HTML. */
async function showApiSearchResults(contents: WebContents, query: string, hits: Array<{ title: string; url: string; snippet: string }>): Promise<void> {
  const escape = (text: string) => text.replace(/[&<>"']/gu, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>API 搜索结果</title><style>body{font:16px/1.7 system-ui;max-width:900px;padding:28px;margin:auto;background:#fafbf8;color:#233b30}article{padding:18px 0;border-bottom:1px solid #ddd}a{color:#235b45}small{word-break:break-all}p{white-space:pre-wrap}</style></head><body><main><h1>${escape(query)}</h1><p>DeepSeek Search · API 搜索结果。点击链接浏览原网页；右键添加和主动扫描不限量。</p>${hits.length ? hits.map(hit => `<article><h2><a href="${escape(hit.url)}">${escape(hit.title)}</a></h2><small>${escape(hit.url)}</small><p>${escape(hit.snippet)}</p></article>`).join('') : '<p>本次 API 搜索无结果，可切换词条或手动浏览。</p>'}</main></body></html>`;
  await contents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
}

/** 执行一条明确的搜索词。人工模式只会在首次打开标签或点击备用词时调用。 */
async function executeResourceSearchPlan(
  state: BrowserSearchSession,
  contents: WebContents,
  plan: ResourceSearchPlan,
): Promise<ResourceItem[]> {
  state.query = plan.query;
  state.searchPageUrl = plan.searchPageUrl;
  state.activeSearchTabId = plan.category;
  pushResourceWorkbenchState(state, `正在搜索${plan.label ? `“${plan.label}”` : ''}：${plan.query}`, true);
  const coreTerm = !state.request.semanticPlan && !state.request.queryOverride && state.request.source !== 'concept-fill'
    ? extractResourceCoreTerm(state.request.projectTitle) || state.request.knowledgeTitles[0] || '' : '';
  assertResourceSessionEditable(state);
  const controller = new AbortController();
  state.apiSearchAbort?.abort(); state.apiSearchAbort = controller;
  // Manual screening opens the actual search page, including tab/variant changes.
  const browserOnly = state.browserOnly || state.request.interactionMode !== 'auto';
  let attempt;
  try {
    attempt = browserOnly ? { value: null, fallbackReason: 'unsupported' as const }
      : await attemptWebApi(signal => webAcquisition.search(plan.query, state.request.source === 'concept-fill' ? 'concept-generation' : 'agent-resource-curation', { count: 12, signal }),
        { signal: controller.signal });
    assertResourceSessionEditable(state);
  } finally { if (state.apiSearchAbort === controller) state.apiSearchAbort = undefined; }
  const apiHits = attempt.value;
  let raw: import('./resourceBrowserCore').RawBrowserCandidate[];
  if (apiHits !== null) {
    raw = apiHits.map(hit => ({ title: hit.title, url: hit.url, description: hit.snippet, detectedFrom: 'link' }));
    state.searchResultReady = true;
    if (state.request.interactionMode !== 'auto') {
      await showApiSearchResults(contents, plan.query, apiHits);
      state.browserView?.setVisible(true);
    }
    pushResourceWorkbenchState(state, `API 搜索已返回 ${raw.length} 个结果，正在按原有规则核验。`, true);
  } else {
    pushResourceWorkbenchState(state, browserOnly ? '使用内置浏览器检索。' : attempt.fallbackReason === 'transient' ? '联网 API 暂时不可用，已降级到内置浏览器检索。'
        : '当前供应商未配置可用的 Search API，使用内置浏览器检索。', true);
    await loadBingSearch(state, contents, plan.query, plan.searchPageUrl, coreTerm);
    raw = await extractCandidates(contents);
  }
  if (state.request.semanticPlan && plan.category === 'paper') {
    const referenceAbort = new AbortController(); state.apiSearchAbort = referenceAbort;
    try { raw = await discoverAcademicReferences(raw, referenceAbort.signal); assertResourceSessionEditable(state); }
    finally { if (state.apiSearchAbort === referenceAbort) state.apiSearchAbort = undefined; }
  }
  const normalized = normalizeBrowserCandidates(raw, plan.category ? 20 : state.request.maxResults);
  const prioritized = plan.category
    ? prioritizeCandidatesForCategory(normalized, plan.category, Math.min(8, state.request.maxResults || 12))
    : normalized;
  const healthResults = await Promise.all(prioritized.map(async (candidate) => ({
    candidate,
    health: await checkPublicResourceUrl(candidate.url),
  })));
  const resources: ResourceItem[] = [];
  const tab = plan.category ? state.searchTabs?.find((item) => item.id === plan.category) : undefined;
  const existingAutomaticCount = plan.category
    ? [...state.automaticCandidateIds].filter((candidateId) => {
        const candidate = state.candidates.get(candidateId);
        return candidate?.searchCategory === plan.category
          && candidate.projectTitle === state.request.projectTitle
          && candidate.taskText === state.request.taskText;
      }).length
    : 0;
  const automaticRegistrationLimit = state.request.interactionMode === 'review' && plan.category
    ? Math.max(0, (tab?.automaticTarget || 1) - existingAutomaticCount)
    : Number.POSITIVE_INFINITY;
  healthResults.forEach(({ candidate, health }) => {
    if (resources.length >= automaticRegistrationLimit) return;
    const publiclyAvailable = health.status === 'available' || health.status === 'redirected';
    if (!publiclyAvailable && health.status !== 'restricted') return;
    const finalUrl = health.finalUrl || candidate.url;
    const classified = classifyBrowserResource({
      ...candidate,
      url: finalUrl,
      contentType: health.contentType || candidate.contentType,
      downloadName: health.suggestedFileName || candidate.downloadName,
    });
    if (findCandidateByUrl(state, finalUrl)) return;
    const candidateId = `${state.id}:candidate-${state.nextCandidateNumber++}`;
    const item: ResourceItem = {
      title: candidate.title,
      url: finalUrl,
      platform: candidate.platform,
      kind: 'online',
      projectTitle: state.request.projectTitle,
      searchCategory: plan.category,
      searchQuery: plan.query,
      taskText: state.request.taskText,
      knowledgeTitles: state.request.knowledgeTitles,
      isFree: health.httpStatus === 402 ? false : publiclyAvailable ? inferResourceIsFree(finalUrl, classified.downloadable || classified.isAttachment) : undefined,
      verifiedAt: health.checkedAt,
      candidateId,
      sourcePageUrl: apiHits === null ? sanitizeSourcePageUrl(plan.searchPageUrl) : undefined,
      contentType: classified.contentType,
      contentLength: health.contentLength,
      suggestedFileName: health.suggestedFileName,
      fileExtension: classified.fileExtension,
      resourceType: classified.resourceType,
      detectedFrom: candidate.detectedFrom || 'link',
      description: candidate.description,
      isAttachment: classified.isAttachment,
      downloadable: publiclyAvailable && classified.downloadable,
      indexable: classified.indexable,
      fileType: classified.fileType,
      accessType: publiclyAvailable ? 'public' : 'authenticated',
      accessHttpStatus: health.httpStatus,
      browserSessionId: state.id,
      browserPartition: state.partition,
    };
    // Do not let a tool/irrelevant hit occupy a limited automatic slot in the
    // visible workbench. Right-click/manual registration uses a different path.
    if (!state.request.semanticPlan && state.request.source !== 'concept-fill' && automaticResourceContentIssue(item, state.request)) return;
    if (!state.request.semanticPlan && state.request.interactionMode === 'auto' && state.request.source !== 'concept-fill' && automaticResourceIntentIssue(item)) return;
    state.candidates.set(candidateId, item);
    state.automaticCandidateIds.add(candidateId);
    resources.push(item);
  });
  if (plan.category) {
    if (tab) {
      tab.loaded = true;
      tab.query = plan.query;
      tab.searchPageUrl = plan.searchPageUrl;
      tab.currentUrl = contents.getURL() || plan.searchPageUrl;
      if (plan.variantId) tab.activeVariantId = plan.variantId;
    }
  }
  return resources;
}

export async function searchResourcesInBrowser(
  value: unknown,
  parent?: BrowserWindow | null,
  browserOnly = false,
  signal?: AbortSignal,
): Promise<ResourceBrowserSearchResult> {
  signal?.throwIfAborted();
  const request = ensureRequest(value);
  let state = request.draftSessionId
    ? [...sessions.values()].find((item) => !item.persistent
      && item.request.draftSessionId === request.draftSessionId
      && item.request.interactionMode === request.interactionMode)
    : undefined;
  if (!state) {
    const sessionId = createSessionId();
    const partition = `resource-search-temp-${sessionId}`;
    const browserSession = electronSession.fromPartition(partition, { cache: false });
    state = {
      id: sessionId,
      partition,
      browserSession,
      window: null,
      browserView: null,
      feedbackTarget: parent && !parent.isDestroyed() ? parent : null,
      candidates: new Map(),
      request,
      persistent: false,
      nextCandidateNumber: 1,
      pendingDecisions: new Map(),
      pendingDownloadCandidateIds: new Set(),
      automaticCandidateIds: new Set(),
      query: '',
      searchPageUrl: '',
    };
    installSessionGuards(state);
    sessions.set(sessionId, state);
  } else {
    state.request = request;
  }

  state.browserOnly = browserOnly;
  const tabSearch = !request.queryOverride && request.source !== 'concept-fill';
  const generatedTabs = tabSearch ? buildResourceSearchTabs(request) : [];
  const query = request.queryOverride || buildResourceSearchQuery(request);
  const searchPageUrl = request.queryOverride
    ? buildBingSearchUrl(query)
    : generatedTabs[0]?.searchPageUrl || buildBingSearchUrl(query);
  state.searchTabs = generatedTabs.length ? generatedTabs : undefined;
  state.activeSearchTabId = generatedTabs[0]?.id;
  state.query = generatedTabs[0]?.query || query;
  state.searchPageUrl = searchPageUrl;
  const win = state.window && !state.window.isDestroyed() ? state.window : createSearchWindow(state, parent);
  const contents = state.browserView?.webContents;
  if (!contents || contents.isDestroyed()) throw new Error('资源工作台浏览器未能初始化');
  if (request.interactionMode !== 'auto' && win.isVisible()) {
    win.show();
    win.focus();
  }
  const cancelSearch = () => closeResourceBrowserSession(state!.id);
  signal?.addEventListener('abort', cancelSearch, { once: true });
  try {
    signal?.throwIfAborted();
    const allPlans: ResourceSearchPlan[] = generatedTabs.length
      ? generatedTabs.map((tab) => ({
          query: tab.query,
          searchPageUrl: tab.searchPageUrl,
          category: tab.id,
          label: tab.label,
          variantId: tab.activeVariantId,
        }))
      : [{ query, searchPageUrl }];
    // 可见工作台只加载第一个标签。其他标签和备用词条由用户显式点击后再搜索；
    // 自动模式窗口不可见，可在后台完成四类默认词条。
    const plans = request.interactionMode === 'auto' ? allPlans : allPlans.slice(0, 1);
    const resources: ResourceItem[] = [];
    for (const [planIndex, plan] of plans.entries()) {
      signal?.throwIfAborted();
      resources.push(...await executeResourceSearchPlan(state, contents, plan));
      signal?.throwIfAborted();
      if (request.interactionMode === 'auto' && plan.category) {
        const tab = state.searchTabs?.find((item) => item.id === plan.category);
        for (const variant of tab?.variants?.slice(1) || []) {
          const categoryCount = resources.filter((item) => item.searchCategory === plan.category
            && !automaticResourceAccessIssue(item, new Set(state.request.trustedResourceHosts))
            && (plan.category !== 'materials' || isDownloadableLearningResource(item))).length;
          const automaticTarget = state.request.automaticTargets?.[plan.category]
            || tab?.automaticTarget
            || 1;
          // A plan's queries can cover different concepts. Raw hit count cannot
          // prove semantic/category coverage, especially for video vs PDF notes.
          if (!state.request.semanticPlan && categoryCount >= automaticTarget) break;
          signal?.throwIfAborted();
          resources.push(...await executeResourceSearchPlan(state, contents, {
            query: variant.query,
            searchPageUrl: variant.searchPageUrl,
            category: plan.category,
            label: `${tab?.label || plan.category} / ${variant.label}`,
            variantId: variant.id,
          }));
        }
      }
      if (planIndex < plans.length - 1) pushResourceWorkbenchState(state, `已完成 ${planIndex + 1}/${plans.length} 类资源检索。`, true);
    }
    pushResourceWorkbenchState(state, resources.length
      ? (generatedTabs.length
          ? (request.interactionMode === 'auto'
              ? `分类检索已发现 ${resources.length} 个可核验候选，正在组合在线资源与下载资料。`
              : `当前标签已自动推荐 ${resources.length} 个候选（上限 ${generatedTabs[0]?.automaticTarget || 0}）；主动扫描、右键添加和人工选择不限量。`)
          : `已发现 ${resources.length} 个可核验候选。`)
      : (request.interactionMode === 'auto'
          ? '四类后台检索未找到通过公开访问校验的候选。'
          : '当前标签未自动提取到候选。你可以切换词条、继续浏览，并通过右键把页面或链接加入清单。'), false);
    const browserHint = '资源工作台已打开：四个标签按需加载，备用词条只在点击后搜索；右侧统一选择、记录偏好和标记下载，人工添加不限量。';
    const markdown = resources.length
      ? `${browserHint}\n${resources.map((resource, index) => `${index + 1}. [${resource.title}](${resource.url}) · ${RESOURCE_TYPE_LABELS[resource.resourceType || 'webpage']} · ${resource.platform || '网页'} · ${resource.accessType === 'authenticated' ? '可能需要登录' : resource.isFree ? '已确认开放访问' : '免费性待人工确认'}${resource.downloadable ? ' · 可下载入库' : resource.isAttachment ? ' · 附件（暂不支持索引）' : ''}`).join('\n')}`
      : `隔离浏览器已打开，但没有找到通过公开访问校验的候选资源。你可以在窗口内继续手动查找。${browserHint}`;
    return { sessionId: state.id, query: state.query, searchPageUrl: state.searchPageUrl, resources, markdown };
  } catch (error) {
    pushResourceWorkbenchState(state, error instanceof Error ? error.message : String(error), false);
    if (state.searchResultReady !== false) state.browserView?.setVisible(true);
    if (request.interactionMode === 'auto') closeResourceBrowserSession(state.id);
    else if (!win.isDestroyed()) win.show();
    throw error;
  } finally { signal?.removeEventListener('abort', cancelSearch); }
}

async function extractPageSnapshot(contents: WebContents): Promise<{
  title: string;
  url: string;
  description?: string;
  hintType?: string;
  links: Array<{
    title: string;
    url: string;
    contentType?: string;
    hintType?: string;
    downloadName?: string;
    description?: string;
    detectedFrom?: 'link' | 'media' | 'metadata';
  }>;
}> {
  return contents.executeJavaScript(`(() => {
    const meta = (selector) => String(document.querySelector(selector)?.getAttribute('content') || '').trim();
    const contentRoot = document.querySelector('article, main, [role="main"]');
    const visibleSummary = String(contentRoot?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 480);
    const pageDescription = meta('meta[name="description"]') || meta('meta[property="og:description"]') || visibleSummary;
    const pageType = meta('meta[property="og:type"]') || (document.querySelector('article') ? 'article' : 'webpage');
    const anchors = Array.from(document.querySelectorAll('a[href]')).slice(0, 220).map((node) => ({
      title: String(node.textContent || node.getAttribute('aria-label') || node.getAttribute('title') || node.getAttribute('download') || '').trim(),
      url: String(node.href || ''),
      contentType: String(node.getAttribute('type') || '').trim(),
      hintType: String(node.getAttribute('data-type') || node.getAttribute('rel') || '').trim(),
      downloadName: String(node.getAttribute('download') || '').trim(),
      detectedFrom: 'link'
    }));
    const media = [
      ...Array.from(document.querySelectorAll('video[src], video source[src]')).map((node) => ({
        title: String(node.getAttribute('title') || document.title || '页面视频').trim(),
        url: String(node.src || node.getAttribute('src') || ''),
        contentType: String(node.getAttribute('type') || '').trim(), hintType: 'video', detectedFrom: 'media'
      })),
      ...Array.from(document.querySelectorAll('audio[src], audio source[src]')).map((node) => ({
        title: String(node.getAttribute('title') || document.title || '页面音频').trim(),
        url: String(node.src || node.getAttribute('src') || ''),
        contentType: String(node.getAttribute('type') || '').trim(), hintType: 'audio', detectedFrom: 'media'
      })),
      ...Array.from(document.querySelectorAll('iframe[src], embed[src], object[data]')).map((node) => ({
        title: String(node.getAttribute('title') || document.title || '嵌入资源').trim(),
        url: String(node.src || node.data || node.getAttribute('src') || node.getAttribute('data') || ''),
        contentType: String(node.getAttribute('type') || '').trim(),
        hintType: node.tagName === 'IFRAME' ? 'embed' : 'document embed', detectedFrom: 'media'
      }))
    ];
    const metadata = [
      { title: document.title || '页面视频', url: meta('meta[property="og:video:secure_url"]') || meta('meta[property="og:video"]'), contentType: meta('meta[property="og:video:type"]'), hintType: 'video', detectedFrom: 'metadata' },
      { title: document.title || '页面音频', url: meta('meta[property="og:audio:secure_url"]') || meta('meta[property="og:audio"]'), contentType: meta('meta[property="og:audio:type"]'), hintType: 'audio', detectedFrom: 'metadata' }
    ].filter((item) => item.url);
    return {
      title: String(document.title || '').trim(),
      url: String(location.href || ''),
      description: pageDescription,
      hintType: pageType,
      links: [...metadata, ...media, ...anchors]
    };
  })()`, true) as Promise<{
    title: string;
    url: string;
    description?: string;
    hintType?: string;
    links: Array<{ title: string; url: string; contentType?: string; hintType?: string; downloadName?: string; description?: string; detectedFrom?: 'link' | 'media' | 'metadata' }>;
  }>;
}

function categoryCandidateScore(candidate: ReturnType<typeof normalizeBrowserCandidates>[number], category: ResourceSearchCategory): number {
  const haystack = `${candidate.title} ${candidate.description || ''} ${candidate.platform}`.toLocaleLowerCase();
  if (category === 'video') {
    return (candidate.resourceType === 'video' ? 80 : 0)
      + (/(?:bilibili|icourse163|xuetangx|ocw\.mit|youtube)/u.test(candidate.platform) ? 60 : 0)
      + (/(?:视频|讲解|公开课|mooc|course|lecture)/iu.test(haystack) ? 20 : 0);
  }
  if (category === 'materials') {
    return (candidate.resourceType === 'pdf' ? 90 : 0)
      + (candidate.resourceType === 'presentation' ? 85 : 0)
      + (candidate.resourceType === 'document' ? 65 : 0)
      + (/(?:教材|讲义|课件|pdf|ppt|textbook|slides)/iu.test(haystack) ? 25 : 0);
  }
  if (category === 'practice') {
    return (['article', 'webpage', 'document', 'pdf'].includes(candidate.resourceType) ? 35 : 0)
      + (/(?:实验|实践|案例|应用|论文|experiment|case|paper|application)/iu.test(haystack) ? 45 : 0);
  }
  if (category === 'paper') {
    return (/arxiv|doi\.org|pubmed|openreview|aclanthology/iu.test(candidate.url) ? 70 : 0)
      + (/论文|期刊|研究报告|\babstract\b|\bjournal\b|\bresearch paper\b/iu.test(haystack) ? 50 : 0);
  }
  return (['article', 'webpage', 'document'].includes(candidate.resourceType) ? 45 : 0)
    + (/(?:定义|概念|原理|百科|介绍|definition|overview|principle)/iu.test(haystack) ? 40 : 0);
}

function prioritizeCandidatesForCategory(
  candidates: ReturnType<typeof normalizeBrowserCandidates>,
  category: ResourceSearchCategory,
  limit: number,
) {
  return candidates
    .map((candidate, index) => ({ candidate, index, score: categoryCandidateScore(candidate, category) }))
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, limit)
    .map((item) => item.candidate);
}

function conceptAuthorityScore(resource: ResourceItem): number {
  let score = resource.resourceType === 'article' ? 3 : 0;
  try {
    const host = new URL(resource.url).hostname.toLocaleLowerCase();
    if (/\.(?:edu|gov)(?:\.[a-z]{2})?$/u.test(host) || /(?:^|\.)edu\.cn$/u.test(host)) score += 8;
    else if (/\.(?:org|ac)(?:\.[a-z]{2})?$/u.test(host)) score += 4;
    if (/(?:zhihu|csdn|toutiao|baijiahao|blogspot)/u.test(host)) score -= 5;
  } catch { score -= 10; }
  if (/(?:官方|标准|大学|学院|研究院|百科|documentation|university|institute|standard)/iu.test(`${resource.title} ${resource.platform || ''}`)) score += 3;
  if (resource.accessType === 'public') score += 2;
  return score;
}

async function extractConceptPageEvidence(
  contents: WebContents,
  resource: ResourceItem,
  term: string,
  aliases: string[],
  strictBody = false,
): Promise<Omit<ConceptSourceEvidence, 'sourceId'> | null> {
  await assertSafePublicUrl(resource.url);
  await waitForPage(contents, resource.url);
  const finalUrl = contents.getURL();
  await assertSafePublicUrl(finalUrl);
  const page = await contents.executeJavaScript(`(() => {
    const meta = (selector) => String(document.querySelector(selector)?.getAttribute('content') || '').trim();
    const root = document.querySelector('article, main, [role="main"]') || document.body;
    const clone = root?.cloneNode(true);
    if (clone?.querySelectorAll) {
      clone.querySelectorAll('script, style, noscript, nav, footer, header, form, button, input, textarea, select, svg, canvas, iframe').forEach((node) => node.remove());
    }
    const semanticNodes = clone?.querySelectorAll
      ? Array.from(clone.querySelectorAll('h1, h2, h3, h4, p, li, dt, dd, blockquote, figcaption, tr')).slice(0, 180)
      : [];
    let blocks = semanticNodes
      .map((node) => String(node.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1600))
      .filter((text) => text.length >= 18);
    if (!blocks.length) {
      blocks = String(clone?.textContent || '')
        .split(/(?:\\n+|(?<=[。！？.!?]))/g)
        .map((text) => text.replace(/\\s+/g, ' ').trim().slice(0, 1600))
        .filter((text) => text.length >= 18)
        .slice(0, 180);
    }
    return {
      title: String(document.title || '').trim(),
      publisher: meta('meta[name="author"]') || meta('meta[property="og:site_name"]'),
      publishedAt: meta('meta[property="article:published_time"]') || meta('meta[name="citation_publication_date"]') || meta('meta[name="date"]'),
      description: meta('meta[name="description"]') || meta('meta[property="og:description"]'),
      blocks,
    };
  })()`, true) as { title?: string; publisher?: string; description?: string; blocks?: string[]; publishedAt?: string };
  let snippet = strictBody ? (page.blocks || []).join('\n').slice(0, 2200) : cleanConceptEvidenceText(term, {
    description: page.description || resource.description,
    blocks: page.blocks,
  }, 2200, aliases);
  if (snippet.length < 80 || !strictBody && conceptEvidenceRelevanceScore(term, '', snippet, aliases) === 0) return null;
  if (strictBody && inferWebEvidenceKind(finalUrl, snippet) === 'abstract') snippet = `【论文摘要，非全文】\n${snippet.slice(0, 2150)}`;
  const title = String(page.title || resource.title || '').trim().slice(0, 240);
  return {
    type: 'web',
    title: page.publisher ? `${title} — ${String(page.publisher).slice(0, 100)}` : title,
    url: sanitizeSourcePageUrl(finalUrl) || resource.url,
    snippet,
    ...(strictBody && stormPublicationDate(page.publishedAt) ? { publishedAt: stormPublicationDate(page.publishedAt) } : {}),
  };
}

/**
 * 在临时隔离浏览器中检索概念证据并抽取公开页面正文。该流程只返回证据，
 * 不进入项目资源草案，也不会读取持久登录容器。
 */
export async function searchConceptEvidenceInBrowser(
  rawTerm: string,
  rawAliases: string[] = [],
  parent?: BrowserWindow | null,
  signal?: AbortSignal,
  research?: { queries: string[]; strictBody: true },
): Promise<ConceptSourceEvidence[]> {
  signal?.throwIfAborted();
  const term = String(rawTerm || '').replace(/\s+/gu, ' ').trim().slice(0, 120);
  if (!term) throw new Error('概念标题不能为空');
  const termKey = term.normalize('NFKC').toLocaleLowerCase();
  const aliases = [...new Set((Array.isArray(rawAliases) ? rawAliases : [])
    .map((alias) => String(alias || '').replace(/\s+/gu, ' ').trim().slice(0, 120))
    .filter((alias) => alias && alias.normalize('NFKC').toLocaleLowerCase() !== termKey))]
    .slice(0, 3);
  const draftSessionId = `concept-fill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const candidates = new Map<string, ResourceItem>();
  let searchedCandidateCount = 0;
  let sessionId = '';
  let lastSearchError: Error | null = null;
  const cancel = () => { if (sessionId) closeResourceBrowserSession(sessionId); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    for (const query of research ? research.queries.slice(0, 3) : buildConceptSearchQueries(term, aliases)) {
      signal?.throwIfAborted();
      try {
        const result = await searchResourcesInBrowser({
          projectTitle: term,
          taskText: `研究概念“${term}”的定义、性质与应用`,
          knowledgeTitles: [term, ...aliases],
          maxResults: 12,
          draftSessionId,
          interactionMode: 'auto',
          source: 'concept-fill',
          queryOverride: query,
        }, parent, true, signal);
        sessionId = result.sessionId;
        signal?.throwIfAborted();
        searchedCandidateCount += result.resources.length;
        result.resources.forEach((resource) => {
          // 403/429 常是站点拒绝探测器的 HEAD 请求，并不等于真实浏览器需要登录。
          // restricted 候选可以进入无 Cookie 隔离浏览器实读，但不能只靠搜索摘要兜底。
          if (!['public', 'authenticated'].includes(resource.accessType || '')) return;
          if (!['article', 'webpage', 'document'].includes(resource.resourceType || 'webpage')) return;
          const relevance = conceptEvidenceRelevanceScore(term, resource.title, resource.description || '', aliases);
          if (research || relevance > 0) candidates.set(resource.url, resource);
        });
        if (!research && candidates.size >= 8) break;
      } catch (cause) {
        signal?.throwIfAborted();
        lastSearchError = cause instanceof Error ? cause : new Error(String(cause));
      }
    }
    if (!sessionId) throw lastSearchError || new Error('概念研究浏览器未能完成搜索');
    const state = sessions.get(sessionId);
    const contents = state?.browserView?.webContents;
    if (!state || !contents || contents.isDestroyed()) throw new Error('概念研究浏览器未能初始化');
    const ranked = [...candidates.values()].sort((a, b) => {
      const relevanceDelta = conceptEvidenceRelevanceScore(term, b.title, b.description || '', aliases)
        - conceptEvidenceRelevanceScore(term, a.title, a.description || '', aliases);
      return relevanceDelta || conceptAuthorityScore(b) - conceptAuthorityScore(a);
    });
    const evidence: Array<Omit<ConceptSourceEvidence, 'sourceId'>> = [];
    const hosts = new Set<string>();
    for (const resource of ranked) {
      signal?.throwIfAborted();
      if (evidence.length >= 4) break;
      let host = '';
      try { host = new URL(resource.url).hostname.toLocaleLowerCase(); } catch { continue; }
      if (hosts.has(host)) continue;
      try {
        const extracted = await extractConceptPageEvidence(contents, resource, term, aliases, Boolean(research));
        signal?.throwIfAborted();
        if (extracted) {
          evidence.push(extracted);
          hosts.add(host);
          continue;
        }
      } catch { signal?.throwIfAborted(); /* Preserve existing evidence policy; cancellation never becomes a summary. */ }
      const snippet = String(resource.description || '').replace(/\s+/gu, ' ').trim().slice(0, 1200);
      if (!research && resource.accessType === 'public'
        && snippet.length >= 80
        && conceptEvidenceRelevanceScore(term, '', snippet, aliases) > 0) {
        evidence.push({ type: 'web', title: resource.title, url: resource.url, snippet });
        hosts.add(host);
      }
    }
    if (evidence.length === 0) {
      if (candidates.size === 0) {
        throw new Error(searchedCandidateCount > 0
          ? `搜索引擎返回了 ${searchedCandidateCount} 个候选，但没有页面完整命中“${term}”或已登记别名`
          : `搜索引擎没有返回“${term}”的可读取候选，请检查网络或补充概念别名后重试`);
      }
      throw new Error(`已找到 ${candidates.size} 个与“${term}”相关的候选，但隔离浏览器未能读取到足够正文；页面可能启用了登录、验证码或脚本限制`);
    }
    return evidence.map((item, index) => ({ ...item, sourceId: `W${index + 1}` }));
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (sessionId) closeResourceBrowserSession(sessionId);
  }
}

function findCandidateByUrl(state: BrowserSearchSession, url: string): ResourceItem | undefined {
  return [...state.candidates.values()].find((candidate) => candidate.url === url);
}

async function registerCandidateUrl(
  state: BrowserSearchSession,
  rawUrl: string,
  rawTitle: string,
  sourcePageUrl: string,
): Promise<ResourceItem> {
  assertResourceSessionEditable(state);
  const safeUrl = await assertSafePublicUrl(rawUrl);
  const fallbackTitle = safeUrl.hostname;
  const normalized = normalizeBrowserCandidates([{
    title: rawTitle || fallbackTitle,
    url: safeUrl.toString(),
    detectedFrom: rawUrl === sourcePageUrl ? 'page' : 'link',
  }], 1)[0];
  if (!normalized) throw new Error('该地址不能登记为学习资源');

  const checked = state.persistent ? null : await checkPublicResourceUrl(normalized.url);
  if (checked && !['available', 'redirected', 'restricted'].includes(checked.status)) {
    throw new Error('该地址当前不可访问');
  }
  const accessType: NonNullable<ResourceItem['accessType']> = state.persistent || checked?.status === 'restricted'
    ? 'authenticated'
    : 'public';
  const finalUrl = checked?.finalUrl || normalized.url;
  const classified = classifyBrowserResource({
    ...normalized,
    url: finalUrl,
    contentType: checked?.contentType || normalized.contentType,
    downloadName: checked?.suggestedFileName || normalized.downloadName,
  });
  // 右键菜单可能在确认之前打开，网络校验返回时必须重新核对当前提交状态。
  assertResourceSessionEditable(state);
  const existing = findCandidateByUrl(state, finalUrl);
  if (existing) {
    const updated = {
      ...existing,
      projectTitle: state.request.projectTitle,
      searchCategory: existing.searchCategory || state.activeSearchTabId,
      taskText: state.request.taskText,
      knowledgeTitles: state.request.knowledgeTitles,
      sourcePageUrl: sanitizeSourcePageUrl(sourcePageUrl) || existing.sourcePageUrl,
    };
    state.candidates.set(existing.candidateId!, updated);
    return updated;
  }
  const candidateId = `${state.id}:candidate-${state.nextCandidateNumber++}`;
  const downloadable = accessType === 'public' && classified.downloadable;
  const item: ResourceItem = {
    title: normalized.title || fallbackTitle,
    url: finalUrl,
    platform: normalized.platform,
    kind: 'online',
    projectTitle: state.request.projectTitle,
    searchCategory: state.activeSearchTabId,
    taskText: state.request.taskText,
    knowledgeTitles: state.request.knowledgeTitles,
    isFree: checked?.httpStatus === 402 ? false : accessType === 'public' ? inferResourceIsFree(finalUrl, downloadable || classified.isAttachment) : undefined,
    verifiedAt: checked?.checkedAt || new Date().toISOString(),
    candidateId,
    sourcePageUrl: sanitizeSourcePageUrl(sourcePageUrl),
    contentType: classified.contentType,
    contentLength: checked?.contentLength,
    suggestedFileName: checked?.suggestedFileName,
    fileExtension: classified.fileExtension,
    resourceType: classified.resourceType,
    detectedFrom: normalized.detectedFrom || 'link',
    isAttachment: classified.isAttachment,
    downloadable,
    indexable: classified.indexable,
    fileType: classified.fileType,
    accessType,
    accessHttpStatus: checked?.httpStatus,
    browserSessionId: state.id,
    browserPartition: state.partition,
    authContainerId: state.authContainerId,
  };
  state.candidates.set(candidateId, item);
  return item;
}

export async function scanResourceBrowserSession(sessionId: string): Promise<ResourceBrowserScanResult> {
  const state = sessions.get(String(sessionId || ''));
  const contents = state?.browserView?.webContents;
  if (!state?.window || state.window.isDestroyed() || !contents || contents.isDestroyed()) throw new Error('浏览器窗口已关闭，请重新打开资源搜索');
  assertResourceSessionEditable(state);
  const snapshot = await extractPageSnapshot(contents);
  assertResourceSessionEditable(state);
  const raw = [
    {
      title: snapshot.title || new URL(snapshot.url).hostname,
      url: snapshot.url,
      description: snapshot.description,
      hintType: snapshot.hintType,
      detectedFrom: 'page' as const,
    },
    ...snapshot.links,
  ];
  const normalized = normalizeBrowserCandidates(raw, 20);
  const resources: ResourceItem[] = [];
  const checkedCandidates = await Promise.all(normalized.map(async (candidate) => {
    if (state.persistent) {
      try {
        await assertSafePublicUrl(candidate.url);
        return {
          candidate,
          accessType: 'authenticated' as const,
          finalUrl: candidate.url,
          verifiedAt: new Date().toISOString(),
          contentType: candidate.contentType,
          contentLength: undefined,
          suggestedFileName: candidate.downloadName,
          httpStatus: undefined,
        };
      } catch { return null; }
    }
    const health = await checkPublicResourceUrl(candidate.url);
    const accessType = health.status === 'restricted' ? 'authenticated' as const : 'public' as const;
    if (health.status !== 'restricted' && health.status !== 'available' && health.status !== 'redirected') return null;
    return {
      candidate,
      accessType,
      finalUrl: health.finalUrl || candidate.url,
      verifiedAt: health.checkedAt,
      contentType: health.contentType || candidate.contentType,
      contentLength: health.contentLength,
      suggestedFileName: health.suggestedFileName || candidate.downloadName,
      httpStatus: health.httpStatus,
    };
  }));
  assertResourceSessionEditable(state);
  for (const checked of checkedCandidates) {
    if (!checked) continue;
    const { candidate, accessType, finalUrl, verifiedAt, contentType, contentLength, suggestedFileName } = checked;
    const classified = classifyBrowserResource({
      ...candidate,
      url: finalUrl,
      contentType,
      downloadName: suggestedFileName,
    });
    const existing = findCandidateByUrl(state, finalUrl);
    const candidateId = existing?.candidateId || `${state.id}:candidate-${state.nextCandidateNumber++}`;
    const downloadable = state.persistent ? classified.downloadable : accessType === 'public' && classified.downloadable;
    const item: ResourceItem = {
      title: candidate.title,
      url: finalUrl,
      platform: candidate.platform,
      kind: 'online',
      projectTitle: state.request.projectTitle,
      searchCategory: existing?.searchCategory || state.activeSearchTabId,
      taskText: state.request.taskText,
      knowledgeTitles: state.request.knowledgeTitles,
      isFree: checked.httpStatus === 402 ? false : accessType === 'public' ? inferResourceIsFree(finalUrl, downloadable || classified.isAttachment) : undefined,
      verifiedAt,
      candidateId,
      sourcePageUrl: sanitizeSourcePageUrl(snapshot.url),
      contentType: classified.contentType,
      contentLength,
      suggestedFileName,
      fileExtension: classified.fileExtension,
      resourceType: classified.resourceType,
      detectedFrom: candidate.detectedFrom || 'link',
      description: candidate.description,
      isAttachment: classified.isAttachment,
      downloadable,
      indexable: classified.indexable,
      fileType: classified.fileType,
      accessType,
      accessHttpStatus: checked.httpStatus,
      browserSessionId: state.id,
      browserPartition: state.partition,
      authContainerId: state.authContainerId,
    };
    state.candidates.set(candidateId, item);
    resources.push(item);
  }
  pushResourceWorkbenchState(state, `已扫描当前页并登记 ${resources.length} 个候选。`);
  return { sessionId: state.id, pageUrl: snapshot.url, resources };
}

export async function openAuthenticatedCandidate(
  sessionId: string,
  candidateId: string,
  parent?: BrowserWindow | null,
): Promise<{ canceled?: boolean; container?: ResourceAuthContainer; resource?: ResourceItem }> {
  const sourceState = sessions.get(String(sessionId || ''));
  const source = sourceState?.candidates.get(String(candidateId || ''));
  if (!sourceState || !source) throw new Error('资源候选已失效，请重新搜索');
  assertResourceSessionEditable(sourceState);
  const sourceDecision = sourceState.pendingDecisions.get(String(candidateId || ''));
  const safeUrl = await assertSafePublicUrl(source.url);
  assertResourceSessionEditable(sourceState);
  const origin = safeUrl.origin;
  const hostname = safeUrl.hostname;
  const confirmation = await dialog.showMessageBox(parent && !parent.isDestroyed() ? parent : undefined, {
    type: 'question',
    title: '创建隔离登录容器',
    message: `允许 Loginote 为 ${hostname} 保存独立登录状态？`,
    detail: '登录、密码和验证码只在该网站窗口中输入。Cookie 由 Chromium 保存在本机，不会发送给 Agent、LLM、Python、审计或分享数据。你可以随时在设置中删除该容器。',
    buttons: ['取消', '允许并打开'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  restoreResourceWorkbenchFocus(sessionId);
  if (confirmation.response !== 1) return { canceled: true };
  assertResourceSessionEditable(sourceState);

  const now = new Date().toISOString();
  const id = authContainerId(origin);
  const partition = `persist:resource-auth-${id}`;
  const containers = await listResourceAuthContainers();
  assertResourceSessionEditable(sourceState);
  const existing = containers.find((container) => container.id === id);
  const container: ResourceAuthContainer = existing
    ? { ...existing, lastUsedAt: now }
    : { id, name: hostname, origin, partition, createdAt: now, lastUsedAt: now };
  await saveResourceAuthContainers([...containers.filter((item) => item.id !== id), container]);

  const authBrowserSession = electronSession.fromPartition(partition);
  const copiedCookieCount = await copyOriginCookies(sourceState.browserSession, authBrowserSession, safeUrl);

  [...sessions.values()]
    .filter((item) => item.authContainerId === id)
    .forEach((item) => closeResourceBrowserSession(item.id));
  const authSessionId = `resource-browser-${id}-${Date.now()}`;
  const state: BrowserSearchSession = {
    id: authSessionId,
    partition,
    browserSession: authBrowserSession,
    window: null,
    browserView: null,
    feedbackTarget: parent && !parent.isDestroyed() ? parent : null,
    candidates: new Map(),
    request: sourceState.request,
    persistent: true,
    authContainerId: id,
    nextCandidateNumber: 2,
    pendingDecisions: new Map(),
    pendingDownloadCandidateIds: new Set(),
    automaticCandidateIds: new Set(),
    query: sourceState.query,
    searchPageUrl: safeUrl.toString(),
  };
  installSessionGuards(state);
  sessions.set(authSessionId, state);
  createSearchWindow(state, parent);
  const contents = state.browserView?.webContents;
  if (!contents) throw new Error('隔离登录工作台未能初始化');
  await waitForPage(contents, safeUrl.toString());
  const resource: ResourceItem = {
    ...source,
    candidateId: `${authSessionId}:candidate-1`,
    isFree: false,
    accessType: 'authenticated',
    downloadable: false,
    browserSessionId: authSessionId,
    browserPartition: partition,
    authContainerId: id,
  };
  state.candidates.set(resource.candidateId!, resource);
  if (sourceDecision) state.pendingDecisions.set(resource.candidateId!, sourceDecision);
  pushResourceWorkbenchState(state, copiedCookieCount > 0
    ? `已把本站当前的 ${copiedCookieCount} 项 Cookie 保存到本机隔离容器。若页面仍要求登录，请在左侧再登录一次。`
    : '已创建本站的本机隔离容器。请在左侧完成登录并打开目标资源。');
  return { container, resource };
}

export async function openResourceAuthContainer(
  containerId: string,
  parent?: BrowserWindow | null,
): Promise<{ ok: boolean; sessionId?: string; error?: string }> {
  const container = (await listResourceAuthContainers()).find((item) => item.id === String(containerId || ''));
  if (!container) return { ok: false, error: '登录容器不存在' };
  [...sessions.values()]
    .filter((item) => item.authContainerId === container.id)
    .forEach((item) => closeResourceBrowserSession(item.id));
  const sessionId = `resource-browser-${container.id}-${Date.now()}`;
  const state: BrowserSearchSession = {
    id: sessionId,
    partition: container.partition,
    browserSession: electronSession.fromPartition(container.partition),
    window: null,
    browserView: null,
    feedbackTarget: parent && !parent.isDestroyed() ? parent : null,
    candidates: new Map(),
    request: { projectTitle: '设置', taskText: '登录容器管理', knowledgeTitles: ['登录容器'] },
    persistent: true,
    authContainerId: container.id,
    nextCandidateNumber: 1,
    pendingDecisions: new Map(),
    pendingDownloadCandidateIds: new Set(),
    automaticCandidateIds: new Set(),
    query: container.name,
    searchPageUrl: container.origin,
  };
  installSessionGuards(state);
  sessions.set(sessionId, state);
  createSearchWindow(state, parent);
  const contents = state.browserView?.webContents;
  if (!contents) return { ok: false, error: '登录容器工作台未能初始化' };
  await waitForPage(contents, container.origin);
  await saveResourceAuthContainers((await listResourceAuthContainers()).map((item) => (
    item.id === container.id ? { ...item, lastUsedAt: new Date().toISOString() } : item
  )));
  return { ok: true, sessionId };
}

export async function removeResourceAuthContainer(containerId: string): Promise<boolean> {
  const containers = await listResourceAuthContainers();
  const container = containers.find((item) => item.id === String(containerId || ''));
  if (!container) return false;
  [...sessions.values()]
    .filter((item) => item.authContainerId === container.id)
    .forEach((item) => closeResourceBrowserSession(item.id));
  const ses = electronSession.fromPartition(container.partition);
  await ses.clearStorageData();
  await ses.clearCache();
  await saveResourceAuthContainers(containers.filter((item) => item.id !== container.id));
  return true;
}

export async function clearAllResourceAuthContainers(): Promise<void> {
  const containers = await listResourceAuthContainers();
  await Promise.all(containers.map(async (container) => {
    [...sessions.values()]
      .filter((item) => item.authContainerId === container.id)
      .forEach((item) => closeResourceBrowserSession(item.id));
    const ses = electronSession.fromPartition(container.partition);
    await ses.clearStorageData();
    await ses.clearCache();
  }));
  if (resourceBrowserUserStateDir) await fs.rm(authContainerPath(), { force: true });
}

export async function navigateResourceWorkbench(
  sessionId: string,
  action: 'back' | 'forward' | 'reload' | 'home' | 'go' | 'open-candidate' | 'switch-tab' | 'search-variant',
  value?: string,
): Promise<boolean> {
  const state = sessions.get(String(sessionId || ''));
  const contents = state?.browserView?.webContents;
  if (!state || !contents || contents.isDestroyed()) throw new Error('资源工作台已经关闭');
  assertResourceSessionEditable(state);
  if (action === 'switch-tab') {
    const tab = state.searchTabs?.find((item) => item.id === value);
    if (!tab) throw new Error('资源检索标签已失效');
    if (state.activeSearchTabId === tab.id && tab.loaded) return true;
    state.activeSearchTabId = tab.id;
    state.query = tab.query;
    state.searchPageUrl = tab.searchPageUrl;
    if (tab.loaded) {
      try {
        pushResourceWorkbenchState(state, `已切换到“${tab.label}”。`, true);
        await waitForPage(contents, tab.currentUrl || tab.searchPageUrl);
        pushResourceWorkbenchState(state, undefined, false);
      } catch (error) {
        pushResourceWorkbenchState(state, error instanceof Error ? error.message : String(error), false);
        throw error;
      }
    } else {
      try {
        const found = await executeResourceSearchPlan(state, contents, {
          query: tab.query,
          searchPageUrl: tab.searchPageUrl,
          category: tab.id,
          label: tab.label,
          variantId: tab.activeVariantId,
        });
        pushResourceWorkbenchState(
          state,
          `“${tab.label}”首次加载完成，自动推荐 ${found.length} 个候选（上限 ${tab.automaticTarget}）；主动添加不限量。`,
          false,
        );
      } catch (error) {
        pushResourceWorkbenchState(state, error instanceof Error ? error.message : String(error), false);
        throw error;
      }
    }
  } else if (action === 'search-variant') {
    const [tabId, variantId] = String(value || '').split('::');
    const tab = state.searchTabs?.find((item) => item.id === tabId);
    const variant = tab?.variants?.find((item) => item.id === variantId);
    if (!tab || !variant) throw new Error('备用搜索词条已失效');
    state.activeSearchTabId = tab.id;
    tab.activeVariantId = variant.id;
    try {
      const found = await executeResourceSearchPlan(state, contents, {
        query: variant.query,
        searchPageUrl: variant.searchPageUrl,
        category: tab.id,
        label: `${tab.label} / ${variant.label}`,
        variantId: variant.id,
      });
      pushResourceWorkbenchState(
        state,
        found.length > 0
          ? `已用“${variant.label}”搜索，自动推荐新增 ${found.length} 个候选；该类上限 ${tab.automaticTarget}，主动添加不限量。`
          : `已用“${variant.label}”搜索；该类自动推荐额度为 ${tab.automaticTarget} 个，若需更多可扫描当前页或右键添加。`,
        false,
      );
    } catch (error) {
      pushResourceWorkbenchState(state, error instanceof Error ? error.message : String(error), false);
      throw error;
    }
  } else if (action === 'back') {
    if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
  } else if (action === 'forward') {
    if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
  } else if (action === 'reload') {
    contents.reload();
  } else if (action === 'home') {
    await executeResourceSearchPlan(state, contents, { query: state.query, searchPageUrl: state.searchPageUrl, category: state.activeSearchTabId });
  } else if (action === 'open-candidate') {
    const candidate = state.candidates.get(String(value || ''));
    if (!candidate) throw new Error('资源候选已失效');
    await contents.loadURL((await assertSafePublicUrl(candidate.url)).toString());
  } else {
    const text = String(value || '').trim();
    if (!text) return false;
    if (/^https?:\/\//iu.test(text)) {
      await contents.loadURL((await assertSafePublicUrl(text)).toString());
    } else {
      state.query = text;
      state.searchPageUrl = buildBingSearchUrl(text);
      await executeResourceSearchPlan(state, contents, { query: text, searchPageUrl: state.searchPageUrl, category: state.activeSearchTabId });
    }
  }
  if (action !== 'switch-tab' && action !== 'search-variant') pushResourceWorkbenchState(state);
  return true;
}

export function setResourceWorkbenchDecision(
  sessionId: string,
  candidateId: string,
  decision: ResourceCandidateDecision | null,
): ResourceWorkbenchState {
  const state = sessions.get(String(sessionId || ''));
  const candidate = state?.candidates.get(String(candidateId || ''));
  if (!state || !candidate) throw new Error('资源候选已失效，请重新搜索');
  assertResourceSessionEditable(state);
  if (decision === null) {
    state.pendingDecisions.delete(candidateId);
    state.pendingDownloadCandidateIds.delete(candidateId);
  } else {
    state.pendingDecisions.set(candidateId, decision);
    if (decision === 'rejected') state.pendingDownloadCandidateIds.delete(candidateId);
  }
  const notice = decision === 'selected'
    ? `已暂存“${candidate.title}”，确认前不会写回。`
    : decision === 'rejected'
      ? `已暂存“不感兴趣”：${candidate.title}`
      : `已撤销对“${candidate.title}”的选择。`;
  pushResourceWorkbenchState(state, notice);
  return resourceWorkbenchState(state, notice);
}

export function setResourceWorkbenchDownload(
  sessionId: string,
  candidateId: string,
  enabled: boolean,
): ResourceWorkbenchState {
  const state = sessions.get(String(sessionId || ''));
  const candidate = state?.candidates.get(String(candidateId || ''));
  if (!state || !candidate) throw new Error('资源候选已失效，请重新搜索');
  assertResourceSessionEditable(state);
  if (!candidate.downloadable) throw new Error('该资源不是当前支持下载的文件');
  if (enabled) {
    state.pendingDecisions.set(candidateId, 'selected');
    state.pendingDownloadCandidateIds.add(candidateId);
  } else {
    state.pendingDownloadCandidateIds.delete(candidateId);
  }
  const notice = enabled
    ? `“${candidate.title}”将在统一确认后下载到本地资料库。`
    : `已取消“${candidate.title}”的下载标记。`;
  pushResourceWorkbenchState(state, notice);
  return resourceWorkbenchState(state, notice);
}

export function getResourceWorkbenchPendingCommit(sessionId: string): {
  state: BrowserSearchSession;
  selectedResources: ResourceItem[];
  rejectedResources: ResourceItem[];
  downloadCandidateIds: string[];
} {
  const state = sessions.get(String(sessionId || ''));
  if (!state) throw new Error('资源工作台已经关闭');
  const selectedResources: ResourceItem[] = [];
  const rejectedResources: ResourceItem[] = [];
  state.pendingDecisions.forEach((decision, candidateId) => {
    const candidate = state.candidates.get(candidateId);
    if (!candidate) return;
    const snapshot = { ...candidate, knowledgeTitles: candidate.knowledgeTitles ? [...candidate.knowledgeTitles] : undefined };
    if (decision === 'selected') selectedResources.push(snapshot);
    else rejectedResources.push(snapshot);
  });
  return {
    state,
    selectedResources,
    rejectedResources,
    downloadCandidateIds: [...state.pendingDownloadCandidateIds].filter((id) => state.pendingDecisions.get(id) === 'selected'),
  };
}

export function beginResourceWorkbenchCommit(sessionId: string, commitId: string, onClosed: () => void): void {
  const state = sessions.get(sessionId);
  if (!state) throw new Error('资源工作台已经关闭');
  assertResourceSessionEditable(state);
  if (state.busy || state.pendingDownload) throw new Error('当前资源操作尚未结束，请稍候再确认');
  state.commit = { id: commitId, phase: 'confirming', onClosed };
  pushResourceWorkbenchState(state, '请在确认框中确认本次选择；取消后仍可继续调整。', true);
}

export function isResourceWorkbenchCommitActive(sessionId: string, commitId: string, applyingOnly = false): boolean {
  const state = sessions.get(sessionId);
  return Boolean(state?.window && !state.window.isDestroyed() && state.commit?.id === commitId
    && (!applyingOnly || state.commit.phase === 'applying'));
}

export function completeResourceWorkbenchCommit(sessionId: string, commitId: string, notice: string): void {
  const state = sessions.get(String(sessionId || ''));
  if (!state || state.commit?.id !== commitId) return;
  const commit = state.commit;
  state.commit = undefined;
  commit.onClosed();
  state.pendingDecisions.clear();
  state.pendingDownloadCandidateIds.clear();
  pushResourceWorkbenchState(state, notice, false);
}

export function updateResourceWorkbenchCommitState(
  sessionId: string,
  commitId: string,
  notice: string,
  phase: 'preparing' | 'applying' | null,
): void {
  const state = sessions.get(String(sessionId || ''));
  if (!state || state.commit?.id !== commitId) return;
  if (phase) state.commit.phase = phase;
  else cancelResourceSessionCommit(state);
  pushResourceWorkbenchState(state, notice, Boolean(phase));
}

export async function downloadResourceCandidate(
  sessionId: string,
  candidateId: string,
  parent?: BrowserWindow | null,
  skipConfirmation = false,
): Promise<{ canceled?: boolean; filePath?: string; title?: string; sourceUrl?: string }> {
  const state = sessions.get(String(sessionId || ''));
  const candidate = state?.candidates.get(String(candidateId || ''));
  if (!state || !candidate) throw new Error('资源候选已失效，请重新搜索');
  if (!skipConfirmation) assertResourceSessionEditable(state);
  const commitId = skipConfirmation ? state.commit?.id : undefined;
  const assertDownloadActive = () => {
    if (sessions.get(state.id) !== state || !state.window || state.window.isDestroyed()
      || (commitId ? state.commit?.id !== commitId : Boolean(state.commit))) {
      throw new Error('资源工作台已关闭或正在提交，下载已取消');
    }
  };
  assertDownloadActive();
  if (!candidate.downloadable || !candidate.fileExtension) {
    throw new Error('该候选不是当前支持保存的直接文件附件');
  }
  if (candidate.contentLength && candidate.contentLength > MAX_DOWNLOAD_BYTES) {
    throw new Error('该文件超过 100 MB，不能加入资料库');
  }
  if (state.pendingDownload) throw new Error('该浏览器会话已有下载正在进行');
  const confirmation = skipConfirmation ? { response: 1 } : await dialog.showMessageBox(parent && !parent.isDestroyed() ? parent : undefined, {
    type: 'question',
    title: '确认下载到资料库',
    message: `下载“${candidate.title}”并加入本地资料库？`,
    detail: `${candidate.platform || candidate.url}\n文件只会在确认后下载，最大 100 MB。${candidate.indexable ? '下载后将自动解析并建立资料库索引。' : '当前格式会保存到资料库，但暂不建立索引。'}`,
    buttons: ['取消', '下载并入库'],
    defaultId: 1,
    cancelId: 0,
    noLink: true,
  });
  if (!skipConfirmation) restoreResourceWorkbenchFocus(sessionId);
  if (confirmation.response !== 1) return { canceled: true };
  assertDownloadActive();

  const tempRoot = path.join(os.tmpdir(), 'loginote-resource-downloads');
  await fs.mkdir(tempRoot, { recursive: true });
  assertDownloadActive();
  const tempDir = await fs.mkdtemp(path.join(tempRoot, 'download-'));
  try {
    assertDownloadActive();
  } catch (error) {
    // 此时尚未开始下载，目录是本函数刚创建的空临时目录。
    await fs.rmdir(tempDir).catch(() => {});
    throw error;
  }
  const fileName = safeAttachmentFileName(
    candidate.title,
    candidate.url,
    candidate.suggestedFileName,
    candidate.fileExtension,
  );
  const targetPath = path.join(tempDir, fileName);
  try {
    const filePath = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = state.pendingDownload;
        if (pending?.targetPath !== targetPath) return;
        state.pendingDownload = undefined;
        reject(new Error('下载超时'));
        pending.cancel?.();
      }, 120_000);
      state.pendingDownload = { url: candidate.url, targetPath, resolve, reject, timer };
      state.browserSession.downloadURL(candidate.url);
    });
    assertDownloadActive();
    await assertResourceDownloadFile(filePath, candidate.fileExtension);
    assertDownloadActive();
    return { filePath, title: candidate.title, sourceUrl: sanitizeSourcePageUrl(candidate.url) };
  } catch (error) {
    const pending = state.pendingDownload;
    if (pending?.targetPath === targetPath) {
      state.pendingDownload = undefined;
      clearTimeout(pending.timer);
      pending.cancel?.();
    }
    // 仅清理本次下载创建的具体文件/目录，不递归删除共享临时根目录。
    await fs.unlink(targetPath).catch(() => {});
    await fs.rmdir(tempDir).catch(() => {});
    throw error;
  }
}

export function closeResourceBrowserSession(sessionId: string): boolean {
  const state = sessions.get(String(sessionId || ''));
  if (!state) return false;
  if (state.commit?.phase === 'applying') {
    pushResourceWorkbenchState(state, '资源正在写回项目，请等待保存结果后再关闭。');
    return false;
  }
  cancelResourceSessionCommit(state);
  const ownedWindow = !state.transportOnly && state.window && !state.window.isDestroyed() ? state.window : null;
  // Register cleanup before closing: the active map may disappear immediately,
  // while the guest and Chromium storage still need asynchronous teardown.
  let confirmClosed: (() => void) | undefined;
  const closed = ownedWindow && !state.persistent ? new Promise<void>(resolve => { confirmClosed = resolve; ownedWindow.once('closed', resolve); }) : undefined;
  if (!state.persistent) void resourceSessionCleanup.schedule(state.browserSession, closed);
  try { ownedWindow?.close(); }
  catch (error) {
    if (confirmClosed) { ownedWindow?.removeListener('closed', confirmClosed); confirmClosed(); }
    throw error;
  }
  sessions.delete(state.id);
  return true;
}

/** Dedicated anonymous download transport, independent of closed search windows.
 * Only the host's approved batch passes verified descriptors here. */
export async function downloadPublicResourceAttachment(resource: ResourceItem, parent: BrowserWindow | null, signal: AbortSignal): Promise<{ filePath?: string }> {
  signal.throwIfAborted();
  if (!parent || parent.isDestroyed()) throw new Error('主窗口不可用');
  const id = createSessionId(), partition = `resource-download-temp-${id}`;
  const browserSession = electronSession.fromPartition(partition, { cache: false });
  const state: BrowserSearchSession = { id, partition, browserSession, window: parent, browserView: null, feedbackTarget: null,
    candidates: new Map([['approved', resource]]), request: { projectTitle: '', taskText: '', knowledgeTitles: [] }, persistent: false,
    nextCandidateNumber: 1, pendingDecisions: new Map(), pendingDownloadCandidateIds: new Set(), automaticCandidateIds: new Set(), query: '', searchPageUrl: '', transportOnly: true };
  installSessionGuards(state); sessions.set(id, state);
  const abort = () => { cancelResourceSessionCommit(state); sessions.delete(id); };
  signal.addEventListener('abort', abort, { once: true });
  try { signal.throwIfAborted(); return await downloadResourceCandidate(id, 'approved', undefined, true); }
  finally {
    signal.removeEventListener('abort', abort); cancelResourceSessionCommit(state); sessions.delete(id);
    // Parent is the application window, not an owned workbench: never close it.
    await resourceSessionCleanup.schedule(browserSession);
  }
}

export async function disposeResourceBrowserSessions(): Promise<void> {
  // 应用退出必须释放挂起下载与提交，不能让工作台的保存期关闭保护阻止退出。
  [...sessions.values()].forEach((state) => {
    cancelResourceSessionCommit(state);
    closeResourceBrowserSession(state.id);
  });
  await resourceSessionCleanup.drain();
}

/** Narrow browser-only fallback for optional textbook discovery. Never changes
 * resource curation quotas, workbench state, preferences or project bindings. */
export async function searchTextbookLinksInBrowser(query: string, signal: AbortSignal): Promise<Array<{ title: string; url: string; snippet: string; content: string }>> {
  signal.throwIfAborted();
  const id = createSessionId(), partition = `textbook-search-temp-${id}`;
  const browserSession = electronSession.fromPartition(partition, { cache: false });
  const win = new BrowserWindow({ show: false, webPreferences: { session: browserSession, sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  const state: BrowserSearchSession = { id, partition, browserSession, window: win, browserView: null, feedbackTarget: null,
    candidates: new Map(), request: { projectTitle: '', taskText: '', knowledgeTitles: [], interactionMode: 'auto' }, persistent: false,
    nextCandidateNumber: 1, pendingDecisions: new Map(), pendingDownloadCandidateIds: new Set(), automaticCandidateIds: new Set(), query, searchPageUrl: buildBingSearchUrl(query) };
  installSessionGuards(state);
  const abort = () => { if (!win.isDestroyed()) win.destroy(); };
  signal.addEventListener('abort', abort, { once: true });
  let rejectAbort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(signal.reason); signal.addEventListener('abort', rejectAbort, { once: true }); });
  try {
    await Promise.race([loadBingSearch(state, win.webContents, query, buildBingSearchUrl(query), query.split(/\s+/u)[0]), cancelled]); signal.throwIfAborted();
    return (await extractCandidates(win.webContents)).slice(0, 6).map(hit => ({ title: hit.title, url: hit.url, snippet: hit.description || '', content: '' }));
  } finally {
    signal.removeEventListener('abort', abort); signal.removeEventListener('abort', rejectAbort); abort();
    await Promise.allSettled([browserSession.closeAllConnections(), browserSession.clearStorageData(), browserSession.clearCache()]);
  }
}
export function hasResourceWorkbenchAcceptedWrite(): boolean {
  return [...sessions.values()].some(state => state.commit?.phase === 'applying');
}
