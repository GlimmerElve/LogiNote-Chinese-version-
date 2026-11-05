/** Human-authored mock replies exercising the real V2 parser, scoring and UI adapter. */
import { createFlowShadowFixture } from '../../src/services/flowShadow/demo';
import { buildShadowReferencePacket } from '../../src/services/flowShadow/references';
import { replayShadowResponses } from '../../src/services/flowShadow/runner';
import { shadowFingerprint } from '../../src/services/flowShadow/protocol';
import { adaptShadowRecordToFlowV2 } from '../../src/services/flowAnalysis/productionV2';
import { scoreConceptEvidence, scoreJudgmentEvidence, scoreReasoningEvidence, computeLayeredMastery } from '../../src/services/profile/scoring/threeLayer';
import type { ConceptEvidence, JudgmentEvidence, ReasoningEvidence, KnowledgePointMasteryResult } from '../../src/types';

export function createFlowResultPreview() {
  const fixture = createFlowShadowFixture();
  const sentences = [
    '心理账户是人们在心理上把不同来源或用途的钱分开评价，不一定把所有收支放在一起计算。',
    '按照理性消费的预期，如果两个情景的总支出和绝对节省相同，选择比例应该一致。',
    '材料用两个火车票情景，让被试在花钱节省时间和花时间节省金钱之间选择。',
    '第一个情景中，选择花钱节省时间的比例为33%。',
    '第二个情景中，选择花钱节省时间的比例为76%。',
    '所以在这两个情景里，实际选择比例不一致，与刚才的理性预期不同。',
    '我认为这证明了所有人任何时候都会按局部账户的相对节省来决策。',
    '不过如果换一类任务，时间的重要程度可能影响选择，还需要再检验。',
  ];
  const input = { ...fixture.input, attemptId: 'preview-mental-account-20261015',
    observedAt: '2026-10-15T09:20:00.000Z', rawText: sentences.join('\n'),
    task: { ...fixture.input.task, id: 'preview-project', family: 'free_review' as const,
      goal: '复述心理账户的含义、情景结果与解释，并说明结论的适用范围。', promptedBehaviors: [] } };
  const graph = structuredClone(fixture.graph);
  graph.nodes = sentences.map((text, index) => ({ id: `N${index + 1}`, role: graph.nodes[index].role, text, rawQuote: text }));
  graph.nodes[7].role = 'claim';
  graph.arguments = [
    { id: 'A1', claim: 'N2', support: [], oppose: ['N6'], status: 'stated_only' },
    { id: 'A2', claim: 'N6', support: ['N4', 'N5'], oppose: [], status: 'argued' },
    { id: 'A3', claim: 'N7', support: ['N6'], oppose: [], status: 'incomplete' },
    { id: 'A4', claim: 'N8', support: [], oppose: [], status: 'stated_only' },
  ];
  graph.relations = [
    { id: 'R1', kind: 'context', from: 'N1', to: 'N7', reason: '心理账户定义为局部账户解释提供概念背景。' },
    { id: 'R2', kind: 'method_for', from: 'N3', to: 'N4', reason: '第一个情景问卷产生第一组选择比例。' },
    { id: 'R3', kind: 'method_for', from: 'N3', to: 'N5', reason: '第二个情景问卷产生第二组选择比例。' },
    { id: 'R4', kind: 'relates', from: 'N8', to: 'N7', reason: '补充局部账户解释需要进一步检验的适用情境。' },
  ];
  const referenceCandidates = fixture.referenceCandidates.map((item, index) => ({ ...item,
    sourceId: 'preview-textbook', title: '心理账户 · 模拟教材', locator: `第${index + 1}节 · 模拟参考片段`,
    text: [
      '心理账户是个体对经济活动进行心理编码、分类和评价的方式，可按不同用途建立局部账户。',
      '理性消费预期：绝对成本和效益一致时，情景变化不应改变选择比例。',
      '两种情景的选择比例不同，表明此次任务中的选择受到情景设置影响。',
      '局部账户是对这些选择差异的一种解释，结论需要限定在给定任务与条件下。',
      '比较理性预期与实际结果，应区分理论预测与观察结果。',
      '33%与76%的比例差异可用于说明这两个情景中的选择并不一致。',
      '两个情景的差异不足以推出所有人、所有情境下均采用同一决策方式。',
    ][index],
  }));
  const packet = buildShadowReferencePacket(input, graph, referenceCandidates);
  const assessment = structuredClone(fixture.assessment);
  assessment.clarity = { score: 82, comment: '模拟评价：定义、情景与结论的承接清楚，末尾适用范围的表述仍可更明确。', evidenceIds: ['E1', 'E6', 'E7'] };
  assessment.evidence = sentences.map((quote, index) => ({ id: `E${index + 1}`, quote, nodeIds: [`N${index + 1}`], attribution: 'user' }));
  const levels = [4, 3, 3, 3, 3, 2, 3, 2, 3];
  const reasons = [
    '说明心理账户的分类评价特点，并区分整体计算。',
    '概念在定义和解释中基本一致，局部账户的具体边界尚可补充。',
    '将心理账户用于解释两个情景，尚未展示对新情境的完整应用。',
    '能区分理性预期与实际选择差异。',
    '33%和76%明确归属于材料中的两种情景。',
    '“所有人任何时候”超出两个情景的证据范围，末句只部分收回了确定性。',
    '两组比例与“选择不一致”的判断直接相关。',
    '现有依据足以说明此次差异，不足以支持普遍决策规律。',
    '预期与观察区分清楚，但普遍化结论与后续保留条件存在张力。',
  ];
  assessment.criteria.forEach((criterion, index) => {
    criterion.level = levels[index]; criterion.reason = reasons[index];
    criterion.opportunityKeys = [index < 3 ? '心理账户定义及情景应用' : index < 6 ? '理性预期与实际结果的归属和范围' : '比例差异到普遍解释的推导'];
  });
  assessment.referenceComparisons = packet.targets.map((target, index) => {
    const referenceIds = packet.selection.find(item => item.targetId === target.id)?.itemIds || [];
    return {
      id: `RC${index + 1}`, targetId: target.id, layer: target.layer,
      state: !referenceIds.length ? 'insufficient_reference' : target.nodeIds.includes('N7') ? 'partially_aligned' : 'aligned',
      level: !referenceIds.length ? null : target.nodeIds.includes('N7') ? 2 : 4,
      userEvidenceIds: target.nodeIds.map(id => `E${id.slice(1)}`), referenceIds,
      reason: !referenceIds.length ? '本次模拟参考包没有覆盖时间重要程度的判断，暂不评价其资料一致性。'
        : target.nodeIds.includes('N7') ? '承认局部账户解释与教材一致，但“所有人任何时候”的范围超出教材限定。'
          : '复述与模拟教材的核心含义一致，无需逐字相同。',
    };
  });
  assessment.behaviors = [
    { code: 'concept_framing', state: 'observed', evidenceIds: ['E1'], reason: '先解释心理账户，再进入情景与结论。' },
    { code: 'evidence_description', state: 'observed', evidenceIds: ['E4', 'E5'], reason: '列出两组选择比例作为观察依据。' },
    { code: 'comparison_review', state: 'observed', evidenceIds: ['E2', 'E6'], reason: '将理性预期与实际观察对比。' },
    { code: 'mechanism_explanation', state: 'observed', evidenceIds: ['E7'], reason: '尝试用局部账户解释选择差异，适用范围有待收窄。' },
    { code: 'abstract_concrete', state: 'observed', direction: 1, evidenceIds: ['E1', 'E7'], reason: '从具体比例上升到概念解释，本次偏抽象。' },
    { code: 'structured_connections', state: 'observed', direction: 1, evidenceIds: ['E2', 'E4', 'E5', 'E6'], reason: '按预期、观察、比较组织表达，本次偏系统。' },
    { code: 'uncertainty_calibration', state: 'observed', direction: 0, evidenceIds: ['E7', 'E8'], reason: '普遍化表达与保留条件同时出现，方向暂记均衡。' },
  ];
  assessment.issues = [{ id: 'I1', kind: 'argument_gap', targetIds: ['N7', 'A3'], evidenceIds: ['E7'], severity: 'medium',
    reason: '从两个情景的比例差异推出“所有人任何时候”的结论，缺少跨人群、跨任务的依据。' }];
  assessment.summary = '你能解释心理账户，区分理性预期与实际观察，并用两组比例支持“选择不同”。主要待完善点是结论的适用范围：两个情景的结果尚不足以说明所有人、所有情境。';
  assessment.recommendation = '把“所有人任何时候”改为“在这两个情景及相应条件下”，再说明局部账户如何影响相对节省的评价。';
  const extractResponse = { protocol: fixture.extractResponse.protocol, inputKey: shadowFingerprint(input), graph };
  const assessResponse = { protocol: fixture.extractResponse.protocol, inputKey: shadowFingerprint(input),
    graphKey: shadowFingerprint(graph), referenceKey: shadowFingerprint(packet), assessment };
  const record = replayShadowResponses(input, extractResponse, assessResponse, packet);
  const masteryResponses: Array<{ name: string; conceptEvidence: ConceptEvidence; judgmentEvidence: JudgmentEvidence;
    reasoningEvidence: ReasoningEvidence; comment: string }> = [
    { name: '心理账户', conceptEvidence: { redefinesInOwnWords: true },
      judgmentEvidence: { considersConditions: true, absolutistCount: 1, judgmentErrors: ['将两个情景推广至所有人、所有情境。'] },
      reasoningEvidence: { providesPremises: true, fallacyTypes: ['过度概括'] }, comment: '概念较清楚，结论范围过宽，需补充边界。' },
    { name: '理性消费预期', conceptEvidence: { distinguishesSimilarConcepts: true },
      judgmentEvidence: { considersConditions: true, distinguishesFactOpinion: true },
      reasoningEvidence: { providesPremises: true, completeChain: true }, comment: '能区分预期与实际结果，并用比例比较。' },
  ];
  const masteryResults: KnowledgePointMasteryResult[] = masteryResponses.map(response => {
    const conceptDelta = scoreConceptEvidence(response.conceptEvidence);
    const judgmentDelta = scoreJudgmentEvidence(response.judgmentEvidence);
    const reasoningDelta = scoreReasoningEvidence(response.reasoningEvidence);
    const layered = computeLayeredMastery(conceptDelta, judgmentDelta, reasoningDelta, 50);
    return { name: response.name, existingNoteTitle: response.name, level: layered.level,
      conceptDelta: conceptDelta ?? 0, judgmentDelta: judgmentDelta ?? 0, reasoningDelta: reasoningDelta ?? 0,
      conceptFinal: layered.conceptFinal, judgmentFinal: layered.judgmentFinal, reasoningFinal: layered.reasoningFinal, comment: response.comment };
  });
  const bundle = adaptShadowRecordToFlowV2(record, '心理账户与决策权衡', masteryResults);
  return { input, extractResponse, assessResponse, masteryResponses, masteryResults, record, bundle };
}
