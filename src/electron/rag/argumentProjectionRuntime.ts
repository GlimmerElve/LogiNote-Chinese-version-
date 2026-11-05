import path from 'node:path';
import { createHash } from 'node:crypto';
import { argumentContextHash } from '../../services/argumentContext/hash.ts';
import { ARGUMENT_CONTEXT_LIMITS, ARGUMENT_CONTEXT_TASKS } from '../../services/argumentContext/types.ts';
import type { ArgumentContextBudget, ArgumentContextPack, ArgumentContextPointer, ArgumentContextScope, ArgumentContextTask } from '../../services/argumentContext/types.ts';
import type { ArgumentProjectionBuildInput } from '../../services/argumentContext/buildTypes.ts';
import { validateArgumentProjectionBuildInput } from '../../services/argumentContext/construction.ts';
import { normalizeArgumentContextBudget } from '../../services/argumentContext/validator.ts';
import { withRagSourceTransaction } from '../ragSourceTransactions.ts';
import { readSavedArgumentProjectionSource, readSavedArgumentReferenceNote } from './argumentSavedSourceReader.ts';
import { createArgumentSourceAdmissionStore } from './argumentSourceAdmission.ts';
import type { SourceAdmissionReview } from './argumentSourceAdmission.ts';
import { ARGUMENT_REFERENCE_POLICY_VERSION, readArgumentReferenceProvenance } from './argumentReferencePolicy.ts';
import { validateArgumentProjectionSourceRef } from './argumentProjectionAuthority.ts';
import type { ArgumentProjectionAuthorityHost, ArgumentProjectionSourceRef } from './argumentProjectionAuthority.ts';
import { createPersistentArgumentProjectionStore } from './argumentProjectionStore.ts';
import type { PersistentArgumentProjectionStore } from './argumentProjectionStore.ts';
import { createStoredArgumentContextPointer, readStoredArgumentContextPack } from './argumentProjectionReader.ts';
import { readTaskScopedArgumentContextPack } from '../../services/argumentContext/taskScopedReader.ts';
import type { ArgumentTaskScopedPack } from '../../services/argumentContext/taskScopedTypes.ts';

/** Selectors only. Neither a path nor a renderer-supplied scope/quality is an authority. */
export type ArgumentProjectionReadonlyRequest =
  | { op: 'source'; environmentId: string; ref: ArgumentProjectionSourceRef }
  | { op: 'pointer'; environmentId: string; ref: ArgumentProjectionSourceRef; seedNodeIds: string[] }
  | { op: 'read'; environmentId: string; pointer: ArgumentContextPointer; task: ArgumentContextTask; budget?: Partial<ArgumentContextBudget> }
  | { op: 'read-task'; environmentId: string; pointer: ArgumentContextPointer; task: ArgumentContextTask; budget?: Partial<ArgumentContextBudget> };

export type ArgumentProjectionRuntimeReason = 'invalid_request' | 'environment_changed' | 'scope_denied'
  | 'source_pending' | 'source_changed' | 'source_unavailable' | 'admission_unavailable'
  | 'projection_unavailable' | 'projection_invalid' | 'pointer_invalid';
export type ArgumentProjectionReadonlyResponse =
  | { status: 'physical_source'; environmentId: string; input: ArgumentProjectionBuildInput }
  | { status: 'available'; environmentId: string; pointer: ArgumentContextPointer }
  | { status: 'available'; environmentId: string; pack: ArgumentContextPack }
  | { status: 'available'; environmentId: string; pack: ArgumentTaskScopedPack }
  | { status: 'source_missing'; environmentId: string }
  | { status: 'held'; environmentId: string; reasonCode: ArgumentProjectionRuntimeReason };

