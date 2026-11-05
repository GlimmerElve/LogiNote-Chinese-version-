import { resolveNoteByTitleOrAlias } from '../../noteResolver';
import { collectProjectKnowledgeNotes, getChildProjectNotes, getLeafProjectNotesInScope, getLearningProjectNotesInScope, isLeafProjectNote } from '../../knowledgePointSelector';
import type {
  AgentPlanTaskChange,
  AgentPlanExecutionPatch,
  AgentPlanMetaPatch,
  AgentPlanMilestonePatch,
  AgentProjectStructurePatch,
  AgentProjectPlanNode,
  AgentProjectStudyTaskBatchInput,
  AgentProjectStudyTasksInput,
  AgentPortfolioPlanRootPatchInput,
} from '../types';
import type { DueDateItem, NoteItem, PlanMeta, PlanTaskBlueprint } from '../../../types';
import { registerTool } from '../toolRegistry';
import { isLearningProject } from '../../projectRole';
import { getActivePortfolioPlanRoots } from '../planDraftService';
import { buildLearningCapacity, cachedCapacitySettings, learningCapacitySummary } from '../../learningCapacity';
import type { VaultSettings } from '../../../types';
import { collectPlanResearch, checkPlanResearchCitations } from '../../planResearch';
import { assertGeneratedPlanCoreScope } from '../../planCoreScope';
import { rememberPlanResearch, readPlanResearch } from '../planResearchReceipts';

const OPERATIONS = new Set<AgentPlanTaskChange['operation']>(['add', 'reschedule', 'reprioritize']);
const PRIORITIES = new Set<NonNullable<AgentPlanTaskChange['priority']>>(['high', 'medium', 'low']);

function parseChange(args: Record<string, unknown>): AgentPlanTaskChange {
  const operation = String(args.operation || '') as AgentPlanTaskChange['operation'];
  if (!OPERATIONS.has(operation)) throw new Error(`不支持的计划操作：${operation}`);
  const priority = args.priority ? String(args.priority) as NonNullable<AgentPlanTaskChange['priority']> : undefined;
  if (priority && !PRIORITIES.has(priority)) throw new Error(`不支持的优先级：${priority}`);
  return {
    operation,
    noteTitle: String(args.noteTitle || ''),
    taskText: String(args.taskText || ''),
    dueDate: args.dueDate ? String(args.dueDate) : undefined,
    priority,
  };
}

function operationLabel(operation: AgentPlanTaskChange['operation']): string {
  if (operation === 'add') return '新增计划任务';
  if (operation === 'reschedule') return '调整任务日期';
  return '调整任务优先级';
}

function parseProjectNode(
  value: unknown,
  state: { count: number } = { count: 0 },
): AgentProjectPlanNode {
  state.count += 1;
  if (state.count > 60) throw new Error('项目计划一次最多创建 60 个节点');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('项目计划根节点格式无效');
  const raw = value as Record<string, unknown>;
  let children: AgentProjectPlanNode[] = [];
  if (raw.children !== undefined) {
    if (!Array.isArray(raw.children)) throw new Error('计划节点 children 必须是数组');
    children = raw.children.map((child) => parseProjectNode(child, state));
  }
  const rawMilestone = raw.milestone && typeof raw.milestone === 'object' && !Array.isArray(raw.milestone)
    ? raw.milestone as Record<string, unknown>
    : undefined;
  const tasks = Array.isArray(raw.tasks)
    ? raw.tasks.map((task, index) => parsePlanTaskBlueprint(task, index))
    : [];
  return {
    key: raw.key ? String(raw.key).trim() : undefined,
    title: String(raw.title || ''),
    startDate: raw.startDate ? String(raw.startDate) : undefined,
    dueDate: raw.dueDate ? String(raw.dueDate) : undefined,
    priority: raw.priority ? String(raw.priority) as AgentProjectPlanNode['priority'] : undefined,
    outcome: raw.outcome ? String(raw.outcome).trim() : undefined,
    estimatedMinutes: raw.estimatedMinutes === undefined ? undefined : Number(raw.estimatedMinutes),
    milestone: rawMilestone ? {
      id: String(rawMilestone.id || '').trim(),
      title: String(rawMilestone.title || '').trim(),
      dueDate: String(rawMilestone.dueDate || '').trim(),
      description: rawMilestone.description ? String(rawMilestone.description).trim() : undefined,
    } : undefined,
    tasks,
    children,
  };
}

function planTaskSchema(): Record<string, unknown> {
  return {
    type: 'object',
    required: ['key', 'text', 'kind', 'dueDate', 'estimatedMinutes'],
    properties: {
      key: { type: 'string' }, text: { type: 'string' },
      kind: { type: 'string', enum: ['learn', 'practice', 'review', 'assessment'] },
      startDate: { type: 'string', description: 'YYYY-MM-DD' }, dueDate: { type: 'string', description: 'YYYY-MM-DD' },
      estimatedMinutes: { type: 'number' }, priority: { type: 'string', enum: ['high', 'medium', 'low'] },
      capacityKind: { type: 'string', enum: ['additional', 'included'] },
      dependencyKeys: { type: 'array', items: { type: 'string' } }, milestoneId: { type: 'string' },
      executionKind: { type: 'string', enum: ['todo', 'flow', 'practice', 'review'] },
      recurrence: {
        type: 'object', required: ['frequency'],
        properties: {
          frequency: { type: 'string', enum: ['none', 'daily', 'weekdays', 'weekly', 'custom'] },
          interval: { type: 'number' }, weekdays: { type: 'array', items: { type: 'number' } },
          timeOfDay: { type: 'string' }, endDate: { type: 'string' },
          missedPolicy: { type: 'string', enum: ['skip', 'rollover', 'keep'] },
        },
        additionalProperties: false,
      },
      linkedProjectKey: { type: 'string' }, linkedKnowledgeIds: { type: 'array', items: { type: 'string' } },
      launchMode: { type: 'string', enum: ['none', 'flow', 'scene', 'review'] },
      reminderMinutes: { type: 'number' }, displayRow: { type: 'number' },
    },
    additionalProperties: false,
  };
}

function parsePlanTaskBlueprint(value: unknown, index: number): PlanTaskBlueprint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('执行事项格式无效');
  const raw = value as Record<string, any>;
  const frequency = raw.recurrence?.frequency;
  return {
    key: String(raw.key || `task-${index + 1}`).trim(),
    text: String(raw.text || '').trim(),
    kind: ['learn', 'practice', 'review', 'assessment'].includes(raw.kind) ? raw.kind : 'learn',
    startDate: raw.startDate ? String(raw.startDate) : undefined,
    dueDate: String(raw.dueDate || ''),
    estimatedMinutes: Number(raw.estimatedMinutes) || 60,
    capacityKind: raw.capacityKind === 'included' ? 'included' : 'additional',
    priority: ['high', 'medium', 'low'].includes(raw.priority) ? raw.priority : 'medium',
    dependencyKeys: Array.isArray(raw.dependencyKeys) ? raw.dependencyKeys.map(String) : [],
    milestoneId: raw.milestoneId ? String(raw.milestoneId) : undefined,
    executionKind: ['todo', 'flow', 'practice', 'review'].includes(raw.executionKind) ? raw.executionKind : undefined,
    recurrence: frequency && ['none', 'daily', 'weekdays', 'weekly', 'custom'].includes(frequency) ? {
      frequency,
      interval: raw.recurrence.interval === undefined ? undefined : Number(raw.recurrence.interval),
      weekdays: Array.isArray(raw.recurrence.weekdays) ? raw.recurrence.weekdays.map(Number) : undefined,
      timeOfDay: raw.recurrence.timeOfDay ? String(raw.recurrence.timeOfDay) : undefined,
      endDate: raw.recurrence.endDate ? String(raw.recurrence.endDate) : undefined,
      missedPolicy: ['skip', 'rollover', 'keep'].includes(raw.recurrence.missedPolicy) ? raw.recurrence.missedPolicy : 'rollover',
    } : undefined,
    linkedProjectKey: raw.linkedProjectKey ? String(raw.linkedProjectKey) : undefined,
    linkedKnowledgeIds: Array.isArray(raw.linkedKnowledgeIds) ? raw.linkedKnowledgeIds.map(String) : undefined,
    launchMode: ['none', 'flow', 'scene', 'review'].includes(raw.launchMode) ? raw.launchMode : undefined,
    reminderMinutes: raw.reminderMinutes === undefined ? undefined : Number(raw.reminderMinutes),
    displayRow: raw.displayRow === undefined ? undefined : Number(raw.displayRow),
    source: 'llm',
  };
}

