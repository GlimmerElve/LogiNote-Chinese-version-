/** Consume an already-read startup snapshot, never cache it as storage authority.
 * Yield one event-loop turn before doing derived work so IPC can return first. */
export function createStartupSnapshotTask<T>(options: {
  scope: () => string | undefined;
  run: (snapshot: T, isCurrent: () => boolean) => Promise<void>;
  onError: (error: unknown) => void;
  schedule?: (run: () => void) => void;
}) {
  let completedScope: string | undefined;
  const pending = new Set<string>();
  const schedule = options.schedule ?? (run => { setImmediate(run); });
  const report = (error: unknown) => {
    try { options.onError(error); } catch { /* Diagnostics cannot break vault loading. */ }
  };
  return {
    offer(scope: string, snapshot: T): void {
      if (scope !== options.scope() || completedScope === scope || pending.has(scope)) return;
      pending.add(scope);
      const isCurrent = () => options.scope() === scope;
      try {
        schedule(() => {
          void Promise.resolve().then(async () => {
            if (!isCurrent()) return;
            await options.run(snapshot, isCurrent);
            if (isCurrent()) completedScope = scope;
          }).catch(report).finally(() => { pending.delete(scope); });
        });
      } catch (error) {
        pending.delete(scope);
        report(error);
      }
    },
  };
}
