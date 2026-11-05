import type { LlmCallRequest, LlmCallResponse } from '../../types';
import { callLLM } from '../llmService';
import { AgentCoordinator } from './agentCoordinator';
import { COGNITION_ALIGNMENT_REVIEW_PROMPT, comparisonUnavailable, isAlignmentReference, renderCognitionAlignment, validateCognitionAlignment, type AlignmentDecision } from '../cognition/alignment';
import type { QaEvidenceReviewContext } from './postToolReview';
import type { QaFinalAnswerGateResult } from './finalAnswerGate';

/** Reuses the existing final-review slot. Never repairs an unsafe comparison with unchecked prose. */
export async function runCognitionAlignmentGate(input: {
  question: string; draftAnswer: string; evidence: QaEvidenceReviewContext; auditRunId: string;
  callLlm?: (request: LlmCallRequest) => Promise<LlmCallResponse>; maxLlmCalls: number;
}): Promise<QaFinalAnswerGateResult> {
  const maxLlmCalls = input.maxLlmCalls >= 1 ? 1 : 0;
  const coordinator = new AgentCoordinator({ workflowId: 'qa-answer-gate-v1', userRequest: input.question,
    runId: `${input.auditRunId}:cognition-alignment`, budget: { maxTasks: 1, maxLlmCalls, maxToolCalls: 0, maxOutputChars: 5000 } });
  let decision: AlignmentDecision = { accepted: false, code: comparisonUnavailable(input.evidence) || 'review_unavailable' };
  if (maxLlmCalls && !comparisonUnavailable(input.evidence)) {
    const artifact = await coordinator.runSpecialist<AlignmentDecision>({ specialistId: 'qa-answer-reviewer',
      objective: 'Check scope alignment of one cognitive claim against documentary evidence without changing cognition.',
      runner: async () => {
        let raw: unknown;
        try {
          const response = await (input.callLlm || callLLM)({ providerId: '', model: '', workflow: 'agent-personalized-qa', skipMemoryInjection: true,
            systemPromptOverride: COGNITION_ALIGNMENT_REVIEW_PROMPT,
            userInput: JSON.stringify({ question: input.question.slice(0, 1000), untrustedDraft: input.draftAnswer.slice(0, 6000),
              personalCognition: input.evidence.personalCognition,
              sources: input.evidence.sources.filter((s) => isAlignmentReference(s) && input.evidence.review.supportedCitationIds.includes(s.sourceId)) }) });
          raw = response.parsedJson ?? JSON.parse(response.content);
        } catch { /* Missing/invalid reviewer output must not grant permission to publish the draft claim. */ }
        const payload = validateCognitionAlignment(raw, input.evidence);
        return { payload, llmCalls: 1, toolCalls: 0, outputChars: JSON.stringify(payload).length,
          validation: { status: 'valid', diagnostics: payload.accepted ? [] : [payload.code] } };
      } });
    if (artifact) decision = artifact.payload;
  }
  const answer = renderCognitionAlignment(decision, input.evidence);
  return { answer, changed: answer !== input.draftAnswer.trim(),
    review: { valid: decision.accepted, invalidCitationIds: [], unsupportedClaims: decision.accepted ? [] : [`alignment:${decision.code}`],
      repairInstructions: decision.accepted ? [] : decision.certaintyNotice
        ? ['仅展示措辞强度提示；范围未对齐，不作完整关系判断或认知更新建议。']
        : ['先澄清对齐信息，不合并或覆盖原认知。'] },
    coordination: coordinator.summarize(!decision.accepted) };
}
