import type { MemoryContextTrace } from '../memory/memoryContextBuilder';
import { getTool } from './toolRegistry';
import { readFreshAuditFile, auditRecord, assertAudit } from './auditRead';
import type {
  AgentCoordinationSummary,
  AgentPendingApproval,
  AgentToolStep,
  AgentTurnResult,
  AgentWorkflowAction,
  AgentWorkflowHandoff,
  AgentWorkflowStage,
  AgentRuntimeMetrics,
} from './types';

export type AgentAuditStatus = 'running' | 'completed' | 'pending-approval' | 'failed' | 'truncated';
export type AgentAuditApprovalStatus = 'pending' | 'approved' | 'rejected' | 'failed';

export interface AgentAuditToolStep {
  callId: string;
  name: string;
  permission: 'readonly' | 'navigation' | 'write' | 'unknown';
  argumentsSummary: string;
  ok: boolean;
  sourceIds?: string[];
  error?: string;
}

export interface AgentAuditApproval {
  id: string;
  status: AgentAuditApprovalStatus;
  requestedAt: string;
  decidedAt?: string;
  items: Array<{ tool: string; title: string; description: string; impacts: string[] }>;
}

export interface AgentAuditRun {
  id: string;
  roleId: string;
  userRequest: string;
  skillId?: string;
  skillName?: string;
  status: AgentAuditStatus;
  createdAt: string;
  updatedAt: string;
  dataVersionBefore?: number;
  dataVersionAfter?: number;
  memory?: {
    workflow: string;
    maxChars: number;
    usedChars: number;
    budgetTrimmed: boolean;
    sections: Array<{ kind: string; chars: number; sourceIds: string[] }>;
  };
  steps: AgentAuditToolStep[];
  approvals: AgentAuditApproval[];
  /** Payload-free specialist execution metadata. */
  coordination?: AgentCoordinationSummary;
  coordinations?: AgentCoordinationSummary[];
  runtime?: AgentRuntimeMetrics;
  error?: string;
}

export interface AgentAuditFile {
  version: 2;
  runs: AgentAuditRun[];
  handoffs: AgentHandoffAuditEvent[];
}

export type AgentHandoffAuditStatus = 'created' | 'accepted' | 'dismissed' | 'superseded' | 'arrived' | 'route-mismatch' | 'failed';

/** 不保存动作 prompt、结果摘要、对话或笔记正文，只保留流程分析所需引用。 */
export interface AgentHandoffAuditEvent {
  id: string;
  handoffId: string;
  status: AgentHandoffAuditStatus;
  sourceStage: AgentWorkflowStage;
  sourceSkillId?: string;
  sourceArtifactId?: string;
  scopeProjectId?: string;
  scopeProjectTitle?: string;
  knowledgePointTitles: string[];
  candidateTargetSkillIds?: string[];
  actionId?: string;
  expectedTargetSkillId?: string;
  actualTargetSkillId?: string;
  agentRunId?: string;
  error?: string;
  createdAt: string;
}

export interface AgentHandoffAuditSummary {
  totalCreated: number;
  totalAccepted: number;
  totalDismissed: number;
  totalSuperseded: number;
  totalArrived: number;
  totalRouteMismatch: number;
  totalFailed: number;
  acceptanceRate: number;
  arrivalRate: number;
  routes: Array<{
    sourceStage: AgentWorkflowStage;
    targetSkillId: string;
    accepted: number;
    arrived: number;
  }>;
}

const STORAGE_KEY = 'loginote_agent_audit_v1';
const MAX_RUNS = 100;
const MAX_HANDOFF_EVENTS = 500;
const RETENTION_MS = 180 * 24 * 60 * 60 * 1000;

