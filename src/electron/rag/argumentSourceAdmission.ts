import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { argumentContextHash } from '../../services/argumentContext/hash.ts';
import { prepareArgumentProjectionBuild, validateArgumentProjectionBuildInput } from '../../services/argumentContext/construction.ts';
import type { ArgumentProjectionBuildInput } from '../../services/argumentContext/buildTypes.ts';
import type { ArgumentEvidenceSpan, ArgumentSourceIdentity } from '../../services/argumentContext/types.ts';

export interface SourceAdmissionReview {
  reviewId: string;
  policyVersion: string;
  decision: 'eligible' | 'review_only' | 'unassessed';
  evidence: ArgumentEvidenceSpan[];
  checks: {
    provenanceVerified: boolean;
    relevantContentPresent: boolean;
    noCriticalSourceGaps: boolean;
    reviewIndependent: boolean;
  };
  reason: string;
  reviewedAt: string;
}
export interface ArgumentSourceAdmissionStore {
  apply(base: ArgumentProjectionBuildInput): Promise<ArgumentProjectionBuildInput>;
  /** Trusted host only, under its current saved-source lease. Never expose to renderer IPC. */
  record(base: ArgumentProjectionBuildInput, review: SourceAdmissionReview, assertCurrent?: () => void): Promise<ArgumentProjectionBuildInput>;
}
export const ARGUMENT_SOURCE_ADMISSION_LIMITS = { records: 256, bytes: 4 * 1024 * 1024, evidence: 16 } as const;
const CONTRACT = 'argument-source-admission-v1' as const;
const DEFAULT_POLICY = 'saved-reference-unassessed-v1';
const HASH = /^[a-f0-9]{64}$/u;
const directoryQueues = new Map<string, Promise<void>>();
const fail = (code: string): never => { throw new Error(`argument_source_admission_${code}`); };
const sha = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');
export const argumentSourceAdmissionFileName = (rootScopeId: string): string => `argument-source-admission-${sha(rootScopeId)}.json`;
export const argumentSourceAdmissionKeyFileName = (rootScopeId: string): string => `argument-source-admission-${sha(rootScopeId)}.key`;

