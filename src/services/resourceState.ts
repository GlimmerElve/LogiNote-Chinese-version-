import type { NoteItem, ResourceItem, ResourceSearchCategory } from '../types';
import { automaticResourceContentIssue } from './resourceContentAdmission';
import { AUTOMATIC_RESOURCE_TARGETS, RESOURCE_CATEGORY_LABELS, automaticResourceIntentIssue, buildAutomaticResourcePlan, isDownloadableLearningResource, resourceIdentity } from './resourceCuration';

export type ResourceFeedbackRating = 'helpful' | 'not-helpful' | 'completed';
export type ResourceDiscoveryDecision = 'selected' | 'rejected';
export type ResourceHealthStatus = 'unchecked' | 'available' | 'redirected' | 'restricted' | 'broken' | 'temporary-error';

export interface ResourceFeedbackRecord {
  key: string;
  noteId: string;
  url: string;
  taskText?: string;
  knowledgeTitles?: string[];
  searchCategory?: ResourceSearchCategory;
  resourceType?: ResourceItem['resourceType'];
  rating: ResourceFeedbackRating;
  updatedAt: string;
}

export interface ResourceHealthRecord {
  url: string;
  status: ResourceHealthStatus;
  checkedAt: string;
  httpStatus?: number;
  finalUrl?: string;
  contentType?: string;
  contentLength?: number;
  suggestedFileName?: string;
  error?: string;
  failureCount: number;
}

export interface ResourceDiscoveryPreferenceRecord {
  key: string;
  noteId: string;
  url: string;
  host: string;
  taskText?: string;
  knowledgeTitles?: string[];
  resourceType?: ResourceItem['resourceType'];
  searchCategory?: ResourceSearchCategory;
  decision: ResourceDiscoveryDecision;
  updatedAt: string;
}

export interface ResourceStateFile {
  version: 1;
  feedback: Record<string, ResourceFeedbackRecord>;
  health: Record<string, ResourceHealthRecord>;
  discoveryPreferences: Record<string, ResourceDiscoveryPreferenceRecord>;
}

export interface AutoResourceSelectionResult {
  selected: ResourceItem[];
  skipped: Array<{ resource: ResourceItem; reason: string }>;
}

export interface ResourceHealthCheckResult extends Omit<ResourceHealthRecord, 'failureCount'> {}

export function deriveResourcePreferenceSignals(
  records: ResourceDiscoveryPreferenceRecord[],
  feedbackRecords: ResourceFeedbackRecord[] = [],
) {
  const automaticTargets = AUTOMATIC_RESOURCE_TARGETS;
  const selectedByCategory = new Map<ResourceSearchCategory, number>();
  const rejectedByHost = new Map<string, number>();
  const positiveByHost = new Map<string, number>();
  const negativeByHost = new Map<string, number>();
  records.forEach((record) => {
    if (record.decision === 'selected' && record.searchCategory) {
      selectedByCategory.set(record.searchCategory, (selectedByCategory.get(record.searchCategory) || 0) + 1);
    }
    if (record.decision === 'rejected' && record.host) {
      rejectedByHost.set(record.host, (rejectedByHost.get(record.host) || 0) + 1);
      negativeByHost.set(record.host, (negativeByHost.get(record.host) || 0) + 1);
    }
  });
  feedbackRecords.forEach((record) => {
    const host = resourceHost(record.url);
    if (!host) return;
    if (record.rating === 'helpful' || record.rating === 'completed') {
      positiveByHost.set(host, (positiveByHost.get(host) || 0) + 1);
    } else {
      negativeByHost.set(host, (negativeByHost.get(host) || 0) + 1);
    }
  });
  const hostNames = new Set([...positiveByHost.keys(), ...negativeByHost.keys()]);
  const hostSignals = [...hostNames].map((host) => {
    const positiveCount = positiveByHost.get(host) || 0;
    const negativeCount = negativeByHost.get(host) || 0;
    return { host, positiveCount, negativeCount };
  });
  const adaptivePlan = buildAutomaticResourcePlan({ version: 1, health: {},
    discoveryPreferences: Object.fromEntries(records.map(record => [record.key, record])),
    feedback: Object.fromEntries(feedbackRecords.map(record => [record.key, record])),
  });
  return {
    preferredCategories: (Object.keys(adaptivePlan.targets) as ResourceSearchCategory[]).flatMap(category => (
      adaptivePlan.targets[category] > automaticTargets[category]
        ? [{
            category,
            selectedCount: selectedByCategory.get(category) || 0,
            automaticTarget: automaticTargets[category],
            adjustedTarget: adaptivePlan.targets[category],
          }]
        : []
    )),
    questionableHosts: [...rejectedByHost.entries()]
      .map(([host, rejectedCount]) => ({ host, rejectedCount, confidence: rejectedCount >= 2 ? 'strong' as const : 'tentative' as const }))
      .sort((left, right) => right.rejectedCount - left.rejectedCount),
    blockedHosts: hostSignals
      .filter((item) => item.negativeCount >= 2 && item.negativeCount > item.positiveCount)
      .sort((left, right) => right.negativeCount - left.negativeCount),
    reliableHosts: hostSignals
      .filter((item) => item.positiveCount >= 2 && item.positiveCount > item.negativeCount)
      .sort((left, right) => right.positiveCount - left.positiveCount),
  };
}

