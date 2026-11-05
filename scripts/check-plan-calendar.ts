import assert from 'node:assert/strict';
import type { DueDateItem, NoteItem } from '../src/types';
import { buildExecutionAgendaOccurrences, buildPlanWorkspaceModel, PLAN_OVERVIEW_ID } from '../src/services/planViewModel';
import { buildHomeScheduledTasks, nextHomeTaskOccurrence } from '../src/services/homepage/homeTaskScheduling';
import { getLearningCompletionTarget, setLearningCompletion } from '../src/services/learningCompletion';
import { toggleScheduledProjectCompletion } from '../src/services/planProjectState';

// Actual pure calendar/view-model functions; no browser, IO, storage or model calls.
const TODAY = '2026-10-11', MONDAY = '2026-10-05', SUNDAY = '2026-10-11';
function note(id: string, parentId?: string): NoteItem {
  return { id, title: id, parentId, noteType: 'project', content: '', dueDates: [], tags: [], links: [], backlinks: [],
    createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' };
}
function task(owner: NoteItem, id: string, patch: Partial<DueDateItem> = {}): DueDateItem {
  return { id, noteId: owner.id, noteTitle: owner.title, taskText: id, startDate: MONDAY, dueDate: '2026-10-31',
    completed: false, priority: 'medium', estimatedMinutes: 20, kind: 'practice', ...patch };
}
function deadline(owner: NoteItem, startDate: string, dueDate: string, completed = false) {
  return task(owner, `${owner.id}-deadline`, { taskText: owner.title, startDate, dueDate, completed });
}
const root = note('calendar-root');
root.planMeta = { schemaVersion: 2, status: 'active', startDate: MONDAY, targetDate: '2026-10-31', weeklyBudgetMinutes: 300 };
const daily = task(root, 'daily', { recurrence: { frequency: 'daily', endDate: '2026-10-31' }, completedOccurrenceDates: [MONDAY, TODAY] });
const weekdays = task(root, 'weekdays', { recurrence: { frequency: 'weekdays', endDate: '2026-10-31' } });
const weekly = task(root, 'weekly', { recurrence: { frequency: 'weekly', weekdays: [1, 5], endDate: '2026-10-31' } });
const custom = task(root, 'custom', { recurrence: { frequency: 'custom', weekdays: [0, 3], interval: 2, endDate: '2026-10-31' } });
const interval = task(root, 'interval', { recurrence: { frequency: 'daily', interval: 3, endDate: '2026-10-31' } });
const partial = task(root, 'partial', { startDate: '2026-10-09', recurrence: { frequency: 'daily', endDate: '2026-10-13' } });
const expired = task(root, 'expired', { recurrence: { frequency: 'daily', endDate: '2026-10-04' } });
const overdue = task(root, 'overdue', { startDate: '2026-10-08', dueDate: '2026-10-09', estimatedMinutes: 15 });
root.dueDates = [daily, weekdays, weekly, custom, interval, partial, expired, overdue];
const before = JSON.stringify(root);
const week = buildExecutionAgendaOccurrences(root.dueDates, MONDAY, SUNDAY, TODAY);
const dates = (id: string) => week.filter(item => item.id === id).map(item => item.occurrenceDate);
assert.equal(dates('daily').length, 7);
assert.deepEqual(week.filter(item => item.id === 'daily' && item.completed).map(item => item.occurrenceDate), [MONDAY, TODAY]);
assert.deepEqual(dates('weekdays'), ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09']);
assert.deepEqual(dates('weekly'), ['2026-10-05', '2026-10-09']);
assert.deepEqual(dates('custom'), ['2026-10-07', '2026-10-11']);
assert.deepEqual(dates('interval'), ['2026-10-05', '2026-10-08', '2026-10-11']);
assert.deepEqual(dates('partial'), ['2026-10-09', '2026-10-10', '2026-10-11']);
assert.deepEqual(dates('expired'), []);
assert.deepEqual(dates('overdue'), [TODAY]);
assert.equal(week.find(item => item.id === 'overdue')?.dueDate, '2026-10-09', 'rolling actionable days never reschedules a deadline');
const nextWeek = buildExecutionAgendaOccurrences(root.dueDates, '2026-10-12', '2026-10-18', TODAY);
assert.equal(nextWeek.filter(item => item.id === 'daily').length, 7, 'future weeks expand independently of today');
assert.equal(nextWeek.filter(item => item.id === 'custom').length, 0, 'interval weeks do not invent custom occurrences');
assert.deepEqual(nextWeek.filter(item => item.id === 'partial').map(item => item.occurrenceDate), ['2026-10-12', '2026-10-13']);
assert.equal(nextWeek.some(item => item.id === 'overdue'), false, 'overdue one-off does not duplicate into future weeks');
const completedOnce = { ...overdue, completed: true, completedAt: new Date(2026, 9, 8, 0, 15).toISOString() };
assert.equal(buildExecutionAgendaOccurrences([completedOnce], MONDAY, SUNDAY, TODAY)[0].occurrenceDate, '2026-10-08');
assert.deepEqual(buildExecutionAgendaOccurrences([daily], '2026-02-30', SUNDAY, TODAY), []);
assert.deepEqual(buildExecutionAgendaOccurrences([daily], SUNDAY, MONDAY, TODAY), []);
assert.deepEqual(buildExecutionAgendaOccurrences([daily], MONDAY, '2026-10-31', TODAY), [], 'this helper accepts bounded seven-day agendas only');
for (const malformed of [
  { ...daily, startDate: '2026-02-30' }, { ...daily, dueDate: '2026-02-30' },
  { ...daily, recurrence: { frequency: 'daily' as const, interval: 0 } },
  { ...daily, recurrence: { frequency: 'custom' as const, weekdays: [7] } },
]) assert.deepEqual(buildExecutionAgendaOccurrences([malformed], MONDAY, SUNDAY, TODAY), []);
assert.deepEqual(buildExecutionAgendaOccurrences([daily, { ...daily }], MONDAY, SUNDAY, TODAY), [], 'ambiguous task identities cannot create duplicate checks');
assert.equal(JSON.stringify(root), before, 'aggregation never mutates rules or completion dates');
const malformedWeekdays = { ...daily, recurrence: { frequency: 'custom', weekdays: 'Monday' } } as unknown as DueDateItem;
const malformedModel = buildPlanWorkspaceModel([{ ...root, dueDates: [malformedWeekdays] }], root.id, TODAY);
assert.equal(malformedModel.tasks.length, 0, 'malformed stored weekdays do not crash the workspace');

const scheduled = buildPlanWorkspaceModel([root], root.id, TODAY);
const summaryWork = buildHomeScheduledTasks([root], TODAY).filter(item => item.progressEligible);
assert.equal(scheduled.selectedPlan?.taskCount, summaryWork.length, 'home and plan use the same valid daily progress scope');
assert.equal(scheduled.selectedPlan?.completedTaskCount, summaryWork.filter(item => item.completed).length);
assert.equal(scheduled.selectedPlan?.currentWeekMinutes, 455, 'week load counts 7+5+2+2+3+3 occurrences and a 15-minute one-off');
assert.equal(scheduled.tasks.find(item => item.id === 'weekdays')?.occurrenceDate, '2026-10-12', 'weekend list points to the next real weekday');
assert.equal(scheduled.tasks.find(item => item.id === 'weekly')?.occurrenceDate, '2026-10-12');
assert.equal(scheduled.tasks.some(item => item.id === 'expired'), false, 'a malformed end before start is not an executable rule');
const ended = { ...daily, id: 'ended', recurrence: { frequency: 'daily' as const, endDate: '2026-10-09' } };
const endedModel = buildPlanWorkspaceModel([{ ...root, dueDates: [ended] }], root.id, TODAY);
assert.equal(endedModel.tasks[0].occurrenceAvailable, false);
assert.equal(endedModel.selectedPlan?.taskCount, 0, 'expired recurring work is not a permanent unfinished task');
assert.equal(buildExecutionAgendaOccurrences(endedModel.tasks, MONDAY, SUNDAY, TODAY).length, 5, 'expired rules retain their actual historical occurrences');
assert.ok(buildExecutionAgendaOccurrences(endedModel.tasks, MONDAY, SUNDAY, TODAY).every(item => item.occurrenceAvailable));
const unlimited = { ...daily, dueDate: MONDAY, recurrence: { frequency: 'daily' as const } };
const unlimitedModel = buildPlanWorkspaceModel([{ ...root, dueDates: [unlimited] }], root.id, TODAY);
assert.ok(unlimitedModel.tasks[0].widthPercent > 80, 'an open-ended rule spans the visible timeline rather than its old first due date');
assert.equal(unlimitedModel.tasks[0].occurrenceDate, TODAY);
for (const occurrence of week.filter(item => item.recurrence)) {
  assert.equal(nextHomeTaskOccurrence(occurrence, occurrence.occurrenceDate), occurrence.occurrenceDate);
  assert.ok(getLearningCompletionTarget([root], { noteId: root.id, taskId: occurrence.id, occurrenceDate: occurrence.occurrenceDate }), 'every displayed occurrence is a real completion target');
}
const dailyTarget = getLearningCompletionTarget([root], { noteId: root.id, taskId: daily.id, occurrenceDate: TODAY })!;
const undone = setLearningCompletion([root], dailyTarget, false, TODAY);
const undoneWeek = buildExecutionAgendaOccurrences(undone[0].dueDates, MONDAY, SUNDAY, TODAY);
assert.equal(undoneWeek.find(item => item.id === daily.id && item.occurrenceDate === TODAY)?.completed, false);
assert.equal(undoneWeek.find(item => item.id === daily.id && item.occurrenceDate === MONDAY)?.completed, true, 'undo one date preserves another date');

const phaseA = note('phase-overdue', root.id), phaseB = note('phase-current', root.id);
phaseA.dueDates = [deadline(phaseA, MONDAY, '2026-10-09', true)];
phaseB.dueDates = [deadline(phaseB, '2026-10-10', '2026-10-20'), task(phaseB, 'practice-complete', { completed: true })];
const leafA = note('leaf-overdue', phaseA.id), leafB = note('leaf-current', phaseB.id);
leafA.dueDates = [deadline(leafA, MONDAY, '2026-10-09')];
leafB.dueDates = [deadline(leafB, '2026-10-10', '2026-10-20')];
const phaseNotes = [{ ...root, dueDates: [] }, phaseA, phaseB, leafA, leafB];
const phaseModel = buildPlanWorkspaceModel(phaseNotes, root.id, TODAY);
assert.equal(phaseModel.currentPhase?.projectId, phaseA.id, 'unfinished overdue leaves must not disappear behind an overlapping stage');
assert.equal(phaseModel.phases.find(item => item.projectId === phaseA.id)?.completed, false, 'stale parent checkbox is not stage completion');
assert.equal(phaseModel.phases.find(item => item.projectId === phaseB.id)?.progress, 50, 'completing execution alone cannot make an unfinished structural phase 100%');
const progressed = toggleScheduledProjectCompletion(phaseNotes, leafA.id, TODAY);
assert.equal(buildPlanWorkspaceModel(progressed, root.id, TODAY).currentPhase?.projectId, phaseB.id, 'completed stage yields to the remaining stage');
const rounded = progressed.map(item => item.id === phaseB.id ? { ...item, dueDates: [item.dueDates[0], ...Array.from({ length: 200 }, (_, index) => task(item, `finished-${index}`, { completed: true }))] } : item);
const roundedPhase = buildPlanWorkspaceModel(rounded, root.id, TODAY).currentPhase!;
assert.equal(roundedPhase.progress, 100);
assert.equal(roundedPhase.completed, false, 'rounded progress is not proof that every task has completed');
const otherRoot = { ...root, id: 'other-root', title: 'other-root', dueDates: [], planMeta: { ...root.planMeta!, weeklyBudgetMinutes: 100 } };
const otherLeaf = { ...leafB, id: 'other-leaf', parentId: otherRoot.id, dueDates: [deadline({ ...leafB, id: 'other-leaf' }, MONDAY, '2026-10-20')] };
const overview = buildPlanWorkspaceModel([...progressed, otherRoot, otherLeaf], PLAN_OVERVIEW_ID, TODAY);
assert.equal(overview.currentPhases.length, 2);
assert.equal(overview.currentPhases.find(item => item.rootId === root.id)?.projectId, phaseB.id);
assert.equal(overview.selectedPlan?.taskCount, overview.plans.reduce((sum, item) => sum + item.taskCount, 0));
assert.equal(JSON.stringify(root), before);
console.log('PASS plan calendar: actual weekly recurrence expansion, local history, precise completion dates, scope/load consistency, valid next occurrences and unfinished stage selection; pure synthetic data only.');
