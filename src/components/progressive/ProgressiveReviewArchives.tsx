import React, { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { registerEditorInputLeave } from '../../services/ui/editorInputLeave';
import type { ProgressiveCourse } from '../../services/progressiveLearning/types';
import type { ProgressiveReviewSummary, ProgressiveReviewRecord } from '../../services/progressiveLearning/reviewTypes';
import type { FlowAnalysisV2Bundle } from '../../services/flowAnalysis/productionV2';
import { readProgressiveReview, readProgressiveReviewPart, progressiveReviewCommand } from '../../services/progressiveLearning/reviewClient';
const SavedReport = lazy(() => import('../FlowAnalysisPanel').then(m => ({ default: m.FlowAnalysisPanel })));
const SavedGraph = lazy(() => import('../../modules/argumentCanvas/components/ArgumentDocEmbed').then(m => ({ default: m.ArgumentDocEmbed })));
const status = (r: ProgressiveReviewSummary) => r.status === 'analyzed' ? '已分析' : r.status === 'failed' ? '分析未完成' : r.status === 'running' ? `分析中 ${r.completedParts}/${r.parts}` : r.status === 'saved' ? '本次未记录复述' : '待分析';
export function ProgressiveReviewArchives({ course }: {
    course: ProgressiveCourse;
}) {
    const rows = (course.reviews || []).filter(r => r.parts > 0).slice().sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
    return <section aria-label="复盘分析记录" className="progressive-review-archives">
  {course.lastSuccessfulReview && <p className="progressive-course-footnote">本项目已有有效复盘，历史原文在记录中保留。</p>}
  {course.completion?.status === 'committed' && <p className="progressive-course-footnote">学习流程已完成，知识掌握情况另行记录。</p>}
  {rows.map(row => <ReviewArchive key={row.id} row={row} projectId={course.projectNoteId}/>)}
 </section>;
}
function ReviewArchive({ row, projectId }: {
    row: ProgressiveReviewSummary;
    projectId: string;
}) {
    const [open, setOpen] = useState(false), [record, setRecord] = useState<ProgressiveReviewRecord | null>(null), [error, setError] = useState('');
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
    return <details className="progressive-page-record" data-progressive-review-id={row.id} onToggle={e => setOpen(e.currentTarget.open)}>
  <summary>{new Date(row.submittedAt).toLocaleString()} · 复盘 · {status(row)}</summary>
  {row.error && <p role="status">{row.error}，已保留原文和完成的 {row.completedParts}/{row.parts} 段。</p>}
  {row.status === 'analyzed' && row.auxiliary !== 'ready' && <p className="progressive-course-footnote">主分析已成功。{row.auxiliary === 'waiting_knowledge' ? '知识点对象尚在准备，评价稍后补充。' : row.auxiliary === 'failed' ? '部分知识点或画像处理未完成。' : '正在补充知识点和画像记录。'}</p>}
  {(row.status === 'failed' || row.auxiliary === 'failed' || row.status === 'pending' && row.activated === false) && <button type="button" disabled={busy} onClick={() => {
                setBusy(true);
                void progressiveReviewCommand({ op: 'review-retry', projectNoteId: projectId, reviewId: row.id }).catch(() => setError('重试请求未保存，请稍后重试。')).finally(() => setBusy(false));
            }}>重试未完成部分</button>}
  {error && <p role="alert">{error}</p>}
  {open && !record && !error && <p>正在读取复盘记录…</p>}
  {open && record && <>
   <details className="progressive-attempt-record"><summary>本次实际分析的原文</summary><pre>{record.rawText}</pre>{record.summaryText && <p>用户总结：{record.summaryText}</p>}</details>
   {record.editedText !== undefined && <details className="progressive-attempt-record"><summary>后续编辑的文本 · 分析仍对应原版本</summary><pre>{record.editedText}</pre></details>}
   {row.status === 'analyzed' && <details className="progressive-attempt-record"><summary>编辑归档文本</summary>
    {!editing ? <button type="button" onClick={() => setEditing(true)}>编辑文本</button> : <><textarea ref={editorRef} aria-label="编辑归档复述" value={edited} maxLength={100000} onChange={e => setEdited(e.target.value)}/><button type="button" disabled={busy} onClick={() => {
                        setBusy(true);
                        void progressiveReviewCommand({ op: 'review-edit', projectNoteId: projectId, reviewId: row.id, expectedVersion: record.version, text: edited }).then(reply => { if (reply.record)
                            setRecord(reply.record); setEditing(false); setError(''); }).catch(() => setError('文本尚未保存，编辑仍保留，请重试。')).finally(() => setBusy(false));
                    }}>保存文本</button><button type="button" disabled={busy} onClick={() => { setEdited(record.editedText ?? record.rawText); setEditing(false); setError(''); }}>取消编辑</button></>}
    <p className="progressive-course-footnote">编辑不会重新分析；已有结果继续对应本次实际分析的原文。</p>
   </details>}
   {record.chunks.map((part, i) => <SavedPart key={part.id + ':' + (part.resultHash || 'pending')} projectId={projectId} reviewId={row.id} partId={part.id} number={i + 1} ready={Boolean(part.resultHash)}/>)}
  </>}
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
    return <details className="progressive-attempt-record" onToggle={event => { if (!event.currentTarget.open || data || !ready)
        return; void readProgressiveReviewPart(projectId, reviewId, partId).then(value => { setData(value); setError(''); }).catch(() => setError('结果读取失败，可以收起后重试。')); }}>
  <summary>第{number}段 · {ready ? '已分析' : '未完成'}</summary>
  {error && <p role="alert">{error}</p>}
  {ready && !data && !error && <p>正在读取已保存结果…</p>}
  {data && <><p>{data.report.summary}</p>{data.report.recommendation && <p>{data.report.recommendation}</p>}
   <button type="button" onClick={() => setShowReport(true)}>查看分析详情</button>
   <details onToggle={event => setShowGraph(event.currentTarget.open)}><summary>查看关联结构图</summary>{showGraph && <Suspense fallback={<p>正在加载结构图…</p>}><SavedGraph doc={data.argumentDoc}/></Suspense>}</details>
   {showReport && <Suspense fallback={<p>正在打开已保存报告…</p>}><SavedReport speakingContent={data.analysisV2.record.input.rawText} noteTitle="已保存的学习复盘" allNotes={[]} onClose={() => setShowReport(false)} autoRun={false} initialReport={data.report}/></Suspense>}
  </>}
 </details>;
}
