import type { FlowSession, NoteItem } from '../../types.ts';
import type { ArgDoc } from '../argumentDoc/types.ts';
import type { LearningReviewPatch, LearningReviewRecord, LearningReviewStatus } from './types.ts';
import { learningReviewMarker, hasLearningReviewMarker } from './noteContent.ts';
import { migrateLearningContent } from './migration.ts';
import { flowReviewAdmission, hasLearningReviewContent, flowReviewContentText } from './reviewAdmission';
import { flowMasteryTextKey } from '../masteryShadow/sourceKey';

export function learningTimeTitle(startedAt: string, endedAt: string): string {
  const format = (value: string) => new Date(value).toLocaleString('sv-SE', { hour12: false }).slice(0, 16);
  const start = format(startedAt), end = format(endedAt);
  return start.slice(0, 10) === end.slice(0, 10) ? `${start}–${end.slice(11)}` : `${start}–${end}`;
}

function exposeRecord(note: NoteItem, id: string): string {
  const marker = learningReviewMarker(id);
  if (hasLearningReviewMarker(note.content, id)) return note.content;
  return `${note.content}${note.content.trim() ? '\n\n' : ''}${marker}`;
}

/** 纯事务投影：总从最新笔记合并，暂存阶段不替换正文或插入半完成图。 */
export function saveFlowReviewRecord(
  latest: NoteItem, session: FlowSession, status: LearningReviewStatus, expose = false,
): NoteItem {
  if (latest.id !== session.noteId) throw new Error('学习记录目标不匹配');
  const admission = flowReviewAdmission(session);
  if (!admission.hasContent) {
    // Question cards are independent artifacts. A preview/empty microphone
    // session must not create a record, migrate a note or erase its old summary.
    if (session.questions !== undefined && JSON.stringify(session.questions) !== JSON.stringify(latest.questions || []))
      return { ...latest, questions: session.questions };
    return latest;
  }
  const note = migrateLearningContent(latest);
  const records = note.learningReviewRecords || [];
  const previous = records.find((item) => item.sessionId === session.id);
  const raw = admission.restatement;
  const record: LearningReviewRecord = {
    schemaVersion: 1, id: previous?.id || session.id, sessionId: session.id,
    projectNoteId: note.id, rootProjectId: session.rootProjectId || previous?.rootProjectId || note.id,
    textbookRevisionId: previous?.textbookRevisionId || session.textbookRevisionId || note.textbook?.revisionId,
    startedAt: previous?.startedAt || session.startedAt, endedAt: previous?.endedAt || session.endedAt,
    title: previous?.title || learningTimeTitle(session.startedAt, session.endedAt),
    userEditedTitle: previous?.userEditedTitle || false,
    rawRestatement: previous?.rawRestatement ?? raw,
    editedRestatement: previous?.userEditedRestatement ? previous.editedRestatement : raw,
    userEditedRestatement: previous?.userEditedRestatement || false,
    summary: session.summary || previous?.summary || '', analysisSummary: previous?.analysisSummary, episodeId: session.id,
    masteryAssessment: previous?.masteryAssessment,
    masteryInputKey: previous?.masteryInputKey || flowMasteryTextKey(session.incrementalText || session.restateText || ''),
    argumentDocIds: previous?.argumentDocIds || [],
    ...(previous?.argumentRestatementKey ? { argumentRestatementKey: previous.argumentRestatementKey } : {}),
    status: previous?.status === 'completed' ? 'completed' : status,
    error: previous?.error, expanded: previous?.expanded,
    createdAt: previous?.createdAt || session.endedAt, updatedAt: session.endedAt,
  };
  const content = expose ? exposeRecord(note, record.id) : note.content;
  return {
    ...note, learningReviewRecords: [...records.filter((item) => item.id !== record.id), record],
    content,
    questions: session.questions ?? note.questions, flowSummary: session.summary || '', updatedAt: content === latest.content ? latest.updatedAt : session.endedAt,
  };
}

