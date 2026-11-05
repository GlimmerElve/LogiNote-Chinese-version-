import type { NoteItem, ResourceFormatPreference, ResourceItem, ResourceSearchCategory } from '../types';
import type { ResourceStateFile } from './resourceState';
export const RESOURCE_SEMANTIC_MIN_SCORE = 0.55;

export const RESOURCE_CATEGORY_LABELS: Record<ResourceSearchCategory, string> = {
  encyclopedia: '概念解释', video: '视频', practice: '实践案例', paper: '论文', materials: '下载资料',
};
export const AUTOMATIC_RESOURCE_TARGETS: Record<ResourceSearchCategory, number> = {
  encyclopedia: 2, video: 3, practice: 2, paper: 1, materials: 2,
};
export const RESOURCE_FORMAT_PREFERENCES: Record<ResourceFormatPreference, string> = {
  adaptive: '跟随主动选择与使用反馈', video: '偏好视频', reading: '偏好图文解释', practice: '偏好实践案例', paper: '偏好论文',
};
export function normalizeResourceFormatPreference(value: unknown): ResourceFormatPreference {
  return typeof value === 'string' && Object.hasOwn(RESOURCE_FORMAT_PREFERENCES, value) ? value as ResourceFormatPreference : 'adaptive';
}

/** Fixed ten-item budget: eight online learning resources plus two download slots.
 * Only explicit choices/feedback influence the mix; automatic writes never train it. */
export function buildAutomaticResourcePlan(state: ResourceStateFile, preference: unknown = 'adaptive', notes: NoteItem[] = []) {
  const categories = ['encyclopedia', 'video', 'practice', 'paper'] as const;
  const targets = { ...AUTOMATIC_RESOURCE_TARGETS };
  const selected = normalizeResourceFormatPreference(preference);
  const explicit = selected === 'reading' ? 'encyclopedia' : selected;
  if (explicit !== 'adaptive') {
    categories.forEach(category => { targets[category] = category === explicit ? 5 : 1; });
  } else {
    const scores = new Map<ResourceSearchCategory, number>();
    const known = new Map<string, Pick<ResourceItem, 'url' | 'resourceType' | 'searchCategory'>>();
    for (const note of notes) for (const resource of note.resources || []) known.set(resourceIdentity(resource), resource);
    const choices = Object.values(state.discoveryPreferences);
    for (const choice of choices) known.set(resourceIdentity(choice), choice);
    const add = (category: ResourceSearchCategory | undefined, value: number) => {
      if (category && categories.includes(category as typeof categories[number])) scores.set(category, (scores.get(category) || 0) + value);
    };
    choices.forEach(choice => add(choice.searchCategory || (choice.resourceType === 'video' ? 'video' : undefined), choice.decision === 'selected' ? 1 : -1));
    Object.values(state.feedback).forEach(feedback => {
      const resource = known.get(resourceIdentity(feedback));
      add(feedback.searchCategory || resource?.searchCategory || (feedback.resourceType === 'video' || resource?.resourceType === 'video' ? 'video' : undefined),
        feedback.rating === 'completed' ? 3 : feedback.rating === 'helpful' ? 2 : -2);
    });
    // Shift at most two slots to a supported preference, preserving every online category.
    const strongest = categories.map(category => ({ category, score: scores.get(category) || 0 })).sort((a, b) => b.score - a.score);
    if (strongest[0].score >= 2 && strongest[0].score > strongest[1].score) {
      const winner = strongest[0].category;
      const shifts = Math.min(2, Math.floor((strongest[0].score - strongest[1].score) / 2));
      for (let i = 0; i < shifts; i++) {
        const donor = categories.filter(category => category !== winner && targets[category] > 1)
          .sort((a, b) => (scores.get(a) || 0) - (scores.get(b) || 0) || targets[b] - targets[a])[0];
        if (!donor) break;
        targets[donor]--; targets[winner]++;
      }
    }
  }
  return { targets, preference: selected, total: 10, downloadTarget: 2,
    summary: Object.entries(targets).map(([category, count]) => `${RESOURCE_CATEGORY_LABELS[category as ResourceSearchCategory]} ${count}`).join('、') };
}

