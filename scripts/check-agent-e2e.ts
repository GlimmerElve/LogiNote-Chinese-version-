import assert from 'node:assert/strict';
import type { LlmCallResponse, NoteItem, ResourceItem } from '../src/types';
import { buildProjectPlanNotes, applyPlanTaskChange } from '../src/services/planAdjustmentService';
import { AGENT_ROLES, resolveAgentApproval, runAgentTurn } from '../src/services/agent/agentEngine';
import {
  clearAgentAudit,
  flushAgentAuditWrites,
  listAgentAuditRuns,
  listAgentHandoffAuditEvents,
  recordAgentHandoffAudit,
} from '../src/services/agent/auditStore';
import { buildAgentAcceptanceSnapshot } from '../src/services/agent/acceptance';
import {
  buildPlanDraftMutation,
  createPlanDraftSession,
  createPortfolioPlanDraftSession,
  stagePlanDraftBatch,
  stagePlanExecutionPatches,
  stagePlanMetaPatch,
  stagePlanMilestonePatches,
  stagePlanStructurePatches,
  stagePortfolioPlanPatches,
  summarizePlanDraft,
} from '../src/services/agent/planDraftService';
import {
  buildResourceDraftMutation,
  createResourceDraftSession,
  registerDiscoveredResources,
  stageResourceDraftBatch,
  summarizeResourceDraft,
  validateResourceSearchTarget,
} from '../src/services/agent/resourceDraftService';
import { buildPlanHandoff } from '../src/services/agent/workflowHandoff';
import { clearToolRegistryForTests, registerTool } from '../src/services/agent/toolRegistry';
import { registerPlanTools } from '../src/services/agent/tools/planTools';
import { registerResourceTools } from '../src/services/agent/tools/resourceTools';
import { registerQaTools } from '../src/services/agent/tools/qaTools';
import { registerUiTools } from '../src/services/agent/tools/uiTools';
import type {
  AgentPlanDraftSession,
  AgentResourceDraftSession,
  AgentRuntimeContext,
  AgentTurnResult,
  AgentWorkflowAction,
} from '../src/services/agent/types';

const NOW = '2026-09-29T08:00:00.000Z';
let notes: NoteItem[] = [];
let activeNoteId: string | undefined;
let planDraft: AgentPlanDraftSession | null = null;
let resourceDraft: AgentResourceDraftSession | null = null;
let idSequence = 0;
const launches: Array<Parameters<AgentRuntimeContext['enterLearningMode']>[0]> = [];

function nextId(prefix = 'e2e'): string {
  idSequence += 1;
  return `${prefix}-${idSequence}`;
}

function scriptedCaller(responses: LlmCallResponse[]) {
  let index = 0;
  const caller = async (): Promise<LlmCallResponse> => {
    const response = responses[index];
    if (!response) throw new Error(`脚本化 Provider 缺少第 ${index + 1} 个响应`);
    index += 1;
    return {
      ...response,
      usage: response.usage || { promptTokens: 120, completionTokens: 30 },
    };
  };
  return { caller, calls: () => index };
}

function findNote(title: string): NoteItem | undefined {
  return notes.find((note) => note.title === title);
}

