import type { ReviewDraftAnswer } from './memory/types';
import { parseReviewQuestionIntent } from './reviewIntentValidation';

export function reviewDraftQuestionKey(text: string): string {
  return text.replace(/\r\n?/g, '\n').trim();
}

export function displayReviewDraftQuestion(context: NonNullable<ReviewDraftAnswer['context']>): string {
  return context.tutorPrompt ? `${context.questionText}\n\n上次导师的提示或改述：\n${context.tutorPrompt}` : context.questionText;
}

export function reviewDraftTutorPrompt(latestPrompt: string | undefined, previous?: ReviewDraftAnswer): string | undefined {
  return previous?.context && latestPrompt === displayReviewDraftQuestion(previous.context)
    ? previous.context.tutorPrompt : latestPrompt;
}

/** Old or damaged context is recoverable text, never permission to attach an answer to a question. */
export function readReviewDraftContext(draft: ReviewDraftAnswer): ReviewDraftAnswer['context'] {
  const context = draft.context;
  if (!context || context.version !== 1 || typeof context.questionText !== 'string'
    || !context.questionText.trim() || !Number.isInteger(context.hintLevel)
    || context.hintLevel < 0 || context.hintLevel > 4 || !Array.isArray(context.consultedMaterialIds)
    || (context.tutorPrompt !== undefined && typeof context.tutorPrompt !== 'string')
    || context.consultedMaterialIds.some(id => typeof id !== 'string' || !id.trim())) return undefined;
  try {
    return { version: 1, questionText: context.questionText,
      ...(context.tutorPrompt !== undefined ? { tutorPrompt: context.tutorPrompt } : {}),
      questionIntent: parseReviewQuestionIntent(context.questionIntent), hintLevel: context.hintLevel,
      consultedMaterialIds: [...new Set(context.consultedMaterialIds)] };
  } catch { return undefined; }
}

export function buildReviewDraft(input: {
  id: string; content: string; previous?: ReviewDraftAnswer;
  context: NonNullable<ReviewDraftAnswer['context']>;
}, now = new Date().toISOString()): ReviewDraftAnswer {
  const context = structuredClone(input.context);
  return { id: input.previous?.id || input.id, content: input.content, context,
    timestamp: input.previous?.content === input.content && JSON.stringify(input.previous.context) === JSON.stringify(context)
      ? input.previous.timestamp : now };
}
