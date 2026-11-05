import { randomUUID } from 'node:crypto';
import { argumentContextHash } from '../../services/argumentContext/hash.ts';
import { parseArgumentQuestionReceipt, type ArgumentQuestionReceipt, type ArgumentQuestionReceiptVerification } from '../../services/argumentContext/questionReceipt.ts';
import type { ArgumentQuestionFrameSelectors, FrozenArgumentQuestionFrames } from '../../services/argumentContext/questionBindingTypes.ts';
import { createArgumentQuestionFrameService, parseArgumentQuestionFrameSelectors } from './argumentQuestionFrames.ts';
import { readSavedArgumentReferenceNotes } from './argumentSavedSourceReader.ts';
import { withRagSourceTransaction } from '../ragSourceTransactions.ts';
import { buildArgumentReferenceDisclosure, type ArgumentReferenceDisclosureContext, type ArgumentReferenceDisclosureReply } from '../../services/argumentContext/referenceDisclosure.ts';
import type { ArgumentReferencePropositionDisclosureReply } from '../../services/argumentContext/referencePropositionReceipt.ts';
import { validateReviewedReferencePropositions, type ReviewedReferencePropositionBundle,
  type ReviewedReferencePropositionProof } from '../../services/reviewComparison/sourcePropositionAnchors.ts';
import type { createArgumentProjectionEnvironmentRegistry } from './argumentProjectionEnvironment.ts';
import type { PersistentArgumentProjectionStore } from './argumentProjectionStore.ts';

export interface ArgumentQuestionPropositionHost {
  /** Host-issued access for this one pre-question attempt; never an IPC DTO. */
  owner: number; environmentId: string; dataRoot: string; rootScopeId: string;
  store: PersistentArgumentProjectionStore; signal: AbortSignal; assertCurrent(): void;
}

export interface ArgumentQuestionPropositionOptions {
  /** Host-only dependency. No default model, renderer proof or answer-time call. */
  preparePropositions?: (context: ArgumentReferenceDisclosureContext, host: ArgumentQuestionPropositionHost) => Promise<{
    bundle: ReviewedReferencePropositionBundle; proof: ReviewedReferencePropositionProof;
  } | null>;
  timeoutMs?: number;
}

