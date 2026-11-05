import { useEffect, useRef, useState, useSyncExternalStore } from 'react';

export type VaultStartupState = { status: 'loading' | 'ready' | 'error'; error: string };

/** Failed reads never unlock an empty, writable workspace. */
export function createVaultStartup<T>(read: () => Promise<T>, onLoaded: (value: T) => void) {
  let state: VaultStartupState = { status: 'loading', error: '' };
  let generation = 0;
  let pending: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const update = (next: VaultStartupState) => { state = next; listeners.forEach(listener => listener()); };
  const retry = (): Promise<void> => {
    if (pending) return pending;
    if (state.status === 'ready') return Promise.resolve();
    const request = ++generation;
    pending = Promise.resolve().then(read).then(value => {
      if (request !== generation) return;
      onLoaded(value);
      update({ status: 'ready', error: '' });
    }).catch(error => {
      if (request !== generation) return;
      update({ status: 'error', error: error instanceof Error ? error.message : '读取失败，请稍后重试。' });
    }).finally(() => { if (request === generation) pending = null; });
    update({ status: 'loading', error: '' });
    return pending;
  };
  return {
    retry,
    cancel: () => { generation++; pending = null; },
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export function useVaultStartup<T>(read: () => Promise<T>, onLoaded: (value: T) => void) {
  const callbacks = useRef({ read, onLoaded });
  callbacks.current = { read, onLoaded };
  const [controller] = useState(() => createVaultStartup(
    () => callbacks.current.read(), value => callbacks.current.onLoaded(value),
  ));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { void controller.retry(); return controller.cancel; }, [controller]);
  return { ...state, retry: controller.retry };
}