export interface ArgumentProjectionRuntimeOptions {
  dataRoot: string; vaultRoot: string; userStateDir: string;
  /** A new host-issued lease is required after every selection/root change, even A → B → A. */
  environmentId: string; rootScopeId: string; scope: ArgumentContextScope;
  isCurrent: () => boolean;
  /** Host-only saved membership recheck, called inside the source lock; no nested locks. */
  assertScopeCurrent?: () => Promise<void>;
  /** Narrow learning scope cannot revoke a global admission merely because a cited dependency is not granted. */
  dependencyAccessFailureIsScoped?: boolean;
}
export interface ArgumentProjectionRuntime {
  /** Internal host/test dependencies. Only execute may be exposed through the read-only IPC. */
  host: ArgumentProjectionAuthorityHost;
  store: PersistentArgumentProjectionStore;
  admission: ReturnType<typeof createArgumentSourceAdmissionStore>;
  /** Host-only mutation. Expected input is a saved snapshot, never renderer authority. */
  recordSourceReview(expectedInput: ArgumentProjectionBuildInput, review: SourceAdmissionReview,
    assertCurrent?: () => void): Promise<ArgumentProjectionBuildInput>;
  execute(request: unknown): Promise<ArgumentProjectionReadonlyResponse>;
}

const HASH = /^[a-f0-9]{64}$/u;
const fail = (code: string): never => { throw new Error(`argument_projection_runtime_${code}`); };
function closed(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_request');
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.hasOwn(item, key))) fail('invalid_request');
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 300 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value) || /^(?:[a-z]:[\\/]|[\\/])/iu.test(value)) fail('invalid_request');
}
function opaqueId(value: unknown): asserts value is string {
  id(value); if (/[\\/]/u.test(value) || /^[A-Za-z]:/u.test(value)) fail('invalid_request');
}
function ids(value: unknown, limit: number, nonempty = false): asserts value is string[] {
  if (!Array.isArray(value)) return fail('invalid_request');
  if (value.length > limit || nonempty && !value.length) fail('invalid_request');
  value.forEach(id); if (new Set(value).size !== value.length) fail('invalid_request');
}
function hash(value: unknown): void { if (typeof value !== 'string' || !HASH.test(value)) fail('invalid_request'); }
function validatePointer(value: unknown): asserts value is ArgumentContextPointer {
  closed(value, ['version', 'scopeId', 'scopeHash', 'source', 'structureHash', 'seedNodeIds']);
  if (value.version !== 1) fail('invalid_request');
  id(value.scopeId); hash(value.scopeHash); hash(value.structureHash);
  ids(value.seedNodeIds, ARGUMENT_CONTEXT_LIMITS.readNodes, true);
  const source = value.source;
  closed(source, ['kind', 'entityId', 'rootScopeId', 'version', 'contentHash', 'coordinateSpace',
    'parserVersion', 'segmentationVersion', 'extractorVersion', 'validatorVersion']);
  validateArgumentProjectionSourceRef({ kind: source.kind, entityId: source.entityId });
  opaqueId(source.rootScopeId); id(source.version); hash(source.contentHash);
  for (const key of ['parserVersion', 'segmentationVersion', 'extractorVersion', 'validatorVersion']) id(source[key]);
  if (source.coordinateSpace !== (source.kind === 'knowledge-note' ? 'saved-note-utf16' : 'parsed-text-utf16')) fail('invalid_request');
}
function validateScope(value: unknown, rootScopeId: string): asserts value is ArgumentContextScope {
  closed(value, ['scopeId', 'rootScopeId', 'corpus', 'allowedSourceKinds', 'allowedNoteIds', 'allowedDocIds', 'allowedRecordIds']);
  id(value.scopeId); opaqueId(value.rootScopeId);
  if (value.rootScopeId !== rootScopeId || value.corpus !== 'reference') fail('invalid_host');
  ids(value.allowedSourceKinds, 2); ids(value.allowedNoteIds, 20000); ids(value.allowedDocIds, 20000); ids(value.allowedRecordIds, 20000);
  if (value.allowedSourceKinds.some(kind => kind !== 'knowledge-note' && kind !== 'uploaded-document')
    || value.allowedRecordIds.length) fail('invalid_host');
}

