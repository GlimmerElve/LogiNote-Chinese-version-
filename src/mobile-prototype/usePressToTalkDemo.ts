import { useCallback, useEffect, useRef, useState } from 'react';
import type { ButtonHTMLAttributes, KeyboardEvent, PointerEvent } from 'react';

export type PressToTalkPhase = 'idle' | 'pressing' | 'recording' | 'canceling';
type StopReason = 'released' | 'cancel' | 'interrupted' | 'limit';
type HoldKey = 'Space' | 'Enter';
type Session = {
  source: 'pointer' | 'keyboard';
  element: HTMLButtonElement;
  pointerId?: number;
  key?: HoldKey;
  startY: number;
  recording: boolean;
  canceling: boolean;
  startedAt: number;
  holdTimer?: ReturnType<typeof setTimeout>;
  durationTimer?: ReturnType<typeof setInterval>;
  limitTimer?: ReturnType<typeof setTimeout>;
};

const HOLD_DELAY_MS = 280;
const CANCEL_DISTANCE_PX = 64;
const LIMIT_MS = 60_000;

function holdKey(event: KeyboardEvent<HTMLButtonElement>): HoldKey | undefined {
  if (event.code === 'Space' || event.key === ' ' || event.key === 'Spacebar') return 'Space';
  if (event.key === 'Enter') return 'Enter';
  return undefined;
}

