import { stormPublicationDate } from './stormResearch';
import { buildPlanResearchPrompt } from './planResearchPrompt';

export interface PlanResearchSource {
  id: string;
  title: string;
  url: string;
  excerpt: string;
  coverage: 'page-excerpt' | 'abstract';
  publishedAt?: string;
}
export interface PlanResearchBundle {
  subject: string;
  retrievedAt: string;
  queries: string[];
  sources: PlanResearchSource[];
  warnings: string[];
}

export function planResearchSubject(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > 120 || /[\r\n\u0000]/u.test(value)) {
    throw new Error('请填写 1～120 字的公开学习主题，不要填写私人经历或笔记正文。');
  }
  return value.trim();
}

export function validatePlanResearch(value: PlanResearchBundle, subject: string): PlanResearchBundle {
  if (!value || value.subject !== planResearchSubject(subject) || !Number.isFinite(Date.parse(value.retrievedAt))
    || !Array.isArray(value.sources) || !value.sources.length || value.sources.length > 6
    || !Array.isArray(value.queries) || !value.queries.length || value.queries.length > 3
    || value.queries.some(query => typeof query !== 'string' || !query.trim() || [...query].length > 128)
    || !Array.isArray(value.warnings) || value.warnings.length > 12 || value.warnings.some(item => typeof item !== 'string' || item.length > 300)) {
    throw new Error('未取得有效的规划联网材料，请重试，或明确关闭联网生成未核实草图。');
  }
  const urls = new Set<string>();
  for (const [index, source] of value.sources.entries()) {
    const url = new URL(source.url);
    if (source.id !== `P${index + 1}` || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || source.url.length > 4096 || /[\s<>"`{}\\]/u.test(source.url) || urls.has(source.url)
      || typeof source.title !== 'string' || !source.title.trim() || source.title.length > 300
      || typeof source.excerpt !== 'string' || source.excerpt.length < 100 || source.excerpt.length > 2200
      || !['page-excerpt', 'abstract'].includes(source.coverage)
      || source.publishedAt !== undefined && stormPublicationDate(source.publishedAt) !== source.publishedAt) throw new Error('规划来源材料不完整，请重新联网取证。');
    urls.add(source.url);
  }
  return structuredClone(value);
}

export interface PlanResearchPreparation {
  research?: PlanResearchBundle;
  notice?: string;
}

/** Only draft generation may degrade to offline. Strict research/Agent receipts
 * keep their existing validation and never acquire fabricated sources. */
export async function preparePlanResearch(subject: string, signal?: AbortSignal, {
  collect = collectPlanResearch, timeoutMs = 25_000,
}: { collect?: typeof collectPlanResearch; timeoutMs?: number } = {}): Promise<PlanResearchPreparation> {
  subject = planResearchSubject(subject);
  signal?.throwIfAborted();
  const budget = new AbortController();
  const combined = signal ? AbortSignal.any([signal, budget.signal]) : budget.signal;
  const timer = setTimeout(() => budget.abort(new DOMException('规划资料检索超时', 'TimeoutError')), timeoutMs);
  let stop!: () => void;
  try {
    const aborted = new Promise<never>((_, reject) => {
      stop = () => reject(combined.reason);
      combined.addEventListener('abort', stop, { once: true });
    });
    const result = await Promise.race([Promise.resolve().then(() => {
      combined.throwIfAborted(); return collect(subject, combined);
    }), aborted]);
    signal?.throwIfAborted();
    const research = validatePlanResearch(result, subject);
    return { research, notice: research.warnings.find(warning => warning.includes('部分联网检索未完成')) };
  } catch {
    signal?.throwIfAborted(); // Explicit Stop must never start an offline model request.
    return { notice: '联网补充未完成，已按离线草图继续（未联网核实）。可在生成后重新联网补充。' };
  } finally {
    clearTimeout(timer);
    combined.removeEventListener('abort', stop);
  }
}

export function planResearchContext(bundle?: PlanResearchBundle): string {
  return buildPlanResearchPrompt(bundle).text;
}

export function checkPlanResearchCitations(text: string, bundle?: PlanResearchBundle): void {
  const ids = [...text.matchAll(/\[P(\d+)\]/gu)].map(match => `P${match[1]}`);
  if (bundle ? !ids.length || ids.some(id => !bundle.sources.some(source => source.id === id)) : ids.length > 0) {
    throw new Error('计划缺少真实联网来源编号或引用了不存在的来源，请重新生成。');
  }
}

/** The editable wizard draft may keep an uncited plan, but must not present it
 * as source-verified. Agent research receipts still use the strict check above. */
export function checkPlanDraftResearchCitations(text: string, bundle?: PlanResearchBundle, visibleSourceIds?: readonly string[]): string | undefined {
  if (bundle && !/\[P\d+\]/u.test(text)) {
    return '来源核验未完成：已取得联网材料，但计划未提供来源编号。蓝图已保留，可继续编辑，请核对来源后再采用。';
  }
  checkPlanResearchCitations(text, bundle);
  if (visibleSourceIds && [...text.matchAll(/\[P(\d+)\]/gu)].some(match => !visibleSourceIds.includes(`P${match[1]}`))) {
    throw new Error('计划引用了本轮未提供的来源，请重新生成。');
  }
  return undefined;
}

export async function collectPlanResearch(subject: string, signal?: AbortSignal): Promise<PlanResearchBundle> {
  subject = planResearchSubject(subject);
  signal?.throwIfAborted();
  const api = window.electronAPI?.planResearch;
  if (!api?.search || !api.cancel) throw new Error('规划联网需要更新后的桌面版，请重启；或关闭联网生成未核实草图。');
  const requestId = crypto.randomUUID();
  let dispatched = false, rejectAbort!: (reason: unknown) => void;
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const cancel = () => {
    if (dispatched) void api.cancel(requestId).catch(() => {});
    rejectAbort(signal?.reason || new DOMException('规划检索已停止', 'AbortError'));
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const result = await Promise.race([Promise.resolve().then(() => {
      signal?.throwIfAborted(); dispatched = true; return api.search(subject, requestId);
    }), aborted]);
    signal?.throwIfAborted();
    return validatePlanResearch(result, subject);
  } finally { signal?.removeEventListener('abort', cancel); }
}
