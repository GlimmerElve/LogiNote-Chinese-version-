/**
 * 问题气泡（从 argument-editor-standalone 迁移）
 * 点击 error/warning 节点的 ⚠️ 图标时弹出。
 */

import { useEffect, useRef } from 'react';

interface IssueBubbleProps {
  x: number;
  y: number;
  severity: number | null;
  issue: string;
  suggestion: string | null;
  onClose: () => void;
}

function severityLabel(severity: number | null): string {
  if (severity === null) return '未知';
  if (severity >= 4) return '严重问题';
  if (severity >= 2) return '一般问题';
  return '轻微问题';
}

function severityColor(severity: number | null): string {
  if (severity === null) return '#9ca3af';
  if (severity >= 4) return '#ef4444';
  if (severity >= 2) return '#f59e0b';
  return '#eab308';
}

export function IssueBubble({ x, y, severity, issue, suggestion, onClose }: IssueBubbleProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) onClose();
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [onClose]);

  return (
    <div ref={ref} style={{ position: 'fixed', left: x, top: y, zIndex: 2000, width: 280, background: 'var(--color-surface)', border: `1px solid ${severityColor(severity)}`, borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-pop)', padding: 14, fontSize: 13, color: 'var(--color-text)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <span style={{ fontWeight: 700, fontSize: 14, color: 'var(--color-text)' }}>问题诊断</span>
        <span style={{ background: severityColor(severity), color: '#fff', fontSize: 11, padding: '1px 8px', borderRadius: 10 }}>
          {severityLabel(severity)}
        </span>
      </div>

      <div style={{ marginBottom: 6 }}>
        <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>问题描述</div>
        <div style={{ lineHeight: 1.6 }}>{issue || '（无描述）'}</div>
      </div>

      {suggestion && (
        <div style={{ marginBottom: 10 }}>
          <div style={{ fontSize: 11, color: '#9ca3af', marginBottom: 2 }}>改进建议</div>
          <div style={{ lineHeight: 1.6, color: '#1f2937' }}>{suggestion}</div>
        </div>
      )}

      <button onClick={onClose} style={{ width: '100%', padding: '7px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', background: 'var(--color-surface-muted)', cursor: 'pointer', fontSize: 13, color: 'var(--color-text)' }}>
        知道了
      </button>
    </div>
  );
}