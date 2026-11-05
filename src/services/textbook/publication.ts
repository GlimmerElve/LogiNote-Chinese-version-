import type { NoteItem } from '../../types';
import { recalculateBacklinks } from '../storage';
import { enqueueLearningWrite, type LearningWriteQueue } from '../ui/learningWriteQueue';
import { applyTextbookPublication } from './generation';
import type { TextbookPublishInput } from './generationTypes';

export interface TextbookPublicationWriter {
  readNotes: () => NoteItem[];
  saveNotes: (notes: NoteItem[]) => Promise<unknown>;
  applyNotes: (notes: NoteItem[]) => void;
  beforeSave?: () => void;
  preflightMarkdown?: (markdown: string) => void | Promise<void>;
}

/** A candidate remains private until its durable save succeeds against the latest visible snapshot. */
export async function commitTextbookPublication(writer: TextbookPublicationWriter, input: TextbookPublishInput): Promise<NoteItem> {
  let wroteCandidate = false;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const base = writer.readNotes();
      const target = base.find((note) => note.id === input.job.spec.projectNoteId);
      if (!target) throw new Error('教材目标项目已不存在，未写入其他项目');
      // Once persistence starts, a late Stop must not interrupt safe commit/rebase.
      const publication = wroteCandidate ? { ...input, signal: undefined } : input;
      const published = await applyTextbookPublication(target, base, publication);
      await writer.preflightMarkdown?.(published.content);
      if (writer.readNotes() !== base) continue;
      if (!wroteCandidate) input.signal?.throwIfAborted();
      const next = recalculateBacklinks(base.map((note) => note.id === target.id ? published : note));
      writer.beforeSave?.();
      await writer.saveNotes(next);
      wroteCandidate = true;
      if (writer.readNotes() !== base) continue;
      writer.applyNotes(next);
      return next.find((note) => note.id === target.id)!;
    }
    throw new Error('保存期间笔记持续变化，请稍后重试；未覆盖最新编辑');
  } catch (error) {
    // If a previously saved candidate became invalid, compensate with the current visible
    // snapshot. Never restore the original base and lose independent edits/review records.
    if (wroteCandidate) {
      try { await writer.saveNotes(writer.readNotes()); } catch { /* Caller keeps latest visible notes pending. */ }
    }
    throw error;
  }
}

export function publishTextbookAfterSave(queue: LearningWriteQueue, writer: TextbookPublicationWriter, input: TextbookPublishInput): Promise<NoteItem> {
  return enqueueLearningWrite(queue, () => commitTextbookPublication(writer, input));
}
