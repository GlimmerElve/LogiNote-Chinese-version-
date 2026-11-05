import type { ResourceItem } from '../../types';
import { openDocument } from '../documentRagClient';

/** Resolve only after the reader/OS accepts the request, not after the user actually reads it. */
export async function openLearningResource(resource: ResourceItem): Promise<void> {
  if (resource.documentId) {
    await openDocument(resource.documentId);
    return;
  }
  const url = new URL(resource.url);
  if (!['https:', 'http:', 'file:'].includes(url.protocol)) throw new Error('unsupported-resource');
  const api = (window as Window & { electronAPI?: { isElectron?: boolean; openExternal?: (url: string) => Promise<void> } }).electronAPI;
  if (api?.openExternal) {
    await api.openExternal(url.href);
    return;
  }
  if (api?.isElectron || url.protocol === 'file:') throw new Error('resource-reader-unavailable');
  // `noopener` makes window.open return null even when it succeeds. Open a blank
  // window synchronously, sever its opener before navigation, and suppress referrers.
  const opened = window.open('about:blank', '_blank');
  if (!opened) throw new Error('popup-blocked');
  try {
    opened.opener = null;
    const policy = opened.document.createElement('meta');
    policy.name = 'referrer';
    policy.content = 'no-referrer';
    opened.document.head.appendChild(policy);
    opened.location.replace(url.href);
  } catch (cause) {
    opened.close();
    throw cause;
  }
}