const context: AgentRuntimeContext = {
  getNotes: () => notes,
  getActiveNote: () => notes.find((note) => note.id === activeNoteId) || null,
  navigate: () => {},
  openNoteByTitle: (title) => {
    const note = findNote(title);
    if (!note) return false;
    activeNoteId = note.id;
    return true;
  },
  enterLearningMode: (input) => {
    launches.push(input);
    return input.mode === 'scene' ? Boolean(input.sceneRequest) : input.mode === 'review';
  },
  createKnowledgeNote: async (input) => {
    const note: NoteItem = {
      id: nextId('knowledge'), title: input.title, content: input.content, noteType: 'knowledge',
      tags: input.tags || [], links: [], backlinks: [], dueDates: [], createdAt: NOW, updatedAt: NOW,
    };
    notes = [...notes, note];
    return { noteId: note.id, title: note.title, tags: note.tags };
  },
  applyPlanTaskChange: async (change) => {
    const mutation = applyPlanTaskChange(notes, change, NOW);
    notes = mutation.notes;
    return mutation.summary;
  },
  createProjectPlan: async (root, planMeta) => {
    const mutation = buildProjectPlanNotes(notes, root, NOW, () => nextId('project'), planMeta);
    notes = mutation.notes;
    activeNoteId = mutation.summary.rootNoteId;
    return mutation.summary;
  },
  appendProjectStudyTasks: async () => { throw new Error('端到端主链禁止绕过草案写任务'); },
  appendProjectStudyTaskBatch: async () => { throw new Error('端到端主链禁止绕过草案批量写任务'); },
  getPlanDraftSession: () => planDraft,
  startPlanDraftSession: (input) => {
    planDraft = input.scopeKind === 'portfolio'
      ? createPortfolioPlanDraftSession(notes, NOW, nextId('portfolio-draft'), input.rootProjectIds)
      : createPlanDraftSession(notes, {
        scopeProjectTitle: input.scopeProjectTitle,
        selectedProjectId: activeNoteId,
        mode: input.mode,
        purpose: input.purpose,
      }, NOW, nextId('plan-draft'));
    return summarizePlanDraft(planDraft);
  },
  stagePlanDraftBatch: (input) => {
    if (!planDraft) throw new Error('没有计划草案');
    planDraft = stagePlanDraftBatch(notes, planDraft, input, NOW);
    return summarizePlanDraft(planDraft);
  },
  stagePlanStructurePatches: (patches) => {
    if (!planDraft) throw new Error('没有计划草案');
    planDraft = stagePlanStructurePatches(notes, planDraft, patches, NOW);
    return summarizePlanDraft(planDraft);
  },
  stagePlanMetaPatch: (patch) => {
    if (!planDraft) throw new Error('没有计划草案');
    planDraft = stagePlanMetaPatch(notes, planDraft, patch, NOW);
    return summarizePlanDraft(planDraft);
  },
  stagePlanMilestonePatches: (patches) => {
    if (!planDraft) throw new Error('没有计划草案');
    planDraft = stagePlanMilestonePatches(notes, planDraft, patches, NOW);
    return summarizePlanDraft(planDraft);
  },
  stagePlanExecutionPatches: (patches) => {
    if (!planDraft) throw new Error('没有计划草案');
    planDraft = stagePlanExecutionPatches(notes, planDraft, patches, NOW);
    return summarizePlanDraft(planDraft);
  },
  stagePortfolioPlanPatches: (input) => {
    if (!planDraft) throw new Error('没有计划草案');
    planDraft = stagePortfolioPlanPatches(notes, planDraft, input, NOW);
    return summarizePlanDraft(planDraft);
  },
  discardPlanDraftSession: () => {
    const scopeProjectTitle = planDraft?.scopeProjectTitle;
    const discarded = Boolean(planDraft);
    planDraft = null;
    return { discarded, scopeProjectTitle };
  },
  commitPlanDraftSession: async () => {
    if (!planDraft) throw new Error('没有计划草案');
    const mutation = buildPlanDraftMutation(notes, planDraft, NOW, () => nextId('note'));
    notes = mutation.notes;
    const scopeProjectTitle = mutation.summary.rootProjectTitle;
    planDraft = null;
    return { scopeProjectTitle, ...mutation.summary };
  },
  getResourceDraftSession: () => resourceDraft,
  startResourceDraftSession: (input) => {
    resourceDraft = createResourceDraftSession(notes, {
      scopeProjectTitle: input.scopeProjectTitle,
      selectedProjectId: activeNoteId,
    }, NOW, nextId('resource-draft'));
    return summarizeResourceDraft(resourceDraft);
  },
  searchOnlineLearningResources: async (input) => {
    if (!resourceDraft) throw new Error('没有资源草案');
    const target = validateResourceSearchTarget(notes, resourceDraft, input);
    const resources: ResourceItem[] = [{
      title: `${target.knowledgeTitles[0]} 开放教程`,
      url: 'https://example.org/open-calculus',
      platform: 'Example Open Learning',
      kind: 'online',
      isFree: true,
    }];
    resourceDraft = registerDiscoveredResources(notes, resourceDraft, resources, {
      taskText: target.taskText,
      knowledgeTitles: target.knowledgeTitles,
    }, NOW);
    return { resources, markdown: resources.map((item) => `- [${item.title}](${item.url})`).join('\n') };
  },
  stageResourceDraftBatch: (projects) => {
    if (!resourceDraft) throw new Error('没有资源草案');
    resourceDraft = stageResourceDraftBatch(notes, resourceDraft, projects, NOW);
    return summarizeResourceDraft(resourceDraft);
  },
  discardResourceDraftSession: () => {
    const scopeProjectTitle = resourceDraft?.scopeProjectTitle;
    const discarded = Boolean(resourceDraft);
    resourceDraft = null;
    return { discarded, scopeProjectTitle };
  },
  commitResourceDraftSession: async () => {
    if (!resourceDraft) throw new Error('没有资源草案');
    const mutation = buildResourceDraftMutation(notes, resourceDraft, NOW);
    notes = mutation.notes;
    resourceDraft = null;
    return mutation.summary;
  },
  ensureDataFresh: async () => {},
};

