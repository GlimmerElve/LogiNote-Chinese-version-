import type { FlowSession, KnowledgePointCandidate, NoteItem } from '../../src/types';
import { saveFlowReviewRecord } from '../../src/services/textbook/reviewRecordStore';
import { createMasteryShadowState } from '../../src/services/masteryShadow/stateMachine';
import { setMasteryLayerFixture } from './mastery-evidence';

export const FLOW_MASTERY_RAW = '确认偏误是更倾向于寻找、解释或记住支持自己原观点的信息，并忽略反面信息。只找到支持材料，不能单独证明原观点正确，因为按支持与否筛选会遗漏相反信息，使看到的证据不具代表性，高估支持强度。我会主动找反例，并检查资料可靠性和代表性后再下判断。但发现筛选偏差也不意味着原观点一定错误，这种倾向不是每个人每次都会出现。至于锚定效应，我只听过名称，今天还没有展开学习。';
export const FLOW_MASTERY_BOOK = [
  '## 确认偏误',
  '确认偏误指人们倾向于寻找、解释或记住支持已有信念的信息，而忽视或低估反面信息。它是一种倾向，并不表示每个人每次都这样做。',
  '只搜集支持性资料，不能单独证明原观点正确。支持材料本身仍可能有价值，但要检查是否遗漏反面证据、样本是否有代表性，以及证据的可靠性。发现选择性搜集也不能反过来证明原观点必定错误。',
  '如果证据是按是否支持既有观点来筛选的，样本就可能系统性地遗漏相反信息。因此，仅凭筛选后的支持材料可能高估支持强度。合理检验需要主动寻找反例、评估材料可靠性，并结合必要的代表性条件判断；不能以结论为真来证明其前提有效。',
  '## 锚定效应',
  '锚定效应指判断受先出现的信息影响，后续调整可能不足。仅知道名称不代表能够解释或应用这个概念。',
  '## 损失厌恶',
  '损失厌恶指相对于某一参照点，损失带来的主观影响可能大于等量收益，不等于任何时候都拒绝风险。',
].join('\n\n');

export const FLOW_MASTERY_CANDIDATES: KnowledgePointCandidate[] = [
  { id: 'cand-confirmation', name: '确认偏误', existingNoteTitle: '确认偏误', category: 'known' },
  { id: 'cand-anchoring', name: '锚定效应', existingNoteTitle: '锚定效应', category: 'known' },
  { id: 'cand-loss', name: '损失厌恶', existingNoteTitle: '损失厌恶', category: 'known' },
];

export function createFlowMasteryFixture(sessionId = 'flow-mastery-fixture-1', notes?: NoteItem[]) {
  const at = '2026-10-18T08:00:00.000Z';
  const base = (id: string, title: string, noteType: NoteItem['noteType'], content = ''): NoteItem => ({
    id, title, noteType, content, tags: [], links: [], backlinks: [], dueDates: [], createdAt: at, updatedAt: at,
  });
  const session: FlowSession = { id: sessionId, noteId: 'flow-mastery-project', noteTitle: '认知偏差学习',
    startedAt: at, endedAt: at, durationSeconds: 1200, reviewIntervalMinutes: 10,
    incrementalText: FLOW_MASTERY_RAW, restateText: FLOW_MASTERY_RAW, analyze: true };
  let result = notes;
  if (!result) {
    const project = base(session.noteId, session.noteTitle, 'project',
      `<TextbookBoundary id="mastery-region" edge="start" />\n\n${FLOW_MASTERY_BOOK}\n\n<TextbookBoundary id="mastery-region" edge="end" />`);
    project.links = ['确认偏误', '锚定效应', '损失厌恶'];
    project.textbook = { schemaVersion: 1, textbookId: 'mastery-book', projectNoteId: project.id,
      rootProjectId: project.id, revisionId: 'mastery-book-r1', regionId: 'mastery-region', createdAt: at, updatedAt: at };
    const confirmation = base('kp-confirmation', '确认偏误', 'knowledge', '请对该知识点进行定义描述');
    confirmation.dsrState = { difficulty: 4, stability: 8, lastReviewedAt: at, reviewCount: 3,
      consecutiveCorrect: 1, consecutiveWrong: 0, conceptMastery: 72, conceptMasterySamples: 3 };
    const anchoring = base('kp-anchoring', '锚定效应', 'knowledge', '请对该知识点进行定义描述');
    const priorState = createMasteryShadowState(anchoring.id);
    setMasteryLayerFixture(priorState, 'concept', 'confirmed');
    anchoring.dsrState = { difficulty: 3, stability: 10, lastReviewedAt: at, reviewCount: 5,
      consecutiveCorrect: 3, consecutiveWrong: 0, conceptMastery: 85, conceptMasterySamples: 5, masteryShadow: priorState };
    result = [project, confirmation, anchoring, base('kp-loss', '损失厌恶', 'knowledge')];
  }
  result = result.map(note => note.id === session.noteId ? saveFlowReviewRecord(note, session, 'pending_analysis') : note);
  return { notes: result, session, candidates: structuredClone(FLOW_MASTERY_CANDIDATES) };
}
