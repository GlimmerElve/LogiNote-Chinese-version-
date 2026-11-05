import path from 'node:path';
import { extractResourceCoreTerm } from '../services/resourceSearchTerm';
export { extractResourceCoreTerm } from '../services/resourceSearchTerm';
import type { LocalFileType, ResourceAuthContainer, ResourceContentKind, ResourceSearchTab } from '../types';

export interface RawBrowserCandidate {
  title: string;
  url: string;
  contentType?: string;
  hintType?: string;
  downloadName?: string;
  description?: string;
  detectedFrom?: 'page' | 'link' | 'media' | 'metadata';
}

export interface NormalizedBrowserCandidate extends RawBrowserCandidate {
  platform: string;
  downloadable: boolean;
  fileType?: LocalFileType;
  resourceType: ResourceContentKind;
  isAttachment: boolean;
  indexable: boolean;
  fileExtension?: string;
}

const SEARCH_HOSTS = new Set([
  'www.bing.com',
  'bing.com',
  'cn.bing.com',
]);

const OPEN_RESOURCE_HOSTS = [
  'wikipedia.org',
  'wikibooks.org',
  'arxiv.org',
  'openstax.org',
  'ocw.mit.edu',
  'github.com',
  'developer.mozilla.org',
  'bilibili.com',
  'icourse163.org',
  'xuetangx.com',
  'youtube.com',
  'youtu.be',
];

const SENSITIVE_QUERY_KEY = /^(?:access_?token|auth|authorization|code|credential|jwt|key|password|session|signature|sig|state)$/iu;
const VIDEO_HOSTS = ['youtube.com', 'youtu.be', 'bilibili.com', 'vimeo.com', 'youku.com', 'coursera.org'];
const INDEXABLE_EXTENSIONS = new Set(['pdf', 'txt', 'md', 'markdown', 'docx', 'pptx']);
const STORABLE_EXTENSIONS = new Set([
  ...INDEXABLE_EXTENSIONS,
  'doc', 'ppt', 'xlsx', 'xls', 'epub',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg',
  'mp3', 'wav', 'ogg', 'm4a', 'flac',
  'mp4', 'webm', 'mkv', 'mov', 'avi',
  'zip', 'rar', '7z',
]);

/**
 * 登录容器只按完整 origin 复用，避免把一个子域的登录状态错误交给另一个子域。
 * URL 路径、查询参数和锚点不会影响匹配。
 */
