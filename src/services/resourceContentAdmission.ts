import type { ResourceItem } from '../types';
import { extractResourceCoreTerm } from './resourceSearchTerm';
import { RESOURCE_SEMANTIC_MIN_SCORE } from './resourceCuration';

const compact = (text: string) => text.normalize('NFKC').replace(/[\s\p{P}]+/gu, '').replace(/帐/gu, '账').toLocaleLowerCase();
export function resourceTopicTerms(input: { projectTitle?: string; knowledgeTitles?: string[] }): string[] {
  return [...new Set([extractResourceCoreTerm(input.projectTitle || ''),
    ...(input.knowledgeTitles || []).flatMap(item => [item, ...item.split(/[：:（()）｜|、]/u)]),
  ].map(compact).filter(term => term.length >= 2))];
}

/** Automatic recommendations only. A trusted host proves willingness to visit,
 * not that every search hit is a lesson. Manual collection stays unrestricted. */
export function automaticResourceContentIssue(resource: Pick<ResourceItem, 'title' | 'url' | 'description' | 'resourceType' | 'searchCategory' | 'semanticReview'>,
  input: { projectTitle?: string; knowledgeTitles?: string[] }): string | undefined {
  const terms = resourceTopicTerms(input);
  if (!terms.length) return undefined;
  const title = String(resource.title || '');
  const titleMatch = terms.some(term => compact(title).includes(term));
  let pathname = '';
  try { pathname = new URL(resource.url).pathname; } catch { /* access validation handles invalid URLs */ }
  const productLanding = (!titleMatch && /音视频.*(?:搜得到|用得好)|(?:AI|GPT).{0,30}(?:总结|转写|摘要|搜得到).{0,12}(?:工具|助手|平台)|(?:视频|音频|音视频)(?:总结|转写|摘要)(?:工具|助手|平台)/iu.test(title))
    || (/\/(?:desktop|apps?|tools?|download)(?:\/|$)/iu.test(pathname) && /GPT|\bAI\b|客户端|下载|转写|总结工具/iu.test(title));
  if (productLanding) return '工具或产品入口页，不是直接学习内容；仍可人工添加';
  if (/站内搜索|搜索结果|搜索列表|标签列表|资源导航|下载中心/u.test(title)
    || (!titleMatch && /\/(?:search|volumn|issues?|toc)(?:\/|[_\.]|$)/iu.test(pathname))) {
    return '搜索、导航或期刊目录页，不作为具体学习内容自动推荐';
  }
  // Search snippets can contain sidebar recommendations and comments unrelated
  // to the actual title. Never use those trailing words to prove relevance.
  const description = String(resource.description || '').split(/相关推荐|相关视频|推荐视频|猜你喜欢|广告位招租|热门评论|为你推荐|related videos|recommended for you/iu)[0];
  const semanticallyReviewed = resource.semanticReview?.version === 1 && resource.semanticReview.score >= RESOURCE_SEMANTIC_MIN_SCORE;
  if (!semanticallyReviewed && !titleMatch && !terms.some(term => compact(description).includes(term))) return '标题与摘要未命中项目主题或知识点';
  if (resource.searchCategory === 'video' && resource.resourceType !== 'video'
    && (resource.resourceType === 'article' || /\/(?:articles?|info|posts?|news|wiki|item)(?:\/|\.php)/iu.test(pathname))
    && !/视频|录像|录播|公开课|课程回放|video|lecture/iu.test(`${title} ${description}`)) {
    return '该结果是文章页，未取得视频线索，不占用视频类自动推荐名额';
  }
  if (!semanticallyReviewed && !titleMatch && (resource.searchCategory === 'video' || resource.resourceType === 'video')) {
    const lead = description.slice(0, 180);
    const explicitLesson = /(?:本期|本视频|本课程|本节|本讲|这期视频|this (?:video|lesson|course))/iu.test(lead)
      && terms.some(term => compact(lead).includes(term));
    if (!explicitLesson) return '视频标题未命中主题，摘要也未明确说明本视频讲授该主题';
  }
  return undefined;
}
