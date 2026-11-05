import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { NoteItem } from '../src/types';
import { getLearningCompletionTarget, getProjectCompletionTarget, type LearningCompletionTarget } from '../src/services/learningCompletion';
import { getScheduledProjectState } from '../src/services/planProjectState';
import { formatPlanTaskLine } from '../src/services/planTaskAnchor';
import { commitLearningCompletion } from '../src/services/ui/learningCompletionWrite';

function project(id: string, parentId?: string): NoteItem {
  const deadline = {
    id: `deadline-${id}`, noteId: id, noteTitle: id, taskText: id,
    dueDate: '2099-12-31', startDate: '2020-01-01', completed: false, priority: 'medium' as const,
  };
  return {
    id, title: id, noteType: 'project', parentId,
    content: formatPlanTaskLine(deadline.taskText, deadline.dueDate, deadline.id),
    dueDates: [deadline], tags: [], links: [], backlinks: [],
    createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z',
  };
}

function fixtures(): NoteItem[] {
  const root = project('root');
  root.planMeta = {
    schemaVersion: 2, status: 'active', weeklyBudgetMinutes: 300,
    milestones: [{ id: 'manual-gate', title: '自行验收', dueDate: '2099-12-31', completed: false }],
  };
  return [root, project('a', root.id), project('b', root.id)];
}

