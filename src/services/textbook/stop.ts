export interface TextbookStopRequest { jobId: string; token: string }
export interface TextbookStopReply { jobId: string; status: 'stopping' | 'not-running' }

/** Stop events are host-issued and bound to the exact execution lease, not a chat. */
export function createTextbookRunStop(jobId: string, external: AbortSignal | undefined,
  subscribe: (listener: (request: TextbookStopRequest) => void) => () => void) {
  const controller = new AbortController();
  const forward = () => controller.abort(external?.reason);
  if (external?.aborted) forward(); else external?.addEventListener('abort', forward, { once: true });
  let token: string | undefined;
  const early = new Set<string>();
  const unsubscribe = subscribe(request => {
    if (request.jobId !== jobId || typeof request.token !== 'string') return;
    if (token === request.token) controller.abort(new DOMException('用户请求停止教材任务，已保存成果保留', 'AbortError'));
    else if (!token && early.size < 8) early.add(request.token);
  });
  return { signal: controller.signal,
    claim: (value: string) => {
      token = value;
      if (early.has(value)) controller.abort(new DOMException('用户请求停止教材任务，已保存成果保留', 'AbortError'));
      early.clear();
    },
    dispose: () => { external?.removeEventListener('abort', forward); unsubscribe(); early.clear(); },
  };
}
