import { argumentContextHash } from './hash';
import { validateArgumentProjectionBuildInput, verifyArgumentProjectionBuildResult } from './construction';
import { validateArgumentContextSourceFoundation } from './validator';
import type { ArgumentProjectionBuildInput, ArgumentProjectionBuildProof, ArgumentProjectionBuildResult } from './buildTypes';
import type { ArgumentContextScope, ArgumentSourceIdentity } from './types';
import { reviewedTaskScopeNodeIds } from './scopedAdmission';

/** Host-owned currentSource and scope must be obtained independently from the candidate. */
export interface ArgumentProjectionPublicationRequest {
  publicationId: string;
  result: ArgumentProjectionBuildResult;
  proof: ArgumentProjectionBuildProof;
  scope: ArgumentContextScope;
  currentSource: ArgumentSourceIdentity;
  expectedActiveHash: string | null;
}

/** Receipt of the in-memory prototype only; not a production-store transaction receipt. */
export interface ArgumentProjectionPublicationReceipt {
  version: 1;
  publicationId: string;
  buildId: string;
  reviewId: string;
  scopeId: string;
  scopeHash: string;
  source: ArgumentSourceIdentity;
  resultHash: string;
  structureHash: string;
  candidateStatus: ArgumentProjectionBuildResult['status'];
  status: 'published' | 'held';
  /** Active hash at this transaction, not permission to return an older source snapshot. */
  activeHash: string | null;
  reasons: string[];
  limitations: ArgumentProjectionBuildResult['limitations'];
}

export interface ArgumentProjectionPublicationReadRequest {
  source: ArgumentSourceIdentity;
  scope: ArgumentContextScope;
}

export interface ArgumentProjectionPublicationStore {
  /** A host registration is independent of the model's submitted build/review response. */
  registerSource(input: ArgumentProjectionBuildInput): Promise<void>;
  publish(request: ArgumentProjectionPublicationRequest): Promise<ArgumentProjectionPublicationReceipt>;
  /** A stale source or changed scope never falls back to a formerly active projection. */
  read(request: ArgumentProjectionPublicationReadRequest): Promise<ArgumentProjectionBuildResult | null>;
  readStaged(request: ArgumentProjectionPublicationReadRequest & { publicationId: string }): Promise<ArgumentProjectionBuildResult | null>;
}

interface StoredCandidate {
  result: ArgumentProjectionBuildResult;
  sourceHash: string;
  scopeHash: string;
  sourceBindingHash: string;
  epoch: number;
}
interface RegisteredSource {
  sourceHash: string;
  sourceBindingHash: string;
  scopeHash: string;
  buildId: string;
  epoch: number;
  registrationTicket: number;
}
interface PublicationOperation {
  fingerprint: string;
  /** Receipts are historical transactions; an A→B→A registration must not relabel one as new. */
  key: string;
  context: RegisteredSource;
  inFlight?: Promise<ArgumentProjectionPublicationReceipt>;
  receipt?: ArgumentProjectionPublicationReceipt;
  /** Held candidates retain their audit; they cannot be promoted without a fresh publication. */
  staged?: StoredCandidate;
}

const HASH = /^[a-f0-9]{64}$/u;
const MAX_OPERATIONS = 2000;
const MAX_ACTIVE_SOURCES = 256;
const fail = (reason: string): never => { throw new Error(`argument_publication_${reason}`); };

