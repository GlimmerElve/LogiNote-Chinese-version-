import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { NoteItem, UserNoteState } from '../types';
import { planLegacyMasteryMigration, type LegacyMasteryMigrationPlan } from '../services/masteryShadow/legacyMigration';
import { samePersonalValue, storedPersonalValue, type PersonalNotePatch, type StoredPersonalValue } from '../services/personalNoteState';
import { serializeUserStateFile } from '../services/userStateService';
import { savePersonalNoteState } from './personalNoteSave';
import { atomicWriteTextFile } from './atomicWrite';

const POLICY = 'legacy-score-estimate-v1' as const;
const BACKUP_DIRECTORY = ['user-state', 'migrations', 'legacy-mastery'];
const LOCK_FILE = 'legacy-mastery-migration.lock';
const run = promisify(execFile);
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex');
const plain = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const equalRoot = (left: string, right: string): boolean => process.platform === 'win32'
  ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase() : path.resolve(left) === path.resolve(right);
const validId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,299}$/u.test(value);

export interface LegacyMasteryMigrationOptions {
  dataRoot: string;
  /** The default is a strictly read-only preview. */
  apply?: boolean;
  /** Explicit human confirmation; never infer this from the process check alone. */
  appClosed?: boolean;
  migrationId?: string;
  migratedAt?: string;
  thresholds?: LegacyMasteryMigrationPlan['thresholds'];
  /** Test seam: production uses the operating-system process inventory below. */
  isAppRunning?: () => Promise<boolean>;
}

export interface LegacyMasteryRollbackOptions {
  dataRoot: string;
  manifestPath: string;
  apply?: boolean;
  appClosed?: boolean;
  isAppRunning?: () => Promise<boolean>;
}

export interface LegacyMasteryMigrationReport {
  mode: 'dry-run' | 'applied' | 'rollback-dry-run' | 'rolled-back';
  migrationId: string;
  policy: typeof POLICY;
  thresholds: LegacyMasteryMigrationPlan['thresholds'];
  planned: number;
  changed: number;
  skipped: number;
  skippedReasons: Record<string, number>;
  estimatedLevels: Record<0 | 1 | 2 | 3, number>;
  manifestPath?: string;
  backupPath?: string;
  /** No note bodies, scores per person, settings or credentials are returned. */
  dataRoot: string;
}

interface Snapshot {
  root: string; vault: string; statesDirectory: string;
  metadataPath: string; statePath: string;
  metadataBytes: Buffer; stateBytes: Buffer;
  metadataHash: string; stateHash: string;
  notes: Array<Pick<NoteItem, 'id' | 'title' | 'noteType'>>;
  states: Record<string, UserNoteState>;
}

interface MigrationManifest {
  version: 1; policy: typeof POLICY; migrationId: string; migratedAt: string;
  dataRoot: string;
  thresholds: LegacyMasteryMigrationPlan['thresholds'];
  metadataHash: string; beforeHash: string; afterHash: string;
  backupFile: 'user-state.before.json';
  changes: Array<{ noteId: string; sourceScore: number; estimatedLevel: 0 | 1 | 2 | 3;
    before: StoredPersonalValue; after: StoredPersonalValue }>;
}

