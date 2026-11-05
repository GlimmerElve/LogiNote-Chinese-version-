import { createHash } from 'node:crypto';
import type { SourceBlock, StructuredDocument } from '../../types.ts';
import { estimateEmbeddingTokens } from './chunking.ts';
import { planArgumentWindows, readArgumentWindowText, type ArgumentReadingWindow,
  type ArgumentWindowOptions, type ArgumentWindowPlan, type ReadingSpan, type ReadingUnit } from './argumentWindowPlanner.ts';

/** Local-only next stage of the reading contract. No model, vector/store or semantic edges. */
export const CONTEXT_WINDOW_VERSION = 'argument-context-window-v1';
export interface SourceNote extends ReadingSpan {
  id: string; marker: string; blockId: string; page?: number;
  detection: 'explicit_note' | 'pdf_footer_number_candidate';
}
export interface NoteCall extends ReadingSpan {
  id: string; marker: string; blockId: string; page?: number;
  notation: 'bracket' | 'superscript' | 'flattened_numeric_candidate';
  status: 'matched' | 'ambiguous' | 'unmatched'; noteIds: string[];
}
export interface WindowBridge {
  id: string; left: string; right: string; unitIds: string[];
  reason: 'transition_cue' | 'complete_boundary_sentences';
  status: 'carried' | 'blocked';
}
export interface ContextReadingWindow extends ArgumentReadingWindow {
  references: { callId: string; noteId: string }[];
  bridgeIds: string[]; bodyTokens: number; readyForExtraction: boolean;
}
export interface ContextWindowPlan {
  version: typeof CONTEXT_WINDOW_VERSION; base: ArgumentWindowPlan;
  notes: SourceNote[]; calls: NoteCall[]; bridges: WindowBridge[]; windows: ContextReadingWindow[];
  checks: { sourceCoverage: number; duplicateCoreCharacters: number; allBudgetsPassed: boolean;
    completeBridgeCount: number; blockedBridgeCount: number; matchedCalls: number;
    unresolvedCalls: number; noteBodyLeakCount: number; semanticCompleteness: 'pending_manual_review' };
}
const transitionCue = /(?:以下|下面|下文|接下来|上述|以上|前述|以下通过|进一步说明|详细介绍见|\b(?:following|above|below)\b)/iu;
const plainPrefix = /(?:实验|情景|情境|问题|方案|图|表|组|第|步骤|模型|假设|自变量|因变量)$/u;
const superscripts = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const pageOf = (b: SourceBlock) => b.locator.kind === 'pdf' ? b.locator.page : undefined;
const sorted = (units: ReadingUnit[]) => [...new Map(units.map(u => [u.id, u])).values()].sort((a, b) => a.start - b.start);
const rawUnit = (source: StructuredDocument, u: ReadingUnit) => u.segments.map((s, i) =>
  (i ? s.separatorBefore : '') + source.normalizedText.slice(s.start, s.end)).join('');

function collectNotes(source: StructuredDocument, base: ArgumentWindowPlan): SourceNote[] {
  const excluded = new Set(base.metadata.map(m => m.blockId));
  const bibliographyStart = base.windows.find(w => w.core[0].contentRole === 'bibliography')?.core[0].start ?? Infinity;
  const bottom = new Map<number, number>();
  for (const b of source.blocks) if (b.locator.kind === 'pdf' && b.locator.bbox)
    bottom.set(b.locator.page, Math.max(bottom.get(b.locator.page) || 0, b.locator.bbox[3]));
  return source.blocks.flatMap((b): SourceNote[] => {
    if (excluded.has(b.id) || b.textStart >= bibliographyStart || b.kind === 'heading') return [];
    const raw = source.normalizedText.slice(b.textStart, b.textEnd);
    const explicit = raw.match(/^\s*\[\^([^\]\s]+)\]:\s*/u);
    const numbered = raw.match(/^\s*(\d{1,2})(?!\d)(?:\s+|(?=\p{Script=Han}))/u);
    const footer = b.locator.kind === 'pdf' && b.locator.bbox
      && b.locator.bbox[3] >= (bottom.get(b.locator.page) || 0) - 100
      && b.locator.bbox[3] - b.locator.bbox[1] >= 18 && raw.length >= 20;
    if (!explicit && !(numbered && footer && b.kind === 'paragraph')) return [];
    return [{ id: `note:${base.contentHash}:${b.textStart}:${b.textEnd}`, marker: (explicit || numbered)![1],
      start: b.textStart, end: b.textEnd, blockId: b.id, page: pageOf(b),
      detection: explicit ? 'explicit_note' : 'pdf_footer_number_candidate' }];
  });
}

