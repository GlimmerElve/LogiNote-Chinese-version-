import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ArgDoc, RelationType } from '../../../services/argumentDoc/types';
import { ARGUMENT_ROLE_LABELS, RELATION_LABELS } from '../../../services/argumentDoc/types';
import { edgeEditError, recommendedRelation, relationHint, RELATION_HELP } from '../../../services/argumentDoc/editorModel';
import { useDialog } from '../../../components/useDialog';

export interface RelationDraft { id?: string; source: string; target: string; relation: RelationType; reason?: string }

export function RelationDialog({ doc, initial, onClose, onConfirm, onDelete }: {
  doc: ArgDoc; initial: RelationDraft; onClose: () => void;
  onConfirm: (draft: RelationDraft) => boolean; onDelete: (id: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  const [draft, setDraft] = useState(initial);
  const [failure, setFailure] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  useDialog(true, ref, onClose);
  const from = doc.nodes.find(n => n.id === draft.source);
  const to = doc.nodes.find(n => n.id === draft.target);
  const error = edgeEditError(doc, draft.source, draft.target, draft.relation, draft.id);
  const hint = from && to ? relationHint(from, to, draft.relation) : null;
  const label = (node: ArgDoc['nodes'][number]) => `${node.id} · ${node.role ? ARGUMENT_ROLE_LABELS[node.role] : node.mainType} · ${node.text.slice(0, 36) || '空白节点'}`;
  return createPortal(<div className="arg-relation-overlay">
    <div ref={ref} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`} tabIndex={-1} className="arg-relation-dialog">
      <header><h2 id={`${id}-title`}>{draft.id ? '编辑关系' : '确认新关系'}</h2><button type="button" onClick={onClose}>取消</button></header>
      <p>起点 → 终点。角色只用于提示，确认关系不会自动改变节点角色。</p>
      <label>起点<select value={draft.source} onChange={e => setDraft({ ...draft, source: e.target.value })}>
        <option value="">选择起点</option>{doc.nodes.map(n => <option key={n.id} value={n.id}>{label(n)}</option>)}
      </select></label>
      <button type="button" onClick={() => setDraft({ ...draft, source: draft.target, target: draft.source })}>反转方向 ↑↓</button>
      <label>终点<select value={draft.target} onChange={e => setDraft({ ...draft, target: e.target.value })}>
        <option value="">选择终点</option>{doc.nodes.map(n => <option key={n.id} value={n.id}>{label(n)}</option>)}
      </select></label>
      {from && to && <div className="arg-relation-endpoints"><strong>{from.id} → {to.id}</strong><blockquote>{from.text || '空白节点'}</blockquote><span>↓</span><blockquote>{to.text || '空白节点'}</blockquote></div>}
      <label>关系类型<select value={draft.relation} onChange={e => setDraft({ ...draft, relation: e.target.value as RelationType })}>
        {(Object.keys(RELATION_LABELS) as RelationType[]).map(kind => <option key={kind} value={kind}>{RELATION_LABELS[kind]}</option>)}
      </select></label>
      <p>{RELATION_HELP[draft.relation]}</p>
      {from && to && <small>角色提示优先考虑：{RELATION_LABELS[recommendedRelation(from, to)]}；仍需按实际语义选择。</small>}
      {hint && <p role="status" className="arg-relation-warning">{hint}</p>}
      <label>关系说明（可选）<textarea maxLength={600} value={draft.reason ?? ''} onChange={e => setDraft({ ...draft, reason: e.target.value })} placeholder="简短说明两个块如何承接；不会据此自动补充内容。" /></label>
      {(error || failure) && <p role="alert" className="arg-relation-warning">{error || failure}</p>}
      <footer>
        {draft.id && <button type="button" className="is-danger" onClick={() => {
          if (!confirmDelete) { setConfirmDelete(true); return; }
          onDelete(draft.id!); onClose();
        }}>{confirmDelete ? '确认删除这条关系' : '删除关系'}</button>}
        <button type="button" disabled={Boolean(error)} onClick={() => {
          if (onConfirm({ ...draft, reason: draft.reason?.trim() || undefined })) onClose();
          else setFailure('关系未保存，图可能已变化，请核对后重试。');
        }}>{draft.id ? '保存关系' : '创建关系'}</button>
      </footer>
      <small>取消不建边；删除或修改后可用 Ctrl/Cmd+Z 撤销。</small>
    </div>
  </div>, document.body);
}
