/** One live read per dialog. Notifications request one follow-up, never invalidate
 * an otherwise valid slow response or create a queue of polling requests. */
export function createProgressiveReviewRefreshQueue(read: () => Promise<void>) {
  let running: Promise<void> | null = null;
  let requested = false;
  let stopped = false;
  return {
    refresh(): Promise<void> {
      if (stopped) return Promise.resolve();
      requested = true;
      if (running) return running;
      const work = (async () => {
        while (requested && !stopped) {
          requested = false;
          await read();
        }
      })();
      const pending = work.finally(() => { if (running === pending) running = null; });
      running = pending;
      return pending;
    },
    stop() { stopped = true; requested = false; },
  };
}
