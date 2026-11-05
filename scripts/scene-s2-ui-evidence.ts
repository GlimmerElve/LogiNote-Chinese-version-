/** Local evidence binding for the complete synthetic UI-handler validation, never an additional model stage. */
import type { SceneInitialRequest } from '../src/types';
import type { S2AgentReply, S2CanvasDefinition, S2Document } from '../src/types/sceneS2';
import type { S2InteractionFrame } from '../src/types/sceneS2Plugin';
import type { S2LocalExecution, S2WorkflowRun } from '../src/services/scene/sceneS2PluginHost';
import { s2BusinessRuntimeContext } from '../src/services/scene/sceneS2Business';

export interface S2UiReviewStep {
  query: string; origin: string; before: S2Document; result: S2AgentReply; after?: S2Document;
  hostFrame?: Pick<S2InteractionFrame, 'sceneId' | 'runId' | 'revision' | 'event'>;
  triggeredExecution?: { available: boolean; workflowRunId?: string; revision: number };
  historyLength?: number; memoryRunId?: string; memoryVersionBefore?: number; memoryVersionAfter?: number; sameMemoryAndHostRun?: boolean;
}
interface Source { id: string; kind: 'design' | 'reply' | 'host'; text: string; turn?: number; origin?: string }
export interface S2UiEvidence extends Omit<Source, 'text'> { id: string; sourceId: string; checkIds: string[]; quote: string }
export interface S2UiReviewCheck { id: string; verdict: 'met' | 'unmet' | 'uncertain'; evidenceId: string; evidence: string; reason: string }
export const S2_UI_EVIDENCE_LIMITS = { minChars: 20, maxChars: 100, sources: 40, sourceChars: 90000,
  sourceTotalChars: 180000, perCheck: 160, candidates: 640, quoteChars: 48000, inputChars: 90000 } as const;
export class S2UiEvidenceError extends Error {
  constructor(readonly code: 'ui-evidence-empty' | 'ui-evidence-limit' | 'ui-evidence-unsupported-check' | 'ui-review-input-too-large') { super(code); }
}
const json = (value: unknown) => JSON.stringify(value);
const heading = (line: string) => /^#{1,6}\s+\S/.test(line.trim()) || /^【[^】\r\n]+】$/.test(line.trim())
  || /^(?:\*\*[^\r\n]+\*\*|__[^\r\n]+__)$/.test(line.trim()) || /^(?:[-_*]\s*){3,}$/.test(line.trim());
function bodyQuotes(text: string): string[] {
  const output: string[] = [], seen = new Set<string>();
  const add = (raw: string) => { const quote = raw.trim();
    if (quote.length >= 20 && quote.length <= 100 && !seen.has(quote) && !heading(quote)) { seen.add(quote); output.push(quote); } };
  const emit = (raw: string) => {
    const body = raw.trim(); let start = 0;
    while (body.length - start >= 20) {
      let end = Math.min(start + 100, body.length);
      if (end < body.length) for (let at = end - 1; at >= start + 19; at--) if (/[。！？!?；;\r\n]/.test(body[at])) { end = at + 1; break; }
      add(body.slice(start, end)); start = end; while (/\s/.test(body[start] ?? '') && start < body.length) start++;
    }
    if (start < body.length && body.length >= 20) add(body.slice(Math.max(0, body.length - 100)));
  };
  let run = '';
  for (const match of text.matchAll(/([^\r\n]*)(\r\n|\n|\r|$)/g)) {
    if (!match[0]) continue;
    if (heading(match[1])) { emit(run); run = ''; } else run += match[0];
  }
  emit(run); return output;
}
export interface S2UiEvidenceInput {
  originalRequest: SceneInitialRequest; definition: S2CanvasDefinition; preview: unknown; userDocument?: S2Document;
  steps: S2UiReviewStep[]; workflows: S2WorkflowRun[]; receipts: S2LocalExecution[];
  collaborationIndex: number; executionIndex: number; queryCount: number; checkIds: readonly string[];
  localChecks: Record<string, boolean>; stopped?: string;
}