export const RESOURCE_STATE_STORAGE_KEY = 'loginote_resource_state_v1';

export function emptyResourceState(): ResourceStateFile {
  return { version: 1, feedback: {}, health: {}, discoveryPreferences: {} };
}

export function normalizeResourceUrl(raw: string): string {
  const value = raw.trim();
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return value;
  }
}

export function makeResourceFeedbackKey(noteId: string, resource: Pick<ResourceItem, 'url' | 'taskText'>): string {
  return [noteId.trim(), (resource.taskText || '').trim().toLocaleLowerCase(), normalizeResourceUrl(resource.url)].join('|');
}

export function normalizeResourceState(value: unknown): ResourceStateFile {
  if (!value || typeof value !== 'object') return emptyResourceState();
  const raw = value as Partial<ResourceStateFile>;
  return {
    version: 1,
    feedback: raw.feedback && typeof raw.feedback === 'object' ? raw.feedback : {},
    health: raw.health && typeof raw.health === 'object' ? raw.health : {},
    discoveryPreferences: raw.discoveryPreferences && typeof raw.discoveryPreferences === 'object'
      ? raw.discoveryPreferences
      : {},
  };
}

export function getResourceStateSnapshot(): ResourceStateFile {
  if (typeof localStorage === 'undefined') return emptyResourceState();
  try {
    return normalizeResourceState(JSON.parse(localStorage.getItem(RESOURCE_STATE_STORAGE_KEY) || 'null'));
  } catch {
    return emptyResourceState();
  }
}

function resourceHost(url: string): string {
  try { return new URL(url).hostname.toLocaleLowerCase(); } catch { return ''; }
}

/** A single explicit selection or positive usage feedback shows willingness to
 * visit that exact host. It does not establish public access or content quality.
 * Never derive trust from automatically collected resources or browser cookies. */
export function trustedResourceHosts(state: ResourceStateFile, notes: NoteItem[] = []): Set<string> {
  const hosts = new Set<string>();
  const add = (raw: string | undefined) => {
    try { const url = new URL(raw || ''); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) hosts.add(url.hostname.toLocaleLowerCase()); } catch { /* not an online source */ }
  };
  Object.values(state.discoveryPreferences).forEach(record => { if (record.decision === 'selected') add(record.url); });
  Object.values(state.feedback).forEach(record => { if (record.rating === 'helpful' || record.rating === 'completed') add(record.url); });
  for (const note of notes) for (const resource of note.resources || []) {
    const legacyManual = resource.collectionOrigin === undefined && [
      '用户在资源统筹工作台中明确确认收录。', '用户在资源统筹工作台中确认下载并收录。',
    ].includes(resource.reason || '');
    if (resource.collectionOrigin === 'user' || legacyManual) add(resource.kind === 'local' ? resource.sourceUrl : resource.url);
  }
  const signals = deriveResourcePreferenceSignals(Object.values(state.discoveryPreferences), Object.values(state.feedback));
  signals.blockedHosts.forEach(item => hosts.delete(item.host));
  return hosts;
}

