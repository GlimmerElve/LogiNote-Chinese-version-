import type { NoteItem } from '../../types';
import { isLeafProjectNote } from '../knowledgePointSelector';
import { buildHomeScheduledTasks, compareHomePendingTasks, homeLocalDate, homeCalendarDay } from '../homepage/homeTaskScheduling';
import { extractProjectTasks } from './resourceDraftService';
import { projectDocumentBindings } from '../projectResourceScope';
import { previewWikiConceptBatch } from '../conceptBatchScope';

export function projectStudyTasks(project: NoteItem): string[] {
  return extractProjectTasks(project.content, project.textbook).filter(task => task.trim() !== project.title.trim());
}
export function projectPreparationState(project: NoteItem, notes: NoteItem[]) {
  let candidates: ReturnType<typeof previewWikiConceptBatch>['candidates'] = [], wikiError: string | undefined;
  try { candidates = previewWikiConceptBatch(notes, { projectNoteId: project.id, source: 'rag', allowCloud: false }).candidates; }
  catch (error) { const text = error instanceof Error ? error.message : 'Wiki 前置状态不可读'; if (!text.includes('没有可处理')) wikiError = text; }
  return { projectNoteId: project.id, title: project.title, projectRole: project.projectRole || 'learning', leaf: isLeafProjectNote(project.id, notes),
    studyTaskCount: projectStudyTasks(project).length, textbookReady: !!project.textbook,
    wiki: candidates.map(item => ({ title: item.title, noteId: item.noteId, action: item.action })), ...(wikiError ? { wikiError } : {}),
    documentBindings: projectDocumentBindings(project, notes) };
}
/** Same actionDate/start/completion/active-root rules as Home, without the old 50-row truncation. */
export function todayLearningProjects(notes: NoteItem[], today = homeLocalDate()) {
  if (homeCalendarDay(today) === null) throw new Error('日期格式无效');
  const byId = new Map(notes.map(note => [note.id, note]));
  const leafIds = new Set(notes.filter(note => isLeafProjectNote(note.id, notes)).map(note => note.id));
  const ids = [...new Set(buildHomeScheduledTasks(notes, today).filter(row => !row.completed && row.launch?.actionDate === today
    && leafIds.has(row.launch.noteId)).sort(compareHomePendingTasks).map(row => row.launch!.noteId))];
  return { today, total: ids.length, projects: ids.map(id => projectPreparationState(byId.get(id)!, notes)) };
}