function tool(id: string, name: string, args: Record<string, unknown>): LlmCallResponse {
  return { content: '', toolCalls: [{ id, name, arguments: args }] };
}

async function runWithApproval(input: {
  userText: string;
  beforeApproval: LlmCallResponse[];
  afterApproval?: LlmCallResponse[];
}): Promise<AgentTurnResult> {
  const script = scriptedCaller([
    ...input.beforeApproval,
    ...(input.afterApproval || [{ content: '已完成。' }]),
  ]);
  let result = await runAgentTurn({
    role: AGENT_ROLES.default, userText: input.userText, history: [], ctx: context,
    memoryPrefixLoader: async () => '', callLlm: script.caller,
  });
  assert.ok(result.pendingApproval, `${input.userText} 应产生审批卡片`);
  let approvalCount = 0;
  while (result.pendingApproval) {
    approvalCount += 1;
    assert.ok(approvalCount <= 4, `${input.userText} 审批次数异常`);
    result = await resolveAgentApproval({
      role: AGENT_ROLES.default,
      approval: result.pendingApproval,
      approved: true,
      history: result.updatedHistory,
      ctx: context,
      callLlm: script.caller,
    });
  }
  assert.equal(result.truncated, false);
  return result;
}

clearToolRegistryForTests();
registerPlanTools();
registerResourceTools();
registerQaTools();
registerUiTools();
// 端到端夹具固定检索证据，不访问用户真实索引或资料库。
registerTool({
  name: 'retrieve_qa_evidence', description: '测试证据检索',
  parameters: { type: 'object', required: ['question'], properties: { question: { type: 'string' } } },
  location: 'renderer', permission: 'readonly',
  execute: (args) => ({
    question: String(args.question || ''), requestedScope: 'global', appliedScope: 'global', coverage: 'sufficient',
    sources: [
      { sourceId: 'N1', type: 'note', entityId: 'knowledge-gradient', title: '梯度', snippet: '梯度与等高线正交。', score: 1 },
      { sourceId: 'D1', type: 'document', entityId: 'doc-calculus', title: 'calculus.pdf', snippet: '切向方向导数为零。', score: 0.9 },
    ],
    sourceIds: ['note:knowledge-gradient', 'document:doc-calculus'], warnings: [],
  }),
});
await clearAgentAudit();

