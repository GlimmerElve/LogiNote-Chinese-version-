import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { VaultSettings } from '../types';

export type AppSettingsState = {
  settings: VaultSettings;
  loadState: 'loading' | 'ready' | 'error';
  saveState: 'idle' | 'saving' | 'saved' | 'error';
  loadError: string;
  saveError: string;
};

/** Loading is read-only. Only an explicit user change schedules persistence. */
export function createAppSettings(initial: VaultSettings, read: () => Promise<VaultSettings>, save: (settings: VaultSettings) => Promise<void>) {
  let state: AppSettingsState = { settings: initial, loadState: 'loading', saveState: 'idle', loadError: '', saveError: '' };
  let generation = 0, revision = 0;
  let reading: Promise<void> | null = null;
  let writes: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const updateState = (patch: Partial<AppSettingsState>) => { state = { ...state, ...patch }; listeners.forEach(listener => listener()); };
  const load = (): Promise<void> => {
    if (reading) return reading;
    if (state.loadState === 'ready') return Promise.resolve();
    const request = ++generation;
    reading = Promise.resolve().then(read).then(settings => {
      if (request === generation) updateState({ settings, loadState: 'ready', loadError: '' });
    }).catch(error => {
      if (request === generation) updateState({ loadState: 'error', loadError: error instanceof Error ? error.message : '设置读取失败' });
    }).finally(() => { if (request === generation) reading = null; });
    updateState({ loadState: 'loading', loadError: '' });
    return reading;
  };
  const persist = () => {
    const snapshot = state.settings, savedRevision = ++revision;
    updateState({ saveState: 'saving', saveError: '' });
    writes = writes.catch(() => {}).then(() => save(snapshot)).then(() => {
      if (revision === savedRevision) updateState({ saveState: 'saved', saveError: '' });
    }).catch(error => {
      if (revision === savedRevision) updateState({ saveState: 'error', saveError: error instanceof Error ? error.message : '设置保存失败' });
    });
    return writes;
  };
  return {
    load,
    update: (patch: Partial<VaultSettings>) => {
      if (state.loadState !== 'ready') return;
      if (Object.keys(patch).every(key => Object.is(state.settings[key as keyof VaultSettings], patch[key as keyof VaultSettings]))) return;
      updateState({ settings: { ...state.settings, ...patch } });
      void persist();
    },
    retrySave: () => state.loadState === 'ready' && state.saveState === 'error' ? persist() : writes,
    flush: async () => {
      // Re-check after each queue drain in case another edit joined the queue.
      let current: Promise<void>;
      do { current = writes; await current; } while (current !== writes);
      if (state.saveState === 'error') throw new Error(state.saveError);
    },
    hasUnsavedChanges: () => state.saveState === 'saving' || state.saveState === 'error',
    cancelRead: () => { generation++; reading = null; },
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}

export function useAppSettings(initial: VaultSettings, read: () => Promise<VaultSettings>, save: (settings: VaultSettings) => Promise<void>) {
  const callbacks = useRef({ read, save }); callbacks.current = { read, save };
  const [controller] = useState(() => createAppSettings(initial, () => callbacks.current.read(), settings => callbacks.current.save(settings)));
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  useEffect(() => { void controller.load(); return controller.cancelRead; }, [controller]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!controller.hasUnsavedChanges()) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [controller]);
  return { ...state, update: controller.update, retryLoad: controller.load, retrySave: controller.retrySave, flush: controller.flush, getSnapshot: controller.getSnapshot };
}
