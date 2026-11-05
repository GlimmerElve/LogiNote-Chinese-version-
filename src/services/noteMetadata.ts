import type { NoteItem, DueDateItem } from '../types';
import { isReferenceProject } from './projectRole';
import { extractPlanTaskId, stripPlanTaskAnchor } from './planTaskAnchor';
import { projectPlanningContent } from './textbook/noteContent';
import { noteNameKey, parseWikiLink } from './noteResolver';
import { extractMarkdownWikiLinks } from './markdownWikiLinks';

export type NoteMetadataInput = Pick<NoteItem, 'id' | 'title' | 'content' | 'noteType' | 'projectRole' | 'aliases' | 'dueDates' | 'textbook'>;

/** Pure metadata calculation, shared by the worker and offline checks. */
export function parseNoteMetadata(note: NoteItem): { links: string[]; dueDates: DueDateItem[]; wikiLinks?: string[] } {
  const linksSet = new Set<string>();
  const wikiLinks = extractMarkdownWikiLinks(note.content);
  for (const raw of wikiLinks) {
    const target = parseWikiLink(raw);
    const title = target.noteTitle || (target.heading ? note.title : '');
    if (title) linksSet.add(title);
  }
  const dueDates: DueDateItem[] = [];
  const lines = isReferenceProject(note) ? [] : projectPlanningContent(note.content, note.textbook).split('\n');
  lines.forEach((line, idx) => {
    // The legacy lazy-prefix regex is quadratic on a long line with no @due.
    // Fast-reject those lines without changing its established capture rules.
    if (!/@due\([\d\-]+\)/i.test(line)) return;
    const dueMatch = line.match(/(.*?)(?:@due\(([\d\-]+)\))/i);
    if (!dueMatch) return;
    const rawText = stripPlanTaskAnchor(dueMatch[1]).replace(/^[-*]\s*(\[[ xX]\])?\s*/, '');
    const stableTaskId = extractPlanTaskId(line);
    dueDates.push({ id: stableTaskId || `due-${note.id}-${idx}`, noteId: note.id, noteTitle: note.title,
      taskText: rawText || note.title, dueDate: dueMatch[2].trim(), completed: /^[-*]\s*\[[xX]\]/.test(line.trim()),
      priority: line.includes('【高】') || line.includes('High') ? 'high' : 'medium', source: stableTaskId ? 'manual' : 'legacy' });
  });
  return { links: [...linksSet], dueDates, wikiLinks };
}

export interface DerivedNoteMetadata { id: string; links: string[]; backlinks: string[]; dueDates: DueDateItem[] }

export function calculateNoteMetadata(notes: NoteMetadataInput[], parse: (note: NoteMetadataInput) => ReturnType<typeof parseNoteMetadata> = note => parseNoteMetadata(note as NoteItem)): DerivedNoteMetadata[] {
  // One linear namespace index for the snapshot, with the same ambiguity rule
  // as navigation. Never attach a backlink to whichever note happens to be first.
  const names = new Map<string, Map<string, NoteMetadataInput>>();
  for (const note of notes) {
    for (const name of [note.title, ...(note.aliases || [])]) {
      const key = noteNameKey(name);
      if (!key) continue;
      if (!names.has(key)) names.set(key, new Map());
      names.get(key)!.set(note.id, note);
    }
  }
  const backlinks = new Map<string, Set<string>>();
  const derived = notes.map(note => {
    const parsed = parse(note);
    const linksSet = new Set<string>();
    const targets = parsed.wikiLinks ? parsed.wikiLinks.map(raw => {
      const destination = parseWikiLink(raw, name => names.has(noteNameKey(name)));
      return destination.noteTitle || (destination.heading ? note.title : '');
    }).filter(Boolean) : parsed.links;
    for (const target of targets) {
      const matches = names.get(noteNameKey(target));
      if (matches && matches.size > 1) continue;
      const resolved = matches?.values().next().value as NoteMetadataInput | undefined;
      // Retain a unique alias if its canonical title is ambiguous in old data.
      linksSet.add(resolved && names.get(noteNameKey(resolved.title))?.size === 1 ? resolved.title : target);
      if (!resolved) continue;
      if (!backlinks.has(resolved.id)) backlinks.set(resolved.id, new Set());
      backlinks.get(resolved.id)!.add(note.title);
    }
    const existing = new Set(note.dueDates.map(item => item.id));
    return { id: note.id, links: [...linksSet], backlinks: [] as string[], dueDates: [...note.dueDates, ...parsed.dueDates.filter(item => !existing.has(item.id))] };
  });
  derived.forEach(item => { item.backlinks = [...(backlinks.get(item.id) || [])]; });
  return derived;
}

/** Bounded to the current snapshot. Re-resolve all links when titles/aliases
 * change, but scan a document body only when its parsing inputs change. */
export function createNoteMetadataCalculator(parse: (note: NoteMetadataInput) => ReturnType<typeof parseNoteMetadata> = note => parseNoteMetadata(note as NoteItem)) {
  const cache = new Map<string, { input: NoteMetadataInput; parsed: ReturnType<typeof parseNoteMetadata> }>();
  return (notes: NoteMetadataInput[]) => {
    const alive = new Set(notes.map(note => note.id));
    for (const id of cache.keys()) if (!alive.has(id)) cache.delete(id);
    return calculateNoteMetadata(notes, note => {
      const prior = cache.get(note.id), before = prior?.input;
      if (before && before.content === note.content && before.title === note.title && before.noteType === note.noteType
        && before.projectRole === note.projectRole && Boolean(before.textbook) === Boolean(note.textbook)
        && before.textbook?.regionId === note.textbook?.regionId) return prior!.parsed;
      const parsed = parse(note); cache.set(note.id, { input: note, parsed }); return parsed;
    });
  };
}

export function applyNoteMetadata(notes: NoteItem[], derived: DerivedNoteMetadata[]): NoteItem[] {
  if (notes.length !== derived.length || derived.some((item, index) => item.id !== notes[index].id)) throw new Error('笔记元数据快照不匹配');
  let changed = false;
  const result = notes.map((note, index) => {
    const item = derived[index];
    if (JSON.stringify([note.links, note.backlinks, note.dueDates]) === JSON.stringify([item.links, item.backlinks, item.dueDates])) return note;
    changed = true;
    return { ...note, links: item.links, backlinks: item.backlinks, dueDates: item.dueDates };
  });
  return changed ? result : notes;
}

export function recalculateBacklinks(notes: NoteItem[]): NoteItem[] {
  return applyNoteMetadata(notes, calculateNoteMetadata(notes));
}
