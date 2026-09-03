import React, { useEffect, useRef } from "react";

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

const MIN_W = 1000;
const MIN_H = 620;

/**
 * 无边框窗口的 10px 透明边缘缩放热区。
 * 渲染 8 个固定定位的透明条/角，mousedown 时记录初始屏幕坐标与窗口边界，
 * mousemove 时按方向计算新边界并通过 IPC setBounds 手动缩放窗口。
 * 仅在 Electron 环境渲染。
 */
export const WindowResizeHandles: React.FC = () => {
  const controls = (window as any).electronAPI?.windowControls as
    | {
        getBounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
        setBounds: (b: { x: number; y: number; width: number; height: number }) => void;
      }
    | undefined;
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!controls) return;

    const startResize = (dir: ResizeDir, e: MouseEvent) => {
      e.preventDefault();
      const startX = e.screenX;
      const startY = e.screenY;

      controls.getBounds().then((initial) => {
        if (!initial) return;

        const onMove = (ev: MouseEvent) => {
          const dx = ev.screenX - startX;
          const dy = ev.screenY - startY;
          let { x, y, width, height } = initial;

          if (dir.includes("e")) width = initial.width + dx;
          if (dir.includes("s")) height = initial.height + dy;
          if (dir.includes("w")) {
            x = initial.x + dx;
            width = initial.width - dx;
          }
          if (dir.includes("n")) {
            y = initial.y + dy;
            height = initial.height - dy;
          }

          // 最小尺寸约束（与主进程 minWidth/minHeight 保持一致）
          if (width < MIN_W) {
            if (dir.includes("w")) x = initial.x + (initial.width - MIN_W);
            width = MIN_W;
          }
          if (height < MIN_H) {
            if (dir.includes("n")) y = initial.y + (initial.height - MIN_H);
            height = MIN_H;
          }

          if (rafRef.current) cancelAnimationFrame(rafRef.current);
          rafRef.current = requestAnimationFrame(() => {
            controls.setBounds({
              x: Math.round(x),
              y: Math.round(y),
              width: Math.round(width),
              height: Math.round(height),
            });
          });
        };

        const onUp = () => {
          window.removeEventListener("mousemove", onMove);
          window.removeEventListener("mouseup", onUp);
        };

        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      });
    };

    const binds: Array<[ResizeDir, string]> = [
      ["n", ".resize-handle-n"],
      ["s", ".resize-handle-s"],
      ["e", ".resize-handle-e"],
      ["w", ".resize-handle-w"],
      ["ne", ".resize-handle-ne"],
      ["nw", ".resize-handle-nw"],
      ["se", ".resize-handle-se"],
      ["sw", ".resize-handle-sw"],
    ];

    const disposers: Array<() => void> = [];
    binds.forEach(([dir, selector]) => {
      const el = document.querySelector(selector) as HTMLElement | null;
      if (!el) return;
      const handler = (e: MouseEvent) => startResize(dir, e);
      el.addEventListener("mousedown", handler as EventListener);
      disposers.push(() => el.removeEventListener("mousedown", handler as EventListener));
    });

    return () => {
      disposers.forEach((fn) => fn());
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [controls]);

  if (!controls) return null;

  return (
    <>
      <div className="resize-handle resize-handle-n" />
      <div className="resize-handle resize-handle-s" />
      <div className="resize-handle resize-handle-e" />
      <div className="resize-handle resize-handle-w" />
      <div className="resize-handle resize-handle-ne" />
      <div className="resize-handle resize-handle-nw" />
      <div className="resize-handle resize-handle-se" />
      <div className="resize-handle resize-handle-sw" />
    </>
  );
};