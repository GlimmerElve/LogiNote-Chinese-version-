import {
  clearAgentAudit,
  loadAgentAudit,
  summarizeAgentHandoffAudit,
  type AgentAuditRun,
  type AgentHandoffAuditEvent,
  type AgentHandoffAuditSummary,
} from './auditStore';
import {
  clearSceneInteractionAudit,
  loadSceneInteractionAudit,
  summarizeSceneInteractionAudit,
  type SceneInteractionAuditEvent,
  type SceneInteractionAuditSummary,
} from '../scene/sceneInteractionAudit';
import {
  clearSceneAssemblyAudit,
  loadSceneAssemblyAudit,
  summarizeSceneAssemblyAudit,
  type SceneAssemblyAuditEvent,
  type SceneAssemblyAuditSummary,
} from '../scene/sceneAssemblyAudit';
import { buildAgentAcceptanceSnapshot, type AgentAcceptanceSnapshot } from './acceptance';

export interface AuditCountItem {
  key: string;
  count: number;
}

export interface AgentAuditDashboardSnapshot {
  generatedAt: string;
  acceptance: AgentAcceptanceSnapshot;
  agent: {
    total: number;
    completed: number;
    failed: number;
    truncated: number;
    pendingApproval: number;
    running: number;
    completionRate: number;
    toolCalls: number;
    toolFailures: number;
    approvals: number;
    approvalsApproved: number;
    approvalsRejected: number;
    coordinationRuns: number;
    coordinationDegraded: number;
    llmCalls: number;
    promptTokens: number;
    completionTokens: number;
    skills: Array<{ id: string; name: string; runs: number; completed: number; issues: number }>;
    toolFailureNames: AuditCountItem[];
    recentRuns: Array<{
      id: string;
      skillName: string;
      status: AgentAuditRun['status'];
      toolCalls: number;
      toolFailures: number;
      approvalStatus?: string;
      updatedAt: string;
    }>;
  };
  handoff: AgentHandoffAuditSummary & {
    recent: Array<Pick<AgentHandoffAuditEvent, 'id' | 'status' | 'sourceStage' | 'expectedTargetSkillId' | 'actualTargetSkillId' | 'createdAt'>>;
  };
  interaction: SceneInteractionAuditSummary & {
    topReasons: AuditCountItem[];
    recent: Array<Pick<SceneInteractionAuditEvent, 'id' | 'outcome' | 'reason' | 'requestedType' | 'resolvedType' | 'createdAt'>>;
  };
  assembly: SceneAssemblyAuditSummary & {
    topDiagnostics: AuditCountItem[];
    recent: Array<Pick<SceneAssemblyAuditEvent, 'id' | 'sceneSkill' | 'surface' | 'recipeId' | 'outcome' | 'diagnosticCodes' | 'createdAt'>>;
  };
}

function rate(numerator: number, denominator: number): number {
  return denominator ? Math.round((numerator / denominator) * 1000) / 10 : 0;
}

function sortedCounts(counts: Record<string, number | undefined>, limit = 6): AuditCountItem[] {
  return Object.entries(counts)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number' && entry[1] > 0)
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, limit);
}

