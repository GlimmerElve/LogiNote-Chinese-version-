import type { NoteItem, NoteSearchResult } from '../../types';
import { chunkSemanticText } from '../../electron/rag/chunking';
import { cognitionQueryTerms } from '../cognition/retrieval';
import { hasSubstantiveReferenceText } from '../ragSourcePolicy';
import { selectReferenceEvidence } from '../referenceEvidence';

export interface ReviewNotePassage {
  text: string; textStart: number; textEnd: number; sectionPath: string;
  chunkId?: string;
}

/** Read-only fallback, never an embedding rebuild. Match the reference index's semantic units
 * and map LF coordinates back to saved UTF-16 originals (including CRLF and emoji). */
function currentPieces(text: string) {
  let normalized = ''; const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r') { normalized += '\n'; if (text[i + 1] === '\n') i++; }
    else normalized += text[i];
    offsets.push(i + 1);
  }
  return chunkSemanticText(normalized, { minChars: 0, maxChars: 450, maxEstimatedTokens: 260 })
    .map(piece => ({ ...piece, textStart: offsets[piece.textStart], textEnd: offsets[piece.textEnd] }))
    .filter(piece => hasSubstantiveReferenceText(text.slice(piece.textStart, piece.textEnd)));
}

const bodyHit = (hit: NoteSearchResult, note: NoteItem) => hit.noteId === note.id
  && hit.noteType === 'knowledge' && hit.evidenceOrigin !== 'user-argument-doc'
  && !hit.argumentHits?.length && !hit.matchKinds?.includes('argument');

/** A vector score is a candidate, not authority. Use only an exact current, saved body interval;
 * stale snippets are never copied into the model input. sourceHash uses the index descriptor. */
