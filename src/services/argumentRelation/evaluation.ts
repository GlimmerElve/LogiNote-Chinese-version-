import {
  ARGUMENT_RELATION_LABELS,
  isArgumentativeLabel,
  isArgumentRelationLabel,
  type ArgumentRelationCase,
  type ArgumentRelationLabel,
  type ArgumentRelationPrediction,
} from './contract.ts';

const ratio = (a: number, b: number): number | null => b ? a / b : null;
const harmonic = (precision: number | null, recall: number | null): number =>
  precision && recall ? 2 * precision * recall / (precision + recall) : 0;

export function validateArgumentRelationCases(cases: ArgumentRelationCase[]): void {
  if (!Array.isArray(cases) || !cases.length) throw new Error('Empty argument relation dataset');
  const ids = new Set<string>();
  for (const item of cases) {
    if (!item.id || ids.has(item.id)) throw new Error('Missing/duplicate case id');
    ids.add(item.id);
    if (!item.groupId || !item.phenomenon || !item.annotationReason
      || !['synthetic', 'local_review'].includes(item.origin)
      || !['assistant_draft', 'human_reviewed'].includes(item.annotationStatus)
      || !isArgumentRelationLabel(item.expectedLabel)) throw new Error(`Invalid annotation: ${item.id}`);
    const sentences = new Set<string>();
    for (const sentence of item.sentences) {
      if (!sentence.id || !sentence.text.trim() || sentences.has(sentence.id)) throw new Error(`Invalid sentence: ${item.id}`);
      sentences.add(sentence.id);
    }
    for (const endpoint of [item.sourceSentenceIds, item.targetSentenceIds]) {
      if (!endpoint.length || new Set(endpoint).size !== endpoint.length || endpoint.some((id) => !sentences.has(id))) {
        throw new Error(`Invalid endpoint: ${item.id}`);
      }
    }
    if (item.sourceSentenceIds.some((id) => item.targetSentenceIds.includes(id))) throw new Error(`Overlapping endpoints: ${item.id}`);
  }
}

/** Fail on malformed output rather than silently turning parse failures into correct abstentions. */
export function parseArgumentRelationPredictions(raw: unknown): ArgumentRelationPrediction[] {
  if (!Array.isArray(raw)) throw new Error('predictions must be an array');
  const ids = new Set<string>();
  return raw.map((value) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid prediction');
    const item = value as Record<string, unknown>;
    if (typeof item.id !== 'string' || !item.id.trim() || ids.has(item.id)) throw new Error('Missing/duplicate prediction id');
    ids.add(item.id);
    if (!isArgumentRelationLabel(item.label)) throw new Error(`Invalid label: ${item.id}`);
    if (!Array.isArray(item.evidenceSentenceIds)
      || item.evidenceSentenceIds.some((id) => typeof id !== 'string' || !id.trim())
      || new Set(item.evidenceSentenceIds).size !== item.evidenceSentenceIds.length) throw new Error(`Invalid evidence: ${item.id}`);
    if (typeof item.explanation !== 'string' || !item.explanation.trim()) throw new Error(`Missing explanation: ${item.id}`);
    return { id: item.id, label: item.label, evidenceSentenceIds: [...item.evidenceSentenceIds], explanation: item.explanation };
  });
}

