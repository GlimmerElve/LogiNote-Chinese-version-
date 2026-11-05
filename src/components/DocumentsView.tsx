import React, { useEffect, useRef, useState, useCallback, useId } from 'react';
import { UploadCloud, FolderOpen, Trash2, Loader2, RefreshCw, FileText, File, FileCode, ExternalLink, Presentation, Eye, X, Database, RotateCcw, CheckCircle2, AlertCircle, Search, FolderTree, Folder, FolderPlus, ChevronDown, ArrowUpDown } from 'lucide-react';
import type { UploadedDocument, DocumentPreview, DocumentStatus, SourceLocator, RagKnowledgeSettings, NoteItem } from '../types';
import { DocumentProjectBindingSection, type SaveDocumentBindings } from './DocumentProjectBindingSection';
import {
  listDocuments,
  uploadDocuments,
  deleteDocument,
  retryDocument,
  openDocument,
  previewDocument,
  subscribeDocumentChanges,
  chooseDocumentFiles,
  isDocumentRagAvailable,
  setDocumentCategory,
} from '../services/documentRagClient';
import { getKnowledgeSettings, isKnowledgeRagAvailable, setKnowledgeSettings } from '../services/knowledgeRagClient';
import {documentBackgroundJobs,startDocumentGraphBackgroundJob} from '../services/documentBackgroundJobs';
import {documentJobActive} from '../services/documentBackgroundQueue';
import {canProcessDocumentArgument,documentGraphAction,documentGraphStatus,documentProcessingDescription,DOCUMENT_PROCESSING_LABELS,type DocumentProcessingAction} from '../services/documentProcessingActions';
import {DocumentArgumentGraphDialog} from './DocumentArgumentGraphDialog';
import {resolveProvider} from '../services/llmService';
import {ensureLlmSettingsLoaded} from '../services/llmStorage';
import type { NodeSourceRepairProposal } from '../services/documentGraphNodeRepair';
import { useDialog } from './useDialog';

type FilterStatus = 'all' | 'stored' | 'processing' | 'ready' | 'pending' | 'failed';
type DocumentConfirmation = { kind: 'delete' | DocumentProcessingAction; document: UploadedDocument };
const focusStyle = 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ln-focus-ring)]';
const iconButtonStyle = `inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-[var(--ln-text-secondary)] hover:bg-[var(--ln-bg-subtle)] hover:text-[var(--ln-accent)] transition-colors motion-reduce:transition-none disabled:opacity-50 disabled:cursor-wait ${focusStyle}`;
const secondaryButtonStyle = `inline-flex min-h-11 items-center justify-center gap-1.5 rounded-lg border border-[var(--ln-border)] px-3 py-2 text-xs font-semibold text-[var(--ln-text-primary)] hover:bg-[var(--ln-bg-subtle)] transition-colors motion-reduce:transition-none disabled:opacity-50 ${focusStyle}`;
const primaryButtonStyle = `inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--ln-accent)] px-4 py-2 text-sm font-bold text-[var(--ln-bg-surface)] hover:bg-[var(--ln-accent-hover)] transition-colors motion-reduce:transition-none disabled:opacity-50 ${focusStyle}`;
const destructiveButtonStyle = `inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-[var(--ln-danger)] px-4 py-2 text-sm font-bold text-white hover:opacity-90 transition-colors motion-reduce:transition-none disabled:opacity-50 ${focusStyle}`;

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function statusText(status: DocumentStatus): string {
  switch (status) {
    case 'stored':
      return '已保存，暂不索引';
    case 'ready':
      return '正文索引已完成';
    case 'processing':
      return '正文解析与向量化中…';
    case 'pending':
      return '排队中';
    case 'failed':
      return '向量化失败';
    default:
      return status;
  }
}

function FileIcon({ fileType }: { fileType: UploadedDocument['fileType'] }) {
  const Icon = fileType === 'pdf' ? FileText : fileType === 'md' ? FileCode
    : fileType === 'ppt' || fileType === 'pptx' ? Presentation : File;
  return <Icon className="h-5 w-5 shrink-0 text-[var(--ln-accent)]" aria-hidden="true" />;
}

function formatSourceLocator(locator: SourceLocator): string {
  if (locator.kind === 'pdf') return `PDF 第 ${locator.page} 页`;
  if (locator.kind === 'docx') return `DOCX 第 ${locator.paragraphIndex + 1} 段`;
  if (locator.kind === 'pptx') return `PPTX 第 ${locator.slideIndex} 页${locator.notes ? '备注' : ''}`;
  return `原文字符 ${locator.charStart}–${locator.charEnd}`;
}

function knowledgeStatusText(doc: UploadedDocument): string {
  return documentGraphStatus(doc);
}

