import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { argumentContextHash } from '../../services/argumentContext/hash.ts';
import { validateSourcePropositions, type SourcePropositionProof } from '../../services/reviewComparison/sourcePropositionAnchors.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionBuildResult } from '../../services/argumentContext/buildTypes.ts';
import { validateArgumentProjectionSourceRef, type ArgumentProjectionSourceRef } from './argumentProjectionAuthority.ts';
import type { ArgumentProjectionActiveBinding, PersistentArgumentProjectionStore } from './argumentProjectionStore.ts';

export const SOURCE_PROPOSITION_STORE_LIMITS = { sources: 256, proofCharacters: 256000, bytes: 32 * 1024 * 1024 } as const;
export interface PersistentSourcePropositionStore {
  /** Read-only on a current source; an observed invalidation writes derived tombstones only. */
  read(ref: ArgumentProjectionSourceRef, guard?: () => void): Promise<SourcePropositionProof | null>;
  publish(ref: ArgumentProjectionSourceRef, expectedBinding: ArgumentProjectionActiveBinding, proof: SourcePropositionProof,
    guard?: () => void): Promise<{ status: 'stored'; bundleHash: string; retention: 'persistent' }
      | { status: 'held'; reasons: string[] }>;
}
interface StoredAsset {
  binding: ArgumentProjectionActiveBinding; sourceBindingHash: string; scopeHash: string;
  proof: SourcePropositionProof; proofHash: string;
}
interface SourceRow {
  keyHash: string; ref: ArgumentProjectionSourceRef; revision: number; active: StoredAsset | null;
  tombstone: { bindingHash: string; reason: 'publication_changed' | 'source_unavailable' } | null;
}
interface Ledger {
  version: 1; contractVersion: 'reference-source-proposition-ledger-v1'; rootScopeId: string;
  generation: number; sources: SourceRow[]; ledgerHash: string;
}
class StoreError extends Error {}
const fail = (code: string): never => { throw new StoreError(`source_proposition_store_${code}`); };
const HASH = /^[a-f0-9]{64}$/u;
const queues = new Map<string, Promise<void>>();
const sha = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
export const sourcePropositionLedgerFileName = (rootScopeId: string) => `reference-source-propositions-${sha(rootScopeId)}.json`;
function data(value: unknown, depth = 0): void {
  if (depth > 64) fail('invalid_data');
  if (value === null || typeof value === 'boolean' || typeof value === 'string'
    || typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object') fail('invalid_data');
  if (Array.isArray(value)) {
    if (value.length > 4096 || Reflect.ownKeys(value).length !== value.length + 1
      || Object.keys(value).some((key, index) => key !== String(index))) fail('invalid_data');
  } else if (![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Reflect.ownKeys(value as object).some(key => typeof key !== 'string')) fail('invalid_data');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value as object))) {
    if (!Object.hasOwn(descriptor, 'value') || (key !== 'length' || !Array.isArray(value)) && !descriptor.enumerable) fail('invalid_data');
    if (key !== 'length' || !Array.isArray(value)) data(descriptor.value, depth + 1);
  }
}
function closed(value: unknown, fields: string[]) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('|') !== [...fields].sort().join('|')) fail('invalid_shape');
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 300 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value) || /^(?:[a-z]:[\\/]|[\\/])/iu.test(value)) fail('invalid_id');
}
function hash(value: unknown): void { if (typeof value !== 'string' || !HASH.test(value)) fail('invalid_hash'); }
function integer(value: unknown): void { if (!Number.isSafeInteger(value) || (value as number) < 1) fail('invalid_integer'); }
function refShape(value: ArgumentProjectionSourceRef) {
  data(value); closed(value, ['kind', 'entityId']); validateArgumentProjectionSourceRef(value);
}
function bindingShape(value: ArgumentProjectionActiveBinding) {
  data(value); closed(value, ['publicationId', 'epoch', 'resultHash', 'structureHash']);
  id(value.publicationId); integer(value.epoch); hash(value.resultHash); hash(value.structureHash);
}
const key = (root: string, ref: ArgumentProjectionSourceRef) => sha(JSON.stringify([root, 'reference-propositions', ref.kind, ref.entityId]));
const same = async (left: unknown, right: unknown) => await argumentContextHash(left) === await argumentContextHash(right);
function proofShape(proof: SourcePropositionProof, ref: ArgumentProjectionSourceRef, root: string) {
  data(proof); closed(proof, ['input', 'result', 'draft', 'review', 'bundle']);
  if (JSON.stringify(proof).length > SOURCE_PROPOSITION_STORE_LIMITS.proofCharacters) fail('proof_budget');
  if (proof.input.source.rootScopeId !== root || proof.input.scope.rootScopeId !== root || proof.input.scope.corpus !== 'reference'
    || proof.input.source.kind !== ref.kind || proof.input.source.entityId !== ref.entityId) fail('wrong_source');
}
async function rebuild(proof: SourcePropositionProof, ref: ArgumentProjectionSourceRef, root: string) {
  proofShape(proof, ref, root);
  const result = await validateSourcePropositions(proof.input, proof.result, proof.bundle, { draft: proof.draft, review: proof.review });
  if (result.status !== 'ready') fail('proof_invalid');
}
async function safeDirectory(directory: string, create: boolean): Promise<boolean> {
  const root = path.parse(directory).root;
  let current = root;
  for (const part of [null, ...path.relative(root, directory).split(path.sep).filter(Boolean)] as (string | null)[]) {
    if (part !== null) current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return false;
      await fs.mkdir(current); stat = await fs.lstat(current);
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('unsafe_directory');
  }
  return true;
}
async function readBytes(target: string, missing: boolean): Promise<Buffer | null> {
  let stat;
  try { stat = await fs.lstat(target); }
  catch (error) { if (missing && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > SOURCE_PROPOSITION_STORE_LIMITS.bytes) fail('unsafe_file');
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > SOURCE_PROPOSITION_STORE_LIMITS.bytes || opened.ino !== stat.ino || opened.dev !== stat.dev) fail('file_changed');
    const bytes = await handle.readFile();
    if (bytes.length > SOURCE_PROPOSITION_STORE_LIMITS.bytes) fail('file_budget');
    return bytes;
  } finally { await handle.close(); }
}
function observedSourceChange(error: unknown): boolean {
  return error instanceof Error && error.message === 'argument_projection_store_source_changed';
}