async function directory(target: string): Promise<void> {
  // Check every parent as well: an apparently ordinary child may live below a junction.
  let current = path.resolve(target);
  for (;;) {
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('migration_unsafe_directory');
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

async function readRegularFile(file: string, maximum: number): Promise<Buffer> {
  await directory(path.dirname(file));
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximum) throw new Error('migration_unsafe_file');
  const bytes = await fs.readFile(file);
  const after = await fs.lstat(file);
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino
    || before.size !== after.size || bytes.length !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('migration_source_changed');
  return bytes;
}

async function noPendingJournal(statesDirectory: string): Promise<void> {
  try { await fs.lstat(path.join(statesDirectory, 'vault-pending-snapshot.json')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  throw new Error('migration_pending_vault_snapshot');
}

async function readSnapshot(dataRoot: string): Promise<Snapshot> {
  if (typeof dataRoot !== 'string' || !path.isAbsolute(dataRoot) || /[\u0000-\u001f\u007f]/u.test(dataRoot)) throw new Error('migration_invalid_root');
  const root = path.resolve(dataRoot);
  if (equalRoot(root, path.parse(root).root)) throw new Error('migration_invalid_root');
  const vault = path.join(root, 'vault'), statesDirectory = path.join(root, 'user-state');
  await directory(vault); await directory(statesDirectory); await noPendingJournal(statesDirectory);
  const metadataPath = path.join(vault, 'metadata.json'), statePath = path.join(statesDirectory, 'user-state.json');
  const [metadataBytes, stateBytes] = await Promise.all([
    readRegularFile(metadataPath, 64 * 1024 * 1024), readRegularFile(statePath, 128 * 1024 * 1024),
  ]);
  let metadata: any, personal: any;
  try { metadata = JSON.parse(metadataBytes.toString('utf8')); personal = JSON.parse(stateBytes.toString('utf8')); }
  catch { throw new Error('migration_invalid_json'); }
  if (!plain(metadata) || metadata.version !== 1 || !plain(metadata.notesMeta)
    || !plain(personal) || personal.version !== 1 || !plain(personal.noteStates)
    || Object.keys(personal).some(key => !['version', 'noteStates'].includes(key))) throw new Error('migration_invalid_catalog');
  const notes: Snapshot['notes'] = [];
  for (const [id, value] of Object.entries(metadata.notesMeta)) {
    if (!validId(id) || !plain(value) || value.id !== id || typeof value.title !== 'string'
      || !['knowledge', 'project'].includes(value.noteType)) throw new Error('migration_invalid_note_metadata');
    notes.push({ id, title: value.title, noteType: value.noteType });
  }
  for (const [id, value] of Object.entries(personal.noteStates)) {
    if (!validId(id) || !plain(value) || (Object.hasOwn(value, 'dsrState') && !plain(value.dsrState))) throw new Error('migration_invalid_personal_state');
  }
  await noPendingJournal(statesDirectory);
  return { root, vault, statesDirectory, metadataPath, statePath, metadataBytes, stateBytes,
    metadataHash: hash(metadataBytes), stateHash: hash(stateBytes), notes, states: personal.noteStates };
}

/** Fail closed if the OS process inventory cannot be read. Never kills a process. */
export async function legacyMasteryAppIsRunning(): Promise<boolean> {
  if (process.platform === 'win32') {
    const result = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; @(Get-Process | Where-Object { $_.ProcessName -match '^(electron|logi[ -]?note)$' }).Count"],
    { windowsHide: true, timeout: 10_000, maxBuffer: 100_000 });
    const count = Number(result.stdout.trim());
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('migration_process_check_failed');
    return count > 0;
  }
  const result = await run('ps', ['-A', '-o', 'comm='], { timeout: 10_000, maxBuffer: 1_000_000 });
  return result.stdout.split(/\r?\n/u).some(line => /^(electron|logi[ -]?note)(?:\.exe)?$/iu.test(path.basename(line.trim())));
}

async function requireClosed(options: Pick<LegacyMasteryMigrationOptions, 'appClosed' | 'isAppRunning'>): Promise<void> {
  if (options.appClosed !== true) throw new Error('migration_requires_app_closed_confirmation');
  if (await (options.isAppRunning || legacyMasteryAppIsRunning)()) throw new Error('migration_application_is_running');
}

async function unchanged(snapshot: Snapshot): Promise<void> {
  const current = await readSnapshot(snapshot.root);
  if (current.metadataHash !== snapshot.metadataHash || current.stateHash !== snapshot.stateHash) throw new Error('migration_source_changed');
}

async function exclusive<T>(snapshot: Snapshot, action: () => Promise<T>): Promise<T> {
  const target = path.join(snapshot.statesDirectory, LOCK_FILE);
  // This prevents two migration CLIs, not a running app. Human confirmation remains mandatory.
  const lock = await fs.open(target, 'wx');
  try { await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); return await action(); }
  finally { await lock.close(); await fs.rm(target, { force: true }); }
}

async function createBackupDirectory(root: string, migrationId: string): Promise<string> {
  let current = root;
  for (const segment of BACKUP_DIRECTORY) {
    current = path.join(current, segment);
    try { await fs.mkdir(current); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    await directory(current);
  }
  const target = path.join(current, migrationId);
  // A migration ID is immutable, including after an interrupted attempt.
  await fs.mkdir(target); await directory(target); return target;
}

function shadowValue(state: UserNoteState | undefined): StoredPersonalValue {
  const shadow = state?.dsrState?.masteryShadow;
  return shadow === undefined ? { present: false } : { present: true, value: structuredClone(shadow) };
}

function patchesFor(snapshot: Snapshot, changes: MigrationManifest['changes']): PersonalNotePatch[] {
  return changes.map(change => {
    const current = snapshot.states[change.noteId];
    if (!current?.dsrState || !plain(current.dsrState)) throw new Error('migration_missing_dsr_state');
    const dsr = { ...current.dsrState };
    if (change.after.present) dsr.masteryShadow = structuredClone(change.after.value) as any;
    else delete dsr.masteryShadow;
    return { noteId: change.noteId, noteType: 'knowledge', changes: [{ field: 'dsrState',
      before: storedPersonalValue(current, 'dsrState'), after: { present: true, value: dsr } }] };
  });
}

function expectedStates(snapshot: Snapshot, patches: PersonalNotePatch[]): Record<string, UserNoteState> {
  const states = structuredClone(snapshot.states);
  for (const patch of patches) {
    const after = patch.changes[0].after;
    if (!after.present) throw new Error('migration_invalid_dsr_patch');
    states[patch.noteId].dsrState = structuredClone(after.value) as any;
  }
  return states;
}

async function commit(snapshot: Snapshot, patches: PersonalNotePatch[], options: LegacyMasteryMigrationOptions): Promise<void> {
  if (patches.length > 1000) throw new Error('migration_too_many_changes');
  await requireClosed(options); await unchanged(snapshot);
  await savePersonalNoteState(snapshot.vault, snapshot.statesDirectory, patches, undefined, async (file, text) => {
    // Last byte-level check also protects against metadata/deletion changes after planning.
    await unchanged(snapshot);
    return atomicWriteTextFile(file, text, { allowCopyFallback: false });
  });
  const after = await readSnapshot(snapshot.root);
  if (after.metadataHash !== snapshot.metadataHash || !samePersonalValue(after.states, expectedStates(snapshot, patches))) {
    throw new Error('migration_post_commit_conflict_backup_retained');
  }
}

function reasons(items: Array<{ reason: string }>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[item.reason] = (counts[item.reason] || 0) + 1;
  return counts;
}

export async function migrateLegacyMastery(options: LegacyMasteryMigrationOptions): Promise<LegacyMasteryMigrationReport> {
  const snapshot = await readSnapshot(options.dataRoot);
  const migrationId = options.migrationId || `legacy-mastery-${new Date().toISOString().replace(/[:.]/gu, '-')}-${randomUUID().slice(0, 8)}`;
  if (!validId(migrationId) || migrationId.length > 160) throw new Error('migration_invalid_id');
  const plan = planLegacyMasteryMigration(snapshot.notes, snapshot.states, {
    migrationId, migratedAt: options.migratedAt || new Date().toISOString(), thresholds: options.thresholds,
  });
  const levels = { 0: 0, 1: 0, 2: 0, 3: 0 };
  for (const change of plan.changes) levels[change.estimatedLevel] += 1;
  const report: LegacyMasteryMigrationReport = { mode: options.apply ? 'applied' : 'dry-run', migrationId,
    policy: POLICY, thresholds: plan.thresholds, planned: plan.changes.length, changed: 0,
    skipped: plan.skipped.length, skippedReasons: reasons(plan.skipped), estimatedLevels: levels, dataRoot: snapshot.root };
  if (!options.apply) return report;
  await requireClosed(options);
  return exclusive(snapshot, async () => {
    await unchanged(snapshot);
    if (!plan.changes.length) return report;
    const changes: MigrationManifest['changes'] = plan.changes.map(change => ({ noteId: change.noteId,
      sourceScore: change.sourceScore, estimatedLevel: change.estimatedLevel,
      before: change.before === undefined ? { present: false } : { present: true, value: change.before },
      after: { present: true, value: change.after } }));
    const patches = patchesFor(snapshot, changes);
    const directoryPath = await createBackupDirectory(snapshot.root, migrationId);
    const backupPath = path.join(directoryPath, 'user-state.before.json'), manifestPath = path.join(directoryPath, 'manifest.json');
    const manifest: MigrationManifest = { version: 1, policy: POLICY, migrationId, migratedAt: plan.migratedAt,
      dataRoot: snapshot.root, thresholds: plan.thresholds, metadataHash: snapshot.metadataHash,
      beforeHash: snapshot.stateHash, afterHash: hash(serializeUserStateFile(expectedStates(snapshot, patches))), backupFile: 'user-state.before.json', changes };
    await fs.writeFile(backupPath, snapshot.stateBytes, { flag: 'wx' });
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), { flag: 'wx' });
    await commit(snapshot, patches, options);
    return { ...report, changed: patches.length, backupPath, manifestPath };
  });
}