function projectNodeSchema(depth = 0): Record<string, unknown> {
  const properties: Record<string, unknown> = {
    key: { type: 'string', description: '草案内唯一键' }, title: { type: 'string' },
    startDate: { type: 'string', description: '可选，YYYY-MM-DD；与 dueDate 同时存在时显示在结构轨道；若与 dueDate 相同，该节点必须是叶子' },
    dueDate: { type: 'string', description: '可选，YYYY-MM-DD；若与 startDate 相同，children 必须为空' },
    priority: { type: 'string', enum: ['high', 'medium', 'low'] },
    outcome: { type: 'string' },
    estimatedMinutes: { type: 'integer', minimum: 5, maximum: 1440, description: '可选叶子项目独立时长；默认继承每日投入' },
    milestone: {
      type: 'object', required: ['id', 'title', 'dueDate'],
      properties: { id: { type: 'string' }, title: { type: 'string' }, dueDate: { type: 'string' }, description: { type: 'string' } },
      additionalProperties: false,
    },
    tasks: { type: 'array', maxItems: 12, items: planTaskSchema() },
  };
  properties.children = depth < 7
    ? { type: 'array', items: projectNodeSchema(depth + 1), maxItems: 30 }
    : { type: 'array', items: { type: 'object', description: '更深层项目，字段与上层相同' }, maxItems: 30 };
  return { type: 'object', required: ['title'], properties, additionalProperties: false };
}

function parsePlanMeta(value: unknown): Partial<PlanMeta> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('planMeta 格式无效');
  const raw = value as Record<string, any>;
  return {
    schemaVersion: 2,
    status: ['draft', 'active', 'paused', 'completed', 'archived'].includes(raw.status) ? raw.status : 'active',
    shortTitle: raw.shortTitle ? String(raw.shortTitle) : undefined,
    summary: raw.summary ? String(raw.summary) : undefined,
    startDate: raw.startDate ? String(raw.startDate) : undefined,
    targetDate: raw.targetDate ? String(raw.targetDate) : undefined,
    weeklyBudgetMinutes: raw.weeklyBudgetMinutes === undefined ? undefined : Number(raw.weeklyBudgetMinutes),
    dailyStudyMinutes: raw.dailyStudyMinutes === undefined ? undefined : Number(raw.dailyStudyMinutes),
    activeWeekdays: Array.isArray(raw.activeWeekdays) ? raw.activeWeekdays.map(Number) : undefined,
    portfolioPriority: ['high', 'medium', 'low'].includes(raw.portfolioPriority) ? raw.portfolioPriority : undefined,
    autoAdjustPolicy: ['ask', 'automatic', 'off'].includes(raw.autoAdjustPolicy) ? raw.autoAdjustPolicy : undefined,
    conditions: raw.conditions && typeof raw.conditions === 'object' ? raw.conditions : undefined,
    milestones: Array.isArray(raw.milestones) ? raw.milestones.map((item: any) => ({
      id: String(item?.id || ''), title: String(item?.title || ''), dueDate: String(item?.dueDate || ''),
      criteria: Array.isArray(item?.criteria) ? item.criteria.map(String) : undefined,
      projectId: item?.projectId ? String(item.projectId) : undefined,
      completed: false,
    })) : undefined,
  };
}

function planMetaSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      status: { type: 'string', enum: ['draft', 'active', 'paused', 'completed', 'archived'] },
      shortTitle: { type: 'string' }, summary: { type: 'string' },
      startDate: { type: 'string' }, targetDate: { type: 'string' }, dailyStudyMinutes: { type: 'integer', minimum: 5, maximum: 1440 },
      activeWeekdays: { type: 'array', items: { type: 'number' } },
      portfolioPriority: { type: 'string', enum: ['high', 'medium', 'low'] },
      autoAdjustPolicy: { type: 'string', enum: ['ask', 'automatic', 'off'] },
      conditions: planConditionsSchema(),
      milestones: {
        type: 'array', items: {
          type: 'object', required: ['id', 'title', 'dueDate'],
          properties: {
            id: { type: 'string' }, title: { type: 'string' }, dueDate: { type: 'string' },
            criteria: { type: 'array', items: { type: 'string' } }, projectId: { type: 'string', description: '引用项目 key' },
          }, additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  };
}

function summarizeDraft(root: AgentProjectPlanNode): { count: number; scheduled: number; tasks: number; milestones: number; titles: string[] } {
  let count = 0;
  let scheduled = 0;
  let tasks = 0;
  let milestones = 0;
  const titles: string[] = [];
  const visit = (node: AgentProjectPlanNode) => {
    count += 1;
    if (node.dueDate) scheduled += 1;
    tasks += node.tasks?.length || 0;
    if (node.milestone) milestones += 1;
    if (titles.length < 5) titles.push(node.title);
    (node.children || []).forEach(visit);
  };
  visit(root);
  return { count, scheduled, tasks, milestones, titles };
}

function parseStudyTasksInput(args: Record<string, unknown>): AgentProjectStudyTasksInput {
  if (!Array.isArray(args.tasks)) throw new Error('tasks 必须是数组');
  const tasks = args.tasks.map((task) => String(task || '').trim());
  if (tasks.length < 1 || tasks.length > 7) throw new Error('一次必须提交 1 至 7 条学习任务');
  return { projectTitle: String(args.projectTitle || '').trim(), tasks };
}

function parseStudyTaskBatchInput(args: Record<string, unknown>): AgentProjectStudyTaskBatchInput {
  if (!Array.isArray(args.projects)) throw new Error('projects 必须是数组');
  if (!Array.isArray(args.createKnowledgeNotes)) throw new Error('createKnowledgeNotes 必须是数组');
  if (args.projects.length < 1 || args.projects.length > 5) throw new Error('一个批次必须包含 1 至 5 个末级项目');
  return {
    rootProjectTitle: String(args.rootProjectTitle || '').trim(),
    projects: args.projects.map((project) => {
      if (!project || typeof project !== 'object' || Array.isArray(project)) throw new Error('项目任务格式无效');
      return parseStudyTasksInput(project as Record<string, unknown>);
    }),
    createKnowledgeNotes: args.createKnowledgeNotes.map((title) => String(title || '').trim()),
  };
}

function parseDraftBatchInput(args: Record<string, unknown>) {
  return parseStudyTaskBatchInput({
    rootProjectTitle: '__draft_scope__',
    projects: args.projects,
    createKnowledgeNotes: args.createKnowledgeNotes,
  });
}

function parseStructurePatches(args: Record<string, unknown>): AgentProjectStructurePatch[] {
  if (!Array.isArray(args.patches) || args.patches.length < 1 || args.patches.length > 20) {
    throw new Error('patches 必须包含 1 至 20 个结构补丁');
  }
  const operations = new Set<AgentProjectStructurePatch['operation']>(['update', 'add_child', 'move', 'delete_subtree']);
  return args.patches.map((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('结构补丁格式无效');
    const patch = raw as Record<string, unknown>;
    const operation = String(patch.operation || '') as AgentProjectStructurePatch['operation'];
    if (!operations.has(operation)) throw new Error(`不支持的结构补丁：${operation}`);
    const priority = patch.priority ? String(patch.priority) as AgentProjectStructurePatch['priority'] : undefined;
    if (priority && !PRIORITIES.has(priority)) throw new Error(`不支持的优先级：${priority}`);
    return {
      operation,
      projectTitle: patch.projectTitle ? String(patch.projectTitle).trim() : undefined,
      parentProjectTitle: patch.parentProjectTitle ? String(patch.parentProjectTitle).trim() : undefined,
      newParentProjectTitle: patch.newParentProjectTitle ? String(patch.newParentProjectTitle).trim() : undefined,
      title: patch.title ? String(patch.title).trim() : undefined,
      startDate: patch.startDate ? String(patch.startDate).trim() : undefined,
      dueDate: patch.dueDate ? String(patch.dueDate).trim() : undefined,
      clearStartDate: patch.clearStartDate === true,
      clearDueDate: patch.clearDueDate === true,
      priority,
    };
  });
}

function structurePatchLabel(patch: AgentProjectStructurePatch): string {
  if (patch.operation === 'add_child') return `新增：“${patch.parentProjectTitle}” → “${patch.title}”`;
  if (patch.operation === 'move') return `移动：“${patch.projectTitle}” → “${patch.newParentProjectTitle}”`;
  if (patch.operation === 'delete_subtree') return `删除子树：“${patch.projectTitle}”`;
  const changes = [patch.title ? `标题→“${patch.title}”` : '', patch.startDate ? `开始→${patch.startDate}` : '', patch.dueDate ? `结束→${patch.dueDate}` : '', patch.clearStartDate ? '清除开始日期' : '', patch.clearDueDate ? '清除项目时间范围' : '', patch.priority ? `优先级→${patch.priority}` : ''].filter(Boolean);
  return `更新：“${patch.projectTitle}”${changes.length ? `（${changes.join('，')}）` : ''}`;
}

function parsePlanMetaPatch(args: Record<string, unknown>): AgentPlanMetaPatch {
  const raw = args.patch;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('patch 必须是计划设置对象');
  const patch = raw as Record<string, any>;
  if (patch.weeklyBudgetMinutes !== undefined) throw new Error('周预算已迁移为个人共享容量，请用 update_learning_capacity 确认修改；不能修改单个计划的旧预算');
  const parsed: AgentPlanMetaPatch = {
    status: ['draft', 'active', 'paused', 'completed', 'archived'].includes(patch.status) ? patch.status : undefined,
    shortTitle: patch.shortTitle === undefined ? undefined : String(patch.shortTitle).trim(),
    summary: patch.summary === undefined ? undefined : String(patch.summary).trim(),
    startDate: patch.startDate === undefined ? undefined : String(patch.startDate),
    targetDate: patch.targetDate === undefined ? undefined : String(patch.targetDate),
    weeklyBudgetMinutes: patch.weeklyBudgetMinutes === undefined ? undefined : Number(patch.weeklyBudgetMinutes),
    dailyStudyMinutes: patch.dailyStudyMinutes === undefined ? undefined : Number(patch.dailyStudyMinutes),
    activeWeekdays: Array.isArray(patch.activeWeekdays) ? patch.activeWeekdays.map(Number) : undefined,
    portfolioPriority: ['high', 'medium', 'low'].includes(patch.portfolioPriority) ? patch.portfolioPriority : undefined,
    autoAdjustPolicy: ['ask', 'automatic', 'off'].includes(patch.autoAdjustPolicy) ? patch.autoAdjustPolicy : undefined,
    conditions: patch.conditions && typeof patch.conditions === 'object' && !Array.isArray(patch.conditions) ? patch.conditions : undefined,
  };
  return Object.fromEntries(Object.entries(parsed).filter(([, value]) => value !== undefined)) as AgentPlanMetaPatch;
}

