import { textbookPublicUrl } from '../services/textbook/boundUrls';
import { fetchTextbookPublicBody } from './textbookWebReader';
import { decodeTextbookBody, extractTextbookHtml, extractTextbookImageLinks } from './textbookWebContent';

/** Fetch omitted image metadata from the SAME public article. This never
 * replaces API text, crawls unrelated links, reads cookies or invokes OCR. */
export async function discoverTextbookPublicImages(rawUrl: string, term: string, signal: AbortSignal,
  deps: { fetch?: typeof fetchTextbookPublicBody; render?: (url: string, signal: AbortSignal) => Promise<import('./textbookWebReader').PublicBody> } = {}): Promise<Array<{ url: string; alt: string }>> {
  const url = textbookPublicUrl(rawUrl), abort = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  const extract = (body: import('./textbookWebReader').PublicBody) => {
    if (!/html/iu.test(body.contentType)) return [];
    const html = decodeTextbookBody(body.bytes, body.contentType), content = extractTextbookHtml(html);
    if (!content.text.includes(term)) return [];
    return extractTextbookImageLinks(html, textbookPublicUrl(body.url));
  };
  try { const images = extract(await (deps.fetch || fetchTextbookPublicBody)(url, abort)); if (images.length) return images; }
  catch { abort.throwIfAborted(); }
  abort.throwIfAborted();
  const render = deps.render || (async (target, caller) => (await import('./textbookBrowser')).renderTextbookPublicPage(target, caller));
  return extract(await render(url, abort));
}
