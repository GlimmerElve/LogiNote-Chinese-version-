import type { ReviewQuestionIntent } from '../reviewIntent';
import type { ReviewAnswerEvidence } from '../memory/types';
import { argumentContextHash } from './hash';
import { parseArgumentQuestionReceipt, type ArgumentQuestionReceipt } from './questionReceipt';

export interface ReviewArgumentQuestionApi {
  getEnvironment(selection: import('../../electron/rag/argumentLearningScope').ArgumentEnvironmentSelection): Promise<import('../../electron/rag/argumentProjectionEnvironment').ArgumentProjectionEnvironmentReply>;
  freezeQuestion(environmentId: string, selectors: import('./questionBindingTypes').ArgumentQuestionFrameSelectors): Promise<ArgumentQuestionReceipt>;
  verifyQuestion(environmentId: string, receipt: ArgumentQuestionReceipt): Promise<import('./questionReceipt').ArgumentQuestionReceiptVerification>;
  readQuestion?(environmentId: string, receipt: ArgumentQuestionReceipt): Promise<import('./referenceDisclosure').ArgumentReferenceDisclosureReply>;
  readQuestionPropositions?(environmentId: string, receipt: ArgumentQuestionReceipt): Promise<import('./referencePropositionReceipt').ArgumentReferencePropositionDisclosureReply>;
}
/** Local optional preparation only. No model call, score, belief update or reference re-selection. */
export function createReviewArgumentQuestionClient(noteId: string, sessionId: string,
  getApi: () => ReviewArgumentQuestionApi | undefined = () => typeof window === 'undefined' ? undefined
    : (window as unknown as {electronAPI?:{argumentContext?:ReviewArgumentQuestionApi}}).electronAPI?.argumentContext) {
  async function freeze(intent: ReviewQuestionIntent): Promise<ArgumentQuestionReceipt> {
    intent = structuredClone(intent);
    const originQuestionMessageId = `q-${await argumentContextHash([sessionId, intent.questionMessageId])}`;
    const held = (reason: string): ArgumentQuestionReceipt => ({ version: 1, status: 'held', originQuestionMessageId, reasons: [reason] });
    if (intent.assessment?.status !== 'fixed' || intent.referenceRubric?.status !== 'fixed') return held('reference_unavailable');
    try {
      const api = getApi(); if (!api?.freezeQuestion) return held('environment_unavailable');
      const environment = await api.getEnvironment({ kind: 'learning-note', noteId });
      if (environment.status !== 'available') return held('environment_unavailable');
      const selectors = {
        questionMessageId: originQuestionMessageId, knowledgeTargets: [...intent.knowledgeTargets],
        assessment: structuredClone(intent.assessment), referenceRubric: structuredClone(intent.referenceRubric) };
      const receipt = parseArgumentQuestionReceipt(await api.freezeQuestion(environment.environmentId, selectors));
      if (receipt.originQuestionMessageId !== originQuestionMessageId) return held('receipt_unavailable');
      if (receipt.freezeId && receipt.selectorsHash !== await argumentContextHash(selectors)) return held('receipt_unavailable');
      return receipt;
    } catch { return held('environment_unavailable'); }
  }
  async function verifyAnswers(evidence: ReviewAnswerEvidence[]): Promise<void> {
    const answers = evidence.filter(a => a.questionIntent?.referenceStructure).map(answer =>
      ({ answer, intent: structuredClone(answer.questionIntent!), receipt: structuredClone(answer.questionIntent!.referenceStructure!) }));
    if (!answers.length) return;
    // Bound work explicitly; never pretend omitted answers were verified.
    for (const { answer } of answers) answer.referenceStructureVerification = { status: 'held', reasons: ['verification_not_performed'] };
    try {
      const api = getApi(); if (!api?.verifyQuestion) return;
      const environment = await api.getEnvironment({ kind: 'learning-note', noteId });
      if (environment.status !== 'available') return;
      const cache = new Map<string, import('./questionReceipt').ArgumentQuestionReceiptVerification>();
      for (const { answer, intent, receipt } of answers.slice(0, 12)) {
        if (!receipt.selectorsHash || await argumentContextHash({ questionMessageId: receipt.originQuestionMessageId,
          knowledgeTargets: intent.knowledgeTargets, assessment: intent.assessment, referenceRubric: intent.referenceRubric }) !== receipt.selectorsHash) {
          answer.referenceStructureVerification = { status: 'held', reasons: ['intent_changed'] }; continue;
        }
        const key = JSON.stringify(receipt);
        let result = cache.get(key);
        if (!result) {
          const raw = await api.verifyQuestion(environment.environmentId, receipt);
          result = raw && ['current', 'held'].includes(raw.status) && Array.isArray(raw.reasons)
            && raw.reasons.length <= 24 && raw.reasons.every(r => typeof r === 'string' && /^[a-z_]{1,80}$/u.test(r))
            ? { status: raw.status, reasons: [...raw.reasons] } : { status: 'held', reasons: ['receipt_unavailable'] };
          cache.set(key, result);
        }
        // Do not attach the original receipt's result to an answer whose intent was
        // replaced during awaited host reads. Keys are generated by this client.
        let unchanged = false;
        try { unchanged = JSON.stringify(answer.questionIntent) === JSON.stringify(intent); } catch { /* changed/unserializable */ }
        answer.referenceStructureVerification = unchanged ? structuredClone(result) : { status: 'held', reasons: ['intent_changed'] };
      }
    } catch { /* Learning and the old score writer remain usable without this shadow read. */ }
  }
  /** Deliberate read only; normal learning does not add another model request. */
  async function readReference(original: ReviewQuestionIntent): Promise<import('./referenceDisclosure').ArgumentReferenceDisclosureReply> {
    const intent = structuredClone(original), receipt = intent.referenceStructure;
    if (!receipt || receipt.status !== 'fixed' || !receipt.selectorsHash || intent.assessment?.status !== 'fixed'
      || intent.referenceRubric?.status !== 'fixed') return { status: 'held', reasons: ['reference_unavailable'] };
    try {
      if (receipt.selectorsHash !== await argumentContextHash({ questionMessageId: receipt.originQuestionMessageId,
        knowledgeTargets: intent.knowledgeTargets, assessment: intent.assessment, referenceRubric: intent.referenceRubric }))
        return { status: 'held', reasons: ['intent_changed'] };
      const api = getApi(); if (!api?.readQuestion) return { status: 'held', reasons: ['environment_unavailable'] };
      const environment = await api.getEnvironment({ kind: 'learning-note', noteId });
      if (environment.status !== 'available') return { status: 'held', reasons: ['environment_unavailable'] };
      const reply = await api.readQuestion(environment.environmentId, receipt);
      if (JSON.stringify(original) !== JSON.stringify(intent)) return { status: 'held', reasons: ['intent_changed'] };
      if (reply.status === 'held') return structuredClone(reply);
      const context = reply.context;
      if (context.coverage !== 'complete_required' || context.contractHash !== receipt.contractHash
        || context.originQuestionMessageId !== receipt.originQuestionMessageId || context.rubricHash !== await argumentContextHash(intent.referenceRubric)
        || JSON.stringify(context.assessment) !== JSON.stringify(intent.assessment)
        || JSON.stringify(context.frames.map(frame => frame.knowledgeTarget)) !== JSON.stringify(intent.knowledgeTargets))
        return { status: 'held', reasons: ['receipt_unavailable'] };
      if (JSON.stringify(original) !== JSON.stringify(intent)) return { status: 'held', reasons: ['intent_changed'] };
      return structuredClone(reply);
    } catch { return { status: 'held', reasons: ['environment_unavailable'] }; }
  }
  /** Explicit anchor reader, never invoked by normal review or old scoring. */
  async function readReferencePropositions(original: ReviewQuestionIntent): Promise<import('./referencePropositionReceipt').ArgumentReferencePropositionDisclosureReply> {
    const intent = structuredClone(original);
    try {
      // Obtain independent host authority first, not a client-supplied context.
      const reference = await readReference(intent);
      if (reference.status !== 'ready') return reference;
      const api = getApi(), receipt = intent.referenceStructure;
      if (!api?.readQuestionPropositions || !receipt) return { status: 'held', reasons: ['propositions_unavailable'] };
      const environment = await api.getEnvironment({ kind: 'learning-note', noteId });
      if (environment.status !== 'available') return { status: 'held', reasons: ['environment_unavailable'] };
      const reply = await api.readQuestionPropositions(environment.environmentId, receipt);
      if (JSON.stringify(original) !== JSON.stringify(intent)) return { status: 'held', reasons: ['intent_changed'] };
      if (reply.status !== 'ready') return structuredClone(reply);
      const contextHash = await argumentContextHash(reference.context);
      if (reply.binding.freezeId !== receipt.freezeId || reply.binding.contractHash !== receipt.contractHash
        || reply.binding.contextHash !== contextHash || reply.bundle.contextHash !== contextHash
        || reply.bundle.contractHash !== receipt.contractHash || reply.binding.bundleHash !== reply.bundle.bundleHash
        || await argumentContextHash(reply.context) !== contextHash)
        return { status: 'held', reasons: ['receipt_unavailable'] };
      if (JSON.stringify(original) !== JSON.stringify(intent)) return { status: 'held', reasons: ['intent_changed'] };
      return structuredClone(reply);
    } catch { return { status: 'held', reasons: ['propositions_unavailable'] }; }
  }
  return { freeze, verifyAnswers, readReference, readReferencePropositions };
}
