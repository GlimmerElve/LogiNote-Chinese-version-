import { createArgumentContextPointer, readArgumentContextPack } from '../../services/argumentContext/reader.ts';
import { ARGUMENT_CONTEXT_TASKS } from '../../services/argumentContext/types.ts';
import type { ArgumentContextBudget, ArgumentContextPack, ArgumentContextPointer, ArgumentContextTask } from '../../services/argumentContext/types.ts';
import { validateArgumentProjectionSourceRef } from './argumentProjectionAuthority.ts';
import type { ArgumentProjectionSourceRef } from './argumentProjectionAuthority.ts';
import type { PersistentArgumentProjectionStore } from './argumentProjectionStore.ts';

/** Internal host read API, not a renderer-supplied authority or a new Agent permission. */
export async function createStoredArgumentContextPointer(store: PersistentArgumentProjectionStore,
  sourceRef: ArgumentProjectionSourceRef, seedNodeIds: string[]): Promise<ArgumentContextPointer | null> {
  const ref = structuredClone(sourceRef), seeds = structuredClone(seedNodeIds);
  validateArgumentProjectionSourceRef(ref);
  return store.withActive(ref, async (result, input) =>
    createArgumentContextPointer(result.projection, result.authority, input.scope, seeds));
}

/**
 * Read against the persisted proof and independently supplied CURRENT host scope.
 * No top-k preview fallback, no caller-provided projection, no implied source quality.
 * withActive encloses the pure reader in the source transaction; do not call the store
 * again inside the callback, or wait there for a model or user.
 */
export async function readStoredArgumentContextPack(store: PersistentArgumentProjectionStore,
  requestValue: { pointer: ArgumentContextPointer; task: ArgumentContextTask; budget?: Partial<ArgumentContextBudget> }): Promise<ArgumentContextPack | null> {
  const request = structuredClone(requestValue);
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some((key) => !['pointer', 'task', 'budget'].includes(key))
    || !Object.hasOwn(request, 'pointer') || !Object.hasOwn(request, 'task')
    || !ARGUMENT_CONTEXT_TASKS.includes(request.task)) throw new Error('argument_stored_reader_invalid_request');
  const ref = { kind: request.pointer?.source?.kind, entityId: request.pointer?.source?.entityId };
  validateArgumentProjectionSourceRef(ref);
  return store.withActive(ref, async (result, input) =>
    readArgumentContextPack(result.projection, result.authority, { ...request, scope: input.scope }));
}