/** Recommendation links only: trusted hosts may require user login/verification.
 * No effect on browser sessions, downloads, content readers or textbook sources. */
export function automaticResourceAccessIssue(resource: ResourceItem, hosts: ReadonlySet<string> = new Set()): string | undefined {
  let url: URL;
  try { url = new URL(resource.url); } catch { return '非 HTTP(S) 在线资源'; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || resource.kind === 'local') return '非 HTTP(S) 在线资源';
  if (/(?:^|\/)(?:guest_verify|login|signin|sign-in|captcha|challenge|verification)(?:\/|$)/iu.test(url.pathname)) return '链接落在登录或验证页面，不能作为学习资源收录';
  if ([404, 410].includes(resource.accessHttpStatus || 0)) return '资源已失效（HTTP 404/410）';
  if (resource.accessHttpStatus === 402 || resource.isFree === false) return '未同时确认为公开可访问且免费';
  const pricingText = `${resource.title} ${resource.description || ''}`.replace(/(?:无须|无需|不需(?:要)?)付费/gu, '');
  if (/(?:需(?:要)?付费|付费(?:课程|观看|阅读|下载)|购买后|订阅后|会员专享|付费专享|\bpaywall\b|\bpremium[- ]only\b|\bsubscription required\b)/iu.test(pricingText)) return '存在明确收费或会员限制提示';
  if (resource.accessHttpStatus && resource.accessHttpStatus >= 400 && ![401, 403, 407, 429].includes(resource.accessHttpStatus)) return '当前链接检查失败';
  if (resource.accessType !== 'public') {
    if (resource.accessType !== 'authenticated' || !hosts.has(url.hostname.toLocaleLowerCase())) return '未同时确认为公开可访问且免费';
    if (!resource.verifiedAt || !Number.isFinite(Date.parse(resource.verifiedAt))) return '访问条件尚未核验';
    return undefined;
  }
  if (resource.isFree !== true && (!resource.verifiedAt || !Number.isFinite(Date.parse(resource.verifiedAt)))) return '公开访问状态尚未核验';
  return undefined;
}

export function summarizeAutomaticResourceSkips(skipped: AutoResourceSelectionResult['skipped']): string {
  const counts = new Map<string, number>();
  skipped.forEach(({ reason }) => counts.set(reason, (counts.get(reason) || 0) + 1));
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([reason, count]) => `${reason} ${count} 条`).join('；');
}

/**
 * 自动收录的确定性门控。LLM 不参与最终放行：真实搜索候选须公开或来自用户认可站点、无明确收费限制，
 * 标题/摘要命中项目核心主题或任务知识点，且不能命中历史排除。重复的显式选择与使用反馈可以
 * 调整分类配额、屏蔽持续负反馈站点，并提升反复被验证为有用的来源。
 */
