import React, { useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useDialog } from './useDialog';

/** Local conversation reset only; this dialog never deletes notes or audit records. */
export function AgentClearConfirmation({ open, disabled = false, onCancel, onConfirm }: {
  open: boolean;
  disabled?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  useDialog(open, dialogRef, onCancel, 60);
  if (!open) return null;
  return createPortal(
    <div className="agent-clear-confirm-overlay" onClick={onCancel}>
      <div ref={dialogRef} className="agent-clear-confirm" role="alertdialog" aria-modal="true"
        aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
        onClick={(event) => event.stopPropagation()}>
        <strong id={titleId}>清空当前聊天？</strong>
        <span id={descriptionId}>只清除本次对话和工具轨迹，不影响草案、笔记、画像及审计记录。</span>
        <div>
          <button type="button" onClick={onCancel}>取消</button>
          <button type="button" className="is-danger" disabled={disabled}
            onClick={() => { if (!disabled) onConfirm(); }}>清空</button>
        </div>
      </div>
    </div>, document.body,
  );
}
