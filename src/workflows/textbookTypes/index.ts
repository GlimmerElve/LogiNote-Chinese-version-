import { normalizeTextbookTeachingTypes, type TextbookTeachingType } from '../../services/textbook/teachingTypes';

type TypeModule = { default: string };
const loaders: Record<TextbookTeachingType, () => Promise<TypeModule>> = {
  concept: () => import('./concept'),
  history: () => import('./history'),
  mathematics: () => import('./mathematics'),
  science: () => import('./science'),
  procedure: () => import('./procedure'),
  general: () => import('./general'),
};

/** No model request, no new tools. Import only the approved chapter's hints. */
export async function loadTextbookTypeGuidance(types: unknown, load = (type: TextbookTeachingType) => loaders[type]()): Promise<string> {
  const selected = normalizeTextbookTeachingTypes(types);
  return (await Promise.all(selected.map(load))).map(module => module.default).join('\n');
}

/** Same type routing; v5 loads revised hints only for the two evaluated types. */
export function loadReadableTextbookTypeGuidance(types: unknown): Promise<string> {
  return loadTextbookTypeGuidance(types, type => type === 'concept' ? import('./readingConcept')
    : type === 'mathematics' ? import('./readingMathematics') : loaders[type]());
}
