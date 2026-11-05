import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { argumentContextHash } from '../../services/argumentContext/hash.ts';
import { validateArgumentProjectionBuildInput, verifyArgumentProjectionBuildResult } from '../../services/argumentContext/construction.ts';
import type { ArgumentProjectionBuildInput, ArgumentProjectionBuildProof, ArgumentProjectionBuildResult } from '../../services/argumentContext/buildTypes.ts';
import type { ArgumentProjectionPublicationReceipt } from '../../services/argumentContext/publication.ts';
import type { ArgumentProjectionAuthorityHost, ArgumentProjectionSourceRef } from './argumentProjectionAuthority.ts';
import { reviewedTaskScopeNodeIds } from '../../services/argumentContext/scopedAdmission.ts';

export const ARGUMENT_PROJECTION_STORE_LIMITS = { sources: 256, operations: 512, bytes: 32 * 1024 * 1024 } as const;
export interface PersistentArgumentProjectionPublicationRequest {
  publicationId: string;
  result: ArgumentProjectionBuildResult;
  proof: ArgumentProjectionBuildProof;
  expectedActiveHash: string | null;
}
export interface PersistentArgumentProjectionPublicationReceipt extends ArgumentProjectionPublicationReceipt {
  /** Only this derived ledger is persisted; original notes, old RAG indexes and scores are untouched. */
  persistence: { kind: 'derived-reference-ledger'; strategy: 'rename-only' };
}
export interface PersistentArgumentProjectionStore {
  publish(request: PersistentArgumentProjectionPublicationRequest, assertCurrent?: () => void): Promise<PersistentArgumentProjectionPublicationReceipt>;
  /** Host-only saved-source read, with observed derived invalidation in the SAME freshness transaction. */
  readSource(ref: ArgumentProjectionSourceRef): Promise<ArgumentProjectionBuildInput | null>;
  read(ref: ArgumentProjectionSourceRef): Promise<ArgumentProjectionBuildResult | null>;
  readStaged(ref: ArgumentProjectionSourceRef, publicationId: string): Promise<ArgumentProjectionBuildResult | null>;
  /** Trusted pure reader only: no model/UI waits or nested store call while this lease is held. */
  withActive<T>(ref: ArgumentProjectionSourceRef,
    action: (result: ArgumentProjectionBuildResult, input: ArgumentProjectionBuildInput) => Promise<T>): Promise<T | null>;
  /** Host-only short read. Publication epoch is not a model/renderer authority. */
  withActiveBinding?<T>(ref: ArgumentProjectionSourceRef, action: (result: ArgumentProjectionBuildResult,
    input: ArgumentProjectionBuildInput, binding: ArgumentProjectionActiveBinding) => Promise<T>): Promise<T | null>;
}
export interface ArgumentProjectionActiveBinding {
  publicationId: string; epoch: number; resultHash: string; structureHash: string;
}
interface SourceBinding { sourceBindingHash: string; scopeHash: string; sourceHash: string; buildId: string }
interface StoredOperation {
  publicationId: string; fingerprint: string; epoch: number; binding: SourceBinding;
  request: PersistentArgumentProjectionPublicationRequest; receipt: PersistentArgumentProjectionPublicationReceipt;
}
interface SourceRow {
  keyHash: string; ref: ArgumentProjectionSourceRef; epoch: number; current: SourceBinding | null;
  activePublicationId: string | null; operations: StoredOperation[];
}
interface ProjectionLedger {
  version: 1; contractVersion: 'argument-projection-ledger-v1'; rootScopeId: string;
  generation: number; sources: SourceRow[]; ledgerHash: string;
}

const HASH = /^[a-f0-9]{64}$/u;
const PERSISTENCE = { kind: 'derived-reference-ledger' as const, strategy: 'rename-only' as const };
// The queue is shared by every instance in this process, not hidden inside a factory instance.
const directoryQueues = new Map<string, Promise<void>>();
const fail = (reason: string): never => { throw new Error(`argument_projection_store_${reason}`); };
const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
export const argumentProjectionLedgerFileName = (rootScopeId: string): string => `argument-projection-${sha(rootScopeId)}.json`;