function compact(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function summarizeAuditArguments(value: unknown, max = 1200): string {
  const seen = new WeakSet<object>();
  try {
    const text = JSON.stringify(value ?? {}, (key, item) => {
      if (/api.?key|token|password|secret|authorization/i.test(key)) return '[REDACTED]';
      if (item && typeof item === 'object') {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    });
    return compact(text, max);
  } catch {
    return '[无法序列化参数]';
  }
}

export function extractAuditSourceIds(value: unknown): string[] | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const sourceIds = (value as { sourceIds?: unknown }).sourceIds;
  if (!Array.isArray(sourceIds)) return undefined;
  const normalized = [...new Set(sourceIds
    .filter((item): item is string => typeof item === 'string')
    .map((item) => compact(item, 180))
    .filter(Boolean))]
    .slice(0, 20);
  return normalized.length ? normalized : undefined;
}

export function normalizeAgentAuditFile(value: unknown, now = Date.now()): AgentAuditFile {
  const raw = value && typeof value === 'object' ? value as Partial<AgentAuditFile> : {};
  const rawRuns = Array.isArray(raw.runs)
    ? raw.runs
    : [];
  const cutoff = now - RETENTION_MS;
  const runs = rawRuns
    .filter((run) => run && typeof run === 'object' && typeof run.id === 'string' && Date.parse(run.updatedAt) >= cutoff)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_RUNS);
  const statuses = new Set<AgentHandoffAuditStatus>(['created', 'accepted', 'dismissed', 'superseded', 'arrived', 'route-mismatch', 'failed']);
  const stages = new Set<AgentWorkflowStage>(['plan', 'scene', 'review']);
  const handoffs = (Array.isArray(raw.handoffs) ? raw.handoffs : [])
    .filter((event): event is AgentHandoffAuditEvent => Boolean(
      event && typeof event === 'object'
      && typeof event.id === 'string'
      && typeof event.handoffId === 'string'
      && statuses.has(event.status)
      && stages.has(event.sourceStage)
      && Date.parse(event.createdAt) >= cutoff,
    ))
    .map((event) => ({
      id: compact(event.id, 240),
      handoffId: compact(event.handoffId, 120),
      status: event.status,
      sourceStage: event.sourceStage,
      sourceSkillId: event.sourceSkillId ? compact(event.sourceSkillId, 80) : undefined,
      sourceArtifactId: event.sourceArtifactId ? compact(event.sourceArtifactId, 120) : undefined,
      scopeProjectId: event.scopeProjectId ? compact(event.scopeProjectId, 120) : undefined,
      scopeProjectTitle: event.scopeProjectTitle ? compact(event.scopeProjectTitle, 100) : undefined,
      knowledgePointTitles: Array.isArray(event.knowledgePointTitles)
        ? [...new Set(event.knowledgePointTitles.filter((item): item is string => typeof item === 'string').map((item) => compact(item, 80)).filter(Boolean))].slice(0, 12)
        : [],
      candidateTargetSkillIds: Array.isArray(event.candidateTargetSkillIds)
        ? [...new Set(event.candidateTargetSkillIds.filter((item): item is string => typeof item === 'string').map((item) => compact(item, 80)).filter(Boolean))].slice(0, 5)
        : undefined,
      actionId: event.actionId ? compact(event.actionId, 80) : undefined,
      expectedTargetSkillId: event.expectedTargetSkillId ? compact(event.expectedTargetSkillId, 80) : undefined,
      actualTargetSkillId: event.actualTargetSkillId ? compact(event.actualTargetSkillId, 80) : undefined,
      agentRunId: event.agentRunId ? compact(event.agentRunId, 120) : undefined,
      error: event.error ? compact(event.error, 300) : undefined,
      createdAt: event.createdAt,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, MAX_HANDOFF_EVENTS);
  return { version: 2, runs, handoffs };
}

function api() {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as {
    electronAPI?: {
      userState?: {
        loadAgentAudit?: (strict?: boolean) => Promise<unknown>;
        saveAgentAudit?: (file: unknown) => Promise<void>;
      };
      agent?: { dataVersion?: () => Promise<number> };
    };
  }).electronAPI;
}

let cache: AgentAuditFile | null = null;
let loadPromise: Promise<AgentAuditFile> | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let mutationQueue: Promise<void> = Promise.resolve();

function readLocal(): AgentAuditFile {
  if (typeof localStorage === 'undefined') return { version: 2, runs: [], handoffs: [] };
  try { return normalizeAgentAuditFile(JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null')); }
  catch { return { version: 2, runs: [], handoffs: [] }; }
}

export async function loadAgentAudit(strict = false): Promise<AgentAuditFile> {
  if (strict) {
    await flushAgentAuditWrites();
    const native = api()?.userState;
    return readFreshAuditFile(STORAGE_KEY, native?.loadAgentAudit ? () => native.loadAgentAudit!(true) : undefined,
      validateAgentAuditFile, normalizeAgentAuditFile);
  }
  if (cache) return cache;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    const electron = api()?.userState;
    if (electron?.loadAgentAudit) {
      try {
        const remote = await electron.loadAgentAudit();
        if (remote) {
          cache = normalizeAgentAuditFile(remote);
          if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
          return cache;
        }
      } catch (error) {
        console.warn('[agent-audit] load failed:', error);
      }
    }
    cache = readLocal();
    return cache;
  })();
  return loadPromise.finally(() => { loadPromise = null; });
}

function validateAgentAuditFile(value: unknown): void {
  const file = auditRecord(value);
  assertAudit(Array.isArray(file.runs) && (file.handoffs === undefined || Array.isArray(file.handoffs)));
  for (const value of file.runs) {
    const run = auditRecord(value);
    assertAudit(typeof run.id === 'string' && run.id.trim() && typeof run.updatedAt === 'string'
      && Number.isFinite(Date.parse(run.updatedAt))
      && ['running', 'completed', 'pending-approval', 'failed', 'truncated'].includes(String(run.status))
      && Array.isArray(run.steps) && Array.isArray(run.approvals));
    for (const value of run.steps) {
      const step = auditRecord(value);
      assertAudit(typeof step.name === 'string' && typeof step.ok === 'boolean');
    }
    for (const value of run.approvals) {
      const approval = auditRecord(value);
      assertAudit(['pending', 'approved', 'rejected', 'failed'].includes(String(approval.status)));
    }
    for (const field of ['skillId', 'skillName']) assertAudit(run[field] === undefined || typeof run[field] === 'string');
    if (run.runtime !== undefined) {
      const runtime = auditRecord(run.runtime);
      for (const field of ['llmCalls', 'promptTokens', 'completionTokens']) {
        assertAudit(runtime[field] === undefined || (typeof runtime[field] === 'number' && Number.isFinite(runtime[field]) && runtime[field] >= 0));
      }
    }
    if (run.coordinations !== undefined) assertAudit(Array.isArray(run.coordinations));
    for (const item of (run.coordinations as unknown[] | undefined) || (run.coordination !== undefined ? [run.coordination] : [])) auditRecord(item);
  }
  for (const value of (file.handoffs as unknown[] | undefined) || []) {
    const event = auditRecord(value);
    assertAudit(typeof event.id === 'string' && typeof event.handoffId === 'string'
      && typeof event.createdAt === 'string' && Number.isFinite(Date.parse(event.createdAt))
      && ['created', 'accepted', 'dismissed', 'superseded', 'arrived', 'route-mismatch', 'failed'].includes(String(event.status))
      && ['plan', 'scene', 'review'].includes(String(event.sourceStage)));
    for (const field of ['sourceSkillId', 'sourceArtifactId', 'scopeProjectId', 'scopeProjectTitle', 'actionId', 'expectedTargetSkillId', 'actualTargetSkillId', 'agentRunId', 'error']) {
      assertAudit(event[field] === undefined || typeof event[field] === 'string');
    }
  }
}

async function save(file: AgentAuditFile): Promise<void> {
  cache = normalizeAgentAuditFile(file);
  if (typeof localStorage !== 'undefined') {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(cache)); }
    catch (error) { console.warn('[agent-audit] local cache failed:', error); }
  }
  const electron = api()?.userState;
  if (!electron?.saveAgentAudit) return;
  const next = cache;
  const write = writeQueue.then(() => electron.saveAgentAudit!(next));
  writeQueue = write.catch((error) => console.warn('[agent-audit] save failed:', error));
  await write;
}

