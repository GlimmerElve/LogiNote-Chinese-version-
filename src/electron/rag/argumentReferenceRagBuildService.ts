import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { argumentContextHash } from '../../services/argumentContext/hash.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionBuildResult } from '../../services/argumentContext/buildTypes.ts';
import type { ArgumentContextScope } from '../../services/argumentContext/types.ts';
import type { ArgumentReferenceBuildCounts, ArgumentReferenceBuildSourceIdentity } from '../../services/argumentContext/referenceBuildTypes.ts';
import type { ArgumentReferenceRagBuildCancelReply, ArgumentReferenceRagBuildPrepareReply, ArgumentReferenceRagBuildReason,
  ArgumentReferenceRagBuildRunReply, ArgumentReferenceRagBuildSourceRequest, ArgumentReferenceRagBuildStatusReply,
  ArgumentReferenceRagBuildSummary } from '../../services/argumentContext/referenceRagBuildTypes.ts';
import type { NoteItem } from '../../types.ts';
import type { createArgumentProjectionEnvironmentRegistry, ArgumentProjectionRoots } from './argumentProjectionEnvironment.ts';
import type { createArgumentReferenceBuildService } from './argumentReferenceBuildService.ts';
import type { ArgumentProjectionRuntime } from './argumentProjectionRuntime.ts';
import { validateArgumentProjectionSourceRef, type ArgumentProjectionSourceRef } from './argumentProjectionAuthority.ts';
import { readArgumentReferenceProvenance, type ArgumentReferenceProvenance } from './argumentReferencePolicy.ts';
import { argumentReferenceModel, type ArgumentReferenceModelAdapter, type ArgumentReferenceModelConfig } from './argumentReferenceModel.ts';
import { createArgumentReferenceNoteObservations, type ArgumentReferenceNoteObservation } from './argumentReferenceNoteObservations.ts';
import { createPersistentSourcePropositionStore } from './referenceSourcePropositionStore.ts';
import { createCurrentSourcePropositionReader, createReferenceSourcePropositionProvider, createSavedSourcePropositionModel } from './referenceSourcePropositionProvider.ts';
import type { SourcePropositionBuildModelOptions, SourcePropositionBuildDiagnostic } from '../../services/reviewComparison/sourcePropositionBuild.ts';

