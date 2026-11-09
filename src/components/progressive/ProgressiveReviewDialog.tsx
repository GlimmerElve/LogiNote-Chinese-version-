import React, { lazy, Suspense, useCallback, useEffect, useId, useRef, useState } from 'react';
import { AlertCircle, BookOpen, Check, Loader2, RefreshCw, X, Pencil, Save } from 'lucide-react';
import { useDialog } from '../useDialog';
import { loadProgressiveCourse } from '../../services/progressiveLearning/client';
import { onProgressiveChange, progressiveReviewCommand, readProgressiveReview, readProgressiveReviewPart, readProgressiveAuxiliary } from '../../services/progressiveLearning/reviewClient';
import type { ProgressiveReviewRecord, ProgressiveReviewSelectionCandidate, ProgressiveReviewSelectionReply, ProgressiveAuxiliaryResult, ProgressiveReviewGraphReply, ProgressiveReviewReply } from '../../services/progressiveLearning/reviewTypes';
import { createProgressiveReviewRefreshQueue } from '../../services/progressiveLearning/reviewRefresh';
import { verifyProgressiveAuxiliaryBinding } from '../../services/progressiveLearning/reviewFeedback';
import { ProgressiveMasteryFeedback } from './ProgressiveMasteryFeedback';
import type { FlowAnalysisV2Bundle } from '../../services/flowAnalysis/productionV2';
import type { ArgDoc } from '../../services/argumentDoc/types';
import type { ProgressiveGraphEditorHandle } from './ProgressiveReviewGraphEditor';
import { registerEditorInputLeave } from '../../services/ui/editorInputLeave';
import { progressiveGraphEditKey as graphEditKey, progressiveReviewGraphSourceKey as graphSourceKey } from '../../services/progressiveLearning/reviewGraphEdit';
import '../LearningAnalysisDialogs.css';
import './progressiveReviewDialog.css';

const SavedReport = lazy(() => import('../FlowAnalysisPanel').then(module => ({ default: module.FlowAnalysisPanel })));
const SavedGraph = lazy(() => import('../../modules/argumentCanvas/components/ArgumentDocEmbed').then(module => ({ default: module.ArgumentDocEmbed })));
const GraphEditor = lazy(() => import('./ProgressiveReviewGraphEditor').then(module => ({ default: module.ProgressiveReviewGraphEditor })));
const RESULT_TABS = [
  { id: 'graph', label: '逻辑结构图' },
  { id: 'report', label: '分析报告' },
  { id: 'mastery', label: '知识点反馈' },
] as const;
type ResultTab = typeof RESULT_TABS[number]['id'];
export interface ProgressiveReviewDialogTarget {
  projectNoteId: string;
  reviewId: string;
  courseId: string;
  environmentId: string;
  noteTitle: string;
  partId?: string;
}

