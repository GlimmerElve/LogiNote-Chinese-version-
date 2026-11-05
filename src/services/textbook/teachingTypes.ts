import type { TeachingBlueprint } from './generationTypes';

/** Routing hints only, never a new factual or completion gate. */
export const TEXTBOOK_TEACHING_TYPES = ['concept', 'history', 'mathematics', 'science', 'procedure', 'general'] as const;
export type TextbookTeachingType = typeof TEXTBOOK_TEACHING_TYPES[number];

export function normalizeTextbookTeachingTypes(value: unknown): TextbookTeachingType[] {
  const values = Array.isArray(value) ? value : [value];
  const known = [...new Set(values.filter((item): item is TextbookTeachingType => typeof item === 'string'
    && TEXTBOOK_TEACHING_TYPES.includes(item as TextbookTeachingType)))];
  const specific = known.filter(item => item !== 'general');
  return specific.length ? specific.slice(0, 2) : ['general'];
}

/** Called only for a NEW v4 blueprint, never retrofit existing checkpoints. */
export function normalizeTextbookBlueprintTypes(book: TeachingBlueprint): void {
  book.teachingTypes = normalizeTextbookTeachingTypes(book.teachingTypes);
  for (const chapter of book.chapters) {
    chapter.teachingTypes = normalizeTextbookTeachingTypes(chapter.teachingTypes === undefined ? book.teachingTypes : chapter.teachingTypes);
  }
}

export function textbookChapterTeachingTypes(book: TeachingBlueprint, chapterId: string): TextbookTeachingType[] {
  const chapter = book.chapters.find(item => item.id === chapterId);
  return normalizeTextbookTeachingTypes(chapter?.teachingTypes === undefined ? book.teachingTypes : chapter.teachingTypes);
}
