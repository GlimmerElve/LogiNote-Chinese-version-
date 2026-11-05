import type { NoteItem } from '../../types';
import { resolveNoteByTitleOrAlias } from '../noteResolver';
import { getProjectCompletionTarget } from '../learningCompletion';
import { getScheduledProjectChildren, getScheduledProjectDeadline, getScheduledProjectState } from '../planProjectState';

function derive(note: NoteItem, allNotes: NoteItem[], projectContextId?: string | null) {
  const ancestorTitles: string[] = [], ancestorIds = new Set<string>();
  let ancestor = note;
  const byId = new Map(allNotes.map(item => [item.id, item]));
  while (ancestor.parentId && !ancestorIds.has(ancestor.parentId)) {
    ancestorIds.add(ancestor.parentId);
    const parent = byId.get(ancestor.parentId);
    if (!parent) break;
    ancestorTitles.unshift(parent.title); ancestor = parent;
  }
  const argumentDocs = [...(note.argumentDocs || [])].sort((a, b) => new Date(b.updated_at || b.created_at).getTime() - new Date(a.updated_at || a.created_at).getTime());
  const projectNotes = allNotes.filter(item => item.noteType === 'project');
  const knowledgeNotes = allNotes.filter(item => item.noteType === 'knowledge');
  const resolveLinks = (titles: string[]) => {
    const seen = new Set<string>();
    return titles.flatMap(title => {
      const found = resolveNoteByTitleOrAlias(title, knowledgeNotes);
      if (!found || seen.has(found.id)) return [];
      seen.add(found.id); return [found];
    });
  };
  const directKnowledgeNotes = resolveLinks(note.links || []).filter(item => item.id !== note.id);
  const explicit = projectNotes.find(item => item.id === projectContextId);
  const parent = projectNotes.find(item => item.id === note.parentId);
  const linked = note.noteType === 'knowledge'
    ? projectNotes.find(project => resolveLinks(project.links || []).some(item => item.id === note.id)) : undefined;
  let rootProject: NoteItem | null = (note.noteType === 'project' ? note : explicit || parent || linked) ?? null;
  if (rootProject?.noteType !== 'project') rootProject = null;
  const seen = new Set<string>();
  while (rootProject?.parentId && !seen.has(rootProject.id)) {
    seen.add(rootProject.id);
    const next = projectNotes.find(item => item.id === rootProject!.parentId);
    if (!next || seen.has(next.id)) break;
    rootProject = next;
  }
  const linkedTitles: string[] = [], visited = new Set<string>(), pending = rootProject ? [rootProject] : [];
  const children = new Map<string, NoteItem[]>();
  for (const project of projectNotes) if (project.parentId) {
    if (!children.has(project.parentId)) children.set(project.parentId, []);
    children.get(project.parentId)!.push(project);
  }
  for (let index = 0; index < pending.length; index++) {
    const project = pending[index];
    if (visited.has(project.id)) continue;
    visited.add(project.id); linkedTitles.push(...(project.links || [])); pending.push(...(children.get(project.id) || []));
  }
  const scheduledChildren = note.noteType === 'project' && getScheduledProjectDeadline(note) ? getScheduledProjectChildren(allNotes, note.id) : [];
  return { ancestorTitles, argumentDocs, rootProject, directKnowledgeNotes, rootKnowledgeNotes: resolveLinks(linkedTitles),
    knowledgeProjectContextId: rootProject?.id || projectContextId || undefined,
    completionTarget: getProjectCompletionTarget(allNotes, note.id), scheduledChildren,
    childProgress: scheduledChildren.length ? getScheduledProjectState(allNotes, note.id) : null,
    completedChildren: scheduledChildren.filter(child => getScheduledProjectState(allNotes, child.id).completed).length };
}

const contexts = new WeakMap<NoteItem[], Map<string, { note: NoteItem; value: ReturnType<typeof derive> }>>();
/** Draft typing does not change the published array, so local renders reuse this result. */
export function getNoteEditorContext(note: NoteItem, allNotes: NoteItem[], projectContextId?: string | null) {
  let cache = contexts.get(allNotes);
  if (!cache) { cache = new Map(); contexts.set(allNotes, cache); }
  const key = JSON.stringify([note.id, projectContextId]);
  let context = cache.get(key);
  if (!context || context.note !== note) { context = { note, value: derive(note, allNotes, projectContextId) }; cache.set(key, context); }
  return context.value;
}
