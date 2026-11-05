import type { ReactNode, RefObject } from 'react';
import './ArgumentEditorFrame.css';

/** Shared production frame: controls occupy their own rows, never cover an editor. */
export function ArgumentEditorFrame({ rootRef, title, toolbar, panelToggle, canvas, sidebar, actions, nodeCount, edgeCount, busy = false, feedback }: {
  rootRef?: RefObject<HTMLDivElement | null>; title: string; toolbar: ReactNode; panelToggle: ReactNode;
  canvas: ReactNode; sidebar?: ReactNode; actions: ReactNode; nodeCount: number; edgeCount: number;
  busy?: boolean; feedback?: ReactNode;
}) {
  return <div ref={rootRef} className="argument-editor-workspace argument-canvas-scope argument-editor-frame">
    <header className="argument-editor-topbar" inert={busy}>
      <div className="argument-editor-brand"><span>LogiNote · 论证结构</span><h1 title={title}>{title}</h1></div>
      <div className="argument-editor-tools">{toolbar}</div>
      {panelToggle}
    </header>
    <div className="argument-editor-main" inert={busy} aria-busy={busy}>
      {canvas}
      {sidebar}
    </div>
    <footer className="argument-editor-footer">
      {feedback}
      <div className="argument-editor-statusbar">
        <span>节点 {nodeCount} · 连线 {edgeCount}</span>
        <details className="argument-editor-shortcuts"><summary>快捷键</summary>
          <p>Tab 新建前提并确认关系 · Shift+Tab 优先反对 · Ctrl+Enter 新建块 · Delete 删除 · Ctrl+Z 撤销 · Ctrl+C/V 复制粘贴</p>
        </details>
      </div>
      <div className="argument-editor-actions" role="group" aria-label="论证操作">{actions}</div>
    </footer>
  </div>;
}