function required(target: LearningCompletionTarget | null): LearningCompletionTarget {
  assert.ok(target);
  return target;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (cause?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function delayedPublish() {
  let notes = fixtures();
  const base = notes;
  const saved: NoteItem[][] = [];
  let applies = 0;
  let beforeSaves = 0;
  const pending = deferred();
  const target = required(getProjectCompletionTarget(notes, 'a'));
  const result = commitLearningCompletion({
    readNotes: () => notes,
    beforeSave: () => { beforeSaves += 1; },
    saveNotes: async (value) => { saved.push(value); await pending.promise; },
    applyNotes: (value) => { applies += 1; notes = value; },
  }, target, true);
  assert.equal(saved.length, 1);
  assert.equal(applies, 0, 'completion is not published while its disk write is pending');
  assert.equal(notes, base);
  assert.equal(getScheduledProjectState(notes, 'a').completed, false);
  pending.resolve();
  await result;
  assert.equal(applies, 1);
  assert.equal(beforeSaves, 1);
  assert.equal(getScheduledProjectState(notes, 'a').completed, true);
  assert.equal(getScheduledProjectState(notes, 'root').completed, false);
  assert.deepEqual(notes[0].planMeta!.milestones, base[0].planMeta!.milestones);
  assert.equal(base[1].dueDates[0].completed, false, 'the old immutable UI snapshot is not modified');
}

async function concurrentEditRebase() {
  let notes = fixtures();
  const saved: NoteItem[][] = [];
  const published: NoteItem[][] = [];
  const firstSave = deferred();
  const secondSave = deferred();
  const secondStarted = deferred();
  const target = required(getProjectCompletionTarget(notes, 'a'));
  const operation = commitLearningCompletion({
    readNotes: () => notes,
    saveNotes: async (value) => {
      saved.push(value);
      if (saved.length === 1) await firstSave.promise;
      else { secondStarted.resolve(); await secondSave.promise; }
    },
    applyNotes: (value) => { published.push(value); notes = value; },
  }, target, true);
  // Simulate typing and independently completing a sibling while the first write awaits disk.
  notes = notes.map((note) => note.id === 'b'
    ? {
      ...note,
      content: `- [x] b @due(2099-12-31) <!-- ln-task:deadline-b -->\n用户正在编辑的最新内容`,
      dueDates: note.dueDates.map((item) => ({ ...item, completed: true, completedAt: '2026-10-01T00:00:00.000Z' })),
      updatedAt: '2026-10-01T00:00:00.000Z',
    }
    : note.id === 'a' ? { ...note, content: `${note.content}\n新的学习记录` } : note);
  firstSave.resolve();
  await secondStarted.promise;
  assert.equal(published.length, 0, 'the old completion snapshot is never applied over concurrent edits');
  assert.equal(saved.length, 2, 'completion is recalculated and saved again on the latest notes');
  assert.match(saved[1].find((note) => note.id === 'a')!.content, /新的学习记录/);
  assert.match(saved[1].find((note) => note.id === 'b')!.content, /用户正在编辑的最新内容/);
  assert.equal(getScheduledProjectState(saved[1], 'root').completed, true, 'ancestor roll-up uses the newly completed sibling');
  secondSave.resolve();
  await operation;
  assert.equal(published.length, 1);
  assert.equal(getScheduledProjectState(notes, 'a').completed, true);
  assert.equal(getScheduledProjectState(notes, 'b').completed, true);
  assert.equal(notes[0].planMeta!.status, 'completed');
  // Undo uses the latest siblings and cannot restore the pre-write tree.
  await commitLearningCompletion({
    readNotes: () => notes, saveNotes: async () => {}, applyNotes: (value) => { notes = value; },
  }, target, false);
  assert.equal(getScheduledProjectState(notes, 'root').completed, false);
  assert.equal(getScheduledProjectState(notes, 'b').completed, true);
  assert.match(notes.find((note) => note.id === 'a')!.content, /新的学习记录/);
  assert.match(notes.find((note) => note.id === 'b')!.content, /用户正在编辑的最新内容/);
}

async function failureAndRetry() {
  let notes = fixtures();
  const base = notes;
  let applies = 0;
  let attempts = 0;
  const target = required(getProjectCompletionTarget(notes, 'a'));
  const writer = {
    readNotes: () => notes,
    saveNotes: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('磁盘暂时不可写');
    },
    applyNotes: (value: NoteItem[]) => { applies += 1; notes = value; },
  };
  await assert.rejects(commitLearningCompletion(writer, target, true), /磁盘暂时不可写/);
  assert.equal(applies, 0, 'failed save must not claim that the task has completed');
  assert.equal(notes, base);
  assert.equal(getScheduledProjectState(notes, 'a').completed, false);
  await commitLearningCompletion(writer, target, true);
  assert.equal(attempts, 2);
  assert.equal(applies, 1);
  assert.equal(getScheduledProjectState(notes, 'a').completed, true);
  const acknowledged = notes;
  const time = notes[1].dueDates[0].completedAt;
  await commitLearningCompletion(writer, target, true);
  assert.equal(notes, acknowledged, 'a duplicate explicit true never toggles completion back off');
  assert.equal(notes[1].dueDates[0].completedAt, time, 'retry does not replace the acknowledgement timestamp');
  assert.equal(getScheduledProjectState(notes, 'a').completed, true);
}

async function failurePreservesConcurrentEdit() {
  let notes = fixtures();
  const pending = deferred();
  let applies = 0;
  const target = required(getProjectCompletionTarget(notes, 'a'));
  const result = commitLearningCompletion({
    readNotes: () => notes,
    saveNotes: async () => pending.promise,
    applyNotes: (value) => { notes = value; applies += 1; },
  }, target, true);
  notes = notes.map((note) => note.id === 'a' ? { ...note, content: `${note.content}\n保存等待期间的新输入` } : note);
  pending.reject(new Error('保存失败'));
  await assert.rejects(result, /保存失败/);
  assert.equal(applies, 0);
  assert.equal(getScheduledProjectState(notes, 'a').completed, false);
  assert.match(notes[1].content, /保存等待期间的新输入/);
  await commitLearningCompletion({
    readNotes: () => notes, saveNotes: async () => {}, applyNotes: (value) => { notes = value; },
  }, target, true);
  assert.equal(getScheduledProjectState(notes, 'a').completed, true);
  assert.match(notes[1].content, /保存等待期间的新输入/);
}

async function invalidAndOccurrenceIsolation() {
  let notes = fixtures();
  const target = required(getProjectCompletionTarget(notes, 'a'));
  notes = notes.filter((note) => note.id !== 'a');
  let saves = 0;
  let applies = 0;
  await assert.rejects(commitLearningCompletion({
    readNotes: () => notes,
    saveNotes: async () => { saves += 1; },
    applyNotes: (value) => { notes = value; applies += 1; },
  }, target, true), /移除|调整/);
  assert.equal(saves, 0, 'invalidated work is rejected before a storage write');
  assert.equal(applies, 0);

  const localNow = new Date();
  const today = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(localNow.getDate()).padStart(2, '0')}`;
  const yesterdayDate = new Date(localNow.getFullYear(), localNow.getMonth(), localNow.getDate() - 1);
  const yesterday = `${yesterdayDate.getFullYear()}-${String(yesterdayDate.getMonth() + 1).padStart(2, '0')}-${String(yesterdayDate.getDate()).padStart(2, '0')}`;
  notes = fixtures();
  notes[0] = {
    ...notes[0],
    dueDates: [...notes[0].dueDates, {
      id: 'daily', noteId: 'root', noteTitle: 'root', taskText: '每日计算练习', dueDate: '2099-12-31',
      startDate: '2020-01-01', completed: false, priority: 'medium', recurrence: { frequency: 'daily' },
      executionKind: 'practice', completedOccurrenceDates: [yesterday],
    }],
  };
  const occurrence = required(getLearningCompletionTarget(notes, { noteId: 'root', taskId: 'daily' }));
  assert.equal(occurrence.binding.occurrenceDate, today);
  await commitLearningCompletion({
    readNotes: () => notes, saveNotes: async () => {}, applyNotes: (value) => { notes = value; },
  }, occurrence, true);
  assert.deepEqual(notes[0].dueDates.find((item) => item.id === 'daily')!.completedOccurrenceDates, [yesterday, today].sort());
  assert.equal(getScheduledProjectState(notes, 'a').completed, false);
  assert.equal(getScheduledProjectState(notes, 'root').completed, false, 'execution completion does not complete structural ancestors');
}

async function compensateRebaseFailure(compensationFails: boolean) {
  let notes = fixtures();
  let disk = structuredClone(notes);
  const firstSave = deferred();
  const secondFailure = new Error('并发重算后的第二次保存失败');
  const compensationFailure = new Error('补偿写入也失败');
  const target = required(getProjectCompletionTarget(notes, 'a'));
  const attempted: NoteItem[][] = [];
  let applies = 0;
  const operation = commitLearningCompletion({
    readNotes: () => notes,
    saveNotes: async (value) => {
      attempted.push(value);
      if (attempted.length === 1) {
        disk = structuredClone(value);
        await firstSave.promise;
      } else if (attempted.length === 2) throw secondFailure;
      else {
        if (compensationFails) throw compensationFailure;
        disk = structuredClone(value);
      }
    },
    applyNotes: (value) => { notes = value; applies += 1; },
  }, target, true);
  notes = notes.map((note) => note.id === 'a'
    ? { ...note, content: `${note.content}\n并发写入的新内容`, updatedAt: '2026-10-01T00:00:00.000Z' } : note);
  const latest = notes;
  firstSave.resolve();
  await assert.rejects(operation, (cause) => cause === secondFailure,
    'a failed compensation must not replace the original completion-save error');
  assert.equal(attempted.length, 3, 'an acknowledged older candidate triggers a latest-state compensating write');
  assert.equal(attempted[2], latest, 'compensation reads the newest live state, not the stale completion candidate');
  assert.equal(applies, 0);
  assert.equal(notes, latest, 'neither failure path publishes or rolls back user edits');
  assert.equal(getScheduledProjectState(notes, 'a').completed, false);
  assert.match(notes[1].content, /并发写入的新内容/);
  if (!compensationFails) {
    assert.deepEqual(disk, latest, 'successful compensation removes the stale candidate from disk');
    assert.equal(getScheduledProjectState(disk, 'a').completed, false);
  }
  await commitLearningCompletion({
    readNotes: () => notes,
    saveNotes: async (value) => { disk = structuredClone(value); },
    applyNotes: (value) => { notes = value; applies += 1; },
  }, target, true);
  assert.equal(applies, 1, 'either failed path can retry the same explicit completion request');
  assert.equal(getScheduledProjectState(notes, 'a').completed, true);
  assert.match(notes[1].content, /并发写入的新内容/);
  assert.deepEqual(disk, notes);
}

async function compensateInvalidatedTarget() {
  let notes = fixtures();
  let disk = structuredClone(notes);
  const firstSave = deferred();
  const target = required(getProjectCompletionTarget(notes, 'a'));
  let saves = 0;
  let applies = 0;
  const operation = commitLearningCompletion({
    readNotes: () => notes,
    saveNotes: async (value) => {
      saves += 1;
      disk = structuredClone(value);
      if (saves === 1) await firstSave.promise;
    },
    applyNotes: (value) => { notes = value; applies += 1; },
  }, target, true);
  notes = notes.filter((note) => note.id !== 'a');
  firstSave.resolve();
  await assert.rejects(operation, /移除|调整/);
  assert.equal(applies, 0);
  assert.equal(saves, 2, 'invalidated rebase compensates the previously saved candidate');
  assert.deepEqual(disk, notes, 'a removed task cannot be resurrected by an older completion snapshot');
}

await delayedPublish();
await concurrentEditRebase();
await failureAndRetry();
await failurePreservesConcurrentEdit();
await invalidAndOccurrenceIsolation();
await compensateRebaseFailure(false);
await compensateRebaseFailure(true);
await compensateInvalidatedTarget();

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const sceneChat = readFileSync(new URL('../src/components/scene/SceneChatView.tsx', import.meta.url), 'utf8');
const sceneDerivation = readFileSync(new URL('../src/components/scene/SceneDerivationView.tsx', import.meta.url), 'utf8');
assert.match(app, /commitLearningCompletion\(/, 'App uses the tested pessimistic completion writer');
assert.match(app, /learningWriteQueueRef\.current/, 'completion requests are serialized rather than toggled concurrently');
assert.match(app, /getLearningCompletionTarget\(notesRef\.current, request\.taskBinding\)/,
  'scene launches bind explicit task IDs, not guessed subject strings');
assert.doesNotMatch(app, /flowTaskBindingRef\.current\s*\|\|\s*\{\s*noteId:\s*session\.noteId\s*\}/,
  'an invalid or absent frozen execution binding cannot fall back to completing the study note');
assert.match(sceneChat, /finished\s*&&\s*completionContent/, 'S1 acknowledgement is only offered on the result page');
assert.match(sceneDerivation, /isEnded\s*&&\s*\([\s\S]*?completionContent\s*!=\s*null/,
  'S4 acknowledgement is only offered after the run ends');
console.log('Learning completion write checks passed: save-before-publish, delayed rebase, concurrent edits, failure/retry, compensation, occurrence isolation and UI wiring.');
