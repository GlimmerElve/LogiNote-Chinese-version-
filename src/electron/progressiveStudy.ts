import { createHash, randomUUID } from 'node:crypto';
import type { ProgressiveAdaptation, ProgressiveCourse, ProgressiveLessonPage, ProgressivePageStudy,
  ProgressiveQuestion, ProgressiveStudyMutation, ProgressiveStudySummary } from '../services/progressiveLearning/types';
import { progressiveText, projectProgressiveQuestion, validateProgressiveJudgment, validateProgressiveQuestions } from '../services/progressiveLearning/validation';
import { pageRestatement } from '../services/progressiveLearning/restatement';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const id = (value: unknown) => progressiveText(value, 150, '学习记录编号');
export const progressiveQuestionHash = (question: ProgressiveQuestion) => hash(projectProgressiveQuestion(question));
export function emptyProgressiveStudy(pageId: string): ProgressivePageStudy {
  return { schemaVersion: 1, pageId, version: 0, updatedAt: '', drafts: {}, attempts: [], feedback: [] };
}
export function validateStoredProgressiveStudy(study: ProgressivePageStudy): void {
  if (Array.isArray(study.drafts) || !Number.isSafeInteger(study.version) || study.version < 1
    || !Number.isFinite(Date.parse(study.updatedAt))) throw Error('学习记录版本或草稿无效');
  const ids = new Set<string>();
  for (const attempt of study.attempts) {
    if (!attempt || typeof attempt !== 'object') throw Error('作答记录无效');
    id(attempt.id); id(attempt.submissionId);
    if (ids.has(attempt.id) || !/^[a-f0-9]{64}$/u.test(attempt.questionHash) || !/^[a-f0-9]{64}$/u.test(attempt.pageHash)
      || !Number.isFinite(Date.parse(attempt.submittedAt))) throw Error('作答记录版本无效');
    ids.add(attempt.id); validateProgressiveQuestions([attempt.question]);
    if (attempt.questionId !== attempt.question.id || attempt.questionHash !== progressiveQuestionHash(attempt.question)) throw Error('原题与作答记录不一致');
    answerDraft(attempt.answer, attempt.question);
    if (attempt.judgment) validateProgressiveJudgment(attempt.judgment);
  }
  ids.clear();
  for (const feedback of study.feedback) {
    if (!feedback || typeof feedback !== 'object' || !/^q[1-3]$/u.test(feedback.questionId)
      || !['question', 'answer', 'grading'].includes(feedback.category) || !['pending', 'confirmed', 'not-confirmed'].includes(feedback.status)
      || !Number.isFinite(Date.parse(feedback.createdAt))) throw Error('题目反馈记录无效');
    id(feedback.id); if (ids.has(feedback.id)) throw Error('题目反馈编号重复'); ids.add(feedback.id);
    progressiveText(feedback.text, 2000, '题目反馈');
    if (feedback.explanation !== undefined) progressiveText(feedback.explanation, 2200, '反馈核实说明');
  }
  for (const [key, draft] of Object.entries(study.drafts)) {
    if (!/^q[1-3]$/u.test(key) || !draft || typeof draft !== 'object') throw Error('作答草稿无效');
    progressiveText(draft.text, 8000, '作答草稿', true);
    if (draft.formulaDraft !== undefined) progressiveText(draft.formulaDraft, 4000, '公式草稿', true);
  }
}
export function progressiveStudySummary(study: ProgressivePageStudy, page: ProgressiveLessonPage): ProgressiveStudySummary {
  const submitted = (page.questions || []).filter(question => study.attempts.some(attempt => attempt.questionId === question.id
    && attempt.questionHash === progressiveQuestionHash(question))).length;
  return { pageId: page.id, version: study.version, updatedAt: study.updatedAt, submitted,
    pending: (page.questions?.length || 0) - submitted, attempts: study.attempts.length };
}
function answerDraft(value: unknown, question: ProgressiveQuestion) {
  const draft = value as { text: string; optionId?: string; formulaDraft?: string };
  if (!draft || typeof draft !== 'object' || Object.keys(draft).some(key => !['text', 'optionId', 'formulaDraft'].includes(key))) throw Error('作答草稿格式无效');
  progressiveText(draft.text, 8000, '作答草稿', true);
  if (draft.formulaDraft !== undefined) progressiveText(draft.formulaDraft, 4000, '公式草稿', true);
  if (draft.optionId !== undefined && !question.options?.some(option => option.id === draft.optionId)) throw Error('作答选项不属于当前题目');
  return { text: draft.text, ...(draft.optionId ? { optionId: draft.optionId } : {}), ...(draft.formulaDraft !== undefined ? { formulaDraft: draft.formulaDraft } : {}) };
}
/** A model result can only complete an already saved user submission; it cannot manufacture one. */
export function mutateProgressiveStudy(old: ProgressivePageStudy, page: ProgressiveLessonPage, pageHash: string,
  mutation: ProgressiveStudyMutation): ProgressivePageStudy {
  if (!mutation || typeof mutation !== 'object') throw Error('学习记录请求无效');
  const next = structuredClone(old), questions = page.questions || [], now = new Date().toISOString();
  const question = (questionId: string) => {
    const found = questions.find(item => item.id === questionId);
    if (!found) throw Error('题目不属于当前保存页');
    return found;
  };
  switch (mutation.kind) {
    case 'view-explanation': {
      const attempt=next.attempts.find(a=>a.id===mutation.attemptId);
      if(!attempt?.judgment)throw Error('该作答的解析尚未生成');
      if(next.explanationViews?.some(v=>v.attemptId===attempt.id))return old;
      next.explanationViews=[...(next.explanationViews||[]),{attemptId:attempt.id,viewedAt:now}];break;
    }
    case 'draft': {
      if (!mutation.drafts || typeof mutation.drafts !== 'object' || Array.isArray(mutation.drafts) || Object.keys(mutation.drafts).length > 3) throw Error('作答草稿格式无效');
      for (const [key, value] of Object.entries(mutation.drafts)) next.drafts[key] = answerDraft(value, question(key));
      break;
    }
    case 'submit': {
      id(mutation.submissionId);
      if (!Array.isArray(mutation.questionIds) || !mutation.questionIds.length || mutation.questionIds.length > 3
        || new Set(mutation.questionIds).size !== mutation.questionIds.length) throw Error('提交题目无效');
      const existing = old.attempts.filter(attempt => attempt.submissionId === mutation.submissionId);
      if (existing.length) {
        if (!same(existing.map(attempt => attempt.questionId).sort(), [...mutation.questionIds].sort())) throw Error('原提交记录已存在，不替换作答');
        return old;
      }
      if (old.attempts.length + mutation.questionIds.length > 90) throw Error('本页作答记录已达上限，原记录仍保留');
      for (const key of mutation.questionIds) {
        const definition = question(key), answer = answerDraft(old.drafts[key], definition);
        if (definition.kind === 'application' ? !answer.text.trim() : !answer.optionId) throw Error('空白题目保留待答，不能代为提交');
        next.attempts.push({ id: `answer-${randomUUID()}`, submissionId: mutation.submissionId, questionId: key,
          questionHash: progressiveQuestionHash(definition), pageHash, question: projectProgressiveQuestion(definition), answer,
          assistance:old.attempts.some(a=>a.questionId===key)||old.explanationViews?.some(v=>old.attempts.find(a=>a.id===v.attemptId)?.questionId===key)?'assisted':'independent',
          submittedAt: now });
      }
      break;
    }
    case 'grade': {
      if (!Array.isArray(mutation.results) || !mutation.results.length || mutation.results.length > 3
        || new Set(mutation.results.map(result => result.attemptId)).size !== mutation.results.length) throw Error('判题记录无效');
      for (const result of mutation.results) {
        const attempt = next.attempts.find(item => item.id === result.attemptId);
        if (!attempt) throw Error('不能为未提交的作答制造判定');
        validateProgressiveJudgment(result.judgment);
        if (attempt.judgment) {
          if (!same(attempt.judgment, result.judgment)) throw Error('已有判定保留原版本，不接受迟到替换');
          continue;
        }
        if (attempt.pageHash !== pageHash || attempt.questionHash !== progressiveQuestionHash(question(attempt.questionId))) throw Error('原题内容已变化，原作答保留，不能套用新题判定');
        const judgment = result.judgment;
        const quote = judgment.referenceQuote && page.body.replace(/\s+/gu, ' ').includes(judgment.referenceQuote.replace(/\s+/gu, ' ')) ? judgment.referenceQuote : undefined;
        if (attempt.question.kind === 'application' && judgment.outcome !== 'unverifiable' && !quote)
          throw Error('应用题判定尚未核实本页依据，原作答保持待判');
        attempt.judgment = { outcome: judgment.outcome, errorKind: judgment.errorKind,
          explanation: judgment.explanation, referenceAnswer: judgment.referenceAnswer,
          ...(quote ? { referenceQuote: quote } : {}) };
        attempt.gradedAt = now;
      }
      break;
    }
    case 'feedback': {
      const value = mutation.feedback;
      if (!value || !['question', 'answer', 'grading'].includes(value.category)) throw Error('题目反馈无效');
      id(value.id); question(value.questionId); progressiveText(value.text, 2000, '题目反馈');
      if (value.attemptId && !old.attempts.some(attempt => attempt.id === value.attemptId && attempt.questionId === value.questionId)) throw Error('反馈对应的作答记录不存在');
      const prior = old.feedback.find(item => item.id === value.id);
      if (prior) {
        if (prior.text !== value.text || prior.questionId !== value.questionId || prior.category !== value.category) throw Error('原反馈已保存，不能用不同内容覆盖');
        return old;
      }
      if (old.feedback.length >= 60) throw Error('本页反馈记录已达上限');
      next.feedback.push({ id: value.id, questionId: value.questionId, category: value.category, text: value.text,
        ...(value.attemptId ? { attemptId: value.attemptId } : {}), createdAt: now, status: 'pending' });
      break;
    }
    case 'verify-feedback': {
      const feedback = next.feedback.find(item => item.id === mutation.feedbackId);
      if (!feedback || !['pending', 'confirmed', 'not-confirmed'].includes(mutation.status)) throw Error('待核实反馈不存在');
      progressiveText(mutation.explanation, 2200, '反馈核实说明');
      if (feedback.status !== 'pending') {
        if (feedback.status !== mutation.status) throw Error('反馈已核实，不接受迟到替换');
        return old;
      }
      feedback.status = mutation.status; feedback.explanation = mutation.explanation;
      break;
    }
    default: throw Error('学习记录操作无效');
  }
  if (same(next, old)) return old;
  return { ...next, version: old.version + 1, updatedAt: now };
}
export function progressiveAdaptation(course: Pick<ProgressiveCourse, 'progress' | 'plan' | 'pages' | 'consumedFeedback' | 'consumedSignals' | 'budget'>, page: ProgressiveLessonPage, study: ProgressivePageStudy): ProgressiveAdaptation {
  const previous = course.consumedSignals?.[page.id];
  const text = pageRestatement(course.progress.restatementDraft, course.progress.restatementSpans || [], page.id).slice(-6000);
  const restatementKey = text ? hash(text) : undefined;
  const restatement = restatementKey && !previous?.restatements.includes(restatementKey) ? text : '';
  const attemptIds: string[] = [];
  const eligible = (page.questions || []).flatMap(question => {
    if (study.feedback.some(item => item.questionId === question.id && item.status !== 'not-confirmed')) return [];
    const attempt = study.attempts.filter(item => item.questionId === question.id && item.questionHash === progressiveQuestionHash(question)).at(-1);
    if (!attempt?.judgment || attempt.judgment.outcome === 'unverifiable') return [];
    if (previous?.attemptIds.includes(attempt.id)) return [];
    attemptIds.push(attempt.id);
    return [{ question: question.prompt, answer: attempt.answer.optionId
      ? question.options?.find(option => option.id === attempt.answer.optionId)?.text || '' : attempt.answer.text,
      outcome: attempt.judgment.outcome, errorKind: attempt.judgment.errorKind, explanation: attempt.judgment.explanation }];
  });
  // Scrolls and unrelated drafts are deliberately absent from the feedback identity.
  const feedbackKey = hash({ pageId: page.id, restatement, attemptIds });
  const remainingMainline = course.plan?.pages.filter(main => !course.pages?.some(saved => saved.id === main.id)).length || 0;
  return { feedbackKey, fresh: Boolean(restatement || eligible.length) && course.consumedFeedback?.[page.id] !== feedbackKey,
    restatement, answers: eligible, remainingMainline,
    signals: { ...(restatement ? { restatementKey } : {}), attemptIds },
    expansionAvailable: (course.pages?.length || 0) + remainingMainline < course.budget.totalPageLimit };
}
export function consumeProgressiveSignals(course: Pick<ProgressiveCourse, 'consumedSignals'>, pageId: string, adaptation: ProgressiveAdaptation) {
  const previous = course.consumedSignals?.[pageId] || { restatements: [], attemptIds: [] };
  return { ...course.consumedSignals, [pageId]: {
    restatements: [...new Set([...previous.restatements, ...(adaptation.signals?.restatementKey ? [adaptation.signals.restatementKey] : [])])].slice(-64),
    attemptIds: [...new Set([...previous.attemptIds, ...(adaptation.signals?.attemptIds || [])])].slice(-128),
  } };
}
