/** Human-authored synthetic fixture, NOT a model response or an accuracy test. */
import { FLOW_SHADOW_PROTOCOL, type ShadowAssessment, type ShadowGraph, type ShadowInput } from './types.ts';
import { normalizeShadowInput, shadowFingerprint } from './protocol.ts';
import { replayShadowResponses } from './runner.ts';
import { SHADOW_CRITERIA } from './rubric.ts';
import { buildShadowReferencePacket } from './references.ts';
import type { ShadowReferenceCandidate } from './types.ts';

export function createFlowShadowFixture() {
  const sentences = [
    '蓝印指包裹上的蓝色印记，不是运输路线。',
    '本次演练规定：包裹有蓝印且系统联网时，进入二号通道。',
    '检验办法是读取印记并核对联网状态。',
    '检查发现这个包裹有蓝印。',
    '状态页显示系统已联网。',
    '因此这个包裹会进入二号通道。',
    '如果系统离线，仅凭蓝印不能推出它进入二号通道。',
    '我先核对这两个条件，再决定通道。',
  ];
  const input: ShadowInput = normalizeShadowInput({ attemptId: 'synthetic-parcel-1', assessmentRevision: 1,
    observedAt: '2026-10-15T12:00:00+08:00', rawText: sentences.join('\n'), assistance: 'none',
    task: { id: 'synthetic-parcel-task', goal: '只根据演练规定说明该包裹的通道判断，解释所用概念和条件，不使用其他分拣规则。',
      family: 'derivation', requiredLayers: ['concept', 'judgment', 'reasoning'], promptedBehaviors: ['mechanism_explanation'] } });
  const roles = ['background', 'claim', 'method', 'premise', 'premise', 'claim', 'claim', 'method'] as const;
  const graph: ShadowGraph = {
    nodes: sentences.map((text, i) => ({ id: `N${i + 1}`, role: roles[i], text, rawQuote: text })),
    arguments: [
      { id: 'A1', claim: 'N2', support: [], oppose: [], status: 'stated_only' },
      { id: 'A2', claim: 'N6', support: ['N2', 'N4', 'N5'], oppose: [], status: 'argued' },
      { id: 'A3', claim: 'N7', support: [], oppose: [], status: 'stated_only' },
    ],
    relations: [
      { id: 'R1', kind: 'context', from: 'N1', to: 'N4', reason: '定义检查结果中的蓝印对象。' },
      { id: 'R2', kind: 'method_for', from: 'N3', to: 'N4', reason: '读取印记得到检查结果。' },
      { id: 'R3', kind: 'method_for', from: 'N3', to: 'N5', reason: '核对状态得到联网观察。' },
      { id: 'R4', kind: 'relates', from: 'N8', to: 'N3', reason: '复述同一检验程序的实施顺序。' },
    ], unresolved: [],
  };
  const evidence = sentences.map((quote, i) => ({ id: `E${i + 1}`, quote, nodeIds: [`N${i + 1}`], attribution: 'user' as const }));
  const references: Record<string, string[]> = {
    concept_clarity: ['E1', 'E4'], concept_consistency: ['E1', 'E2'], concept_application: ['E1', 'E4'],
    judgment_clarity: ['E2', 'E6'], judgment_attribution: ['E2', 'E4', 'E5'], judgment_calibration: ['E2', 'E7'],
    reasoning_relevance: ['E2', 'E4', 'E5', 'E6'], reasoning_sufficiency: ['E2', 'E4', 'E5', 'E6'], reasoning_consistency: ['E2', 'E6', 'E7'],
  };
  const referenceCandidates: ShadowReferenceCandidate[] = [
    ['REF-C1', 'T-C-N1', '蓝印术语', '蓝印指包裹上的蓝色印记，不指运输路线。', 'definition'],
    ['REF-J2', 'T-J-N2', '二号通道规则', '包裹同时具有蓝印且系统联网时，进入二号通道。', 'condition'],
    ['REF-J6', 'T-J-N6', '二号通道规则', '同时满足蓝印和联网两个条件，可判定进入二号通道。', 'claim'],
    ['REF-J7', 'T-J-N7', '二号通道规则', '系统离线时，不满足进入二号通道的联合条件。', 'boundary'],
    ['REF-R1', 'T-R-A1', '二号通道规则', '包裹同时具有蓝印且系统联网时，进入二号通道。', 'claim'],
    ['REF-R2', 'T-R-A2', '二号通道规则', '蓝印与联网是联合条件；检查两项后才能判定通道。', 'premise'],
    ['REF-R3', 'T-R-A3', '二号通道规则', '系统离线时，仅凭蓝印不能推出进入二号通道。', 'counterexample'],
  ].map(([id, targetId, title, text, relation]) => ({ id, targetId, tier: 1, sourceType: 'project_textbook',
    sourceId: 'synthetic-project-body', title, locator: '合成教材正文', relation, availability: 'available', text, similarity: 1 })) as ShadowReferenceCandidate[];
  const referencePacket = buildShadowReferencePacket(input, graph, referenceCandidates);
  const userByTarget: Record<string, string[]> = { 'T-C-N1': ['E1'], 'T-J-N2': ['E2'], 'T-J-N6': ['E6'], 'T-J-N7': ['E7'],
    'T-R-A1': ['E2'], 'T-R-A2': ['E2', 'E4', 'E5', 'E6'], 'T-R-A3': ['E7'] };
  const assessment: ShadowAssessment = { evidence,
    criteria: SHADOW_CRITERIA.map(c => ({ id: c.id, state: 'observed', level: 3,
      evidenceIds: references[c.id], opportunityKeys: [c.layer === 'concept' ? '蓝印的含义和使用' : c.layer === 'judgment' ? '本次通道判断' : '蓝印与联网联合推出通道'],
      reason: '人工编写的合成固定判定，仅用于验证数据流与评分规则，不代表模型准确性。' })),
    referenceComparisons: referencePacket.targets.map((target, index) => ({ id: `RC${index + 1}`, targetId: target.id, layer: target.layer,
      state: 'aligned', level: 4, userEvidenceIds: userByTarget[target.id] || [],
      referenceIds: referencePacket.selection.find(item => item.targetId === target.id)?.itemIds.slice(0, 1) || [],
      reason: '人工合成的用户表达与同一合成教材规则一致；只验证资料绑定和本地计分。' })),
    behaviors: [
      { code: 'concept_framing', state: 'observed', evidenceIds: ['E1'], reason: '解释蓝印并区分运输路线。' },
      { code: 'evidence_description', state: 'observed', evidenceIds: ['E4', 'E5'], reason: '分别陈述印记和联网观察。' },
      { code: 'mechanism_explanation', state: 'observed', evidenceIds: ['E2', 'E6'], reason: '任务要求的推导，不当作自发偏好。' },
      { code: 'uncertainty_calibration', state: 'observed', direction: 1, evidenceIds: ['E7'], reason: '指出离线时仅凭印记不能推出结论。' },
    ], issues: [], summary: '合成演示：说明概念、两个条件和结论；三层试行分由本地固定判据折算。',
    recommendation: '这是人工固定样例，请用真实复盘的独立模型响应检验语义、稳定性和成本。' };
  const extractResponse = { protocol: FLOW_SHADOW_PROTOCOL, inputKey: shadowFingerprint(input), graph };
  const assessResponse = { protocol: FLOW_SHADOW_PROTOCOL, inputKey: shadowFingerprint(input), graphKey: shadowFingerprint(graph),
    referenceKey: shadowFingerprint(referencePacket), assessment };
  return { input, graph, referenceCandidates, referencePacket, assessment, extractResponse, assessResponse };
}
export function createFlowShadowDemo() {
  const fixture = createFlowShadowFixture();
  return replayShadowResponses(fixture.input, fixture.extractResponse, fixture.assessResponse, fixture.referencePacket);
}