function closed(value: unknown, fields: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_shape');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(object, key))) fail('invalid_shape');
}
function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > 300 || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value) || /^(?:[a-z]:[\\/]|[\\/])/iu.test(value)) fail('invalid_id');
}
function hash(value: unknown): asserts value is string { if (typeof value !== 'string' || !HASH.test(value)) fail('invalid_hash'); }
function integer(value: unknown): asserts value is number { if (!Number.isSafeInteger(value) || (value as number) < 1) fail('invalid_integer'); }
function refShape(ref: ArgumentProjectionSourceRef): void {
  closed(ref, ['kind', 'entityId']); id(ref.entityId);
  if (ref.kind !== 'knowledge-note' && ref.kind !== 'uploaded-document') fail('reference_only');
}
function bindingShape(binding: SourceBinding): void {
  closed(binding, ['sourceBindingHash', 'scopeHash', 'sourceHash', 'buildId']); Object.values(binding).forEach(hash);
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ak = Object.keys(a).sort(), bk = Object.keys(b).sort();
  return ak.length === bk.length && ak.every((key, index) => key === bk[index]
    && equal((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}
function requestShape(request: PersistentArgumentProjectionPublicationRequest): void {
  closed(request, ['publicationId', 'result', 'proof', 'expectedActiveHash']); id(request.publicationId);
  if (request.expectedActiveHash !== null) hash(request.expectedActiveHash);
}
function sourceRef(input: ArgumentProjectionBuildInput): ArgumentProjectionSourceRef {
  const ref = { kind: input.source.kind, entityId: input.source.entityId } as ArgumentProjectionSourceRef;
  refShape(ref); return ref;
}
function rowKey(root: string, ref: ArgumentProjectionSourceRef): string { return sha(JSON.stringify([root, 'reference', ref.kind, ref.entityId])); }
async function bindingOf(input: ArgumentProjectionBuildInput): Promise<SourceBinding> {
  return { sourceBindingHash: input.sourceBindingHash, scopeHash: input.scopeHash,
    sourceHash: await argumentContextHash(input.source), buildId: input.buildId };
}
function reasonsFor(result: ArgumentProjectionBuildResult): string[] {
  const reasons: string[] = [];
  const scoped = result.status === 'reviewed_scoped' && reviewedTaskScopeNodeIds(result.projection).length > 0;
  if (result.status !== 'reviewed_complete' && !scoped) reasons.push('review_incomplete');
  if (result.projection.build.origin !== 'validated-projection') reasons.push('legacy_not_publishable');
  if (!scoped && result.projection.build.gaps.length) reasons.push('build_gaps');
  if (!result.projection.build.scopes.length || !scoped && result.projection.build.scopes.some((scope) => scope.status !== 'reviewed_for_scope')) reasons.push('scope_incomplete');
  if (result.projection.source.kind === 'personal-cognition') reasons.push('reference_source_required');
  if (result.projection.quality.status !== 'eligible') reasons.push('source_not_qualified');
  return reasons;
}
function receiptFor(request: PersistentArgumentProjectionPublicationRequest, input: ArgumentProjectionBuildInput,
  beforeHash: string | null): PersistentArgumentProjectionPublicationReceipt {
  const result = request.result, reasons = reasonsFor(result);
  return { version: 1, publicationId: request.publicationId, buildId: result.buildId, reviewId: result.reviewId,
    scopeId: input.scope.scopeId, scopeHash: input.scopeHash, source: structuredClone(input.source), resultHash: result.resultHash,
    structureHash: result.authority.structureHash, candidateStatus: result.status,
    status: reasons.length ? 'held' : 'published', activeHash: reasons.length ? beforeHash : result.authority.structureHash,
    reasons, limitations: structuredClone(result.limitations), persistence: { ...PERSISTENCE } };
}
async function validateLedger(ledger: ProjectionLedger, root: string): Promise<void> {
  closed(ledger, ['version', 'contractVersion', 'rootScopeId', 'generation', 'sources', 'ledgerHash']);
  if (ledger.version !== 1 || ledger.contractVersion !== 'argument-projection-ledger-v1' || ledger.rootScopeId !== root) fail('wrong_ledger');
  integer(ledger.generation); hash(ledger.ledgerHash);
  if (!Array.isArray(ledger.sources) || ledger.sources.length > ARGUMENT_PROJECTION_STORE_LIMITS.sources) fail('source_capacity');
  const rowKeys = new Set<string>(), publicationIds = new Set<string>();
  let count = 0;
  for (const row of ledger.sources) {
    closed(row, ['keyHash', 'ref', 'epoch', 'current', 'activePublicationId', 'operations']); refShape(row.ref); integer(row.epoch); hash(row.keyHash);
    if (row.keyHash !== rowKey(root, row.ref) || rowKeys.has(row.keyHash)) fail('invalid_source_key');
    rowKeys.add(row.keyHash);
    if (row.current !== null) bindingShape(row.current);
    if (row.activePublicationId !== null) id(row.activePublicationId);
    if (!Array.isArray(row.operations)) fail('invalid_operations');
    count += row.operations.length;
    if (count > ARGUMENT_PROJECTION_STORE_LIMITS.operations) fail('operation_capacity');
    let previousEpoch = 0, epochBinding: SourceBinding | null = null;
    let activeId: string | null = null, activeHash: string | null = null;
    for (const operation of row.operations) {
      closed(operation, ['publicationId', 'fingerprint', 'epoch', 'binding', 'request', 'receipt']);
      id(operation.publicationId); hash(operation.fingerprint); integer(operation.epoch); bindingShape(operation.binding);
      if (publicationIds.has(operation.publicationId) || operation.epoch < previousEpoch || operation.epoch > row.epoch) fail('invalid_operation_history');
      publicationIds.add(operation.publicationId); requestShape(operation.request);
      if (operation.publicationId !== operation.request.publicationId) fail('operation_id_mismatch');
      await verifyArgumentProjectionBuildResult(operation.request.result, operation.request.proof);
      const input = operation.request.proof.input;
      if (input.source.rootScopeId !== root || !equal(sourceRef(input), row.ref) || input.scope.corpus !== 'reference') fail('wrong_record_source');
      if (!equal(await bindingOf(input), operation.binding) || await argumentContextHash(operation.request) !== operation.fingerprint) fail('record_binding_changed');
      if (operation.epoch !== previousEpoch) { activeId = null; activeHash = null; epochBinding = operation.binding; }
      else if (!equal(epochBinding, operation.binding)) fail('epoch_binding_changed');
      const expected = receiptFor(operation.request, input, activeHash);
      if (!equal(operation.receipt, expected)) fail('receipt_changed');
      if (expected.status === 'published') {
        if (operation.request.expectedActiveHash !== activeHash) fail('history_cas_mismatch');
        activeId = operation.publicationId; activeHash = expected.structureHash;
      }
      previousEpoch = operation.epoch;
    }
    if (row.current === null || previousEpoch !== row.epoch) activeId = null;
    else if (epochBinding !== null && !equal(epochBinding, row.current)) fail('current_binding_changed');
    if (row.activePublicationId !== activeId) fail('invalid_active_pointer');
  }
  const { ledgerHash: _ledgerHash, ...payload } = ledger;
  if (await argumentContextHash(payload) !== ledger.ledgerHash) fail('ledger_hash_changed');
}

async function safeDirectory(directory: string, create: boolean): Promise<boolean> {
  const root = path.parse(directory).root;
  let current = root;
  const parts = path.relative(root, directory).split(path.sep).filter(Boolean);
  for (const part of [null, ...parts] as (string | null)[]) {
    if (part !== null) current = path.join(current, part);
    let info;
    try { info = await fs.lstat(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (!create) return false;
      await fs.mkdir(current); info = await fs.lstat(current);
    }
    if (!info.isDirectory() || info.isSymbolicLink()) fail('unsafe_directory');
  }
  return true;
}
async function readBytes(target: string, missingAllowed: boolean): Promise<Buffer | null> {
  let info;
  try { info = await fs.lstat(target); }
  catch (error) { if (missingAllowed && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > ARGUMENT_PROJECTION_STORE_LIMITS.bytes) fail('unsafe_ledger_file');
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > ARGUMENT_PROJECTION_STORE_LIMITS.bytes || opened.ino !== info.ino || opened.dev !== info.dev) fail('file_changed');
    const bytes = await handle.readFile();
    if (bytes.length > ARGUMENT_PROJECTION_STORE_LIMITS.bytes) fail('file_budget');
    return bytes;
  } finally { await handle.close(); }
}

/**
 * Persistent derived-reference ledger. Lock order is always directory queue → host.withSource.
 * Cross-process writers and unobserved external source ABA require a future host-level mechanism.
 * Ordinary reads do not write. An observed source/scope change or deletion persists only derived
 * invalidation metadata, so an observed A→B→A cannot reactivate A's old publication receipt.
 */
export function createPersistentArgumentProjectionStore(directoryInput: string, host: ArgumentProjectionAuthorityHost,
  options: { write?: (target: string, text: string) => Promise<unknown> } = {}): PersistentArgumentProjectionStore {
  if (typeof directoryInput !== 'string' || !path.isAbsolute(directoryInput)) fail('absolute_directory_required');
  const directory = path.resolve(directoryInput), root = host.rootScopeId;
  id(root); if (/[\\/]/u.test(root) || typeof host.withSource !== 'function'
    || host.assertCurrent !== undefined && typeof host.assertCurrent !== 'function'
    || host.withSourceValidity !== undefined && typeof host.withSourceValidity !== 'function') fail('invalid_host');
  if (options.write !== undefined && typeof options.write !== 'function') fail('invalid_writer');
  const writePayload = options.write;
  const target = path.join(directory, argumentProjectionLedgerFileName(root));
  const queueKey = process.platform === 'win32' ? directory.toLowerCase() : directory;

  function serial<T>(action: () => Promise<T>): Promise<T> {
    const prior = directoryQueues.get(queueKey) ?? Promise.resolve();
    const job = prior.then(action), tail = job.then(() => undefined, () => undefined);
    directoryQueues.set(queueKey, tail);
    void tail.then(() => { if (directoryQueues.get(queueKey) === tail) directoryQueues.delete(queueKey); });
    return job;
  }
  async function load(): Promise<ProjectionLedger | null> {
    if (!await safeDirectory(directory, false)) return null;
    const bytes = await readBytes(target, true); if (bytes === null) return null;
    let parsed: ProjectionLedger;
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) fail('invalid_utf8');
    try { parsed = JSON.parse(text) as ProjectionLedger; } catch { return fail('corrupt_json'); }
    await validateLedger(parsed, root); return parsed;
  }
  function current(assertCurrent?: () => void): void { host.assertCurrent?.(); assertCurrent?.(); }
  async function commit(ledger: ProjectionLedger, assertCurrent?: () => void): Promise<void> {
    current(assertCurrent);
    if (ledger.generation >= Number.MAX_SAFE_INTEGER) fail('generation_overflow');
    ledger.generation += 1;
    const { ledgerHash: _oldHash, ...payload } = ledger;
    ledger.ledgerHash = await argumentContextHash(payload);
    const text = JSON.stringify(ledger), expected = Buffer.from(text, 'utf8');
    if (expected.length > ARGUMENT_PROJECTION_STORE_LIMITS.bytes) fail('file_budget');
    await safeDirectory(directory, true);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      if (writePayload) await writePayload(temporary, text);
      else {
        const handle = await fs.open(temporary, 'wx', 0o600);
        try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      }
      const actual = await readBytes(temporary, false);
      if (!actual || !actual.equals(expected)) fail('temporary_payload_changed');
      // Custom writers only receive the temporary path; the final strategy cannot become copy.
      // Windows FlushFileBuffers requires a write-capable handle, even after payload verification.
      const temporaryInfo = await fs.lstat(temporary);
      if (!temporaryInfo.isFile() || temporaryInfo.isSymbolicLink() || temporaryInfo.size !== expected.length) fail('unsafe_temporary_file');
      const handle = await fs.open(temporary, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.size !== expected.length || opened.ino !== temporaryInfo.ino
          || opened.dev !== temporaryInfo.dev) fail('temporary_file_changed');
        await handle.sync();
      } finally { await handle.close(); }
      await safeDirectory(directory, false);
      // The durable commit point is rename, not the later promise/receipt delivery.
      // A cancellation observed afterwards cannot retract the file, but must not
      // return a published receipt as though the revoked lease were still current.
      current(assertCurrent);
      await fs.rename(temporary, target); // Strict rename-only; a locked target is a failed transaction.
      current(assertCurrent);
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  function empty(): ProjectionLedger {
    return { version: 1, contractVersion: 'argument-projection-ledger-v1', rootScopeId: root,
      generation: 0, sources: [], ledgerHash: '0'.repeat(64) };
  }
  async function currentInput(inputValue: ArgumentProjectionBuildInput | null, ref: ArgumentProjectionSourceRef): Promise<ArgumentProjectionBuildInput | null> {
    const input = structuredClone(inputValue); if (input === null) return null;
    await validateArgumentProjectionBuildInput(input);
    if (input.source.rootScopeId !== root || input.scope.rootScopeId !== root || input.scope.corpus !== 'reference'
      || !equal(sourceRef(input), ref)) fail('host_source_mismatch');
    return input;
  }
  async function synchronize(ledger: ProjectionLedger, row: SourceRow | undefined,
    input: ArgumentProjectionBuildInput | null, assertCurrent?: () => void): Promise<void> {
    if (!row) return;
    const binding = input === null ? null : await bindingOf(input);
    if (!equal(row.current, binding)) {
      if (row.epoch >= Number.MAX_SAFE_INTEGER) fail('epoch_overflow');
      row.epoch += 1; row.current = binding; row.activePublicationId = null;
      await commit(ledger, assertCurrent);
    }
  }
  function activeOperation(row: SourceRow): StoredOperation | undefined {
    return row.operations.find((operation) => operation.publicationId === row.activePublicationId
      && operation.epoch === row.epoch && equal(operation.binding, row.current));
  }
  function withValidSource<T>(ref: ArgumentProjectionSourceRef,
    action: (input: ArgumentProjectionBuildInput | null) => Promise<T>, assertCurrent?: () => void): Promise<T> {
    if (!host.withSourceValidity) return host.withSource(ref, action);
    return host.withSourceValidity(ref, action, async () => {
      // A physically changed source can fail before the host has a usable input.
      // This separate callback only isolates retained derived state. It never
      // publishes, replays a proof, invokes a consumer reader or treats corruption
      // as an ordinary missing source that could be returned to the caller.
      current(assertCurrent);
      const ledger = await load();
      if (ledger) await synchronize(ledger, ledger.sources.find(item => item.keyHash === rowKey(root, ref)), null, assertCurrent);
      fail('source_changed');
    });
  }

  async function publish(requestValue: PersistentArgumentProjectionPublicationRequest,
    assertCurrent?: () => void): Promise<PersistentArgumentProjectionPublicationReceipt> {
    if (assertCurrent !== undefined && typeof assertCurrent !== 'function') fail('invalid_guard');
    current(assertCurrent);
    const request = structuredClone(requestValue); requestShape(request);
    const ref = sourceRef(request.proof.input);
    return serial(() => withValidSource(ref, async (hostValue) => {
      current(assertCurrent);
      const input = await currentInput(hostValue, ref), ledger = await load() ?? empty();
      let row = ledger.sources.find((item) => item.keyHash === rowKey(root, ref));
      await synchronize(ledger, row, input, assertCurrent);
      if (input === null) fail('source_missing');
      await verifyArgumentProjectionBuildResult(request.result, request.proof);
      const binding = await bindingOf(input);
      if (!equal(binding, await bindingOf(request.proof.input))
        || !equal(input, request.proof.input)) fail('source_changed');
      const fingerprint = await argumentContextHash(request);
      const previous = ledger.sources.flatMap((item) => item.operations).find((operation) => operation.publicationId === request.publicationId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('idempotency_content_changed');
        if (!row || previous.epoch !== row.epoch || !equal(previous.binding, row.current)) fail('source_changed');
        current(assertCurrent); return structuredClone(previous.receipt);
      }
      if (!row) {
        if (ledger.sources.length >= ARGUMENT_PROJECTION_STORE_LIMITS.sources) fail('source_capacity');
        row = { keyHash: rowKey(root, ref), ref: structuredClone(ref), epoch: 1, current: binding,
          activePublicationId: null, operations: [] }; ledger.sources.push(row);
      }
      if (ledger.sources.reduce((sum, item) => sum + item.operations.length, 0) >= ARGUMENT_PROJECTION_STORE_LIMITS.operations) fail('operation_capacity');
      const beforeHash = activeOperation(row)?.request.result.authority.structureHash ?? null;
      const receipt = receiptFor(request, input, beforeHash);
      if (receipt.status === 'published' && request.expectedActiveHash !== beforeHash) fail('cas_mismatch');
      row.operations.push({ publicationId: request.publicationId, fingerprint, epoch: row.epoch,
        binding: structuredClone(binding), request, receipt });
      if (receipt.status === 'published') row.activePublicationId = request.publicationId;
      await commit(ledger, assertCurrent); current(assertCurrent); return structuredClone(receipt);
    }, assertCurrent));
  }
  async function read(refValue: ArgumentProjectionSourceRef): Promise<ArgumentProjectionBuildResult | null> {
    return withActive(refValue, async (result) => result);
  }
  async function readSource(refValue: ArgumentProjectionSourceRef): Promise<ArgumentProjectionBuildInput | null> {
    const ref = structuredClone(refValue); refShape(ref);
    return serial(() => withValidSource(ref, async hostValue => {
      const input = await currentInput(hostValue, ref), ledger = await load();
      if (ledger) await synchronize(ledger, ledger.sources.find(item => item.keyHash === rowKey(root, ref)), input);
      return structuredClone(input);
    }));
  }
  async function withActive<T>(refValue: ArgumentProjectionSourceRef,
    action: (result: ArgumentProjectionBuildResult, input: ArgumentProjectionBuildInput) => Promise<T>): Promise<T | null> {
    if (typeof action !== 'function') fail('invalid_reader');
    return withActiveBinding(refValue, (result, input) => action(result, input));
  }
  async function withActiveBinding<T>(refValue: ArgumentProjectionSourceRef,
    action: (result: ArgumentProjectionBuildResult, input: ArgumentProjectionBuildInput,
      binding: ArgumentProjectionActiveBinding) => Promise<T>): Promise<T | null> {
    const ref = structuredClone(refValue); refShape(ref);
    if (typeof action !== 'function') fail('invalid_reader');
    return serial(() => withValidSource(ref, async (hostValue) => {
      const input = await currentInput(hostValue, ref), ledger = await load(); if (ledger === null) return null;
      const row = ledger.sources.find((item) => item.keyHash === rowKey(root, ref));
      await synchronize(ledger, row, input);
      if (!input || !row) return null;
      const operation = activeOperation(row); if (!operation) return null;
      return structuredClone(await action(structuredClone(operation.request.result), structuredClone(input), {
        publicationId: operation.publicationId, epoch: row.epoch, resultHash: operation.request.result.resultHash,
        structureHash: operation.request.result.authority.structureHash,
      }));
    }));
  }
  async function readStaged(refValue: ArgumentProjectionSourceRef, publicationIdValue: string): Promise<ArgumentProjectionBuildResult | null> {
    const ref = structuredClone(refValue), publicationId = publicationIdValue; refShape(ref); id(publicationId);
    return serial(() => withValidSource(ref, async (hostValue) => {
      const input = await currentInput(hostValue, ref), ledger = await load(); if (ledger === null) return null;
      const row = ledger.sources.find((item) => item.keyHash === rowKey(root, ref));
      await synchronize(ledger, row, input);
      if (!input || !row) return null;
      const operation = row.operations.find((item) => item.publicationId === publicationId && item.receipt.status === 'held'
        && item.epoch === row.epoch && equal(item.binding, row.current));
      return structuredClone(operation?.request.result ?? null);
    }));
  }
  return { publish, readSource, read, readStaged, withActive, withActiveBinding };
}