interface AdmissionRecord {
  source: ArgumentSourceIdentity;
  sourceIdentityHash: string;
  review: SourceAdmissionReview;
  fingerprint: string;
  signature: string;
}
interface AdmissionLedger {
  version: 1;
  contractVersion: typeof CONTRACT;
  rootScopeId: string;
  generation: number;
  records: AdmissionRecord[];
  signature: string;
}
function closed(value: unknown, fields: string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_shape');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).some((key) => !fields.includes(key)) || fields.some((key) => !Object.hasOwn(object, key))) fail('invalid_shape');
}
function text(value: unknown, maximum = 300): asserts value is string {
  if (typeof value !== 'string' || !value.length || value.length > maximum || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value) || /^(?:[a-z]:[\\/]|[\\/])/iu.test(value)) fail('invalid_text');
}
function hash(value: unknown): asserts value is string { if (typeof value !== 'string' || !HASH.test(value)) fail('invalid_hash'); }
function sourceShape(source: ArgumentSourceIdentity, rootScopeId: string): void {
  closed(source, ['kind', 'entityId', 'rootScopeId', 'version', 'contentHash', 'coordinateSpace',
    'parserVersion', 'segmentationVersion', 'extractorVersion', 'validatorVersion']);
  if (source.kind !== 'knowledge-note' && source.kind !== 'uploaded-document') fail('reference_only');
  for (const key of ['entityId', 'rootScopeId', 'version', 'parserVersion', 'segmentationVersion', 'extractorVersion', 'validatorVersion'] as const) text(source[key]);
  if (source.rootScopeId !== rootScopeId || /[\\/]/u.test(source.rootScopeId)) fail('root_mismatch');
  hash(source.contentHash);
  if (source.coordinateSpace !== (source.kind === 'knowledge-note' ? 'saved-note-utf16' : 'parsed-text-utf16')) fail('coordinate_mismatch');
}
function reviewShape(review: SourceAdmissionReview): void {
  closed(review, ['reviewId', 'policyVersion', 'decision', 'evidence', 'checks', 'reason', 'reviewedAt']);
  text(review.reviewId); text(review.policyVersion); text(review.reason, 2000);
  if (!['eligible', 'review_only', 'unassessed'].includes(review.decision)) fail('invalid_decision');
  if (typeof review.reviewedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(review.reviewedAt)
    || !Number.isFinite(Date.parse(review.reviewedAt))) fail('invalid_timestamp');
  const checks = ['provenanceVerified', 'relevantContentPresent', 'noCriticalSourceGaps', 'reviewIndependent'] as const;
  closed(review.checks, [...checks]);
  if (checks.some((key) => typeof review.checks[key] !== 'boolean')) fail('invalid_checks');
  if (!Array.isArray(review.evidence) || review.evidence.length > ARGUMENT_SOURCE_ADMISSION_LIMITS.evidence) fail('evidence_budget');
  const signatures = new Set<string>();
  for (const span of review.evidence) {
    closed(span, ['sentenceId', 'start', 'end', 'quote']); text(span.sentenceId);
    if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start
      || span.end > 500000 || typeof span.quote !== 'string' || !span.quote.trim() || span.quote.length !== span.end - span.start) fail('invalid_evidence');
    const signature = `${span.sentenceId}:${span.start}:${span.end}`;
    if (signatures.has(signature)) fail('duplicate_evidence'); signatures.add(signature);
  }
  if (review.decision === 'eligible' && (!review.evidence.length || checks.some((key) => review.checks[key] !== true))) fail('unsupported_eligibility');
}
async function baseInput(baseValue: ArgumentProjectionBuildInput, rootScopeId: string): Promise<ArgumentProjectionBuildInput> {
  const base = structuredClone(baseValue);
  await validateArgumentProjectionBuildInput(base);
  sourceShape(base.source, rootScopeId);
  if (base.scope.corpus !== 'reference' || base.scope.rootScopeId !== rootScopeId
    || base.sourceQualification.status !== 'unassessed' || base.sourceQualification.policyVersion !== DEFAULT_POLICY
    || base.sourceQualification.evidence.length !== 0) fail('saved_base_required');
  return base;
}
async function qualified(base: ArgumentProjectionBuildInput, review: SourceAdmissionReview): Promise<ArgumentProjectionBuildInput> {
  reviewShape(review);
  // Rebuild every derived quote/hash and validate exact saved-source UTF-16 evidence.
  return prepareArgumentProjectionBuild({ source: base.source, canonicalText: base.canonicalText, hierarchy: base.hierarchy,
    scope: base.scope, chunks: base.chunks,
    sourceQualification: { status: review.decision, policyVersion: review.policyVersion, evidence: review.evidence } });
}
async function recordFingerprint(record: Pick<AdmissionRecord, 'source' | 'sourceIdentityHash' | 'review'>, rootScopeId: string): Promise<string> {
  return argumentContextHash({ contractVersion: CONTRACT, rootScopeId, ...record });
}
function sign(fingerprint: string, key: Buffer): string { return createHmac('sha256', key).update(fingerprint, 'utf8').digest('hex'); }
function verifySignature(signature: string, fingerprint: string, key: Buffer): void {
  hash(signature);
  if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(sign(fingerprint, key), 'hex'))) fail('signature_changed');
}
async function safeDirectory(directory: string, create: boolean): Promise<boolean> {
  const root = path.parse(directory).root;
  let current = root;
  for (const part of [null, ...path.relative(root, directory).split(path.sep).filter(Boolean)] as (string | null)[]) {
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
async function readBytes(target: string, maximum: number, missingAllowed: boolean): Promise<Buffer | null> {
  let info;
  try { info = await fs.lstat(target); }
  catch (error) { if (missingAllowed && (error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) fail('unsafe_file');
  const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maximum || opened.dev !== info.dev || opened.ino !== info.ino) fail('file_changed');
    const bytes = await handle.readFile();
    if (bytes.length > maximum) fail('file_budget');
    return bytes;
  } finally { await handle.close(); }
}

/**
 * Host-private source eligibility, independent from structural extraction and question scope.
 * Callers hold their saved-source lease; this queue never acquires the source coordinator.
 * HMAC detects unsigned edits, not factual truth, old signed-file replay, cross-process races,
 * or a same-account actor that can steal the local signing key. No renderer publication route.
 */
export function createArgumentSourceAdmissionStore(directoryInput: string, rootScopeId: string): ArgumentSourceAdmissionStore {
  if (typeof directoryInput !== 'string' || !path.isAbsolute(directoryInput)) fail('absolute_directory_required');
  const directory = path.resolve(directoryInput);
  text(rootScopeId); if (/[\\/]/u.test(rootScopeId)) fail('invalid_root');
  const target = path.join(directory, argumentSourceAdmissionFileName(rootScopeId));
  const keyTarget = path.join(directory, argumentSourceAdmissionKeyFileName(rootScopeId));
  const queueKey = process.platform === 'win32' ? directory.toLowerCase() : directory;
  function serial<T>(action: () => Promise<T>): Promise<T> {
    const previous = directoryQueues.get(queueKey) ?? Promise.resolve();
    const job = previous.then(action), tail = job.then(() => undefined, () => undefined);
    directoryQueues.set(queueKey, tail);
    void tail.then(() => { if (directoryQueues.get(queueKey) === tail) directoryQueues.delete(queueKey); });
    return job;
  }
  async function signingKey(required: boolean, create: boolean, assertCurrent?: () => void): Promise<Buffer | null> {
    let key = await readBytes(keyTarget, 32, true);
    if (key === null && required) fail('missing_key');
    if (key === null && create) {
      assertCurrent?.();
      await safeDirectory(directory, true);
      const candidate = randomBytes(32);
      let handle;
      assertCurrent?.();
      try { handle = await fs.open(keyTarget, 'wx', 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (handle) {
        try { await handle.writeFile(candidate); await handle.sync(); } finally { await handle.close(); }
      }
      // Never fall back to an in-memory key if another writer created an invalid key.
      key = await readBytes(keyTarget, 32, false);
    }
    if (key !== null && key.length !== 32) fail('invalid_key');
    return key;
  }
  async function validateLedger(ledger: AdmissionLedger, key: Buffer): Promise<void> {
    closed(ledger, ['version', 'contractVersion', 'rootScopeId', 'generation', 'records', 'signature']);
    if (ledger.version !== 1 || ledger.contractVersion !== CONTRACT || ledger.rootScopeId !== rootScopeId
      || !Number.isSafeInteger(ledger.generation) || ledger.generation < 1) fail('wrong_ledger');
    if (!Array.isArray(ledger.records) || !ledger.records.length || ledger.records.length > ARGUMENT_SOURCE_ADMISSION_LIMITS.records) fail('record_capacity');
    const reviewIds = new Set<string>();
    for (const record of ledger.records) {
      closed(record, ['source', 'sourceIdentityHash', 'review', 'fingerprint', 'signature']);
      sourceShape(record.source, rootScopeId); reviewShape(record.review); hash(record.sourceIdentityHash); hash(record.fingerprint);
      if (reviewIds.has(record.review.reviewId)) fail('duplicate_review'); reviewIds.add(record.review.reviewId);
      if (record.sourceIdentityHash !== await argumentContextHash(record.source)
        || record.fingerprint !== await recordFingerprint({ source: record.source, sourceIdentityHash: record.sourceIdentityHash, review: record.review }, rootScopeId)) fail('record_binding_changed');
      verifySignature(record.signature, record.fingerprint, key);
    }
    const { signature: _signature, ...payload } = ledger;
    verifySignature(ledger.signature, await argumentContextHash(payload), key);
  }
  async function load(): Promise<{ ledger: AdmissionLedger; key: Buffer } | null> {
    if (!await safeDirectory(directory, false)) return null;
    const bytes = await readBytes(target, ARGUMENT_SOURCE_ADMISSION_LIMITS.bytes, true);
    if (bytes === null) return null;
    const key = await signingKey(true, false); if (key === null) return fail('missing_key');
    const text = bytes.toString('utf8');
    if (!Buffer.from(text, 'utf8').equals(bytes)) fail('invalid_utf8');
    let ledger: AdmissionLedger;
    try { ledger = JSON.parse(text) as AdmissionLedger; } catch { return fail('corrupt_json'); }
    await validateLedger(ledger, key); return { ledger, key };
  }
  async function commit(ledger: AdmissionLedger, key: Buffer, assertCurrent?: () => void): Promise<void> {
    assertCurrent?.();
    if (ledger.generation >= Number.MAX_SAFE_INTEGER) fail('generation_overflow');
    ledger.generation += 1;
    const { signature: _signature, ...payload } = ledger;
    ledger.signature = sign(await argumentContextHash(payload), key);
    const bytes = Buffer.from(JSON.stringify(ledger), 'utf8');
    if (bytes.length > ARGUMENT_SOURCE_ADMISSION_LIMITS.bytes) fail('file_budget');
    await safeDirectory(directory, true);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const handle = await fs.open(temporary, 'wx', 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      const actual = await readBytes(temporary, ARGUMENT_SOURCE_ADMISSION_LIMITS.bytes, false);
      if (!actual?.equals(bytes)) fail('temporary_payload_changed');
      // Check again before rename; no copy fallback and no authoritative memory cache.
      await safeDirectory(directory, false);
      const currentKey = await signingKey(true, false);
      if (currentKey === null || !timingSafeEqual(currentKey, key)) fail('key_changed');
      const existing = await readBytes(target, ARGUMENT_SOURCE_ADMISSION_LIMITS.bytes, true);
      if (existing !== null) {
        const existingText = existing.toString('utf8');
        if (!Buffer.from(existingText, 'utf8').equals(existing)) fail('invalid_utf8');
        let previous: AdmissionLedger;
        try { previous = JSON.parse(existingText) as AdmissionLedger; } catch { return fail('corrupt_json'); }
        await validateLedger(previous, key);
        if (previous.generation !== ledger.generation - 1) fail('ledger_changed');
      } else if (ledger.generation !== 1) fail('ledger_changed');
      // This rename is the durable commit point. Later revocation cannot retract it;
      // the post-check instead prevents a late completion from claiming current authority.
      assertCurrent?.();
      await fs.rename(temporary, target);
      assertCurrent?.();
    } finally { await fs.unlink(temporary).catch(() => {}); }
  }
  async function apply(baseValue: ArgumentProjectionBuildInput): Promise<ArgumentProjectionBuildInput> {
    const base = await baseInput(baseValue, rootScopeId);
    return serial(async () => {
      const loaded = await load(); if (loaded === null) return structuredClone(base);
      const sourceIdentityHash = await argumentContextHash(base.source);
      const record = loaded.ledger.records.findLast((row) => row.sourceIdentityHash === sourceIdentityHash);
      return record ? qualified(base, record.review) : structuredClone(base);
    });
  }
  async function record(baseValue: ArgumentProjectionBuildInput, reviewValue: SourceAdmissionReview,
    assertCurrent?: () => void): Promise<ArgumentProjectionBuildInput> {
    if (assertCurrent !== undefined && typeof assertCurrent !== 'function') fail('invalid_guard');
    assertCurrent?.();
    const capturedBase = structuredClone(baseValue), review = structuredClone(reviewValue);
    const base = await baseInput(capturedBase, rootScopeId);
    const output = await qualified(base, review);
    return serial(async () => {
      assertCurrent?.();
      const loaded = await load();
      const sourceIdentityHash = await argumentContextHash(base.source);
      const fingerprint = await recordFingerprint({ source: base.source, sourceIdentityHash, review }, rootScopeId);
      const previous = loaded?.ledger.records.find((row) => row.review.reviewId === review.reviewId);
      if (previous) {
        if (previous.fingerprint !== fingerprint) fail('idempotency_content_changed');
        // Retrying an old eligible review must not appear to undo a newer review_only
        // decision. Idempotency preserves the ledger and returns its current decision.
        const current = loaded!.ledger.records.findLast((row) => row.sourceIdentityHash === sourceIdentityHash)!;
        const currentOutput = await qualified(base, current.review);
        assertCurrent?.(); return currentOutput;
      }
      if (loaded && loaded.ledger.records.length >= ARGUMENT_SOURCE_ADMISSION_LIMITS.records) fail('record_capacity');
      const key = loaded?.key ?? await signingKey(false, true, assertCurrent);
      if (key === null) return fail('missing_key');
      const ledger: AdmissionLedger = loaded?.ledger ?? { version: 1, contractVersion: CONTRACT, rootScopeId, generation: 0, records: [], signature: '0'.repeat(64) };
      ledger.records.push({ source: structuredClone(base.source), sourceIdentityHash, review,
        fingerprint, signature: sign(fingerprint, key) });
      await commit(ledger, key, assertCurrent); assertCurrent?.(); return structuredClone(output);
    });
  }
  return { apply, record };
}
