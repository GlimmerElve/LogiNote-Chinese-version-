export const COMMUNITY_UNAVAILABLE_MESSAGE = '社区正在建设中，暂未开放。';

/** Release clients require an explicit opt-in and a deployed HTTPS website. */
export function resolveCommunityWebsiteUrl(raw: string | undefined, options: { release: boolean; releaseEnabled: boolean }): string | null {
  if (options.release && !options.releaseEnabled) return null;
  if (!raw?.trim()) return null;
  try {
    const url = new URL(raw.trim());
    const hostname = url.hostname.replace(/\.$/, '');
    const local = hostname === 'localhost' || hostname.endsWith('.localhost') || /^127\./.test(hostname)
      || ['0.0.0.0', '[::]', '[::1]'].includes(hostname) || /^\[::ffff:7f[\da-f]{2}:/i.test(hostname);
    if (url.username || url.password) return null;
    if (options.release ? url.protocol !== 'https:' || local : url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return null;
    return url.href;
  } catch { return null; }
}

export function communityWebsiteUrl(): string | null {
  return resolveCommunityWebsiteUrl(import.meta.env.VITE_COMMUNITY_WEB_URL || (import.meta.env.DEV ? 'http://127.0.0.1:5174' : ''), {
    release: import.meta.env.MODE === 'release',
    releaseEnabled: import.meta.env.VITE_COMMUNITY_RELEASE_ENABLED === 'true',
  });
}
