/** Fixture-specific acceptance checks, NOT a general local semantic classifier or production scoring rule. */
import { SHADOW_CRITERIA } from '../src/services/flowShadow/rubric';
import { verifiedShadowUserEvidence } from '../src/services/flowShadow/scoring';
import type { ShadowAssessment, ShadowRecord } from '../src/services/flowShadow/types';

export function assessmentContractChecks(value: unknown) {
  const a = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const criteria = Array.isArray(a.criteria) ? a.criteria as Array<Record<string, unknown>> : [];
  const evidence = new Set(Array.isArray(a.evidence) ? a.evidence.map(e => e?.id) : []);
  return {
    nineDistinctCriteria: criteria.length === 9 && new Set(criteria.map(c => c.id)).size === 9
      && SHADOW_CRITERIA.every(c => criteria.some(v => v.id === c.id)),
    legalLevelsAndEvidence: criteria.length === 9 && criteria.every(c => {
      const missing = c.state === 'uncertain' || c.state === 'not_applicable';
      return ['observed', 'not_demonstrated', 'uncertain', 'not_applicable'].includes(String(c.state))
        && (missing ? c.level === null : typeof c.level === 'number' && Number.isInteger(c.level) && c.level >= 0 && c.level <= 4)
        && Array.isArray(c.evidenceIds) && (missing || c.evidenceIds.length > 0) && c.evidenceIds.every(id => evidence.has(id))
        && Array.isArray(c.opportunityKeys) && c.opportunityKeys.every(key => typeof key === 'string' && key.trim().length > 0)
        && (missing || c.opportunityKeys.length > 0);
    }),
    noModelTotalScore: !Object.keys(a).some(key => /^(?:total_?score|overall_?score|score)$/iu.test(key)),
  };
}

export function oralAcceptanceChecks(record: ShadowRecord) {
  const { graph, input, assessment } = record;
  const nodeById = new Map(graph.nodes.map(n => [n.id, n]));
  const quote = (id: string) => {
    const node = nodeById.get(id);
    return node?.rawQuote.trim() && input.rawText.includes(node.rawQuote) ? node.rawQuote : '';
  };
  const expected = graph.nodes.filter(n => n.role === 'claim' && n.rawQuote.includes('选择比例应该一致'));
  const arguments_ = graph.arguments.filter(a => expected.some(n => n.id === a.claim));
  const supportClosure = (ids: string[]) => {
    const seen = new Set<string>(), pending = [...ids];
    while (pending.length) {
      const id = pending.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      for (const a of graph.arguments) if (a.claim === id) pending.push(...a.support);
    }
    return [...seen];
  };
  const actualOpposesExpectation = arguments_.some(a => {
    const validOpposition = a.oppose.filter(id => ['claim', 'premise'].includes(nodeById.get(id)?.role || ''));
    const evidence = supportClosure(validOpposition).map(quote).join('\n');
    return validOpposition.some(id => quote(id).includes('实际选择比例不一致'))
      || evidence.includes('33%') && evidence.includes('76%');
  });
  const noSamePairRelates = arguments_.every(a => a.oppose.every(id => !graph.relations.some(r => r.kind === 'relates'
    && (r.from === id && r.to === a.claim || r.to === id && r.from === a.claim))));
  const valid = verifiedShadowUserEvidence(input, graph, assessment).evidence;
  const behavior = assessment.behaviors.find(b => b.code === 'uncertainty_calibration');
  const negative = (behavior?.polarity?.negative || []).map(id => valid.get(id)).filter(e => e !== undefined);
  const positive = (behavior?.polarity?.positive || []).map(id => valid.get(id)).filter(e => e !== undefined);
  const poles = [...negative, ...positive];
  const poleNodeIds = new Set(poles.flatMap(e => e.nodeIds));
  // The withdrawal may be its own meta-discourse node, rather than part of a pole quote.
  // Accept its exact user evidence only when linked to the same original/corrected object.
  // Never accept a model reason containing "收回" by itself or an unrelated correction elsewhere.
  const withdrawal = [...valid.values()].filter(e => e.quote.includes('这句话我收回'));
  const withdrawalCovered = withdrawal.some(e => e.nodeIds.some(id => poleNodeIds.has(id)
    || graph.relations.some(r => r.from === id && poleNodeIds.has(r.to) || r.to === id && poleNodeIds.has(r.from))));
  const polarity = behavior?.polarity;
  const linkedIds = new Set(behavior?.evidenceIds || []);
  const independentPoles = Boolean(polarity && polarity.negative.every(id => linkedIds.has(id) && !polarity.positive.includes(id))
    && polarity.positive.every(id => linkedIds.has(id)));
  return {
    actualOpposesExpectation,
    noSamePairRelates,
    selfCorrectionPreserved: graph.nodes.some(n => n.rawQuote.includes('这句话我收回') && n.text.includes('收回')),
    retractedClaimNotConfirmedError: !assessment.issues.some(i => i.kind === 'confirmed_internal' && i.reason.includes('所有人')),
    explicitRetractionRecognized: polarity?.resolution === 'resolved' && (behavior?.direction ?? 0) > 0 && independentPoles
      && negative.some(e => e.quote.includes('所有人任何时候'))
      && positive.some(e => e.quote.includes('不能这么往外推') || e.quote.includes('可能影响')) && withdrawalCovered,
    ...assessmentContractChecks(assessment),
  };
}