/** Ephemeral authentic contracts, bounded per owner. Restart/eviction => held, never reconstruction after an answer. */
export function createArgumentQuestionRuntime(environments: ReturnType<typeof createArgumentProjectionEnvironmentRegistry>,
  options: ArgumentQuestionPropositionOptions = {}) {
  // Capture the host callback/budget once, before any operation can await.
  const configuredPrepare = options.preparePropositions, configuredTimeout = options.timeoutMs;
  const preparePropositions = typeof configuredPrepare === 'function' ? configuredPrepare.bind(options) : undefined;
  const timeoutMs = Number.isFinite(configuredTimeout) ? Math.min(30000, Math.max(1, Math.floor(configuredTimeout!))) : 10000;
  type RetainedPropositions = { status: 'ready'; contextHash: string; bundle: ReviewedReferencePropositionBundle;
    proof: ReviewedReferencePropositionProof }
    | { status: 'pending' }
    | { status: 'held'; reasons: string[] };
  type Entry = { owner: number; selectionHash: string; selectorsHash: string; contract: FrozenArgumentQuestionFrames;
    receipt: ArgumentQuestionReceipt; propositions?: RetainedPropositions };
  const entries = new Map<string, Entry>(), pending = new Set<string>();
  let generation = 0;
  const ownerGenerations = new Map<number, number>();
  const held = (questionMessageId: unknown, reason: string): ArgumentQuestionReceipt => ({ version: 1, status: 'held',
    originQuestionMessageId: typeof questionMessageId === 'string' && questionMessageId.length <= 80 ? questionMessageId : 'unavailable', reasons: [reason] });
  class PropositionPreparationTimeout extends Error {}
  async function boundedPropositions(context: ArgumentReferenceDisclosureContext, host: Omit<ArgumentQuestionPropositionHost, 'signal'>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    try {
      return await Promise.race([
        Promise.resolve().then(() => preparePropositions!(structuredClone(context), { ...host, signal: controller.signal })),
        new Promise<never>((_, reject) => { timer = setTimeout(() => {
          controller.abort(); reject(new PropositionPreparationTimeout());
        }, timeoutMs); }),
      ]);
    } finally { controller.abort(); if (timer !== undefined) clearTimeout(timer); }
  }
  function revoke(owner?: number) {
    if (owner === undefined) { generation++; ownerGenerations.clear(); }
    else ownerGenerations.set(owner, (ownerGenerations.get(owner) ?? 0) + 1);
    for (const [id, entry] of entries) if (owner === undefined || entry.owner === owner) entries.delete(id);
  }
  async function prepare(owner: number, environmentId: string, selectors: ArgumentQuestionFrameSelectors): Promise<ArgumentQuestionReceipt> {
    const issuingGeneration = generation, issuingOwnerGeneration = ownerGenerations.get(owner) ?? 0;
    const qid = selectors?.questionMessageId;
    if (typeof qid !== 'string' || !qid.trim() || qid.length > 80) return held(qid, 'invalid_selectors');
    // Capture and close the request before the first awaited environment/catalog read.
    // A reused question must not bypass parsing because a self-hash ignores undefined keys.
    try { selectors = parseArgumentQuestionFrameSelectors(structuredClone(selectors)); }
    catch { return held(qid, 'invalid_selectors'); }
    try {
      return await environments.withEnvironment(owner, environmentId, async (runtime, roots, scope, selection) => {
        if (selection.kind !== 'learning-note') return held(qid, 'learning_scope_required');
        const selectionHash = await argumentContextHash({ rootScopeId: scope.rootScopeId, selection });
        const selectorsHash = await argumentContextHash(selectors);
        const old = [...entries.values()].find(e => e.owner === owner && e.selectionHash === selectionHash && e.contract.originQuestionMessageId === qid);
        // A concurrent caller must not receive a fixed receipt before its optional
        // pre-answer anchor attempt ends, then discover late answer-time anchors.
        if (old?.propositions?.status === 'pending') return held(qid, 'question_freeze_pending');
        if (old) return old.selectorsHash === selectorsHash ? structuredClone(old.receipt) : held(qid, 'question_already_frozen');
        const key = JSON.stringify([owner, selectionHash, qid]);
        if (pending.has(key)) return held(qid, 'question_freeze_pending');
        pending.add(key);
        try {
          const service = createArgumentQuestionFrameService({ runtime, readReferenceNotes: () =>
            withRagSourceTransaction(Object.values(roots), () => readSavedArgumentReferenceNotes({ ...roots, scope }, selectors.knowledgeTargets)) });
          const contract = await service.prepare(selectors), freezeId = randomUUID();
          if (issuingGeneration !== generation || issuingOwnerGeneration !== (ownerGenerations.get(owner) ?? 0))
            return held(qid, 'receipt_unavailable');
          const receipt: ArgumentQuestionReceipt = { version: 1, originQuestionMessageId: contract.originQuestionMessageId,
            status: contract.status, freezeId, contractHash: contract.contractHash, selectorsHash, reasons: [...contract.reasons] };
          // No renderer receives original text, paths, authority or a publication capability here.
          const entry: Entry = { owner, selectionHash, selectorsHash, contract: structuredClone(contract), receipt: structuredClone(receipt) };
          if (preparePropositions && contract.status === 'fixed') entry.propositions = { status: 'pending' };
          entries.set(freezeId, entry);
          const owned = [...entries].filter(([, e]) => e.owner === owner);
          for (const [id] of owned.slice(0, Math.max(0, owned.length - 200))) entries.delete(id);
          if (preparePropositions && contract.status === 'fixed') {
            let state: RetainedPropositions = { status: 'held', reasons: ['proposition_preparation_unavailable'] };
            try {
              const before = await service.verify(entry.contract);
              const disclosure = before.status === 'current' ? await buildArgumentReferenceDisclosure(entry.contract) : null;
              const current = await service.verify(entry.contract);
              if (disclosure?.status === 'ready' && current.status === 'current'
                && issuingGeneration === generation && issuingOwnerGeneration === (ownerGenerations.get(owner) ?? 0)
                && entries.get(freezeId) === entry) {
                const context = structuredClone(disclosure.context), contextHash = await argumentContextHash(context);
                if (issuingGeneration !== generation || issuingOwnerGeneration !== (ownerGenerations.get(owner) ?? 0)
                  || entries.get(freezeId) !== entry) return held(qid, 'receipt_unavailable');
                const prepared = await boundedPropositions(context, { owner, environmentId, dataRoot: roots.dataRoot,
                  rootScopeId: scope.rootScopeId, store: runtime.store, assertCurrent: () => {
                    if (issuingGeneration !== generation || issuingOwnerGeneration !== (ownerGenerations.get(owner) ?? 0)
                      || entries.get(freezeId) !== entry) throw new Error('receipt_unavailable');
                  } });
                if (prepared) {
                  // Validate the original closed data before cloning can erase
                  // hidden fields/accessors, then replay the detached snapshot.
                  const originalValidation = validateReviewedReferencePropositions(context, prepared.bundle, prepared.proof);
                  // Detached snapshot prevents a provider's later mutation from
                  // changing the retained review/proof or authenticated context.
                  const snapshot = structuredClone(prepared);
                  const initial = await originalValidation;
                  const verified = initial.status === 'ready'
                    ? await validateReviewedReferencePropositions(context, snapshot.bundle, snapshot.proof) : initial;
                  state = verified.status === 'ready' && initial.status === 'ready'
                    && verified.bundle.bundleHash === initial.bundle.bundleHash && verified.bundle.contextHash === contextHash
                    ? { status: 'ready', contextHash, bundle: structuredClone(verified.bundle), proof: structuredClone(snapshot.proof) }
                    : { status: 'held', reasons: ['proposition_proof_unavailable'] };
                } else state = { status: 'held', reasons: ['propositions_not_prepared'] };
              } else state = { status: 'held', reasons: ['proposition_source_unavailable'] };
            } catch (error) {
              state = { status: 'held', reasons: [error instanceof PropositionPreparationTimeout
                ? 'proposition_preparation_timeout' : 'proposition_preparation_unavailable'] };
            }
            // Even a failed provider attempt is final for this original question.
            // It neither changes the normal fixed receipt nor gets retried in read.
            const after = await service.verify(entry.contract);
            if (after.status !== 'current') state = { status: 'held', reasons: ['proposition_source_unavailable'] };
            if (issuingGeneration !== generation || issuingOwnerGeneration !== (ownerGenerations.get(owner) ?? 0)
              || entries.get(freezeId) !== entry) return held(qid, 'receipt_unavailable');
            entry.propositions = state;
          }
          return receipt;
        } finally { pending.delete(key); }
      });
    } catch { return held(qid, 'environment_unavailable'); }
  }
  async function verify(owner: number, environmentId: string, raw: unknown): Promise<ArgumentQuestionReceiptVerification> {
    const verifyingGeneration = generation, verifyingOwnerGeneration = ownerGenerations.get(owner) ?? 0;
    try {
      const receipt = parseArgumentQuestionReceipt(structuredClone(raw)), entry = receipt.freezeId ? entries.get(receipt.freezeId) : undefined;
      if (!entry || entry.owner !== owner || await argumentContextHash(receipt) !== await argumentContextHash(entry.receipt)) return { status: 'held', reasons: ['receipt_unavailable'] };
      const result = await environments.withEnvironment<ArgumentQuestionReceiptVerification>(owner, environmentId, async (runtime, roots, scope, selection) => {
        if (selection.kind !== 'learning-note' || await argumentContextHash({ rootScopeId: scope.rootScopeId, selection }) !== entry.selectionHash)
          return { status: 'held', reasons: ['selection_changed'] };
        const service = createArgumentQuestionFrameService({ runtime, readReferenceNotes: () =>
          withRagSourceTransaction(Object.values(roots), () => readSavedArgumentReferenceNotes({ ...roots, scope }, entry.contract.knowledgeTargets)) });
        const result = await service.verify(entry.contract);
        return { status: result.status, reasons: result.reasons };
      });
      if (verifyingGeneration !== generation || verifyingOwnerGeneration !== (ownerGenerations.get(owner) ?? 0)
        || entries.get(receipt.freezeId!) !== entry) return { status: 'held', reasons: ['receipt_unavailable'] };
      return result;
    } catch { return { status: 'held', reasons: ['environment_unavailable'] }; }
  }
  /** Read the retained pre-answer baseline; never accept a replacement contract or renderer-selected source. */
  async function read(owner: number, environmentId: string, raw: unknown): Promise<ArgumentReferenceDisclosureReply> {
    const readingGeneration = generation, readingOwnerGeneration = ownerGenerations.get(owner) ?? 0;
    try {
      const receipt = parseArgumentQuestionReceipt(structuredClone(raw)), entry = receipt.freezeId ? entries.get(receipt.freezeId) : undefined;
      if (!entry || entry.owner !== owner || await argumentContextHash(receipt) !== await argumentContextHash(entry.receipt))
        return { status: 'held', reasons: ['receipt_unavailable'] };
      const result = await environments.withEnvironment<ArgumentReferenceDisclosureReply>(owner, environmentId, async (runtime, roots, scope, selection) => {
        if (selection.kind !== 'learning-note' || await argumentContextHash({ rootScopeId: scope.rootScopeId, selection }) !== entry.selectionHash)
          return { status: 'held', reasons: ['selection_changed'] };
        const service = createArgumentQuestionFrameService({ runtime, readReferenceNotes: () =>
          withRagSourceTransaction(Object.values(roots), () => readSavedArgumentReferenceNotes({ ...roots, scope }, entry.contract.knowledgeTargets)) });
        const verification = await service.verify(entry.contract);
        if (verification.status !== 'current') return { status: 'held', reasons: [...verification.reasons] };
        // The source replay and projection share this host operation. A self-hashed
        // client DTO, newly found passage or held baseline can never replace entry.
        const reply = await buildArgumentReferenceDisclosure(entry.contract);
        const after = await service.verify(entry.contract);
        return after.status === 'current' ? reply : { status: 'held', reasons: [...after.reasons] };
      });
      if (readingGeneration !== generation || readingOwnerGeneration !== (ownerGenerations.get(owner) ?? 0)
        || entries.get(receipt.freezeId!) !== entry) return { status: 'held', reasons: ['receipt_unavailable'] };
      return result;
    } catch { return { status: 'held', reasons: ['environment_unavailable'] }; }
  }
  /** Only disclose anchors captured during this receipt's first pre-answer
   * preparation. No callback, renderer proof, re-extraction or receipt upgrade. */
  async function readPropositions(owner: number, environmentId: string, raw: unknown): Promise<ArgumentReferencePropositionDisclosureReply> {
    const readingGeneration = generation, readingOwnerGeneration = ownerGenerations.get(owner) ?? 0;
    try {
      const receipt = parseArgumentQuestionReceipt(structuredClone(raw)), entry = receipt.freezeId ? entries.get(receipt.freezeId) : undefined;
      if (!entry || entry.owner !== owner || await argumentContextHash(receipt) !== await argumentContextHash(entry.receipt))
        return { status: 'held', reasons: ['receipt_unavailable'] };
      const retained = entry.propositions;
      // Existing read owns environment/selection/source authentication. A client
      // hash or proof never substitutes for that original host entry.
      const first = await read(owner, environmentId, receipt);
      if (first.status !== 'ready') return first;
      if (!retained || retained.status === 'pending') return { status: 'held', reasons: ['propositions_not_prepared'] };
      if (retained.status === 'held') return { status: 'held', reasons: [...retained.reasons] };
      const snapshot = structuredClone(retained), contextHash = await argumentContextHash(first.context);
      if (contextHash !== snapshot.contextHash) return { status: 'held', reasons: ['proposition_context_changed'] };
      const verified = await validateReviewedReferencePropositions(first.context, snapshot.bundle, snapshot.proof);
      if (verified.status !== 'ready') return { status: 'held', reasons: ['proposition_proof_unavailable'] };
      const after = await read(owner, environmentId, receipt);
      if (after.status !== 'ready') return after;
      if (await argumentContextHash(after.context) !== snapshot.contextHash
        || verified.bundle.contextHash !== snapshot.contextHash || verified.bundle.contractHash !== receipt.contractHash)
        return { status: 'held', reasons: ['proposition_context_changed'] };
      if (readingGeneration !== generation || readingOwnerGeneration !== (ownerGenerations.get(owner) ?? 0)
        || entries.get(receipt.freezeId!) !== entry || entry.propositions !== retained)
        return { status: 'held', reasons: ['receipt_unavailable'] };
      return { status: 'ready', context: structuredClone(after.context), bundle: structuredClone(verified.bundle),
        binding: { freezeId: receipt.freezeId!, contractHash: receipt.contractHash!, contextHash: snapshot.contextHash,
          bundleHash: verified.bundle.bundleHash } };
    } catch { return { status: 'held', reasons: ['environment_unavailable'] }; }
  }
  return { prepare, verify, read, readPropositions, revoke };
}