/**
 * Authorization remains the independently issued library lease. This stable single-source
 * build/read scope is derived only AFTER checking membership in that library; a pointer
 * cannot authorize itself. Adding an unrelated library source must not change this source's
 * binding or tombstone an otherwise unchanged projection. Root/selection changes still
 * revoke the enclosing environment lease at the host, rather than widening this scope.
 */
export function createArgumentProjectionSourceScope(libraryScopeValue: ArgumentContextScope,
  refValue: ArgumentProjectionSourceRef): ArgumentContextScope {
  const library = structuredClone(libraryScopeValue), ref = structuredClone(refValue);
  opaqueId(library?.rootScopeId); validateScope(library, library.rootScopeId);
  validateArgumentProjectionSourceRef(ref);
  if (!library.allowedSourceKinds.includes(ref.kind)
    || !(ref.kind === 'knowledge-note' ? library.allowedNoteIds : library.allowedDocIds).includes(ref.entityId)) fail('scope_denied');
  const identity = JSON.stringify([library.rootScopeId, ref.kind, ref.entityId]);
  return { scopeId: `reference-source-${createHash('sha256').update(identity, 'utf8').digest('hex')}`,
    rootScopeId: library.rootScopeId, corpus: 'reference', allowedSourceKinds: [ref.kind],
    allowedNoteIds: ref.kind === 'knowledge-note' ? [ref.entityId] : [],
    allowedDocIds: ref.kind === 'uploaded-document' ? [ref.entityId] : [], allowedRecordIds: [] };
}

function validateRequest(value: unknown): asserts value is ArgumentProjectionReadonlyRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_request');
  const op = (value as Record<string, unknown>).op;
  if (op === 'source' || op === 'pointer') {
    closed(value, op === 'source' ? ['op', 'environmentId', 'ref'] : ['op', 'environmentId', 'ref', 'seedNodeIds']);
    validateArgumentProjectionSourceRef(value.ref);
    if (op === 'pointer') ids(value.seedNodeIds, ARGUMENT_CONTEXT_LIMITS.readNodes, true);
  } else if (op === 'read' || op === 'read-task') {
    closed(value, ['op', 'environmentId', 'pointer', 'task'], ['budget']);
    validatePointer(value.pointer);
    if (typeof value.task !== 'string' || !ARGUMENT_CONTEXT_TASKS.includes(value.task as ArgumentContextTask)) fail('invalid_request');
    if (op === 'read-task' && !['definition', 'example', 'distinguish', 'fact', 'condition', 'reasoning'].includes(value.task as string)) fail('invalid_request');
    normalizeArgumentContextBudget(value.budget as Partial<ArgumentContextBudget> | undefined);
  } else fail('invalid_request');
  opaqueId((value as Record<string, unknown>).environmentId);
}

/** Stable small codes only; never serialize host paths, raw exceptions or parser details. */
function reasonFor(error: unknown, op: ArgumentProjectionReadonlyRequest['op']): ArgumentProjectionRuntimeReason {
  const message = error instanceof Error ? error.message : '';
  if (message === 'argument_projection_runtime_environment_changed') return 'environment_changed';
  if (message === 'argument_projection_runtime_scope_denied' || message === 'argument_saved_source_scope_denied') return 'scope_denied';
  if (message === 'argument_saved_source_save_in_progress') return 'source_pending';
  if (message === 'argument_projection_runtime_source_changed' || message === 'argument_saved_source_source_changed'
    || message === 'argument_context_snapshot_changed' || message === 'argument_projection_store_source_changed') return 'source_changed';
  if (message.startsWith('argument_source_admission_')) return 'admission_unavailable';
  if (message.startsWith('argument_projection_store_')) return 'projection_invalid';
  if (message.startsWith('argument_context_') && op !== 'source') return 'pointer_invalid';
  if (message.startsWith('argument_task_context_')) return 'projection_invalid';
  return 'source_unavailable';
}

/**
 * Saved-source authority and read-only execution boundary. The host scope is captured
 * independently by main; caller requests cannot widen it. No parse, extraction, model,
 * publication, score or cognition write is initiated here. Stored reads may persist the
 * existing derived-ledger invalidation when a source change has actually been observed.
 * App-process source transactions cannot exclude external editors or unobserved ABA.
 */
