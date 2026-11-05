import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown } from 'mdast-util-math';
import type { Nodes } from 'mdast';
import type { NoteItem } from '../types';
import { findNotesByTitleOrAlias, parseWikiLink, resolveNoteByTitleOrAlias } from './noteResolver';

interface Range { start: number; end: number }
interface Patch extends Range { value: string }

const readableContainers = new Set(['root', 'paragraph', 'heading', 'blockquote', 'list', 'listItem',
  'table', 'tableRow', 'tableCell', 'emphasis', 'strong', 'delete', 'footnoteDefinition']);
const key = (value: string) => value.trim().toLowerCase();

/** A title used as a wiki destination must remain unique and representable. */
export function noteRenameError(notes: readonly NoteItem[], noteId: string, newTitle: string): string | null {
  const title = newTitle.trim();
  if (!title || title === '#' || title.length > 120 || /[\u0000-\u001f\[\]|]/u.test(title)) {
    return '笔记标题应为 1 至 120 个字符，不能包含换行、方括号或 |，也不能仅为 #';
  }
  if (findNotesByTitleOrAlias(title, notes.filter(note => note.id !== noteId)).length) {
    return '新标题与已有笔记或别名冲突，请使用不同名称';
  }
  return null;
}

function applyPatches(content: string, patches: readonly Patch[]): string {
  let result = content;
  for (const patch of [...patches].sort((a, b) => b.start - a.start)) {
    result = result.slice(0, patch.start) + patch.value + result.slice(patch.end);
  }
  return result;
}

