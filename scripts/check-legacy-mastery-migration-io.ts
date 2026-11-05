import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { migrateLegacyMastery, rollbackLegacyMastery } from '../src/electron/legacyMasteryMigration.ts';
import { createMasteryShadowState } from '../src/services/masteryShadow/stateMachine.ts';

const base = await fs.mkdtemp(path.join(os.tmpdir(), 'loginote-legacy-mastery-io-'));
const closed = async () => false;
const at = '2026-10-18T00:00:00.000Z';
const json = (value: unknown) => JSON.stringify(value, null, 2);
const read = async (file: string) => JSON.parse(await fs.readFile(file, 'utf8'));
const statePath = (root: string) => path.join(root, 'user-state', 'user-state.json');
const metadataPath = (root: string) => path.join(root, 'vault', 'metadata.json');

async function fixture(name: string): Promise<string> {
  const root = path.join(base, name);
  await fs.mkdir(path.join(root, 'vault', 'notes'), { recursive: true });
  await fs.mkdir(path.join(root, 'user-state'), { recursive: true });
  const notesMeta = Object.fromEntries(['a', 'b', 'c', 'new', 'empty'].map(id => [id,
    { id, title: `Isolated ${id}`, noteType: 'knowledge', parentId: null }]));
  await fs.writeFile(metadataPath(root), json({ version: 1, notesMeta }));
  const dsr = { difficulty: 5, stability: 12, lastReviewedAt: at, reviewCount: 9, consecutiveCorrect: 3, consecutiveWrong: 0 };
  await fs.writeFile(statePath(root), json({ version: 1, noteStates: {
    a: { pinned: true, flowSummary: 'Keep this field', dsrState: { ...dsr, conceptMastery: 95, conceptMasterySamples: 4 } },
    b: { dsrState: { ...dsr, conceptMastery: 75, conceptMasterySamples: 2 } },
    c: { dsrState: { ...dsr, conceptMastery: 20, conceptMasterySamples: 1, masteryShadow: createMasteryShadowState('c') } },
    new: { dsrState: { ...dsr, conceptMastery: 90, masteryShadow: { ...createMasteryShadowState('new'),
      updatedAt: at, appliedObservationIds: ['genuine-new-evaluation'] } } },
    empty: { dsrState: dsr },
  } }));
  await fs.writeFile(path.join(root, 'vault', 'notes', 'a.md'), 'Private body sentinel');
  await fs.writeFile(path.join(root, 'note-embeddings.json'), 'Index sentinel');
  await fs.writeFile(path.join(root, 'user-state', 'profile.json'), 'Profile sentinel');
  return root;
}

async function tree(root: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function visit(directory: string): Promise<void> {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, item.name);
      if (item.isDirectory()) await visit(file);
      else files[path.relative(root, file)] = (await fs.readFile(file)).toString('base64');
    }
  }
  await visit(root); return files;
}

