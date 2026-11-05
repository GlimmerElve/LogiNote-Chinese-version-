import type { ArgumentProjectionBuildInput, ArgumentProjectionBuildResult } from '../../services/argumentContext/buildTypes.ts';
import { argumentContextHash } from '../../services/argumentContext/hash.ts';
import type { ArgumentReferenceDisclosureContext } from '../../services/argumentContext/referenceDisclosure.ts';
import { buildSourcePropositions, type SourcePropositionBuildModel, type SourcePropositionBuildDiagnostic } from '../../services/reviewComparison/sourcePropositionBuild.ts';
import { projectReferenceSourcePropositions, validateSourcePropositions, type SourcePropositionProof } from '../../services/reviewComparison/sourcePropositionAnchors.ts';
import { validateArgumentProjectionSourceRef, type ArgumentProjectionSourceRef } from './argumentProjectionAuthority.ts';
import type { ArgumentProjectionActiveBinding, PersistentArgumentProjectionStore } from './argumentProjectionStore.ts';
import type { ArgumentReferenceModelAdapter, ArgumentReferenceModelConfig } from './argumentReferenceModel.ts';
import { createSourcePropositionBuildModel, type SourcePropositionBuildModelOptions } from '../../services/reviewComparison/sourcePropositionBuild.ts';
import type { PersistentSourcePropositionStore } from './referenceSourcePropositionStore.ts';

export interface CurrentSourcePropositionSnapshot {
  input: ArgumentProjectionBuildInput; result: ArgumentProjectionBuildResult; binding: ArgumentProjectionActiveBinding;
}
export const SOURCE_PROPOSITION_PROVIDER_LIMITS = { entries: 64, pending: 8, proofCharacters: 256000, cacheCharacters: 2000000 } as const;
export interface ReferenceSourcePropositionProviderOptions {
  /** Independent, host-authorized current publication reader. No self-supplied snapshot. */
  readCurrent(ref: ArgumentProjectionSourceRef): Promise<CurrentSourcePropositionSnapshot | null>;
  model?: SourcePropositionBuildModel;
  /** Host model/config lease check, when using a saved provider. Never a model vote. */
  assertModelCurrent?: () => Promise<void>;
  readTimeoutMs?: number;
  /** Host-only derived store. Reads never cause a missing asset to be built. */
  storage?: PersistentSourcePropositionStore;
  onDiagnostic?: (diagnostic: Readonly<SourcePropositionBuildDiagnostic>) => void;
}
const counts = () => ({ draft: 0, review: 0, total: 0, limit: 2 as const });
const held = (reason: string) => ({ status: 'held' as const, reasons: [reason], modelRequests: counts() });
const fail = (code: string): never => { throw new Error(code); };
function closed(raw: unknown, fields: string[]) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
    || Reflect.ownKeys(raw).some(key => typeof key !== 'string')
    || Reflect.ownKeys(raw).sort().join('|') !== [...fields].sort().join('|')
    || Object.values(Object.getOwnPropertyDescriptors(raw)).some(value => !value.enumerable || !Object.hasOwn(value, 'value')))
    fail('source_snapshot_unavailable');
}
async function bounded<T>(call: () => Promise<T>, timeout: number, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) fail('source_provider_aborted');
  let timer: ReturnType<typeof setTimeout> | undefined, stop!: () => void;
  const halted = new Promise<never>((_, reject) => {
    stop = () => reject(new Error('source_provider_aborted'));
    signal?.addEventListener('abort', stop, { once: true });
    timer = setTimeout(() => reject(new Error('source_provider_timeout')), timeout);
  });
  try {
    const result = await Promise.race([halted, Promise.resolve().then(() => {
      if (signal?.aborted) fail('source_provider_aborted'); return call();
    })]);
    if (signal?.aborted) fail('source_provider_aborted'); return result;
  } finally { if (timer) clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}