export function buildAgentAuditDashboard(input: {
  runs: AgentAuditRun[];
  handoffs: AgentHandoffAuditEvent[];
  interactions: SceneInteractionAuditEvent[];
  assemblies: SceneAssemblyAuditEvent[];
  generatedAt?: string;
}): AgentAuditDashboardSnapshot {
  const statusCount = (status: AgentAuditRun['status']) => input.runs.filter((run) => run.status === status).length;
  const completed = statusCount('completed');
  const failed = statusCount('failed');
  const truncated = statusCount('truncated');
  const toolCalls = input.runs.reduce((sum, run) => sum + run.steps.length, 0);
  const toolFailures = input.runs.reduce((sum, run) => sum + run.steps.filter((step) => !step.ok).length, 0);
  const toolFailureMap: Record<string, number> = {};
  const skillMap = new Map<string, AgentAuditDashboardSnapshot['agent']['skills'][number]>();
  const coordinations = input.runs.flatMap((run) => run.coordinations || (run.coordination ? [run.coordination] : []));
  const llmCalls = input.runs.reduce((sum, run) => sum + (run.runtime?.llmCalls || 0), 0);
  const promptTokens = input.runs.reduce((sum, run) => sum + (run.runtime?.promptTokens || 0), 0);
  const completionTokens = input.runs.reduce((sum, run) => sum + (run.runtime?.completionTokens || 0), 0);
  for (const run of input.runs) {
    const skillId = run.skillId || 'general';
    const skill = skillMap.get(skillId) || {
      id: skillId,
      name: run.skillName || (skillId === 'general' ? '通用助手' : skillId),
      runs: 0,
      completed: 0,
      issues: 0,
    };
    skill.runs += 1;
    if (run.status === 'completed') skill.completed += 1;
    if (run.status === 'failed' || run.status === 'truncated') skill.issues += 1;
    skillMap.set(skillId, skill);
    for (const step of run.steps) {
      if (!step.ok) toolFailureMap[step.name] = (toolFailureMap[step.name] || 0) + 1;
    }
  }
  const approvals = input.runs.flatMap((run) => run.approvals);
  const handoffSummary = summarizeAgentHandoffAudit(input.handoffs);
  const interactionSummary = summarizeSceneInteractionAudit(input.interactions);
  const assemblySummary = summarizeSceneAssemblyAudit(input.assemblies);

  return {
    generatedAt: input.generatedAt || new Date().toISOString(),
    acceptance: buildAgentAcceptanceSnapshot({ runs: input.runs, handoffs: input.handoffs }),
    agent: {
      total: input.runs.length,
      completed,
      failed,
      truncated,
      pendingApproval: statusCount('pending-approval'),
      running: statusCount('running'),
      completionRate: rate(completed, completed + failed + truncated),
      toolCalls,
      toolFailures,
      approvals: approvals.length,
      approvalsApproved: approvals.filter((item) => item.status === 'approved').length,
      approvalsRejected: approvals.filter((item) => item.status === 'rejected').length,
      coordinationRuns: coordinations.length,
      coordinationDegraded: coordinations.filter((item) => item.status !== 'completed' || item.fallbackApplied).length,
      llmCalls,
      promptTokens,
      completionTokens,
      skills: [...skillMap.values()].sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name)),
      toolFailureNames: sortedCounts(toolFailureMap),
      recentRuns: input.runs.slice(0, 12).map((run) => ({
        id: run.id,
        skillName: run.skillName || '通用助手',
        status: run.status,
        toolCalls: run.steps.length,
        toolFailures: run.steps.filter((step) => !step.ok).length,
        approvalStatus: run.approvals.at(-1)?.status,
        updatedAt: run.updatedAt,
      })),
    },
    handoff: {
      ...handoffSummary,
      recent: input.handoffs.slice(0, 12).map((event) => ({
        id: event.id,
        status: event.status,
        sourceStage: event.sourceStage,
        expectedTargetSkillId: event.expectedTargetSkillId,
        actualTargetSkillId: event.actualTargetSkillId,
        createdAt: event.createdAt,
      })),
    },
    interaction: {
      ...interactionSummary,
      topReasons: sortedCounts(interactionSummary.reasons),
      recent: input.interactions.slice(0, 12).map((event) => ({
        id: event.id,
        outcome: event.outcome,
        reason: event.reason,
        requestedType: event.requestedType,
        resolvedType: event.resolvedType,
        createdAt: event.createdAt,
      })),
    },
    assembly: {
      ...assemblySummary,
      topDiagnostics: sortedCounts(assemblySummary.diagnostics),
      recent: input.assemblies.slice(0, 12).map((event) => ({
        id: event.id,
        sceneSkill: event.sceneSkill,
        surface: event.surface,
        recipeId: event.recipeId,
        outcome: event.outcome,
        diagnosticCodes: event.diagnosticCodes,
        createdAt: event.createdAt,
      })),
    },
  };
}

export async function loadAgentAuditDashboard(): Promise<AgentAuditDashboardSnapshot> {
  const [agent, interaction, assembly] = await Promise.all([
    loadAgentAudit(true),
    loadSceneInteractionAudit(true),
    loadSceneAssemblyAudit(true),
  ]);
  return buildAgentAuditDashboard({ runs: agent.runs, handoffs: agent.handoffs, interactions: interaction.events, assemblies: assembly.events });
}

export async function clearAgentAuditDashboard(): Promise<void> {
  // Wait for every store, including after one rejects; this is not an atomic transaction.
  const results = await Promise.allSettled([
    clearAgentAudit(),
    clearSceneInteractionAudit(),
    clearSceneAssemblyAudit(),
  ]);
  if (results.some(result => result.status === 'rejected')) throw new Error('审计记录未全部清除');
}
