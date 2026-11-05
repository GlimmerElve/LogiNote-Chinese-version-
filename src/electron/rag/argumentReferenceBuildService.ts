import { randomUUID } from 'node:crypto';
import { types as nodeUtilTypes } from 'node:util';
import { argumentContextHash } from '../../services/argumentContext/hash.ts';
import { buildArgumentProjectionExtractionRequest, buildArgumentProjectionSelectionRequest, buildArgumentProjectionReviewRequest,
  buildArgumentProjectionSourceReviewRequest, buildArgumentProjectionTaskReviewRequest,
  type ArgumentProjectionModelRequest } from '../../services/argumentContext/buildPrompts.ts';
import { finalizeArgumentProjectionBuild, getArgumentProjectionReviewRowDiagnostic, readArgumentProjectionDraft,
  buildArgumentProjectionSourceReviewInput, readArgumentProjectionSourceReview,
  buildArgumentProjectionTaskReviewInput, readArgumentProjectionTaskReview,
  verifyArgumentProjectionBuildResult } from '../../services/argumentContext/construction.ts';
import { readArgumentProjectionSelection } from '../../services/argumentContext/modelDraftSelection.ts';
import { ARGUMENT_PROJECTION_BUILD_LIMITS, type ArgumentProjectionBuildInput, type ArgumentProjectionBuildResult,
  type ArgumentProjectionReview } from '../../services/argumentContext/buildTypes.ts';
import type { ArgumentContextScope } from '../../services/argumentContext/types.ts';
import type { ArgumentReferenceBuildCancelReply, ArgumentReferenceBuildCounts, ArgumentReferenceBuildPrepareReply,
  ArgumentReferenceBuildReason, ArgumentReferenceBuildRunReply, ArgumentReferenceBuildSourceIdentity,
  ArgumentReferenceBuildSourceRequest, ArgumentReferenceBuildStatusReply, ArgumentReferenceBuildSummary } from '../../services/argumentContext/referenceBuildTypes.ts';
import type { createArgumentProjectionEnvironmentRegistry, ArgumentProjectionRoots } from './argumentProjectionEnvironment.ts';
import type { ArgumentProjectionRuntime } from './argumentProjectionRuntime.ts';
import { validateArgumentProjectionSourceRef, type ArgumentProjectionSourceRef } from './argumentProjectionAuthority.ts';
import { readArgumentReferenceProvenance, buildArgumentReferenceQualificationRequest, resolveArgumentReferenceQualification,
  type ArgumentReferenceProvenance, type ArgumentReferenceQualificationRequest } from './argumentReferencePolicy.ts';
import { argumentReferenceModel, type ArgumentReferenceModelAdapter, type ArgumentReferenceModelConfig } from './argumentReferenceModel.ts';
import type { NoteItem } from '../../types.ts';
import { createArgumentReferenceNoteObservations, type ArgumentReferenceNoteObservation } from './argumentReferenceNoteObservations.ts';

