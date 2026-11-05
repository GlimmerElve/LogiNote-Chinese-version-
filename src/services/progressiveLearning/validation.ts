import type { ProgressiveMainline, ProgressiveReflectionHook, ProgressiveSourcePacket,
  ProgressiveProgressPatch, ProgressiveConcept, ProgressiveQuestion, ProgressiveRoute, ProgressiveJudgment } from './types';

export const PROGRESSIVE_MAX_BODY = 50_000;
export const PROGRESSIVE_MAX_RAW = 90_000;
export const PROGRESSIVE_MAX_DRAFT = 100_000;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
export const validProgressivePageId = (value: unknown): value is string => typeof value === 'string'
  && /^(?:main-[1-4]|extra-[a-f0-9-]{36})$/u.test(value);
export function validateProgressiveConcepts(value: unknown): asserts value is ProgressiveConcept[] {
  if (!Array.isArray(value) || value.length > 8) throw Error('本页知识点格式无效');
  const keys = new Set<string>();
  for (const concept of value) {
    if (!object(concept)) throw Error('本页知识点格式无效');
    const key = progressiveText(concept.key, 100, '知识点键');
    if (keys.has(key)) throw Error('知识点键重复');
    keys.add(key);
    progressiveText(concept.title, 80, '知识点标题');
    progressiveText(concept.summary, 1800, '知识点讲解');
  }
}
export function progressiveText(value: unknown, max: number, label: string, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new Error(`${label}无效或超过保存上限`);
  return value;
}
export function validateProgressiveQuestions(value: unknown, body?: string): asserts value is ProgressiveQuestion[] {
  if (!Array.isArray(value) || value.length > 3) throw Error('本页题目须为0–3道');
  const ids = new Set<string>();
  for (const question of value) {
    if (!object(question) || typeof question.id !== 'string' || !/^q[1-3]$/u.test(question.id) || ids.has(question.id)
      || !['choice', 'judgment', 'application'].includes(question.kind as string)
      || !['concept', 'calculation', 'transfer'].includes(question.focus as string)) throw Error('题目编号或类型无效');
    ids.add(question.id);
    progressiveText(question.prompt, 3000, '题干'); progressiveText(question.objective, 600, '考查目标');
    progressiveText(question.referenceAnswer, 1600, '参考答案'); progressiveText(question.explanation, 2200, '题目解析');
    if (question.referenceQuote !== undefined) progressiveText(question.referenceQuote, 1500, '讲解依据', true);
    if (!Array.isArray(question.conceptKeys) || question.conceptKeys.length > 8) throw Error('题目知识点无效');
    question.conceptKeys.forEach(key => progressiveText(key, 100, '题目知识点'));
    if (question.kind !== 'application') {
      if (!Array.isArray(question.options) || question.options.length < 2 || question.options.length > 6
        || question.kind === 'judgment' && question.options.length !== 2) throw Error('题目选项无效');
      const options = new Set<string>();
      for (const option of question.options) {
        if (!object(option) || typeof option.id !== 'string' || !/^[A-Za-z0-9_-]{1,20}$/u.test(option.id) || options.has(option.id)) throw Error('选项编号无效');
        options.add(option.id); progressiveText(option.text, 1800, '选项');
      }
      if (!options.has(question.correctOptionId as string)) throw Error('参考选项不在题目中');
    } else if (question.options !== undefined || question.correctOptionId !== undefined) throw Error('应用题不能含选择题答案');
  }
}
export function projectProgressiveQuestion(question: ProgressiveQuestion): ProgressiveQuestion {
  return { id: question.id, kind: question.kind, prompt: question.prompt, objective: question.objective,
    conceptKeys: [...question.conceptKeys], focus: question.focus,
    ...(question.options ? { options: question.options.map(({ id, text }) => ({ id, text })), correctOptionId: question.correctOptionId } : {}),
    referenceAnswer: question.referenceAnswer, explanation: question.explanation,
    ...(question.referenceQuote !== undefined ? { referenceQuote: question.referenceQuote } : {}) };
}
export function validateProgressiveRoute(value: unknown): asserts value is ProgressiveRoute {
  if (!object(value) || !['mainline', 'expansion', 'finish'].includes(value.kind as string)) throw Error('后续讲解编排无效');
  progressiveText(value.reason, 800, '编排依据');
  if (value.correction !== undefined) progressiveText(value.correction, 1200, '衔接纠正', true);
}
export function validateProgressiveJudgment(value: unknown): asserts value is ProgressiveJudgment {
  if (!object(value) || !['correct', 'incorrect', 'unverifiable'].includes(value.outcome as string)
    || !['concept', 'calculation', 'expression', 'unknown', 'none'].includes(value.errorKind as string)) throw Error('答题判定格式无效');
  progressiveText(value.explanation, 2200, '判题说明'); progressiveText(value.referenceAnswer, 1600, '判题参考答案', value.outcome === 'unverifiable');
  if (value.referenceQuote !== undefined) progressiveText(value.referenceQuote, 1500, '判题依据', true);
}
export function validateProgressiveMainline(value: unknown, maxPages = 4): asserts value is ProgressiveMainline {
  if (!object(value)) throw new Error('课程主线格式无效');
  progressiveText(value.title, 300, '主线标题');
  const goals = (raw: unknown) => {
    if (!Array.isArray(raw) || !raw.length || raw.length > 12) throw new Error('学习目标格式无效');
    raw.forEach(goal => progressiveText(goal, 600, '学习目标'));
  };
  goals(value.objectives);
  if (!Array.isArray(value.pages) || !value.pages.length || value.pages.length > Math.min(4, maxPages)) throw new Error('主线页数超过课程预算');
  value.pages.forEach((page, index) => {
    if (!object(page) || page.id !== `main-${index + 1}`) throw new Error('主线页面编号无效');
    progressiveText(page.title, 300, '页面标题'); goals(page.objectives);
  });
}
export function validateProgressiveHook(value: unknown): asserts value is ProgressiveReflectionHook {
  if (!object(value) || value.kind !== 'reflection') throw new Error('复述钩子格式无效');
  progressiveText(value.id, 100, '钩子编号');
  progressiveText(value.prompt, 2000, '复述提示');
}
export function validateProgressiveSources(value: unknown): asserts value is ProgressiveSourcePacket[] {
  if (!Array.isArray(value) || value.length > 12 || JSON.stringify(value).length > 40_000) throw new Error('页面来源片段超过保存上限');
  const ids = new Set<string>();
  value.forEach(source => {
    if (!object(source) || !['document', 'knowledge', 'web', 'model_knowledge'].includes(source.kind as string)) throw new Error('页面来源片段格式无效');
    progressiveText(source.id, 200, '来源编号');
    if (ids.has(source.id as string)) throw new Error('来源编号重复');
    ids.add(source.id as string);
    progressiveText(source.title, 300, '来源标题');
    progressiveText(source.text, 12_000, '来源内容', true);
    if (source.locator !== undefined) progressiveText(source.locator, 1000, '来源定位', true);
  });
}
export function validateProgressiveProgressPatch(value: unknown, projectNoteId?: string): asserts value is ProgressiveProgressPatch {
  if (!object(value) || !Object.keys(value).length || Object.keys(value).some(key => !['currentPageId', 'scrollTop', 'restatementDraft', 'summaryDraft', 'questions', 'questionDraft', 'restatementSpans'].includes(key))) throw new Error('学习进度字段无效');
  if (value.currentPageId !== undefined && value.currentPageId !== null && !validProgressivePageId(value.currentPageId)) throw new Error('学习页面无效');
  if (value.scrollTop !== undefined && (typeof value.scrollTop !== 'number' || !Number.isFinite(value.scrollTop) || value.scrollTop < 0 || value.scrollTop > 10_000_000)) throw new Error('阅读位置无效');
  for (const key of ['restatementDraft', 'summaryDraft']) if (value[key] !== undefined) progressiveText(value[key], PROGRESSIVE_MAX_DRAFT, '学习草稿', true);
  if (value.questionDraft !== undefined) progressiveText(value.questionDraft, 8000, '问题草稿', true);
  if (value.restatementSpans !== undefined) {
    if (!Array.isArray(value.restatementSpans) || value.restatementSpans.length > 1000) throw Error('复述页面定位超过上限');
    let end = 0;
    for (const span of value.restatementSpans) {
      if (!object(span) || !validProgressivePageId(span.pageId) || !Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end)
        || (span.start as number) < end || (span.end as number) <= (span.start as number) || (span.end as number) > PROGRESSIVE_MAX_DRAFT) throw Error('复述页面定位无效');
      end = span.end as number;
    }
  }
  if (value.questions !== undefined) {
    if (!Array.isArray(value.questions) || value.questions.length > 100 || JSON.stringify(value.questions).length > 150_000) throw new Error('问题记录超过保存上限');
    const ids = new Set<string>();
    for (const card of value.questions) {
      if (!object(card)) throw new Error('问题记录格式无效');
      const id = progressiveText(card.id, 200, '问题编号');
      if (ids.has(id)) throw new Error('问题编号重复');
      ids.add(id);
      progressiveText(card.noteId, 300, '问题所属笔记');
      if (projectNoteId && card.noteId !== projectNoteId) throw new Error('问题记录不属于当前学习项目');
      progressiveText(card.question, 8000, '问题内容');
      if (card.answer !== undefined) progressiveText(card.answer, 50_000, '问题答案', true);
      for (const date of ['createdAt', 'answeredAt']) {
        if (card[date] === undefined && date === 'answeredAt') continue;
        if (typeof card[date] !== 'string' || card[date].length > 60 || !Number.isFinite(Date.parse(card[date]))) throw new Error('问题时间格式无效');
      }
    }
  }
}
