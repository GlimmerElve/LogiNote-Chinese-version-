import type { ReviewCriterionId } from '../src/services/reviewAssessment.ts';
import type { FrozenReferenceItemObservation, FrozenReferenceShadowResult } from '../src/services/reviewComparison/frozenReferenceShadow.ts';
import { DISCLOSURE_FIXTURE_REASONING, PROGRESSIVE_FIXTURE_CONDITION, PROGRESSIVE_FIXTURE_DEFINITION } from './reference-disclosure-fixture.ts';

/** Pre-registered assistant annotations, NOT human gold or outside-world factual truth.
 * Pure data and predicates only: importing this file cannot request a model, read a
 * vault, grade mastery, change cognition, or loosen the production evaluator. */
export const REVIEW_PROGRESSIVE_DATASET_VERSION = 'review-progressive-synthetic-v1' as const;
export type ReviewProgressiveTask = 'definition' | 'condition' | 'reasoning';
export type ReviewProgressiveCategory = 'paraphrase' | 'missing_condition' | 'direct_opposition' | 'reverse_inference' | 'strong_hint';
export interface ReviewProgressiveExpectedItem {
  itemId: string; criterionId: ReviewCriterionId;
  verdicts: readonly FrozenReferenceItemObservation['verdict'][];
  direction?: FrozenReferenceItemObservation['direction'];
  premises?: FrozenReferenceItemObservation['premises'];
  rationale: string;
}
export interface ReviewProgressiveExpected {
  status: 'reviewed'; evidence: FrozenReferenceShadowResult['evidence'];
  frames: readonly { frameId: 'target-1'; status: FrozenReferenceShadowResult['frames'][number]['status']; items: readonly ReviewProgressiveExpectedItem[] }[];
  noFalseCovered: boolean; rationale: string;
}
export interface ReviewProgressiveCase {
  id: string; task: ReviewProgressiveTask; category: ReviewProgressiveCategory;
  annotationStatus: 'assistant_draft'; origin: 'synthetic';
  fixture: { task: ReviewProgressiveTask; theme: 'progressive-device-v1' | 'progressive-parcel-v1'; noteCount: 1 };
  question: string; answer: string; hintLevel: 0 | 4; consultedMaterialIds: readonly string[];
  /** Visible synthetic hint provenance; only hintLevel is an evaluator field. */
  hint?: string;
  expected: ReviewProgressiveExpected;
}

