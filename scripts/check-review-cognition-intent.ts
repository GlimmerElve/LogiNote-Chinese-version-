import assert from 'node:assert/strict';
import {
  cognitionIntentCandidates,
  parseReviewTutorIntent,
  stripReviewIntentMarkers,
  inheritReviewQuestionIntent,
  type ReviewCognitionIntentCandidate,
} from '../src/services/reviewIntent.ts';
import { reviewCognitionObservations } from '../src/services/cognition/observations.ts';
import type { CognitionRetrieval } from '../src/services/cognition/retrieval.ts';

const retrieval: CognitionRetrieval = {
  status: 'ready',
  method: 'local-lexical-v1',
  fileRevision: 4,
  warning: '',
  items: Array.from({ length: 4 }, (_, index) => ({
    recordId: `r${index}`,
    revisionId: `v${index}`,
    branchId: `b${index}`,
    nodeId: `n${index}`,
    title: '选择过载',
    text: `已确认主张 ${index}`,
    textTruncated: false,
    stance: 'endorsed',
    branchKind: 'primary',
    context: '',
    needsReview: false,
    confirmedAt: '2026-01-01T00:00:00.000Z',
    sourceKind: 'argument_editor',
    originRevisionId: `v${index}`,
    score: 1,
    usableAsFactEvidence: false,
  })),
};

const candidates = cognitionIntentCandidates(retrieval);
assert.equal(candidates.length, 3, '只向导师暴露有界的候选坐标');
assert.equal(candidates[0].token, 'C1');

const parsed = parseReviewTutorIntent(
  '这个结论在什么条件下不成立？\n[意图:选择过载]\n[认知意图:C1|give_condition]',
  {
    questionMessageId: 'tutor-2',
    allowedKnowledgeTargets: ['选择过载'],
    cognitionCandidates: candidates,
  },
);
assert.equal(parsed.cleanText, '这个结论在什么条件下不成立？');
assert.deepEqual(parsed.intent.knowledgeTargets, ['选择过载']);
assert.deepEqual(parsed.intent.cognitionTarget, { ...candidates[0].reference, purpose: 'give_condition' });

const invalid = parseReviewTutorIntent('请说明。\n[认知意图:C999|give_evidence]', {
  questionMessageId: 'tutor-3',
  allowedKnowledgeTargets: ['选择过载'],
  fallbackKnowledgeTargets: ['选择过载'],
  cognitionCandidates: candidates,
});
assert.equal(invalid.intent.cognitionTarget, undefined, '不接受模型自造的节点 token');
assert.deepEqual(invalid.intent.knowledgeTargets, ['选择过载']);
assert.equal(stripReviewIntentMarkers('问题\n[认知意图:无]\n[意图:无]'), '问题');

const selected = candidates[0] as ReviewCognitionIntentCandidate;
const questionIntent = {
  version: 1 as const,
  questionMessageId: 'tutor-1',
  knowledgeTargets: ['选择过载'],
  cognitionTarget: { ...selected.reference, purpose: 'give_condition' as const },
};
const episode = {
  id: 'review-1',
  startedAt: '2026-01-01T00:00:00.000Z',
  endedAt: '2026-01-01T00:02:00.000Z',
  questionText: '开场问题',
  knowledgeContext: '参考内容',
  messages: [
    { id: 'tutor-1', role: 'assistant' as const, content: '在什么条件下不成立？', timestamp: '2026-01-01T00:00:10.000Z' },
    { id: 'user-1', role: 'user' as const, content: '如果选项差异很明显，增加选项未必会降低满意度。', timestamp: '2026-01-01T00:00:30.000Z' },
  ],
  answerEvidence: [{
    messageId: 'user-1',
    answer: '如果选项差异很明显，增加选项未必会降低满意度。',
    hintLevel: 0 as const,
    targetKnowledgeNames: ['选择过载'],
    questionIntent,
  }],
};
const observations = reviewCognitionObservations(episode, { id: 'note-1', title: '选择过载' });
assert.equal(observations.length, 1);
assert.deepEqual(observations[0].questionIntent, questionIntent, '认知候选保留问题生成时的坐标');

assert.throws(() => reviewCognitionObservations({
  ...episode,
  answerEvidence: [{ ...episode.answerEvidence[0], questionIntent: { ...questionIntent, questionMessageId: 'tutor-forged' } }],
}, { title: '选择过载' }), /不匹配/);

const inherited = inheritReviewQuestionIntent(questionIntent, 'tutor-reanswer');
assert.equal(inherited.questionMessageId, 'tutor-reanswer');
assert.deepEqual(inherited.cognitionTarget, questionIntent.cognitionTarget, '强提示后的无提示重答保持原坐标和目的');
inherited.knowledgeTargets.push('新知识点');
assert.deepEqual(questionIntent.knowledgeTargets, ['选择过载'], '坐标继承不得共享可变知识点数组');
assert.equal(parseReviewTutorIntent('解释两者关系？\n[认知意图:C1|connect_nodes]', {
  questionMessageId: 'tutor-multiple', allowedKnowledgeTargets: ['选择过载'], cognitionCandidates: candidates,
}).intent.cognitionTarget, undefined, '单坐标协议不能冒充已定位两个节点');
assert.equal(cognitionIntentCandidates({ ...retrieval, items: [{ ...retrieval.items[0], text: '原文'.repeat(400) }] })[0].textTruncated, true);
const duplicate = parseReviewTutorIntent('问题？\n[意图:选择过载]\n[意图:选择过载]\n[认知意图:C1|give_condition]', {
  questionMessageId: 'tutor-duplicate', allowedKnowledgeTargets: ['选择过载'], cognitionCandidates: candidates,
});
assert.equal(duplicate.cleanText, '问题？');
assert.equal(duplicate.intent.cognitionTarget, undefined, '重复意图标记不能形成可信认知坐标');
assert.deepEqual(duplicate.intent.knowledgeTargets, []);

console.log('复习认知意图协议检查通过（含强提示目标继承、单坐标边界与截断标记）');
