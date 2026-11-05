import React, { useId, useLayoutEffect, useRef } from 'react';
import { Check, Loader2, Brain, AlertCircle } from 'lucide-react';
import { useDialog } from './useDialog';
import './LearningAnalysisDialogs.css';

export type AnalysisPhase = 'mastery' | 'evidence' | 'summary';
const STEPS = ['识别知识点', '掌握度评分', '五路画像证据', '综合分析总结'];
const PHASE_INDEX: Record<AnalysisPhase, number> = { mastery: 1, evidence: 2, summary: 3 };
const DESCRIPTIONS: Record<AnalysisPhase, string> = {
  mastery: '正在分析本次学习中各知识点的掌握情况。',
  evidence: '正在整理本次学习的画像证据。',
  summary: '正在生成本次复盘的综合建议。',
};

interface AnalysisProgressModalProps {
  phase: AnalysisPhase;
  offline: boolean;
  error?: string;
  onClose?: () => void;
}

export const AnalysisProgressModal: React.FC<AnalysisProgressModalProps> = ({ phase, offline, error, onClose }) => {
  const titleId = useId(), descriptionId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const failed = offline || Boolean(error);
  useDialog(true, dialogRef, failed ? onClose : undefined, 400);
  useLayoutEffect(() => {
    if (failed && (document.activeElement === document.body || document.activeElement === dialogRef.current)) closeRef.current?.focus();
  }, [failed]);
  const phaseIndex = PHASE_INDEX[phase];
  return <div className="learning-analysis-overlay is-progress">
    <section className="learning-analysis-dialog learning-analysis-progress" ref={dialogRef} tabIndex={-1}
      role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}>
      <header><div className={`learning-analysis-emblem${failed ? ' is-error' : ''}`}>{failed ? <AlertCircle aria-hidden="true" /> : <Brain aria-hidden="true" />}</div>
        <div><span className="learning-analysis-eyebrow">LEARNING REVIEW</span><h2 id={titleId}>{failed ? '本次分析未完成' : '正在分析复盘'}</h2>
          <p id={descriptionId} role={failed ? 'alert' : 'status'}>{failed
            ? error || 'AI 服务暂不可用。学习内容已保存，请检查模型配置或网络连接。'
            : DESCRIPTIONS[phase]}</p></div></header>
      <ol className="learning-analysis-steps">
        {STEPS.map((label, index) => {
          const state = index < phaseIndex ? 'done' : index === phaseIndex ? (failed ? 'failed' : 'active') : 'pending';
          return <li key={label} className={`is-${state}`} aria-current={state === 'active' || state === 'failed' ? 'step' : undefined}>
            <span aria-hidden="true">{state === 'done' ? <Check /> : state === 'active' ? <Loader2 className="is-spinning" /> : state === 'failed' ? <AlertCircle /> : index + 1}</span>
            <strong>{label}</strong><small>{state === 'done' ? '已完成' : state === 'active' ? '进行中' : state === 'failed' ? '未完成' : '待处理'}</small>
          </li>;
        })}
      </ol>
      <footer>{failed && onClose ? <button type="button" className="is-primary" ref={closeRef} onClick={onClose}>返回笔记</button>
        : <p>请等待本次分析结束，暂不切换工作区。</p>}</footer>
    </section>
  </div>;
};
