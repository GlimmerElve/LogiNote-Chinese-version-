import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { CognitionFile, CognitionGraphEdit } from '../services/cognition/types';
import { buildCognitionManagement } from '../services/cognition/management';
import type { ManagedCognitionEdge, ManagedCognitionNode } from '../services/cognition/management';
import { COGNITION_EDIT_LABELS, previewCognitionGraphEdit } from '../services/cognition/editing';
import { ARGUMENT_ROLE_LABELS } from '../services/argumentDoc/types';
import { COGNITION_RELATION_LABELS as RELATION_LABELS, COGNITION_RELATION_MEANINGS } from '../services/cognition/types';
import { useDialog } from './useDialog';
import { useCognitionWrite } from './useCognitionWrite';
import { useCognitionLeaveProtection } from './useCognitionLeaveProtection';
import { allowCognitionLeave } from '../services/ui/cognitionLeave';
import { CognitionNodePicker } from './CognitionNodePicker';

export type CognitionGraphEditIntent = { action: 'add_node' | 'delete_node' | 'add_relation' | 'update_relation' | 'delete_relation'; node?: ManagedCognitionNode; edge?: ManagedCognitionEdge };
export function CognitionGraphEditDialog({ file, intent, storageScopeId, writeLock, onBusyChange, onCancel, onSaved }: {
  file: CognitionFile; intent: CognitionGraphEditIntent; storageScopeId?: string; writeLock: { current: boolean }; onBusyChange: (busy: boolean) => void;
  onCancel: () => void; onSaved: (file: CognitionFile) => void;
}) {
  const [base, setBase] = useState(file), ref = useRef<HTMLDivElement>(null), previewRef = useRef<HTMLElement>(null);
  const [reloadCount, setReloadCount] = useState(0);
  const model = useMemo(() => buildCognitionManagement(base), [base]), nodes = model.groups.flatMap(group => group.nodes);
  const reviewedNode = intent.node && nodes.find(node => node.id === intent.node!.id);
  const reviewedEdge = intent.edge && [...model.groups.flatMap(group => group.edges), ...model.brokenEdges].find(edge => edge.id === intent.edge!.id);
  const [title, setTitle] = useState(''), [text, setText] = useState('');
  const [role, setRole] = useState('claim');
  const [sourceId, setSourceId] = useState(intent.edge?.source || intent.node?.id || ''), [targetId, setTargetId] = useState(intent.edge?.target || '');
  const [relation, setRelation] = useState<keyof typeof RELATION_LABELS>((intent.edge?.relation as keyof typeof RELATION_LABELS) || 'relates');
  const [reason, setReason] = useState(intent.action === 'update_relation' ? intent.edge?.reason || '' : '');
  const changeReason = reason.trim() || `用户${COGNITION_EDIT_LABELS[intent.action]}`;
  const writer = useCognitionWrite(next => { leave.setDirty(false); onSaved(next); }, { lock: writeLock, onBusyChange });
  const leave = useCognitionLeaveProtection(writer.busy, writeLock);
  useDialog(true, ref, () => { if (!writer.busy && allowCognitionLeave(ref.current)) onCancel(); });
  useEffect(() => { if (reloadCount) previewRef.current?.focus({ preventScroll: true }); }, [reloadCount]);
  const stale = base.revision !== file.revision;
  let edit: CognitionGraphEdit | undefined, preview: ReturnType<typeof previewCognitionGraphEdit> | undefined, previewError = '';
  try {
    if (intent.action === 'add_node') edit = { action: 'add_node', title: title.trim() || text.trim().split(/\r?\n/u)[0].slice(0, 80), text, role: role as keyof typeof ARGUMENT_ROLE_LABELS, stance: 'endorsed', reason: changeReason };
    else if (intent.action === 'delete_node') { if (!reviewedNode) throw new Error('原目标节点已不存在，草稿仍保留；不会替换为其他节点'); edit = { action: 'delete_node', target: reviewedNode, reason: changeReason }; }
    else if (intent.action === 'delete_relation') { if (!reviewedEdge?.reference) throw new Error('原目标关系已不存在，草稿仍保留；不会替换为其他关系'); edit = { action: 'delete_relation', edge: reviewedEdge.reference, reason: changeReason }; }
    else {
      if (intent.action === 'update_relation' && !reviewedEdge?.reference) throw new Error('原目标关系已不存在，草稿仍保留；不会替换为其他关系');
      const source = nodes.find(node => node.id === sourceId), target = nodes.find(node => node.id === targetId);
      if (!source || !target) throw new Error('请选择真实的起点与终点认知块');
      edit = { action: intent.action, source, target, relation, reason: changeReason, ...(reviewedEdge?.reference ? { edge: reviewedEdge.reference } : {}) };
    }
    preview = previewCognitionGraphEdit(base, edit);
  } catch (cause) { previewError = cause instanceof Error ? cause.message : '请完善变更内容'; }
  return <div className="cm-scrim"><div ref={ref} className="cm-graph-dialog cognition-ui" role="dialog" aria-modal="true" aria-labelledby="cm-graph-edit-title">
    <h2 id="cm-graph-edit-title">{COGNITION_EDIT_LABELS[intent.action]}</h2>
    <div ref={leave.root} tabIndex={-1} aria-label="认知图谱变更编辑器">
      {leave.notice && <p role="status">{leave.notice}</p>}
      {stale && <div role="alert" className="cognition-notice">认知库已变化，当前草稿保留但尚未保存。
        <div className="cognition-actions"><button type="button" disabled={writer.busy} onClick={() => {
          if (writeLock.current) return;
          setBase(file); writer.clearError(); setReloadCount(count => count + 1);
        }}>加载最新版本并重新核对</button></div>
      </div>}
      {!!reloadCount && !stale && <p role="status">已加载最新版本，草稿已保留；请重新核对下方预览和目标后确认。</p>}
      <fieldset disabled={writer.busy || stale} onChange={event => { if (!(event.target as HTMLElement).hasAttribute('data-cognition-nonedit')) leave.setDirty(true); }}>
        {intent.action === 'add_node' && <><label>我的认识<textarea aria-label="我的认识" rows={4} maxLength={20000} value={text} onChange={event => setText(event.target.value)} /></label>
          <details><summary>主题与论证角色</summary><label>认知主题（选填）<input aria-label="认知主题" placeholder="默认取正文首行" maxLength={1000} value={title} onChange={event => setTitle(event.target.value)} /></label>
          <label>论证角色<select aria-label="论证角色" value={role} onChange={event => setRole(event.target.value)}>{Object.entries(ARGUMENT_ROLE_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
          </details></>}
        {['add_relation', 'update_relation'].includes(intent.action) && <>
          <CognitionNodePicker label="关系起点" nodes={nodes} value={sourceId} onChange={id => { setSourceId(id); leave.setDirty(true); }} />
          <CognitionNodePicker label="关系终点" nodes={nodes} value={targetId} onChange={id => { setTargetId(id); leave.setDirty(true); }} />
          <label>关系类型<select aria-label="关系类型" aria-describedby="cm-relation-meaning" value={relation} onChange={event => setRelation(event.target.value as typeof relation)}>{Object.entries(RELATION_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label><p id="cm-relation-meaning">方向：起点 → 终点。{COGNITION_RELATION_MEANINGS[relation]}</p>
          <label>关系理由（选填）<textarea aria-label="关系理由" maxLength={2000} rows={2} value={reason} onChange={event => setReason(event.target.value)} /></label>
        </>}
      </fieldset>
      <section ref={previewRef} tabIndex={-1} className="cm-change-preview" aria-label="具体变更预览">{preview?.lines.map((line, index) => <p key={index}>{line}</p>)}{!preview && <p role="status">{previewError}</p>}</section>
      {writer.error && <p role="alert" className="cognition-error">保存失败，草稿已保留。{writer.error}</p>}
      <div className="cognition-actions"><button type="button" disabled={writer.busy || stale || !preview} onClick={() => { if (edit && preview) void writer.write({ kind: 'edit_graph', edit, confirmed: true, expectedRevision: base.revision, ...(storageScopeId ? { storageScopeId } : {}) }); }}>{writer.busy ? '正在保存…' : intent.action.startsWith('delete_') ? '确认删除' : '确认保存变更'}</button>
        <button type="button" disabled={writer.busy} onClick={() => { if (writeLock.current) return; leave.setDirty(false); onCancel(); }}>取消编辑</button></div>
    </div>
  </div></div>;
}
