import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { NoteItem, ResourceWorkbenchCommitEvent } from '../src/types';
import { applyConfirmedWorkbenchResources, createResourceDraftSession } from '../src/services/agent/resourceDraftService';
import { saveAllNotesToStorage } from '../src/services/storage';
import { enqueueLearningWrite } from '../src/services/ui/learningWriteQueue';
import { commitPlanWrite } from '../src/services/ui/planWrite';

function note(id: string, parentId?: string): NoteItem {
  return { id, title: id, parentId, noteType: 'project', content: '原有内容', dueDates: [],
    tags: [], links: [], backlinks: [], createdAt: '2026-10-01', updatedAt: '2026-10-01' };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const adjust = (notes: NoteItem[]) => ({ notes: notes.map((item) => item.id === 'root'
  ? { ...item, planMeta: { schemaVersion: 2 as const, status: 'active' as const, weeklyBudgetMinutes: 300 }, updatedAt: '2026-10-06' } : item), tag: 'saved' });

async function delayedSave() {
  let notes = [note('root'), note('child', 'root'), note('other')];
  const original = notes;
  const gate = deferred();
  const saves: NoteItem[][] = [];
  let applies = 0;
  const operation = commitPlanWrite({
    readNotes: () => notes,
    saveNotes: async (candidate) => { saves.push(candidate); await gate.promise; },
    applyNotes: (candidate) => { notes = candidate; applies++; },
  }, adjust, 'root');
  assert.equal(saves.length, 1);
  assert.equal(notes, original);
  assert.equal(applies, 0, 'a pending write cannot publish the plan');
  gate.resolve();
  const result = await operation;
  assert.equal(result.tag, 'saved');
  assert.equal(applies, 1);
  assert.equal(notes[0].planMeta!.weeklyBudgetMinutes, 300);
  assert.equal(notes[1].content, '原有内容');
  assert.equal(notes[2].planMeta, undefined);
}

async function unrelatedEditSurvives() {
  let notes = [note('root'), note('other')];
  const gate = deferred();
  const saves: NoteItem[][] = [];
  let applies = 0;
  const operation = commitPlanWrite({
    readNotes: () => notes,
    saveNotes: async (candidate) => { saves.push(candidate); if (saves.length === 1) await gate.promise; },
    applyNotes: (candidate) => { notes = candidate; applies++; },
  }, adjust, 'root');
  notes = notes.map((item) => item.id === 'other' ? { ...item, content: '另一计划的最新编辑' } : item);
  gate.resolve(); await operation;
  assert.equal(saves.length, 2, 're-save on the live snapshot before publishing');
  assert.equal(applies, 1);
  assert.equal(notes.find((item) => item.id === 'other')!.content, '另一计划的最新编辑');
}

async function scopeConflictPreservesData() {
  for (const addedChild of [false, true]) {
    let notes = [note('root'), note('child', 'root'), note('other')];
    const gate = deferred();
    const saves: NoteItem[][] = [];
    let applies = 0;
    const operation = commitPlanWrite({
      readNotes: () => notes,
      saveNotes: async (candidate) => { saves.push(candidate); if (saves.length === 1) await gate.promise; },
      applyNotes: () => { applies++; },
    }, adjust, 'root');
    notes = addedChild ? [...notes, note('new-child', 'root')]
      : notes.map((item) => item.id === 'child' ? { ...item, content: '保留这一新输入' } : item);
    gate.resolve();
    await assert.rejects(operation, /计划在保存期间发生了修改/);
    assert.equal(applies, 0);
    assert.equal(saves.length, 2, 'compensate a stale disk candidate with the visible latest data');
    assert.equal(saves[1], notes);
    assert.equal(notes[0].planMeta, undefined);
    assert.ok(addedChild ? notes.some((item) => item.id === 'new-child') : notes[1].content === '保留这一新输入');
  }
}

async function failureKeepsDraftAndRetryHasStableIdentity() {
  let notes = [note('other')];
  const created = note('stable-new-plan');
  let fail = true;
  let applies = 0;
  const writer = {
    readNotes: () => notes,
    saveNotes: async () => { if (fail) throw new Error('磁盘不可写'); },
    applyNotes: (candidate: NoteItem[]) => { notes = candidate; applies++; },
  };
  const prepare = (current: NoteItem[]) => ({ notes: [...current, created] });
  await assert.rejects(commitPlanWrite(writer, prepare), /磁盘不可写/);
  assert.equal(applies, 0);
  assert.deepEqual(notes.map((item) => item.id), ['other']);
  fail = false;
  await commitPlanWrite(writer, prepare);
  assert.equal(applies, 1);
  assert.equal(notes.filter((item) => item.id === created.id).length, 1);
}

async function noNoteDeletionOrIdCollision() {
  let notes = [note('root'), note('child', 'root')];
  let writes = 0;
  const writer = { readNotes: () => notes, saveNotes: async () => { writes++; }, applyNotes: (value: NoteItem[]) => { notes = value; } };
  await assert.rejects(commitPlanWrite(writer, () => ({ notes: [notes[0]] }), 'root'), /不能删除原有笔记/);
  await assert.rejects(commitPlanWrite(writer, () => ({ notes: [...notes, notes[1]] }), 'root'), /重复或缺失/);
  assert.equal(writes, 0);
  const candidate = note('new');
  const gate = deferred();
  const operation = commitPlanWrite({ ...writer, saveNotes: async () => { writes++; if (writes === 1) await gate.promise; } },
    (base) => ({ notes: [...base, candidate] }));
  notes = [...notes, { ...candidate, content: '其他来源刚创建的同一 ID' }];
  gate.resolve();
  await assert.rejects(operation, /目标笔记在保存期间发生了修改/);
  assert.equal(notes.at(-1)!.content, '其他来源刚创建的同一 ID');
}

async function workbenchCommitPreservesPendingNewPlan() {
  const now = '2026-10-06T00:00:00.000Z';
  const taskText = '阅读 [[queue-knowledge]]';
  const resourceProject = { ...note('resource-root'), content: `- [ ] ${taskText}` };
  const knowledge: NoteItem = { ...note('queue-knowledge'), noteType: 'knowledge' };
  let notes = [resourceProject, knowledge];
  let disk = structuredClone(notes);
  const session = createResourceDraftSession(notes, { selectedProjectId: resourceProject.id }, now, 'queue-resource-session');
  const payload: ResourceWorkbenchCommitEvent = {
    commitId: 'queue-resource-commit', sessionId: 'queue-native-workbench', draftSessionId: session.id,
    selectedResources: [{
      title: '队列知识点教程', url: 'https://example.org/queue-resource', kind: 'online',
      projectTitle: resourceProject.title, taskText, knowledgeTitles: [knowledge.title],
    }],
    rejectedResources: [], downloadedCandidateIds: [], downloadedResources: [], downloadErrors: [],
  };
  const createdPlan: NoteItem = {
    ...note('queued-new-plan'),
    planMeta: { schemaVersion: 2, status: 'active', weeklyBudgetMinutes: 300 },
  };
  const createdChild = note('queued-new-child', createdPlan.id);
  const queue = { current: Promise.resolve() as Promise<unknown> };
  const planSaveStarted = deferred();
  const finishPlanSave = deferred();
  const resourceSaved = deferred();
  const finishPreferences = deferred();
  const snapshots: NoteItem[][] = [];
  let applies = 0;
  let resourcePrepares = 0;
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  // Exercise the real invocation-order disk queue without contacting a real vault.
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    electronAPI: { vault: { saveVault: async (candidate: NoteItem[]) => {
      snapshots.push(structuredClone(candidate));
      if (snapshots.length === 1) { planSaveStarted.resolve(); await finishPlanSave.promise; }
      disk = structuredClone(candidate);
    } } },
  } });
  const writer = {
    readNotes: () => notes,
    saveNotes: saveAllNotesToStorage,
    applyNotes: (candidate: NoteItem[]) => { notes = candidate; applies++; },
  };
  const persist = <T extends { notes: NoteItem[] }>(prepare: (current: NoteItem[]) => T, rootId?: string) =>
    enqueueLearningWrite(queue, () => commitPlanWrite(writer, prepare, rootId));
  const operations: Promise<unknown>[] = [];
  try {
    const planCommit = persist((current) => ({ notes: [...current, createdPlan, createdChild] }));
    operations.push(planCommit);
    await Promise.race([planSaveStarted.promise, planCommit]);
    assert.equal(applies, 0, 'the new plan remains unpublished while its real storage write is pending');
    assert.ok(!notes.some((item) => item.id === createdPlan.id));

    // A native window can emit this callback while the main-window dialog saves.
    const resourceCommit = (async () => {
      const mutation = await persist((current) => {
        resourcePrepares++;
        assert.equal(applies, 1, 'resource preparation must follow the new-plan publication');
        assert.ok(current.some((item) => item.id === createdPlan.id), 'prepare from the latest plan snapshot');
        assert.ok(current.some((item) => item.id === createdChild.id), 'the full new hierarchy must survive');
        return applyConfirmedWorkbenchResources(current, session, payload, now);
      }, session.scopeProjectId);
      resourceSaved.resolve();
      await finishPreferences.promise;
      return mutation.summary;
    })();
    operations.push(resourceCommit);
    assert.equal(resourcePrepares, 0, 'a workbench event cannot prepare a stale snapshot during the pending plan save');
    assert.equal(snapshots.length, 1, 'the workbench write waits in the application queue before reaching storage');
    finishPlanSave.resolve();
    await planCommit;
    await Promise.race([resourceSaved.promise, resourceCommit]);
    assert.equal(resourcePrepares, 1);
    assert.equal(snapshots.length, 2);
    assert.equal(applies, 2);
    for (const snapshot of [notes, disk, snapshots[1]]) {
      assert.equal(snapshot.filter((item) => item.id === createdPlan.id).length, 1);
      assert.equal(snapshot.find((item) => item.id === createdChild.id)?.parentId, createdPlan.id);
      assert.equal(snapshot.find((item) => item.id === resourceProject.id)?.resources?.[0]?.url, payload.selectedResources[0].url,
        'the persisted snapshot must contain both the new plan and the confirmed resource');
    }

    // Preference recording is asynchronous; its completion must not replay its
    // earlier resource snapshot over another transaction completed meanwhile.
    await persist((current) => ({ notes: current.map((item) => item.id === createdPlan.id
      ? { ...item, content: '偏好保存期间的新编辑', updatedAt: '2026-10-06T00:01:00.000Z' } : item) }), createdPlan.id);
    const latest = notes;
    finishPreferences.resolve();
    assert.equal((await resourceCommit).addedResourceCount, 1);
    assert.equal(notes, latest, 'late preference completion cannot replay captured mutation.notes');
    assert.equal(notes.find((item) => item.id === createdPlan.id)?.content, '偏好保存期间的新编辑');
    assert.deepEqual(disk, notes, 'final visible and persisted snapshots retain the plan, resource and later edit');
  } finally {
    finishPlanSave.resolve();
    finishPreferences.resolve();
    await Promise.allSettled(operations);
    await queue.current.catch(() => {});
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
}