function validateValue(value: unknown): value is StoredPersonalValue {
  return plain(value) && typeof value.present === 'boolean'
    && Object.keys(value).every(key => ['present', 'value'].includes(key))
    && (value.present ? Object.hasOwn(value, 'value') && plain(value.value) : !Object.hasOwn(value, 'value'));
}

async function loadManifest(snapshot: Snapshot, manifestPath: string): Promise<MigrationManifest> {
  if (!path.isAbsolute(manifestPath)) throw new Error('migration_invalid_manifest_path');
  const file = path.resolve(manifestPath);
  let manifest: any;
  try { manifest = JSON.parse((await readRegularFile(file, 32 * 1024 * 1024)).toString('utf8')); }
  catch (error) { if (error instanceof SyntaxError) throw new Error('migration_invalid_manifest'); throw error; }
  if (!plain(manifest) || Object.keys(manifest).some(key => !['version', 'policy', 'migrationId', 'migratedAt',
    'dataRoot', 'thresholds', 'metadataHash', 'beforeHash', 'afterHash', 'backupFile', 'changes'].includes(key))
    || manifest.version !== 1 || manifest.policy !== POLICY || !validId(manifest.migrationId)
    || manifest.migrationId.length > 160 || typeof manifest.dataRoot !== 'string' || !equalRoot(manifest.dataRoot, snapshot.root)
    || !equalRoot(file, path.join(snapshot.root, ...BACKUP_DIRECTORY, manifest.migrationId, 'manifest.json'))
    || manifest.backupFile !== 'user-state.before.json' || !Array.isArray(manifest.changes) || !manifest.changes.length || manifest.changes.length > 1000
    || ![manifest.metadataHash, manifest.beforeHash, manifest.afterHash].every(value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value))
    || !plain(manifest.thresholds) || Object.keys(manifest.thresholds).length !== 3
    || !['concept', 'judgment', 'reasoning'].every(key => Number.isFinite(manifest.thresholds[key]))
    || typeof manifest.migratedAt !== 'string' || !Number.isFinite(Date.parse(manifest.migratedAt))) throw new Error('migration_invalid_manifest');
  const seen = new Set<string>();
  for (const change of manifest.changes) {
    if (!plain(change) || Object.keys(change).some(key => !['noteId', 'sourceScore', 'estimatedLevel', 'before', 'after'].includes(key))
      || !validId(change.noteId) || seen.has(change.noteId) || !validateValue(change.before) || !validateValue(change.after)
      || !change.after.present || !plain(change.after.value) || change.after.value.version !== 1 || change.after.value.knowledgePointId !== change.noteId
      || !Number.isFinite(change.sourceScore) || change.sourceScore < 0 || change.sourceScore > 100
      || ![0, 1, 2, 3].includes(change.estimatedLevel)) throw new Error('migration_invalid_manifest');
    seen.add(change.noteId);
  }
  const backup = await readRegularFile(path.join(path.dirname(file), manifest.backupFile), 128 * 1024 * 1024);
  if (hash(backup) !== manifest.beforeHash) throw new Error('migration_backup_hash_mismatch');
  let original: any;
  try { original = JSON.parse(backup.toString('utf8')); } catch { throw new Error('migration_invalid_backup'); }
  if (!plain(original) || original.version !== 1 || !plain(original.noteStates)
    || Object.keys(original).some(key => !['version', 'noteStates'].includes(key))) throw new Error('migration_invalid_backup');
  // Reconstruct this policy from the immutable backup. A hand-edited after-value
  // cannot authorise restoration of an unrelated shadow merely by matching its hash.
  const reconstructed = planLegacyMasteryMigration(manifest.changes.map(change => ({
    id: change.noteId, title: '', noteType: 'knowledge' as const,
  })), original.noteStates, { migrationId: manifest.migrationId, migratedAt: manifest.migratedAt,
    thresholds: { concept: manifest.thresholds.concept, judgment: manifest.thresholds.judgment, reasoning: manifest.thresholds.reasoning } });
  if (reconstructed.changes.length !== manifest.changes.length || manifest.changes.some(change => {
    const expected = reconstructed.changes.find(item => item.noteId === change.noteId);
    return !expected || expected.sourceScore !== change.sourceScore || expected.estimatedLevel !== change.estimatedLevel
      || !samePersonalValue(expected.after, change.after.value);
  })) throw new Error('migration_manifest_policy_mismatch');
  const expected = structuredClone(original.noteStates);
  for (const change of manifest.changes) {
    const state = original.noteStates[change.noteId];
    if (!plain(state) || !plain(state.dsrState) || !samePersonalValue(shadowValue(state), change.before)) throw new Error('migration_backup_patch_mismatch');
    expected[change.noteId].dsrState.masteryShadow = structuredClone(change.after.value);
  }
  if (hash(serializeUserStateFile(expected)) !== manifest.afterHash) throw new Error('migration_manifest_patch_hash_mismatch');
  return manifest as unknown as MigrationManifest;
}

