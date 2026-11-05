import assert from 'node:assert/strict';
import {
  emptyLearningEpisodeFile,
  normalizeLearningEpisodeFile,
  upsertEpisodeInFile,
} from '../src/services/memory/types.ts';
import {
  extractFlowEvidence,
  extractPlanEvidence,
  extractQaEvidence,
  extractReviewEvidence,
  extractSceneEvidence,
  summarizeDerivationProcess,
  summarizePlan,
} from '../src/services/memory/evidenceExtractor.ts';
import { renderTaskFulfillmentSummary, summarizeTaskFulfillment } from '../src/services/memory/taskFulfillment.ts';
import { buildArgumentRagText } from '../src/services/argumentDoc/ragText.ts';
import { assessArgumentDoc, createPublishedSnapshot } from '../src/services/argumentDoc/quality.ts';
import {
  aggregateLearningHabits,
  buildLearningHabitContext,
} from '../src/services/memory/learningHabitAggregator.ts';
import {
  buildPlanPersonalizationPolicy,
  renderPlanPersonalizationPolicy,
} from '../src/services/memory/planPersonalization.ts';
import { applyProfileEvidenceGate } from '../src/services/profile/evidenceGateCore.ts';
import {
  evaluateEpisodeMemory,
  evaluateProfileSignal,
  getInteractionMemoryRule,
} from '../src/services/memory/interactionMemoryPolicy.ts';

const now = new Date().toISOString();
const episode = {
  id: 'flow-check',
  type: 'flow',
  status: 'pending_analysis',
  title: '存储自检',
  startedAt: now,
  endedAt: now,
  createdAt: now,
  updatedAt: now,
};

assert.equal(getInteractionMemoryRule('navigation').retention, 'discard');
assert.equal(getInteractionMemoryRule('note-edit').retention, 'artifact');
assert.equal(getInteractionMemoryRule('derivation-attempt').retention, 'session');
assert.equal(getInteractionMemoryRule('review-completion').retention, 'episode');
assert.equal(evaluateEpisodeMemory(episode).eligibleForContext, false, '待分析事件只能用于恢复');
assert.equal(evaluateEpisodeMemory({ ...episode, status: 'completed' }).persist, false, '空活动不得形成长期记忆');
assert.equal(evaluateEpisodeMemory({ ...episode, status: 'completed', durationSeconds: 90 }).persist, true);

const unscoredBehavior = {
  sourceEpisodeId: 'policy-check', dimension: 'cognitive_style', indicator: 'systematicVsScattered',
  value: 40, confidence: 0.9, evidenceType: 'observed', observedAt: now,
};
assert.equal(evaluateProfileSignal(unscoredBehavior, 500).action, 'reject', '单次观察不得直接写画像');
assert.equal(
  evaluateProfileSignal({
    ...unscoredBehavior,
    dimension: 'ability',
    evidenceType: 'explicit',
    evidenceSnippetIds: ['policy-check-e0'],
    matchedCriteria: ['user-explicit'],
  }, 500).action,
  'reject',
  '能力不能由用户自评直接写入画像',
);
const tracedSceneScore = {
  sourceEpisodeId: 'policy-check', dimension: 'ability', indicator: 'reasoningValidity',
  value: 80, confidence: 0.75, evidenceType: 'scored', observedAt: now,
  evidenceSnippetIds: ['policy-check-e1'], matchedCriteria: ['finalScore'], rubricVersion: 'scene-s4-v1',
};
assert.equal(evaluateProfileSignal(tracedSceneScore, 5).action, 'accept', '可验证计算评分不依赖文本长度');
assert.equal(
  evaluateProfileSignal({ ...tracedSceneScore, rubricVersion: 'review-analysis-v1' }, 20).action,
  'reject',
  '短文本评分不得进入长期画像',
);

const inserted = upsertEpisodeInFile(emptyLearningEpisodeFile(), episode);
assert.equal(inserted.episodes.length, 1);

const completed = upsertEpisodeInFile(inserted, { ...episode, status: 'completed' });
assert.equal(completed.episodes.length, 1, '相同事件 id 必须覆盖而不是重复追加');
assert.equal(completed.episodes[0].status, 'completed');

const recovered = normalizeLearningEpisodeFile({
  version: 999,
  episodes: [null, { ...completed.episodes[0], transcript: [{ content: '不应长期保留' }], evidenceText: '原始复述' }, { id: 'broken' }],
});
assert.equal(recovered.version, 2, '旧版文件读取后必须迁移到当前版本');
assert.equal(recovered.episodes.length, 1, '损坏事件必须在 IPC 信任边界被过滤');
assert.equal('transcript' in recovered.episodes[0], false, '旧版完整对话必须在读取时剥离');
assert.equal('evidenceText' in recovered.episodes[0], false, '旧版原始复述必须在读取时剥离');

