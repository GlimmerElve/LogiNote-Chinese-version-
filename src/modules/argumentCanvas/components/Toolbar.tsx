/**
 * 顶部工具栏（高对比按钮样式，不依赖画布 CSS 变量）
 *
 * 提供：新建节点（9 类下拉）、一键整理（三层布局）、导出（Markdown / JSON / PDF / PNG）。
 */

import { useEffect, useId, useRef, useState } from 'react';
import { Plus, LayoutGrid, Download, LoaderCircle } from 'lucide-react';
import type { ArgumentFunctionType } from '../../../types';
import { ALL_ARGUMENT_TYPES, ALL_ARGUMENT_ROLES, ARGUMENT_ROLE_LABELS, type ArgumentRole } from '../../../services/argumentDoc/types';
import './Toolbar.css';

interface ToolbarProps {
  onAddNode: (type: ArgumentFunctionType) => void;
  onAddRole?: (role: ArgumentRole) => void;
  onAutoLayout: () => void;
  onExportMarkdown: () => void | Promise<void>;
  onExportJSON: () => void | Promise<void>;
  onExportPDF: () => void | Promise<void>;
  onExportPNG: () => void | Promise<void>;
}

export function Toolbar({
  onAddNode,
  onAddRole,
  onAutoLayout,
  onExportMarkdown,
  onExportJSON,
  onExportPDF,
  onExportPNG,
}: ToolbarProps) {
  const [menu, setMenu] = useState<'node' | 'export' | null>(null);
  const [exporting, setExporting] = useState('');
  const [error, setError] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const nodeTrigger = useRef<HTMLButtonElement>(null);
  const exportTrigger = useRef<HTMLButtonElement>(null);
  const exportLock = useRef(false);
  const mounted = useRef(true);
  const pendingFocus = useRef<HTMLElement | null>(null);
  const id = useId();

  useEffect(() => {
    mounted.current = true;
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setMenu(null);
    };
    document.addEventListener('pointerdown', outside);
    return () => {
      mounted.current = false;
      document.removeEventListener('pointerdown', outside);
    };
  }, []);

  useEffect(() => {
    if (menu) menuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [menu]);

  useEffect(() => {
    if (exporting || !pendingFocus.current) return;
    const target = pendingFocus.current;
    pendingFocus.current = null;
    // Do not steal focus back if the user moved to another part of the editor.
    if (target.isConnected && !target.matches(':disabled') &&
        (document.activeElement === document.body || rootRef.current?.contains(document.activeElement))) {
      target.focus({ preventScroll: true });
    }
  }, [exporting]);

  const close = () => {
    setMenu(null);
    (menu === 'node' ? nodeTrigger : exportTrigger).current?.focus({ preventScroll: true });
  };

  const exportItem = async (label: string, action: () => void | Promise<void>, origin: HTMLButtonElement) => {
    if (exportLock.current) return;
    exportLock.current = true;
    setExporting(label);
    setError('');
    try {
      await action();
      if (mounted.current) {
        setMenu(null);
        pendingFocus.current = exportTrigger.current;
      }
    } catch (cause) {
      if (mounted.current) {
        setError(`${label}未完成。${cause instanceof Error ? cause.message : '请重试。'}`);
        pendingFocus.current = origin;
      }
    } finally {
      exportLock.current = false;
      if (mounted.current) setExporting('');
    }
  };

  return (
    <div ref={rootRef} className="argument-toolbar argument-toolbar-accessible" onKeyDown={(event) => {
      if (!menu) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (!menuRef.current?.contains(event.target as Node)) return;
      if (event.key === 'Tab') {
        event.preventDefault();
        const trigger = (menu === 'node' ? nodeTrigger : exportTrigger).current;
        const controls = Array.from(document.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), select:not(:disabled), summary, [tabindex]'))
          .filter(control => control.tabIndex >= 0 && control.getClientRects().length > 0 && !control.closest('[inert]') && !menuRef.current?.contains(control));
        const index = trigger ? controls.indexOf(trigger) : -1;
        setMenu(null);
        (event.shiftKey ? trigger : controls[index + 1] || trigger)?.focus({ preventScroll: true });
        return;
      }
      const options = Array.from(menuRef.current.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
      const index = options.indexOf(event.target as HTMLButtonElement);
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) || !options.length) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 :
        (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[next]?.focus({ preventScroll: true });
    }}>
      <div className="argument-toolbar-title">
        <span>论证结构</span>
        <small>双击节点编辑内容</small>
      </div>

      {/* 新建节点下拉 */}
      <div className="argument-toolbar-menu">
        <button
          type="button" ref={nodeTrigger} aria-haspopup="menu" aria-expanded={menu === 'node'} aria-controls={`${id}-nodes`}
          onClick={() => setMenu((v) => v === 'node' ? null : 'node')}
          className="argument-toolbar-button is-primary"
        >
          <Plus aria-hidden="true" />
          新建节点
        </button>
        {menu === 'node' && (
          <div ref={menuRef} id={`${id}-nodes`} role="menu" aria-label="选择节点类型" className="argument-toolbar-popover is-left"
            onBlur={(event) => { if (event.relatedTarget !== nodeTrigger.current && event.relatedTarget !== exportTrigger.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) setMenu(null); }}>
            {onAddRole ? ALL_ARGUMENT_ROLES.map(role => <button type="button" role="menuitem" tabIndex={-1}
              key={role} className="argument-toolbar-option" onClick={() => { onAddRole(role); close(); }}>
              {ARGUMENT_ROLE_LABELS[role]}
            </button>) : ALL_ARGUMENT_TYPES.map((t) => (
              <button
                type="button" role="menuitem" tabIndex={-1}
                key={t}
                onClick={() => {
                  onAddNode(t);
                  close();
                }}
                className="argument-toolbar-option"
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* 一键整理 */}
      <button
        type="button"
        onClick={onAutoLayout}
        className="argument-toolbar-button"
      >
        <LayoutGrid aria-hidden="true" />
        一键整理
      </button>

      {/* 导出下拉 */}
      <div className="argument-toolbar-menu is-export">
        <button
          type="button" ref={exportTrigger} aria-haspopup="menu" aria-expanded={menu === 'export'} aria-controls={`${id}-exports`}
          onClick={() => setMenu((v) => v === 'export' ? null : 'export')}
          className="argument-toolbar-button"
        >
          {exporting ? <LoaderCircle aria-hidden="true" className="animate-spin motion-reduce:animate-none" /> : <Download aria-hidden="true" />}
          {exporting ? '正在导出' : '导出'}
        </button>
        {menu === 'export' && (
          <div ref={menuRef} id={`${id}-exports`} role="menu" aria-label="选择导出格式" aria-busy={!!exporting} className="argument-toolbar-popover is-right"
            onBlur={(event) => { if (event.relatedTarget && event.relatedTarget !== nodeTrigger.current && event.relatedTarget !== exportTrigger.current && !event.currentTarget.contains(event.relatedTarget as Node)) setMenu(null); }}>
            {[
              { label: '导出 Markdown', fn: onExportMarkdown },
              { label: '导出 JSON', fn: onExportJSON },
              { label: '导出 PDF', fn: onExportPDF },
              { label: '导出 PNG', fn: onExportPNG },
            ].map((item) => (
              <button
                type="button" role="menuitem" tabIndex={-1} disabled={!!exporting}
                key={item.label}
                onClick={(event) => { void exportItem(item.label, item.fn, event.currentTarget); }}
                className="argument-toolbar-option"
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {exporting && <div role="status" className="argument-toolbar-notice">正在生成导出文件，请稍候。</div>}
      {error && <div role="alert" className="argument-toolbar-notice">{error}</div>}
    </div>
  );
}
