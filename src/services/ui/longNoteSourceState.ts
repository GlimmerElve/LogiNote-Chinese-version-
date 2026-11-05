import { StateEffect, StateField } from '@codemirror/state';
import { history, invertedEffects } from '@codemirror/commands';
import { applyLongNoteSourceChanges, sourceCoordinateMap } from './longNoteSource';

export interface SourceDocument { source: string; lineBreak: string }
export const replaceLongNoteSource = StateEffect.define<Partial<SourceDocument> & Pick<SourceDocument, 'source'>>();
const separator = (source: string, fallback = '\n') => source.match(/\r\n|\r|\n/u)?.[0] || fallback;

export function createLongNoteSourceState(initial: string) {
  const field = StateField.define<SourceDocument>({
    create: () => ({ source: initial, lineBreak: separator(initial) }),
    update: (value, transaction) => {
      const replacement = transaction.effects.filter(effect => effect.is(replaceLongNoteSource)).at(-1);
      if (replacement) return { source: replacement.value.source,
        lineBreak: replacement.value.lineBreak || separator(replacement.value.source, value.lineBreak) };
      if (!transaction.docChanged) return value;
      const changes: Array<{ from: number; to: number; insert: string }> = [];
      transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => changes.push({ from, to, insert: inserted.toString() }));
      return { ...value, source: applyLongNoteSourceChanges(value.source, changes, value.lineBreak) };
    },
  });
  return { field, extensions: [field, history(), invertedEffects.of(transaction => {
    const before = transaction.startState.field(field);
    // Normal typing keeps only CodeMirror's changed ranges in history. Do not
    // retain a complete long-note string for every keystroke. An explicit
    // replacement or an edit to unusual mixed line endings needs exact bytes.
    let exact = transaction.effects.some(effect => effect.is(replaceLongNoteSource));
    if (!exact && transaction.docChanged) {
      const rawPosition = sourceCoordinateMap(before.source);
      let touchesBreak = false;
      transaction.changes.iterChanges((from, to, _fromB, _toB, inserted) => {
        if (inserted.lines > 1 || /\r|\n/u.test(before.source.slice(rawPosition(from), rawPosition(to)))) touchesBreak = true;
      });
      if (touchesBreak) {
        for (const match of before.source.matchAll(/\r\n|\r|\n/gu)) if (match[0] !== before.lineBreak) { exact = true; break; }
      }
    }
    return exact ? [replaceLongNoteSource.of(before)] : [];
  })] };
}