/** Fixed before the long-sample call; detects the deliberately wrong subtraction, not overall truth. */
export function oral1000AcceptanceChecks(record: ShadowRecord, rawAssessment: ShadowAssessment) {
  const valid = verifiedShadowUserEvidence(record.input, record.graph, record.assessment).evidence;
  return {
    ...oralAcceptanceChecks(record),
    ...assessmentContractChecks(rawAssessment),
    arithmeticErrorDetected: record.assessment.issues.some(issue => ['confirmed_internal', 'argument_gap'].includes(issue.kind)
      && /计算|相减|差值|百分点|算错|减法/u.test(issue.reason)
      && issue.evidenceIds.some(id => valid.get(id)?.quote.includes('差了33个百分点'))),
    sourceComparisonsComplete: record.references.targets.every(target => record.assessment.referenceComparisons
      .filter(comparison => comparison.targetId === target.id).length === 1),
  };
}

/** Thresholds fixed before the low-quality call; no output-dependent lowering. */
export const LOW_QUALITY_ACCEPTANCE_THRESHOLDS = Object.freeze({ maximumMean: 60, baselineScores: { concept: 100, judgment: 100, reasoning: 91.7 } });
export function lowQualityAcceptanceChecks(record: ShadowRecord, rawAssessment: ShadowAssessment) {
  const score = (layer: string) => record.scoring.layers.find(l => l.layer === layer)?.score ?? null;
  const scores = ['concept', 'judgment', 'reasoning'].map(score);
  const mean = scores.every(s => s !== null) ? (scores as number[]).reduce((a, b) => a + b, 0) / 3 : null;
  return {
    ...assessmentContractChecks(rawAssessment),
    allLayersBelowHighQualityBaseline: Object.entries(LOW_QUALITY_ACCEPTANCE_THRESHOLDS.baselineScores)
      .every(([layer, baseline]) => score(layer) !== null && score(layer)! < baseline),
    meanAtMost60: mean !== null && mean <= LOW_QUALITY_ACCEPTANCE_THRESHOLDS.maximumMean,
    notAllPerfect: scores.every(s => s !== null) && !scores.every(s => s === 100),
    incorrectReferenceAlignmentDetected: record.assessment.referenceComparisons.some(c => c.state === 'misaligned' && c.referenceIds.length > 0),
    userProblemDetected: record.assessment.issues.some(i => ['argument_gap', 'confirmed_internal'].includes(i.kind) && i.evidenceIds.length > 0),
  };
}