const reviewEvidence = extractReviewEvidence({
  episodeId: 'review-check',
  observedAt: now,
  knowledgePoints: ['二次函数'],
  messages: Array.from({ length: 12 }, (_, index) => ({
    role: index % 2 === 0 ? 'assistant' : 'user',
    content: `第 ${index} 条可见对话，${'回答'.repeat(index + 1)}`,
    timestamp: now,
  })),
  analysis: {
    accuracyScore: 60,
    completenessScore: 55,
    logicScore: 50,
    relevanceScore: 70,
    overallRating: 'hard',
    feedback: '存在概念混淆',
    suggestion: '复习定义',
    missingKnowledge: ['顶点式的参数含义', '判别式'],
  },
});
assert.ok(reviewEvidence.evidenceSnippets.length <= 5, '长期证据最多保留五条');
assert.ok(reviewEvidence.evidenceSnippets.every((item) => item.text.length <= 501));
assert.ok(!reviewEvidence.profileSignals.some((item) => item.dimension === 'knowledge_mastery'), 'overall review score is not per-knowledge mastery in current mode');
assert.ok(!reviewEvidence.profileSignals.some((item) => item.dimension === 'ability'), 'retired overall scores cannot enter current profile without validated criterion evidence');
assert.ok(reviewEvidence.evidenceSnippets.every((item) => item.id), '压缩证据必须有可回溯 id');
assert.ok(reviewEvidence.profileSignals.some((item) => item.evidenceSnippetIds?.length), '画像信号必须引用压缩证据');

const flowEvidence = extractFlowEvidence({
  episodeId: 'flow-check',
  observedAt: now,
  report: { clarityScore: 72, summary: '能够解释核心概念', sections: [] },
  profileInsight: {
    concepts: [],
    cognitiveStyle: { systematicVsScattered: 35 },
    layeredScores: {
      raw: { concept: 70, judgment: 60, logic: 50 },
      penalty: { concept: 0, judgment: 0, logic: 0 },
      final: { concept: 70, judgment: 60, logic: 50 },
      grade: { concept: '良好', judgment: '一般', logic: '一般' },
    },
  },
});
assert.ok(flowEvidence.profileSignals.some((item) => item.indicator === 'systematicVsScattered'));

const sceneEvidence = extractSceneEvidence({
  episodeId: 'scene-check',
  observedAt: now,
  spec: { meta: { sceneSkill: 'S4', knowledgePoints: ['一元二次方程'] } },
  run: {
    status: 'success',
    endReason: '推导完成',
    turnCount: 2,
    messages: [],
    finalScore: 0.8,
    derivationEvents: [
      { type: 'node_submit', nodeId: 'step-1', latex: 'x=3', at: now },
      { type: 'node_verify', nodeId: 'step-1', result: 'fail', details: {}, at: now },
      { type: 'node_edit', nodeId: 'step-1', oldLatex: 'x=3', newLatex: 'x=2', at: now },
      { type: 'node_submit', nodeId: 'step-1', latex: 'x=2', at: now },
      { type: 'node_verify', nodeId: 'step-1', result: 'pass', details: {}, at: now },
    ],
    canvas: {
      helpUsed: 1,
      nodes: [{ type: 'conclusion', data: { latex: 'x=2', status: 'pass' } }],
    },
  },
});
assert.ok(sceneEvidence.evidenceSnippets.some((item) => item.text === 'x=2'));
assert.ok(sceneEvidence.evidenceSnippets.some((item) => item.type === 'correction' && item.text.includes('修正后通过 1 个步骤')));
assert.ok(sceneEvidence.profileSignals.some((item) => item.indicator === 'reasoningValidity' && item.value === 80));
assert.deepEqual(summarizeDerivationProcess({
  derivationEvents: [
    { type: 'node_verify', nodeId: 'n1', result: 'fail' },
    { type: 'node_edit', nodeId: 'n1' },
    { type: 'node_verify', nodeId: 'n1', result: 'pass' },
  ],
}), {
  submitCount: 0,
  editCount: 1,
  passCount: 1,
  warnCount: 0,
  failCount: 1,
  correctedNodeCount: 1,
});