/**
 * Host-only derived audit ledger. Lock order is derived-directory queue →
 * projection active/source transaction. No models, user waits or nested
 * projection calls occur inside that transaction. Current saved-source authority
 * is supplied ONLY by withActiveBinding, never by self-recomputed hashes.
 * Same-process instances share a queue. Cross-process writers/unobserved external
 * source ABA still require a future host-level mechanism.
 */
export function createPersistentSourcePropositionStore(directoryInput: string, projections: PersistentArgumentProjectionStore,
  rootScopeId: string, options: { write?: (temp: string, text: string) => Promise<unknown> } = {}): PersistentSourcePropositionStore {
  if (typeof directoryInput !== 'string' || !path.isAbsolute(directoryInput)) fail('absolute_directory_required');
  id(rootScopeId); if (/[\\/]/u.test(rootScopeId)) fail('invalid_root');
  const activeReader = projections.withActiveBinding, writer = options.write;
  if (typeof activeReader !== 'function') fail('active_binding_required');
  if (writer !== undefined && typeof writer !== 'function') fail('invalid_writer');
  const active = activeReader!.bind(projections);
  const directory = path.resolve(directoryInput), target = path.join(directory, sourcePropositionLedgerFileName(rootScopeId));
  const queueKey = process.platform === 'win32' ? directory.toLowerCase() : directory;
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const prior = queues.get(queueKey) ?? Promise.resolve(), job = prior.then(action), tail = job.then(() => undefined, () => undefined);
    queues.set(queueKey, tail);
    void tail.then(() => { if (queues.get(queueKey) === tail) queues.delete(queueKey); });
    return job;
  }
  function current(guard?: () => void) { guard?.(); }
  async function validateLedger(ledger: Ledger) {
    data(ledger); closed(ledger, ['version', 'contractVersion', 'rootScopeId', 'generation', 'sources', 'ledgerHash']);
    if (ledger.version !== 1 || ledger.contractVersion !== 'reference-source-proposition-ledger-v1' || ledger.rootScopeId !== rootScopeId) fail('wrong_ledger');
    integer(ledger.generation); hash(ledger.ledgerHash);
    if (!Array.isArray(ledger.sources) || ledger.sources.length > SOURCE_PROPOSITION_STORE_LIMITS.sources) fail('source_capacity');
    const keys = new Set<string>();
    for (const row of ledger.sources) {
      closed(row, ['keyHash', 'ref', 'revision', 'active', 'tombstone']); refShape(row.ref); integer(row.revision); hash(row.keyHash);
      if (row.keyHash !== key(rootScopeId, row.ref) || keys.has(row.keyHash)) fail('invalid_source_key'); keys.add(row.keyHash);
      if (row.active !== null) {
        closed(row.active, ['binding', 'sourceBindingHash', 'scopeHash', 'proof', 'proofHash']);
        bindingShape(row.active.binding); hash(row.active.sourceBindingHash); hash(row.active.scopeHash); hash(row.active.proofHash);
        await rebuild(row.active.proof, row.ref, rootScopeId);
        if (row.active.binding.resultHash !== row.active.proof.result.resultHash
          || row.active.binding.structureHash !== row.active.proof.result.authority.structureHash
          || row.active.sourceBindingHash !== row.active.proof.input.sourceBindingHash || row.active.scopeHash !== row.active.proof.input.scopeHash
          || row.active.proofHash !== await argumentContextHash(row.active.proof) || row.tombstone !== null) fail('record_binding_changed');
      } else {
        if (row.tombstone === null) fail('missing_tombstone');
        closed(row.tombstone, ['bindingHash', 'reason']); hash(row.tombstone.bindingHash);
        if (!['publication_changed', 'source_unavailable'].includes(row.tombstone.reason)) fail('invalid_tombstone');
      }
    }
    const { ledgerHash: _hash, ...body } = ledger;
    if (await argumentContextHash(body) !== ledger.ledgerHash) fail('ledger_hash_changed');
  }
  async function load(): Promise<Ledger | null> {
    if (!await safeDirectory(directory, false)) return null;
    const bytes = await readBytes(target, true); if (!bytes) return null;
    const text = bytes.toString('utf8'); if (!Buffer.from(text, 'utf8').equals(bytes)) fail('invalid_utf8');
    let ledger: Ledger; try { ledger = JSON.parse(text) as Ledger; } catch { return fail('corrupt_json'); }
    await validateLedger(ledger); return ledger;
  }
  function empty(): Ledger {
    return { version: 1, contractVersion: 'reference-source-proposition-ledger-v1', rootScopeId, generation: 0, sources: [], ledgerHash: '0'.repeat(64) };
  }
  async function commit(ledger: Ledger, guard?: () => void) {
    current(guard); if (ledger.generation >= Number.MAX_SAFE_INTEGER) fail('generation_overflow');
    ledger.generation++; const { ledgerHash: _old, ...body } = ledger; ledger.ledgerHash = await argumentContextHash(body);
    const text = JSON.stringify(ledger), expected = Buffer.from(text, 'utf8');
    if (expected.length > SOURCE_PROPOSITION_STORE_LIMITS.bytes) fail('file_budget');
    await safeDirectory(directory, true); current(guard);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    let renamed = false;
    try {
      if (writer) await writer(temp, text);
      else {
        const handle = await fs.open(temp, 'wx', 0o600);
        try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      }
      const actual = await readBytes(temp, false);
      if (!actual || !actual.equals(expected)) fail('temporary_payload_changed');
      const before = await fs.lstat(temp), handle = await fs.open(temp, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || before.isSymbolicLink() || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== expected.length) fail('temporary_file_changed');
        await handle.sync();
      } finally { await handle.close(); }
      if (!await safeDirectory(directory, false)) fail('directory_changed');
      // Do not replace an unexpected directory/link. No copy/unlink fallback.
      await readBytes(target, true);
      current(guard); await fs.rename(temp, target); renamed = true;
      try { current(guard); } catch { return fail('committed_lease_revoked'); }
    } catch (error) {
      if (renamed && !(error instanceof StoreError)) fail('committed_lease_revoked');
      throw error;
    } finally { await fs.unlink(temp).catch(() => {}); }
  }
  async function invalidate(ledger: Ledger | null, ref: ArgumentProjectionSourceRef,
    reason: 'publication_changed' | 'source_unavailable', guard?: () => void) {
    const row = ledger?.sources.find(item => item.keyHash === key(rootScopeId, ref));
    if (!ledger || !row?.active) return;
    if (row.revision >= Number.MAX_SAFE_INTEGER) fail('revision_overflow');
    row.tombstone = { bindingHash: await argumentContextHash(row.active.binding), reason }; row.active = null; row.revision++;
    await commit(ledger, guard);
  }
  async function matches(asset: StoredAsset, input: ArgumentProjectionBuildInput, result: ArgumentProjectionBuildResult,
    binding: ArgumentProjectionActiveBinding, ref: ArgumentProjectionSourceRef) {
    bindingShape(binding);
    if (input.source.rootScopeId !== rootScopeId || input.scope.rootScopeId !== rootScopeId || input.scope.corpus !== 'reference'
      || input.source.kind !== ref.kind || input.source.entityId !== ref.entityId) fail('host_source_mismatch');
    return await same(asset.binding, binding) && await same(asset.proof.input, input) && await same(asset.proof.result, result);
  }
  async function read(refValue: ArgumentProjectionSourceRef, guard?: () => void): Promise<SourcePropositionProof | null> {
    if (guard !== undefined && typeof guard !== 'function') fail('invalid_guard'); current(guard);
    refShape(refValue); const ref = structuredClone(refValue);
    return serial(async () => {
      current(guard); let ledger: Ledger | null = null;
      try {
        const reply = await active(ref, async (result, input, binding) => {
          current(guard); ledger = await load(); current(guard);
          const row = ledger?.sources.find(item => item.keyHash === key(rootScopeId, ref));
          if (!row?.active) return null;
          if (!await matches(row.active, input, result, binding, ref)) {
            await invalidate(ledger, ref, 'publication_changed', guard); return null;
          }
          await rebuild(row.active.proof, ref, rootScopeId); current(guard); return structuredClone(row.active.proof);
        });
        current(guard);
        if (reply === null) { ledger ??= await load(); await invalidate(ledger, ref, 'source_unavailable', guard); }
        return reply;
      } catch (error) {
        // Only the trusted projection store's confirmed physical-source failure
        // is invalidation authority. Permissions/pending/corruption are not.
        if (observedSourceChange(error)) { current(guard); await invalidate(await load(), ref, 'source_unavailable', guard); return null; }
        if (error instanceof StoreError) throw error;
        return fail('read_unavailable');
      }
    });
  }
  async function publish(refValue: ArgumentProjectionSourceRef, expectedValue: ArgumentProjectionActiveBinding,
    proofValue: SourcePropositionProof, guard?: () => void) {
    try {
      if (guard !== undefined && typeof guard !== 'function') fail('invalid_guard'); current(guard);
      refShape(refValue); bindingShape(expectedValue); proofShape(proofValue, refValue, rootScopeId);
      const ref = structuredClone(refValue), expected = structuredClone(expectedValue), proof = structuredClone(proofValue);
      return await serial(async () => {
        current(guard);
        try {
          const stored = await active(ref, async (result, input, binding) => {
            current(guard); const ledger = await load() ?? empty();
            let row = ledger.sources.find(item => item.keyHash === key(rootScopeId, ref));
            const asset: StoredAsset = { binding: expected, sourceBindingHash: proof.input.sourceBindingHash,
              scopeHash: proof.input.scopeHash, proof, proofHash: await argumentContextHash(proof) };
            if (!await matches(asset, input, result, binding, ref)) {
              if (row?.active && !await matches(row.active, input, result, binding, ref)) await invalidate(ledger, ref, 'publication_changed', guard);
              fail('publication_changed');
            }
            await rebuild(proof, ref, rootScopeId); current(guard);
            if (row?.active && await same(row.active, asset)) return { status: 'stored' as const, bundleHash: proof.bundle.bundleHash, retention: 'persistent' as const };
            // Never overwrite a different audit for the same active publication.
            if (row?.active && await same(row.active.binding, expected)) fail('audit_conflict');
            if (!row) {
              if (ledger.sources.length >= SOURCE_PROPOSITION_STORE_LIMITS.sources) fail('source_capacity');
              row = { keyHash: key(rootScopeId, ref), ref, revision: 1, active: asset, tombstone: null }; ledger.sources.push(row);
            } else {
              if (row.revision >= Number.MAX_SAFE_INTEGER) fail('revision_overflow');
              row.revision++; row.active = asset; row.tombstone = null;
            }
            await commit(ledger, guard); current(guard);
            return { status: 'stored' as const, bundleHash: proof.bundle.bundleHash, retention: 'persistent' as const };
          });
          current(guard);
          if (stored === null) { await invalidate(await load(), ref, 'source_unavailable', guard); fail('source_unavailable'); }
          return stored;
        } catch (error) {
          if (observedSourceChange(error)) { current(guard); await invalidate(await load(), ref, 'source_unavailable', guard); fail('source_unavailable'); }
          throw error;
        }
      });
    } catch (error) {
      return { status: 'held' as const, reasons: [error instanceof StoreError ? error.message : 'source_proposition_store_publish_unavailable'] };
    }
  }
  return { read, publish };
}