export function findResourceAuthContainerForUrl(
  containers: ResourceAuthContainer[],
  rawUrl: string,
): ResourceAuthContainer | undefined {
  try {
    const url = new URL(String(rawUrl || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    return containers.find((container) => {
      try { return new URL(container.origin).origin === url.origin; } catch { return false; }
    });
  } catch {
    return undefined;
  }
}

function cleanContentType(value?: string): string | undefined {
  const cleaned = String(value || '').split(';')[0].trim().toLocaleLowerCase();
  return cleaned || undefined;
}

function candidateExtension(url: string, downloadName?: string): string {
  const source = String(downloadName || '').trim() || (() => {
    try { return decodeURIComponent(new URL(url).pathname); } catch { return ''; }
  })();
  return path.posix.extname(source).slice(1).toLocaleLowerCase();
}

export function classifyBrowserResource(input: RawBrowserCandidate): Pick<NormalizedBrowserCandidate,
  'downloadable' | 'indexable' | 'fileType' | 'fileExtension' | 'resourceType' | 'isAttachment' | 'contentType'> {
  const contentType = cleanContentType(input.contentType);
  const hint = String(input.hintType || '').toLocaleLowerCase();
  let hostname = '';
  try { hostname = new URL(input.url).hostname.toLocaleLowerCase(); } catch { /* invalid URL handled later */ }

  // HTML is a page (possibly a video landing page), never a downloadable PDF
  // merely because its URL or Content-Disposition claims a file extension.
  if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
    const videoPage = hint.includes('video') || VIDEO_HOSTS.some(host => hostname === host || hostname.endsWith(`.${host}`));
    const pageType = hint.includes('article') || contentType === 'application/xhtml+xml' ? 'article' : videoPage ? 'video' : 'webpage';
    return { contentType, resourceType: pageType,
      fileType: pageType === 'video' ? 'video' : 'html', fileExtension: undefined, isAttachment: false, indexable: false, downloadable: false };
  }

  const mimeExtension = (() => {
    if (contentType === 'application/pdf') return 'pdf';
    if (contentType === 'text/markdown') return 'md';
    if (contentType === 'text/plain') return 'txt';
    if (/presentationml/u.test(contentType || '')) return 'pptx';
    if (/ms-powerpoint/u.test(contentType || '')) return 'ppt';
    if (/wordprocessingml/u.test(contentType || '')) return 'docx';
    if (/msword/u.test(contentType || '')) return 'doc';
    if (/spreadsheetml/u.test(contentType || '')) return 'xlsx';
    if (contentType === 'video/mp4') return 'mp4';
    if (contentType === 'video/webm') return 'webm';
    if (contentType === 'audio/mpeg') return 'mp3';
    if (contentType === 'image/png') return 'png';
    if (contentType === 'image/jpeg') return 'jpg';
    if (contentType === 'application/zip') return 'zip';
    return '';
  })();
  const namedExtension = candidateExtension('', input.downloadName);
  const urlExtension = candidateExtension(input.url);
  const supportedName = [namedExtension, urlExtension].find(ext => STORABLE_EXTENSIONS.has(ext));
  const textName = [namedExtension, urlExtension].find(ext => ['txt', 'md', 'markdown', 'csv', 'json', 'log'].includes(ext));
  // Specific MIME beats a .do/.php route or misleading filename. Generic
  // binary responses can still use a supported disposition/URL extension;
  // retain textual .md/.markdown rather than converting them to .txt.
  const extension = mimeExtension === 'txt' && textName ? textName
    : mimeExtension === 'zip' && ['docx', 'pptx', 'xlsx', 'epub'].includes(supportedName || '') ? supportedName!
      : mimeExtension || supportedName || namedExtension || urlExtension;

  let resourceType: ResourceContentKind = 'webpage';
  let fileType: LocalFileType | undefined;
  if (extension === 'pdf' || contentType === 'application/pdf') {
    resourceType = 'pdf'; fileType = 'pdf';
  } else if (['ppt', 'pptx', 'odp', 'key'].includes(extension)
    || /presentation|powerpoint|opendocument\.presentation/u.test(contentType || '')
    || hint.includes('presentation')) {
    resourceType = 'presentation'; fileType = 'office';
  } else if (['doc', 'docx', 'odt', 'rtf', 'epub', 'xls', 'xlsx', 'ods', 'csv'].includes(extension)
    || /wordprocessingml|msword|spreadsheet|opendocument\.text|epub/u.test(contentType || '')
    || hint.includes('document')) {
    resourceType = 'document'; fileType = extension === 'csv' ? 'text' : 'office';
  } else if (['txt', 'md', 'markdown', 'json', 'log'].includes(extension)
    || contentType?.startsWith('text/plain') || contentType === 'text/markdown') {
    resourceType = 'document'; fileType = 'text';
  } else if (['vtt', 'srt', 'ass', 'ssa'].includes(extension) || contentType === 'text/vtt') {
    // Caption files hosted by a video platform are documents, not videos.
    resourceType = 'document'; fileType = 'text';
  } else if (['mp4', 'webm', 'mkv', 'mov', 'avi', 'm4v', 'm3u8'].includes(extension)
    || contentType?.startsWith('video/') || hint.includes('video')
    || VIDEO_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`))) {
    resourceType = 'video'; fileType = 'video';
  } else if (['mp3', 'wav', 'ogg', 'm4a', 'flac', 'aac'].includes(extension)
    || contentType?.startsWith('audio/') || hint.includes('audio')) {
    resourceType = 'audio'; fileType = 'audio';
  } else if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(extension)
    || contentType?.startsWith('image/') || hint.includes('image')) {
    resourceType = 'image'; fileType = 'image';
  } else if (['zip', 'rar', '7z', 'tar', 'gz'].includes(extension)
    || /zip|rar|compressed|tar/u.test(contentType || '')) {
    resourceType = 'archive'; fileType = 'other';
  } else if (hint.includes('article') || contentType === 'application/xhtml+xml') {
    resourceType = 'article'; fileType = 'html';
  } else if (contentType?.startsWith('text/html')) {
    resourceType = hint.includes('article') ? 'article' : 'webpage';
    fileType = 'html';
  }

  const fileExtension = extension || undefined;
  const isAttachment = Boolean(input.downloadName)
    || Boolean(extension && resourceType !== 'webpage' && resourceType !== 'article')
    || Boolean(mimeExtension)
    || ['pdf', 'presentation', 'archive'].includes(resourceType);
  const indexable = Boolean(fileExtension && INDEXABLE_EXTENSIONS.has(fileExtension));
  const downloadable = Boolean(fileExtension && STORABLE_EXTENSIONS.has(fileExtension));
  return { downloadable, indexable, fileType, fileExtension, resourceType, isAttachment, contentType };
}

/** 来源页只保留不含查询参数的公开地址，避免 OAuth code 或站点会话参数进入后续上下文。 */
export function sanitizeSourcePageUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(String(rawUrl || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return undefined;
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return undefined;
  }
}

type ResourceSearchInput = {
  projectTitle?: string;
  rootProjectTitle?: string;
  taskText: string;
  knowledgeTitles: string[];
  interactionMode?: 'review' | 'auto';
  semanticPlan?: import('../types').ResourceSemanticSearchPlan;
  automaticTargets?: Partial<Record<import('../types').ResourceSearchCategory, number>>;
};

/** 固定中文市场，避免 Bing 隔离会话的首次请求落入未初始化的通用市场。 */
export function buildBingSearchUrl(query: string): string {
  const params = new URLSearchParams({
    q: String(query || '').replace(/\s+/gu, ' ').trim(),
    mkt: 'zh-CN',
    cc: 'CN',
    setlang: 'zh-Hans',
  });
  return `https://cn.bing.com/search?${params.toString()}`;
}

export interface BingSearchSnapshot {
  url: string;
  input: string;
  resultText: string;
  resultCount: number;
  emptyResults: boolean;
}

/** The address/search box alone can be correct while a fresh anonymous Bing
 * response contains results for another topic. Check actual organic results,
 * never navigation/suggestions/the query reflected in the page heading. */
export function isExpectedBingSearch(snapshot: BingSearchSnapshot, query: string, coreTerm = ''): boolean {
  const normalized = (text: string) => text.normalize('NFKC').replace(/\s+/gu, ' ').trim().toLocaleLowerCase();
  let url: URL;
  try { url = new URL(snapshot.url); } catch { return false; }
  if (!['http:', 'https:'].includes(url.protocol) || !/(?:^|\.)bing\.com$/u.test(url.hostname) || url.pathname !== '/search') return false;
  if (normalized(url.searchParams.get('q') || '') !== normalized(query) || normalized(snapshot.input) !== normalized(query)) return false;
  if (snapshot.emptyResults && snapshot.resultCount === 0) return true;
  if (snapshot.resultCount === 0) return false;
  const compact = (text: string) => normalized(text).replace(/[\s\p{P}]+/gu, '').replace(/帐/gu, '账');
  return !coreTerm || compact(snapshot.resultText).includes(compact(coreTerm));
}

/**
 * 资源检索固定使用“当前项目核心词 + 根项目领域词”。任务原文通常含有
 * “学习/解释/完成”等动作和长描述，不再进入查询；知识点只作为当前标题
 * 无法提取实体时的兜底。
 */
export function buildResourceSearchSubject(input: ResourceSearchInput): string {
  const knowledgeTerms = input.knowledgeTitles.map((value) => String(value || '')
    .normalize('NFKC')
    .replace(/\[\[([^\]]+)\]\]/gu, '$1')
    .split(/\s*[：:—–｜|\n（(]\s*/u)[0]
    .replace(/^[\s《》「」“”"'，,、;；.。\-—–]+|[\s《》「」“”"'，,、;；.。\-—–]+$/gu, '')
    .replace(/\s+/gu, ' ')
    .trim())
    .filter(Boolean)
    .map((term) => [...term].slice(0, 36).join(''));
  const fallbackKnowledge = knowledgeTerms[0] || '';
  const extractedCurrent = extractResourceCoreTerm(input.projectTitle || '');
  // 项目标题始终优先；知识点只能在项目标题无法提取时兜底，不能把“学习…”模板加回来。
  const currentTerm = extractedCurrent || fallbackKnowledge;
  const rootTerm = extractResourceCoreTerm(input.rootProjectTitle || '');
  const comparableCurrent = currentTerm.replace(/\s+/gu, '').toLocaleLowerCase();
  const comparableRoot = rootTerm.replace(/\s+/gu, '').toLocaleLowerCase();
  const includeRoot = Boolean(rootTerm)
    && comparableRoot !== comparableCurrent
    && !comparableCurrent.includes(comparableRoot);
  return [currentTerm, includeRoot ? rootTerm : ''].filter(Boolean).join(' ').trim() || '学习资源';
}

export function buildResourceSearchTabs(input: ResourceSearchInput): ResourceSearchTab[] {
  if (input.interactionMode === 'auto' && input.semanticPlan) return input.semanticPlan.lanes.map(lane => {
    const variants = lane.queries.map((query, index) => ({ id: `${lane.category}-semantic-${index}`, label: query, query, searchPageUrl: buildBingSearchUrl(query) }));
    return { id: lane.category, label: lane.category, description: lane.reason, automaticTarget: input.automaticTargets?.[lane.category] || 2,
      query: variants[0].query, searchPageUrl: variants[0].searchPageUrl, currentUrl: variants[0].searchPageUrl,
      candidateCount: 0, loaded: false, activeVariantId: variants[0].id, variants };
  });
  const subject = buildResourceSearchSubject(input);
  const definitions: Array<{
    id: ResourceSearchTab['id']; label: string; description: string; automaticTarget: number;
    terms: Array<{ id: string; label: string }>;
  }> = [
    { id: 'encyclopedia', label: '百科与概念', description: '详细定义、原理、介绍与边界', automaticTarget: 2, terms: [
      { id: 'concept', label: '概念' }, { id: 'definition', label: '定义' }, { id: 'encyclopedia', label: '百科' }, { id: 'introduction', label: '介绍' },
    ] },
    { id: 'video', label: '视频介绍', description: '优先 Bilibili、MOOC 与公开课', automaticTarget: 3, terms: [
      { id: 'bilibili', label: 'bilibili' }, { id: 'mooc', label: 'MOOC' }, { id: 'opencourse', label: 'opencourse' }, { id: 'open-class', label: '公开课' },
    ] },
    { id: 'materials', label: '资料与教材', description: 'PDF、PPT、教材与课程讲义', automaticTarget: 2, terms: [
      { id: 'pdf', label: 'PDF' }, { id: 'ppt', label: 'PPT' }, { id: 'textbook', label: '教材' }, { id: 'handout', label: '讲义' },
    ] },
    { id: 'practice', label: '实践与案例', description: '实验、应用案例与相关论文', automaticTarget: 2, terms: [
      { id: 'case', label: '案例' }, { id: 'experiment', label: '实验' }, { id: 'paper', label: '论文' }, { id: 'application', label: '应用' },
    ] },
  ];
  if (input.interactionMode === 'auto') {
    definitions.find(item => item.id === 'practice')!.description = '具体实践、实验与应用案例';
    definitions.find(item => item.id === 'practice')!.terms = [
      { id: 'case', label: '案例' }, { id: 'experiment', label: '实验' }, { id: 'tutorial', label: '实战' }, { id: 'application', label: '应用' },
    ];
    definitions.push({ id: 'paper', label: '论文与研究', description: '论文原页、摘要与公开研究', automaticTarget: 1, terms: [
      { id: 'paper', label: '论文' }, { id: 'research', label: 'research paper' }, { id: 'journal', label: '期刊' }, { id: 'arxiv', label: 'arxiv' },
    ] });
  }
  return definitions.map(({ terms, ...definition }) => {
    const variants = terms.map((term) => {
      const intent = input.interactionMode === 'auto' && definition.id === 'materials'
        ? term.id === 'pdf' ? 'filetype:pdf' : term.id === 'ppt' ? 'filetype:pptx' : term.label : term.label;
      const query = `${subject} ${intent}`.replace(/\s+/gu, ' ').trim().slice(0, 120);
      return {
        id: `${definition.id}-${term.id}`,
        label: term.label,
        query,
        searchPageUrl: buildBingSearchUrl(query),
      };
    });
    const initial = variants[0];
    return {
      ...definition,
      query: initial.query,
      searchPageUrl: initial.searchPageUrl,
      currentUrl: initial.searchPageUrl,
      candidateCount: 0,
      loaded: false,
      activeVariantId: initial.id,
      variants,
    };
  });
}

/** 保留单查询入口给旧调用方；新资源工作台使用 buildResourceSearchTabs。 */
export function buildResourceSearchQuery(input: ResourceSearchInput): string {
  return buildResourceSearchTabs(input)[0].query;
}

function normalizeConceptComparable(value: string): string {
  return String(value || '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}+#=<>]+/gu, '');
}

function normalizeConceptSearchTerm(value: unknown): string {
  return String(value || '')
    .normalize('NFKC')
    .replace(/["“”]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 120);
}

function uniqueConceptTerms(rawTerm: string, rawAliases: string[] = []): string[] {
  const seen = new Set<string>();
  return [rawTerm, ...rawAliases]
    .map(normalizeConceptSearchTerm)
    .filter((term) => {
      const key = normalizeConceptComparable(term);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

/**
 * 概念补全使用精确词组查询。普通资源搜索允许宽召回，但概念定义不能把
 * “超限效应”拆成“超 / 限 / 效应”后再用无关页面拼接。
 */
export function buildConceptSearchQueries(rawTerm: string, rawAliases: string[] = []): string[] {
  const [term, ...aliases] = uniqueConceptTerms(rawTerm, rawAliases);
  if (!term) return [];
  return [
    `"${term}" 定义 原理`,
    `"${term}" 概念 机制`,
    `"${term}" 案例 应用`,
    ...aliases.slice(0, 3).map((alias) => `"${alias}" 定义 原理`),
  ];
}

/**
 * 返回页面对目标概念的词面相关度。0 是硬拒绝：页面标题或正文至少需要
 * 出现完整概念词组，避免仅命中单字、同前缀产品名或搜索引擎联想词。
 */
export function conceptEvidenceRelevanceScore(
  rawTerm: string,
  rawTitle: string,
  rawText: string,
  rawAliases: string[] = [],
): number {
  const targets = uniqueConceptTerms(rawTerm, rawAliases).map(normalizeConceptComparable);
  if (targets.length === 0) return 0;
  const title = normalizeConceptComparable(rawTitle);
  const text = normalizeConceptComparable(rawText);
  let best = 0;
  targets.forEach((target, index) => {
    const titleMatch = title.includes(target);
    const textMatch = text.includes(target);
    if (!titleMatch && !textMatch) return;
    // 规范标题始终优先；别名只补充召回，不覆盖主术语证据的排序。
    const aliasPenalty = index === 0 ? 0 : 8;
    let score = (titleMatch ? 32 : 0) + (textMatch ? 18 : 0) - aliasPenalty;
    if (textMatch) {
      const occurrences = text.split(target).length - 1;
      score += Math.min(10, Math.max(0, occurrences - 1) * 2);
    }
    best = Math.max(best, score);
  });
  return best;
}

function findRawConceptIndex(text: string, rawTerms: string[]): number {
  const comparableText = text.normalize('NFKC').toLocaleLowerCase();
  let best = -1;
  for (const rawTerm of rawTerms) {
    const index = comparableText.indexOf(rawTerm.normalize('NFKC').toLocaleLowerCase());
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  return best;
}

const CONCEPT_PAGE_BOILERPLATE = /(?:cookie|隐私政策|用户协议|版权所有|copyright|ICP备|登录|注册|扫码|客户端(?:下载)?|相关阅读|相关推荐|热门推荐|返回首页|分享(?:到|至)|打印本页|关闭窗口)/iu;
const CONCEPT_EXPLANATION_CUE = /(?:定义|是指|指的是|含义|原理|机制|特征|特点|表现|示例|案例|应用|边界|区别|definition|means|mechanism|example|application)/iu;

/**
 * 把网页语义块压缩成概念证据：只围绕完整术语命中块取上下文，清除样板
 * 文本并去重。输入仍是不可信网页数据，输出只做文本清洗。
 */
export function cleanConceptEvidenceText(
  rawTerm: string,
  input: { description?: string; blocks?: string[] },
  maxChars = 2200,
  rawAliases: string[] = [],
): string {
  const rawTerms = uniqueConceptTerms(rawTerm, rawAliases);
  const targets = rawTerms.map(normalizeConceptComparable);
  const limit = Math.max(400, Math.min(6000, Math.floor(maxChars) || 2200));
  if (targets.length === 0) return '';
  const rawBlocks = [input.description || '', ...(Array.isArray(input.blocks) ? input.blocks : [])];
  const seen = new Set<string>();
  const blocks = rawBlocks.flatMap((value, sourceIndex) => {
    let text = String(value || '').replace(/\s+/gu, ' ').trim();
    if (text.length < 18) return [];
    const normalized = normalizeConceptComparable(text);
    const containsTerm = targets.some((target) => normalized.includes(target));
    if (!containsTerm && CONCEPT_PAGE_BOILERPLATE.test(text)) return [];
    if (seen.has(normalized)) return [];
    seen.add(normalized);
    if (text.length > 1000) {
      const index = findRawConceptIndex(text, rawTerms);
      const start = index > 220 ? index - 220 : 0;
      text = text.slice(start, start + 1000).trim();
    }
    return [{ text, containsTerm, sourceIndex, cue: CONCEPT_EXPLANATION_CUE.test(text) }];
  });
  const hitIndexes = blocks
    .map((block, index) => block.containsTerm ? index : -1)
    .filter((index) => index >= 0)
    .slice(0, 8);
  if (hitIndexes.length === 0) return '';

  const priority: number[] = [];
  const queued = new Set<number>();
  const queue = (index: number) => {
    if (index < 0 || index >= blocks.length || queued.has(index)) return;
    queued.add(index);
    priority.push(index);
  };
  [...hitIndexes]
    .sort((a, b) => Number(blocks[b].cue) - Number(blocks[a].cue) || blocks[a].sourceIndex - blocks[b].sourceIndex)
    .forEach(queue);
  hitIndexes.forEach((index) => {
    queue(index - 1);
    queue(index + 1);
    queue(index + 2);
  });

  const selected: Array<{ sourceIndex: number; text: string }> = [];
  let used = 0;
  for (const index of priority) {
    const block = blocks[index];
    const remaining = limit - used;
    if (remaining < 80) break;
    const text = block.text.slice(0, remaining);
    selected.push({ sourceIndex: block.sourceIndex, text });
    used += text.length + 1;
  }
  return selected
    .sort((a, b) => a.sourceIndex - b.sourceIndex)
    .map((item) => item.text)
    .join('\n')
    .slice(0, limit)
    .trim();
}

export function classifyDownload(url: string): { downloadable: boolean; fileType?: 'pdf' | 'txt' | 'md' } {
  const extension = candidateExtension(url);
  if (extension === 'pdf') return { downloadable: true, fileType: 'pdf' };
  if (extension === 'txt') return { downloadable: true, fileType: 'txt' };
  if (extension === 'md' || extension === 'markdown') return { downloadable: true, fileType: 'md' };
  return { downloadable: false };
}

/** Unknown hosts are not proof of a paywall. Keep unknown distinct from paid. */
export function inferResourceIsFree(url: string, downloadable: boolean): boolean | undefined {
  if (downloadable) return true;
  try {
    const host = new URL(url).hostname.toLocaleLowerCase();
    return OPEN_RESOURCE_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`)) ? true : undefined;
  } catch {
    return false;
  }
}

export function normalizeBrowserCandidates(
  candidates: RawBrowserCandidate[],
  maxResults = 12,
): NormalizedBrowserCandidate[] {
  const byUrl = new Map<string, NormalizedBrowserCandidate & { order: number }>();
  for (const [order, raw] of candidates.slice(0, 240).entries()) {
    try {
      const url = new URL(String(raw.url || '').trim());
      if (!['http:', 'https:'].includes(url.protocol)) continue;
      if (url.username || url.password || SEARCH_HOSTS.has(url.hostname.toLocaleLowerCase())) continue;
      if ([...url.searchParams.keys()].some((key) => SENSITIVE_QUERY_KEY.test(key))) continue;
      url.hash = '';
      const title = String(raw.title || '').replace(/\s+/gu, ' ').trim().slice(0, 200);
      if (!title) continue;
      const normalizedUrl = url.toString();
      const classified = classifyBrowserResource({ ...raw, url: normalizedUrl });
      const candidate = {
        title,
        url: normalizedUrl,
        platform: url.hostname.replace(/^www\./iu, ''),
        contentType: classified.contentType,
        hintType: String(raw.hintType || '').slice(0, 40) || undefined,
        downloadName: String(raw.downloadName || '').slice(0, 200) || undefined,
        description: String(raw.description || '').replace(/\s+/gu, ' ').trim().slice(0, 320) || undefined,
        detectedFrom: raw.detectedFrom,
        ...classified,
        order,
      } satisfies NormalizedBrowserCandidate & { order: number };
      const previous = byUrl.get(normalizedUrl);
      if (!previous || resourcePriority(candidate) > resourcePriority(previous)) byUrl.set(normalizedUrl, candidate);
    } catch { /* ignore malformed candidates */ }
  }
  return [...byUrl.values()]
    .sort((a, b) => resourcePriority(b) - resourcePriority(a) || a.order - b.order)
    .slice(0, Math.max(1, Math.min(20, maxResults)))
    .map(({ order: _order, ...candidate }) => candidate);
}

function resourcePriority(candidate: Pick<NormalizedBrowserCandidate, 'resourceType' | 'isAttachment'>): number {
  const priorities: Record<ResourceContentKind, number> = {
    pdf: 100,
    presentation: 95,
    document: 90,
    video: 80,
    audio: 75,
    archive: 70,
    image: 60,
    article: 50,
    webpage: 20,
    other: 10,
  };
  return priorities[candidate.resourceType] + (candidate.isAttachment ? 5 : 0);
}

export function safeDownloadFileName(title: string, url: string, fileType: 'pdf' | 'txt' | 'md'): string {
  return safeAttachmentFileName(title, url, undefined, fileType);
}

export function safeAttachmentFileName(
  title: string,
  url: string,
  suggestedFileName: string | undefined,
  fallbackExtension: string,
): string {
  const fromUrl = (() => {
    try { return decodeURIComponent(path.posix.basename(new URL(url).pathname)); } catch { return ''; }
  })();
  const safeExtension = String(fallbackExtension || 'bin').replace(/[^a-z0-9]/giu, '').toLocaleLowerCase().slice(0, 12) || 'bin';
  const expectedExt = `.${safeExtension}`;
  const suggested = String(suggestedFileName || '').trim();
  const sourceName = suggested || (path.posix.extname(fromUrl) ? fromUrl : title);
  const base = (sourceName || `resource${expectedExt}`)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_')
    .trim()
    .slice(0, 160);
  const actualExt = path.posix.extname(base);
  if (actualExt.toLocaleLowerCase() === expectedExt) return base;
  return `${(actualExt ? base.slice(0, -actualExt.length) : base) || 'resource'}${expectedExt}`;
}