export function DocumentPreviewDialog({
  preview,
  onClose,
  onOpen,
  onReindex,
  onGraphAction,onRegenerate,onRebuildAll,onViewGraph,onNextBatch,
  error,
  notice,
  busy = false,
  backgroundInert = false,
}: {
  preview: DocumentPreview;
  onClose: () => void;
  onOpen: () => void;
  onReindex: () => void;
  onGraphAction?:()=>void;
  onRegenerate?:()=>void;
  onRebuildAll?:()=>void;
  onViewGraph?:()=>void;
  onNextBatch?:()=>void;
  error?: string | null;
  notice?: string;
  busy?: boolean;
  backgroundInert?: boolean;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const reindexButtonRef = useRef<HTMLButtonElement>(null);
  const wasBackgroundInert = useRef(false);
  const dialogId = useId();
  const doc = preview.document;

  useDialog(true, dialogRef, busy ? undefined : onClose, 80);

  useEffect(() => {
    if (wasBackgroundInert.current && !backgroundInert) {
      (reindexButtonRef.current || dialogRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus({ preventScroll: true });
    }
    wasBackgroundInert.current = backgroundInert;
  }, [backgroundInert]);

  useEffect(() => {
    if (!preview.focusedChunkId) return;
    const target = dialogRef.current?.querySelector<HTMLElement>('[data-citation-focus="true"]');
    target?.scrollIntoView({ block: 'center' });
  }, [preview.focusedChunkId]);

  const sourceHost = (() => {
    try { return doc.sourceUrl ? new URL(doc.sourceUrl).hostname : ''; } catch { return ''; }
  })();

  return (
    <div
      inert={backgroundInert || undefined}
      className="fixed inset-0 z-[80] flex items-center justify-center bg-black/50 backdrop-blur-sm p-3 sm:p-6"
      onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${dialogId}-title`}
        aria-describedby={`${dialogId}-description`}
        aria-busy={busy}
        tabIndex={-1}
        className={`flex w-full max-w-4xl max-h-[88dvh] flex-col overflow-hidden rounded-2xl border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] text-[var(--ln-text-primary)] shadow-2xl ${focusStyle}`}
      >
        <header className="flex shrink-0 items-start gap-3 border-b border-[var(--ln-border)] px-4 py-4 sm:px-5">
          <div className="mt-0.5 rounded-xl bg-[var(--ln-accent-soft)] p-2 text-[var(--ln-accent)]">
            <Database className="h-5 w-5" aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 id={`${dialogId}-title`} className="break-words text-base font-bold">{doc.fileName}</h3>
            <p id={`${dialogId}-description`} className="mt-1 text-xs text-[var(--ln-text-secondary)]">
              {preview.focusedChunkId?.startsWith(`${doc.id}:block:`) ? '以下为论证图引用的预处理原文，可核对具体来源。' : doc.status === 'ready' ? '以下内容是实际进入本地 RAG 的文本分块，可用于核对解析质量。' : statusText(doc.status)}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} aria-label="关闭资料详情" className={iconButtonStyle}>
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </header>

        <div className="min-h-0 overflow-y-auto px-4 py-4 sm:px-5">
          {error && <p role="alert" className="mb-3 rounded-xl border border-[var(--ln-danger)] bg-[var(--ln-bg-subtle)] p-3 text-xs text-[var(--ln-danger)]">{error}</p>}
          {notice && <p role="status" className="mb-3 rounded-xl border border-[var(--ln-border)] bg-[var(--ln-accent-soft)] p-3 text-[13px] text-[var(--ln-accent)]">{notice}</p>}
          <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[
              ['格式', doc.fileType.toUpperCase()],
              ['大小', formatSize(doc.size)],
              ['文本字符', doc.totalChars.toLocaleString()],
              ['索引分块', String(doc.chunkCount)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-xl border border-[var(--ln-border)] bg-[var(--ln-bg-subtle)] p-3">
                <dt className="text-[10px] text-[var(--ln-text-secondary)]">{label}</dt>
                <dd className="mt-1 text-sm font-semibold">{value}</dd>
              </div>
            ))}
          </dl>

          {sourceHost && (
            <p className="mt-3 truncate text-xs text-[var(--ln-text-secondary)]" title={doc.sourceUrl}>来源：{sourceHost}</p>
          )}
          {doc.indexable&&<p className="mt-3 text-xs text-[var(--ln-text-secondary)]">{documentGraphStatus(doc)}。正文索引在本地自动建立；生成论证图需要单独确认模型处理。</p>}

          {(doc.status === 'ready' || preview.focusedChunkId) && preview.chunks.length > 0 ? (
            <section className="mt-5 space-y-2" aria-label="索引文本分块">
              <div className="flex items-center justify-between">
                <h4 className="text-sm font-bold">索引内容</h4>
                <span className="text-[11px] text-[var(--ln-text-secondary)]">显示 {preview.chunks.length}/{preview.totalChunkCount} 块</span>
              </div>
              {preview.chunks.map((chunk) => {
                const focused = chunk.id === preview.focusedChunkId;
                return (
                <article
                  key={chunk.id}
                  data-citation-focus={focused ? 'true' : undefined}
                  aria-current={focused ? 'true' : undefined}
                  className={`rounded-xl border bg-[var(--ln-bg-surface)] p-3 ${focused ? 'border-[var(--ln-accent)] ring-2 ring-[var(--ln-focus-ring)]' : 'border-[var(--ln-border)]'}`}
                >
                  <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold text-[var(--ln-accent)]">
                    <span>#{chunk.index + 1}</span>
                    {focused && <span className="rounded-full bg-[var(--ln-accent-soft)] px-2 py-0.5 text-[10px]">引用位置</span>}
                    <span className="truncate">{chunk.sectionPath || '未命名段落'}</span>
                  </div>
                  {!!chunk.sourceLocators?.length && (
                    <div className="mb-2 flex flex-wrap gap-1">
                      {Array.from(new Set(chunk.sourceLocators.map(formatSourceLocator))).slice(0, 3).map((label) => (
                        <span key={label} className="rounded bg-[var(--ln-bg-subtle)] px-1.5 py-0.5 text-[10px] text-[var(--ln-text-secondary)]">{label}</span>
                      ))}
                    </div>
                  )}
                  <p className="whitespace-pre-wrap break-words text-xs leading-6 text-[var(--ln-text-primary)]">{chunk.content}</p>
                </article>
                );
              })}
              {preview.truncated && <p className="text-center text-xs text-[var(--ln-text-secondary)]">大文档本次展示 40 个分块；从引用打开时会围绕引用位置展示，检索仍使用全部分块。</p>}
            </section>
          ) : (
            <div className="mt-5 rounded-xl border border-dashed border-[var(--ln-border)] p-5 text-center text-xs text-[var(--ln-text-secondary)]">
              {doc.status === 'stored'
                ? doc.sourceReadOnly ? '这是来自社区的独立只读快照，保留来源与版本，不生成知识点或学习记录。' : '原文件已安全保存，但当前格式没有文本解析器，因此不会参与 RAG 检索。'
                : doc.status === 'failed'
                  ? `解析或索引失败：${doc.error || '未知错误'}`
                  : doc.status === 'ready'
                    ? '索引已完成，但当前没有可展示的文本分块。'
                  : '资料仍在排队或处理中，完成后即可查看索引文本。'}
            </div>
          )}
        </div>

        <footer className="flex shrink-0 flex-wrap justify-end gap-2 border-t border-[var(--ln-border)] px-4 py-3 sm:px-5">
          {onGraphAction&&documentGraphAction(doc).action&&<button type="button" onClick={onGraphAction} disabled={busy} className={primaryButtonStyle}>{documentGraphAction(doc).label}</button>}
          {onViewGraph&&documentGraphAction(doc).view&&<button type="button" onClick={onViewGraph} disabled={busy} className={secondaryButtonStyle}>查看论证图</button>}
          {doc.indexable && !['pending', 'processing'].includes(doc.status) && (
            <details className="relative"><summary className={`cursor-pointer list-none ${secondaryButtonStyle}`}>更多操作</summary>
              <div className="absolute bottom-full right-0 mb-2 flex w-48 flex-col gap-1 rounded-xl border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] p-2">
                <button type="button" ref={reindexButtonRef} onClick={onReindex} disabled={busy} className={secondaryButtonStyle}>重建正文索引</button>
                {onRegenerate&&canProcessDocumentArgument(doc)&&<button type="button" onClick={onRegenerate} disabled={busy} className={secondaryButtonStyle}>重新生成论证图</button>}
                {onRebuildAll&&<button type="button" onClick={onRebuildAll} disabled={busy} className={secondaryButtonStyle}>全部重建</button>}
                {onNextBatch&&documentGraphAction(doc).action==='generate'&&<button type="button" onClick={onNextBatch} disabled={busy} className={secondaryButtonStyle}>仅处理下一批论证图</button>}
              </div>
            </details>
          )}
          <button type="button" onClick={onOpen} disabled={busy} className={primaryButtonStyle}>
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" />}打开原文件
          </button>
        </footer>
      </div>
    </div>
  );
}

export function DocumentConfirmationDialog({ confirmation, busy, error, onClose, onConfirm,progress,onStop,settings,onModeChange }: {
  confirmation: DocumentConfirmation;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onConfirm: () => void;
  progress?:string;
  onStop?:()=>void;
  settings?:RagKnowledgeSettings;
  onModeChange?:(mode:'local-only'|'allow-cloud')=>void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [modelLabel,setModelLabel]=useState('正在读取模型配置…');
  useEffect(()=>{
    if(confirmation.kind==='delete'||confirmation.kind==='body')return;
    let current=true;
    void ensureLlmSettingsLoaded().then(()=>{
      if(current)setModelLabel(resolveProvider('document-knowledge-extract')?.selectedModel||'尚未配置模型，请到模型设置配置');
    }).catch(()=>{if(current)setModelLabel('模型配置读取失败；执行前将重新校验，不会直接发送请求');});
    return()=>{current=false;};
  },[confirmation.kind,settings?.processingMode]);
  useDialog(true, dialogRef, busy ? undefined : onClose, 90);
  const deleting = confirmation.kind === 'delete';
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center bg-black/50 p-4"
      onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="alertdialog" aria-modal="true" aria-labelledby="document-confirm-title"
        aria-describedby="document-confirm-description" aria-busy={busy} tabIndex={-1}
        className={`w-full max-w-md max-h-[88dvh] overflow-y-auto rounded-2xl border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] p-5 text-[var(--ln-text-primary)] shadow-2xl ${focusStyle}`}>
        <h3 id="document-confirm-title" className="text-base font-bold">{deleting ? '删除这份资料？' : `${DOCUMENT_PROCESSING_LABELS[confirmation.kind as DocumentProcessingAction]}？`}</h3>
        <p className="mt-2 break-words text-sm font-semibold">{confirmation.document.fileName}</p>
        <p id="document-confirm-description" className="mt-2 text-xs leading-6 text-[var(--ln-text-secondary)]">
          {deleting ? '将删除资料库中保存的文件、向量分块和该资料的论证图。此操作无法在这里撤销。' : documentProcessingDescription(confirmation.kind as DocumentProcessingAction,settings?.processingMode||'local-only')}
        </p>
        {!deleting&&confirmation.kind!=='body'&&settings&&<fieldset className="mt-3 space-y-2" disabled={busy}>
          <legend className="text-xs font-semibold">论证抽取模型（选择不会立即发送请求）</legend>
          <div className="flex flex-wrap gap-2">{(['local-only','allow-cloud'] as const).map(mode=><button key={mode} type="button" aria-pressed={settings.enabled&&settings.processingMode===mode} onClick={()=>onModeChange?.(mode)} className={settings.enabled&&settings.processingMode===mode?primaryButtonStyle:secondaryButtonStyle}>{mode==='local-only'?'本机模型':'云端模型'}</button>)}</div>
          <p className="text-xs text-[var(--ln-text-secondary)]">{settings.enabled?`当前配置：${modelLabel||'尚未配置模型，请到模型设置配置'}`:'请先选择本机或云端模型。'}</p>
        </fieldset>}
        {error && <p role="alert" className="mt-3 break-words text-xs text-[var(--ln-danger)]">{error}</p>}
        {busy&&!deleting&&progress&&<p role="status" className="mt-3 break-words text-xs text-[var(--ln-accent)]">{progress}</p>}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} disabled={busy} className={secondaryButtonStyle}>取消</button>
          {busy&&!deleting&&onStop&&<button type="button" onClick={onStop} className={secondaryButtonStyle}>停止处理</button>}
          <button type="button" onClick={onConfirm} disabled={busy||(!deleting&&confirmation.kind!=='body'&&!settings?.enabled)}
            className={deleting ? destructiveButtonStyle : primaryButtonStyle}>
            {busy && <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />}
            {busy ? (deleting ? '正在删除…' : '处理中…') : deleting ? '确认删除' : '确认执行'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function DocumentCategoryDialog({ document, categories, busy, error, onClose, onSave, bindingSection, notice }: {
  document: UploadedDocument;
  categories: string[];
  busy: boolean;
  error?: string | null;
  onClose: () => void;
  onSave: (category?: string) => void | Promise<void>;
  bindingSection?: React.ReactNode;
  notice?: string;
}) {
  const ref = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const id = useId();
  const [draft, setDraft] = useState(document.category || '');
  useDialog(true, ref, busy ? undefined : onClose, 90);
  useEffect(() => { setDraft(document.category || ''); inputRef.current?.focus({ preventScroll: true }); }, [document.id, document.category]);
  return <div className="fixed inset-0 z-[95] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm" onMouseDown={(event) => { if (!busy && event.target === event.currentTarget) onClose(); }}>
    <form ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} tabIndex={-1}
      className={`max-h-[90dvh] w-full max-w-xl overflow-y-auto rounded-2xl border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] p-5 text-[var(--ln-text-primary)] shadow-2xl ${focusStyle}`}
      onSubmit={(event) => { event.preventDefault(); void onSave(draft.trim() || undefined); }}>
      <div className="flex items-start gap-3">
        <span className="rounded-xl bg-[var(--ln-accent-soft)] p-2 text-[var(--ln-accent)]"><FolderPlus className="h-5 w-5" aria-hidden="true" /></span>
        <div className="min-w-0 flex-1"><h3 id={`${id}-title`} className="text-base font-bold">{bindingSection ? '整理资料 · 分类与项目绑定' : '整理资料分类'}</h3>
          <p id={`${id}-description`} className="mt-1 break-words text-xs leading-5 text-[var(--ln-text-secondary)]">为“{document.fileName}”选择已有分类，或输入一个新分类。{bindingSection ? '分类与项目绑定分别保存，互不改变。' : ''}</p></div>
        <button type="button" onClick={onClose} disabled={busy} aria-label="关闭分类设置" className={iconButtonStyle}><X className="h-4 w-4" aria-hidden="true" /></button>
      </div>
      {!!categories.length && <div className="mt-4 flex flex-wrap gap-2" aria-label="已有资料分类">{categories.map((category) => <button key={category} type="button" disabled={busy} aria-pressed={draft === category}
        onClick={() => setDraft(category)} className={`min-h-10 rounded-lg border px-3 py-2 text-xs font-semibold ${focusStyle} ${draft === category ? 'border-[var(--ln-accent)] bg-[var(--ln-accent-soft)] text-[var(--ln-accent)]' : 'border-[var(--ln-border)] text-[var(--ln-text-secondary)] hover:bg-[var(--ln-bg-subtle)]'}`}>{category}</button>)}</div>}
      <label htmlFor={`${id}-category`} className="mt-4 block text-xs font-semibold">分类名称</label>
      <input ref={inputRef} id={`${id}-category`} disabled={busy} value={draft} maxLength={80} onChange={(event) => setDraft(event.target.value)} placeholder="例如：心理学论文、课程讲义"
        className={`mt-2 min-h-11 w-full rounded-xl border border-[var(--ln-border)] bg-[var(--ln-bg-app)] px-3 text-sm text-[var(--ln-text-primary)] placeholder:text-[var(--ln-text-muted)] ${focusStyle}`} />
      {error && <p role="alert" className="mt-3 text-xs text-[var(--ln-danger)]">{error}</p>}
      {notice && <p role="status" className="mt-3 text-xs text-[var(--ln-accent)]">{notice}</p>}
      <div className="mt-5 flex flex-wrap justify-between gap-2">
        <button type="button" disabled={busy || !document.category} onClick={() => void onSave(undefined)} className={secondaryButtonStyle}>移至未分类</button>
        <div className="flex gap-2"><button type="button" disabled={busy} onClick={onClose} className={secondaryButtonStyle}>{bindingSection ? '关闭' : '取消'}</button>
          <button type="submit" disabled={busy || !draft.trim()} className={primaryButtonStyle}>{busy ? <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <FolderPlus className="h-4 w-4" aria-hidden="true" />}保存分类</button></div>
      </div>
      {bindingSection}
    </form>
  </div>;
}

export function DocumentSourceRepairDialog({proposal,onClose,onConfirm}:{proposal:NodeSourceRepairProposal;onClose:()=>void;onConfirm:()=>void}){
  const ref=useRef<HTMLDivElement>(null),id=useId();useDialog(true,ref,onClose,100);
  return <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4">
    <div ref={ref} role="alertdialog" aria-modal="true" aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} tabIndex={-1}
      className={`w-full max-w-2xl max-h-[88dvh] overflow-y-auto rounded-2xl border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] p-5 text-[var(--ln-text-primary)] shadow-2xl ${focusStyle}`}>
      <h3 id={`${id}-title`} className="text-base font-bold">核对引文后继续</h3>
      <p id={`${id}-description`} className="mt-2 text-sm leading-6 text-[var(--ln-text-secondary)]">
        {proposal.validNodeCount}/{proposal.nodeCount} 个节点来源已通过。以下仅是本地定位候选，不代表语义已确认。确认后按原文修订并继续后续模型步骤，不重发初抽；暂缓会保留当前会话的响应。不会改动资料原文。
      </p>
      <div className="mt-4 space-y-4">{proposal.issues.map(issue=>{
        const after=issue.candidates[0]?.quote||'';let start=0,end=0;
        while(start<Math.min(issue.quote.length,after.length)&&issue.quote[start]===after[start])start++;
        while(end<Math.min(issue.quote.length,after.length)-start&&issue.quote.at(-end-1)===after.at(-end-1))end++;
        return <section key={`${issue.nodeId}:${issue.sourceIndex}`} className="rounded-xl border border-[var(--ln-border)] p-3 text-sm">
          <h4 className="font-semibold">{issue.nodeId} · {issue.window}</h4>
          <p className="mt-2 break-all">模型多写或改写：<del>{issue.quote.slice(start,issue.quote.length-end)||'（无）'}</del></p>
          <p className="break-all">原文对应内容：<ins>{after.slice(start,after.length-end)||'（无）'}</ins></p>
          <details className="mt-2"><summary className={`cursor-pointer ${focusStyle}`}>查看完整引文对照</summary>
            <p className="mt-2 font-semibold">模型引文</p><p className="whitespace-pre-wrap break-words">{issue.quote}</p>
            <p className="mt-2 font-semibold">资料原文（修订后）</p><p className="whitespace-pre-wrap break-words">{after}</p>
          </details>
        </section>;
      })}</div>
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button type="button" className={secondaryButtonStyle} onClick={onClose}>暂缓，保留响应</button>
        <button type="button" className={primaryButtonStyle} onClick={onConfirm} disabled={!proposal.canConfirm}>按原文修订并继续</button>
      </div>
    </div>
  </div>;
}

export const DocumentsView: React.FC<{ notes?: NoteItem[]; getBindingScope?: () => Promise<string>; onSaveDocumentBindings?: SaveDocumentBindings }> = ({ notes = [], getBindingScope, onSaveDocumentBindings }) => {
  const [documents, setDocuments] = useState<UploadedDocument[]>([]);
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [categoryFilter, setCategoryFilter] = useState('__all__');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<'newest' | 'name' | 'size'>('newest');
  const [collapsedCategories, setCollapsedCategories] = useState<string[]>([]);
  const [categoryDocument, setCategoryDocument] = useState<UploadedDocument | null>(null);
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [bindingBusy, setBindingBusy] = useState(false);
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [uploadPhase, setUploadPhase] = useState<'choosing' | 'uploading'>('choosing');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [actionIds, setActionIds] = useState<string[]>([]);
  const [preview, setPreview] = useState<DocumentPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoadingId, setPreviewLoadingId] = useState('');
  const [confirmation, setConfirmation] = useState<DocumentConfirmation | null>(null);
  const [confirmationBusy, setConfirmationBusy] = useState(false);
  const [confirmationError, setConfirmationError] = useState<string | null>(null);
  const [knowledgeSettings, setKnowledgeSettingsState] = useState<RagKnowledgeSettings>({ enabled: false, processingMode: 'local-only' });
  const [knowledgeBusy, setKnowledgeBusy] = useState(false);
  const [backgroundJobs,setBackgroundJobs]=useState(()=>documentBackgroundJobs.getSnapshot());
  const knowledgeRunBusy=backgroundJobs.some(documentJobActive);
  const activeJobDocIds=new Set(backgroundJobs.filter(documentJobActive).map(job=>job.docId));
  const jobByDoc=new Map(backgroundJobs.map(job=>[job.docId,job]));
  const stopGraphJobs=()=>backgroundJobs.filter(documentJobActive).forEach(job=>documentBackgroundJobs.cancel(job.id));
  const [knowledgeSettingsLoading, setKnowledgeSettingsLoading] = useState(true);
  const [knowledgeSettingsReady, setKnowledgeSettingsReady] = useState(false);
  const [knowledgeSettingsError, setKnowledgeSettingsError] = useState<string | null>(null);
  const [knowledgeNotice, setKnowledgeNotice] = useState('');
  const [graphDocument,setGraphDocument]=useState<UploadedDocument|null>(null);
  const mountedRef = useRef(true);
  const uploadBusyRef = useRef(false);
  const actionIdsRef = useRef(new Set<string>());
  const knowledgeBusyRef = useRef(false);
  const knowledgeReadBusyRef = useRef(false);
  const knowledgeReadVersionRef = useRef(0);
  const previewRequestRef = useRef(0);
  const previewRequestIdRef = useRef('');
  const previewOriginRef = useRef<HTMLButtonElement | null>(null);
  const restorePreviewFocusRef = useRef(false);
  const refreshPromiseRef = useRef<Promise<boolean> | null>(null);
  const refreshVersionRef = useRef(0);
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const focusListAfterDeleteRef = useRef(false);
  const confirmationBusyRef = useRef(false);
  const confirmationRef = useRef<DocumentConfirmation | null>(null);
  const closePreview = useCallback(() => {
    restorePreviewFocusRef.current = true;
    setPreview(null);
    setPreviewError(null);
  }, []);
  const closeConfirmation = useCallback(() => {
    if (confirmationBusyRef.current) return;
    confirmationRef.current = null;
    setConfirmation(null);
    setConfirmationError(null);
  }, []);

  const available = isDocumentRagAvailable();
  const knowledgeAvailable = isKnowledgeRagAvailable();

  const readKnowledgeSettings = useCallback(async () => {
    if (!knowledgeAvailable || knowledgeReadBusyRef.current) return;
    knowledgeReadBusyRef.current = true;
    const version = ++knowledgeReadVersionRef.current;
    setKnowledgeSettingsLoading(true);
    setKnowledgeSettingsReady(false);
    setKnowledgeSettingsError(null);
    try {
      const settings = await getKnowledgeSettings();
      if (mountedRef.current && version === knowledgeReadVersionRef.current) {
        setKnowledgeSettingsState(settings);
        setKnowledgeSettingsReady(true);
      }
    } catch (e: any) {
      if (mountedRef.current && version === knowledgeReadVersionRef.current) {
        setKnowledgeSettingsError(e?.message || '知识层设置读取失败，请重试');
      }
    } finally {
      if (version === knowledgeReadVersionRef.current) {
        knowledgeReadBusyRef.current = false;
        if (mountedRef.current) setKnowledgeSettingsLoading(false);
      }
    }
  }, [knowledgeAvailable]);

  const refresh = useCallback((showLoading = false, afterMutation = false): Promise<boolean> => {
    if (!available) { setListLoading(false); return Promise.resolve(false); }
    if (showLoading) setListLoading(true);
    if (!afterMutation && refreshPromiseRef.current) return refreshPromiseRef.current;
    const version = ++refreshVersionRef.current;
    const pending = (async () => {
      try {
        const docs = await listDocuments();
        if (mountedRef.current && version === refreshVersionRef.current) { setDocuments(docs); setListError(null); }
        return true;
      } catch (e: any) {
        if (mountedRef.current && version === refreshVersionRef.current) setListError(e?.message || '资料列表读取失败，请重试');
        return false;
      } finally {
        if (version === refreshVersionRef.current) {
          refreshPromiseRef.current = null;
          if (mountedRef.current) setListLoading(false);
        }
      }
    })();
    refreshPromiseRef.current = pending;
    return pending;
  }, [available]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    if (knowledgeAvailable) void readKnowledgeSettings();
    else { setKnowledgeSettingsLoading(false); setKnowledgeSettingsReady(false); }
    const stopKnowledgeRead = () => {
      mountedRef.current = false;
      knowledgeReadVersionRef.current += 1;
      knowledgeReadBusyRef.current = false;
    };
    if (!available) return stopKnowledgeRead;
    // 订阅主进程推送的变化事件（替代高频轮询）
    const unsubscribe = subscribeDocumentChanges(() => refresh());
    // 保底：每 2 秒轻量拉一次（覆盖极端情况）
    const timer = setInterval(() => refresh(), 2000);
    return () => {
      stopKnowledgeRead();
      previewRequestRef.current += 1;
      unsubscribe();
      clearInterval(timer);
    };
  }, [available, knowledgeAvailable, readKnowledgeSettings, refresh]);

  useEffect(()=>{
    const update=()=>{
      if(!mountedRef.current)return;
      const jobs=documentBackgroundJobs.getSnapshot();setBackgroundJobs(jobs);
      const latest=jobs.at(-1);if(latest)setKnowledgeNotice(`${latest.fileName}：${latest.error||latest.message}`);
      void refresh();
    };
    update();return documentBackgroundJobs.subscribe(update);
  },[refresh]);

  useEffect(()=>{
    setPreview(current=>{
      if(!current)return current;
      const document=documents.find(doc=>doc.id===current.document.id);
      return document&&document!==current.document?{...current,document}:current;
    });
    setCategoryDocument(current => current ? documents.find((doc) => doc.id === current.id) || null : current);
  },[documents]);

  useEffect(() => {
    if (!confirmation && focusListAfterDeleteRef.current) {
      focusListAfterDeleteRef.current = false;
      refreshButtonRef.current?.focus({ preventScroll: true });
    }
  }, [confirmation]);

  useEffect(() => {
    if (preview || previewLoadingId || confirmation || !restorePreviewFocusRef.current) return;
    restorePreviewFocusRef.current = false;
    const origin = previewOriginRef.current;
    previewOriginRef.current = null;
    // Loading disables the trigger before the async dialog mounts; its normal
    // focus snapshot can therefore be the document body instead of this row.
    if (origin?.isConnected && !origin.disabled && !origin.closest('[inert]')) {
      origin.focus({ preventScroll: true });
    } else {
      refreshButtonRef.current?.focus({ preventScroll: true });
    }
  }, [preview, previewLoadingId, confirmation]);

  const handleKnowledgeMode = async (mode: 'off' | RagKnowledgeSettings['processingMode']) => {
    if (!knowledgeAvailable || !knowledgeSettingsReady || knowledgeSettingsLoading || knowledgeBusyRef.current || actionIdsRef.current.size > 0) return;
    knowledgeBusyRef.current = true;
    setKnowledgeBusy(true);
    setError(null);
    try {
      const next = await setKnowledgeSettings({
        enabled: mode !== 'off',
        processingMode: mode === 'allow-cloud' ? 'allow-cloud' : 'local-only',
      });
      setKnowledgeSettingsState(next);
      await refresh(false, true);
    } catch (e: any) {
      setError(e?.message || '知识层设置失败');
    } finally {
      knowledgeBusyRef.current = false;
      setKnowledgeBusy(false);
    }
  };

  const handleProcessKnowledge = async (document?:UploadedDocument) => {
    if (!knowledgeAvailable || !knowledgeSettingsReady || knowledgeSettingsLoading || !knowledgeSettings.enabled || knowledgeBusyRef.current || actionIdsRef.current.size > 0) return;
    knowledgeBusyRef.current = true;
    setKnowledgeNotice('');
    setError(null);
    try {
      const doc=document||(await listDocuments()).find(d=>documentGraphAction(d).action&&!activeJobDocIds.has(d.id));
      if(!doc){setKnowledgeNotice('没有待处理资料');return;}
      await startDocumentGraphBackgroundJob(doc,'next');
      if(mountedRef.current)setKnowledgeNotice(`“${doc.fileName}”已加入后台队列，可以离开资料页面。`);
    } catch (e: any) {
      if (mountedRef.current) setError(e?.message || '知识抽取失败');
    } finally {
      knowledgeBusyRef.current = false;
    }
  };

  const handleUpload = async () => {
    if (uploadBusyRef.current) return;
    if (!available) {
      setError('资料文档功能仅在桌面版可用');
      return;
    }
    uploadBusyRef.current = true;
    setError(null);
    setNotice('');
    setUploadPhase('choosing');
    setBusy(true);
    try {
      const files = await chooseDocumentFiles();
      if (files.length === 0) { setNotice('已取消选择资料'); return; }
      setUploadPhase('uploading');
      const imported = await uploadDocuments(files);
      if (selectedCategory && imported.length) {
        try {
          await Promise.all(imported.map((doc) => setDocumentCategory(doc.id, selectedCategory)));
          setNotice(`已接收 ${imported.length} 份资料并归入“${selectedCategory}”；可解析格式会在独立后台进程建立索引。`);
        } catch (categoryFailure: any) {
          setNotice(`已接收 ${imported.length} 份资料；正文索引会继续建立。`);
          setError(categoryFailure?.message || '资料已上传，但自动归类失败，请稍后手动整理');
        }
      } else {
        setNotice(`已接收 ${imported.length} 份资料；可解析格式会在独立后台进程建立索引，可以离开本页。`);
      }
      await refresh(false, true);
    } catch (e: any) {
      setError(e?.message || '上传失败');
    } finally {
      uploadBusyRef.current = false;
      setBusy(false);
    }
  };

  const runDocumentAction = async (doc: UploadedDocument, action: () => Promise<void>, failureMessage: string) => {
    if (!available || actionIdsRef.current.has(doc.id)) return false;
    actionIdsRef.current.add(doc.id);
    setActionIds([...actionIdsRef.current]);
    setError(null);
    setPreviewError(null);
    try {
      await action();
      return true;
    } catch (e: any) {
      const message = e?.message || failureMessage;
      if (confirmationRef.current) setConfirmationError(message);
      else if (preview?.document.id === doc.id) setPreviewError(message);
      else setError(message);
      return false;
    } finally {
      actionIdsRef.current.delete(doc.id);
      if (mountedRef.current) setActionIds([...actionIdsRef.current]);
    }
  };

  const handleRetry = async (doc: UploadedDocument) => {
    if (knowledgeBusyRef.current||activeJobDocIds.has(doc.id)) return;
    await runDocumentAction(doc, async () => {
      await retryDocument(doc.id);
      setNotice(`已提交“${doc.fileName}”的解析重试`);
      await refresh(false, true);
    }, '重试失败');
  };

  const handleOpen = async (doc: UploadedDocument) => {
    await runDocumentAction(doc, () => openDocument(doc.id), '打开资料失败');
  };

  const handlePreview = async (doc: UploadedDocument, origin?: HTMLButtonElement) => {
    if (!available || previewRequestIdRef.current === doc.id || actionIdsRef.current.has(doc.id)) return;
    previewOriginRef.current = origin || null;
    restorePreviewFocusRef.current = false;
    const request = ++previewRequestRef.current;
    previewRequestIdRef.current = doc.id;
    setPreviewLoadingId(doc.id);
    setError(null);
    try {
      const next = await previewDocument(doc.id);
      if (mountedRef.current && request === previewRequestRef.current) { setPreview(next); setPreviewError(null); }
    } catch (e: any) {
      if (mountedRef.current && request === previewRequestRef.current) setError(e?.message || '读取索引预览失败');
    } finally {
      if (mountedRef.current && request === previewRequestRef.current) { setPreviewLoadingId(''); previewRequestIdRef.current = ''; }
    }
  };

  const handleSetCategory = async (category?: string) => {
    const doc = categoryDocument;
    if (!doc || categoryBusy || bindingBusy || actionIdsRef.current.has(doc.id)) return;
    const next = category?.trim() || undefined;
    actionIdsRef.current.add(doc.id);
    setActionIds([...actionIdsRef.current]);
    setCategoryBusy(true);
    setCategoryError(null);
    try {
      await setDocumentCategory(doc.id, next);
      setDocuments((items) => items.map((item) => item.id === doc.id ? { ...item, category: next } : item));
      setCategoryDocument(onSaveDocumentBindings ? { ...doc, category: next } : null);
      setNotice(next ? `已将“${doc.fileName}”归入“${next}”` : `已将“${doc.fileName}”移至未分类`);
    } catch (e: any) {
      setCategoryError(e?.message || '保存资料分类失败');
    } finally {
      actionIdsRef.current.delete(doc.id);
      if (mountedRef.current) { setActionIds([...actionIdsRef.current]); setCategoryBusy(false); }
    }
  };

  const requestConfirmation = (doc: UploadedDocument, kind: DocumentConfirmation['kind']) => {
    if (!available || confirmationRef.current || actionIdsRef.current.has(doc.id) || activeJobDocIds.has(doc.id)||knowledgeBusyRef.current) return;
    const next = { document: doc, kind };
    previewRequestRef.current += 1;
    previewRequestIdRef.current = '';
    setPreviewLoadingId('');
    confirmationRef.current = next;
    setConfirmation(next);
    setConfirmationError(null);
    setKnowledgeNotice('');
  };

  const confirmDocumentAction = async () => {
    const current = confirmationRef.current;
    if (!current || confirmationBusyRef.current) return;
    confirmationBusyRef.current = true;
    setConfirmationBusy(true);
    setConfirmationError(null);
    try {
      const doc = current.document;
      const ok = await runDocumentAction(doc, async () => {
        if (current.kind === 'delete') {
          await deleteDocument(doc.id);
          setDocuments((docs) => docs.filter((item) => item.id !== doc.id));
          setPreview((value) => value?.document.id === doc.id ? null : value);
          setNotice(`已删除“${doc.fileName}”`);
        } else if(current.kind==='body'){
          await retryDocument(doc.id);
          setNotice(`“${doc.fileName}”正在本地重建正文索引；未调用论证抽取模型。`);
          if(preview?.document.id===doc.id)setPreview(await previewDocument(doc.id));
        } else {
          await startDocumentGraphBackgroundJob(doc,current.kind==='all'?'all':current.kind==='regenerate'?'regenerate':'continue');
          if(mountedRef.current)setNotice(`“${doc.fileName}”已加入论证图后台队列。可以关闭弹窗、切换到其他笔记；进度保留在资料列表中。`);
          void refresh(false,true);
          return;
        }
        await refresh(false, true);
      }, current.kind === 'delete' ? '删除失败' : '资料处理失败');
      if (ok) {
        focusListAfterDeleteRef.current = current.kind === 'delete';
        confirmationRef.current = null; setConfirmation(null); setConfirmationError(null);
      }
    } finally {
      confirmationBusyRef.current = false;
      setConfirmationBusy(false);
    }
  };

  const counts: Record<FilterStatus, number> = {
    all: documents.length,
    stored: documents.filter((d) => d.status === 'stored').length,
    processing: documents.filter((d) => d.status === 'processing').length,
    ready: documents.filter((d) => d.status === 'ready').length,
    pending: documents.filter((d) => d.status === 'pending').length,
    failed: documents.filter((d) => d.status === 'failed').length,
  };

  const categories = Array.from(new Set(documents.map((doc) => doc.category?.trim()).filter((value): value is string => Boolean(value))))
    .sort((left, right) => left.localeCompare(right, 'zh-CN'));
  const selectedCategory = categoryFilter.startsWith('category:') ? categoryFilter.slice(9) : undefined;
  const categoryCounts = new Map<string, number>();
  for (const doc of documents) categoryCounts.set(doc.category || '__uncategorized__', (categoryCounts.get(doc.category || '__uncategorized__') || 0) + 1);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filtered = documents.filter((doc) => (filter === 'all' || doc.status === filter)
    && (categoryFilter === '__all__' || (categoryFilter === '__uncategorized__' ? !doc.category : doc.category === selectedCategory))
    && (!normalizedQuery || doc.fileName.toLocaleLowerCase().includes(normalizedQuery) || doc.category?.toLocaleLowerCase().includes(normalizedQuery)))
    .sort((left, right) => sort === 'name' ? left.fileName.localeCompare(right.fileName, 'zh-CN')
      : sort === 'size' ? right.size - left.size : Date.parse(right.uploadAt) - Date.parse(left.uploadAt));
  const groupedDocuments = new Map<string, UploadedDocument[]>();
  for (const doc of filtered) {
    const key = doc.category || '__uncategorized__';
    groupedDocuments.set(key, [...(groupedDocuments.get(key) || []), doc]);
  }
  const visibleGroups = [...groupedDocuments.entries()].sort(([left], [right]) => left === '__uncategorized__' ? 1 : right === '__uncategorized__' ? -1 : left.localeCompare(right, 'zh-CN'));
  const bindingProjects = new Map<string, NoteItem[]>();
  for (const note of notes) if (note.noteType === 'project') {
    for (const documentId of new Set((note.resources || []).flatMap(item => item.documentId ? [item.documentId] : []))) {
      bindingProjects.set(documentId, [...(bindingProjects.get(documentId) || []), note]);
    }
  }

  useEffect(() => {
    if (selectedCategory && !categories.includes(selectedCategory)) setCategoryFilter('__all__');
  }, [categories.join('\u0000'), selectedCategory]);

  return (
    <div className="flex-1 h-full overflow-y-auto bg-[var(--ln-bg-app)] text-[var(--ln-text-primary)]">
      <div inert={Boolean(preview || confirmation || categoryDocument) || undefined} className="mx-auto max-w-6xl space-y-5 p-4 sm:p-6">
        {/* 头部 */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-black">资料文档</h2>
            <p className="text-xs text-[var(--ln-text-secondary)] mt-1">上传后在独立后台进程解析、分块和向量化；论证图需另行确认，离开本页不会取消任务</p>
          </div>
          <button
            type="button"
            onClick={handleUpload}
            disabled={busy || !available}
            aria-busy={busy}
            className={primaryButtonStyle}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <UploadCloud className="w-4 h-4" aria-hidden="true" />}
            {busy ? (uploadPhase === 'choosing' ? '正在选择…' : '正在导入…') : '上传资料'}
          </button>
        </div>

        {!available && <p role="status" className="rounded-xl border border-[var(--ln-border)] p-3 text-xs text-[var(--ln-text-secondary)]">资料文档功能仅在桌面版可用，请在桌面应用中导入和管理资料。</p>}

        <section aria-label="资料论证结构处理设置" aria-busy={knowledgeSettingsLoading || knowledgeBusy || knowledgeRunBusy} className="rounded-xl border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] p-3">
          <div className="space-y-3">
            <div>
              <div className="text-xs font-bold">论证抽取模型 · v5.0.8</div>
              <p className="mt-0.5 text-[11px] leading-5 text-[var(--ln-text-secondary)]">本机模型使用 Ollama；云端模型在确认生成时接收本资料批次及交接节点。选择模型不会开始处理；暂停抽取不影响检索已有论证图。</p>
            </div>
            <div role="group" aria-label="论证抽取模型" className="flex flex-wrap items-center gap-2">
            {([
              ['off', '暂停抽取'],
              ['local-only', '本机模型'],
              ['allow-cloud', '云端模型'],
            ] as const).map(([mode, label]) => {
              const active = knowledgeSettingsReady && (mode === 'off'
                ? !knowledgeSettings.enabled
                : knowledgeSettings.enabled && knowledgeSettings.processingMode === mode);
              return (
                <button
                  key={mode}
                  type="button"
                  disabled={!knowledgeAvailable || !knowledgeSettingsReady || knowledgeSettingsLoading || knowledgeBusy || knowledgeRunBusy || actionIds.length > 0}
                  aria-pressed={active}
                  onClick={() => handleKnowledgeMode(mode)}
                  className={`min-h-11 rounded-lg px-3 py-2 text-xs font-semibold transition-colors motion-reduce:transition-none disabled:opacity-50 ${focusStyle} ${active
                    ? 'bg-[var(--ln-accent)] text-[var(--ln-bg-surface)]'
                    : 'bg-[var(--ln-bg-subtle)] text-[var(--ln-text-secondary)] hover:text-[var(--ln-accent)]'}`}
                >{label}</button>
              );
            })}
            {knowledgeRunBusy && <button type="button" className={secondaryButtonStyle} onClick={stopGraphJobs}>停止后台论证任务</button>}
            </div>
          </div>
          {knowledgeSettingsLoading && <p role="status" className="mt-2 text-xs text-[var(--ln-text-secondary)]">正在读取知识层设置…</p>}
          {!knowledgeAvailable && <p role="status" className="mt-2 text-xs text-[var(--ln-text-secondary)]">当前环境无法读取知识层设置。</p>}
          {knowledgeSettingsError && <div role="alert" className="mt-2 flex flex-wrap items-center gap-2 text-xs text-[var(--ln-danger)]">
            <p className="min-w-0 flex-1 break-words">{knowledgeSettingsError}。读取成功后才可修改设置或处理资料。</p>
            <button type="button" className={secondaryButtonStyle} disabled={!knowledgeAvailable || knowledgeSettingsLoading} onClick={() => void readKnowledgeSettings()}>重试读取设置</button>
          </div>}
          {knowledgeNotice && <p role="status" className="mt-2 text-xs text-[var(--ln-accent)]">{knowledgeNotice}</p>}
          <p className="mt-2 text-xs text-[var(--ln-text-secondary)]">任务由应用后台队列运行，可以先查看其他笔记。完全退出应用会停止未完成任务，已保存批次保留；重新打开后由你继续，不会自动重发云端请求。</p>
          <p className="mt-2 text-xs text-[var(--ln-text-secondary)]">按完整段落组成约3000～3999字一批，单批正文少于4000字，联合分块、标注、连线；尾部节点自动交接。每批1次请求，全文结束后必要时把断开单元分成小包局部补链。表格完整保留，本地校验、向量化并保存进度。</p>
        </section>

        {/* 状态过滤 chips */}
        <div role="group" aria-label="按资料状态筛选" className="flex items-center gap-1.5 flex-wrap">
          {([
            ['all', '全部'],
            ['ready', '已索引'],
            ['stored', '仅保存'],
            ['processing', '处理中'],
            ['pending', '排队中'],
            ['failed', '失败'],
          ] as Array<[FilterStatus, string]>).map(([value, label]) => (
            <button
              type="button"
              key={value}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
              className={`min-h-11 px-3 py-2 rounded-lg text-xs transition-colors motion-reduce:transition-none ${focusStyle} ${filter === value
                ? 'bg-[var(--ln-accent-soft)] text-[var(--ln-accent)]'
                : 'text-[var(--ln-text-secondary)] hover:bg-[var(--ln-bg-subtle)]'}`}
            >
              {label} {counts[value]}
            </button>
          ))}
          <span className="flex-1" />
          <button
            type="button"
            onClick={() => refresh(true)}
            disabled={!available || listLoading}
            className={iconButtonStyle}
            title="刷新"
            ref={refreshButtonRef}
            aria-label="刷新资料列表"
          >
            {listLoading ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <RefreshCw className="w-4 h-4" aria-hidden="true" />}
          </button>
        </div>

        {error && (
          <div role="alert" className="p-3 rounded-xl border border-[var(--ln-danger)] bg-[var(--ln-bg-surface)] text-xs text-[var(--ln-danger)]">
            {error}
          </div>
        )}
        {notice && <p role="status" className="text-xs text-[var(--ln-accent)]">{notice}</p>}
        {previewLoadingId && <div role="status" className="flex items-center justify-between gap-2 text-xs text-[var(--ln-text-secondary)]">
          <span>正在读取“{documents.find((doc) => doc.id === previewLoadingId)?.fileName}”的索引预览…</span>
          <button type="button" className={secondaryButtonStyle} onClick={() => {
            previewRequestRef.current += 1;
            previewRequestIdRef.current = '';
            restorePreviewFocusRef.current = true;
            setPreviewLoadingId('');
          }}>取消查看</button>
        </div>}
        {listError && <div role="alert" className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-[var(--ln-danger)] p-3 text-xs text-[var(--ln-danger)]">
          <span>{documents.length > 0 ? '列表更新失败，当前显示上次读取的资料。' : '未能读取资料列表。'}{listError}</span>
          <button type="button" disabled={listLoading} onClick={() => refresh(true)} className={secondaryButtonStyle}>重新读取</button>
        </div>}

        {/* 分类资料库 */}
        <div className="overflow-hidden rounded-2xl border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] lg:grid lg:grid-cols-[13rem_minmax(0,1fr)]">
          <aside aria-label="资料分类" className="border-b border-[var(--ln-border)] bg-[var(--ln-bg-subtle)] p-3 lg:border-b-0 lg:border-r">
            <div className="mb-3 flex items-center gap-2 px-2 text-xs font-bold text-[var(--ln-text-primary)]"><FolderTree className="h-4 w-4 text-[var(--ln-accent)]" aria-hidden="true" />资料分类</div>
            <nav className="space-y-1" aria-label="按分类筛选资料">
              {[
                ['__all__', '全部资料', documents.length],
                ['__uncategorized__', '未分类', categoryCounts.get('__uncategorized__') || 0],
              ].map(([value, label, count]) => <button key={String(value)} type="button" aria-pressed={categoryFilter === value} onClick={() => setCategoryFilter(String(value))}
                className={`flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${focusStyle} ${categoryFilter === value ? 'bg-[var(--ln-accent-soft)] font-bold text-[var(--ln-accent)]' : 'text-[var(--ln-text-secondary)] hover:bg-[var(--ln-bg-surface)]'}`}>
                <Folder className="h-4 w-4 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{label}</span><span className="tabular-nums">{count}</span>
              </button>)}
              {!!categories.length && <div className="my-2 border-t border-[var(--ln-border)]" />}
              {categories.map((category) => <button key={category} type="button" aria-pressed={categoryFilter === `category:${category}`} onClick={() => setCategoryFilter(`category:${category}`)} title={category}
                className={`flex min-h-10 w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-xs transition-colors ${focusStyle} ${categoryFilter === `category:${category}` ? 'bg-[var(--ln-accent-soft)] font-bold text-[var(--ln-accent)]' : 'text-[var(--ln-text-secondary)] hover:bg-[var(--ln-bg-surface)]'}`}>
                <Folder className="h-4 w-4 shrink-0" aria-hidden="true" /><span className="min-w-0 flex-1 truncate">{category}</span><span className="tabular-nums">{categoryCounts.get(category) || 0}</span>
              </button>)}
            </nav>
            <p className="mt-3 px-2 text-[10px] leading-4 text-[var(--ln-text-muted)]">点击卡片分类或绑定状态，统一整理分类与项目绑定。分类不会改变项目范围。</p>
          </aside>
          <section className="min-w-0 p-3 sm:p-4" aria-label="分类资料内容">
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <label className="relative min-w-[14rem] flex-1"><span className="sr-only">搜索资料</span><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ln-text-muted)]" aria-hidden="true" />
                <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件名或分类" className={`min-h-11 w-full rounded-xl border border-[var(--ln-border)] bg-[var(--ln-bg-app)] pl-9 pr-3 text-sm text-[var(--ln-text-primary)] placeholder:text-[var(--ln-text-muted)] ${focusStyle}`} /></label>
              <label className="relative"><span className="sr-only">资料排序</span><ArrowUpDown className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[var(--ln-text-muted)]" aria-hidden="true" />
                <select value={sort} onChange={(event) => setSort(event.target.value as typeof sort)} className={`min-h-11 appearance-none rounded-xl border border-[var(--ln-border)] bg-[var(--ln-bg-app)] py-2 pl-9 pr-8 text-xs text-[var(--ln-text-primary)] ${focusStyle}`}>
                  <option value="newest">最近上传</option><option value="name">名称排序</option><option value="size">文件大小</option>
                </select></label>
            </div>
            {listLoading && documents.length === 0 ? (
              <p role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-[var(--ln-text-secondary)]"><Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />正在读取资料列表…</p>
            ) : !available || (listError && documents.length === 0) ? null : filtered.length === 0 ? (
              <div className="py-12 text-center text-[var(--ln-text-secondary)]">
                <FolderOpen className="mx-auto mb-3 h-10 w-10" aria-hidden="true" />
                <p className="text-sm">{documents.length === 0 ? '还没有上传资料' : normalizedQuery ? '没有匹配的资料' : '当前状态下没有资料'}</p>
                {documents.length === 0
                  ? <p className="mt-1 text-xs">DOCX、PPTX、PDF、Markdown 和文本可建立索引，其他附件也可统一保存</p>
                  : <button type="button" className={`${secondaryButtonStyle} mt-3`} onClick={() => { setFilter('all'); setCategoryFilter('__all__'); setQuery(''); }}>查看全部资料</button>}
              </div>
            ) : (
              <div aria-label="资料列表" aria-busy={listLoading} className="space-y-3">
                {visibleGroups.map(([group, groupDocuments]) => {
                  const groupLabel = group === '__uncategorized__' ? '未分类' : group;
                  const collapsed = collapsedCategories.includes(group);
                  return <section key={group} className="overflow-hidden rounded-xl border border-[var(--ln-border)] bg-[var(--ln-bg-app)]">
                    <button type="button" aria-expanded={!collapsed} onClick={() => setCollapsedCategories((items) => items.includes(group) ? items.filter((item) => item !== group) : [...items, group])}
                      className={`flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left ${focusStyle}`}>
                      <ChevronDown className={`h-4 w-4 shrink-0 text-[var(--ln-accent)] transition-transform motion-reduce:transition-none ${collapsed ? '-rotate-90' : ''}`} aria-hidden="true" />
                      <Folder className="h-4 w-4 shrink-0 text-[var(--ln-accent)]" aria-hidden="true" /><span className="min-w-0 flex-1 truncate text-xs font-bold">{groupLabel}</span><span className="text-[11px] tabular-nums text-[var(--ln-text-secondary)]">{groupDocuments.length} 份</span>
                    </button>
                    {!collapsed && <div className="space-y-2 border-t border-[var(--ln-border)] p-2">{groupDocuments.map((doc) => (
              <div
                key={doc.id}
                data-document-id={doc.id}
                aria-busy={actionIds.includes(doc.id)}
                className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-3 rounded-xl border border-[var(--ln-border)] bg-[var(--ln-bg-surface)] p-3 xl:grid-cols-[auto_minmax(0,1fr)_auto]"
              >
                <FileIcon fileType={doc.fileType} />
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span title={doc.fileName} className="w-full text-sm font-semibold break-words">
                      {doc.fileName}
                    </span>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--ln-bg-subtle)] text-[var(--ln-text-secondary)] uppercase">
                      {doc.fileType}
                    </span>
                    <span className="text-[10px] text-[var(--ln-text-secondary)]">{formatSize(doc.size)}</span>
                    <button type="button" onClick={() => { setNotice(''); setCategoryError(null); setCategoryDocument(doc); }} disabled={actionIds.includes(doc.id)} aria-label={`整理分类：${doc.fileName}`}
                      className={`inline-flex min-h-8 items-center gap-1 rounded-lg bg-[var(--ln-accent-soft)] px-2 text-[10px] font-semibold text-[var(--ln-accent)] hover:bg-[var(--ln-bg-subtle)] ${focusStyle}`}><Folder className="h-3 w-3" aria-hidden="true" />{doc.category || '未分类'}</button>
                    {onSaveDocumentBindings && <button type="button" onClick={() => { setNotice(''); setCategoryError(null); setCategoryDocument(doc); }} aria-label={`管理项目绑定：${doc.fileName}`}
                      disabled={actionIds.includes(doc.id)} className={`inline-flex min-h-8 items-center rounded-lg border border-[var(--ln-border)] px-2 text-[10px] text-[var(--ln-text-secondary)] ${focusStyle}`}>
                      {bindingProjects.get(doc.id)?.length ? `已绑定 ${bindingProjects.get(doc.id)!.length} 个项目 · 子项目继承` : '未绑定项目 · 点击绑定'}
                    </button>}
                  </div>
                  {onSaveDocumentBindings && !!bindingProjects.get(doc.id)?.length && <p className="mt-1 break-words text-[11px] text-[var(--ln-text-secondary)]">
                    直接绑定：{bindingProjects.get(doc.id)!.map(note => note.title).join('、')}
                  </p>}
                  <div className="flex items-center gap-2 mt-1 text-xs">
                    {doc.status === 'ready' && (
                      <span className="flex items-center gap-1 text-[var(--ln-accent)]"><CheckCircle2 className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{statusText(doc.status)} · {doc.chunkCount} 个分块{doc.needsReindex ? ' · 切分或定位版本较旧，建议重建' : ''}</span>
                    )}
                    {doc.status === 'stored' && (
                      <span className="text-[var(--ln-text-secondary)]">{statusText(doc.status)} · 可用系统应用打开</span>
                    )}
                    {doc.status === 'processing' && (
                      <span className="text-[var(--ln-accent)] flex items-center gap-1">
                        <Loader2 className="w-3 h-3 animate-spin motion-reduce:animate-none" aria-hidden="true" /> {statusText(doc.status)}
                        {doc.bodyIndexProgress?` · ${doc.bodyIndexProgress.completed}/${doc.bodyIndexProgress.total}块`:doc.chunkCount > 0 && ` · ${doc.chunkCount} 块`}
                      </span>
                    )}
                    {doc.status === 'pending' && (
                      <span className="text-[var(--ln-text-secondary)]">{statusText(doc.status)}</span>
                    )}
                    {doc.status === 'failed' && (
                      <span className="text-[var(--ln-danger)] flex items-center gap-1">
                        <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{statusText(doc.status)}
                      </span>
                    )}
                  </div>
                  {doc.status === 'ready' && (
                    <p className={`mt-1 break-words text-[11px] ${doc.knowledgeStatus === 'failed' ? 'text-[var(--ln-danger)]' : 'text-[var(--ln-text-secondary)]'}`}>
                      {knowledgeStatusText(doc)}
                    </p>
                  )}
                  {doc.status === 'failed' && doc.error && (
                    <p className="break-words text-xs text-[var(--ln-danger)] mt-1">{doc.error}</p>
                  )}
                  {jobByDoc.has(doc.id)&&<div className="mt-2 space-y-1 text-xs" role="status" aria-live="polite">
                    <p className={jobByDoc.get(doc.id)!.status==='failed'?'text-[var(--ln-danger)]':'text-[var(--ln-text-secondary)]'}>
                      {jobByDoc.get(doc.id)!.status==='queued'?'论证图后台排队中：':documentJobActive(jobByDoc.get(doc.id)!)?'论证图后台处理中：':''}
                      {jobByDoc.get(doc.id)!.error||jobByDoc.get(doc.id)!.message}
                    </p>
                    {documentJobActive(jobByDoc.get(doc.id)!)&&<button type="button" className={secondaryButtonStyle}
                      onClick={()=>documentBackgroundJobs.cancel(jobByDoc.get(doc.id)!.id)} disabled={jobByDoc.get(doc.id)!.status==='cancelling'}>
                      {jobByDoc.get(doc.id)!.status==='queued'?'取消排队':'停止该论证任务'}
                    </button>}
                  </div>}
                </div>
                <div className="col-span-2 ml-auto flex flex-wrap items-center justify-end gap-1 xl:col-span-1">
                  {canProcessDocumentArgument(doc) && (
                    <button
                      type="button"
                      onClick={() => {const action=documentGraphAction(doc).action;if(action)requestConfirmation(doc,action);else setGraphDocument(doc);}}
                      disabled={!knowledgeAvailable || !knowledgeSettingsReady || knowledgeSettingsLoading || knowledgeBusy || activeJobDocIds.has(doc.id) || actionIds.includes(doc.id)}
                      className={secondaryButtonStyle}
                      aria-label={`${documentGraphAction(doc).label}：${doc.fileName}`}
                    >
                      <Database className="w-4 h-4" aria-hidden="true" />{documentGraphAction(doc).label}
                    </button>
                  )}
                  {doc.status === 'failed' && doc.indexable && (
                    <button
                      type="button"
                      onClick={() => handleRetry(doc)}
                      disabled={actionIds.includes(doc.id) || knowledgeBusy || activeJobDocIds.has(doc.id)}
                      className={iconButtonStyle}
                      title="重试"
                      aria-label={`重试解析 ${doc.fileName}`}
                    >
                      <RefreshCw className="w-4 h-4" aria-hidden="true" />
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={(event) => handlePreview(doc, event?.currentTarget)}
                    disabled={previewLoadingId === doc.id || actionIds.includes(doc.id)}
                    className={iconButtonStyle}
                    title="查看资料详情与索引内容"
                    aria-label={`查看 ${doc.fileName} 的资料详情与索引内容`}
                  >
                    {previewLoadingId === doc.id ? <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpen(doc)}
                    disabled={actionIds.includes(doc.id)}
                    className={iconButtonStyle}
                    title="用系统默认应用打开"
                    aria-label={`用系统默认应用打开 ${doc.fileName}`}
                  >
                    <ExternalLink className="w-4 h-4" aria-hidden="true" />
                  </button>
                  <button
                    type="button"
                    onClick={() => requestConfirmation(doc, 'delete')}
                    disabled={actionIds.includes(doc.id) || knowledgeBusy || activeJobDocIds.has(doc.id) || previewLoadingId === doc.id}
                    className={`${iconButtonStyle} hover:text-[var(--ln-danger)]`}
                    title="删除"
                    aria-label={`删除资料 ${doc.fileName}`}
                  >
                    <Trash2 className="w-4 h-4" aria-hidden="true" />
                  </button>
                </div>
              </div>
                    ))}</div>}
                  </section>;
                })}
              </div>
            )}
          </section>
        </div>
      </div>
      {categoryDocument && <DocumentCategoryDialog document={categoryDocument} categories={categories} busy={categoryBusy || bindingBusy} error={categoryError}
        notice={notice}
        onClose={() => { if (!categoryBusy && !bindingBusy) { setCategoryDocument(null); setCategoryError(null); } }} onSave={handleSetCategory}
        bindingSection={onSaveDocumentBindings && getBindingScope ? <DocumentProjectBindingSection key={categoryDocument.id} document={categoryDocument} notes={notes}
          disabled={categoryBusy || bindingBusy} getScope={getBindingScope} onSave={onSaveDocumentBindings} onBusyChange={setBindingBusy} /> : undefined} />}
      {preview && (
        <DocumentPreviewDialog
          preview={preview}
          error={previewError}
          busy={actionIds.includes(preview.document.id)}
          backgroundInert={Boolean(confirmation)||Boolean(graphDocument)}
          onClose={closePreview}
          onOpen={() => void handleOpen(preview.document)}
          onReindex={() => requestConfirmation(preview.document, 'body')}
          onGraphAction={()=>{const action=documentGraphAction(preview.document).action;if(action)requestConfirmation(preview.document,action);}}
          onRegenerate={()=>requestConfirmation(preview.document,'regenerate')}
          onRebuildAll={()=>requestConfirmation(preview.document,'all')}
          onViewGraph={()=>setGraphDocument(preview.document)}
          onNextBatch={knowledgeSettings.enabled?()=>void handleProcessKnowledge(preview.document):undefined}
        />
      )}
      {confirmation && <DocumentConfirmationDialog confirmation={confirmation} busy={confirmationBusy||knowledgeBusy||knowledgeSettingsLoading} error={confirmationError} progress={knowledgeNotice} onStop={knowledgeRunBusy?stopGraphJobs:undefined}
        settings={knowledgeSettings} onModeChange={mode=>void handleKnowledgeMode(mode)}
        onClose={closeConfirmation} onConfirm={confirmDocumentAction} />}
      {graphDocument&&<DocumentArgumentGraphDialog document={graphDocument} onClose={()=>setGraphDocument(null)}/>}
    </div>
  );
};