export function createArgumentProjectionRuntime(options: ArgumentProjectionRuntimeOptions): ArgumentProjectionRuntime {
  closed(options, ['dataRoot', 'vaultRoot', 'userStateDir', 'environmentId', 'rootScopeId', 'scope', 'isCurrent'], ['assertScopeCurrent', 'dependencyAccessFailureIsScoped']);
  for (const root of [options.dataRoot, options.vaultRoot, options.userStateDir]) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || /[\u0000-\u001f\u007f]/u.test(root)) fail('invalid_host');
  }
  opaqueId(options.environmentId); opaqueId(options.rootScopeId);
  if (typeof options.isCurrent !== 'function') fail('invalid_host');
  if (options.assertScopeCurrent !== undefined && typeof options.assertScopeCurrent !== 'function') fail('invalid_host');
  if (options.dependencyAccessFailureIsScoped !== undefined && typeof options.dependencyAccessFailureIsScoped !== 'boolean') fail('invalid_host');
  const scope = structuredClone(options.scope); validateScope(scope, options.rootScopeId);
  const dataRoot = path.resolve(options.dataRoot), vaultRoot = path.resolve(options.vaultRoot), userStateDir = path.resolve(options.userStateDir);
  const environmentId = options.environmentId, rootScopeId = options.rootScopeId, isCurrent = options.isCurrent;
  const assertScopeCurrent = options.assertScopeCurrent;
  const dependencyAccessFailureIsScoped = options.dependencyAccessFailureIsScoped === true;
  const sourceOptions = { dataRoot, vaultRoot, userStateDir };
  const admission = createArgumentSourceAdmissionStore(path.join(userStateDir, 'argument-source-admission'), rootScopeId);
  const current = () => { if (!isCurrent()) fail('environment_changed'); };
  function allowed(ref: ArgumentProjectionSourceRef): void {
    if (!scope.allowedSourceKinds.includes(ref.kind)
      || !(ref.kind === 'knowledge-note' ? scope.allowedNoteIds : scope.allowedDocIds).includes(ref.entityId)) fail('scope_denied');
  }
  async function rawSaved(ref: ArgumentProjectionSourceRef): Promise<ArgumentProjectionBuildInput | null> {
    const sourceScope = createArgumentProjectionSourceScope(scope, ref);
    let base: ArgumentProjectionBuildInput | null;
    try {
      base = await readSavedArgumentProjectionSource({ ...sourceOptions, scope: sourceScope }, ref);
    } catch (error) {
      // A removed source directory, like an absent source file, cannot retain authority.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return base;
  }
  async function saved(ref: ArgumentProjectionSourceRef): Promise<ArgumentProjectionBuildInput | null> {
    const base = await rawSaved(ref);
    // Missing/corrupt admission material must reject, never masquerade as source absence.
    return base === null ? null : await qualifiedCurrent(base);
  }
  async function qualifiedCurrent(base: ArgumentProjectionBuildInput): Promise<ArgumentProjectionBuildInput> {
    const applied = await admission.apply(base), prefix = `${ARGUMENT_REFERENCE_POLICY_VERSION}:p-`;
    if (!applied.sourceQualification.policyVersion.startsWith(prefix)) return applied;
    if (dependencyAccessFailureIsScoped && base.source.kind === 'knowledge-note') {
      // Read ONLY this authorized source's metadata. A project may be allowed to
      // read the note but not one of its internal citations; that is a scoped
      // access failure, not evidence that the global dependency was deleted.
      const note = await readSavedArgumentReferenceNote({ ...sourceOptions, scope: base.scope }, base.source.entityId);
      if (!note) fail('source_unavailable');
      if (note.referenceSources?.some(citation => {
        const kind = citation.type === 'note' ? 'knowledge-note' : citation.type === 'document' ? 'uploaded-document' : null;
        const entityId = citation.entityId;
        return kind && entityId && !(kind === base.source.kind && entityId === base.source.entityId)
          && (!scope.allowedSourceKinds.includes(kind) || !(kind === 'knowledge-note' ? scope.allowedNoteIds : scope.allowedDocIds).includes(entityId));
      })) fail('scope_denied');
    }
    // Production qualification also binds checked internal provenance dependencies. A
    // later edit/delete to such a dependency must revoke admission, not only future
    // build tickets. The real library scope authorizes the dependency read; no wider
    // caller scope or renderer path is used. Old synthetic policy contracts are kept.
    try {
      const provenance = await readArgumentReferenceProvenance(sourceOptions, applied, scope);
      if (applied.sourceQualification.policyVersion === `${prefix}${provenance.fingerprint}`) return applied;
    } catch (error) {
      // An exact saved-original/snapshot mismatch is an observed change. Generic
      // I/O failures and pending/denied access are only unavailable verification:
      // hold this read rather than permanently tombstoning an unchanged source.
      const message = error instanceof Error ? error.message : '';
      if (message !== 'argument_saved_source_source_changed' && message !== 'argument_reference_policy_source_changed') throw error;
    }
    return structuredClone(base);
  }
  async function recordSourceReview(expectedValue: ArgumentProjectionBuildInput, reviewValue: SourceAdmissionReview,
    assertCurrent?: () => void): Promise<ArgumentProjectionBuildInput> {
    if (assertCurrent !== undefined && typeof assertCurrent !== 'function') fail('invalid_request');
    const expected = structuredClone(expectedValue), review = structuredClone(reviewValue);
    await validateArgumentProjectionBuildInput(expected);
    const ref = { kind: expected.source.kind, entityId: expected.source.entityId } as ArgumentProjectionSourceRef;
    validateArgumentProjectionSourceRef(ref); allowed(ref);
    const guarded = () => { current(); assertCurrent?.(); };
    guarded();
    return withRagSourceTransaction([dataRoot, vaultRoot, userStateDir], async () => {
      guarded(); await assertScopeCurrent?.(); guarded();
      const base = await rawSaved(ref);
      if (base === null) fail('source_unavailable');
      const currentInput = await qualifiedCurrent(base);
      if (await argumentContextHash(currentInput) !== await argumentContextHash(expected)) fail('source_changed');
      // Compare raw source identity, not the changing qualification/build binding. An
      // authorized admission change is expected; the ordinary withSource post-check
      // would incorrectly reject that legitimate change, hence this dedicated method.
      const rawHash = await argumentContextHash(base);
      guarded();
      await admission.record(base, review, guarded);
      const after = await rawSaved(ref);
      if (after === null || await argumentContextHash(after) !== rawHash) fail('source_changed');
      const output = await qualifiedCurrent(after);
      await assertScopeCurrent?.(); guarded();
      return structuredClone(output);
    });
  }
  const host: ArgumentProjectionAuthorityHost = {
    rootScopeId,
    assertCurrent: current,
    async withSourceValidity<T>(refValue: ArgumentProjectionSourceRef,
      action: (input: ArgumentProjectionBuildInput | null) => Promise<T>, onObservedChanged: () => Promise<void>): Promise<T> {
      const ref = structuredClone(refValue); validateArgumentProjectionSourceRef(ref); allowed(ref);
      if (typeof action !== 'function' || typeof onObservedChanged !== 'function') fail('invalid_request');
      current();
      return withRagSourceTransaction([dataRoot, vaultRoot, userStateDir], async () => {
        current(); await assertScopeCurrent?.(); current();
        const changed = async (): Promise<never> => {
          // Source changes are different from a lapsed/narrowed authorization or
          // a pending multi-file save. Recheck those before any derived write.
          await assertScopeCurrent?.(); current();
          await onObservedChanged();
          return fail('source_changed');
        };
        const read = async (): Promise<ArgumentProjectionBuildInput | null> => {
          try { return await saved(ref); }
          catch (error) {
            // Do not infer deletion from parse errors, EACCES, absent permission,
            // pending journals or generic I/O failures. Only an observed, exact
            // original-byte/snapshot mismatch can take this invalidation route.
            if (error instanceof Error && error.message === 'argument_saved_source_source_changed') return changed();
            throw error;
          }
        };
        const input = await read(), snapshotHash = await argumentContextHash(input);
        current();
        const result = await action(structuredClone(input));
        current();
        const after = await read();
        await assertScopeCurrent?.(); current();
        if (await argumentContextHash(after) !== snapshotHash) return changed();
        return result;
      });
    },
    async withSource<T>(refValue: ArgumentProjectionSourceRef, action: (input: ArgumentProjectionBuildInput | null) => Promise<T>): Promise<T> {
      const ref = structuredClone(refValue); validateArgumentProjectionSourceRef(ref); allowed(ref);
      if (typeof action !== 'function') fail('invalid_request');
      current();
      return withRagSourceTransaction([dataRoot, vaultRoot, userStateDir], async () => {
        current();
        await assertScopeCurrent?.();
        const input = await saved(ref), snapshotHash = await argumentContextHash(input);
        current();
        const result = await action(structuredClone(input));
        // An external edit during a short callback must not return the old snapshot as current.
        const after = await saved(ref);
        if (await argumentContextHash(after) !== snapshotHash) fail('source_changed');
        await assertScopeCurrent?.();
        current(); return result;
      });
    },
  };
  const store = createPersistentArgumentProjectionStore(path.join(userStateDir, 'argument-projections'), host);
  const held = (reasonCode: ArgumentProjectionRuntimeReason): ArgumentProjectionReadonlyResponse => ({ status: 'held', environmentId, reasonCode });
  async function execute(value: unknown): Promise<ArgumentProjectionReadonlyResponse> {
    let request: ArgumentProjectionReadonlyRequest;
    try { request = structuredClone(value) as ArgumentProjectionReadonlyRequest; validateRequest(request); }
    catch { return held('invalid_request'); }
    if (request.environmentId !== environmentId) return held('environment_changed');
    try {
      current();
      const selectedRef: ArgumentProjectionSourceRef = request.op === 'read' || request.op === 'read-task'
        ? { kind: request.pointer.source.kind as ArgumentProjectionSourceRef['kind'], entityId: request.pointer.source.entityId }
        : request.ref;
      // The enclosing live library lease, not pointer.scopeHash/source claims, grants access.
      validateArgumentProjectionSourceRef(selectedRef); allowed(selectedRef);
      if (request.op === 'source') {
        const input = await store.readSource(request.ref);
        return input === null
          ? { status: 'source_missing', environmentId }
          : { status: 'physical_source', environmentId, input: structuredClone(input) };
      }
      if (request.op === 'pointer') {
        const pointer = await createStoredArgumentContextPointer(store, request.ref, request.seedNodeIds);
        current();
        if (pointer) return { status: 'available', environmentId, pointer };
        // No active structure is not proof that the physical source is absent.
        return await host.withSource(request.ref, async input => input === null
          ? { status: 'source_missing', environmentId } : held('projection_unavailable'));
      }
      if (request.op === 'read-task') {
        const pack = await store.withActive(selectedRef, (result, input) => readTaskScopedArgumentContextPack(result.projection, result.authority,
          { pointer: request.pointer, scope: input.scope, task: request.task as import('../../services/argumentContext/taskScopedTypes.ts').ArgumentTaskScopedTask,
            ...(request.budget === undefined ? {} : { budget: request.budget }) }));
        current(); return pack === null ? held('projection_unavailable') : { status: 'available', environmentId, pack };
      }
      const pack = await readStoredArgumentContextPack(store, {
        pointer: request.pointer, task: request.task, ...(request.budget === undefined ? {} : { budget: request.budget }),
      });
      current(); return pack === null ? held('projection_unavailable') : { status: 'available', environmentId, pack };
    } catch (error) { return held(reasonFor(error, request.op)); }
  }
  return { host, store, admission, recordSourceReview, execute };
}
