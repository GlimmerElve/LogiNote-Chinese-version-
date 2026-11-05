import React, { useEffect, useState } from 'react';
import type { ProgressiveAnswerDraft, ProgressivePageStudy, ProgressiveQuestion } from '../../services/progressiveLearning/types';
import type { ProgressiveController } from '../../services/progressiveLearning/runtime';
import { QuickCheckText } from '../quickCheck/QuickCheckText';
import { MathLiveAnswer } from '../quickCheck/MathLiveAnswer';

export function ProgressiveQuiz({ pageId, questions, study, busy, busyQuestions, error, controller }: {
  pageId: string; questions: ProgressiveQuestion[]; study: ProgressivePageStudy | null | undefined;
  busy: boolean; busyQuestions?: string[]; error?: string | null; controller: ProgressiveController;
}) {
  if (!questions.length || !study) return null;
  const pending = questions.filter(question => !study.attempts.some(attempt => attempt.questionId === question.id)).length;
  return <section className="progressive-quiz" aria-label="本页答题" data-progressive-quiz>
    <header><strong>试着应用一下</strong><small>{pending ? `${pending} 题待提交，可先继续阅读` : '本页题目已提交'}</small></header>
    {questions.map(question => <Question key={`${pageId}:${question.id}`} pageId={pageId} question={question} study={study}
      busy={busyQuestions ? busyQuestions.includes(question.id) : busy} controller={controller} />)}
    {error && <p className="progressive-study-error" role="alert">{error}</p>}
    <p className="progressive-course-footnote">下一页不会代为提交答案；未提交内容会作为草稿保留。</p>
  </section>;
}

function Question({ pageId, question, study, busy, controller }: {
  pageId: string; question: ProgressiveQuestion; study: ProgressivePageStudy; busy: boolean; controller: ProgressiveController;
}) {
  const attempt = study.attempts.filter(item => item.questionId === question.id).at(-1);
  const [retaking, setRetaking] = useState(false), [feedback, setFeedback] = useState('');
  const [category, setCategory] = useState<'question' | 'answer' | 'grading'>('question');
  const [feedbackError, setFeedbackError] = useState('');
  const feedbackRows = study.feedback.filter(item => item.questionId === question.id);
  const draft = study.drafts[question.id] || { text: '' };
  const editable = !attempt || retaking;
  const display = editable ? draft : attempt.answer;
  const hasAnswer = question.kind === 'application' ? Boolean(draft.text.trim()) : Boolean(draft.optionId);
  useEffect(() => setRetaking(false), [attempt?.id]);
  useEffect(() => { if (feedbackRows.at(-1)?.text === feedback) setFeedback(''); }, [feedbackRows.at(-1)?.id]);
  const change = (patch: Partial<ProgressiveAnswerDraft>) => controller.saveAnswerDraft?.(question.id, { ...draft, ...patch });
  return <article className="progressive-question" data-question-id={question.id}>
    <div className="progressive-question-prompt"><strong>{question.id.slice(1)}.</strong><QuickCheckText text={question.prompt} recoverPlainMath /></div>
    {question.options ? <fieldset disabled={busy || !editable} aria-label={`第${question.id.slice(1)}题选项`}>
      {question.options.map(option => <label key={option.id} className={display.optionId === option.id ? 'is-selected' : ''}>
        <input type="radio" name={`${pageId}-${question.id}`} value={option.id} checked={display.optionId === option.id}
          onChange={() => change({ text: '', optionId: option.id })} />
        <QuickCheckText text={option.text} recoverPlainMath />
      </label>)}
    </fieldset> : <MathLiveAnswer id={`${pageId}-${question.id}-answer`} value={display.text}
      onChange={text => change({ text })} formulaDraft={editable ? draft.formulaDraft || '' : ''}
      onFormulaDraftChange={formulaDraft => change({ formulaDraft })} maxLength={8000} disabled={busy || !editable}
      placeholder="写下你的回答和思路，也可以插入公式…" />}
    <div className="progressive-question-actions">
      {editable ? <button type="button" disabled={busy || !hasAnswer} onClick={() => { void controller.submitAnswers?.([question.id]); }}>
        {busy ? '正在保存与判定…' : retaking ? '提交本次重答' : '提交答案'}
      </button> : <button type="button" disabled={busy} onClick={() => setRetaking(true)}>重新作答</button>}
      {attempt && <span className="progressive-answer-state" role="status">
        {!attempt.judgment ? '已提交 · 待判定' : attempt.judgment.outcome === 'correct' ? '已提交 · 回答正确'
          : attempt.judgment.outcome === 'incorrect' ? '已提交 · 需要再核对' : '已提交 · 暂不能确定'}
      </span>}
      {attempt && !attempt.judgment && <button type="button" disabled={busy} onClick={() => { void controller.retryGrading?.(); }}>重试判定</button>}
    </div>
    {attempt?.judgment && <details className="progressive-answer-explanation" onToggle={event=>{if(event.currentTarget.open)void controller.markExplanationViewed?.(question.id).catch(()=>{});}}>
      <summary>查看解析与参考答案</summary>
      <QuickCheckText text={attempt.judgment.explanation} recoverPlainMath /><p><strong>参考答案：</strong><QuickCheckText text={attempt.judgment.referenceAnswer} recoverPlainMath /></p>
    </details>}
    <details className="progressive-question-feedback">
      <summary>反馈此题</summary>
      <label>反馈类型<select aria-label="题目反馈类型" value={category} onChange={event => setCategory(event.target.value as typeof category)}>
        <option value="question">题干或条件有问题</option><option value="answer">参考答案有问题</option><option value="grading">判定有问题</option>
      </select></label>
      <textarea aria-label="题目反馈内容" value={feedback} maxLength={2000} onChange={event => { setFeedback(event.target.value); setFeedbackError(''); }} placeholder="说明你希望核实的条件、答案或判定…" />
      <button type="button" disabled={busy || !feedback.trim()} onClick={() => {
        if (!feedback.trim()) { setFeedbackError('请填写需要核实的内容'); return; }
        void controller.sendFeedback?.(question.id, category, feedback);
      }}>提交反馈</button>
      {feedbackError && <p role="alert">{feedbackError}</p>}
      {feedbackRows.map(item => <div key={item.id} className="progressive-feedback-record">
        <small>{item.status === 'pending' ? '待核实' : item.status === 'confirmed' ? '反馈成立' : '已核实，暂未发现所述问题'} · {new Date(item.createdAt).toLocaleString()}</small>
        <p>{item.text}</p>{item.explanation && <QuickCheckText text={item.explanation} recoverPlainMath />}
        {item.status === 'pending' && <button type="button" disabled={busy} onClick={() => { void controller.retryFeedback?.(item.id); }}>重试核实</button>}
      </div>)}
      {feedbackRows.some(item => item.status !== 'not-confirmed') && <p className="progressive-course-footnote">此题存在待核实或已确认的问题，不用它的争议判定触发负向补充。</p>}
    </details>
  </article>;
}
