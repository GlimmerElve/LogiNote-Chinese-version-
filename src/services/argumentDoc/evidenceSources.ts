import type { DocumentPreviewChunk } from '../../types';
import { openDocument, previewDocument, searchDocuments } from '../documentRagClient';
import { searchNotes } from '../ragService';
import type { ArgumentSourceRef } from './types';

export interface ArgumentEvidenceCandidate {
  id: string;
  type: 'note' | 'document';
  entityId: string;
  chunkId?: string;
  title: string;
  quote: string;
  sectionPath?: string[];
  score: number;
}

export interface ArgumentEvidencePreview {
  title: string;
  subtitle: string;
  content: string;
  canOpenOriginal: boolean;
}

function compact(value: string, max: number): string {
  return String(value || '').replace(/\s+/gu, ' ').trim().slice(0, max);
}

function parseSectionPath(value: string): string[] | undefined {
  const parts = String(value || '').split(/\s*>\s*|\s*\/\s*/u).map((part) => part.trim()).filter(Boolean);
  return parts.length ? parts.slice(0, 20) : undefined;
}

export async function searchArgumentEvidenceCandidates(
  query: string,
  currentNoteId?: string | null,
  limit = 8,
): Promise<ArgumentEvidenceCandidate[]> {
  const text = compact(query, 1200);
  if (!text) return [];
  const [notes, documents] = await Promise.all([
    searchNotes(text, Math.max(6, limit)),
    searchDocuments(text, Math.max(6, limit), { mode: 'passage', expandGraph: false }),
  ]);
  const noteCandidates = notes.flatMap((result): ArgumentEvidenceCandidate[] => {
    if (result.noteId === currentNoteId || result.evidenceOrigin === 'user-argument-doc') return [];
    if (result.matchKinds?.length && !result.matchKinds.includes('note')) return [];
    const quote = compact(result.snippet, 1200);
    if (!quote) return [];
    return [{
      id: `note:${result.noteId}`,
      type: 'note',
      entityId: result.noteId,
      title: compact(result.title, 300),
      quote,
      score: result.score,
    }];
  });
  const documentCandidates = documents.flatMap((result): ArgumentEvidenceCandidate[] => {
    const quote = compact(result.snippet, 1200);
    if (!result.docId || !result.chunkId || !quote) return [];
    return [{
      id: `document:${result.docId}:${result.chunkId}`,
      type: 'document',
      entityId: result.docId,
      chunkId: result.chunkId,
      title: compact(result.fileName, 300),
      quote,
      sectionPath: parseSectionPath(result.sectionPath),
      score: result.score,
    }];
  });
  const seen = new Set<string>();
  return [...documentCandidates, ...noteCandidates]
    .sort((left, right) => right.score - left.score)
    .filter((candidate) => {
      if (seen.has(candidate.id)) return false;
      seen.add(candidate.id);
      return true;
    })
    .slice(0, Math.max(1, limit));
}

function focusedChunk(chunks: DocumentPreviewChunk[], chunkId?: string): DocumentPreviewChunk | undefined {
  return chunks.find((chunk) => chunk.id === chunkId) || chunks[0];
}

/** 绑定资料时再读一次本地 chunk，不直接信任列表里的截断 snippet。 */
export async function candidateToArgumentSourceRef(
  candidate: ArgumentEvidenceCandidate,
): Promise<ArgumentSourceRef> {
  if (candidate.type === 'document') {
    if (!candidate.chunkId) throw new Error('资料候选缺少 chunkId');
    const preview = await previewDocument(candidate.entityId, candidate.chunkId);
    const chunk = focusedChunk(preview.chunks, candidate.chunkId);
    if (!chunk || chunk.id !== candidate.chunkId) throw new Error('该资料片段已不存在，请重新检索');
    return {
      type: 'document',
      entityId: candidate.entityId,
      chunkId: candidate.chunkId,
      title: preview.document.fileName || candidate.title,
      quote: compact(chunk.content, 5000),
      sectionPath: parseSectionPath(chunk.sectionPath) || candidate.sectionPath,
      verifiedAt: new Date().toISOString(),
    };
  }
  return {
    type: 'note',
    entityId: candidate.entityId,
    title: candidate.title,
    quote: compact(candidate.quote, 5000),
    verifiedAt: new Date().toISOString(),
  };
}

export async function previewArgumentSource(
  source: ArgumentSourceRef | ArgumentEvidenceCandidate,
): Promise<ArgumentEvidencePreview> {
  if (source.type === 'document') {
    const preview = await previewDocument(source.entityId, source.chunkId);
    const chunk = focusedChunk(preview.chunks, source.chunkId);
    if (!chunk) throw new Error('资料片段已不存在');
    return {
      title: preview.document.fileName,
      subtitle: chunk.sectionPath || '未标注章节',
      content: chunk.content,
      canOpenOriginal: true,
    };
  }
  return {
    title: source.title || '笔记来源',
    subtitle: '笔记命中片段',
    content: source.quote,
    canOpenOriginal: true,
  };
}

export async function openArgumentSourceOriginal(source: ArgumentSourceRef | ArgumentEvidenceCandidate): Promise<void> {
  if (source.type === 'document') {
    await openDocument(source.entityId);
    return;
  }
  const api = (window as any).electronAPI?.argument;
  if (!api?.openNote) throw new Error('无法从当前环境打开笔记');
  await api.openNote(source.entityId);
}
