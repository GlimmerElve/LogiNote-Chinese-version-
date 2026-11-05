import { createHash } from 'node:crypto';
import type { LlmProvider, LlmSettings, LlmWorkflowId } from '../types';
import { assertSafePublicUrl } from './resourceHealth';
import { textbookPublicUrl } from '../services/textbook/boundUrls';
import { stormPublicationDate } from '../services/stormResearch';
import { selectLlmProvider } from '../services/llmProviderSelection';

export interface WebSearchHit { title: string; url: string; snippet: string; content: string; publishedAt?: string }
export interface WebPage { title: string; content: string }
export type WebWorkflow = 'concept-generation' | 'textbook-blueprint' | 'agent-resource-curation' | 'storm-multi-perspective' | 'plan-generation';
let settingsReader: () => Promise<LlmSettings | null> = async () => null;
/** Main-process only. API keys never enter browser pages, citations or job files. */
export function configureWebAcquisition(reader: typeof settingsReader): void { settingsReader = reader; }
export function resolveWebProvider(settings: LlmSettings | null, workflow: WebWorkflow): LlmProvider | null {
  return settings ? selectLlmProvider(settings, workflow) : null;
}
/** Adapters are explicit: OpenAI compatibility alone does NOT imply Search support.
 * Do not silently forward a proxy/local key to the official DeepSeek service. */
export function deepSeekToolsBase(provider: LlmProvider | null): string | null {
  if (!provider?.enabled || provider.apiType !== 'openai-compatible' || !provider.apiKey?.trim()) return null;
  try {
    const url = new URL(provider.baseUrl);
    return url.origin === 'https://api.deepseek.com' && !url.username && !url.password && !url.search && !url.hash
      && /^\/(?:v1\/?|beta\/?)?$/u.test(url.pathname) ? `${url.origin}/v1/tools` : null;
  } catch { return null; }
}
export class WebApiError extends Error {
  constructor(public readonly status: number, message: string) { super(message); this.name = 'WebApiError'; }
}
export interface WebAcquisitionDependencies {
  settings?: typeof settingsReader; fetch?: typeof fetch; validateUrl?: typeof assertSafePublicUrl;
}
export function createWebAcquisition(dependencies: WebAcquisitionDependencies = {}) {
  const unsupported = new Map<string, number>();
  const validate = async (url: string) => {
    const safe = textbookPublicUrl(url); await (dependencies.validateUrl || assertSafePublicUrl)(safe); return safe;
  };
  const request = async (workflow: WebWorkflow, operation: 'search' | 'fetch', body: object, signal?: AbortSignal): Promise<any | null> => {
    signal?.throwIfAborted();
    const provider = resolveWebProvider(await (dependencies.settings || settingsReader)(), workflow);
    const base = deepSeekToolsBase(provider);
    if (!base || !provider) return null;
    const key = createHash('sha256').update(`${base}:${provider.apiKey}:${operation}`).digest('hex');
    if ((unsupported.get(key) || 0) > Date.now()) return null;
    const abort = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(20_000)]);
    let response: Response;
    try {
      response = await (dependencies.fetch || fetch)(`${base}/${operation}`, { method: 'POST', redirect: 'error', signal: abort,
        headers: { Authorization: `Bearer ${provider.apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    } catch { abort.throwIfAborted(); throw new WebApiError(0, '联网 API 连接失败，请检查网络后重试；未误判为不支持'); }
    // Fetch 404 means THIS PAGE is unreadable per official docs, not missing API.
    if ([405, 501].includes(response.status) || (operation === 'search' && response.status === 404)) {
      await response.body?.cancel();
      if (unsupported.size >= 100) unsupported.clear();
      unsupported.set(key, Date.now() + 10 * 60_000); return null;
    }
    if (!response.ok) {
      await response.body?.cancel();
      const reason = response.status === 401 ? 'API Key 无效' : response.status === 402 ? '账号余额不足'
        : response.status === 403 ? '安全策略拒绝' : response.status === 404 ? '该网页未取得可读正文'
          : response.status === 429 ? '接口限流，请稍后重试' : '服务请求失败';
      throw new WebApiError(response.status, `联网 API：${reason}（HTTP ${response.status}）`);
    }
    // Bound allocation even when upstream omits or lies about Content-Length.
    const reader = response.body?.getReader(); if (!reader) throw new WebApiError(200, '联网 API 返回空响应');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        abort.throwIfAborted(); const next = await reader.read(); if (next.done) break;
        size += next.value.byteLength;
        if (size > 4_000_000) throw new WebApiError(200, '联网 API 响应超过安全读取上限');
        chunks.push(next.value);
      }
    } catch (error) {
      abort.throwIfAborted();
      if (error instanceof WebApiError) throw error;
      throw new WebApiError(0, '联网 API 正文传输中断');
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new WebApiError(200, '联网 API 响应不是有效 JSON'); }
  };
  return {
    async search(query: string, workflow: WebWorkflow, options: { count?: number; signal?: AbortSignal; needContent?: boolean } = {}): Promise<WebSearchHit[] | null> {
      const term = query.trim();
      if (!term || [...term].length > 128) throw new Error('API 搜索词必须为 1～128 字符');
      const data = await request(workflow, 'search', { query: term, count: Math.min(20, Math.max(1, Math.floor(options.count || 10))),
        need_content: Boolean(options.needContent) }, options.signal);
      if (data === null) return null;
      if (!data || !Array.isArray(data.results)) throw new WebApiError(200, '联网 API 缺少搜索结果数组');
      const hits: WebSearchHit[] = []; const seen = new Set<string>();
      for (const raw of data.results.slice(0, 20)) {
        options.signal?.throwIfAborted();
        if (!raw || typeof raw.title !== 'string' || typeof raw.url !== 'string') continue;
        let url: string; try { url = await validate(raw.url); } catch { continue; }
        if (seen.has(url)) continue; seen.add(url);
        hits.push({ title: raw.title.slice(0, 300), url, publishedAt: stormPublicationDate(raw.published_at || raw.published_date),
          snippet: String(raw.snippet || raw.summary || '').slice(0, 2000),
          // Summary is never passed off as a retrieved page body.
          content: typeof raw.content === 'string' ? raw.content.slice(0, 200_000) : '' });
      }
      return hits;
    },
    async fetchPage(url: string, workflow: WebWorkflow, signal?: AbortSignal): Promise<WebPage | null> {
      if (!deepSeekToolsBase(resolveWebProvider(await (dependencies.settings || settingsReader)(), workflow))) return null;
      signal?.throwIfAborted(); const safe = await validate(url); signal?.throwIfAborted();
      const data = await request(workflow, 'fetch', { url: safe }, signal);
      if (data === null) return null;
      if (!data || typeof data.content !== 'string' || !data.content.trim() || data.content.length > 200_000)
        throw new WebApiError(200, '联网 API 未返回有效正文或正文超过 20 万字');
      return { title: typeof data.title === 'string' ? data.title.slice(0, 300) : '', content: data.content.trim() };
    },
  };
}
export const webAcquisition = createWebAcquisition();
