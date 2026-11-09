import type { NoteItem, PlanMeta, PlanNode, VaultSettings } from '../types';
import type { PlanDraftMutationResult } from './agent/planDraftService';
import { isPlanEditorDraftFresh } from './agent/workflowDraftStore';
import { assertHardDraftCapacity, planRootFor } from './learningCapacity';
import { getScheduledProjectDeadline } from './planProjectState';
import { isLearningProject } from './projectRole';
import {
  buildPublishedPlanEditorValue,
  replacePublishedPlanFromEditor,
  type PublishedPlanEditorValue,
} from './publishedPlanEditor';

export interface PublishedPlanPortfolioMutation {
  notes: NoteItem[];
  roots: Array<{
    rootId: string;
    tree: [PlanNode];
    planMeta: Partial<PlanMeta>;
    summary: PlanDraftMutationResult['summary'];
  }>;
  changedProjectNotes: NoteItem[];
}

const same = (left: unknown, right: unknown) => JSON.stringify(left ?? null) === JSON.stringify(right ?? null);

function flatten(nodes: PlanNode[]): PlanNode[] {
  return nodes.flatMap(node => [node, ...flatten(node.children)]);
}

/** Validate IDs before the title-based single-root adapter can resolve a patch. */
function assertEditorScope(notes: NoteItem[], draft: PublishedPlanEditorValue): void {
  const initial = buildPublishedPlanEditorValue(notes, draft.rootId)!;
  const scoped = new Map(notes.filter(note => isLearningProject(note) && planRootFor(note, notes)?.id === draft.rootId)
    .map(note => [note.id, note]));
  const keys = new Set<string>();
  const taskKeys = new Set<string>();
  const visit = (node: PlanNode, parentId?: string) => {
    if (!node || typeof node.key !== 'string' || !node.key || !Array.isArray(node.children) || keys.has(node.key)) {
      throw new Error('综合草图包含重复或缺失的项目标识');
    }
    keys.add(node.key);
    if (keys.size > 60) throw new Error('一个项目计划最多包含 60 个节点');
    const project = scoped.get(node.key);
    if (!project || (parentId && project.parentId !== parentId)) {
      throw new Error('综合草图只能调整锁定根内的已有项目，不能新增或移动项目');
    }
    if (node.title !== project.title) throw new Error('综合改期不能重命名项目，请保留原项目名称');
    if (node !== draft.tree[0] && node.tasks?.length) throw new Error('综合草图执行事项必须保留在根轨道');
    for (const task of node.tasks || []) {
      if (!task?.key || taskKeys.has(task.key)) throw new Error('综合草图包含重复或缺失的执行事项标识');
      taskKeys.add(task.key);
      if (task.linkedProjectKey && !scoped.has(task.linkedProjectKey)) throw new Error('执行事项关联项目不属于锁定根计划');
      if (notes.some(note => !scoped.has(note.id) && note.dueDates.some(item => item.id === task.key))) {
        throw new Error('执行事项标识属于锁定范围外的笔记');
      }
    }
    node.children.forEach(child => visit(child, node.key));
  };
  visit(draft.tree[0]);
  if (!Array.isArray(draft.projectCatalog) || draft.projectCatalog.some(project => !scoped.has(project.key) || project.key === draft.rootId)) {
    throw new Error('综合草图项目目录超出锁定根计划');
  }
  for (const milestone of draft.planMeta.milestones || []) {
    if (milestone.projectId && !scoped.has(milestone.projectId)) throw new Error('里程碑关联项目不属于锁定根计划');
  }

  // Completed work is history, not a rescheduling candidate. In particular a
  // missing editor row must never delete a completed execution or deadline.
  const finalNodes = new Map(flatten(draft.tree).map(node => [node.key, node]));
  const initialNodes = new Map(flatten(initial.tree).map(node => [node.key, node]));
  for (const project of scoped.values()) {
    const deadline = getScheduledProjectDeadline(project);
    if (deadline?.completed) {
      const before = initialNodes.get(project.id), after = finalNodes.get(project.id);
      if (!after || !before || !same(
        [before.title, before.startDate, before.dueDate, before.estimatedMinutes],
        [after.title, after.startDate, after.dueDate, after.estimatedMinutes],
      )) throw new Error('综合调整不能删除或改写已完成项目的历史安排');
    }
    for (const task of project.dueDates.filter(item => item !== deadline && item.completed)) {
      const before = initial.tree[0].tasks?.find(item => item.key === task.id);
      const after = draft.tree[0].tasks?.find(item => item.key === task.id);
      if (!before || !after || !same(before, after)) throw new Error('综合调整不能删除或改写已完成执行事项');
    }
  }
  for (const milestone of initial.planMeta.milestones || []) {
    if (milestone.completed && !same(milestone, draft.planMeta.milestones?.find(item => item.id === milestone.id))) {
      throw new Error('综合调整不能删除或改写已完成里程碑');
    }
  }
}

/**
 * One pure portfolio projection. No persistence occurs here: callers submit
 * the final notes once through the existing save-before-publish writer.
 */
