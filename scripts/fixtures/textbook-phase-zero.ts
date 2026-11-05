import type { NoteItem } from '../../src/types';
import type { ArgDoc } from '../../src/services/argumentDoc/types';

/** 合成的真实混合正文形态；不读取用户资料，不代表已实现教材/记录存储模型。 */
export const TEXTBOOK_FIXTURE = {
  rootProjectId: 'root-psychology-effects',
  revisionId: 'textbook-revision-1',
  plan: '- [ ] 理解 [[选择过载效应]] @due(2026-10-08) <!-- ln-task:choice-1 -->',
  restatement: '我原来以为选项越多就一定越难选择，现在需要区分任务难度和偏好是否清晰。',
  graphId: 'argument-choice-session-1',
  sessions: [
    { id: 'flow-choice-1', startedAt: '2026-10-06T12:10:00.000Z', endedAt: '2026-10-06T12:45:00.000Z',
      title: '2026-10-06 20:10–20:45', userEditedTitle: false },
    { id: 'flow-choice-2', startedAt: '2026-10-06T13:10:00.000Z', endedAt: '2026-10-06T13:40:00.000Z',
      title: '我的第二次选择过载复盘', userEditedTitle: true },
  ],
  textbook: [
    '# 选择过载效应教材',
    '选择过载并非选项增加后的必然结果，判断时应考虑任务难度与偏好清晰度。[^条件]',
    '![决策情境示意](material:choice-diagram)',
    '$$U(x)=V(x)-C(x)$$',
    '| 场景 | 条件 |\n| --- | --- |\n| 比较商品 | 偏好不清晰 |',
    '```python\noptions = ["A", "B", "C"]\nprint(len(options))\n```',
    '```mermaid\nflowchart LR\n  A[明确目标] --> B[缩小候选]\n```',
    '> 教学提示：先检查条件，再判断是否出现过载。',
    '[^条件]: 合成教材示例，引用定位 source-choice-1 第 2 页，不是真实研究结论。',
  ].join('\n\n'),
} as const;

export function mixedTextbookNote(): NoteItem {
  const fixture = TEXTBOOK_FIXTURE;
  const graph: ArgDoc = {
    doc_id: fixture.graphId, title: '本次选择过载复盘', iteration: 0, status: 'draft',
    created_at: fixture.sessions[0].endedAt, updated_at: fixture.sessions[0].endedAt,
    nodes: [], edges: [],
  };
  return {
    id: 'project-choice', title: '学习选择过载效应：选项为何并非越多越好', noteType: 'project',
    content: [fixture.plan, fixture.textbook, fixture.restatement,
      `<ArgumentBlock id="${fixture.graphId}" />`].join('\n\n'),
    generatedContentBlocks: [], argumentDocs: [graph],
    tags: ['心理学效应'], links: ['选择过载效应'], backlinks: [], dueDates: [],
    createdAt: fixture.sessions[0].startedAt, updatedAt: fixture.sessions[0].endedAt,
  };
}

/** 后续阶段须接到真实任务/存储/组件；阶段零只冻结输入与预期，不冒充集成通过。 */
export const TEXTBOOK_ACCEPTANCE_CASES = [
  { id: 'create-next-day', projectNoteId: 'project-choice', operation: 'create', revisionId: 'textbook-revision-1',
    at: '2026-10-07T12:00:00.000Z', expected: 'return_existing' },
  { id: 'same-title-other-project', projectNoteId: 'project-choice-other', operation: 'create',
    at: '2026-10-07T12:00:00.000Z', expected: 'use_project_id_not_title' },
  { id: 'rewrite-explicit-approval', projectNoteId: 'project-choice', operation: 'rewrite',
    approvedOperation: 'create', expected: 'reject_operation_mismatch' },
  { id: 'append-explicit-approval', projectNoteId: 'project-choice', operation: 'append',
    approvedOperation: 'append', expected: 'preserve_existing_chapters_and_records' },
  { id: 'publish-retry', projectNoteId: 'project-choice', operation: 'create',
    jobId: 'job-choice-1', idempotencyKey: 'publish-choice-1', expected: 'one_publication' },
  { id: 'textbook-edited-during-job', projectNoteId: 'project-choice', operation: 'rewrite',
    baseHash: 'base-before-user-edit', currentHash: 'base-after-user-edit', expected: 'reject_and_preserve_draft' },
  { id: 'record-added-during-job', projectNoteId: 'project-choice', operation: 'append',
    expected: 'merge_latest_note_preserve_record' },
  { id: 'same-session-save-retry', sessionId: 'flow-choice-1', graphId: 'argument-choice-session-1',
    expected: 'update_same_record' },
  { id: 'same-day-second-session', sessionId: 'flow-choice-2', expected: 'separate_record' },
  { id: 'graph-edit-after-title-edit', sessionId: 'flow-choice-2', title: '我的第二次选择过载复盘',
    expected: 'preserve_title_and_update_original_graph' },
  { id: 'analysis-failure', sessionId: 'flow-choice-1', expected: 'retain_text_without_fabricated_graph' },
  { id: 'legacy-unknown-session', graphId: 'argument-legacy-no-session', expected: 'preserve_original_entry' },
] as const;
