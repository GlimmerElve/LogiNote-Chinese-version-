import { ProgressiveReviewArchives } from './ProgressiveReviewArchives';
import { progressiveReviewEligible } from '../../services/progressiveLearning/reviewPolicy';
import React, { useState } from 'react';
import type { ProgressiveCourse, ProgressivePageStudy, ProgressiveQuestion } from '../../services/progressiveLearning/types';
import { readProgressivePage } from '../../services/progressiveLearning/client';
import { QuickCheckText } from '../quickCheck/QuickCheckText';

export function ProgressiveLearningRecords({ course, showEmpty = false }: { course: ProgressiveCourse; showEmpty?: boolean }) {
  const draft = course.progress.restatementDraft, summary = course.progress.summaryDraft;
  const hasDraft = Boolean(draft.replace(/^\s*##\s*复盘\s*[·•].*$/gmu, '').trim() || summary.trim());
  const pages = course.pages || [];
  const submitted = (kind: 'mainline' | 'expansion') => pages.filter(page => page.kind === kind)
    .reduce((count, page) => count + (course.studyPages?.find(ref => ref.pageId === page.id)?.submitted || 0), 0);
  const mainPending = pages.filter(page => page.kind === 'mainline').reduce((count, page) => count + (course.studyPages?.find(ref => ref.pageId === page.id)?.pending ?? page.questionCount ?? 0), 0);
  const records = [...(course.studyPages || [])].filter(ref => ref.version > 0).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (!hasDraft && !records.length && !course.reviews?.length && !course.lastSuccessfulReview && !course.completion) return showEmpty ? <p className="progressive-records-empty">暂无学习记录。完成作答或复盘后，可在这里查看。</p> : null;
  return <section className="progressive-learning-records" aria-label="渐进学习记录">
    <h3>学习记录</h3>
    <p className="progressive-course-footnote">主线已提交 {submitted('mainline')} 题 · 待提交 {mainPending} 题 · 补充已提交 {submitted('expansion')} 题</p>
    {hasDraft && <details className="progressive-private-draft"><summary>待分析复述草稿 · 未分析</summary>
      {draft && <div><strong>我的复述</strong><pre>{draft}</pre></div>}
      {summary && <div><strong>本次总结</strong><pre>{summary}</pre></div>}
      {!progressiveReviewEligible(draft)&&<p className="progressive-course-footnote">复述尚不足10个有效字符，原文已保存，暂未启动正式分析。</p>}
    </details>}
    <ProgressiveReviewArchives course={course}/>
    {records.map(ref => <PageRecord key={`${course.id}:${ref.pageId}:${ref.version}`} projectNoteId={course.projectNoteId} pageId={ref.pageId}
      title={pages.find(page => page.id === ref.pageId)?.title || '历史页面'}
      updatedAt={ref.updatedAt} submitted={ref.submitted} pending={ref.pending} />)}
  </section>;
}
function PageRecord({ projectNoteId, pageId, title, updatedAt, submitted, pending }: {
  projectNoteId: string; pageId: string; title: string; updatedAt: string; submitted: number; pending: number;
}) {
  const [study, setStudy] = useState<ProgressivePageStudy | null>(null), [error, setError] = useState('');
  const [questions, setQuestions] = useState<ProgressiveQuestion[]>([]);
  return <details className="progressive-page-record" onToggle={event => {
    if (!event.currentTarget.open || study) return;
    void readProgressivePage(projectNoteId, pageId).then(course => { setStudy(course.study || null); setQuestions(course.page?.questions || []); setError(''); })
      .catch(() => setError('本页记录读取失败，原记录仍保留；可收起后重试。'));
  }}>
    <summary>{new Date(updatedAt).toLocaleString()} · <QuickCheckText text={title} /> · 已提交 {submitted} 题{pending ? `，待提交 ${pending} 题` : ''}</summary>
    {error && <p role="alert">{error}</p>}
    {!study && !error && <p>正在读取本页记录…</p>}
    {study && Object.entries(study.drafts).filter(([id, draft]) => {
      if (!draft.text.trim() && !draft.optionId && !draft.formulaDraft?.trim()) return false;
      const submitted = study.attempts.filter(attempt => attempt.questionId === id).at(-1)?.answer;
      return !submitted || draft.text !== submitted.text || draft.optionId !== submitted.optionId
        || (draft.formulaDraft || '') !== (submitted.formulaDraft || '');
    }).map(([id, draft]) => {
      const question = questions.find(item => item.id === id);
      return <details key={`draft-${id}`} className="progressive-attempt-record">
        <summary>第{id.slice(1)}题 · 未提交草稿</summary>
        {question && <QuickCheckText text={question.prompt} recoverPlainMath />}
        <QuickCheckText text={draft.optionId ? question?.options?.find(option => option.id === draft.optionId)?.text || draft.optionId : draft.text} />
        {draft.formulaDraft && <p>待插入公式：<QuickCheckText text={`$${draft.formulaDraft}$`} /></p>}
      </details>;
    })}
    {study?.attempts.map((attempt, index, all) => <details key={attempt.id} className="progressive-attempt-record">
      <summary>{all.slice(0, index).some(item => item.questionId === attempt.questionId) ? '再次作答' : '首次作答'} · 第{attempt.questionId.slice(1)}题
        {' · '}{new Date(attempt.submittedAt).toLocaleString()} · {!attempt.judgment ? '待判定' : attempt.judgment.outcome === 'correct' ? '回答正确' : attempt.judgment.outcome === 'incorrect' ? '需要核对' : '暂不能确定'}</summary>
      <QuickCheckText text={attempt.question.prompt} recoverPlainMath />
      <p><strong>我的回答：</strong><QuickCheckText text={attempt.answer.optionId
        ? attempt.question.options?.find(option => option.id === attempt.answer.optionId)?.text || attempt.answer.optionId : attempt.answer.text} /></p>
      {attempt.judgment && <><QuickCheckText text={attempt.judgment.explanation} recoverPlainMath /><p><strong>参考答案：</strong><QuickCheckText text={attempt.judgment.referenceAnswer} recoverPlainMath /></p></>}
    </details>)}
    {study?.feedback.map(item => <details key={item.id} className="progressive-attempt-record">
      <summary>题目反馈 · 第{item.questionId.slice(1)}题 · {item.status === 'pending' ? '待核实' : item.status === 'confirmed' ? '反馈成立' : '已核实'}</summary>
      <p>{item.text}</p>{item.explanation && <QuickCheckText text={item.explanation} recoverPlainMath />}
    </details>)}
  </details>;
}
