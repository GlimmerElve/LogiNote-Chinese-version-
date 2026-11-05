import React, { useEffect, useId, useRef, useState } from 'react';
import { NoteItem } from '../types';
import { Brain, Clock, Sparkles } from 'lucide-react';
import { useDialog } from './useDialog';

interface FlowEntranceModalProps {
  isOpen: boolean;
  note: NoteItem;
  defaultInterval: number;
  onClose: () => void;
  onConfirm: (noteId: string, reviewIntervalMinutes: number) => void;
}

export const FlowEntranceModal: React.FC<FlowEntranceModalProps> = ({
  isOpen, note, defaultInterval, onClose, onConfirm,
}) => {
  const [intervalMinutes, setIntervalMinutes] = useState(() => Number.isFinite(defaultInterval)
    ? Math.max(5, Math.min(60, Math.round(defaultInterval / 5) * 5)) : 20);
  const cardRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const intervalId = useId();
  const intervalValueId = useId();
  useDialog(isOpen, cardRef, onClose, 70);
  useEffect(() => {
    if (!isOpen) return;
    setIntervalMinutes(Number.isFinite(defaultInterval)
      ? Math.max(5, Math.min(60, Math.round(defaultInterval / 5) * 5)) : 20);
  }, [defaultInterval, isOpen, note.id]);
  if (!isOpen) return null;

  return (
    <div className="flow-entrance-backdrop" onClick={onClose}>
      <div ref={cardRef} className="flow-entrance-card" onClick={e => e.stopPropagation()}
        role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId} tabIndex={-1}
        style={{ maxHeight: 'calc(100dvh - 32px)', overflow: 'hidden', background: 'var(--ln-bg-surface)',
          color: 'var(--ln-text-primary)', borderColor: 'var(--ln-border)' }}>
        <div className="flow-entrance-body">
        <div className="flow-entrance-illustration">
          <Brain className="w-8 h-8" aria-hidden="true" />
        </div>
        <div className="flow-entrance-kicker">FOCUS SESSION</div>
        <div id={titleId} className="flow-entrance-title" style={{ color: 'var(--ln-text-primary)', fontSize: '1.25rem' }}>
          准备进入心流？
        </div>
        <div id={descriptionId} className="flow-entrance-message" style={{ background: 'var(--ln-bg-subtle)', color: 'var(--ln-text-secondary)', borderColor: 'var(--ln-border-subtle)', fontSize: '.8125rem' }}>
          <p className="font-semibold mb-1" style={{ color: 'var(--ln-text-primary)', fontSize: '.875rem', whiteSpace: 'normal', overflowWrap: 'anywhere' }}>{note.title || '未命名项目'}</p>
          <p>学习过程中会引导你<strong>复述与解释</strong>，并按设定间隔提醒进行复盘。</p>
          <p>教材安排交互探索时，每个讲解页可能额外调用一次所选模型生成交互图；失败不会阻断阅读。</p>
        </div>
        <div className="flow-entrance-interval">
          <label htmlFor={intervalId} style={{ color: 'var(--ln-text-secondary)', fontSize: '.8125rem' }}><Clock className="w-3.5 h-3.5 inline mr-1" aria-hidden="true" />复盘提醒间隔</label>
          <input id={intervalId} type="range" min={5} max={60} step={5} value={intervalMinutes}
            aria-describedby={intervalValueId} aria-valuetext={`每 ${intervalMinutes} 分钟提醒一次`}
            className="focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
            style={{ minHeight: 44, accentColor: 'var(--ln-accent)', outlineColor: 'var(--ln-accent)' }} onChange={e => setIntervalMinutes(Number(e.target.value))} />
          <div id={intervalValueId} className="flow-entrance-interval-value" style={{ color: 'var(--ln-accent)', fontSize: '.8125rem' }}>每 {intervalMinutes} 分钟提醒一次</div>
        </div>
        </div>
        <div className="flow-entrance-actions">
          <button type="button" className="flow-entrance-cancel focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ minHeight: 44, minWidth: 44, fontSize: '.8125rem', background: 'var(--ln-bg-surface)', color: 'var(--ln-text-secondary)', borderColor: 'var(--ln-border)', outlineColor: 'var(--ln-accent)' }} onClick={onClose}>先等等</button>
          <button type="button" className="flow-entrance-confirm focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2" style={{ minHeight: 44, minWidth: 44, fontSize: '.8125rem', outlineColor: 'var(--ln-accent)' }} onClick={() => onConfirm(note.id, intervalMinutes)}>
            <Sparkles className="w-4 h-4" aria-hidden="true" /> 出发，开始学习
          </button>
        </div>
      </div>
    </div>
  );
};
