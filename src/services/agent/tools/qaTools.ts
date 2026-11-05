import type { DocumentSearchResult, NoteItem, NoteSearchResult, SourceLocator } from '../../../types';
import { searchDocuments, readDocumentArgumentEvidence } from '../../documentRagClient';
import { attachQaDocumentGraph, qaGraphAnchorsFromHits } from '../qaGraphEvidence';
import type { QaDocumentGraph } from '../qaDocumentGraph';
import { buildNoteRagContent, searchNotes } from '../../ragService';
import type { AgentRuntimeContext } from '../types';
import { registerTool } from '../toolRegistry';
import { searchCurrentPersonalCognition } from '../../cognition/store';
import type { CognitionRetrieval } from '../../cognition/retrieval';

export type QaEvidenceCoverage = 'sufficient' | 'partial' | 'insufficient';

export interface QaEvidenceSource {
  sourceId: string;
  type: 'note' | 'document';
  entityId: string;
  title: string;
  noteType?: NoteItem['noteType'];
  sectionPath?: string;
  chunkId?: string;
  snippet: string;
  score: number;
  matchKinds?: Array<'note' | 'passage' | 'entity' | 'argument'>;
  relationSummary?: string;
  sourceLocation?: SourceLocator;
  evidenceOrigin?: 'passage' | 'imported-document-extraction' | 'note-passage' | 'user-argument-doc';
  admission?: 'admitted' | 'limited';
  evidenceGrade?: 'A' | 'B' | 'C' | 'ungraded';
  argumentHits?: NoteSearchResult['argumentHits'];
}

export interface QaEvidenceResult {
  documentGraph?: QaDocumentGraph;
  /** Separate diagnostic channel, never sources/coverage/citation IDs. Absent in ordinary QA. */
  personalCognition?: CognitionRetrieval;
  question: string;
  requestedScope: 'current-note' | 'global';
  appliedScope: 'current-note' | 'global';
  coverage: QaEvidenceCoverage;
  sources: QaEvidenceSource[];
  sourceIds: string[];
  warnings: string[];
}

function limit(value: unknown, fallback: number): number {
  return Math.max(1, Math.min(6, typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback));
}

