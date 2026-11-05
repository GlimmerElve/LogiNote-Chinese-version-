type Job = { cancelled: boolean; run(): void };
export interface ReadingPresentation {
  enqueue(run: () => void): () => void;
  interact(): void;
  resume(): void;
  dispose(): void;
}
/** IO/worker completion is independent of presentation. Do not replace loading
 * slots while the user is scrolling; publish one prepared item per idle frame. */
export function createReadingPresentation(environment: {
  requestFrame: (run: () => void) => number;
  cancelFrame: (id: number) => void;
  setTimer: (run: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (id: ReturnType<typeof setTimeout>) => void;
}, quietMs = 140): ReadingPresentation {
  let moving = false, disposed = false, frame: number | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const jobs: Job[] = [];
  const pump = () => {
    if (disposed || moving || frame !== undefined) return;
    while (jobs[0]?.cancelled) jobs.shift();
    if (!jobs.length) return;
    frame = environment.requestFrame(() => {
      frame = undefined;
      if (disposed || moving) return;
      const job = jobs.shift(); if (job && !job.cancelled) job.run();
      pump();
    });
  };
  return {
    enqueue(run) { const job = { cancelled: false, run }; jobs.push(job); pump(); return () => { job.cancelled = true; }; },
    interact() {
      if (disposed) return;
      moving = true;
      if (frame !== undefined) { environment.cancelFrame(frame); frame = undefined; }
      if (timer !== undefined) environment.clearTimer(timer);
      timer = environment.setTimer(() => { timer = undefined; moving = false; pump(); }, quietMs);
    },
    resume() { disposed = false; moving = false; pump(); },
    dispose() {
      disposed = true; jobs.length = 0;
      if (frame !== undefined) environment.cancelFrame(frame);
      if (timer !== undefined) environment.clearTimer(timer);
      frame = undefined; timer = undefined;
    },
  };
}