function mutate(mutator: (file: AgentAuditFile) => AgentAuditFile): Promise<void> {
  const task = mutationQueue.then(async () => save(mutator(await loadAgentAudit())));
  mutationQueue = task.catch((error) => console.warn('[agent-audit] mutation failed:', error));
  return task;
}

async function upsert(run: AgentAuditRun): Promise<void> {
  await mutate((file) => ({
    version: 2,
    runs: [run, ...file.runs.filter((item) => item.id !== run.id)],
    handoffs: file.handoffs,
  }));
}

function handoffEventId(handoffId: string, status: AgentHandoffAuditStatus, actionId?: string): string {
  return `${handoffId}:${status}${actionId ? `:${actionId}` : ''}`;
}

export async function recordAgentHandoffAudit(input: {
  handoff: AgentWorkflowHandoff;
  status: AgentHandoffAuditStatus;
  action?: AgentWorkflowAction;
  actualTargetSkillId?: string;
  agentRunId?: string;
  error?: unknown;
}): Promise<void> {
  const { handoff, action } = input;
  const event: AgentHandoffAuditEvent = {
    id: handoffEventId(handoff.id, input.status, action?.id),
    handoffId: handoff.id,
    status: input.status,
    sourceStage: handoff.sourceStage,
    sourceSkillId: handoff.sourceSkillId,
    sourceArtifactId: handoff.sourceArtifactId,
    scopeProjectId: handoff.scopeProjectId,
    scopeProjectTitle: handoff.scopeProjectTitle,
    knowledgePointTitles: handoff.knowledgePointTitles,
    candidateTargetSkillIds: input.status === 'created'
      ? [...new Set(handoff.actions.map((item) => item.targetSkillId))]
      : undefined,
    actionId: action?.id,
    expectedTargetSkillId: action?.targetSkillId,
    actualTargetSkillId: input.actualTargetSkillId,
    agentRunId: input.agentRunId,
    error: input.error ? compact(input.error instanceof Error ? input.error.message : String(input.error), 300) : undefined,
    createdAt: new Date().toISOString(),
  };
  await mutate((file) => ({
    version: 2,
    runs: file.runs,
    handoffs: [event, ...file.handoffs.filter((item) => item.id !== event.id)],
  }));
}

