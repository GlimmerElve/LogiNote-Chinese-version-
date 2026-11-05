/**
 * 论证结构编辑器 · 独立窗口根组件。
 *
 * - 通过 electronAPI.argument.onData 接收主窗推送的初始数据（doc/noteId/entryMode）。
 * - 编辑只存在于本窗口内存（canvasStore），「保存并退出」时经 IPC 回传主窗落盘。
 * - 「再次提交」保留四角色和五类边，仅重评结构，不更新画像或原始复盘分数。
 * - 不渲染结果报告面板（报告保留在主窗口弹窗）。
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { AlertTriangle } from 'lucide-react';
import { ArgumentEditView } from './components/ArgumentEditView';
import { ArgumentPublicationDialog, type ArgumentPublicationRequest } from './components/ArgumentPublicationDialog';
import { useArgumentEditorWrite } from './components/useArgumentEditorWrite';
import { useDialog } from './components/useDialog';
import { useCanvasStore } from './modules/argumentCanvas/store/canvasStore';
import { reassessArgumentStructure } from './services/argumentDoc/reassess';
import {
  appendArgumentIssueDecision,
  appendArgumentQualityAudit,
  computeArgumentRevisionHash,
  ensureArgumentSemanticTargetSnapshots,
  getEffectiveArgumentQuality,
  isArgumentSemanticIssueTargetUnchanged,
} from './services/argumentDoc/quality';
import { reviewArgumentQuality } from './services/argumentDoc/semanticQuality';
import {
  candidateToArgumentSourceRef,
  openArgumentSourceOriginal,
  previewArgumentSource,
  searchArgumentEvidenceCandidates,
  type ArgumentEvidenceCandidate,
} from './services/argumentDoc/evidenceSources';
import { hydrateFromUserState } from './services/electronUserState';
import type { ArgDoc, ArgumentSemanticIssue, ArgumentSourceRef } from './services/argumentDoc/types';
import { prepareArgumentPublication, type ArgumentPublicationChoice } from './services/ui/argumentPublication';

interface ArgumentEditorData {
  doc: ArgDoc;
  noteId: string | null;
  entryMode: 'new' | 'edit';
  publication?: ArgumentPublicationChoice;
}

function getArgumentApi(): ArgumentApi {
  return (window as any).electronAPI?.argument ?? {};
}

interface ArgumentApi {
  onData?: (cb: (data: ArgumentEditorData) => void) => () => void;
  save?: (data: ArgumentEditorData) => Promise<{ ok: boolean; error?: string }>;
  delete?: (docId: string) => Promise<{ ok: boolean; error?: string }>;
  close?: () => Promise<boolean>;
  openNote?: (noteId: string) => Promise<void>;
}

function sourceKey(source: Pick<ArgumentSourceRef, 'type' | 'entityId' | 'chunkId'>): string {
  return `${source.type}:${source.entityId}:${source.chunkId || ''}`;
}

export default function ArgumentEditorApp() {
  const [doc, setDoc] = useState<ArgDoc | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [qualityReviewing, setQualityReviewing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [publicationRequest, setPublicationRequest] = useState<ArgumentPublicationRequest | null>(null);
  const [qualityNotice, setQualityNotice] = useState('');
  const deleteDialogRef = useRef<HTMLDivElement>(null);
  const modelLock = useRef(false);
  const evidencePending = useRef(0);
  const baselineRef = useRef('');
  const loadedRef = useRef(false);
  const allowCloseRef = useRef(false);
  const mountedRef = useRef(true);
  const noteIdRef = useRef<string | null>(null);
  const entryModeRef = useRef<'new' | 'edit'>('new');
  const { writing, writeError, writeFinished, writeLock, performWrite } = useArgumentEditorWrite({
    doc, readDoc: () => useCanvasStore.getState().getDoc(), getArgumentApi,
    noteIdRef, entryModeRef, modelLock, evidencePending, baselineRef, allowCloseRef, mountedRef,
  });
  useDialog(confirmDelete, deleteDialogRef, () => setConfirmDelete(false));

  useEffect(() => {
    mountedRef.current = true;
    // 灌入 LLM 配置到 localStorage（独立窗口需要，否则「再次提交」找不到 provider）
    hydrateFromUserState({ skipSettings: true, skipLlm: true }).catch(() => {});

    const api = getArgumentApi();
    const off = api?.onData?.((data) => {
      if (!data?.doc) return;
      if (loadedRef.current) return;
      noteIdRef.current = data.noteId ?? null;
      entryModeRef.current = data.entryMode ?? 'new';
      useCanvasStore.getState().initDoc(data.doc);
      // A newly generated graph has not been saved, even before its first edit.
      baselineRef.current = entryModeRef.current === 'new' ? '' : JSON.stringify(useCanvasStore.getState().getDoc());
      loadedRef.current = true;
      setDoc(useCanvasStore.getState().getDoc());
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!allowCloseRef.current && loadedRef.current && (writeLock.current || modelLock.current || evidencePending.current
        || JSON.stringify(useCanvasStore.getState().getDoc()) !== baselineRef.current)) {
        event.preventDefault(); event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { mountedRef.current = false; off?.(); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);

  const handleChange = useCallback((d: ArgDoc) => {
    setDoc(d);
  }, []);

  // Same structure-only contract as the flow result workspace; reject stale replies.
  const handleResubmit = useCallback(async (mode: 'changes' | 'full' = 'changes') => {
    if (!doc || submitting || writeLock.current || modelLock.current) return;
    modelLock.current = true;
    setSubmitting(true);
    setQualityNotice('');
    try {
      const snapshot = useCanvasStore.getState().getDoc();
      const updated = await reassessArgumentStructure(snapshot, undefined, mode);
      if (!mountedRef.current) return;
      if (!updated.structureReview || updated.iteration === snapshot.iteration) {
        setQualityNotice('没有待重评的修改或问题，未发送模型请求。'); return;
      }
      if (!useCanvasStore.getState().applyStructureReviewPatch(updated)) {
        setQualityNotice('结构已修改，本次重评未覆盖新版本，请重新提交。');
        return;
      }
      setDoc(useCanvasStore.getState().getDoc());
    } catch (e) {
      console.warn('[ArgEditor] 再次提交失败:', e);
      if (mountedRef.current) setQualityNotice('结构重评失败或返回不完整，原图和诊断均已保留，请重试。');
    } finally {
      if (mountedRef.current) setSubmitting(false);
      modelLock.current = false;
    }
  }, [doc, submitting]);

  const handleQualityReview = useCallback(async () => {
    if (!doc || qualityReviewing || writeLock.current || modelLock.current) return;
    modelLock.current = true;
    setQualityReviewing(true);
    setQualityNotice('');
    try {
      const reviewDoc = useCanvasStore.getState().getDoc();
      const result = await reviewArgumentQuality(reviewDoc);
      const latestDoc = useCanvasStore.getState().getDoc();
      if (computeArgumentRevisionHash(latestDoc) !== result.semantic.revisionHash) {
        setQualityNotice('复核期间结构图已修改，本次报告未写入。请重新运行质量复核。');
        return;
      }
      const reviewIssueIds = new Set(result.semantic.issues
        .filter((issue) => issue.severity !== 'blocker')
        .map((issue) => issue.id));
      const updated: ArgDoc = {
        ...latestDoc,
        rag: {
          sourceKind: 'user_graph',
          draftAssessment: result.deterministic,
          semanticAssessment: result.semantic,
          evidenceAssessment: result.evidence,
          issueDecisions: latestDoc.rag?.issueDecisions?.filter((decision) => (
            decision.revisionHash !== result.semantic.revisionHash
            || reviewIssueIds.has(decision.issueId)
          )),
          qualityAudit: appendArgumentQualityAudit(latestDoc.rag?.qualityAudit, result.auditEntry),
          publishedSnapshot: latestDoc.rag?.publishedSnapshot,
        },
      };
      useCanvasStore.getState().setRagState(updated.rag);
      setDoc(updated);
    } catch (error) {
      console.warn('[ArgEditor] RAG 质量复核失败:', error);
      setQualityNotice(error instanceof Error ? error.message : '论证图质量复核失败，请检查模型服务。');
    } finally {
      setQualityReviewing(false);
      modelLock.current = false;
    }
  }, [doc, qualityReviewing]);

  const handleSearchEvidence = useCallback(async (nodeId: string) => {
    const current = useCanvasStore.getState().getDoc();
    const node = current.nodes.find((item) => item.id === nodeId);
    if (!node?.text.trim()) throw new Error('请先填写节点内容');
    return searchArgumentEvidenceCandidates(node.text, noteIdRef.current, 8);
  }, []);

  const handleBindEvidence = useCallback(async (nodeId: string, candidate: ArgumentEvidenceCandidate) => {
    if (writeLock.current) throw new Error('正在保存，请稍后再绑定证据');
    const state = useCanvasStore.getState();
    const node = state.getDoc().nodes.find((item) => item.id === nodeId);
    if (!node) throw new Error('目标节点已不存在');
    evidencePending.current += 1;
    try {
      const source = await candidateToArgumentSourceRef(candidate);
      const latest = state.getDoc().nodes.find((item) => item.id === nodeId);
      if (!mountedRef.current || !latest) throw new Error('目标节点已不存在');
      const sources = latest.sources || [];
      if (sources.some((item) => sourceKey(item) === sourceKey(source))) return;
      state.updateNode(nodeId, { sources: [...sources, source], user_edited: true });
      setDoc(state.getDoc());
    } finally { evidencePending.current -= 1; }
  }, []);

  const handleRemoveEvidence = useCallback((nodeId: string, source: ArgumentSourceRef) => {
    const state = useCanvasStore.getState();
    const node = state.getDoc().nodes.find((item) => item.id === nodeId);
    if (!node) return;
    state.updateNode(nodeId, {
      sources: (node.sources || []).filter((item) => sourceKey(item) !== sourceKey(source)),
      user_edited: true,
    });
    setDoc(state.getDoc());
  }, []);

  const handleLocateQualityIssue = useCallback((issue: ArgumentSemanticIssue) => {
    if (issue.target.kind === 'graph' || !issue.target.id) return;
    document.dispatchEvent(new CustomEvent('argument-quality:locate', {
      detail: { kind: issue.target.kind, id: issue.target.id },
    }));
  }, []);

  const handleIgnoreQualityIssue = useCallback((issue: ArgumentSemanticIssue, reason: string) => {
    const state = useCanvasStore.getState();
    const current = state.getDoc();
    const storedSemantic = current.rag?.semanticAssessment;
    if (!current.rag || !storedSemantic) return;
    const semantic = ensureArgumentSemanticTargetSnapshots(current, storedSemantic);
    const storedIssue = semantic.issues.find((item) => item.id === issue.id);
    if (!storedIssue) return;
    if (!isArgumentSemanticIssueTargetUnchanged(current, semantic, storedIssue)) {
      setQualityNotice('该建议对应的目标已经变化，请重新运行质量复核。');
      return;
    }
    if (storedIssue.severity === 'blocker') {
      setQualityNotice('阻断问题不能忽略，必须修正后重新复核。');
      return;
    }
    const normalizedReason = reason.trim().slice(0, 300);
    if (normalizedReason.length < 4) return;
    const now = new Date().toISOString();
    const effective = getEffectiveArgumentQuality(current.rag.draftAssessment, semantic);
    state.setRagState({
      ...current.rag,
      semanticAssessment: semantic,
      issueDecisions: appendArgumentIssueDecision(current.rag.issueDecisions, {
        version: 1,
        issueId: storedIssue.id,
        revisionHash: semantic.revisionHash,
        action: 'ignored',
        reason: normalizedReason,
        decidedAt: now,
      }),
      qualityAudit: appendArgumentQualityAudit(current.rag.qualityAudit, {
        id: `issue-ignored-${Date.now()}`,
        event: 'issue_ignored',
        issueId: storedIssue.id,
        reason: normalizedReason,
        revisionHash: semantic.revisionHash,
        at: now,
        deterministicScore: current.rag.draftAssessment.score,
        semanticScore: semantic.score,
        effectiveAdmission: effective.admission,
        evidenceGrade: current.rag.evidenceAssessment?.grade || 'ungraded',
        model: semantic.model,
      }),
    });
    setDoc(state.getDoc());
  }, []);

  const handleRestoreQualityIssue = useCallback((issue: ArgumentSemanticIssue) => {
    const state = useCanvasStore.getState();
    const current = state.getDoc();
    const reportRevision = current.rag?.semanticAssessment?.revisionHash;
    if (!current.rag || !reportRevision) return;
    state.setRagState({
      ...current.rag,
      issueDecisions: (current.rag.issueDecisions || []).filter((decision) => !(
        decision.revisionHash === reportRevision && decision.issueId === issue.id
      )),
    });
    setDoc(state.getDoc());
  }, []);

  const handleApplyQualitySuggestion = useCallback((issue: ArgumentSemanticIssue, text: string) => {
    const state = useCanvasStore.getState();
    const current = state.getDoc();
    const storedSemantic = current.rag?.semanticAssessment;
    if (!current.rag || !storedSemantic) return;
    const semantic = ensureArgumentSemanticTargetSnapshots(current, storedSemantic);
    const storedIssue = semantic.issues.find((item) => item.id === issue.id);
    if (!storedIssue) return;
    if (!isArgumentSemanticIssueTargetUnchanged(current, semantic, storedIssue)) {
      setQualityNotice('该建议对应的目标已经变化，请重新运行质量复核。');
      return;
    }
    if (current.rag.qualityAudit?.some((entry) => (
      entry.event === 'suggestion_applied'
      && entry.revisionHash === semantic.revisionHash
      && entry.issueId === storedIssue.id
    ))) return;
    if (storedIssue.target.kind !== 'node' || !storedIssue.target.id) return;
    const node = current.nodes.find((item) => item.id === storedIssue.target.id);
    const nextText = text.trim().slice(0, 500);
    if (!node || !nextText || nextText === node.text.trim()) return;
    const now = new Date().toISOString();
    const effective = getEffectiveArgumentQuality(current.rag.draftAssessment, semantic);
    state.setRagState({
      ...current.rag,
      semanticAssessment: semantic,
      qualityAudit: appendArgumentQualityAudit(current.rag.qualityAudit, {
        id: `suggestion-applied-${Date.now()}`,
        event: 'suggestion_applied',
        issueId: storedIssue.id,
        revisionHash: semantic.revisionHash,
        at: now,
        deterministicScore: current.rag.draftAssessment.score,
        semanticScore: semantic.score,
        effectiveAdmission: effective.admission,
        evidenceGrade: current.rag.evidenceAssessment?.grade || 'ungraded',
        model: semantic.model,
      }),
    });
    state.updateNode(node.id, {
      text: nextText,
      user_edited: true,
      status: 'edited',
      issue: null,
      severity: null,
      suggestion: null,
    });
    setDoc(state.getDoc());
  }, []);

  // 保存并退出：把最终 doc 回传主窗落盘
  const handleSubmit = useCallback(() => {
    if (writing || writeFinished) return;
    const latestDoc = useCanvasStore.getState().getDoc();
    setPublicationRequest({ title: latestDoc.title || '未命名论证结构', preview: prepareArgumentPublication(latestDoc) });
  }, [writing, writeFinished]);

  const confirmPublication = useCallback((choice: ArgumentPublicationChoice) => {
    if (writing || writeFinished) return;
    setPublicationRequest(null);
    void performWrite('save', choice);
  }, [performWrite, writing, writeFinished]);

  // 删除当前图：确认后回传主窗执行删除落盘
  const handleDelete = useCallback(() => {
    if (writing || writeFinished) return;
    setConfirmDelete(true);
  }, [writing, writeFinished]);

  const confirmDeleteGraph = useCallback(() => {
    if (writing || writeFinished) return;
    setConfirmDelete(false);
    void performWrite('delete');
  }, [performWrite, writing, writeFinished]);

  if (!doc) {
    return (
      <div className="h-screen w-screen flex items-center justify-center text-slate-400 bg-[#FEF9F3] dark:bg-slate-950">
        <span>正在加载论证结构…</span>
      </div>
    );
  }

  return (
    <>
    <div className="argument-editor-app-layer" inert={confirmDelete || Boolean(publicationRequest) || undefined}>
    <ArgumentEditView
      doc={doc}
      noteId={noteIdRef.current}
      report={null}
      onChange={handleChange}
      onResubmit={handleResubmit}
      onQualityReview={handleQualityReview}
      onSearchEvidence={handleSearchEvidence}
      onBindEvidence={handleBindEvidence}
      onRemoveEvidence={handleRemoveEvidence}
      onPreviewEvidence={previewArgumentSource}
      onOpenEvidence={openArgumentSourceOriginal}
      onLocateQualityIssue={handleLocateQualityIssue}
      onIgnoreQualityIssue={handleIgnoreQualityIssue}
      onRestoreQualityIssue={handleRestoreQualityIssue}
      onApplyQualitySuggestion={handleApplyQualitySuggestion}
      onSubmit={handleSubmit}
      onDelete={handleDelete}
      submitting={submitting}
      qualityReviewing={qualityReviewing}
      writing={writing}
      writeError={writeError || qualityNotice}
      writeFinished={writeFinished}
      hideResultPanel
    />
    </div>
    {confirmDelete && <div className="argument-editor-confirm-overlay">
      <div ref={deleteDialogRef} className="argument-editor-confirm-dialog" role="alertdialog" aria-modal="true"
        aria-labelledby="argument-delete-title" aria-describedby="argument-delete-description" tabIndex={-1}>
        <div className="argument-editor-confirm-icon"><AlertTriangle aria-hidden="true" /></div>
        <div>
          <h2 id="argument-delete-title">删除这张论证结构图？</h2>
          <p id="argument-delete-description">删除后会从原笔记中移除该结构图，且无法撤销。笔记正文与其他结构图不受影响。</p>
        </div>
        <div className="argument-editor-confirm-actions">
          <button type="button" onClick={() => setConfirmDelete(false)}>取消</button>
          <button type="button" className="is-danger" onClick={confirmDeleteGraph}>确认删除</button>
        </div>
      </div>
    </div>}
    <ArgumentPublicationDialog request={publicationRequest} onCancel={() => setPublicationRequest(null)} onChoose={confirmPublication} />
    </>
  );
}