export const ARGUMENT_REFERENCE_BUILD_LIMITS = { ticketsPerOwner: 8, ticketTtlMs: 10 * 60 * 1000, inflight: 2 } as const;
let globalInflight = 0;
type Environments = Pick<ReturnType<typeof createArgumentProjectionEnvironmentRegistry>, 'withEnvironment'>;
const MODEL_DIAGNOSTIC_CODES = [
  'argument_projection_invalid_selection',
  'argument_projection_invalid_shape', 'argument_projection_invalid_string', 'argument_projection_invalid_array',
  'argument_projection_invalid_ids', 'argument_projection_invalid_enum', 'argument_projection_invalid_boolean',
  'argument_projection_invalid_id', 'argument_projection_duplicate_id', 'argument_projection_invalid_json',
  'argument_projection_response_budget', 'argument_projection_unknown_quote', 'argument_projection_draft_binding_mismatch',
  'argument_projection_missing_draft_scope', 'argument_projection_orphan_relation', 'argument_projection_self_relation',
  'argument_projection_copied_self_support', 'argument_projection_orphan_group', 'argument_projection_invalid_group_members',
  'argument_projection_invalid_group_relation', 'argument_projection_orphan_scope', 'argument_projection_duplicate_scope',
  'argument_projection_scope_missing_endpoint', 'argument_projection_scope_missing_group_member',
  'argument_projection_review_binding_mismatch', 'argument_projection_missing_review_slot',
  'argument_projection_unknown_review_slot', 'argument_projection_review_evidence_mismatch',
  'argument_projection_unsupported_accept', 'argument_projection_review_direction_changed',
  'argument_projection_review_operator_changed', 'argument_projection_unknown_operator_accept',
  'argument_projection_source_coverage_mismatch',
  'argument_reference_policy_invalid_shape', 'argument_reference_policy_invalid_json',
  'argument_reference_policy_response_budget', 'argument_reference_policy_invalid_review',
  'argument_reference_policy_invalid_quote', 'argument_reference_policy_unsupported_eligibility',
] as const;
const BUILD_DIAGNOSTIC_REASONS: readonly ArgumentReferenceBuildReason[] = [
  'invalid_request', 'environment_changed', 'scope_denied', 'source_missing', 'source_pending', 'source_changed',
  'source_unavailable', 'provenance_unavailable', 'model_unavailable', 'model_changed', 'request_budget',
  'ticket_unavailable', 'ticket_expired', 'cancelled', 'capacity', 'qualification_rejected',
  'model_response_invalid', 'model_failed', 'review_incomplete', 'publication_rejected',
];
export interface ArgumentReferenceBuildDiagnostic {
  stage: 'source-preflight' | 'source-quality' | 'structure-extraction' | 'structure-review' | 'publication';
  code: ArgumentReferenceBuildReason | typeof MODEL_DIAGNOSTIC_CODES[number];
  row?: NonNullable<ReturnType<typeof getArgumentProjectionReviewRowDiagnostic>>;
}
export interface ArgumentReferenceBuildServiceOptions {
  environments: Environments; model?: ArgumentReferenceModelAdapter; now?: () => number;
  /** Host-only explicit protocol; legacy stays strict and there is no fallback. */
  draftProtocol?: 'legacy-v1' | 'selection-v2';
  /** Independent full-source obligations, not candidate-only completeness votes. */
  reviewProtocol?: 'legacy-v1' | 'source-grounded-v2' | 'task-grounded-v3';
  /** Optional host-only observer, called synchronously but never awaited. No renderer authority or public IPC fields. */
  onDiagnostic?: (diagnostic: Readonly<ArgumentReferenceBuildDiagnostic>) => void;
}
interface SourceSnapshot { input: ArgumentProjectionBuildInput; inputHash: string; provenance: ArgumentReferenceProvenance }
interface Ticket {
  id: string; owner: number; environmentId: string; ref: ArgumentProjectionSourceRef; expiresAt: number; epoch: number; ownerEpoch: number;
  snapshot: SourceSnapshot; model: ArgumentReferenceModelConfig; qualification: ArgumentReferenceQualificationRequest;
  noteObservation: ArgumentReferenceNoteObservation;
  summary: ArgumentReferenceBuildSummary; abort: AbortController; stopReason?: 'cancelled' | 'environment_changed' | 'ticket_expired' | 'source_changed';
  job?: Promise<ArgumentReferenceBuildRunReply>; result?: ArgumentReferenceBuildRunReply;
}
const fail = (code: ArgumentReferenceBuildReason): never => { throw new Error(`argument_reference_build_${code}`); };
function closed(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))
    || keys.some(key => !Object.hasOwn(value, key))) fail('invalid_request');
}
function opaqueId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,300}$/u.test(value)) fail('invalid_request');
}
function ownerShape(owner: number): void { if (!Number.isSafeInteger(owner) || owner < 0) fail('invalid_request'); }
function sourceRequest(value: unknown): ArgumentReferenceBuildSourceRequest {
  const request = structuredClone(value); closed(request, ['environmentId', 'ref']); opaqueId(request.environmentId);
  try { validateArgumentProjectionSourceRef(request.ref); } catch { return fail('invalid_request'); }
  return request as unknown as ArgumentReferenceBuildSourceRequest;
}
function ticketRequest(value: unknown, run: boolean): { environmentId: string; ticketId: string } {
  const request = structuredClone(value); closed(request, run ? ['environmentId', 'ticketId', 'consent'] : ['environmentId', 'ticketId']);
  opaqueId(request.environmentId); opaqueId(request.ticketId);
  if (run && request.consent !== 'process-reference') fail('invalid_request');
  return { environmentId: request.environmentId, ticketId: request.ticketId };
}
function sourceIdentity(input: ArgumentProjectionBuildInput): ArgumentReferenceBuildSourceIdentity {
  return { kind: input.source.kind as ArgumentProjectionSourceRef['kind'], entityId: input.source.entityId,
    version: input.source.version, contentHash: input.source.contentHash };
}
function counts(result: ArgumentProjectionBuildResult): ArgumentReferenceBuildCounts {
  return { nodes: result.projection.nodes.length, relations: result.projection.relations.length,
    groups: result.projection.prerequisiteGroups.length, scopes: result.projection.build.scopes.length };
}
function modelObject(raw: string): unknown {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > 96000) fail('model_response_invalid');
  const text = raw.trim(), match = /^```(?:json)?\s*([\s\S]*?)\s*```$/u.exec(text);
  try { return JSON.parse(match ? match[1] : text); } catch { return fail('model_response_invalid'); }
}
function requestBudget(request: ArgumentProjectionModelRequest): void {
  if (request.systemPrompt.length + request.userInput.length > ARGUMENT_PROJECTION_BUILD_LIMITS.requestCharacters) fail('request_budget');
}
function reason(error: unknown): ArgumentReferenceBuildReason {
  const message = error instanceof Error ? error.message : '';
  const prefix = 'argument_reference_build_';
  if (message.startsWith(prefix)) return message.slice(prefix.length) as ArgumentReferenceBuildReason;
  if (message.includes('environment_changed') || message === 'environment_changed') return 'environment_changed';
  if (message.includes('scope_denied')) return 'scope_denied';
  if (message.includes('save_in_progress')) return 'source_pending';
  if (message.includes('source_changed') || message.includes('snapshot_changed') || message.includes('cas_mismatch')) return 'source_changed';
  if (message.includes('request_budget') || message.includes('serialized_budget')) return 'request_budget';
  if (message.startsWith('argument_reference_model_')) return message.endsWith('response_invalid') ? 'model_response_invalid' : 'model_unavailable';
  if (/^argument_reference_policy_(?:invalid_shape|invalid_json|response_budget|invalid_review|invalid_quote|unsupported_eligibility)$/u.test(message)) return 'model_response_invalid';
  if (message.startsWith('argument_reference_policy_')) return 'provenance_unavailable';
  if (message.startsWith('argument_projection_store_') || message.startsWith('argument_source_admission_')) return 'publication_rejected';
  if (message.startsWith('argument_projection_') || message.startsWith('argument_context_')) return 'model_response_invalid';
  return 'source_unavailable';
}

