import assert from 'node:assert/strict';
import type { NoteItem, PlanNode } from '../src/types';
import { PLAN_OVERVIEW_ID, buildPlanWorkspaceModel, buildStructureAgendaOccurrences } from '../src/services/planViewModel';
import { createPlanWorkspaceDemoNotes } from '../src/services/planDemoFixtures';
import {
  addPublishedPlanStructureItem,
  buildPublishedPlanEditorValue,
  replacePublishedPlanFromEditor,
} from '../src/services/publishedPlanEditor';
import {
  getScheduledProjectDeadline,
  getScheduledProjectState,
  toggleScheduledProjectCompletion,
} from '../src/services/planProjectState';
import { getPlanMilestoneGate, togglePlanMilestoneCompletion } from '../src/services/planMilestoneState';
import { formatPlanTaskLine } from '../src/services/planTaskAnchor';
import { groupTimelineMilestones, layoutStructureNodes, layoutTimelineMilestones } from '../src/services/planTimelineLayout';
import {
  getTimelineBoardWidth,
  getTimelineDateScrollLeft,
  getTimelineZoomScrollLeft,
  PLAN_TIMELINE_BASE_WEEK_WIDTH,
  PLAN_TIMELINE_MIN_ZOOM,
  PLAN_TIMELINE_MAX_ZOOM,
  PLAN_TIMELINE_ZOOM_STEP,
} from '../src/services/planTimelineViewport';
import { parseNoteMetadata } from '../src/services/storage';
import { buildHomeFocusProject } from '../src/services/homepage/homepageViewModel';
import {
  getTimelineAutoScrollDistance, getTimelineBlockWidth, getTimelineDayZoomScrollLeft,
  getTimelineGestureDays, getTimelinePointerOutline, packTimelineIntervals,
  PLAN_COMPOSER_ZOOM_STOPS, resizeTimelineWindow,
} from '../src/services/planTimelineInteraction';

assert.equal(PLAN_COMPOSER_ZOOM_STOPS[0], 8, 'composer should support a broader overview');
assert.equal(PLAN_COMPOSER_ZOOM_STOPS.at(-1), 480, 'a day can expand to a readable task-card width');
assert.ok(PLAN_COMPOSER_ZOOM_STOPS.every((value, index) => index === 0 || value > PLAN_COMPOSER_ZOOM_STOPS[index - 1]));
assert.equal(getTimelineGestureDays(450, 498, 48, 0, 0), 1, 'moving a block preserves the original grab offset');
assert.equal(getTimelineGestureDays(200, 248, 48, 0, 0), 1, 'the grab position within a block must not change the move distance');
assert.equal(getTimelineGestureDays(450, 450, 48, 0, 96), 2, 'edge autoscroll contributes to the calendar movement');
assert.equal(getTimelineGestureDays(450, 438, 48, 96, 72), -0.75, 'fractional travel supports continuous preview before day snapping');
assert.deepEqual(resizeTimelineWindow('2026-10-06', '2026-10-08', 2, 'end'),
  { startDate: '2026-10-06', dueDate: '2026-10-10', appliedDays: 2 });
assert.deepEqual(resizeTimelineWindow('2026-10-06', '2026-10-08', -10, 'end'),
  { startDate: '2026-10-06', dueDate: '2026-10-06', appliedDays: -2 }, 'shrinking cannot invert the time range');
assert.deepEqual(resizeTimelineWindow('2026-10-06', '2026-10-08', -10, 'start', '2026-10-05', '2026-10-09'),
  { startDate: '2026-10-05', dueDate: '2026-10-08', appliedDays: -1 }, 'left handle must respect the parent start');
assert.deepEqual(resizeTimelineWindow('2026-10-06', '2026-10-08', 10, 'end', '2026-10-05', '2026-10-09'),
  { startDate: '2026-10-06', dueDate: '2026-10-09', appliedDays: 1 }, 'right handle must respect the parent end');
assert.deepEqual(resizeTimelineWindow('2026-10-06', '2026-10-06', 10, 'start'),
  { startDate: '2026-10-06', dueDate: '2026-10-06', appliedDays: 0 }, 'a leaf project remains at least one day');
assert.equal(getTimelineDayZoomScrollLeft(100, 800, 100, 20, 48, 2116), 730,
  'day-centered zoom remains stable even when the overview calendar length changes');
assert.equal(getTimelineDayZoomScrollLeft(730, 800, 100, 48, 20, 960), 100);
assert.equal(getTimelineDayZoomScrollLeft(0, 800, 100, 20, 8, 804), 0, 'shrinking to the left edge clamps safely');

for (const scale of PLAN_COMPOSER_ZOOM_STOPS) {
  const oneDay = getTimelineBlockWidth(1, scale);
  assert.ok(oneDay > 0 && oneDay < scale, 'a short task must stay inside its real calendar day');
  assert.ok(Math.abs(getTimelineBlockWidth(2, scale) - oneDay - scale) < 1e-10,
    'stretching a one-day task by a day must visibly increase width by one date column');
}
const adjacentLayout = packTimelineIntervals([{ key: 'a', start: 0, end: 1 }, { key: 'b', start: 1, end: 2 }]);
assert.equal(adjacentLayout.laneCount, 1, 'adjacent days do not collide at any zoom');
const overlappingLayout = packTimelineIntervals([{ key: 'a', start: 0, end: 1 }, { key: 'b', start: 0, end: 1 }]);
assert.equal(overlappingLayout.laneCount, 2, 'same-day projects remain independently selectable after release');
assert.notEqual(overlappingLayout.laneByKey.get('a'), overlappingLayout.laneByKey.get('b'));
assert.equal(packTimelineIntervals([]).laneCount, 1, 'empty tracks keep their initial height');
assert.deepEqual(getTimelinePointerOutline(871, 476, -180, 'move'), { left: 691, width: 476 },
  'continuous pointer outline is separate from the solid, final day-snapped position');
assert.deepEqual(getTimelinePointerOutline(391, 16, 7, 'resize-end'), { left: 391, width: 23 });
assert.deepEqual(getTimelinePointerOutline(411, 16, -7, 'resize-start'), { left: 404, width: 23 });
assert.deepEqual(getTimelinePointerOutline(391, 16, 0, 'move'), { left: 391, width: 16 });
const scrollAt60Hz = Array.from({ length: 60 }, () => getTimelineAutoScrollDistance(8, 1000 / 60)).reduce((a, b) => a + b, 0);
const scrollAt144Hz = Array.from({ length: 144 }, () => getTimelineAutoScrollDistance(8, 1000 / 144)).reduce((a, b) => a + b, 0);
assert.ok(Math.abs(scrollAt60Hz - scrollAt144Hz) < 1e-8, 'edge scrolling must not accelerate with the screen refresh rate');
assert.equal(getTimelineAutoScrollDistance(8, 0), 0);
assert.equal(getTimelineAutoScrollDistance(8, 1000), getTimelineAutoScrollDistance(8, 32), 'a stalled frame must not cause a large scroll jump');

