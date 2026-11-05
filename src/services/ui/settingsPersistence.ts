export type SettingsPersistenceState = { saveState: 'idle' | 'saving' | 'saved' | 'error'; saveError: string; recovering: boolean };

/** Renderer-owned writes survive the settings panel. Only the latest acknowledgement clears recovery. */
export function createSettingsPersistence<T>(cache: (value: T) => void, save: (value: T) => Promise<void>) {
  let state: SettingsPersistenceState = { saveState: 'idle', saveError: '', recovering: false };
  let latest: T | null = null;
  let revision = 0;
  let queue: Promise<void> = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = (next: SettingsPersistenceState) => { state = next; listeners.forEach(listener => listener()); };
  const failure = () => ({ saveState: 'error' as const, saveError: '模型配置未能保存。本次输入仍保留在当前窗口，请重试后再关闭。', recovering: true });
  const write = (value: T): Promise<void> => {
    const snapshot = structuredClone(value), version = ++revision;
    latest = snapshot;
    // Protect same-frame refresh/close before cache or IPC callbacks run.
    publish({ saveState: 'saving', saveError: '', recovering: state.recovering });
    try { cache(structuredClone(snapshot)); } catch (cause) {
      publish(failure());
      return Promise.reject(new Error(state.saveError, { cause }));
    }
    const operation = queue.catch(() => {}).then(() => save(structuredClone(snapshot))).then(() => {
      if (version === revision) { latest = null; publish({ saveState: 'saved', saveError: '', recovering: false }); }
    }).catch(cause => {
      if (version === revision) publish(failure());
      throw new Error('模型配置保存失败，请重试。', { cause });
    });
    queue = operation;
    // The queue retains rejection for flush/callers, without an unhandled background rejection.
    void operation.catch(() => {});
    return operation;
  };
  return {
    write,
    retry: () => state.saveState === 'error' && latest !== null ? write(latest) : queue,
    flush: async () => {
      let observed: Promise<void>;
      do { observed = queue; await observed.catch(() => {}); } while (observed !== queue);
      if (state.saveState === 'error') throw new Error(state.saveError);
    },
    getDraft: () => latest === null ? null : structuredClone(latest),
    hasUnsavedChanges: () => state.saveState === 'saving' || state.saveState === 'error',
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
}
