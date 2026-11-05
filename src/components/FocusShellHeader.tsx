import React from 'react';
import { Circle } from 'lucide-react';
import { WindowControls } from './WindowControls';

interface FocusShellHeaderProps {
  title: string;
  context?: string;
}

/**
 * 专注页面的最小桌面壳层。
 *
 * 不提供全局导航，避免学习过程被打断；仅保留窗口拖动区域、当前任务标识
 * 与无边框 Electron 窗口必需的控制按钮。退出语义仍由各业务页面负责。
 */
export const FocusShellHeader: React.FC<FocusShellHeaderProps> = ({ title, context }) => {
  const handleTitleBarDoubleClick = (event: React.MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea, .app-no-drag')) return;
    (window as any).electronAPI?.windowControls?.toggleMaximize();
  };

  return (
    <header className="focus-shell-header app-drag-region" onDoubleClick={handleTitleBarDoubleClick}>
      <div className="focus-shell-identity" aria-label={`当前专注任务：${title}`}>
        <Circle className="focus-shell-pulse" aria-hidden="true" />
        <span className="focus-shell-mode">专注模式</span>
        <span className="focus-shell-divider" aria-hidden="true" />
        <strong>{title}</strong>
        {context && <span className="focus-shell-context">{context}</span>}
      </div>
      <WindowControls />
    </header>
  );
};
