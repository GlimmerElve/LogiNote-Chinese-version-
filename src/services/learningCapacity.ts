import type { NoteItem, VaultSettings, PlanNode, PlanMeta } from '../types';
import { isLearningProject, isReferenceProject } from './projectRole';
import { getScheduledProjectChildren, getScheduledProjectDeadline } from './planProjectState';
import { homeCalendarDay, homeLocalDate, nextHomeTaskOccurrence } from './homepage/homeTaskScheduling';

export const CAPACITY_TOOLS = ['query_learning_capacity', 'update_learning_capacity'] as const;
export const CAPACITY_GUIDANCE = '学习容量：个人周预算由所有计划共用，不得把各计划旧周预算相加。计划每日投入决定叶子项目默认学习时长，不等于单次专注时长。用 query_learning_capacity 查询，用 update_learning_capacity 提交范围明确的修改确认卡；修改强度/预算不授权重排日期。关联项目不代表任务已包含在项目预算内，只有明确 capacityKind=included 且发生在该叶子安排学习日的实例才不额外计时，其他日期的周期复习仍计额外投入。';
export function validStudyMinutes(value: unknown, max = 1440): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 5 && value <= max;
}
export function personalWeeklyBudget(settings?: Partial<VaultSettings>): number | null {
  return validStudyMinutes(settings?.learningWeeklyBudgetMinutes, 10080) ? settings!.learningWeeklyBudgetMinutes! : null;
}
/** Cache is only a UI default. Agent mutations use the live, hydrated settings port. */
export function cachedCapacitySettings(): Partial<VaultSettings> {
  try { return JSON.parse(globalThis.localStorage?.getItem('loginote_vault_settings_v1') || '{}'); } catch { return {}; }
}
export function planRootFor(note: NoteItem, notes: NoteItem[]): NoteItem | null {
  if (isReferenceProject(note)) return null;
  const seen = new Set<string>(); let current = note;
  while (current.parentId) {
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    const parent = notes.find(n => n.id === current.parentId && n.noteType === 'project');
    if (!parent) break;
    current = parent;
  }
  return current.noteType === 'project' ? current : null;
}
export function leafStudyEffort(note: NoteItem, root: NoteItem) {
  const deadline = getScheduledProjectDeadline(note);
  if (validStudyMinutes(deadline?.estimatedMinutes)) return { minutes: deadline!.estimatedMinutes!, source: 'override' as const };
  if (validStudyMinutes(root.planMeta?.dailyStudyMinutes)) return { minutes: root.planMeta!.dailyStudyMinutes!, source: 'plan-daily' as const };
  return { minutes: validStudyMinutes(root.planMeta?.conditions?.preferredSessionMinutes)
    ? root.planMeta!.conditions!.preferredSessionMinutes! : 60, source: 'unconfirmed-legacy' as const };
}
export function weekStartDate(date = homeLocalDate()): string {
  const day = homeCalendarDay(date); if (day === null) throw new Error('日期必须是有效的 YYYY-MM-DD');
  return dateFromDay(day - (new Date(day * 86400000).getUTCDay() + 6) % 7);
}
const dateFromDay = (day: number) => new Date(day * 86400000).toISOString().slice(0, 10);
export interface CapacityEntry { rootId: string; noteId: string; taskId?: string; title: string; date: string; minutes: number;
  kind: 'project' | 'execution'; completed: boolean; estimated: boolean }