export function replacePublishedPlanPortfolio(
  notes: NoteItem[],
  drafts: PublishedPlanEditorValue[],
  baseProjectRevisions: Record<string, string>,
  settings: Partial<VaultSettings>,
  now = new Date().toISOString(),
): PublishedPlanPortfolioMutation {
  if (!Array.isArray(drafts) || !drafts.length) throw new Error('综合计划草图不能为空');
  const noteIds = new Set(notes.map(note => note.id));
  if (noteIds.size !== notes.length || notes.some(note => !note.id)) throw new Error('笔记包含重复或缺失的标识');
  const rootIds = new Set<string>();
  const origin = drafts[0]?.agentEditorDraftId;
  if (typeof origin !== 'string' || !origin.trim() || origin !== origin.trim() || origin.length > 200) {
    throw new Error('综合计划草图缺少有效的 Agent 来源');
  }
  for (const draft of drafts) {
    if (!draft?.rootId || rootIds.has(draft.rootId)) throw new Error('综合计划草图包含重复或缺失的根项目');
    rootIds.add(draft.rootId);
    if (!Array.isArray(draft.tree) || draft.tree.length !== 1 || draft.tree[0]?.key !== draft.rootId || !draft.planMeta) {
      throw new Error('综合草图与锁定根项目不匹配');
    }
    if (draft.agentEditorDraftId !== origin) throw new Error('综合草图不能混合不同的 Agent 来源');
    const root = notes.find(note => note.id === draft.rootId);
    if (!isLearningProject(root) || root.planMeta?.status === 'archived' || planRootFor(root, notes)?.id !== root.id) {
      throw new Error('锁定根计划不存在、已归档或不再是学习计划根');
    }
  }
  if (!baseProjectRevisions || typeof baseProjectRevisions !== 'object' || Array.isArray(baseProjectRevisions)
    || Object.values(baseProjectRevisions).some(value => typeof value !== 'string')
    || !isPlanEditorDraftFresh(notes, {
      newPlanDraft: null, editorQueue: drafts, editingPlanRootId: drafts[0].rootId, baseProjectRevisions,
    })) {
    throw new Error('综合草图锁定范围不完整或已有项目被修改；请重新载入整组计划后确认');
  }
  // Validate the entire group before projecting even its first root.
  drafts.forEach(draft => assertEditorScope(notes, draft));

  // Isolate inputs even if a future adapter accidentally mutates a shared leaf.
  let working = structuredClone(notes);
  const safeDrafts = structuredClone(drafts);
  const summaries = new Map<string, PlanDraftMutationResult['summary']>();
  for (const draft of safeDrafts) {
    const mutation = replacePublishedPlanFromEditor(working, draft.rootId, draft.tree, draft.planMeta, now);
    if (mutation.createdProjectNotes.length || mutation.deletedProjectIds.length || mutation.createdKnowledgeNotes.length || mutation.changedKnowledgeNotes.length) {
      throw new Error('综合草图不能创建或删除项目及知识笔记');
    }
    working = mutation.notes;
    summaries.set(draft.rootId, mutation.summary);
  }

  const roots = safeDrafts.map(draft => {
    const final = buildPublishedPlanEditorValue(working, draft.rootId);
    if (!final) throw new Error('综合调整后锁定根计划丢失');
    // Every selected root has already been replaced. Testing against this final
    // combination permits a valid capacity swap between two selected plans.
    assertHardDraftCapacity(final.tree, final.planMeta, working, settings, draft.rootId);
    if (final.planMeta.conditions?.deadlineMode === 'hard') {
      const target = final.planMeta.targetDate;
      if (!target || !/^\d{4}-\d{2}-\d{2}$/.test(target) || !Number.isFinite(Date.parse(`${target}T00:00:00Z`))
        || new Date(`${target}T00:00:00Z`).toISOString().slice(0, 10) !== target) {
        throw new Error('硬截止计划必须设置有效目标日期');
      }
      for (const project of working.filter(note => isLearningProject(note) && planRootFor(note, working)?.id === draft.rootId)) {
        if (project.dueDates.some(item => !item.completed && (item.recurrence?.endDate || item.dueDate) > target)) {
          throw new Error('硬截止计划的未完成安排不能晚于目标日期');
        }
      }
    }
    return { rootId: draft.rootId, tree: final.tree, planMeta: final.planMeta, summary: summaries.get(draft.rootId)! };
  });
  const original = new Map(notes.map(note => [note.id, note]));
  const changedProjectNotes = working.filter(note => !same(note, original.get(note.id)));
  if (working.length !== notes.length || changedProjectNotes.some(note => !isLearningProject(note) || !rootIds.has(planRootFor(note, working)?.id || ''))) {
    throw new Error('综合调整不能改变锁定范围外的笔记');
  }
  const changed = new Map(changedProjectNotes.map(note => [note.id, note]));
  return { notes: notes.map(note => changed.get(note.id) || note), roots, changedProjectNotes };
}