/** Foreground presentation only. The native archive/worker remains the single analysis writer. */
export function ProgressiveReviewDialog({ target, onClose, onStarted }: {
  target: ProgressiveReviewDialogTarget;
  onClose(): void;
  onStarted?(projectNoteId: string): void;
}) {
  const titleId = useId(), descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null), alive = useRef(true), request = useRef(0), writing = useRef(false);
  const scope = JSON.stringify([target.environmentId, target.courseId, target.projectNoteId, target.reviewId, target.partId || '']);
  const scopeRef = useRef(scope); scopeRef.current = scope;
  const refreshQueue = useRef<ReturnType<typeof createProgressiveReviewRefreshQueue> | null>(null);
  const auxiliaryCache = useRef<{ scope: string; hash: string; value: ProgressiveAuxiliaryResult } | null>(null);
  const [auxiliary, setAuxiliary] = useState<{ scope: string; hash: string; value: ProgressiveAuxiliaryResult } | null>(null);
  const [auxiliaryError, setAuxiliaryError] = useState('');
  const [record, setRecordState] = useState<ProgressiveReviewRecord | null>(null), recordRef = useRef<ProgressiveReviewRecord | null>(null);
  const setRecord = (update: React.SetStateAction<ProgressiveReviewRecord | null>) => {
    const value = typeof update === 'function' ? update(recordRef.current) : update;
    if (value && recordRef.current?.id === value.id && recordRef.current.version > value.version) return;
    recordRef.current = value; setRecordState(value);
  };
  const [candidates, setCandidates] = useState<ProgressiveReviewSelectionCandidate[]>([]);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [readError, setReadError] = useState(''), [actionError, setActionError] = useState('');
  const [partId, setPartId] = useState(''), [result, setResult] = useState<FlowAnalysisV2Bundle | null>(null), [resultError, setResultError] = useState('');
  const [resultRetry, setResultRetry] = useState(0);
  const [graph, setGraphState] = useState<ProgressiveReviewGraphReply | null>(null), [graphError, setGraphError] = useState('');
  const graphRef = useRef<ProgressiveReviewGraphReply | null>(null), graphReadGeneration = useRef(0);
  const setGraph = (value: ProgressiveReviewGraphReply | null) => { graphRef.current = value; setGraphState(value); };
  const [editingGraph, setEditingGraphState] = useState(false), [editedGraph, setEditedGraphState] = useState<ArgDoc | null>(null);
  const editingGraphRef = useRef(false), editedGraphRef = useRef<ArgDoc | null>(null);
  const setEditingGraph = (value: boolean) => { editingGraphRef.current = value; setEditingGraphState(value); };
  const setEditedGraph = (value: ArgDoc | null) => { editedGraphRef.current = value; setEditedGraphState(value); };
  const [editorEpoch, setEditorEpoch] = useState(0), editorEpochRef = useRef(0);
  const [relationEditorOpen, setRelationEditorOpen] = useState(false);
  const [graphNotice, setGraphNotice] = useState('');
  const editorRef = useRef<ProgressiveGraphEditorHandle>(null), dirtyGraphRef = useRef(false);
  dirtyGraphRef.current = Boolean(editingGraph && graph && editedGraph && graphEditKey(graph.doc) !== graphEditKey(editedGraph));
  const hasLocalGraphChanges = () => {
    if (!editingGraphRef.current) return false;
    if (editorRef.current?.hasPendingInput()) return true;
    const baseline = graphRef.current, current = editorRef.current?.peek() || editedGraphRef.current;
    return Boolean(baseline && current && graphEditKey(baseline.doc) !== graphEditKey(current));
  };
  const currentGraph = () => editingGraph ? editorRef.current?.snapshot() || editedGraph : graph?.doc;
  const canLeaveGraph = () => {
    if (editorRef.current?.hasPendingRelation()) {
      setActionError('关系编辑尚未完成，请先创建、保存或取消这条关系。'); return false;
    }
    const current = currentGraph();
    if (writing.current || (editingGraph && current && graph && graphEditKey(current) !== graphEditKey(graph.doc))) {
      setActionError(writing.current ? '正在保存，请稍候。' : '结构图修改尚未保存，请先保存草稿或放弃修改。');
      return false;
    }
    return true;
  };
  const [resultTab, setResultTab] = useState<ResultTab>('graph');
  const [visitedTabs, setVisitedTabs] = useState<Set<ResultTab>>(() => new Set(['graph']));
  const chooseResultTab = (tab: ResultTab) => {
    setResultTab(tab); setVisitedTabs(previous => previous.has(tab) ? previous : new Set([...previous, tab]));
  };
  const close = () => { if (canLeaveGraph()) onClose(); };
  useDialog(true, dialogRef, close, 400);
  useEffect(() => registerEditorInputLeave({ pending: () => writing.current || dirtyGraphRef.current || editorRef.current?.hasPendingInput()
    ? '论证图尚未保存或正在保存，请先完成保存或放弃修改。' : null,
    element: () => dialogRef.current, notify: message => setActionError(message) }), []);

  const readSnapshot = useCallback(async () => {
    const ticket = ++request.current;
    try {
      const course = await loadProgressiveCourse(target.projectNoteId);
      if (!course || course.id !== target.courseId || course.environmentId !== target.environmentId) throw Error('课程或资料库已变化，请关闭后重新打开复盘。');
      let next = await readProgressiveReview(target.projectNoteId, target.reviewId);
      if (next.courseId !== target.courseId) throw Error('复盘所属课程已变化。');
      let choices: ProgressiveReviewSelectionCandidate[] | undefined;
      if (next.analysisSelection?.status === 'pending') {
        const selection = await progressiveReviewCommand<ProgressiveReviewSelectionReply>({ op: 'review-selection-read', projectNoteId: target.projectNoteId, reviewId: target.reviewId });
        if (selection.course.id !== target.courseId || selection.course.environmentId !== target.environmentId) throw Error('课程或资料库已变化。');
        next = selection.record; choices = selection.candidates;
      }
      if (!alive.current || scopeRef.current !== scope || ticket !== request.current) return;
      setRecord(next); setReadError(''); setLoading(false);
      if (choices) {
        const keys = new Set(choices.map(choice => choice.key));
        setCandidates(choices);
        setSelected(previous => previous === null ? keys : new Set([...previous].filter(key => keys.has(key))));
      }
      const first = next.chunks.find(part => part.resultHash);
      if (first) setPartId(previous => next.chunks.some(part => part.id === previous && part.resultHash) ? previous
        : next.chunks.some(part => part.id === target.partId && part.resultHash) ? target.partId! : first.id);
      // Present a durable primary report immediately. Auxiliary IO may be slow
      // or unavailable, and must never hide an already completed analysis.
      if (next.status === 'analyzed' && next.auxiliaryHash) {
        try {
          let snapshot = auxiliaryCache.current;
          if (!snapshot || snapshot.scope !== scope || snapshot.hash !== next.auxiliaryHash) {
            const value = await readProgressiveAuxiliary(target.projectNoteId, target.reviewId);
            if (!value) throw Error('掌握反馈暂未读到，已保存的主分析不受影响。');
            await verifyProgressiveAuxiliaryBinding(next, value);
            snapshot = { scope, hash: next.auxiliaryHash, value };
          }
          if (!alive.current || scopeRef.current !== scope || ticket !== request.current) return;
          auxiliaryCache.current = snapshot; setAuxiliary(snapshot); setAuxiliaryError('');
        } catch (error) {
          if (alive.current && scopeRef.current === scope && ticket === request.current) {
            setAuxiliary(null); setAuxiliaryError(error instanceof Error ? error.message : '掌握反馈读取失败，请重试。');
          }
        }
      } else { setAuxiliary(null); setAuxiliaryError(''); }
    } catch (error) {
      if (alive.current && scopeRef.current === scope && ticket === request.current) { setReadError(error instanceof Error ? error.message : '复盘记录读取失败，请重试。'); setLoading(false); }
    }
  }, [target.projectNoteId, target.reviewId, target.courseId, target.environmentId, scope]);
  const refresh = useCallback(() => refreshQueue.current?.refresh() || Promise.resolve(), []);

  useEffect(() => {
    alive.current = true;
    setRecord(null); setCandidates([]); setSelected(null); setLoading(true);
    setReadError(''); setActionError(''); setPartId(''); setResult(null); setResultError('');
    setGraph(null); setGraphError(''); setEditingGraph(false); setEditedGraph(null); setGraphNotice('');
    setRelationEditorOpen(false);
    ++graphReadGeneration.current; ++editorEpochRef.current; setEditorEpoch(editorEpochRef.current);
    setResultTab('graph'); setVisitedTabs(new Set(['graph']));
    auxiliaryCache.current = null; setAuxiliary(null); setAuxiliaryError('');
    const queue = createProgressiveReviewRefreshQueue(readSnapshot); refreshQueue.current = queue;
    const off = onProgressiveChange(id => { if (id === target.projectNoteId) void queue.refresh(); });
    void queue.refresh();
    return () => { alive.current = false; request.current++; off(); queue.stop(); if (refreshQueue.current === queue) refreshQueue.current = null; };
  }, [readSnapshot, target.projectNoteId]);
  const selecting = record?.analysisSelection?.status === 'pending';
  const processing = Boolean(record && !selecting && !['failed', 'analyzed'].includes(record.status));
  useEffect(() => {
    if (!processing && !(record?.status === 'analyzed' && ['pending', 'running'].includes(record.auxiliary))) return;
    const timer = setInterval(() => { void refresh(); }, 1500);
    return () => clearInterval(timer);
  }, [processing, record?.status, record?.auxiliary, refresh]);

  const partHash = record?.chunks.find(part => part.id === partId)?.resultHash;
  const graphHash = record?.graphDrafts?.[partId] || partHash;
  const graphSource = record ? graphSourceKey(record) : '';
  useEffect(() => {
    let cancelled = false;
    const generation = ++graphReadGeneration.current;
    if (!partId || !graphHash) { setGraph(null); setGraphError(''); return; }
    // Do not blur a local node editor just to inspect a background refresh.
    // Pending textarea text is not in the canvas store until its blur commits.
    if (writing.current || hasLocalGraphChanges()) return;
    setGraphError('');
    void progressiveReviewCommand<ProgressiveReviewGraphReply>({ op: 'review-graph-read', projectNoteId: target.projectNoteId, reviewId: target.reviewId, partId }).then(value => {
      if (!value?.doc || value.record.id !== target.reviewId || value.record.courseId !== target.courseId || value.record.projectNoteId !== target.projectNoteId) throw Error('结构图所属项目已变化，请重新打开。');
      if (!cancelled && generation === graphReadGeneration.current && !writing.current && !hasLocalGraphChanges()) {
        const latest = recordRef.current;
        if (latest && latest.id === value.record.id && latest.version > value.record.version && graphSourceKey(latest) !== graphSourceKey(value.record)) return;
        const previous = graphRef.current;
        // A clean editor accepting a different saved graph must receive a new
        // store baseline too. Native metadata stamping from our own save does
        // not reset the undo stack because its editable content is unchanged.
        if (editingGraphRef.current && previous && graphEditKey(previous.doc) !== graphEditKey(value.doc)) {
          ++editorEpochRef.current; setEditorEpoch(editorEpochRef.current);
          setGraphNotice('结构图已有更新，已载入最新保存的版本。');
        }
        setGraph(value); setEditedGraph(value.doc);
        setRecord(previous => !previous || previous.id === value.record.id && previous.version <= value.record.version ? value.record : previous);
      }
    }).catch(error => { if (!cancelled && generation === graphReadGeneration.current && !writing.current) setGraphError(error instanceof Error ? error.message : '结构图读取失败，请重试。'); });
    return () => { cancelled = true; };
  }, [target.projectNoteId, target.reviewId, target.courseId, scope, partId, graphHash, graphSource, resultRetry, editingGraph, busy, relationEditorOpen]);
  useEffect(() => {
    let cancelled = false;
    setResult(null); setResultError('');
    if (!partId || !partHash) return;
    void readProgressiveReviewPart(target.projectNoteId, target.reviewId, partId).then(value => {
      if (!value) throw Error('已保存的分析结果暂不可用。');
      if (!cancelled) setResult(value);
    }).catch(error => { if (!cancelled) setResultError(error instanceof Error ? error.message : '结果读取失败，请重试。'); });
    return () => { cancelled = true; };
  }, [target.projectNoteId, target.reviewId, partId, partHash, resultRetry]);

  const persistGraph = async (confirm: boolean) => {
    if (!record || !graph || writing.current || readError || graphError) return;
    if (editorRef.current?.hasPendingRelation()) {
      setActionError('关系编辑尚未完成，请先创建、保存或取消这条关系。'); return;
    }
    if (graphSourceKey(record) !== graphSourceKey(graph.record)) {
      setActionError('论证图或复述已有更新，请重新读取并核对后再保存或确认；当前未保存修改仍保留。'); return;
    }
    const doc = currentGraph(); if (!doc) return;
    const dirty = graphEditKey(doc) !== graphEditKey(graph.doc);
    const operationScope = scope;
    writing.current = true; ++graphReadGeneration.current; setBusy(true); setActionError(''); setGraphNotice(''); ++request.current;
    try {
      let latest = record;
      if (dirty) {
        const saved = await progressiveReviewCommand<ProgressiveReviewGraphReply>({ op: 'review-graph-save', projectNoteId: target.projectNoteId, reviewId: target.reviewId,
          environmentId: target.environmentId, courseId: target.courseId, expectedVersion: latest.version, partId, expectedGraphHash: graph.graphHash, doc });
        latest = saved.record;
        if (alive.current && scopeRef.current === operationScope) { setGraph(saved); setEditedGraph(saved.doc); setRecord(latest); dirtyGraphRef.current = false; }
      }
      if (confirm) {
        const saved = await progressiveReviewCommand<ProgressiveReviewReply>({ op: 'review-cognition-confirm', projectNoteId: target.projectNoteId, reviewId: target.reviewId,
          environmentId: target.environmentId, courseId: target.courseId, expectedVersion: latest.version, confirmed: true });
        if (saved.record) latest = saved.record;
      }
      if (alive.current && scopeRef.current === operationScope) {
        setRecord(latest); setGraphNotice(confirm ? '已确认并写入个人认知库；原始分析与历史评分保持不变。' : '结构图草稿已保存，尚未写入个人认知库。');
      }
    } catch (error) {
      if (alive.current && scopeRef.current === operationScope) setActionError(error instanceof Error ? error.message : '保存未完成，修改仍保留，请重试。');
    } finally {
      writing.current = false;
      if (alive.current && scopeRef.current === operationScope) { setBusy(false); void refresh(); }
    }
  };

  const submit = async (retry = false) => {
    if (!record || writing.current || readError) return;
    writing.current = true; setBusy(true); setActionError('');
    try {
      await progressiveReviewCommand(retry
        ? { op: 'review-retry', projectNoteId: target.projectNoteId, reviewId: target.reviewId }
        : { op: 'review-start', projectNoteId: target.projectNoteId, reviewId: target.reviewId, courseId: target.courseId,
          environmentId: target.environmentId, expectedVersion: record.version, conceptKeys: [...(selected || [])] });
      onStarted?.(target.projectNoteId);
      if (alive.current && scopeRef.current === scope) await refresh();
    } catch (error) {
      if (alive.current && scopeRef.current === scope) { setActionError(error instanceof Error ? error.message : '开始分析失败，原文仍保留，请重试。'); await refresh(); }
    } finally { writing.current = false; if (alive.current) setBusy(false); }
  };
  const error = actionError || readError;
  const currentAuxiliary = auxiliary?.scope === scope && auxiliary.hash === record?.auxiliaryHash ? auxiliary.value : null;
  const auxiliaryNeedsRetry = currentAuxiliary?.mastery.some(receipt => receipt.error || !receipt.result);
  const title = selecting ? '选择要分析的知识点' : record?.status === 'analyzed' ? '复盘分析结果' : record?.status === 'failed' ? '本次分析未完成' : '正在分析复盘';
  return <div className="learning-analysis-overlay progressive-review-overlay">
    <section ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
      className={`learning-analysis-dialog progressive-review-dialog${record?.status === 'analyzed' ? ' is-result' : ''}`}>
      <header><div><span className="learning-analysis-eyebrow">LEARNING REVIEW</span><h2 id={titleId}>{title}</h2>
        <p id={descriptionId}>{selecting ? '确认本次复述涉及的知识点，再开始分析。' : target.noteTitle}</p></div>
        <button type="button" className="learning-analysis-icon" aria-label="关闭复盘窗口" disabled={busy} onClick={close}><X aria-hidden="true" /></button></header>
      <div className="learning-analysis-body" aria-busy={loading || busy}>
        {error && <div className="learning-analysis-error" role="alert"><AlertCircle aria-hidden="true" /><p>{error}</p>
          <button type="button" disabled={busy} onClick={() => { setActionError(''); void refresh(); }}><RefreshCw aria-hidden="true" />重新读取</button></div>}
        {loading && <div className="learning-analysis-state" role="status"><Loader2 className="is-spinning" aria-hidden="true" />正在读取本次复盘…</div>}
        {selecting && <>
          {candidates.length > 0 ? <>
            <button type="button" className="learning-analysis-select-all" disabled={busy} onClick={() => setSelected(selected?.size === candidates.length ? new Set() : new Set(candidates.map(choice => choice.key)))}>
              <Check aria-hidden="true" />{selected?.size === candidates.length ? '取消全选' : '全选'}<span>已选 {selected?.size || 0} / {candidates.length}</span></button>
            <fieldset className="progressive-review-choices"><legend>本次课程知识点</legend>{candidates.map(choice => <label key={choice.key} className={`learning-analysis-candidate progressive-review-choice${selected?.has(choice.key) ? ' is-selected' : ''}`}>
              <input type="checkbox" checked={Boolean(selected?.has(choice.key))} disabled={busy} onChange={() => setSelected(previous => {
                const next = new Set(previous); next.has(choice.key) ? next.delete(choice.key) : next.add(choice.key); return next;
              })} /><span><strong>{choice.title}</strong>{choice.summary && <small>{choice.summary}</small>}
                {!choice.ready && <small>知识点笔记准备中；不影响复述分析，掌握评价稍后补充。</small>}</span></label>)}</fieldset>
          </> : <p className="progressive-review-notice">本次课程暂无可选知识点，仍可分析复述本身，不会补造知识点掌握记录。</p>}
          <details className="progressive-review-source"><summary>本次分析的复述 · {record.rawText.length} 字</summary><pre>{record.rawText}</pre></details>
        </>}
        {processing && <div className="learning-analysis-state" role="status" aria-live="polite"><Loader2 className="is-spinning" aria-hidden="true" />正在分析并保存 · 已完成 {record?.completedParts}/{record?.parts} 段</div>}
        {record?.status === 'failed' && <div className="learning-analysis-error" role="alert"><AlertCircle aria-hidden="true" /><p>{record.error || '本次分析暂未完成。'} 原文和已完成的 {record.completedParts}/{record.parts} 段已保留，重试只处理未完成部分。</p></div>}
        {record?.status === 'analyzed' && <>
          {record.auxiliary !== 'ready' && <p className="progressive-review-notice" role="status">{record.auxiliary === 'failed' ? '主分析已保存，部分知识点或画像更新待重试。' : record.auxiliary === 'waiting_knowledge' ? '主分析已保存，等待知识点笔记就绪后补充掌握反馈。' : '主分析已保存，正在补充知识点和画像记录。'}</p>}
          {record.chunks.length > 1 && <nav className="progressive-review-parts" aria-label="选择复盘分析分段">{record.chunks.filter(part => part.resultHash).map((part, index) => <button key={part.id} type="button" disabled={busy} aria-pressed={partId === part.id} onClick={() => { if (part.id !== partId && canLeaveGraph()) { setEditingGraph(false); setEditedGraph(null); setGraph(null); setPartId(part.id); } }}>第 {index + 1} 段</button>)}</nav>}
          <div className="progressive-review-result-tabs" role="tablist" aria-label="复盘结果视图" onKeyDown={event => {
            if (event.nativeEvent.isComposing || event.altKey || event.ctrlKey || event.metaKey) return;
            const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
            const current = tabs.indexOf(event.target as HTMLButtonElement);
            if (current < 0) return;
            const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
              : event.key === 'ArrowRight' ? (current + 1) % tabs.length : event.key === 'ArrowLeft' ? (current + tabs.length - 1) % tabs.length : -1;
            if (index < 0) return;
            event.preventDefault(); event.stopPropagation(); chooseResultTab(RESULT_TABS[index].id); tabs[index].focus();
          }}>
            {RESULT_TABS.map(tab => <button key={tab.id} id={`${titleId}-tab-${tab.id}`} role="tab" type="button"
              aria-selected={resultTab === tab.id} aria-controls={`${titleId}-panel-${tab.id}`} tabIndex={resultTab === tab.id ? 0 : -1}
              onClick={() => chooseResultTab(tab.id)}>{tab.label}</button>)}
          </div>
          <section id={`${titleId}-panel-graph`} role="tabpanel" aria-labelledby={`${titleId}-tab-graph`} tabIndex={0} hidden={resultTab !== 'graph'} className="progressive-review-result-panel">
            <div className="progressive-review-cognition-state" role="status"><strong>{record.cognitionConfirmation?.status === 'confirmed' ? '已确认的个人理解' : '待确认的论证草稿'}</strong><p>{record.cognitionConfirmation?.status === 'confirmed' ? '修改后需再次确认，才会更新个人认知库。' : '可先编辑节点与关系；确认后才写入个人认知库。'}</p></div>
            {graphError ? <div role="alert"><p>{graphError}</p><button type="button" onClick={() => setResultRetry(value => value + 1)}>重新读取结构图</button></div>
              : !graph ? <p role="status">正在读取已保存的结构图…</p>
                : graph.doc && Array.isArray(graph.doc.nodes) && Array.isArray(graph.doc.edges)
                  ? <><div className="progressive-review-graph-actions"><button type="button" disabled={busy} onClick={() => { if (!editingGraph) { setEditingGraph(true); setEditedGraph(graph.doc); setActionError(''); } else if (canLeaveGraph()) setEditingGraph(false); }}><Pencil aria-hidden="true" />{editingGraph ? '完成编辑' : '打开论证编辑器'}</button>
                    {editingGraph && <><button type="button" disabled={busy} onClick={() => void persistGraph(false)}><Save aria-hidden="true" />保存图草稿</button><button type="button" disabled={busy} onClick={() => { setEditingGraph(false); setEditedGraph(graph.doc); dirtyGraphRef.current = false; setActionError(''); }}>放弃未保存修改</button></>}</div>
                    <div className="progressive-review-graph" aria-label="本段已保存的逻辑结构图"><Suspense fallback={<p role="status">正在展示结构图…</p>}>{editingGraph && editedGraph
                      ? <GraphEditor key={partId + ':' + editorEpoch} ref={editorRef} doc={editedGraph} busy={busy} onRelationEditorOpenChange={open => {
                        if (editorEpoch === editorEpochRef.current) setRelationEditorOpen(open);
                      }} onChange={value => {
                        if (!editingGraphRef.current || editorEpoch !== editorEpochRef.current || value.doc_id !== graphRef.current?.doc.doc_id) return;
                        setEditedGraph(value); dirtyGraphRef.current = graphEditKey(value) !== graphEditKey(graphRef.current.doc);
                      }} />
                      : <SavedGraph key={partId + ':' + graph.graphHash} doc={graph.doc} />}</Suspense></div>
                    <div className="progressive-review-confirmation"><p>确认本次复盘全部 {record.chunks.length} 段的已保存结构；原文与原分析评分不变。</p><button type="button" className="is-primary" disabled={busy || Boolean(readError)} onClick={() => void persistGraph(true)}>{busy ? '正在保存…' : '确认并写入个人认知库'}</button></div></>
                  : <p className="progressive-review-notice">本段没有可显示的逻辑结构，已保存的分析报告仍可查看。</p>}
            {graphNotice && <p className="progressive-review-notice" role="status">{graphNotice}</p>}
          </section>
          <section id={`${titleId}-panel-report`} role="tabpanel" aria-labelledby={`${titleId}-tab-report`} tabIndex={0} hidden={resultTab !== 'report'} className="progressive-review-result-panel">
            {visitedTabs.has('report') && (resultError ? <div role="alert"><p>{resultError}</p><button type="button" onClick={() => setResultRetry(value => value + 1)}>重新读取结果</button></div>
              : result ? <Suspense fallback={<p role="status">正在展示已保存结果…</p>}><SavedReport key={partId + ':' + partHash} speakingContent={result.analysisV2.record.input.rawText} noteTitle={target.noteTitle} allNotes={[]} autoRun={false} initialReport={result.report} /></Suspense>
                : <p role="status">正在读取已保存结果…</p>)}
          </section>
          <section id={`${titleId}-panel-mastery`} role="tabpanel" aria-labelledby={`${titleId}-tab-mastery`} tabIndex={0} hidden={resultTab !== 'mastery'} className="progressive-review-result-panel">
            {visitedTabs.has('mastery') && <>
              {auxiliaryError && <div className="learning-analysis-error" role="alert"><AlertCircle aria-hidden="true" /><p>{auxiliaryError}</p><button type="button" onClick={() => { void refresh(); }}>重新读取掌握反馈</button></div>}
              <ProgressiveMasteryFeedback record={record} auxiliary={currentAuxiliary} />
            </>}
          </section>
        </>}
      </div>
      <footer><button type="button" disabled={busy} onClick={close}>{processing ? '在后台继续' : '返回笔记'}</button>
        {selecting && <button type="button" className="is-primary" disabled={busy || Boolean(readError) || loading} onClick={() => { void submit(); }}><BookOpen aria-hidden="true" />{busy ? '正在提交…' : selected?.size ? `开始复盘分析（${selected.size}）` : '开始分析复述'}</button>}
        {record && !selecting && (record.status === 'failed' || record.auxiliary === 'failed' || auxiliaryNeedsRetry) && <button type="button" className="is-primary" disabled={busy || Boolean(readError)} onClick={() => { void submit(true); }}>{busy ? '正在提交…' : '重试未完成部分'}</button>}
      </footer>
    </section>
  </div>;
}
