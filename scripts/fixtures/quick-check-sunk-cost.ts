import type { NoteItem, LlmCallRequest } from '../../src/types';
import { type QuickCheckAnswer } from '../../src/services/quickCheck';
import { masteryBaselineFixture, masteryComparisonFixture } from './mastery-baselines';
import { quickCheckDesignFixture, generateQuickCheckFixture as generateQuickCheck } from './quick-check-design';

export const sunkCostNote: NoteItem = { id: 'isolated-sunk-cost-scope', title: '沉没成本', noteType: 'knowledge',
  content: '## 定义\n沉没成本是已经发生且无法收回的成本，既包括金钱，也包括已经投入的时间、精力与情感。决策应比较从现在开始的未来增量成本和收益，而非已发生的投入。\n\n## 边界\n沉没成本不能决定未来投入，但应复盘过去的判断错误。沉没成本与机会成本相关，不是互不相干的概念；不能仅因项目短期不顺就立即放弃。\n\n## 示例与应用\n如果停止项目未来收支均为零，继续需额外投入500万元并产生600万元收入，则继续的预期未来净收益为100万元。过去已投入且无法收回的800万元不改变该比较。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z' };

export const sunkCostAnswers: QuickCheckAnswer[] = [
  { questionId: 'Q1', text: '如果继续追加，总投入是1300万元，预计盈利600万元，也就是说最好的情况下也处于700万元的亏损情况，所以我认为不应该继续，因为存在总投入1300万元无法盈利600万元的情况。800万元是沉没成本，已经投入却未产出的成本。' },
  { questionId: 'Q2', optionId: 'A' }, { questionId: 'Q3', optionId: 'B' },
];

export async function createSunkCostCard(note = sunkCostNote, wrongGenerationKey = false) {
  return generateQuickCheck({ note, readers: { searchNotes: async () => [] }, source: 'isolated-scope-regression', call: async request => {
    const input = JSON.parse(request.userInput);
    const prompts = [
      '某公司三年前投入800万元研发一款产品，至今未上市。若继续推进，还需追加500万元，预计未来带来600万元收入；若立即停止，追加投入为0、未来收入为0。仅按给定收支，判断是否应继续推进并说明理由，同时指出800万元应如何处理。',
      '以下哪项最符合“沉没成本”概念边界的要求？',
      '判断：沉没成本只包括已经支付的金钱，不包括已经投入的时间、精力与情感。',
    ];
    const criteria = [['concept_accuracy', 'concept_application'], ['concept_boundary'], ['concept_accuracy']];
    return { content: JSON.stringify(quickCheckDesignFixture(request, { questions: prompts.map((prompt, index) => {
      const refs = input.references.filter((ref: { criterionIds: string[] }) => ref.criterionIds.some(id => criteria[index].includes(id)));
      return { id: `Q${index + 1}`, prompt, type: index ? index === 1 ? 'choice' : 'true_false' : 'application',
        criterionIds: criteria[index], referenceIds: refs.map((ref: { id: string }) => ref.id),
        ...(index ? { options: index === 1 ? [
          { id: 'A', text: '沉没成本与机会成本无关，二者是两套独立概念' },
          { id: 'B', text: '只要项目出现亏损就应立即放弃' },
          { id: 'C', text: '沉没成本只包括金钱，不包括时间和精力' },
          { id: 'D', text: '过去无法收回的投入不应决定未来选择，但过去的错误仍需复盘' },
        ] : [{ id: 'A', text: '成立' }, { id: 'B', text: '不成立' }] } : {}),
        privateAnswer: { ...(index ? { optionId: index === 1 ? wrongGenerationKey ? 'A' : 'D' : 'B' } : {}),
          explanation: index === 0 ? '未来净收益600−500=100万元，800万元已发生，不能据此否决继续。' : '按笔记中的概念含义和边界判断。',
          referenceQuotes: refs.map((ref: { id: string; quote: string }) => ({ referenceId: ref.id, quote: ref.quote.slice(0, 160) })) } };
    }) })) };
  } });
}

/** Mock semantic outcomes for contract tests only; real acceptance uses a cloud call. */
export function sunkCostEvaluationFixture(request: LlmCallRequest) {
  const input = JSON.parse(request.userInput);
  return { protocol: 'quick-check-evaluation-v2', sessionId: input.sessionId,
    questionEvaluations: input.questionTasks.map((task: any) => {
      const scoped = { ...task, references: input.references.filter((ref: any) => task.task.verificationScopes[0].referenceIds.includes(ref.id)) };
      const evidence = [{ id: 'E1', quote: task.answer }];
      const criteria = task.criteria.map((criterion: any) => {
        const failed = criterion.id === 'concept_application' || task.questionId === 'Q2';
        return { id: criterion.id, state: failed ? 'fail' : 'pass', evidenceIds: ['E1'],
          reason: task.questionId === 'Q1' ? '本题未来增量收益600−500=100万元，不能把已发生的800万元再次计入继续或停止的比较。'
            : task.questionId === 'Q2' ? '本题选择A与资料给出的关系不符，应选择D。' : '本题选择B正确，沉没成本不限于金钱。',
          ...(failed ? { comparison: masteryComparisonFixture(scoped, criterion.id, ['E1']) } : {}) };
      });
      const reference = scoped.references[0];
      return { questionId: task.questionId,
        result: { protocol: 'mastery-shadow-evaluator-v1', evaluationId: task.evaluationId, knowledgePointId: input.knowledgePointId,
          baselines: masteryBaselineFixture(scoped), evidence, criteria, summary: 'Synthetic scope regression, not a semantic proof.' },
        ...(task.questionId === 'Q1' ? {} : { answerKey: { optionId: task.questionId === 'Q2' ? 'D' : 'B',
          explanation: task.questionId === 'Q2' ? '无法收回的过去投入不决定未来选择，但应复盘错误。' : '资料明确包括时间、精力等非金钱投入。',
          referenceQuotes: [{ referenceId: reference.id, quote: reference.quote.slice(0, 160) }] } }) };
    }) };
}
