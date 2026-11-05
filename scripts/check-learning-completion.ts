import assert from 'node:assert/strict';
import type { DueDateItem, NoteItem } from '../src/types';
import {
  getLearningCompletionTarget,
  getProjectCompletionTarget,
  setLearningCompletion,
  type LearningCompletionTarget,
} from '../src/services/learningCompletion';
import { getScheduledProjectState } from '../src/services/planProjectState';
import { formatPlanTaskLine } from '../src/services/planTaskAnchor';

const NOW = '2026-10-06T12:00:00.000Z';
const TOMORROW = '2026-10-07';

function note(id: string, parentId?: string, scheduled = false): NoteItem {
  const task: DueDateItem = {
    id: `deadline-${id}`, noteId: id, noteTitle: id, taskText: id,
    startDate: '2026-10-01', dueDate: '2026-10-09', completed: false, priority: 'medium',
  };
  return {
    id, title: id, noteType: 'project', parentId, tags: ['keep-tag'],
    links: ['keep-link'], backlinks: ['keep-backlink'],
    content: scheduled ? formatPlanTaskLine(task.taskText, task.dueDate, task.id) : 'ordinary editable content',
    dueDates: scheduled ? [task] : [],
    resources: [{ title: 'keep resource', url: 'https://example.org/resource' }],
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

function target(value: LearningCompletionTarget | null): LearningCompletionTarget {
  assert.ok(value);
  return value;
}

function execution(taskId: string, recurrence?: DueDateItem['recurrence']): DueDateItem {
  return {
    id: taskId, noteId: 'root', noteTitle: 'root', taskText: '每日一道计算题',
    startDate: '2026-10-01', dueDate: '2026-10-09', completed: false,
    priority: 'medium', executionKind: 'practice', kind: 'practice',
    estimatedMinutes: 20, launchMode: 'scene', recurrence,
    linkedProjectId: 'leaf-a', completedOccurrenceDates: ['2026-10-05'],
  };
}

const root = note('root', undefined, true);
root.planMeta = {
  schemaVersion: 2, status: 'active', weeklyBudgetMinutes: 300,
  startDate: '2026-10-01', targetDate: '2026-10-09',
  milestones: [{ id: 'manual-gate', title: '自我验收', dueDate: '2026-10-09', completed: false }],
};
const parent = note('parent', 'root', true);
const leafA = note('leaf-a', 'parent', true);
const leafB = note('leaf-b', 'parent', true);
const ordinary = note('ordinary', 'root');
const knowledge = { ...note('knowledge'), noteType: 'knowledge' as const };
const unrelated = note('other-root', undefined, true);
const initial = [root, parent, leafA, leafB, ordinary, knowledge, unrelated];
const snapshot = structuredClone(initial);

assert.equal(getProjectCompletionTarget(initial, root.id), null, 'a scheduled root with descendants is not leaf work');
assert.equal(getProjectCompletionTarget(initial, parent.id), null, 'a scheduled parent cannot be completed at learning exit');
assert.equal(getProjectCompletionTarget(initial, ordinary.id), null, 'ordinary projects never acquire task semantics');
assert.equal(getProjectCompletionTarget(initial, knowledge.id), null, 'knowledge notes do not become project tasks');
assert.equal(getLearningCompletionTarget(initial), null, 'an explicit source binding is required');
assert.equal(getLearningCompletionTarget(initial, { noteId: 'missing' }), null);
assert.equal(getLearningCompletionTarget(initial, { noteId: leafA.id, taskId: 'missing' }), null,
  'invalid execution binding must not silently complete its scheduled project');
assert.equal(getLearningCompletionTarget(initial, { noteId: leafA.id, taskId: leafA.dueDates[0].id }), null,
  'a structural deadline is not a separate execution task');
assert.equal(getLearningCompletionTarget(initial, { noteId: leafA.id, occurrenceDate: '2026-10-06' }), null,
  'a malformed date-only binding cannot silently become structural completion');
assert.deepEqual(target(getProjectCompletionTarget(initial, leafA.id)).path, ['root', 'parent', 'leaf-a']);

const first = setLearningCompletion(initial, target(getProjectCompletionTarget(initial, leafA.id)), true, NOW);
assert.equal(getScheduledProjectState(first, leafA.id).completed, true);
assert.equal(getScheduledProjectState(first, parent.id).completed, false);
assert.equal(first.find((item) => item.id === leafA.id)!.dueDates[0].completedAt, NOW);
assert.match(first.find((item) => item.id === leafA.id)!.content, /^- \[x\]/);
assert.equal(first.find((item) => item.id === unrelated.id), unrelated, 'unrelated note identity is preserved');
assert.equal(setLearningCompletion(first, target(getProjectCompletionTarget(first, leafA.id)), true, NOW), first,
  'setting the same explicit state is idempotent');
assert.deepEqual(initial, snapshot, 'input notes are never mutated');

const both = setLearningCompletion(first, target(getProjectCompletionTarget(first, leafB.id)), true, NOW);
assert.equal(getScheduledProjectState(both, parent.id).completed, true);
assert.equal(both.find((item) => item.id === parent.id)!.dueDates[0].completed, true);
assert.equal(both.find((item) => item.id === root.id)!.planMeta!.status, 'completed');
assert.deepEqual(both.find((item) => item.id === root.id)!.planMeta!.milestones, root.planMeta.milestones,
  'leaf completion makes milestone acceptance ready, never accepted automatically');
const undone = setLearningCompletion(both, target(getProjectCompletionTarget(first, leafA.id)), false, NOW);
assert.equal(getScheduledProjectState(undone, parent.id).completed, false);
assert.equal(undone.find((item) => item.id === root.id)!.planMeta!.status, 'active');
assert.equal(getScheduledProjectState(undone, leafB.id).completed, true,
  'undo re-evaluates latest siblings without reverting another completed leaf');
assert.match(undone.find((item) => item.id === leafA.id)!.content, /^- \[ \]/);
assert.equal(undone.find((item) => item.id === leafA.id)!.dueDates[0].completedAt, undefined);
for (const id of [root.id, parent.id, leafA.id, leafB.id]) {
  const before = initial.find((item) => item.id === id)!;
  const after = both.find((item) => item.id === id)!;
  assert.equal(after.dueDates[0].startDate, before.dueDates[0].startDate);
  assert.equal(after.dueDates[0].dueDate, before.dueDates[0].dueDate);
  assert.deepEqual(after.resources, before.resources);
  assert.deepEqual(after.tags, before.tags);
}

const unscheduledContainer = note('container', parent.id);
const deepLeaf = note('deep-leaf', unscheduledContainer.id, true);
assert.equal(getProjectCompletionTarget([parent, unscheduledContainer, deepLeaf], parent.id), null,
  'scheduled descendants below an ordinary container still make their ancestor a parent');
assert.deepEqual(target(getProjectCompletionTarget([parent, unscheduledContainer, deepLeaf], deepLeaf.id)).path,
  ['parent', 'container', 'deep-leaf']);

const staleProject = target(getProjectCompletionTarget(initial, leafA.id));
assert.throws(() => setLearningCompletion(initial.filter((item) => item.id !== leafA.id), staleProject, true, NOW), /移除|调整/);
assert.throws(() => setLearningCompletion(initial.map((item) => item.id === leafA.id ? { ...item, dueDates: [] } : item),
  staleProject, true, NOW), /移除|调整/);
assert.throws(() => setLearningCompletion([...initial, note('new-child', leafA.id, true)], staleProject, true, NOW), /末级/);

const daily = execution('daily', { frequency: 'daily', endDate: '2026-10-09' });
const oneOff = { ...execution('one-off'), recurrence: undefined, completedOccurrenceDates: undefined };
const taskRoot = {
  ...root,
  content: `${root.content}\n${formatPlanTaskLine(daily.taskText, daily.dueDate, daily.id)}\n${formatPlanTaskLine(oneOff.taskText, oneOff.dueDate, oneOff.id)}`,
  dueDates: [...root.dueDates, daily, oneOff],
};
const taskNotes = [taskRoot, leafA, unrelated];
const todayBinding = { noteId: root.id, taskId: daily.id, occurrenceDate: '2026-10-06' };
const todayTarget = target(getLearningCompletionTarget(taskNotes, todayBinding));
assert.equal(todayTarget.kind, 'execution');
assert.deepEqual(todayTarget.path, ['root']);
assert.equal(todayTarget.completed, false);
const localNow = new Date();
const localToday = `${localNow.getFullYear()}-${String(localNow.getMonth() + 1).padStart(2, '0')}-${String(localNow.getDate()).padStart(2, '0')}`;
const openDaily = { ...daily, startDate: '2020-01-01', dueDate: '2099-12-31', recurrence: { frequency: 'daily' as const } };
const normalizedTarget = target(getLearningCompletionTarget([{ ...root, dueDates: [openDaily] }], { noteId: root.id, taskId: daily.id }));
assert.equal(normalizedTarget.binding.occurrenceDate, localToday, 'launch freezes a local occurrence date rather than leaving an implicit tomorrow');
const doneDaily = setLearningCompletion(taskNotes, todayTarget, true, NOW);
const doneTask = doneDaily[0].dueDates.find((item) => item.id === daily.id)!;
assert.deepEqual(doneTask.completedOccurrenceDates, ['2026-10-05', '2026-10-06']);
assert.equal(doneTask.completed, daily.completed, 'a recurrence rule is not itself marked completed');
assert.equal(doneTask.completedAt, daily.completedAt, 'only the bound occurrence list changes');
assert.equal(doneDaily[0].content, taskRoot.content, 'a recurring rule never gets a permanent checked body line');
assert.equal(doneDaily[0].dueDates.find((item) => item.id === oneOff.id), oneOff, 'other tasks stay untouched');
assert.equal(doneDaily[1], leafA, 'a linked project is not automatically completed by an execution occurrence');
assert.equal(doneDaily[2], unrelated);
assert.equal(target(getLearningCompletionTarget(doneDaily, { ...todayBinding, occurrenceDate: TOMORROW })).completed, false,
  'tomorrow remains a new pending occurrence');
assert.equal(setLearningCompletion(doneDaily, todayTarget, true, NOW), doneDaily);
const dailyUndone = setLearningCompletion(doneDaily, todayTarget, false, NOW);
assert.deepEqual(dailyUndone[0].dueDates.find((item) => item.id === daily.id)!.completedOccurrenceDates, ['2026-10-05']);
const tomorrowTarget = target(getLearningCompletionTarget(taskNotes, { ...todayBinding, occurrenceDate: TOMORROW }));
assert.throws(() => setLearningCompletion(taskNotes, tomorrowTarget, true, NOW), /尚未到/,
  'future occurrences may be displayed but cannot be acknowledged in advance');
const originalTimeZone = process.env.TZ;
try {
  process.env.TZ = 'Asia/Shanghai';
  const localMidnightDone = setLearningCompletion(taskNotes, tomorrowTarget, true, '2026-10-06T16:30:00.000Z');
  assert.ok(localMidnightDone[0].dueDates.find((item) => item.id === daily.id)!.completedOccurrenceDates!.includes(TOMORROW),
    'after local midnight, completing October 7 is valid although the UTC timestamp still says October 6');
  const crossedMidnight = setLearningCompletion(taskNotes, todayTarget, true, '2026-10-06T16:30:00.000Z');
  assert.deepEqual(crossedMidnight[0].dueDates.find((item) => item.id === daily.id)!.completedOccurrenceDates,
    ['2026-10-05', '2026-10-06'], 'a session crossing midnight completes only its frozen October 6 occurrence');
} finally {
  if (originalTimeZone === undefined) delete process.env.TZ;
  else process.env.TZ = originalTimeZone;
}
assert.equal(getLearningCompletionTarget(taskNotes, { ...todayBinding, occurrenceDate: '2026-10-10' }), null, 'recurrence end is inclusive');
assert.equal(getLearningCompletionTarget(taskNotes, { ...todayBinding, occurrenceDate: '2026-09-30' }), null, 'cannot complete a pre-start occurrence');
assert.equal(getLearningCompletionTarget(taskNotes, { ...todayBinding, occurrenceDate: '2026-02-30' }), null, 'invalid calendar dates are rejected');

const oneOffTarget = target(getLearningCompletionTarget(taskNotes, { noteId: root.id, taskId: oneOff.id }));
const doneOneOff = setLearningCompletion(taskNotes, oneOffTarget, true, NOW);
assert.equal(doneOneOff[0].dueDates.find((item) => item.id === oneOff.id)!.completed, true);
assert.equal(doneOneOff[0].dueDates.find((item) => item.id === oneOff.id)!.completedAt, NOW);
const bodyLines = doneOneOff[0].content.split('\n');
assert.match(bodyLines[1], /^- \[ \]/, 'same title and date do not allow updating another task anchor');
assert.match(bodyLines[2], /^- \[x\]/, 'only the matching task anchor is synchronized');
assert.equal(setLearningCompletion(doneOneOff, oneOffTarget, true, NOW), doneOneOff);
const oneOffUndone = setLearningCompletion(doneOneOff, oneOffTarget, false, NOW);
assert.match(oneOffUndone[0].content.split('\n')[2], /^- \[ \]/);
assert.equal(oneOffUndone[0].dueDates.find((item) => item.id === oneOff.id)!.completedAt, undefined);

const legacy = { ...oneOff, id: 'due-root-2' };
const legacyRoot = { ...taskRoot, dueDates: [daily, legacy], content: `unrelated\n${formatPlanTaskLine(daily.taskText, daily.dueDate, daily.id)}\n- [ ] ${legacy.taskText} @due(${legacy.dueDate})` };
const legacyDone = setLearningCompletion([legacyRoot], target(getLearningCompletionTarget([legacyRoot], { noteId: root.id, taskId: legacy.id })), true, NOW);
assert.match(legacyDone[0].content.split('\n')[2], /^- \[x\]/, 'legacy exact line IDs remain supported');
assert.match(legacyDone[0].content.split('\n')[1], /^- \[ \]/);

const removedTask = taskNotes.map((item) => item.id === root.id
  ? { ...item, dueDates: item.dueDates.filter((task) => task.id !== daily.id) } : item);
assert.throws(() => setLearningCompletion(removedTask, todayTarget, true, NOW), /移除|调整/);
const rescheduledTask = taskNotes.map((item) => item.id === root.id
  ? { ...item, dueDates: item.dueDates.map((task) => task.id === daily.id ? { ...task, recurrence: { frequency: 'custom' as const, weekdays: [1] } } : task) } : item);
assert.throws(() => setLearningCompletion(rescheduledTask, todayTarget, true, NOW), /移除|调整/,
  'an occurrence invalidated by a changed recurrence cannot be marked from an old session');
assert.throws(() => setLearningCompletion(taskNotes, { ...todayTarget, kind: 'project' }, true, NOW), /移除|调整/);

for (const [recurrence, valid, invalid] of [
  [{ frequency: 'daily', interval: 2 }, '2026-10-05', '2026-10-06'],
  [{ frequency: 'weekdays' }, '2026-10-06', '2026-10-04'],
  [{ frequency: 'weekly', weekdays: [2] }, '2026-10-06', '2026-10-05'],
  [{ frequency: 'custom', interval: 2, weekdays: [2, 4] }, '2026-10-06', '2026-10-08'],
] as Array<[DueDateItem['recurrence'], string, string]>) {
  const ruleTask = execution('rule', recurrence);
  const notes = [{ ...root, dueDates: [ruleTask] }];
  assert.ok(getLearningCompletionTarget(notes, { noteId: root.id, taskId: ruleTask.id, occurrenceDate: valid }));
  assert.equal(getLearningCompletionTarget(notes, { noteId: root.id, taskId: ruleTask.id, occurrenceDate: invalid }), null);
}

assert.deepEqual(initial, snapshot, 'all checks use immutable in-memory fixtures, not the user vault');
console.log('Learning completion checks passed: explicit leaf/project binding, occurrence isolation, roll-up/undo, stale targets and content preservation.');