function planConditionsSchema(): Record<string, unknown> {
  return {
    type: 'object',
    properties: {
      goalEvidence: { type: 'string' },
      startingLevel: { type: 'string', enum: ['new', 'basic', 'intermediate', 'advanced'] },
      pace: { type: 'string', enum: ['relaxed', 'balanced', 'intensive'] },
      preferredSessionMinutes: { type: 'number' },
      preferredTimeOfDay: { type: 'string', enum: ['morning', 'afternoon', 'evening', 'flexible'] },
      deadlineMode: { type: 'string', enum: ['hard', 'flexible'] },
      reviewCadence: { type: 'string', enum: ['light', 'standard', 'intensive'] },
      constraintNotes: { type: 'string' },
    },
    additionalProperties: false,
  };
}

function parseMilestonePatches(args: Record<string, unknown>): AgentPlanMilestonePatch[] {
  if (!Array.isArray(args.patches) || args.patches.length < 1 || args.patches.length > 20) throw new Error('patches 必须包含 1 至 20 个里程碑补丁');
  return args.patches.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('里程碑补丁格式无效');
    const raw = value as Record<string, any>;
    const operation = String(raw.operation || '') as AgentPlanMilestonePatch['operation'];
    if (!['add', 'update', 'delete'].includes(operation)) throw new Error(`不支持的里程碑操作：${operation}`);
    return {
      operation,
      milestoneId: String(raw.milestoneId || '').trim(),
      title: raw.title === undefined ? undefined : String(raw.title).trim(),
      dueDate: raw.dueDate === undefined ? undefined : String(raw.dueDate),
      criteria: Array.isArray(raw.criteria) ? raw.criteria.map((item: unknown) => String(item).trim()) : undefined,
      projectTitle: raw.projectTitle === undefined ? undefined : String(raw.projectTitle).trim(),
      clearCriteria: raw.clearCriteria === true,
      clearProject: raw.clearProject === true,
    };
  });
}

function parseExecutionPatches(args: Record<string, unknown>): AgentPlanExecutionPatch[] {
  if (!Array.isArray(args.patches) || args.patches.length < 1 || args.patches.length > 20) throw new Error('patches 必须包含 1 至 20 个执行事项补丁');
  return args.patches.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('执行事项补丁格式无效');
    const raw = value as Record<string, any>;
    const operation = String(raw.operation || '') as AgentPlanExecutionPatch['operation'];
    if (!['add', 'update', 'delete'].includes(operation)) throw new Error(`不支持的执行事项操作：${operation}`);
    const recurrence = raw.recurrence && typeof raw.recurrence === 'object' && !Array.isArray(raw.recurrence)
      ? {
        frequency: raw.recurrence.frequency,
        interval: raw.recurrence.interval === undefined ? undefined : Number(raw.recurrence.interval),
        weekdays: Array.isArray(raw.recurrence.weekdays) ? raw.recurrence.weekdays.map(Number) : undefined,
        timeOfDay: raw.recurrence.timeOfDay === undefined ? undefined : String(raw.recurrence.timeOfDay),
        endDate: raw.recurrence.endDate === undefined ? undefined : String(raw.recurrence.endDate),
        missedPolicy: raw.recurrence.missedPolicy,
      }
      : undefined;
    return {
      operation,
      taskId: String(raw.taskId || '').trim(),
      noteTitle: raw.noteTitle === undefined ? undefined : String(raw.noteTitle).trim(),
      taskText: raw.taskText === undefined ? undefined : String(raw.taskText).trim(),
      kind: ['learn', 'practice', 'review', 'assessment'].includes(raw.kind) ? raw.kind : undefined,
      executionKind: ['todo', 'flow', 'practice', 'review'].includes(raw.executionKind) ? raw.executionKind : undefined,
      startDate: raw.startDate === undefined ? undefined : String(raw.startDate),
      dueDate: raw.dueDate === undefined ? undefined : String(raw.dueDate),
      estimatedMinutes: raw.estimatedMinutes === undefined ? undefined : Number(raw.estimatedMinutes),
      priority: ['high', 'medium', 'low'].includes(raw.priority) ? raw.priority : undefined,
      recurrence: recurrence as AgentPlanExecutionPatch['recurrence'],
      milestoneId: raw.milestoneId === undefined ? undefined : String(raw.milestoneId),
      linkedProjectTitle: raw.linkedProjectTitle === undefined ? undefined : String(raw.linkedProjectTitle).trim(),
      linkedKnowledgeTitles: Array.isArray(raw.linkedKnowledgeTitles) ? raw.linkedKnowledgeTitles.map(String) : undefined,
      launchMode: ['none', 'flow', 'scene', 'review'].includes(raw.launchMode) ? raw.launchMode : undefined,
      reminderMinutes: raw.reminderMinutes === undefined ? undefined : Number(raw.reminderMinutes),
      clearRecurrence: raw.clearRecurrence === true,
      clearMilestone: raw.clearMilestone === true,
      clearLinkedProject: raw.clearLinkedProject === true,
      clearLinkedKnowledge: raw.clearLinkedKnowledge === true,
    };
  });
}

function recurrenceSchema(): Record<string, unknown> {
  return planTaskSchema().properties
    ? (planTaskSchema().properties as Record<string, unknown>).recurrence as Record<string, unknown>
    : { type: 'object' };
}

function dayNumber(value: string | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) ? Math.floor(parsed / 86400000) : null;
}

function dateFromDay(day: number): string {
  return new Date(day * 86400000).toISOString().slice(0, 10);
}

function currentWeekStartDay(now = new Date()): number {
  const today = Math.floor(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / 86400000);
  const weekday = new Date(today * 86400000).getUTCDay();
  return today - ((weekday + 6) % 7);
}

function isProjectDeadline(note: NoteItem, task: DueDateItem): boolean {
  return task.taskText.trim() === note.title.trim();
}

function occurrenceDatesInWeek(task: DueDateItem, weekStartDay: number): string[] {
  if (task.completed && (!task.recurrence || task.recurrence.frequency === 'none')) return [];
  const baseDay = dayNumber(task.startDate || task.dueDate);
  if (baseDay === null) return [];
  const endDay = dayNumber(task.recurrence?.endDate);
  const completed = new Set(task.completedOccurrenceDates || []);
  const frequency = task.recurrence?.frequency || 'none';
  const interval = Math.max(1, Math.floor(task.recurrence?.interval || 1));
  const dates: string[] = [];
  for (let day = weekStartDay; day <= weekStartDay + 6; day += 1) {
    if (day < baseDay || (endDay !== null && day > endDay)) continue;
    let matches = false;
    if (frequency === 'none') matches = day === dayNumber(task.dueDate);
    else if (frequency === 'daily') matches = (day - baseDay) % interval === 0;
    else if (frequency === 'weekdays') {
      const weekday = new Date(day * 86400000).getUTCDay();
      matches = weekday >= 1 && weekday <= 5 && Math.floor((day - baseDay) / 7) % interval === 0;
    } else {
      const baseWeekday = new Date(baseDay * 86400000).getUTCDay();
      const weekdays = task.recurrence?.weekdays?.length ? task.recurrence.weekdays : [baseWeekday];
      const weekday = new Date(day * 86400000).getUTCDay();
      matches = weekdays.includes(weekday) && Math.floor((day - baseDay) / 7) % interval === 0;
    }
    const date = dateFromDay(day);
    if (matches && !completed.has(date)) dates.push(date);
  }
  return dates;
}

