/**
 * 论证结构编辑器 · 独立窗口根组件。
 *
 * - 通过 electronAPI.argument.onData 接收主窗推送的初始数据（doc/noteId/entryMode）。
 * - 编辑只存在于本窗口内存（canvasStore），「保存并退出」时经 IPC 回传主窗落盘。
 * - 「再次提交」在本窗口内完成：反推 preprocess → 调 profile-evidence-layered → 更新画布节点状态。
 * - 不渲染结果报告面板（报告保留在主窗口弹窗）。
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { ArgumentEditView } from './components/ArgumentEditView';
import { useCanvasStore } from './modules/argumentCanvas/store/canvasStore';
import { argDocToPreprocess, applyVulnerabilities } from './services/argumentDoc/convert';
import { fetchLayeredEvidence } from './services/flowAnalysis/evidenceTasks';
import { hydrateFromUserState } from './services/electronUserState';
import type { ArgDoc } from './services/argumentDoc/types';

interface ArgumentEditorData {
  doc: ArgDoc;
  noteId: string | null;
  entryMode: 'new' | 'edit';
}

function getArgumentApi(): ArgumentApi {
  return (window as any).electronAPI?.argument ?? {};
}

interface ArgumentApi {
  onData?: (cb: (data: ArgumentEditorData) => void) => () => void;
  save?: (data: ArgumentEditorData) => void;
  delete?: (docId: string) => void;
}

export default function ArgumentEditorApp() {
  const [doc, setDoc] = useState<ArgDoc | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const noteIdRef = useRef<string | null>(null);
  const entryModeRef = useRef<'new' | 'edit'>('new');

  useEffect(() => {
    // 灌入 LLM 配置到 localStorage（独立窗口需要，否则「再次提交」找不到 provider）
    hydrateFromUserState().catch(() => {});

    const api = getArgumentApi();
    const off = api?.onData?.((data) => {
      if (!data?.doc) return;
      noteIdRef.current = data.noteId ?? null;
      entryModeRef.current = data.entryMode ?? 'new';
      setDoc(data.doc);
    });
    return () => { off?.(); };
  }, []);

  const handleChange = useCallback((d: ArgDoc) => {
    setDoc(d);
  }, []);

  // 再次提交：以当前画布 doc 反推 preprocess → 重跑步骤② → 增量更新节点状态
  const handleResubmit = useCallback(async () => {
    if (!doc || submitting) return;
    setSubmitting(true);
    try {
      const preprocess = argDocToPreprocess(doc);
      const text = preprocess.sentences.map((s) => s.text).join('\n');
      const result = await fetchLayeredEvidence(preprocess, text);
      const vulns = result.qualityResult?.vulnerabilities ?? [];
      const updated = applyVulnerabilities(doc, vulns);
      // 增量回写诊断字段到画布 store（同 doc_id 跳过 initDoc 也不影响）
      useCanvasStore.getState().applyVulnerabilityPatch(updated.nodes);
      setDoc(updated);
    } catch (e) {
      console.warn('[ArgEditor] 再次提交失败:', e);
    } finally {
      setSubmitting(false);
    }
  }, [doc, submitting]);

  // 保存并退出：把最终 doc 回传主窗落盘
  const handleSubmit = useCallback(() => {
    if (!doc) return;
    getArgumentApi()?.save?.({
      doc: { ...doc, updated_at: new Date().toISOString() },
      noteId: noteIdRef.current,
      entryMode: entryModeRef.current,
    });
  }, [doc]);

  // 删除当前图：确认后回传主窗执行删除落盘
  const handleDelete = useCallback(() => {
    if (!doc) return;
    if (!window.confirm('确定删除该论证结构图？此操作不可撤销。')) return;
    getArgumentApi()?.delete?.(doc.doc_id);
  }, [doc]);

  if (!doc) {
    return (
      <div className="h-screen w-screen flex items-center justify-center text-slate-400 bg-[#FEF9F3] dark:bg-slate-950">
        <span>正在加载论证结构…</span>
      </div>
    );
  }

  return (
    <ArgumentEditView
      doc={doc}
      report={null}
      onChange={handleChange}
      onResubmit={handleResubmit}
      onSubmit={handleSubmit}
      onDelete={handleDelete}
      submitting={submitting}
      hideResultPanel
    />
  );
}