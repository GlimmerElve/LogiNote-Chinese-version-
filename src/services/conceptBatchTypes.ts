import type { ConceptDraft, ConceptSource, NoteItem } from '../types';

export type ConceptBatchItemStatus = 'pending' | 'retrieving' | 'generating' | 'saving' | 'completed' | 'skipped' | 'failed' | 'conflict';
export type ConceptBatchStatus = 'queued' | 'running' | 'stopping' | 'paused' | 'completed' | 'partial' | 'failed' | 'archived';
export interface ConceptNoteBaseline { title: string; aliases: string[]; content: string; references?: ConceptDraft['references']; }
export interface ConceptBatchItem {
  wikiTitle: string; noteId: string; created: boolean; initialized: boolean; status: ConceptBatchItemStatus;
  baseline?: ConceptNoteBaseline; draft?: ConceptDraft; error?: string; attempts: number;
}
export interface ConceptBatchJob {
  version: 1; id: string; scopeId: string; projectNoteId: string; projectTitle: string;
  source: ConceptSource; allowCloud: boolean; modelFingerprint: string; modelLabel: string;
  createdAt: string; updatedAt: string; status: ConceptBatchStatus; items: ConceptBatchItem[]; error?: string;
  evidenceScope?: import('./conceptFillService').ConceptEvidenceScope;
}
export const conceptBatchActive = (job: ConceptBatchJob) => ['queued', 'running', 'stopping'].includes(job.status);
export const conceptNoteBaseline = (note: NoteItem): ConceptNoteBaseline => ({
  title: note.title, aliases: [...(note.aliases || [])], content: note.content,
  ...(note.referenceSources ? { references: structuredClone(note.referenceSources) } : {}),
});
const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const sources = ['rag', 'browser', 'hybrid'];
const itemStatuses = ['pending', 'retrieving', 'generating', 'saving', 'completed', 'skipped', 'failed', 'conflict'];
const jobStatuses = ['queued', 'running', 'stopping', 'paused', 'completed', 'partial', 'failed', 'archived'];
function references(value: ConceptDraft['references']): ConceptDraft['references'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 10) throw new Error('概念引用记录无效');
  return value.map(ref => {
    if (!ref || !text(ref.title, 500) || ref.type !== undefined && !['web', 'note', 'document'].includes(ref.type)
      || ref.sourceId !== undefined && (typeof ref.sourceId !== 'string' || !/^\d{1,3}$/u.test(ref.sourceId))) throw new Error('概念引用记录无效');
    if (ref.url) { const url = new URL(ref.url); if (!['http:', 'https:'].includes(url.protocol) || ref.url.length > 4000) throw new Error('概念来源 URL 无效'); }
    return { title: ref.title, ...(ref.sourceId ? { sourceId: ref.sourceId } : {}), ...(ref.type ? { type: ref.type } : {}),
      ...(ref.url ? { url: ref.url } : {}), ...(ref.entityId ? { entityId: String(ref.entityId).slice(0, 200) } : {}),
      ...(ref.sectionPath ? { sectionPath: String(ref.sectionPath).slice(0, 500) } : {}),
      ...(ref.snippet ? { snippet: String(ref.snippet).slice(0, 500) } : {}) };
  });
}
export function normalizeConceptDraft(draft: ConceptDraft, noteId: string, source: ConceptSource): ConceptDraft {
  if (!draft || draft.noteId !== noteId || !text(draft.title, 120) || draft.source !== source
    || !text(draft.content, 24_000) || !date(draft.createdAt)
    || /<(?:TextbookBoundary|ArgumentBlock|LearningReviewBlock)\b/u.test(draft.content)) throw new Error('概念草稿目标、正文或结构无效，未写入');
  const refs = references(draft.references);
  if (!refs?.length) throw new Error('概念草稿缺少真实引用，未写入');
  const allowed = new Set(refs.map(ref => ref.sourceId));
  const citations = [...draft.content.matchAll(/\[(\d+)\]/gu)].map(match => match[1]);
  if (!citations.length || citations.some(id => !allowed.has(id))) throw new Error('概念草稿引用校验失败，未写入');
  return { noteId, title: draft.title, source, content: draft.content, references: refs, createdAt: draft.createdAt };
}
export function normalizeConceptBatchJobs(value: unknown): ConceptBatchJob[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw new Error('概念批处理恢复记录无效');
  const ids = new Set<string>();
  return value.map((job: ConceptBatchJob) => {
    if (!job || job.version !== 1 || !text(job.id, 200) || ids.has(job.id) || !text(job.scopeId, 200)
      || !text(job.projectNoteId, 200) || !text(job.projectTitle, 120) || !sources.includes(job.source)
      || typeof job.allowCloud !== 'boolean' || !/^[a-f0-9]{64}$/u.test(job.modelFingerprint)
      || !text(job.modelLabel, 300) || !date(job.createdAt) || !date(job.updatedAt) || !jobStatuses.includes(job.status)
      || !Array.isArray(job.items) || !job.items.length || job.items.length > 30) throw new Error('概念批处理恢复记录无效');
    ids.add(job.id);
    if (job.evidenceScope && (job.source !== 'rag' || !Array.isArray(job.evidenceScope.allowedDocIds) || !Array.isArray(job.evidenceScope.allowedNoteIds)
      || job.evidenceScope.allowedDocIds.length > 12 || job.evidenceScope.allowedNoteIds.length > 30
      || [...job.evidenceScope.allowedDocIds, ...job.evidenceScope.allowedNoteIds].some(id => !text(id, 200)))) throw new Error('概念证据白名单无效');
    const targets = new Set<string>();
    const items = job.items.map(item => {
      if (!item || !text(item.wikiTitle, 120) || !text(item.noteId, 200) || targets.has(item.noteId)
        || typeof item.created !== 'boolean' || typeof item.initialized !== 'boolean' || !itemStatuses.includes(item.status)
        || !Number.isInteger(item.attempts) || item.attempts < 0 || item.attempts > 3) throw new Error('概念批处理条目无效');
      targets.add(item.noteId);
      let baseline: ConceptNoteBaseline | undefined;
      if (item.baseline) {
        const b = item.baseline;
        if (!text(b.title, 120) || typeof b.content !== 'string' || b.content.length > 2000
          || !Array.isArray(b.aliases) || b.aliases.length > 30 || b.aliases.some(alias => !text(alias, 120))) throw new Error('概念目标基线无效');
        baseline = { title: b.title, aliases: [...b.aliases], content: b.content, references: references(b.references) };
      }
      return { wikiTitle: item.wikiTitle, noteId: item.noteId, created: item.created, initialized: item.initialized, status: item.status, attempts: item.attempts,
        ...(baseline ? { baseline } : {}), ...(item.draft ? { draft: normalizeConceptDraft(item.draft, item.noteId, job.source) } : {}),
        ...(typeof item.error === 'string' ? { error: item.error.slice(0, 500) } : {}) };
    });
    return { version: 1 as const, id: job.id, scopeId: job.scopeId, projectNoteId: job.projectNoteId, projectTitle: job.projectTitle,
      source: job.source, allowCloud: job.allowCloud, modelFingerprint: job.modelFingerprint, modelLabel: job.modelLabel,
      createdAt: job.createdAt, updatedAt: job.updatedAt, status: job.status, items,
      ...(job.evidenceScope ? { evidenceScope: { allowedDocIds: [...new Set(job.evidenceScope.allowedDocIds)], allowedNoteIds: [...new Set(job.evidenceScope.allowedNoteIds)] } } : {}),
      ...(typeof job.error === 'string' ? { error: job.error.slice(0, 500) } : {}) };
  });
}
