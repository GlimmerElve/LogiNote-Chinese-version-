import { webAcquisition, WebApiError } from './webAcquisition';
import { attemptWebApi } from './webApiFallback';
import { inferWebEvidenceKind } from '../services/webEvidenceKind';
import { planResearchSubject, validatePlanResearch, type PlanResearchBundle, type PlanResearchSource } from '../services/planResearch';
import { stormPublicationDate } from '../services/stormResearch';
import { cleanConceptEvidenceText } from './resourceBrowserCore';
import type { ConceptSourceEvidence } from '../types';

export function planSearchQueries(subject: string): string[] {
  const term = [...planResearchSubject(subject).replace(/\s+/gu, ' ')].slice(0, 80).join('');
  return [`${term} university syllabus 课程大纲`, `${term} prerequisites 先修 学习目标`, `${term} official curriculum 教材 目录`];
}

type Browser = (subject: string, queries: string[], signal?: AbortSignal) => Promise<ConceptSourceEvidence[]>;
/** Only the explicitly public topic is searched. No profile, private notes, downloads or binding writes. */
export async function researchPlanWeb(subject: string, browser: Browser, signal?: AbortSignal, api = webAcquisition,
  now = new Date()): Promise<PlanResearchBundle> {
  subject = planResearchSubject(subject); signal?.throwIfAborted();
  const queries = planSearchQueries(subject), warnings: string[] = [], sources: PlanResearchSource[] = [];
  const seen = new Set<string>(), hosts = new Map<string, number>();
  const add = (title: string, url: string, content: string, publishedAt?: string) => {
    if (typeof title !== 'string' || typeof url !== 'string' || typeof content !== 'string') { warnings.push('部分课程来源信息不完整，已跳过'); return; }
    const cleaned = content.replace(/\u0000/gu, '').trim();
    const excerpt = cleanConceptEvidenceText(subject, { blocks: cleaned.split(/\n+/u) }, 2200) || cleaned.slice(0, 2200);
    let host: string;
    try { host = new URL(url).hostname; } catch { warnings.push('部分课程来源信息不完整，已跳过'); return; }
    if (seen.has(url) || (hosts.get(host) || 0) >= 2 || excerpt.length < 100
      || /^(?:#\s*)?(?:登录|验证码|安全验证|access denied|just a moment|sign in)(?:\s|$|[：:])/iu.test(excerpt)) return;
    const source: PlanResearchSource = { id: `P${sources.length + 1}`, title: title.trim().slice(0, 300), url, excerpt,
      coverage: inferWebEvidenceKind(url, excerpt) === 'abstract' ? 'abstract' : 'page-excerpt', publishedAt: stormPublicationDate(publishedAt) };
    try {
      validatePlanResearch({ subject, retrievedAt: now.toISOString(), queries, sources: [{ ...source, id: 'P1' }], warnings: [] }, subject);
    } catch { warnings.push('部分课程来源信息不完整，已跳过'); return; }
    seen.add(url); hosts.set(host, (hosts.get(host) || 0) + 1);
    sources.push(source);
  };
  const attempt = await attemptWebApi(async abort => {
    let reads = 0;
    for (const query of queries) {
      const before = sources.length;
      const hits = await api.search(query, 'plan-generation', { count: 6, needContent: true, signal: abort });
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
            const page = await api.fetchPage(hit.url, 'plan-generation', abort);
            if (page === null) return null;
            body = page.content;
          } catch (error) {
            abort.throwIfAborted();
            if (error instanceof WebApiError && [403, 404].includes(error.status)) { warnings.push('部分课程网页未取得正文，已跳过'); continue; }
            throw error;
          }
        }
        abort.throwIfAborted(); add(hit.title, hit.url, body, hit.publishedAt);
      }
    }
    return sources.length ? true : null;
  }, { signal, timeoutMs: 15_000 });
  signal?.throwIfAborted();
  if (attempt.value === null && sources.length) {
    // Supplementary queries are best-effort. Do not discard validated evidence
    // or wait on another route when we already have enough to build a draft.
    warnings.push('部分联网检索未完成，已保留取得的有效来源；课程覆盖范围尚不完整');
  } else if (attempt.value === null) {
    warnings.push('搜索 API 未提供可用材料，已使用隔离网页检索');
    const pages = await browser(subject, queries, signal);
    signal?.throwIfAborted();
    for (const page of pages.slice(0, 30)) { if (sources.length >= 6) break; if (page.url) add(page.title, page.url, page.snippet, page.publishedAt); }
  }
  if (!sources.length) throw new Error('未取得可读课程或先修材料，规划已暂停；请重试，或主动关闭联网生成未核实草图。');
  return validatePlanResearch({ subject, retrievedAt: now.toISOString(), queries, sources,
    warnings: [...new Set([...warnings, '来源为网页节选，覆盖范围、适用性与发布日期仍需核对；核心20%是目标导向的取舍，不是固定课程比例'])] }, subject);
}
