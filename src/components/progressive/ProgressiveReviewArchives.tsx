import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { registerEditorInputLeave } from '../../services/ui/editorInputLeave';
import type { ProgressiveCourse } from '../../services/progressiveLearning/types';
import type { ProgressiveReviewSummary, ProgressiveReviewRecord } from '../../services/progressiveLearning/reviewTypes';
import type { FlowAnalysisV2Bundle } from '../../services/flowAnalysis/productionV2';
import { readProgressiveReview, readProgressiveReviewPart, progressiveReviewCommand } from '../../services/progressiveLearning/reviewClient';
import { ProgressiveReviewDialog } from './ProgressiveReviewDialog';
import { ArrowUpRight, Brain, ChevronDown } from 'lucide-react';
import './progressiveLearningRecords.css';
const SavedReport = lazy(() => import('../FlowAnalysisPanel').then(m => ({ default: m.FlowAnalysisPanel })));
const SavedGraph = lazy(() => import('../../modules/argumentCanvas/components/ArgumentDocEmbed').then(m => ({ default: m.ArgumentDocEmbed })));
const status = (r: ProgressiveReviewSummary) => r.status === 'analyzed' ? '已分析' : r.status === 'failed' ? '分析未完成' : r.status === 'running' ? `分析中 ${r.completedParts}/${r.parts}` : r.status === 'saved' ? '本次未记录复述' : '待分析';
export function ProgressiveReviewArchives({ course }: {
    course: ProgressiveCourse;
}) {
    const rows = (course.reviews || []).filter(r => r.parts > 0).slice().sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
    return <section aria-label="复盘分析记录" className="progressive-review-archives progressive-records-ui">
  {!!rows.length && <h4 className="learning-records-section-title">复盘记录<span>{rows.length}</span></h4>}
  <div className="learning-records-timeline">
  {rows.map(row => <ReviewArchive key={row.id} row={row} course={course}/>)}
  </div>
 </section>;
}
function ReviewArchive({ row, course }: {
    row: ProgressiveReviewSummary;
    course: ProgressiveCourse;
}) {
    const projectId = course.projectNoteId;
    const [open, setOpen] = useState(false), [record, setRecord] = useState<ProgressiveReviewRecord | null>(null), [error, setError] = useState('');
    const [dialogOpen, setDialogOpen] = useState(false);
    const [editing, setEditing] = useState(false), [edited, setEdited] = useState(''), [busy, setBusy] = useState(false);
    const editorRef = useRef<HTMLTextAreaElement>(null);
    const pendingRef = useRef(false);
    pendingRef.current = Boolean(editing && record && edited !== (record.editedText ?? record.rawText));
    useEffect(() => registerEditorInputLeave({ pending: () => pendingRef.current ? '归档复述尚未保存，请先保存或取消编辑。' : null,
        element: () => editorRef.current, notify: message => { setError(message); editorRef.current?.focus(); } }), []);
    useEffect(() => { if (!open)
        return; let cancelled = false; void readProgressiveReview(projectId, row.id).then(value => { if (!cancelled) {
        setRecord(value);
        setError('');
        if (!editing)
            setEdited(value.editedText ?? value.rawText);
    } }).catch(() => { if (!cancelled)
        setError('记录读取未完成，原文仍保留；可收起后重试。'); }); return () => { cancelled = true; }; }, [projectId, row.id, row.version, open]);
    const showDialog = () => {
      if (pendingRef.current) { setError('归档复述尚未保存，请先保存或取消编辑。'); editorRef.current?.focus(); return; }
      setDialogOpen(true);
    };
    return <details className={`progressive-page-record learning-record-card is-review${row.status === 'failed' ? ' has-error' : ''}`} data-progressive-review-id={row.id} onToggle={e => setOpen(e.currentTarget.open)}>
  <summary><span className="learning-record-icon"><Brain aria-hidden="true" /></span>
    <span className="learning-record-summary-text"><time dateTime={row.submittedAt}>{new Date(row.submittedAt).toLocaleDateString('zh-CN')}<span>{new Date(row.submittedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span></time><strong>学习复盘</strong><small>{row.completedParts}/{row.parts} 段已分析</small></span>
    <span className={`learning-record-badge${row.status === 'failed' || row.auxiliary === 'failed' ? ' is-error' : row.status === 'analyzed' ? ' is-success' : ' is-pending'}`}>{row.analysisSelection?.status === 'pending' ? '待选择' : status(row)}</span><ChevronDown className="learning-record-chevron" aria-hidden="true" /></summary>
  <div className="learning-record-body">
  {row.error && <p className="learning-record-notice is-error" role="status">{row.error}，已保留原文和完成的 {row.completedParts}/{row.parts} 段。</p>}
  {row.status === 'analyzed' && row.auxiliary !== 'ready' && <p className="learning-record-notice">{row.auxiliary === 'waiting_knowledge' ? '知识点准备中，主分析已保存。' : row.auxiliary === 'failed' ? '部分数据更新待重试，主分析已保存。' : '主分析已保存，正在补充学习数据。'}</p>}
  <div className="learning-record-actions"><button type="button" className="learning-record-action is-primary" disabled={busy} onClick={showDialog}>
    {row.analysisSelection?.status === 'pending' ? '选择知识点并分析' : row.status === 'running' ? '查看分析进度' : row.status === 'pending' ? '继续复盘分析' : row.status === 'failed' || row.auxiliary === 'failed' ? '重试未完成部分' : '查看分析结果'}<ArrowUpRight aria-hidden="true" /></button></div>
  {dialogOpen && <ProgressiveReviewDialog target={{ projectNoteId: projectId, reviewId: row.id, courseId: course.id, environmentId: course.environmentId, noteTitle: course.title }} onClose={() => setDialogOpen(false)} />}
  {error && <p className="learning-record-notice is-error" role="alert">{error}</p>}
  {open && !record && !error && <p className="learning-record-notice" role="status">正在读取复盘记录…</p>}
  {open && record && <>
   <details className="progressive-attempt-record learning-record-detail"><summary>本次实际分析的原文</summary><pre className="learning-record-text">{record.rawText}</pre>{record.summaryText && <p>用户总结：{record.summaryText}</p>}</details>
   {record.editedText !== undefined && <details className="progressive-attempt-record learning-record-detail"><summary>后续编辑的文本 · 分析仍对应原版本</summary><pre className="learning-record-text">{record.editedText}</pre></details>}
   {row.status === 'analyzed' && <details className="progressive-attempt-record learning-record-detail"><summary>编辑归档文本</summary>
    {!editing ? <button type="button" className="learning-record-action" onClick={() => setEditing(true)}>编辑文本</button> : <><textarea className="learning-record-editor" ref={editorRef} aria-label="编辑归档复述" value={edited} maxLength={100000} onChange={e => setEdited(e.target.value)}/><button type="button" className="learning-record-action is-primary" disabled={busy} onClick={() => {
                        setBusy(true);
                        void progressiveReviewCommand({ op: 'review-edit', projectNoteId: projectId, reviewId: row.id, expectedVersion: record.version, text: edited }).then(reply => { if (reply.record)
                            setRecord(reply.record); setEditing(false); setError(''); }).catch(() => setError('归档更新尚未完成，编辑仍保留，请重试。')).finally(() => setBusy(false));
                    }}>保存文本</button><button type="button" className="learning-record-action" disabled={busy} onClick={() => { setEdited(record.editedText ?? record.rawText); setEditing(false); setError(''); }}>取消编辑</button></>}
    <p className="progressive-course-footnote">编辑不会重新分析；已有结果继续对应本次实际分析的原文。</p>
   </details>}
   {record.chunks.map((part, i) => <SavedPart key={part.id + ':' + (part.resultHash || 'pending')} projectId={projectId} reviewId={row.id} partId={part.id} number={i + 1} ready={Boolean(part.resultHash)}/>)}
  </>}
  </div>
 </details>;
}
function SavedPart({ projectId, reviewId, partId, number, ready }: {
    projectId: string;
    reviewId: string;
    partId: string;
    number: number;
    ready: boolean;
}) {
    const [data, setData] = useState<FlowAnalysisV2Bundle | null>(null), [error, setError] = useState(''), [showReport, setShowReport] = useState(false), [showGraph, setShowGraph] = useState(false);
    return <details className="progressive-attempt-record learning-record-detail" onToggle={event => { if (!event.currentTarget.open || data || !ready)
        return; void readProgressiveReviewPart(projectId, reviewId, partId).then(value => { setData(value); setError(''); }).catch(() => setError('结果读取失败，可以收起后重试。')); }}>
  <summary>第{number}段 · {ready ? '已分析' : '未完成'}</summary>
  {error && <p role="alert">{error}</p>}
  {ready && !data && !error && <p>正在读取已保存结果…</p>}
  {data && <><p>{data.report.summary}</p>{data.report.recommendation && <p>{data.report.recommendation}</p>}
   <button type="button" className="learning-record-action" onClick={() => setShowReport(true)}>查看分析详情</button>
   <details onToggle={event => setShowGraph(event.currentTarget.open)}><summary>查看原始分析结构图</summary>{showGraph && <Suspense fallback={<p>正在加载结构图…</p>}><SavedGraph doc={data.argumentDoc}/></Suspense>}</details>
   {showReport && <Suspense fallback={<p>正在打开已保存报告…</p>}><SavedReport speakingContent={data.analysisV2.record.input.rawText} noteTitle="已保存的学习复盘" allNotes={[]} onClose={() => setShowReport(false)} autoRun={false} initialReport={data.report}/></Suspense>}
  </>}
 </details>;
}
