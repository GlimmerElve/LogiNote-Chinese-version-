import { useId, useRef } from 'react';
import { CheckCircle2, FilePenLine, ShieldCheck, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import type { ArgumentPublicationChoice, ArgumentPublicationPreview } from '../services/ui/argumentPublication';
import { useDialog } from './useDialog';
import './ArgumentPublicationDialog.css';

export interface ArgumentPublicationRequest {
  title: string;
  preview: ArgumentPublicationPreview;
}

export function ArgumentPublicationDialog({ request, onCancel, onChoose }: {
  request: ArgumentPublicationRequest | null;
  onCancel: () => void;
  onChoose: (choice: ArgumentPublicationChoice) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId(), descriptionId = useId();
  useDialog(Boolean(request), ref, onCancel, 190);
  if (!request) return null;
  const { preview } = request;
  return createPortal(<div className="argument-publication-overlay"
    onPointerDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
    <div ref={ref} className="argument-publication-dialog" role="dialog" aria-modal="true"
      aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}>
      <header><span><ShieldCheck aria-hidden="true" /></span><div><small>ARGUMENT SAVE</small>
        <h2 id={titleId}>{preview.canPublish ? '保存论证结构' : '保存为草稿'}</h2></div>
        <button type="button" aria-label="关闭保存选项" onClick={onCancel}><X aria-hidden="true" /></button></header>
      <div className="argument-publication-summary"><strong>{request.title}</strong>
        <span>有效质量分 {preview.effective.score}/100 · 证据等级 {preview.evidenceAssessment.grade}</span></div>
      <p id={descriptionId}>{preview.canPublish
        ? '当前版本已通过发布门槛。你可以只保存草稿，也可以同时发布到论证层 RAG，供检索和复习使用。'
        : preview.draftReason}</p>
      {preview.corrections.length > 0 && <ul>{preview.corrections.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>}
      <footer>
        <button type="button" onClick={onCancel}>继续编辑</button>
        <button type="button" className="is-draft" onClick={() => onChoose('draft')}><FilePenLine aria-hidden="true" />仅保存草稿</button>
        {preview.canPublish && <button type="button" className="is-primary" onClick={() => onChoose('publish')}><CheckCircle2 aria-hidden="true" />保存并发布</button>}
      </footer>
    </div>
  </div>, document.body);
}