export const REVIEW_PROGRESSIVE_REFERENCES = {
  definition: {
    fixture: { task: 'definition', theme: 'progressive-device-v1', noteCount: 1 },
    sourceParagraphs: PROGRESSIVE_FIXTURE_DEFINITION,
    selectedItems: [{ itemId: 'I1', criterionId: 'concept_meaning', paragraphIndex: 0, nodeIds: ['N1'], relationIds: [] },
      { itemId: 'I2', criterionId: 'concept_boundary', paragraphIndex: 1, nodeIds: ['N2'], relationIds: ['E1'] }],
    structure: { nodes: [{ id: 'N1', role: 'definition', paragraphIndex: 0 }, { id: 'N2', role: 'condition', paragraphIndex: 1 }],
      relations: [{ id: 'E1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'requires_condition', paragraphIndex: 1 }], groups: [],
      scope: { task: 'definition', seedNodeId: 'N1', requiredNodeIds: ['N1', 'N2'], requiredRelationIds: ['E1'], requiredGroupIds: [] } },
  },
  condition: {
    fixture: { task: 'condition', theme: 'progressive-device-v1', noteCount: 1 },
    sourceParagraphs: PROGRESSIVE_FIXTURE_CONDITION,
    selectedItems: [{ itemId: 'I1', criterionId: 'condition_scope', paragraphIndex: 0, nodeIds: ['N1'], relationIds: [] },
      { itemId: 'I2', criterionId: 'condition_scope', paragraphIndex: 1, nodeIds: ['N2'], relationIds: ['E1'] }],
    // The AND is explicit in the N1 quote, not inferred from a title or two nodes.
    structure: { nodes: [{ id: 'N1', role: 'condition', paragraphIndex: 0 }, { id: 'N2', role: 'exception', paragraphIndex: 1 }],
      relations: [{ id: 'E1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'exception_of', paragraphIndex: 1 }], groups: [],
      scope: { task: 'condition', seedNodeId: 'N1', requiredNodeIds: ['N1', 'N2'], requiredRelationIds: ['E1'], requiredGroupIds: [] } },
  },
  reasoning: {
    fixture: { task: 'reasoning', theme: 'progressive-device-v1', noteCount: 1 },
    sourceParagraphs: DISCLOSURE_FIXTURE_REASONING,
    selectedItems: [{ itemId: 'I1', criterionId: 'actual_premise', paragraphIndex: 0, nodeIds: ['N1'], relationIds: [] },
      { itemId: 'I2', criterionId: 'actual_premise', paragraphIndex: 2, nodeIds: ['N3'], relationIds: ['E2'] },
      { itemId: 'I3', criterionId: 'inference_link', paragraphIndex: 1, nodeIds: ['N1', 'N2', 'N3'], relationIds: ['E1', 'E2'] }],
    structure: { nodes: [{ id: 'N1', role: 'fact', paragraphIndex: 0 }, { id: 'N2', role: 'conclusion', paragraphIndex: 1 }, { id: 'N3', role: 'condition', paragraphIndex: 2 }],
      relations: [{ id: 'E1', sourceNodeId: 'N1', targetNodeId: 'N2', kind: 'support', paragraphIndex: 1 },
        { id: 'E2', sourceNodeId: 'N3', targetNodeId: 'N2', kind: 'requires_condition', paragraphIndex: 2 }],
      groups: [{ id: 'G1', conclusionNodeId: 'N2', premiseNodeIds: ['N1'], conditionNodeIds: ['N3'], relationIds: ['E1', 'E2'], operator: 'all' }],
      scope: { task: 'reasoning', seedNodeId: 'N2', requiredNodeIds: ['N1', 'N2', 'N3'], requiredRelationIds: ['E1', 'E2'], requiredGroupIds: ['G1'] } },
  },
} as const;

const item = (itemId: string, criterionId: ReviewCriterionId, verdicts: ReviewProgressiveExpectedItem['verdicts'], rationale: string,
  structural: Pick<ReviewProgressiveExpectedItem, 'direction' | 'premises'> = {}): ReviewProgressiveExpectedItem => ({ itemId, criterionId, verdicts, rationale, ...structural });
const definitionItems = (meaning: ReviewProgressiveExpectedItem['verdicts'], boundary: ReviewProgressiveExpectedItem['verdicts']) => [
  item('I1', 'concept_meaning', meaning, '只核对实验约定的可执行训练指令状态；否定可以执行是同条件直接相反。'),
  item('I2', 'concept_boundary', boundary, '已供电与自检通过是明确AND条件；未谈条件可partial或unverifiable，但不能covered或contradicted。'),
];
const conditionItems = (scope: ReviewProgressiveExpectedItem['verdicts'], exception: ReviewProgressiveExpectedItem['verdicts']) => [
  item('I1', 'condition_scope', scope, '供电且正常模式两个限定同时满足；说了供电而漏正常模式是部分覆盖，不自动当错误事实。'),
  item('I2', 'condition_scope', exception, '维护模式下不按该规则报警；在同一维护条件下说会按该规则报警是明确相反。'),
];
const reasoningItems = (inference: ReviewProgressiveExpectedItem['verdicts'], condition: ReviewProgressiveExpectedItem['verdicts'],
  direction: FrozenReferenceItemObservation['direction'], premises: FrozenReferenceItemObservation['premises']) => [
  item('I1', 'actual_premise', ['supported'], '用户必须明确给出本次读数超阈值，不能只给一般规则。'),
  item('I2', 'actual_premise', condition, '已供电是本次推断的必要实际条件，原题已选择该条件。'),
  item('I3', 'inference_link', inference, '本题规则是超阈值→报警；逆命题未被资料排除，不必为假，却不足以完成本题正向推断。', { direction, premises }),
];
const question = {
  definition: '按本实验约定，什么是“青灯就绪”？这个状态需要哪些条件？',
  condition: '按本实验约定，阈值报警规则在哪些条件下适用？维护模式怎样处理？',
  reasoning: '按本实验约定，结合本次读数、供电条件和规则，说明为什么能推出本次设备会报警。',
} as const;
const expected = (status: ReviewProgressiveExpected['frames'][number]['status'], items: ReviewProgressiveExpectedItem[],
  evidence: ReviewProgressiveExpected['evidence'], rationale: string): ReviewProgressiveExpected => ({ status: 'reviewed', evidence,
  frames: [{ frameId: 'target-1', status, items }], noFalseCovered: status !== 'covered', rationale });
const sample = (id: string, task: ReviewProgressiveTask, category: ReviewProgressiveCategory, answer: string, expectation: ReviewProgressiveExpected,
  hint?: string): ReviewProgressiveCase => ({ id, task, category, annotationStatus: 'assistant_draft', origin: 'synthetic',
  fixture: { task, theme: 'progressive-device-v1', noteCount: 1 }, question: question[task], answer,
  hintLevel: hint ? 4 : 0, consultedMaterialIds: [], ...(hint ? { hint } : {}), expected: expectation });

/** 3 tasks × 4 samples: 6 covered positives (3 assisted), 3 omissions,
 * 2 genuine oppositions and 1 unsupported reverse. No rejection-heavy imbalance. */
export const REVIEW_PROGRESSIVE_DATASET: readonly ReviewProgressiveCase[] = [
  sample('D01', 'definition', 'paraphrase', '“青灯就绪”就是说设备能开始执行训练指令；它得先有电，而且自检要通过。',
    expected('covered', definitionItems(['supported'], ['supported']), 'independent', '同义表达保留核心含义和全部AND条件，不要求逐字背诵。')),
  sample('D02', 'definition', 'missing_condition', '“青灯就绪”就是设备可以开始执行训练指令的状态。',
    expected('partial', definitionItems(['supported'], ['partial', 'unverifiable']), 'independent', '定义核心正确但两个边界都未表达；缺失项可部分/未能核验，不允许判整题合格，也不判真矛盾。')),
  sample('D03', 'definition', 'direct_opposition', '设备已供电且自检通过时，“青灯就绪”表示设备不能开始执行训练指令；这种状态只在已供电且自检通过时成立。',
    expected('contradicted', definitionItems(['contradicted'], ['supported']), 'independent', '同实验对象、同供电与自检条件下，对可以执行作直接否定；不是条件或确定程度差异。')),
  sample('D04', 'definition', 'strong_hint', '按刚才的提示，“青灯就绪”指设备能开始执行训练指令，但要先接通电源并通过自检。',
    expected('covered', definitionItems(['supported'], ['supported']), 'assisted_not_independent', '回答覆盖参考，但答案来源于强提示，不作为独立掌握证据。'),
    '青灯就绪=可执行训练指令；前提是已供电且自检通过。请用自己的话重述。'),
  sample('C01', 'condition', 'paraphrase', '设备得有电并运行在正常模式，才按阈值规则报警；维护模式是例外，就算有电且读数高于阈值，也不按这条规则报警。',
    expected('covered', conditionItems(['supported'], ['supported']), 'independent', '复述AND条件及维护例外，未扩大为所有报警机制。')),
  sample('C02', 'condition', 'missing_condition', '我记得一个适用条件是设备已供电；维护模式时即便有电且读数超过阈值，也不按这条规则报警。',
    expected('partial', conditionItems(['partial'], ['supported']), 'independent', '说出供电却没有正常模式；没有声称所有模式都适用，因此是遗漏，不预设矛盾。')),
  sample('C03', 'condition', 'direct_opposition', '只有设备已供电且处于正常模式，阈值报警规则才适用；在维护模式下，即使设备已供电且读数超过阈值，也会按这条阈值报警规则报警。',
    expected('contradicted', conditionItems(['supported'], ['contradicted']), 'independent', '先正确复述适用条件，再在明确维护例外中主张相反结果；直接相反项须可见，不被held算通过。')),
  sample('C04', 'condition', 'strong_hint', '按提示，阈值规则要设备有电且在正常模式才能用；维护模式例外，哪怕有电又超阈值也不按这条规则报警。',
    expected('covered', conditionItems(['supported'], ['supported']), 'assisted_not_independent', '强提示可覆盖条件结构，但不能冒充无帮助独立回忆。'),
    '该规则需要已供电AND正常模式；维护模式不按该规则报警。请复述。'),
  sample('R01', 'reasoning', 'paraphrase', '本次设备已经通电，读数也确实超过阈值；按本实验超阈值触发报警的规则，所以本次设备会报警。',
    expected('covered', reasoningItems(['supported'], ['supported'], 'correct', 'complete'), 'independent', '给出实际前提、必要供电条件和前提→结论的明确连线。')),
  sample('R02', 'reasoning', 'missing_condition', '本次设备的读数确实超过了阈值；按照超阈值触发报警的规则，所以本次设备会报警。',
    expected('partial', reasoningItems(['partial'], ['partial', 'unverifiable'], 'correct', 'missing'), 'independent', '正向连接存在，但必要已供电条件未表达；I2可partial/unverifiable，I3不得supported。')),
  sample('R03', 'reasoning', 'reverse_inference', '本次设备已供电，读数也超过阈值；这条规则可以倒过来用：因为本次会报警，所以能推出本次读数超过阈值。',
    expected('partial', reasoningItems(['partial', 'unverifiable'], ['supported'], 'reverse', 'complete'), 'independent', '参考仅支持超阈值→报警；报警→超阈值不可据此推出，但未证明逆命题为假，因此不预标contradicted。')),
  sample('R04', 'reasoning', 'strong_hint', '按提示，本次设备有电而且读数高于阈值；既然规则说超阈值会触发报警，就能推出本次设备会报警。',
    expected('covered', reasoningItems(['supported'], ['supported'], 'correct', 'complete'), 'assisted_not_independent', '完整实际前提和正确方向仍属于强提示后表现，不是独立证据。'),
    '本次已供电AND超阈值；实验规则超阈值→报警。请说明本次为何报警。'),
];

export interface ReviewProgressiveOutcome {
  caseId: string; task: ReviewProgressiveTask; category: ReviewProgressiveCategory;
  passed: boolean; semanticPass: boolean; evidencePass: boolean; safetyPass: boolean;
  itemAgreement: { matched: number; total: number }; failures: string[];
  falseCovered: boolean; held: boolean; falseRejectedPositive: boolean; contradictionRecognized: boolean;
  directionAgreement: { matched: number; total: number }; reverseSafelyUncovered: boolean;
  expected: ReviewProgressiveExpected;
  actual: { status: FrozenReferenceShadowResult['status']; reasons: string[]; evidence: FrozenReferenceShadowResult['evidence'];
    frames: FrozenReferenceShadowResult['frames']; observations: Pick<FrozenReferenceItemObservation, 'frameId' | 'itemId' | 'verdict' | 'direction' | 'premises'>[] };
}

/** Descriptive acceptance predicate, not a mastery-score conversion. Held is a
 * safety outcome, never agreement with a reviewed semantic expectation. */
export function judgeReviewProgressiveOutcome(testCase: ReviewProgressiveCase, result: FrozenReferenceShadowResult): ReviewProgressiveOutcome {
  const failures: string[] = [], expectedItems = testCase.expected.frames.flatMap(frame => frame.items.map(item => ({ frame, item })));
  const held = result.status !== 'reviewed';
  if (held) failures.push(`status:${result.status}:${result.reasons.join(',')}`);
  let matched = 0, directionMatched = 0, directionTotal = 0;
  const observedKeys = result.observations.map(item => JSON.stringify([item.frameId, item.itemId]));
  if (new Set(observedKeys).size !== observedKeys.length || result.observations.length !== expectedItems.length) failures.push('item_set_mismatch');
  for (const { frame, item } of expectedItems) {
    const actual = result.observations.find(observation => observation.frameId === frame.frameId && observation.itemId === item.itemId);
    if (actual && item.verdicts.includes(actual.verdict)) matched++;
    else failures.push(`item:${frame.frameId}/${item.itemId}:expected=${item.verdicts.join('|')}:actual=${actual?.verdict ?? 'missing'}`);
    if (item.direction !== undefined) {
      directionTotal++; if (actual?.direction === item.direction) directionMatched++;
      else failures.push(`direction:${item.itemId}:expected=${item.direction}:actual=${actual?.direction ?? 'missing'}`);
    }
    if (item.premises !== undefined && actual?.premises !== item.premises)
      failures.push(`premises:${item.itemId}:expected=${item.premises}:actual=${actual?.premises ?? 'missing'}`);
  }
  const frameMatches = testCase.expected.frames.every(frame => result.frames.some(actual => actual.frameId === frame.frameId && actual.status === frame.status));
  if (!frameMatches || result.frames.length !== testCase.expected.frames.length || new Set(result.frames.map(frame => frame.frameId)).size !== result.frames.length)
    failures.push('frame_status_mismatch');
  const evidencePass = result.evidence === testCase.expected.evidence;
  if (!evidencePass) failures.push(`evidence:expected=${testCase.expected.evidence}:actual=${result.evidence}`);
  const safetyPass = result.scope === 'frozen_question_items' && result.semanticTruth === 'not_certified'
    && result.scoreWrite === 'disabled' && result.cognitionWrite === 'disabled'
    && result.modelRequests.total === result.modelRequests.extract + result.modelRequests.reference && result.modelRequests.total <= 2
    && result.modelRequests.extract <= 1 && result.modelRequests.reference <= 1 && (!held ? result.modelRequests.total === 2 : true);
  if (!safetyPass) failures.push('shadow_safety_contract_mismatch');
  const semanticPass = !held && failures.every(failure => failure.startsWith('evidence:') || failure === 'shadow_safety_contract_mismatch');
  const falseCovered = testCase.expected.noFalseCovered && result.frames.some(frame => frame.status === 'covered');
  if (falseCovered) failures.push('false_covered');
  const positive = testCase.expected.frames.every(frame => frame.status === 'covered');
  return { caseId: testCase.id, task: testCase.task, category: testCase.category,
    passed: semanticPass && evidencePass && safetyPass && !falseCovered, semanticPass, evidencePass, safetyPass,
    itemAgreement: { matched, total: expectedItems.length }, failures, falseCovered, held,
    falseRejectedPositive: positive && (!frameMatches || held),
    contradictionRecognized: testCase.category === 'direct_opposition' && !held && result.frames.some(frame => frame.status === 'contradicted'),
    directionAgreement: { matched: directionMatched, total: directionTotal },
    reverseSafelyUncovered: testCase.category === 'reverse_inference' && !held && result.frames.every(frame => frame.status === 'partial'),
    expected: structuredClone(testCase.expected), actual: { status: result.status, reasons: [...result.reasons], evidence: result.evidence,
      frames: structuredClone(result.frames), observations: result.observations.map(({ frameId, itemId, verdict, direction, premises }) => ({ frameId, itemId, verdict, direction, premises })) } };
}

export interface ReviewProgressiveReport {
  version: 1; datasetVersion: typeof REVIEW_PROGRESSIVE_DATASET_VERSION; annotationStatus: 'assistant_draft'; humanGold: false;
  semanticTruth: 'not_certified'; scoreWrite: 'disabled'; cognitionWrite: 'disabled';
  expectedCases: number; observedCases: number; uniqueCases: number; duplicateOrUnknownCaseIds: string[]; missingCaseIds: string[]; allCasesPass: boolean;
  metrics: { endToEnd: { matched: number; total: number }; itemAgreement: { matched: number; total: number }; directionAgreement: { matched: number; total: number };
    held: number; falseCovered: number; falseRejectedPositive: { count: number; total: number };
    directOpposition: { recognized: number; total: number }; reverseInference: { safelyUncovered: number; total: number }; assistanceClassification: { matched: number; total: number } };
  byTask: Record<ReviewProgressiveTask, { observed: number; passed: number; held: number; falseCovered: number }>;
  failedCaseIds: string[];
}

export function summarizeReviewProgressiveReport(outcomes: readonly ReviewProgressiveOutcome[]): ReviewProgressiveReport {
  const expectedIds = REVIEW_PROGRESSIVE_DATASET.map(testCase => testCase.id), seen = new Set<string>(), bad = new Set<string>();
  for (const outcome of outcomes) { if (!expectedIds.includes(outcome.caseId) || seen.has(outcome.caseId)) bad.add(outcome.caseId); seen.add(outcome.caseId); }
  // Invalid duplicate/unknown records do not improve numerator or denominator.
  const valid = outcomes.filter(outcome => expectedIds.includes(outcome.caseId) && !bad.has(outcome.caseId));
  const byTask = Object.fromEntries((['definition', 'condition', 'reasoning'] as const).map(task => {
    const subset = valid.filter(outcome => outcome.task === task);
    return [task, { observed: subset.length, passed: subset.filter(outcome => outcome.passed).length,
      held: subset.filter(outcome => outcome.held).length, falseCovered: subset.filter(outcome => outcome.falseCovered).length }];
  })) as ReviewProgressiveReport['byTask'];
  const missingCaseIds = expectedIds.filter(id => !seen.has(id));
  const sum = (key: 'itemAgreement' | 'directionAgreement', value: 'matched' | 'total') => valid.reduce((total, outcome) => total + outcome[key][value], 0);
  const positives = valid.filter(outcome => outcome.expected.frames.every(frame => frame.status === 'covered'));
  const oppositions = valid.filter(outcome => outcome.category === 'direct_opposition'), reverse = valid.filter(outcome => outcome.category === 'reverse_inference');
  const assisted = valid.filter(outcome => outcome.category === 'strong_hint');
  return { version: 1, datasetVersion: REVIEW_PROGRESSIVE_DATASET_VERSION, annotationStatus: 'assistant_draft', humanGold: false,
    semanticTruth: 'not_certified', scoreWrite: 'disabled', cognitionWrite: 'disabled', expectedCases: expectedIds.length,
    observedCases: outcomes.length, uniqueCases: valid.length, duplicateOrUnknownCaseIds: [...bad], missingCaseIds,
    allCasesPass: !bad.size && !missingCaseIds.length && valid.length === expectedIds.length && valid.every(outcome => outcome.passed),
    metrics: { endToEnd: { matched: valid.filter(outcome => outcome.passed).length, total: valid.length },
      itemAgreement: { matched: sum('itemAgreement', 'matched'), total: sum('itemAgreement', 'total') },
      directionAgreement: { matched: sum('directionAgreement', 'matched'), total: sum('directionAgreement', 'total') },
      held: valid.filter(outcome => outcome.held).length, falseCovered: valid.filter(outcome => outcome.falseCovered).length,
      falseRejectedPositive: { count: positives.filter(outcome => outcome.falseRejectedPositive).length, total: positives.length },
      directOpposition: { recognized: oppositions.filter(outcome => outcome.contradictionRecognized).length, total: oppositions.length },
      reverseInference: { safelyUncovered: reverse.filter(outcome => outcome.reverseSafelyUncovered).length, total: reverse.length },
      assistanceClassification: { matched: assisted.filter(outcome => outcome.evidencePass).length, total: assisted.length } },
    byTask, failedCaseIds: valid.filter(outcome => !outcome.passed).map(outcome => outcome.caseId) };
}
