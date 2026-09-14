/**
 * 自定义论证节点（从 argument-editor-standalone 迁移）
 * 双层结构：外层 wrapper 定位 Handle，内层卡片承载视觉样式。
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { Handle, Position, type NodeProps, type Node } from '@xyflow/react';
import { AlertTriangle, Lightbulb } from 'lucide-react';
import type { ArgNode } from '../../../services/argumentDoc/types';
import { getNodeLayer, LAYER_LABEL } from '../../../services/argumentDoc/types';
import { renderTextWithMath } from '../utils/formula';
import { FormulaToolbar } from './FormulaToolbar';
import { SuggestionBox } from './SuggestionBox';

export type ArgumentNodeData = { argNode: ArgNode; highlighted?: boolean };
export type ArgumentFlowNode = Node<ArgumentNodeData, 'argumentNode'>;

const STATUS_BORDER: Record<string, string> = {
  ok: 'var(--color-border)',
  error: 'var(--color-error)',
  warning: 'var(--color-warning)',
  suggested: 'var(--color-suggested)',
  to_delete: 'var(--color-error)',
  edited: 'var(--color-edited)',
  isolated: 'var(--color-isolated)',
};

const STATUS_GLOW: Record<string, string> = {
  ok: '0 0 0 0 rgba(0,0,0,0)',
  error: '0 0 0 3px rgba(220, 38, 38, 0.25)',
  warning: '0 0 0 3px rgba(245, 158, 11, 0.25)',
  suggested: '0 0 0 3px rgba(139, 92, 246, 0.25)',
  to_delete: '0 0 0 3px rgba(220, 38, 38, 0.25)',
  edited: '0 0 0 0 rgba(0,0,0,0)',
  isolated: '0 0 0 0 rgba(0,0,0,0)',
};

const LAYER_COLOR: Record<string, string> = {
  concept: 'var(--layer-concept)',
  judgment: 'var(--layer-judgment)',
  logic: 'var(--layer-logic)',
};

export function ArgumentNode({ id, data, selected }: NodeProps<ArgumentFlowNode>) {
  const node = data.argNode;
  const highlighted = data.highlighted ?? false;
  const [editing, setEditing] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [draft, setDraft] = useState(node.text);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const editingRef = useRef<HTMLDivElement>(null);

  const layer = getNodeLayer(node.mainType);
  const border = STATUS_BORDER[node.status] ?? 'var(--color-border)';

  const startEdit = useCallback(() => {
    setDraft(node.text);
    setEditing(true);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [node.text]);

  const commitEdit = useCallback(() => {
    setEditing(false);
    document.dispatchEvent(new CustomEvent('arg-node:edit', { detail: { id, text: draft } }));
  }, [id, draft]);

  useEffect(() => {
    if (!editing) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (editingRef.current && !editingRef.current.contains(e.target as globalThis.Node)) commitEdit();
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [editing, commitEdit]);

  const toggleCollapse = useCallback(() => {
    document.dispatchEvent(new CustomEvent('arg-node:toggle-collapse', { detail: { id } }));
  }, [id]);

  const handleInsertFormula = useCallback((tex: string) => {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart ?? draft.length;
    const end = ta.selectionEnd ?? draft.length;
    const next = draft.slice(0, start) + tex + draft.slice(end);
    setDraft(next);
    const braceStart = tex.indexOf('{');
    const caretOffset = braceStart >= 0 ? braceStart + 1 : tex.length;
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + caretOffset;
      ta.selectionStart = ta.selectionEnd = pos;
    });
  }, [draft]);

  const handleIssueClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    document.dispatchEvent(new CustomEvent('arg-node:issue-click', { detail: { nodeId: id, x: e.clientX, y: e.clientY } }));
  }, [id]);

  return (
    <div className="arg-node" onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} style={{ width: 300, position: 'relative' }}>
      <div style={{
        border: `2px solid ${highlighted ? 'var(--color-error)' : border}`,
        borderRadius: 'var(--radius)',
        background: 'var(--color-surface)',
        boxShadow: highlighted ? '0 0 0 3px rgba(220, 38, 38, 0.35)' : selected ? `0 0 0 2px var(--color-secondary), ${STATUS_GLOW[node.status]}` : hovered ? `var(--shadow-card), ${STATUS_GLOW[node.status]}` : `${STATUS_GLOW[node.status]}`,
        overflow: editing ? 'visible' : 'hidden',
        transition: 'box-shadow var(--transition), border-color var(--transition)',
      }}>
        <div className="arg-node-header" style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '8px 12px', background: 'var(--color-surface-muted)', borderBottom: '1px solid var(--color-border-soft)', fontSize: 13, fontWeight: 600, color: 'var(--color-text)', fontFamily: 'var(--font-display)' }}>
          <div style={{ display: 'flex', alignItems: 'center', minWidth: 0 }}>
            <span className="arg-node-type">{node.mainType}</span>
            {node.subTypes && (
              <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 400, color: 'var(--color-text-faint)', background: 'var(--color-surface)', padding: '1px 6px', borderRadius: 'var(--radius-xs)', whiteSpace: 'nowrap' }}>
                {node.subTypes}
              </span>
            )}
          </div>
          {(node.status === 'error' || node.status === 'warning') && (
            <button className="arg-node-icon nodrag" onMouseDown={(e) => e.stopPropagation()} onClick={handleIssueClick} style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', border: 'none', background: 'transparent', cursor: 'pointer', padding: 2, lineHeight: 1, color: node.status === 'error' ? 'var(--color-error)' : 'var(--color-warning)', display: 'flex', alignItems: 'center', justifyContent: 'center' }} title="查看问题诊断">
              <AlertTriangle size={20} strokeWidth={2} />
            </button>
          )}
          {node.status === 'suggested' && (
            <span style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', color: 'var(--color-suggested)', display: 'flex' }}>
              <Lightbulb size={20} strokeWidth={2} />
            </span>
          )}
          {node.status === 'to_delete' && (
            <span style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%, -50%)', color: 'var(--color-error)', display: 'flex' }}>
              <AlertTriangle size={20} strokeWidth={2} />
            </span>
          )}
          <span style={{ background: LAYER_COLOR[layer], color: '#fff', fontSize: 10, padding: '2px 8px', borderRadius: 'var(--radius-xs)', fontWeight: 500, fontFamily: 'var(--font-body)' }}>
            {LAYER_LABEL[layer]}
          </span>
        </div>

        {editing ? (
          <div ref={editingRef} className="arg-node-editing nodrag nopan">
            <FormulaToolbar onInsert={handleInsertFormula} />
            <textarea ref={textareaRef} value={draft} onChange={(e) => setDraft(e.target.value)} onInput={(e) => { const ta = e.currentTarget; ta.style.height = 'auto'; ta.style.height = `${ta.scrollHeight}px`; }} onWheel={(e) => e.stopPropagation()} className="arg-node-textarea nodrag nopan nowheel" style={{ width: '100%', minHeight: 80, padding: 10, border: 'none', outline: 'none', resize: 'none', overflow: 'hidden', fontSize: 13, lineHeight: 1.6, color: 'var(--color-text)', background: 'var(--color-surface)', boxSizing: 'border-box', fontFamily: 'var(--font-body)' }} />
          </div>
        ) : (
          <>
            <div className="arg-node-content" onDoubleClick={startEdit} style={{ padding: '12px', fontSize: 13, lineHeight: 1.6, color: 'var(--color-text)', maxHeight: node.collapsed ? 200 : undefined, overflow: 'hidden', cursor: 'text', wordBreak: 'break-word', textDecoration: node.status === 'to_delete' ? 'line-through' : undefined, opacity: node.status === 'to_delete' ? 0.55 : 1 }} dangerouslySetInnerHTML={{ __html: renderTextWithMath(node.text) }} />
            {node.status === 'suggested' && <SuggestionBox nodeId={id} suggestion={node.suggestion} />}
          </>
        )}

        {!editing && node.asrNote && (
          <div style={{ padding: '6px 12px', fontSize: 11, lineHeight: 1.5, color: '#92400E', background: '#FEF3C7', borderTop: '1px dashed #F59E0B' }}>
            {node.asrNote}
          </div>
        )}

        {!editing && node.text.length > 80 && (
          <button onClick={toggleCollapse} style={{ display: 'block', width: '100%', padding: '5px', border: 'none', borderTop: '1px solid var(--color-border-soft)', background: 'var(--color-surface-muted)', color: 'var(--color-text-muted)', fontSize: 11, cursor: 'pointer' }}>
            {node.collapsed ? '展开' : '收起'}
          </button>
        )}
      </div>

      <Handle type="target" position={Position.Top} style={{ width: 20, height: 20, top: -10, background: hovered ? 'var(--color-secondary)' : 'var(--color-text-muted)', border: '3px solid #fff', boxShadow: hovered ? '0 0 6px rgba(37, 99, 235, 0.6)' : '0 0 4px rgba(0,0,0,0.25)', transition: 'background var(--transition), box-shadow var(--transition)' }} />
      <Handle type="source" position={Position.Bottom} style={{ width: 16, height: 16, bottom: -8, background: hovered ? 'var(--color-text)' : 'var(--color-text-muted)', border: '2px solid #fff', boxShadow: hovered ? '0 0 5px rgba(0,0,0,0.4)' : '0 0 3px rgba(0,0,0,0.25)', transition: 'background var(--transition), box-shadow var(--transition)' }} />
    </div>
  );
}