function closed(value: unknown, fields: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_shape');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some((key) => !fields.includes(key))
    || fields.some((key) => !Object.hasOwn(item, key))) fail('invalid_shape');
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 300 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value) || /^(?:[a-z]:[\\/]|[\\/])/iu.test(value)) fail('invalid_id');
}
function slot(source: ArgumentSourceIdentity, scope: ArgumentContextScope): string {
  if (!source || typeof source !== 'object' || !scope || typeof scope !== 'object') fail('invalid_shape');
  id(source.rootScopeId); id(source.entityId); id(scope.rootScopeId); id(scope.scopeId);
  if (!['knowledge-note', 'uploaded-document', 'personal-cognition'].includes(source.kind)
    || !['reference', 'personal'].includes(scope.corpus)) fail('invalid_scope');
  if (source.rootScopeId !== scope.rootScopeId) fail('scope_denied');
  // JSON tuple encoding avoids collisions caused by identifiers containing separators.
  return JSON.stringify([source.rootScopeId, scope.corpus, source.kind, source.entityId]);
}
function completenessReasons(result: ArgumentProjectionBuildResult): string[] {
  const reasons: string[] = [];
  const scoped = result.status === 'reviewed_scoped' && reviewedTaskScopeNodeIds(result.projection).length > 0;
  if (result.status !== 'reviewed_complete' && !scoped) reasons.push('review_incomplete');
  if (result.projection.build.origin !== 'validated-projection') reasons.push('legacy_not_publishable');
  if (!scoped && result.projection.build.gaps.length) reasons.push('build_gaps');
  if (!result.projection.build.scopes.length
    || !scoped && result.projection.build.scopes.some((scope) => scope.status !== 'reviewed_for_scope')) reasons.push('scope_incomplete');
  // S2 active publication is for qualified reference projections, not a personal growth path.
  if (result.projection.source.kind === 'personal-cognition') reasons.push('reference_source_required');
  if (result.projection.quality.status !== 'eligible') reasons.push('source_not_qualified');
  return reasons;
}

/**
 * Deterministic in-memory S2 publication boundary. It has no filesystem, model, score or
 * cognition-write adapter. A future host must perform its source-version check and CAS in
 * the same persistent transaction; passing an old identity as currentSource is not authority.
 */
