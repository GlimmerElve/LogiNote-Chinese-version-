import type { ArgumentReferenceDisclosureContext } from '../src/services/argumentContext/referenceDisclosure.ts';
import type { FrozenReferenceShadowResult } from '../src/services/reviewComparison/frozenReferenceShadow.ts';
import type { ReviewCriterionId } from '../src/services/reviewAssessment.ts';
import type { ReviewReferenceRubric } from '../src/services/reviewReferenceRubric.ts';
import { REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET, REVIEW_PROGRESSIVE_ACCEPTANCE_REFERENCES,
  summarizeReviewProgressiveAcceptanceReport } from './review-progressive-acceptance-dataset.ts';
import { judgeReviewProgressiveOutcome, type ReviewProgressiveCase, type ReviewProgressiveOutcome,
  type ReviewProgressiveTask } from './review-progressive-dataset.ts';

/** Pre-registered synthetic texts and unchanged eight answer expectations. This
 * module imports no fixture builder, config reader, model caller or vault reader.
 * A real source build is required by the runner; the prior fixed graph is NOT
 * transplanted into its reference store. This remains assistant draft, not gold. */
export const REFERENCE_RAG_ACCEPTANCE_DATASET_VERSION = 'reference-rag-source-to-answer-acceptance-v1' as const;
export const REFERENCE_RAG_ACCEPTANCE_DATASET = REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET;
export const REFERENCE_RAG_ACCEPTANCE_BUDGET = {
  sources: 3, sourceCallsPerSource: 5, sourceRequests: 15,
  answerCallsPerCase: 2, answerRequests: 16, totalRequests: 31,
  authorizationMaximum: 56, automaticRetries: 0,
} as const;
export interface ReferenceRagAcceptanceSelector {
  itemId: string; criterionId: ReviewCriterionId; paragraphIndex: number;
  start: number; end: number; text: string;
}
export interface ReferenceRagAcceptanceSource {
  sourceId: string; task: ReviewProgressiveTask; sourceParagraphs: readonly string[];
  content: string; selectors: readonly ReferenceRagAcceptanceSelector[];
}

/** LF is declared here before a run; offsets are never inferred from a reply.
 * Titles/note IDs are runner-owned. Their host scope is validated separately. */
function acceptanceSource(task: ReviewProgressiveTask): ReferenceRagAcceptanceSource {
    const reference = REVIEW_PROGRESSIVE_ACCEPTANCE_REFERENCES[task];
    const sourceParagraphs = [...reference.sourceParagraphs], content = sourceParagraphs.join('\n\n');
    const selectors = reference.selectedItems.map(item => {
      const start = sourceParagraphs.slice(0, item.paragraphIndex).reduce((sum, text) => sum + text.length + 2, 0);
      const text = sourceParagraphs[item.paragraphIndex];
      return { itemId: item.itemId, criterionId: item.criterionId, paragraphIndex: item.paragraphIndex,
        start, end: start + text.length, text };
    });
    return Object.freeze({ sourceId: `acceptance-source-${task}`, task,
      sourceParagraphs: Object.freeze(sourceParagraphs), content,
      selectors: Object.freeze(selectors.map(selector => Object.freeze(selector))) });
}
export const REFERENCE_RAG_ACCEPTANCE_SOURCES: Record<ReviewProgressiveTask, ReferenceRagAcceptanceSource> = Object.freeze({
  definition: acceptanceSource('definition'), condition: acceptanceSource('condition'), reasoning: acceptanceSource('reasoning'),
});

export interface ReferenceRagAcceptanceRubricRegistration {
  version: 1; protocol: 'reference-rag-acceptance-rubric-registration-v1';
  datasetVersion: typeof REFERENCE_RAG_ACCEPTANCE_DATASET_VERSION;
  caseId: string; task: ReviewProgressiveTask; frameId: 'target-1';
  contractHash: string; rubricHash: string;
  /** Only identity is accepted in v1. Any future mapping must be declared before
   * answer requests, not selected by a result or fabricated from graph IDs. */
  itemMappings: readonly { expectedItemId: string; actualItemId: string; criterionId: ReviewCriterionId;
    paragraphIndex: number; start: number; end: number; text: string }[];
}
const registrations = new WeakMap<ReferenceRagAcceptanceRubricRegistration, string>();
const fail = (): never => { throw new Error('acceptance_pre_answer_rubric_mismatch'); };
const signature = (testCase: ReviewProgressiveCase) => JSON.stringify(testCase);
const canonicalCase = (testCase: ReviewProgressiveCase) => {
  const canonical = REFERENCE_RAG_ACCEPTANCE_DATASET.find(item => item.id === testCase.id);
  if (!canonical || signature(canonical) !== signature(testCase)) fail();
  return canonical!;
};

