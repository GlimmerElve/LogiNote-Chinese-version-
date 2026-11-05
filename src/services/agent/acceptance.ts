import type { AgentAuditRun, AgentHandoffAuditEvent } from './auditStore';

export type AgentAcceptanceStatus = 'passed' | 'failed' | 'incomplete' | 'not-run';

export interface AgentAcceptanceCheck {
  id: string;
  label: string;
  passed: boolean;
  detail?: string;
}

export interface AgentAcceptanceScenarioResult {
  id: string;
  name: string;
  status: AgentAcceptanceStatus;
  runId?: string;
  updatedAt?: string;
  checks: AgentAcceptanceCheck[];
  issues: string[];
  /** User-reviewed prompt for producing a real-provider sample; never sent automatically. */
  testPrompt?: string;
  prerequisites: string[];
}

export interface AgentAcceptanceSnapshot {
  total: number;
  passed: number;
  failed: number;
  incomplete: number;
  notRun: number;
  passRate: number;
  scenarios: AgentAcceptanceScenarioResult[];
}

interface RunScenarioDefinition {
  id: string;
  name: string;
  skillId: string;
  /** 用工具特征区分同一 Skill 下的不同工作流。 */
  signatureTools: string[];
  requiredTools: string[];
  requireEvidenceSource?: boolean;
  requireApprovedWrite?: boolean;
  forbidWrites?: boolean;
  maxToolCalls: number;
  maxLlmCalls: number;
  testPrompt: string;
  prerequisites: string[];
}

const RUN_SCENARIOS: RunScenarioDefinition[] = [
  {
    id: 'plan-create', name: '创建学习计划', skillId: 'plan-planning',
    signatureTools: ['create_project_plan'], requiredTools: ['create_project_plan'],
    requireApprovedWrite: true, maxToolCalls: 8, maxLlmCalls: 4,
    testPrompt: '帮我制定一个真实可用的学习计划。请先确认学习目标、可验收成果、当前基础、起止日期、每周预算和学习日；为结构项目编排父子时间范围，设置至少一个可验收里程碑，并加入一个无需创建项目笔记的周期执行事项。写入前让我确认完整蓝图。',
    prerequisites: ['已配置并启用一个 LLM Provider', '准备一个真实学习目标与周期活动需求', 'Agent 确认后导入草图，仍需在计划编辑器最终确认才会写入'],
  },
  {
    id: 'leaf-task-generation', name: '末级项目任务生成', skillId: 'study-task-generation',
    signatureTools: ['start_project_task_draft', 'query_leaf_project_task_scope', 'stage_project_study_task_batch'],
    requiredTools: ['start_project_task_draft', 'query_leaf_project_task_scope', 'stage_project_study_task_batch', 'commit_project_task_draft'],
    requireApprovedWrite: true, maxToolCalls: 12, maxLlmCalls: 8,
    testPrompt: '请为当前选中的项目批量生成学习任务清单，只处理项目树中的末级项目，并把每条任务显式关联到需要掌握的 [[知识点]]；提交前让我检查完整草案。',
    prerequisites: ['先在侧栏选中一个已有项目', '项目树中至少有一个末级项目', '确认后会写入任务并可能创建知识点笔记'],
  },
  {
    id: 'resource-curation', name: '学习资源统筹', skillId: 'resource-curation',
    signatureTools: ['start_project_resource_draft', 'query_project_resource_context', 'search_online_learning_resources'],
    requiredTools: ['start_project_resource_draft', 'query_project_resource_context', 'search_online_learning_resources'],
    requireApprovedWrite: true, maxToolCalls: 16, maxLlmCalls: 8,
    testPrompt: '请为当前选中的项目统筹免费学习资源。先读取真实任务和关联知识点，再搜索和筛选候选；不要编造 URL，在资源工作台中让我确认后直接写回。',
    prerequisites: ['先选中一个含学习任务和 [[知识点]] 的项目', '联网搜索需要确认，工作台“确认并写回”是最终收录授权', '需要登录的网站由我在隔离窗口中操作'],
  },
  {
    id: 'personalized-qa', name: '个性化 RAG 答疑', skillId: 'personalized-qa',
    signatureTools: ['retrieve_qa_evidence'], requiredTools: ['retrieve_qa_evidence'],
    requireEvidenceSource: true, forbidWrites: true, maxToolCalls: 8, maxLlmCalls: 4,
    testPrompt: '请结合我的本地笔记和已导入资料，解释我当前正在学习的一个核心概念；明确区分本地证据与通用解释，并给出可点击追溯的引用。',
    prerequisites: ['资料库或笔记中已有与问题相关的内容', '问题应明确指向一个具体概念', '本流程不会修改笔记或掌握度'],
  },
  {
    id: 'scene-setup', name: '个性化场景搭设', skillId: 'scene-setup',
    signatureTools: ['enter_learning_mode'], requiredTools: ['enter_learning_mode'],
    forbidWrites: true, maxToolCalls: 10, maxLlmCalls: 5,
    testPrompt: '请根据当前项目和我的学习情况，搭建一个需要我实际操作或作答的应用练习场景，并先进入场景预览。',
    prerequisites: ['建议先选中一个项目或知识点', '生成后需要在场景页完成真实互动', '仅搭设场景不会更新掌握度'],
  },
  {
    id: 'socratic-review', name: '苏格拉底式复习入口', skillId: 'socratic-review',
    signatureTools: ['enter_learning_mode'], requiredTools: ['enter_learning_mode'],
    forbidWrites: true, maxToolCalls: 8, maxLlmCalls: 4,
    testPrompt: '带我复习当前选中的知识点或项目；请进入专门的复习页面，从一个回忆问题开始。',
    prerequisites: ['先选中一个知识点或项目笔记', '正式作答和评分在复习页完成', '只有有效复习结果才会回写掌握度'],
  },
  {
    id: 'knowledge-capture', name: '知识点草案创建', skillId: 'knowledge-capture',
    signatureTools: ['create_knowledge_note'], requiredTools: ['create_knowledge_note'],
    requireApprovedWrite: true, maxToolCalls: 4, maxLlmCalls: 3,
    testPrompt: '[selection_action:knowledge_draft] 请把我刚才选中的回答片段整理成知识点笔记草案，先给出完整内容，确认后再创建。',
    prerequisites: ['先在 Agent 回答中选择一段有独立知识价值的内容', '创建前会显示完整草案并请求确认', '不会自动修改已有笔记或掌握度'],
  },
];

