import { getAgentSpecialist } from './specialistRegistry';
import type {
  AgentArtifact,
  AgentArtifactKind,
  AgentCoordinationBudget,
  AgentCoordinationStep,
  AgentCoordinationSummary,
  AgentRunContext,
  AgentSpecialistId,
  AgentTaskEnvelope,
} from './types';

export interface AgentSpecialistRunResult<T = unknown> {
  payload: T;
  llmCalls: number;
  toolCalls: number;
  outputChars: number;
  validation?: AgentArtifact<T>['validation'];
}

export interface AgentSpecialistRunInput {
  task: AgentTaskEnvelope;
  context: Readonly<AgentRunContext>;
  inputArtifacts: readonly AgentArtifact[];
}

export type AgentSpecialistRunner<T = unknown> = (
  input: AgentSpecialistRunInput,
) => Promise<AgentSpecialistRunResult<T>> | AgentSpecialistRunResult<T>;

const DEFAULT_BUDGET: AgentCoordinationBudget = {
  maxTasks: 3,
  maxLlmCalls: 2,
  maxToolCalls: 0,
  maxOutputChars: 3200,
};

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function artifactTextLength(payload: unknown): number {
  try { return JSON.stringify(payload).length; } catch { return Number.MAX_SAFE_INTEGER; }
}

export class AgentCoordinator {
  readonly context: AgentRunContext;
  private readonly initialBudget: AgentCoordinationBudget;
  private readonly steps: AgentCoordinationStep[] = [];

  constructor(input: {
    workflowId: AgentRunContext['workflowId'];
    userRequest: string;
    runId?: string;
    budget?: Partial<AgentCoordinationBudget>;
  }) {
    this.initialBudget = { ...DEFAULT_BUDGET, ...input.budget };
    this.context = {
      runId: input.runId || makeId('coord-run'),
      workflowId: input.workflowId,
      userRequest: input.userRequest,
      artifacts: [],
      remainingBudget: { ...this.initialBudget },
    };
  }

  getArtifacts(kind?: AgentArtifactKind): AgentArtifact[] {
    return this.context.artifacts.filter((artifact) => !kind || artifact.kind === kind);
  }

