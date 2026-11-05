import type { DueDateItem, NoteItem } from '../types';

const DAY = 86_400_000;

const KNOWLEDGE = [
  { id: 'graph-demo-random-variable', title: '随机变量', mastery: 92, tags: ['概率基础'], links: ['概率分布', '独立事件'] },
  { id: 'graph-demo-distribution', title: '概率分布', mastery: 84, tags: ['概率基础'], links: ['随机变量', '条件概率', '先验概率'] },
  { id: 'graph-demo-conditional', title: '条件概率', mastery: 78, tags: ['概率基础', '核心概念'], links: ['全概率公式', '贝叶斯定理', '独立事件'] },
  { id: 'graph-demo-independence', title: '独立事件', mastery: 65, tags: ['概率基础'], links: ['条件概率', '随机变量'] },
  { id: 'graph-demo-total-probability', title: '全概率公式', mastery: 54, tags: ['概率基础'], links: ['条件概率', '贝叶斯定理'] },
  { id: 'graph-demo-bayes', title: '贝叶斯定理', mastery: 61, tags: ['概率论', '核心概念'], links: ['条件概率', '全概率公式', '先验概率', '后验概率', '似然函数'] },
  { id: 'graph-demo-prior', title: '先验概率', mastery: 42, tags: ['统计推断'], links: ['贝叶斯定理', '后验概率'] },
  { id: 'graph-demo-likelihood', title: '似然函数', mastery: 37, tags: ['统计推断'], links: ['贝叶斯定理', '最大似然估计', '后验概率'] },
  { id: 'graph-demo-posterior', title: '后验概率', mastery: 59, tags: ['统计推断'], links: ['贝叶斯定理', '最大后验估计', '贝叶斯网络'] },
  { id: 'graph-demo-mle', title: '最大似然估计', mastery: 71, tags: ['统计推断'], links: ['似然函数', '置信区间', '最大后验估计'] },
  { id: 'graph-demo-map', title: '最大后验估计', mastery: 48, tags: ['统计推断', '机器学习'], links: ['最大似然估计', '后验概率', '朴素贝叶斯'] },
  { id: 'graph-demo-confidence', title: '置信区间', mastery: 26, tags: ['统计推断'], links: ['最大似然估计'] },
  { id: 'graph-demo-naive-bayes', title: '朴素贝叶斯', mastery: 68, tags: ['机器学习'], links: ['贝叶斯定理', '文本分类', '垃圾邮件识别'] },
  { id: 'graph-demo-network', title: '贝叶斯网络', mastery: 46, tags: ['机器学习'], links: ['后验概率', '条件概率'] },
  { id: 'graph-demo-text-classification', title: '文本分类', mastery: 75, tags: ['机器学习应用'], links: ['朴素贝叶斯', '垃圾邮件识别'] },
  { id: 'graph-demo-spam', title: '垃圾邮件识别', mastery: undefined, tags: ['机器学习应用'], links: ['朴素贝叶斯', '文本分类'] },
] as const;

const EXTENDED_GROUPS = [
  {
    id: 'stochastic',
    title: '随机过程',
    anchor: '随机变量',
    terms: ['样本空间', '概率测度', '联合分布', '边缘分布', '条件分布', '期望与方差', '协方差', '大数定律', '中心极限定理', '马尔可夫链', '状态转移矩阵', '平稳分布', '泊松过程', '布朗运动'],
  },
  {
    id: 'statistics',
    title: '数理统计',
    anchor: '置信区间',
    terms: ['总体与样本', '抽样分布', '充分统计量', '点估计', '矩估计', '无偏估计', '一致估计', '假设检验', '显著性水平', '第一类错误', '第二类错误', '检验功效', '方差分析', '卡方检验'],
  },
  {
    id: 'regression',
    title: '回归建模',
    anchor: '最大似然估计',
    terms: ['线性回归', '最小二乘法', '残差分析', '多重共线性', '岭回归', '套索回归', '逻辑回归', '广义线性模型', '交叉验证', '偏差方差分解', '正则化', '特征选择', '模型诊断', '预测区间'],
  },
  {
    id: 'information',
    title: '信息论',
    anchor: '文本分类',
    terms: ['信息量', '信息熵', '联合熵', '条件熵', '互信息', '相对熵', '交叉熵', '数据处理不等式', '最大熵原理', '信道容量', '率失真理论', '霍夫曼编码', '算术编码', '信息增益'],
  },
  {
    id: 'decision',
    title: '决策理论',
    anchor: '后验概率',
    terms: ['损失函数', '风险函数', '贝叶斯风险', '决策规则', '最小风险决策', '零一损失', '效用函数', '先验决策', '后验决策', '极大极小准则', '受试者工作曲线', '精确率与召回率', '校准曲线', '决策边界'],
  },
] as const;