/** No original request, user query or private witness is an eligible evidence source. */
export function buildS2UiReviewEvidence(input: S2UiEvidenceInput) {
  const limits = S2_UI_EVIDENCE_LIMITS, checks = [...input.checkIds];
  if (!checks.length || checks.length > 16 || new Set(checks).size !== checks.length || checks.some(id => !/^[a-z][a-z0-9-]{0,63}$/.test(id))) throw new S2UiEvidenceError('ui-evidence-unsupported-check');
  if (!Number.isInteger(input.collaborationIndex) || !Number.isInteger(input.executionIndex) || input.collaborationIndex < 0
    || input.executionIndex <= input.collaborationIndex || input.queryCount !== input.executionIndex + 1 || input.steps.length > input.queryCount + 1)
    throw new S2UiEvidenceError('ui-evidence-limit');
  const { business, ...definitionRest } = input.definition;
  const publicBusiness = business ? { ...s2BusinessRuntimeContext(business), knowledge: business.knowledge.map(item => ({ ...item })) } : undefined;
  const publicDefinition = { ...definitionRest, ...(publicBusiness ? { business: publicBusiness } : {}) };
  const sources: Source[] = [];
  const add = (source: Source) => {
    if (sources.length >= limits.sources || source.text.length > limits.sourceChars || sources.some(item => item.id === source.id)) throw new S2UiEvidenceError('ui-evidence-limit');
    sources.push(source); return source.id;
  };
  const designGoal = add({ id: 'design-goal', kind: 'design', text: input.definition.goal });
  const designPolicy = add({ id: 'design-policy', kind: 'design', text: json(input.definition.instructions) });
  const designInitial = add({ id: 'design-initial', kind: 'design', text: json(input.definition.initial) });
  const designBusiness = publicBusiness ? add({ id: 'design-business', kind: 'design', text: json(publicBusiness) }) : undefined;
  const designIds = [designGoal, designPolicy, designInitial, ...(designBusiness ? [designBusiness] : [])];
  const users = input.steps.map((step, index) => ({ step, turn: index + 1 })).filter(item => item.step.origin === 'user');
  const userReply = (index: number) => {
    const item = users[index]; return item ? add({ id: `reply-${item.turn}`, kind: 'reply', text: item.step.result.reply, turn: item.turn, origin: item.step.origin }) : undefined;
  };
  const userReplyIds = users.map((_, index) => userReply(index)!);
  const collaboration = users[input.collaborationIndex], execution = users[input.executionIndex];
  const collaborationIds = collaboration ? [userReplyIds[input.collaborationIndex]] : [];
  if (collaboration?.step.after && input.localChecks.uiConfirmedEditMatchesProposal === true) collaborationIds.push(add({ id: 'host-confirmed-edit', kind: 'host', turn: collaboration.turn,
    text: json({ origin: 'actual-ui-confirmed-edit', commands: collaboration.step.result.commands, document: collaboration.step.after }) }));
  const hostIds: string[] = [];
  // Bind the completion reply and records to the exact real event, never the latest unrelated run or a user promise.
  for (const [index, step] of input.steps.entries()) {
    const frame = step.hostFrame, event = frame?.event;
    if (step.origin !== 'host-event' || event?.kind !== 'workflow-completed' || !event.workflowRunId || !execution
      || index <= execution.turn - 1 || step.triggeredExecution?.available !== true
      || step.triggeredExecution.workflowRunId !== event.workflowRunId || step.triggeredExecution.revision !== frame!.revision) continue;
    const run = input.workflows.find(item => item.id === event.workflowRunId && item.revision === frame!.revision && item.publication === 'current');
    if (!run || !['succeeded', 'failed'].includes(run.status)) continue;
    const turn = index + 1;
    hostIds.push(add({ id: `reply-${turn}`, kind: 'reply', text: step.result.reply, turn, origin: 'host-event' }));
    hostIds.push(add({ id: `host-run-${turn}`, kind: 'host', text: json(run), turn, origin: 'host-event' }));
    const invocationIds = new Set(run.nodes.flatMap(node => node.invocationId ? [node.invocationId] : []));
    const receipts = input.receipts.filter(item => invocationIds.has(item.receipt.invocationId) && item.receipt.sceneId === frame!.sceneId
      && item.receipt.runId === frame!.runId && item.receipt.revision === frame!.revision && item.receipt.publication === 'current');
    if (receipts.length) hostIds.push(add({ id: `host-receipts-${turn}`, kind: 'host', text: json(receipts), turn, origin: 'host-event' }));
  }
  const consentIds = execution ? [userReplyIds[input.executionIndex], ...hostIds] : [];
  if (execution) consentIds.push(add({ id: 'host-confirmation-facts', kind: 'host', turn: execution.turn,
    text: json({ origin: 'actual-ui-confirmation-facts', awaitingUserConfirmation: input.localChecks.awaitingUserConfirmation,
      confirmedEditMatchesProposal: input.localChecks.uiConfirmedEditMatchesProposal, selectedTargetsOnly: input.localChecks.selectedTargetsOnly,
      confirmedWorkflowSucceeded: input.localChecks.confirmedWorkflowSucceeded }) }));
  const policy: Record<string, Array<string | undefined>> = {
    'design-goal-and-roles': designIds, 'incomplete-exercise': [designInitial],
    'hint-not-solution': [userReplyIds[0]], 'analogy-not-workflow': [userReplyIds[1]],
    'preserve-and-collaborate': collaborationIds, 'execution-vs-business-truth': hostIds,
    'bounded-target-and-consent': consentIds, 'result-grounding': hostIds,
    'authorized-completion': designIds, 'exercise-not-answer': [designInitial],
    'hint-and-skill-analogy': [userReplyIds[0], userReplyIds[1]],
    'criterion-grounding': [userReplyIds[2]], 'advice-not-score': [userReplyIds[input.collaborationIndex - 1]],
    'collaboration-preserves-work': collaborationIds, 'consent-and-local-results': hostIds,
  };
  if (sources.reduce((count, source) => count + source.text.length, 0) > limits.sourceTotalChars) throw new S2UiEvidenceError('ui-evidence-limit');
  for (const checkId of checks) if (!Object.hasOwn(policy, checkId)) throw new S2UiEvidenceError('ui-evidence-unsupported-check');
  const catalogue: S2UiEvidence[] = []; let quoteChars = 0; const counts = new Map(checks.map(id => [id, 0]));
  for (const source of sources) {
    const checkIds = checks.filter(id => policy[id].includes(source.id));
    if (!checkIds.length) continue; let count = 0;
    for (const quote of bodyQuotes(source.text)) {
        if (!source.text.includes(quote)) throw new S2UiEvidenceError('ui-evidence-empty');
        for (const id of checkIds) { counts.set(id, counts.get(id)! + 1); if (counts.get(id)! > limits.perCheck) throw new S2UiEvidenceError('ui-evidence-limit'); }
        if (catalogue.length >= limits.candidates || quoteChars + quote.length > limits.quoteChars) throw new S2UiEvidenceError('ui-evidence-limit');
        quoteChars += quote.length;
        catalogue.push({ id: `${source.id}--${String(++count).padStart(3, '0')}`, checkIds, sourceId: source.id,
          kind: source.kind, ...(source.turn === undefined ? {} : { turn: source.turn }), ...(source.origin ? { origin: source.origin } : {}), quote });
    }
  }
  if ([...counts.values()].some(count => !count)) throw new S2UiEvidenceError('ui-evidence-empty');
  // Deduplicate identical complete document snapshots; references preserve all fields, not summaries or truncation.
  const documents: Array<{ id: string; document: S2Document }> = [], documentIds = new Map<string, string>();
  const document = (value: S2Document | undefined) => {
    if (!value) return undefined; const key = json(value); let id = documentIds.get(key);
    if (!id) { id = `document-${documents.length + 1}`; documentIds.set(key, id); documents.push({ id, document: value }); } return id;
  };
  const { initial: _, ...definitionFields } = publicDefinition;
  const transcript = { originalRequest: input.originalRequest,
    definition: { ...definitionFields, initialDocumentId: document(input.definition.initial) },
    preview: input.preview, userDocumentId: document(input.userDocument),
    steps: input.steps.map(step => { const { before, after, ...rest } = step; return { ...rest, beforeDocumentId: document(before), afterDocumentId: document(after) }; }),
    documents, workflows: input.workflows, receipts: input.receipts, localChecks: input.localChecks, stopped: input.stopped };
  return { catalogue, transcript, sources: sources.map(source => ({ ...source })),
    actualReplies: input.steps.map((step, index) => `ACTUAL_REPLY ${index + 1} (${step.origin})\n${step.result.reply}\nEND_REPLY`).join('\n') };
}
export function readS2UiEvidenceJudge(raw: unknown, catalogue: readonly S2UiEvidence[], checkIds: readonly string[]): S2UiReviewCheck[] {
  const value = raw as { checks?: unknown[] };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => key !== 'checks')
    || !Array.isArray(value.checks) || value.checks.length !== checkIds.length) throw new Error('Invalid UI evidence judge coverage');
  const seen = new Set<string>();
  return value.checks.map(raw => {
    const item = raw as Omit<S2UiReviewCheck, 'evidence'>, evidence = catalogue.find(entry => entry.id === item?.evidenceId);
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).some(key => !['id', 'verdict', 'evidenceId', 'reason'].includes(key))
      || !checkIds.includes(item.id) || seen.has(item.id) || !['met', 'unmet', 'uncertain'].includes(item.verdict)
      || typeof item.evidenceId !== 'string' || !evidence || !evidence.checkIds.includes(item.id) || evidence.quote.length < 20 || evidence.quote.length > 100
      || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 1000) throw new Error('Invalid or cross-source UI evidence judge');
    seen.add(item.id); return { ...item, evidence: evidence.quote };
  });
}
export function assertS2UiReviewInput(text: string) {
  if (text.length > S2_UI_EVIDENCE_LIMITS.inputChars) throw new S2UiEvidenceError('ui-review-input-too-large');
}
