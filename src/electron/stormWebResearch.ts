import { webAcquisition, WebApiError } from './webAcquisition';
import { attemptWebApi } from './webApiFallback';
import { inferWebEvidenceKind } from '../services/webEvidenceKind';
import { validateStormResearch, stormPublicationDate, type StormResearchBundle, type StormResearchSource } from '../services/stormResearch';
import { cleanConceptEvidenceText } from './resourceBrowserCore';
import type { ConceptSourceEvidence } from '../types';

export function stormSearchQueries(subject: string, now = new Date()): string[] {
  const term = [...subject.replace(/\s+/gu, ' ').trim()].slice(0, 70).join('');
  const year = now.getFullYear();
  return [`${term} ${year} 最新进展 official report`, `${term} ${year - 1} ${year} research paper systematic review`,
    `${term} research limitations contradictory evidence`];
}

type Browser = (subject: string, queries: string[], signal?: AbortSignal) => Promise<ConceptSourceEvidence[]>;
/** Queries go to public search; never send notes, project state or private RAG. */
export async function researchStormWeb(subject: string, browser: Browser, signal?: AbortSignal, api = webAcquisition,
  now = new Date()): Promise<StormResearchBundle> {
  if (typeof subject !== 'string' || !subject.trim() || subject.length > 500) throw new Error('研究主题需为 1～500 字符');
  signal?.throwIfAborted();
  const queries = stormSearchQueries(subject, now), warnings: string[] = [];
  const sources: StormResearchSource[] = [];
  const seen = new Set<string>(), hosts = new Map<string, number>();
  const add = (title: string, url: string, content: string, publishedAt?: string) => {
    const cleaned = content.replace(/\u0000/gu, '').trim();
    const excerpt = cleanConceptEvidenceText(subject, { blocks: cleaned.split(/\n+/u) }, 2200) || cleaned.slice(0, 2200);
    const host = new URL(url).hostname;
    if (seen.has(url) || (hosts.get(host) || 0) >= 2 || excerpt.length < 100
      || /^(?:#\s*)?(?:登录|验证码|安全验证|access denied|just a moment|sign in)(?:\s|$|[：:])/iu.test(excerpt)) return;
    seen.add(url); hosts.set(host, (hosts.get(host) || 0) + 1);
    sources.push({ id: `S${sources.length + 1}`, title: title.slice(0, 300), url, excerpt,
      coverage: inferWebEvidenceKind(url, excerpt) === 'abstract' ? 'abstract' : 'page-excerpt', publishedAt: stormPublicationDate(publishedAt) });
  };
  const attempt = await attemptWebApi(async abort => {
    let reads = 0;
    for (const query of queries) {
      const before = sources.length;
      const hits = await api.search(query, 'storm-multi-perspective', { count: 6, needContent: true, signal: abort });
      if (hits === null) return null;
      for (const hit of hits) {
        abort.throwIfAborted();
        if (sources.length >= 6 || sources.length >= before + 2) break;
        if (seen.has(hit.url)) continue;
        let body = hit.content;
        if (!body) {
          if (reads >= 6) continue;
          reads++;
          try {
            const page = await api.fetchPage(hit.url, 'storm-multi-perspective', abort);
            if (page === null) return null;
            body = page.content;
          } catch (error) {
            abort.throwIfAborted();
            if (error instanceof WebApiError && [403, 404].includes(error.status)) { warnings.push('部分网页未取得正文，已跳过'); continue; }
            throw error;
          }
        }
        abort.throwIfAborted();
        add(hit.title, hit.url, body, hit.publishedAt); // Search snippets are never treated as page text.
      }
    }
    return true;
  }, { signal, timeoutMs: 45_000 });
  signal?.throwIfAborted();
  if (attempt.value === null) {
    warnings.push(attempt.fallbackReason === 'transient' ? '搜索 API 暂时不可用，使用隔离网页检索' : '当前供应商未提供适配的搜索 API，使用隔离网页检索');
    // Do not duplicate half-finished API results or mix routes after timeout.
    sources.length = 0; seen.clear(); hosts.clear();
    const pages = await browser(subject, queries, signal);
    signal?.throwIfAborted();
    for (const page of pages.slice(0, 6)) add(page.title, page.url!, page.snippet, page.publishedAt);
  }
  if (!sources.length) throw new Error('联网检索未取得可读证据，STORM 已暂停；请检查网络后继续，未生成纯模型研究报告');
  return validateStormResearch({ subject, retrievedAt: now.toISOString(), queries, sources,
    warnings: [...new Set([...warnings, '页面发表日期及同行评审状态需逐条核对，检索年份不代表文献年份'])] }, subject);
}
