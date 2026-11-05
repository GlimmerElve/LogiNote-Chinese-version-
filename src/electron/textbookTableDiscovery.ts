import { textbookPublicUrl } from '../services/textbook/boundUrls';
import { hasTeachingTable, textbookTeachingBodyIssue } from '../services/textbook/webMaterialAssessment';
import { fetchTextbookPublicBody, type ReadWebBody } from './textbookWebReader';
import { decodeTextbookBody, extractTextbookHtml, extractTextbookImageLinks } from './textbookWebContent';

/** Recover a real, rendered HTML table omitted by the API's Markdown conversion.
 * Read only the same public URL; never interpret a code example as a table or
 * append reconstructed cells to the frozen API body. */
export async function discoverTextbookPublicTable(rawUrl: string, term: string, signal: AbortSignal,
  fetchBody: typeof fetchTextbookPublicBody = fetchTextbookPublicBody): Promise<ReadWebBody | null> {
  const url = textbookPublicUrl(rawUrl), abort = AbortSignal.any([signal, AbortSignal.timeout(5000)]);
  const body = await fetchBody(url, abort);
  abort.throwIfAborted();
  if (!/html/iu.test(body.contentType)) return null;
  const html = decodeTextbookBody(body.bytes, body.contentType), parsed = extractTextbookHtml(html);
  // The DOM must contain a real teaching table, not just pipe text in <pre>.
  if (!parsed.text.includes(term) || textbookTeachingBodyIssue(parsed.text) || !parsed.tables.some(hasTeachingTable)) return null;
  return { text: parsed.text, finalUrl: textbookPublicUrl(body.url), contentType: body.contentType, format: 'html',
    contentKind: parsed.contentKind, images: extractTextbookImageLinks(html, body.url) };
}