export async function readAgentDataVersion(): Promise<number | undefined> {
  try { return await api()?.agent?.dataVersion?.(); } catch { return undefined; }
}

function auditSteps(steps: AgentToolStep[]): AgentAuditToolStep[] {
  return steps.map((step) => ({
    callId: step.call.id,
    name: step.call.name,
    permission: getTool(step.call.name)?.permission || (step.call.name === 'request_more_qa_evidence' ? 'readonly' : 'unknown'),
    argumentsSummary: summarizeAuditArguments(step.call.arguments),
    ok: step.ok,
    sourceIds: extractAuditSourceIds(step.result),
    error: step.error ? compact(step.error, 500) : undefined,
  }));
}

function auditMemory(trace?: MemoryContextTrace): AgentAuditRun['memory'] {
  if (!trace) return undefined;
  return {
    workflow: trace.workflow,
    maxChars: trace.maxChars,
    usedChars: trace.usedChars,
    budgetTrimmed: trace.budgetTrimmed,
    sections: trace.sections.map((section) => ({
      kind: section.kind,
      chars: section.chars,
      sourceIds: section.sourceIds.slice(0, 20),
    })),
  };
}

function pendingApproval(approval: AgentPendingApproval | undefined, requestedAt: string): AgentAuditApproval[] {
  if (!approval) return [];
  return [{
    id: approval.id,
    status: 'pending',
    requestedAt,
    items: approval.items.map((item) => ({
      tool: item.call.name,
      title: compact(item.title, 200),
      description: compact(item.description, 500),
      impacts: (item.impacts || []).map((impact) => compact(impact, 300)).slice(0, 20),
    })),
  }];
}

