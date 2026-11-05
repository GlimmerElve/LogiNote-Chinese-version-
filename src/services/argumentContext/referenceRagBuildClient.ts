import type { ArgumentReferenceSourceRef } from './referenceBuildTypes';
import type { ArgumentReferenceRagBuildApi, ArgumentReferenceRagBuildPrepareReply, ArgumentReferenceRagBuildStatusReply,
  ArgumentReferenceRagBuildRunReply, ArgumentReferenceRagBuildCancelReply } from './referenceRagBuildTypes';
import { argumentReferenceBuildReasonLabel } from './referenceBuildClient';

export type PreparedReferenceRagBuild = Extract<ArgumentReferenceRagBuildPrepareReply, { status: 'prepared' }>;
export type ArgumentReferenceRagBuildEventApi = ArgumentReferenceRagBuildApi & {
  onChanged?(callback: () => void): () => void; onInvalidated?(callback: () => void): () => void;
};
const validPropositionCount = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
export function getArgumentReferenceRagBuildApi(): ArgumentReferenceRagBuildEventApi | undefined {
  return typeof window === 'undefined' ? undefined
    : (window as unknown as { electronAPI?: { argumentReferenceRag?: ArgumentReferenceRagBuildEventApi } }).electronAPI?.argumentReferenceRag;
}

/** An explicit combined build lease. Only read-only preparation/status can renew; never replay consented work. */
export function createArgumentReferenceRagBuildClient(getApi: () => ArgumentReferenceRagBuildApi | undefined) {
  let environment: Promise<string | null> | undefined;
  async function getEnvironment(api: ArgumentReferenceRagBuildApi): Promise<{ id: string | null; token: Promise<string | null> }> {
    if (!environment) environment = api.getEnvironment().then(reply => reply.status === 'available'
      && typeof reply.environmentId === 'string' && reply.environmentId.length > 0 && reply.environmentId.length <= 300
      ? reply.environmentId : null).catch(() => null);
    const token = environment, value = await token;
    if (!value && environment === token) environment = undefined;
    return { id: value, token };
  }
  async function readOnly<T extends ArgumentReferenceRagBuildPrepareReply | ArgumentReferenceRagBuildStatusReply>(
    refValue: ArgumentReferenceSourceRef,
    action: (api: ArgumentReferenceRagBuildApi, environmentId: string, ref: ArgumentReferenceSourceRef) => Promise<T>,
  ): Promise<T | { status: 'held'; reasonCode: 'environment_changed' }> {
    const ref = structuredClone(refValue);
    for (let attempt = 0; attempt < 2; attempt++) {
      let used: Promise<string | null> | undefined;
      try {
        const api = getApi(); if (!api) break;
        const lease = await getEnvironment(api); used = lease.token; if (!lease.id) break;
        const reply = await action(api, lease.id, ref);
        if (reply.status !== 'held' || reply.reasonCode !== 'environment_changed') return reply;
        // A response from an obsolete lease must not erase a concurrent reader's new lease.
        if (environment === used) environment = undefined;
      } catch { if (environment === used) environment = undefined; break; }
    }
    return { status: 'held', reasonCode: 'environment_changed' };
  }
  async function prepare(ref: ArgumentReferenceSourceRef): Promise<ArgumentReferenceRagBuildPrepareReply> {
    const reply = await readOnly(ref, (api, environmentId, selected) => api.prepare({ environmentId, ref: selected }));
    try {
      if (reply.status === 'prepared' && (!reply.summary
        || !(reply.summary.stage === 'structure-and-propositions' && reply.summary.maximumModelRequests === 5
          || reply.summary.stage === 'propositions' && reply.summary.maximumModelRequests === 2))) {
        return { status: 'held', reasonCode: 'model_response_invalid' };
      }
      if (reply.status === 'available' && !validPropositionCount(reply.propositionCount)) return { status: 'held', reasonCode: 'model_response_invalid' };
      return reply;
    } catch { return { status: 'held', reasonCode: 'model_response_invalid' }; }
  }
  async function status(ref: ArgumentReferenceSourceRef): Promise<ArgumentReferenceRagBuildStatusReply> {
    const reply = await readOnly(ref, (api, environmentId, selected) => api.status({ environmentId, ref: selected }));
    return reply.status === 'available' && !validPropositionCount(reply.propositionCount)
      ? { status: 'held', reasonCode: 'model_response_invalid' } : reply;
  }
  async function run(ticketValue: PreparedReferenceRagBuild): Promise<ArgumentReferenceRagBuildRunReply> {
    const ticket = structuredClone(ticketValue);
    try {
      const api = getApi(); if (!api) return { status: 'held', reasonCode: 'environment_changed' };
      const reply = await api.run({ environmentId: ticket.environmentId, ticketId: ticket.ticketId, consent: 'process-reference-with-propositions' });
      return reply.status === 'published' && !validPropositionCount(reply.propositionCount)
        ? { status: 'held', reasonCode: 'model_response_invalid' } : reply;
    } catch { return { status: 'held', reasonCode: 'model_failed' }; }
  }
  async function cancel(ticketValue: PreparedReferenceRagBuild): Promise<ArgumentReferenceRagBuildCancelReply> {
    const ticket = structuredClone(ticketValue);
    try {
      return await getApi()?.cancel({ environmentId: ticket.environmentId, ticketId: ticket.ticketId })
        ?? { status: 'held', reasonCode: 'environment_changed' };
    } catch { return { status: 'held', reasonCode: 'environment_changed' }; }
  }
  return { prepare, status, run, cancel, invalidate: () => { environment = undefined; } };
}

export const argumentReferenceRagBuildClient = createArgumentReferenceRagBuildClient(getArgumentReferenceRagBuildApi);

export function argumentReferenceRagBuildReasonLabel(reason: string): string {
  switch (reason) {
    case 'propositions_missing': return '论证结构已保存，关键命题尚待审核';
    case 'proposition_review_held': return '关键命题审核未通过，请核对后重试';
    case 'proposition_storage_unavailable': return '关键命题未能安全保存，请稍后重试';
    default: return argumentReferenceBuildReasonLabel(reason);
  }
}
