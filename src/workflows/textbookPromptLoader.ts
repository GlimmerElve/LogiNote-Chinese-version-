import { TEXTBOOK_CHAPTER_PROMPT, TEXTBOOK_SECTION_REPAIR_PROMPT } from './textbookPrompt';
import { resolveTextbookPrompt } from './textbookPromptV2';
import { loadReadableTextbookTypeGuidance, loadTextbookTypeGuidance } from './textbookTypes';
import { usesProgressiveTextbookPrompt, type TextbookPromptVersion } from '../services/textbook/promptVersion';

/** Routing is part of the existing blueprint call. Specialty modules are loaded
 * only after its checkpoint is saved, and only for the chapter being written. */
export async function loadTextbookPrompt(base: string, version?: TextbookPromptVersion, visualVersion?: 2 | 3,
  formats: readonly string[] = [], teachingTypes?: unknown): Promise<string> {
  const authoring = base.startsWith(TEXTBOOK_CHAPTER_PROMPT) || base.startsWith(TEXTBOOK_SECTION_REPAIR_PROMPT);
  const guidance = usesProgressiveTextbookPrompt(version) && authoring
    ? await (version === 5 || version === 6 || version === 7 ? loadReadableTextbookTypeGuidance(teachingTypes) : loadTextbookTypeGuidance(teachingTypes)) : undefined;
  return resolveTextbookPrompt(base, version, visualVersion, formats, guidance);
}
