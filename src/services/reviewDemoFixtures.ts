import type { NoteItem } from '../types';

const DAY = 86_400_000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY).toISOString();
}

const DEFINITIONS = [
  {
    id: 'review-demo-bayes',
    title: '贝叶斯定理',
    content: '贝叶斯定理描述在已有证据的条件下，如何更新对某一事件发生概率的认识。它把先验概率、似然与后验概率连接起来，是概率论与统计推断中的核心公式。',
    tags: ['概率论'],
    links: ['条件概率', '全概率公式', '最大后验估计'],
    mastery: 61,
    reviewedDaysAgo: 12,
    stability: 5,
    wrong: 1,
  },
  {
    id: 'review-demo-conditional',
    title: '条件概率',
    content: '条件概率刻画在事件 B 已发生的前提下事件 A 发生的可能性。它是理解独立性、全概率公式与贝叶斯定理的基础。',
    tags: ['概率论'],
    links: ['贝叶斯定理', '独立事件', '全概率公式'],
    mastery: 78,
    reviewedDaysAgo: 3,
    stability: 8,
    wrong: 0,
  },
  {
    id: 'review-demo-total-probability',
    title: '全概率公式',
    content: '全概率公式把一个复杂事件按互斥且完备的条件进行拆分，再汇总每条路径上的条件概率。它经常作为贝叶斯定理分母的计算基础。',
    tags: ['概率论'],
    links: ['条件概率', '贝叶斯定理', '独立事件'],
    mastery: 43,
    reviewedDaysAgo: 18,
    stability: 4,
    wrong: 2,
  },
  {
    id: 'review-demo-likelihood',
    title: '似然函数',
    content: '似然函数把观测数据视为固定值，把未知参数视为变量，用来比较不同参数对当前数据的解释能力。似然不是参数的概率分布。',
    tags: ['统计推断'],
    links: ['最大似然估计', '贝叶斯定理', '后验分布'],
    mastery: 37,
    reviewedDaysAgo: 21,
    stability: 3,
    wrong: 3,
  },
  {
    id: 'review-demo-mle',
    title: '最大似然估计',
    content: '最大似然估计选择使已观察数据出现概率最大的参数值。实际计算通常转化为最大化对数似然，以把乘积化为求和并提升数值稳定性。',
    tags: ['统计推断'],
    links: ['似然函数', '最大后验估计', '置信区间'],
    mastery: 55,
    reviewedDaysAgo: 9,
    stability: 6,
    wrong: 1,
  },
  {
    id: 'review-demo-clt',
    title: '中心极限定理',
    content: '在一定条件下，大量独立同分布随机变量之和经过标准化后趋近正态分布。它解释了正态分布为何在抽样统计中普遍出现。',
    tags: ['概率论'],
    links: ['正态分布', '样本均值', '置信区间'],
    mastery: 71,
    reviewedDaysAgo: 6,
    stability: 9,
    wrong: 0,
  },
  {
    id: 'review-demo-normal',
    title: '正态分布',
    content: '正态分布由均值与方差决定，具有对称的钟形密度曲线。标准化可以把一般正态变量转换为标准正态变量。',
    tags: ['概率分布'],
    links: ['中心极限定理', '标准化', '置信区间'],
    mastery: 84,
    reviewedDaysAgo: 2,
    stability: 12,
    wrong: 0,
  },
  {
    id: 'review-demo-confidence',
    title: '置信区间',
    content: '置信区间用样本构造一个随机区间，并用长期重复抽样下的覆盖率描述其可靠性。它不表示参数以某个概率落在已经计算出的区间内。',
    tags: ['统计推断'],
    links: ['中心极限定理', '样本均值', '最大似然估计'],
    mastery: 48,
    reviewedDaysAgo: 15,
    stability: 4,
    wrong: 2,
  },
] as const;

/** 为 review-picker 预览补足临时知识点；不进入 App 的持久化 notes 状态。 */
export function withReviewDemoFixtures(notes: NoteItem[]): NoteItem[] {
  const existingTitles = new Set(notes.map((note) => note.title));
  const fixtures: NoteItem[] = DEFINITIONS
    .filter((item) => !existingTitles.has(item.title))
    .map((item) => ({
      id: item.id,
      title: item.title,
      content: item.content,
      noteType: 'knowledge',
      tags: [...item.tags],
      links: [...item.links],
      backlinks: DEFINITIONS.filter((candidate) => candidate.links.includes(item.title as never)).map((candidate) => candidate.title),
      dueDates: [],
      createdAt: isoDaysAgo(item.reviewedDaysAgo + 24),
      updatedAt: isoDaysAgo(Math.max(1, Math.floor(item.reviewedDaysAgo / 2))),
      dsrState: {
        difficulty: 5 + Math.min(3, item.wrong * 0.5),
        stability: item.stability,
        lastReviewedAt: isoDaysAgo(item.reviewedDaysAgo),
        reviewCount: Math.max(1, 5 - item.wrong),
        consecutiveCorrect: item.wrong > 0 ? 0 : 2,
        consecutiveWrong: item.wrong,
        conceptMastery: item.mastery,
        conceptMasterySamples: 3,
        conceptMasteryUpdatedAt: isoDaysAgo(item.reviewedDaysAgo),
      },
    }));
  const rootProjectId = notes.find((note) => note.noteType === 'project' && !note.parentId)?.id;
  const notesWithPreviewLinks = notes.map((note) => note.id === rootProjectId
    ? { ...note, links: [...new Set([...note.links, ...DEFINITIONS.map((item) => item.title)])] }
    : note);
  return [...notesWithPreviewLinks, ...fixtures];
}
