/** Version changes affect new tasks only. Never reinterpret an approved job's
 * prompt version while resuming its chapters or exhausted model requests. */
export const TEXTBOOK_PROMPT_VERSION = 8 as const;
export type TextbookPromptVersion = 2 | 3 | 4 | 5 | 6 | 7 | 8;

export function usesProgressiveTextbookPrompt(version?: TextbookPromptVersion): boolean {
  return version === 4 || version === 5 || version === 6 || version === 7 || version === 8;
}

export function validateTextbookPromptVersion(value: unknown): asserts value is TextbookPromptVersion | undefined {
  if (value !== undefined && value !== 2 && value !== 3 && value !== 4 && value !== 5 && value !== 6 && value !== 7 && value !== 8) {
    throw new Error('教材提示词版本不支持，原草稿保留，请重新准备');
  }
}