export function selectResourcesForAutomaticCollection(
  resources: ResourceItem[],
  input: {
    taskText: string;
    projectTitle?: string;
    knowledgeTitles: string[];
    existingUrls: string[];
    maxResults?: number;
    state?: ResourceStateFile;
    notes?: NoteItem[];
    targets?: Partial<Record<ResourceSearchCategory, number>>;
  },
): AutoResourceSelectionResult {
  const state = input.state || getResourceStateSnapshot();
  const trustedHosts = trustedResourceHosts(state, input.notes);
  const existing = new Set(input.existingUrls.map(url => resourceIdentity({ url })));
  const exactRejected = new Set(Object.values(state.discoveryPreferences)
    .filter((item) => item.decision === 'rejected')
    .map((item) => resourceIdentity(item)));
  const preferenceSignals = deriveResourcePreferenceSignals(
    Object.values(state.discoveryPreferences),
    Object.values(state.feedback),
  );
  const blockedHosts = new Set(preferenceSignals.blockedHosts.map((item) => item.host));
  const reliableHosts = new Map(preferenceSignals.reliableHosts.map((item) => [item.host, item]));
  const hostScores = new Map<string, number>();
  const typeScores = new Map<string, number>();
  const categoryScores = new Map<string, number>();
  Object.values(state.discoveryPreferences).forEach((item) => {
    const weight = item.decision === 'selected' ? 1 : -2;
    if (item.host) hostScores.set(item.host, (hostScores.get(item.host) || 0) + weight);
    if (item.resourceType) typeScores.set(item.resourceType, (typeScores.get(item.resourceType) || 0) + weight);
    if (item.searchCategory) categoryScores.set(item.searchCategory, (categoryScores.get(item.searchCategory) || 0) + weight);
  });
  Object.values(state.feedback).forEach((item) => {
    const host = resourceHost(item.url);
    const weight = item.rating === 'completed' ? 3 : item.rating === 'helpful' ? 2 : -3;
    if (host) hostScores.set(host, (hostScores.get(host) || 0) + weight);
  });

  const skipped: AutoResourceSelectionResult['skipped'] = [];
  const ranked: Array<{ resource: ResourceItem; score: number }> = [];
  resources.forEach((resource, index) => {
    const url = normalizeResourceUrl(resource.url);
    const identity = resourceIdentity(resource);
    const host = resourceHost(url);
    const accessIssue = automaticResourceAccessIssue(resource, trustedHosts);
    if (accessIssue) { skipped.push({ resource, reason: accessIssue }); return; }
    if (existing.has(identity)) {
      skipped.push({ resource, reason: '项目已收录相同 URL' }); return;
    }
    if (exactRejected.has(identity)) {
      skipped.push({ resource, reason: '用户曾明确排除该 URL' }); return;
    }
    if (blockedHosts.has(host)) {
      skipped.push({ resource, reason: '用户多次对该来源站点给出负面反馈' }); return;
    }
    const hostPreference = hostScores.get(host) || 0;
    const contentIssue = automaticResourceContentIssue(resource, input) || automaticResourceIntentIssue(resource);
    if (contentIssue) { skipped.push({ resource, reason: contentIssue }); return; }
    const typePreference = typeScores.get(resource.resourceType || 'webpage') || 0;
    const categoryPreference = categoryScores.get(resource.searchCategory || '') || 0;
    const typeBase: Partial<Record<NonNullable<ResourceItem['resourceType']>, number>> = {
      pdf: 0.20, presentation: 0.16, document: 0.14, video: 0.10, article: 0.08, webpage: 0.02,
    };
    const score = 0.5
      + (resource.semanticReview?.score || 0) * 0.8
      + (typeBase[resource.resourceType || 'webpage'] || 0)
      + Math.max(-0.2, Math.min(0.2, hostPreference * 0.04))
      + Math.max(-0.12, Math.min(0.12, typePreference * 0.03))
      + Math.max(-0.18, Math.min(0.18, categoryPreference * 0.035))
      + (reliableHosts.has(host) ? 0.22 : 0)
      + (resource.isFree === true ? 0.04 : 0)
      - index * 0.002;
    ranked.push({ resource, score });
  });
  const sorted = ranked.sort((a, b) => b.score - a.score);
  const hasCategorizedSearch = sorted.some((item) => Boolean(item.resource.searchCategory));
  if (!hasCategorizedSearch) {
    const limit = Math.max(1, Math.min(3, input.maxResults || 2));
    const selected: ResourceItem[] = [], seen = new Set<string>();
    for (const { resource } of sorted) {
      const identity = resourceIdentity(resource);
      if (seen.has(identity)) { skipped.push({ resource, reason: '同一来源已收录' }); continue; }
      seen.add(identity);
      if (selected.length < limit) selected.push(resource);
      else skipped.push({ resource, reason: '超过每个任务的自动收录上限' });
    }
    return { selected, skipped };
  }
  const categoryTargets = buildAutomaticResourcePlan(state, 'adaptive', input.notes).targets;
  if (input.targets) for (const category of Object.keys(categoryTargets) as ResourceSearchCategory[]) {
    const target = input.targets[category];
    if (Number.isSafeInteger(target) && target! >= 1 && target! <= 6) categoryTargets[category] = target!;
  }
  const selected: ResourceItem[] = [];
  const selectedRows = new Set<typeof ranked[number]>();
  const selectedIds = new Set<string>(), hosts = new Map<string, number>();
  const coveredTopics = new Set<string>();
  // Reserve real attachments before online slots; a PDF keyword alone cannot satisfy this lane.
  for (const category of ['materials', 'encyclopedia', 'video', 'practice', 'paper'] as ResourceSearchCategory[]) {
    const pool = sorted.filter(item => item.resource.searchCategory === category);
    for (let count = 0; count < categoryTargets[category]; count++) {
      const candidates = pool.filter(item => !selectedIds.has(resourceIdentity(item.resource)));
      candidates.sort((a, b) => {
        const quality = (item: typeof a) => item.score - (hosts.get(resourceHost(item.resource.url)) || 0) * 0.12
          + Math.min(3, (item.resource.semanticReview?.topics || []).filter(topic => !coveredTopics.has(topic)).length) * 0.4
          + (category === 'materials' && isDownloadableLearningResource(item.resource) ? 2 : 0)
          + (category !== 'materials' && !isDownloadableLearningResource(item.resource) ? 0.15 : 0);
        return quality(b) - quality(a);
      });
      const best = candidates[0]; if (!best || selected.length >= 10) break;
      selected.push(best.resource); selectedRows.add(best); selectedIds.add(resourceIdentity(best.resource));
      best.resource.semanticReview?.topics?.forEach(topic => coveredTopics.add(topic));
      const host = resourceHost(best.resource.url); hosts.set(host, (hosts.get(host) || 0) + 1);
    }
  }
  for (const row of sorted) if (!selectedRows.has(row)) skipped.push({ resource: row.resource,
    reason: selectedIds.has(resourceIdentity(row.resource)) ? '同一来源已收录（含论文摘要与PDF）'
      : `超过“${RESOURCE_CATEGORY_LABELS[row.resource.searchCategory!]}”分类目标；不以其它类型凑数` });
  selected.sort((a, b) => Object.keys(AUTOMATIC_RESOURCE_TARGETS).indexOf(a.searchCategory!) - Object.keys(AUTOMATIC_RESOURCE_TARGETS).indexOf(b.searchCategory!));
  return { selected, skipped };
}

