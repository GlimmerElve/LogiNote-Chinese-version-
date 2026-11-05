import type {
  AgentArtifactKind,
  AgentSpecialistId,
  AgentTaskBudget,
} from './types';

export interface AgentSpecialistDefinition {
  id: AgentSpecialistId;
  name: string;
  purpose: string;
  execution: 'llm' | 'deterministic';
  allowedTools: readonly string[];
  acceptedArtifacts: readonly AgentArtifactKind[];
  outputArtifact: AgentArtifactKind;
  budget: AgentTaskBudget;
}

const SPECIALISTS: readonly AgentSpecialistDefinition[] = [
  {
    id: 'scene-architect',
    name: 'Scene Architect',
    purpose: 'Understand the actual desired experience and exclusions before seeing a recipe or tool catalogue.',
    execution: 'llm',
    allowedTools: [],
    acceptedArtifacts: [],
    outputArtifact: 'scene-architecture',
    budget: { maxLlmCalls: 2, maxToolCalls: 0, maxOutputChars: 8000 },
  },
  {
    id: 'scene-interaction-planner',
    name: 'Interaction Planner',
    purpose: 'Select only registered interaction capabilities that support the architecture.',
    execution: 'llm',
    allowedTools: [],
    acceptedArtifacts: ['scene-architecture'],
    outputArtifact: 'scene-interaction-plan',
    budget: { maxLlmCalls: 2, maxToolCalls: 0, maxOutputChars: 8000 },
  },
  {
    id: 'scene-reviewer',
    name: 'Scene Protocol Reviewer',
    purpose: 'Run deterministic compatibility checks and produce an executable recommendation.',
    execution: 'deterministic',
    allowedTools: [],
    acceptedArtifacts: ['scene-architecture', 'scene-interaction-plan'],
    outputArtifact: 'scene-review',
    budget: { maxLlmCalls: 0, maxToolCalls: 0, maxOutputChars: 800 },
  },
  {
    id: 'plan-architect',
    name: 'Learning Plan Architect',
    purpose: 'Produce a compact planning strategy without mutating project data.',
    execution: 'llm',
    allowedTools: [],
    acceptedArtifacts: [],
    outputArtifact: 'plan-strategy',
    budget: { maxLlmCalls: 1, maxToolCalls: 0, maxOutputChars: 1200 },
  },
  {
    id: 'plan-policy-reviewer',
    name: 'Plan Policy Reviewer',
    purpose: 'Apply project depth, node count, scope lock and approval boundaries.',
    execution: 'deterministic',
    allowedTools: [],
    acceptedArtifacts: ['plan-strategy'],
    outputArtifact: 'plan-policy-review',
    budget: { maxLlmCalls: 0, maxToolCalls: 0, maxOutputChars: 1000 },
  },
  {
    id: 'task-designer',
    name: 'Study Task Designer',
    purpose: 'Define task sequencing and evidence criteria for leaf projects.',
    execution: 'llm',
    allowedTools: [],
    acceptedArtifacts: [],
    outputArtifact: 'task-strategy',
    budget: { maxLlmCalls: 1, maxToolCalls: 0, maxOutputChars: 1200 },
  },
  {
    id: 'task-policy-reviewer',
    name: 'Task Policy Reviewer',
    purpose: 'Enforce leaf-only tasks, wiki links, batch bounds and draft locking.',
    execution: 'deterministic',
    allowedTools: [],
    acceptedArtifacts: ['task-strategy'],
    outputArtifact: 'task-policy-review',
    budget: { maxLlmCalls: 0, maxToolCalls: 0, maxOutputChars: 1000 },
  },
  {
    id: 'resource-strategist',
    name: 'Learning Resource Strategist',
    purpose: 'Define resource selection criteria without inventing URLs or sources.',
    execution: 'llm',
    allowedTools: [],
    acceptedArtifacts: [],
    outputArtifact: 'resource-strategy',
    budget: { maxLlmCalls: 1, maxToolCalls: 0, maxOutputChars: 1200 },
  },
  {
    id: 'resource-policy-reviewer',
    name: 'Resource Policy Reviewer',
    purpose: 'Enforce task binding, source provenance, free access and draft limits.',
    execution: 'deterministic',
    allowedTools: [],
    acceptedArtifacts: ['resource-strategy'],
    outputArtifact: 'resource-policy-review',
    budget: { maxLlmCalls: 0, maxToolCalls: 0, maxOutputChars: 1000 },
  },
  {
    id: 'qa-evidence-reviewer',
    name: 'QA Evidence Reviewer',
    purpose: 'Check retrieved snippets for question coverage and citation support.',
    execution: 'llm',
    allowedTools: [],
    acceptedArtifacts: [],
    outputArtifact: 'qa-evidence-review',
    budget: { maxLlmCalls: 1, maxToolCalls: 0, maxOutputChars: 1800 },
  },
  {
    id: 'resource-evidence-reviewer',
    name: 'Resource Evidence Reviewer',
    purpose: 'Check searched resources for provenance, task relevance and unresolved access risks.',
    execution: 'llm',
    allowedTools: [],
    acceptedArtifacts: [],
    outputArtifact: 'resource-evidence-review',
    budget: { maxLlmCalls: 1, maxToolCalls: 0, maxOutputChars: 4000 },
  },
  {
    id: 'project-scope-reviewer',
    name: 'Project Scope Reviewer',
    purpose: 'Convert project query results into deterministic scope boundaries for the next tool round.',
    execution: 'deterministic',
    allowedTools: [],
    acceptedArtifacts: [],
    outputArtifact: 'project-scope-review',
    budget: { maxLlmCalls: 0, maxToolCalls: 0, maxOutputChars: 1200 },
  },
  {
    id: 'qa-answer-reviewer',
    name: 'QA Final Answer Reviewer',
    purpose: 'Check the drafted answer against reviewed local evidence and actual citation IDs.',
    execution: 'llm',
    allowedTools: [],
    acceptedArtifacts: [],
    outputArtifact: 'qa-answer-review',
    budget: { maxLlmCalls: 1, maxToolCalls: 0, maxOutputChars: 1800 },
  },
  {
    id: 'qa-answer-repairer',
    name: 'QA Answer Repairer',
    purpose: 'Perform one bounded revision that removes unsupported citations and labels general explanations.',
    execution: 'llm',
    allowedTools: [],
    acceptedArtifacts: ['qa-answer-review'],
    outputArtifact: 'qa-answer-repair',
    budget: { maxLlmCalls: 1, maxToolCalls: 0, maxOutputChars: 6000 },
  },
] as const;

const BY_ID = new Map(SPECIALISTS.map((item) => [item.id, item]));

export function listAgentSpecialists(): AgentSpecialistDefinition[] {
  return SPECIALISTS.map((item) => ({
    ...item,
    allowedTools: [...item.allowedTools],
    acceptedArtifacts: [...item.acceptedArtifacts],
    budget: { ...item.budget },
  }));
}

export function getAgentSpecialist(id: AgentSpecialistId): AgentSpecialistDefinition {
  const specialist = BY_ID.get(id);
  if (!specialist) throw new Error(`Unregistered agent specialist: ${id}`);
  return specialist;
}
