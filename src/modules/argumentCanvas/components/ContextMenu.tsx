/**
 * 右键菜单（从 argument-editor-standalone 迁移）
 * - 单节点：切换类型（9 类）+ 删除
 * - 多节点：批量删除
 */

import { useRef, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ArgumentFunctionType } from '../../../types';
import type { ArgumentRole } from '../../../services/argumentDoc/types';
import { ALL_ARGUMENT_ROLES, ALL_ARGUMENT_TYPES, ARGUMENT_ROLE_LABELS } from '../../../services/argumentDoc/types';
import { useDialog } from '../../../components/useDialog';
import { useCanvasStore } from '../store/canvasStore';

export interface ContextMenuState {
  x: number;
  y: number;
  nodeIds: string[];
}

interface ContextMenuProps {
  state: ContextMenuState;
  onDeleteNodes: (ids: string[]) => void;
  onChangeType: (id: string, type: ArgumentFunctionType) => void;
  onChangeRole: (id: string, role: ArgumentRole) => void;
  onClose: () => void;
}

export function ContextMenu({ state, onDeleteNodes, onChangeType, onChangeRole, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  useDialog(true, menuRef, onClose);
  const node = useCanvasStore(s => s.doc.nodes.find(n => n.id === state.nodeIds[0]));

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as globalThis.Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  const single = state.nodeIds.length === 1;

  return (
    <div
      ref={menuRef}
      role="menu" aria-label="节点操作" tabIndex={-1}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
        event.preventDefault();
        const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
      }}
      style={{
        position: 'fixed',
        left: state.x,
        top: state.y,
        zIndex: 1000,
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        boxShadow: 'var(--shadow-pop)',
        minWidth: 160,
        padding: '4px 0',
        fontSize: 13,
        color: 'var(--color-text)',
      }}
    >
      {single && (
        <div style={{ position: 'relative' }}>
          <div style={{ padding: '6px 12px', color: 'var(--color-text-muted)', fontSize: 11 }}>论证角色</div>
          {ALL_ARGUMENT_ROLES.map((role) => <button type="button" role="menuitem" key={role} onClick={() => { onChangeRole(state.nodeIds[0], role); onClose(); }}
            style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, background: 'transparent', color: 'inherit', padding: '8px 12px', cursor: 'pointer' }}>{ARGUMENT_ROLE_LABELS[role]}{node?.role === role ? ' · 当前' : ''}</button>)}
        </div>
      )}
      {single && !node?.role && (
        <div style={{ position: 'relative' }} onMouseEnter={() => setTypeMenuOpen(true)} onMouseLeave={() => setTypeMenuOpen(false)}>
          <button type="button" role="menuitem" onClick={() => setTypeMenuOpen(value => !value)} aria-expanded={typeMenuOpen} style={{ border: 0, background: 'transparent', color: 'inherit', width: '100%', padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            旧标签（兼容）
            <ChevronRight size={14} />
          </button>
          {typeMenuOpen && (
            <div
              style={{
                position: 'absolute',
                left: '100%',
                top: 0,
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                boxShadow: 'var(--shadow-pop)',
                minWidth: 140,
                maxHeight: 320,
                overflowY: 'auto',
              }}
            >
              {ALL_ARGUMENT_TYPES.map((t) => (
                <button type="button" role="menuitem"
                  key={t}
                  onClick={() => {
                    onChangeType(state.nodeIds[0], t);
                    onClose();
                  }}
                  style={{ display: 'block', border: 0, background: 'transparent', color: 'inherit', padding: '8px 12px', cursor: 'pointer' }}
                >
                  {t}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <button type="button" role="menuitem"
        onClick={() => {
          onDeleteNodes(state.nodeIds);
          onClose();
        }}
        style={{ display: 'block', width: '100%', textAlign: 'left', border: 0, background: 'transparent', padding: '8px 12px', cursor: 'pointer', color: 'var(--color-error)' }}
      >
        {single ? '删除节点' : `批量删除（${state.nodeIds.length} 个节点）`}
      </button>
    </div>
  );
}