/** Rollback is a per-shadow compare-and-set, never an old whole-file restoration. */
export async function rollbackLegacyMastery(options: LegacyMasteryRollbackOptions): Promise<LegacyMasteryMigrationReport> {
  const snapshot = await readSnapshot(options.dataRoot), manifest = await loadManifest(snapshot, options.manifestPath);
  const notes = new Map(snapshot.notes.map(note => [note.id, note]));
  const eligible: MigrationManifest['changes'] = [], skipped: Array<{ reason: string }> = [];
  for (const change of manifest.changes) {
    if (notes.get(change.noteId)?.noteType !== 'knowledge') { skipped.push({ reason: 'note_missing_or_type_changed' }); continue; }
    const current = shadowValue(snapshot.states[change.noteId]);
    if (samePersonalValue(current, change.before)) { skipped.push({ reason: 'already_rolled_back' }); continue; }
    if (!samePersonalValue(current, change.after)) { skipped.push({ reason: 'newer_mastery_state_preserved' }); continue; }
    eligible.push({ ...change, before: change.after, after: change.before });
  }
  const report: LegacyMasteryMigrationReport = { mode: options.apply ? 'rolled-back' : 'rollback-dry-run',
    migrationId: manifest.migrationId, policy: POLICY, thresholds: manifest.thresholds, planned: eligible.length,
    changed: 0, skipped: skipped.length, skippedReasons: reasons(skipped), estimatedLevels: { 0: 0, 1: 0, 2: 0, 3: 0 },
    dataRoot: snapshot.root, manifestPath: path.resolve(options.manifestPath), backupPath: path.join(path.dirname(options.manifestPath), manifest.backupFile) };
  if (!options.apply) return report;
  await requireClosed(options);
  return exclusive(snapshot, async () => {
    await unchanged(snapshot);
    if (eligible.length) await commit(snapshot, patchesFor(snapshot, eligible), options);
    return { ...report, changed: eligible.length };
  });
}
