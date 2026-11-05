interface ResourceSessionStorage {
  clearStorageData(): Promise<void>;
  clearCache(): Promise<void>;
}

/** Closing a workbench is synchronous, but Chromium storage cleanup is not.
 * Keep its completion after the workbench leaves the active-session map so an
 * application quit can join it, including repeated disposal requests. */
export function createResourceSessionCleanup(warn: (message: string, error: unknown) => void = console.warn) {
  const scheduled = new WeakMap<ResourceSessionStorage, Promise<void>>();
  const pending = new Set<Promise<void>>();
  return {
    schedule(session: ResourceSessionStorage, closed: Promise<void> = Promise.resolve()): Promise<void> {
      const previous = scheduled.get(session);
      if (previous) return previous;
      const operation = (async () => {
        await closed;
        for (const [name, clear] of [
          ['storage', () => session.clearStorageData()],
          ['cache', () => session.clearCache()],
        ] as const) {
          try { await clear(); }
          catch (error) { warn(`[resource-browser] temporary ${name} cleanup failed:`, error); }
        }
      })();
      scheduled.set(session, operation); pending.add(operation);
      void operation.finally(() => pending.delete(operation)).catch(() => {});
      return operation;
    },
    async drain(): Promise<void> {
      // A closed-window callback may add another cleanup while the first waits.
      while (pending.size) await Promise.all([...pending]);
    },
  };
}
