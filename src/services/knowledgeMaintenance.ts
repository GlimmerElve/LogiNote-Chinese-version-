import type { NoteItem } from '../types';
import type { WorkspaceNoteChange } from './agent/workspaceOperations';
import { findNotesByTitleOrAlias, resolveNoteByTitleOrAlias } from './noteResolver';
import { knowledgeName } from './knowledgeLifecycle';

export interface KnowledgeMergeInput { sourceIds: string[]; targetId?: string; targetTitle?: string }
export function selectedKnowledge(notes: readonly NoteItem[], ids: readonly string[]): NoteItem[] {
  if (!Array.isArray(ids) || !ids.length || ids.length > 30 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id)) throw Error('请选择1至30篇不同的知识点笔记');
  const byId = new Map(notes.map(note => [note.id, note]));
  return ids.map(id => { const note = byId.get(id); if (!note || note.noteType !== 'knowledge') throw Error('只能整理明确指定且仍存在的知识点笔记');
    if (notes.some(child => child.parentId === id)) throw Error('知识点下还有其他笔记，请先移动下级内容'); return note; });
}
export function prepareKnowledgeDeletion(notes: readonly NoteItem[], ids: string[]): WorkspaceNoteChange {
  const before = selectedKnowledge(notes, ids);
  return { kind: 'remove', knowledgeOnly: true, label: `删除 ${before.length} 篇知识点笔记`, before, after: [] };
}
function mergeId(text: string) { let a = 2166136261, b = 2246822519; for (const char of text) { a = Math.imul(a ^ char.charCodeAt(0), 16777619); b = Math.imul(b ^ char.charCodeAt(0), 3266489917); }
  return `knowledge-merge-${(a >>> 0).toString(16)}${(b >>> 0).toString(16)}`; }
/** Preserve original paragraphs, formulas and code. Only heading depth is moved
 * under an explicit source section; no semantic rewriting or model call. */
function sourceSection(note: NoteItem) {
  if (note.textbook || note.argumentDocs?.length || /<(?:TextbookBoundary|LearningReviewBlock|ArgumentBlock)\b/u.test(note.content)) throw Error('所选笔记包含受管教材或分析块，请先使用对应模块整理');
  let fence = '';
  const body = note.content.split('\n').map((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) { if (!fence) fence = marker; else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''; return line; }
    if (fence) return line;
    const heading = /^(#{1,6})\s+(.*)$/u.exec(line);
    if (!heading) return line;
    if (index === 0 && heading[1] === '#' && knowledgeName(heading[2]) === knowledgeName(note.title)) return '';
    return '#'.repeat(Math.min(6, heading[1].length + 2)) + ' ' + heading[2];
  }).join('\n').trim();
  return `## ${note.title}\n\n${body}`;
}
export function prepareKnowledgeMerge(notes: readonly NoteItem[], input: KnowledgeMergeInput, at = new Date().toISOString()): WorkspaceNoteChange {
  const sources = selectedKnowledge(notes, input.sourceIds);
  let target = input.targetId ? selectedKnowledge(notes, [input.targetId])[0] : undefined;
  const requested = input.targetTitle?.trim();
  if (input.targetTitle !== undefined && (!requested || requested === '#' || requested.length > 120 || /[\r\n\[\]|\u0000-\u001f]/u.test(requested))) throw Error('请输入有效的目标知识点名称');
  if (target && requested && knowledgeName(target.title) !== knowledgeName(requested)) throw Error('目标名称与所选目标笔记不一致');
  if (!target) {
    if (!requested) throw Error('请指定目标知识点名称或ID');
    const matches = findNotesByTitleOrAlias(requested, notes);
    if (matches.length > 1 || matches[0]?.noteType === 'project') throw Error('目标名称存在歧义或被项目占用，请选择明确的知识点');
    target = matches[0];
  }
  const members = sources.filter(note => note.id !== target?.id);
  if (!members.length) throw Error('至少选择一篇目标以外的来源笔记');
  if (members.reduce((n, note) => n + note.content.length, target?.content.length || 0) > 1_000_000) throw Error('本次合并内容过多，请分批整理');
  const title = target?.title || requested!;
  const content = (target?.content ? target.content + '\n\n' : `# ${title}\n\n`) + members.map(sourceSection).join('\n\n') + '\n';
  const union = <T,>(values: T[]) => [...new Map(values.map(value => [JSON.stringify(value), value])).values()];
  const parentId = target?.parentId || (sources.every(note => note.parentId === sources[0].parentId) ? sources[0].parentId : undefined);
  const merged: NoteItem = { ...(target || { id: mergeId(JSON.stringify([title, sources.map(note => note.id).sort()])), title, noteType: 'knowledge' as const,
    tags: [], links: [], backlinks: [], dueDates: [], createdAt: at }), content, updatedAt: at,
    ...(parentId ? { parentId } : {}), tags: union([...(target?.tags || []), ...members.flatMap(note => note.tags)]),
    resources: union([...(target?.resources || []), ...members.flatMap(note => note.resources || [])]),
    referenceSources: union([...(target?.referenceSources || []), ...members.flatMap(note => note.referenceSources || [])]),
    argumentDocs: union([...(target?.argumentDocs || []), ...members.flatMap(note => note.argumentDocs || [])]) };
  if (!target && notes.some(note => note.id === merged.id)) throw Error('目标ID已存在，请选择已有目标');
  return { kind: 'merge', knowledgeOnly: true, label: `合并 ${members.length} 篇知识点至《${title}》`,
    before: [...members, ...(target ? [target] : [])], after: [merged],
    knowledgeMerges: members.map(note => ({ sourceId: note.id, targetId: merged.id })) };
}

/** Candidate discovery uses explicit Wiki/name identities, never fuzzy substring
 * matching or a scan through unrelated note bodies. */
export function knowledgeSelectionIds(text: string, notes: readonly NoteItem[]): string[] {
  const matches = [...text.matchAll(/\[\[([^\]\r\n]+)\]\]/gu)].map(match => match[1].split('|')[0].split('#')[0].trim());
  const names = matches.length ? matches : [text.trim()]; const ids = new Set<string>();
  for (const name of names) { const resolved = resolveNoteByTitleOrAlias(name, notes as NoteItem[]); if (resolved?.noteType === 'knowledge') ids.add(resolved.id); }
  return [...ids];
}
