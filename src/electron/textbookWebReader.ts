import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import { extractStructuredDocument } from './documentParsers';
import { textbookPublicUrl } from '../services/textbook/boundUrls';
import type { TextbookBoundUrl, TextbookWebPointer } from '../services/textbook/webTypes';
import { assertReadableText, decodeTextbookBody, extractTextbookHtml, extractTextbookTranscript, extractPublicVideoData,
  isTextbookVideoPage, isTextbookCatalogPage, type HtmlContentKind } from './textbookWebContent';
import { extractTextbookImageLinks, extractTextbookMarkdownImages } from './textbookWebContent';
export { extractTextbookHtml, extractTextbookTranscript, decodeTextbookBody } from './textbookWebContent';

export interface PublicBody { bytes: Buffer; url: string; contentType: string }
export interface ReadWebBody { text: string; finalUrl: string; contentType: string; format: TextbookWebPointer['format']; transcriptUrl?: string; contentKind?: HtmlContentKind; acquisition?: 'anonymous_browser' | 'provider_api'; images?: Array<{ url: string; alt: string }> }
export interface PublicFetchDependencies { resolve: typeof lookup; request: typeof http.request }
const MAX_BYTES = 12_000_000;
async function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted(); let listener: () => void;
  try { return await Promise.race([work, new Promise<never>((_, reject) => {
    listener = () => reject(signal.reason); signal.addEventListener('abort', listener, { once: true });
  })]); } finally { signal.removeEventListener('abort', listener!); }
}
/** Positive public-address allowlist, including IPv4-mapped IPv6 and transition networks. */
export function isTextbookPublicIp(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && [0, 168].includes(b))
      || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
  }
  if (isIP(address) !== 6) return false;
  // Global unicast only: excludes ::ffff mappings, local/link-local/multicast and NAT64.
  const first = parseInt(address.split(':')[0], 16);
  const second = parseInt(address.split(':')[1] || '0', 16);
  return first >= 0x2000 && first <= 0x3fff && first !== 0x2002
    && !(first === 0x2001 && (second === 0 || second === 2 || second === 0xdb8 || (second >= 0x10 && second <= 0x2f)));
}
/** Shared by direct downloads and the browser's pinned network gateway. */
export async function resolveTextbookPublicTarget(raw: string, signal: AbortSignal, resolve = lookup) {
  signal.throwIfAborted(); const url = new URL(textbookPublicUrl(raw));
  const host = url.hostname.replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) throw new Error('不读取本机或内网资源');
  const addresses = await abortable(resolve(host, { all: true, verbatim: true }), signal);
  signal.throwIfAborted();
  if (!addresses.length || addresses.some(item => !isTextbookPublicIp(item.address))) throw new Error('资源域名指向内网、保留或不安全地址');
  return { url, addresses, pinned: addresses[0] };
}
export async function fetchTextbookPublicBody(raw: string, signal?: AbortSignal, dependencies?: PublicFetchDependencies): Promise<PublicBody> {
  // One deadline across DNS, all redirects and response body; never send cookies/auth/referrers.
  const deadline = AbortSignal.timeout(30_000);
  const abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  let current = textbookPublicUrl(raw);
  for (let redirect = 0; redirect <= 5; redirect++) {
    // Validate every returned address, then PIN that address in the actual socket lookup.
    const { url, addresses, pinned } = await resolveTextbookPublicTarget(current, abort, dependencies?.resolve);
    const result = await new Promise<PublicBody | { redirect: string }>((resolve, reject) => {
      let responseFailure: ((error: unknown) => void) | undefined;
      const request = (dependencies?.request || (url.protocol === 'https:' ? https : http).request)(url, {
        method: 'GET', signal: abort,
        headers: { 'User-Agent': 'LogiNote-Textbook/1.0', Accept: 'text/html,application/pdf,text/plain,*/*;q=0.5', 'Accept-Encoding': 'gzip, deflate, br' },
        lookup: (_name, options, callback) => {
          // Node's autoSelectFamily requests an array; still return only the pinned address.
          if (options.all) (callback as unknown as (error: null, values: typeof addresses) => void)(null, [pinned]);
          else callback(null, pinned.address, pinned.family);
        },
      }, (response) => {
        const status = response.statusCode || 0;
        if ([301, 302, 303, 307, 308].includes(status)) {
          const location = response.headers.location; response.destroy();
          if (!location) reject(new Error('网页跳转缺少目标地址'));
          else { try { resolve({ redirect: new URL(location, url).href }); } catch { reject(new Error('网页跳转目标地址无效')); } }
          return;
        }
        if (status < 200 || status >= 300) { response.destroy(); reject(new Error(`公开资源返回 HTTP ${status}`)); return; }
        const encoding = String(response.headers['content-encoding'] || 'identity').toLowerCase().trim();
        if (!['identity', 'gzip', 'deflate', 'br'].includes(encoding)) { response.destroy(); reject(new Error('在线资源压缩格式不受支持')); return; }
        if (Number(response.headers['content-length']) > MAX_BYTES) { response.destroy(); reject(new Error('在线资源超过 12 MB，请下载为本地资料')); return; }
        // Bound BOTH wire bytes and inflated bytes; abort/error destroys the whole pipeline.
        const decoded = encoding === 'gzip' ? createGunzip() : encoding === 'deflate' ? createInflate()
          : encoding === 'br' ? createBrotliDecompress() : new PassThrough();
        const chunks: Buffer[] = []; let wireLength = 0, length = 0, settled = false;
        const cleanup = () => abort.removeEventListener('abort', cancelled);
        const fail = (error: unknown) => {
          if (settled) return; settled = true; cleanup(); response.unpipe(decoded); response.destroy(); decoded.destroy(); reject(error);
        };
        responseFailure = fail;
        const cancelled = () => fail(abort.reason); abort.addEventListener('abort', cancelled, { once: true });
        response.on('error', fail); response.on('aborted', () => fail(new Error('网页正文传输中断')));
        decoded.on('error', () => fail(new Error('在线资源压缩正文损坏或解压失败，未作为教材证据')));
        response.on('data', (chunk: Buffer) => {
          wireLength += chunk.length; if (wireLength > MAX_BYTES) fail(new Error('在线资源超过 12 MB，请下载为本地资料'));
        });
        decoded.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > MAX_BYTES) { fail(new Error('在线资源解压后超过 12 MB，请下载为本地资料')); return; }
          chunks.push(chunk);
        });
        decoded.on('end', () => {
          if (settled) return; settled = true; cleanup();
          resolve({ bytes: Buffer.concat(chunks), url: url.href, contentType: String(response.headers['content-type'] || '') });
        });
        if (abort.aborted) cancelled(); else response.pipe(decoded);
      });
      request.on('error', error => responseFailure ? responseFailure(error) : reject(error)); request.end();
    });
    if (!('redirect' in result)) return result;
    current = textbookPublicUrl(result.redirect);
  }
  throw new Error('在线资源跳转次数过多');
}