// 1. 计划：写工具必须先暂停，批准后才真正创建项目树。
const planResult = await runWithApproval({
  userText: '帮我制定一个微积分学习计划，本轮不要联网',
  beforeApproval: [tool('plan-create', 'create_project_plan', {
    offlineDraft: true,
    root: {
      key: 'calculus-root', title: '微积分实践', startDate: '2026-10-01', dueDate: '2026-12-31', priority: 'high',
      tasks: [{
        key: 'daily-calculus', text: '每日完成一道微积分计算题', kind: 'practice',
        startDate: '2026-10-01', dueDate: '2026-12-31', estimatedMinutes: 30,
        executionKind: 'practice', recurrence: { frequency: 'daily', interval: 1, missedPolicy: 'rollover' },
        linkedProjectKey: 'derivative-project', launchMode: 'scene',
      }],
      children: [
        { key: 'derivative-project', title: '核心20%：导数应用', startDate: '2026-10-01', dueDate: '2026-10-31', priority: 'high', outcome: '范围：局部变化与最优化；选择依据：支撑变化率建模；验收：完成变化率模型；暂不包含：高级积分方法', children: [] },
        { key: 'integral-project', title: '扩展：积分应用', startDate: '2026-11-01', dueDate: '2026-11-30', priority: 'medium', outcome: '核心验收通过后独立完成面积模型', children: [] },
      ],
    },
    planMeta: {
      status: 'active', summary: '从导数到积分形成可应用的微积分能力；未联网核实',
      startDate: '2026-10-01', targetDate: '2026-12-31', weeklyBudgetMinutes: 600,
      activeWeekdays: [1, 2, 3, 4, 5, 6], autoAdjustPolicy: 'ask',
      conditions: { goalEvidence: '独立完成一次变化率与面积建模', startingLevel: 'basic', deadlineMode: 'hard' },
      milestones: [{ id: 'derivative-ready', title: '导数阶段验收', dueDate: '2026-10-31', projectId: 'derivative-project', criteria: ['能将导数用于真实变化率问题'] }],
    },
  })],
});
assert.equal(planResult.activeSkill?.id, 'plan-planning');
assert.equal(notes.filter((note) => note.noteType === 'project').length, 3);
const createdPlanRoot = notes.find((note) => note.title === '微积分实践');
assert.equal(createdPlanRoot?.planMeta?.weeklyBudgetMinutes, 600);
assert.equal(createdPlanRoot?.planMeta?.milestones?.length, 1);
assert.equal(createdPlanRoot?.dueDates.find((item) => item.taskText.includes('每日完成'))?.recurrence?.frequency, 'daily');
const revisedPlanResult = await runWithApproval({
  userText: '调整这个学习计划：每日投入改为 90 分钟，增加积分里程碑和每周复盘事项',
  beforeApproval: [
    tool('plan-workspace', 'query_plan_workspace', { rootProjectTitle: '微积分实践' }),
    tool('plan-draft-start', 'start_project_task_draft', { scopeProjectTitle: '微积分实践', mode: 'revise-subtree', purpose: 'plan-layout' }),
    tool('plan-meta-stage', 'stage_plan_settings_patch', { patch: { dailyStudyMinutes: 90 } }),
    tool('plan-milestone-stage', 'stage_plan_milestone_patches', { patches: [{
      operation: 'add', milestoneId: 'integral-ready', title: '积分阶段验收', dueDate: '2026-11-30',
      projectTitle: '扩展：积分应用', criteria: ['能用积分解决一次面积建模问题'],
    }] }),
    tool('plan-execution-stage', 'stage_plan_execution_patches', { patches: [{
      operation: 'add', taskId: 'weekly-calculus-review', noteTitle: '微积分实践', taskText: '每周复盘微积分模型',
      kind: 'review', executionKind: 'review', startDate: '2026-11-01', dueDate: '2026-11-01', estimatedMinutes: 45,
      recurrence: { frequency: 'weekly', interval: 1, weekdays: [0], endDate: '2026-12-31', missedPolicy: 'rollover' },
      milestoneId: 'integral-ready', linkedProjectTitle: '扩展：积分应用', launchMode: 'review',
    }] }),
    tool('plan-layout-commit', 'commit_project_task_draft', {}),
  ],
});
assert.equal(revisedPlanResult.activeSkill?.id, 'plan-planning');
assert.equal(findNote('微积分实践')?.planMeta?.dailyStudyMinutes, 90);
assert.equal(findNote('微积分实践')?.planMeta?.weeklyBudgetMinutes, 600, 'legacy budget is retained, not treated as personal capacity');
assert.equal(findNote('微积分实践')?.planMeta?.milestones?.some((item) => item.id === 'integral-ready'), true);
assert.equal(findNote('微积分实践')?.dueDates.find((item) => item.id === 'weekly-calculus-review')?.recurrence?.frequency, 'weekly');
await context.createProjectPlan({
  key: 'algebra-root', title: '线性代数实践', startDate: '2026-10-01', dueDate: '2026-12-15', priority: 'medium', tasks: [],
  children: [{ key: 'matrix-project', title: '矩阵计算', startDate: '2026-10-01', dueDate: '2026-10-31', priority: 'medium', tasks: [], children: [] }],
}, {
  status: 'active', startDate: '2026-10-01', targetDate: '2026-12-15', weeklyBudgetMinutes: 240,
  activeWeekdays: [1, 2, 3, 4, 5], autoAdjustPolicy: 'ask',
});
const calculusRootId = findNote('微积分实践')!.id;
const algebraRootId = findNote('线性代数实践')!.id;
const portfolioResult = await runWithApproval({
  userText: '请统筹所有学习计划，调整结构日期并平衡每周负荷',
  beforeApproval: [
    tool('portfolio-query', 'query_plan_portfolio', { rootProjectIds: [calculusRootId, algebraRootId] }),
    tool('portfolio-start', 'start_plan_portfolio_draft', { rootProjectIds: [calculusRootId, algebraRootId] }),
    tool('portfolio-stage', 'stage_plan_portfolio_patches', { roots: [
      { rootProjectId: calculusRootId, structurePatches: [{ operation: 'update', projectTitle: '扩展：积分应用', startDate: '2026-11-03', dueDate: '2026-11-30', priority: 'high' }] },
      { rootProjectId: algebraRootId, planMetaPatch: { dailyStudyMinutes: 60 } },
    ] }),
    tool('portfolio-commit', 'commit_project_task_draft', {}),
  ],
});
assert.equal(portfolioResult.activeSkill?.id, 'plan-planning');
assert.equal(findNote('扩展：积分应用')?.dueDates.find((item) => item.taskText === '扩展：积分应用')?.startDate, '2026-11-03');
assert.equal(findNote('线性代数实践')?.planMeta?.dailyStudyMinutes, 60);
assert.equal(planDraft, null, '综合草案必须在一次确认后整体提交并清空');
const planHandoff = buildPlanHandoff(planResult);
assert.ok(planHandoff);
const taskAction = planHandoff!.actions.find((action) => action.targetSkillId === 'study-task-generation') as AgentWorkflowAction;
assert.ok(taskAction);
await recordAgentHandoffAudit({ handoff: planHandoff!, status: 'created' });
await recordAgentHandoffAudit({ handoff: planHandoff!, status: 'accepted', action: taskAction });

