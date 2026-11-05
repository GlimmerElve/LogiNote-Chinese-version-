import type { NoteItem } from '../types';

/** Organizational children are not necessarily learning-plan nodes. Legacy projects stay learning. */
export function isReferenceProject(note: NoteItem | undefined): boolean {
  return note?.noteType === 'project' && note.projectRole === 'reference';
}

export function isLearningProject(note: NoteItem | undefined): note is NoteItem & { noteType: 'project'; projectRole?: 'learning' } {
  return note?.noteType === 'project' && note.projectRole !== 'reference';
}

export function assertProjectRole(note: NoteItem): void {
  if (note.projectRole === undefined) return;
  if (note.noteType !== 'project' || !['learning', 'reference'].includes(note.projectRole)) throw new Error('项目用途无效');
  if (isReferenceProject(note) && (note.planMeta || note.textbook || note.dueDates.length
    || /<(?:TextbookBoundary|LearningReviewBlock|ArgumentBlock)\b/u.test(note.content))) {
    throw new Error('资料型项目只保存普通正文，不能携带计划、任务属性或受管学习内容');
  }
}