/** Planned time stays on its planned date, not on the rolling Home action date. */
export function buildLearningCapacity(notes: NoteItem[], week = weekStartDate(), settings = cachedCapacitySettings(), today = homeLocalDate()) {
  const first = homeCalendarDay(week); if (first === null) throw new Error('周起点无效');
  const end = dateFromDay(first + 6), entries: CapacityEntry[] = [], backlog: CapacityEntry[] = [];
  const projects = notes.filter(isLearningProject);
  const byId = new Map(projects.map(n => [n.id, n])), rootCache = new Map<string, NoteItem | null>(), nonLeaves = new Set<string>();
  const rootOf = (note: NoteItem): NoteItem | null => {
    if (rootCache.has(note.id)) return rootCache.get(note.id)!;
    const path: NoteItem[] = [], seen = new Set<string>(); let current = note, root: NoteItem | null;
    while (true) {
      if (seen.has(current.id)) { root = null; break; }
      seen.add(current.id); path.push(current);
      if (rootCache.has(current.id)) { root = rootCache.get(current.id)!; break; }
      const parent = current.parentId ? byId.get(current.parentId) : undefined;
      if (!parent) { root = current; break; } current = parent;
    }
    path.forEach(p => rootCache.set(p.id, root)); return root;
  };
  for (const note of projects) if (getScheduledProjectDeadline(note)) {
    const seen = new Set([note.id]); let parent = note.parentId ? byId.get(note.parentId) : undefined;
    while (parent && !seen.has(parent.id)) { nonLeaves.add(parent.id); seen.add(parent.id); parent = parent.parentId ? byId.get(parent.parentId) : undefined; }
  }
  const roots = projects.filter(n => !n.parentId || !byId.has(n.parentId));
  const availableRoots = roots.filter(r => !['archived', 'paused', 'draft'].includes(r.planMeta?.status || 'active'));
  const rootIds = new Set(availableRoots.map(r => r.id));
  const add = (entry: CapacityEntry) => {
    if (entry.date >= week && entry.date <= end) entries.push(entry);
    if (!entry.completed && entry.date < today && entry.kind === 'project') backlog.push(entry);
  };
  for (const note of projects) {
    const root = rootOf(note); if (!root || !rootIds.has(root.id)) continue;
    const deadline = getScheduledProjectDeadline(note);
    if (deadline && !nonLeaves.has(note.id)) {
      const effort = leafStudyEffort(note, root);
      add({ rootId: root.id, noteId: note.id, title: note.title, date: deadline.startDate || deadline.dueDate,
        minutes: effort.minutes, estimated: effort.source === 'unconfirmed-legacy', kind: 'project', completed: deadline.completed });
    }
    const seen = new Set<string>();
    for (const task of note.dueDates) {
      if (task.linkedProjectId && isReferenceProject(notes.find(n => n.id === task.linkedProjectId))) continue;
      if (task === deadline || task.taskText.trim() === note.title.trim() || seen.has(task.id)) continue;
      seen.add(task.id);
      if (homeCalendarDay(task.dueDate) === null || homeCalendarDay(task.startDate || task.dueDate) === null
        || (task.startDate || task.dueDate) > task.dueDate) continue;
      const linked = byId.get(task.linkedProjectId || note.id);
      // Only a real scheduled leaf in this same plan can absorb an execution task.
      const included = task.capacityKind === 'included' && linked && rootOf(linked)?.id === root.id
        && getScheduledProjectDeadline(linked) && !nonLeaves.has(linked.id);
      const dates: string[] = [];
      if (task.recurrence && task.recurrence.frequency !== 'none') {
        let date = nextHomeTaskOccurrence(task, week);
        while (date && date <= end && dates.length < 7) { dates.push(date); date = nextHomeTaskOccurrence(task, dateFromDay(homeCalendarDay(date)! + 1)); }
      } else dates.push(task.startDate || task.dueDate);
      for (const date of dates) {
        const linkedDeadline = included ? getScheduledProjectDeadline(linked!) : undefined;
        if (linkedDeadline && date === (linkedDeadline.startDate || linkedDeadline.dueDate)) continue;
        add({ rootId: root.id, noteId: note.id, taskId: task.id, title: task.taskText, date,
          minutes: validStudyMinutes(task.estimatedMinutes) ? task.estimatedMinutes : 60, estimated: !validStudyMinutes(task.estimatedMinutes),
          kind: 'execution', completed: task.recurrence && task.recurrence.frequency !== 'none' ? !!task.completedOccurrenceDates?.includes(date) : task.completed });
      }
    }
  }
  const summarize = (items: CapacityEntry[]) => ({ projectMinutes: items.filter(i => i.kind === 'project').reduce((s, i) => s + i.minutes, 0),
    executionMinutes: items.filter(i => i.kind === 'execution').reduce((s, i) => s + i.minutes, 0),
    scheduledMinutes: items.reduce((s, i) => s + i.minutes, 0), estimatedCount: items.filter(i => i.estimated).length });
  const totals = summarize(entries), budgetMinutes = personalWeeklyBudget(settings);
  const byRoot = roots.filter(r => r.planMeta?.status !== 'archived').map(root => {
    const items = entries.filter(e => e.rootId === root.id), counts = summarize(items);
    const byDay = new Map<string, number>(); items.forEach(e => byDay.set(e.date, (byDay.get(e.date) || 0) + e.minutes));
    return { rootId: root.id, title: root.title, status: root.planMeta?.status || 'active', dailyStudyMinutes: root.planMeta?.dailyStudyMinutes ?? null,
      ...counts, dailyOverloads: validStudyMinutes(root.planMeta?.dailyStudyMinutes)
        ? [...byDay].filter(([, m]) => m > root.planMeta!.dailyStudyMinutes!).map(([date, minutes]) => ({ date, minutes })) : [] };
  });
  return { weekStart: week, weekEnd: end, budgetMinutes, budgetConfirmed: budgetMinutes !== null, ...totals,
    remainingMinutes: budgetMinutes === null ? null : budgetMinutes - totals.scheduledMinutes,
    percent: budgetMinutes === null ? null : Math.round(totals.scheduledMinutes / budgetMinutes * 100),
    byRoot, entries, backlog, legacyBudgets: roots.filter(r => r.planMeta?.weeklyBudgetMinutes).map(r => ({ rootId: r.id, title: r.title, minutes: r.planMeta!.weeklyBudgetMinutes! })),
    warnings: ['叶子项目按计划学习日计入一次，不按日期跨度乘算；逾期结转单列，未自动重排。',
      '已包含事项仅在关联叶子的安排学习日去重；其它日期的重复复习仍算额外投入。',
      ...(budgetMinutes === null ? ['个人周预算尚未确认，旧计划预算不求和、不自动迁移。'] : []),
      ...(totals.estimatedCount ? ['存在旧项目或任务时长估算，需确认；每日投入不等于专注单次时长。'] : [])] };
}