// 2. 任务：只读取并修改两个末级项目，根项目中的周期执行事项必须保留。
const taskResult = await runWithApproval({
  userText: taskAction.prompt,
  beforeApproval: [
    tool('task-start', 'start_project_task_draft', { scopeProjectTitle: '微积分实践', mode: 'full-task-generation', purpose: 'study-tasks' }),
    tool('task-scope', 'query_leaf_project_task_scope', { rootProjectTitle: '微积分实践', offset: 0 }),
    tool('task-stage', 'stage_project_study_task_batch', {
      projects: [
        { projectTitle: '核心20%：导数应用', tasks: ['解释 [[导数]] 的局部变化含义', '用 [[导数]] 分析一个最优化问题'] },
        { projectTitle: '扩展：积分应用', tasks: ['解释 [[积分]] 的累积含义', '用 [[积分]] 计算一个面积模型'] },
      ],
      createKnowledgeNotes: ['导数', '积分'],
    }),
    tool('task-query', 'query_project_task_draft', {}),
    tool('task-commit', 'commit_project_task_draft', {}),
  ],
});
assert.equal(taskResult.activeSkill?.id, 'study-task-generation');
assert.match(findNote('微积分实践')?.content || '', /每日完成一道微积分计算题/, '根项目的周期执行事项不得被末级任务草案覆盖');
assert.match(findNote('核心20%：导数应用')?.content || '', /\[\[导数\]\]/);
assert.match(findNote('扩展：积分应用')?.content || '', /\[\[积分\]\]/);
await recordAgentHandoffAudit({
  handoff: planHandoff!, status: 'arrived', action: taskAction,
  actualTargetSkillId: taskResult.activeSkill?.id, agentRunId: taskResult.auditRunId,
});

