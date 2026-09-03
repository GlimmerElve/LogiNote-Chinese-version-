import React, { useEffect, useState } from "react";
import { Minus, Square, X, Maximize2 } from "lucide-react";

/**
 * Windows 风格窗口控制按钮组（最小化 / 最大化·还原 / 关闭）。
 * 仅在 Electron 环境渲染；订阅最大化状态用于切换图标并维护根元素的
 * `electron-maximized` class（最大化时去除圆角与 10px 透明热区）。
 */
export const WindowControls: React.FC = () => {
  const controls = (window as any).electronAPI?.windowControls as
    | {
        minimize: () => void;
        toggleMaximize: () => void;
        close: () => void;
        isMaximized: () => Promise<boolean>;
        onMaximizedChange: (cb: (maximized: boolean) => void) => () => void;
      }
    | undefined;
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!controls) return;
    let mounted = true;
    controls.isMaximized().then((v: boolean) => {
      if (mounted) setMaximized(v);
    });
    const unsubscribe = controls.onMaximizedChange((v: boolean) => {
      setMaximized(v);
      document.documentElement.classList.toggle("electron-maximized", v);
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [controls]);

  if (!controls) return null;

  return (
    <div className="app-no-drag flex items-center h-full">
      <button
        onClick={() => controls.minimize()}
        className="window-control-btn"
        title="最小化"
        aria-label="最小化"
      >
        <Minus className="w-4 h-4" />
      </button>
      <button
        onClick={() => controls.toggleMaximize()}
        className="window-control-btn"
        title={maximized ? "还原" : "最大化"}
        aria-label={maximized ? "还原" : "最大化"}
      >
        {maximized ? <Maximize2 className="w-3.5 h-3.5" /> : <Square className="w-3 h-3" />}
      </button>
      <button
        onClick={() => controls.close()}
        className="window-control-btn window-control-close"
        title="关闭"
        aria-label="关闭"
      >
        <X className="w-4 h-4" />
      </button>
    </div>
  );
};