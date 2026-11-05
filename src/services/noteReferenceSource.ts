import type { NoteRagIndexInput, NoteReferenceSource } from '../types';
import { referenceNoteContent } from './ragSourcePolicy';

/** Metadata is provenance only, not a certificate that a citation supports its sentence. */
export function noteReferenceSources(input: NoteRagIndexInput): NoteReferenceSource[] {
  if (!Array.isArray(input.referenceSources)) return [];
  return input.referenceSources.slice(0, 30).flatMap((source) => {
    if (!source || typeof source !== 'object' || typeof source.title !== 'string') return [];
    const text = (value: unknown, max: number) => typeof value === 'string' ? value.slice(0, max) : undefined;
    return [{ title: source.title.slice(0, 500), sourceId: text(source.sourceId, 80),
      type: ['web', 'document', 'note'].includes(source.type || '') ? source.type : undefined,
      url: text(source.url, 2000), entityId: text(source.entityId, 500), sectionPath: text(source.sectionPath, 1000),
      snippet: text(source.snippet, 500) }];
  });
}
/** Share the exact serialization between the local store, IPC freshness guard and editor status. */
export function noteReferenceSourceDescriptor(input: NoteRagIndexInput) {
  return { noteType: input.noteType, title: input.title, content: referenceNoteContent(input),
    referenceSources: noteReferenceSources(input) };
}

/** Browser-safe equivalent of the background index's source hash; performs no index writes. */
export async function noteReferenceSourceFingerprint(input: NoteRagIndexInput): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(noteReferenceSourceDescriptor(input))));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