export function createArgumentProjectionPublicationStore(): ArgumentProjectionPublicationStore {
  const active = new Map<string, StoredCandidate>();
  const registered = new Map<string, RegisteredSource>();
  const registrationTickets = new Map<string, number>();
  const operations = new Map<string, PublicationOperation>();
  const queues = new Map<string, Promise<void>>();

  async function registerSource(inputValue: ArgumentProjectionBuildInput): Promise<void> {
    const input = structuredClone(inputValue);
    const key = slot(input.source, input.scope);
    const ticket = (registrationTickets.get(key) ?? 0) + 1;
    registrationTickets.set(key, ticket);
    await validateArgumentProjectionBuildInput(input);
    const sourceHash = await argumentContextHash(input.source);
    const previous = registered.get(key);
    // A slower older registration must not roll back a later successful host registration.
    // An invalid newer registration does not invalidate an earlier valid one.
    if (previous && previous.registrationTicket > ticket) return;
    const sameBinding = previous?.sourceBindingHash === input.sourceBindingHash
      && previous.scopeHash === input.scopeHash && previous.sourceHash === sourceHash;
    registered.set(key, { sourceHash, sourceBindingHash: input.sourceBindingHash, scopeHash: input.scopeHash,
      buildId: input.buildId, epoch: sameBinding && previous ? previous.epoch : (previous?.epoch ?? 0) + 1,
      registrationTicket: ticket });
  }

  function contextFor(key: string, sourceHash: string, scopeHash: string,
    input: ArgumentProjectionBuildInput): RegisteredSource {
    const current = registered.get(key);
    if (!current) fail('source_not_registered');
    if (current.sourceHash !== sourceHash || current.scopeHash !== scopeHash
      || current.sourceBindingHash !== input.sourceBindingHash || current.buildId !== input.buildId) fail('source_changed');
    return { ...current };
  }
  function assertCurrent(key: string, captured: RegisteredSource): void {
    const current = registered.get(key);
    if (!current || current.epoch !== captured.epoch || current.sourceHash !== captured.sourceHash
      || current.sourceBindingHash !== captured.sourceBindingHash || current.scopeHash !== captured.scopeHash
      || current.buildId !== captured.buildId) fail('source_changed');
  }

  async function validateBoundCandidate(key: string, request: ArgumentProjectionPublicationRequest,
    captured: RegisteredSource): Promise<{ sourceHash: string; scopeHash: string }> {
    assertCurrent(key, captured);
    // A self-recomputed result hash is not admission, including for idempotent replay.
    await verifyArgumentProjectionBuildResult(request.result, request.proof);
    await validateArgumentContextSourceFoundation(request.currentSource, request.proof.input.canonicalText,
      request.proof.input.hierarchy, request.scope);
    const [currentSourceHash, inputSourceHash, resultSourceHash, authoritySourceHash, scopeHash, inputScopeHash] = await Promise.all([
      argumentContextHash(request.currentSource), argumentContextHash(request.proof.input.source),
      argumentContextHash(request.result.projection.source), argumentContextHash(request.result.authority.source),
      argumentContextHash(request.scope), argumentContextHash(request.proof.input.scope),
    ]);
    if (currentSourceHash !== inputSourceHash || currentSourceHash !== resultSourceHash
      || currentSourceHash !== authoritySourceHash) fail('source_changed');
    if (scopeHash !== inputScopeHash || scopeHash !== request.proof.input.scopeHash) fail('scope_changed');
    // Registration is not behind the publication queue: host source changes during review win.
    assertCurrent(key, captured);
    return { sourceHash: currentSourceHash, scopeHash };
  }

  function enqueue<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = queues.get(key) ?? Promise.resolve();
    const job = prior.then(work);
    // Every queue tail fulfills, so a failed review/CAS never poisons later work.
    const settled = job.then(() => undefined, () => undefined);
    queues.set(key, settled);
    void settled.then(() => { if (queues.get(key) === settled) queues.delete(key); });
    return job;
  }

  async function publish(requestInput: ArgumentProjectionPublicationRequest): Promise<ArgumentProjectionPublicationReceipt> {
    // Capture all mutable arrays, identities, draft and review before the first async boundary.
    const request = structuredClone(requestInput);
    closed(request, ['publicationId', 'result', 'proof', 'scope', 'currentSource', 'expectedActiveHash']);
    id(request.publicationId);
    if (request.expectedActiveHash !== null
      && (typeof request.expectedActiveHash !== 'string' || !HASH.test(request.expectedActiveHash))) fail('invalid_expected_hash');
    const key = slot(request.currentSource, request.scope);
    const [fingerprint, hostSourceHash, hostScopeHash] = await Promise.all([
      argumentContextHash(request), argumentContextHash(request.currentSource), argumentContextHash(request.scope),
    ]);
    const captured = contextFor(key, hostSourceHash, hostScopeHash, request.proof.input);
    let operation = operations.get(request.publicationId);
    if (operation) {
      if (operation.fingerprint !== fingerprint) fail('idempotency_content_changed');
      if (operation.key !== key) fail('source_changed');
      assertCurrent(key, operation.context);
      if (operation.receipt || operation.inFlight) {
        const replayReceipt = operation.receipt;
        const replayPromise = operation.inFlight;
        // Canonical hashes deliberately omit undefined object properties. Revalidate the full
        // closed schema so an idempotent request cannot smuggle new undefined/unknown fields.
        await validateBoundCandidate(key, request, captured);
        const receipt = replayReceipt ?? await replayPromise!;
        assertCurrent(key, captured);
        return structuredClone(receipt);
      }
    } else {
      if (operations.size >= MAX_OPERATIONS) fail('operation_capacity');
      operation = { fingerprint, key, context: { ...captured } };
      operations.set(request.publicationId, operation);
    }
    const selectedOperation = operation;
    const job = enqueue(key, async () => {
      const { sourceHash: currentSourceHash, scopeHash } = await validateBoundCandidate(key, request, captured);
      // The await of the validator itself is another scheduling boundary. Recheck here,
      // then perform staging/CAS/activation without any further await.
      assertCurrent(key, captured);
      const previousSlot = active.get(key);
      // A hidden snapshot from an older registered source/scope is not a CAS baseline.
      // Treat the current generation as inactive, while reusing its occupied map slot.
      const existing = previousSlot?.epoch === captured.epoch
        && previousSlot.sourceHash === captured.sourceHash
        && previousSlot.scopeHash === captured.scopeHash
        && previousSlot.sourceBindingHash === captured.sourceBindingHash ? previousSlot : undefined;
      const activeHash = existing?.result.authority.structureHash ?? null;
      const reasons = completenessReasons(request.result);
      const receipt: ArgumentProjectionPublicationReceipt = {
        version: 1, publicationId: request.publicationId, buildId: request.result.buildId,
        reviewId: request.result.reviewId, scopeId: request.scope.scopeId, scopeHash,
        source: request.currentSource, resultHash: request.result.resultHash,
        structureHash: request.result.authority.structureHash, candidateStatus: request.result.status,
        status: reasons.length ? 'held' : 'published', activeHash, reasons,
        limitations: request.result.limitations,
      };
      const candidate: StoredCandidate = {
        result: structuredClone(request.result), sourceHash: currentSourceHash, scopeHash,
        sourceBindingHash: captured.sourceBindingHash, epoch: captured.epoch,
      };
      if (reasons.length) {
        selectedOperation.staged = candidate;
      } else {
        if (activeHash !== request.expectedActiveHash) fail('cas_mismatch');
        if (!previousSlot && active.size >= MAX_ACTIVE_SOURCES) fail('active_capacity');
        // No await between comparing the active hash and replacing the entire verified snapshot.
        active.set(key, candidate);
        receipt.activeHash = candidate.result.authority.structureHash;
      }
      selectedOperation.receipt = structuredClone(receipt);
      return structuredClone(receipt);
    });
    selectedOperation.inFlight = job;
    try {
      return structuredClone(await job);
    } finally {
      // Retain the fingerprint even on failure, but permit a same-content retry after transient
      // verification failure. Other publication IDs and source queues are never blocked by it.
      if (selectedOperation.inFlight === job) delete selectedOperation.inFlight;
    }
  }

  async function read(requestInput: ArgumentProjectionPublicationReadRequest): Promise<ArgumentProjectionBuildResult | null> {
    const request = structuredClone(requestInput);
    closed(request, ['source', 'scope']);
    const key = slot(request.source, request.scope);
    const [sourceHash, scopeHash] = await Promise.all([
      argumentContextHash(request.source), argumentContextHash(request.scope),
    ]);
    // Read after the hashes settle, then return one complete immutable snapshot synchronously.
    const stored = active.get(key);
    const current = registered.get(key);
    if (!stored || !current || current.sourceHash !== sourceHash || current.scopeHash !== scopeHash
      || stored.sourceHash !== sourceHash || stored.scopeHash !== scopeHash
      || stored.sourceBindingHash !== current.sourceBindingHash || stored.epoch !== current.epoch) return null;
    return structuredClone(stored.result);
  }

  async function readStaged(requestValue: ArgumentProjectionPublicationReadRequest & { publicationId: string }): Promise<ArgumentProjectionBuildResult | null> {
    const request = structuredClone(requestValue);
    closed(request, ['publicationId', 'source', 'scope']); id(request.publicationId);
    const key = slot(request.source, request.scope);
    const [sourceHash, scopeHash] = await Promise.all([
      argumentContextHash(request.source), argumentContextHash(request.scope),
    ]);
    const staged = operations.get(request.publicationId)?.staged;
    const current = registered.get(key);
    if (!staged || !current || current.sourceHash !== sourceHash || current.scopeHash !== scopeHash
      || staged.sourceHash !== sourceHash || staged.scopeHash !== scopeHash
      || staged.sourceBindingHash !== current.sourceBindingHash || staged.epoch !== current.epoch) return null;
    return structuredClone(staged.result);
  }

  return { registerSource, publish, read, readStaged };
}