/** Only reads an independently validated published source. No model inside the source transaction. */
export function createCurrentSourcePropositionReader(store: PersistentArgumentProjectionStore) {
  const reader = store.withActiveBinding?.bind(store);
  return async (ref: ArgumentProjectionSourceRef): Promise<CurrentSourcePropositionSnapshot | null> => {
    if (!reader) fail('active_publication_binding_unavailable');
    return reader!(ref, async (result, input, binding) => ({ input, result, binding }));
  };
}
/** Dormant real host adapter; creation does not read configuration or invoke a model. */
export function createSavedSourcePropositionModel(config: ArgumentReferenceModelConfig, adapter: Pick<ArgumentReferenceModelAdapter, 'invoke'>,
  options: SourcePropositionBuildModelOptions = {}) {
  const saved = structuredClone(config), invoke = adapter.invoke.bind(adapter);
  return createSourcePropositionBuildModel((request, signal) => {
    if (!signal) return Promise.reject(new Error('source_proposition_signal_required'));
    return invoke(structuredClone(saved), request, signal);
  }, options);
}

/**
 * Host-only bounded audit cache with optional persistent derived storage. Build is a SEPARATE explicit two-call
 * action, not an extension of the old three-call reference consent. Question
 * preparation reads only; restart/revoke/cache misses do not trigger models.
 * Durable storage must independently authenticate the current publication.
 */
