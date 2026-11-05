import assert from 'node:assert/strict';
import type { PlanNode } from '../src/types';
import { assessPlanConditions } from '../src/services/planConditionService';

const overloaded: PlanNode[] = [{
  key: 'phase', title: '阶段', children: [], tasks: [
    { key: 'learn', text: '学习', kind: 'learn', dueDate: '2026-10-06', estimatedMinutes: 400 },
    { key: 'practice', text: '练习', kind: 'practice', dueDate: '2026-10-07', estimatedMinutes: 300, dependencyKeys: ['learn'] },
  ],
}];
const overloadedResult = assessPlanConditions(overloaded, {
  startDate: '2026-10-05', targetDate: '2026-10-11', weeklyBudgetMinutes: 600,
  activeWeekdays: [1, 2, 3, 4, 5],
  conditions: { deadlineMode: 'hard', pace: 'balanced', preferredSessionMinutes: 60, reviewCadence: 'standard' },
}, 600);
assert.equal(overloadedResult.blocking, true);
assert.ok(overloadedResult.issues.some((issue) => issue.code === 'capacity-overload'));

const feasible: PlanNode[] = [{
  key: 'phase', title: '阶段', children: [], tasks: [
    { key: 'learn', text: '学习', kind: 'learn', dueDate: '2026-10-06', estimatedMinutes: 60 },
    { key: 'practice', text: '练习', kind: 'practice', dueDate: '2026-10-07', estimatedMinutes: 60, dependencyKeys: ['learn'] },
    { key: 'review', text: '复习', kind: 'review', dueDate: '2026-10-09', estimatedMinutes: 30, dependencyKeys: ['practice'] },
  ],
}];
const feasibleResult = assessPlanConditions(feasible, {
  startDate: '2026-10-05', targetDate: '2026-10-18', weeklyBudgetMinutes: 600,
  activeWeekdays: [1, 2, 3, 4, 5],
  conditions: { deadlineMode: 'hard', pace: 'balanced', preferredSessionMinutes: 60, reviewCadence: 'standard' },
}, 600);
assert.equal(feasibleResult.blocking, false);
assert.equal(feasibleResult.issues.length, 0);

const invalidOrder: PlanNode[] = [{
  key: 'phase', title: '阶段', children: [], tasks: [
    { key: 'foundation', text: '前置', kind: 'learn', dueDate: '2026-10-09', estimatedMinutes: 60 },
    { key: 'output', text: '输出', kind: 'practice', dueDate: '2026-10-08', estimatedMinutes: 60, dependencyKeys: ['foundation'] },
    { key: 'weekend', text: '周末任务', kind: 'review', dueDate: '2026-10-10', estimatedMinutes: 30 },
  ],
}];
const invalidOrderResult = assessPlanConditions(invalidOrder, {
  startDate: '2026-10-05', targetDate: '2026-10-18', weeklyBudgetMinutes: 600,
  activeWeekdays: [1, 2, 3, 4, 5],
  conditions: { deadlineMode: 'flexible', pace: 'balanced', preferredSessionMinutes: 60, reviewCadence: 'light' },
});
assert.ok(invalidOrderResult.issues.some((issue) => issue.code === 'dependency-order'));
assert.ok(invalidOrderResult.issues.some((issue) => issue.code === 'rest-day-task'));

const weekdays = { startDate: '2026-11-02', targetDate: '2026-11-15', dailyStudyMinutes: 60,
  activeWeekdays: [1, 2, 3, 4, 5], conditions: { deadlineMode: 'flexible' as const } };
const node = (key: string, startDate?: string, dueDate?: string, children: PlanNode[] = []): PlanNode => ({ key, title: key, startDate, dueDate, children });
const recursive: PlanNode[] = [node('parent-on-sunday', '2026-11-01', '2026-11-15', [node('inner', '2026-11-02', '2026-11-15', [
  node('saturday-start', '2026-11-07', '2026-11-10'), node('sunday-due-only', undefined, '2026-11-08'),
  node('friday-start-sunday-end', '2026-11-06', '2026-11-08'), node('undated'), node('start-only', '2026-11-07'),
  node('bad-date', '2026-02-30', '2026-03-02'),
])])];
const unchanged = JSON.stringify(recursive);
const rest = assessPlanConditions(recursive, weekdays, 600).issues.find(issue => issue.code === 'rest-day-project')!;
assert.ok(rest); assert.deepEqual(rest.projectKeys, ['saturday-start', 'sunday-due-only']);
assert.equal(rest.taskKeys, undefined); assert.equal(rest.severity, 'warning');
assert.match(rest.message, /saturday-start.*2026-11-07，周六/);
assert.match(rest.message, /sunday-due-only.*2026-11-08，周日/);
assert.equal(JSON.stringify(recursive), unchanged, 'checks never reschedule a project');
assert.equal(assessPlanConditions(recursive, { ...weekdays, activeWeekdays: [0, 1, 2, 3, 4, 5, 6] }, 600).issues.some(issue => issue.code === 'rest-day-project'), false,
  'explicitly enabled weekends are allowed');
assert.equal(assessPlanConditions([node('monday', '2026-11-02', '2026-11-08')], weekdays, 600).issues.some(issue => issue.code === 'rest-day-project'), false,
  'a leaf learning on Monday is not treated as daily work through Sunday');
assert.equal(assessPlanConditions([node('saturday', '2026-11-07', '2026-11-07')], {
  ...weekdays, conditions: { deadlineMode: 'hard' },
}, 600).blocking, false, 'an unselected learning day is a visible warning, not an implicit new hard rule');
for (const timezone of ['Asia/Shanghai', 'America/Los_Angeles']) {
  const original = process.env.TZ;
  try {
    process.env.TZ = timezone;
    assert.deepEqual(assessPlanConditions(recursive, weekdays, 600).issues.find(issue => issue.code === 'rest-day-project')!.projectKeys, rest.projectKeys);
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
}

console.log('plan condition checks passed');
