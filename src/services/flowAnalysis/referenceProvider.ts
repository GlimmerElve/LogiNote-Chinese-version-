import type { NoteItem, NoteSearchResult, TextbookReferenceSearchResult } from '../../types';
import type { ShadowReferenceCandidate } from '../flowShadow/types';
import type { ShadowReferenceProvider } from '../flowShadow/references';
import type { FlowAnalysisInput } from './types';
import { searchDocuments } from '../documentRagClient';
import { searchProjectTextbooks } from '../textbookReferenceRag';
import { readTextbookBody } from '../textbook/noteContent';
import { hasSubstantiveReferenceText, referenceNoteContent } from '../ragSourcePolicy';
import { searchNotes } from '../ragService';
import { selectReviewNotePassage } from '../reviewComparison/notePassages';
import { noteReferenceSourceFingerprint } from '../noteReferenceSource';
import { referenceParagraphs, referenceProseKind, selectReferenceEvidence } from '../referenceEvidence';

export interface FlowReferenceReaders {
  searchTextbooks: typeof searchProjectTextbooks;
  searchDocuments: typeof searchDocuments;
  searchNotes: typeof searchNotes;
}
const compact = (value: string, max = 2000) => value.replace(/\s+/gu, ' ').trim().slice(0, max);
const similarity = (a: string, b: string) => {
  const tokens = (value: string) => {
    const normalized = value.toLocaleLowerCase().replace(/<[^>]+>/gu, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    const words = normalized.split(/\s+/u).filter(Boolean), chars = [...normalized.replace(/\s+/gu, '')];
    for (let index = 0; index + 1 < chars.length; index++) words.push(chars[index] + chars[index + 1]);
    return new Set(words);
  };
  const left = tokens(a), right = tokens(b);
  if (!left.size || !right.size) return 0;
  let overlap = 0;
  for (const item of left) if (right.has(item)) overlap++;
  return Math.round(overlap / Math.sqrt(left.size * right.size) * 1000) / 1000;
};

/** Read-only lexical fallback. Never uses arbitrary project content as a textbook. */
function bestPassages(body: string, query: string, limit = 2) {
  return body.split(/\n{2,}|(?<=。|！|？)\s*\n/u)
    .map((paragraph, index) => ({ locator: `paragraph:${index + 1}`,
      text: paragraph.split(/\r?\n/u).filter(line => line.trim()).every(line => /^\s*#{1,6}\s+/u.test(line)) ? '' : compact(paragraph) }))
    .filter(p => hasSubstantiveReferenceText(p.text))
    .map(p => ({ ...p, score: similarity(query, p.text) })).filter(p => p.score > 0)
    .sort((a, b) => b.score - a.score || a.locator.localeCompare(b.locator)).slice(0, limit);
}
function rootOf(note: NoteItem, notes: readonly NoteItem[]): string {
  const byId = new Map(notes.map(item => [item.id, item]));
  let current = note, guard = 0;
  while (current.parentId && byId.has(current.parentId) && guard++ < 100) current = byId.get(current.parentId)!;
  return current.id;
}

/** Project textbook > project resources > linked knowledge; searching never creates/rebuilds an index. */
export function createFlowReferenceProvider(input: FlowAnalysisInput, overrides: Partial<FlowReferenceReaders> = {},
  options: { purpose?: 'mastery' } = {}): ShadowReferenceProvider {
  input = { ...input, allNotes: structuredClone(input.allNotes) };
  const readers: FlowReferenceReaders = { searchTextbooks: searchProjectTextbooks, searchDocuments, searchNotes, ...overrides };
  const current = input.noteId ? input.allNotes.find(note => note.id === input.noteId) : input.allNotes.find(note => note.title === input.noteTitle);
  const rootId = current ? rootOf(current, input.allNotes) : undefined;
  const projectNotes = current && rootId ? [current, ...input.allNotes.filter(note => note.id !== current.id && rootOf(note, input.allNotes) === rootId)]
    .filter(note => note.noteType === 'project').slice(0, 50) : [];
  const bodies = new Map<string, { note: NoteItem; body: string }>();
  for (const raw of projectNotes) {
    const note = { ...raw, textbook: raw.textbook ? { ...raw.textbook } : undefined };
    if (!note.textbook || note.textbook.projectNoteId !== note.id || note.textbook.rootProjectId !== rootId) continue;
    const body = readTextbookBody(note.content || '', note.textbook);
    if (body && hasSubstantiveReferenceText(body)) bodies.set(note.id, { note, body });
  }
  // Large textbooks depend on the background index. Never tokenize an unbounded book on the UI thread.
  let fallbackChars = 0;
  const fallbackBodies = [...bodies.values()].filter(source => {
    if (fallbackChars + source.body.length > 20000) return false;
    fallbackChars += source.body.length;
    return true;
  });
  const linkedTitles = new Set(current?.links || []);
  const linkedNotes = input.allNotes.filter(note => note.noteType === 'knowledge' && linkedTitles.has(note.title)
    && hasSubstantiveReferenceText(referenceNoteContent(note)));
  const resources = [...new Map(projectNotes.flatMap(note => note.resources || [])
    .map((resource, index) => [resource.documentId || resource.url || `${index}:${resource.title}`, resource] as const)).values()];
  const local = resources.filter(resource => Boolean(resource.documentId));
  const documentIds = [...new Set(local.flatMap(resource => resource.documentId ? [resource.documentId] : []))];
  const documentsById = new Map(local.flatMap(resource => resource.documentId ? [[resource.documentId, resource] as const] : []));
  const online = resources.filter(resource => !resource.documentId && Boolean(resource.url));
  const mastery = options.purpose === 'mastery';
  const localPassages = (body: string, query: string) => referenceParagraphs(body)
    .flatMap(span => { const selected = selectReferenceEvidence(body, span); return selected ? [{ ...selected, sectionPath: span.sectionPath }] : []; })
    .map(p => ({ ...p, score: similarity(query, `${p.sectionPath}\n${p.text}`) }))
    .filter(p => p.score > 0).sort((a, b) => b.score - a.score).slice(0, 2);

  function currentHit(hit: TextbookReferenceSearchResult): boolean {
    const source = bodies.get(hit.noteId), manifest = source?.note.textbook;
    return Boolean(source && manifest && hit.textbookId === manifest.textbookId && hit.revisionId === manifest.revisionId
      && typeof hit.chunkId === 'string' && hit.chunkId && Number.isFinite(hit.score)
      && Number.isSafeInteger(hit.textStart) && Number.isSafeInteger(hit.textEnd) && hit.textStart >= 0
      && hit.textEnd > hit.textStart && hit.textEnd <= source.body.length && hasSubstantiveReferenceText(hit.snippet)
      && source.body.slice(hit.textStart, hit.textEnd).slice(0, 650) === hit.snippet);
  }
  return {
    async retrieve(_shadowInput, _graph, targets, signal) {
      const output: ShadowReferenceCandidate[] = [];
      // Merge identical search tasks within THIS invocation only. Targets/grades stay independent;
      // never reuse hits across sessions, projects or textbook revisions.
      const textbookCache = new Map<string, TextbookReferenceSearchResult[]>();
      const documentCache = new Map<string, Awaited<ReturnType<typeof searchDocuments>>>();
      const knowledgeCache = new Map<string, NoteSearchResult[]>();
      const check = () => { if (signal?.aborted) throw new DOMException('复盘分析已停止', 'AbortError'); };
      for (const target of targets) {
        check();
        const relation = target.layer === 'concept' ? 'definition' : target.layer === 'judgment' ? 'claim' : 'premise';
        let textbookHits: TextbookReferenceSearchResult[] = [];
        if (bodies.size) {
          if (textbookCache.has(target.query)) textbookHits = textbookCache.get(target.query)!;
          else {
            try { textbookHits = (await readers.searchTextbooks(target.query, [...bodies.keys()], mastery ? 6 : 2)).filter(currentHit); }
            catch { /* Missing/failed index falls back to the same managed body, never the review text. */ }
            textbookCache.set(target.query, textbookHits);
          }
          check();
        }
        const selectedTextbooks = textbookHits.flatMap(hit => {
          const selected = mastery ? selectReferenceEvidence(bodies.get(hit.noteId)!.body, hit) : undefined;
          return mastery && !selected ? [] : [{ hit, selected }];
        }).slice(0, 2);
        for (const [index, { hit, selected }] of selectedTextbooks.entries()) output.push({
          id: `REF1-${target.id}-${index + 1}`, targetId: target.id, tier: 1, sourceType: 'project_textbook',
          sourceId: hit.noteId, title: bodies.get(hit.noteId)!.note.title.slice(0, 300),
          locator: selected && (selected.textStart !== hit.textStart || selected.textEnd !== hit.textEnd)
            ? `${hit.chunkId}@${selected.textStart}-${selected.textEnd}`.slice(0, 500) : hit.chunkId.slice(0, 500),
          relation, availability: 'available', text: selected?.text || hit.snippet, similarity: Math.max(0, Math.min(1, hit.score)),
        });
        if (!selectedTextbooks.length) {
          const passages = fallbackBodies.flatMap(({ note, body }) => (mastery
            ? localPassages(body, target.query).map(p => ({ ...p, locator: `body@${p.textStart}-${p.textEnd}` }))
            : bestPassages(body, target.query, 2)).map(p => ({ note, ...p })))
            .sort((a, b) => b.score - a.score).slice(0, 2);
          for (const [index, p] of passages.entries()) output.push({
            id: `REF1-${target.id}-${index + 1}`, targetId: target.id, tier: 1, sourceType: 'project_textbook',
            sourceId: p.note.id, title: p.note.title.slice(0, 300), locator: `managed-textbook:${p.locator}`,
            relation, availability: 'available', text: p.text, similarity: p.score,
          });
        }
        const hasTextbook = output.some(candidate => candidate.targetId === target.id && candidate.tier === 1 && candidate.availability === 'available');
        if (hasTextbook && !mastery) continue;
        if (!hasTextbook && projectNotes[0]) output.push({
          id: `REF1-${target.id}-gap`, targetId: target.id, tier: 1, sourceType: 'project_textbook', sourceId: projectNotes[0].id,
          title: projectNotes[0].title.slice(0, 300), locator: 'managed-textbook-unavailable', relation: 'other',
          availability: 'missing', text: '', similarity: null,
        });
        let resourceHits: Awaited<ReturnType<typeof searchDocuments>> = [];
        if (documentIds.length) {
          if (documentCache.has(target.query)) resourceHits = documentCache.get(target.query)!;
          else {
            try {
              resourceHits = (await readers.searchDocuments(target.query, 4, { allowedDocIds: documentIds, mode: 'passage', expandGraph: false }))
                .filter(hit => documentsById.has(hit.docId) && hasSubstantiveReferenceText(hit.snippet) && Number.isFinite(hit.score)
                  && (!mastery || referenceProseKind(hit.snippet, hit.sectionPath) !== 'meta')).slice(0, 2);
            } catch { /* Unavailable resources are evidence gaps, not a reason to cancel analysis. */ }
            documentCache.set(target.query, resourceHits);
          }
          check();
        }
        for (const [index, hit] of resourceHits.entries()) output.push({
          id: `REF2-${target.id}-${index + 1}`, targetId: target.id, tier: 2, sourceType: 'project_resource', sourceId: hit.docId,
          title: (documentsById.get(hit.docId)?.title || hit.fileName || '项目本地资料').slice(0, 300),
          locator: (hit.sectionPath || hit.chunkId).slice(0, 500), relation: target.layer === 'reasoning' ? 'premise' : 'other',
          availability: 'available', text: compact(hit.snippet), similarity: Math.max(0, Math.min(1, hit.score)),
        });
        if (resourceHits.length && !mastery) continue;
        if (!resourceHits.length && local[0]) output.push({
          id: `REF2-${target.id}-gap-local`, targetId: target.id, tier: 2, sourceType: 'project_resource', sourceId: local[0].documentId!,
          title: (local[0].title || '项目本地资料').slice(0, 300), locator: local[0].documentId!.slice(0, 500), relation: 'other',
          availability: 'unreadable', text: '', similarity: null,
        });
        if (online[0]) output.push({
          id: `REF2-${target.id}-gap-online`, targetId: target.id, tier: 2, sourceType: 'online_resource', sourceId: online[0].url.slice(0, 300),
          title: (online[0].title || '项目在线资源').slice(0, 300), locator: online[0].url.slice(0, 500), relation: 'other',
          availability: 'unreadable', text: '', similarity: null,
        });
        let knowledgeHits: NoteSearchResult[] = [];
        if (linkedNotes.length) {
          if (knowledgeCache.has(target.query)) knowledgeHits = knowledgeCache.get(target.query)!;
          else {
            try { knowledgeHits = await readers.searchNotes(target.query, 2, { allowedNoteIds: linkedNotes.map(note => note.id) }); }
            catch { /* Explicit semantic-unit fallback below; no automatic embedding/rebuild. */ }
            knowledgeCache.set(target.query, knowledgeHits);
          }
          check();
        }
        // Only linked knowledge IDs can enter this channel. Snippets never replace saved originals.
        const selectedNotes = [...new Set(knowledgeHits.map(hit => hit.noteId))]
          .flatMap(id => linkedNotes.filter(note => note.id === id)).slice(0, 2);
        if (!selectedNotes.length) {
          let fallbackKnowledgeChars = 0;
          selectedNotes.push(...linkedNotes.filter(note => {
            if (fallbackKnowledgeChars + note.content.length > 20000) return false;
            fallbackKnowledgeChars += note.content.length; return true;
          }).map(note => ({ note, score: similarity(target.query, `${note.title}\n${note.content}`) }))
            .filter(row => row.score > 0).sort((a, b) => b.score - a.score).slice(0, 2).map(row => row.note));
        }
        for (const [index, note] of selectedNotes.entries()) {
          const selected = selectReviewNotePassage(note, knowledgeHits, await noteReferenceSourceFingerprint(note), target.query);
          let passage = selected.passage;
          if (mastery && passage) {
            const restored = selectReferenceEvidence(note.content, passage);
            passage = restored ? { ...passage, ...restored } : undefined;
            if (!passage && note.content.length <= 20000) {
              const alternative = localPassages(note.content, target.query)[0];
              if (alternative) passage = { ...alternative };
            }
          }
          if (!passage) continue;
          output.push({
          id: `REF3-${target.id}-${index + 1}`, targetId: target.id, tier: 3, sourceType: 'linked_knowledge', sourceId: note.id,
          title: note.title.slice(0, 300),
          locator: `${passage.chunkId || 'semantic-fallback'}:${passage.sectionPath}@${passage.textStart}-${passage.textEnd}`.slice(0, 500),
          relation: target.layer === 'concept' ? 'definition' : 'other', availability: 'available', text: passage.text,
          similarity: passage.chunkId ? knowledgeHits.find(hit => hit.noteId === note.id)?.score ?? null : similarity(target.query, passage.text),
          });
        }
      }
      check();
      return output;
    },
  };
}