export function createReferenceSourcePropositionProvider(options: ReferenceSourcePropositionProviderOptions) {
  const onDiagnostic = options.onDiagnostic;
  const readCurrent = options.readCurrent.bind(options), sourceModel = options.model;
  const model: SourcePropositionBuildModel | undefined = sourceModel ? {
    draft: sourceModel.draft.bind(sourceModel), review: sourceModel.review.bind(sourceModel),
    ...(sourceModel.prepareDraft ? { prepareDraft: sourceModel.prepareDraft.bind(sourceModel) } : {}),
    ...(sourceModel.prepareReview ? { prepareReview: sourceModel.prepareReview.bind(sourceModel) } : {}),
  } : undefined;
  const assertModelCurrent = options.assertModelCurrent?.bind(options);
  const storage: PersistentSourcePropositionStore | undefined = options.storage
    ? { read: options.storage.read.bind(options.storage), publish: options.storage.publish.bind(options.storage) } : undefined;
  const readTimeout = Number.isFinite(options.readTimeoutMs) ? Math.max(1, Math.min(30000, Math.floor(options.readTimeoutMs!))) : 10000;
  const cache = new Map<string, { fingerprint: string; proof: SourcePropositionProof; characters: number }>();
  const pending = new Map<string, AbortController>(); let generation = 0;
  const key = (ref: ArgumentProjectionSourceRef) => JSON.stringify([ref.kind, ref.entityId]);
  function revoke() { generation++; cache.clear(); for (const controller of pending.values()) controller.abort(); pending.clear(); }
  function guard(epoch: number, signal?: AbortSignal) {
    if (generation !== epoch) fail('source_provider_revoked'); if (signal?.aborted) fail('source_provider_aborted');
  }
  async function current(ref: ArgumentProjectionSourceRef, epoch: number, signal?: AbortSignal) {
    guard(epoch, signal);
    const raw = await bounded<CurrentSourcePropositionSnapshot | null>(() => readCurrent(structuredClone(ref)), readTimeout, signal);
    guard(epoch, signal);
    if (!raw) { cache.delete(key(ref)); fail('source_snapshot_unavailable'); }
    closed(raw, ['input', 'result', 'binding']); closed(raw.binding, ['publicationId', 'epoch', 'resultHash', 'structureHash']);
    const snapshot = structuredClone(raw);
    if (snapshot.input.source.kind !== ref.kind || snapshot.input.source.entityId !== ref.entityId
      || snapshot.input.sourceQualification.status !== 'eligible' || !['reviewed_complete', 'reviewed_scoped'].includes(snapshot.result.status)
      || snapshot.result.projection.quality.status !== 'eligible' || snapshot.result.projection.build.origin !== 'validated-projection'
      || typeof snapshot.binding.publicationId !== 'string' || !snapshot.binding.publicationId.trim() || snapshot.binding.publicationId.length > 300
      || !Number.isSafeInteger(snapshot.binding.epoch) || snapshot.binding.epoch < 1
      || snapshot.binding.resultHash !== snapshot.result.resultHash || snapshot.binding.structureHash !== snapshot.result.authority.structureHash)
      { cache.delete(key(ref)); fail('source_snapshot_unavailable'); }
    const fingerprint = await argumentContextHash(snapshot); guard(epoch, signal);
    if (cache.has(key(ref)) && cache.get(key(ref))!.fingerprint !== fingerprint) cache.delete(key(ref));
    return { snapshot, fingerprint };
  }
  async function saved(ref: ArgumentProjectionSourceRef, fresh: Awaited<ReturnType<typeof current>>, epoch: number, signal?: AbortSignal): Promise<SourcePropositionProof | null> {
    const cached = cache.get(key(ref));
    if (cached) return structuredClone(cached.proof);
    if (!storage) return null;
    const proof = await bounded<SourcePropositionProof | null>(() => storage.read(structuredClone(ref), () => guard(epoch, signal)), readTimeout, signal);
    guard(epoch, signal);
    if (!proof) return null;
    const verified = await validateSourcePropositions(fresh.snapshot.input, fresh.snapshot.result, proof.bundle,
      { draft: proof.draft, review: proof.review });
    guard(epoch, signal);
    if (verified.status !== 'ready') fail('source_proof_unavailable');
    // Disk read permission/freshness is checked by the independent store. The
    // caller still re-reads the original publication after preparing the view.
    return structuredClone(proof);
  }
  async function build(originalRef: ArgumentProjectionSourceRef,
    originalOptions: { consent?: 'process-reference-propositions'; signal?: AbortSignal; timeoutMs?: number } = {}) {
    const ref = structuredClone(originalRef), consent = originalOptions.consent, signal = originalOptions.signal, timeoutMs = originalOptions.timeoutMs;
    const epoch = generation;
    try { validateArgumentProjectionSourceRef(ref); } catch { return held('invalid_source_selector'); }
    if (consent !== 'process-reference-propositions') return held('explicit_proposition_consent_required');
    if (!model) return held('explicit_model_required');
    const id = key(ref); if (pending.has(id)) return held('source_build_pending');
    if (pending.size >= SOURCE_PROPOSITION_PROVIDER_LIMITS.pending) return held('source_build_capacity');
    const controller = new AbortController(), abort = () => controller.abort();
    let actualRequests = counts();
    if (signal?.aborted) controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    pending.set(id, controller);
    try {
      const original = await current(ref, epoch, controller.signal);
      const assertCurrent = async () => {
        guard(epoch, controller.signal);
        if (assertModelCurrent) await bounded(assertModelCurrent, readTimeout, controller.signal);
        const fresh = await current(ref, epoch, controller.signal);
        if (fresh.fingerprint !== original.fingerprint) fail('source_snapshot_changed');
      };
      const previous = await saved(ref, original, epoch, controller.signal);
      if (previous) {
        const verified = await validateSourcePropositions(original.snapshot.input, original.snapshot.result, previous.bundle,
          { draft: previous.draft, review: previous.review });
        await assertCurrent();
        if (verified.status !== 'ready') { cache.delete(id); return held('source_proof_unavailable'); }
        return { status: 'ready' as const, bundle: structuredClone(verified.bundle), proof: structuredClone(previous),
          modelRequests: counts(), reused: true, retention: storage ? 'persistent' as const : 'ephemeral' as const };
      }
      if (cache.size >= SOURCE_PROPOSITION_PROVIDER_LIMITS.entries
        || [...cache.values()].reduce((sum, entry) => sum + entry.characters, 0) >= SOURCE_PROPOSITION_PROVIDER_LIMITS.cacheCharacters)
        return held('source_cache_capacity');
      const built = await buildSourcePropositions(original.snapshot.input, original.snapshot.result, model,
        { signal: controller.signal, timeoutMs, readTimeoutMs: readTimeout, assertCurrent, onDiagnostic });
      actualRequests = { ...built.modelRequests };
      if (built.status !== 'ready') return built;
      // All asynchronous freshness checks are performed by the pipeline; check
      // the captured cache lease once more before the synchronous insertion.
      guard(epoch, controller.signal);
      const characters = JSON.stringify(built.proof).length;
      if (characters > SOURCE_PROPOSITION_PROVIDER_LIMITS.proofCharacters || cache.size >= SOURCE_PROPOSITION_PROVIDER_LIMITS.entries
        || [...cache.values()].reduce((sum, entry) => sum + entry.characters, 0) + characters > SOURCE_PROPOSITION_PROVIDER_LIMITS.cacheCharacters)
        return { ...held('source_cache_capacity'), modelRequests: built.modelRequests };
      if (storage) {
        const persisted = await bounded(() => storage.publish(structuredClone(ref), structuredClone(original.snapshot.binding),
          structuredClone(built.proof), () => guard(epoch, controller.signal)), readTimeout, controller.signal);
        guard(epoch, controller.signal);
        if (persisted.status !== 'stored' || persisted.bundleHash !== built.bundle.bundleHash)
          return { ...held('source_storage_unavailable'), modelRequests: built.modelRequests };
        // Do not retain a result if the source changed just after the durable
        // commit. A file already renamed is not rolled back by cancellation.
        await assertCurrent();
      }
      cache.set(id, { fingerprint: original.fingerprint, proof: structuredClone(built.proof), characters });
      return { ...built, reused: false, retention: storage ? 'persistent' as const : 'ephemeral' as const };
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const reason = code.startsWith('source_proposition_store_') || code.startsWith('argument_source_proposition_store_')
        ? 'source_storage_unavailable'
        : ['source_provider_aborted', 'source_provider_timeout', 'source_provider_revoked', 'source_snapshot_changed'].includes(code)
          ? code : 'source_snapshot_unavailable';
      return { ...held(reason), modelRequests: actualRequests };
    } finally {
      // A timed-out storage operation may still be unwinding. Its synchronous
      // guard must no longer permit a late durable commit after this run ended.
      controller.abort(); signal?.removeEventListener('abort', abort);
      if (pending.get(id) === controller) pending.delete(id);
    }
  }
  async function loadForQuestion(original: ArgumentReferenceDisclosureContext) {
    const context = structuredClone(original), epoch = generation, controller = new AbortController();
    try {
      const refs = [...new Map(context.frames.map(frame => {
        const ref: ArgumentProjectionSourceRef = { kind: frame.source.kind, entityId: frame.source.entityId };
        validateArgumentProjectionSourceRef(ref); return [key(ref), ref];
      })).values()];
      const sources: SourcePropositionProof[] = [], snapshots = new Map<string, string>();
      for (const ref of refs) {
        const fresh = await current(ref, epoch, controller.signal), retained = await saved(ref, fresh, epoch, controller.signal);
        if (!retained) return held('source_propositions_not_built');
        const verified = await validateSourcePropositions(fresh.snapshot.input, fresh.snapshot.result, retained.bundle,
          { draft: retained.draft, review: retained.review });
        if (verified.status !== 'ready') { cache.delete(key(ref)); return held('source_proof_unavailable'); }
        sources.push(structuredClone(retained)); snapshots.set(key(ref), fresh.fingerprint);
      }
      const projected = await projectReferenceSourcePropositions(context, sources);
      if (projected.status !== 'ready') return projected;
      for (const ref of refs) if ((await current(ref, epoch, controller.signal)).fingerprint !== snapshots.get(key(ref))) return held('source_snapshot_changed');
      guard(epoch, controller.signal);
      return projected;
    } catch { return held('source_propositions_unavailable'); }
    finally { controller.abort(); }
  }
  async function preparePropositions(context: ArgumentReferenceDisclosureContext) {
    const reply = await loadForQuestion(context); return reply.status === 'ready' ? { bundle: reply.bundle, proof: reply.proof } : null;
  }
  return { build, loadForQuestion, preparePropositions, revoke };
}
