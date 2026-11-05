import type { NoteItem } from '../../types';
import { argumentCanonicalTextHash, argumentContextHash } from './hash';
import type { ArgumentReferenceSourceRef, ArgumentReferenceBuildPrepareReply, ArgumentReferenceBuildRunReply,
  ArgumentReferenceBuildStatusReply, ArgumentReferenceBuildCancelReply, ArgumentReferenceBuildSourceIdentity } from './referenceBuildTypes';

export interface ArgumentReferenceBuildApi {
  getEnvironment(): Promise<{ status: 'available'; environmentId: string } | { status: 'held'; reasonCode: string }>;
  prepare(request: { environmentId: string; ref: ArgumentReferenceSourceRef }): Promise<ArgumentReferenceBuildPrepareReply>;
  status(request: { environmentId: string; ref: ArgumentReferenceSourceRef }): Promise<ArgumentReferenceBuildStatusReply>;
  run(request: { environmentId: string; ticketId: string; consent: 'process-reference' }): Promise<ArgumentReferenceBuildRunReply>;
  cancel(request: { environmentId: string; ticketId: string }): Promise<ArgumentReferenceBuildCancelReply>;
}
export type PreparedReferenceBuild = Extract<ArgumentReferenceBuildPrepareReply, { status: 'prepared' }>;
export function getArgumentReferenceBuildApi(): (ArgumentReferenceBuildApi & {
  onChanged?(callback: () => void): () => void; onInvalidated?(callback: () => void): () => void;
}) | undefined {
  return typeof window === 'undefined' ? undefined
    : (window as unknown as { electronAPI?: { argumentReference?: ArgumentReferenceBuildApi & {
      onChanged?(callback: () => void): () => void; onInvalidated?(callback: () => void): () => void;
    } } }).electronAPI?.argumentReference;
}

/** One shared BUILD lease, separate from review question leases. Only read-only operations may renew/retry. */
export function createArgumentReferenceBuildClient(getApi: () => ArgumentReferenceBuildApi | undefined) {
  let environment: Promise<string | null> | undefined;
  async function getEnvironment(api: ArgumentReferenceBuildApi): Promise<{ id: string | null; token: Promise<string | null> }> {
    if (!environment) environment = api.getEnvironment().then(reply => reply.status === 'available'
      && typeof reply.environmentId === 'string' && reply.environmentId.length <= 300 ? reply.environmentId : null).catch(() => null);
    const token = environment, value = await token;
    if (!value && environment === token) environment = undefined;
    return { id: value, token };
  }
  async function readOnly<T extends ArgumentReferenceBuildPrepareReply | ArgumentReferenceBuildStatusReply>(
    refValue: ArgumentReferenceSourceRef, action: (api: ArgumentReferenceBuildApi, environmentId: string, ref: ArgumentReferenceSourceRef) => Promise<T>,
  ): Promise<T | { status: 'held'; reasonCode: 'environment_changed' }> {
    const ref = structuredClone(refValue);
    for (let attempt = 0; attempt < 2; attempt++) {
      let used: Promise<string | null> | undefined;
      try {
        const api = getApi(); if (!api) break;
        const lease = await getEnvironment(api); used = lease.token; if (!lease.id) break;
        const reply = await action(api, lease.id, ref);
        if (reply.status !== 'held' || reply.reasonCode !== 'environment_changed') return reply;
        // A late response from the OLD lease must not revoke another reader's new lease.
        if (environment === used) environment = undefined;
      } catch { if (environment === used) environment = undefined; break; }
    }
    return { status: 'held', reasonCode: 'environment_changed' };
  }
  async function prepare(ref: ArgumentReferenceSourceRef): Promise<ArgumentReferenceBuildPrepareReply> {
    return readOnly(ref, (api, environmentId, selected) => api.prepare({ environmentId, ref: selected }));
  }
  async function status(ref: ArgumentReferenceSourceRef): Promise<ArgumentReferenceBuildStatusReply> {
    return readOnly(ref, (api, environmentId, selected) => api.status({ environmentId, ref: selected }));
  }
  async function run(ticketValue: PreparedReferenceBuild): Promise<ArgumentReferenceBuildRunReply> {
    const ticket = structuredClone(ticketValue);
    try {
      const api = getApi(); if (!api) return { status: 'held', reasonCode: 'environment_changed' };
      // Never auto-renew, replay, or change a ticket after the user consented to its exact source/model.
      return await api.run({ environmentId: ticket.environmentId, ticketId: ticket.ticketId, consent: 'process-reference' });
    } catch { return { status: 'held', reasonCode: 'model_failed' }; }
  }
  async function cancel(ticketValue: PreparedReferenceBuild): Promise<ArgumentReferenceBuildCancelReply> {
    const ticket = structuredClone(ticketValue);
    try {
      return await getApi()?.cancel({ environmentId: ticket.environmentId, ticketId: ticket.ticketId })
        ?? { status: 'held', reasonCode: 'environment_changed' };
    } catch { return { status: 'held', reasonCode: 'environment_changed' }; }
  }
  return { prepare, status, run, cancel, invalidate: () => { environment = undefined; } };
}

export const argumentReferenceBuildClient = createArgumentReferenceBuildClient(getArgumentReferenceBuildApi);

/** Renderer freshness check only, never admission authority. Matches the saved-source identity contract. */
export async function expectedNoteArgumentReference(noteValue: NoteItem): Promise<ArgumentReferenceBuildSourceIdentity> {
  const note = structuredClone(noteValue);
  return { kind: 'knowledge-note', entityId: note.id, contentHash: await argumentCanonicalTextHash(note.content),
    version: await argumentContextHash({ contract: 'saved-note-content-identity-v2', noteId: note.id, noteType: note.noteType,
      title: note.title, canonicalText: note.content, createdAt: note.createdAt, referenceSources: note.referenceSources ?? [] }) };
}

export function argumentReferenceBuildReasonLabel(reason: string): string {
  switch (reason) {
    case 'source_pending': return '等待正文保存完成';
    case 'source_changed': return '原文已变化，请重新建立参考论证';
    case 'model_changed': return '模型设置已变化，请重新确认';
    case 'model_unavailable': return '请先配置并保存可用的抽取模型';
    case 'request_budget': return '资料超过本次完整处理预算，未截断或发布';
    case 'provenance_unavailable': return '缺少可追溯出处，请先补充来源';
    case 'qualification_rejected': return '来源审核未通过，仍可查阅原文';
    case 'review_incomplete': return '尚无完整审核通过的参考论证';
    case 'model_response_invalid': return '模型输出不符合协议，未发布';
    case 'model_failed': return '模型请求失败，未自动重试';
    case 'publication_rejected': return '结构未能安全发布，请核对后重试';
    case 'ticket_expired': return '本次确认已过期，请重新开始';
    case 'cancelled': return '本次处理已停止';
    case 'capacity': return '已有处理任务，请稍后再试';
    case 'source_missing': return '未找到已保存的参考正文';
    case 'scope_denied': return '当前资料不在允许的参考范围';
    default: return '参考论证暂不可用，请稍后重试';
  }
}
