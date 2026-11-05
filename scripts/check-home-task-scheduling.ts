import assert from 'node:assert/strict';
import type { DueDateItem, NoteItem, PlanRecurrenceRule, UserProfile } from '../src/types';
import type { MasteryTimelineFile } from '../src/services/learningAbility/types';
import { buildHomeFocusProject, buildHomeViewModel, collectTodos } from '../src/services/homepage/homepageViewModel';
import { buildHomeScheduledTasks, homeCalendarDay, nextHomeTaskOccurrence } from '../src/services/homepage/homeTaskScheduling';
import { getLearningCompletionTarget, setLearningCompletion } from '../src/services/learningCompletion';

// All data below is synthetic. These functions have no storage/model/browser APIs.
const TODAY = '2026-10-07';
const TOMORROW = '2026-10-08';
function note(id: string, parentId?: string, noteType: NoteItem['noteType'] = 'project'): NoteItem {
  return { id, parentId, noteType, title: id, content: '', dueDates: [], tags: [], links: [], backlinks: [],
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
}
function deadline(owner: NoteItem, startDate: string, dueDate: string, completed = false): DueDateItem {
  return { id: `${owner.id}-deadline`, noteId: owner.id, noteTitle: owner.title, taskText: owner.title,
    startDate, dueDate, completed, priority: 'medium' };
}
function task(owner: NoteItem, id = 'execution', patch: Partial<DueDateItem> = {}): DueDateItem {
  return { id, noteId: owner.id, noteTitle: owner.title, taskText: `${id} synthetic work`,
    startDate: '2026-10-01', dueDate: '2026-10-31', completed: false, priority: 'medium',
    executionKind: 'flow', ...patch };
}
function recurring(owner: NoteItem, rule: PlanRecurrenceRule, patch: Partial<DueDateItem> = {}): DueDateItem {
  return task(owner, 'recurring', { recurrence: rule, ...patch });
}
const root = note('root');
root.planMeta = { schemaVersion: 2, status: 'active' };
root.dueDates = [deadline(root, '2026-10-01', '2026-10-31')];
const parent = note('parent', root.id);
parent.dueDates = [deadline(parent, '2026-10-01', '2026-10-02')];
const leaf = note('leaf', parent.id);
leaf.dueDates = [deadline(leaf, '2026-10-02', '2026-10-06')];
const completedLeaf = note('completed-leaf', parent.id);
completedLeaf.dueDates = [deadline(completedLeaf, '2026-10-01', '2026-10-03', true)];
const ordinary = note('ordinary', root.id);
const knowledge = note('knowledge', leaf.id, 'knowledge');
const hierarchy = [root, parent, leaf, completedLeaf, ordinary, knowledge];
const before = JSON.stringify(hierarchy);
const structureFocus = buildHomeFocusProject(hierarchy, TODAY)!;
assert.equal(structureFocus.nextNoteId, leaf.id);
assert.equal(structureFocus.nextTaskId, leaf.dueDates[0].id);
assert.deepEqual(structureFocus.nextLaunch, { noteId: leaf.id, mode: 'flow', actionDate: TODAY, binding: { noteId: leaf.id } });
assert.equal(structureFocus.totalTasks, 2, 'root and parent deadlines do not duplicate leaf progress');
assert.equal(structureFocus.completedTasks, 1);
assert.equal(structureFocus.progress, 50);
assert.equal(structureFocus.nearestDueDate, '2026-10-06', 'overdue work retains its real deadline');
assert.equal(structureFocus.nextActionDate, TODAY, 'unfinished structure work rolls only its actionable date forward');
assert.deepEqual(collectTodos(hierarchy, TODAY).map(item => item.noteId), [leaf.id]);
assert.equal(collectTodos(hierarchy, TOMORROW)[0].actionDate, TOMORROW);
assert.equal(JSON.stringify(hierarchy), before, 'calendar aggregation never reschedules or mutates notes');
assert.equal(buildHomeFocusProject([note('ordinary-root')], TODAY), null);
const bareRoot = note('bare-root'); bareRoot.dueDates = [deadline(bareRoot, TODAY, TOMORROW)];
assert.equal(buildHomeFocusProject([bareRoot], TODAY), null, 'a root-only deadline is not a leaf learning recommendation');

const container = note('ordinary-container', parent.id);
const deepLeaf = note('deep-leaf', container.id); deepLeaf.dueDates = [deadline(deepLeaf, TODAY, TOMORROW)];
assert.deepEqual(buildHomeScheduledTasks([root, parent, container, deepLeaf], TODAY).filter(row => row.structural).map(row => row.ownerNoteId), [deepLeaf.id], 'scheduled descendants below ordinary containers still suppress parent deadlines');
const malformedLeaf = { ...leaf, dueDates: [deadline(leaf, '2026-02-30', '2026-10-06')] };
assert.ok(!buildHomeScheduledTasks([root, parent, malformedLeaf], TODAY).some(row => row.ownerNoteId === malformedLeaf.id));
assert.deepEqual(buildHomeScheduledTasks(hierarchy, '2026-02-30'), []);
assert.equal(buildHomeFocusProject(hierarchy, 'not-a-date'), null);
assert.equal(homeCalendarDay('2026-02-30'), null);
assert.equal(homeCalendarDay('2028-02-29') !== null, true);

const daily = recurring(root, { frequency: 'daily', endDate: '2026-10-10' });
const dailyNotes = [{ ...root, dueDates: [root.dueDates[0], daily] }];
const dailyFocus = buildHomeFocusProject(dailyNotes, TODAY)!;
assert.deepEqual(dailyFocus.nextLaunch, { noteId: root.id, mode: 'flow', actionDate: TODAY,
  binding: { noteId: root.id, taskId: daily.id, occurrenceDate: TODAY } });
assert.equal(dailyFocus.totalTasks, 1, 'a rule contributes only its current valid occurrence, never every historical date');
assert.equal(collectTodos(dailyNotes, TODAY)[0].date, TODAY);
const doneTarget = getLearningCompletionTarget(dailyNotes, dailyFocus.nextLaunch!.binding)!;
const dailyDone = setLearningCompletion(dailyNotes, doneTarget, true, TODAY);
const doneFocus = buildHomeFocusProject(dailyDone, TODAY)!;
assert.equal(doneFocus.completedTasks, 1);
assert.equal(doneFocus.progress, 100, 'today can be complete without permanently completing a recurring rule');
assert.equal(doneFocus.nearestDueDate, TOMORROW);
assert.equal(doneFocus.nextLaunch!.binding.occurrenceDate, TOMORROW, 'today completion advances the preview to the next valid day');
assert.equal(collectTodos(dailyDone, TODAY)[0].date, TOMORROW);
const tomorrowFocus = buildHomeFocusProject(dailyDone, TOMORROW)!;
assert.equal(tomorrowFocus.progress, 0);
assert.equal(tomorrowFocus.nextLaunch!.binding.occurrenceDate, TOMORROW, 'tomorrow becomes actionable again');
assert.equal(dailyDone[0].dueDates[1].completed, false, 'rule checkbox is not rewritten by the occurrence completion');
const misleadingLegacyComplete = [{ ...root, dueDates: [{ ...daily, completed: true }] }];
assert.equal(buildHomeFocusProject(misleadingLegacyComplete, TODAY)!.completedTasks, 0, 'legacy completed is never applied to every occurrence');
assert.equal(buildHomeFocusProject(misleadingLegacyComplete, TODAY)!.nextLaunch!.binding.occurrenceDate, TODAY);

const frequencies: { rule: PlanRecurrenceRule; start: string; at: string; expected: string }[] = [
  { rule: { frequency: 'daily', interval: 3 }, start: '2026-10-01', at: '2026-10-08', expected: '2026-10-10' },
  { rule: { frequency: 'weekdays' }, start: '2026-10-02', at: '2026-10-03', expected: '2026-10-05' },
  { rule: { frequency: 'weekdays', interval: 2 }, start: '2026-10-01', at: '2026-10-08', expected: '2026-10-15' },
  { rule: { frequency: 'weekly' }, start: '2026-10-01', at: '2026-10-07', expected: '2026-10-08' },
  { rule: { frequency: 'weekly', interval: 2, weekdays: [5] }, start: '2026-10-01', at: '2026-10-03', expected: '2026-10-16' },
  { rule: { frequency: 'custom', weekdays: [0, 3] }, start: '2026-10-01', at: '2026-10-07', expected: '2026-10-07' },
  { rule: { frequency: 'custom', weekdays: [0, 3], interval: 2 }, start: '2026-10-01', at: '2026-10-08', expected: '2026-10-18' },
  { rule: { frequency: 'custom', weekdays: [] }, start: '2026-10-01', at: '2026-10-07', expected: '2026-10-08' },
];
for (const sample of frequencies) {
  const item = recurring(root, sample.rule, { startDate: sample.start });
  assert.equal(nextHomeTaskOccurrence(item, sample.at), sample.expected);
  const rows = buildHomeScheduledTasks([{ ...root, dueDates: [item] }], sample.at);
  assert.equal(rows[0].launch!.binding.occurrenceDate, sample.expected);
  assert.ok(getLearningCompletionTarget([{ ...root, dueDates: [item] }], rows[0].launch!.binding), 'home-produced occurrence is admitted by the actual completion calendar');
  if (sample.expected !== sample.at) assert.equal(rows[0].progressEligible, false);
}
// Check the optimized next-date calculation against the real completion calendar,
// including non-Monday anchors, leap day and month/year boundaries.
for (const start of ['2026-12-26', '2028-02-27']) {
  for (const frequency of ['daily', 'weekdays', 'weekly', 'custom'] as const) {
    for (const interval of [1, 2, 3]) {
      const item = recurring(root, { frequency, interval, weekdays: [0, 2, 5] }, { startDate: start, dueDate: '2028-12-31' });
      const notes = [{ ...root, dueDates: [item] }];
      for (let offset = 0; offset < 24; offset += 1) {
        const at = new Date((homeCalendarDay(start)! + offset) * 86_400_000).toISOString().slice(0, 10);
        let expected: string | null = null;
        for (let candidateOffset = 0; candidateOffset < 29; candidateOffset += 1) {
          const candidate = new Date((homeCalendarDay(at)! + candidateOffset) * 86_400_000).toISOString().slice(0, 10);
          if (getLearningCompletionTarget(notes, { noteId: root.id, taskId: item.id, occurrenceDate: candidate })) { expected = candidate; break; }
        }
        assert.equal(nextHomeTaskOccurrence(item, at), expected, 'home next-date math matches the admitted calendar rather than a separate approximation');
      }
    }
  }
}
for (const rule of [
  { frequency: 'daily', interval: 0 }, { frequency: 'weekly', interval: 1.5 },
  { frequency: 'weekdays', weekdays: [7] }, { frequency: 'custom', weekdays: [-1] },
  { frequency: 'daily', endDate: '2026-02-30' }, { frequency: 'daily', endDate: '2026-09-30' },
  { frequency: 'unknown' },
] as PlanRecurrenceRule[]) {
  assert.equal(nextHomeTaskOccurrence(recurring(root, rule), TODAY), null);
  assert.deepEqual(buildHomeScheduledTasks([{ ...root, dueDates: [recurring(root, rule)] }], TODAY), []);
}
const lastDay = recurring(root, { frequency: 'daily', endDate: TODAY });
assert.equal(nextHomeTaskOccurrence(lastDay, TODAY), TODAY, 'recurrence end is inclusive');
assert.equal(nextHomeTaskOccurrence(lastDay, TOMORROW), null);
const lastDayDone = [{ ...root, dueDates: [{ ...lastDay, completedOccurrenceDates: [TODAY] }] }];
assert.equal(buildHomeFocusProject(lastDayDone, TODAY)!.completedTasks, 1);
assert.equal(buildHomeFocusProject(lastDayDone, TODAY)!.nextLaunch, null);
assert.equal(buildHomeFocusProject(lastDayDone, TOMORROW)!.totalTasks, 0, 'expired rules do not become forever-unfinished work');
const futureRule = recurring(root, { frequency: 'daily' }, { startDate: '2026-10-10' });
assert.equal(buildHomeFocusProject([{ ...root, dueDates: [futureRule] }], TODAY)!.nextLaunch!.actionDate, '2026-10-10');
assert.equal(buildHomeFocusProject([{ ...root, dueDates: [futureRule] }], TODAY)!.totalTasks, 0);
const skippedCompletedDates = { ...daily, completedOccurrenceDates: [TODAY, TOMORROW, '2026-10-09'] };
assert.equal(buildHomeFocusProject([{ ...root, dueDates: [skippedCompletedDates] }], TODAY)!.nextLaunch!.binding.occurrenceDate, '2026-10-10');
for (const patch of [{ dueDate: '2026-02-30' }, { startDate: '2026-02-30' }, { startDate: '2026-11-01', dueDate: TODAY }]) {
  assert.deepEqual(buildHomeScheduledTasks([{ ...root, dueDates: [task(root, 'malformed-one-off', patch)] }], TODAY), []);
}
assert.equal(nextHomeTaskOccurrence(recurring(root, { frequency: 'daily', interval: 10 ** 15 }), TODAY), null, 'oversized intervals settle safely without a calendar scan or Date range error');

// A same-root linked project is only the learning object; completion is still the rule owner.
const linkedExecution = task(root, 'linked', { linkedProjectId: parent.id, executionKind: 'practice', launchMode: 'flow', dueDate: '2026-10-05' });
const linkedNotes = [{ ...root, dueDates: [linkedExecution] }, parent, leaf];
const linkedFocus = buildHomeFocusProject(linkedNotes, TODAY)!;
assert.equal(linkedFocus.nextLaunch!.noteId, parent.id);
assert.equal(linkedFocus.nextLaunch!.mode, 'flow', 'explicit launchMode wins over executionKind');
assert.deepEqual(linkedFocus.nextLaunch!.binding, { noteId: root.id, taskId: linkedExecution.id });
const linkedDone = setLearningCompletion(linkedNotes, getLearningCompletionTarget(linkedNotes, linkedFocus.nextLaunch!.binding)!, true, TODAY);
assert.equal(linkedDone[0].dueDates[0].completed, true);
assert.equal(linkedDone.find(item => item.id === parent.id)!.dueDates[0].completed, false);
assert.equal(linkedDone.find(item => item.id === leaf.id)!.dueDates[0].completed, false, 'studying a parent as an execution object cannot complete the parent or its leaves');
const otherRoot = note('other-root'); const otherLeaf = note('other-leaf', otherRoot.id);
for (const linkedProjectId of [otherRoot.id, otherLeaf.id, knowledge.id, 'missing']) {
  const notes = [{ ...root, dueDates: [{ ...linkedExecution, linkedProjectId }] }, parent, leaf, knowledge, otherRoot, otherLeaf];
  const executionRow = buildHomeScheduledTasks(notes, TODAY).find(row => row.taskId === linkedExecution.id)!;
  assert.equal(executionRow.launch!.noteId, root.id, 'foreign/knowledge/missing linked IDs do not expand scope');
  assert.deepEqual(executionRow.launch!.binding, { noteId: root.id, taskId: linkedExecution.id });
}
for (const [executionKind, mode] of [['flow', 'flow'], ['practice', 'scene'], ['review', 'review'], ['todo', 'none']] as const) {
  const item = task(root, executionKind, { executionKind });
  assert.equal(buildHomeScheduledTasks([{ ...root, dueDates: [item] }], TODAY)[0].launch!.mode, mode);
}
assert.equal(buildHomeScheduledTasks([{ ...root, dueDates: [task(root, 'manual', { launchMode: 'none' })] }], TODAY)[0].launch!.mode, 'none');
for (const status of ['paused', 'draft', 'archived', 'completed'] as const) {
  const inactive = { ...root, planMeta: { schemaVersion: 2 as const, status }, dueDates: [daily] };
  assert.equal(buildHomeScheduledTasks([inactive], TODAY)[0].launch, null, 'stale click revalidation cannot start an inactive root');
  assert.deepEqual(collectTodos([inactive], TODAY), []);
  assert.equal(buildHomeFocusProject([inactive], TODAY)?.nextLaunch || null, null);
}
const futureLeaf = { ...leaf, dueDates: [deadline(leaf, '2026-10-10', '2026-10-12')] };
const startedTask = task(root, 'started', { startDate: '2026-10-02', dueDate: '2026-10-20' });
assert.equal(buildHomeFocusProject([{ ...root, dueDates: [startedTask] }, parent, futureLeaf], TODAY)!.nextTaskId, startedTask.id, 'future structural work does not displace something already actionable');
const duplicateTask = task(root, 'duplicate');
assert.deepEqual(buildHomeScheduledTasks([{ ...root, dueDates: [duplicateTask, duplicateTask] }], TODAY), [], 'duplicate task IDs have no unambiguous completion authority');
const cyclicA = note('cycle-a', 'cycle-b'), cyclicB = note('cycle-b', 'cycle-a');
cyclicA.dueDates = [task(cyclicA)];
assert.deepEqual(buildHomeScheduledTasks([cyclicA, cyclicB], TODAY), [], 'cyclic hierarchy terminates without inventing a root');

const profile = { learningAbility: {}, ability: { conceptClarity: 0, judgmentReasonableness: 0, reasoningValidity: 0 },
  cognitiveStyle: { abstractVsConcrete: 0, systematicVsScattered: 0, divergentVsConvergent: 0, cautiousVsDogmatic: 0, deepVsSurface: 0 } } as unknown as UserProfile;
const timeline = { weeks: [] } as unknown as MasteryTimelineFile;
const aggregate = buildHomeViewModel(dailyDone, profile, timeline, TODAY);
assert.equal(aggregate.calYear, 2026); assert.equal(aggregate.calMonth, 10);
assert.equal(aggregate.calendar.find(day => day.isToday)!.day, 7);
assert.equal(aggregate.focusProject!.nextLaunch!.binding.occurrenceDate, aggregate.todos[0].launch.binding.occurrenceDate);
assert.equal(aggregate.completedProjects, 0, 'today’s 100% recurring progress is not a permanently completed project');
const allLeavesDone = hierarchy.map(item => item.id === leaf.id ? { ...item, dueDates: [{ ...item.dueDates[0], completed: true }] } : item);
assert.equal(buildHomeViewModel(allLeavesDone, profile, timeline, TODAY).completedProjects, 1, 'completed leaf work is not blocked by stale ancestor deadline flags');
assert.throws(() => buildHomeViewModel(hierarchy, profile, timeline, '2026-02-30'), /日历日期无效/);
console.log('Home task scheduling passed: scheduled leaves, valid calendar frequencies, interval weeks, ends, malformed dates, current occurrence completion/renewal, scoped learning objects, exact task binding, inactive roots, shared todos/progress, and immutable data. No storage or model access.');
