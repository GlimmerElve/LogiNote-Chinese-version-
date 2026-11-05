import type { TextbookChapter } from './generationTypes';

export function mergeTextbookSectionRepair(original: TextbookChapter, requested: Array<keyof TextbookChapter['sections']>, value: unknown): TextbookChapter {
  const patch = value as TextbookChapter;
  const keys = patch?.sections && typeof patch.sections === 'object' ? Object.keys(patch.sections) : [];
  if (!requested.length || patch?.id !== original.id || Object.keys(patch).some((key) => !['id', 'sections'].includes(key))
    || keys.length !== new Set(requested).size || keys.some((key) => !requested.includes(key as keyof TextbookChapter['sections']))
    || requested.some((key) => typeof patch.sections[key] !== 'string')) throw new Error('小节修订必须只返回指定的小节，不得遗漏或改写其它内容');
  return { id: original.id, sections: { ...original.sections, ...patch.sections } };
}
