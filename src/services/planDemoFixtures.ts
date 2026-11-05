import type { DueDateItem, NoteItem, PlanTaskKind } from '../types';
import { homeLocalDate } from './homepage/homeTaskScheduling';

const DAY_MS = 86_400_000;

function dateAt(baseDay: number, offset: number): string {
  return new Date((baseDay + offset) * DAY_MS).toISOString().slice(0, 10);
}

function utcDay(value: string): number {
  return Math.floor(Date.parse(`${value}T00:00:00Z`) / DAY_MS);
}

function mondayOf(value: string): number {
  const day = utcDay(value);
  const weekday = new Date(day * DAY_MS).getUTCDay();
  return day - ((weekday + 6) % 7);
}

function projectDeadline(
  noteId: string,
  title: string,
  startDate: string,
  dueDate: string,
  completed = false,
): DueDateItem {
  return {
    id: `${noteId}-deadline`,
    noteId,
    noteTitle: title,
    taskText: title,
    startDate,
    dueDate,
    completed,
    completedAt: completed ? `${dueDate}T18:00:00.000Z` : undefined,
    priority: 'high',
    kind: 'learn',
    estimatedMinutes: 60,
    source: 'llm',
  };
}

function executionTask(
  noteId: string,
  noteTitle: string,
  id: string,
  taskText: string,
  startDate: string,
  dueDate: string,
  kind: PlanTaskKind,
  minutes: number,
  recurrence?: DueDateItem['recurrence'],
  completed = false,
): DueDateItem {
  return {
    id,
    noteId,
    noteTitle,
    taskText,
    startDate,
    dueDate,
    completed,
    completedAt: completed ? `${dueDate}T20:00:00.000Z` : undefined,
    priority: kind === 'assessment' ? 'high' : 'medium',
    kind,
    executionKind: kind === 'review' ? 'review' : kind === 'practice' || kind === 'assessment' ? 'practice' : 'flow',
    recurrence,
    estimatedMinutes: minutes,
    source: 'llm',
    launchMode: kind === 'review' ? 'review' : kind === 'practice' || kind === 'assessment' ? 'scene' : 'flow',
  };
}

function projectNote(
  id: string,
  title: string,
  parentId: string,
  startDate: string,
  dueDate: string,
  now: string,
  completed = false,
  tasks: DueDateItem[] = [],
): NoteItem {
  return {
    id,
    title,
    parentId,
    noteType: 'project',
    content: `# ${title}\n\n演示计划中的结构项目，用于验证父子层级、完成传播与时间线展示。`,
    tags: ['计划演示', '结构项目'],
    links: [],
    backlinks: [],
    dueDates: [projectDeadline(id, title, startDate, dueDate, completed), ...tasks],
    createdAt: now,
    updatedAt: now,
  };
}