try {
  const root = await fixture('happy');
  const before = await tree(root), original = await read(statePath(root));
  const preview = await migrateLegacyMastery({ dataRoot: root, migrationId: 'preview', migratedAt: at });
  assert.equal(preview.mode, 'dry-run'); assert.equal(preview.planned, 3); assert.equal(preview.changed, 0);
  assert.deepEqual(await tree(root), before, 'default preview creates no lock, backup or state mutation');
  await assert.rejects(migrateLegacyMastery({ dataRoot: root, apply: true }), /requires_app_closed_confirmation/u);
  await assert.rejects(migrateLegacyMastery({ dataRoot: root, apply: true, appClosed: true, isAppRunning: async () => true }), /application_is_running/u);
  assert.deepEqual(await tree(root), before, 'unsafe admission creates no artifacts');

  const applied = await migrateLegacyMastery({ dataRoot: root, apply: true, appClosed: true,
    isAppRunning: closed, migrationId: 'happy-migration', migratedAt: at });
  assert.equal(applied.changed, 3); assert(applied.manifestPath && applied.backupPath);
  assert.equal(await fs.readFile(applied.backupPath, 'utf8'), Buffer.from(before[path.join('user-state', 'user-state.json')], 'base64').toString('utf8'));
  const after = await read(statePath(root));
  for (const id of ['a', 'b', 'c']) {
    assert(after.noteStates[id].dsrState.masteryShadow);
    const copy = structuredClone(after.noteStates[id]); delete copy.dsrState.masteryShadow;
    const originalCopy = structuredClone(original.noteStates[id]); delete originalCopy.dsrState.masteryShadow;
    assert.deepEqual(copy, originalCopy, 'only the masteryShadow subfield changes');
  }
  assert.deepEqual(after.noteStates.new, original.noteStates.new, 'new evaluation is never remigrated');
  assert.deepEqual(after.noteStates.empty, original.noteStates.empty, 'missing old scores stay unassessed');
  const afterTree = await tree(root);
  for (const [file, value] of Object.entries(before)) if (file !== path.join('user-state', 'user-state.json')) {
    assert.equal(afterTree[file], value, 'body, metadata, vector and profile bytes remain unchanged');
  }
  assert.equal((await migrateLegacyMastery({ dataRoot: root, apply: true, appClosed: true, isAppRunning: closed })).changed, 0, 'rerun is idempotent');

  // An independent memory update must survive rollback. A later mastery evaluation must also survive.
  after.noteStates.a.dsrState.stability = 77;
  after.noteStates.a.dsrState.reviewCount = 123;
  after.noteStates.a.flowSummary = 'Newer summary';
  after.noteStates.b.dsrState.masteryShadow.updatedAt = '2026-10-19T00:00:00.000Z';
  await fs.writeFile(statePath(root), json(after));
  const beforeRollback = await tree(root);
  const rollbackPreview = await rollbackLegacyMastery({ dataRoot: root, manifestPath: applied.manifestPath });
  assert.equal(rollbackPreview.planned, 2); assert.equal(rollbackPreview.skippedReasons.newer_mastery_state_preserved, 1);
  assert.deepEqual(await tree(root), beforeRollback, 'rollback preview is read-only');
  await assert.rejects(rollbackLegacyMastery({ dataRoot: root, manifestPath: applied.manifestPath, apply: true }), /requires_app_closed_confirmation/u);
  const rollback = await rollbackLegacyMastery({ dataRoot: root, manifestPath: applied.manifestPath,
    apply: true, appClosed: true, isAppRunning: closed });
  assert.equal(rollback.changed, 2);
  const rolled = await read(statePath(root));
  assert(!Object.hasOwn(rolled.noteStates.a.dsrState, 'masteryShadow'));
  assert.equal(rolled.noteStates.a.dsrState.stability, 77); assert.equal(rolled.noteStates.a.dsrState.reviewCount, 123);
  assert.equal(rolled.noteStates.a.flowSummary, 'Newer summary');
  assert.deepEqual(rolled.noteStates.b, after.noteStates.b);
  assert.deepEqual(rolled.noteStates.c, original.noteStates.c, 'a pre-existing empty shadow is restored exactly');
  assert.equal((await rollbackLegacyMastery({ dataRoot: root, manifestPath: applied.manifestPath,
    apply: true, appClosed: true, isAppRunning: closed })).changed, 0, 'rollback is idempotent');

  const pendingRoot = await fixture('pending');
  await fs.writeFile(path.join(pendingRoot, 'user-state', 'vault-pending-snapshot.json'), 'must not recover');
  const pendingBefore = await tree(pendingRoot);
  await assert.rejects(migrateLegacyMastery({ dataRoot: pendingRoot }), /pending_vault_snapshot/u);
  await assert.rejects(migrateLegacyMastery({ dataRoot: pendingRoot, apply: true, appClosed: true, isAppRunning: closed }), /pending_vault_snapshot/u);
  assert.deepEqual(await tree(pendingRoot), pendingBefore);

  const corruptRoot = await fixture('corrupt');
  await fs.writeFile(statePath(corruptRoot), '{bad');
  const corruptBefore = await tree(corruptRoot);
  await assert.rejects(migrateLegacyMastery({ dataRoot: corruptRoot }), /invalid_json/u);
  assert.deepEqual(await tree(corruptRoot), corruptBefore);

  const extensionRoot = await fixture('unknown-extension');
  const extended = await read(statePath(extensionRoot)); extended.futureSchemaExtension = { preserve: true };
  await fs.writeFile(statePath(extensionRoot), json(extended));
  const extensionBefore = await tree(extensionRoot);
  await assert.rejects(migrateLegacyMastery({ dataRoot: extensionRoot, apply: true, appClosed: true, isAppRunning: closed }), /invalid_catalog/u);
  assert.deepEqual(await tree(extensionRoot), extensionBefore, 'unknown top-level data is not silently dropped by the serializer');

  const conflictRoot = await fixture('conflict');
  let checks = 0;
  await assert.rejects(migrateLegacyMastery({ dataRoot: conflictRoot, apply: true, appClosed: true,
    migrationId: 'conflicted', migratedAt: at, isAppRunning: async () => {
      checks += 1;
      if (checks === 2) {
        const state = await read(statePath(conflictRoot)); state.noteStates.a.dsrState.stability = 999;
        await fs.writeFile(statePath(conflictRoot), json(state));
      }
      return false;
    } }), /source_changed/u);
  assert.equal((await read(statePath(conflictRoot))).noteStates.a.dsrState.stability, 999);
  assert(!(await read(statePath(conflictRoot))).noteStates.a.dsrState.masteryShadow, 'concurrent source change is not overwritten');
  await assert.rejects(migrateLegacyMastery({ dataRoot: conflictRoot, apply: true, appClosed: true,
    isAppRunning: closed, migrationId: 'conflicted', migratedAt: at }), /EEXIST/u, 'interrupted backup IDs are immutable');

  const tamperedRoot = await fixture('tampered');
  const tampered = await migrateLegacyMastery({ dataRoot: tamperedRoot, apply: true, appClosed: true,
    isAppRunning: closed, migrationId: 'tampered', migratedAt: at });
  await fs.appendFile(tampered.backupPath!, ' ');
  const tamperedBefore = await tree(tamperedRoot);
  await assert.rejects(rollbackLegacyMastery({ dataRoot: tamperedRoot, manifestPath: tampered.manifestPath! }), /backup_hash_mismatch/u);
  assert.deepEqual(await tree(tamperedRoot), tamperedBefore);

  const forgedRoot = await fixture('forged');
  const forged = await migrateLegacyMastery({ dataRoot: forgedRoot, apply: true, appClosed: true,
    isAppRunning: closed, migrationId: 'forged', migratedAt: at });
  const forgedManifest = await read(forged.manifestPath!);
  forgedManifest.changes[0].after.value.updatedAt = '2026-12-01T00:00:00.000Z';
  const forgedExpected = await read(forged.backupPath!);
  for (const change of forgedManifest.changes) forgedExpected.noteStates[change.noteId].dsrState.masteryShadow = change.after.value;
  forgedManifest.afterHash = createHash('sha256').update(json(forgedExpected)).digest('hex');
  await fs.writeFile(forged.manifestPath!, json(forgedManifest));
  const forgedBefore = await tree(forgedRoot);
  await assert.rejects(rollbackLegacyMastery({ dataRoot: forgedRoot, manifestPath: forged.manifestPath! }), /manifest_policy_mismatch/u);
  assert.deepEqual(await tree(forgedRoot), forgedBefore, 'forged after-values are not trusted even with a recalculated hash');

  await assert.rejects(rollbackLegacyMastery({ dataRoot: root, manifestPath: forged.manifestPath! }), /invalid_manifest/u);
  const linkedRoot = path.join(base, 'linked-root');
  await fs.symlink(root, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(migrateLegacyMastery({ dataRoot: linkedRoot }), /unsafe_directory/u, 'root junction/symlink is refused');

  await assert.rejects(migrateLegacyMastery({ dataRoot: 'relative-root' }), /invalid_root/u);
  console.log('Legacy mastery IO passed: read-only preview, explicit closed-app admission, isolated backups, CAS conflict refusal, idempotency and per-shadow rollback. No production data or LLM requests.');
} finally {
  // The exact freshly created temp directory is owned by this test, never a user data root.
  assert(path.basename(base).startsWith('loginote-legacy-mastery-io-'));
  assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
  await fs.rm(base, { recursive: true, force: true });
}
