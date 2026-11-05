import React, { useEffect, useRef } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import type { SettingsPersistenceState } from '../services/ui/settingsPersistence';
import './AppSettingsFeedback.css';

/** Ordinary saves remain quiet outside settings. An error keeps its retry visible until acknowledged. */
export function ModelSettingsFeedback({ state, onRetry }: { state: SettingsPersistenceState; onRetry: () => void }) {
  const button = useRef<HTMLButtonElement>(null), origin = useRef<Element | null>(null);
  const failed = state.saveState === 'error';
  useEffect(() => {
    if (failed && origin.current && (document.activeElement === document.body || document.activeElement === origin.current)) button.current?.focus({ preventScroll: true });
  }, [failed]);
  if (!failed && !state.recovering) return null;
  return <div role={failed ? 'alert' : 'status'} aria-atomic="true" className={`app-settings-feedback is-banner ${failed ? 'is-error' : ''}`}>
    {failed ? <AlertTriangle size={18} aria-hidden="true" /> : <Loader2 size={18} aria-hidden="true" className="animate-spin motion-reduce:animate-none" />}
    <span>{failed ? state.saveError : '正在重试保存模型配置…'}</span>
    {failed && <button ref={button} type="button" onClick={() => { origin.current = document.activeElement; onRetry(); }}>重试保存模型配置</button>}
  </div>;
}
