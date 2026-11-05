import { NoteItem } from '../types';
import { resolveNoteByTitleOrAlias } from './noteResolver';
import { masteryReadMode, readKnowledgeMastery } from './masteryReadModel';
import { isLearningProject } from './projectRole';

export function getChildProjectNotes(projectId: string, allNotes: NoteItem[]): NoteItem[] {
  return allNotes.filter((note) => note.noteType === 'project' && note.parentId === projectId);
}

/** Learning leaf, not a structural directory leaf; reference children remain ordinary notes. */
export function isLeafProjectNote(projectId: string, allNotes: NoteItem[]): boolean {
  const project = allNotes.find((note) => note.id === projectId && note.noteType === 'project');
  return isLearningProject(project) && getChildProjectNotes(projectId, allNotes).filter(isLearningProject).length === 0;
}

export function getProjectNotesInScope(rootProjectId: string, allNotes: NoteItem[]): NoteItem[] {
  const projects: NoteItem[] = [];
  const visited = new Set<string>();
  const walk = (projectId: string) => {
    if (visited.has(projectId)) return;
    visited.add(projectId);
    const project = allNotes.find((note) => note.id === projectId && note.noteType === 'project');
    if (!project) return;
    projects.push(project);
    getChildProjectNotes(projectId, allNotes).forEach((child) => walk(child.id));
  };
  walk(rootProjectId);
  return projects;
}

export function getLeafProjectNotesInScope(rootProjectId: string, allNotes: NoteItem[]): NoteItem[] {
  return getLearningProjectNotesInScope(rootProjectId, allNotes)
    .filter((project) => isLeafProjectNote(project.id, allNotes));
}

/** Plan/learning views only; retain getProjectNotesInScope for structural safety checks. */
export function getLearningProjectNotesInScope(rootProjectId: string, allNotes: NoteItem[]): NoteItem[] {
  if (!isLearningProject(allNotes.find(note => note.id === rootProjectId))) return [];
  return getProjectNotesInScope(rootProjectId, allNotes).filter(isLearningProject);
}

/**
 * 收集项目及后代项目显式链接的全局知识点。
 * 同一个知识点可被多个项目复用；parentId 仅作为旧数据兼容关系，不再代表唯一归属。
 */
export function collectProjectKnowledgeNotes(projectId: string, allNotes: NoteItem[]): NoteItem[] {
  const visitedProjects = new Set<string>();
  const collectedIds = new Set<string>();
  const result: NoteItem[] = [];
  const knowledgeNotes = allNotes.filter((note) => note.noteType === 'knowledge');

  const collect = (note: NoteItem | undefined) => {
    if (!note || note.noteType !== 'knowledge' || collectedIds.has(note.id)) return;
    collectedIds.add(note.id);
    result.push(note);
  };

  const walkProject = (id: string) => {
    const project = allNotes.find((note) => note.id === id && note.noteType === 'project');
    if (!isLearningProject(project) || visitedProjects.has(id)) return;
    visitedProjects.add(id);

    for (const target of project.links || []) {
      collect(resolveNoteByTitleOrAlias(target, knowledgeNotes));
    }

    for (const child of allNotes.filter((note) => note.parentId === id)) {
      if (child.noteType === 'project') walkProject(child.id);
      else collect(child); // 兼容旧版把知识点直接挂在项目下的数据。
    }
  };

  walkProject(projectId);
  return result;
}

/**
 * 按 conceptMastery 排序，取掌握度最高的作「锚点」、最低的作「薄弱点」。
 * 掌握度未定义时按 50（中性）处理。
 */
export function selectAnchorsAndWeakPoints(
  knowledgeNotes: NoteItem[],
  anchorCount = 3,
  weakCount = 5,
): { anchors: NoteItem[]; weakPoints: NoteItem[] } {
  if (knowledgeNotes.length === 0) {
    return { anchors: [], weakPoints: [] };
  }
  if (masteryReadMode() === 'current') {
    const assessed = knowledgeNotes.map(note => ({ note, view: readKnowledgeMastery(note) }));
    return {
      anchors: assessed.filter(item => item.view.confirmed && item.view.contentStatus === 'ready')
        .slice(0, anchorCount).map(item => item.note),
      weakPoints: assessed.filter(item => item.view.contentStatus === 'ready' && !item.view.confirmed)
        .sort((a, b) => b.view.reviewPriority - a.view.reviewPriority || a.note.title.localeCompare(b.note.title))
        .slice(0, weakCount).map(item => item.note),
    };
  }

  const scored = knowledgeNotes.map((note) => ({
    note,
    mastery: note.dsrState?.conceptMastery ?? 50,
  }));

  // 降序：掌握度高的在前（锚点候选）
  const desc = [...scored].sort((a, b) => b.mastery - a.mastery);
  const anchors = desc.slice(0, Math.min(anchorCount, desc.length)).map((s) => s.note);

  // 升序：掌握度低的在前（薄弱点候选）
  const asc = [...scored].sort((a, b) => a.mastery - b.mastery);
  const weakPoints = asc.slice(0, Math.min(weakCount, asc.length)).map((s) => s.note);

  return { anchors, weakPoints };
}

/** 项目复习共用上下文：用掌握较牢的知识点带动薄弱点。 */
export function buildProjectReviewKnowledgeContext(project: NoteItem, allNotes: NoteItem[]): string {
  const knowledgeNotes = collectProjectKnowledgeNotes(project.id, allNotes);
  const { anchors, weakPoints } = selectAnchorsAndWeakPoints(knowledgeNotes);
  const anchorIds = new Set(anchors.map((note) => note.id));
  const weakOnly = weakPoints.filter((note) => !anchorIds.has(note.id));
  const parts = [`项目：${project.title}`];
  if (anchors.length) parts.push(`锚点知识点（掌握较牢）：${anchors.map((note) => note.title).join('、')}`);
  if (weakOnly.length) parts.push(masteryReadMode() === 'current'
    ? `待评估/待确认/待加强（不等同于不掌握）：${weakOnly.map(note => `${note.title}（${readKnowledgeMastery(note).displayLabel}）`).join('、')}`
    : `薄弱知识点（待加强）：${weakOnly.map((note) => note.title).join('、')}`);
  return parts.join('\n');
}