interface ResourceElectronApi {
  userState?: {
    loadResourceState(): Promise<unknown>;
    saveResourceState(file: unknown): Promise<void>;
  };
  checkResourceHealth?(url: string): Promise<ResourceHealthCheckResult>;
}

function getElectronApi(): ResourceElectronApi | undefined {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as { electronAPI?: ResourceElectronApi }).electronAPI;
}

let writeQueue: Promise<void> = Promise.resolve();

function persistResourceState(next: ResourceStateFile): Promise<void> {
  if (typeof localStorage === 'undefined') return Promise.resolve();
  localStorage.setItem(RESOURCE_STATE_STORAGE_KEY, JSON.stringify(next));
  const api = getElectronApi()?.userState;
  if (!api?.saveResourceState) return Promise.resolve();
  const write = writeQueue.then(() => api.saveResourceState(next));
  writeQueue = write.catch((error) => console.warn('[resource-state] save failed:', error));
  return write;
}

export async function loadResourceState(): Promise<ResourceStateFile> {
  const api = getElectronApi()?.userState;
  if (!api?.loadResourceState) return getResourceStateSnapshot();
  try {
    const remote = await api.loadResourceState();
    if (!remote) return getResourceStateSnapshot();
    const normalized = normalizeResourceState(remote);
    localStorage.setItem(RESOURCE_STATE_STORAGE_KEY, JSON.stringify(normalized));
    return normalized;
  } catch (error) {
    console.warn('[resource-state] load failed:', error);
    return getResourceStateSnapshot();
  }
}

