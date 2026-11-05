import type { NoteItem } from '../../types';
import type { TextbookBoundUrl } from './webTypes';

// Reject credential-bearing URLs instead of silently stripping a token and changing its target.
export function textbookPublicUrl(raw: string): string {
  if (typeof raw !== 'string' || raw.length > 4096) throw new Error('资源 URL 无效');
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || (url.port && !['80', '443'].includes(url.port))) throw new Error('只读取无凭据、标准端口的公开 HTTP/HTTPS 资源');
  if ([...url.searchParams.keys()].some((key) => /^(?:(?:(?:access|id|refresh)_?)?token|jwt|bearer|auth(?:orization|_?key|_?token)?|api_?key|key|password|passwd|secret|session(?:id)?|sid|cookie|signature|sig|credential|code|policy|key-pair-id|awsaccesskeyid|x-amz-.+|x-goog-.+)$/iu.test(key))) throw new Error('资源 URL 含访问凭据，请绑定公开链接或先下载为本地资料');
  url.hash = ''; return url.href;
}
export function textbookBoundUrls(note: Pick<NoteItem, 'resources'>): TextbookBoundUrl[] {
  const seen = new Set<string>(); const result: TextbookBoundUrl[] = [];
  for (const resource of note.resources || []) {
    if (resource.documentId || !resource.url || !/^https?:\/\//iu.test(resource.url)) continue;
    // Keep invalid public targets in the approved list: acquisition reports their failure explicitly.
    let url: string; try { const parsed = new URL(resource.url); parsed.hash = ''; url = parsed.href; } catch { continue; }
    if (seen.has(url)) continue; seen.add(url);
    result.push({ id: `U${result.length + 1}`, url, title: (resource.title || '已绑定网页').slice(0, 300), resourceType: resource.resourceType });
  }
  return result;
}
