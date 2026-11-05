import { createHash } from 'node:crypto';
import type { ArgumentContextScope } from '../../services/argumentContext/types.ts';

/** A selector, never an allowlist or a filesystem path. */
export type ArgumentEnvironmentSelection = { kind: 'library' } | { kind: 'learning-note'; noteId: string };
export function parseArgumentEnvironmentSelection(value: unknown = { kind: 'library' }): ArgumentEnvironmentSelection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_selection');
  const v = value as Record<string, unknown>;
  if (v.kind === 'library' && Object.keys(v).join() === 'kind') return { kind: 'library' };
  if (v.kind === 'learning-note' && Object.keys(v).length === 2 && typeof v.noteId === 'string'
    && v.noteId.length > 0 && v.noteId.length <= 300 && v.noteId === v.noteId.trim()
    && !/[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(v.noteId) && !['.', '..'].includes(v.noteId)) return { kind: 'learning-note', noteId: v.noteId };
  throw new Error('invalid_selection');
}
type Meta = { id: string; noteType?: string; title?: string; aliases?: unknown; links?: unknown; parentId?: unknown; resources?: unknown };
const strings = (v: unknown): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > 10000 || v.some(s => typeof s !== 'string' || s.length > 2000)) throw new Error('invalid_catalog');
  return v as string[];
};
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');

/** Mirrors project descendants/links/legacy parents, but never resolves ambiguous names arbitrarily. */
export function deriveArgumentLearningScope(notes: Meta[], indexableDocIds: string[], rootScopeId: string,
  selection: ArgumentEnvironmentSelection): ArgumentContextScope {
  const knowledge = notes.filter(n => n.noteType === 'knowledge');
  let selectedNotes: Meta[] = knowledge, related: Meta[] = [];
  if (selection.kind === 'learning-note') {
    const root = notes.find(n => n.id === selection.noteId);
    if (!root || !['project', 'knowledge'].includes(root.noteType || '')) throw new Error('selection_missing');
    const ids = new Set<string>();
    if (root.noteType === 'knowledge') { selectedNotes = [root]; related = [root]; }
    else {
      const projectChildren = new Map<unknown, Meta[]>(), knowledgeChildren = new Map<unknown, Meta[]>(), names = new Map<string, Set<string>>();
      for (const n of notes) {
        const children = n.noteType === 'project' ? projectChildren : n.noteType === 'knowledge' ? knowledgeChildren : undefined;
        if (children) { const list = children.get(n.parentId) ?? []; list.push(n); children.set(n.parentId, list); }
      }
      for (const n of knowledge) for (const name of [n.title, ...strings(n.aliases)]) {
        if (typeof name !== 'string') continue;
        const key = name.toLocaleLowerCase(), matches = names.get(key) ?? new Set<string>(); matches.add(n.id); names.set(key, matches);
      }
      const visited = new Set<string>(), pending = [root];
      while (pending.length) {
        const p = pending.pop()!;
        if (visited.has(p.id)) continue;
        visited.add(p.id); related.push(p);
        for (const name of strings(p.links)) {
          const candidates = names.get(name.toLocaleLowerCase());
          if (candidates?.size === 1) ids.add([...candidates][0]);
        }
        for (const n of knowledgeChildren.get(p.id) ?? []) ids.add(n.id);
        pending.push(...(projectChildren.get(p.id) ?? []).filter(n => !visited.has(n.id)));
      }
      selectedNotes = knowledge.filter(n => ids.has(n.id)); related.push(...selectedNotes);
    }
  }
  const allowedNoteIds = selectedNotes.map(n => n.id).sort();
  let allowedDocIds = [...indexableDocIds].sort();
  if (selection.kind === 'learning-note') {
    const linked = new Set<string>();
    for (const n of related) {
      if (n.resources === undefined) continue;
      if (!Array.isArray(n.resources) || n.resources.length > 10000) throw new Error('invalid_catalog');
      for (const r of n.resources) {
        if (!r || typeof r !== 'object') throw new Error('invalid_catalog');
        if (typeof (r as {documentId?: unknown}).documentId === 'string') linked.add((r as {documentId:string}).documentId);
      }
    }
    allowedDocIds = allowedDocIds.filter(id => linked.has(id));
  }
  // Membership is independently derived; changing only mastery/timestamps does not
  // revoke it. A changed authorization set/selection cannot reuse a live lease.
  const scopeId = `reference-${selection.kind}-${digest({ rootScopeId, selection, allowedNoteIds, allowedDocIds })}`;
  return { scopeId, rootScopeId, corpus: 'reference', allowedSourceKinds: ['knowledge-note', 'uploaded-document'],
    allowedNoteIds, allowedDocIds, allowedRecordIds: [] };
}
