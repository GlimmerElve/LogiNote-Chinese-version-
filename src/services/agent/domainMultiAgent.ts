import type { LlmCallRequest, LlmCallResponse } from '../../types';
import { callLLM } from '../llmService';
import { AgentCoordinator } from './agentCoordinator';
import type {
  AgentArtifact,
  AgentArtifactKind,
  AgentCoordinationSummary,
  AgentCoordinationWorkflowId,
  AgentSpecialistId,
} from './types';

export type DomainCoordinationSkillId = 'plan-planning' | 'study-task-generation' | 'resource-curation';
type DomainCoordinationLlmCaller = (request: LlmCallRequest) => Promise<LlmCallResponse>;

export interface DomainStrategyArtifactData {
  skillId: DomainCoordinationSkillId;
  mode: string;
  objective: string;
  focusAreas: string[];
  strategySteps: string[];
  openQuestions: string[];
}

export interface DomainPolicyReviewArtifactData extends DomainStrategyArtifactData {
  valid: boolean;
  hardConstraints: string[];
  diagnosticCodes: string[];
}

export interface DomainMultiAgentResult {
  recommendation: DomainPolicyReviewArtifactData;
  prompt: string;
  coordination: AgentCoordinationSummary;
}

interface DomainWorkflowConfig {
  workflowId: AgentCoordinationWorkflowId;
  strategistId: AgentSpecialistId;
  reviewerId: AgentSpecialistId;
  strategyArtifact: AgentArtifactKind;
  modes: readonly string[];
  inferMode: (request: string) => string;
  strategistPrompt: string;
  fallbackFocus: string[];
  fallbackSteps: string[];
  hardConstraints: string[];
}

const CONFIGS: Record<DomainCoordinationSkillId, DomainWorkflowConfig> = {
  'plan-planning': {
    workflowId: 'learning-plan-v1',
    strategistId: 'plan-architect',
    reviewerId: 'plan-policy-reviewer',
    strategyArtifact: 'plan-strategy',
    modes: ['create', 'revise-structure', 'reschedule', 'portfolio', 'plan-layout', 'milestone', 'execution-track', 'conditions'],
    inferMode: (request) => /(?:综合总览|多计划|所有(?:学习)?计划|全部(?:根)?项目|多个根计划|跨计划)/u.test(request)
      ? 'portfolio'
      : /(?:里程碑|验收节点)/u.test(request)
        ? 'milestone'
        : /(?:执行事项|周期事项|重复任务|提醒)/u.test(request)
          ? 'execution-track'
          : /(?:每周预算|学习日|起始水平|目标证据|截止日强度|计划条件)/u.test(request)
            ? 'conditions'
            : /(?:计划设置|计划布局|双轨|时间轨)/u.test(request)
              ? 'plan-layout'
              : /(?:改期|延期|提前|优先级|日期)/u.test(request)
                ? 'reschedule'
                : /(?:调整|修改|修订|重排|拆分|合并|结构|项目树)/u.test(request)
                  ? 'revise-structure'
                  : 'create',
    strategistPrompt: 'Plan the learning path at strategy level: goal evidence, prerequisite order, milestones, workload and adaptation. Do not claim that any project, task or note already exists.',
    fallbackFocus: ['目标与可验证达成标准', '前置知识与项目层级', '时间负荷与阶段里程碑'],
    fallbackSteps: ['先读取真实计划范围和学习状态', '形成范围内结构草案', '检查约束后请求一次最终确认'],
    hardConstraints: [
      '新计划一次最多 60 个项目节点；层级不作业务限制，五级及更深由界面折叠。',
      '结构项目创建笔记；周期执行事项不创建笔记，也不得为每个项目机械生成。',
      '里程碑只表示可验收的关键节点，初始状态必须未完成，最终状态由用户手动验收。',
      '修改已有计划时只能操作范围锁定板块及其后代。',
      '综合计划只能使用界面提供的 rootProjectIds 锁定多个真实根计划，不得按标题猜测或跨根移动项目。',
      '计划设置、里程碑和执行事项必须通过各自补丁协议暂存，不得退化为正文文本。',
      '根项目和中间项目以子项目标题表达任务，不默认生成正文任务。',
      '未经工具成功结果不得声称已创建或修改计划；写入仍需用户确认。',
    ],
  },
  'study-task-generation': {
    workflowId: 'study-task-v1',
    strategistId: 'task-designer',
    reviewerId: 'task-policy-reviewer',
    strategyArtifact: 'task-strategy',
    modes: ['full-generate', 'revise-subtree'],
    inferMode: (request) => /(?:修订|调整|修改|重做|局部|这个板块)/u.test(request) ? 'revise-subtree' : 'full-generate',
    strategistPrompt: 'Design a task-generation strategy for leaf projects: observable actions, progression, application evidence and knowledge-link coverage. Do not invent leaf project names or knowledge notes.',
    fallbackFocus: ['末级项目的真实学习产出', '从理解到应用的任务梯度', '知识点 wiki 链接覆盖'],
    fallbackSteps: ['先锁定项目范围并分页读取末级项目', '按末级项目生成可验证任务', '暂存全部批次后请求一次最终确认'],
    hardConstraints: [
      '只能给锁定子树中的末级项目生成正文学习任务。',
      '每个末级项目 1 至 7 条任务，每条至少显式引用一个 [[知识点]]。',
      '缺失知识点必须列入待创建清单并被任务实际引用。',
      '任务 Skill 不修改项目层级、标题、日期、优先级或资源。',
    ],
  },
  'resource-curation': {
    workflowId: 'resource-curation-v1',
    strategistId: 'resource-strategist',
    reviewerId: 'resource-policy-reviewer',
    strategyArtifact: 'resource-strategy',
    modes: ['curate', 'replace', 'recheck'],
    inferMode: (request) => /(?:复核|失效|链接状态|可访问)/u.test(request)
      ? 'recheck'
      : /(?:替换|移除|删除|不适合)/u.test(request)
        ? 'replace'
        : 'curate',
    strategistPrompt: 'Define resource selection strategy by task, level, modality, quality, accessibility and learner fit. Never output, guess or fabricate a URL.',
    fallbackFocus: ['资源与真实任务的直接对应', '难度、语言和媒介适配', '免费性、可访问性与来源质量'],
    fallbackSteps: ['先读取任务、知识点和历史反馈', '优先检索已有资料，再按真实任务打开外部资源工作台', '用户在工作台最终确认后直接收录并续办未处理任务'],
    hardConstraints: [
      '资源必须绑定锁定范围内真实存在的任务及其显式知识点。',
      '在线 URL 只能来自搜索工具或笔记已有资源，禁止模型编造。',
      '外部资源必须明确免费；每条任务最多 3 个、每个项目最多 15 个。',
      '移除资源必须是用户明确要求，且目标 URL 当前真实存在。',
    ],
  },
};