export interface LearningCapacityPatch { weeklyBudgetMinutes?: number; planDaily?: { rootId: string; minutes: number }[];
  leafEfforts?: { noteId: string; minutes: number | null }[]; executionEfforts?: { noteId: string; taskId: string; minutes?: number; capacityKind?: 'additional' | 'included' }[] }
export function learningCapacitySummary(capacity: ReturnType<typeof buildLearningCapacity>) {
  const { entries, backlog, ...rest } = capacity;
  return { ...rest, entryTotal: entries.length, backlogTotal: backlog.length, rootTotal: rest.byRoot.length,
    byRoot: rest.byRoot.slice(0, 50), legacyBudgets: rest.legacyBudgets.slice(0, 50) };
}
export function prepareLearningCapacityPatch(notes: NoteItem[], patch: LearningCapacityPatch, now = new Date().toISOString()) {
  if (patch.weeklyBudgetMinutes !== undefined && !validStudyMinutes(patch.weeklyBudgetMinutes, 10080)) throw new Error('个人周预算须为 5–10080 分钟整数');
  let after = structuredClone(notes); const changed = new Set<string>();
  const noteFor = (id: string) => { const matches = after.filter(n => n.id === id && isLearningProject(n)); if (matches.length !== 1) throw new Error('学习项目身份无效或重复；资料型不参与学习容量，请重新读取'); return matches[0]; };
  for (const item of patch.planDaily || []) {
    const root = noteFor(item.rootId);
    if (planRootFor(root, after)?.id !== root.id || !validStudyMinutes(item.minutes)) throw new Error('须指定真实根计划及 5–1440 分钟每日投入');
    // Freeze completed inherited effort before changing a default; no historical relearning.
    for (const leaf of after) {
      const d = getScheduledProjectDeadline(leaf);
      if (d?.completed && !validStudyMinutes(d.estimatedMinutes) && planRootFor(leaf, after)?.id === root.id && getScheduledProjectChildren(after, leaf.id).length === 0) {
        d.estimatedMinutes = leafStudyEffort(leaf, root).minutes; changed.add(leaf.id);
      }
    }
    root.planMeta = { schemaVersion: 2, status: 'active', ...root.planMeta, dailyStudyMinutes: item.minutes }; changed.add(root.id);
  }
  for (const item of patch.leafEfforts || []) {
    const leaf = noteFor(item.noteId), deadline = getScheduledProjectDeadline(leaf);
    if (!deadline || getScheduledProjectChildren(after, leaf.id).length) throw new Error('只能调整已排期叶子项目的时长');
    if (deadline.completed) throw new Error('已完成项目的历史时长不通过此入口修改');
    if (item.minutes !== null && !validStudyMinutes(item.minutes)) throw new Error('叶子项目时长须为 5–1440 分钟整数，null 恢复继承');
    if (item.minutes === null) delete deadline.estimatedMinutes; else deadline.estimatedMinutes = item.minutes;
    changed.add(leaf.id);
  }
  for (const item of patch.executionEfforts || []) {
    const note = noteFor(item.noteId), matches = note.dueDates.filter(t => t.id === item.taskId && t !== getScheduledProjectDeadline(note));
    if (matches.length !== 1) throw new Error('执行事项身份无效');
    const task = matches[0];
    if (item.minutes !== undefined) { if (!validStudyMinutes(item.minutes)) throw new Error('执行事项时长无效'); task.estimatedMinutes = item.minutes; }
    if (item.capacityKind !== undefined) {
      if (!['additional', 'included'].includes(item.capacityKind)) throw new Error('计时关系无效');
      if (item.capacityKind === 'included') {
        const leaf = noteFor(task.linkedProjectId || note.id);
        if (!getScheduledProjectDeadline(leaf) || getScheduledProjectChildren(after, leaf.id).length || planRootFor(leaf, after)?.id !== planRootFor(note, after)?.id) throw new Error('包含关系须指向同计划的真实叶子项目');
      }
      task.capacityKind = item.capacityKind;
    }
    changed.add(note.id);
  }
  if (!changed.size && patch.weeklyBudgetMinutes === undefined) throw new Error('没有要修改的学习容量数据');
  after = after.map(n => changed.has(n.id) ? { ...n, updatedAt: now } : n);
  return { before: notes.filter(n => changed.has(n.id)), after: after.filter(n => changed.has(n.id)), notes: after };
}

