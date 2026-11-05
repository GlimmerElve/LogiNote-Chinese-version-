import { applyQaEvidenceFallback, buildQaAnswerCitations, discloseCognitionComparison, runQaFinalAnswerGate } from '../finalAnswerGate';
import { renderCognitionAlignment } from '../../cognition/alignment';
import type { PostToolReviewState } from '../postToolReview';
import { buildAgentReplyPolicy, resolveAgentQaQuestion } from '../replyPolicy';
import { isAgentSelfMetaQuestion } from '../skillRegistry';
import { normalizeAgentAnswerText } from '../answerFormat';
import { executeAgentNode, throwIfAgentAborted } from './nodeRunner';
import type { AgentLlmCaller, AgentNodeExecutionContext, AgentRunState } from './types';

const MAX_SPECIALIST_LLM_CALLS_PER_TURN = 4;
const FALSE_ACTIVE_SKILL_DENIAL = /(?:skill|技能).{0,24}(?:未激活|没有激活|未启用|没有.{0,12}激活|需要.{0,8}激活)|(?:没有|未).{0,20}(?:激活|启用).{0,20}(?:skill|技能)|技能面板|设置页.{0,16}(?:skill|技能)/iu;
const FALSE_PLAN_MATERIAL_REQUIREMENT = /(?:(?:需要|必须|请|先).{0,16}(?:上传|提供|导入).{0,12}(?:资料|文档|教材)|(?:没有|缺少).{0,12}(?:资料|文档|RAG).{0,16}(?:无法|不能|暂时不))/iu;


export function repairFalseActiveSkillDenial(
  reply: string,
  activeSkill?: { id: string; name: string },
): string {
  const normalized = reply.trim();
  if (!activeSkill) return normalized;
  const falseDenial = FALSE_ACTIVE_SKILL_DENIAL.test(normalized);
  const falsePlanMaterialRequirement = activeSkill.id === 'plan-planning'
    && FALSE_PLAN_MATERIAL_REQUIREMENT.test(normalized);
  if (!falseDenial && !falsePlanMaterialRequirement) return normalized;
  return `${activeSkill.name} Skill 已由系统自动激活，不需要手动开启${activeSkill.id === 'plan-planning' ? '，也不要求上传资料' : ''}。但本次任务尚未完成，请重试。`;
}

export async function runAgentFinalAnswerNode(
  state: AgentRunState,
  dependencies: {
    draftAnswer: string;
    mode: 'complete' | 'truncated';
    enablePostToolReview?: boolean;
    postToolReviewState: PostToolReviewState;
    callLlm?: AgentLlmCaller;
  },
  context: AgentNodeExecutionContext = {},
): Promise<AgentRunState> {
  return executeAgentNode(state, {
    id: 'final-answer',
    execute: async () => {
      if (dependencies.postToolReviewState.cognitionInquiry) {
        return {
          status: 'completed', draftReply: dependencies.draftAnswer,
          finalReply: dependencies.postToolReviewState.cognitionInquiry.answer,
          finalCitations: dependencies.postToolReviewState.cognitionInquiry.citations || [], postToolCoordinationRuns: [...dependencies.postToolReviewState.coordinationRuns],
        };
      }
      let cognitionChecked = false;
      let reply = dependencies.mode === 'complete'
        ? normalizeAgentAnswerText(dependencies.draftAnswer).trim() || '我暂时没有得到可用结果。'
        : dependencies.draftAnswer.trim() || '本次工具调用达到上限，请缩小问题范围后重试。';

      if (
        dependencies.mode === 'complete'
        && dependencies.enablePostToolReview
        && state.activeSkill?.id === 'personalized-qa'
        && dependencies.postToolReviewState.qaEvidence
      ) {
        try {
          context.onActivity?.({ phase: 'reviewing' });
          const remainingLlmCalls = Math.max(
            0,
            MAX_SPECIALIST_LLM_CALLS_PER_TURN - dependencies.postToolReviewState.llmCallsUsed,
          );
          const gate = await runQaFinalAnswerGate({
            question: state.standaloneRequest || resolveAgentQaQuestion(state.userText, state.inputHistory),
            replyPolicy: buildAgentReplyPolicy(state.userText),
            draftAnswer: reply,
            evidence: dependencies.postToolReviewState.qaEvidence,
            auditRunId: state.runId,
            callLlm: dependencies.callLlm,
            maxLlmCalls: Math.min(2, remainingLlmCalls),
          });
          reply = gate.answer;
          cognitionChecked = !!dependencies.postToolReviewState.qaEvidence.personalCognition;
          dependencies.postToolReviewState.llmCallsUsed += gate.coordination.totals.llmCalls;
          dependencies.postToolReviewState.coordinationRuns.push(gate.coordination);
        } catch (error) {
          throwIfAgentAborted(context.signal);
          console.warn('[agent-final-answer-gate] gate failed; applying deterministic citation cleanup:', error);
          reply = applyQaEvidenceFallback(reply, dependencies.postToolReviewState.qaEvidence);
        }
      }

      context.onActivity?.({ phase: 'finalizing' });
      if (
        dependencies.mode === 'complete'
        && state.activeSkill?.id === 'personalized-qa'
        && !isAgentSelfMetaQuestion(state.userText)
        && !dependencies.postToolReviewState.qaEvidence
      ) {
        reply = applyQaEvidenceFallback(reply, {
          review: {
            coverage: 'insufficient',
            supportedCitationIds: [],
            risks: ['本地证据检索或审核未完成。'],
            answerGuidance: ['明确区分本地证据与通用解释。'],
          },
          sources: [],
        });
      }

      if (dependencies.postToolReviewState.qaEvidence?.personalCognition) {
        if (!cognitionChecked) reply = renderCognitionAlignment({ accepted: false, code: 'review_unavailable' }, dependencies.postToolReviewState.qaEvidence);
        reply = applyQaEvidenceFallback(reply, dependencies.postToolReviewState.qaEvidence);
      }
      reply = discloseCognitionComparison(reply, dependencies.postToolReviewState.qaEvidence);
      return {
        status: 'completed',
        draftReply: dependencies.draftAnswer,
        finalReply: reply,
        finalCitations: buildQaAnswerCitations(reply, dependencies.postToolReviewState.qaEvidence),
        postToolCoordinationRuns: [...dependencies.postToolReviewState.coordinationRuns],
      };
    },
  }, context);
}