function percent(numerator: number, denominator: number): number {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

function toolNames(run: AgentAuditRun): string[] {
  return run.steps.map((step) => step.name);
}

function hasOrderedSubsequence(actual: string[], required: string[]): boolean {
  let cursor = 0;
  for (const name of actual) {
    if (name === required[cursor]) cursor += 1;
    if (cursor === required.length) return true;
  }
  return required.length === 0;
}

function findLatestRun(runs: AgentAuditRun[], definition: RunScenarioDefinition): AgentAuditRun | undefined {
  return runs
    .filter((run) => run.skillId === definition.skillId)
    .filter((run) => {
      const names = new Set(toolNames(run));
      return definition.signatureTools.some((name) => names.has(name));
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
}

function resultStatus(run: AgentAuditRun, checks: AgentAcceptanceCheck[]): AgentAcceptanceStatus {
  if (run.status === 'running' || run.status === 'pending-approval') return 'incomplete';
  if (run.status !== 'completed') return 'failed';
  return checks.every((check) => check.passed) ? 'passed' : 'failed';
}

function evaluateRunScenario(runs: AgentAuditRun[], definition: RunScenarioDefinition): AgentAcceptanceScenarioResult {
  const run = findLatestRun(runs, definition);
  if (!run) return {
    id: definition.id,
    name: definition.name,
    status: 'not-run',
    checks: [],
    issues: [],
    testPrompt: definition.testPrompt,
    prerequisites: definition.prerequisites,
  };

  const names = toolNames(run);
  const failedSteps = run.steps.filter((step) => !step.ok);
  const approvedWrite = run.approvals.some((approval) => approval.status === 'approved');
  const evidenceStep = run.steps.find((step) => step.name === 'retrieve_qa_evidence' && step.ok);
  const checks: AgentAcceptanceCheck[] = [
    { id: 'completed', label: '流程正常完成', passed: run.status === 'completed', detail: run.status },
    { id: 'tools-succeeded', label: '工具调用无失败', passed: failedSteps.length === 0, detail: failedSteps.map((step) => step.name).join('、') || undefined },
    {
      id: 'required-tools', label: '关键工具按顺序到达',
      passed: hasOrderedSubsequence(names, definition.requiredTools),
      detail: definition.requiredTools.filter((name) => !names.includes(name)).join('、') || undefined,
    },
    {
      id: 'tool-budget', label: `工具调用不超过 ${definition.maxToolCalls} 次`,
      passed: run.steps.length <= definition.maxToolCalls,
      detail: `${run.steps.length} 次`,
    },
    {
      id: 'llm-budget', label: `主 Agent 请求不超过 ${definition.maxLlmCalls} 次`,
      passed: Boolean(run.runtime) && (run.runtime?.llmCalls || 0) <= definition.maxLlmCalls,
      detail: run.runtime ? `${run.runtime.llmCalls} 次，${run.runtime.promptTokens + run.runtime.completionTokens} tokens` : '旧样本未记录调用量',
    },
  ];
  if (definition.requireApprovedWrite) {
    checks.push({ id: 'approval', label: '写入经过用户确认', passed: approvedWrite });
  }
  if (definition.forbidWrites) {
    const writes = run.steps.filter((step) => step.permission === 'write');
    checks.push({ id: 'no-write', label: '只读/导航流程未写数据', passed: writes.length === 0, detail: writes.map((step) => step.name).join('、') || undefined });
  }
  if (definition.requireEvidenceSource) {
    checks.push({
      id: 'evidence', label: '答疑取得可追溯本地来源',
      passed: Boolean(evidenceStep?.sourceIds?.length),
      detail: evidenceStep?.sourceIds?.length ? `${evidenceStep.sourceIds.length} 个来源` : '没有来源',
    });
  }
  const issues = checks.filter((check) => !check.passed).map((check) => check.detail ? `${check.label}：${check.detail}` : check.label);
  return {
    id: definition.id,
    name: definition.name,
    status: resultStatus(run, checks),
    runId: run.id,
    updatedAt: run.updatedAt,
    checks,
    issues,
    testPrompt: definition.testPrompt,
    prerequisites: definition.prerequisites,
  };
}

function evaluateHandoff(handoffs: AgentHandoffAuditEvent[]): AgentAcceptanceScenarioResult {
  const groups = new Map<string, AgentHandoffAuditEvent[]>();
  for (const event of handoffs) groups.set(event.handoffId, [...(groups.get(event.handoffId) || []), event]);
  const latest = [...groups.values()]
    .filter((events) => events.some((event) => event.status === 'created'))
    .sort((a, b) => Math.max(...b.map((event) => Date.parse(event.createdAt))) - Math.max(...a.map((event) => Date.parse(event.createdAt))))[0];
  if (!latest) return {
    id: 'workflow-handoff', name: 'Skill 流程移交', status: 'not-run', checks: [], issues: [],
    prerequisites: ['先完成一次计划、场景或复习流程', '在“建议的下一步”卡片中主动选择一个动作'],
  };

  const accepted = latest.filter((event) => event.status === 'accepted');
  const arrived = latest.filter((event) => event.status === 'arrived');
  const abnormal = latest.filter((event) => event.status === 'route-mismatch' || event.status === 'failed');
  const matched = accepted.some((acceptance) => arrived.some((arrival) => (
    arrival.actionId === acceptance.actionId
    && arrival.expectedTargetSkillId === arrival.actualTargetSkillId
  )));
  const checks: AgentAcceptanceCheck[] = [
    { id: 'accepted', label: '用户主动接受下一步', passed: accepted.length > 0 },
    { id: 'arrived', label: '目标 Skill 正确到达', passed: matched },
    { id: 'no-route-error', label: '没有路由失配或失败', passed: abnormal.length === 0 },
  ];
  const issues = checks.filter((check) => !check.passed).map((check) => check.label);
  const incomplete = accepted.length === 0 || arrived.length === 0;
  return {
    id: 'workflow-handoff', name: 'Skill 流程移交',
    status: incomplete ? 'incomplete' : checks.every((check) => check.passed) ? 'passed' : 'failed',
    runId: latest[0]?.handoffId,
    updatedAt: latest.map((event) => event.createdAt).sort().at(-1),
    checks,
    issues,
    prerequisites: ['先完成一次计划、场景或复习流程', '在“建议的下一步”卡片中主动选择一个动作'],
  };
}

export function buildAgentAcceptanceSnapshot(input: {
  runs: AgentAuditRun[];
  handoffs: AgentHandoffAuditEvent[];
}): AgentAcceptanceSnapshot {
  const scenarios = [
    ...RUN_SCENARIOS.map((definition) => evaluateRunScenario(input.runs, definition)),
    evaluateHandoff(input.handoffs),
  ];
  const passed = scenarios.filter((scenario) => scenario.status === 'passed').length;
  const failed = scenarios.filter((scenario) => scenario.status === 'failed').length;
  const incomplete = scenarios.filter((scenario) => scenario.status === 'incomplete').length;
  const notRun = scenarios.filter((scenario) => scenario.status === 'not-run').length;
  return {
    total: scenarios.length,
    passed,
    failed,
    incomplete,
    notRun,
    passRate: percent(passed, passed + failed + incomplete),
    scenarios,
  };
}