export const ARGUMENT_REFERENCE_RAG_BUILD_LIMITS = { ticketsPerOwner: 8, ticketTtlMs: 10 * 60 * 1000, inflight: 2 } as const;
let globalInflight = 0;
export interface ArgumentReferenceRagBuildServiceOptions {
  environments: Pick<ReturnType<typeof createArgumentProjectionEnvironmentRegistry>, 'withEnvironment'>;
  structure: Pick<ReturnType<typeof createArgumentReferenceBuildService>, 'prepare' | 'run' | 'cancel' | 'status'>;
  model?: ArgumentReferenceModelAdapter;
  propositionDraftProtocol?: SourcePropositionBuildModelOptions['draftProtocol'];
  onPropositionDiagnostic?: (diagnostic: Readonly<SourcePropositionBuildDiagnostic>) => void;
}
interface Snapshot { input: ArgumentProjectionBuildInput; sourceHash: string; provenance: ArgumentReferenceProvenance; rootHash: string }
interface Ticket {
  id: string; owner: number; environmentId: string; ref: ArgumentProjectionSourceRef; expiresAt: number;
  epoch: number; ownerEpoch: number; snapshot: Snapshot; config: ArgumentReferenceModelConfig;
  observation: ArgumentReferenceNoteObservation; summary: ArgumentReferenceRagBuildSummary; oldTicketId?: string;
  publicationHash?: string; readyBundleHash?: string;
  abort: AbortController; stopReason?: 'cancelled' | 'environment_changed' | 'ticket_expired' | 'source_changed';
  job?: Promise<ArgumentReferenceRagBuildRunReply>; result?: ArgumentReferenceRagBuildRunReply;
}
const fail = (code: ArgumentReferenceRagBuildReason): never => { throw new Error(`argument_reference_rag_build_${code}`); };
const held = (reasonCode: ArgumentReferenceRagBuildReason) => ({ status: 'held' as const, reasonCode });
function closed(raw: unknown, fields: string[]): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
    || Reflect.ownKeys(raw).some(key => typeof key !== 'string')
    || Reflect.ownKeys(raw).sort().join('|') !== [...fields].sort().join('|')
    || Object.values(Object.getOwnPropertyDescriptors(raw)).some(value => !value.enumerable || !Object.hasOwn(value, 'value'))) fail('invalid_request');
}
function opaque(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,300}$/u.test(value)) fail('invalid_request');
}
function ownerShape(owner: number): void { if (!Number.isSafeInteger(owner) || owner < 0) fail('invalid_request'); }
function sourceRequest(raw: unknown): ArgumentReferenceRagBuildSourceRequest {
  closed(raw, ['environmentId', 'ref']); opaque(raw.environmentId); closed(raw.ref, ['kind', 'entityId']);
  try { validateArgumentProjectionSourceRef(raw.ref); } catch { fail('invalid_request'); }
  return structuredClone(raw) as unknown as ArgumentReferenceRagBuildSourceRequest;
}
function ticketRequest(raw: unknown, run: boolean) {
  closed(raw, run ? ['environmentId', 'ticketId', 'consent'] : ['environmentId', 'ticketId']);
  opaque(raw.environmentId); opaque(raw.ticketId);
  if (run && raw.consent !== 'process-reference-with-propositions') fail('invalid_request');
  return { environmentId: raw.environmentId, ticketId: raw.ticketId };
}
function sourceIdentity(input: ArgumentProjectionBuildInput): ArgumentReferenceBuildSourceIdentity {
  return { kind: input.source.kind as ArgumentProjectionSourceRef['kind'], entityId: input.source.entityId,
    version: input.source.version, contentHash: input.source.contentHash };
}
function counts(result: ArgumentProjectionBuildResult): ArgumentReferenceBuildCounts {
  return { nodes: result.projection.nodes.length, relations: result.projection.relations.length,
    groups: result.projection.prerequisiteGroups.length, scopes: result.projection.build.scopes.length };
}
function reason(error: unknown): ArgumentReferenceRagBuildReason {
  const message = error instanceof Error ? error.message : '';
  if (message.startsWith('argument_reference_rag_build_')) return message.slice('argument_reference_rag_build_'.length) as ArgumentReferenceRagBuildReason;
  if (message.includes('environment_changed')) return 'environment_changed';
  if (message.includes('scope_denied')) return 'scope_denied';
  if (message.includes('save_in_progress')) return 'source_pending';
  if (message.includes('source_changed') || message.includes('snapshot_changed') || message.includes('cas_mismatch')) return 'source_changed';
  if (message.startsWith('source_proposition_store_') || message.startsWith('argument_source_proposition_store_')) return 'proposition_storage_unavailable';
  if (message.startsWith('argument_reference_model_')) return 'model_unavailable';
  if (message.startsWith('argument_reference_policy_')) return 'provenance_unavailable';
  return 'source_unavailable';
}

/**
 * Separate, explicit five-or-two-call consent. The legacy structure service keeps its
 * three-call contract. This coordinator publishes no scores or personal cognition.
 * Short host source transactions never span a user decision or model request.
 */
