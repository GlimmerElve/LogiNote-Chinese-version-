import type { NoteItem } from '../../types';

// The shell needs these read-only references without importing the scene UI.
const DEMO_TIMESTAMP = '2026-10-03T09:30:00.000Z';
export const SCENE_S1_DEMO_NOTES: NoteItem[] = [{
  id: 'demo-retention-note', title: 'Q3 用户留存摘要', noteType: 'knowledge',
  content: '# Q3 用户留存摘要\n\n新用户第 7 日留存提升 **4.8%**，但样本仍集中在单一渠道。\n\n## 决策边界\n\n当前结果尚不足以将渠道差异与产品改动的影响分离。下一阶段需要扩大样本，并保留对照组与退出条件。',
  tags: [], links: [], backlinks: [], dueDates: [], createdAt: DEMO_TIMESTAMP, updatedAt: DEMO_TIMESTAMP,
}];
