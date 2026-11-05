import assert from 'node:assert/strict';
import { scoreCognitiveStyle } from '../src/services/profile/scoring/styleScoring';
import {
  determineMasteryLevel,
  scoreConceptEvidence,
  scoreJudgmentEvidence,
  scoreReasoningEvidence,
} from '../src/services/profile/scoring/threeLayer';
import { aggregateLearningAbility, computeCurrentStreak } from '../src/services/learningAbility/aggregator';
import { buildProfileEvidenceDetails } from '../src/services/profile/profileEvidenceQuery';
import { getDefaultUserProfile } from '../src/services/profile/profileStore';
import type { LearningEpisode } from '../src/services/memory/types';
import { resetForRerun } from '../src/services/scene/sceneRuntime';
import type { NoteItem, SceneRunState, SceneSpec } from '../src/types';
import {
  buildKnowledgeStateContext,
  composeMemoryContext,
  hasMemoryContextRecipe,
  selectRelevantEpisodes,
} from '../src/services/memory/memoryContextBuilder';
import { adjustPlanAfterNoteUpdate } from '../src/services/planAdjustmentService';
import { collectProjectKnowledgeNotes } from '../src/services/knowledgePointSelector';
import { applyProjectReviewOutcome, buildReviewSchedule } from '../src/services/reviewScheduler';

const unknownStyle = scoreCognitiveStyle({});
assert.equal(unknownStyle.abstractVsConcrete, undefined, '无锚点必须保持未知，不能伪装成中性 0');
assert.equal(scoreCognitiveStyle({ usesAbstractTerms: true }).abstractVsConcrete, 25);

assert.equal(scoreConceptEvidence({}), null);
assert.equal(scoreJudgmentEvidence({}), null);
assert.equal(scoreReasoningEvidence({}), null);
assert.equal(determineMasteryLevel(null, null, null), 'none', '全空证据不得误判为已触及推理层');
assert.equal(determineMasteryLevel(15, null, null), 'reasoning');

const yesterday = new Date();
yesterday.setDate(yesterday.getDate() - 1);
const weekday = yesterday.getDay();
const dayIndex = weekday === 0 ? 6 : weekday - 1;
const monday = new Date(yesterday);
monday.setHours(0, 0, 0, 0);
monday.setDate(yesterday.getDate() - dayIndex);
const fmt = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const reviewDays = [0, 0, 0, 0, 0, 0, 0];
reviewDays[dayIndex] = 1;

assert.equal(computeCurrentStreak({
  version: 1,
  weeks: [{
    weekStart: fmt(monday),
    weekEnd: fmt(new Date(monday.getTime() + 6 * 86400000)),
    newMastered: 0,
    masteredCount: 0,
    reasoning: { conceptScore: 0, judgmentScore: 0, logicScore: 0, vulnerabilityCount: 0, vulnerabilityBreakdown: {} },
    analysisCount: 0,
    study: { activeDays: 1, dailyMinutes: [0, 0, 0, 0, 0, 0, 0], dailyReviewActive: reviewDays },
    errorRate: 0,
  }],
}), 1, '达标复习也必须计入连续学习天数');

const now = new Date().toISOString();
const evidenceProfile = getDefaultUserProfile();
evidenceProfile.evidenceGate = {
  version: 1,
  processedEpisodeIds: ['scene-evidence'],
  aggregates: {
    'ability:reasoningValidity': {
      dimension: 'ability',
      indicator: 'reasoningValidity',
      status: 'holding',
      mean: 80,
      confidence: 0.7,
      samples: [{
        episodeId: 'scene-evidence',
        value: 80,
        weight: 0.7,
        observedAt: now,
        evidenceSnippetIds: ['scene-evidence-e1'],
        matchedCriteria: ['finalScore'],
        rubricVersion: 'scene-s4-v1',
      }],
      updatedAt: now,
    },
  },
};
const sceneEpisode: LearningEpisode = {
  id: 'scene-evidence',
  type: 'scene',
  status: 'completed',
  title: '二次方程推导',
  startedAt: now,
  endedAt: now,
  evidenceSnippets: [{
    id: 'scene-evidence-e1',
    type: 'success',
    text: 'x=2',
    importance: 0.9,
    source: 'user_statement',
  }],
  createdAt: now,
  updatedAt: now,
};
const evidenceDetails = buildProfileEvidenceDetails(evidenceProfile, [sceneEpisode]);
assert.equal(evidenceDetails[0].samples[0].episodeTitle, '二次方程推导');
assert.equal(evidenceDetails[0].samples[0].evidenceSnippets[0].text, 'x=2');

const rerunSpec = {
  sceneId: 'scene-1',
  meta: { name: '重跑检查' },
  metrics: [],
  events: [],
  openingNarrative: '',
} as SceneSpec;
const previousRun = {
  runId: 'old-run',
  overrides: {},
} as SceneRunState;
const rerun = resetForRerun(rerunSpec, previousRun);
assert.notEqual(rerun.runId, previousRun.runId, '反事实重跑必须生成独立 runId，避免覆盖上一局记忆');