export function finishFlowReviewRecord(
  note: NoteItem, sessionId: string, status: LearningReviewStatus, error?: string, analysisSummary?: string,
): NoteItem {
  const record = note.learningReviewRecords?.find((item) => item.sessionId === sessionId);
  if (!record) throw new Error('找不到本次已暂存的学习记录');
  if (!hasLearningReviewContent(record)) return note;
  const now = new Date().toISOString();
  const content = exposeRecord(note, record.id);
  return {
    ...note, content, updatedAt: content === note.content ? note.updatedAt : now,
    learningReviewRecords: note.learningReviewRecords!.map((item) => item.id === record.id
      ? { ...item, status: item.status === 'completed' ? 'completed' : status, error,
        ...(analysisSummary ? { analysisSummary: analysisSummary.replace(/\s+/gu, ' ').trim().slice(0, 240) } : {}),
        updatedAt: now } : item),
  };
}

/** 与原图文档同一次持久化：重试/图编辑只更新原文档，标题、原始转写不回滚。 */
export function saveReviewArgument(note: NoteItem, doc: ArgDoc, sessionId?: string, sourceRestatement?: string): NoteItem {
  const bound = sessionId
    ? note.learningReviewRecords?.find((item) => item.sessionId === sessionId)
    : note.learningReviewRecords?.find((item) => item.argumentDocIds.includes(doc.doc_id));
  if (sessionId && !bound) throw new Error('本次学习记录已失效，不能将图写到其他复盘');
  if (bound && bound.argumentDocIds.length && !bound.argumentDocIds.includes(doc.doc_id)) {
    throw new Error('本次复盘已有结构图，请更新原图而不是新建另一张图');
  }
  if (note.learningReviewRecords?.some((item) => item.id !== bound?.id && item.argumentDocIds.includes(doc.doc_id))) {
    throw new Error('结构图已属于另一条学习记录，不能重新绑定');
  }
  const argumentDocs = [...(note.argumentDocs || []).filter((item) => item.doc_id !== doc.doc_id), doc];
  let content = note.content;
  if (bound) content = exposeRecord(note, bound.id);
  else {
    const marker = `<ArgumentBlock id="${doc.doc_id}" />`;
    if (!note.argumentDocs?.some((item) => item.doc_id === doc.doc_id)) {
      content += `${content.trim() ? '\n\n' : ''}${marker}`;
    }
  }
  return {
    ...note, content, argumentDocs, updatedAt: doc.updated_at,
    learningReviewRecords: note.learningReviewRecords?.map((item) => item.id === bound?.id
      ? { ...item, argumentDocIds: [...new Set([...item.argumentDocIds, doc.doc_id])], status: 'completed',
        ...(sourceRestatement === undefined ? {} : { argumentRestatementKey: flowMasteryTextKey(flowReviewContentText(sourceRestatement)) }),
        error: undefined, updatedAt: doc.updated_at } : item),
  };
}

export function patchLearningReviewRecord(note: NoteItem, id: string, patch: LearningReviewPatch): NoteItem {
  const record = note.learningReviewRecords?.find((item) => item.id === id && item.projectNoteId === note.id);
  if (!record) throw new Error('学习记录不存在');
  const title = patch.title?.trim();
  if (patch.title !== undefined && !title) throw new Error('学习记录标题不能为空');
  return {
    ...note, learningReviewRecords: note.learningReviewRecords!.map((item) => item.id === id ? {
      ...item,
      ...(title !== undefined ? { title, userEditedTitle: true } : {}),
      ...(patch.editedRestatement !== undefined ? { editedRestatement: patch.editedRestatement, userEditedRestatement: true } : {}),
      ...(patch.expanded !== undefined ? { expanded: patch.expanded } : {}),
      updatedAt: new Date().toISOString(),
    } : item),
  };
}

export function detachReviewArgument(note: NoteItem, docId: string): NoteItem {
  return { ...note, learningReviewRecords: note.learningReviewRecords?.map((item) => item.argumentDocIds.includes(docId) ? {
    ...item, argumentDocIds: item.argumentDocIds.filter((id) => id !== docId), updatedAt: new Date().toISOString(),
  } : item) };
}