export function createArgumentReferenceRagBuildService(options: ArgumentReferenceRagBuildServiceOptions) {
  const onDiagnostic = options.onPropositionDiagnostic;
  const propositionDraftProtocol = options.propositionDraftProtocol ?? 'legacy-v1';
  if (!['legacy-v1', 'owned-parent-text-v2', 'owned-parent-choice-v3'].includes(propositionDraftProtocol)) throw new Error('argument_reference_rag_build_invalid_request');
  const withEnvironment: ArgumentReferenceRagBuildServiceOptions['environments']['withEnvironment'] = options.environments.withEnvironment.bind(options.environments);
  const structure: ArgumentReferenceRagBuildServiceOptions['structure'] = { prepare: options.structure.prepare.bind(options.structure), run: options.structure.run.bind(options.structure),
    cancel: options.structure.cancel.bind(options.structure), status: options.structure.status.bind(options.structure) };
  const adapter = options.model ?? argumentReferenceModel;
  const model: ArgumentReferenceModelAdapter = { read: adapter.read.bind(adapter), invoke: adapter.invoke.bind(adapter) };
  const tickets = new Map<string, Ticket>(), ownerEpochs = new Map<number, number>();
  const observations = createArgumentReferenceNoteObservations(); let epoch = 0;
  function guard(ticket: Ticket) {
    if (ticket.stopReason) fail(ticket.stopReason);
    if (ticket.epoch !== epoch || ticket.ownerEpoch !== (ownerEpochs.get(ticket.owner) ?? 0) || tickets.get(ticket.id) !== ticket) fail('environment_changed');
    if (!observations.current(ticket.observation)) { ticket.stopReason = 'source_changed'; ticket.abort.abort(); fail('source_changed'); }
    if (Date.now() >= ticket.expiresAt) { ticket.stopReason = 'ticket_expired'; ticket.abort.abort(); fail('ticket_expired'); }
  }
  function stop(ticket: Ticket, code: Ticket['stopReason']) {
    ticket.stopReason = code; ticket.abort.abort(); tickets.delete(ticket.id);
    if (ticket.oldTicketId) void structure.cancel(ticket.owner, { environmentId: ticket.environmentId, ticketId: ticket.oldTicketId }).catch(() => {});
  }
  function revoke(owner?: number) {
    if (owner === undefined) { epoch++; observations.reset(); } else ownerEpochs.set(owner, (ownerEpochs.get(owner) ?? 0) + 1);
    for (const ticket of tickets.values()) if (owner === undefined || ticket.owner === owner) stop(ticket, 'environment_changed');
  }
  function sweep() { for (const ticket of tickets.values()) if (Date.now() >= ticket.expiresAt) stop(ticket, 'ticket_expired'); }
  async function guardedWait<T>(ticket: Ticket, work: () => Promise<T>): Promise<T> {
    guard(ticket);
    let timer: ReturnType<typeof setTimeout> | undefined, abort!: () => void;
    const halted = new Promise<never>((_, reject) => {
      abort = () => reject(new Error(`argument_reference_rag_build_${ticket.stopReason ?? 'cancelled'}`));
      ticket.abort.signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => { ticket.stopReason = 'ticket_expired'; ticket.abort.abort(); }, Math.max(1, ticket.expiresAt - Date.now()));
    });
    try {
      const reply = await Promise.race([halted, Promise.resolve().then(() => { guard(ticket); return work(); })]);
      guard(ticket); return reply;
    } finally { if (timer) clearTimeout(timer); ticket.abort.signal.removeEventListener('abort', abort); }
  }
  async function saved(runtime: ArgumentProjectionRuntime, roots: ArgumentProjectionRoots, ref: ArgumentProjectionSourceRef,
    scope: ArgumentContextScope): Promise<Snapshot> {
    return runtime.host.withSource(ref, async input => {
      if (!input) return fail('source_missing');
      const provenance = await readArgumentReferenceProvenance(roots, input, scope);
      // Qualification/buildId are expected derived changes after the authorized
      // structure-quality stage. Everything describing the saved source is bound.
      const { sourceQualification: _qualification, buildId: _build, sourceBindingHash: _binding, ...physical } = input;
      return { input, sourceHash: await argumentContextHash(physical), provenance, rootHash: await argumentContextHash(roots) };
    });
  }
  async function check(ticket: Ticket) {
    guard(ticket);
    await guardedWait(ticket, () => withEnvironment(ticket.owner, ticket.environmentId, async (runtime, roots, scope) => {
      guard(ticket); const config = await model.read(roots); guard(ticket);
      if (config.fingerprint !== ticket.config.fingerprint) fail('model_changed');
      const current = await saved(runtime, roots, ticket.ref, scope); guard(ticket);
      if (current.rootHash !== ticket.snapshot.rootHash) fail('environment_changed');
      if (current.sourceHash !== ticket.snapshot.sourceHash || current.provenance.fingerprint !== ticket.snapshot.provenance.fingerprint) fail('source_changed');
      if (ticket.publicationHash) {
        const active = await createCurrentSourcePropositionReader(runtime.store)(ticket.ref); guard(ticket);
        if (!active || await argumentContextHash(active.binding) !== ticket.publicationHash) fail('source_changed');
      }
    }));
    guard(ticket);
  }
  async function inspect(owner: number, request: ArgumentReferenceRagBuildSourceRequest) {
    return withEnvironment(owner, request.environmentId, async (runtime, roots, scope) => {
      const snapshot = await saved(runtime, roots, request.ref, scope);
      const reader = createCurrentSourcePropositionReader(runtime.store), active = await reader(request.ref);
      if (!active || active.input.buildId !== snapshot.input.buildId) return { snapshot, active: null, proof: null };
      const store = createPersistentSourcePropositionStore(path.join(roots.dataRoot, 'argument-propositions'), runtime.store, scope.rootScopeId);
      const proof = await store.read(request.ref);
      // These are separate short host transactions: neither the old active
      // snapshot nor a newly read asset may authenticate the other by itself.
      const after = await reader(request.ref);
      if (!after || await argumentContextHash(after) !== await argumentContextHash(active)
        || await argumentContextHash(snapshot.input) !== await argumentContextHash(after.input)) fail('source_changed');
      if (proof && (await argumentContextHash(proof.input) !== await argumentContextHash(after.input)
        || await argumentContextHash(proof.result) !== await argumentContextHash(after.result))) fail('source_changed');
      return { snapshot, active, proof };
    });
  }
  async function status(owner: number, raw: unknown): Promise<ArgumentReferenceRagBuildStatusReply> {
    try {
      ownerShape(owner); const request = sourceRequest(raw), readingEpoch = epoch, readingOwnerEpoch = ownerEpochs.get(owner) ?? 0;
      const state = await inspect(owner, request);
      if (readingEpoch !== epoch || readingOwnerEpoch !== (ownerEpochs.get(owner) ?? 0)) fail('environment_changed');
      if (!state.active) return { status: 'missing', source: sourceIdentity(state.snapshot.input),
        sourceQualification: state.snapshot.input.sourceQualification.status, reasonCode: 'review_incomplete' };
      if (!state.proof) return { status: 'missing', source: sourceIdentity(state.snapshot.input), sourceQualification: 'eligible',
        reasonCode: 'propositions_missing', counts: counts(state.active.result) };
      return { status: 'available', source: sourceIdentity(state.snapshot.input), sourceQualification: 'eligible',
        counts: counts(state.active.result), propositionCount: state.proof.bundle.anchors.length };
    } catch (error) { return held(reason(error)); }
  }
  async function prepare(owner: number, raw: unknown): Promise<ArgumentReferenceRagBuildPrepareReply> {
    let oldTicketId: string | undefined, environmentId = '';
    try {
      ownerShape(owner); const request = sourceRequest(raw); environmentId = request.environmentId; sweep();
      const preparingEpoch = epoch, preparingOwnerEpoch = ownerEpochs.get(owner) ?? 0, start = observations.begin();
      let state = await inspect(owner, request);
      if (preparingEpoch !== epoch || preparingOwnerEpoch !== (ownerEpochs.get(owner) ?? 0)) fail('environment_changed');
      if (state.active && state.proof) return { status: 'available', environmentId, source: sourceIdentity(state.snapshot.input),
        sourceQualification: 'eligible', counts: counts(state.active.result), propositionCount: state.proof.bundle.anchors.length };
      let oldSummary: Omit<ArgumentReferenceRagBuildSummary, 'stage' | 'maximumModelRequests'> | undefined;
      if (!state.active) {
        const prepared = await structure.prepare(owner, request);
        if (prepared.status === 'held') return prepared;
        if (prepared.status === 'prepared') { oldTicketId = prepared.ticketId; oldSummary = prepared.summary; }
        else state = await inspect(owner, request);
      }
      if (!oldTicketId && !state.active) fail('review_incomplete');
      const captured = await withEnvironment(owner, environmentId, async (runtime, roots, scope) => {
        const config = await model.read(roots), snapshot = await saved(runtime, roots, request.ref, scope);
        if (snapshot.sourceHash !== state.snapshot.sourceHash || snapshot.provenance.fingerprint !== state.snapshot.provenance.fingerprint
          || snapshot.rootHash !== state.snapshot.rootHash) fail('source_changed');
        const after = await model.read(roots); if (after.fingerprint !== config.fingerprint) fail('model_changed');
        return { config, snapshot };
      });
      if (preparingEpoch !== epoch || preparingOwnerEpoch !== (ownerEpochs.get(owner) ?? 0)) fail('environment_changed');
      const observation = observations.capture(start, [captured.snapshot.input.source,
        ...captured.snapshot.provenance.internalReferences.map(reference => reference.source)]);
      if (oldSummary && (oldSummary.providerLabel !== captured.config.providerLabel || oldSummary.modelName !== captured.config.modelName
        || oldSummary.isRemote !== captured.config.isRemote)) fail('model_changed');
      sweep();
      const stage = oldTicketId ? 'structure-and-propositions' as const : 'propositions' as const;
      const publicationHash = state.active ? await argumentContextHash(state.active.binding) : undefined;
      const existing = [...tickets.values()].find(ticket => ticket.owner === owner && ticket.environmentId === environmentId
        && ticket.summary.stage === stage && ticket.snapshot.sourceHash === captured.snapshot.sourceHash
        && ticket.snapshot.provenance.fingerprint === captured.snapshot.provenance.fingerprint && ticket.snapshot.rootHash === captured.snapshot.rootHash
        && ticket.config.fingerprint === captured.config.fingerprint && !ticket.stopReason && !ticket.job);
      if (existing && existing.oldTicketId === oldTicketId && existing.publicationHash === publicationHash)
        return { status: 'prepared', environmentId, ticketId: existing.id, expiresAt: new Date(existing.expiresAt).toISOString(), summary: structuredClone(existing.summary) };
      if (existing) stop(existing, 'source_changed');
      if ([...tickets.values()].filter(ticket => ticket.owner === owner).length >= ARGUMENT_REFERENCE_RAG_BUILD_LIMITS.ticketsPerOwner) fail('capacity');
      const summary: ArgumentReferenceRagBuildSummary = { sourceKind: request.ref.kind, entityId: captured.snapshot.input.source.entityId,
        sourceVersion: captured.snapshot.input.source.version, contentHash: captured.snapshot.input.source.contentHash,
        characters: captured.snapshot.input.canonicalText.length, sentences: captured.snapshot.input.hierarchy.sentences.length,
        chunks: captured.snapshot.input.chunks.length, providerLabel: captured.config.providerLabel, modelName: captured.config.modelName,
        isRemote: captured.config.isRemote, stage, maximumModelRequests: oldTicketId ? 5 : 2, reviewBudget: 'checked-after-extraction' };
      const ticket: Ticket = { id: randomUUID(), owner, environmentId, ref: structuredClone(request.ref), expiresAt: Date.now() + ARGUMENT_REFERENCE_RAG_BUILD_LIMITS.ticketTtlMs,
        epoch, ownerEpoch: preparingOwnerEpoch, snapshot: captured.snapshot, config: structuredClone(captured.config), observation,
        summary, oldTicketId, publicationHash, abort: new AbortController() };
      tickets.set(ticket.id, ticket);
      return { status: 'prepared', environmentId, ticketId: ticket.id, expiresAt: new Date(ticket.expiresAt).toISOString(), summary: structuredClone(summary) };
    } catch (error) {
      if (oldTicketId) await structure.cancel(owner, { environmentId, ticketId: oldTicketId }).catch(() => {});
      return held(reason(error));
    }
  }
  async function process(ticket: Ticket): Promise<ArgumentReferenceRagBuildRunReply> {
    let structureCounts: ArgumentReferenceBuildCounts | undefined;
    try {
      await check(ticket);
      if (ticket.oldTicketId) {
        const built = await guardedWait(ticket, () => structure.run(ticket.owner,
          { environmentId: ticket.environmentId, ticketId: ticket.oldTicketId!, consent: 'process-reference' }));
        if (built.status !== 'published') return { ...held(built.reasonCode), ...(built.counts ? { counts: built.counts } : {}) };
        structureCounts = built.counts;
      }
      await check(ticket);
      const provider = await guardedWait(ticket, () => withEnvironment(ticket.owner, ticket.environmentId, async (runtime, roots, scope) => {
        guard(ticket);
        const sourceReader = createCurrentSourcePropositionReader(runtime.store);
        const active = await sourceReader(ticket.ref); guard(ticket);
        if (!active) fail('review_incomplete');
        const publicationHash = await argumentContextHash(active.binding);
        if (ticket.publicationHash && ticket.publicationHash !== publicationHash) fail('source_changed');
        ticket.publicationHash = publicationHash;
        structureCounts = counts(active.result);
        const storage = createPersistentSourcePropositionStore(path.join(roots.dataRoot, 'argument-propositions'), runtime.store, scope.rootScopeId);
        return createReferenceSourcePropositionProvider({ storage, model: createSavedSourcePropositionModel(ticket.config, model, { draftProtocol: propositionDraftProtocol }), onDiagnostic,
          assertModelCurrent: () => check(ticket),
          readCurrent: ref => withEnvironment(ticket.owner, ticket.environmentId, async (currentRuntime, currentRoots) => {
            guard(ticket); if (await argumentContextHash(currentRoots) !== ticket.snapshot.rootHash) fail('environment_changed');
            return createCurrentSourcePropositionReader(currentRuntime.store)(ref);
          }) });
      }));
      const proposition = await provider.build(ticket.ref, { consent: 'process-reference-propositions', signal: ticket.abort.signal });
      try { await check(ticket); } finally { provider.revoke(); }
      if (proposition.status !== 'ready' || proposition.retention !== 'persistent') {
        const storageFailure = proposition.status === 'held' && proposition.reasons.some(code => code.includes('storage'));
        return { ...held(storageFailure ? 'proposition_storage_unavailable' : 'proposition_review_held'),
          structureStatus: 'published', ...(structureCounts ? { counts: structureCounts } : {}) };
      }
      ticket.readyBundleHash = proposition.bundle.bundleHash;
      await verifyPublished(ticket);
      return { status: 'published', counts: structureCounts!, propositionCount: proposition.bundle.anchors.length };
    } catch (error) { return { ...held(reason(error)), ...(structureCounts ? { structureStatus: 'published' as const, counts: structureCounts } : {}) }; }
  }
  async function verifyPublished(ticket: Ticket) {
    guard(ticket);
    const current = await guardedWait(ticket, () => inspect(ticket.owner, { environmentId: ticket.environmentId, ref: ticket.ref }));
    guard(ticket);
    if (current.snapshot.sourceHash !== ticket.snapshot.sourceHash || current.snapshot.rootHash !== ticket.snapshot.rootHash
      || current.snapshot.provenance.fingerprint !== ticket.snapshot.provenance.fingerprint) fail('source_changed');
    if (!current.active || !ticket.publicationHash || await argumentContextHash(current.active.binding) !== ticket.publicationHash) fail('source_changed');
    if (!current.proof || !ticket.readyBundleHash || current.proof.bundle.bundleHash !== ticket.readyBundleHash) fail('proposition_storage_unavailable');
  }
  async function run(owner: number, raw: unknown): Promise<ArgumentReferenceRagBuildRunReply> {
    try {
      ownerShape(owner); const request = ticketRequest(raw, true), ticket = tickets.get(request.ticketId);
      if (!ticket || ticket.owner !== owner || ticket.environmentId !== request.environmentId) fail('ticket_unavailable');
      guard(ticket);
      if (ticket.result) {
        await check(ticket); if (ticket.result.status === 'published') await verifyPublished(ticket); return structuredClone(ticket.result);
      }
      if (ticket.job) {
        const reply = await ticket.job; await check(ticket); if (reply.status === 'published') await verifyPublished(ticket); return structuredClone(reply);
      }
      if (globalInflight >= ARGUMENT_REFERENCE_RAG_BUILD_LIMITS.inflight) fail('capacity');
      globalInflight++;
      ticket.job = process(ticket).then(reply => { ticket.result = structuredClone(reply); return reply; }).finally(() => { globalInflight--; });
      return structuredClone(await ticket.job);
    } catch (error) { return held(reason(error)); }
  }
  async function cancel(owner: number, raw: unknown): Promise<ArgumentReferenceRagBuildCancelReply> {
    try {
      ownerShape(owner); const request = ticketRequest(raw, false), ticket = tickets.get(request.ticketId);
      if (!ticket || ticket.owner !== owner || ticket.environmentId !== request.environmentId || ticket.result) fail('ticket_unavailable');
      stop(ticket, 'cancelled'); return { status: 'cancelled' };
    } catch (error) { return held(reason(error)); }
  }
  function observeNoteSnapshot(next: NoteItem[], previous: NoteItem[]) {
    observations.observe(next, previous);
    for (const ticket of tickets.values()) if (!ticket.stopReason && !observations.current(ticket.observation)) stop(ticket, 'source_changed');
  }
  function observeNoteDelta(next: NoteItem[], previous: NoteItem[]) {
    observations.observeDelta(next, previous);
    for (const ticket of tickets.values()) if (!ticket.stopReason && !observations.current(ticket.observation)) stop(ticket, 'source_changed');
  }
  return { prepare, status, run, cancel, revoke, observeNoteSnapshot, observeNoteDelta };
}