function serializePlanRoot(root: NoteItem, notes: NoteItem[], weekStartDay: number, settings: Partial<VaultSettings> = cachedCapacitySettings()) {
  const projects = notes.filter(isLearningProject);
  const byId = new Map(projects.map((note) => [note.id, note]));
  const scope = getLearningProjectNotesInScope(root.id, notes);
  const rows = scope.map((note) => {
    const deadline = note.dueDates.find((item) => isProjectDeadline(note, item));
    return {
      projectId: note.id,
      title: note.title,
      outcome: note.planOutcome ?? root.planMeta?.phaseWindows?.find(phase => phase.projectId === note.id)?.outcome,
      parentProjectId: note.parentId,
      parentProjectTitle: note.parentId ? byId.get(note.parentId)?.title : undefined,
      revision: note.updatedAt,
      startDate: deadline?.startDate,
      dueDate: deadline?.dueDate,
      completed: deadline?.completed,
      priority: deadline?.priority,
      scheduled: Boolean(deadline),
      executionItems: note.dueDates.filter((item) => item !== deadline).map((item) => ({
        id: item.id, taskText: item.taskText, kind: item.kind, executionKind: item.executionKind,
        startDate: item.startDate, dueDate: item.dueDate, estimatedMinutes: item.estimatedMinutes,
        priority: item.priority, completed: item.completed, recurrence: item.recurrence,
        milestoneId: item.milestoneId, linkedProjectId: item.linkedProjectId,
        linkedKnowledgeIds: item.linkedKnowledgeIds, launchMode: item.launchMode,
        occurrenceDates: occurrenceDatesInWeek(item, weekStartDay),
      })),
    };
  });
  const weeklyOccurrences = rows.flatMap((project) => project.executionItems.flatMap((task) => (
    task.occurrenceDates.map((date) => ({
      rootProjectId: root.id,
      rootProjectTitle: root.title,
      projectId: project.projectId,
      projectTitle: project.title,
      taskId: task.id,
      taskText: task.taskText,
      date,
      estimatedMinutes: Math.max(1, task.estimatedMinutes || 60),
    }))
  )));
  const capacity = buildLearningCapacity(notes, dateFromDay(weekStartDay), settings);
  const weeklyScheduledMinutes = capacity.byRoot.find(r => r.rootId === root.id)?.scheduledMinutes || 0;
  const weeklyBudgetMinutes = capacity.budgetMinutes;
  return {
    rootProjectId: root.id,
    rootProjectTitle: root.title,
    rootRevision: root.updatedAt,
    planMeta: root.planMeta,
    projects: rows,
    milestones: (root.planMeta?.milestones || []).map((milestone) => ({
      ...milestone,
      projectTitle: milestone.projectId ? byId.get(milestone.projectId)?.title : undefined,
    })),
    weeklyLoad: {
      weekStart: dateFromDay(weekStartDay),
      weekEnd: dateFromDay(weekStartDay + 6),
      scheduledMinutes: weeklyScheduledMinutes,
      budgetMinutes: weeklyBudgetMinutes,
      percent: weeklyBudgetMinutes === null ? null : Math.round((weeklyScheduledMinutes / weeklyBudgetMinutes) * 100),
      personalCapacity: { scheduledMinutes: capacity.scheduledMinutes, budgetMinutes: capacity.budgetMinutes, percent: capacity.percent, remainingMinutes: capacity.remainingMinutes, estimatedCount: capacity.estimatedCount },
    },
    weeklyOccurrences,
    counts: {
      projects: rows.length,
      scheduledProjects: rows.filter((item) => item.scheduled).length,
      milestones: root.planMeta?.milestones?.length || 0,
      executionItems: rows.reduce((sum, item) => sum + item.executionItems.length, 0),
    },
  };
}

function parsePortfolioRootPatches(args: Record<string, unknown>): AgentPortfolioPlanRootPatchInput[] {
  if (!Array.isArray(args.roots) || args.roots.length < 1 || args.roots.length > 20) {
    throw new Error('roots 必须包含 1 至 20 个根计划补丁');
  }
  return args.roots.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('根计划补丁格式无效');
    const raw = value as Record<string, unknown>;
    const rootProjectId = String(raw.rootProjectId || '').trim();
    if (!rootProjectId) throw new Error('根计划补丁必须提供 rootProjectId');
    const structurePatches = raw.structurePatches === undefined
      ? undefined
      : parseStructurePatches({ patches: raw.structurePatches });
    const parsedPlanMetaPatch = raw.planMetaPatch === undefined
      ? undefined
      : parsePlanMetaPatch({ patch: raw.planMetaPatch });
    const planMetaPatch = parsedPlanMetaPatch && Object.keys(parsedPlanMetaPatch).length > 0
      ? parsedPlanMetaPatch
      : undefined;
    const milestonePatches = raw.milestonePatches === undefined
      ? undefined
      : parseMilestonePatches({ patches: raw.milestonePatches });
    const executionPatches = raw.executionPatches === undefined
      ? undefined
      : parseExecutionPatches({ patches: raw.executionPatches });
    if (!structurePatches?.length && !planMetaPatch && !milestonePatches?.length && !executionPatches?.length) {
      throw new Error(`计划根 ${rootProjectId} 的组合补丁为空`);
    }
    return { rootProjectId, structurePatches, planMetaPatch, milestonePatches, executionPatches };
  });
}

