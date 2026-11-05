import { webAcquisition, WebApiError } from './webAcquisition';
import type { RawBrowserCandidate } from './resourceBrowserCore';

const academic = (url: URL) => /(?:^|\.)(?:arxiv\.org|aclanthology\.org|openreview\.net|proceedings\.neurips\.cc|doi\.org|acm\.org)$/u.test(url.hostname);
/** Follow actual citations when Search returns reading notes instead of papers.
 * Every new URL must be present in retrieved public source text, never guessed by a model. */
export async function discoverAcademicReferences(candidates: RawBrowserCandidate[], signal?: AbortSignal, api = webAcquisition): Promise<RawBrowserCandidate[]> {
  const references = new Map<string, RawBrowserCandidate>();
  if (candidates.some(candidate => { try { return academic(new URL(candidate.url)); } catch { return false; } })) return candidates;
  let pages = 0;
  for (const candidate of candidates) {
    signal?.throwIfAborted();
    if (pages >= 1 || references.size >= 1) break;
    let source: URL; try { source = new URL(candidate.url); } catch { continue; }
    if (academic(source) || /\.(?:pdf|pptx?|docx?)(?:$|\?)/iu.test(source.pathname)) continue;
    pages++;
    try {
      const page = await api.fetchPage(source.toString(), 'agent-resource-curation', signal);
      if (!page) break;
      const links = page.content.slice(0, 80_000).match(/https?:\/\/[^\s<>"'\[\](){}]+/gu) || [];
      for (const raw of links) {
        if (references.size >= 1) break;
        let url: URL; try { url = new URL(raw.replace(/[.,;:]+$/u, '')); } catch { continue; }
        if (!academic(url) || references.has(url.toString())) continue;
        const original = await api.fetchPage(url.toString(), 'agent-resource-curation', signal);
        signal?.throwIfAborted();
        if (original?.content) references.set(url.toString(), { title: original.title || '引用的学术原页', url: url.toString(),
          description: original.content.slice(0, 1800), detectedFrom: 'link' });
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof WebApiError && [401, 402, 429].includes(error.status)) throw error;
      // A citation page can be unreadable; keep other real search evidence.
    }
  }
  return [...references.values(), ...candidates];
}
