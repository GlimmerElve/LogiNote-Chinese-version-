import type { DocumentChunk, DocumentSearchResult, NoteItem, NoteSearchResult } from '../../types.ts';
import { argumentContextHash, compareArgumentContextIds } from '../../services/argumentContext/hash.ts';
import { createArgumentContextPointer } from '../../services/argumentContext/reader.ts';
import type { ArgumentContextPointer } from '../../services/argumentContext/types.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionBuildResult } from '../../services/argumentContext/buildTypes.ts';
import type { PersistentArgumentProjectionStore } from './argumentProjectionStore.ts';
import { adaptSavedKnowledgeNote } from './argumentSourceAdapter.ts';
import { isCurrentNoteReferenceHit } from './noteReferenceAuthority.ts';
import { buildNoteReferenceChunks } from './noteReferenceChunks.ts';
import { TEXT_SEGMENTATION_VERSION } from './sentenceBoundaries.ts';
import { DOCUMENT_SEMANTIC_CHUNKING_VERSION } from './chunking.ts';

export const ARGUMENT_SEARCH_BRIDGE_LIMITS = { hits: 8, seedNodes: 16 } as const;
export type ArgumentSearchContextReason = 'unsupported_hit' | 'hit_budget' | 'projection_unavailable'
  | 'passage_unversioned' | 'source_mismatch' | 'chunk_unavailable' | 'chunk_mismatch'
  | 'no_evidence_overlap' | 'seed_budget' | 'source_unavailable';
/** An entry point to a later bounded structural read, never a completeness or truth claim. */
export type ArgumentSearchContextAttachment =
  | { status: 'available'; environmentId: string; pointer: ArgumentContextPointer }
  | { status: 'unavailable'; environmentId: string; reasonCode: ArgumentSearchContextReason };
export type ArgumentSearchResultWithContext<T> = T & { argumentContext: ArgumentSearchContextAttachment };
export interface ArgumentSearchBridgeOptions {
  /** Issued by the host alongside the independent scope captured by this store's runtime. */
  environmentId: string;
  store: Pick<PersistentArgumentProjectionStore, 'withActive'>;
  /** Raw, captured-root read of one saved note. Called ONLY inside withActive's source lock. */
  readSavedKnowledgeNote?: (noteId: string) => Promise<NoteItem | null>;
  /** Raw, captured-root read of one persisted L1 chunk. No snapshot wrapper or nested lock. */
  readSavedDocumentChunk?: (docId: string, chunkId: string) => Promise<DocumentChunk | null>;
}
export interface ArgumentSearchBridge {
  attachNoteHits<T extends NoteSearchResult>(hits: T[]): Promise<ArgumentSearchResultWithContext<T>[]>;
  attachDocumentHits<T extends DocumentSearchResult>(hits: T[]): Promise<ArgumentSearchResultWithContext<T>[]>;
}

function boundary(text: string, offset: number): boolean {
  const left = text.charCodeAt(offset - 1), right = text.charCodeAt(offset);
  return !(left >= 0xd800 && left <= 0xdbff && right >= 0xdc00 && right <= 0xdfff);
}
function validRange(text: string, start: unknown, end: unknown): start is number {
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && (start as number) >= 0
    && (end as number) > (start as number) && (end as number) <= text.length
    && boundary(text, start as number) && boundary(text, end as number);
}

/**
 * Add an optional structural pointer without changing search order, score, top-k or permission.
 * Never infer coordinates from snippets or equate historical graph IDs with projection nodes.
 * The store independently reads the current saved source and retained publication proof. The
 * pure pointer reader runs in the SAME withActive callback: no recursive store/source lock,
 * model request, parsing, publication, source qualification upgrade or user wait occurs here.
 * Application locks cannot prevent unobserved external-file ABA or cross-process writers.
 */
