import React, { useEffect, useRef } from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import { WindowControls } from './WindowControls';
import { LogiNoteLogoMark } from './LogiNoteLogo';
import type { VaultStartupState } from './useVaultStartup';

export function VaultStartupView({ status, error, onRetry }: VaultStartupState & { onRetry: () => void }) {
  const retryButton = useRef<HTMLButtonElement>(null);
  const retryOrigin = useRef<Element | null>(null);
  useEffect(() => {
    if (status === 'error' && (document.activeElement === document.body || document.activeElement === retryOrigin.current)) {
      retryButton.current?.focus({ preventScroll: true });
    }
  }, [status]);
  const failed = status === 'error';
  return <section className="vault-startup">
    <header className="vault-startup-header app-drag-region">
      <span><LogiNoteLogoMark className="vault-startup-logo" /> LogiNote</span>
      <WindowControls />
    </header>
    <main className="vault-startup-main">
      <div className="vault-startup-card">
        <div className="vault-startup-icon" aria-hidden="true">
          {failed ? <AlertTriangle size={28} /> : <Loader2 size={28} className="animate-spin motion-reduce:animate-none" />}
        </div>
        <div role={failed ? 'alert' : 'status'} aria-atomic="true">
          <h1>{failed ? '暂时无法读取笔记库' : '正在打开你的笔记'}</h1>
          <p>{failed ? '读取尚未成功，暂不开放编辑与新建操作。请重试；原笔记不会在此处被清空或替换。' : '正在读取本地笔记与学习状态，请稍候。'}</p>
        </div>
        {failed && <>
          <button ref={retryButton} type="button" onClick={() => { retryOrigin.current = document.activeElement; onRetry(); }}>
            <RefreshCw size={17} aria-hidden="true" />重新读取
          </button>
          <details><summary>查看错误详情</summary><pre>{error}</pre></details>
        </>}
      </div>
    </main>
  </section>;
}
