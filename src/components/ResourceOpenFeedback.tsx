import React from 'react';
import { AlertTriangle, ExternalLink, RefreshCw } from 'lucide-react';
import type { ResourceItem } from '../types';
import type { ResourceOpenFeedback as Feedback } from './useResourceOpen';
import './ResourceOpenFeedback.css';

export function ResourceOpenFeedback({ feedback, onRetry, disabled = false }: { feedback: Feedback | null; onRetry: (resource: ResourceItem) => void; disabled?: boolean }) {
  if (!feedback) return null;
  const failed = feedback.kind === 'error';
  return <div className={`resource-open-feedback ${failed ? 'is-error' : ''}`} role={failed ? 'alert' : 'status'}>
    {failed ? <AlertTriangle aria-hidden="true" /> : <ExternalLink aria-hidden="true" />}
    <div><strong>{feedback.resource.title || '学习资料'}</strong><p>{failed
      ? '未能打开，当前学习内容已保留。请检查资料是否可用或浏览器是否阻止弹窗，然后重试。'
      : feedback.kind === 'opening' ? '正在打开资料…' : '已交给资料阅读器或浏览器打开。'}</p></div>
    {failed && <button type="button" disabled={disabled} onClick={() => { if (!disabled) onRetry(feedback.resource); }}><RefreshCw aria-hidden="true" />重试打开</button>}
  </div>;
}
