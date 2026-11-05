import type { NoteItem } from '../../types';
import { generatedMathMarkdown } from '../textbook/generatedMath';
export interface ProjectKnowledgeRow { title: string; summary: string }
export interface ProgressiveKnowledgeChange { before: NoteItem; note: NoteItem; rows: ProjectKnowledgeRow[]; knowledgeBacklinks?: Array<{ id: string; backlinks: string[] }> }
const heading = '### 本项目需要掌握的知识点';
const key = (value: string) => value.normalize('NFKC').trim().toLocaleLowerCase();
/** Plain Markdown, no opaque IDs or private learning records in the body. */
function section(source: string) {
  let fence = '', from = -1, to = source.length;
  for (const line of source.matchAll(/[^\n]*(?:\n|$)/gu)) {
    if (!line[0]) continue;
    const text = line[0].replace(/\r?\n$/u, '');
    const marker = text.match(/^ {0,3}(`{3,}|~{3,})(.*)$/u);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
      continue;
    }
    if (fence) continue;
    if (text.trim() === heading) { if (from < 0) from = line.index! + line[0].length; continue; }
    if (from >= 0 && /^ {0,3}#{1,3}\s/u.test(text)) { to = line.index!; break; }
  }
  return from < 0 ? null : { from, to };
}
export function readProjectKnowledgeRows(source: string): ProjectKnowledgeRow[] {
  const range = section(source); if (!range) return [];
  const rows: ProjectKnowledgeRow[] = []; let current: ProjectKnowledgeRow | null = null, fence = '';
  for (const line of source.slice(range.from, range.to).split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (marker) {
      if (!fence) { fence = marker[1]; current = null; }
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !marker[2].trim()) fence = '';
      continue;
    }
    if (fence) continue;
    const modern = /^ {0,3}####[ \t]+\[\[([^\]\r\n]+)\]\][ \t]*$/u.exec(line);
    const legacy = /^[ \t]*(?:[-*][ \t]+)?\[\[([^\]\r\n]+)\]\][：:][ \t]*(.*)$/u.exec(line);
    if (modern || legacy) { const row = { title: (modern || legacy)![1], summary: legacy?.[2] || '' }; rows.push(row); current = modern ? row : null; continue; }
    if (/^\s*#{1,4}\s/u.test(line)) { current = null; continue; }
    if (current && line.trim()) { current.summary = line.trim(); current = null; }
  }
  return rows;
}
export function appendProjectKnowledgeRows(source: string, rows: readonly ProjectKnowledgeRow[]): string {
  const existing = new Set(readProjectKnowledgeRows(source).map(row => key(row.title)));
  const added = rows.filter(row => { const name = key(row.title); if (existing.has(name)) return false; existing.add(name); return true; });
  if (!added.length) return source;
  const text = added.map(row => {
    if (!row.title.trim() || /[\[\]|\r\n]/u.test(row.title)) throw Error('知识点名称不能安全写入双链，未改写项目正文');
    const summary = generatedMathMarkdown(row.summary).replace(/[\r\n]+/gu, ' ').replace(/\[\[/gu, '［［').replace(/\]\]/gu, '］］').trim();
    return `#### [[${row.title}]]\n\n${summary}`;
  }).join('\n\n') + '\n';
  const range = section(source);
  if (!range) return source + (source ? source.endsWith('\n\n') ? '' : source.endsWith('\n') ? '\n' : '\n\n' : '') + heading + '\n\n' + text;
  // Append inside the section without rewriting its existing/manual descriptions.
  return source.slice(0, range.to) + (source.slice(0, range.to).endsWith('\n\n') ? '' : '\n') + text
    + (range.to < source.length ? '\n' : '') + source.slice(range.to);
}
export function pendingProjectKnowledgeRows(current: string, incoming: string) {
  const seen = new Set(readProjectKnowledgeRows(current).map(row => key(row.title)));
  return readProjectKnowledgeRows(incoming).filter(row => !seen.has(key(row.title)));
}
/** Acknowledged disk changes advance separately from an unsaved editor draft. */
export function rebaseProgressiveKnowledge(current: NoteItem, baseline: NoteItem, change: ProgressiveKnowledgeChange): NoteItem | null {
  if (current.id !== change.note.id || baseline.id !== current.id || baseline.content !== change.before.content) return null;
  return { ...current, content: appendProjectKnowledgeRows(current.content, change.rows),
    links: [...new Set([...current.links, ...change.rows.map(row => row.title)])],
    updatedAt: current.updatedAt === baseline.updatedAt ? change.note.updatedAt : current.updatedAt };
}
