import { textbookPublicUrl } from '../services/textbook/boundUrls';
import type { TextbookBoundUrl } from '../services/textbook/webTypes';
import { safeTextbookWebError } from '../services/textbook/webErrors';
import { assertReadableText, isTextbookCatalogPage, isTextbookVideoPage } from './textbookWebContent';
import { readTextbookBoundBody, type PublicBody } from './textbookWebReader';
import { webAcquisition } from './webAcquisition';
import { inferWebEvidenceKind } from '../services/webEvidenceKind';
import { extractTextbookMarkdownImages } from './textbookWebContent';
import { textbookTeachingBodyIssue } from '../services/textbook/webMaterialAssessment';
import { attemptWebApi } from './webApiFallback';

export function shouldRenderTextbookPage(resource: TextbookBoundUrl, error: unknown): boolean {
  try {
    const url = new URL(textbookPublicUrl(resource.url));
    if (isTextbookCatalogPage(url.href) || isTextbookVideoPage(url.href, resource.resourceType)
      || /\.(?:pdf|pptx?|docx?|vtt|srt|ttml|zip|mp[34]|png|jpe?g|webp)$/iu.test(url.pathname)
      || ['pdf', 'document', 'presentation', 'image', 'audio', 'video'].includes(resource.resourceType || '')) return false;
  } catch { return false; }
  const message = error instanceof Error ? error.message : String(error || '');
  return /公开资源返回 HTTP (?:403|406|408|500|502|503|504)\b|未取得足够的公开正文|正文内容不足|编码|乱码|压缩正文损坏|压缩格式不受支持/u.test(message)
    || (error instanceof Error && error.name === 'TimeoutError');
}

/** Read one frozen, approved target. No searches, summary fallback or shared login state. */
export async function readTextbookBoundBodyWithBrowser(resource: TextbookBoundUrl, signal?: AbortSignal, dependencies: {
  direct?: typeof readTextbookBoundBody;
  render?: (url: string, signal: AbortSignal) => Promise<PublicBody>;
  api?: typeof webAcquisition;
} = {}) {
  const abort = signal ? AbortSignal.any([signal, AbortSignal.timeout(50_000)]) : AbortSignal.timeout(50_000);
  abort.throwIfAborted();
  const url = textbookPublicUrl(resource.url);
  // Files retain local page/slide positions; a video summary is not a transcript.
  const binary = /\.(?:pdf|pptx?|docx?|vtt|srt|ttml|zip|mp[34]|png|jpe?g|webp)$/iu.test(new URL(url).pathname)
    || ['pdf', 'document', 'presentation', 'image', 'audio', 'video'].includes(resource.resourceType || '');
  if (!binary && !isTextbookCatalogPage(url) && !isTextbookVideoPage(url, resource.resourceType)) {
    const { value: page } = await attemptWebApi(signal => (dependencies.api || webAcquisition).fetchPage(url, 'textbook-blueprint', signal),
      { signal: abort, timeoutMs: 5000 });
    abort.throwIfAborted();
    if (page !== null) {
      assertReadableText(page.content);
      const issue = textbookTeachingBodyIssue(page.content); if (issue) throw new Error(issue);
      if (/^(?:#\s*)?(?:登录|验证码|安全验证|access denied|just a moment|sign in)(?:\s|$|[：:])/iu.test(page.content)) throw new Error('API 仅取得登录或验证页面，未作为教材正文');
      return { text: page.content, finalUrl: url, contentType: 'text/markdown', format: 'text' as const,
        acquisition: 'provider_api' as const,
        contentKind: inferWebEvidenceKind(url, page.content), images: extractTextbookMarkdownImages(page.content, url) };
    }
  }
  try {
    const body = await (dependencies.direct || readTextbookBoundBody)(resource, abort);
    if (body.format === 'html' || body.format === 'text') { const issue = textbookTeachingBodyIssue(body.text); if (issue) throw new Error(issue); }
    return body;
  }
  catch (directError) {
    abort.throwIfAborted();
    if (!shouldRenderTextbookPage(resource, directError)) throw directError;
    try {
      const render = dependencies.render || (async (url, signal) => (await import('./textbookBrowser')).renderTextbookPublicPage(url, signal));
      const body = await render(textbookPublicUrl(resource.url), abort); abort.throwIfAborted();
      const parsed = await readTextbookBoundBody(resource, abort, async url => {
        if (url !== textbookPublicUrl(resource.url)) throw new Error('匿名正文后备不额外读取其它来源'); return body;
      });
      const issue = textbookTeachingBodyIssue(parsed.text); if (issue) throw new Error(issue);
      return { ...parsed, acquisition: 'anonymous_browser' as const };
    } catch (browserError) {
      abort.throwIfAborted();
      throw new Error(`直连：${safeTextbookWebError(directError).slice(0, 65)}；匿名浏览器：${safeTextbookWebError(browserError).slice(0, 100)}`);
    }
  }
}
