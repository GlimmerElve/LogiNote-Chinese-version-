import type { NoteItem } from '../../types';
import { setLearningCompletion, type LearningCompletionTarget } from '../learningCompletion';
import { recalculateBacklinks } from '../storage';

interface CompletionWriter {
  readNotes: () => NoteItem[];
  saveNotes: (notes: NoteItem[]) => Promise<unknown>;
  applyNotes: (notes: NoteItem[]) => void;
  beforeSave?: () => void;
}

/** Publish completion only after a real save; rebase if a note changed during the write. */
export async function commitLearningCompletion(writer: CompletionWriter, target: LearningCompletionTarget, completed: boolean): Promise<void> {
  let wroteCandidate = false;
  try {
    for (;;) {
      const base = writer.readNotes();
      const changed = setLearningCompletion(base, target, completed);
      const next = changed === base ? base : recalculateBacklinks(changed);
      writer.beforeSave?.();
      await writer.saveNotes(next);
      wroteCandidate = true;
      if (writer.readNotes() !== base) continue;
      writer.applyNotes(next);
      return;
    }
  } catch (error) {
    // A concurrent edit may invalidate a previously saved candidate. Restore the latest
    // in-memory version when possible; callers retain it for retry if storage is down.
    if (wroteCandidate) {
      try { await writer.saveNotes(writer.readNotes()); } catch { /* Keep the original error and pending edits. */ }
    }
    throw error;
  }
}