/** Keep original source offsets: serializing an AST would change unrelated formatting. */
function readableOffsets(content: string): Range[] {
  const protectedRanges: Range[] = [];
  // Standalone control tags must not cause CommonMark HTML to swallow the next
  // paragraph. Mask their bytes for parsing while retaining UTF-16 offsets.
  for (const match of content.matchAll(/<\/?(?:TextbookBoundary|LearningReviewBlock|ArgumentBlock)\b(?:[^"'<>]|"[^"]*"|'[^']*')*(?:>|$)/gu)) {
    protectedRanges.push({ start: match.index!, end: match.index! + match[0].length });
  }
  const frontmatter = content.match(/^\uFEFF?---[ \t]*\r?\n/u);
  if (frontmatter) {
    const close = /^(?:---|\.\.\.)[ \t]*(?:\r?$)/gmu;
    close.lastIndex = frontmatter[0].length;
    const match = close.exec(content);
    protectedRanges.push({ start: 0, end: match ? match.index + match[0].length : content.length });
  }
  let source = content;
  for (const range of [...protectedRanges].sort((a, b) => b.start - a.start)) {
    source = source.slice(0, range.start) + source.slice(range.start, range.end).replace(/[^\r\n]/g, ' ')
      + source.slice(range.end);
  }
  const tree = fromMarkdown(source, { extensions: [gfm(), math()], mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()] });
  const ranges: Range[] = [];
  const visit = (node: Nodes): void => {
    if (node.type === 'text') {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) ranges.push({ start, end });
    } else if (readableContainers.has(node.type) && 'children' in node) {
      for (const child of node.children) visit(child);
    }
  };
  visit(tree);
  return ranges;
}

function wikiPatches(content: string, names: ReadonlySet<string>, oldTitle: string, title: string, notes: readonly NoteItem[]): Patch[] {
  if (!content.includes('[[')) return [];
  const candidates: Patch[] = [];
  for (const match of content.matchAll(/\[\[([^\]\r\n]+)\]\]/gu)) {
    let slashes = 0;
    for (let i = match.index! - 1; i >= 0 && content[i] === '\\'; i--) slashes++;
    if (slashes % 2 || content[match.index! - 1] === '[') continue;
    const inner = match[1], pipe = inner.indexOf('|');
    const destination = pipe >= 0 ? inner.slice(0, pipe) : inner;
    const parsed = parseWikiLink(inner, notes);
    const hash = parsed.heading !== undefined ? destination.indexOf('#', destination.indexOf(parsed.noteTitle) + parsed.noteTitle.length) : -1;
    const rawName = hash >= 0 ? destination.slice(0, hash) : destination;
    const name = rawName.trim();
    if (!names.has(key(name))) continue;
    const leading = rawName.match(/^\s*/u)![0], trailing = rawName.match(/\s*$/u)![0];
    const anchor = hash >= 0 ? destination.slice(hash) : '';
    // Explicit labels are untouched. Existing alias-only links receive a label
    // so updating their destination does not replace the author's chosen name.
    const label = pipe >= 0 ? inner.slice(pipe) : key(name) !== key(oldTitle) ? `|${name}` : '';
    candidates.push({ start: match.index!, end: match.index! + match[0].length,
      value: `[[${leading}${title}${trailing}${anchor}${label}]]` });
  }
  // The overwhelmingly common unreferencing note never reaches the parser.
  if (!candidates.length) return [];
  const ranges = readableOffsets(content);
  const literalUrls = [...content.matchAll(/\b[a-z][a-z0-9+.-]*:[^\s<>"']+/giu)]
    .map(match => ({ start: match.index!, end: match.index! + match[0].length }));
  return candidates.filter(patch => ranges.some(range => patch.start >= range.start && patch.start < range.end)
    && !literalUrls.some(range => patch.start < range.end && range.start < patch.end));
}

function renamedGeneratedBlocks(content: string, blocks: string[] | undefined, patches: Patch[]): string[] | undefined {
  if (!blocks || !patches.length) return blocks;
  const updated = new Set(blocks);
  for (const block of blocks) {
    if (!block) continue;
    let start = content.indexOf(block);
    while (start >= 0) {
      const owned = patches.filter(patch => patch.start >= start && patch.end <= start + block.length)
        .map(patch => ({ ...patch, start: patch.start - start, end: patch.end - start }));
      if (owned.length) updated.add(applyPatches(block, owned));
      start = content.indexOf(block, start + block.length);
    }
  }
  return updated.size === blocks.length ? blocks : [...updated];
}

/**
 * Update live references as part of the SAME vault edit as a rename. The caller
 * supplies the latest after snapshot (which can include a concurrent body edit)
 * and then uses its normal metadata/save pipeline. Resolution uses the before
 * snapshot, so a duplicate title or an alias shadowed by another title cannot
 * redirect references belonging to another note.
 *
 * This deliberately excludes historical review/AI evidence, textbook source
 * snapshots and published argument graphs. Their stored titles describe the
 * evidence as captured; stable IDs continue to resolve the current note.
 */
export function applyNoteRenameReferences(before: readonly NoteItem[], after: NoteItem[], noteId: string): NoteItem[] {
  const previous = before.find(note => note.id === noteId), renamed = after.find(note => note.id === noteId);
  if (!previous || !renamed || previous.title === renamed.title) return after;
  const error = noteRenameError(before, noteId, renamed.title);
  if (error) throw new Error(error);
  const title = renamed.title.trim();
  const names = new Set([previous.title, ...(previous.aliases || [])]
    .filter(name => resolveNoteByTitleOrAlias(name, before as NoteItem[])?.id === noteId).map(key));
  let changed = false;
  const result = after.map(note => {
    const patches = wikiPatches(note.content, names, previous.title, title, before);
    const content = patches.length ? applyPatches(note.content, patches) : note.content;
    let tasksChanged = false;
    const dueDates = note.dueDates.map(task => {
      const noteTitle = task.noteId === noteId ? title : task.noteTitle;
      const taskPatches = wikiPatches(task.taskText, names, previous.title, title, before);
      const taskText = taskPatches.length ? applyPatches(task.taskText, taskPatches) : task.taskText;
      if (noteTitle === task.noteTitle && taskText === task.taskText) return task;
      tasksChanged = true;
      return { ...task, noteTitle, taskText };
    });
    if (content === note.content && !tasksChanged) return note;
    changed = true;
    return { ...note, content, ...(tasksChanged ? { dueDates } : {}),
      ...(patches.length && note.generatedContentBlocks ? { generatedContentBlocks: renamedGeneratedBlocks(note.content, note.generatedContentBlocks, patches) } : {}),
      updatedAt: renamed.updatedAt };
  });
  return changed ? result : after;
}
