import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Mic, X } from 'lucide-react';
import { usePressToTalkDemo } from './usePressToTalkDemo';

type Props = {
  text: string;
  sourceTitle: string;
  error: string;
  anchor: HTMLElement | null;
  onChange: (text: string) => void;
  onSave: () => boolean;
  onClose: () => void;
};

/** Gesture prototype only: hold-to-talk has its own lifecycle. Native audio
 * permission/recording/transcription is deliberately not simulated as real data. */
export function RestatementBubble({ text, sourceTitle, error, anchor, onChange, onSave, onClose }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [closing, setClosing] = useState(false);
  const voice = usePressToTalkDemo({ onPressStart: () => inputRef.current?.blur() });

  useLayoutEffect(() => {
    const dialog = dialogRef.current!;
    const previousFocus = document.activeElement as HTMLElement | null;
    dialog.showModal();
    function fitToVisibleScreen() {
      const viewport = window.visualViewport;
      const top = viewport?.offsetTop || 0;
      const height = viewport?.height || innerHeight;
      const device = anchor?.getBoundingClientRect();
      const minTop = Math.max(top + 12, device ? device.top + 50 : top + 12);
      const bottom = Math.min(top + height - 18, device ? device.bottom - 82 : top + height - 18);
      dialog.style.maxHeight = `${Math.max(140, bottom - minTop)}px`;
      dialog.style.left = `${device ? device.left + device.width / 2 : innerWidth / 2}px`;
      dialog.style.top = `${Math.max(minTop, bottom - dialog.offsetHeight)}px`;
    }
    fitToVisibleScreen();
    window.visualViewport?.addEventListener('resize', fitToVisibleScreen);
    window.visualViewport?.addEventListener('scroll', fitToVisibleScreen);
    window.addEventListener('resize', fitToVisibleScreen);
    const observer = new ResizeObserver(fitToVisibleScreen);
    observer.observe(dialog);
    return () => {
      observer.disconnect();
      window.visualViewport?.removeEventListener('resize', fitToVisibleScreen);
      window.visualViewport?.removeEventListener('scroll', fitToVisibleScreen);
      window.removeEventListener('resize', fitToVisibleScreen);
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, [anchor]);
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  function close() {
    if (closing) return;
    voice.cancel();
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) { onClose(); return; }
    setClosing(true);
    closeTimer.current = setTimeout(onClose, 150);
  }
  return <dialog ref={dialogRef} className="mp-restatement" data-closing={closing || undefined}
    aria-label="复述气泡" onCancel={e => { e.preventDefault(); close(); }}
    onClick={e => { if (e.target === e.currentTarget) {
      const box = e.currentTarget.getBoundingClientRect();
      if (e.clientX < box.left || e.clientX > box.right || e.clientY < box.top || e.clientY > box.bottom) close();
    } }}>
    <div className="mp-restatement-head"><span className="mp-voice-preview-tag">语音演示 · 未录音</span><button autoFocus className="mp-icon" aria-label="收起复述气泡" onClick={close}><X size={19} /></button></div>
    <form className="mp-restatement-body" onSubmit={e => { e.preventDefault(); if (!closing && !voice.active && text.trim() && onSave()) close(); }}>
      <span className="mp-visually-hidden" id="restatement-source">{sourceTitle}</span>
      <label className="mp-visually-hidden" htmlFor="restatement-text">用自己的话说说</label>
      <textarea ref={inputRef} id="restatement-text" rows={4} maxLength={2000} inputMode="text" aria-describedby="restatement-source" readOnly={voice.active}
        placeholder="点这里打字" value={text} onChange={e => onChange(e.target.value)} />
      <div className="mp-hold-area" data-testid="voice-demo" data-phase={voice.phase}>
        {voice.active && <div className="mp-voice-feedback" aria-hidden="true"><span className="mp-voice-wave">{[0, 1, 2, 3, 4, 5, 6].map(n => <i key={n} style={{ '--bar': n } as React.CSSProperties} />)}</span><time>{String(Math.floor(voice.elapsedSeconds / 60)).padStart(2, '0')}:{String(voice.elapsedSeconds % 60).padStart(2, '0')}</time></div>}
        <button {...voice.buttonProps} type="button" className="mp-hold-voice" aria-label="按住说话" disabled={closing}><Mic size={18} /><span>{voice.phase === 'canceling' ? '松开取消' : voice.phase === 'recording' ? '松开结束' : '按住说话'}</span></button>
        <p className="mp-voice-state" role="status">{voice.phase === 'canceling' ? '松开取消' : voice.active ? '上滑取消' : voice.feedback}</p>
      </div>
      {error && <p className="mp-restatement-error" role="alert">{error}</p>}
      <button className="mp-primary mp-full" type="submit" aria-label="保存复述" disabled={closing || voice.active || !text.trim()}>保存</button>
    </form>
  </dialog>;
}