function auditCoordination(summary?: AgentCoordinationSummary): AgentCoordinationSummary | undefined {
  if (!summary) return undefined;
  return {
    version: 1,
    runId: compact(summary.runId, 160),
    workflowId: summary.workflowId,
    status: summary.status,
    steps: summary.steps.slice(0, 8).map((step) => ({
      taskId: compact(step.taskId, 160),
      specialistId: step.specialistId,
      status: step.status,
      llmCalls: Math.max(0, Math.min(20, step.llmCalls)),
      toolCalls: Math.max(0, Math.min(50, step.toolCalls)),
      outputChars: Math.max(0, Math.min(20000, step.outputChars)),
      artifactKinds: step.artifactKinds.slice(0, 8),
      diagnosticCodes: step.diagnosticCodes.map((item) => compact(item, 120)).slice(0, 12),
    })),
    totals: {
      llmCalls: Math.max(0, Math.min(20, summary.totals.llmCalls)),
      toolCalls: Math.max(0, Math.min(50, summary.totals.toolCalls)),
      outputChars: Math.max(0, Math.min(40000, summary.totals.outputChars)),
    },
    fallbackApplied: Boolean(summary.fallbackApplied),
  };
}

function auditCoordinations(result?: AgentTurnResult): AgentCoordinationSummary[] | undefined {
  if (!result) return undefined;
  const runs = result.coordinationRuns?.length
    ? result.coordinationRuns
    : result.coordination
      ? [result.coordination]
      : [];
  const normalized = runs.map(auditCoordination).filter((item): item is AgentCoordinationSummary => Boolean(item));
  return normalized.length
    ? [...new Map(normalized.map((item) => [item.runId, item])).values()].slice(0, 12)
    : undefined;
}

export async function recordAgentTurnAudit(input: {
  id: string;
  roleId: string;
  userRequest: string;
  createdAt: string;
  dataVersionBefore?: number;
  memoryTrace?: MemoryContextTrace;
  result?: AgentTurnResult;
  error?: unknown;
}): Promise<void> {
  const now = new Date().toISOString();
  const result = input.result;
  const status: AgentAuditStatus = input.error
    ? 'failed'
    : !result
      ? 'running'
    : result?.pendingApproval
      ? 'pending-approval'
      : result?.truncated
        ? 'truncated'
        : 'completed';
  await upsert({
    id: input.id,
    roleId: input.roleId,
    userRequest: compact(input.userRequest, 500),
    skillId: result?.activeSkill?.id,
    skillName: result?.activeSkill?.name,
    status,
    createdAt: input.createdAt,
    updatedAt: now,
    dataVersionBefore: input.dataVersionBefore,
    dataVersionAfter: await readAgentDataVersion(),
    memory: auditMemory(input.memoryTrace),
    steps: auditSteps(result?.toolTrace || []),
    approvals: pendingApproval(result?.pendingApproval, now),
    coordination: auditCoordination(result?.coordination),
    coordinations: auditCoordinations(result),
    runtime: result?.runtimeMetrics,
    error: input.error ? compact(input.error instanceof Error ? input.error.message : String(input.error), 500) : undefined,
  });
}