function workbenchUsesSharedTransaction() {
  const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('return workbench.onCommitted(');
  const end = source.indexOf('const updateWorkflowHandoff', start);
  assert.ok(start >= 0 && end > start, 'the native workbench commit callback must be inspected');
  const callback = source.slice(start, end);
  assert.match(callback, /const mutation = await persistPlanMutation\(\(current\) => \{[\s\S]*?return applyConfirmedWorkbenchResources\(current, next, payload\);[\s\S]*?\}, session\.scopeProjectId\);/,
    'native resource commits must await preparation from current notes under the locked scope');
  assert.match(callback, /resourceDraftSessionRef\.current\?\.id !== session\.id/,
    'the queued preparation must recheck the resource session');
  assert.doesNotMatch(callback, /saveAllNotesToStorage\(/, 'the callback cannot bypass the shared application queue');
  assert.doesNotMatch(callback, /notesRef\.current\s*=\s*mutation\.notes|setNotes\(\s*mutation\.notes\s*\)/,
    'preference recording must never replay a captured resource snapshot');
  const persistStart = source.indexOf('const persistPlanMutation');
  const persistEnd = source.indexOf('const handleBatchCreateProjectTree', persistStart);
  assert.ok(persistStart >= 0 && persistEnd > persistStart);
  assert.match(source.slice(persistStart, persistEnd), /enqueueLearningWrite\(learningWriteQueueRef/,
    'the workbench and plan callbacks must use the same application transaction queue');
}

await delayedSave();
await unrelatedEditSurvives();
await scopeConflictPreservesData();
await failureKeepsDraftAndRetryHasStableIdentity();
await noNoteDeletionOrIdCollision();
await workbenchCommitPreservesPendingNewPlan();
workbenchUsesSharedTransaction();
console.log('Plan save checks passed: delayed publication, live-edit rebasing, conflict recovery, safe retry, no note deletion and concurrent native resource commits.');
