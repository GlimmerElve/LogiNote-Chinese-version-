import type { TeachingBlueprint, TextbookChapter } from './generationTypes';
import { TEXTBOOK_CHAPTER_SECTIONS } from './generationTypes';
import { textbookVisualGuidance } from './visualGuidance';
import { hasChapterRestatement, TEXTBOOK_RESTATEMENT_REVIEW_GUIDANCE } from './restatement';

export const TEXTBOOK_TEACHING_LENGTHS = {
  focused: { min: 3500, preferred: 4500, max: 5500 },
  extended: { min: 6000, preferred: 7200, max: 8500 },
} as const;
type Section = keyof TextbookChapter['sections'];

/** Allocate an already chosen course, never infer new facts/goals or drop chapters.
 * Hints are repaired locally, not by extra model calls. Existing checkpoints do
 * not call this function: their plans, chapter hashes and budgets stay intact. */
export function allocateTextbookTeaching(book: TeachingBlueprint): void {
  const depth = book.teachingPlan?.depth === 'extended' ? 'extended' : 'focused';
  const range = TEXTBOOK_TEACHING_LENGTHS[depth];
  const suggested = book.teachingPlan?.targetChars;
  const targetChars = typeof suggested === 'number' && Number.isFinite(suggested)
    ? Math.round(Math.max(range.min, Math.min(range.max, suggested))) : range.preferred;
  book.teachingPlan = { version: 1, depth, targetChars };
  const plans = book.chapters.map((chapter, index) => {
    const last = index === book.chapters.length - 1;
    const defaults: Section[] = index === 0 ? ['explanation', 'boundaries', 'workedExample']
      : last ? ['explanation', 'practice', 'answer', 'selfCheck', 'summary'] : ['explanation', 'workedExample'];
    const raw = chapter.writingPlan?.sections;
    const selected = new Set<Section>(Array.isArray(raw)
      ? raw.filter((section) => TEXTBOOK_CHAPTER_SECTIONS.includes(section)) : defaults);
    selected.add('explanation');
    selected.add('selfCheck');
    for (const visual of textbookVisualGuidance(book, chapter.id).targets) selected.add(visual.section);
    if (selected.has('practice') || selected.has('answer')) { selected.add('practice'); selected.add('answer'); }
    const hint = chapter.writingPlan?.targetChars;
    const weight = typeof hint === 'number' && Number.isFinite(hint) && hint > 0
      ? Math.max(500, Math.min(3500, hint)) : chapter.reasoning && chapter.reasoning !== 'standard' ? 1.25 * 1500 : 1500;
    return { selected, weight };
  });
  // Book-wide completeness, not seven repeated mini-lessons per chapter.
  for (const section of ['boundaries', 'workedExample'] as const) {
    if (!plans.some((plan) => plan.selected.has(section))) plans[0].selected.add(section);
  }
  for (const section of ['practice', 'answer', 'selfCheck', 'summary'] as const) {
    if (!plans.some((plan) => plan.selected.has(section))) plans[plans.length - 1].selected.add(section);
  }
  const weightTotal = plans.reduce((sum, plan) => sum + plan.weight, 0);
  let allocated = 0;
  book.chapters.forEach((chapter, index) => {
    const chars = index === plans.length - 1 ? targetChars - allocated : Math.round(targetChars * plans[index].weight / weightTotal);
    allocated += chars;
    chapter.writingPlan = { targetChars: chars, sections: TEXTBOOK_CHAPTER_SECTIONS.filter((section) => plans[index].selected.has(section)), restatement: 1 };
  });
}

/** A chapter need not display a redundant summary just to feed the next call.
 * Reuse a bounded verbatim excerpt instead; no summarization call or extra facts.
 * Legacy nonempty summaries retain their exact value and dependency hash. */
export function textbookContinuitySummary(chapter?: TextbookChapter): string | undefined {
  if (!chapter) return undefined;
  return chapter.sections.summary || `上一章讲解摘录（非完整小结）：\n${chapter.sections.explanation.slice(0, 1000)}`;
}

export const TEXTBOOK_COMPACT_REVIEW_GUIDANCE = '本教材按 teachingPlan/writingPlan 分配全书内容。七个 sections 是兼容槽位，不要求每章填满：未选小节允许空字符串且不显示，案例、练习及答案、自检、小结可集中到承担相应职责的章节。按整本任务与实际内容核验；不要仅因某章没有独立练习/小结、字数偏离软目标而要求补写或重生成。事实、核心目标、答案、来源和隐私标准不变。';

/** Keep the actual review prompt and its cache identity in agreement. Legacy
 * blueprints retain the original prompt/hash and need no new review call. */
export function textbookTeachingReviewPrompt(base: string, blueprint: TeachingBlueprint): string {
  const prompt = blueprint.teachingPlan ? `${base}\n${TEXTBOOK_COMPACT_REVIEW_GUIDANCE}` : base;
  return blueprint.chapters.some(chapter => hasChapterRestatement(chapter.writingPlan))
    ? `${prompt}\n${TEXTBOOK_RESTATEMENT_REVIEW_GUIDANCE}` : prompt;
}
