import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { withRagSourceTransaction } from '../ragSourceTransactions.ts';
import { createArgumentProjectionRuntime } from './argumentProjectionRuntime.ts';
import type { ArgumentContextScope } from '../../services/argumentContext/types.ts';
import { deriveArgumentLearningScope, parseArgumentEnvironmentSelection, type ArgumentEnvironmentSelection } from './argumentLearningScope.ts';

export interface ArgumentProjectionRoots { dataRoot: string; vaultRoot: string; userStateDir: string }
export type ArgumentProjectionEnvironmentReply =
  | { status: 'available'; environmentId: string; scope: 'reference_library' | 'learning_note'; noteCount: number; documentCount: number }
  | { status: 'held'; reasonCode: 'environment_unavailable' };

function normalizedRoots(roots: ArgumentProjectionRoots): ArgumentProjectionRoots {
  const resolve = (value: string) => {
    if (typeof value !== 'string' || !path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('invalid_root');
    const absolute = path.resolve(value);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  return { dataRoot: resolve(roots.dataRoot), vaultRoot: resolve(roots.vaultRoot), userStateDir: resolve(roots.userStateDir) };
}
function rootFingerprint(roots: ArgumentProjectionRoots): string {
  return createHash('sha256').update(JSON.stringify(roots)).digest('hex');
}
function safeId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 300 && value === value.trim()
    && !/[<>:"/\\|?*\u0000-\u001f\u007f]/u.test(value) && !['.', '..'].includes(value);
}
async function catalogFile(file: string): Promise<Buffer | null> {
  try {
    // Missing first-run catalogs are empty; corruption is not an empty library.
    const parent = await fs.lstat(path.dirname(file));
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new Error('unsafe_catalog');
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4 * 1024 * 1024) throw new Error('unsafe_catalog');
    const bytes = await fs.readFile(file);
    if (bytes.length > 4 * 1024 * 1024 || !Buffer.from(bytes.toString('utf8'), 'utf8').equals(bytes)) throw new Error('unsafe_catalog');
    return bytes;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function readLibraryScope(roots: ArgumentProjectionRoots, selection: ArgumentEnvironmentSelection): Promise<ArgumentContextScope> {
  try { await fs.lstat(path.join(roots.userStateDir, 'vault-pending-snapshot.json')); throw new Error('save_in_progress'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const metadataFile = path.join(roots.vaultRoot, 'metadata.json'), manifestFile = path.join(roots.dataRoot, 'rag-index', 'manifest.json');
  const metadata = await catalogFile(metadataFile), manifest = await catalogFile(manifestFile);
  const notes = metadata ? JSON.parse(metadata.toString('utf8')) : { version: 1, notesMeta: {} };
  if (!notes || notes.version !== 1 || !notes.notesMeta || typeof notes.notesMeta !== 'object' || Array.isArray(notes.notesMeta)) throw new Error('invalid_catalog');
  const docs = manifest ? JSON.parse(manifest.toString('utf8')) : [];
  if (!Array.isArray(docs) || docs.length > 10000 || Object.keys(notes.notesMeta).length > 10000) throw new Error('invalid_catalog');
  Object.entries(notes.notesMeta).forEach(([id, meta]: [string, any]) => {
    if (!safeId(id) || !meta || meta.id !== id) throw new Error('invalid_catalog');
  });
  const allowedDocIds = docs.flatMap((doc: any) => {
    if (!doc || !safeId(doc.id)) throw new Error('invalid_catalog');
    return doc.indexable === true ? [doc.id] : [];
  }).sort();
  if (new Set(docs.map((doc: any) => doc.id)).size !== docs.length) throw new Error('invalid_catalog');
  const afterMetadata = await catalogFile(metadataFile), afterManifest = await catalogFile(manifestFile);
  if (!(metadata === null ? afterMetadata === null : afterMetadata?.equals(metadata))
    || !(manifest === null ? afterManifest === null : afterManifest?.equals(manifest))) throw new Error('catalog_changed');
  const rootScopeId = `reference-root-${rootFingerprint(roots)}`;
  return deriveArgumentLearningScope(Object.values(notes.notesMeta), allowedDocIds, rootScopeId, selection);
}

/**
 * Independently issued library or saved learning-note scope. Renderer selectors
 * cannot supply membership or extend this scope. Membership is re-read under each
 * source transaction, including changes made outside this application's writers.
 * One lease per webContents; navigation, replacement and root/reset revocation
 * prevent replay, including root A -> B -> A. No paths are returned to the caller.
 */
export function createArgumentProjectionEnvironmentRegistry(getRoots: () => ArgumentProjectionRoots,
  isAvailable: () => boolean = () => true) {
  let epoch = 0;
  type Lease = { environmentId: string; runtime?: ReturnType<typeof createArgumentProjectionRuntime>;
    roots?: ArgumentProjectionRoots; scope?: ArgumentContextScope; selection?: ArgumentEnvironmentSelection; assertScopeCurrent?: () => Promise<void> };
  const leases = new Map<number, Lease>();
  function revoke(owner?: number): void {
    if (owner === undefined) { epoch++; leases.clear(); }
    else leases.delete(owner);
  }
  async function getEnvironment(owner: number, selectionValue?: unknown): Promise<ArgumentProjectionEnvironmentReply> {
    try {
      if (!Number.isSafeInteger(owner) || owner < 0) throw new Error('invalid_owner');
      if (!isAvailable()) { revoke(); throw new Error('environment_suspended'); }
      // Even an invalid replacement cannot retain an earlier, wider library lease.
      revoke(owner);
      const selection = parseArgumentEnvironmentSelection(selectionValue);
      // Replacement invalidates the previous lease before any awaited catalog read.
      const roots = normalizedRoots(getRoots()), fingerprint = rootFingerprint(roots), issuingEpoch = epoch;
      const environmentId = randomUUID();
      // Reserve a marker now: concurrent issuance for this owner is latest-wins.
      leases.set(owner, { environmentId });
      let lapsed = false;
      const current = () => {
        // Once an environment mismatch is observed, returning to the same root
        // must not revive this lease, even if a host forgot explicit revoke().
        if (lapsed) return false;
        try {
          if (!isAvailable() || issuingEpoch !== epoch || leases.get(owner)?.environmentId !== environmentId
            || rootFingerprint(normalizedRoots(getRoots())) !== fingerprint) lapsed = true;
        } catch { lapsed = true; }
        return !lapsed;
      };
      const scope = await withRagSourceTransaction(Object.values(roots), async () => {
        if (!current()) throw new Error('environment_changed');
        const scope = await readLibraryScope(roots, selection);
        if (!current()) throw new Error('environment_changed');
        return scope;
      });
      const assertScopeCurrent = async () => {
        if (!current()) throw new Error('argument_projection_runtime_environment_changed');
        try {
          if (JSON.stringify(await readLibraryScope(roots, selection)) !== JSON.stringify(scope)) lapsed = true;
        } catch { lapsed = true; }
        if (!current()) throw new Error('argument_projection_runtime_environment_changed');
      };
      const runtime = createArgumentProjectionRuntime({ ...roots, environmentId, rootScopeId: scope.rootScopeId, scope,
        isCurrent: current, assertScopeCurrent, dependencyAccessFailureIsScoped: selection.kind === 'learning-note' });
      if (!current()) throw new Error('environment_changed');
      leases.set(owner, { environmentId, runtime, roots, scope, selection, assertScopeCurrent });
      return { status: 'available', environmentId, scope: selection.kind === 'library' ? 'reference_library' : 'learning_note',
        noteCount: scope.allowedNoteIds.length, documentCount: scope.allowedDocIds.length };
    } catch {
      // Do not delete a newer concurrently issued lease.
      return { status: 'held', reasonCode: 'environment_unavailable' };
    }
  }
  async function execute(owner: number, request: unknown) {
    if (!isAvailable()) { revoke(); return { status: 'held' as const, reasonCode: 'environment_changed' }; }
    const lease = leases.get(owner);
    if (!lease?.runtime || !request || typeof request !== 'object'
      || (request as { environmentId?: unknown }).environmentId !== lease.environmentId) {
      return { status: 'held' as const, reasonCode: 'environment_changed' };
    }
    return lease.runtime.execute(request);
  }
  /** Host-only bridge. Never expose the runtime, roots or authority through IPC. */
  async function withEnvironment<T>(owner: number, environmentId: string,
    action: (runtime: ReturnType<typeof createArgumentProjectionRuntime>, roots: ArgumentProjectionRoots,
      scope: ArgumentContextScope, selection: ArgumentEnvironmentSelection) => Promise<T>): Promise<T> {
    const lease = leases.get(owner);
    if (!isAvailable() || !lease?.runtime || !lease.roots || !lease.scope || !lease.selection
      || lease.environmentId !== environmentId) throw new Error('environment_changed');
    const check = () => withRagSourceTransaction(Object.values(lease.roots!), lease.assertScopeCurrent!);
    await check();
    const result = await action(lease.runtime, structuredClone(lease.roots), structuredClone(lease.scope), structuredClone(lease.selection));
    await check(); return result;
  }
  return { getEnvironment, execute, withEnvironment, revoke };
}