/** Check the REAL newly frozen host rubric and disclosure before answer models.
 * This is a benchmark alignment check, not host authentication or a graph repair.
 * Graph/node/relation IDs may be real model output; item coordinates/criteria may
 * not be changed to make an answer match. A held/missing context cannot register. */
export function assertPreAnswerRubric(testCase: ReviewProgressiveCase, value: {
  rubric: ReviewReferenceRubric; context: ArgumentReferenceDisclosureContext;
}): ReferenceRagAcceptanceRubricRegistration {
  canonicalCase(testCase);
  const source = REFERENCE_RAG_ACCEPTANCE_SOURCES[testCase.task], { rubric, context } = value;
  const expectedItems = testCase.expected.frames[0].items;
  if (testCase.expected.frames.length !== 1 || testCase.expected.frames[0].frameId !== 'target-1'
    || rubric?.status !== 'fixed' || rubric.taskType !== testCase.task || rubric.items.length !== source.selectors.length
    || context?.version !== 1 || context.protocol !== 'review-frozen-reference-context-v1'
    || context.taskType !== testCase.task || context.coverage !== 'complete_required' || context.policy !== 'all_target_frames'
    || context.assessment.status !== 'fixed' || context.assessment.taskType !== testCase.task
    || context.limitations.semanticTruth !== 'not_certified' || context.limitations.writes !== 'disabled'
    || context.frames.length !== 1 || !/^[a-f0-9]{64}$/u.test(context.contractHash)
    || !/^[a-f0-9]{64}$/u.test(context.rubricHash)) fail();
  const frame = context.frames[0];
  if (frame.frameId !== 'target-1' || frame.source.kind !== 'knowledge-note'
    || frame.source.coordinateSpace !== 'saved-note-utf16' || frame.items.length !== source.selectors.length
    || new Set(context.quotes.map(quote => quote.quoteId)).size !== context.quotes.length) fail();
  const itemMappings = source.selectors.map((selector, index) => {
    const expected = expectedItems[index], actualRubric = rubric.items[index], actualItem = frame.items[index];
    const quote = context.quotes.find(candidate => candidate.quoteId === actualItem?.quoteId);
    if (!expected || expected.itemId !== selector.itemId || expected.criterionId !== selector.criterionId
      || actualRubric.itemId !== selector.itemId || actualRubric.criterionId !== selector.criterionId
      || actualRubric.noteId !== frame.source.entityId || actualRubric.knowledgeTarget !== frame.knowledgeTarget
      || actualRubric.start !== selector.start || actualRubric.end !== selector.end || actualRubric.quote !== selector.text
      || actualItem?.itemId !== selector.itemId || actualItem.criterionId !== selector.criterionId
      || !actualItem.nodeIds.length || !quote || quote.start !== selector.start || quote.end !== selector.end
      || quote.text !== selector.text || source.content.slice(quote.start, quote.end) !== quote.text) fail();
    return Object.freeze({ expectedItemId: selector.itemId, actualItemId: actualItem.itemId,
      criterionId: selector.criterionId, paragraphIndex: selector.paragraphIndex,
      start: selector.start, end: selector.end, text: selector.text });
  });
  const registration: ReferenceRagAcceptanceRubricRegistration = Object.freeze({ version: 1,
    protocol: 'reference-rag-acceptance-rubric-registration-v1', datasetVersion: REFERENCE_RAG_ACCEPTANCE_DATASET_VERSION,
    caseId: testCase.id, task: testCase.task, frameId: 'target-1', contractHash: context.contractHash,
    rubricHash: context.rubricHash, itemMappings: Object.freeze(itemMappings) });
  registrations.set(registration, signature(testCase));
  return registration;
}

/** No registration (including source/question held) is a failed acceptance
 * observation, not an exception that discards remaining cases or a safe pass. */
export function judgeReferenceRagAcceptanceOutcome(testCase: ReviewProgressiveCase, result: FrozenReferenceShadowResult,
  registration?: ReferenceRagAcceptanceRubricRegistration | null): ReviewProgressiveOutcome {
  const outcome = judgeReviewProgressiveOutcome(testCase, result);
  if (!registration || registrations.get(registration) !== signature(testCase)
    || registration.caseId !== testCase.id || registration.task !== testCase.task) {
    outcome.passed = false; outcome.semanticPass = false;
    outcome.failures.unshift('pre_answer_rubric_not_registered');
  }
  return outcome;
}

