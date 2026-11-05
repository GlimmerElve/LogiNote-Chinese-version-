import type { ResourceItem, ResourceWorkbenchState } from '../../types';

export type WorkbenchAction = 'back' | 'forward' | 'reload' | 'home' | 'go' | 'open-candidate' | 'switch-tab' | 'search-variant';
export interface ResourceWorkbenchApi {
  navigate(request: { sessionId: string; action: WorkbenchAction; value?: string }): Promise<boolean>;
  setDecision(request: { sessionId: string; candidateId: string; decision: 'selected' | 'rejected' | null }): Promise<ResourceWorkbenchState>;
  setDownload(request: { sessionId: string; candidateId: string; enabled: boolean }): Promise<ResourceWorkbenchState>;
  scan(sessionId: string): Promise<unknown>;
  authorize(request: { sessionId: string; candidateId: string }): Promise<{ canceled?: boolean; resource?: ResourceItem }>;
  commit(sessionId: string): Promise<{ ok: boolean; pendingApply?: boolean; canceled?: boolean; error?: string }>;
  close(): void;
  onState(callback: (state: ResourceWorkbenchState) => void): () => void;
}

export type WorkbenchPending = 'navigate' | 'decision' | 'download' | 'scan' | 'authorize' | 'commit' | null;
export interface WorkbenchSnapshot {
  state: ResourceWorkbenchState | null;
  address: string;
  pending: WorkbenchPending;
  error: string;
  working: boolean;
}

/** One owner for IPC snapshots, local input and accepted operations. No storage or network here. */
export function createResourceWorkbenchController(api?: ResourceWorkbenchApi) {
  let snapshot: WorkbenchSnapshot = { state: null, address: '', pending: null, error: '', working: false };
  let active = false, generation = 0, sequence = 0, addressDirty = false;
  let operation: { generation: number; sessionId: string; sequence: number; awaitingApply: boolean } | null = null;
  let listener: ((value: WorkbenchSnapshot) => void) | null = null;
  const publish = (change: Partial<WorkbenchSnapshot>) => {
    snapshot = { ...snapshot, ...change };
    snapshot.working = Boolean(snapshot.pending || snapshot.state?.busy);
    if (active) listener?.(snapshot);
  };
  const receive = (next: ResourceWorkbenchState) => {
    if (!active) return;
    const previous = snapshot.state;
    const changedSession = previous?.sessionId !== next.sessionId;
    sequence += 1;
    if (changedSession) { generation += 1; operation = null; addressDirty = false; }
    // Authoritative state events win over an older IPC return value.
    const finishedApply = operation?.awaitingApply && !next.busy;
    if (finishedApply) operation = null;
    publish({ state: next,
      address: changedSession || !addressDirty ? next.currentUrl || next.query : snapshot.address,
      ...(changedSession ? { pending: null, error: '' } : finishedApply ? { pending: null } : {}),
    });
  };
  const owns = (job: NonNullable<typeof operation>) => active && operation === job
    && job.generation === generation && snapshot.state?.sessionId === job.sessionId;
  const begin = (pending: Exclude<WorkbenchPending, null>) => {
    if (!active || !api || !snapshot.state || operation || snapshot.working) return null;
    const job = { generation, sessionId: snapshot.state.sessionId, sequence, awaitingApply: false };
    operation = job;
    publish({ pending, error: '' });
    return job;
  };
  const finish = (job: NonNullable<typeof operation>) => {
    if (!owns(job)) return;
    operation = null; publish({ pending: null });
  };
  const fail = (job: NonNullable<typeof operation>, cause: unknown) => {
    if (owns(job)) publish({ error: cause instanceof Error ? cause.message : String(cause) });
  };
  const candidate = (resource: ResourceItem) => snapshot.state?.resources
    .find(item => item.candidateId === resource.candidateId && item.url === resource.url);
  const acceptReply = (job: NonNullable<typeof operation>, reply: ResourceWorkbenchState) => {
    if (owns(job) && sequence === job.sequence && reply.sessionId === job.sessionId) receive(reply);
  };

  return {
    getSnapshot: () => snapshot,
    connect(onChange: (value: WorkbenchSnapshot) => void) {
      active = true; listener = onChange; onChange(snapshot);
      const unsubscribe = api?.onState(receive);
      return () => {
        active = false; generation += 1; operation = null; listener = null; unsubscribe?.();
        snapshot = { ...snapshot, pending: null, working: Boolean(snapshot.state?.busy) };
      };
    },
    setAddress(value: string) { addressDirty = true; publish({ address: value }); },
    async navigate(action: WorkbenchAction, value?: string) {
      if (action === 'go' && !value?.trim()) return;
      const job = begin('navigate'); if (!job) return;
      try {
        const ok = await api!.navigate({ sessionId: job.sessionId, action, value });
        if (owns(job) && ok) { addressDirty = false; publish({ address: snapshot.state!.currentUrl || snapshot.state!.query }); }
      } catch (cause) { fail(job, cause); } finally { finish(job); }
    },
    async decide(resource: ResourceItem, decision: 'selected' | 'rejected' | null) {
      if (!resource.candidateId || !candidate(resource)) return;
      const job = begin('decision'); if (!job) return;
      try { acceptReply(job, await api!.setDecision({ sessionId: job.sessionId, candidateId: resource.candidateId, decision })); }
      catch (cause) { fail(job, cause); } finally { finish(job); }
    },
    async toggleDownload(resource: ResourceItem, enabled: boolean) {
      if (!resource.candidateId || !candidate(resource)?.downloadable) return;
      const job = begin('download'); if (!job) return;
      try { acceptReply(job, await api!.setDownload({ sessionId: job.sessionId, candidateId: resource.candidateId, enabled })); }
      catch (cause) { fail(job, cause); } finally { finish(job); }
    },
    async scan() {
      const job = begin('scan'); if (!job) return;
      try { await api!.scan(job.sessionId); } catch (cause) { fail(job, cause); } finally { finish(job); }
    },
    async saveSiteLogin(resource: ResourceItem) {
      if (!resource.candidateId || !candidate(resource)) return;
      const job = begin('authorize'); if (!job) return;
      try {
        const result = await api!.authorize({ sessionId: job.sessionId, candidateId: resource.candidateId });
        if (!owns(job) || result.canceled) return;
        if (!result.resource) throw new Error('登录容器未能创建，请重试');
        // Only the initiating session may close after authorization opens its replacement window.
        api!.close();
      } catch (cause) { fail(job, cause); } finally { finish(job); }
    },
    async commit() {
      if (!snapshot.state || !Object.values(snapshot.state.decisions).some(Boolean)) return;
      const job = begin('commit'); if (!job) return;
      try {
        const result = await api!.commit(job.sessionId);
        if (!owns(job)) return;
        if (!result.ok && !result.canceled) publish({ error: result.error || '写回失败，请重试' });
        if (result.ok && result.pendingApply) {
          // A fast apply acknowledgement may have arrived before the IPC promise settled.
          job.awaitingApply = !(sequence > job.sequence && !snapshot.state?.busy);
        }
      } catch (cause) { fail(job, cause); }
      finally { if (!job.awaitingApply) finish(job); }
    },
    close() { if (active && !operation && !snapshot.state?.busy) api?.close(); },
  };
}
