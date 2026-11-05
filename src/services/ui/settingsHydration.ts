export type SettingsHydrationState = { status: 'idle' | 'loading' | 'ready' | 'error'; error: string };

/** One read owner per renderer. Explicit edits outrank an older startup response. */
export function createSettingsHydration<T>(read: () => Promise<T>, commit: (value: T) => void, current: () => T) {
  let state: SettingsHydrationState = { status: 'idle', error: '' };
  let revision = 0;
  let pending: Promise<T> | null = null;
  const listeners = new Set<() => void>();
  const publish = (next: SettingsHydrationState) => { state = next; listeners.forEach(listener => listener()); };
  const load = (retry = false): Promise<T> => {
    if (pending) return pending;
    if (state.status === 'ready') return Promise.resolve().then(current);
    if (state.status === 'error' && !retry) return Promise.reject(new Error(state.error));
    const startedAt = revision;
    pending = Promise.resolve().then(read).then(value => {
      if (revision === startedAt) {
        commit(value);
        publish({ status: 'ready', error: '' });
      }
      return current();
    }).catch(error => {
      if (revision !== startedAt && state.status === 'ready') return current();
      // Never surface malformed configuration bytes or credentials in feedback.
      publish({ status: 'error', error: '无法读取模型配置，请检查本地文件的权限和格式后重新读取。' });
      throw new Error(state.error, { cause: error });
    }).finally(() => { pending = null; });
    publish({ status: 'loading', error: '' });
    return pending;
  };
  return {
    load,
    edited: () => { revision++; if (state.status !== 'ready') publish({ status: 'ready', error: '' }); },
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