export interface ReferenceRagAcceptanceSourceOutcome {
  sourceId: string; task: ReviewProgressiveTask; status: 'published' | 'held' | 'not_processed';
  modelRequests: { structure: number; propositions: number; total: number };
  reasons?: string[];
}

/** Counts source work once for each shared source, rather than pretending every
 * answer rebuilt the source. Source held/unprocessed and omitted cases cannot
 * yield all-pass. Expectations and answer safety remain the previous predicate. */
export function summarizeReferenceRagAcceptanceReport(outcomes: readonly ReviewProgressiveOutcome[],
  sourceOutcomes: readonly ReferenceRagAcceptanceSourceOutcome[]) {
  const previous = summarizeReviewProgressiveAcceptanceReport(outcomes);
  const outcomeContractsValid = outcomes.every(outcome => {
    const testCase = REFERENCE_RAG_ACCEPTANCE_DATASET.find(value => value.id === outcome.caseId);
    return !!testCase && outcome.task === testCase.task && outcome.category === testCase.category
      && JSON.stringify(outcome.expected) === JSON.stringify(testCase.expected);
  });
  const tasks = ['definition', 'condition', 'reasoning'] as const;
  const sourceSetComplete = sourceOutcomes.length === tasks.length
    && new Set(sourceOutcomes.map(source => source.task)).size === tasks.length
    && new Set(sourceOutcomes.map(source => source.sourceId)).size === tasks.length
    && tasks.every(task => sourceOutcomes.some(source => source.task === task && source.status === 'published'));
  const sourceCountsValid = sourceOutcomes.every(source => {
    const count = source.modelRequests;
    return tasks.includes(source.task) && source.sourceId.trim() && ['published', 'held', 'not_processed'].includes(source.status)
      && [count.structure, count.propositions, count.total].every(value => Number.isSafeInteger(value) && value >= 0)
      && count.structure <= 3 && count.propositions <= 2 && count.total === count.structure + count.propositions && count.total <= 5
      && (source.status !== 'published' || (count.structure > 0 && count.propositions === 2))
      && (source.status !== 'not_processed' || count.total === 0);
  });
  const sourceRequests = sourceOutcomes.reduce((sum, source) => sum + source.modelRequests.total, 0);
  // The old judge verifies at most two calls; accepted complete results require
  // exactly two. Held calls are recorded by the runner's stage ledger separately.
  const answerMaximum = outcomes.length * REFERENCE_RAG_ACCEPTANCE_BUDGET.answerCallsPerCase;
  const budgetValid = sourceCountsValid && sourceRequests <= REFERENCE_RAG_ACCEPTANCE_BUDGET.sourceRequests
    && answerMaximum <= REFERENCE_RAG_ACCEPTANCE_BUDGET.answerRequests
    && sourceRequests + answerMaximum <= REFERENCE_RAG_ACCEPTANCE_BUDGET.totalRequests;
  return { ...previous, datasetVersion: REFERENCE_RAG_ACCEPTANCE_DATASET_VERSION,
    pilot: 'real_model_source_to_answer_shared_synthetic_sources' as const,
    referenceReviewer: 'configured_model_with_host_replay' as const,
    sourceSetComplete, budgetValid, outcomeContractsValid, sourceOutcomes: structuredClone(sourceOutcomes),
    budget: REFERENCE_RAG_ACCEPTANCE_BUDGET, sourceRequests, answerRequestUpperBound: answerMaximum,
    totalRequestUpperBound: sourceRequests + answerMaximum,
    allCasesPass: previous.allCasesPass && outcomeContractsValid && sourceSetComplete && budgetValid };
}

/** Public pure content used for a preflight/manifest SHA-256. It is not a model
 * prompt: assistant expectations must stay outside source and answer requests. */
export function referenceRagAcceptanceFingerprintContent() {
  return { datasetVersion: REFERENCE_RAG_ACCEPTANCE_DATASET_VERSION, budget: REFERENCE_RAG_ACCEPTANCE_BUDGET,
    sources: REFERENCE_RAG_ACCEPTANCE_SOURCES, cases: REFERENCE_RAG_ACCEPTANCE_DATASET,
    rubricRegistration: { frameId: 'target-1', mapping: 'identity_only_pre_answer', sourceCoordinateSpace: 'saved-note-utf16',
      sourceLineEndings: 'LF', criterionAndOriginalParagraphMustMatch: true } };
}
