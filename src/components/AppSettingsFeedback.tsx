import React, { useEffect, useRef } from 'react';
import { AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import type { AppSettingsState } from './useAppSettings';

export type AppSettingsFeedbackState = Pick<AppSettingsState, 'loadState' | 'saveState' | 'loadError' | 'saveError'>;
export function AppSettingsFeedback({ state, onRetryLoad, onRetrySave, banner = false }: {
  state: AppSettingsFeedbackState; onRetryLoad?: () => void; onRetrySave?: () => void; banner?: boolean;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const retryOrigin = useRef<Element | null>(null);
  const recovering = useRef(false);
  const failed = state.loadState === 'error' || state.saveState === 'error';
  if (failed) recovering.current = true;
  const loading = state.loadState === 'loading', saving = state.saveState === 'saving';
  if (!failed && !loading && !saving) recovering.current = false;
  useEffect(() => {
    if (failed && retryOrigin.current && (document.activeElement === document.body || document.activeElement === retryOrigin.current)) {
      buttonRef.current?.focus({ preventScroll: true });
    }
  }, [failed]);
  if (banner ? !failed && !recovering.current : state.loadState === 'ready' && state.saveState === 'idle') return null;
  const text = state.loadState === 'error' ? `应用设置读取失败：${state.loadError}。当前仅显示缓存设置，重新读取成功后才能调整。`
    : state.saveState === 'error' ? `应用设置未保存：${state.saveError}。本次调整仍在当前窗口生效，请重试后再关闭。`
    : loading ? '正在读取应用设置…' : saving ? '正在保存外观与收录设置…' : '外观与收录设置已保存到本机';
  const retry = state.loadState === 'error' ? onRetryLoad : onRetrySave;
  return <div role={failed ? 'alert' : 'status'} aria-atomic="true"
    className={`app-settings-feedback ${banner ? 'is-banner' : ''} ${failed ? 'is-error' : ''}`}>
    {failed ? <AlertTriangle size={18} aria-hidden="true" /> : loading || saving ? <Loader2 size={18} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <CheckCircle2 size={18} aria-hidden="true" />}
    <span>{text}</span>
    {failed && retry && <button ref={buttonRef} type="button" onClick={() => { retryOrigin.current = document.activeElement; retry(); }}>
      {state.loadState === 'error' ? '重新读取应用设置' : '重试保存应用设置'}
    </button>}
  </div>;
}