export function registerPlanTools(): void {
  registerTool({
    name: 'research_learning_plan',
    description: '为学习规划检索公开课程大纲、先修和学习目标并读取网页节选。不搜索私人笔记/画像，不下载或绑定资源。只传公开主题（最多120字）；使用配置的搜索API时可能产生供应商费用，不支持时尝试隔离网页检索。返回真实来源和 researchId，规划完成时传给 create_project_plan。失败须报告或重试，不能假装已联网。',
    parameters: { type: 'object', required: ['subject'], properties: { subject: { type: 'string', minLength: 1, maxLength: 120, description: '公开学科/技能名，不含私人经历、画像、认知库或笔记内容' } }, additionalProperties: false },
    location: 'renderer', permission: 'readonly',
    execute: async (args, ctx, execution) => {
      const bundle = await collectPlanResearch(String(args.subject || ''), execution?.signal);
      execution?.signal?.throwIfAborted();
      return { researchId: rememberPlanResearch(ctx, bundle), ...bundle };
    },
  });
  registerTool({
    name: 'start_plan_portfolio_draft',
    description: '按 query_plan_portfolio 返回的稳定根 ID 开始一个精确范围的组合草案。允许更新各根内部项目日期/优先级、预算、里程碑和执行事项，禁止新增/删除/跨根移动结构项目。',
    parameters: {
      type: 'object', required: ['rootProjectIds'], properties: {
        rootProjectIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1 }, description: 'query_plan_portfolio 返回的稳定根项目 ID 集合' },
      }, additionalProperties: false,
    },
    location: 'renderer',
    permission: 'navigation',
    execute: (args, ctx) => {
      const rootProjectIds = Array.isArray(args.rootProjectIds)
        ? args.rootProjectIds.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
      if (!rootProjectIds.length) throw new Error('组合草案必须提供至少一个有效的根项目 ID');
      return ctx.startPlanDraftSession({
        scopeKind: 'portfolio',
        rootProjectIds,
        mode: 'revise-subtree',
        purpose: 'plan-layout',
      });
    },
  });

  registerTool({
    name: 'start_project_task_draft',
    description: '开始一个计划结构或学习任务草案会话并锁定项目范围。scopeProjectTitle 省略时使用界面当前选中的项目。',
    parameters: {
      type: 'object', required: ['mode', 'purpose'],
      properties: {
        scopeProjectTitle: { type: 'string', description: '可选，要锁定的根项目或局部板块标题' },
        mode: { type: 'string', enum: ['full-task-generation', 'revise-subtree'] },
        purpose: { type: 'string', enum: ['structure', 'study-tasks', 'plan-layout'], description: '项目结构、末级学习任务，或计划条件/里程碑/执行轨道修订' },
      },
      additionalProperties: false,
    },
    location: 'renderer',
    permission: 'navigation',
    execute: (args, ctx) => ctx.startPlanDraftSession({
      scopeProjectTitle: args.scopeProjectTitle ? String(args.scopeProjectTitle).trim() : undefined,
      mode: args.mode === 'revise-subtree' ? 'revise-subtree' : 'full-task-generation',
      purpose: args.purpose === 'structure' ? 'structure' : args.purpose === 'plan-layout' ? 'plan-layout' : 'study-tasks',
    }),
  });

  registerTool({
    name: 'query_project_task_draft',
    description: '查看当前草案锁定范围、已暂存项目数、任务数和待创建知识点。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    location: 'renderer',
    permission: 'readonly',
    execute: (_args, ctx) => {
      const session = ctx.getPlanDraftSession();
      if (!session) return { active: false };
      return {
        active: true,
        sessionId: session.id,
        scopeKind: session.scopeKind || 'root',
        mode: session.mode,
        purpose: session.purpose,
        scopeProjectTitle: session.scopeProjectTitle,
        projectCount: session.projects.length,
        taskCount: session.projects.reduce((sum, project) => sum + project.tasks.length, 0),
        createKnowledgeNotes: session.createKnowledgeNotes,
        projects: session.projects,
        structurePatches: session.structurePatches,
        planMetaPatch: session.planMetaPatch,
        milestonePatches: session.milestonePatches || [],
        executionPatches: session.executionPatches || [],
        portfolioRoots: session.scopeKind === 'portfolio'
          ? Object.values(session.portfolioRoots || {}).map((root) => ({
            rootProjectId: root.rootProjectId,
            rootProjectTitle: root.rootProjectTitle,
            structurePatches: root.structurePatches,
            planMetaPatch: root.planMetaPatch,
            milestonePatches: root.milestonePatches,
            executionPatches: root.executionPatches,
          }))
          : undefined,
      };
    },
  });

  registerTool({
    name: 'stage_project_study_task_batch',
    description: '向当前草案暂存 1 至 5 个末级项目的任务，不立即写入笔记。同一项目再次暂存会只替换该项目草案，不影响其他草案项目。',
    parameters: {
      type: 'object', required: ['projects', 'createKnowledgeNotes'],
      properties: {
        projects: {
          type: 'array', minItems: 1, maxItems: 5,
          items: {
            type: 'object', required: ['projectTitle', 'tasks'],
            properties: {
              projectTitle: { type: 'string' },
              tasks: { type: 'array', minItems: 1, maxItems: 7, items: { type: 'string' } },
            },
            additionalProperties: false,
          },
        },
        createKnowledgeNotes: { type: 'array', maxItems: 30, items: { type: 'string' } },
      },
      additionalProperties: false,
    },
    location: 'renderer',
    permission: 'navigation',
    execute: (args, ctx) => {
      const input = parseDraftBatchInput(args);
      return ctx.stagePlanDraftBatch({ projects: input.projects, createKnowledgeNotes: input.createKnowledgeNotes });
    },
  });

  registerTool({
    name: 'stage_project_structure_patches',
    description: '向当前范围锁草案暂存项目结构补丁，不立即写入。支持更新项目、添加子项目、范围内移动和删除子树；拆分或合并应组合这些操作。',
    parameters: {
      type: 'object', required: ['patches'],
      properties: {
        patches: {
          type: 'array', minItems: 1, maxItems: 20,
          items: {
            type: 'object', required: ['operation'],
            properties: {
              operation: { type: 'string', enum: ['update', 'add_child', 'move', 'delete_subtree'] },
              projectTitle: { type: 'string', description: 'update/move/delete_subtree 的已有项目标题' },
              parentProjectTitle: { type: 'string', description: 'add_child 的父项目标题' },
              newParentProjectTitle: { type: 'string', description: 'move 的新父项目标题' },
              title: { type: 'string', description: 'update 的新标题或 add_child 的新项目标题' },
              startDate: { type: 'string', description: 'update/add_child 可选，YYYY-MM-DD' },
              dueDate: { type: 'string', description: 'update/add_child 可选，YYYY-MM-DD' },
              clearStartDate: { type: 'boolean', description: 'update 时只清除时间起点' },
              clearDueDate: { type: 'boolean', description: 'update 时清除整个项目时间范围' },
              priority: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    location: 'renderer',
    permission: 'navigation',
    execute: (args, ctx) => ctx.stagePlanStructurePatches(parseStructurePatches(args)),
  });

  registerTool({
    name: 'stage_plan_settings_patch',
    description: '向当前根计划草案暂存计划条件和节奏设置，不立即写入。只修改明确提供的字段。',
    parameters: {
      type: 'object', required: ['patch'],
      properties: {
        patch: {
          type: 'object',
          properties: {
            status: { type: 'string', enum: ['draft', 'active', 'paused', 'completed', 'archived'] },
            shortTitle: { type: 'string' }, summary: { type: 'string' },
            startDate: { type: 'string' }, targetDate: { type: 'string' },
            dailyStudyMinutes: { type: 'integer', minimum: 5, maximum: 1440 }, activeWeekdays: { type: 'array', items: { type: 'number' } },
            portfolioPriority: { type: 'string', enum: ['high', 'medium', 'low'] },
            autoAdjustPolicy: { type: 'string', enum: ['ask', 'automatic', 'off'] },
            conditions: planConditionsSchema(),
          }, additionalProperties: false,
        },
      }, additionalProperties: false,
    },
    location: 'renderer', permission: 'navigation',
    execute: (args, ctx) => ctx.stagePlanMetaPatch(parsePlanMetaPatch(args)),
  });

  registerTool({
    name: 'stage_plan_milestone_patches',
    description: '向当前根计划草案暂存里程碑新增、修改或删除。不能修改完成状态；完成与撤销完成只能由用户在里程碑详情中操作。',
    parameters: {
      type: 'object', required: ['patches'], properties: {
        patches: { type: 'array', minItems: 1, maxItems: 20, items: {
          type: 'object', required: ['operation', 'milestoneId'], properties: {
            operation: { type: 'string', enum: ['add', 'update', 'delete'] }, milestoneId: { type: 'string' },
            title: { type: 'string' }, dueDate: { type: 'string' }, criteria: { type: 'array', items: { type: 'string' } },
            projectTitle: { type: 'string' }, clearCriteria: { type: 'boolean' }, clearProject: { type: 'boolean' },
          }, additionalProperties: false,
        } },
      }, additionalProperties: false,
    },
    location: 'renderer', permission: 'navigation',
    execute: (args, ctx) => ctx.stagePlanMilestonePatches(parseMilestonePatches(args)),
  });

  registerTool({
    name: 'stage_plan_execution_patches',
    description: '向当前根计划草案暂存执行轨道事项的新增、修改或删除。执行事项是独立提醒/活动，不创建项目笔记；修改和删除时使用 query_plan_workspace 返回的 taskId。',
    parameters: {
      type: 'object', required: ['patches'], properties: {
        patches: { type: 'array', minItems: 1, maxItems: 20, items: {
          type: 'object', required: ['operation', 'taskId'], properties: {
            operation: { type: 'string', enum: ['add', 'update', 'delete'] }, taskId: { type: 'string' },
            noteTitle: { type: 'string' }, taskText: { type: 'string' },
            kind: { type: 'string', enum: ['learn', 'practice', 'review', 'assessment'] },
            executionKind: { type: 'string', enum: ['todo', 'flow', 'practice', 'review'] },
            startDate: { type: 'string' }, dueDate: { type: 'string' }, estimatedMinutes: { type: 'number' },
            priority: { type: 'string', enum: ['high', 'medium', 'low'] }, recurrence: recurrenceSchema(),
            milestoneId: { type: 'string' }, linkedProjectTitle: { type: 'string' },
            linkedKnowledgeTitles: { type: 'array', items: { type: 'string' } },
            launchMode: { type: 'string', enum: ['none', 'flow', 'scene', 'review'] }, reminderMinutes: { type: 'number' },
            clearRecurrence: { type: 'boolean' }, clearMilestone: { type: 'boolean' },
            clearLinkedProject: { type: 'boolean' }, clearLinkedKnowledge: { type: 'boolean' },
          }, additionalProperties: false,
        } },
      }, additionalProperties: false,
    },
    location: 'renderer', permission: 'navigation',
    execute: (args, ctx) => ctx.stagePlanExecutionPatches(parseExecutionPatches(args)),
  });

  registerTool({
    name: 'stage_plan_portfolio_patches',
    description: '按 query_plan_portfolio 返回的稳定 rootProjectId，在一个组合草案中暂存多个根计划的结构日期/优先级、设置、里程碑和执行事项变更。结构补丁仅允许更新根内既有项目，不得新增、删除、重命名或跨根移动；本工具不会立即写入。',
    parameters: {
      type: 'object', required: ['roots'], properties: {
        roots: { type: 'array', minItems: 1, maxItems: 20, items: {
          type: 'object', required: ['rootProjectId'], properties: {
            rootProjectId: { type: 'string', description: 'query_plan_portfolio 返回的稳定根项目 ID' },
            structurePatches: { type: 'array', minItems: 1, maxItems: 20, description: '仅更新该根内部既有项目的时间或优先级，不改变父子结构', items: {
              type: 'object', required: ['operation', 'projectTitle'], properties: {
                operation: { type: 'string', enum: ['update'] },
                projectTitle: { type: 'string' },
                startDate: { type: 'string', description: 'YYYY-MM-DD' },
                dueDate: { type: 'string', description: 'YYYY-MM-DD' },
                clearStartDate: { type: 'boolean' },
                clearDueDate: { type: 'boolean' },
                priority: { type: 'string', enum: ['high', 'medium', 'low'] },
              }, additionalProperties: false,
            } },
            planMetaPatch: { type: 'object', properties: {
              status: { type: 'string', enum: ['draft', 'active', 'paused', 'completed', 'archived'] },
              shortTitle: { type: 'string' }, summary: { type: 'string' },
              startDate: { type: 'string' }, targetDate: { type: 'string' },
              dailyStudyMinutes: { type: 'integer', minimum: 5, maximum: 1440 }, activeWeekdays: { type: 'array', items: { type: 'number' } },
              portfolioPriority: { type: 'string', enum: ['high', 'medium', 'low'] },
              autoAdjustPolicy: { type: 'string', enum: ['ask', 'automatic', 'off'] },
              conditions: planConditionsSchema(),
            }, additionalProperties: false },
            milestonePatches: { type: 'array', minItems: 1, maxItems: 20, items: {
              type: 'object', required: ['operation', 'milestoneId'], properties: {
                operation: { type: 'string', enum: ['add', 'update', 'delete'] }, milestoneId: { type: 'string' },
                title: { type: 'string' }, dueDate: { type: 'string' }, criteria: { type: 'array', items: { type: 'string' } },
                projectTitle: { type: 'string' }, clearCriteria: { type: 'boolean' }, clearProject: { type: 'boolean' },
              }, additionalProperties: false,
            } },
            executionPatches: { type: 'array', minItems: 1, maxItems: 20, items: {
              type: 'object', required: ['operation', 'taskId'], properties: {
                operation: { type: 'string', enum: ['add', 'update', 'delete'] }, taskId: { type: 'string' },
                noteTitle: { type: 'string' }, taskText: { type: 'string' },
                kind: { type: 'string', enum: ['learn', 'practice', 'review', 'assessment'] },
                executionKind: { type: 'string', enum: ['todo', 'flow', 'practice', 'review'] },
                startDate: { type: 'string' }, dueDate: { type: 'string' }, estimatedMinutes: { type: 'number' },
                priority: { type: 'string', enum: ['high', 'medium', 'low'] }, recurrence: recurrenceSchema(),
                milestoneId: { type: 'string' }, linkedProjectTitle: { type: 'string' },
                linkedKnowledgeTitles: { type: 'array', items: { type: 'string' } },
                launchMode: { type: 'string', enum: ['none', 'flow', 'scene', 'review'] }, reminderMinutes: { type: 'number' },
                clearRecurrence: { type: 'boolean' }, clearMilestone: { type: 'boolean' },
                clearLinkedProject: { type: 'boolean' }, clearLinkedKnowledge: { type: 'boolean' },
              }, additionalProperties: false,
            } },
          }, additionalProperties: false,
        } },
      }, additionalProperties: false,
    },
    location: 'renderer', permission: 'navigation',
    execute: (args, ctx) => ctx.stagePortfolioPlanPatches({ roots: parsePortfolioRootPatches(args) }),
  });

  registerTool({
    name: 'discard_project_task_draft',
    description: '放弃当前尚未写入笔记的学习任务草案。仅在用户明确要求取消或切换范围时调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    location: 'renderer',
    permission: 'navigation',
    execute: (_args, ctx) => ctx.discardPlanDraftSession(),
  });

  registerTool({
    name: 'commit_project_task_draft',
    bindsDraft: 'plan',
    description: '结束当前完整草案。计划结构、计划设置、里程碑和执行事项草案只会导入可视化计划编辑器，用户可继续调整并在编辑器中最终确认后写入；学习任务正文草案仍按原流程请求确认后写入。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    location: 'renderer',
    permission: 'write',
    confirmation: (_args, ctx) => {
      const session = ctx?.getPlanDraftSession();
      if (!session) throw new Error('当前没有可提交的计划草案');
      if (session.scopeKind === 'portfolio') {
        const roots = Object.values(session.portfolioRoots || {}).filter((root) => (root.structurePatches?.length || 0) > 0 || root.planMetaPatch
          || root.milestonePatches.length > 0 || root.executionPatches.length > 0);
        if (roots.length === 0) throw new Error('综合计划草案中还没有任何修改');
        return {
          title: '导入综合计划草图',
          description: `将 ${roots.length} 个根计划的调整依次导入可视化编辑器，尚不会写入笔记。`,
          impacts: [
            ...roots.flatMap((root) => [
              `${root.rootProjectTitle}：结构时间 ${root.structurePatches?.length || 0} 项，设置 ${root.planMetaPatch ? 1 : 0} 项，里程碑 ${root.milestonePatches.length} 项，执行事项 ${root.executionPatches.length} 项`,
              ...(root.structurePatches || []).slice(0, 5).map((patch) => `${root.rootProjectTitle} · ${structurePatchLabel(patch)}`),
            ]),
            '只允许调整根内既有项目的日期或优先级；不新增、删除、重命名或跨根移动项目。',
            '导入后可逐个检查、拖拽和修改；每个根计划都需在编辑器中明确确认后才会写入。',
          ],
        };
      }
      const taskCount = session.projects.reduce((sum, project) => sum + project.tasks.length, 0);
      const isStudyTaskDraft = session.purpose === 'study-tasks';
      return {
        title: isStudyTaskDraft ? '提交学习任务草案' : session.mode === 'revise-subtree' ? '导入局部计划草图' : '导入完整计划草图',
        description: isStudyTaskDraft
          ? `修改范围已锁定为“${session.scopeProjectTitle}”，将更新 ${session.projects.length} 个末级项目、${taskCount} 条正文任务。`
          : `修改范围已锁定为“${session.scopeProjectTitle}”，将把结构、里程碑、执行事项和计划设置导入可视化编辑器，尚不会写入。`,
        impacts: [
          ...(session.structurePatches.length > 0
            ? session.structurePatches.slice(0, 8).map(structurePatchLabel)
            : ['不修改项目层级结构。']),
          session.structurePatches.length > 8 ? `另有 ${session.structurePatches.length - 8} 个结构补丁，请在完整草案中查看。` : '',
          session.planMetaPatch ? '计划条件或节奏设置将同步更新。' : '',
          session.milestonePatches?.length ? `里程碑变更：${session.milestonePatches.map((patch) => `${patch.operation}:${patch.milestoneId}`).join('、')}` : '',
          session.executionPatches?.length ? `执行事项变更：${session.executionPatches.map((patch) => `${patch.operation}:${patch.taskId}`).join('、')}` : '',
          `仅涉及：${session.projects.map((project) => project.projectTitle).join('、') || '尚无项目'}`,
          session.createKnowledgeNotes.length > 0
            ? `创建知识点：${session.createKnowledgeNotes.join('、')}`
            : '不创建新的知识点笔记。',
          isStudyTaskDraft
            ? '范围外项目不会被修改；确认前仍未写入任何笔记。'
            : '导入后可继续调整；只有在计划编辑器的最终确认窗中确认，才会写入当前根计划。',
        ].filter(Boolean),
      };
    },
    execute: (_args, ctx) => ctx.commitPlanDraftSession(),
  });

  registerTool({
    name: 'query_leaf_project_task_scope',
    description: '按每批最多 5 个查询一个项目树中的末级项目及现有正文。批量生成学习任务时先调用；offset 用于继续下一批。',
    parameters: {
      type: 'object', required: ['rootProjectTitle'],
      properties: {
        rootProjectTitle: { type: 'string', description: '要批量处理的根项目或任一子树项目标题' },
        offset: { type: 'number', description: '从第几个末级项目开始，默认 0' },
      },
      additionalProperties: false,
    },
    location: 'renderer',
    permission: 'readonly',
    execute: (args, ctx) => {
      const notes = ctx.getPlanNotes?.() || ctx.getNotes();
      const requested = String(args.rootProjectTitle || '').trim();
      const root = resolveNoteByTitleOrAlias(requested, notes.filter((note) => note.noteType === 'project'));
      if (!root) throw new Error(`未找到项目笔记：${requested}`);
      const rawOffset = args.offset === undefined ? 0 : Number(args.offset);
      if (!Number.isInteger(rawOffset) || rawOffset < 0) throw new Error('offset 必须是非负整数');
      const leaves = getLeafProjectNotesInScope(root.id, notes);
      const batch = leaves.slice(rawOffset, rawOffset + 5);
      return {
        rootProjectTitle: root.title,
        totalLeafProjects: leaves.length,
        offset: rawOffset,
        nextOffset: rawOffset + batch.length < leaves.length ? rawOffset + batch.length : null,
        leafProjects: batch.map((project) => ({
          title: project.title,
          outcome: project.planOutcome,
          content: project.content.slice(0, 1200),
          linkedKnowledgeTitles: project.links || [],
        })),
      };
    },
  });

  registerTool({
    name: 'query_project_learning_context',
    description: '查询一个项目笔记的层级、祖先链、正文和已关联知识点；不传标题时读取当前选中的项目。',
    parameters: {
      type: 'object',
      properties: { projectTitle: { type: 'string' } }, additionalProperties: false,
    },
    location: 'renderer',
    permission: 'readonly',
    execute: (args, ctx) => {
      const notes = ctx.getPlanNotes?.() || ctx.getNotes();
      const requested = String(args.projectTitle || '').trim();
      const activeNote = ctx.getActiveNote?.();
      const project = requested
        ? resolveNoteByTitleOrAlias(requested, notes.filter((note) => note.noteType === 'project'))
        : activeNote?.noteType === 'project' ? activeNote : undefined;
      if (!project) throw new Error(requested ? `未找到项目笔记：${requested}` : '当前没有选中的项目笔记');
      const ancestors: string[] = [];
      const visited = new Set<string>();
      let current = project;
      while (current.parentId && !visited.has(current.parentId)) {
        visited.add(current.parentId);
        const parent = notes.find((note) => note.id === current.parentId && note.noteType === 'project');
        if (!parent) break;
        ancestors.unshift(parent.title);
        current = parent;
      }
      const knowledgeNotes = notes.filter((note) => note.noteType === 'knowledge');
      const childProjectTitles = getChildProjectNotes(project.id, notes).filter(isLearningProject).map((note) => note.title);
      const linkedKnowledgeTitles = (project.links || [])
        .map((title) => resolveNoteByTitleOrAlias(title, knowledgeNotes)?.title)
        .filter((title): title is string => Boolean(title));
      const scopeKnowledgeTitles = collectProjectKnowledgeNotes(project.id, notes).map((note) => note.title);
      return {
        title: project.title,
        level: project.parentId ? '子项目' : '根项目',
        outcome: project.planOutcome,
        isLeafProject: isLeafProjectNote(project.id, notes),
        projectRole: project.projectRole || 'learning',
        referenceChildTitles: getChildProjectNotes(project.id, notes).filter(note => !isLearningProject(note)).map(note => note.title),
        childProjectTitles,
        ancestors,
        content: project.content.slice(0, 4000),
        linkedKnowledgeTitles: [...new Set(linkedKnowledgeTitles)],
        scopeKnowledgeTitles,
      };
    },
  });

  registerTool({
    name: 'query_knowledge_notes',
    description: '查询已经存在的知识点笔记及其别名。生成项目学习任务前使用，确保 [[知识点]] 链接指向真实知识点笔记。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '可选，按标题、别名或标签筛选' },
        projectTitle: { type: 'string', description: '可选，用于标记知识点是否已被该项目显式链接' },
      },
      additionalProperties: false,
    },
    location: 'renderer',
    permission: 'readonly',
    execute: (args, ctx) => {
      const notes = ctx.getPlanNotes?.() || ctx.getNotes();
      const query = String(args.query || '').trim().toLocaleLowerCase();
      const requestedProject = String(args.projectTitle || '').trim();
      const project = requestedProject
        ? resolveNoteByTitleOrAlias(requestedProject, notes.filter((note) => note.noteType === 'project'))
        : undefined;
      if (requestedProject && !project) throw new Error(`未找到项目笔记：${requestedProject}`);
      const linked = new Set(project?.links || []);
      return {
        knowledgeNotes: notes
          .filter((note) => note.noteType === 'knowledge')
          .filter((note) => !query || [note.title, ...(note.aliases || []), ...(note.tags || [])]
            .some((value) => value.toLocaleLowerCase().includes(query)))
          .slice(0, 50)
          .map((note) => ({
            title: note.title,
            aliases: note.aliases || [],
            alreadyLinked: linked.has(note.title),
          })),
      };
    },
  });

  registerTool({
    name: 'query_plan_portfolio',
    description: '读取指定或全部有效且未归档根计划的稳定 ID、项目时间、执行事项、里程碑、本周负荷和跨计划日期冲突。综合总览中调整多个计划前必须先调用。',
    parameters: { type: 'object', properties: {
      rootProjectIds: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'string', minLength: 1 }, description: '可选；界面给出的精确根计划 ID 集合' },
    }, additionalProperties: false },
    location: 'renderer',
    permission: 'readonly',
    execute: (args, ctx) => {
      const notes = ctx.getPlanNotes?.() || ctx.getNotes();
      const weekStartDay = currentWeekStartDay();
      const requestedIds = Array.isArray(args.rootProjectIds)
        ? args.rootProjectIds.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
      if (Array.isArray(args.rootProjectIds) && requestedIds.length === 0) {
        throw new Error('综合查询若显式提供 rootProjectIds，必须至少包含一个有效的根项目 ID');
      }
      if (new Set(requestedIds).size !== requestedIds.length) throw new Error('综合查询范围包含重复的根项目 ID');
      const activeRoots = getActivePortfolioPlanRoots(notes);
      const requestedSet = new Set(requestedIds);
      const selectedRoots = requestedIds.length ? activeRoots.filter((root) => requestedSet.has(root.id)) : activeRoots;
      const missingIds = requestedIds.filter((rootId) => !selectedRoots.some((root) => root.id === rootId));
      if (missingIds.length) throw new Error(`以下根计划不存在、未启用或已归档：${missingIds.join('、')}`);
      const plans = selectedRoots.map((root) => serializePlanRoot(root, notes, weekStartDay, ctx.getLearningCapacitySettings?.()));
      const capacity = buildLearningCapacity(notes, dateFromDay(weekStartDay), ctx.getLearningCapacitySettings?.() || cachedCapacitySettings());
      const occurrences = plans.flatMap((plan) => plan.weeklyOccurrences);
      const occurrencesByDate = new Map<string, typeof occurrences>();
      for (const occurrence of occurrences) {
        const items = occurrencesByDate.get(occurrence.date) || [];
        items.push(occurrence);
        occurrencesByDate.set(occurrence.date, items);
      }
      const milestones = plans.flatMap((plan) => plan.milestones.map((milestone) => ({
        ...milestone,
        rootProjectId: plan.rootProjectId,
        rootProjectTitle: plan.rootProjectTitle,
      })));
      const milestoneDates = new Map<string, typeof milestones>();
      for (const milestone of milestones.filter((item) => !item.completed)) {
        const items = milestoneDates.get(milestone.dueDate) || [];
        items.push(milestone);
        milestoneDates.set(milestone.dueDate, items);
      }
      return {
        scope: 'portfolio',
        week: { start: dateFromDay(weekStartDay), end: dateFromDay(weekStartDay + 6) },
        roots: plans,
        executionItems: plans.flatMap((plan) => plan.projects.flatMap((project) => project.executionItems.map((task) => ({
          ...task,
          rootProjectId: plan.rootProjectId,
          rootProjectTitle: plan.rootProjectTitle,
          projectId: project.projectId,
          projectTitle: project.title,
        })))),
        milestones,
        weeklyLoad: {
          scheduledMinutes: plans.reduce((sum, plan) => sum + plan.weeklyLoad.scheduledMinutes, 0),
          allocatedBudgetMinutes: capacity.budgetMinutes,
          personalCapacity: learningCapacitySummary(capacity),
          byRoot: plans.map((plan) => ({
            rootProjectId: plan.rootProjectId,
            rootProjectTitle: plan.rootProjectTitle,
            ...plan.weeklyLoad,
          })),
        },
        conflicts: {
          overloadedRoots: plans.filter((plan) => capacity.budgetMinutes !== null && plan.weeklyLoad.scheduledMinutes > capacity.budgetMinutes).map((plan) => ({
            rootProjectId: plan.rootProjectId,
            rootProjectTitle: plan.rootProjectTitle,
            scheduledMinutes: plan.weeklyLoad.scheduledMinutes,
            budgetMinutes: plan.weeklyLoad.budgetMinutes,
            overByMinutes: plan.weeklyLoad.scheduledMinutes - capacity.budgetMinutes!,
          })),
          crossRootDateCollisions: [...occurrencesByDate.entries()].flatMap(([date, items]) => {
            const rootIds = [...new Set(items.map((item) => item.rootProjectId))];
            return rootIds.length > 1 ? [{ date, rootProjectIds: rootIds, totalMinutes: items.reduce((sum, item) => sum + item.estimatedMinutes, 0), items }] : [];
          }),
          milestoneDateCollisions: [...milestoneDates.entries()].flatMap(([date, items]) => {
            const rootIds = [...new Set(items.map((item) => item.rootProjectId))];
            return rootIds.length > 1 ? [{ date, rootProjectIds: rootIds, milestones: items.map((item) => ({ id: item.id, title: item.title, rootProjectTitle: item.rootProjectTitle })) }] : [];
          }),
        },
        counts: {
          roots: plans.length,
          projects: plans.reduce((sum, plan) => sum + plan.counts.projects, 0),
          milestones: milestones.length,
          executionItems: plans.reduce((sum, plan) => sum + plan.counts.executionItems, 0),
        },
      };
    },
  });

  registerTool({
    name: 'query_plan_workspace',
    description: '读取一个根计划的完整双轨模型：项目层级与时间范围、根计划条件、里程碑和周期执行事项。修订既有计划时必须先调用，不要从记忆推测当前状态。',
    parameters: {
      type: 'object',
      properties: {
        rootProjectId: { type: 'string', description: '稳定根项目 ID；综合查询后应优先使用' },
        rootProjectTitle: { type: 'string', description: '根计划标题或别名；省略时从当前项目向上定位根计划' },
      },
      additionalProperties: false,
    },
    location: 'renderer',
    permission: 'readonly',
    execute: (args, ctx) => {
      const notes = ctx.getPlanNotes?.() || ctx.getNotes();
      const projects = notes.filter((note) => note.noteType === 'project');
      const requestedId = String(args.rootProjectId || '').trim();
      const requested = String(args.rootProjectTitle || '').trim();
      let root = requestedId
        ? projects.find((project) => project.id === requestedId)
        : requested ? resolveNoteByTitleOrAlias(requested, projects)
        : ctx.getActiveNote?.()?.noteType === 'project' ? ctx.getActiveNote?.() || undefined : undefined;
      if (!root) throw new Error(requestedId ? `未找到根计划 ID：${requestedId}` : requested ? `未找到根计划：${requested}` : '当前没有选中项目计划');
      const byId = new Map(projects.map((note) => [note.id, note]));
      const seenParents = new Set<string>();
      while (root.parentId && !seenParents.has(root.parentId)) {
        seenParents.add(root.parentId);
        const parent = byId.get(root.parentId);
        if (!parent) break;
        root = parent;
      }
      return serializePlanRoot(root, notes, currentWeekStartDay(), ctx.getLearningCapacitySettings?.());
    },
  });

  registerTool({
    name: 'query_plan_tasks',
    description: '查询计划任务的所属笔记、任务名、日期、优先级和完成状态。修改计划前先调用此工具确认精确名称。',
    parameters: {
      type: 'object',
      properties: {
        noteTitle: { type: 'string', description: '可选，按笔记标题或别名精确筛选' },
        includeCompleted: { type: 'boolean', description: '是否包含已完成任务，默认 false' },
      },
      additionalProperties: false,
    },
    location: 'renderer',
    permission: 'readonly',
    execute: (args, ctx) => {
      const notes = ctx.getPlanNotes?.() || ctx.getNotes();
      const requestedTitle = String(args.noteTitle || '').trim();
      const selected = requestedTitle ? [resolveNoteByTitleOrAlias(requestedTitle, notes)].filter(Boolean) : notes;
      if (requestedTitle && selected.length === 0) throw new Error(`未找到笔记：${requestedTitle}`);
      const includeCompleted = args.includeCompleted === true;
      return {
        tasks: selected.flatMap((note) => (note?.dueDates || [])
          .filter((task) => includeCompleted || !task.completed)
          .map((task) => ({
            noteTitle: note!.title,
             taskText: task.taskText,
             taskId: task.id,
             startDate: task.startDate,
             dueDate: task.dueDate,
             priority: task.priority,
             completed: task.completed,
             kind: task.kind,
             executionKind: task.executionKind,
             estimatedMinutes: task.estimatedMinutes,
             recurrence: task.recurrence,
             milestoneId: task.milestoneId,
             linkedProjectId: task.linkedProjectId,
             linkedKnowledgeIds: task.linkedKnowledgeIds,
             launchMode: task.launchMode,
          })))
          .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
          .slice(0, 50),
      };
    },
  });

  registerTool({
    name: 'adjust_plan_task',
    description: '为一个计划任务生成新增、改期或优先级调整草图。必须使用 query_plan_tasks 核对已有任务；一次调用只调整一个任务。项目计划中的变更会导入可视化编辑器，经用户继续调整和最终确认后才写入。',
    parameters: {
      type: 'object',
      required: ['operation', 'noteTitle', 'taskText'],
      properties: {
        operation: { type: 'string', enum: ['add', 'reschedule', 'reprioritize'] },
        noteTitle: { type: 'string', description: '承载任务的已有笔记标题或别名' },
        taskText: { type: 'string', description: '新增任务名称，或已有任务的精确名称' },
        dueDate: { type: 'string', description: 'add/reschedule 必填，YYYY-MM-DD' },
        priority: { type: 'string', enum: ['high', 'medium', 'low'], description: 'add 可选，reprioritize 必填' },
      },
      additionalProperties: false,
    },
    location: 'renderer',
    permission: 'write',
    confirmation: (args) => {
      const change = parseChange(args);
      return {
        title: `导入${operationLabel(change.operation)}草图`,
        description: `将“${change.noteTitle || '未指定笔记'}”中的任务“${change.taskText || '未指定任务'}”调整导入计划编辑器。`,
        impacts: [
          change.dueDate ? `日期：${change.dueDate}` : '',
          change.priority ? `优先级：${change.priority}` : '',
          '本步骤不写入；导入后可继续调整，只有编辑器最终确认才会更新计划。',
        ].filter(Boolean),
      };
    },
    execute: (args, ctx) => {
      if (ctx.getPlanDraftSession()) throw new Error('当前存在计划草案；请在草案中暂存本次变更或先放弃草案，不能绕过草案直接写入');
      return ctx.applyPlanTaskChange(parseChange(args));
    },
  });

  registerTool({
    name: 'create_project_plan',
    description: '导入核心20%优先的双轨学习计划草图。root.children 第一层先列“核心20%：具体闭环”，再列“扩展：进阶成果”，由轨道节点直接表达范围；不要求额外的核心说明，outcome仅为可选简短验收产出。先调用research_learning_plan再据其真实[P1]来源制定草图并传researchId，在已有summary中保留引用；只有用户明确不要联网时才用offlineDraft=true，summary标注未联网核实。不接受模型提供的来源列表。最多60节点，一天范围节点必须是叶子，不生成日内动作清单。tasks只放独立周期事项。仅导入编辑器，不创建或覆盖笔记，仍由用户最终确认。',
    parameters: {
      type: 'object',
      required: ['root'],
      properties: { root: projectNodeSchema(), planMeta: planMetaSchema(),
        researchId: { type: 'string', description: '本对话 research_learning_plan 返回的真实检索记录ID' },
        offlineDraft: { type: 'boolean', description: '仅限用户明确选择不联网的未核实草图；不能用于静默掩盖检索失败' } },
      additionalProperties: false,
    },
    location: 'renderer',
    permission: 'write',
    confirmation: (args) => {
      const root = parseProjectNode(args.root);
      const planMeta = parsePlanMeta(args.planMeta);
      const summary = summarizeDraft(root);
      return {
        title: '导入完整计划草图',
        description: `将“${root.title || '未命名项目'}”及其全部子节点导入可视化计划编辑器；本步骤不会创建或覆盖笔记。`,
        impacts: [
          `草图共 ${summary.count} 个项目节点，其中 ${summary.scheduled} 个设置日期。`,
          `里程碑 ${summary.milestones + (planMeta?.milestones?.length || 0)} 个，执行事项 ${summary.tasks} 个。`,
          `节点预览：${summary.titles.filter(Boolean).join('、') || '无有效标题'}`,
          '导入后可以继续拖拽、增删和修改；只有编辑器最终确认才会写入。',
        ],
      };
    },
    execute: (args, ctx) => {
      if (ctx.getPlanDraftSession()) throw new Error('当前存在计划草案；请先完成或放弃草案，不能并行创建另一份计划');
      const root = parseProjectNode(args.root);
      assertGeneratedPlanCoreScope(root.children || []);
      if (args.offlineDraft === true && args.researchId) throw new Error('联网记录与离线草图不能同时指定');
      const research = args.offlineDraft === true ? undefined : readPlanResearch(ctx, args.researchId);
      const meta = parsePlanMeta(args.planMeta) || {};
      checkPlanResearchCitations(JSON.stringify({ root, summary: meta.summary }), research);
      if (!research && !meta.summary?.includes('未联网核实')) throw new Error('离线草图须在 summary 标注“未联网核实”');
      return ctx.createProjectPlan(root, { ...meta, research });
    },
  });

  registerTool({
    name: 'append_project_study_tasks',
    description: '只向没有项目子节点的末级项目笔记写入 1 至 7 条学习任务。通常生成 3 至 7 条，使用具体动作并按依赖顺序排列，不带日期；每条任务必须包含至少一个指向已有知识点笔记的 [[wiki 链接]]。根项目和中间项目的任务就是直属子项目标题，不写正文任务。',
    parameters: {
      type: 'object',
      required: ['projectTitle', 'tasks'],
      properties: {
        projectTitle: { type: 'string', description: '已有项目笔记标题或别名' },
        tasks: {
          type: 'array', minItems: 1, maxItems: 7,
          items: { type: 'string', description: '不带项目符号和日期，例如：掌握 [[并查集]] 的 [[路径压缩]] 优化' },
        },
      },
      additionalProperties: false,
    },
    location: 'renderer',
    permission: 'write',
    confirmation: (args) => {
      const input = parseStudyTasksInput(args);
      return {
        title: '写入项目学习任务并关联知识点',
        description: `将在项目“${input.projectTitle || '未指定项目'}”正文顶部写入 ${input.tasks.length} 条学习任务。`,
        impacts: [
          ...input.tasks.slice(0, 5),
          input.tasks.length > 5 ? `另有 ${input.tasks.length - 5} 条任务` : '',
          '任务中的 [[知识点]] 将形成可见 wiki 链接和反向链接；不会修改知识点归属。',
        ].filter(Boolean),
      };
    },
    execute: (args, ctx) => ctx.appendProjectStudyTasks(parseStudyTasksInput(args)),
  });

  registerTool({
    name: 'append_project_study_task_batch',
    description: '一次为同一项目树下 1 至 5 个末级项目写入学习任务，并创建任务确实引用但尚不存在的知识点笔记。整批先校验后一次落盘；每条任务仍须包含 [[知识点]]。',
    parameters: {
      type: 'object',
      required: ['rootProjectTitle', 'projects', 'createKnowledgeNotes'],
      properties: {
        rootProjectTitle: { type: 'string', description: '本批末级项目所属的根项目或子树项目标题' },
        projects: {
          type: 'array', minItems: 1, maxItems: 5,
          items: {
            type: 'object', required: ['projectTitle', 'tasks'],
            properties: {
              projectTitle: { type: 'string' },
              tasks: {
                type: 'array', minItems: 1, maxItems: 7,
                items: { type: 'string', description: '包含至少一个 [[知识点]]，不带项目符号和日期' },
              },
            },
            additionalProperties: false,
          },
        },
        createKnowledgeNotes: {
          type: 'array', maxItems: 30,
          items: { type: 'string' },
          description: '任务引用但 query_knowledge_notes 未找到的知识点标题；没有则传空数组',
        },
      },
      additionalProperties: false,
    },
    location: 'renderer',
    permission: 'write',
    confirmation: (args) => {
      const input = parseStudyTaskBatchInput(args);
      const taskCount = input.projects.reduce((sum, project) => sum + project.tasks.length, 0);
      return {
        title: '批量生成末级项目学习任务',
        description: `将在“${input.rootProjectTitle || '未指定项目'}”下更新 ${input.projects.length} 个末级项目，共写入 ${taskCount} 条任务。`,
        impacts: [
          `项目：${input.projects.map((project) => project.projectTitle).join('、')}`,
          input.createKnowledgeNotes.length > 0
            ? `同时创建知识点笔记：${input.createKnowledgeNotes.join('、')}`
            : '无需创建新的知识点笔记。',
          '整批校验成功后才会保存；任务将通过 [[知识点]] 建立显式关联。',
        ],
      };
    },
    execute: (args, ctx) => ctx.appendProjectStudyTaskBatch(parseStudyTaskBatchInput(args)),
  });
}