/** Pure preview: substitute only the edited plan, retain every other active plan. */
export function previewDraftCapacity(tree: PlanNode[], meta: Partial<PlanMeta>, notes: NoteItem[], settings: Partial<VaultSettings>, editingRootId?: string) {
  const root = tree[0]; if (!root) return [];
  const ids = new Map<string, string>();
  const collect = (node: PlanNode) => { ids.set(node.key, `__capacity_preview__${node.key}`); node.children.forEach(collect); }; collect(root);
  const draftNotes: NoteItem[] = [];
  const visit = (node: PlanNode, parentId?: string) => {
    const id = ids.get(node.key)!;
    draftNotes.push({ id, title: node.title, noteType: 'project', parentId, content: '', createdAt: '', updatedAt: '', tags: [], aliases: [], links: [], backlinks: [],
      ...(node === root ? { planMeta: { schemaVersion: 2, ...meta, status: 'active', dailyStudyMinutes: meta.dailyStudyMinutes } as PlanMeta } : {}),
      dueDates: [ ...(node.dueDate ? [{ id: `deadline-${id}`, noteId: id, noteTitle: node.title, taskText: node.title,
        startDate: node.startDate, dueDate: node.dueDate, completed: false, priority: 'medium' as const, estimatedMinutes: node.estimatedMinutes }] : []),
        ...(node.tasks || []).map(t => ({ ...t, id: t.key, noteId: id, noteTitle: node.title, taskText: t.text,
          priority: t.priority || 'medium' as const, completed: false, linkedProjectId: t.linkedProjectKey ? ids.get(t.linkedProjectKey) : undefined })) ] } as NoteItem);
    node.children.forEach(child => visit(child, id));
  }; visit(root);
  const others = notes.filter(n => !editingRootId || planRootFor(n, notes)?.id !== editingRootId);
  const dates = draftNotes.flatMap(n => n.dueDates.flatMap(d => [d.startDate || d.dueDate, d.recurrence?.endDate || d.dueDate])).filter(d => homeCalendarDay(d) !== null).sort();
  const start = homeCalendarDay(weekStartDate(dates[0] || homeLocalDate()))!, end = homeCalendarDay(dates.at(-1) || homeLocalDate())!;
  const weeks = [];
  for (let day = start; day <= end && weeks.length < 104; day += 7) weeks.push(buildLearningCapacity([...others, ...draftNotes], dateFromDay(day), settings));
  return weeks;
}

export function assertHardDraftCapacity(tree: PlanNode[], meta: Partial<PlanMeta>, notes: NoteItem[], settings: Partial<VaultSettings>, editingRootId?: string) {
  if (meta.conditions?.deadlineMode !== 'hard') return;
  if (personalWeeklyBudget(settings) === null) throw new Error('硬截止计划需先在学习偏好中确认个人共享周预算');
  const weeks = previewDraftCapacity(tree, meta, notes, settings, editingRootId);
  if (weeks.some(w => (w.percent ?? 0) > 100 || w.byRoot.some(r => r.rootId.startsWith('__capacity_preview__') && r.dailyOverloads.length))) {
    throw new Error('硬截止草稿超过个人共享周容量或本计划每日投入，请先调整日期/范围或明确修改个人预算；未重排其他计划');
  }
}
