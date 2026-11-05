import type { ReviewCriterionId } from '../src/services/reviewAssessment.ts';
import { type ReviewProgressiveCase, type ReviewProgressiveExpected, type ReviewProgressiveExpectedItem,
  type ReviewProgressiveOutcome, type ReviewProgressiveReport, type ReviewProgressiveTask } from './review-progressive-dataset.ts';
import { ACCEPTANCE_FIXTURE_CONDITION, ACCEPTANCE_FIXTURE_DEFINITION, ACCEPTANCE_FIXTURE_REASONING } from './reference-disclosure-fixture.ts';

/** Fresh wording and fictional facts, pre-registered before any v3 cloud run.
 * This small assistant-annotated pilot is NOT human gold, a fully blind holdout,
 * a model-built reference benchmark or certification of semantic truth. The
 * in-memory fixture keeps its fixed synthetic reviewer and original graph shape.
 * Importing this module cannot read a vault, request a model or write production data. */
export const REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET_VERSION = 'review-progressive-acceptance-v3-draft-v1' as const;

export const REVIEW_PROGRESSIVE_ACCEPTANCE_REFERENCES = {
  definition: {
    sourceParagraphs: ACCEPTANCE_FIXTURE_DEFINITION,
    selectedItems: [{ itemId: 'I1', criterionId: 'concept_meaning', paragraphIndex: 0, nodeIds: ['N1'], relationIds: [] },
      { itemId: 'I2', criterionId: 'concept_boundary', paragraphIndex: 1, nodeIds: ['N2'], relationIds: ['E1'] }],
    nodes: [{ id: 'N1', role: 'definition' }, { id: 'N2', role: 'condition' }],
    relations: [{ id: 'E1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'requires_condition' }], groups: [],
  },
  condition: {
    sourceParagraphs: ACCEPTANCE_FIXTURE_CONDITION,
    selectedItems: [{ itemId: 'I1', criterionId: 'condition_scope', paragraphIndex: 0, nodeIds: ['N1'], relationIds: [] },
      { itemId: 'I2', criterionId: 'condition_scope', paragraphIndex: 1, nodeIds: ['N2'], relationIds: ['E1'] }],
    nodes: [{ id: 'N1', role: 'condition' }, { id: 'N2', role: 'exception' }],
    relations: [{ id: 'E1', sourceNodeId: 'N2', targetNodeId: 'N1', kind: 'exception_of' }], groups: [],
  },
  reasoning: {
    sourceParagraphs: ACCEPTANCE_FIXTURE_REASONING,
    selectedItems: [{ itemId: 'I1', criterionId: 'actual_premise', paragraphIndex: 0, nodeIds: ['N1'], relationIds: [] },
      { itemId: 'I2', criterionId: 'actual_premise', paragraphIndex: 2, nodeIds: ['N3'], relationIds: ['E2'] },
      { itemId: 'I3', criterionId: 'inference_link', paragraphIndex: 1, nodeIds: ['N1', 'N2', 'N3'], relationIds: ['E1', 'E2'] }],
    nodes: [{ id: 'N1', role: 'fact' }, { id: 'N2', role: 'conclusion' }, { id: 'N3', role: 'condition' }],
    relations: [{ id: 'E1', sourceNodeId: 'N1', targetNodeId: 'N2', kind: 'support' },
      { id: 'E2', sourceNodeId: 'N3', targetNodeId: 'N2', kind: 'requires_condition' }],
    groups: [{ id: 'G1', conclusionNodeId: 'N2', premiseNodeIds: ['N1'], conditionNodeIds: ['N3'], relationIds: ['E1', 'E2'], operator: 'all' }],
  },
} as const;

const item = (itemId: string, criterionId: ReviewCriterionId, verdicts: ReviewProgressiveExpectedItem['verdicts'], rationale: string,
  structural: Pick<ReviewProgressiveExpectedItem, 'direction' | 'premises'> = {}): ReviewProgressiveExpectedItem => ({ itemId, criterionId, verdicts, rationale, ...structural });
const definitionItems = (meaning: ReviewProgressiveExpectedItem['verdicts'], boundary: ReviewProgressiveExpectedItem['verdicts']) => [
  item('I1', 'concept_meaning', meaning, '实验定义仅核对系统能否接收派送任务，措辞不同但含义相同应支持；同范围不能接收是直接相反。'),
  item('I2', 'concept_boundary', boundary, '联网与身份校验通过是AND必要条件；只回忆联网且未否定另一条件是遗漏，不自动认定事实相反。'),
];
const conditionItems = (scope: ReviewProgressiveExpectedItem['verdicts']) => [
  item('I1', 'condition_scope', scope, '适用条件同时要求联网及自动模式；漏自动模式是部分覆盖，不等于断言所有模式均适用。'),
  item('I2', 'condition_scope', ['supported'], '人工模式例外明确不按该蓝印规则送入二号通道，不能扩大为其它机制都无法送入。'),
];
const reasoningItems = (verdicts: ReviewProgressiveExpectedItem['verdicts'],
  structural: Pick<ReviewProgressiveExpectedItem, 'direction' | 'premises'> = {}) => [
  item('I1', 'actual_premise', ['supported'], '本次包裹带蓝印须是明确实际前提，不可只用关于所有蓝印包裹的一般规则。'),
  item('I2', 'actual_premise', ['supported'], '本次分拣系统已经联网，保留已选的必要实际条件。'),
  item('I3', 'inference_link', verdicts, '参考支持蓝印→进入二号通道。逆向不充分不等于事实相反；同条件明确不会进入才是实际结论反义。', structural),
];
const expected = (status: ReviewProgressiveExpected['frames'][number]['status'], items: ReviewProgressiveExpectedItem[],
  rationale: string, evidence: ReviewProgressiveExpected['evidence'] = 'independent'): ReviewProgressiveExpected => ({ status: 'reviewed', evidence,
  frames: [{ frameId: 'target-1', status, items }], noFalseCovered: status !== 'covered', rationale });
const questions: Record<ReviewProgressiveTask, string> = {
  definition: '你如何解释本实验的“蓝印就绪”？请把接收任务的能力及成立限制讲清楚。',
  condition: '介绍一下本实验蓝印分拣规则的使用范围，并说明人工模式下这条规则怎么处理包裹。',
  reasoning: '这次合成包裹应当怎样分拣？请用已知蓝印事实、联网条件及实验约定说明你的推断。',
};
const sample = (id: string, task: ReviewProgressiveTask, category: ReviewProgressiveCase['category'], answer: string,
  expectation: ReviewProgressiveExpected, hint?: string): ReviewProgressiveCase => ({ id, task, category,
  annotationStatus: 'assistant_draft', origin: 'synthetic', fixture: { task, theme: 'progressive-parcel-v1', noteCount: 1 },
  question: questions[task], answer, hintLevel: hint ? 4 : 0, consultedMaterialIds: [], ...(hint ? { hint } : {}), expected: expectation });

/** 8 pre-registered cases: 3 complete positives (one strongly assisted),
 * 2 missing-condition cases, 2 actual oppositions and 1 reverse inference.
 * The 19 selected items and their expectations must never be remapped after a run. */
export const REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET: readonly ReviewProgressiveCase[] = [
  sample('VD01', 'definition', 'paraphrase', '我把“蓝印就绪”理解成系统已经可以接受新的派送任务了。不过这个状态成立，系统必须连上网络，同时还得通过身份校验。',
    expected('covered', definitionItems(['supported'], ['supported']), '完整同义复述保留接收任务含义及联网、身份校验AND边界，不能因为不同措辞误报相反。')),
  sample('VD02', 'definition', 'missing_condition', '“蓝印就绪”说的是系统能够接收派送任务。至于成立限制，我只记得其中一项是系统要联网。',
    expected('partial', definitionItems(['supported'], ['partial']), '明确只回忆一个必要条件，未否定身份校验；这是有内容的部分覆盖，不应整题covered或contradicted。')),
  sample('VD03', 'definition', 'direct_opposition', '系统已联网并且身份校验通过时，我理解“蓝印就绪”是系统不能接收派送任务的状态；它也只有在联网且身份校验通过时才成立。',
    expected('contradicted', definitionItems(['contradicted'], ['supported']), '同一实验、同一成立条件与确定程度，能够接收与不能接收是实际含义相反，不是缺条件。')),
  sample('VC01', 'condition', 'strong_hint', '依照提示，我理解蓝印规则要系统联网而且运行在自动模式下才适用。人工模式另算，即便联网、包裹也有蓝印，仍不会按这条规则把它送进二号通道。',
    expected('covered', conditionItems(['supported']), '内容完整且例外保持规则范围，但强提示后回答不能当作独立回忆。', 'assisted_not_independent'),
    '要点：联网AND自动模式；人工模式例外，即使联网且有蓝印，也不按这条规则送入二号通道。请重新解释。'),
  sample('VC02', 'condition', 'missing_condition', '使用蓝印分拣规则的条件，我目前记得系统已经联网这一项。人工模式属于例外，即使联网且包裹有蓝印，也不会按这条规则送往二号通道。',
    expected('partial', conditionItems(['partial']), '遗漏自动模式但没有扩大规则到所有模式；人工例外完整，因此I1部分、I2支持。')),
  sample('VR01', 'reasoning', 'paraphrase', '本次包裹确实带有蓝印，分拣系统现在已经联网。实验的约定是带蓝印的包裹进入二号通道，所以依这项约定，本次包裹会送往二号通道。',
    expected('covered', reasoningItems(['supported'], { direction: 'correct', premises: 'complete' }), '实际蓝印前提及联网条件齐全，结论送往与参考进入同义，存在正向前提到结论的连线。')),
  sample('VR02', 'reasoning', 'reverse_inference', '本次包裹带有蓝印，系统也已经联网。我把实验约定倒过来作为推断：因为本次包裹会进入二号通道，所以可推出它带有蓝印。',
    expected('partial', reasoningItems(['partial', 'unverifiable'], { direction: 'reverse', premises: 'complete' }), '实际前提和联网条件均出现，但只呈现二号通道→蓝印的逆推。参考没有断言逆命题为假，而且双方结果同为进入二号通道，不得伪报事实矛盾。')),
  sample('VR03', 'reasoning', 'direct_opposition', '关于本次包裹，我确认它带有蓝印，分拣系统也已联网。尽管采用本实验的蓝印分拣约定，我认定的本次结果仍是不会进入二号通道。',
    expected('contradicted', reasoningItems(['contradicted']), '本次实际前提及条件一致，却明确给出不会进入的相反实际结论。直接结论反义允许无需证明边；不强制协议允许的direction/premises编码为一个固定值。')),
];

export interface ReviewProgressiveAcceptanceReport extends Omit<ReviewProgressiveReport, 'datasetVersion'> {
  datasetVersion: typeof REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET_VERSION;
  pilot: 'limited_new_wording_and_fictional_facts'; blindHoldout: false; referenceReviewer: 'fixed_synthetic';
}

/** The same descriptive predicate family, scoped ONLY to these eight cases.
 * Zero observations remains preparation, not a model pass. No score conversion. */
export function summarizeReviewProgressiveAcceptanceReport(outcomes: readonly ReviewProgressiveOutcome[]): ReviewProgressiveAcceptanceReport {
  const expectedIds = REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET.map(testCase => testCase.id), seen = new Set<string>(), bad = new Set<string>();
  for (const outcome of outcomes) { if (!expectedIds.includes(outcome.caseId) || seen.has(outcome.caseId)) bad.add(outcome.caseId); seen.add(outcome.caseId); }
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
  return { version: 1, datasetVersion: REVIEW_PROGRESSIVE_ACCEPTANCE_DATASET_VERSION, annotationStatus: 'assistant_draft', humanGold: false,
    pilot: 'limited_new_wording_and_fictional_facts', blindHoldout: false, referenceReviewer: 'fixed_synthetic',
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
