/**
 * 公式工具栏（从 argument-editor-standalone 迁移）
 * 编辑态显示在 textarea 上方，提供「插入公式」按钮 + 常用公式/希腊字母面板。
 */

import { useState, useRef, useEffect } from 'react';

const COMMON_FORMULAS: Array<{ label: string; tex: string }> = [
  { label: '分数', tex: '\\frac{}{}' },
  { label: '根式', tex: '\\sqrt{}' },
  { label: '求和', tex: '\\sum_{}^{}' },
  { label: '积分', tex: '\\int_{}^{}' },
  { label: '极限', tex: '\\lim_{x \\to }' },
  { label: '矩阵', tex: '\\begin{pmatrix} \\end{pmatrix}' },
  { label: '乘积', tex: '\\prod_{}^{}' },
  { label: '属于', tex: '\\in' },
  { label: '不属于', tex: '\\notin' },
  { label: '不等于', tex: '\\neq' },
  { label: '小于等于', tex: '\\leq' },
  { label: '大于等于', tex: '\\geq' },
  { label: '无穷', tex: '\\infty' },
];

const GREEK_LETTERS: Array<{ symbol: string; tex: string }> = [
  { symbol: 'α', tex: '\\alpha' },
  { symbol: 'β', tex: '\\beta' },
  { symbol: 'γ', tex: '\\gamma' },
  { symbol: 'δ', tex: '\\delta' },
  { symbol: 'ε', tex: '\\epsilon' },
  { symbol: 'ζ', tex: '\\zeta' },
  { symbol: 'η', tex: '\\eta' },
  { symbol: 'θ', tex: '\\theta' },
  { symbol: 'ι', tex: '\\iota' },
  { symbol: 'κ', tex: '\\kappa' },
  { symbol: 'λ', tex: '\\lambda' },
  { symbol: 'μ', tex: '\\mu' },
  { symbol: 'ν', tex: '\\nu' },
  { symbol: 'ξ', tex: '\\xi' },
  { symbol: 'π', tex: '\\pi' },
  { symbol: 'ρ', tex: '\\rho' },
  { symbol: 'σ', tex: '\\sigma' },
  { symbol: 'τ', tex: '\\tau' },
  { symbol: 'φ', tex: '\\phi' },
  { symbol: 'χ', tex: '\\chi' },
  { symbol: 'ψ', tex: '\\psi' },
  { symbol: 'ω', tex: '\\omega' },
  { symbol: 'Γ', tex: '\\Gamma' },
  { symbol: 'Δ', tex: '\\Delta' },
  { symbol: 'Θ', tex: '\\Theta' },
  { symbol: 'Λ', tex: '\\Lambda' },
  { symbol: 'Π', tex: '\\Pi' },
  { symbol: 'Σ', tex: '\\Sigma' },
  { symbol: 'Φ', tex: '\\Phi' },
  { symbol: 'Ψ', tex: '\\Psi' },
  { symbol: 'Ω', tex: '\\Omega' },
];

interface FormulaToolbarProps {
  onInsert: (tex: string) => void;
}

export function FormulaToolbar({ onInsert }: FormulaToolbarProps) {
  const [open, setOpen] = useState(false);
  const [hint, setHint] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  useEffect(() => {
    return () => {
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    };
  }, []);

  const insert = (tex: string) => {
    onInsert(tex);
    setOpen(false);
    setHint(true);
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = setTimeout(() => setHint(false), 2500);
  };

  return (
    <div ref={rootRef} style={{ position: 'relative', padding: '4px 8px', background: 'var(--color-surface-muted)', borderBottom: '1px solid var(--color-border-soft)' }}>
      <button
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        style={{ padding: '5px 10px', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-xs)', background: 'var(--color-surface)', cursor: 'pointer', fontSize: 13, color: 'var(--color-text)' }}
      >
        插入公式
      </button>
      {hint && (
        <span style={{ marginLeft: 8, fontSize: 11, color: '#b45309', background: '#fef3c7', padding: '2px 8px', borderRadius: 6 }}>
          公式需用 $...$ 包裹才能渲染
        </span>
      )}
      {open && (
        <div className="nodrag nopan nowheel" style={{ position: 'absolute', left: '100%', top: 0, zIndex: 1000, background: 'var(--color-surface)', border: '1px solid var(--color-border)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-pop)', maxHeight: 220, overflowY: 'auto', width: 180, padding: 6 }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>常用公式</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 2, marginBottom: 6 }}>
            {COMMON_FORMULAS.map((f) => (
              <div key={f.label} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(f.tex)} style={{ padding: '3px 6px', cursor: 'pointer', fontSize: 12, color: '#374151', borderRadius: 4 }}>
                {f.label}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#6b7280', marginBottom: 4 }}>希腊字母</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 2 }}>
            {GREEK_LETTERS.map((g) => (
              <div key={g.tex} onMouseDown={(e) => e.preventDefault()} onClick={() => insert(g.tex)} style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 14, fontFamily: 'serif', borderRadius: 4, color: '#374151' }} title={g.tex}>
                {g.symbol}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}