function compactText(value: string, max = 900): string {
  const text = (value || '')
    .replace(/data:image\/[^)\s]+/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** Pure normalization kept separate so citation IDs and deduplication can be regression-tested. */
export function buildQaEvidenceResult(input: {
  question: string;
  requestedScope: 'current-note' | 'global';
  activeNote?: NoteItem | null;
  notes?: NoteItem[];
  noteResults: NoteSearchResult[];
  documentResults: DocumentSearchResult[];
  warnings?: string[];
}): QaEvidenceResult {
  const warnings = [...(input.warnings || [])];
  const appliedScope = input.requestedScope === 'current-note' && input.activeNote ? 'current-note' : 'global';
  if (input.requestedScope === 'current-note' && !input.activeNote) {
    warnings.push('当前没有选中笔记，已回退到全局笔记检索。');
  }
  if (appliedScope === 'current-note' && input.activeNote?.noteType === 'project') {
    warnings.push('当前项目正文属于个人认知素材，不作为参考事实证据；计划与任务也不计入知识证据。');
  }

  const noteById = new Map<string, Omit<QaEvidenceSource, 'sourceId'>>();
  if (appliedScope === 'current-note' && input.activeNote) {
    const snippet = compactText(buildNoteRagContent(input.activeNote));
    if (snippet) {
      noteById.set(input.activeNote.id, {
        type: 'note', entityId: input.activeNote.id, title: input.activeNote.title,
        noteType: input.activeNote.noteType, snippet, score: 1,
        evidenceOrigin: 'note-passage', matchKinds: ['note'],
      });
    }
  }

  for (const result of input.noteResults) {
    if (result.noteType !== 'knowledge' || result.evidenceOrigin === 'user-argument-doc'
      || result.matchKinds?.includes('argument') || result.argumentHits?.length) continue;
    const current = input.notes?.find((note) => note.id === result.noteId)
      || (input.activeNote?.id === result.noteId ? input.activeNote : undefined);
    if ((input.notes && !current) || (current && current.noteType !== 'knowledge')) continue;
    if (appliedScope === 'current-note' && result.noteId !== input.activeNote?.id) continue;
    const retrieved: Omit<QaEvidenceSource, 'sourceId'> = {
      type: 'note', entityId: result.noteId, title: result.title,
      noteType: 'knowledge',
      snippet: compactText(result.snippet), score: result.score,
      matchKinds: result.matchKinds,
      relationSummary: result.relationSummary ? compactText(result.relationSummary, 500) : undefined,
      evidenceOrigin: result.evidenceOrigin,
      admission: result.admission,
      evidenceGrade: result.evidenceGrade,
      argumentHits: result.argumentHits,
    };
    const existing = noteById.get(result.noteId);
    if (!existing) {
      noteById.set(result.noteId, retrieved);
    }
  }

  const noteSources = [...noteById.values()].map((source, index) => ({ ...source, sourceId: `N${index + 1}` }));
  const seenChunks = new Set<string>();
  const documentSources = input.documentResults
    .filter((result) => {
      const key = JSON.stringify([result.docId, result.chunkId]);
      if (seenChunks.has(key)) return false;
      seenChunks.add(key);
      return Boolean(compactText(result.snippet));
    })
    .map((result, index): QaEvidenceSource => ({
      sourceId: `D${index + 1}`,
      type: 'document',
      entityId: result.docId,
      title: result.fileName,
      sectionPath: result.sectionPath || undefined,
      chunkId: result.chunkId,
      snippet: compactText(result.snippet),
      score: result.score,
      matchKinds: result.matchKinds,
      relationSummary: result.relationSummary ? compactText(result.relationSummary, 500) : undefined,
      sourceLocation: result.sourceLocators?.[0],
      evidenceOrigin: result.matchKinds?.some((kind) => kind === 'entity' || kind === 'argument')
        ? 'imported-document-extraction'
        : 'passage',
      admission: result.matchKinds?.some((kind) => kind === 'entity' || kind === 'argument') ? 'admitted' : undefined,
    }));
  const sources = [...noteSources, ...documentSources];

  // Knowledge notes are reference material, not verified truth. Personal material
  // cannot contribute a citation or evidence-coverage count.
  const directEvidenceCount = sources.filter((source) => source.type === 'note'
    ? source.noteType === 'knowledge'
    : !source.matchKinds || source.matchKinds.includes('passage')).length;
  const coverage: QaEvidenceCoverage = sources.length >= 2 && directEvidenceCount >= 1
    ? 'sufficient'
    : sources.length >= 1 ? 'partial' : 'insufficient';
  return {
    question: input.question,
    requestedScope: input.requestedScope,
    appliedScope,
    coverage,
    sources,
    sourceIds: sources.map((source) => `${source.type}:${source.entityId}`),
    warnings,
  };
}

async function retrieveQaEvidence(
  args: Record<string, unknown>,
  ctx: AgentRuntimeContext,
): Promise<QaEvidenceResult> {
  const question = String(args.question || '').trim().slice(0, 1000);
  if (!question) throw new Error('答疑检索问题不能为空');
  const activeNote = ctx.getActiveNote?.() || null;
  const requestedScope = args.scope === 'global' ? 'global' : 'current-note';
  const noteLimit = limit(args.noteLimit, 4);
  const documentLimit = limit(args.documentLimit, 4);
  const personalOnly = args.includePersonalCognition === true && args.personalCognitionOnly === true;
  const [notes, documents, cognition] = await Promise.allSettled([
    personalOnly ? Promise.resolve([]) : searchNotes(question, noteLimit),
    personalOnly ? Promise.resolve([]) : searchDocuments(question, documentLimit),
    args.includePersonalCognition === true
      ? searchCurrentPersonalCognition(question)
      : Promise.resolve(undefined),
  ]);
  const warnings: string[] = [];
  if (notes.status === 'rejected') warnings.push(`笔记检索失败：${notes.reason instanceof Error ? notes.reason.message : String(notes.reason)}`);
  if (documents.status === 'rejected') warnings.push(`资料检索失败：${documents.reason instanceof Error ? documents.reason.message : String(documents.reason)}`);
  const result = buildQaEvidenceResult({
    question,
    requestedScope,
    activeNote,
    notes: ctx.getNotes(),
    noteResults: notes.status === 'fulfilled' ? notes.value : [],
    documentResults: documents.status === 'fulfilled' ? documents.value : [],
    warnings,
  });
  if (args.includePersonalCognition === true) {
    result.personalCognition = cognition.status === 'fulfilled' ? cognition.value : {
      status: 'unavailable', method: 'local-lexical-v1', items: [], warning: '个人认知库暂不可读，未完成认知比对；不会将读取失败当成空库。',
    };
  }
  const anchors = qaGraphAnchorsFromHits(documents.status === 'fulfilled' ? documents.value : []);
  if (anchors.length) {
    try { return attachQaDocumentGraph(result, await readDocumentArgumentEvidence(anchors,question)); }
    catch { result.warnings.push('论证结构暂不可读，仍保留已检索正文；不能据此认定原文没有依据。'); }
  }
  return result;
}

export function registerQaTools(): void {
  registerTool({
    name: 'retrieve_qa_evidence',
    description: '检索知识点笔记正文与已导入资料，返回 [N#]/[D#] 参考来源、覆盖度和警告。项目复述、用户论证图只在系统授权的个人认知通道读取，不是事实证据。',
    parameters: {
      type: 'object', required: ['question'], additionalProperties: false,
      properties: {
        question: { type: 'string' },
        scope: { type: 'string', enum: ['current-note', 'global'] },
        noteLimit: { type: 'number' },
        documentLimit: { type: 'number' },
        includePersonalCognition: { type: 'boolean', description: '仅在用户明确要求查询或比较个人认知时由系统开启。只读当前认知，独立于事实证据。' },
        personalCognitionOnly: { type: 'boolean', description: '系统用于只读查询个人原话，不检索笔记和资料。' },
      },
    },
    location: 'renderer',
    permission: 'readonly',
    execute: retrieveQaEvidence,
  });
}
