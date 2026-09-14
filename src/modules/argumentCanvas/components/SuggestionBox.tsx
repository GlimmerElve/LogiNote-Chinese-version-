/**
 * 建议框（从 argument-editor-standalone 迁移）
 * 用于 status=suggested 的节点，显示建议 + [添加][删除]。
 */

import { Lightbulb } from 'lucide-react';

interface SuggestionBoxProps {
  nodeId: string;
  suggestion: string | null;
}

export function SuggestionBox({ nodeId, suggestion }: SuggestionBoxProps) {
  const accept = () => {
    document.dispatchEvent(new CustomEvent('arg-suggestion:accept', { detail: { id: nodeId } }));
  };

  const discard = () => {
    document.dispatchEvent(new CustomEvent('arg-suggestion:discard', { detail: { id: nodeId } }));
  };

  return (
    <div style={{ padding: '10px 12px', background: 'rgba(139, 92, 246, 0.06)', borderTop: '1px dashed var(--color-suggested)', fontSize: 12, color: 'var(--color-suggested)' }}>
      <div style={{ marginBottom: 8, lineHeight: 1.5, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        <Lightbulb size={14} strokeWidth={2} style={{ flexShrink: 0, marginTop: 1 }} />
        <span>{suggestion || '建议新增此节点'}</span>
      </div>
      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={accept} onMouseDown={(e) => e.stopPropagation()} style={{ padding: '4px 12px', border: '1px solid var(--color-suggested)', borderRadius: 'var(--radius-xs)', background: 'var(--color-suggested)', color: '#fff', cursor: 'pointer', fontSize: 12 }}>
          添加
        </button>
        <button onClick={discard} onMouseDown={(e) => e.stopPropagation()} style={{ padding: '4px 12px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-xs)', background: 'var(--color-surface)', color: 'var(--color-text-muted)', cursor: 'pointer', fontSize: 12 }}>
          删除
        </button>
      </div>
    </div>
  );
}