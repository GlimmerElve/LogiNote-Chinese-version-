import React, { useEffect, useRef, useState } from 'react';
import { Bot } from 'lucide-react';

const POSITION_KEY = 'loginote_agent_orb_pos_v1';

function clampPosition(position: { x: number; y: number }): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(window.innerWidth - 60, position.x)),
    y: Math.max(64, Math.min(window.innerHeight - 60, position.y)),
  };
}

function initialPosition(): { x: number; y: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(POSITION_KEY) || 'null');
    if (typeof saved?.x === 'number' && typeof saved?.y === 'number') return clampPosition(saved);
  } catch { /* ignore damaged local UI preference */ }
  return clampPosition({ x: window.innerWidth - 76, y: window.innerHeight - 92 });
}

export const AgentOrb: React.FC<{
  open: boolean;
  busy: boolean;
  hasRecommendation?: boolean;
  onToggle: () => void;
}> = ({ open, busy, hasRecommendation = false, onToggle }) => {
  const [position, setPosition] = useState(initialPosition);
  const positionRef = useRef(position);
  positionRef.current = position;
  const drag = useRef<{ pointerId: number; dx: number; dy: number; startX: number; startY: number; moved: boolean } | null>(null);
  const suppressPointerClick = useRef(false);

  const cancelDrag = (event: React.PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    suppressPointerClick.current = true;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  useEffect(() => {
    const keepInViewport = () => setPosition((current) => clampPosition(current));
    window.addEventListener('resize', keepInViewport);
    return () => window.removeEventListener('resize', keepInViewport);
  }, []);

  return (
    <button
      type="button"
      className={`agent-orb${open ? ' is-open' : ''}${busy ? ' is-busy' : ''}${hasRecommendation ? ' has-recommendation' : ''}`}
      style={{ left: position.x, top: position.y }}
      aria-label={open ? '关闭学习助手' : '打开学习助手'}
      aria-expanded={open}
      title="学习助手（Ctrl/Cmd + J）"
      onClick={(event) => {
        // Native button clicks cover Enter, Space and assistive technology.
        // Only the pointer click produced by a completed drag is suppressed.
        const dragged = suppressPointerClick.current;
        suppressPointerClick.current = false;
        if (event.detail > 0 && dragged) { event.preventDefault(); return; }
        onToggle();
      }}
      onPointerDown={(event) => {
        if (!event.isPrimary || event.button !== 0) return;
        suppressPointerClick.current = false;
        drag.current = { pointerId: event.pointerId, dx: event.clientX - position.x, dy: event.clientY - position.y, startX: event.clientX, startY: event.clientY, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (!state || state.pointerId !== event.pointerId) return;
        if (Math.abs(event.clientX - state.startX) > 3 || Math.abs(event.clientY - state.startY) > 3) state.moved = true;
        if (!state.moved) return;
        const next = clampPosition({ x: event.clientX - state.dx, y: event.clientY - state.dy });
        positionRef.current = next;
        setPosition(next);
      }}
      onPointerUp={(event) => {
        const state = drag.current;
        if (!state || state.pointerId !== event.pointerId) return;
        state.moved ||= Math.abs(event.clientX - state.startX) > 3 || Math.abs(event.clientY - state.startY) > 3;
        if (state.moved) {
          const next = clampPosition({ x: event.clientX - state.dx, y: event.clientY - state.dy });
          positionRef.current = next;
          setPosition(next);
        }
        drag.current = null;
        suppressPointerClick.current = state.moved;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
        if (state.moved) {
          try { localStorage.setItem(POSITION_KEY, JSON.stringify(positionRef.current)); } catch { /* Dragging still works when preferences cannot be saved. */ }
        }
      }}
      onPointerCancel={cancelDrag}
      onLostPointerCapture={cancelDrag}
    >
      <Bot aria-hidden="true" />
      <span className="agent-orb-status" />
      {hasRecommendation && !open && <span className="agent-orb-recommendation" aria-label="有建议的下一步" />}
    </button>
  );
};
