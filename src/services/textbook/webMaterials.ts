import type { TextbookJob, TextbookSource } from './generationTypes';
import type { TextbookWebReadRequest, TextbookWebSnapshot } from './webTypes';
import { isBlockingTextbookWebError, safeTextbookWebError } from './webErrors';

/** No searches or model calls. Empty means all optional URLs were skipped;
 * the caller decides whether the remaining approved local/knowledge sources suffice. */
export async function collectBoundTextbookSources(job: TextbookJob, token: string,
  read: (input: TextbookWebReadRequest, signal?: AbortSignal) => Promise<TextbookWebSnapshot>,
  progress: (label: string) => Promise<void>, signal?: AbortSignal, sourceOffset = 0): Promise<TextbookSource[]> {
  if (!job.spec.readBoundUrls || !job.spec.boundUrls?.length) return [];
  const sources: TextbookSource[] = [];
  job.checkpoint.webReads = [...(job.checkpoint.webReads || [])].filter((item) => job.spec.boundUrls!.some((resource) => resource.id === item.id));
  const record = (status: NonNullable<TextbookJob['checkpoint']['webReads']>[number]) => {
    const index = job.checkpoint.webReads!.findIndex((item) => item.id === status.id);
    if (index < 0) job.checkpoint.webReads!.push(status); else job.checkpoint.webReads![index] = status;
  };
  for (const [index, resource] of job.spec.boundUrls.entries()) {
    let blocking = false;
    signal?.throwIfAborted(); await progress(`读取已绑定 URL ${index + 1}/${job.spec.boundUrls.length}：${resource.title}`);
    try {
      const snapshot = await read({ jobId: job.id, token, resourceId: resource.id }, signal);
      signal?.throwIfAborted();
      if (snapshot.jobId !== job.id || snapshot.resourceId !== resource.id || snapshot.web.url !== resource.url
        || !snapshot.text.trim() || !/^[a-f0-9]{64}$/u.test(snapshot.version)) throw new Error('网页快照与批准来源不一致');
      // Avoid increasing model input on every online resource; this is an explicit excerpt,
      // not a claim that the entire resource has been supplied to / understood by the model.
      let end = Math.min(snapshot.text.length, 6000);
      if (end < snapshot.text.length) { const boundary = snapshot.text.lastIndexOf('\n\n', end); if (boundary > 3000) end = boundary; }
      sources.push({ sourceId: `L${sourceOffset + sources.length + 1}`, kind: 'web', id: resource.id, title: resource.title,
        version: snapshot.version, text: snapshot.text.slice(0, end), textStart: 0, textEnd: end,
        web: { ...snapshot.web, coverage: end === snapshot.text.length ? 'full_text' : 'excerpt' } });
      record({ id: resource.id, title: resource.title, status: 'saved' });
    } catch (error) {
      signal?.throwIfAborted();
      record({ id: resource.id, title: resource.title, status: 'failed', error: safeTextbookWebError(error) });
      blocking = isBlockingTextbookWebError(error);
    }
    const status = job.checkpoint.webReads.find((item) => item.id === resource.id)!;
    await progress(status.status === 'saved' ? `${sources.at(-1)?.web?.acquisition === 'provider_api' ? 'API 正文' : sources.at(-1)?.web?.acquisition === 'anonymous_browser' ? '匿名浏览器正文' : '网页'}快照已保存：${resource.title}`
      : `${blocking ? '读取停止' : '已跳过不可读 URL'}：${resource.title}；${status.error}`);
    if (blocking) throw new Error(status.error);
  }
  return sources;
}