/** Gesture-only prototype: no audio, permission, speech or transcript APIs. */
export function usePressToTalkDemo(options?: { onPressStart?: () => void }): {
  phase: PressToTalkPhase;
  elapsedSeconds: number;
  feedback: string;
  active: boolean;
  buttonProps: ButtonHTMLAttributes<HTMLButtonElement>;
  cancel: () => void;
} {
  const [phase, setPhase] = useState<PressToTalkPhase>('idle');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [feedback, setFeedback] = useState('');
  const sessionRef = useRef<Session | null>(null);
  const suppressClickUntilRef = useRef(0);
  const onPressStartRef = useRef(options?.onPressStart);
  onPressStartRef.current = options?.onPressStart;

  const stop = useCallback((reason: StopReason, update = true) => {
    const session = sessionRef.current;
    if (!session) return;
    // Release may synchronously dispatch lostpointercapture. Dispose first.
    sessionRef.current = null;
    suppressClickUntilRef.current = performance.now() + 500;
    clearTimeout(session.holdTimer);
    clearInterval(session.durationTimer);
    clearTimeout(session.limitTimer);
    if (session.pointerId !== undefined) {
      try {
        if (session.element.hasPointerCapture(session.pointerId)) session.element.releasePointerCapture(session.pointerId);
      } catch { /* The browser may already have revoked capture. */ }
    }
    if (!update) return;
    setPhase('idle');
    if (reason === 'limit') setElapsedSeconds(LIMIT_MS / 1000);
    else if (!session.recording || session.canceling || reason !== 'released') setElapsedSeconds(0);
    else setElapsedSeconds(Math.min(LIMIT_MS / 1000, Math.floor((performance.now() - session.startedAt) / 1000)));
    setFeedback(reason === 'limit' ? '已到时长上限'
      : reason === 'interrupted' ? '已中断'
      : reason === 'cancel' || session.canceling ? '已取消'
      : session.recording ? '语音演示已结束' : '请按住说话');
  }, []);

  const begin = useCallback((session: Session) => {
    if (sessionRef.current) return;
    sessionRef.current = session;
    setElapsedSeconds(0);
    setPhase('pressing');
    setFeedback('按住说话');
    if (session.pointerId !== undefined) {
      try { session.element.setPointerCapture(session.pointerId); }
      catch { /* Window release handlers remain available as a fallback. */ }
    }
    onPressStartRef.current?.();
    if (sessionRef.current !== session) return;
    session.holdTimer = setTimeout(() => {
      if (sessionRef.current !== session) return;
      session.recording = true;
      session.startedAt = performance.now();
      setPhase(session.canceling ? 'canceling' : 'recording');
      setFeedback(session.canceling ? '松开取消' : session.source === 'keyboard' ? '松开结束，Esc 取消' : '松开结束，上滑取消');
      session.durationTimer = setInterval(() => {
        if (sessionRef.current === session) setElapsedSeconds(Math.min(60, Math.floor((performance.now() - session.startedAt) / 1000)));
      }, 250);
      session.limitTimer = setTimeout(() => { if (sessionRef.current === session) stop('limit'); }, LIMIT_MS);
    }, HOLD_DELAY_MS);
  }, [stop]);

  const movePointer = useCallback((pointerId: number, clientY: number) => {
    const session = sessionRef.current;
    if (!session || session.source !== 'pointer' || session.pointerId !== pointerId) return;
    const canceling = session.startY - clientY >= CANCEL_DISTANCE_PX;
    if (session.canceling === canceling) return;
    session.canceling = canceling;
    setPhase(session.recording ? canceling ? 'canceling' : 'recording' : 'pressing');
    setFeedback(canceling ? '松开取消' : session.recording ? '松开结束，上滑取消' : '按住说话');
  }, []);

  useEffect(() => {
    const interrupt = () => stop('interrupted');
    const visibility = () => { if (document.visibilityState === 'hidden') interrupt(); };
    const pointerUp = (event: globalThis.PointerEvent) => {
      const session = sessionRef.current;
      if (session?.source === 'pointer' && session.pointerId === event.pointerId) {
        movePointer(event.pointerId, event.clientY);
        stop('released');
      }
    };
    const pointerCancel = (event: globalThis.PointerEvent) => {
      const session = sessionRef.current;
      if (session?.source === 'pointer' && session.pointerId === event.pointerId) interrupt();
    };
    window.addEventListener('blur', interrupt);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pointerup', pointerUp);
    window.addEventListener('pointercancel', pointerCancel);
    return () => {
      window.removeEventListener('blur', interrupt);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pointerup', pointerUp);
      window.removeEventListener('pointercancel', pointerCancel);
      stop('interrupted', false);
    };
  }, [movePointer, stop]);

  const buttonProps: ButtonHTMLAttributes<HTMLButtonElement> = {
    type: 'button',
    'aria-label': '按住说话，松开结束，上滑取消',
    'aria-pressed': phase === 'recording' || phase === 'canceling',
    style: { touchAction: 'none', userSelect: 'none', WebkitUserSelect: 'none' },
    onContextMenu: event => event.preventDefault(),
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      if (!event.isPrimary || event.button !== 0 || sessionRef.current) return;
      event.preventDefault();
      begin({ source: 'pointer', element: event.currentTarget, pointerId: event.pointerId, startY: event.clientY, recording: false, canceling: false, startedAt: 0 });
    },
    onPointerMove: event => movePointer(event.pointerId, event.clientY),
    onPointerUp: event => {
      const session = sessionRef.current;
      if (session?.source !== 'pointer' || session.pointerId !== event.pointerId) return;
      event.preventDefault();
      movePointer(event.pointerId, event.clientY);
      stop('released');
    },
    onPointerCancel: event => {
      if (sessionRef.current?.pointerId === event.pointerId) stop('interrupted');
    },
    onLostPointerCapture: event => {
      if (sessionRef.current?.pointerId === event.pointerId) stop('interrupted');
    },
    onKeyDown: event => {
      if (event.key === 'Escape' && sessionRef.current) {
        event.preventDefault();
        event.stopPropagation();
        stop('cancel');
        return;
      }
      const key = holdKey(event);
      if (!key) return;
      event.preventDefault();
      if (event.repeat || sessionRef.current) return;
      begin({ source: 'keyboard', element: event.currentTarget, key, startY: 0, recording: false, canceling: false, startedAt: 0 });
    },
    onKeyUp: event => {
      const key = holdKey(event), session = sessionRef.current;
      if (!key) return;
      event.preventDefault();
      if (session?.source === 'keyboard' && session.key === key) stop('released');
    },
    onBlur: () => { if (sessionRef.current?.source === 'keyboard') stop('interrupted'); },
    onClick: event => { if (event.detail === 0 && !sessionRef.current && performance.now() >= suppressClickUntilRef.current) setFeedback('请按住说话'); },
  };

  const cancel = useCallback(() => stop('cancel'), [stop]);
  return { phase, elapsedSeconds, feedback, active: phase !== 'idle', buttonProps, cancel };
}
