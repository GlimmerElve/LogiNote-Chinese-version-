import { FLOW_SHADOW_PROTOCOL, COGNITIVE_EVIDENCE_CONTRACT } from '../../src/services/flowShadow/types';
import { SHADOW_CRITERIA } from '../../src/services/flowShadow/rubric';
import { MASTERY_SHADOW_CRITERIA } from '../../src/services/masteryShadow/rubric';
import { masteryBaselineFixture } from './mastery-baselines';
/** Explicit deterministic substitutes; these prove contracts and state, never model quality. */
export function progressiveReviewModelReply(input: any) {
    if (!input.graph) {
        return { protocol: FLOW_SHADOW_PROTOCOL, inputKey: input.inputKey, graph: { nodes: [{ id: 'N1', role: 'background', text: input.rawText.slice(0, 100), rawQuote: input.rawText.slice(0, 100) }], arguments: [], relations: [], unresolved: [] } };
    }
    return { protocol: FLOW_SHADOW_PROTOCOL, inputKey: input.inputKey, graphKey: input.graphKey, referenceKey: input.referenceKey, assessment: {
            evidence: [{ id: 'E1', quote: input.rawText.slice(0, 100), nodeIds: ['N1'], attribution: 'user' }],
            criteria: SHADOW_CRITERIA.map(c => ({ id: c.id, state: 'uncertain', level: null, evidenceIds: [], opportunityKeys: [], reason: '合成测试不提供能力结论。' })),
            referenceComparisons: (input.referencePacket.targets || []).map((t: any, i: number) => ({ id: 'RC' + i, targetId: t.id, layer: t.layer, state: 'insufficient_reference', level: null, userEvidenceIds: [], referenceIds: [], reason: '合成测试不进行语义认证。' })),
            behaviors: [], behaviorContract: COGNITIVE_EVIDENCE_CONTRACT, calculationReviews: [], issues: [], summary: '合成复盘已完成主分析，各层证据不足时保留未知。', recommendation: '结合教学材料继续检查概念条件。'
        } };
}
export function progressiveMasteryModelReply(input: any) {
    const criteria = input.criteria || MASTERY_SHADOW_CRITERIA;
    return { protocol: 'mastery-shadow-evaluator-v1', evaluationId: input.evaluationId, knowledgePointId: input.knowledgePointId,
        evidence: [{ id: 'E1', quote: input.answer.slice(0, 160) }], baselines: masteryBaselineFixture({ ...input, criteria }), coverage: { concept: 'assessed', judgment: 'assessed', reasoning: 'assessed' },
        criteria: criteria.map((c: any) => ({ id: c.id, state: 'pass', evidenceIds: ['E1'], referenceIds: input.references.filter((r: any) => r.criterionIds?.includes(c.id)).map((r: any) => r.id), referenceQuotes: input.references.filter((r: any) => r.criterionIds?.includes(c.id)).slice(0, 3).map((r: any) => ({ referenceId: r.id, quote: r.quote.slice(0, 180) })), reason: '仅合成契约样例，参考和原话都可核对。' })), summary: '合成掌握度结果，不作为语义质量证明。' };
}