export function selectReviewNotePassages(note: NoteItem, hits: NoteSearchResult[], sourceHash: string, query: string,
  options: { limit?: number; maxTotalChars?: number; requireMatch?: boolean; compatibilitySingle?: boolean } = {}) {
  const warnings: string[] = [];
  if (note.noteType !== 'knowledge' || !hasSubstantiveReferenceText(note.content)) return { passages: [], warnings };
  if (note.content.length > 500000) return { passages: [], warnings: ['note_reference_budget_exceeded'] };
  const limit = Math.max(1, Math.min(3, Math.floor(options.limit || 2)));
  const budget = Math.max(1400, Math.min(4200, Math.floor(options.maxTotalChars || 1800)));
  const pieces = currentPieces(note.content);
  const terms = cognitionQueryTerms(query.replace(note.title, '').trim() || query);
  const passageFor = (selected: number, chunkId?: string): ReviewNotePassage | undefined => {
    const focus = pieces[selected];
    if (!focus) return undefined;
    let left = selected, right = selected;
    // Restore bounded continuity before testing whether this is usable prose.
    const referring = /^(?:这|该|上述|因此|其中|它|其|此|但|然而|由此|所以)/u
      .test(note.content.slice(focus.textStart, focus.textEnd));
    const sameSection = (index: number) => pieces[index]?.sectionPath === focus.sectionPath;
    if ((focus.forcedSplit || referring) && selected > 0 && sameSection(selected - 1)
      && focus.textEnd - pieces[selected - 1].textStart <= 1200) left--;
    if (focus.forcedSplit && sameSection(selected + 1)
      && pieces[selected + 1].textEnd - pieces[left].textStart <= 1200) right++;
    const textStart = pieces[left].textStart, textEnd = pieces[right].textEnd;
    return { text: note.content.slice(textStart, textEnd), textStart, textEnd,
      sectionPath: focus.sectionPath, ...(chunkId ? { chunkId } : {}) };
  };
  const restored = new Map<number, ReviewNotePassage | undefined>();
  const usable = (index: number) => {
    if (restored.has(index)) return restored.get(index);
    const passage = passageFor(index);
    const evidence = passage && selectReferenceEvidence(note.content, options.compatibilitySingle ? passage : { ...passage, forcedSplit: pieces[index]?.forcedSplit });
    const result = passage && evidence ? options.compatibilitySingle ? passage : { ...passage, text: evidence.text,
      textStart: evidence.textStart, textEnd: evidence.textEnd } : undefined;
    restored.set(index, result); return result;
  };
  let selected = -1, chunkId: string | undefined;
  for (const hit of hits.filter(hit => bodyHit(hit, note))) {
    const p = hit.passage;
    const index = p ? pieces.findIndex(piece => piece.textStart === p.textStart && piece.textEnd === p.textEnd
      && piece.sectionPath === p.sectionPath && !!piece.forcedSplit === p.forcedSplit) : -1;
    if (p?.schemaVersion === 2 && p.sourceHash === sourceHash && p.sourceUpdatedAt === note.updatedAt
      && typeof p.chunkId === 'string' && p.chunkId && index >= 0
      && typeof hit.snippet === 'string' && !!hit.snippet.trim()
      && note.content.slice(p.textStart, p.textEnd).startsWith(hit.snippet)) {
      // A current vector hit can still be a bibliography/heading, not evidence.
      // Skip it and inspect remaining candidates instead of suppressing the body fallback.
      if (!usable(index)) { warnings.push('note_passage_not_evidence'); continue; }
      selected = index; chunkId = p.chunkId; break;
    }
    warnings.push(p ? 'note_passage_unverifiable' : 'note_passage_legacy');
  }
  const scoreFor = (piece: (typeof pieces)[number]) => {
    const prose = note.content.slice(piece.textStart, piece.textEnd).toLocaleLowerCase();
    const heading = piece.sectionPath.toLocaleLowerCase().replace(note.title.toLocaleLowerCase(), '');
    return terms.reduce((sum, term) => sum + (Number(prose.includes(term)) + 2 * Number(heading.includes(term))) * Math.min(term.length, 8), 0);
  };
  if (options.compatibilitySingle) {
    if (selected < 0) {
      warnings.push('note_reference_semantic_fallback');
      let best = -1;
      pieces.forEach((piece, index) => {
        if (!usable(index)) return;
        const score = scoreFor(piece);
        if (score > best) { best = score; selected = index; }
      });
    }
    if (!pieces[selected]) return { passages: [], warnings };
    if (pieces[selected].forcedSplit) warnings.push('note_reference_forced_split');
    return { passages: [passageFor(selected, chunkId)!], warnings: [...new Set(warnings)] };
  }
  const ranked = pieces.map((piece, index) => ({ index, score: scoreFor(piece) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  if (selected < 0) {
    warnings.push('note_reference_semantic_fallback');
    selected = ranked.find(row => (row.score > 0 || options.requireMatch !== true) && usable(row.index))?.index ?? -1;
  }
  const passages: ReviewNotePassage[] = []; let used = 0;
  for (const index of [...new Set([selected, ...ranked.filter(row => row.score > 0).map(row => row.index)])]) {
    if (passages.length >= limit) break;
    const passage = usable(index);
    if (!passage || passages.some(other => passage.textStart < other.textEnd && other.textStart < passage.textEnd)) continue;
    if (used + passage.text.length > budget) { warnings.push('note_reference_context_budget'); continue; }
    passages.push({ ...passage, ...(index === selected && chunkId ? { chunkId } : {}) }); used += passage.text.length;
    if (pieces[index].forcedSplit) warnings.push('note_reference_forced_split');
  }
  if (!passages.length && !options.compatibilitySingle) warnings.push('note_reference_no_query_match');
  return { passages, warnings: [...new Set(warnings)] };
}

/** Existing one-passage consumers retain their API and compatibility fallback. */
export function selectReviewNotePassage(note: NoteItem, hits: NoteSearchResult[], sourceHash: string, query: string) {
  const selected = selectReviewNotePassages(note, hits, sourceHash, query, { limit: 1, compatibilitySingle: true });
  return { passage: selected.passages[0], warnings: selected.warnings };
}