const taskSummary = summarizeTaskFulfillment([{
  dueDates: [
    { dueDate: '2026-09-25', completed: true, completedAt: '2026-09-24T10:00:00.000Z' },
    { dueDate: '2026-09-25', completed: true, completedAt: '2026-09-26T10:00:00.000Z' },
    { dueDate: '2026-09-27', completed: true, completedAt: '2026-09-27T10:00:00.000Z' },
    { dueDate: '2026-09-20', completed: false },
    { dueDate: '2026-09-20', completed: true },
  ],
}], '2026-09-27T12:00:00.000Z');
assert.deepEqual(taskSummary, { trackedCompleted: 3, onTimeCompleted: 2, lateCompleted: 1, averageLateDays: 1, overdueOpen: 1 });
assert.equal(renderTaskFulfillmentSummary(taskSummary), '近28天有时间证据的任务完成 3 项，按时率 67%；当前逾期未完成 1 项');

const habitEpisode = (id, type, endedAt, profileSignals, durationSeconds = 900) => ({
  id, type, status: 'completed', title: id, startedAt: endedAt, endedAt, durationSeconds,
  profileSignals: profileSignals.map(([indicator, value]) => ({
    sourceEpisodeId: id, dimension: 'learning_habit', indicator, value,
    confidence: 1, evidenceType: 'observed', observedAt: endedAt,
  })),
  createdAt: endedAt, updatedAt: endedAt,
});
const habitEpisodes = [
  habitEpisode('review-1', 'review', '2026-09-21T10:00:00.000Z', [['reviewAnswerCount', 6], ['reviewAnswerChars', 180]]),
  habitEpisode('review-2', 'review', '2026-09-22T10:00:00.000Z', [['reviewAnswerCount', 5], ['reviewAnswerChars', 160]]),
  habitEpisode('review-3', 'review', '2026-09-23T10:00:00.000Z', [['reviewAnswerCount', 4], ['reviewAnswerChars', 120]]),
  habitEpisode('scene-1', 'scene', '2026-09-21T11:00:00.000Z', [['derivationSubmitCount', 4], ['derivationFailureCount', 2], ['derivationCorrectionCount', 1], ['sceneHelpCount', 1]]),
  habitEpisode('scene-2', 'scene', '2026-09-22T11:00:00.000Z', [['derivationSubmitCount', 3], ['derivationFailureCount', 1], ['derivationCorrectionCount', 1], ['sceneHelpCount', 0]]),
  habitEpisode('scene-3', 'scene', '2026-09-23T11:00:00.000Z', [['derivationSubmitCount', 3], ['derivationFailureCount', 1], ['derivationCorrectionCount', 1], ['sceneHelpCount', 1]]),
  habitEpisode('plan-1', 'plan', '2026-09-21T12:00:00.000Z', [['planNodeCount', 10], ['scheduledPlanNodeCount', 8]], 0),
  habitEpisode('plan-2', 'plan', '2026-09-22T12:00:00.000Z', [['planNodeCount', 8], ['scheduledPlanNodeCount', 4]], 0),
  habitEpisode('plan-3', 'plan', '2026-09-23T12:00:00.000Z', [['planNodeCount', 12], ['scheduledPlanNodeCount', 9]], 0),
];
const habitTasks = Array.from({ length: 8 }, (_, index) => ({
  id: `task-${index}`,
  dueDate: index < 6 ? '2026-09-24' : '2026-09-22',
  completed: true,
  completedAt: index % 3 === 0 ? '2026-09-21T08:00:00.000Z' : index % 3 === 1 ? '2026-09-22T08:00:00.000Z' : '2026-09-23T08:00:00.000Z',
}));
const habits = aggregateLearningHabits({
  now: '2026-09-27T12:00:00.000Z',
  episodes: habitEpisodes,
  timeline: {
    version: 1,
    weeks: [{
      weekStart: '2026-09-21', weekEnd: '2026-09-27', newMastered: 0, masteredCount: 0,
      reasoning: { conceptScore: 0, judgmentScore: 0, logicScore: 0, vulnerabilityCount: 0, vulnerabilityBreakdown: {} },
      analysisCount: 0,
      study: { activeDays: 3, dailyMinutes: [25, 30, 25, 0, 0, 0, 0], dailyReviewActive: [1, 1, 1, 0, 0, 0, 0] },
      errorRate: 0,
    }],
  },
  notes: [{ id: 'project-1', dueDates: habitTasks }],
});
assert.equal(habits.studyRhythm.status, 'trusted');
assert.equal(habits.reviewPattern.status, 'trusted');
assert.equal(habits.correctionPattern.status, 'trusted');
assert.equal(habits.executionPattern.status, 'trusted');
assert.equal(habits.planningPattern.status, 'trusted');
assert.equal(habits.reviewPattern.qualifiedReviewRate, 66.7);
assert.equal(habits.correctionPattern.helpUsageRate, 20);
assert.equal(habits.correctionPattern.correctionRecoveryRate, 75);
assert.ok(buildLearningHabitContext(habits).includes('错误修正成功率 75%'));
const sparseHabits = aggregateLearningHabits({
  now: '2026-09-27T12:00:00.000Z',
  episodes: habitEpisodes.slice(0, 1),
  timeline: { version: 1, weeks: [] },
  notes: [],
});
assert.equal(sparseHabits.reviewPattern.status, 'provisional');
assert.equal(buildLearningHabitContext(sparseHabits).includes('复习互动'), false, '暂定习惯不得注入模型上下文');