const root: NoteItem = {
  id: 'plan-root',
  title: '高等数学 · 6 周掌握计划',
  content: '',
  noteType: 'project',
  tags: ['学习计划'],
  links: [],
  backlinks: [],
  dueDates: [],
  planMeta: {
    schemaVersion: 2,
    status: 'active',
    shortTitle: '高等数学 · 6 周掌握计划',
    startDate: '2026-09-21',
    targetDate: '2026-11-01',
    weeklyBudgetMinutes: 600,
    milestones: [{ id: 'milestone-mid', title: '中值定理测验', dueDate: '2026-10-12' }],
  },
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

const phase: NoteItem = {
  id: 'phase-derivative',
  title: '导数与微分',
  content: '',
  noteType: 'project',
  parentId: root.id,
  tags: ['学习计划'],
  links: [],
  backlinks: [],
  dueDates: [
    { id: 'phase-deadline', noteId: 'phase-derivative', noteTitle: '导数与微分', taskText: '导数与微分', dueDate: '2026-10-12', completed: false, priority: 'high' },
    { id: 'task-learn', noteId: 'phase-derivative', noteTitle: '导数与微分', taskText: '理解导数定义', dueDate: '2026-10-03', completed: true, priority: 'high', kind: 'learn', estimatedMinutes: 90 },
    { id: 'task-practice', noteId: 'phase-derivative', noteTitle: '导数与微分', taskText: '完成导数综合练习', dueDate: '2026-10-05', completed: false, priority: 'medium', kind: 'practice', estimatedMinutes: 120 },
    { id: 'task-review', noteId: 'phase-derivative', noteTitle: '导数与微分', taskText: '复习求导法则', dueDate: '2026-10-08', completed: false, priority: 'medium' },
  ],
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

const leafProject: NoteItem = {
  id: 'project-normal-distribution',
  title: '学习正态分布',
  content: '',
  noteType: 'project',
  parentId: phase.id,
  tags: ['学习计划'],
  links: [],
  backlinks: [],
  dueDates: [{ id: 'leaf-deadline', noteId: 'project-normal-distribution', noteTitle: '学习正态分布', taskText: '学习正态分布', startDate: '2026-10-05', dueDate: '2026-10-12', completed: false, priority: 'medium' }],
  createdAt: '2026-09-20T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

const secondRoot: NoteItem = {
  ...root,
  id: 'plan-english',
  title: '英语阅读计划',
  planMeta: {
    schemaVersion: 2,
    status: 'paused',
    targetDate: '2026-12-01',
    weeklyBudgetMinutes: 300,
    milestones: [{ id: 'milestone-english', title: '完成英文长文验收', dueDate: '2026-11-15' }],
  },
  updatedAt: '2026-09-30T00:00:00.000Z',
};

const secondLeaf: NoteItem = {
  ...leafProject,
  id: 'english-long-read',
  title: '完成英文长文',
  parentId: secondRoot.id,
  dueDates: [
    { ...leafProject.dueDates[0], id: 'english-deadline', noteId: 'english-long-read', noteTitle: '完成英文长文', taskText: '完成英文长文', startDate: '2026-11-01', dueDate: '2026-11-15' },
    { ...leafProject.dueDates[0], id: 'english-practice', noteId: 'english-long-read', noteTitle: '完成英文长文', taskText: '精读一篇长文', startDate: '2026-11-02', dueDate: '2026-11-02', kind: 'practice' },
  ],
};
const ordinaryRoot: NoteItem = {
  ...root,
  id: 'ordinary-root',
  title: '只作编辑对象的根笔记',
  planMeta: undefined,
  dueDates: [],
};
const archivedRoot: NoteItem = {
  ...root,
  id: 'archived-root',
  title: '已归档计划',
  planMeta: { schemaVersion: 2, status: 'archived', targetDate: '2026-12-31' },
};

const scopedNotes = [root, phase, leafProject, secondRoot, secondLeaf, ordinaryRoot, archivedRoot];
const homeFocus = buildHomeFocusProject(scopedNotes, '2026-10-02');
assert.equal(homeFocus?.noteId, root.id, 'home progress should still aggregate the selected root project');
assert.equal(homeFocus?.nextTaskId, 'task-practice', 'home should expose the concrete next planned task');
assert.equal(homeFocus?.nextNoteId, phase.id, 'continuing from home should open the note that owns the next planned task, not the root note');
const model = buildPlanWorkspaceModel(scopedNotes, root.id, '2026-10-02');
assert.equal(model.plans.length, 2, 'root projects should remain separate plans');
assert.equal(model.selectedPlan?.id, root.id);
assert.deepEqual(model.scopeRootIds, [root.id]);
assert.equal(model.isOverview, false);
assert.equal(model.tasks.length, 3, 'project deadline should be a milestone, not an actionable task');
assert.equal(model.tasks.some((task) => task.rootId === secondRoot.id), false, 'single-plan tasks must never leak from another root');
assert.equal(model.phases.some((item) => item.rootId === secondRoot.id), false, 'single-plan phases must never leak from another root');
assert.equal(model.milestones.some((item) => item.rootId === secondRoot.id), false, 'single-plan milestones must never leak from another root');
assert.equal(model.timelineEndDate, '2026-11-01', 'another root with a later target must not stretch a single-plan timeline');
assert.equal(model.selectedPlan?.progress, 25, 'overall progress should include the terminal structure project and actionable tasks');
assert.equal(model.structureDueItems.length, 1, 'only leaf projects should become structural due items');
assert.deepEqual(model.structureLanes.map((lane) => lane.rootId), [root.id], 'single-plan structure lanes must be strictly isolated');
assert.deepEqual(model.structureDueItems[0]?.path, ['高等数学 · 6 周掌握计划', '导数与微分', '学习正态分布']);
assert.equal(model.structureDueItems[0]?.startDate, '2026-10-05', 'structure agenda should retain the project deadline start date');
assert.equal(model.structureDueItems.some((item) => item.projectId === phase.id), false, 'a parent project must not duplicate its terminal child in the agenda');
assert.equal(model.structureDueItems.some((item) => item.projectId === root.id), false, 'a root ancestor must not duplicate its terminal child in the agenda');
assert.equal(model.tasks.find((task) => task.id === 'task-review')?.kind, 'review', 'legacy task kind should be inferred conservatively');
assert.equal(model.phases[0]?.title, '导数与微分');
assert.equal(model.nextMilestone?.title, '中值定理测验', 'explicit milestone should remain the primary next milestone on the same date');
assert.ok(model.weeks.length >= 6);

const overviewModel = buildPlanWorkspaceModel(scopedNotes, PLAN_OVERVIEW_ID, '2026-10-02');
assert.equal(overviewModel.isOverview, true);
assert.equal(overviewModel.root, null, 'overview is a virtual scope and must not masquerade as one root note');
assert.equal(overviewModel.selectedPlan?.id, PLAN_OVERVIEW_ID);
assert.deepEqual(new Set(overviewModel.scopeRootIds), new Set([root.id, secondRoot.id]));
assert.deepEqual(new Set(overviewModel.structureLanes.map((lane) => lane.rootId)), new Set([root.id, secondRoot.id]));
assert.equal(overviewModel.tasks.length, model.tasks.length + 1, 'overview should aggregate actionable tasks from every eligible root');
assert.equal(overviewModel.tasks.every((task) => Boolean(task.rootId && task.rootTitle)), true, 'overview tasks must retain their root provenance');
assert.equal(overviewModel.phases.every((item) => Boolean(item.rootId && item.rootTitle)), true, 'overview phases must retain their root provenance');
assert.equal(overviewModel.milestones.every((item) => Boolean(item.rootId && item.rootTitle)), true, 'overview milestones must retain their root provenance');
assert.equal(overviewModel.selectedPlan?.taskCount, overviewModel.plans.reduce((sum, plan) => sum + plan.taskCount, 0));
assert.equal(overviewModel.selectedPlan?.completedTaskCount, overviewModel.plans.reduce((sum, plan) => sum + plan.completedTaskCount, 0));
assert.equal(overviewModel.selectedPlan?.progress, Math.round((1 / 6) * 100), 'overview progress must be weighted by completed and total work, not averaged percentages');
assert.equal(overviewModel.selectedPlan?.targetDate, '2026-12-01', 'overview target should be the latest scoped target date');
assert.equal(overviewModel.selectedPlan?.weeklyBudgetMinutes, 0, 'without an explicit personal budget, do not invent capacity by summing legacy plan budgets');
assert.equal(buildPlanWorkspaceModel(scopedNotes, PLAN_OVERVIEW_ID, '2026-10-06', { learningWeeklyBudgetMinutes: 600 }).selectedPlan?.weeklyBudgetMinutes, 600, 'all plans share one personal budget');
assert.equal(overviewModel.nextMilestone?.rootId, root.id, 'overview next milestone should be the earliest unfinished milestone across roots');
assert.equal(overviewModel.currentPhases.length, 2, 'overview should expose one current/next phase per scoped root');

const milestone = root.planMeta!.milestones![0];
const ordinaryProjectNote: NoteItem = {
  ...leafProject,
  id: 'ordinary-project-note',
  title: '仅作笔记的项目对象',
  dueDates: [],
};
const laterLeaf: NoteItem = {
  ...leafProject,
  id: 'later-leaf',
  title: '里程碑后的叶子项目',
  dueDates: [{
    ...leafProject.dueDates[0],
    id: 'later-leaf-deadline',
    noteId: 'later-leaf',
    noteTitle: '里程碑后的叶子项目',
    taskText: '里程碑后的叶子项目',
    startDate: '2026-10-13',
    dueDate: '2026-10-15',
  }],
};
const milestoneNotes = [root, phase, leafProject, ordinaryProjectNote, laterLeaf];
const blockedGate = getPlanMilestoneGate(milestoneNotes, root.id, milestone, '2026-10-02');
assert.deepEqual(blockedGate.prerequisiteLeaves.map((item) => item.projectId), [leafProject.id], 'only scheduled leaves ending by the milestone should gate acceptance');
assert.equal(blockedGate.ready, false, 'an incomplete predecessor should keep the milestone unready');
assert.equal(togglePlanMilestoneCompletion(milestoneNotes, root.id, milestone.id, '2026-10-02T08:00:00.000Z'), milestoneNotes, 'an unready milestone must reject completion even outside the UI');
assert.equal(getPlanMilestoneGate(milestoneNotes, root.id, milestone, '2026-10-13').visualState, 'overdue', 'an incomplete milestone should gain overdue emphasis after its date');

const completedLeafNotes = toggleScheduledProjectCompletion(milestoneNotes, leafProject.id, '2026-10-03T08:00:00.000Z');
const readyGate = getPlanMilestoneGate(completedLeafNotes, root.id, milestone, '2026-10-03');
assert.equal(readyGate.ready, true, 'finishing every preceding leaf should make the milestone ready for manual acceptance');
assert.equal(milestone.completed, undefined, 'readiness must never mutate the stored milestone automatically');
const acceptedMilestoneNotes = togglePlanMilestoneCompletion(completedLeafNotes, root.id, milestone.id, '2026-10-03T09:00:00.000Z');
const acceptedMilestone = acceptedMilestoneNotes.find((note) => note.id === root.id)!.planMeta!.milestones![0];
assert.equal(acceptedMilestone.completed, true, 'a ready milestone should be completed only by an explicit action');
assert.equal(acceptedMilestone.completedAt, '2026-10-03T09:00:00.000Z');

const reopenedLeafNotes = toggleScheduledProjectCompletion(acceptedMilestoneNotes, leafProject.id, '2026-10-03T10:00:00.000Z');
assert.equal(reopenedLeafNotes.find((note) => note.id === root.id)!.planMeta!.milestones![0].completed, true, 'reopening a prerequisite must not silently revoke an accepted milestone');
const reopenedMilestoneNotes = togglePlanMilestoneCompletion(reopenedLeafNotes, root.id, milestone.id, '2026-10-03T11:00:00.000Z');
assert.equal(reopenedMilestoneNotes.find((note) => note.id === root.id)!.planMeta!.milestones![0].completed, false, 'a completed milestone should always allow a manual undo');

const reportPlanRoot: NoteItem = {
  id: 'report-plan-root',
  title: '真实排期父项目',
  content: '',
  noteType: 'project',
  tags: ['学习计划'],
  links: [],
  backlinks: [],
  dueDates: [{
    id: 'report-plan-root-deadline',
    noteId: 'report-plan-root',
    noteTitle: '真实排期父项目',
    taskText: '真实排期父项目',
    startDate: '2026-10-01',
    dueDate: '2026-10-31',
    completed: false,
    priority: 'high',
  }],
  planMeta: {
    schemaVersion: 2,
    status: 'active',
    shortTitle: '报告交付计划',
    startDate: '2026-10-01',
    targetDate: '2026-10-31',
  },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

const scheduledBrief: NoteItem = {
  id: 'report-scheduled-brief',
  title: '综合简报',
  content: '',
  noteType: 'project',
  parentId: reportPlanRoot.id,
  tags: ['学习计划'],
  links: [],
  backlinks: [],
  dueDates: [{
    id: 'report-scheduled-brief-deadline',
    noteId: 'report-scheduled-brief',
    noteTitle: '综合简报',
    taskText: '综合简报',
    startDate: '2026-10-03',
    dueDate: '2026-10-08',
    completed: false,
    priority: 'medium',
  }],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

const unscheduledStormBranch: NoteItem = {
  id: 'report-unscheduled-storm-branch',
  title: 'STORM 报告',
  content: '',
  noteType: 'project',
  parentId: reportPlanRoot.id,
  tags: ['STORM'],
  links: [],
  backlinks: [],
  dueDates: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

const unscheduledBranchBrief: NoteItem = {
  id: 'report-unscheduled-branch-brief',
  title: '综合简报',
  content: '',
  noteType: 'project',
  parentId: unscheduledStormBranch.id,
  tags: ['STORM'],
  links: [],
  backlinks: [],
  dueDates: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-02T00:00:00.000Z',
};

const unscheduledStormRoot: NoteItem = {
  ...unscheduledStormBranch,
  id: 'report-unscheduled-storm-root',
  parentId: undefined,
  updatedAt: '2026-10-03T00:00:00.000Z',
};

const unscheduledRootBrief: NoteItem = {
  ...unscheduledBranchBrief,
  id: 'report-unscheduled-root-brief',
  parentId: unscheduledStormRoot.id,
};

const projectionRoot: NoteItem = {
  id: 'report-projection-root',
  title: '容器投影计划',
  content: '',
  noteType: 'project',
  tags: ['学习计划'],
  links: [],
  backlinks: [],
  dueDates: [],
  planMeta: {
    schemaVersion: 2,
    status: 'paused',
    shortTitle: '容器投影计划',
    startDate: '2026-10-01',
    targetDate: '2026-10-31',
  },
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const projectionContainer: NoteItem = {
  id: 'report-projection-container',
  title: 'STORM 报告',
  content: '',
  noteType: 'project',
  parentId: projectionRoot.id,
  tags: ['STORM'],
  links: [],
  backlinks: [],
  dueDates: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const projectedScheduledBrief: NoteItem = {
  id: 'report-projected-scheduled-brief',
  title: '综合简报',
  content: '',
  noteType: 'project',
  parentId: projectionContainer.id,
  tags: ['学习计划'],
  links: [],
  backlinks: [],
  dueDates: [{
    id: 'report-projected-scheduled-brief-deadline',
    noteId: 'report-projected-scheduled-brief',
    noteTitle: '综合简报',
    taskText: '综合简报',
    startDate: '2026-10-10',
    dueDate: '2026-10-20',
    completed: false,
    priority: 'medium',
  }],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const legacyDueOnlyProject: NoteItem = {
  id: 'report-legacy-due-only',
  title: '只有截止日的旧项目',
  content: '',
  noteType: 'project',
  parentId: projectionRoot.id,
  tags: ['学习计划'],
  links: [],
  backlinks: [],
  dueDates: [{
    id: 'report-legacy-due-only-deadline',
    noteId: 'report-legacy-due-only',
    noteTitle: '只有截止日的旧项目',
    taskText: '只有截止日的旧项目',
    dueDate: '2026-10-09',
    completed: false,
    priority: 'low',
  }],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const ordinaryKnowledgeNote: NoteItem = {
  id: 'report-ordinary-knowledge',
  title: '普通研究笔记',
  content: '不应被项目完成操作修改。',
  noteType: 'knowledge',
  parentId: reportPlanRoot.id,
  tags: ['研究笔记'],
  links: [],
  backlinks: [],
  dueDates: [{
    id: 'report-ordinary-reminder',
    noteId: 'report-ordinary-knowledge',
    noteTitle: '普通研究笔记',
    taskText: '保留普通笔记提醒',
    dueDate: '2026-10-07',
    completed: false,
    priority: 'medium',
  }],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
};

const reportRegressionNotes: NoteItem[] = [
  reportPlanRoot,
  scheduledBrief,
  unscheduledStormBranch,
  unscheduledBranchBrief,
  unscheduledStormRoot,
  unscheduledRootBrief,
  projectionRoot,
  projectionContainer,
  projectedScheduledBrief,
  legacyDueOnlyProject,
  ordinaryKnowledgeNote,
];

const reportModel = buildPlanWorkspaceModel(reportRegressionNotes, reportPlanRoot.id, '2026-10-03');
assert.equal(getScheduledProjectDeadline(unscheduledRootBrief), undefined, 'an unscheduled STORM leaf must not receive a fabricated deadline');
assert.ok(getScheduledProjectDeadline(scheduledBrief), 'a scheduled project with the same title must remain recognized by its deadline fields');
assert.equal(reportModel.structureLanes.some((lane) => lane.rootId === unscheduledStormRoot.id), false, 'a fully unscheduled STORM tree must not create a structure lane');
assert.equal(reportModel.structureLanes.flatMap((lane) => lane.nodes).some((node) => node.projectId === unscheduledStormBranch.id || node.projectId === unscheduledBranchBrief.id || node.projectId === unscheduledRootBrief.id), false, 'unscheduled STORM containers and leaves must not create fallback bars');
assert.equal(reportModel.tasks.some((task) => task.noteId === unscheduledBranchBrief.id || task.noteId === unscheduledRootBrief.id), false, 'unscheduled STORM leaves must not become fake actionable tasks');
assert.ok(reportModel.structureDueItems.some((item) => item.projectId === scheduledBrief.id), 'a genuinely scheduled project named “综合简报” must remain actionable');
assert.equal(reportModel.phases.some((phaseItem) => phaseItem.projectId === unscheduledStormBranch.id || phaseItem.projectId === unscheduledBranchBrief.id), false, 'unscheduled STORM branches must not receive fallback phase windows');
const unscheduledOnlyModel = buildPlanWorkspaceModel([unscheduledStormRoot, unscheduledRootBrief], unscheduledStormRoot.id, '2026-10-03');
assert.equal(unscheduledOnlyModel.plans.length, 0, 'an ordinary root without plan metadata or scheduling must not enter the plan selector');
assert.equal(unscheduledOnlyModel.selectedPlan, null, 'an excluded ordinary root must not remain selectable through a stale id');
assert.equal(unscheduledOnlyModel.structureLanes.length, 0, 'an unscheduled root must have no structure lane');
assert.equal(unscheduledOnlyModel.structureDueItems.length, 0, 'an unscheduled root must have no structural agenda items');
assert.equal(unscheduledOnlyModel.tasks.length, 0, 'an unscheduled root must have no actionable tasks');
assert.equal(unscheduledOnlyModel.phases.length, 0, 'an unscheduled root must not receive a synthetic phase');

assert.deepEqual(reportModel.structureLanes.map((lane) => lane.rootId), [reportPlanRoot.id], 'selecting one report plan must not leak a separately rooted projection plan');
const projectionModel = buildPlanWorkspaceModel(reportRegressionNotes, projectionRoot.id, '2026-10-03');
const projectionLane = projectionModel.structureLanes.find((lane) => lane.rootId === projectionRoot.id);
const projectedNode = projectionLane?.nodes.find((node) => node.projectId === projectedScheduledBrief.id);
assert.ok(projectedNode, 'a scheduled grandchild below an unscheduled container must remain visible');
assert.equal(projectedNode.parentId, projectionRoot.id, 'a scheduled grandchild must project to the nearest visible scheduled parent');
assert.equal(projectedNode.depth, 0, 'an unscheduled container must not consume a visible structure depth');
assert.deepEqual(projectedNode.path, ['容器投影计划', 'STORM 报告', '综合简报'], 'the projected bar must retain the complete real project path');
const legacyNode = projectionLane?.nodes.find((node) => node.projectId === legacyDueOnlyProject.id);
assert.ok(legacyNode, 'a legacy project with only its own due date must remain scheduled');
assert.equal(legacyNode.startDate, '2026-10-09', 'a due-only legacy project should start on its deadline');
assert.equal(legacyNode.endDate, '2026-10-09', 'a due-only legacy project should render as a one-day range');

const selectedReportProjectIds = new Set(reportModel.structureLanes
  .find((lane) => lane.rootId === reportModel.selectedPlan?.id)?.nodes.map((node) => node.projectId) || []);
const selectedReportStructureItems = reportModel.structureDueItems.filter((item) => selectedReportProjectIds.has(item.projectId));
const expectedVisibleCount = reportModel.tasks.length + selectedReportStructureItems.length;
const expectedVisibleCompleted = reportModel.tasks.filter((task) => task.completed).length
  + selectedReportStructureItems.filter((item) => item.completed).length;
assert.equal(reportModel.selectedPlan?.taskCount, expectedVisibleCount, 'plan summary totals must use the same scheduled items as timeline and agenda');
assert.equal(reportModel.selectedPlan?.completedTaskCount, expectedVisibleCompleted, 'plan summary completion must use the same scheduled items as timeline and agenda');

const noScheduleToggle = toggleScheduledProjectCompletion(reportRegressionNotes, unscheduledRootBrief.id, '2026-10-03T09:00:00.000Z');
assert.strictEqual(noScheduleToggle, reportRegressionNotes, 'toggling an unscheduled leaf must be an exact no-op');

const completedReportNotes = toggleScheduledProjectCompletion(reportRegressionNotes, scheduledBrief.id, '2026-10-03T10:00:00.000Z');
assert.equal(getScheduledProjectDeadline(completedReportNotes.find((note) => note.id === scheduledBrief.id)!)?.completed, true, 'a scheduled leaf should complete through its real deadline');
assert.equal(getScheduledProjectDeadline(completedReportNotes.find((note) => note.id === reportPlanRoot.id)!)?.completed, true, 'completing the only scheduled leaf should aggregate completion to its scheduled parent');
assert.equal(getScheduledProjectState(completedReportNotes, reportPlanRoot.id).completed, true, 'unscheduled STORM descendants must not lower parent completion');
assert.deepEqual(completedReportNotes.find((note) => note.id === ordinaryKnowledgeNote.id), ordinaryKnowledgeNote, 'project completion must not modify an ordinary knowledge note');
for (const projectId of [unscheduledStormBranch.id, unscheduledBranchBrief.id, unscheduledStormRoot.id, unscheduledRootBrief.id]) {
  assert.deepEqual(completedReportNotes.find((note) => note.id === projectId)?.dueDates, [], 'completion must never manufacture a deadline for unscheduled STORM projects');
}

const completedReportModel = buildPlanWorkspaceModel(completedReportNotes, reportPlanRoot.id, '2026-10-03');
const completedSelectedProjectIds = new Set(completedReportModel.structureLanes
  .find((lane) => lane.rootId === completedReportModel.selectedPlan?.id)?.nodes.map((node) => node.projectId) || []);
const completedSelectedStructureItems = completedReportModel.structureDueItems.filter((item) => completedSelectedProjectIds.has(item.projectId));
assert.equal(completedReportModel.selectedPlan?.taskCount, completedReportModel.tasks.length + completedSelectedStructureItems.length, 'completed summary totals must remain aligned with visible scheduled work in the selected plan');
assert.equal(completedReportModel.selectedPlan?.completedTaskCount, completedReportModel.tasks.filter((task) => task.completed).length + completedSelectedStructureItems.filter((item) => item.completed).length, 'completed summary state must remain aligned with visible scheduled work in the selected plan');

const reopenedReportNotes = toggleScheduledProjectCompletion(completedReportNotes, scheduledBrief.id, '2026-10-03T11:00:00.000Z');
assert.equal(getScheduledProjectDeadline(reopenedReportNotes.find((note) => note.id === scheduledBrief.id)!)?.completed, false, 'a second toggle should reopen the scheduled leaf');
assert.equal(getScheduledProjectDeadline(reopenedReportNotes.find((note) => note.id === reportPlanRoot.id)!)?.completed, false, 'reopening a scheduled leaf should reopen its scheduled parent');
assert.deepEqual(reopenedReportNotes.find((note) => note.id === ordinaryKnowledgeNote.id), ordinaryKnowledgeNote, 'reopening a project must still leave ordinary notes untouched');

const stableId = 'plan-task-phase-derivative-1';
const parsed = parseNoteMetadata({
  ...phase,
  content: formatPlanTaskLine('完成一组练习', '2026-10-06', stableId),
  dueDates: [],
});
assert.equal(parsed.dueDates[0]?.id, stableId, 'markdown task anchor should survive line movement');
assert.equal(parsed.dueDates[0]?.taskText, '完成一组练习');

const demoNotes = createPlanWorkspaceDemoNotes('2026-10-02');
const editableRootId = 'plan-demo-statistics-root';
const editorValue = buildPublishedPlanEditorValue(demoNotes, editableRootId);
assert.ok(editorValue, 'a published root plan should serialize into the existing plan composer');
const editedTree = structuredClone(editorValue.tree);
editedTree[0].title = '统计推断 · 调整版';
editedTree[0].children[0].title = '预备知识重新校准';
editedTree[0].tasks![0] = {
  ...editedTree[0].tasks![0],
  text: '每日关键公式回忆',
  estimatedMinutes: 25,
};
const editedMeta = {
  ...structuredClone(editorValue.planMeta),
  weeklyBudgetMinutes: 720,
};
const unrelatedRootId = 'plan-demo-psychology-root';
const collectScopeIds = (rootId: string, source: NoteItem[]) => {
  const ids = new Set([rootId]);
  let changed = true;
  while (changed) {
    changed = false;
    source.forEach((note) => {
      if (note.parentId && ids.has(note.parentId) && !ids.has(note.id)) {
        ids.add(note.id);
        changed = true;
      }
    });
  }
  return ids;
};
const unrelatedScopeIds = collectScopeIds(unrelatedRootId, demoNotes);
const unrelatedBefore = demoNotes.filter((note) => unrelatedScopeIds.has(note.id));
const editorMutation = replacePublishedPlanFromEditor(
  demoNotes,
  editableRootId,
  editedTree,
  editedMeta,
  '2026-10-03T08:00:00.000Z',
);
const editedRoot = editorMutation.notes.find((note) => note.id === editableRootId)!;
assert.equal(editedRoot.title, '统计推断 · 调整版', 'manual plan editing should retain the root id while changing its title');
assert.equal(editedRoot.planMeta?.weeklyBudgetMinutes, 720, 'manual plan editing should update root-level plan conditions');
assert.equal(editorMutation.notes.find((note) => note.id === editedTree[0].children[0].key)?.title, '预备知识重新校准', 'manual plan editing should patch existing structure nodes instead of recreating them');
assert.equal(editedRoot.dueDates.find((task) => task.id === editedTree[0].tasks![0].key)?.taskText, '每日关键公式回忆', 'manual plan editing should update existing execution items in place');
assert.deepEqual(
  editorMutation.notes.filter((note) => unrelatedScopeIds.has(note.id)),
  unrelatedBefore,
  'overwriting one loaded plan must leave every unread root plan byte-for-byte unchanged',
);
const reshapedTree = structuredClone(editorValue.tree);
const removedProject = reshapedTree[0].children[0].children.pop()!;
const removedProjectBefore = structuredClone(demoNotes.find((note) => note.id === removedProject.key)!);
reshapedTree[0].children[0].children.push({
  key: 'manual-new-project',
  title: '手动新增校准项目',
  startDate: '2026-09-25',
  dueDate: '2026-09-27',
  priority: 'medium',
  children: [],
});
const removedTask = reshapedTree[0].tasks!.shift()!;
reshapedTree[0].tasks!.push({
  key: 'manual-new-execution',
  text: '每周手动复盘',
  kind: 'review',
  startDate: '2026-10-03',
  dueDate: '2026-10-03',
  estimatedMinutes: 40,
  priority: 'medium',
  executionKind: 'review',
  recurrence: { frequency: 'weekly', interval: 1, weekdays: [6], endDate: '2026-11-01' },
  linkedProjectKey: 'manual-new-project',
});
const reshapedMeta = structuredClone(editorValue.planMeta);
const removedMilestone = reshapedMeta.milestones!.shift()!;
reshapedMeta.milestones!.push({
  id: 'manual-new-milestone',
  title: '手动验收节点',
  dueDate: '2026-09-27',
  criteria: ['完成新增校准项目'],
  projectId: 'manual-new-project',
  completed: false,
});
const reshapedMutation = replacePublishedPlanFromEditor(
  demoNotes,
  editableRootId,
  reshapedTree,
  reshapedMeta,
  '2026-10-03T09:00:00.000Z',
);
const removedProjectAfter = reshapedMutation.notes.find((note) => note.id === removedProject.key)!;
assert.equal(reshapedMutation.deletedProjectIds.includes(removedProject.key), false, 'removing a loaded structure block must never delete its project note');
assert.ok(removedProjectAfter, 'a project removed from the plan must remain available as a project note');
assert.equal(removedProjectAfter.content, removedProjectBefore.content, 'removing a project from the plan must preserve its body');
assert.equal(removedProjectAfter.parentId, removedProjectBefore.parentId, 'removing a project from the plan must preserve its hierarchy');
assert.deepEqual(
  removedProjectAfter.dueDates.filter((item) => item.id !== `due-${removedProject.key}-0` && item.taskText.trim() !== removedProjectBefore.title.trim()),
  removedProjectBefore.dueDates.filter((item) => item.id !== `due-${removedProject.key}-0` && item.taskText.trim() !== removedProjectBefore.title.trim()),
  'removing a project from the plan must preserve non-project execution items',
);
assert.equal(getScheduledProjectDeadline(removedProjectAfter), undefined, 'removing a project from the plan should clear only its project time range');
const reopenedEditor = buildPublishedPlanEditorValue(reshapedMutation.notes, editableRootId)!;
const reopenedProjectIds = new Set((function collect(nodes: PlanNode[]): string[] {
  return nodes.flatMap((node) => [node.key, ...collect(node.children || [])]);
})(reopenedEditor.tree));
assert.equal(reopenedProjectIds.has(removedProject.key), false, 'an unscheduled project should stay out of the plan track after reopening the editor');
const availableRemovedProject = reopenedEditor.projectCatalog.find((project) => project.key === removedProject.key);
assert.ok(availableRemovedProject, 'a project removed from the timeline should become available for rescheduling');
const originalRemovedDeadline = getScheduledProjectDeadline(removedProjectBefore)!;
const quickReaddedMutation = addPublishedPlanStructureItem(reshapedMutation.notes, {
  mode: 'existing',
  rootId: editableRootId,
  projectId: removedProject.key,
  startDate: originalRemovedDeadline.startDate!,
  dueDate: originalRemovedDeadline.dueDate,
  priority: originalRemovedDeadline.priority,
}, '2026-10-03T09:20:00.000Z');
const quickReaddedProject = quickReaddedMutation.notes.find((note) => note.id === removedProject.key)!;
assert.equal(quickReaddedMutation.notes.length, reshapedMutation.notes.length, 'quick scheduling must reuse an existing project note');
assert.equal(quickReaddedProject.parentId, removedProjectBefore.parentId, 'quick scheduling must preserve the existing project hierarchy');
assert.equal(getScheduledProjectDeadline(quickReaddedProject)?.dueDate, originalRemovedDeadline.dueDate, 'quick scheduling should publish the selected project range');
const quickNewMutation = addPublishedPlanStructureItem(demoNotes, {
  mode: 'new',
  rootId: editableRootId,
  parentId: editorValue.tree[0].children[0].key,
  title: '快速新增结构项目',
  startDate: editorValue.tree[0].children[0].startDate!,
  dueDate: editorValue.tree[0].children[0].startDate!,
  priority: 'medium',
}, '2026-10-03T09:25:00.000Z');
const quickNewProject = quickNewMutation.notes.find((note) => note.title === '快速新增结构项目');
assert.ok(quickNewProject, 'quick structure creation should materialize a new project note');
assert.equal(quickNewProject?.parentId, editorValue.tree[0].children[0].key, 'quick structure creation should attach to the selected parent');
const readdedTree = structuredClone(reopenedEditor.tree);
const insertExistingProject = (nodes: PlanNode[]): boolean => {
  for (const node of nodes) {
    if (node.key === availableRemovedProject.parentKey) {
      node.children.push({
        key: availableRemovedProject.key,
        title: availableRemovedProject.title,
        startDate: originalRemovedDeadline.startDate,
        dueDate: originalRemovedDeadline.dueDate,
        priority: availableRemovedProject.priority,
        children: [],
      });
      return true;
    }
    if (insertExistingProject(node.children || [])) return true;
  }
  return false;
};
assert.equal(insertExistingProject(readdedTree), true, 'the existing project should be inserted beneath its real parent');
const readdedMutation = replacePublishedPlanFromEditor(
  reshapedMutation.notes,
  editableRootId,
  readdedTree,
  reopenedEditor.planMeta,
  '2026-10-03T09:30:00.000Z',
);
const readdedProject = readdedMutation.notes.find((note) => note.id === removedProject.key)!;
assert.equal(readdedMutation.notes.length, reshapedMutation.notes.length, 'rescheduling an existing project must not create a duplicate note');
assert.equal(readdedMutation.createdProjectNotes.some((note) => note.id === removedProject.key), false, 'rescheduling must update the original project instead of materializing a new one');
assert.equal(readdedProject.content, removedProjectBefore.content, 'rescheduling must retain the original project body');
assert.equal(readdedProject.parentId, removedProjectBefore.parentId, 'rescheduling must retain the original project hierarchy');
assert.equal(getScheduledProjectDeadline(readdedProject)?.startDate, originalRemovedDeadline.startDate, 'rescheduling should write the selected start date to the original project');
assert.equal(getScheduledProjectDeadline(readdedProject)?.dueDate, originalRemovedDeadline.dueDate, 'rescheduling should write the selected due date to the original project');
const readdedEditor = buildPublishedPlanEditorValue(readdedMutation.notes, editableRootId)!;
const readdedEditorProjectIds = new Set((function collect(nodes: PlanNode[]): string[] {
  return nodes.flatMap((node) => [node.key, ...collect(node.children || [])]);
})(readdedEditor.tree));
assert.equal(readdedEditorProjectIds.has(removedProject.key), true, 'a rescheduled project should return to the plan track');
assert.ok(reshapedMutation.notes.some((note) => note.title === '手动新增校准项目'), 'new structure blocks should be materialized as project notes');
assert.equal(reshapedMutation.notes.some((note) => note.dueDates.some((task) => task.id === removedTask.key)), false, 'removing an execution block should delete the existing task');
assert.ok(reshapedMutation.notes.some((note) => note.dueDates.some((task) => task.id === 'manual-new-execution')), 'new execution blocks should be added to the selected root scope');
assert.equal(reshapedMutation.notes.find((note) => note.id === editableRootId)?.planMeta?.milestones?.some((milestone) => milestone.id === removedMilestone.id), false, 'removed milestones should be deleted');
assert.ok(reshapedMutation.notes.find((note) => note.id === editableRootId)?.planMeta?.milestones?.some((milestone) => milestone.id === 'manual-new-milestone'), 'new milestones should be saved with the adjusted plan');
assert.deepEqual(
  reshapedMutation.notes.filter((note) => unrelatedScopeIds.has(note.id)),
  unrelatedBefore,
  'structural additions and deletions must still remain isolated from unread plans',
);
const demoModel = buildPlanWorkspaceModel(demoNotes, null, '2026-10-02');
const demoCurrentWeek = demoModel.weeks.find((week) => week.startDate <= '2026-10-02' && week.endDate >= '2026-10-02');
const demoAgendaCount = demoCurrentWeek
  ? demoModel.tasks.filter((task) => task.occurrenceDate >= demoCurrentWeek.startDate && task.occurrenceDate <= demoCurrentWeek.endDate).length
    + buildStructureAgendaOccurrences(demoModel.structureDueItems, demoCurrentWeek.startDate, demoCurrentWeek.endDate, '2026-10-02').length
  : 0;
assert.ok(Math.max(...demoModel.structureLanes.flatMap((lane) => lane.nodes.map((node) => node.depth))) >= 2, 'demo should include a deep structure hierarchy');
assert.ok(demoModel.tasks.filter((task) => task.recurrence && task.recurrence.frequency !== 'none').length >= 3, 'demo should include varied recurring tasks');
assert.ok(demoModel.milestones.length >= 4, 'demo should include milestone progression');
assert.ok(demoAgendaCount >= 5, 'demo current week should visibly fill the agenda');

const posterior = demoModel.structureDueItems.find((item) => item.projectId === 'plan-demo-posterior-explain');
assert.ok(posterior, 'demo should include the posterior learning project');
assert.equal(posterior.startDate, '2026-10-02');
const datesFor = (items: typeof demoModel.structureDueItems, start: string, end: string, today: string) => (
  buildStructureAgendaOccurrences(items, start, end, today).map((entry) => entry.occurrenceDate)
);
assert.deepEqual(datesFor([posterior], '2026-09-28', '2026-10-04', '2026-10-02'), ['2026-10-02'], 'posterior must appear once on its start day without being prelisted on future days');
assert.deepEqual(datesFor([posterior], '2026-09-28', '2026-10-04', '2026-10-03'), ['2026-10-03'], 'unfinished posterior should roll to the new today only after the calendar advances');
assert.deepEqual(datesFor([posterior], '2026-09-28', '2026-10-04', '2026-09-28'), ['2026-10-02'], 'a future project should appear once on its start date, never before it starts');
assert.deepEqual(datesFor([{ ...posterior, dueDate: '2026-10-07' }], '2026-10-05', '2026-10-11', '2026-10-02'), [], 'an already-started project must not be duplicated in a future week even when its deadline falls there');
assert.deepEqual(datesFor([{ ...posterior, startDate: '2026-10-06', dueDate: '2026-10-09' }], '2026-10-05', '2026-10-11', '2026-10-02'), ['2026-10-06'], 'a not-yet-started project should appear once on its start date in a future week');
assert.deepEqual(datesFor([{ ...posterior, startDate: '2026-10-06', dueDate: '2026-10-09' }], '2026-09-28', '2026-10-04', '2026-10-02'), [], 'future-week projects must not be shown in the current week before starting');

const completedPosterior = { ...posterior, completed: true, completedAt: new Date(2026, 9, 3, 10, 15).toISOString() };
assert.deepEqual(datesFor([completedPosterior], '2026-09-28', '2026-10-04', '2026-10-03'), ['2026-10-03'], 'completed projects appear once at actual completion, not on later pending days');
assert.deepEqual(datesFor([completedPosterior], '2026-10-05', '2026-10-11', '2026-10-05'), [], 'completed projects should not roll into another week');
assert.deepEqual(datesFor([{ ...completedPosterior, completedAt: undefined }], '2026-09-28', '2026-10-04', '2026-10-03'), ['2026-10-04'], 'legacy completed projects without a timestamp use their original deadline');
for (const completedAt of [new Date(2026, 9, 3, 0, 15).toISOString(), new Date(2026, 9, 3, 23, 45).toISOString(), '2026-10-03']) {
  assert.deepEqual(datesFor([{ ...completedPosterior, completedAt }], '2026-09-28', '2026-10-04', '2026-10-03'), ['2026-10-03'], 'completion near midnight must belong to its local calendar date, including date-only legacy values');
}
assert.deepEqual(datesFor([{ ...completedPosterior, completedAt: 'invalid-timestamp' }], '2026-09-28', '2026-10-04', '2026-10-03'), ['2026-10-04'], 'invalid completion timestamps should safely fall back to the deadline');

const overdue = buildStructureAgendaOccurrences([posterior], '2026-10-05', '2026-10-11', '2026-10-06');
assert.deepEqual(overdue.map((entry) => entry.occurrenceDate), ['2026-10-06'], 'overdue unfinished project must stay visible today after crossing weeks');
assert.equal(overdue[0]?.item.dueDate, '2026-10-04', 'rollover must not mutate or disguise the original deadline');
assert.equal(overdue[0]?.item.completed, false);
assert.deepEqual(datesFor([posterior], '2026-09-28', '2026-10-04', '2026-10-06'), [], 'unfinished projects that rolled to today must not leave invented pending entries in historical weeks');
assert.deepEqual(datesFor([posterior], '2026-10-12', '2026-10-18', '2026-10-06'), [], 'overdue work belongs to today and must not repeat in later weeks');
assert.equal(buildStructureAgendaOccurrences([posterior, posterior], '2026-09-28', '2026-10-04', '2026-10-02').length, 1, 'each unfinished project must have only one actionable agenda entry');

const leafCompletedAt = new Date(2026, 9, 7, 8, 30).toISOString();
const completedLeafModel = buildPlanWorkspaceModel([root, phase, {
  ...leafProject,
  dueDates: leafProject.dueDates.map((item) => ({ ...item, completed: true, completedAt: leafCompletedAt })),
}], root.id, '2026-10-07');
assert.equal(completedLeafModel.structureDueItems[0]?.completedAt, leafCompletedAt, 'structure agenda must retain actual completion time from the note deadline');
assert.equal(completedLeafModel.structureDueItems.length, 1, 'completed leaf must not add completed parent or grandparent duplicates');
assert.deepEqual(datesFor(completedLeafModel.structureDueItems, '2026-10-05', '2026-10-11', '2026-10-07'), ['2026-10-07']);

const sampleNode = model.structureLanes.find((lane) => lane.rootId === root.id)?.nodes[0];
assert.ok(sampleNode);
const overlappingStructure = layoutStructureNodes([
  { ...sampleNode, projectId: 'parent-a', depth: 0, leftPercent: 0, widthPercent: 40 },
  { ...sampleNode, projectId: 'parent-b', depth: 0, leftPercent: 20, widthPercent: 30 },
  { ...sampleNode, projectId: 'parent-c', depth: 0, leftPercent: 50, widthPercent: 30 },
  { ...sampleNode, projectId: 'child-a', parentId: 'parent-a', depth: 1, leftPercent: 5, widthPercent: 20 },
  { ...sampleNode, projectId: 'grandchild-a', parentId: 'child-a', depth: 2, leftPercent: 10, widthPercent: 10 },
]);
const structurePositions = new Map(overlappingStructure.positioned.map((entry) => [entry.node.projectId, entry]));
assert.notEqual(structurePositions.get('parent-a')?.row, structurePositions.get('parent-b')?.row, 'overlapping sibling projects must occupy separate rows');
assert.equal(structurePositions.get('parent-a')?.row, structurePositions.get('parent-c')?.row, 'nonoverlapping sibling projects should reuse available row space');
for (const entry of overlappingStructure.positioned) {
  const parent = entry.node.parentId ? structurePositions.get(entry.node.parentId) : undefined;
  if (parent) assert.ok(entry.row > parent.row, 'expanded children and grandchildren must stay below their own parent');
}

const milestoneGroups = groupTimelineMilestones([
  { id: 'edge-right', title: '计划结束', dueDate: '2026-10-31', rootId: root.id, rootTitle: root.title, leftPercent: 100 },
  { id: 'same-date-a', title: '后验验收', dueDate: '2026-10-14', rootId: root.id, rootTitle: root.title, leftPercent: 45 },
  { id: 'edge-left', title: '计划开始', dueDate: '2026-10-01', rootId: root.id, rootTitle: root.title, leftPercent: 0 },
  { id: 'adjacent-date', title: '综合验收', dueDate: '2026-10-15', rootId: root.id, rootTitle: root.title, leftPercent: 46 },
  { id: 'same-date-b', title: '推断验收', dueDate: '2026-10-14', rootId: root.id, rootTitle: root.title, leftPercent: 45 },
]);
assert.equal(milestoneGroups.length, 4, 'milestones on the same date should share one marker');
assert.deepEqual(milestoneGroups.map((group) => group.date), ['2026-10-01', '2026-10-14', '2026-10-15', '2026-10-31']);
assert.deepEqual(milestoneGroups[1]?.milestones.map((item) => item.id), ['same-date-a', 'same-date-b'], 'grouping must preserve access to every same-day milestone');

const labelWidths = Object.fromEntries(milestoneGroups.map((group) => [group.date, 100]));
const narrowMilestones = layoutTimelineMilestones(milestoneGroups, 96, labelWidths);
assert.ok(narrowMilestones.markers.every((marker) => !marker.showLabel), 'crowded milestone labels must hide instead of overlapping adjacent icons');
assert.ok(new Set(narrowMilestones.markers.map((marker) => marker.row)).size > 1, 'adjacent milestone icons must move to separate rows when horizontal space is insufficient');
for (const width of [24, 32, 64, 96, 160, 240]) {
  const { markers, height } = layoutTimelineMilestones(milestoneGroups, width, labelWidths);
  assert.equal(markers.length, milestoneGroups.length, 'collisions must never remove milestone icons');
  for (let index = 0; index < markers.length; index += 1) {
    const marker = markers[index];
    assert.ok(marker.x - 12 >= 0 && marker.x + 12 <= width, 'left and right edge icons must remain inside the visible track');
    assert.ok(marker.row * 32 + 24 <= height, 'marker rail must have enough height for every icon row');
    for (const other of markers.slice(index + 1)) {
      if (marker.row === other.row) assert.ok(Math.abs(marker.x - other.x) >= 24, 'milestone icons in the same row must not overlap');
    }
    if (marker.showLabel) {
      const nextInRow = markers.slice(index + 1).find((other) => other.row === marker.row);
      const labelEnd = marker.x + 18 + labelWidths[marker.group.date];
      assert.ok(labelEnd <= width, 'visible milestone text must fit inside the track');
      if (nextInRow) assert.ok(labelEnd < nextInRow.x - 12, 'visible milestone text must leave the next icon unobstructed');
    }
  }
}
assert.ok(layoutTimelineMilestones(milestoneGroups, 1024, labelWidths).markers.some((marker) => marker.showLabel), 'uncrowded milestone labels should remain visible on wide tracks');

assert.equal(PLAN_TIMELINE_BASE_WEEK_WIDTH, 140);
assert.equal(PLAN_TIMELINE_MIN_ZOOM, 100);
assert.equal(PLAN_TIMELINE_MAX_ZOOM, 2400);
assert.equal(PLAN_TIMELINE_ZOOM_STEP, 25);
assert.equal(getTimelineBoardWidth(1000, 160, 12, 100), 1840, '12-week timeline should reserve 140 pixels per week at normal zoom');
assert.equal(getTimelineBoardWidth(1000, 160, 52, 100), 7440, 'a full-year timeline must scroll rather than squeeze 52 weeks into the viewport');
assert.equal(getTimelineBoardWidth(1000, 160, 12, 300), 5200, 'zoom must enlarge date columns without enlarging the label column');
for (const weekCount of [12, 52]) {
  for (const viewportWidth of [640, 1000, 1920]) {
    assert.equal(getTimelineBoardWidth(viewportWidth, 160, weekCount, null), viewportWidth, 'fit mode must exactly fill the viewport without extra scroll or unused board width');
  }
  const previousBoardWidth = getTimelineBoardWidth(1000, 160, weekCount, 100);
  const nextBoardWidth = getTimelineBoardWidth(1000, 160, weekCount, 300);
  const scrollLeft = (previousBoardWidth - 1000) / 3;
  const enlargedScroll = getTimelineZoomScrollLeft({ scrollLeft, viewportWidth: 1000, labelWidth: 160, previousBoardWidth, nextBoardWidth });
  const originalAnchorDate = (scrollLeft + 420) / (previousBoardWidth - 160);
  const enlargedAnchorDate = (enlargedScroll + 420) / (nextBoardWidth - 160);
  assert.ok(Math.abs(originalAnchorDate - enlargedAnchorDate) < 1e-10, 'zoom should keep the center of the visible date area on the same date');
  const restoredScroll = getTimelineZoomScrollLeft({ scrollLeft: enlargedScroll, viewportWidth: 1000, labelWidth: 160, previousBoardWidth: nextBoardWidth, nextBoardWidth: previousBoardWidth });
  assert.ok(Math.abs(restoredScroll - scrollLeft) < 1e-8, 'zooming back should restore the original horizontal position when no edge is clamped');
}
assert.equal(getTimelineBoardWidth(1920, 160, 6, 100), 1920, 'a short plan must still fill a wide viewport');
assert.equal(getTimelineBoardWidth(Number.NaN, -20, Number.NaN, Number.NaN), 140, 'invalid dimensions and zoom should yield a finite one-week board');
assert.equal(getTimelineBoardWidth(-100, 160, 0, null), 0, 'fit mode must sanitize negative viewport sizes');
assert.equal(getTimelineBoardWidth(0, 160, 0, 100), 300, 'zero weeks should still reserve one calendar week');
assert.equal(getTimelineBoardWidth(0, 0, 1, 25), 140, 'zoom should not fall below the supported minimum');
assert.equal(getTimelineBoardWidth(0, 0, 1, 3000), 3360, 'zoom should not exceed the supported maximum');
assert.equal(getTimelineBoardWidth(0, 0, 1, PLAN_TIMELINE_MAX_ZOOM) / 7, 480, 'published plans should also expand a day to readable card width');

const zoomOptions = { scrollLeft: 300, viewportWidth: 1000, labelWidth: 160, previousBoardWidth: 1840, nextBoardWidth: 3520 };
assert.equal(getTimelineZoomScrollLeft(zoomOptions), 1020, 'the fixed 160-pixel label must be excluded when preserving the date center');
assert.notEqual(getTimelineZoomScrollLeft({ ...zoomOptions, labelWidth: 0 }), 1020, 'a different label width changes the visible date anchor');
assert.equal(getTimelineZoomScrollLeft({ ...zoomOptions, anchorRatio: 0 }), 600, 'a left-edge anchor should preserve the first visible date');
assert.equal(getTimelineZoomScrollLeft({ ...zoomOptions, anchorRatio: 1 }), 1440, 'a right-edge anchor should preserve the last visible date');
assert.equal(getTimelineZoomScrollLeft({ ...zoomOptions, nextBoardWidth: 1000 }), 0, 'returning to fit must remove stale horizontal scrolling');
assert.equal(getTimelineZoomScrollLeft({ ...zoomOptions, viewportWidth: 4000, nextBoardWidth: 4000 }), 0, 'expanding the viewport to fit the board must clamp scroll to zero');
assert.equal(getTimelineZoomScrollLeft({ ...zoomOptions, previousBoardWidth: 160 }), 0, 'a board with no calendar area must not divide by zero');
assert.equal(getTimelineZoomScrollLeft({ ...zoomOptions, nextBoardWidth: 0 }), 0, 'a collapsed board must not retain a positive scroll position');
const staleScroll = getTimelineZoomScrollLeft({ ...zoomOptions, scrollLeft: 100_000, nextBoardWidth: 1200 });
assert.ok(staleScroll >= 0 && staleScroll <= 200, 'resize must clamp stale scroll positions to the new board edges');
assert.ok(Number.isFinite(getTimelineZoomScrollLeft({ ...zoomOptions, scrollLeft: Number.NaN, anchorRatio: Number.NaN })), 'invalid scroll and anchor input must never produce NaN');

const dateScrollOptions = { boardWidth: 3520, viewportWidth: 1000, labelWidth: 160 };
assert.equal(getTimelineDateScrollLeft({ ...dateScrollOptions, datePercent: 25 }), 420, 'today should center in the visible date area, excluding the fixed label');
assert.equal(getTimelineDateScrollLeft({ ...dateScrollOptions, datePercent: 50 }), 1260);
assert.equal(getTimelineDateScrollLeft({ ...dateScrollOptions, datePercent: 0 }), 0, 'the first date must clamp to the left edge');
assert.equal(getTimelineDateScrollLeft({ ...dateScrollOptions, datePercent: 100 }), 2520, 'the final date must clamp to the right edge');
assert.equal(getTimelineDateScrollLeft({ ...dateScrollOptions, datePercent: 200 }), 2520, 'out-of-range dates must not scroll beyond the calendar');
assert.equal(getTimelineDateScrollLeft({ ...dateScrollOptions, datePercent: Number.NaN }), 0, 'invalid date percentages must produce a safe scroll position');
assert.equal(getTimelineDateScrollLeft({ ...dateScrollOptions, datePercent: 50, viewportWidth: 5000 }), 0, 'date centering must not create scroll when the viewport is wider than the board');
assert.equal(getTimelineDateScrollLeft({ datePercent: 50, boardWidth: 0, viewportWidth: 0, labelWidth: 160 }), 0, 'zero-sized layout measurements must remain safe');

const fullYearRoot: NoteItem = {
  ...root,
  id: 'full-year-root',
  planMeta: { ...root.planMeta!, startDate: '2026-09-21', targetDate: '2027-09-19' },
};
const oneDayProject: NoteItem = {
  ...leafProject,
  id: 'single-day-project',
  parentId: fullYearRoot.id,
  dueDates: [
    { ...leafProject.dueDates[0], id: 'single-day-deadline', noteId: 'single-day-project', startDate: '2026-10-03', dueDate: '2026-10-03' },
    { ...leafProject.dueDates[0], id: 'single-day-execution', noteId: 'single-day-project', taskText: '单日练习', startDate: '2026-10-03', dueDate: '2026-10-03' },
  ],
};
const fullYearModel = buildPlanWorkspaceModel([fullYearRoot, oneDayProject], fullYearRoot.id, '2026-10-03');
assert.equal(fullYearModel.totalDays, 364);
assert.equal(fullYearModel.tasks[0]?.widthPercent, 100 / 364, 'a one-day execution item must occupy exactly one day even in a 52-week plan');
assert.equal(fullYearModel.structureLanes[0]?.nodes[0]?.widthPercent, 100 / 364, 'a one-day project must not expand to multiple days to satisfy a visual minimum');

console.log('plan workbench checks passed');
