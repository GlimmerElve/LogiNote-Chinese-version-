/**
 * 右键菜单（从 argument-editor-standalone 迁移）
 * - 单节点：切换类型（9 类）+ 删除
 * - 多节点：批量删除
 */

import { useRef, useEffect, useLayoutEffect, useState, type KeyboardEvent } from 'react';
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
  dialogPriority?: number;
}

export function ContextMenu({ state, onDeleteNodes, onChangeType, onChangeRole, onClose, dialogPriority }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const typeMenuRef = useRef<HTMLDivElement>(null);
  const typeTriggerRef = useRef<HTMLButtonElement>(null);
  const [typeMenuOpen, setTypeMenuOpen] = useState(false);
  const [position, setPosition] = useState({ left: state.x, top: state.y });
  const [typePosition, setTypePosition] = useState({ left: state.x, top: state.y });
  useDialog(true, menuRef, onClose, dialogPriority);
  const node = useCanvasStore(s => s.doc.nodes.find(n => n.id === state.nodeIds[0]));

  useLayoutEffect(() => {
    const placeMenus = () => {
      const menu = menuRef.current;
      if (!menu) return;
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft || 0) + 8, top = (viewport?.offsetTop || 0) + 8;
      const right = left + (viewport?.width || innerWidth) - 16;
      const bottom = top + (viewport?.height || innerHeight) - 16;
      const bound = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));
      const rect = menu.getBoundingClientRect();
      const next = { left: bound(state.x, left, right - rect.width), top: bound(state.y, top, bottom - rect.height) };
      setPosition(previous => previous.left === next.left && previous.top === next.top ? previous : next);
      if (typeMenuOpen && typeMenuRef.current && typeTriggerRef.current) {
        const sub = typeMenuRef.current.getBoundingClientRect();
        const trigger = typeTriggerRef.current.getBoundingClientRect();
        const nextType = {
          left: bound(next.left + rect.width + sub.width <= right ? next.left + rect.width : next.left - sub.width, left, right - sub.width),
          top: bound(trigger.top + next.top - rect.top, top, bottom - sub.height),
        };
        setTypePosition(previous => previous.left === nextType.left && previous.top === nextType.top ? previous : nextType);
      }
    };
    placeMenus();
    const observer = new ResizeObserver(placeMenus);
    if (menuRef.current) observer.observe(menuRef.current);
    if (typeMenuRef.current) observer.observe(typeMenuRef.current);
    window.addEventListener('resize', placeMenus);
    window.addEventListener('scroll', placeMenus, true);
    window.visualViewport?.addEventListener('resize', placeMenus);
    window.visualViewport?.addEventListener('scroll', placeMenus);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', placeMenus);
      window.removeEventListener('scroll', placeMenus, true);
      window.visualViewport?.removeEventListener('resize', placeMenus);
      window.visualViewport?.removeEventListener('scroll', placeMenus);
    };
  }, [state.x, state.y, typeMenuOpen, state.nodeIds.length, node?.role]);

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

  const openTypeMenu = () => {
    setTypeMenuOpen(true);
    requestAnimationFrame(() => typeMenuRef.current?.querySelector<HTMLButtonElement>('button')?.focus());
  };
  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target as HTMLElement;
    if (event.key === 'ArrowLeft' && typeMenuRef.current?.contains(target)) {
      event.preventDefault(); setTypeMenuOpen(false); typeTriggerRef.current?.focus(); return;
    }
    if (event.key === 'ArrowRight' && target === typeTriggerRef.current) {
      event.preventDefault(); openTypeMenu(); return;
    }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const owner = target.closest('[role="menu"]') || event.currentTarget;
    const buttons = Array.from(owner.querySelectorAll<HTMLButtonElement>('button'))
      .filter(button => button.closest('[role="menu"]') === owner);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
  };

  return (
    <div
      ref={menuRef}
      role="menu" aria-label="节点操作" tabIndex={-1}
      onKeyDown={handleKey}
      style={{
        position: 'fixed',
        ...position,
        zIndex: 1000,
        background: 'var(--color-surface)',
        border: '1px solid var(--color-border)',
        borderRadius: 'var(--radius-sm)',
        boxShadow: 'var(--shadow-pop)',
        boxSizing: 'border-box',
        minWidth: 'min(160px, calc(100vw - 16px))',
        maxWidth: 'calc(100vw - 16px)',
        maxHeight: 'calc(100dvh - 16px)',
        overflowY: 'auto',
        overscrollBehavior: 'contain',
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
          <button ref={typeTriggerRef} type="button" role="menuitem" onClick={() => typeMenuOpen ? setTypeMenuOpen(false) : openTypeMenu()} aria-haspopup="menu" aria-expanded={typeMenuOpen} style={{ border: 0, background: 'transparent', color: 'inherit', width: '100%', padding: '8px 12px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            旧标签（兼容）
            <ChevronRight size={14} />
          </button>
          {typeMenuOpen && (
            <div
              ref={typeMenuRef} role="menu" aria-label="旧标签（兼容）"
              style={{
                position: 'fixed',
                ...typePosition,
                zIndex: 1001,
                background: 'var(--color-surface)',
                border: '1px solid var(--color-border)',
                borderRadius: 'var(--radius-sm)',
                boxShadow: 'var(--shadow-pop)',
                boxSizing: 'border-box',
                minWidth: 'min(140px, calc(100vw - 16px))',
                maxWidth: 'calc(100vw - 16px)',
                maxHeight: 'min(320px, calc(100dvh - 16px))',
                overflowY: 'auto',
                overscrollBehavior: 'contain',
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