const CONTINUATION_ONLY = /^(?:请)?(?:继续|查看|检查|提交|确认|放弃|取消|下一批|下一步|重试)(?:当前|这个|该)?(?:计划|任务|资源)?(?:草案|批次)?[。.!！]?$/u;
const SIMPLE_RESCHEDULE = /^(?:请)?(?:把|将)?.{0,40}(?:任务|待办).{0,24}(?:改期|延期|提前|调整优先级)/u;

export function shouldRunDomainCoordination(skillId: string | undefined, userRequest: string): skillId is DomainCoordinationSkillId {
  if (!skillId || !(skillId in CONFIGS)) return false;
  const request = userRequest.trim();
  if (!request || CONTINUATION_ONLY.test(request)) return false;
  if (skillId === 'plan-planning' && SIMPLE_RESCHEDULE.test(request)) return false;
  return true;
}

function compactText(value: unknown, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text.slice(0, max);
}

function compactList(value: unknown, maxItems: number, maxChars: number): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => compactText(item, maxChars)).filter(Boolean))].slice(0, maxItems);
}

function readJsonObject(response: LlmCallResponse): Record<string, unknown> | undefined {
  if (response.parsedJson && typeof response.parsedJson === 'object' && !Array.isArray(response.parsedJson)) {
    return response.parsedJson as Record<string, unknown>;
  }
  const content = response.content || '';
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(content.slice(start, end + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function artifactPayload<T>(artifact: AgentArtifact | undefined): T | undefined {
  return artifact?.payload as T | undefined;
}

function fallbackStrategy(skillId: DomainCoordinationSkillId, request: string, config: DomainWorkflowConfig): DomainStrategyArtifactData {
  return {
    skillId,
    mode: config.inferMode(request),
    objective: compactText(request, 240) || '完成用户指定的学习工作流',
    focusAreas: [...config.fallbackFocus],
    strategySteps: [...config.fallbackSteps],
    openQuestions: [],
  };
}

function normalizeStrategy(
  value: Record<string, unknown> | undefined,
  fallback: DomainStrategyArtifactData,
  config: DomainWorkflowConfig,
): DomainStrategyArtifactData | undefined {
  if (!value || typeof value.mode !== 'string' || !config.modes.includes(value.mode)) return undefined;
  const focusAreas = compactList(value.focusAreas, 6, 120);
  const strategySteps = compactList(value.strategySteps, 6, 160);
  if (!focusAreas.length || !strategySteps.length) return undefined;
  return {
    skillId: fallback.skillId,
    mode: value.mode,
    objective: compactText(value.objective, 240) || fallback.objective,
    focusAreas,
    strategySteps,
    openQuestions: compactList(value.openQuestions, 4, 140),
  };
}

export async function runDomainMultiAgent(input: {
  skillId: DomainCoordinationSkillId;
  userRequest: string;
  memoryPrefix?: string;
  callLlm?: DomainCoordinationLlmCaller;
  runId?: string;
}): Promise<DomainMultiAgentResult> {
  const config = CONFIGS[input.skillId];
  const invoke = input.callLlm || callLLM;
  const coordinator = new AgentCoordinator({
    workflowId: config.workflowId,
    userRequest: input.userRequest,
    runId: input.runId ? `${input.runId}:${config.workflowId}` : undefined,
    budget: { maxTasks: 2, maxLlmCalls: 1, maxToolCalls: 0, maxOutputChars: 2400 },
  });
  const fallback = fallbackStrategy(input.skillId, input.userRequest, config);
  let fallbackApplied = false;

  const strategyArtifact = await coordinator.runSpecialist<DomainStrategyArtifactData>({
    specialistId: config.strategistId,
    objective: `Create a bounded strategy for ${input.skillId}.`,
    runner: async ({ task }) => {
      let response: LlmCallResponse | undefined;
      try {
        response = await invoke({
          providerId: '', model: '', workflow: input.skillId === 'plan-planning'
            ? 'plan-generation'
            : input.skillId === 'study-task-generation'
              ? 'agent-study-task-generation'
              : 'agent-resource-curation',
          skipMemoryInjection: true,
          systemPromptOverride: `You are a read-only specialist in a multi-agent learning assistant. ${config.strategistPrompt}\nReturn one JSON object only, under ${task.budget.maxOutputChars} characters.\nSchema: {"mode":"${config.modes.join('|')}","objective":"...","focusAreas":["..."],"strategySteps":["..."],"openQuestions":["..."]}.\nThis output is advisory. Do not include hidden reasoning, URLs, fabricated project facts, note contents, or claims that an action was completed.`,
          userInput: JSON.stringify({
            request: compactText(input.userRequest, 1200),
            memoryEvidence: compactText(input.memoryPrefix, 1600),
          }),
        });
      } catch {
        fallbackApplied = true;
      }
      const normalized = normalizeStrategy(response ? readJsonObject(response) : undefined, fallback, config);
      if (!normalized) fallbackApplied = true;
      const payload = normalized || fallback;
      return {
        payload,
        llmCalls: 1,
        toolCalls: 0,
        outputChars: JSON.stringify(payload).length,
        validation: { status: 'valid', diagnostics: normalized ? [] : ['domain-strategy-fallback'] },
      };
    },
  });
  const strategy = artifactPayload<DomainStrategyArtifactData>(strategyArtifact) || fallback;

  const reviewArtifact = await coordinator.runSpecialist<DomainPolicyReviewArtifactData>({
    specialistId: config.reviewerId,
    objective: `Apply deterministic policy boundaries for ${input.skillId}.`,
    inputArtifacts: strategyArtifact ? [strategyArtifact] : [],
    runner: () => {
      const payload: DomainPolicyReviewArtifactData = {
        ...strategy,
        valid: true,
        hardConstraints: [...config.hardConstraints],
        diagnosticCodes: [],
      };
      return {
        payload,
        llmCalls: 0,
        toolCalls: 0,
        outputChars: JSON.stringify(payload).length,
        validation: { status: 'valid', diagnostics: [] },
      };
    },
  });
  const recommendation = artifactPayload<DomainPolicyReviewArtifactData>(reviewArtifact) || {
    ...fallback,
    valid: true,
    hardConstraints: [...config.hardConstraints],
    diagnosticCodes: ['domain-policy-reviewer-fallback'],
  };
  if (!reviewArtifact) fallbackApplied = true;

  const prompt = `\n\n[Multi-agent domain execution brief]\nA read-only specialist proposed the execution strategy below. It is advisory and contains no verified project facts. Before acting, use the current Skill tools to read the real scope, notes, tasks and state. Follow the existing draft lock, tool whitelist and user-confirmation flow.\n- workflow: ${config.workflowId}\n- mode: ${recommendation.mode}\n- objective: ${recommendation.objective}\n- focus: ${recommendation.focusAreas.join('; ')}\n- strategy: ${recommendation.strategySteps.join(' -> ')}\n- unresolved questions: ${recommendation.openQuestions.join('; ') || '(none)'}\n- hard constraints: ${recommendation.hardConstraints.join('; ')}`;

  return {
    recommendation,
    prompt,
    coordination: coordinator.summarize(fallbackApplied),
  };
}
