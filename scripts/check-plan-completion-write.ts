import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { NoteItem } from '../src/types';
import { applyPlanCompletionIntent } from '../src/services/planCompletion';
import { getLearningCompletionTarget } from '../src/services/learningCompletion';
import { getScheduledProjectState } from '../src/services/planProjectState';
import { commitPlanWrite } from '../src/services/ui/planWrite';
import { enqueueLearningWrite } from '../src/services/ui/learningWriteQueue';
import { buildHomeScheduledTasks, homeLocalDate } from '../src/services/homepage/homeTaskScheduling';
import { buildLearningProjectQueue } from '../src/services/learningProjectQueue';
import { buildPlanWorkspaceModel } from '../src/services/planViewModel';
import { formatPlanTaskLine } from '../src/services/planTaskAnchor';

const today = homeLocalDate();
function project(id: string, parentId?: string): NoteItem {
  const deadline = { id: `deadline-${id}`, noteId: id, noteTitle: id, taskText: id, startDate: today, dueDate: today, completed: false, priority: 'medium' as const };
  return { id, title: id, parentId, noteType: 'project', content: formatPlanTaskLine(id, today, deadline.id), dueDates: [deadline], tags: [], links: [], backlinks: [], createdAt: today, updatedAt: today };
}
function fixture() {
  const root = project('root');
  root.planMeta = { schemaVersion: 2, status: 'active', weeklyBudgetMinutes: 300, milestones: [{ id: 'gate', title: '验收', dueDate: today }] };
  root.dueDates.push({ id: 'daily', noteId: 'root', noteTitle: 'root', taskText: '每天一题', startDate: today, dueDate: today, priority: 'medium', completed: false, recurrence: { frequency: 'daily' } });
  return [root, project('a', 'root'), project('b', 'root'), project('unrelated')];
}
function deferred() { let resolve!: () => void, reject!: (e: Error) => void; const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

// Execute the actual App completion callbacks; replace only state/IO boundaries.
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
const start = app.indexOf('  const persistPlanCompletion =');
const end = app.indexOf('  const handleAddPlanWorkspaceTask =', start);
assert.ok(start > 0 && end > start);
const compiled = ts.transpileModule(`function createCallbacks() { ${app.slice(start, end)} return { task: handleTogglePlanWorkspaceTask, project: handleTogglePlanWorkspaceProject, milestone: handleTogglePlanWorkspaceMilestone }; }`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
let notes = fixture(), disk = structuredClone(notes), saveCount = 0, applyCount = 0;
let gate = deferred(), fail = false;
const queue = { current: Promise.resolve() as Promise<unknown> };
const notesRef = { get current() { return notes; } };
const writer = {
  readNotes: () => notes,
  saveNotes: async (candidate: NoteItem[]) => { saveCount++; await gate.promise; if (fail) throw new Error('synthetic disk failure'); disk = structuredClone(candidate); },
  applyNotes: (candidate: NoteItem[]) => { applyCount++; notes = candidate; },
};
const callbacks = runInNewContext(`${compiled}\ncreateCallbacks();`, {
  isPlanPreviewDemo: false, notesRef, getLearningCompletionTarget, getScheduledProjectState, applyPlanCompletionIntent,
  persistPlanMutation: (prepare: (current: NoteItem[]) => { notes: NoteItem[] }) => enqueueLearningWrite(queue, () => commitPlanWrite(writer, prepare)),
});
const operation = callbacks.project('a', true);
await Promise.resolve(); await Promise.resolve();
assert.equal(saveCount, 1);
assert.equal(applyCount, 0);
assert.equal(getScheduledProjectState(notes, 'a').completed, false, 'pending completion cannot alter any visible page');
notes = notes.map(note => note.id === 'unrelated' ? { ...note, content: 'new concurrent text' } : note);
gate.resolve(); await operation;
assert.equal(getScheduledProjectState(notes, 'a').completed, true);
assert.equal(notes.find(note => note.id === 'unrelated')?.content, 'new concurrent text');
assert.deepEqual(disk, notes);
assert.equal(buildHomeScheduledTasks(notes, today).find(row => row.ownerNoteId === 'a')?.launch, null);
assert.equal(buildLearningProjectQueue(notes, today).find(row => row.note.id === 'a')?.isFullyCompleted, true);
assert.equal(buildPlanWorkspaceModel(notes, 'root', today).structureDueItems.find(row => row.projectId === 'a')?.completed, true);
assert.equal(notes[0].planMeta!.milestones![0].completed, undefined, 'leaf completion does not automatically accept a milestone');
await callbacks.project('a', true);
assert.equal(getScheduledProjectState(notes, 'a').completed, true, 'an explicit retry cannot toggle back');

fail = true;
const unchanged = notes;
await assert.rejects(callbacks.project('b', true), /synthetic disk failure/);
assert.equal(notes, unchanged, 'failed writes cannot present a task or its ancestors as complete');
fail = false;
await callbacks.project('b', true);
assert.equal(getScheduledProjectState(notes, 'root').completed, true);
await callbacks.milestone('root', 'gate', true);
assert.equal(notes[0].planMeta!.milestones![0].completed, true);
await callbacks.milestone('root', 'gate', true);
assert.equal(notes[0].planMeta!.milestones![0].completed, true);
await callbacks.milestone('root', 'gate', false);
await callbacks.project('a', false);
await assert.rejects(callbacks.milestone('root', 'gate', true), /前置项目/);
assert.equal(notes[0].planMeta!.milestones![0].completed, false);

await callbacks.task('root', 'daily', today, true);
assert.deepEqual(notes[0].dueDates.find(task => task.id === 'daily')!.completedOccurrenceDates, [today]);
assert.equal(notes[0].dueDates.find(task => task.id === 'daily')!.completed, false);
assert.equal(getScheduledProjectState(notes, 'a').completed, false);
await callbacks.task('root', 'daily', today, true);
assert.deepEqual(notes[0].dueDates.find(task => task.id === 'daily')!.completedOccurrenceDates, [today]);
await callbacks.task('root', 'daily', today, false);
assert.deepEqual(notes[0].dueDates.find(task => task.id === 'daily')!.completedOccurrenceDates, []);
const future = new Date(); future.setDate(future.getDate() + 1);
const beforeFuture = saveCount;
await assert.rejects(callbacks.task('root', 'daily', homeLocalDate(future), true), /尚未到/);
assert.equal(saveCount, beforeFuture, 'future acknowledgements fail before IO');
await assert.rejects(callbacks.task('root', 'deadline-root', today, true), /调整或移除/);
await assert.rejects(callbacks.project('missing', true), /取消排期或移除/);
await assert.rejects(callbacks.milestone('root', 'missing', true), /调整或移除/);

// Freeze a specific prior occurrence: retries across midnight must not complete tomorrow.
const frozen = { kind: 'execution' as const, binding: { noteId: 'root', taskId: 'daily', occurrenceDate: today }, completed: true };
const nextDay = applyPlanCompletionIntent(notes, frozen, `${homeLocalDate(future)}T12:00:00+08:00`);
assert.deepEqual(nextDay[0].dueDates.find(task => task.id === 'daily')!.completedOccurrenceDates, [today]);
console.log('PASS plan completion: actual App callbacks, save-before-publish, shared queue, concurrent edits, explicit retry/undo, manual milestone gates, exact local occurrences and cross-page state consistency; synthetic IO only.');
