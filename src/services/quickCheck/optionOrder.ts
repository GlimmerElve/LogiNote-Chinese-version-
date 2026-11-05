import type { QuickCheckQuestion } from './types';

/** Unbiased bounded sampling; never relies on the model to randomize letters. */
function randomBelow(upperBound: number): number {
  const limit = 0x1_0000_0000 - 0x1_0000_0000 % upperBound;
  const values = new Uint32Array(1);
  do { globalThis.crypto.getRandomValues(values); } while (values[0] >= limit);
  return values[0] % upperBound;
}

/** Shuffle ONLY new multiple-choice questions, once before the session freezes.
 * True/false retains its conventional order. No grading truth is inferred here. */
export function shuffleQuickCheckOptions(question: QuickCheckQuestion, randomInt = randomBelow): QuickCheckQuestion {
  if (question.type !== 'choice' || !question.options) return question;
  const options = question.options.map(option => ({ ...option }));
  for (let index = options.length - 1; index > 0; index--) {
    const pick = randomInt(index + 1);
    if (!Number.isInteger(pick) || pick < 0 || pick > index) throw new Error('简测选项排序失败，原题和作答未改变。');
    [options[index], options[pick]] = [options[pick], options[index]];
  }
  const answerIndex = options.findIndex(option => option.id === question.privateAnswer.optionId);
  if (answerIndex < 0) throw new Error('简测答案与选项不匹配，请重新生成。');
  return { ...question, options: options.map((option, index) => ({ ...option, id: 'ABCD'[index] })),
    privateAnswer: { ...question.privateAnswer, optionId: 'ABCD'[answerIndex] } };
}

/** References to option positions cannot survive a shuffle. Bare letters such
 * as "命题A与B均正确" are NOT option references. Ambiguous domain wording stays
 * with the semantic generator; local checks require explicit option wording. */
export function hasPositionDependentChoice(question: Pick<QuickCheckQuestion, 'prompt' | 'options' | 'privateAnswer'>): boolean {
  const text = [question.prompt, question.privateAnswer.explanation, ...(question.options?.map(option => option.text) || [])].join('\n');
  return /(?:以上|上述)(?:选项)?(?:均|都|全|皆)(?:是|对|正确|不)|(?:前[两三四1234]|最后一|第[一二三四1234])(?:个)?选项|(?:选项|(?:正确)?答案[为是：:\s]*|应选)\s*[A-D](?![A-Za-z0-9_组类型])/u.test(text);
}