function collectCalls(source: StructuredDocument, base: ArgumentWindowPlan, notes: SourceNote[]): NoteCall[] {
  const notesByBlock = new Set(notes.map(n => n.blockId));
  const bodyBlocks = new Set(base.windows.filter(w => w.core[0].contentRole === 'body').flatMap(w => w.core.flatMap(u => u.blockIds)));
  const calls: NoteCall[] = [];
  for (const b of source.blocks) {
    if (notesByBlock.has(b.id) || !bodyBlocks.has(b.id)) continue;
    const raw = source.normalizedText.slice(b.textStart, b.textEnd);
    const append = (marker: string, offset: number, length: number, notation: NoteCall['notation']) => {
      // Flattened PDF numbers are only candidates when an actual footer of that number exists.
      if (notation === 'flattened_numeric_candidate' && !notes.some(n => n.marker === marker)) return;
      const start = b.textStart + offset, end = start + length;
      if (calls.some(c => c.start === start && c.end === end)) return;
      calls.push({ id: `call:${base.contentHash}:${start}:${end}`, marker, start, end, blockId: b.id,
        page: pageOf(b), notation, status: 'unmatched', noteIds: [] });
    };
    for (const m of raw.matchAll(/\[\^([^\]\s]+)\]|\[(\d{1,2})\]|[⁰¹²³⁴⁵⁶⁷⁸⁹]+/gu)) {
      const marker = m[1] || m[2] || [...m[0]].map(c => superscripts.indexOf(c)).join('');
      append(marker, m.index!, m[0].length, m[1] || m[2] ? 'bracket' : 'superscript');
    }
    for (const m of raw.matchAll(/(?<=\p{Script=Han})([1-9]\d?)(?=[。！？!?.,，;；]|\s+\p{Script=Han})/gu)) {
      const offset = m.index!, following = raw.slice(offset + m[0].length);
      if (plainPrefix.test(raw.slice(0, offset)) || /^\.\d/u.test(following)
        || /^\s*(?:元|美+元|分钟|小时|人|年|月|日|个|项|次|份|组|%)/u.test(following)) continue;
      append(m[1], offset, m[0].length, 'flattened_numeric_candidate');
    }
  }
  for (const c of calls) {
    const candidates = notes.filter(n => n.marker === c.marker && (c.page === undefined ? n.detection === 'explicit_note'
      : n.page === c.page || n.page === c.page + 1));
    // Same-page match has stronger structural evidence. Never choose by text similarity.
    const samePage = c.page === undefined ? [] : candidates.filter(n => n.page === c.page);
    const selected = samePage.length ? samePage : candidates;
    c.noteIds = selected.map(n => n.id);
    c.status = selected.length === 1 ? 'matched' : selected.length > 1 ? 'ambiguous' : 'unmatched';
  }
  return calls.sort((a, b) => a.start - b.start);
}

