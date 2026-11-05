import React, { useEffect, useRef, useState } from 'react';
import { MathField } from '../../modules/derivationCanvas/components/MathField';
import { FormulaBlock } from '../textbook/FormulaBlock';
import { useDialog } from '../useDialog';
import { answerPreviewParts, insertAnswerFormula } from './mathAnswer';
import './mathLiveAnswer.css';

export interface MathLiveAnswerProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Persisted by the card independently of the submitted answer. */
  formulaDraft: string;
  onFormulaDraftChange: (latex: string) => void;
  maxLength?: number;
  disabled?: boolean;
  placeholder?: string;
}

/** Formula editing is just input, not a hint, evaluation or assisted answer. */
export function MathLiveAnswer({ id, value, onChange, formulaDraft, onFormulaDraftChange,
  maxLength = 4000, disabled = false, placeholder = '用自己的话作答，也可以列出计算或证明的关键步骤…' }: MathLiveAnswerProps) {
  const textarea = useRef<HTMLTextAreaElement>(null);
  const renderedAnswer = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const selection = useRef({ start: value.length, end: value.length });
  const pendingCursor = useRef<number | null>(null);
  // Inserting/cancelling synchronously invalidates the editor before any parent
  // update or focus transfer. A late MathField blur may still try to save its
  // old value while React is unmounting it; that must not resurrect the draft.
  const finishing = useRef(false);
  const [open, setOpen] = useState(Boolean(formulaDraft.trim()));
  const [editing, setEditing] = useState(false);
  const [display, setDisplay] = useState(false);
  const [showSource, setShowSource] = useState(!answerPreviewParts(value).some(part => part.kind === 'formula'));
  const [error, setError] = useState('');
  const [keyboardContainer, setKeyboardContainer] = useState<HTMLDivElement | null>(null);
  useDialog(open && !disabled, panel, () => { setEditing(false); setOpen(false); }, 230);
  useEffect(() => {
    if (pendingCursor.current == null) return;
    const cursor = pendingCursor.current; pendingCursor.current = null;
    if (showSource) {
      textarea.current?.focus({ preventScroll: true });
      textarea.current?.setSelectionRange(cursor, cursor);
    } else renderedAnswer.current?.focus({ preventScroll: true });
    selection.current = { start: cursor, end: cursor };
  }, [value, open, showSource]);

  const rememberSelection = () => {
    const element = textarea.current;
    if (showSource && element) selection.current = { start: element.selectionStart, end: element.selectionEnd };
  };
  const keepDraft = (latex: string) => {
    if (finishing.current) return;
    setError(''); onFormulaDraftChange(latex);
  };
  const insert = () => {
    const result = insertAnswerFormula(value, formulaDraft, selection.current, display, maxLength);
    if (result.ok === false) { setError(result.error); return; }
    finishing.current = true;
    pendingCursor.current = result.cursor;
    onChange(result.value); onFormulaDraftChange('');
    setEditing(false); setOpen(false); setShowSource(false); setError('');
  };
  const parts = answerPreviewParts(value);
  const hasFormula = parts.some(part => part.kind === 'formula');
  return <div className="quick-check-math-answer">
    {showSource || !hasFormula ? <><label className="quick-check-sr-only" htmlFor={id}>你的回答</label>
    <textarea ref={textarea} id={id} value={value} rows={5} maxLength={maxLength} disabled={disabled} placeholder={placeholder}
      onSelect={rememberSelection} onKeyUp={rememberSelection} onClick={rememberSelection}
      onChange={event => { selection.current = { start: event.target.selectionStart, end: event.target.selectionEnd }; onChange(event.target.value); }} /></>
      : <div ref={renderedAnswer} className="quick-check-rendered-answer" role="region" aria-label="你的回答（公式已渲染）" tabIndex={0}>
        {parts.map((part, index) => part.kind === 'text' ? <span key={index}>{part.value}</span>
          : <FormulaBlock key={index} latex={part.value} displayMode={part.display} />)}
      </div>}
    <div className="quick-check-math-tools"><button type="button" disabled={disabled} aria-expanded={open} aria-controls={`${id}-formula-panel`}
      onClick={() => { finishing.current = false; rememberSelection(); setOpen(true); setEditing(true); setError(''); }}>
      <span aria-hidden="true">𝑓𝑥</span>{formulaDraft.trim() ? '继续编辑公式草稿' : '插入公式'}</button>
      {hasFormula && <button type="button" disabled={disabled} onClick={() => {
        if (showSource) rememberSelection();
        pendingCursor.current = selection.current.end;
        setShowSource(!showSource);
      }}>{showSource ? '完成编辑' : '编辑回答'}</button>}
      <small>{formulaDraft.trim() ? '公式草稿已保留，插入或取消后可继续答题。' : '支持文字与公式混写'}</small></div>
    {open && !disabled && <div ref={panel} className="quick-check-formula-panel" id={`${id}-formula-panel`} role="dialog" aria-modal="true" aria-labelledby={`${id}-formula-title`} tabIndex={-1}>
      <div className="quick-check-formula-title"><strong id={`${id}-formula-title`}>编辑公式</strong>
        <button type="button" aria-label="收起公式编辑，保留草稿" onClick={() => { setEditing(false); setOpen(false); }}>收起</button></div>
      <p className="quick-check-math-note">使用公式键盘输入，完成后插入回答的光标位置；所选文字会被替换。</p>
      <div className="quick-check-mathfield">
        <MathField value={formulaDraft} editing={editing} keyboardContainer={keyboardContainer}
          onInputDraft={keepDraft} onDraftSave={keepDraft} onCancel={() => setEditing(false)}
          onRequestEdit={() => { finishing.current = false; setEditing(true); }} placeholder="点击或按 Enter 输入公式…" />
      </div>
      <div ref={setKeyboardContainer} className="quick-check-math-keyboard" />
      <label className="quick-check-math-layout"><input type="checkbox" checked={display} onChange={event => setDisplay(event.target.checked)} />独立成行</label>
      {formulaDraft.trim() && !editing && <div className="quick-check-formula-preview"><FormulaBlock latex={formulaDraft} displayMode={display} /></div>}
      {error && <p className="quick-check-math-error" role="alert">{error}</p>}
      <div className="quick-check-formula-actions"><button type="button" onPointerDown={event => event.preventDefault()}
        onClick={() => { finishing.current = true; onFormulaDraftChange(''); setEditing(false); setOpen(false); setError(''); }}>取消公式</button>
        <button type="button" className="is-primary" disabled={!formulaDraft.trim()} onPointerDown={event => event.preventDefault()} onClick={insert}>插入回答</button></div>
    </div>}
  </div>;
}