assert.equal(hasMemoryContextRecipe('review-tutor'), true);
assert.equal(hasMemoryContextRecipe('plan-generation'), true);
assert.equal(hasMemoryContextRecipe('scene-generate'), true);
assert.equal(hasMemoryContextRecipe('review-scoring'), false, '客观评分不得获得个性化记忆配方');
assert.equal(hasMemoryContextRecipe('profile-evidence-layered'), false, '画像证据提取必须保持盲评');

const unrelatedEpisode: LearningEpisode = {
  ...sceneEpisode,
  id: 'unrelated',
  title: '英语口语练习',
  knowledgePoints: ['过去完成时'],
  evidenceSnippets: [{ id: 'unrelated-e1', type: 'observation', text: '时态练习', importance: 0.5, source: 'user_statement' }],
};
const selectedMemory = selectRelevantEpisodes(
  [unrelatedEpisode, { ...sceneEpisode, knowledgePoints: ['二次方程'] }],
  '二次方程',
  ['scene'],
  3,
);
assert.deepEqual(selectedMemory.selected.map((item) => item.id), ['scene-evidence']);

const knowledgeNotes = [
  {
    id: 'kp-trusted', title: '二次方程', content: '', noteType: 'knowledge', tags: [], links: [], backlinks: [], dueDates: [],
    createdAt: now, updatedAt: now,
    dsrState: {
      difficulty: 6, stability: 4, lastReviewedAt: now, reviewCount: 3,
      consecutiveCorrect: 1, consecutiveWrong: 2, conceptMastery: 68, conceptMasterySamples: 3,
    },
  },
  {
    id: 'kp-new', title: '判别式', content: '', noteType: 'knowledge', tags: [], links: [], backlinks: [], dueDates: [],
    createdAt: now, updatedAt: now,
  },
  {
    id: 'kp-provisional', title: '配方法', content: '', noteType: 'knowledge', tags: [], links: [], backlinks: [], dueDates: [],
    createdAt: now, updatedAt: now,
    dsrState: {
      difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 1,
      consecutiveCorrect: 0, consecutiveWrong: 0, conceptMastery: 45, conceptMasterySamples: 1,
    },
  },
  {
    id: 'unrelated-kp', title: '无关知识点', content: '', noteType: 'knowledge', tags: [], links: [], backlinks: [], dueDates: [],
    createdAt: now, updatedAt: now,
  },
] satisfies NoteItem[];
const knowledgeState = buildKnowledgeStateContext(knowledgeNotes, ['kp-trusted', 'kp-new', 'kp-provisional']);
assert.deepEqual(knowledgeState.sourceIds, ['kp-trusted', 'kp-new', 'kp-provisional']);
assert.match(knowledgeState.text, /二次方程.*68%（3次证据）/);
assert.match(knowledgeState.text, /连续错误 2 次/);
assert.match(knowledgeState.text, /判别式.*尚无掌握评估/);
assert.match(knowledgeState.text, /配方法.*45%（暂定，证据不足）/);
assert.doesNotMatch(knowledgeState.text, /无关知识点/);

const delayedRoot = {
  id: 'plan-root', title: '数学计划', content: '', noteType: 'project', tags: [], links: [], backlinks: [],
  dueDates: [{ id: 'root-task', noteId: 'plan-root', noteTitle: '数学计划', taskText: '完成数学计划', dueDate: '2026-10-10', completed: false, priority: 'high' }],
  createdAt: now, updatedAt: now,
} satisfies NoteItem;
const delayedChild = {
  id: 'plan-child', title: '进阶阶段', content: '', noteType: 'project', parentId: 'plan-root', tags: [], links: [], backlinks: [],
  dueDates: [
    { id: 'child-task-1', noteId: 'plan-child', noteTitle: '进阶阶段', taskText: '完成基础阶段', dueDate: '2026-09-20', completed: false, priority: 'high' },
    { id: 'child-task-2', noteId: 'plan-child', noteTitle: '进阶阶段', taskText: '完成进阶阶段', dueDate: '2026-09-25', completed: false, priority: 'medium' },
  ],
  createdAt: now, updatedAt: now,
} satisfies NoteItem;
const delayedChildCompleted: NoteItem = {
  ...delayedChild,
  dueDates: delayedChild.dueDates.map((item, index) => index === 0 ? { ...item, completed: true } : item),
};
const otherProject = {
  id: 'other-plan', title: '英语计划', content: '', noteType: 'project', tags: [], links: [], backlinks: [],
  dueDates: [{ id: 'other-task', noteId: 'other-plan', noteTitle: '英语计划', taskText: '背单词', dueDate: '2026-09-25', completed: false, priority: 'medium' }],
  createdAt: now, updatedAt: now,
} satisfies NoteItem;
const delayedAdjustment = adjustPlanAfterNoteUpdate(
  [delayedRoot, delayedChildCompleted, otherProject], delayedChild, delayedChildCompleted, '2026-09-23T08:00:00.000Z',
);
assert.equal(delayedAdjustment.notes.find((note) => note.id === 'plan-child')?.dueDates[1].dueDate, '2026-09-28');
assert.equal(delayedAdjustment.notes.find((note) => note.id === 'plan-child')?.dueDates[1].originalDueDate, '2026-09-25');
assert.equal(delayedAdjustment.notes.find((note) => note.id === 'plan-root')?.dueDates[0].dueDate, '2026-10-10', '根项目目标日期不得自动移动');
assert.equal(delayedAdjustment.notes.find((note) => note.id === 'other-plan')?.dueDates[0].dueDate, '2026-09-25', '不得调整其他根项目');
const adjustedChild = delayedAdjustment.notes.find((note) => note.id === 'plan-child')!;
const uncheckedChild: NoteItem = { ...adjustedChild, dueDates: adjustedChild.dueDates.map((item, index) => index === 0 ? { ...item, completed: false } : item) };
const recheckedChild: NoteItem = { ...uncheckedChild, dueDates: uncheckedChild.dueDates.map((item, index) => index === 0 ? { ...item, completed: true } : item) };
const repeatedCompletion = adjustPlanAfterNoteUpdate(
  [delayedRoot, recheckedChild], uncheckedChild, recheckedChild, '2026-09-24T08:00:00.000Z',
);
assert.equal(repeatedCompletion.notes.find((note) => note.id === 'plan-child')?.dueDates[1].dueDate, '2026-09-28', '同一完成事件不得重复顺延');

