import { useId, useRef } from 'react';
import { ArchiveRestore, Trash2, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { useDialog } from './useDialog';
import './ArgumentActionDialog.css';

export interface ArgumentActionRequest {
  kind: 'delete' | 'withdraw';
  docId: string;
  graphTitle: string;
  noteTitle: string;
}

export function ArgumentActionDialog({ request, onCancel, onConfirm }: {
  request: ArgumentActionRequest | null;
  onCancel: () => void;
  onConfirm: (request: ArgumentActionRequest) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId(), descriptionId = useId();
  useDialog(Boolean(request), dialogRef, onCancel, 180);
  if (!request) return null;
  const deleting = request.kind === 'delete';
  const Icon = deleting ? Trash2 : ArchiveRestore;
  return createPortal(<div className="argument-action-overlay"
    onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div ref={dialogRef} className="argument-action-dialog" role="alertdialog" aria-modal="true"
      aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
      <header>
        <span className={deleting ? 'is-danger' : 'is-warning'}><Icon aria-hidden="true" /></span>
        <div><small>LOGIC STRUCTURE</small><h2 id={titleId}>{deleting ? '删除论证结构图？' : '撤回已发布版本？'}</h2></div>
        <button type="button" aria-label="关闭确认窗口" onClick={onCancel}><X aria-hidden="true" /></button>
      </header>
      <div className="argument-action-target">
        <span>论证结构</span><strong>{request.graphTitle}</strong><small>所属笔记：{request.noteTitle}</small>
      </div>
      <p id={descriptionId}>{deleting
        ? '确认后会从所属笔记中移除这张结构图及其正文占位。笔记的其他正文和其他结构图不受影响，此操作无法撤销。'
        : '只撤回论证层 RAG 中的已发布快照。结构图、草稿与质量报告仍会保留；重新复核发布前，检索与复习不再使用该快照。'}</p>
      <footer>
        <button type="button" onClick={onCancel}>取消</button>
        <button type="button" className={deleting ? 'is-danger' : 'is-primary'} onClick={() => onConfirm(request)}>
          {deleting ? '确认删除' : '确认撤回'}
        </button>
      </footer>
    </div>
  </div>, document.body);
}