const EXTENDED_KNOWLEDGE = EXTENDED_GROUPS.flatMap((group, groupIndex) => group.terms.map((title, termIndex) => ({
  id: `graph-demo-${group.id}-${termIndex + 1}`,
  title,
  mastery: (31 + groupIndex * 11 + termIndex * 7) % 101,
  tags: [group.title],
  links: [
    termIndex === 0 ? group.anchor : group.terms[termIndex - 1],
    ...(termIndex + 1 < group.terms.length ? [group.terms[termIndex + 1]] : []),
  ],
})));

const ALL_KNOWLEDGE = [...KNOWLEDGE, ...EXTENDED_KNOWLEDGE];

function isoOffset(days: number): string {
  return new Date(Date.now() + days * DAY).toISOString();
}

function dueDate(projectId: string, projectTitle: string, days: number, taskText: string): DueDateItem {
  return {
    id: `${projectId}-due-${days}`,
    noteId: projectId,
    noteTitle: projectTitle,
    taskText,
    dueDate: isoOffset(days).slice(0, 10),
    completed: false,
    priority: days <= 5 ? 'high' : 'medium',
  };
}

function project(id: string, title: string, parentId: string | undefined, links: string[], days: number): NoteItem {
  return {
    id,
    title,
    parentId,
    content: `用于知识图谱预览的项目语境：${title}。`,
    noteType: 'project',
    tags: ['图谱预览'],
    links,
    backlinks: [],
    dueDates: [dueDate(id, title, days, `完成「${title}」阶段复习`)],
    createdAt: isoOffset(-36),
    updatedAt: isoOffset(-2),
  };
}

/** 为 knowledge-graph 预览补足临时项目与知识关系；不会写入用户笔记。 */
export function withKnowledgeGraphDemoFixtures(notes: NoteItem[]): NoteItem[] {
  const existingTitles = new Set(notes.map((note) => note.title));
  const knowledgeFixtures: NoteItem[] = ALL_KNOWLEDGE
    .filter((item) => !existingTitles.has(item.title))
    .map((item, index) => ({
      id: item.id,
      title: item.title,
      content: `${item.title}是本地知识图谱预览中的示例概念，用于检查知识关联、项目语境与掌握度视觉编码。`,
      noteType: 'knowledge',
      tags: [...item.tags],
      links: [...item.links],
      backlinks: ALL_KNOWLEDGE.filter((candidate) => (candidate.links as readonly string[]).includes(item.title)).map((candidate) => candidate.title),
      dueDates: [],
      createdAt: isoOffset(-48 + index),
      updatedAt: isoOffset(-Math.max(1, 16 - index)),
      dsrState: {
        difficulty: 4.5 + (index % 4) * 0.7,
        stability: 3 + (index % 7),
        lastReviewedAt: isoOffset(-(index + 2)),
        reviewCount: 2 + (index % 5),
        consecutiveCorrect: index % 3,
        consecutiveWrong: index % 4 === 0 ? 1 : 0,
        conceptMastery: item.mastery,
        conceptMasterySamples: item.mastery == null ? 0 : 3,
        conceptMasteryUpdatedAt: item.mastery == null ? undefined : isoOffset(-(index + 2)),
      },
    }));

  const rootId = 'graph-demo-root';
  const projectFixtures = [
    project(rootId, '概率与统计推断 · 图谱预览', undefined, [], 18),
    project('graph-demo-project-probability', '概率基础', rootId, ['随机变量', '概率分布', '条件概率', '独立事件', '全概率公式', '贝叶斯定理'], 5),
    project('graph-demo-project-inference', '统计推断', rootId, ['贝叶斯定理', '先验概率', '似然函数', '后验概率', '最大似然估计', '最大后验估计', '置信区间'], 10),
    project('graph-demo-project-ml', '机器学习应用', rootId, ['贝叶斯定理', '后验概率', '最大后验估计', '朴素贝叶斯', '贝叶斯网络', '文本分类', '垃圾邮件识别'], 15),
    ...EXTENDED_GROUPS.map((group, index) => project(`graph-demo-project-${group.id}`, group.title, rootId, [...group.terms], 7 + index * 3)),
  ].filter((item) => !existingTitles.has(item.title));

  return [...notes, ...projectFixtures, ...knowledgeFixtures];
}