// 3. 资源：URL 必须先由搜索工具登记，再暂存并经批准写入。
const resourceResult = await runWithApproval({
  userText: '请为项目“微积分实践”统筹免费学习资源',
  beforeApproval: [
    tool('resource-start', 'start_project_resource_draft', { scopeProjectTitle: '微积分实践' }),
    tool('resource-context', 'query_project_resource_context', { offset: 0 }),
    tool('resource-search', 'search_online_learning_resources', {
      projectTitle: '核心20%：导数应用', taskText: '解释 [[导数]] 的局部变化含义', knowledgeTitles: ['导数'],
    }),
    tool('resource-stage', 'stage_project_resource_batch', {
      projects: [{
        projectTitle: '核心20%：导数应用', resources: [{
          title: '导数 开放教程', url: 'https://example.org/open-calculus', platform: 'Example Open Learning', kind: 'online',
          taskText: '解释 [[导数]] 的局部变化含义', knowledgeTitles: ['导数'], reason: '直接解释局部变化并提供练习。',
          level: 'beginner', language: 'zh-CN', isFree: true,
        }],
      }],
    }),
    tool('resource-query', 'query_project_resource_draft', {}),
    tool('resource-commit', 'commit_project_resource_draft', {}),
  ],
});
assert.equal(resourceResult.activeSkill?.id, 'resource-curation');
assert.equal(findNote('核心20%：导数应用')?.resources?.[0]?.url, 'https://example.org/open-calculus');

// 4. 答疑：自动证据预检必须发生，且流程不得写数据。
const qa = scriptedCaller([{ content: '根据本地材料，等高线切向方向的方向导数为零，因此梯度与等高线正交 [N1][D1]。' }]);
const qaResult = await runAgentTurn({
  role: AGENT_ROLES.default, userText: '为什么梯度垂直于等高线？', history: [], ctx: context,
  memoryPrefixLoader: async () => '', callLlm: qa.caller,
});
assert.equal(qaResult.activeSkill?.id, 'personalized-qa');
assert.equal(qaResult.toolTrace[0]?.call.name, 'retrieve_qa_evidence');

// 5. 场景与 6. 复习：Agent 只负责进入专用页面，不在对话框内伪造学习结果。
const scene = scriptedCaller([
  tool('scene-enter', 'enter_learning_mode', {
    mode: 'scene',
    sceneRequest: {
      source: 'build', subject: '微积分实践', knowledgePoints: ['导数', '积分'],
      sceneSkill: 'S1', recipeId: 'guided-practice',
    },
  }),
  { content: '已进入场景预览。' },
]);
const sceneResult = await runAgentTurn({
  role: AGENT_ROLES.default, userText: '帮我为微积分实践搭建一个应用练习场景', history: [], ctx: context,
  memoryPrefixLoader: async () => '', callLlm: scene.caller,
});
assert.equal(sceneResult.activeSkill?.id, 'scene-setup');

