import type { ConceptSource, NoteItem } from '../types';
import { extractWikiTargets } from './planAdjustmentService';
import { parseWikiLinkTarget } from './noteResolver';
import { hasTextbookBoundaryMarker, projectPlanningContent, stripTextbookRegion } from './textbook/noteContent';
import { conceptNoteBaseline } from './conceptBatchTypes';
import { isUnfilledWikiKnowledge } from './wikiKnowledge';

export interface ConceptBatchRequest { projectNoteId: string; source: ConceptSource; allowCloud: boolean; titles?: string[];
  evidenceScope?: import('./conceptFillService').ConceptEvidenceScope; }
export const wikiTitleKey = (title: string) => title.trim().normalize('NFKC').toLocaleLowerCase();
export function findWikiKnowledge(title: string, notes: NoteItem[]): NoteItem | undefined {
  const key = wikiTitleKey(title);
  const matches = notes.filter(note => [note.title, ...(note.aliases || [])].some(name => wikiTitleKey(name) === key));
  if (matches.length > 1) throw new Error(`Wiki“${title}”匹配多篇笔记，请先消除同名或别名歧义`);
  return matches[0];
}
export function previewWikiConceptBatch(notes: NoteItem[], request: ConceptBatchRequest) {
  if (!request || typeof request.projectNoteId !== 'string' || !['rag', 'browser', 'hybrid'].includes(request.source)
    || typeof request.allowCloud !== 'boolean') throw new Error('请提供稳定项目 ID、证据来源及远程模型许可');
  const project = notes.find(note => note.id === request.projectNoteId && note.noteType === 'project');
  if (!project) throw new Error('指定项目已不存在，请重新选择');
  if ((!project.textbook && hasTextbookBoundaryMarker(project.content)) || !stripTextbookRegion(project.content, project.textbook).valid) {
    throw new Error('项目教材边界异常，未猜测 Wiki 处理范围');
  }
  // Reuse task-aware coordinates: no textbook, fenced/indented code or image embeds.
  const content = projectPlanningContent(project.content, project.textbook).replace(/!\[\[[^\]]+\]\]/gu, '')
    .replace(/<!--[\s\S]*?-->/gu, '').replace(/`+[^`\n]*`+/gu, '');
  const titles = [...new Map(extractWikiTargets(content, notes).map(raw => {
    const title = parseWikiLinkTarget(raw, notes).trim(); return [wikiTitleKey(title), title] as const;
  })).values()].filter(Boolean);
  if (request.titles !== undefined && (!Array.isArray(request.titles) || !request.titles.length || request.titles.length > 30
    || request.titles.some(title => typeof title !== 'string' || !titles.some(found => wikiTitleKey(found) === wikiTitleKey(title))))) {
    throw new Error('指定条目必须来自此项目真实 Wiki 链接，不能扩大到其它笔记');
  }
  const selected = request.titles ? new Set(request.titles.map(wikiTitleKey)) : null;
  const seenIds = new Set<string>();
  const candidates = titles.filter(title => !selected || selected.has(wikiTitleKey(title))).map(title => {
    if (title.length > 120 || /[\r\n\[\]]/u.test(title)) throw new Error('Wiki 名称过长或无效，请先修正链接');
    const note = findWikiKnowledge(title, notes);
    const duplicate = !!note && seenIds.has(note.id);
    if (note) seenIds.add(note.id);
    const action = duplicate ? 'skip-duplicate' : !note ? 'create-and-fill'
      : note.noteType !== 'knowledge' ? 'skip-project' : !isUnfilledWikiKnowledge(note) ? 'skip-filled' : 'fill';
    return { title, action, ...(note ? { noteId: note.id } : {}),
      ...(note && action === 'fill' ? { baseline: conceptNoteBaseline(note) } : {}) };
  });
  if (!candidates.length) throw new Error('所选项目正文中没有可处理的 Wiki 知识点链接');
  if (candidates.length > 30) throw new Error('单批最多 30 个 Wiki 条目，请先从预览中指定较小范围');
  return { projectNoteId: project.id, projectTitle: project.title, source: request.source, allowCloud: request.allowCloud,
    candidates, eligible: candidates.filter(item => ['create-and-fill', 'fill'].includes(item.action)).length };
}