const argumentDocForRag = {
  doc_id: 'doc-1', title: '论证测试', created_at: now, updated_at: now, iteration: 1, status: 'draft',
  nodes: [
    { id: 'a', mainType: '事实陈述', text: '练习能增加熟练度', position: { x: 0, y: 0 }, status: 'ok', issue: null, severity: null, suggestion: null, user_edited: false, collapsed: false },
    { id: 'b', mainType: '推理', text: '因此刻意练习能提升表现', position: { x: 1, y: 1 }, status: 'edited', issue: null, severity: null, suggestion: null, user_edited: true, collapsed: false },
  ],
  edges: [{ id: 'e1', source: 'a', target: 'b', relation: 'support' }],
};
const argumentAssessment = assessArgumentDoc(argumentDocForRag, now);
argumentDocForRag.rag = {
  sourceKind: 'user_graph',
  draftAssessment: argumentAssessment,
  publishedSnapshot: createPublishedSnapshot(argumentDocForRag, argumentAssessment, now),
};
const argumentRagText = buildArgumentRagText(argumentDocForRag);
assert.ok(argumentRagText.includes('练习能增加熟练度 支持 因此刻意练习能提升表现'));

const qaEvidence = extractQaEvidence({ episodeId: 'qa-check', observedAt: now, question: '为什么判别式小于零时没有实根？' });
assert.equal(qaEvidence.evidenceSnippets.length, 1);
assert.ok(qaEvidence.profileSignals.every((item) => item.dimension === 'learning_habit'));

const planTree = [{ key: 'root', title: '学习微积分', dueDate: '2026-10-01', children: [
  { key: 'child', title: '掌握导数', children: [] },
] }];
assert.deepEqual(summarizePlan(planTree), {
  nodeCount: 2,
  scheduledCount: 1,
  titles: ['学习微积分', '掌握导数'],
});
assert.equal(extractPlanEvidence({ episodeId: 'plan-check', observedAt: now, tree: planTree }).evidenceSnippets.length, 1);

