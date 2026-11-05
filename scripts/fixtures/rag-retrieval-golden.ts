import type { RetrievalGoldenCase } from '../../src/electron/rag/retrievalEvaluation.ts';

type GoldenInput = Omit<RetrievalGoldenCase, 'locatableChunkIds'> & { unlocatable?: string[] };

function golden(input: GoldenInput): RetrievalGoldenCase {
  const unlocatable = new Set(input.unlocatable || []);
  const allCandidates = [...new Set([
    ...input.channels.passage,
    ...input.channels.entity,
    ...input.channels.argument,
  ])];
  return {
    ...input,
    locatableChunkIds: allCandidates.filter((id) => !unlocatable.has(id)),
  };
}

/**
 * 初始人工黄金集：九种确定性查询意图各 3 条，共 27 条。
 * channels 是固定索引快照的各通道排序，不是期望答案；relevance 才是人工标注。
 * 后续可用真实 vault 导出的匿名排名替换 channels，而评测器和门槛保持不变。
 */
export const RAG_RETRIEVAL_GOLDEN_SET: RetrievalGoldenCase[] = [
  golden({
    id: 'definition-cognitive-load', query: '什么是认知负荷？', expectedIntent: 'definition',
    relevance: { 'def:cognitive-load': 3 },
    channels: {
      passage: ['def:cognitive-load', 'noise:working-memory', 'noise:attention', 'noise:motivation', 'noise:metacognition', 'legacy:no-locator'],
      entity: ['def:cognitive-load', 'noise:working-memory', 'noise:attention'],
      argument: ['noise:motivation', 'def:cognitive-load', 'noise:metacognition'],
    }, unlocatable: ['legacy:no-locator'],
  }),
  golden({
    id: 'definition-retrieval-practice', query: '检索练习的定义是什么？', expectedIntent: 'definition',
    relevance: { 'def:retrieval-practice': 3 },
    channels: {
      passage: ['noise:testing', 'def:retrieval-practice', 'noise:spacing', 'noise:reading', 'noise:feedback'],
      entity: ['def:retrieval-practice', 'noise:testing', 'noise:spacing'],
      argument: ['noise:feedback', 'def:retrieval-practice', 'noise:reading'],
    },
  }),
  golden({
    id: 'definition-transfer', query: '迁移学习在这份资料中的含义是什么？', expectedIntent: 'definition',
    relevance: { 'def:transfer': 3, 'def:transfer-boundary': 1 },
    channels: {
      passage: ['def:transfer', 'noise:training', 'def:transfer-boundary', 'noise:testing', 'noise:domain'],
      entity: ['def:transfer', 'def:transfer-boundary', 'noise:domain'],
      argument: ['noise:training', 'def:transfer-boundary', 'def:transfer'],
    },
  }),

  golden({
    id: 'fact-accuracy', query: '实验中检索练习组的正确率是多少？', expectedIntent: 'fact',
    relevance: { 'fact:retrieval-accuracy': 3 },
    channels: {
      passage: ['fact:retrieval-accuracy', 'noise:sample-size', 'noise:delay', 'noise:motivation', 'noise:method'],
      entity: ['noise:sample-size', 'fact:retrieval-accuracy', 'noise:method'],
      argument: ['noise:delay', 'fact:retrieval-accuracy', 'noise:motivation'],
    },
  }),
  golden({
    id: 'fact-study-date', query: '这项间隔效应研究何时进行？', expectedIntent: 'fact',
    relevance: { 'fact:spacing-date': 3 },
    channels: {
      passage: ['noise:spacing-result', 'fact:spacing-date', 'noise:researcher', 'noise:sample', 'noise:method'],
      entity: ['noise:researcher', 'fact:spacing-date', 'noise:sample'],
      argument: ['noise:spacing-result', 'noise:method', 'fact:spacing-date'],
    },
  }),
  golden({
    id: 'fact-sample', query: '哪一组样本接受了即时反馈？', expectedIntent: 'fact',
    relevance: { 'fact:feedback-group': 3 },
    channels: {
      passage: ['fact:feedback-group', 'noise:delayed-feedback', 'noise:control-group', 'noise:accuracy', 'noise:procedure'],
      entity: ['noise:control-group', 'fact:feedback-group', 'noise:procedure'],
      argument: ['noise:accuracy', 'fact:feedback-group', 'noise:delayed-feedback'],
    },
  }),

  golden({
    id: 'relation-memory', query: '海马体和长期记忆是什么关系？', expectedIntent: 'entity_relation',
    relevance: { 'relation:hippocampus-memory': 3 },
    channels: {
      passage: ['noise:hippocampus-definition', 'noise:memory-types', 'noise:brain-region', 'noise:experiment', 'noise:sleep', 'relation:hippocampus-memory'],
      entity: ['relation:hippocampus-memory', 'noise:hippocampus-definition', 'noise:memory-types'],
      argument: ['noise:experiment', 'relation:hippocampus-memory', 'noise:sleep'],
    },
  }),
  golden({
    id: 'relation-load-performance', query: '认知负荷如何影响任务表现？', expectedIntent: 'entity_relation',
    relevance: { 'relation:load-performance': 3, 'relation:load-errors': 2 },
    channels: {
      passage: ['noise:load-definition', 'noise:performance-metric', 'noise:attention', 'noise:training', 'noise:errors', 'relation:load-performance', 'relation:load-errors'],
      entity: ['relation:load-performance', 'relation:load-errors', 'noise:load-definition'],
      argument: ['relation:load-errors', 'noise:training', 'relation:load-performance'],
    },
  }),
  golden({
    id: 'relation-cross-document', query: '不同资料中自我效能感与坚持行为有什么联系？', expectedIntent: 'entity_relation',
    relevance: { 'relation:self-efficacy-persistence:a': 3, 'relation:self-efficacy-persistence:b': 2 },
    channels: {
      passage: ['noise:self-efficacy-definition', 'noise:persistence-definition', 'noise:motivation', 'noise:dropout', 'noise:goal', 'relation:self-efficacy-persistence:a'],
      entity: ['relation:self-efficacy-persistence:a', 'relation:self-efficacy-persistence:b', 'noise:self-efficacy-definition'],
      argument: ['noise:goal', 'relation:self-efficacy-persistence:b', 'noise:dropout'],
    },
  }),

  golden({
    id: 'reason-spacing', query: '为什么间隔练习能提高长期保持？', expectedIntent: 'reason',
    relevance: { 'argument:spacing-mechanism': 3, 'argument:spacing-conclusion': 2 },
    channels: {
      passage: ['noise:spacing-definition', 'noise:schedule', 'argument:spacing-conclusion', 'noise:testing', 'noise:forgetting', 'argument:spacing-mechanism'],
      entity: ['noise:spacing-definition', 'argument:spacing-mechanism', 'noise:forgetting'],
      argument: ['argument:spacing-mechanism', 'argument:spacing-conclusion', 'noise:schedule'],
    },
  }),
  golden({
    id: 'reason-feedback', query: '即时反馈为何会减少重复错误？', expectedIntent: 'reason',
    relevance: { 'argument:feedback-mechanism': 3 },
    channels: {
      passage: ['noise:feedback-definition', 'noise:error-types', 'noise:timing', 'noise:experiment', 'noise:practice', 'argument:feedback-mechanism'],
      entity: ['noise:feedback-definition', 'noise:error-types', 'argument:feedback-mechanism'],
      argument: ['argument:feedback-mechanism', 'noise:timing', 'noise:practice'],
    },
  }),
  golden({
    id: 'reason-sleep', query: '记忆巩固怎么会受到睡眠影响？', expectedIntent: 'reason',
    relevance: { 'argument:sleep-consolidation': 3, 'argument:sleep-stage': 1 },
    channels: {
      passage: ['noise:sleep-definition', 'noise:memory-types', 'argument:sleep-stage', 'noise:duration', 'noise:dream', 'argument:sleep-consolidation'],
      entity: ['noise:sleep-definition', 'argument:sleep-stage', 'noise:memory-types'],
      argument: ['argument:sleep-consolidation', 'argument:sleep-stage', 'noise:duration'],
    },
  }),

  golden({
    id: 'support-retrieval', query: '有什么证据支持主动回忆提高保持率？', expectedIntent: 'support',
    relevance: { 'argument:retrieval-evidence': 3, 'argument:retrieval-result': 2 },
    channels: {
      passage: ['noise:retrieval-definition', 'noise:study-procedure', 'noise:sample', 'argument:retrieval-result', 'noise:feedback', 'argument:retrieval-evidence'],
      entity: ['noise:retrieval-definition', 'argument:retrieval-result', 'noise:sample'],
      argument: ['argument:retrieval-evidence', 'argument:retrieval-result', 'noise:study-procedure'],
    },
  }),
  golden({
    id: 'support-dual-code', query: '图文双编码的依据是什么？', expectedIntent: 'support',
    relevance: { 'argument:dual-code-evidence': 3 },
    channels: {
      passage: ['noise:dual-code-definition', 'noise:image', 'noise:text', 'noise:lesson', 'noise:memory', 'argument:dual-code-evidence'],
      entity: ['noise:dual-code-definition', 'noise:image', 'argument:dual-code-evidence'],
      argument: ['argument:dual-code-evidence', 'noise:memory', 'noise:lesson'],
    },
  }),
  golden({
    id: 'support-self-explanation', query: '哪项论据支撑自我解释能促进迁移？', expectedIntent: 'support',
    relevance: { 'argument:self-explanation-evidence': 3 },
    channels: {
      passage: ['noise:self-explanation-definition', 'noise:transfer-test', 'noise:worked-example', 'noise:sample', 'noise:procedure', 'argument:self-explanation-evidence'],
      entity: ['noise:self-explanation-definition', 'noise:transfer-test', 'argument:self-explanation-evidence'],
      argument: ['argument:self-explanation-evidence', 'noise:worked-example', 'noise:procedure'],
    },
  }),

  golden({
    id: 'opposition-learning-styles', query: '什么反例会削弱学习风格匹配假说？', expectedIntent: 'opposition',
    relevance: { 'argument:learning-styles-counterexample': 3 },
    channels: {
      passage: ['noise:styles-definition', 'noise:matching-method', 'noise:questionnaire', 'noise:preference', 'noise:lesson', 'argument:learning-styles-counterexample'],
      entity: ['noise:styles-definition', 'noise:preference', 'argument:learning-styles-counterexample'],
      argument: ['argument:learning-styles-counterexample', 'noise:matching-method', 'noise:lesson'],
    },
  }),
  golden({
    id: 'opposition-multitasking', query: '有哪些证据反对多任务能提高效率？', expectedIntent: 'opposition',
    relevance: { 'argument:multitask-opposition': 3, 'argument:switching-cost': 2 },
    channels: {
      passage: ['noise:multitask-definition', 'noise:productivity', 'noise:device', 'argument:switching-cost', 'noise:survey', 'argument:multitask-opposition'],
      entity: ['noise:multitask-definition', 'argument:switching-cost', 'noise:productivity'],
      argument: ['argument:multitask-opposition', 'argument:switching-cost', 'noise:survey'],
    },
  }),
  golden({
    id: 'opposition-reward', query: '外部奖励促进内在动机的观点有什么局限？', expectedIntent: 'opposition',
    relevance: { 'argument:reward-limitation': 3 },
    channels: {
      passage: ['noise:reward-definition', 'noise:motivation-definition', 'noise:incentive', 'noise:behavior', 'noise:experiment', 'argument:reward-limitation'],
      entity: ['noise:reward-definition', 'noise:motivation-definition', 'argument:reward-limitation'],
      argument: ['argument:reward-limitation', 'noise:incentive', 'noise:experiment'],
    },
  }),

  golden({
    id: 'comparison-spacing-massing', query: '间隔练习与集中练习有什么区别？', expectedIntent: 'comparison',
    relevance: { 'compare:spacing-massing': 3, 'compare:retention': 2 },
    channels: {
      passage: ['noise:spacing-definition', 'noise:massing-definition', 'compare:retention', 'noise:schedule', 'compare:spacing-massing'],
      entity: ['compare:spacing-massing', 'compare:retention', 'noise:spacing-definition'],
      argument: ['compare:retention', 'noise:schedule', 'compare:spacing-massing'],
    },
  }),
  golden({
    id: 'comparison-formative-summative', query: '形成性评价相比总结性评价有何差异？', expectedIntent: 'comparison',
    relevance: { 'compare:assessment': 3 },
    channels: {
      passage: ['noise:formative-definition', 'noise:summative-definition', 'noise:grading', 'compare:assessment', 'noise:feedback'],
      entity: ['compare:assessment', 'noise:formative-definition', 'noise:summative-definition'],
      argument: ['noise:feedback', 'compare:assessment', 'noise:grading'],
    },
  }),
  golden({
    id: 'comparison-expert-novice', query: '专家与新手的问题表征方式有哪些异同？', expectedIntent: 'comparison',
    relevance: { 'compare:expert-novice': 3, 'compare:representation': 2 },
    channels: {
      passage: ['noise:expert-definition', 'noise:novice-definition', 'compare:representation', 'noise:problem-solving', 'compare:expert-novice'],
      entity: ['compare:expert-novice', 'compare:representation', 'noise:problem-solving'],
      argument: ['compare:representation', 'noise:problem-solving', 'compare:expert-novice'],
    },
  }),

  golden({
    id: 'application-spacing-plan', query: '如何把间隔练习应用到一周复习计划？', expectedIntent: 'application',
    relevance: { 'apply:spacing-plan': 3, 'apply:spacing-example': 1 },
    channels: {
      passage: ['apply:spacing-plan', 'noise:calendar', 'apply:spacing-example', 'noise:definition', 'noise:testing'],
      entity: ['noise:definition', 'apply:spacing-plan', 'noise:calendar'],
      argument: ['apply:spacing-plan', 'apply:spacing-example', 'noise:testing'],
    },
  }),
  golden({
    id: 'application-feedback', query: '怎样在课堂中使用即时反馈？', expectedIntent: 'application',
    relevance: { 'apply:classroom-feedback': 3 },
    channels: {
      passage: ['apply:classroom-feedback', 'noise:feedback-definition', 'noise:device', 'noise:grading', 'noise:survey'],
      entity: ['noise:feedback-definition', 'apply:classroom-feedback', 'noise:device'],
      argument: ['apply:classroom-feedback', 'noise:grading', 'noise:survey'],
    },
  }),
  golden({
    id: 'application-cognitive-load', query: '如何把认知负荷理论应用到课件设计？', expectedIntent: 'application',
    relevance: { 'apply:load-slides': 3, 'apply:load-example': 2 },
    channels: {
      passage: ['apply:load-slides', 'noise:load-definition', 'noise:slide-style', 'apply:load-example', 'noise:working-memory'],
      entity: ['noise:load-definition', 'apply:load-slides', 'noise:working-memory'],
      argument: ['apply:load-slides', 'apply:load-example', 'noise:slide-style'],
    },
  }),

  golden({
    id: 'general-chapter', query: '概括这一章关于记忆的主要内容。', expectedIntent: 'general',
    relevance: { 'general:memory-summary': 3, 'general:memory-outline': 2 },
    channels: {
      passage: ['general:memory-summary', 'general:memory-outline', 'noise:memory-example', 'noise:author', 'noise:references'],
      entity: ['general:memory-outline', 'noise:memory-example', 'general:memory-summary'],
      argument: ['general:memory-summary', 'noise:references', 'general:memory-outline'],
    },
  }),
  golden({
    id: 'general-metacognition', query: '整理资料中关于元认知的要点。', expectedIntent: 'general',
    relevance: { 'general:metacognition-summary': 3, 'general:metacognition-strategies': 2 },
    channels: {
      passage: ['general:metacognition-summary', 'general:metacognition-strategies', 'noise:monitoring', 'noise:motivation', 'noise:example'],
      entity: ['noise:monitoring', 'general:metacognition-summary', 'general:metacognition-strategies'],
      argument: ['general:metacognition-strategies', 'general:metacognition-summary', 'noise:motivation'],
    },
  }),
  golden({
    id: 'general-cross-chapter', query: '总结不同章节对学习动机的讨论。', expectedIntent: 'general',
    relevance: { 'general:motivation:a': 3, 'general:motivation:b': 2 },
    channels: {
      passage: ['general:motivation:a', 'noise:chapter-a', 'general:motivation:b', 'noise:chapter-b', 'noise:references'],
      entity: ['general:motivation:a', 'general:motivation:b', 'noise:chapter-a'],
      argument: ['general:motivation:b', 'general:motivation:a', 'noise:references'],
    },
  }),
];