export function planContextWindows(source: StructuredDocument, options: ArgumentWindowOptions = {}): ContextWindowPlan {
  const initial = planArgumentWindows(source, options); // Validates every raw span before local detection.
  const candidates = collectNotes(source, initial);
  const candidateCalls = collectCalls(source, initial, candidates);
  // A numbered bottom paragraph alone may be a list, not a footnote. Require an actual local call.
  const notes = candidates.filter(n => n.detection === 'explicit_note' || candidateCalls.some(c => c.noteIds.includes(n.id)));
  const base = planArgumentWindows(source, { ...options, isolatedNoteBlockIds: notes.map(n => n.blockId) });
  const calls = collectCalls(source, base, notes);
  const counter = options.measureTokens ?? estimateEmbeddingTokens;
  const measure = (text: string) => {
    const n = counter(text); if (!Number.isFinite(n) || n < 0) throw new Error('argument_window_invalid_counter'); return Math.ceil(n);
  };
  const text = (units: ReadingUnit[]) => units.map(u => rawUnit(source, u)).join('\n');
  const noteMap = new Map(notes.map(n => [n.id, n]));
  let cores = base.windows.map(w => ({ ...w, before: [], after: [] }));
  const assemble = () => {
    const windows: ContextReadingWindow[] = cores.map(w => ({ ...w, core: [...w.core], before: [], after: [],
      gaps: w.gaps.filter(g => !g.startsWith('context_budget:') && g !== 'unresolved_previous_context'),
      references: [], bridgeIds: [], bodyTokens: 0, contextTokens: 0, readyForExtraction: false }));
    const bridges: WindowBridge[] = [];
    for (let i = 1; i < windows.length; i++) {
      const left = windows[i - 1], right = windows[i];
      if (left.core[0].contentRole !== 'body' || right.core[0].contentRole !== 'body'
        || left.kind !== 'paragraph' || right.kind !== 'paragraph') continue;
      const last = left.core.at(-1)!, first = right.core[0];
      const answerTail = !last.terminal && /^(?:YES|NO)\s*\[/iu.test(rawUnit(source, last))
        && left.core.length >= 2 && left.core.at(-2)!.terminal && !left.core.at(-2)!.continuation;
      if (last.continuation || first.continuation || (!last.terminal && !answerTail) || !first.terminal) {
        if (!last.terminal || last.continuation) left.gaps.push('incomplete_boundary_not_carried');
        if (!first.terminal || first.continuation || first.needsPrevious) right.gaps.push('incomplete_boundary_not_carried');
        continue;
      }
      const units = answerTail ? [left.core.at(-2)!, last, first] : [last, first];
      // An introduction inside the preceding core remains available when its examples cross a window.
      const intro = [...left.core].reverse().find(u => transitionCue.test(rawUnit(source, u)) && u.terminal && !u.continuation);
      if (intro && intro.id !== last.id && left.sectionPath === right.sectionPath) units.unshift(intro);
      const bridge: WindowBridge = { id: `bridge:${last.id}:${first.id}`, left: left.id, right: right.id,
        unitIds: sorted(units).map(u => u.id), reason: units.some(u => transitionCue.test(rawUnit(source, u)))
          ? 'transition_cue' : 'complete_boundary_sentences', status: 'carried' };
      left.after = sorted([...left.after, first]);
      right.before = sorted([...right.before, ...units.filter(u => u.id !== first.id)]);
      left.bridgeIds.push(bridge.id); right.bridgeIds.push(bridge.id); bridges.push(bridge);
    }
    for (const w of windows) {
      const readUnits = [...w.before, ...w.core, ...w.after];
      const touches = (c: NoteCall) => readUnits.some(u => u.segments.some(s => c.start >= s.start && c.end <= s.end));
      for (const c of calls.filter(touches)) {
        if (c.status !== 'matched') { w.gaps.push(`note_${c.status}:${c.id}`); continue; }
        w.references.push({ callId: c.id, noteId: c.noteIds[0] });
      }
      const noteText = [...new Set(w.references.map(r => r.noteId))].map(id => {
        const n = noteMap.get(id)!; return source.normalizedText.slice(n.start, n.end);
      }).join('\n');
      w.contextTokens = measure([text(w.before), text(w.after), noteText].filter(Boolean).join('\n'));
      w.coreTokens = measure(text(w.core));
      w.bodyTokens = measure([text(w.before), text(w.core), text(w.after), noteText].filter(Boolean).join('\n'));
      if (w.contextTokens > base.budget.maxContextTokens || w.bodyTokens > base.budget.maxBodyTokens)
        w.gaps.push('required_context_exceeds_budget');
      if (w.core[0].needsPrevious && !w.before.length) w.gaps.push('unresolved_previous_context');
      if (w.core[0].needsPrevious && w.before.length) w.gaps.push('antecedent_not_semantically_verified');
      // A question and its answer proportions form a complete local group despite the last label lacking punctuation.
      if (w.core.length >= 2 && /^(?:YES|NO)\s*\[/iu.test(rawUnit(source, w.core.at(-1)!)) && w.core.at(-2)!.terminal)
        w.gaps = w.gaps.filter(g => g !== 'unfinished_sentence_or_non_body_text');
      w.readyForExtraction = !w.core.some(u => u.continuation) && w.core[0].contentRole === 'body'
        && w.kind === 'paragraph' && !w.gaps.some(g => /exceeds_budget|unresolved_previous|note_ambiguous|note_unmatched|incomplete_boundary|unclosed_quote|layout_order|unfinished_sentence/u.test(g));
      w.gaps = [...new Set(w.gaps)];
    }
    for (const b of bridges) if (windows.some(w => (w.id === b.left || w.id === b.right)
      && w.gaps.includes('required_context_exceeds_budget'))) b.status = 'blocked';
    return { windows, bridges };
  };
  let result = assemble();
  // Repack the core at a complete sentence boundary rather than truncating required context.
  for (let pass = 0; pass < base.units.length; pass++) {
    const index = result.windows.findIndex(w => w.gaps.includes('required_context_exceeds_budget') && w.core.length > 1
      && w.core.every(u => !u.continuation));
    if (index < 0) break;
    const original = cores[index], split = Math.ceil(original.core.length / 2);
    cores.splice(index, 1, ...[original.core.slice(0, split), original.core.slice(split)].map(units => ({
      ...original, core: units, id: `${CONTEXT_WINDOW_VERSION}:${base.docId}:${base.contentHash}:${units[0].start}:${units.at(-1)!.end}`,
      cutReason: 'required_context_repack', gaps: original.gaps.filter(g => !g.startsWith('context_budget:')),
    })));
    result = assemble();
  }
  const leaked = result.windows.flatMap(w => w.core).filter(u => u.blockIds.some(id => notes.some(n => n.blockId === id))).length;
  return { version: CONTEXT_WINDOW_VERSION, base, notes, calls, ...result,
    checks: { sourceCoverage: base.checks.sourceCoverage, duplicateCoreCharacters: base.checks.duplicateCoreCharacters,
      allBudgetsPassed: result.windows.every(w => w.coreTokens <= base.budget.maxCoreTokens
        && w.contextTokens <= base.budget.maxContextTokens && w.bodyTokens <= base.budget.maxBodyTokens),
      completeBridgeCount: result.bridges.filter(b => b.status === 'carried').length,
      blockedBridgeCount: result.bridges.filter(b => b.status === 'blocked').length,
      matchedCalls: calls.filter(c => c.status === 'matched').length, unresolvedCalls: calls.filter(c => c.status !== 'matched').length,
      noteBodyLeakCount: leaked, semanticCompleteness: 'pending_manual_review' } };
}

/** Exact payload preview; caller can inspect it locally without dispatching any model request. */
export function readContextWindow(source: StructuredDocument, plan: ContextWindowPlan, windowId: string) {
  if (source.docId !== plan.base.docId || createHash('sha256').update(source.normalizedText).digest('hex') !== plan.base.contentHash)
    throw new Error('argument_window_source_version_mismatch');
  const w = plan.windows.find(item => item.id === windowId);
  if (!w) throw new Error('argument_window_unknown_context_window');
  const parts = readArgumentWindowText(source, w);
  const units = (rows: ReadingUnit[]) => rows.map(u => ({ unitId: u.id, section: u.sectionPath,
    text: rawUnit(source, u), segments: u.segments }));
  return { section: w.sectionPath, readyForExtraction: w.readyForExtraction, core: units(w.core),
    before: units(w.before), after: units(w.after),
    annotations: [...new Set(w.references.map(r => r.noteId))].map(id => {
      const n = plan.notes.find(item => item.id === id)!;
      return { noteId: id, marker: n.marker, text: source.normalizedText.slice(n.start, n.end),
        start: n.start, end: n.end, page: n.page,
        calls: w.references.filter(r => r.noteId === id).map(r => plan.calls.find(c => c.id === r.callId)!) };
    }), parts };
}
