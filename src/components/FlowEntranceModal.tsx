import React, { useState } from 'react';
import { NoteItem } from '../types';
import { Brain, Clock, Sparkles } from 'lucide-react';

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
  const [intervalMinutes, setIntervalMinutes] = useState(defaultInterval);
  if (!isOpen) return null;

  return (
    <div className="flow-entrance-backdrop" onClick={onClose}>
      <div className="flow-entrance-card" onClick={e => e.stopPropagation()}>
        <div className="flow-entrance-illustration">
          <Brain className="w-8 h-8" />
        </div>
        <div className="flow-entrance-title">
          准备进入心流？
        </div>
        <div className="flow-entrance-message">
          <p className="font-semibold mb-1">费曼学习法 · 联觉效应</p>
          <p>我会引导你<strong>复述与解释</strong>，把知识真正变成自己的理解。</p>
        </div>
        <div className="flow-entrance-interval">
          <label><Clock className="w-3.5 h-3.5 inline mr-1" />复盘提醒间隔</label>
          <input type="range" min={5} max={60} step={5} value={intervalMinutes} onChange={e => setIntervalMinutes(Number(e.target.value))} />
          <div className="flow-entrance-interval-value">每 {intervalMinutes} 分钟提醒一次</div>
        </div>
        <div className="flow-entrance-actions">
          <button className="flow-entrance-cancel" onClick={onClose}>先等等</button>
          <button className="flow-entrance-confirm" onClick={() => onConfirm(note.id, intervalMinutes)}>
            <Sparkles className="w-4 h-4" /> 出发，开始学习
          </button>
        </div>
      </div>
    </div>
  );
};