export function evaluateArgumentRelations(cases: ArgumentRelationCase[], rawPredictions: unknown) {
  validateArgumentRelationCases(cases);
  const predictions = parseArgumentRelationPredictions(rawPredictions);
  const caseIds = new Set(cases.map((item) => item.id));
  if (predictions.some((item) => !caseIds.has(item.id))) throw new Error('Prediction outside frozen dataset');
  const byId = new Map(predictions.map((item) => [item.id, item]));
  const rows = cases.map((item) => {
    const prediction = byId.get(item.id);
    const knownIds = new Set(item.sentences.map((sentence) => sentence.id));
    const evidenceIds = new Set(prediction?.evidenceSentenceIds || []);
    const predictedEdge = !!prediction && isArgumentativeLabel(prediction.label);
    const evidenceValid = !!prediction && [...evidenceIds].every((id) => knownIds.has(id))
      && (!predictedEdge || [...item.sourceSentenceIds, ...item.targetSentenceIds].every((id) => evidenceIds.has(id)));
    return {
      id: item.id, origin: item.origin, phenomenon: item.phenomenon,
      expected: item.expectedLabel, predicted: prediction?.label ?? 'missing' as const,
      correct: prediction?.label === item.expectedLabel,
      expectedEdge: isArgumentativeLabel(item.expectedLabel), predictedEdge,
      evidenceValid,
      // Shape coverage is NOT semantic entailment verification or a production admission decision.
      contractEligibleEdge: predictedEdge && evidenceValid,
    };
  });
  const byLabel = Object.fromEntries(ARGUMENT_RELATION_LABELS.map((label) => {
    const gold = rows.filter((row) => row.expected === label).length;
    const predicted = rows.filter((row) => row.predicted === label).length;
    const tp = rows.filter((row) => row.expected === label && row.correct).length;
    const precision = ratio(tp, predicted);
    const recall = ratio(tp, gold);
    return [label, { gold, predicted, truePositive: tp, precision, recall, f1: harmonic(precision, recall) }];
  })) as Record<ArgumentRelationLabel, { gold: number; predicted: number; truePositive: number; precision: number | null; recall: number | null; f1: number }>;
  const predictedEdges = rows.filter((row) => row.predictedEdge);
  const expectedEdges = rows.filter((row) => row.expectedEdge);
  const eligibleEdges = rows.filter((row) => row.contractEligibleEdge);
  const correctEdges = predictedEdges.filter((row) => row.correct);
  const exactPrecision = ratio(correctEdges.length, predictedEdges.length);
  const exactRecall = ratio(correctEdges.length, expectedEdges.length);
  const presentLabels = ARGUMENT_RELATION_LABELS.filter((label) => byLabel[label].gold || byLabel[label].predicted);
  const group = (key: 'origin' | 'phenomenon') => Object.fromEntries([...new Set(rows.map((row) => row[key]))].map((value) => {
    const subset = rows.filter((row) => row[key] === value);
    return [value, { cases: subset.length, accuracy: ratio(subset.filter((row) => row.correct).length, subset.length),
      falseEdges: subset.filter((row) => row.predictedEdge && !row.expectedEdge).length }];
  }));
  return {
    cases: cases.length,
    answered: predictions.length,
    coverage: predictions.length / cases.length,
    accuracy: rows.filter((row) => row.correct).length / cases.length,
    macroF1: presentLabels.reduce((sum, label) => sum + byLabel[label].f1, 0) / presentLabels.length,
    edge: {
      expected: expectedEdges.length, predicted: predictedEdges.length, correct: correctEdges.length,
      precision: exactPrecision, recall: exactRecall, f1: harmonic(exactPrecision, exactRecall),
      falseEdgeCount: rows.filter((row) => row.predictedEdge && !row.expectedEdge).length,
      falseEdgeRate: ratio(rows.filter((row) => row.predictedEdge && !row.expectedEdge).length, rows.filter((row) => !row.expectedEdge).length),
      polarityErrors: rows.filter((row) => row.expectedEdge && row.predictedEdge && !row.correct).length,
      missedEdges: rows.filter((row) => row.expectedEdge && !row.predictedEdge).length,
      invalidEvidenceCount: predictedEdges.filter((row) => !row.evidenceValid).length,
      contractEligible: eligibleEdges.length,
      contractEligiblePrecision: ratio(eligibleEdges.filter((row) => row.correct).length, eligibleEdges.length),
      contractEligibleRecall: ratio(eligibleEdges.filter((row) => row.correct).length, expectedEdges.length),
    },
    insufficientEvidence: byLabel.insufficient_evidence,
    byLabel, byOrigin: group('origin'), byPhenomenon: group('phenomenon'),
    confusion: Object.fromEntries(ARGUMENT_RELATION_LABELS.map((label) => [label,
      Object.fromEntries([...ARGUMENT_RELATION_LABELS, 'missing'].map((predicted) => [predicted,
        rows.filter((row) => row.expected === label && row.predicted === predicted).length])),
    ])),
    failures: rows.filter((row) => !row.correct || !row.evidenceValid),
    limitations: [
      'Pair classification on supplied endpoints, not end-to-end unit extraction or candidate recall.',
      'Evidence ID coverage validates structure only, not entailment or factual truth.',
      'Assistant draft labels and synthetic cases are development checks, not independent human acceptance.',
      'Selected local findings are a failure-focused subset, not overall corpus accuracy.',
      'No deployment gate is passed by this report; missing predictions count as errors, not abstentions.',
    ],
  };
}