export async function recordAgentApprovalAudit(input: {
  runId: string;
  approval: AgentPendingApproval;
  approved: boolean;
  result?: AgentTurnResult;
  error?: unknown;
}): Promise<void> {
  const file = await loadAgentAudit();
  const current = file.runs.find((run) => run.id === input.runId);
  if (!current) return;
  const now = new Date().toISOString();
  const decision: AgentAuditApprovalStatus = !input.approved ? 'rejected' : input.error ? 'failed' : 'approved';
  const approvals = current.approvals.map((approval) => approval.id === input.approval.id
    ? { ...approval, status: decision, decidedAt: now }
    : approval);
  const nextPending = pendingApproval(input.result?.pendingApproval, now);
  const combinedSteps = [...current.steps, ...auditSteps(input.result?.toolTrace || [])];
  const uniqueSteps = [...new Map(combinedSteps.map((step) => [`${step.callId}:${step.name}`, step])).values()];
  const nextCoordinations = auditCoordinations(input.result) || [];
  const combinedCoordinations = [...(current.coordinations || (current.coordination ? [current.coordination] : [])), ...nextCoordinations];
  await upsert({
    ...current,
    skillId: input.result?.activeSkill?.id || current.skillId,
    skillName: input.result?.activeSkill?.name || current.skillName,
    status: input.error
      ? 'failed'
      : input.result?.pendingApproval
        ? 'pending-approval'
        : input.result?.truncated
          ? 'truncated'
          : 'completed',
    updatedAt: now,
    dataVersionAfter: await readAgentDataVersion(),
    steps: uniqueSteps,
    approvals: [...approvals, ...nextPending.filter((item) => !approvals.some((approval) => approval.id === item.id))],
    coordinations: combinedCoordinations.length
      ? [...new Map(combinedCoordinations.map((item) => [item.runId, item])).values()].slice(0, 12)
      : undefined,
    runtime: input.result?.runtimeMetrics || current.runtime,
    error: input.error ? compact(input.error instanceof Error ? input.error.message : String(input.error), 500) : undefined,
  });
}

export async function listAgentAuditRuns(limit = 50): Promise<AgentAuditRun[]> {
  const file = await loadAgentAudit();
  return file.runs.slice(0, Math.max(0, Math.min(limit, MAX_RUNS)));
}

export async function listAgentHandoffAuditEvents(limit = 200): Promise<AgentHandoffAuditEvent[]> {
  const file = await loadAgentAudit();
  return file.handoffs.slice(0, Math.max(0, Math.min(limit, MAX_HANDOFF_EVENTS)));
}

export function summarizeAgentHandoffAudit(events: AgentHandoffAuditEvent[]): AgentHandoffAuditSummary {
  const count = (status: AgentHandoffAuditStatus) => events.filter((event) => event.status === status).length;
  const totalCreated = count('created');
  const totalAccepted = count('accepted');
  const totalArrived = count('arrived');
  const routeMap = new Map<string, AgentHandoffAuditSummary['routes'][number]>();
  events.forEach((event) => {
    if (!event.expectedTargetSkillId || (event.status !== 'accepted' && event.status !== 'arrived')) return;
    const key = `${event.sourceStage}:${event.expectedTargetSkillId}`;
    const current = routeMap.get(key) || {
      sourceStage: event.sourceStage,
      targetSkillId: event.expectedTargetSkillId,
      accepted: 0,
      arrived: 0,
    };
    if (event.status === 'accepted') current.accepted += 1;
    if (event.status === 'arrived') current.arrived += 1;
    routeMap.set(key, current);
  });
  return {
    totalCreated,
    totalAccepted,
    totalDismissed: count('dismissed'),
    totalSuperseded: count('superseded'),
    totalArrived,
    totalRouteMismatch: count('route-mismatch'),
    totalFailed: count('failed'),
    acceptanceRate: totalCreated ? Math.round((totalAccepted / totalCreated) * 1000) / 10 : 0,
    arrivalRate: totalAccepted ? Math.round((totalArrived / totalAccepted) * 1000) / 10 : 0,
    routes: [...routeMap.values()].sort((a, b) => b.accepted - a.accepted || b.arrived - a.arrived),
  };
}

export async function getAgentHandoffAuditSummary(): Promise<AgentHandoffAuditSummary> {
  return summarizeAgentHandoffAudit(await listAgentHandoffAuditEvents(MAX_HANDOFF_EVENTS));
}

export async function clearAgentAudit(): Promise<void> {
  await mutate(() => ({ version: 2, runs: [], handoffs: [] }));
}

export async function flushAgentAuditWrites(): Promise<void> {
  await mutationQueue;
  await writeQueue;
}