export async function setResourceFeedback(
  noteId: string,
  resource: ResourceItem,
  rating: ResourceFeedbackRating,
): Promise<ResourceStateFile> {
  const current = getResourceStateSnapshot();
  const key = makeResourceFeedbackKey(noteId, resource);
  const next: ResourceStateFile = {
    ...current,
    feedback: {
      ...current.feedback,
      [key]: {
        key,
        noteId,
        url: normalizeResourceUrl(resource.url),
        taskText: resource.taskText,
        knowledgeTitles: resource.knowledgeTitles,
        searchCategory: resource.searchCategory,
        resourceType: resource.resourceType,
        rating,
        updatedAt: new Date().toISOString(),
      },
    },
  };
  await persistResourceState(next);
  return next;
}

export async function recordResourceDiscoveryPreference(
  noteId: string,
  resource: ResourceItem,
  decision: ResourceDiscoveryDecision,
): Promise<ResourceStateFile> {
  return recordResourceDiscoveryPreferences(noteId, [{ resource, decision }]);
}

/** 一次合并写入工作台的所有明确选择，避免并发持久化丢失同一批偏好。 */
export async function recordResourceDiscoveryPreferences(
  noteId: string,
  decisions: Array<{ resource: ResourceItem; decision: ResourceDiscoveryDecision }>,
): Promise<ResourceStateFile> {
  const current = getResourceStateSnapshot();
  const updatedAt = new Date().toISOString();
  const additions = decisions.reduce<Record<string, ResourceDiscoveryPreferenceRecord>>((records, item) => {
    const url = normalizeResourceUrl(item.resource.url);
    const key = [noteId.trim(), url].join('|');
    let host = '';
    try { host = new URL(url).hostname.toLocaleLowerCase(); } catch { /* URL 已由资源候选链路校验 */ }
    records[key] = {
      key,
      noteId,
      url,
      host,
      taskText: item.resource.taskText,
      knowledgeTitles: item.resource.knowledgeTitles,
      resourceType: item.resource.resourceType,
      searchCategory: item.resource.searchCategory,
      decision: item.decision,
      updatedAt,
    };
    return records;
  }, {});
  const entries = Object.values({ ...current.discoveryPreferences, ...additions })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, 500);
  const next: ResourceStateFile = {
    ...current,
    discoveryPreferences: Object.fromEntries(entries.map((item) => [item.key, item])),
  };
  await persistResourceState(next);
  return next;
}

export async function storeResourceHealth(result: ResourceHealthCheckResult): Promise<ResourceStateFile> {
  const current = getResourceStateSnapshot();
  const key = normalizeResourceUrl(result.url);
  const previous = current.health[key];
  const failed = result.status === 'broken' || result.status === 'temporary-error';
  const next: ResourceStateFile = {
    ...current,
    health: {
      ...current.health,
      [key]: {
        ...result,
        url: key,
        failureCount: failed ? (previous?.failureCount || 0) + 1 : 0,
      },
    },
  };
  await persistResourceState(next);
  return next;
}

export async function checkResourceHealth(url: string): Promise<ResourceHealthCheckResult> {
  const api = getElectronApi();
  if (!api?.checkResourceHealth) {
    return { url, status: 'temporary-error', checkedAt: new Date().toISOString(), error: '仅桌面版支持链接复核' };
  }
  return api.checkResourceHealth(url);
}