/** Small public subtitle adapter. No signing, account cookies, danmaku or speech recognition. */
async function bilibiliCaptionUrls(pageUrl: string, fetchBody: typeof fetchTextbookPublicBody, signal: AbortSignal): Promise<string[]> {
  const page = new URL(pageUrl);
  if (!/(?:^|\.)bilibili\.com$/iu.test(page.hostname)) return [];
  const id = /\/video\/(BV[a-zA-Z0-9]{10}|av\d{1,20})(?:\/|$)/u.exec(page.pathname)?.[1];
  if (!id) return [];
  const key = id.startsWith('BV') ? `bvid=${id}` : `aid=${id.slice(2)}`;
  const json = async (url: string): Promise<Record<string, any>> => {
    const body = await fetchBody(textbookPublicUrl(url), signal);
    if (body.bytes.length > 1_000_000) throw new Error('公开字幕接口响应超过上限');
    try {
      const value = JSON.parse(decodeTextbookBody(body.bytes, body.contentType));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid'); return value;
    } catch { throw new Error('公开字幕接口未返回有效数据'); }
  };
  const view = await json(`https://api.bilibili.com/x/web-interface/view?${key}`);
  if (view.code !== 0 || !view.data) throw new Error('公开字幕接口不可访问，未使用登录态或绕过站点限制');
  const requestedPart = Number(page.searchParams.get('p') || '1');
  const part = (Array.isArray(view.data.pages) ? view.data.pages : []).find((item: { page?: number }) => item.page === requestedPart);
  const cid = part?.cid ?? (requestedPart === 1 ? view.data.cid : undefined);
  if (!Number.isSafeInteger(cid) || cid <= 0) throw new Error('没有找到当前视频分集的公开字幕信息');
  const player = await json(`https://api.bilibili.com/x/player/wbi/v2?${key}&cid=${cid}`);
  if (player.code !== 0 || !player.data) throw new Error('公开字幕接口不可访问，未使用登录态或绕过站点限制');
  if (player.data.need_login_subtitle) throw new Error('该视频字幕需要登录，未借用浏览器 Cookie；请绑定公开文字稿或本地字幕');
  return (Array.isArray(player.data.subtitle?.subtitles) ? player.data.subtitle.subtitles : [])
    .filter((item: { subtitle_url?: unknown }) => typeof item.subtitle_url === 'string')
    .sort((a: { lan?: string }, b: { lan?: string }) => Number(/^zh/iu.test(b.lan || '')) - Number(/^zh/iu.test(a.lan || '')))
    .slice(0, 3).map((item: { subtitle_url: string }) => item.subtitle_url);
}
async function readVideoTranscript(pageUrl: string, html: string, tracks: string[], fetchBody: typeof fetchTextbookPublicBody,
  signal: AbortSignal): Promise<{ text: string; transcriptUrl: string }> {
  const published = extractPublicVideoData(html, pageUrl);
  if (published.transcript) return { text: published.transcript, transcriptUrl: pageUrl };
  let lastError: unknown;
  const candidates = [...tracks, ...published.captions];
  if (!candidates.length) {
    try { candidates.push(...await bilibiliCaptionUrls(pageUrl, fetchBody, signal)); }
    catch (error) { signal.throwIfAborted(); lastError = error; }
  }
  for (const raw of [...new Set(candidates)].slice(0, 3)) {
    try {
      const body = await fetchBody(textbookPublicUrl(new URL(raw, pageUrl).href), signal); signal.throwIfAborted();
      if (body.contentType.toLowerCase().includes('html')) throw new Error('字幕链接返回了网页，未取得真实字幕');
      const text = extractTextbookTranscript(decodeTextbookBody(body.bytes, body.contentType)); assertReadableText(text);
      return { text, transcriptUrl: body.url };
    } catch (error) { signal.throwIfAborted(); lastError = error; }
  }
  if (lastError) throw lastError;
  throw new Error('视频未取得公开字幕/文字稿；标题、课程简介和目录不会作为视频内容证据');
}
export async function readTextbookBoundBody(resource: TextbookBoundUrl, signal?: AbortSignal,
  fetchBody = fetchTextbookPublicBody): Promise<ReadWebBody> {
  // A single budget covers page, metadata and subtitle requests, not 30 seconds per subrequest.
  const deadline = AbortSignal.timeout(30_000), abort = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const body = await fetchBody(textbookPublicUrl(resource.url), abort); abort.throwIfAborted();
  const type = body.contentType.split(';')[0].toLowerCase(), extension = path.extname(new URL(body.url).pathname).toLowerCase();
  const decode = () => decodeTextbookBody(body.bytes, body.contentType);
  const prefix = body.bytes.subarray(0, 1024).toString('latin1');
  const pdfMagic = /^\s*%PDF-/u.test(prefix), htmlMagic = /^\s*(?:<!doctype html|<html\b)/iu.test(prefix);
  const declaredPdf = type === 'application/pdf' || extension === '.pdf';
  if (declaredPdf && !pdfMagic) throw new Error('资源未返回有效 PDF（可能是错误页或下载说明），未作为教材正文');
  let text: string; let format: ReadWebBody['format']; let transcriptUrl: string | undefined; let contentKind: HtmlContentKind | undefined;
  let images: ReadWebBody['images'];
  const fileType = pdfMagic ? 'pdf'
    : type.includes('presentationml') || extension === '.pptx' ? 'pptx'
    : type.includes('wordprocessingml') || extension === '.docx' ? 'docx' : undefined;
  if (fileType) {
    const directory = await mkdtemp(path.join(tmpdir(), 'loginote-textbook-'));
    try {
      const file = path.join(directory, `source.${fileType}`); await writeFile(file, body.bytes);
      const parsed = await extractStructuredDocument(file, fileType, resource.id);
      // Keep page/slide/paragraph positions with the real extracted text.
      text = parsed.blocks.map((block) => `[位置 ${JSON.stringify(block.locator)}]\n${parsed.normalizedText.slice(block.textStart, block.textEnd)}`).join('\n\n');
      format = 'document';
    } finally { await rm(directory, { recursive: true, force: true }); }
  } else if (type === 'text/vtt' || type.includes('ttml') || type.includes('subrip') || ['.vtt', '.srt', '.ttml'].includes(extension)
    || (type.includes('json') && /"(?:body|events)"\s*:/u.test(prefix))) {
    text = extractTextbookTranscript(decode()); format = 'transcript';
  } else if (type.includes('html') || htmlMagic) {
    const raw = decode(), html = extractTextbookHtml(raw, false);
    const isVideo = isTextbookVideoPage(body.url, resource.resourceType)
      || (!html.hasArticle && (html.hasVideo || html.tracks.length > 0 || extractPublicVideoData(raw, body.url).hasVideo));
    if (isVideo) {
      const transcript = await readVideoTranscript(body.url, raw, html.tracks, fetchBody, abort);
      text = transcript.text; transcriptUrl = transcript.transcriptUrl; format = 'transcript';
    } else {
      if (isTextbookCatalogPage(body.url)) throw new Error('该链接仅是课程/书籍介绍或目录页，未取得讲授正文；请绑定具体讲义、文章或公开字幕');
      const parsed = extractTextbookHtml(raw); text = parsed.text; contentKind = parsed.contentKind; format = 'html';
      images = extractTextbookImageLinks(raw, body.url);
    }
  } else if (type.startsWith('text/plain') || type.includes('markdown') || ['.txt', '.md'].includes(extension)) {
    text = decode(); format = 'text'; images = extractTextbookMarkdownImages(text, body.url);
  } else throw new Error('该链接不是可读取的正文、PDF/PPTX/DOCX 或文字字幕，请下载为本地资料');
  abort.throwIfAborted(); assertReadableText(text);
  return { text: text.trim(), format, finalUrl: body.url, contentType: body.contentType.slice(0, 200),
    ...(transcriptUrl ? { transcriptUrl } : {}), ...(contentKind ? { contentKind } : {}), ...(images?.length ? { images } : {}) };
}
