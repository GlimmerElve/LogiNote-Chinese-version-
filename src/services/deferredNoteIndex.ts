/** Runtime-neutral coalesced maintenance. The saved vault is the durable job source; startup
 * requests reconciliation again, so quitting never waits for a model/index job. */
export function createDeferredNoteIndex(options: {
  run: () => Promise<void>; onError: (error: unknown) => void; delayMs?: number;
  schedule?: (run: () => void, delay: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
}) {
  const schedule = options.schedule || setTimeout, cancel = options.cancel || clearTimeout;
  let timer: ReturnType<typeof setTimeout> | undefined, running = false, pending = false, stopped = false;
  let immediate = false;
  let revision = 0;
  const editors = new Set<number>();
  const arm = (delay: number) => {
    if (timer !== undefined) cancel(timer);
    timer = schedule(() => { timer = undefined; void drain(); }, delay) as ReturnType<typeof setTimeout>;
    (timer as unknown as { unref?: () => void }).unref?.();
  };
  const drain = async () => {
    if (stopped || running || editors.size || !pending) return;
    pending = false; running = true; immediate = false;
    const startedRevision = revision;
    let failed = false;
    try { await options.run(); }
    catch (error) { failed = true; pending = true; options.onError(error); }
    finally {
      running = false;
      if (!stopped && pending && !editors.size && (!failed || revision !== startedRevision)) arm(immediate ? 0 : options.delayMs ?? 30_000);
    }
  };
  return {
    request() { if (stopped) return; revision++; pending = true; if (!running && !editors.size) arm(options.delayMs ?? 30_000); },
    flush() { if (stopped) return; revision++; immediate = true; if (pending && !running && !editors.size) arm(0); },
    setEditing(owner: number, active: boolean) {
      if (stopped) return;
      if (active) { editors.add(owner); if (timer !== undefined) cancel(timer); timer = undefined; }
      else { editors.delete(owner); if (!editors.size && pending && !running) arm(0); }
    },
    isPending: () => pending || running,
    stop() { stopped = true; if (timer !== undefined) cancel(timer); timer = undefined; },
  };
}
