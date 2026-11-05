import type { TeachingBlueprint, TextbookContext, TextbookSource } from './generationTypes';
import { validateBlueprint } from './validation';
import { TEXTBOOK_COMPLEX_REASONING } from './modelPolicy';
import { allocateTextbookTeaching } from './teachingPlan';
import { normalizeTextbookBlueprintTypes } from './teachingTypes';

/** A chapter declaring a focus needs all of that focus's factual material.
 * Resolve this dependency deterministically, rather than making the model repeat
 * the same source list perfectly. Never remove an ID or invent/read a new source.
 * Invalid shapes, IDs, duplicates and coverage still fail the original validator.
 */
export function assembleTeachingBlueprint(value: unknown, context: TextbookContext, sources: TextbookSource[], allocateTeaching = false, progressive = false): TeachingBlueprint {
  const book = structuredClone(value) as TeachingBlueprint;
  const allowed = new Set(sources.map((source) => source.sourceId));
  const knownSourceList = (ids: unknown): ids is string[] => Array.isArray(ids) && ids.length > 0
    && ids.length <= 32 && new Set(ids).size === ids.length && ids.every((id) => typeof id === 'string' && allowed.has(id));
  if (book && Array.isArray(book.focuses) && Array.isArray(book.chapters)) {
    if (progressive && book.chapters.every(chapter => chapter && typeof chapter === 'object')) normalizeTextbookBlueprintTypes(book);
    for (const chapter of book.chapters) {
      // Invalid optional compute hints safely mean "off", not a full blueprint repair.
      if (chapter && chapter.reasoning !== undefined && !['standard', ...TEXTBOOK_COMPLEX_REASONING].includes(chapter.reasoning)) delete chapter.reasoning;
      if (!chapter || !Array.isArray(chapter.focusIds) || !knownSourceList(chapter.sourceIds)) continue;
      for (const focusId of chapter.focusIds) {
        const matches = book.focuses.filter((focus) => focus?.id === focusId);
        if (matches.length !== 1 || !knownSourceList(matches[0].sourceIds)) continue;
        for (const sourceId of matches[0].sourceIds) {
          if (!chapter.sourceIds.includes(sourceId)) chapter.sourceIds.push(sourceId);
        }
      }
    }
  }
  if (allocateTeaching && book && Array.isArray(book.chapters) && book.chapters.length >= 2
    && book.chapters.length <= 6 && book.chapters.every((chapter) => chapter && typeof chapter.id === 'string')) allocateTextbookTeaching(book);
  validateBlueprint(book, context, sources);
  return book;
}
