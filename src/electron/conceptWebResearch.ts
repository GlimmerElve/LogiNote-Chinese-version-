import type { ConceptSourceEvidence } from '../types';
import { buildConceptSearchQueries, cleanConceptEvidenceText, conceptEvidenceRelevanceScore } from './resourceBrowserCore';
import { webAcquisition, WebApiError } from './webAcquisition';
import { inferWebEvidenceKind } from '../services/webEvidenceKind';
import { attemptWebApi } from './webApiFallback';

/** Whole-concept fallback uses the browser-only path, never recursively retries
 * Search API. Empty/irrelevant/blocked results are not transient failures. */
export async function searchConceptEvidence(term: string, aliases: string[],
  browser: (term: string, aliases: string[]) => Promise<ConceptSourceEvidence[]>, api = webAcquisition, signal?: AbortSignal) {
  const attempt = await attemptWebApi(abort => searchConceptEvidenceWithApi(term, aliases, api, abort), { signal, timeoutMs: 15_000 });
  signal?.throwIfAborted();
  const evidence = attempt.value ?? await browser(term, aliases);
  signal?.throwIfAborted();
  return evidence;
}

/** null alone means unsupported; empty/blocked results never masquerade as capability failure. */
export async function searchConceptEvidenceWithApi(term: string, aliases: string[] = [], api = webAcquisition, signal?: AbortSignal): Promise<ConceptSourceEvidence[] | null> {
  signal?.throwIfAborted();
  const title = String(term || '').replace(/\s+/gu, ' ').trim().slice(0, 120);
  if (!title) throw new Error('概念标题不能为空');
  const names = [...new Set(aliases.filter(a => typeof a === 'string').map(a => a.trim().slice(0, 120)).filter(Boolean))].slice(0, 3);
  const evidence: ConceptSourceEvidence[] = [], seen = new Set<string>(), hosts = new Set<string>();
  let fetches = 0;
  const queries = buildConceptSearchQueries(title, names);
  const plans = [queries[0], ...(names.length ? queries.slice(3, 4) : queries.slice(1, 2))];
  for (const query of plans) {
    const hits = await api.search(query, 'concept-generation', { count: 10, needContent: true, signal });
    if (hits === null) return null;
    for (const hit of hits) {
      if (evidence.length >= 4) break;
      const host = new URL(hit.url).hostname;
      if (seen.has(hit.url) || hosts.has(host) || conceptEvidenceRelevanceScore(title, hit.title, hit.snippet, names) <= 0) continue;
      seen.add(hit.url);
      let content = hit.content;
      if (!content) {
        if (fetches >= 6) continue;
        fetches++;
        try {
          const page = await api.fetchPage(hit.url, 'concept-generation', signal);
          if (page === null) return null;
          content = page.content;
        } catch (error) {
          signal?.throwIfAborted();
          // One unavailable page must not discard other usable sources. Account
          // errors/rate limits are not misreported as missing provider support.
          if (error instanceof WebApiError && [403, 404].includes(error.status)) continue;
          throw error;
        }
      }
      const snippet = cleanConceptEvidenceText(title, { blocks: content.split(/\n\s*\n/u) }, 2200, names);
      if (snippet.length < 100 || conceptEvidenceRelevanceScore(title, '', snippet, names) <= 0
        || /^(?:#\s*)?(?:登录|验证码|安全验证|access denied|just a moment|sign in)(?:\s|$|[：:])/iu.test(snippet)) continue;
      const coverage = inferWebEvidenceKind(hit.url, content) === 'abstract' ? '【论文摘要，非全文；仅限摘要明确支持的内容】\n' : '';
      evidence.push({ sourceId: `W${evidence.length + 1}`, type: 'web', title: hit.title, url: hit.url, snippet: coverage + snippet });
      hosts.add(host);
    }
    if (evidence.length >= 2) break;
  }
  if (!evidence.length) throw new Error(`联网 API 未取得“${title}”的足够相关正文；未将搜索摘要当作正文，请补充别名或本地资料`);
  return evidence;
}
