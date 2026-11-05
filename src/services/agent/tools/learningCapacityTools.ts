import type { LearningCapacityPatch } from '../../learningCapacity';
import { buildLearningCapacity, CAPACITY_GUIDANCE, prepareLearningCapacityPatch, weekStartDate } from '../../learningCapacity';
import type { AgentRuntimeContext } from '../types';
import { registerTool } from '../toolRegistry';

export function readCapacityPatch(args: Record<string, unknown>): LearningCapacityPatch {
  if (Object.keys(args).some(k => !['weeklyBudgetMinutes', 'planDaily', 'leafEfforts', 'executionEfforts'].includes(k))) throw new Error('未知学习容量字段');
  for (const key of ['planDaily', 'leafEfforts', 'executionEfforts']) {
    const list = args[key]; if (list === undefined) continue;
    if (!Array.isArray(list) || list.length > 50 || list.some(v => !v || typeof v !== 'object' || Array.isArray(v))) throw new Error('修改清单最多 50 项');
    const keys = key === 'planDaily' ? ['rootId', 'minutes'] : key === 'leafEfforts' ? ['noteId', 'minutes'] : ['noteId', 'taskId', 'minutes', 'capacityKind'];
    const ids = new Set<string>();
    for (const v of list) {
      if (Object.keys(v).some(k => !keys.includes(k))) throw new Error('未知修改字段');
      for (const id of keys.filter(k => k.endsWith('Id'))) if (typeof v[id] !== 'string' || !v[id] || v[id].length > 256) throw new Error('需要稳定项目/任务 ID');
      const identity = `${v.rootId || v.noteId}\0${v.taskId || ''}`;
      if (ids.has(identity)) throw new Error('修改清单含重复对象'); ids.add(identity);
    }
  }
  return args as LearningCapacityPatch;
}
function settings(ctx: AgentRuntimeContext) { if (!ctx.getLearningCapacitySettings) throw new Error('当前环境未接通个人学习容量'); return ctx.getLearningCapacitySettings(); }
export function compactCapacity(capacity: ReturnType<typeof buildLearningCapacity>, offset = 0, limit = 50, rootId?: string) {
  const selected = rootId ? capacity.entries.filter(e => e.rootId === rootId) : capacity.entries;
  return { ...capacity, entryTotal: selected.length, offset, entries: selected.slice(offset, offset + limit),
    ...(offset + limit < selected.length ? { nextOffset: offset + limit } : {}), backlogTotal: capacity.backlog.length, backlog: capacity.backlog.slice(0, 50) };
}
function preview(args: Record<string, unknown>, ctx: AgentRuntimeContext) {
  const patch = readCapacityPatch(args), notes = ctx.getNotes(), current = settings(ctx);
  const mutation = prepareLearningCapacityPatch(notes, patch);
  const next = { ...current, ...(patch.weeklyBudgetMinutes !== undefined ? { learningWeeklyBudgetMinutes: patch.weeklyBudgetMinutes } : {}) };
  return { patch, mutation, before: buildLearningCapacity(notes, weekStartDate(), current), after: buildLearningCapacity(mutation.notes, weekStartDate(), next) };
}
const id = { type: 'string' }, minutes = { type: 'integer', minimum: 5, maximum: 1440 };
export function registerLearningCapacityTools() {
  registerTool({ name: 'query_learning_capacity', description: `读取个人共享周预算、全部计划每日投入、叶子项目/独立事项计时、逾期结转及超载；不是知识答疑。${CAPACITY_GUIDANCE}`,
    parameters: { type: 'object', additionalProperties: false, properties: { weekStart: { type: 'string', description: '可选 YYYY-MM-DD，取所在周周一' }, rootId: { type: 'string', description: '只筛选明细；个人预算和总负荷仍是全局值' }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } } },
    location: 'renderer', permission: 'readonly', execute: async (args, ctx) => {
      await ctx.ensureDataFresh(); const offset = args.offset ?? 0, limit = args.limit ?? 50;
      if (!Number.isInteger(offset) || Number(offset) < 0 || !Number.isInteger(limit) || Number(limit) < 1 || Number(limit) > 50) throw new Error('容量明细分页无效');
      return compactCapacity(buildLearningCapacity(ctx.getNotes(), weekStartDate(args.weekStart === undefined ? undefined : String(args.weekStart)), settings(ctx)), Number(offset), Number(limit), args.rootId === undefined ? undefined : String(args.rootId));
    } });
  registerTool({ name: 'update_learning_capacity', description: `确认修改个人周预算、根计划每日投入、叶子项目时长覆盖或执行事项计时关系。只改明确字段，不重排、不修改完成状态；始终需要用户确认。${CAPACITY_GUIDANCE}`,
    parameters: { type: 'object', additionalProperties: false, properties: {
      weeklyBudgetMinutes: { type: 'integer', minimum: 5, maximum: 10080 },
      planDaily: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['rootId', 'minutes'], properties: { rootId: id, minutes } } },
      leafEfforts: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['noteId', 'minutes'], properties: { noteId: id, minutes: { type: ['integer', 'null'], description: 'null 恢复继承计划每日投入' } } } },
      executionEfforts: { type: 'array', maxItems: 50, items: { type: 'object', additionalProperties: false, required: ['noteId', 'taskId'], properties: { noteId: id, taskId: id, minutes, capacityKind: { type: 'string', enum: ['additional', 'included'] } } } },
    } }, location: 'renderer', permission: 'write', requiresConfirmation: true,
    approvalSnapshot: (_args, ctx) => ({ weekStart: weekStartDate(), settings: settings(ctx), projects: ctx.getNotes().filter(n => n.noteType === 'project').map(n => ({ id: n.id, parentId: n.parentId, title: n.title, planMeta: n.planMeta, dueDates: n.dueDates })) }),
    confirmation: (args, ctx) => {
      if (!ctx) throw new Error('缺少实时上下文');
      const p = preview(args, ctx);
      return { title: '确认调整学习时间与个人容量', description: '只修改列出的时间设置，不重排任何项目；个人周预算影响所有计划。', impacts: [
        ...(p.patch.weeklyBudgetMinutes !== undefined ? [`个人共享周预算：${p.before.budgetMinutes ?? '未确认'} → ${p.after.budgetMinutes} 分钟`] : []),
        ...(p.patch.planDaily || []).map(v => `${ctx.getNotes().find(n => n.id === v.rootId)?.title}：每日 ${ctx.getNotes().find(n => n.id === v.rootId)?.planMeta?.dailyStudyMinutes ?? '未确认'} → ${v.minutes} 分钟；未单独覆盖的叶子项目继承`),
        ...(p.patch.leafEfforts || []).map(v => `${ctx.getNotes().find(n => n.id === v.noteId)?.title}：时长 → ${v.minutes === null ? '继承计划' : `${v.minutes}分钟`}`),
        ...(p.patch.executionEfforts || []).map(v => `事项 ${v.taskId}：${v.minutes === undefined ? '' : `${v.minutes}分钟；`}${v.capacityKind === 'included' ? '包含在叶子项目内' : v.capacityKind === 'additional' ? '额外投入' : '保留计时关系'}`),
        `本周全部计划：${p.before.scheduledMinutes} → ${p.after.scheduledMinutes} 分钟；${p.after.percent === null ? '周预算待确认' : `总负荷 ${p.after.percent}%`}`,
        `每日强度超限 ${p.after.byRoot.reduce((s, r) => s + r.dailyOverloads.length, 0)} 处；只提示，不移动日期。已完成项目保留原时长。`,
        '包含关系只对关联叶子安排的同一学习日去重；其它日期的周期复习仍是额外投入。',
      ] };
    },
    execute: async (args, ctx) => {
      const p = preview(args, ctx);
      if (!ctx.applyLearningCapacityPatch) throw new Error('当前环境没有学习容量写入入口');
      return ctx.applyLearningCapacityPatch(p.patch);
    } });
}