export function createArgumentSearchBridge(options: ArgumentSearchBridgeOptions): ArgumentSearchBridge {
  if (!options || typeof options.environmentId !== 'string' || !options.environmentId.length
    || options.environmentId.length > 300 || options.environmentId !== options.environmentId.trim()
    || /[\u0000-\u001f\u007f\\/]/u.test(options.environmentId)
    || typeof options.store?.withActive !== 'function'
    || options.readSavedKnowledgeNote !== undefined && typeof options.readSavedKnowledgeNote !== 'function'
    || options.readSavedDocumentChunk !== undefined && typeof options.readSavedDocumentChunk !== 'function') {
    throw new Error('argument_search_bridge_invalid_host');
  }
  const { environmentId, store, readSavedKnowledgeNote, readSavedDocumentChunk } = options;
  const unavailable = (reasonCode: ArgumentSearchContextReason): ArgumentSearchContextAttachment =>
    ({ status: 'unavailable', environmentId, reasonCode });
  async function pointerFor(result: ArgumentProjectionBuildResult, input: ArgumentProjectionBuildInput,
    start: number, end: number): Promise<ArgumentSearchContextAttachment> {
    const seeds = result.projection.nodes.filter(node => node.admission === 'admitted' && node.semanticStatus === 'reviewed'
      && node.evidence.some(span => span.start < end && span.end > start)).map(node => node.id).sort(compareArgumentContextIds);
    if (!seeds.length) return unavailable('no_evidence_overlap');
    // Reject rather than silently cut seeds and imply that the whole matching scope was read.
    if (seeds.length > ARGUMENT_SEARCH_BRIDGE_LIMITS.seedNodes) return unavailable('seed_budget');
    const pointer = await createArgumentContextPointer(result.projection, result.authority, input.scope, seeds);
    return { status: 'available', environmentId, pointer };
  }
  async function noteAttachment(hit: NoteSearchResult): Promise<ArgumentSearchContextAttachment> {
    if (hit.noteType !== 'knowledge' || hit.evidenceOrigin === 'user-argument-doc'
      || hit.matchKinds?.includes('argument') && !hit.matchKinds.includes('note')) return unavailable('unsupported_hit');
    if (!hit.passage || hit.passage.schemaVersion !== 2) return unavailable('passage_unversioned');
    if (!readSavedKnowledgeNote) return unavailable('source_unavailable');
    try {
      return await store.withActive({ kind: 'knowledge-note', entityId: hit.noteId }, async (result, input) => {
        const note = await readSavedKnowledgeNote(hit.noteId);
        if (!note || note.id !== hit.noteId || !isCurrentNoteReferenceHit(hit, [note])) return unavailable('source_mismatch');
        // Metadata-dependent passage hashes differ from canonical-body hashes. Reuse the one
        // source identity adapter rather than weakening metadata/version checks in this bridge.
        const saved = await adaptSavedKnowledgeNote({ note, rootScopeId: input.source.rootScopeId, scope: input.scope });
        if (await argumentContextHash(saved.source) !== await argumentContextHash(input.source)
          || note.content !== input.canonicalText) return unavailable('source_mismatch');
        const passage = hit.passage!;
        const exactChunk = buildNoteReferenceChunks(note).find(chunk => chunk.chunkId === passage.chunkId);
        if (!exactChunk || exactChunk.textStart !== passage.textStart || exactChunk.textEnd !== passage.textEnd
          || exactChunk.sectionPath !== passage.sectionPath || exactChunk.sectionKind !== passage.sectionKind
          || exactChunk.forcedSplit !== passage.forcedSplit
          || !validRange(input.canonicalText, passage.textStart, passage.textEnd)) return unavailable('chunk_mismatch');
        return pointerFor(result, input, passage.textStart, passage.textEnd);
      }) ?? unavailable('projection_unavailable');
    } catch { return unavailable('source_unavailable'); }
  }
  async function documentAttachment(hit: DocumentSearchResult): Promise<ArgumentSearchContextAttachment> {
    if (!readSavedDocumentChunk) return unavailable('source_unavailable');
    try {
      return await store.withActive({ kind: 'uploaded-document', entityId: hit.docId }, async (result, input) => {
        const chunk = await readSavedDocumentChunk(hit.docId, hit.chunkId);
        if (!chunk) return unavailable('chunk_unavailable');
        // Current L1 has no historical raw-file version field. This proves ONLY that the
        // currently saved L1 interval/content matches the current independently bound source,
        // not that an old search result carries a cryptographic original-version receipt.
        const start = chunk.textStart, end = chunk.textEnd;
        const originalSource = chunk.sourceBasis === 'structured-document-v1'
          && chunk.id.startsWith(`${hit.docId}:block:`) && chunk.schemaVersion === 1;
        if (chunk.docId !== hit.docId || chunk.id !== hit.chunkId || chunk.fileName !== hit.fileName
          || chunk.sectionPath !== hit.sectionPath || !(originalSource || chunk.schemaVersion === TEXT_SEGMENTATION_VERSION
            || chunk.schemaVersion === DOCUMENT_SEMANTIC_CHUNKING_VERSION)
          || !validRange(input.canonicalText, start, end)
          || chunk.content !== input.canonicalText.slice(start, end)
          || !Array.isArray(chunk.sourceBlockIds) || new Set(chunk.sourceBlockIds).size !== chunk.sourceBlockIds.length) {
          return unavailable('chunk_mismatch');
        }
        const expectedBlockIds = input.hierarchy.blocks.filter(block => block.start < end! && block.end > start!).map(block => block.id);
        if (chunk.sourceBlockIds.length !== expectedBlockIds.length
          || chunk.sourceBlockIds.some((id, index) => id !== expectedBlockIds[index])) return unavailable('chunk_mismatch');
        return pointerFor(result, input, start!, end!);
      }) ?? unavailable('projection_unavailable');
    } catch { return unavailable('source_unavailable'); }
  }
  async function attach<T>(hitsValue: T[], read: (hit: T) => Promise<ArgumentSearchContextAttachment>): Promise<ArgumentSearchResultWithContext<T>[]> {
    // Capture before the first await; later caller mutation cannot turn a reference hit into
    // another source or retain an injected stale argumentContext value.
    const hits = structuredClone(hitsValue), output: ArgumentSearchResultWithContext<T>[] = [];
    for (let index = 0; index < hits.length; index++) {
      const argumentContext = index >= ARGUMENT_SEARCH_BRIDGE_LIMITS.hits ? unavailable('hit_budget') : await read(hits[index]);
      output.push({ ...hits[index], argumentContext });
    }
    return output;
  }
  return {
    attachNoteHits: <T extends NoteSearchResult>(hits: T[]) => attach<T>(hits, noteAttachment),
    attachDocumentHits: <T extends DocumentSearchResult>(hits: T[]) => attach<T>(hits, documentAttachment),
  };
}