/** 仅供计划演示路由使用；返回独立内存数据，不写入真实笔记仓库。 */
export function createPlanWorkspaceDemoNotes(referenceDate = homeLocalDate()): NoteItem[] {
  const monday = mondayOf(referenceDate);
  const d = (offset: number) => dateAt(monday, offset);
  const now = `${referenceDate}T09:00:00.000Z`;
  const rootId = 'plan-demo-statistics-root';
  const psychologyRootId = 'plan-demo-psychology-root';

  const taskNotes: Record<string, DueDateItem[]> = {
    root: [
      executionTask(rootId, '统计推断 · 六周掌握计划', 'plan-demo-task-formula', '每日公式回忆', d(-7), d(34), 'review', 20, { frequency: 'daily', interval: 1, endDate: d(34), missedPolicy: 'rollover' }),
      executionTask(rootId, '统计推断 · 六周掌握计划', 'plan-demo-task-problem', '工作日概率题训练', d(-7), d(34), 'practice', 35, { frequency: 'weekdays', interval: 1, endDate: d(34), missedPolicy: 'keep' }),
      executionTask(rootId, '统计推断 · 六周掌握计划', 'plan-demo-task-errors', '周五错题归因', d(-5), d(34), 'review', 45, { frequency: 'weekly', interval: 1, weekdays: [5], endDate: d(34), missedPolicy: 'rollover' }),
      executionTask(rootId, '统计推断 · 六周掌握计划', 'plan-demo-task-checkpoint', '完成条件概率小测', d(2), d(4), 'assessment', 50),
      executionTask(rootId, '统计推断 · 六周掌握计划', 'plan-demo-task-case', '拆解一次贝叶斯诊断案例', d(4), d(5), 'practice', 60),
      executionTask(rootId, '统计推断 · 六周掌握计划', 'plan-demo-task-hypothesis', '假设检验计算练习', d(16), d(18), 'practice', 75),
      executionTask(rootId, '统计推断 · 六周掌握计划', 'plan-demo-task-rehearsal', '模型汇报彩排', d(30), d(32), 'assessment', 90),
    ],
  };

  const notes: NoteItem[] = [
    {
      id: rootId,
      title: '统计推断 · 六周掌握计划',
      noteType: 'project',
      content: '# 统计推断 · 六周掌握计划\n\n从概率基础、统计推断到贝叶斯应用，形成可解释、可复习、可验收的学习闭环。',
      tags: ['计划演示', '统计推断'],
      links: [],
      backlinks: [],
      dueDates: taskNotes.root,
      pinned: true,
      color: '#2f6653',
      planMeta: {
        schemaVersion: 2,
        status: 'active',
        shortTitle: '统计推断 · 六周计划',
        summary: '用六周建立从概率基础到贝叶斯应用的完整推理链，并通过练习、复习与项目输出持续验证。',
        startDate: d(-7),
        targetDate: d(34),
        weeklyBudgetMinutes: 600,
        activeWeekdays: [1, 2, 3, 4, 5, 6],
        portfolioPriority: 'high',
        autoAdjustPolicy: 'ask',
        conditions: {
          goalEvidence: '能够独立解释一次统计推断，并完成一份带不确定性说明的案例报告。',
          startingLevel: 'basic',
          pace: 'balanced',
          preferredSessionMinutes: 60,
          preferredTimeOfDay: 'evening',
          deadlineMode: 'flexible',
          reviewCadence: 'intensive',
        },
        phaseWindows: [
          { projectId: 'plan-demo-foundation', startDate: d(-7), endDate: d(-1), outcome: '校准概率基础与符号语言', order: 0 },
          { projectId: 'plan-demo-inference', startDate: d(0), endDate: d(13), outcome: '掌握估计、检验与贝叶斯更新', order: 1 },
          { projectId: 'plan-demo-application', startDate: d(14), endDate: d(27), outcome: '把推断方法用于真实分类问题', order: 2 },
          { projectId: 'plan-demo-output', startDate: d(28), endDate: d(34), outcome: '形成可解释的综合成果', order: 3 },
        ],
        milestones: [
          { id: 'plan-demo-milestone-foundation', title: '基础校准完成', dueDate: d(-1), projectId: 'plan-demo-foundation', completed: true, completedAt: `${d(-1)}T18:00:00.000Z`, criteria: ['完成概率基础诊断', '整理核心公式卡'] },
          { id: 'plan-demo-milestone-bayes', title: '贝叶斯更新验收', dueDate: d(6), projectId: 'plan-demo-inference', criteria: ['完成诊断案例', '能解释先验与似然'] },
          { id: 'plan-demo-milestone-inference', title: '推断方法闭环', dueDate: d(20), projectId: 'plan-demo-inference', criteria: ['独立完成估计与检验题组'] },
          { id: 'plan-demo-milestone-model', title: '应用模型可解释', dueDate: d(27), projectId: 'plan-demo-application', criteria: ['输出误差分析与解释报告'] },
          { id: 'plan-demo-milestone-final', title: '综合项目发布', dueDate: d(34), projectId: 'plan-demo-output', criteria: ['完成展示', '形成后续复习清单'] },
        ],
        updatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    },

    projectNote('plan-demo-foundation', '预备知识校准', rootId, d(-7), d(-1), now, true),
    projectNote('plan-demo-random-variable', '随机变量与概率分布', 'plan-demo-foundation', d(-7), d(-4), now, true),
    projectNote('plan-demo-conditional-review', '条件概率基础复盘', 'plan-demo-foundation', d(-3), d(-1), now, true),

    projectNote('plan-demo-inference', '统计推断核心', rootId, d(0), d(13), now),
    projectNote('plan-demo-bayes', '贝叶斯更新与诊断', 'plan-demo-inference', d(0), d(6), now),
    projectNote('plan-demo-prior-likelihood', '先验与似然建模', 'plan-demo-bayes', d(0), d(3), now),
    projectNote('plan-demo-posterior-explain', '后验更新解释', 'plan-demo-bayes', d(4), d(6), now),
    projectNote('plan-demo-estimation', '点估计与区间估计', 'plan-demo-inference', d(5), d(10), now),
    projectNote('plan-demo-hypothesis', '假设检验与错误控制', 'plan-demo-inference', d(7), d(13), now),

    projectNote('plan-demo-application', '贝叶斯应用项目', rootId, d(14), d(27), now),
    projectNote('plan-demo-classifier', '垃圾邮件分类器', 'plan-demo-application', d(14), d(21), now),
    projectNote('plan-demo-calibration', '概率校准与误差分析', 'plan-demo-application', d(20), d(27), now),

    projectNote('plan-demo-output', '综合输出与复盘', rootId, d(28), d(34), now),
    projectNote('plan-demo-report', '撰写推断报告', 'plan-demo-output', d(28), d(32), now),
    projectNote('plan-demo-presentation', '展示与后续复习清单', 'plan-demo-output', d(31), d(34), now),

    {
      id: psychologyRootId,
      title: '认知心理学 · 记忆机制计划',
      noteType: 'project',
      content: '# 认知心理学 · 记忆机制计划\n\n与统计推断计划并行，用实验阅读与间隔复习建立记忆模型。',
      tags: ['计划演示', '认知心理学'],
      links: [],
      backlinks: [],
      dueDates: [
        executionTask(psychologyRootId, '认知心理学 · 记忆机制计划', 'plan-demo-psych-review', '每日回忆一个经典实验', d(-2), d(20), 'review', 15, { frequency: 'daily', interval: 1, endDate: d(20), missedPolicy: 'rollover' }),
        executionTask(psychologyRootId, '认知心理学 · 记忆机制计划', 'plan-demo-psych-method', '拆解记忆广度实验', d(3), d(4), 'practice', 50),
        executionTask(psychologyRootId, '认知心理学 · 记忆机制计划', 'plan-demo-psych-report', '完成遗忘曲线小结', d(10), d(11), 'assessment', 70),
      ],
      color: '#466f62',
      planMeta: {
        schemaVersion: 2,
        status: 'active',
        shortTitle: '记忆机制 · 四周计划',
        summary: '以工作记忆、长时记忆和遗忘机制为主线，完成一份可复用的实验解释框架。',
        startDate: d(-2),
        targetDate: d(20),
        weeklyBudgetMinutes: 360,
        activeWeekdays: [2, 4, 6],
        portfolioPriority: 'medium',
        autoAdjustPolicy: 'ask',
        conditions: {
          goalEvidence: '能够用记忆模型解释至少三个经典实验。',
          startingLevel: 'basic',
          pace: 'balanced',
          preferredSessionMinutes: 45,
          preferredTimeOfDay: 'morning',
          deadlineMode: 'flexible',
          reviewCadence: 'standard',
        },
        phaseWindows: [
          { projectId: 'plan-demo-psych-working-memory', startDate: d(-2), endDate: d(6), outcome: '建立工作记忆模型', order: 0 },
          { projectId: 'plan-demo-psych-long-term', startDate: d(7), endDate: d(20), outcome: '解释编码、提取与遗忘', order: 1 },
        ],
        milestones: [
          { id: 'plan-demo-psych-milestone-model', title: '工作记忆模型验收', dueDate: d(6), projectId: 'plan-demo-psych-working-memory', criteria: ['绘制模型关系图', '解释两项实验'] },
          { id: 'plan-demo-psych-milestone-final', title: '记忆机制框架完成', dueDate: d(20), projectId: 'plan-demo-psych-long-term', criteria: ['完成遗忘机制对比', '形成复习卡片'] },
        ],
        updatedAt: now,
      },
      createdAt: now,
      updatedAt: now,
    },
    projectNote('plan-demo-psych-working-memory', '工作记忆模型', psychologyRootId, d(-2), d(6), now),
    projectNote('plan-demo-psych-span', '记忆广度与组块化', 'plan-demo-psych-working-memory', d(-2), d(2), now),
    projectNote('plan-demo-psych-interference', '双任务干扰实验', 'plan-demo-psych-working-memory', d(3), d(6), now),
    projectNote('plan-demo-psych-long-term', '长时记忆与遗忘', psychologyRootId, d(7), d(20), now),
    projectNote('plan-demo-psych-encoding', '编码与提取线索', 'plan-demo-psych-long-term', d(7), d(13), now),
    projectNote('plan-demo-psych-forgetting', '遗忘曲线与干扰', 'plan-demo-psych-long-term', d(14), d(20), now),
  ];

  return notes;
}