/**
 * Host-owned two-step consent boundary. Preparation does not invoke any model. Each run makes at most
 * one source-quality call, one extraction call and one independent structure review, with no retries.
 * Source transactions are short: never hold them across a provider request or user decision.
 * Cancellation stops future work; a derived ledger already renamed cannot be rolled back by cancel.
 */
export function createArgumentReferenceBuildService(options: ArgumentReferenceBuildServiceOptions) {
  const environments = options.environments, model = options.model ?? argumentReferenceModel, now = options.now ?? Date.now;
  const draftProtocol = options.draftProtocol ?? 'legacy-v1';
  if (!['legacy-v1', 'selection-v2'].includes(draftProtocol)) throw new Error('argument_reference_build_invalid_request');
  const extractionRequest = draftProtocol === 'selection-v2' ? buildArgumentProjectionSelectionRequest : buildArgumentProjectionExtractionRequest;
  const extractionReader = draftProtocol === 'selection-v2' ? readArgumentProjectionSelection : readArgumentProjectionDraft;
  const reviewProtocol = options.reviewProtocol ?? 'legacy-v1';
  if (!['legacy-v1', 'source-grounded-v2', 'task-grounded-v3'].includes(reviewProtocol)) throw new Error('argument_reference_build_invalid_request');
  function diagnose(stage: ArgumentReferenceBuildDiagnostic['stage'], error: unknown): void {
    if (!options.onDiagnostic) return;
    // Only exact host-defined codes survive. Do not forward arbitrary provider messages,
    // model field names, note identities, source text, host paths or configuration.
    const message = error instanceof Error ? error.message : '';
    const code = MODEL_DIAGNOSTIC_CODES.find(candidate => candidate === message)
      ?? BUILD_DIAGNOSTIC_REASONS.find(candidate => candidate === reason(error)) ?? 'source_unavailable';
    const row = getArgumentProjectionReviewRowDiagnostic(error);
    try {
      const returned: unknown = options.onDiagnostic(Object.freeze({ stage, code, ...(row ? { row: structuredClone(row) } : {}) }));
      // A void callback may still return an async rejection. Observe only native
      // promises, including cross-realm ones; never assimilate arbitrary thenables
      // or read a callback result's then/catch getter. Do not await diagnostics.
      if (nodeUtilTypes.isPromise(returned)) void Promise.prototype.then.call(returned, undefined, () => undefined);
    }
    catch { /* Observability must not create authority, retry work, or replace a held reply. */ }
  }
  const tickets = new Map<string, Ticket>(), ownerEpochs = new Map<number, number>();
  const noteObservations = createArgumentReferenceNoteObservations();
  let epoch = 0;
  const held = (reasonCode: ArgumentReferenceBuildReason): { status: 'held'; reasonCode: ArgumentReferenceBuildReason } => ({ status: 'held', reasonCode });
  function revoke(owner?: number): void {
    if (owner === undefined) { epoch++; noteObservations.reset(); }
    else ownerEpochs.set(owner, (ownerEpochs.get(owner) ?? 0) + 1);
    for (const ticket of tickets.values()) {
      if (owner !== undefined && ticket.owner !== owner) continue;
      ticket.stopReason = 'environment_changed'; ticket.abort.abort(); tickets.delete(ticket.id);
    }
  }
  function guard(ticket: Ticket): void {
    if (ticket.stopReason) fail(ticket.stopReason);
    if (ticket.epoch !== epoch || ticket.ownerEpoch !== (ownerEpochs.get(ticket.owner) ?? 0)
      || tickets.get(ticket.id) !== ticket) fail('environment_changed');
    if (!noteObservations.current(ticket.noteObservation)) {
      ticket.stopReason = 'source_changed'; ticket.abort.abort(); fail('source_changed');
    }
    if (now() >= ticket.expiresAt) { ticket.stopReason = 'ticket_expired'; ticket.abort.abort(); fail('ticket_expired'); }
  }
  function sweep(): void {
    for (const ticket of tickets.values()) if (now() >= ticket.expiresAt) {
      ticket.stopReason = 'ticket_expired'; ticket.abort.abort(); tickets.delete(ticket.id);
    }
  }
  async function saved(runtime: ArgumentProjectionRuntime, roots: ArgumentProjectionRoots, ref: ArgumentProjectionSourceRef,
    scope: ArgumentContextScope): Promise<SourceSnapshot> {
    return runtime.host.withSource(ref, async input => {
      if (!input) return fail('source_missing');
      const provenance = await readArgumentReferenceProvenance(roots, input, scope);
      return { input, inputHash: await argumentContextHash(input), provenance };
    });
  }
  async function check(ticket: Ticket): Promise<void> {
    guard(ticket);
    await environments.withEnvironment(ticket.owner, ticket.environmentId, async (runtime, roots, scope) => {
      guard(ticket);
      const config = await model.read(roots); guard(ticket);
      if (config.fingerprint !== ticket.model.fingerprint) fail('model_changed');
      const snapshot = await saved(runtime, roots, ticket.ref, scope); guard(ticket);
      if (snapshot.inputHash !== ticket.snapshot.inputHash || snapshot.provenance.fingerprint !== ticket.snapshot.provenance.fingerprint) fail('source_changed');
    });
    guard(ticket);
  }
  async function invoke(ticket: Ticket, request: ArgumentProjectionModelRequest): Promise<string> {
    requestBudget(request);
    await check(ticket); guard(ticket);
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error(`argument_reference_build_${ticket.stopReason ?? (now() >= ticket.expiresAt ? 'ticket_expired' : 'cancelled')}`));
      ticket.abort.signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      let output: string;
      try { output = await Promise.race([model.invoke(structuredClone(ticket.model), structuredClone(request), ticket.abort.signal), aborted]); }
      catch (error) {
        guard(ticket);
        if (error instanceof Error && error.message === 'argument_reference_model_response_invalid') fail('model_response_invalid');
        fail('model_failed');
      }
      // Even successful, late responses are never transformed into qualification/publication authority.
      await check(ticket); return output;
    } finally { if (onAbort) ticket.abort.signal.removeEventListener('abort', onAbort); }
  }
  async function status(owner: number, value: unknown): Promise<ArgumentReferenceBuildStatusReply> {
    try {
      ownerShape(owner); const request = sourceRequest(value);
      return await environments.withEnvironment(owner, request.environmentId, async (runtime, roots, scope) => {
        // Synchronize observed qualification changes first. Provenance may itself
        // reject a corrupt/changed dependency; that error must not skip the durable
        // invalidation and later let restored A revive an already-observed old graph.
        const active = await runtime.store.read(request.ref), snapshot = await saved(runtime, roots, request.ref, scope);
        if (active && active.buildId === snapshot.input.buildId && ['reviewed_complete', 'reviewed_scoped'].includes(active.status)
          && snapshot.input.sourceQualification.status === 'eligible') {
          return { status: 'available', source: sourceIdentity(snapshot.input), sourceQualification: 'eligible', counts: counts(active) };
        }
        return { status: 'missing', source: sourceIdentity(snapshot.input), sourceQualification: snapshot.input.sourceQualification.status,
          reasonCode: 'review_incomplete' };
      });
    } catch (error) { return held(reason(error)); }
  }
  async function prepare(owner: number, value: unknown): Promise<ArgumentReferenceBuildPrepareReply> {
    try {
      ownerShape(owner); const request = sourceRequest(value); sweep();
      const preparingEpoch = epoch, preparingOwnerEpoch = ownerEpochs.get(owner) ?? 0;
      const observationStart = noteObservations.begin();
      return await environments.withEnvironment(owner, request.environmentId, async (runtime, roots, scope) => {
        const active = await runtime.store.read(request.ref), snapshot = await saved(runtime, roots, request.ref, scope);
        const noteObservation = noteObservations.capture(observationStart,
          [snapshot.input.source, ...snapshot.provenance.internalReferences.map(reference => reference.source)]);
        if (active && active.buildId === snapshot.input.buildId && ['reviewed_complete', 'reviewed_scoped'].includes(active.status)
          && snapshot.input.sourceQualification.status === 'eligible') {
          return { status: 'available', environmentId: request.environmentId, source: sourceIdentity(snapshot.input),
            sourceQualification: 'eligible', counts: counts(active) };
        }
        if (snapshot.provenance.status === 'missing') fail('provenance_unavailable');
        const config = await model.read(roots);
        const qualification = await buildArgumentReferenceQualificationRequest(snapshot.input, snapshot.provenance);
        requestBudget(qualification.request);
        requestBudget(await extractionRequest(snapshot.input));
        // Review depends on the future draft; do not claim that its full payload fits yet.
        const current = await saved(runtime, roots, request.ref, scope), afterModel = await model.read(roots);
        if (current.inputHash !== snapshot.inputHash || current.provenance.fingerprint !== snapshot.provenance.fingerprint) fail('source_changed');
        if (afterModel.fingerprint !== config.fingerprint) fail('model_changed');
        if (preparingEpoch !== epoch || preparingOwnerEpoch !== (ownerEpochs.get(owner) ?? 0)) fail('environment_changed');
        if (!noteObservations.current(noteObservation)) fail('source_changed');
        sweep();
        const existing = [...tickets.values()].find(ticket => ticket.owner === owner && ticket.environmentId === request.environmentId
          && ticket.snapshot.inputHash === snapshot.inputHash && ticket.snapshot.provenance.fingerprint === snapshot.provenance.fingerprint
          && ticket.model.fingerprint === config.fingerprint && !ticket.stopReason && !ticket.job);
        if (existing) return { status: 'prepared', environmentId: request.environmentId, ticketId: existing.id,
          expiresAt: new Date(existing.expiresAt).toISOString(), summary: structuredClone(existing.summary) };
        if ([...tickets.values()].filter(ticket => ticket.owner === owner).length >= ARGUMENT_REFERENCE_BUILD_LIMITS.ticketsPerOwner) fail('capacity');
        const summary: ArgumentReferenceBuildSummary = { sourceKind: request.ref.kind, entityId: snapshot.input.source.entityId,
          sourceVersion: snapshot.input.source.version, contentHash: snapshot.input.source.contentHash,
          characters: snapshot.input.canonicalText.length, sentences: snapshot.input.hierarchy.sentences.length, chunks: snapshot.input.chunks.length,
          providerLabel: config.providerLabel, modelName: config.modelName, isRemote: config.isRemote,
          maximumModelRequests: 3, reviewBudget: 'checked-after-extraction' };
        const ticket: Ticket = { id: randomUUID(), owner, environmentId: request.environmentId, ref: structuredClone(request.ref),
          expiresAt: now() + ARGUMENT_REFERENCE_BUILD_LIMITS.ticketTtlMs, epoch, ownerEpoch: preparingOwnerEpoch,
          snapshot, noteObservation, model: structuredClone(config), qualification, summary, abort: new AbortController() };
        tickets.set(ticket.id, ticket);
        return { status: 'prepared', environmentId: request.environmentId, ticketId: ticket.id,
          expiresAt: new Date(ticket.expiresAt).toISOString(), summary: structuredClone(summary) };
      });
    } catch (error) { return held(reason(error)); }
  }
  async function process(ticket: Ticket): Promise<ArgumentReferenceBuildRunReply> {
    let built: ArgumentProjectionBuildResult | undefined;
    let stage: ArgumentReferenceBuildDiagnostic['stage'] = 'source-preflight';
    try {
      await check(ticket);
      stage = 'source-quality';
      const rawQuality = await invoke(ticket, ticket.qualification.request);
      const sourceReview = await resolveArgumentReferenceQualification(ticket.snapshot.input, ticket.snapshot.provenance,
        ticket.qualification, modelObject(rawQuality), true, new Date(now()).toISOString());
      // The response is bound to the deterministic request reviewId; ledger identity denotes THIS
      // actual run. A later user-authorized retry must not collide on changed reason/reviewedAt.
      sourceReview.reviewId = `${sourceReview.reviewId}-${ticket.id}`;
      await check(ticket);
      const qualified = await environments.withEnvironment(ticket.owner, ticket.environmentId, async runtime => {
        guard(ticket); return runtime.recordSourceReview(ticket.snapshot.input, sourceReview, () => guard(ticket));
      });
      // Qualification intentionally changes derived binding, never the original source identity/provenance.
      ticket.snapshot = { ...ticket.snapshot, input: qualified, inputHash: await argumentContextHash(qualified) };
      await check(ticket);
      if (qualified.sourceQualification.status !== 'eligible') return held('qualification_rejected');
      stage = 'structure-extraction';
      const extraction = await extractionRequest(qualified);
      const rawDraft = await invoke(ticket, extraction);
      const draft = await extractionReader(draftProtocol === 'selection-v2' ? rawDraft : modelObject(rawDraft), qualified);
      stage = 'structure-review';
      const sourceReviewInput = reviewProtocol === 'task-grounded-v3' ? await buildArgumentProjectionTaskReviewInput(qualified, draft)
        : reviewProtocol === 'source-grounded-v2' ? await buildArgumentProjectionSourceReviewInput(qualified, draft) : undefined;
      const reviewRequest = reviewProtocol === 'task-grounded-v3' ? await buildArgumentProjectionTaskReviewRequest(qualified, draft)
        : reviewProtocol === 'source-grounded-v2' ? await buildArgumentProjectionSourceReviewRequest(qualified, draft) : await buildArgumentProjectionReviewRequest(qualified, draft);
      const rawReview = await invoke(ticket, reviewRequest);
      const review = sourceReviewInput ? reviewProtocol === 'task-grounded-v3'
        ? await readArgumentProjectionTaskReview(rawReview, sourceReviewInput)
        : await readArgumentProjectionSourceReview(rawReview, sourceReviewInput as import('../../services/argumentContext/buildTypes.ts').ArgumentProjectionSourceReviewInput)
        : modelObject(rawReview) as ArgumentProjectionReview;
      built = await finalizeArgumentProjectionBuild(qualified, draft, review);
      const proof = { input: qualified, draft, review };
      stage = 'publication';
      await verifyArgumentProjectionBuildResult(built, proof);
      await check(ticket);
      const publication = await environments.withEnvironment(ticket.owner, ticket.environmentId, async runtime => {
        guard(ticket);
        return runtime.store.publish({ publicationId: `reference-build-${ticket.id}`, result: built!, proof,
          expectedActiveHash: null }, () => guard(ticket));
      });
      guard(ticket);
      if (publication.status !== 'published') return { ...held('review_incomplete'), counts: counts(built) };
      return { status: 'published', counts: counts(built) };
    } catch (error) { diagnose(stage, error); return { ...held(reason(error)), ...(built ? { counts: counts(built) } : {}) }; }
  }
  async function run(owner: number, value: unknown): Promise<ArgumentReferenceBuildRunReply> {
    try {
      ownerShape(owner); const request = ticketRequest(value, true), ticket = tickets.get(request.ticketId);
      if (!ticket || ticket.owner !== owner || ticket.environmentId !== request.environmentId) fail('ticket_unavailable');
      guard(ticket);
      if (ticket.result) return structuredClone(ticket.result);
      if (ticket.job) return structuredClone(await ticket.job);
      if (globalInflight >= ARGUMENT_REFERENCE_BUILD_LIMITS.inflight) fail('capacity');
      globalInflight++;
      ticket.job = process(ticket).then(reply => { ticket.result = structuredClone(reply); return reply; }).finally(() => { globalInflight--; });
      return structuredClone(await ticket.job);
    } catch (error) { return held(reason(error)); }
  }
  async function cancel(owner: number, value: unknown): Promise<ArgumentReferenceBuildCancelReply> {
    try {
      ownerShape(owner); const request = ticketRequest(value, false), ticket = tickets.get(request.ticketId);
      if (!ticket || ticket.owner !== owner || ticket.environmentId !== request.environmentId || ticket.result) fail('ticket_unavailable');
      ticket.stopReason = 'cancelled'; ticket.abort.abort(); tickets.delete(ticket.id); return { status: 'cancelled' };
    } catch (error) { return held(reason(error)); }
  }
  /** Host-only observation before a saved application snapshot, never an IPC authority. */
  function observeNoteSnapshot(next: NoteItem[], previous: NoteItem[]): void {
    noteObservations.observe(next, previous);
    for (const ticket of tickets.values()) if (!ticket.stopReason && !noteObservations.current(ticket.noteObservation)) {
      ticket.stopReason = 'source_changed'; ticket.abort.abort();
    }
  }
  function observeNoteDelta(next: NoteItem[], previous: NoteItem[]): void {
    noteObservations.observeDelta(next, previous);
    for (const ticket of tickets.values()) if (!ticket.stopReason && !noteObservations.current(ticket.noteObservation)) {
      ticket.stopReason = 'source_changed'; ticket.abort.abort();
    }
  }
  return { prepare, run, status, cancel, revoke, observeNoteSnapshot, observeNoteDelta };
}
