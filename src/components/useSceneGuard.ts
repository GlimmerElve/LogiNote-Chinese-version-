import { useCallback, useEffect, useRef, useState } from 'react';
export type SceneSessionStatus = 'idle' | 'running' | 'finished';
export const sceneAllowsNavigation = (status: SceneSessionStatus) => status === 'idle';
export const sceneAllowsExit = (status: SceneSessionStatus) => status !== 'running';

/** A finished run stays mounted until the user explicitly chooses Exit. */
export function useSceneGuard() {
  const statusRef = useRef<SceneSessionStatus>('idle');
  const [status, setStatus] = useState<SceneSessionStatus>('idle');
  const [notice, setNotice] = useState('');
  const updateStatus = useCallback((value: SceneSessionStatus) => { statusRef.current = value; setStatus(value); setNotice(''); }, []);
  const notifyBlocked = useCallback(() => setNotice(statusRef.current === 'running'
    ? '请先完成场景，再点击“退出场景”。引用资料可在场景内查看。'
    : '场景已结束，请点击“退出场景”后再切换页面。'), []);
  const allowNavigation = useCallback(() => {
    if (sceneAllowsNavigation(statusRef.current)) return true;
    notifyBlocked(); return false;
  }, [notifyBlocked]);
  const exit = useCallback(() => {
    if (!sceneAllowsExit(statusRef.current)) { notifyBlocked(); return false; }
    updateStatus('idle'); return true;
  }, [notifyBlocked, updateStatus]);
  useEffect(() => {
    if (status === 'idle') return;
    const token = crypto.randomUUID();
    const marker = 'loginoteSceneLock';
    window.history.pushState({ ...window.history.state, [marker]: token }, '');
    const handlePop = () => { if (!sceneAllowsNavigation(statusRef.current) && window.history.state?.[marker] !== token) { window.history.forward(); notifyBlocked(); } };
    const handleUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    const handleKey = (event: KeyboardEvent) => {
      if ((event.altKey && ['ArrowLeft', 'ArrowRight'].includes(event.key))
        || ((event.ctrlKey || event.metaKey) && ['k', 'j'].includes(event.key.toLowerCase()))) {
        event.preventDefault(); event.stopImmediatePropagation(); notifyBlocked();
      }
    };
    const handleLink = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (!link) return;
      const href = link.getAttribute('href');
      if (href?.startsWith('#')) return;
      event.preventDefault(); event.stopImmediatePropagation(); notifyBlocked();
    };
    window.addEventListener('popstate', handlePop);
    window.addEventListener('beforeunload', handleUnload);
    document.addEventListener('keydown', handleKey, true);
    document.addEventListener('click', handleLink, true);
    document.addEventListener('auxclick', handleLink, true);
    document.addEventListener('contextmenu', handleLink, true);
    return () => {
      window.removeEventListener('popstate', handlePop);
      window.removeEventListener('beforeunload', handleUnload);
      document.removeEventListener('keydown', handleKey, true);
      document.removeEventListener('click', handleLink, true);
      document.removeEventListener('auxclick', handleLink, true);
      document.removeEventListener('contextmenu', handleLink, true);
      if (window.history.state?.[marker] === token) {
        const { [marker]: ignored, ...rest } = window.history.state;
        void ignored; window.history.replaceState(rest, '');
      }
    };
    // Only one sentinel for the whole run, including its result page and reruns.
  }, [status !== 'idle', notifyBlocked]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 4500); return () => clearTimeout(timer); }, [notice]);
  return { status, locked: status !== 'idle', updateStatus, allowNavigation, exit, notice };
}
