import type { NoteItem } from '../types';

/** Only changed notes cross the desktop save boundary. `before` is the last
 * acknowledged renderer baseline, not the latest visible in-flight draft. */
export interface VaultNotesDelta {
  upserts: Array<{ note: NoteItem; before: NoteItem | null }>;
  removed: Array<{ id: string; before: NoteItem }>;
  /** Re-resolved alias/title links for otherwise unchanged peers. No peer body
   * crosses IPC; the native directory checks this source metadata baseline. */
  derivedLinks?: Array<{ id: string; links: string[]; expectedUpdatedAt: string; expectedTitle: string }>;
  /** Explicit selected knowledge-object migration; never permission to rewrite peers. */
  knowledgeMerges?: Array<{ sourceId: string; targetId: string }>;
}
