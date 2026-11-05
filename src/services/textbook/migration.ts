import type { NoteItem } from '../../types.ts';
import { learningReviewMarker, hasLearningReviewMarker } from './noteContent.ts';
import { hasLearningReviewContent } from './reviewAdmission';

/** 不从标题/日期/邻近位置猜测旧复述与旧图关系，也不删除旧入口。 */
export function migrateLearningContent(note: NoteItem): NoteItem {
  if (note.noteType !== 'project' || note.learningContentMigration?.schemaVersion === 1) return note;
  return {
    ...note,
    learningContentMigration: {
      schemaVersion: 1, originalContent: note.content,
      originalArgumentDocIds: (note.argumentDocs || []).map((doc) => doc.doc_id),
    },
  };
}

/** 重启时使已暂存但尚未插入正文的记录可见；不改分析状态、不编造或配对旧图。 */
export function recoverLearningReviewReferences(note: NoteItem): NoteItem {
  if (note.noteType !== 'project') return note;
  const missing = (note.learningReviewRecords || []).filter((record) => record.schemaVersion === 1
    && record.projectNoteId === note.id && ['pending_analysis', 'analyzed'].includes(record.status)
    && hasLearningReviewContent(record)
    && !hasLearningReviewMarker(note.content, record.id));
  if (!missing.length) return note;
  return { ...note, content: `${note.content}${note.content.trim() ? '\n\n' : ''}${missing.map((record) => learningReviewMarker(record.id)).join('\n\n')}` };
}