  async runSpecialist<T>(input: {
    specialistId: AgentSpecialistId;
    objective: string;
    inputArtifacts?: readonly AgentArtifact[];
    requestedTools?: readonly string[];
    /** Scene setup must keep typed stage failures instead of replacing them with a guessed workflow. */
    throwOnFailure?: boolean;
    runner: AgentSpecialistRunner<T>;
  }): Promise<AgentArtifact<T> | undefined> {
    const specialist = getAgentSpecialist(input.specialistId);
    const sourceArtifacts = [...(input.inputArtifacts || [])];
    const sourceKinds = new Set(sourceArtifacts.map((item) => item.kind));
    const missingKind = specialist.acceptedArtifacts.find((kind) => !sourceKinds.has(kind));
    if (missingKind) throw new Error(`${specialist.id} requires artifact ${missingKind}`);

    const requestedTools = [...new Set(input.requestedTools || [])];
    const disallowedTool = requestedTools.find((tool) => !specialist.allowedTools.includes(tool));
    if (disallowedTool) throw new Error(`${specialist.id} is not allowed to use tool ${disallowedTool}`);

    if (this.steps.length >= this.initialBudget.maxTasks) {
      this.steps.push({
        taskId: makeId('task-skipped'), specialistId: specialist.id, status: 'skipped',
        llmCalls: 0, toolCalls: 0, outputChars: 0, artifactKinds: [],
        diagnosticCodes: ['coordination-task-budget-exhausted'],
      });
      return undefined;
    }
    if (
      this.context.remainingBudget.maxLlmCalls < specialist.budget.maxLlmCalls
      || this.context.remainingBudget.maxToolCalls < specialist.budget.maxToolCalls
    ) {
      this.steps.push({
        taskId: makeId('task-skipped'), specialistId: specialist.id, status: 'skipped',
        llmCalls: 0, toolCalls: 0, outputChars: 0, artifactKinds: [],
        diagnosticCodes: ['coordination-call-budget-exhausted'],
      });
      return undefined;
    }

    const task: AgentTaskEnvelope = {
      version: 1,
      id: makeId(`task-${specialist.id}`),
      runId: this.context.runId,
      specialistId: specialist.id,
      objective: input.objective.slice(0, 500),
      inputArtifactIds: sourceArtifacts.map((item) => item.id),
      allowedTools: requestedTools,
      budget: { ...specialist.budget },
      createdAt: new Date().toISOString(),
    };

    try {
      const result = await input.runner({ task, context: this.context, inputArtifacts: sourceArtifacts });
      const actualChars = Math.max(result.outputChars, artifactTextLength(result.payload));
      const diagnostics: string[] = [];
      if (result.llmCalls > task.budget.maxLlmCalls) diagnostics.push('specialist-llm-budget-exceeded');
      if (result.toolCalls > task.budget.maxToolCalls) diagnostics.push('specialist-tool-budget-exceeded');
      if (actualChars > task.budget.maxOutputChars) diagnostics.push('specialist-output-budget-exceeded');
      if (result.llmCalls > this.context.remainingBudget.maxLlmCalls) diagnostics.push('coordination-llm-budget-exceeded');
      if (result.toolCalls > this.context.remainingBudget.maxToolCalls) diagnostics.push('coordination-tool-budget-exceeded');
      if (actualChars > this.context.remainingBudget.maxOutputChars) diagnostics.push('coordination-output-budget-exceeded');
      if (diagnostics.length) throw new Error(diagnostics.join(','));

      this.context.remainingBudget.maxTasks -= 1;
      this.context.remainingBudget.maxLlmCalls -= result.llmCalls;
      this.context.remainingBudget.maxToolCalls -= result.toolCalls;
      this.context.remainingBudget.maxOutputChars -= actualChars;
      const artifact: AgentArtifact<T> = {
        version: 1,
        id: makeId(`artifact-${specialist.outputArtifact}`),
        taskId: task.id,
        kind: specialist.outputArtifact,
        producer: specialist.id,
        payload: result.payload,
        provenance: {
          sourceArtifactIds: task.inputArtifactIds,
          generatedAt: new Date().toISOString(),
        },
        validation: result.validation || { status: 'valid', diagnostics: [] },
      };
      this.context.artifacts.push(artifact as AgentArtifact);
      this.steps.push({
        taskId: task.id,
        specialistId: specialist.id,
        status: 'completed',
        llmCalls: result.llmCalls,
        toolCalls: result.toolCalls,
        outputChars: actualChars,
        artifactKinds: [specialist.outputArtifact],
        diagnosticCodes: artifact.validation.diagnostics.slice(0, 12),
      });
      return artifact;
    } catch (error) {
      this.steps.push({
        taskId: task.id,
        specialistId: specialist.id,
        status: 'failed',
        llmCalls: 0,
        toolCalls: 0,
        outputChars: 0,
        artifactKinds: [],
        diagnosticCodes: [error instanceof Error ? error.message.slice(0, 120) : 'specialist-failed'],
      });
      if (input.throwOnFailure) throw error;
      return undefined;
    }
  }

  summarize(fallbackApplied: boolean): AgentCoordinationSummary {
    const failed = this.steps.some((step) => step.status === 'failed');
    const skipped = this.steps.some((step) => step.status === 'skipped');
    return {
      version: 1,
      runId: this.context.runId,
      workflowId: this.context.workflowId,
      status: failed || skipped || fallbackApplied ? 'degraded' : 'completed',
      steps: this.steps.map((step) => ({ ...step, artifactKinds: [...step.artifactKinds], diagnosticCodes: [...step.diagnosticCodes] })),
      totals: {
        llmCalls: this.steps.reduce((sum, step) => sum + step.llmCalls, 0),
        toolCalls: this.steps.reduce((sum, step) => sum + step.toolCalls, 0),
        outputChars: this.steps.reduce((sum, step) => sum + step.outputChars, 0),
      },
      fallbackApplied,
    };
  }
}
