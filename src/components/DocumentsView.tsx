import React, { useEffect, useRef, useState, useCallback } from 'react';
import { UploadCloud, FolderOpen, Trash2, Loader2, RefreshCw, FileText, File, FileCode } from 'lucide-react';
import type { UploadedDocument, DocumentStatus } from '../types';
import {
  listDocuments,
  uploadDocuments,
  deleteDocument,
  retryDocument,
  subscribeDocumentChanges,
  chooseDocumentFiles,
  isDocumentRagAvailable,
} from '../services/documentRagClient';

type FilterStatus = 'all' | 'processing' | 'ready' | 'pending' | 'failed';

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusText(status: DocumentStatus): string {
  switch (status) {
    case 'ready':
      return '已完成向量化';
    case 'processing':
      return '向量化中…';
    case 'pending':
      return '排队中';
    case 'failed':
      return '向量化失败';
    default:
      return status;
  }
}

function FileIcon({ fileType }: { fileType: UploadedDocument['fileType'] }) {
  if (fileType === 'pdf') return <FileText className="w-5 h-5 text-rose-500" />;
  if (fileType === 'md') return <FileCode className="w-5 h-5 text-indigo-500" />;
  return <File className="w-5 h-5 text-slate-500" />;
}

export const DocumentsView: React.FC = () => {
  const [documents, setDocuments] = useState<UploadedDocument[]>([]);
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const available = isDocumentRagAvailable();

  const refresh = useCallback(async () => {
    if (!available) return;
    try {
      const docs = await listDocuments();
      if (mountedRef.current) setDocuments(docs);
    } catch (e: any) {
      console.warn('[documents] 列表刷新失败:', e?.message);
    }
  }, [available]);

  useEffect(() => {
    mountedRef.current = true;
    refresh();
    // 订阅主进程推送的变化事件（替代高频轮询）
    const unsubscribe = subscribeDocumentChanges(() => refresh());
    // 保底：每 2 秒轻量拉一次（覆盖极端情况）
    const timer = setInterval(() => refresh(), 2000);
    return () => {
      mountedRef.current = false;
      unsubscribe();
      clearInterval(timer);
    };
  }, [refresh]);

  const handleUpload = async () => {
    if (!available) {
      setError('资料文档功能仅在桌面版可用');
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const files = await chooseDocumentFiles();
      if (files.length === 0) return;
      await uploadDocuments(files);
      await refresh();
    } catch (e: any) {
      setError(e?.message || '上传失败');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (doc: UploadedDocument) => {
    const ok = window.confirm(`删除资料「${doc.fileName}」？\n将同时删除该资料产生的所有向量分块。`);
    if (!ok) return;
    try {
      await deleteDocument(doc.id);
      await refresh();
    } catch (e: any) {
      setError(e?.message || '删除失败');
    }
  };

  const handleRetry = async (doc: UploadedDocument) => {
    try {
      await retryDocument(doc.id);
      await refresh();
    } catch (e: any) {
      setError(e?.message || '重试失败');
    }
  };

  const counts: Record<FilterStatus, number> = {
    all: documents.length,
    processing: documents.filter((d) => d.status === 'processing').length,
    ready: documents.filter((d) => d.status === 'ready').length,
    pending: documents.filter((d) => d.status === 'pending').length,
    failed: documents.filter((d) => d.status === 'failed').length,
  };

  // 未向量化 = pending + failed
  const pendingCount = counts.pending + counts.failed;

  const filtered = filter === 'all' ? documents : documents.filter((d) => d.status === filter);

  return (
    <div className="flex-1 h-full overflow-y-auto bg-[#FFFDF7] dark:bg-slate-950">
      <div className="max-w-3xl mx-auto p-6 space-y-5">
        {/* 头部 */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-black text-slate-900 dark:text-slate-100">资料文档</h2>
            <p className="text-xs text-slate-500 mt-1">上传文档后自动向量化，用于知识点概念补全</p>
          </div>
          <button
            onClick={handleUpload}
            disabled={busy}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 transition disabled:opacity-50"
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <UploadCloud className="w-4 h-4" />}
            上传资料
          </button>
        </div>

        {/* 状态过滤 chips */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">向量化中 {counts.processing}</span>
          <span className="text-xs text-slate-400">·</span>
          <span className="text-xs text-emerald-600">已完成 {counts.ready}</span>
          <span className="text-xs text-slate-400">·</span>
          <span className="text-xs text-amber-600">未向量化 {pendingCount}</span>
          <span className="flex-1" />
          <button
            onClick={refresh}
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition"
            title="刷新"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>

        {error && (
          <div className="p-3 rounded-xl border border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-600 dark:text-red-400">
            {error}
          </div>
        )}

        {/* 列表 */}
        {filtered.length === 0 ? (
          <div className="py-16 text-center text-slate-400">
            <FolderOpen className="w-10 h-10 mx-auto mb-3 opacity-40" />
            <p className="text-sm">还没有上传资料</p>
            <p className="text-xs mt-1">上传后可用于知识点概念补全</p>
          </div>
        ) : (
          <div className="space-y-2">
            {filtered.map((doc) => (
              <div
                key={doc.id}
                className={`flex items-center gap-3 p-3 rounded-xl border bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700 ${
                  doc.status === 'processing' ? 'opacity-70' : ''
                }`}
              >
                <FileIcon fileType={doc.fileType} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800 dark:text-slate-100 truncate">
                      {doc.fileName}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-500 dark:text-slate-400 uppercase">
                      {doc.fileType}
                    </span>
                    <span className="text-[10px] text-slate-400">{formatSize(doc.size)}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1 text-xs">
                    {doc.status === 'ready' && (
                      <span className="text-emerald-600">✓ {statusText(doc.status)} · {doc.chunkCount} 个分块</span>
                    )}
                    {doc.status === 'processing' && (
                      <span className="text-blue-500 flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin" /> {statusText(doc.status)}
                        {doc.chunkCount > 0 && ` · ${doc.chunkCount} 块`}
                      </span>
                    )}
                    {doc.status === 'pending' && (
                      <span className="text-amber-600">● {statusText(doc.status)}</span>
                    )}
                    {doc.status === 'failed' && (
                      <span className="text-red-500 flex items-center gap-1">
                        ✗ {statusText(doc.status)}
                      </span>
                    )}
                  </div>
                  {doc.status === 'failed' && doc.error && (
                    <p className="text-xs text-red-400 mt-1">{doc.error}</p>
                  )}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {doc.status === 'failed' && (
                    <button
                      onClick={() => handleRetry(doc)}
                      className="p-1.5 rounded-lg text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 dark:hover:bg-slate-700 transition"
                      title="重试"
                    >
                      <RefreshCw className="w-4 h-4" />
                    </button>
                  )}
                  <button
                    onClick={() => handleDelete(doc)}
                    className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-950/40 transition"
                    title="删除"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};