const review = scriptedCaller([
  tool('review-enter', 'enter_learning_mode', { mode: 'review', noteTitle: '导数' }),
  { content: '已进入专用复习页面。' },
]);
const reviewResult = await runAgentTurn({
  role: AGENT_ROLES.default, userText: '带我复习导数', history: [], ctx: context,
  memoryPrefixLoader: async () => '', callLlm: review.caller,
});
assert.equal(reviewResult.activeSkill?.id, 'socratic-review');
assert.deepEqual(launches.map((item) => item.mode), ['scene', 'review']);

// 7. 知识点捕获：必须展示草案并经批准后创建。
const knowledgeCaptureResult = await runWithApproval({
  userText: '[selection_action:knowledge_draft] 请把“梯度表示最陡上升方向”整理成知识点笔记草案',
  beforeApproval: [tool('knowledge-create', 'create_knowledge_note', {
    title: '梯度的几何意义',
    content: '## 定义\n梯度指向标量场局部增长最快的方向。\n\n## 关键要点\n其方向给出最陡上升方向，模长给出最大方向导数。\n\n## 例子\n在等高线上，梯度与切向方向正交。\n\n## 来源\n用户选中的 Agent 回答片段，待结合资料核实。',
    tags: ['微积分'],
  })],
});
assert.equal(knowledgeCaptureResult.activeSkill?.id, 'knowledge-capture');
assert.ok(findNote('梯度的几何意义'));

await flushAgentAuditWrites();
const acceptance = buildAgentAcceptanceSnapshot({
  runs: await listAgentAuditRuns(100),
  handoffs: await listAgentHandoffAuditEvents(100),
});
assert.equal(acceptance.total, 8);
assert.equal(acceptance.passed, 8, acceptance.scenarios.map((item) => `${item.name}:${item.status}:${item.issues.join('|')}`).join('\n'));
assert.equal(acceptance.failed, 0);
assert.equal(acceptance.incomplete, 0);
assert.equal(acceptance.notRun, 0);
assert.equal(acceptance.passRate, 100);
const resourceAcceptance = acceptance.scenarios.find((item) => item.id === 'resource-curation');
assert.match(resourceAcceptance?.testPrompt || '', /不要编造 URL/u);
assert.equal((resourceAcceptance?.prerequisites.length || 0) >= 2, true);
const emptyAcceptance = buildAgentAcceptanceSnapshot({ runs: [], handoffs: [] });
assert.equal(emptyAcceptance.scenarios.every((item) => item.prerequisites.length > 0), true);
assert.equal(emptyAcceptance.scenarios.find((item) => item.id === 'resource-curation')?.status, 'not-run');

const auditedRuns = await listAgentAuditRuns(100);
const auditedHandoffs = await listAgentHandoffAuditEvents(100);
const qaAudit = auditedRuns.find((run) => run.skillId === 'personalized-qa');
assert.ok(qaAudit);
const missingEvidence = buildAgentAcceptanceSnapshot({
  runs: [{
    ...qaAudit!,
    steps: qaAudit!.steps.map((step) => step.name === 'retrieve_qa_evidence' ? { ...step, sourceIds: undefined } : step),
  }],
  handoffs: [],
});
assert.equal(missingEvidence.scenarios.find((item) => item.id === 'personalized-qa')?.status, 'failed', '无来源答疑不得通过验收');
const pendingPlanAudit = auditedRuns.find((run) => run.skillId === 'plan-planning' && run.steps.some((step) => step.name === 'create_project_plan'));
assert.ok(pendingPlanAudit);
const pendingSnapshot = buildAgentAcceptanceSnapshot({
  runs: [{ ...pendingPlanAudit!, status: 'pending-approval' }],
  handoffs: auditedHandoffs,
});
assert.equal(pendingSnapshot.scenarios.find((item) => item.id === 'plan-create')?.status, 'incomplete', '等待确认不等于验收通过');

console.log('agent e2e acceptance check passed');
