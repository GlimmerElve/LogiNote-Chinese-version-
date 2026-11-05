import type { ReviewCognitionPurpose } from '../src/services/reviewIntent';
import type { ReviewLayerShadow, CognitionGrowthProposal } from '../src/services/reviewComparison/semanticTypes';

export type ReviewDualFamily = 'definition' | 'judgment' | 'contradiction' | 'reasoning' | 'growth' | 'boundary';
export interface ReviewDualCase {
  id: string; origin: 'synthetic'; annotationStatus: 'assistant_draft'; family: ReviewDualFamily;
  topic: string; question: string; answer: string;
  personal?: { text: string; context: string; purpose: ReviewCognitionPurpose };
  references: string[]; hintLevel: 0 | 1 | 2 | 3 | 4;
  expected: {
    mastery: Partial<Record<'concept' | 'judgment' | 'reasoning', ReviewLayerShadow['status']>>;
    growth?: CognitionGrowthProposal['operation'] | 'no_change' | 'held';
    requiredClaims: string[]; noNegative: boolean; noConflict: boolean;
    edge?: { premise: string; conclusion: string; supported: boolean };
  };
  rationale: string;
}
type Draft = Omit<ReviewDualCase, 'origin' | 'annotationStatus' | 'hintLevel' | 'expected'> & {
  hintLevel?: ReviewDualCase['hintLevel']; expected: Partial<ReviewDualCase['expected']> & Pick<ReviewDualCase['expected'], 'mastery'>;
};
const c = (value: Draft): ReviewDualCase => ({ ...value, origin: 'synthetic', annotationStatus: 'assistant_draft', hintLevel: value.hintLevel || 0,
  expected: { requiredClaims: [], noNegative: true, noConflict: true, ...value.expected } });
const personal = (text: string, purpose: ReviewCognitionPurpose = 'give_evidence', context = '条件B') => ({ text, purpose, context });

