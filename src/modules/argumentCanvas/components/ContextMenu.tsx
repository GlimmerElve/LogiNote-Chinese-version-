/**
 * 右键菜单（从 argument-editor-standalone 迁移）
 * - 单节点：切换类型（9 类）+ 删除
 * - 多节点：批量删除
 */

import { useRef, useEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import type { ArgumentFunctionType } from '../../../types';
import { ALL_ARGUMENT_TYPES } from '../../../services/argumentDoc/types';

export interface ContextMenuState {
  x: number;
  y: number;
  nodeIds: string[];
}

interface ContextMenuProps {
  state: ContextMenuState;
  onDeleteNodes: (ids: string[]) => void;
  onChangeType: (id: string, type: ArgumentFunctionType) => void;
  onClose: () => void;
}

export function ContextMenu({ state, onDeleteNodes, onChangeType, onClose }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);

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
        <div style={{ position: 'relative' }} onMouseEnter={() => setTypeMenuOpen(true)} onMouseLeave={() => setTypeMenuOpen(false)}>
          <div style={{ padding: '8px 12px', cursor: 'default', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            切换类型
            <ChevronRight size={14} />
          </div>
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
                <div
                  key={t}
                  onClick={() => {
                    onChangeType(state.nodeIds[0], t);
                    onClose();
                  }}
                  style={{ padding: '8px 12px', cursor: 'pointer' }}
                >
                  {t}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div
        onClick={() => {
          onDeleteNodes(state.nodeIds);
          onClose();
        }}
        style={{ padding: '8px 12px', cursor: 'pointer', color: 'var(--color-error)' }}
      >
        {single ? '删除节点' : `批量删除（${state.nodeIds.length} 个节点）`}
      </div>
    </div>
  );
}