/** Canonical source identity also recognizes a paper's abstract/PDF pair. */
export function resourceIdentity(resource: { url: string; sourceUrl?: string }): string {
  try {
    const url = new URL(resource.sourceUrl || resource.url); url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(?:spm|fbclid|gclid)$/iu.test(key)) url.searchParams.delete(key);
    if (/(?:^|\.)(?:youtube\.com|youtu\.be)$/u.test(url.hostname)) {
      const videoId = url.hostname === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') || /^\/(?:embed|shorts)\/([^/]+)/u.exec(url.pathname)?.[1];
      if (videoId) return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
    }
    if (/(?:^|\.)arxiv\.org$/u.test(url.hostname)) url.pathname = url.pathname.replace(/^\/(?:abs|pdf|html)\//u, '/paper/').replace(/\.pdf$/u, '').replace(/v\d+$/u, '');
    return url.toString();
  } catch { return resource.sourceUrl || resource.url; }
}

export function isDownloadableLearningResource(resource: ResourceItem): boolean {
  return resource.accessType === 'public' && resource.downloadable === true && resource.isFree !== false
    && ['pdf', 'presentation', 'document'].includes(resource.resourceType || '');
}

/** Search lane alone is not evidence that an article is a video or a paper. */
export function automaticResourceIntentIssue(resource: ResourceItem): string | undefined {
  const text = `${resource.title} ${resource.description || ''}`.split(/相关推荐|相关视频|猜你喜欢|related videos/iu)[0];
  let url: URL; try { url = new URL(resource.url); } catch { return '资源地址无效'; }
  const video = resource.resourceType === 'video' || /视频|录像|录播|公开课|课程回放|\bvideo\b|\brecorded lecture\b|\blecture recording\b/iu.test(text);
  const paper = /(?:^|\.)(?:arxiv\.org|doi\.org|pubmed\.ncbi\.nlm\.nih\.gov|pmc\.ncbi\.nlm\.nih\.gov|openreview\.net|aclanthology\.org)$/u.test(url.hostname)
    || /\/(?:doi|article|articles)\/(?:abs|abstract|10\.)/iu.test(url.pathname)
    || /论文|研究报告|期刊|文献|\babstract\b|\bjournal\b|\bresearch paper\b|\bproceedings\b/iu.test(text);
  if (resource.searchCategory === 'paper' && (/笔记|解读|导读|摘录|论文清单|论文推荐|论文合集|reading list/iu.test(resource.title)
    || (/(?:^|\.)(?:github\.com|githubusercontent\.com)$/u.test(url.hostname) && resource.resourceType !== 'pdf')
    || /\/(?:blogs?|posts?)\//iu.test(url.pathname))) return '阅读笔记、解读和引用清单不能冒充论文原页';
  if (resource.semanticReview?.version === 1 && resource.semanticReview.score >= RESOURCE_SEMANTIC_MIN_SCORE) {
    if (resource.searchCategory === 'video' && resource.resourceType !== 'video') return '未核验为真实视频页面；字幕、PDF和代码说明不占视频名额';
    if (resource.searchCategory === 'paper' && resource.resourceType === 'video') return '论文讲解视频不占用论文原文名额';
    return undefined;
  }
  if (resource.searchCategory === 'video' && !video) return '未取得实际视频或课程线索';
  if (resource.searchCategory === 'paper' && !paper) return '未取得论文、期刊或学术来源线索';
  if (resource.searchCategory === 'paper' && video) return '论文讲解视频不占用论文原文名额';
  if (resource.searchCategory === 'paper' && /论文推荐|论文合集|论文清单|文献列表|论文解读|论文导读|papers? to read|reading list/iu.test(resource.title)) return '论文清单或解读不能代替论文原页';
  if (resource.searchCategory === 'practice' && !/案例|实验|实战|实践|示例|应用|\bcase stud|\bexperiment|\bworked example|\btutorial\b/iu.test(text)) return '未取得具体案例或实践线索';
  if (resource.searchCategory === 'encyclopedia' && (video || paper)) return '视频或论文不占用概念解释名额';
  if (resource.searchCategory === 'materials' && !isDownloadableLearningResource(resource)
    && (video || !/教材|讲义|课件|课程笔记|\btextbook\b|\blecture notes\b|\bhandout\b|\bslides\b/iu.test(text))) return '未取得可下载资料或教材讲义线索';
  return undefined;
}

export function summarizeResourceMix(resources: ResourceItem[]) {
  return Object.keys(AUTOMATIC_RESOURCE_TARGETS).map(category => {
    const count = resources.filter(resource => resource.searchCategory === category).length;
    return `${RESOURCE_CATEGORY_LABELS[category as ResourceSearchCategory]} ${count}`;
  }).join('、');
}
