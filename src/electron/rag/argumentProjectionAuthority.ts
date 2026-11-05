import type { ArgumentProjectionBuildInput } from '../../services/argumentContext/buildTypes.ts';

/** A reference selector, not caller-supplied canonical text, path, quality or permission. */
export interface ArgumentProjectionSourceRef {
  kind: 'knowledge-note' | 'uploaded-document';
  entityId: string;
}

/**
 * Trusted host boundary. The callback runs inside the SAME short source transaction as
 * source mutation/selection changes, with an independently read saved snapshot and scope.
 * Never hold this lock over a model call or user approval. A callback/provider that merely
 * accepts the candidate's input or reads a renderer draft does not implement this contract.
 * External filesystem edits require extra before/after freshness checks at the adapter.
 * No production IPC implementation is installed by this interface alone.
 */
export interface ArgumentProjectionAuthorityHost {
  rootScopeId: string;
  /** Synchronous host lease check, including directly before persistent rename. No locks or I/O. */
  assertCurrent?: () => void;
  withSource<T>(ref: ArgumentProjectionSourceRef,
    action: (input: ArgumentProjectionBuildInput | null) => Promise<T>): Promise<T>;
  /**
   * Store-only freshness boundary. action runs at most once; onObservedChanged is
   * a separate invalidation-only callback (also at most once), never a replay of
   * publication or the consumer reader. It may run before OR after action when
   * the host observes an exact physical-source/binding change. Both callbacks run
   * in the same source transaction, with current host membership checked again.
   * Pending saves, scope denial and generic read failures must not invoke it.
   */
  withSourceValidity?<T>(ref: ArgumentProjectionSourceRef,
    action: (input: ArgumentProjectionBuildInput | null) => Promise<T>,
    onObservedChanged: () => Promise<void>): Promise<T>;
}

export function validateArgumentProjectionSourceRef(value: unknown): asserts value is ArgumentProjectionSourceRef {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 2 || !Object.hasOwn(value, 'kind') || !Object.hasOwn(value, 'entityId')) {
    throw new Error('argument_authority_invalid_ref');
  }
  const ref = value as ArgumentProjectionSourceRef;
  if (!['knowledge-note', 'uploaded-document'].includes(ref.kind) || typeof ref.entityId !== 'string'
    || !ref.entityId.length || ref.entityId.length > 300 || ref.entityId !== ref.entityId.trim()
    || /[\u0000-\u001f\u007f]/u.test(ref.entityId) || /^(?:[a-z]:[\\/]|[\\/])/iu.test(ref.entityId)) {
    throw new Error('argument_authority_invalid_ref');
  }
}