const baseProfile = {
  version: 2,
  updatedAt: now,
  analysisCount: 0,
  ability: {
    conceptClarity: 50,
    judgmentReasonableness: 50,
    reasoningValidity: 50,
    evidenceCount: 0,
    evidenceChars: 0,
  },
  cognitiveStyle: {
    abstractVsConcrete: 0,
    systematicVsScattered: 0,
    divergentVsConvergent: 0,
    cautiousVsDogmatic: 0,
    deepVsSurface: 0,
  },
  learningAbility: {
    masteredCount: 0,
    currentStreak: 0,
    newMasteredThisWeek: 0,
    newMasteredLastWeek: 0,
    errorWeekly: [],
    reasoningWeekly: [],
    studyWeekly: [],
    domains: [],
  },
};
const decisionProfile = {
  ...baseProfile,
  analysisCount: 3,
  ability: { ...baseProfile.ability, conceptClarity: 38 },
  cognitiveStyle: { ...baseProfile.cognitiveStyle, systematicVsScattered: -60 },
  evidenceGate: {
    version: 1,
    processedEpisodeIds: ['profile-1', 'profile-2'],
    aggregates: {
      'ability:conceptClarity': {
        dimension: 'ability', indicator: 'conceptClarity', status: 'trusted', mean: 38, confidence: 0.8,
        samples: [{ episodeId: 'profile-1', value: 36, weight: 0.8, observedAt: '2026-09-20T10:00:00.000Z' }],
        updatedAt: now,
      },
      'cognitive_style:systematicVsScattered': {
        dimension: 'cognitive_style', indicator: 'systematicVsScattered', status: 'holding', mean: -60, confidence: 0.8,
        samples: [{ episodeId: 'profile-2', value: -60, weight: 0.8, observedAt: '2026-09-21T10:00:00.000Z' }],
        updatedAt: now,
      },
    },
  },
};
const planPolicy = buildPlanPersonalizationPolicy({
  profile: decisionProfile,
  habits: sparseHabits,
  query: '学习微积分',
  relevantKnowledgeNotes: [{
    id: 'knowledge-limit', title: '极限', content: '', noteType: 'knowledge', tags: [], links: [], backlinks: [], dueDates: [],
    createdAt: now, updatedAt: now,
    dsrState: { difficulty: 5, stability: 2, lastReviewedAt: now, reviewCount: 1, consecutiveCorrect: 0, consecutiveWrong: 1, conceptMastery: 42, conceptMasterySamples: 2 },
  }],
});
assert.ok(planPolicy.decisions.some((item) => item.id === 'ability-conceptClarity-support'));
assert.ok(planPolicy.decisions.some((item) => item.id === 'knowledge-content-knowledge-limit'), 'missing reference content is not an assertion of current non-mastery');
assert.equal(planPolicy.decisions.some((item) => item.id === 'style-explicit-dependencies'), false, '观察中的画像不得改变计划');
assert.ok(planPolicy.deferred.some((item) => item.label === '复习互动'), '暂定习惯只记录为未采用');
assert.ok(renderPlanPersonalizationPolicy(planPolicy).includes('用户本次明确填写'));
const abilitySignal = (episodeId, value, observedAt) => ({
  sourceEpisodeId: episodeId,
  dimension: 'ability',
  indicator: 'reasoningValidity',
  value,
  confidence: 0.8,
  evidenceType: 'scored',
  observedAt,
  evidenceSnippetIds: [`${episodeId}-e1`],
  matchedCriteria: ['logicScore'],
  rubricVersion: 'check-v1',
});
const explicitStyleGate = applyProfileEvidenceGate(baseProfile, {
  episodeId: 'explicit-style-1',
  signals: [{
    sourceEpisodeId: 'explicit-style-1',
    dimension: 'cognitive_style',
    indicator: 'systematicVsScattered',
    value: 45,
    confidence: 0.9,
    evidenceType: 'explicit',
    observedAt: '2026-01-01T10:00:00.000Z',
    evidenceSnippetIds: ['explicit-style-1-e1'],
    matchedCriteria: ['user-explicit'],
  }],
  sampleChars: 20,
});
assert.equal(explicitStyleGate.decisions[0].action, 'hold', '单次明确陈述也不能直接修改长期画像');
const firstGate = applyProfileEvidenceGate(baseProfile, {
  episodeId: 'gate-1',
  signals: [abilitySignal('gate-1', 40, '2026-01-01T10:00:00.000Z')],
  sampleChars: 200,
});
assert.equal(firstGate.decisions[0].action, 'hold');
assert.equal(firstGate.profile.ability.reasoningValidity, 50, '单次评分不得改变长期能力画像');

const secondGate = applyProfileEvidenceGate(firstGate.profile, {
  episodeId: 'gate-2',
  signals: [abilitySignal('gate-2', 44, '2026-01-02T10:00:00.000Z')],
  sampleChars: 180,
});
assert.equal(secondGate.decisions[0].action, 'aggregate');
assert.ok(secondGate.profile.ability.reasoningValidity < 50, '一致的独立证据达到门槛后才更新画像');
assert.equal(secondGate.profile.ability.evidenceCount, 2);
assert.equal(secondGate.profile.ability.evidenceChars, 380);
assert.equal(secondGate.profile.evidenceGate.aggregates['ability:reasoningValidity'].samples[0].rubricVersion, 'check-v1');

const conflictingGate = applyProfileEvidenceGate(secondGate.profile, {
  episodeId: 'gate-3',
  signals: [abilitySignal('gate-3', 95, '2026-01-03T10:00:00.000Z')],
  sampleChars: 160,
});
assert.equal(
  conflictingGate.profile.evidenceGate.aggregates['ability:reasoningValidity'].status,
  'holding',
  '可信画像遇到明显冲突证据后必须允许退回观察态',
);

const duplicateGate = applyProfileEvidenceGate(secondGate.profile, {
  episodeId: 'gate-2',
  signals: [abilitySignal('gate-2', 10, '2026-01-02T10:00:00.000Z')],
  sampleChars: 999,
});
assert.equal(duplicateGate.duplicate, true);
assert.equal(duplicateGate.profile.ability.reasoningValidity, secondGate.profile.ability.reasoningValidity);

console.log('memory store check passed');
