import { loadPersonalCognition, savePersonalCognition } from './store';
import { cognitionWindowApi } from './managerWindow';
import { previewCognitionGraphEdit } from './editing';
import type { CognitionGraphEdit } from './types';

interface Proposal { id: string; scope: string; ownerId?: string; fileRevision: number; edit: CognitionGraphEdit; preview: ReturnType<typeof previewCognitionGraphEdit>; expires: number; busy: boolean }
const proposals = new Map<string, Proposal>();
async function scopeId() {
  const api = cognitionWindowApi();
  if (api && !api.userState?.getAgentTaskScope) throw new Error('认知库环境校验接口不可用，请重启应用');
  return api ? await api.userState!.getAgentTaskScope!() : `browser:${window.location?.origin || 'local'}`;
}
export async function prepareCognitionChange(edit: CognitionGraphEdit, options: { ownerId?: string; signal?: AbortSignal } = {}) {
  options.signal?.throwIfAborted();
  const scope = await scopeId(), file = await loadPersonalCognition();
  const frozen = structuredClone(edit), preview = previewCognitionGraphEdit(file, frozen, 'adopted_with_assistance');
  if (scope !== await scopeId()) throw new Error('资料库已切换，未生成修改提案');
  options.signal?.throwIfAborted();
  for (const [id, proposal] of proposals) if (proposal.expires < Date.now()) proposals.delete(id);
  if (proposals.size >= 30) throw new Error('待确认认知变更过多，请先处理现有提案或重新打开助手');
  const id = crypto.randomUUID();
  proposals.set(id, { id, scope, ...(options.ownerId ? { ownerId: options.ownerId } : {}), fileRevision: file.revision, edit: frozen, preview, expires: Date.now() + 30 * 60_000, busy: false });
  return { proposalId: id, ...preview, requiresUserConfirmation: true, saved: false };
}
export function cognitionChangePreview(id: unknown) {
  const proposal = typeof id === 'string' && proposals.get(id);
  if (!proposal || proposal.expires < Date.now()) throw new Error('认知变更提案已失效，请重新查找、预览并确认');
  return structuredClone(proposal.preview);
}
/** Release an abandoned in-memory preview only; never undo or write cognition. */
export function discardCognitionChangeProposal(id: unknown): void {
  if (typeof id === 'string' && !proposals.get(id)?.busy) proposals.delete(id);
}
/** Runtime ownership is not persisted or model-selectable; never clear another window's previews. */
export function discardOwnedCognitionProposals(ownerId: string, keep: Set<unknown> = new Set()): void {
  for (const [id, proposal] of proposals) if (proposal.ownerId === ownerId && !proposal.busy && !keep.has(id)) proposals.delete(id);
}
async function validated(id: unknown) {
  cognitionChangePreview(id);
  const proposal = proposals.get(id as string)!;
  const scope = await scopeId(), file = await loadPersonalCognition();
  if (scope !== proposal.scope || scope !== await scopeId() || file.revision !== proposal.fileRevision) throw new Error('认知库或版本已变化，旧确认不可使用，请重新预览并确认');
  return proposal;
}
export async function cognitionChangeApprovalSnapshot(id: unknown) {
  const proposal = await validated(id);
  return structuredClone({ id: proposal.id, scope: proposal.scope, fileRevision: proposal.fileRevision, edit: proposal.edit, preview: proposal.preview });
}
/** Only the registered commit tool may call this after its trusted approval execution flag.
 * Multiple exact approval items use ONE CAS/atomic store write, never rebasing
 * a second proposal against a file changed by the first committed write.
 */
export async function commitCognitionChanges(ids: unknown[], signal?: AbortSignal) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 20 || new Set(ids).size !== ids.length) throw new Error('认知批量提案为空、重复或过多，整组未保存');
  const batch = ids.map(id => { cognitionChangePreview(id); return proposals.get(id as string)!; });
  const scope = await scopeId(), file = await loadPersonalCognition();
  if (scope !== await scopeId() || batch.some(proposal => proposal.scope !== scope || proposal.fileRevision !== file.revision)) throw new Error('认知库或版本已变化，旧确认不可使用，请重新预览并确认');
  for (const proposal of batch) {
    cognitionChangePreview(proposal.id);
    if (proposals.get(proposal.id) !== proposal || proposal.busy) throw new Error('这项变更已失效或正在保存，不会重复执行');
  }
  signal?.throwIfAborted();
  batch.forEach(proposal => { proposal.busy = true; });
  try {
    const api = cognitionWindowApi();
    const mutation = batch.length === 1 ? { kind: 'edit_graph' as const, edit: batch[0].edit }
      : { kind: 'edit_graph_batch' as const, edits: batch.map(proposal => proposal.edit) };
    const next = await savePersonalCognition({ ...mutation, confirmed: true, expectedRevision: file.revision, authorship: 'adopted_with_assistance',
      ...(api ? { storageScopeId: scope } : {}) });
    batch.forEach(proposal => proposals.delete(proposal.id));
    return batch.map(proposal => ({ saved: true, fileRevision: next.revision, action: proposal.edit.action, historyPreserved: true, batchSize: batch.length }));
  } finally { batch.forEach(proposal => { proposal.busy = false; }); }
}
export async function commitCognitionChange(id: unknown, signal?: AbortSignal) { return (await commitCognitionChanges([id], signal))[0]; }