/** Invented course rules and synthetic observations only. Expectations NEVER enter model inputs. */
export const REVIEW_DUAL_DATASET: ReviewDualCase[] = [
  c({ id: 'C01', family: 'definition', topic: '回环队列', question: '请用自己的话定义回环队列。',
    answer: '回环队列是一种排队结构，走到存储空间的末尾后，会回到开头继续使用空间。',
    references: ['回环队列是尾部可回绕到存储空间起点的队列结构。'],
    expected: { mastery: { concept: 'supported', reasoning: 'not_required' }, requiredClaims: ['回到开头'] }, rationale: '同义复述不应因措辞不同误拒。' }),
  c({ id: 'C02', family: 'definition', topic: '选择过载', question: '请只解释选择过载的概念，不需要分析因果链。',
    answer: '选择过载是选项太多又难以比较时出现的选择困难，也可能伴随满意度降低。',
    references: ['选择过载指选项过多且难以比较时出现的选择困难、满意度可能降低等现象。'],
    expected: { mastery: { concept: 'supported', reasoning: 'not_required' }, requiredClaims: ['选项太多又难以比较'] }, rationale: '定义保留适用条件，未要求推理不能额外扣分。' }),
  c({ id: 'C03', family: 'definition', topic: '抽屉索引', question: '用自己的话说说本课程中的抽屉索引是什么。',
    answer: '抽屉索引就是把关键词和存放位置对应起来，看到关键词便能找到相应抽屉。',
    references: ['本课程把关键词到抽屉位置的映射称为抽屉索引，用于定位内容。'],
    expected: { mastery: { concept: 'supported' }, requiredClaims: ['关键词和存放位置对应'] }, rationale: '完全以给定课程定义为基线，不靠外部常识。' }),
  c({ id: 'C04', family: 'definition', topic: '复盘记录', question: '请定义本课程中的复盘记录。',
    answer: '复盘记录不是只记下发生了什么，还要记录自己的判断以及作出判断的理由。',
    references: ['本课程的复盘记录包括事件经过、个人判断和判断依据，不只是事件流水账。'],
    expected: { mastery: { concept: 'supported' }, requiredClaims: ['判断的理由'] }, rationale: '否定句和自己的表述不能被当成错误定义。' }),
  c({ id: 'J01', family: 'judgment', topic: '风扇甲规则', question: '在低负载条件下，风扇甲的转速是什么情况？',
    answer: '风扇甲在低负载时转速为每分钟120转。', references: ['风扇甲在低负载条件下转速为每分钟120转。'],
    expected: { mastery: { judgment: 'supported' }, requiredClaims: ['每分钟120转'] }, rationale: '同对象同条件同指标的事实复述。' }),
  c({ id: 'J02', family: 'judgment', topic: '策略S表现', question: '在条件B下，策略S相对策略T的速度如何？请保留比较基准。',
    answer: '在条件B下，策略S的运行速度比策略T更快。', references: ['在条件B下，以策略T为基准，策略S的运行速度更快。'],
    expected: { mastery: { judgment: 'supported' }, requiredClaims: ['比策略T更快'] }, rationale: '相对比较提供明确基准，应可评估。' }),
  c({ id: 'J03', family: 'judgment', topic: '试剂Q测量', question: '请复述试剂Q在温度20度时测得的指标P。',
    answer: '温度20度时，试剂Q的指标P实测值为8。', references: ['温度20度时，试剂Q的指标P实测值为8。'],
    expected: { mastery: { judgment: 'supported' }, requiredClaims: ['实测值为8'] }, rationale: '测量对象、条件和指标齐全。' }),
  c({ id: 'J04', family: 'judgment', topic: '机制M结果', question: '请说明机制M在条件B下对指标P的影响，注意确定程度。',
    answer: '在条件B下，机制M可能使指标P增加，但我没有把它理解为一定增加。',
    references: ['在条件B下，机制M可能使指标P增加，不保证每次都增加。'],
    expected: { mastery: { judgment: 'supported' }, requiredClaims: ['可能使指标P增加'] }, rationale: '正确保留可能性，不应因非确定措辞误拒。' }),
  c({ id: 'X01', family: 'contradiction', topic: '仪器M测量', question: '2026年1月在条件B下，仪器M的指标P实测是多少？',
    answer: '2026年1月在条件B下，仪器M的指标P实测值为20。', references: ['2026年1月在条件B下，仪器M的指标P实测值为18。'],
    expected: { mastery: { judgment: 'contradicted' }, noNegative: false, requiredClaims: ['实测值为20'] }, rationale: '同一测量的实际数值不相容，不是可能性差异。' }),
  c({ id: 'X02', family: 'contradiction', topic: '闸门甲状态', question: '本次条件B下闸门甲的观测状态是什么？',
    answer: '本次在条件B下，闸门甲实测处于开启状态。', references: ['本次在条件B下，闸门甲实测处于关闭状态，而非开启状态。'],
    expected: { mastery: { judgment: 'contradicted' }, noNegative: false, requiredClaims: ['开启状态'] }, rationale: '同一次观测中的互斥事实。' }),
  c({ id: 'X03', family: 'contradiction', topic: '风扇甲转速', question: '本次低负载条件下，风扇甲的转速实测是多少？',
    answer: '本次低负载条件下，风扇甲的转速实测为每分钟150转。', references: ['本次低负载条件下，风扇甲的转速实测为每分钟120转，不是150转。'],
    expected: { mastery: { judgment: 'contradicted' }, noNegative: false, requiredClaims: ['每分钟150转'] }, rationale: '明确数值错误应被检出，不能全部 held 取巧。' }),
  c({ id: 'R01', family: 'reasoning', topic: '设备甲报警推理', question: '请说明设备甲本次报警的前提和推理。',
    answer: '本次设备甲的指标P超过阈值T。由于指标P超过阈值T会触发设备甲报警，所以本次设备甲报警。',
    references: ['本次设备甲的指标P超过阈值T。指标P超过阈值T会触发设备甲报警，因此本次设备甲报警。'],
    expected: { mastery: { reasoning: 'supported' }, requiredClaims: ['指标P超过阈值T', '本次设备甲报警'],
      edge: { premise: '本次设备甲的指标P超过阈值T', conclusion: '本次设备甲报警', supported: true } }, rationale: '显式前提、规则及结论；关系方向不能颠倒。' }),
  c({ id: 'R02', family: 'reasoning', topic: '灯甲亮起推理', question: '请用本次条件B下的前提，解释为什么灯甲亮起。',
    answer: '本次条件B下，开关甲闭合。开关甲闭合会使灯甲亮起，因此本次条件B下灯甲亮起。',
    references: ['本次条件B下，开关甲闭合。开关甲闭合会使灯甲亮起，因此本次条件B下灯甲亮起。'],
    expected: { mastery: { reasoning: 'supported' }, requiredClaims: ['开关甲闭合', '灯甲亮起'],
      edge: { premise: '本次条件B下，开关甲闭合', conclusion: '本次条件B下灯甲亮起', supported: true } }, rationale: '两端事实和连接均有明确参考依据。' }),
  c({ id: 'R03', family: 'reasoning', topic: '无依据的连接', question: '请解释你从开关甲状态推到水箱乙水位的理由。',
    answer: '本次开关甲闭合，因此本次水箱乙水位上升。',
    references: ['本次开关甲闭合。本次水箱乙水位上升。两者之间没有提供因果或推导关系的依据。'],
    expected: { mastery: { reasoning: 'unassessed' }, requiredClaims: ['开关甲闭合', '水箱乙水位上升'],
      edge: { premise: '本次开关甲闭合', conclusion: '本次水箱乙水位上升', supported: false } }, rationale: '两个正确事实不能自动证明关系。' }),
  c({ id: 'G01', family: 'growth', topic: '设备甲多结果', question: '设备甲在条件B下除了产生结果C，还会产生什么结果？',
    answer: '在条件B下，设备甲也会产生结果D。', personal: personal('在条件B下，设备甲会产生结果C。', 'infer_consequence'),
    references: ['在条件B下，设备甲会产生结果C，也会产生结果D；结果C和结果D可以同时出现。'],
    expected: { mastery: { judgment: 'supported' }, growth: 'supplement', requiredClaims: ['也会产生结果D'] }, rationale: '新增D保留C，不能改成互斥或替代。' }),
  c({ id: 'G02', family: 'growth', topic: '装置Q观察证据', question: '请复述装置Q的三次实测结果，作为原观点的新观察证据。',
    answer: '在条件B下，三次实测都观察到装置Q停止，这为原来的停止现象观点提供了观察依据。',
    personal: personal('在条件B下，装置Q会出现停止现象。'),
    references: ['在条件B下，三次实测都观察到装置Q停止，三次观察可作为装置Q出现停止现象的证据，不证明任何条件下都会停止。'],
    expected: { mastery: { judgment: 'supported' }, growth: 'supplement', requiredClaims: ['三次实测都观察到装置Q停止'] }, rationale: '相容的新证据应可生长，不能一律当作重述跳过。' }),
  c({ id: 'G03', family: 'growth', topic: '设备甲不同情境', question: '请说明设备甲在不同条件E下的表现，保留原来条件B下的认识。',
    answer: '在条件E下，设备甲不会产生结果C。', personal: personal('在条件B下，设备甲会产生结果C。', 'give_condition'),
    references: ['在条件E下，设备甲不会产生结果C。'],
    expected: { mastery: { judgment: 'supported' }, growth: 'contextual', requiredClaims: ['条件E'] }, rationale: '不同条件形成并存，不推翻条件B下的原观点。' }),
  c({ id: 'G04', family: 'growth', topic: '设备甲确定程度', question: '请根据证据局限重新表述设备甲在条件B下产生结果C的确定程度。',
    answer: '在条件B下，现有证据尚不能证明设备甲必然产生结果C。', personal: personal('在条件B下，设备甲必然产生结果C。', 'qualify'),
    references: ['在条件B下，现有证据尚不能证明设备甲必然产生结果C。'],
    expected: { mastery: { judgment: 'supported' }, growth: 'certainty_review', requiredClaims: ['尚不能证明'] }, rationale: '证据局限调整旧确定程度，不是实际反例。' }),
  c({ id: 'G05', family: 'growth', topic: '设备甲实际反例', question: '请用本次实际观测核对设备甲在条件B下必然产生结果C的观点。',
    answer: '本次条件B下的实际观测显示，设备甲没有产生结果C。', personal: personal('在条件B下，设备甲必然产生结果C。', 'give_counterexample'),
    references: ['本次条件B下的实际观测显示，设备甲没有产生结果C。'],
    expected: { mastery: { judgment: 'supported' }, growth: 'review_conflict', noConflict: false, requiredClaims: ['没有产生结果C'] }, rationale: '实际反例可以形成待核对冲突，但不自动替换。' }),
  c({ id: 'G06', family: 'growth', topic: '设备甲推论生长', question: '请以设备甲指标P超过阈值T为前提，推出本次报警结论并说明理由。',
    answer: '本次设备甲的指标P超过阈值T。由于指标P超过阈值T会触发设备甲报警，所以本次设备甲报警。',
    personal: personal('本次设备甲的指标P超过阈值T。', 'infer_consequence', '本次设备甲'),
    references: ['本次设备甲的指标P超过阈值T。指标P超过阈值T会触发设备甲报警，因此本次设备甲报警。'],
    expected: { mastery: { reasoning: 'supported' }, growth: 'supplement', requiredClaims: ['本次设备甲报警'],
      edge: { premise: '本次设备甲的指标P超过阈值T', conclusion: '本次设备甲报警', supported: true } }, rationale: '个人前提到新后果的方向与参考推理分别核验。' }),
  c({ id: 'B01', family: 'boundary', topic: '设备甲条件差异', question: '请说说设备甲在条件E下的结果C表现。',
    answer: '在条件E下，设备甲不会产生结果C。', references: ['在条件B下，设备甲会产生结果C。'],
    expected: { mastery: { judgment: 'unassessed' }, requiredClaims: ['条件E'] }, rationale: '不同条件不能将用户判错，也不能当作匹配支持。' }),
  c({ id: 'B02', family: 'boundary', topic: '机制M可能性', question: '请复述机制M在条件B下是否必然增加指标P。',
    answer: '在条件B下，机制M必然增加指标P。', references: ['在条件B下，机制M可能增加指标P。'],
    expected: { mastery: { judgment: 'unassessed' }, requiredClaims: ['必然增加指标P'] }, rationale: '只有可能措辞、没有明确局限或反例，不得制造事实冲突。' }),
  c({ id: 'B03', family: 'boundary', topic: '仪器M资料分歧', question: '请复述本次条件B下仪器M的指标P实测值。',
    answer: '本次条件B下，仪器M的指标P实测值为5。', references: ['本次条件B下，仪器M的指标P实测值为5。', '本次条件B下，仪器M的指标P实测值为6。'],
    expected: { mastery: { judgment: 'unassessed' }, requiredClaims: ['实测值为5'] }, rationale: '资料分歧未解决不能选边评分。' }),
  c({ id: 'B04', family: 'boundary', topic: '强提示后的复述', question: '在条件B下，设备甲会产生什么结果？',
    answer: '在条件B下，设备甲会产生结果C。', references: ['在条件B下，设备甲会产生结果C。'], hintLevel: 3,
    expected: { mastery: { judgment: 'unassessed' }, requiredClaims: ['产生结果C'] }, rationale: '正确答案仍不能伪装独立掌握。' }),
  c({ id: 'B05', family: 'boundary', topic: '设备甲无参考补充', question: '请补充设备甲在条件B下另一个结果。',
    answer: '在条件B下，设备甲也会产生结果D。', personal: personal('在条件B下，设备甲会产生结果C。', 'infer_consequence'), references: [],
    expected: { mastery: { judgment: 'unassessed' }, growth: 'supplement', requiredClaims: ['产生结果D'] }, rationale: '无参考不判错；用户的新认知仍可待确认。' }),
  c({ id: 'B06', family: 'boundary', topic: '只有重述没有证据', question: '请为设备甲在条件B下产生结果C的观点提供新的证据。',
    answer: '在条件B下，设备甲会产生结果C。', personal: personal('在条件B下，设备甲会产生结果C。'), references: ['在条件B下，设备甲会产生结果C。'],
    expected: { mastery: { reasoning: 'unassessed' }, growth: 'no_change', requiredClaims: ['产生结果C'] }, rationale: '导师给证据意图不能把纯重复变成证据生长；单个相容事实不证明理由成立。' }),
  c({ id: 'B07', family: 'boundary', topic: '策略S基准差异', question: '在条件B下，策略S相对策略U的速度如何？',
    answer: '在条件B下，策略S比策略U更快。', references: ['在条件B下，策略S比策略T更快。'],
    expected: { mastery: { judgment: 'unassessed' }, requiredClaims: ['比策略U更快'] }, rationale: '比较基准不同不能对齐后奖罚。' }),
  c({ id: 'B08', family: 'boundary', topic: '导师示例不是用户证据', question: '请定义抽屉索引。导师示例：抽屉索引是关键词到抽屉位置的映射。',
    answer: '我还不清楚，请再解释一下。', references: ['抽屉索引是关键词到抽屉位置的映射。'],
    expected: { mastery: { concept: 'unassessed' } }, rationale: '不得将导师提供的定义算成用户回答或把不会回答记成明确错误。' }),
];
