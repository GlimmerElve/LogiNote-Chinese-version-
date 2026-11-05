import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import type { ResourceHealthCheckResult, ResourceHealthStatus } from '../services/resourceState';

const MAX_REDIRECTS = 5;
const REQUEST_TIMEOUT_MS = 10_000;

export function isPrivateIp(address: string): boolean {
  const value = address.toLowerCase().split('%')[0];
  if (isIP(value) === 4) {
    const [a, b] = value.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (isIP(value) === 6) {
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd')
      || value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb')
      || value.startsWith('::ffff:127.') || value.startsWith('::ffff:10.')
      || value.startsWith('::ffff:192.168.');
  }
  return true;
}

export async function assertSafePublicUrl(raw: string): Promise<URL> {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅支持 HTTP/HTTPS 链接');
  if (url.username || url.password) throw new Error('链接不能包含身份凭据');
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('不允许检查本机或局域网地址');
  }
  const addresses = isIP(hostname) ? [{ address: hostname }] : await lookup(hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => isPrivateIp(address))) {
    throw new Error('不允许检查本机或局域网地址');
  }
  return url;
}

export function classifyResourceHealth(httpStatus: number, redirected: boolean): ResourceHealthStatus {
  if (httpStatus >= 200 && httpStatus < 400) return redirected ? 'redirected' : 'available';
  if ([401, 402, 403, 407, 429].includes(httpStatus)) return 'restricted';
  if ([404, 410].includes(httpStatus)) return 'broken';
  return 'temporary-error';
}

async function requestOnce(url: URL, method: 'HEAD' | 'GET'): Promise<Response> {
  const response = await fetch(url, {
    method,
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: method === 'GET'
      ? { 'User-Agent': 'Loginote-LinkChecker/1.0', Range: 'bytes=0-0' }
      : { 'User-Agent': 'Loginote-LinkChecker/1.0' },
  });
  if (method === 'GET') await response.body?.cancel().catch(() => {});
  return response;
}

function suggestedFileName(response: Response): string | undefined {
  const disposition = response.headers.get('content-disposition') || '';
  const encoded = /filename\*\s*=\s*UTF-8''([^;]+)/iu.exec(disposition)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded).replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').slice(0, 200); } catch { /* fall through */ }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/iu.exec(disposition)?.[1]?.trim();
  return plain?.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_').slice(0, 200) || undefined;
}

export async function checkPublicResourceUrl(rawUrl: string): Promise<ResourceHealthCheckResult> {
  const checkedAt = new Date().toISOString();
  let current = rawUrl;
  let redirected = false;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const safeUrl = await assertSafePublicUrl(current);
      let response = await requestOnce(safeUrl, 'HEAD');
      if ([405, 501].includes(response.status)) response = await requestOnce(safeUrl, 'GET');
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) break;
        if (hop === MAX_REDIRECTS) throw new Error('链接重定向次数过多');
        current = new URL(location, safeUrl).toString();
        redirected = true;
        continue;
      }
      return {
        url: rawUrl,
        status: classifyResourceHealth(response.status, redirected),
        checkedAt,
        httpStatus: response.status,
        finalUrl: redirected ? current : undefined,
        contentType: response.headers.get('content-type')?.split(';')[0].trim().toLocaleLowerCase() || undefined,
        contentLength: Number(response.headers.get('content-length')) || undefined,
        suggestedFileName: suggestedFileName(response),
      };
    }
    throw new Error('链接返回了无目标的重定向');
  } catch (error) {
    return {
      url: rawUrl,
      status: 'temporary-error',
      checkedAt,
      error: error instanceof Error ? error.message : '链接检查失败',
    };
  }
}