const sharedKnowledge: NoteItem = {
  id: 'shared-kp', title: '共享知识点', aliases: ['shared-alias'], content: '', noteType: 'knowledge', tags: [], links: [], backlinks: [], dueDates: [],
  createdAt: now, updatedAt: now,
  dsrState: { difficulty: 5, stability: 2, lastReviewedAt: null, reviewCount: 0, consecutiveCorrect: 0, consecutiveWrong: 0, conceptMastery: 35, conceptMasterySamples: 2 },
};
const projectA: NoteItem = { ...delayedRoot, id: 'project-a', title: '项目 A', links: ['共享知识点'], dueDates: [] };
const projectB: NoteItem = { ...delayedRoot, id: 'project-b', title: '项目 B', links: ['shared-alias'], dueDates: [] };
const relationNotes = [projectA, projectB, sharedKnowledge];
assert.deepEqual(collectProjectKnowledgeNotes(projectA.id, relationNotes).map((note) => note.id), ['shared-kp']);
assert.deepEqual(collectProjectKnowledgeNotes(projectB.id, relationNotes).map((note) => note.id), ['shared-kp'], '别名链接也必须解析到同一全局知识点');
const reviewSchedule = buildReviewSchedule(relationNotes, Date.parse('2026-09-27T08:00:00.000Z'));
assert.deepEqual(reviewSchedule.knowledge.map((item) => item.noteId), ['shared-kp'], '共享知识点在全局队列中只能出现一次');
assert.deepEqual(reviewSchedule.projects.map((item) => item.noteId).sort(), ['project-a', 'project-b'], '同一知识点可以同时触发多个关联项目的复习建议');
assert.equal(sharedKnowledge.dueDates.length, 0, '复习排期不得写入普通 dueDates');
const linkedDomains = aggregateLearningAbility(relationNotes, { version: 1, weeks: [] });
assert.deepEqual(linkedDomains.domains.map((item) => item.projectTitle).sort(), ['项目 A', '项目 B'], '领域画像必须支持一个知识点归入多个项目');
const projectReviewedDsr = applyProjectReviewOutcome(sharedKnowledge.dsrState!, '2026-09-27T09:00:00.000Z', true);
assert.equal(projectReviewedDsr.reviewCount, 1);
assert.equal(projectReviewedDsr.lastReviewedAt, '2026-09-27T09:00:00.000Z');
assert.equal(projectReviewedDsr.consecutiveCorrect, 1);
const afterProjectReview = buildReviewSchedule(
  [projectA, projectB, { ...sharedKnowledge, dsrState: projectReviewedDsr }],
  Date.parse('2026-09-27T09:00:00.000Z'),
);
assert.equal(afterProjectReview.knowledge.length, 0, '成功完成真实复习后应退出当前到期队列');
assert.equal(afterProjectReview.projects.length, 0);

const budgetedMemory = composeMemoryContext('check', 24, [
  { kind: 'profile', text: '长期画像内容长期画像内容', maxChars: 14, sourceIds: ['profile'], reason: 'test' },
  { kind: 'rag', text: '相关笔记内容相关笔记内容', maxChars: 14, sourceIds: ['note'], reason: 'test' },
]);
assert.ok(budgetedMemory.prefix.length <= 24, '记忆前缀不得超过总字符预算');
assert.equal(budgetedMemory.trace.budgetTrimmed, true);

console.log('profile foundation check passed');
