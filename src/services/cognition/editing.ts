import { applyCognitionMutation } from './core';
import { buildCognitionManagement, cognitionNodeKey } from './management';
import { COGNITION_OPERATION_LABELS, COGNITION_RELATION_LABELS as RELATION_LABELS, COGNITION_RELATION_MEANINGS } from './types';
import type { CognitionFile, CognitionGraphEdit, CognitionEdgeReference, CognitionNodeReference, CognitionAuthorship } from './types';
import { cognitionRoleLabel } from './roles';

export const COGNITION_EDIT_LABELS = { add_node: '新增认知块', update_node: '修改认知内容', delete_node: '删除认知块', add_relation: '建立认知关联', update_relation: '调整认知关联', delete_relation: '删除认知关联' };
export function cognitionEdgeKey(ref: CognitionEdgeReference) { return 'linkId' in ref ? `link:${ref.linkId}` : JSON.stringify([ref.recordId, ref.branchId, ref.edgeId]); }
export function previewCognitionGraphEdit(file: CognitionFile, edit: CognitionGraphEdit, authorship: CognitionAuthorship = 'own_expression') {
  const next = applyCognitionMutation(file, { kind: 'edit_graph', confirmed: true, expectedRevision: file.revision, edit, authorship }, { id: 'graph-preview', at: '2000-01-01T00:00:00Z' });
  const model = buildCognitionManagement(file), after = buildCognitionManagement(next);
  const nodes = model.groups.flatMap(group => group.nodes), edges = [...model.groups.flatMap(group => group.edges), ...model.brokenEdges];
  const label = (ref: CognitionNodeReference) => { const node = nodes.find(node => node.id === cognitionNodeKey(ref)); return node ? `${node.title}：${node.text}` : '已失效的节点引用'; };
  const lines: string[] = [];
  if (edit.meaning) lines.push(`助手／编辑者对本次意图的理解：${edit.meaning.interpretation}`);
  if (edit.action === 'add_node') {
    if (edit.parent) {
      // Core validation above has resolved this exact version/branch. Show the actual
      // destination, not the proposed title (which does not rename an existing record).
      const record = file.records.find(record => record.id === edit.parent!.recordId)!;
      const revision = record.revisions.at(-1)!;
      const branch = revision.branches.find(branch => branch.id === edit.parent!.branchId)!;
      const recordTitle = revision.branches.find(branch => branch.id === 'primary')!.graph.title || '未命名理解';
      const branchKind = branch.kind === 'primary' ? '主要理解' : branch.kind === 'contextual' ? '不同情境' : '未决分歧';
      lines.push('保存方式：加入已有认知记录', `目标记录：${recordTitle}（记录 ID：${record.id}）`,
        `目标分支：${branchKind} · ${branch.graph.title || '未命名理解'}（分支 ID：${branch.id}）`, `目标版本：${revision.id}`);
      if (branch.context) lines.push(`分支情境：${branch.context}`);
      if (edit.title !== branch.graph.title) lines.push(`填写的主题“${edit.title}”不会重命名目标记录；新增块沿用以上目标分支主题。`);
    } else lines.push('保存方式：独立新建认知记录', `主题：${edit.title}`);
    lines.push(`新增：${edit.text}`, `论证角色：${cognitionRoleLabel(edit)}`, `状态：${edit.stance === 'endorsed' ? '当前认同' : '暂定理解'}`, edit.parent ? '仅向以上目标分支新增认知块，不自动连线。' : '独立新建，不覆盖其他记录。');
  }
  else if (edit.action === 'update_node') {
    const old = nodes.find(node => node.id === cognitionNodeKey(edit.target));
    lines.push(`修改前：${label(edit.target)}`, `修改后：${edit.text}`, `修改方式：${COGNITION_OPERATION_LABELS[edit.operation]}`, `状态：${edit.stance === 'endorsed' ? '当前认同' : '暂定理解'}`);
    lines.push(`论证角色：${cognitionRoleLabel(old || {})} → ${cognitionRoleLabel({ role: edit.role ?? old?.role })}`);
    for (const kept of edit.meaning?.preserved || []) lines.push(`逐字保留：${kept}`);
    if (edit.meaning?.conditions) {
      const delta = edit.meaning.conditions;
      lines.push(`原条件：${delta.before.join('；') || '未声明原条件'}`, old?.conditions === undefined ? '原记录尚无结构化条件；以上是从原文识别的片段，需你核对是否完整，不代表原主张无其他隐含条件。' : '原条件来自当前已保存的条件列表。');
      for (const change of delta.changes) lines.push(change.kind === 'add' ? `新增条件：${change.after}` : change.kind === 'remove' ? `移除条件：${change.before}` : `替换条件：${change.before} → ${change.after}`);
      const afterNode = after.groups.flatMap(group => group.nodes).find(node => node.id === cognitionNodeKey(edit.target));
      const changed = new Set(delta.changes.flatMap(change => change.kind === 'add' ? [] : [change.before]));
      lines.push(`保留原条件：${delta.before.filter(condition => !changed.has(condition)).join('；') || '无'}`, `修改后条件：${afterNode?.conditions?.join('；') || '未记录条件（不等于客观上无条件成立）'}`);
    }
  }
  else if (edit.action === 'delete_node') lines.push(`移除：${label(edit.target)}`, `同时移除 ${edges.filter(edge => edge.source === cognitionNodeKey(edit.target) || edge.target === cognitionNodeKey(edit.target)).length} 条相关连线；其他块不删除，旧版本仍保留。`);
  if ('edge' in edit && edit.edge) {
    const old = edges.find(edge => edge.id === cognitionEdgeKey(edit.edge!));
    if (!old) throw new Error('原关系已不存在');
    lines.push(`原关系：${nodes.find(node => node.id === old.source)?.text || '失效节点'} → ${nodes.find(node => node.id === old.target)?.text || '失效节点'} · ${RELATION_LABELS[old.relation as keyof typeof RELATION_LABELS]}`, `原说明：${old.reason || '未填写'}`);
  }
  if (edit.action === 'add_relation' || edit.action === 'update_relation') lines.push(`关系起点：${label(edit.source)}`, `关系终点：${label(edit.target)}`, `关系类型：${RELATION_LABELS[edit.relation]}`, `关系含义：${COGNITION_RELATION_MEANINGS[edit.relation]}`, '仅变更指定连线；其他支持、反对或限制关系保留，不自动修改两端正文。');
  lines.push(`变更说明：${edit.reason}`, `待复核节点：${model.summary.needsReview} → ${after.summary.needsReview}；不自动判错、提高掌握度或修改来源笔记。`);
  if (authorship === 'adopted_with_assistance') lines.push('本次表述由助手辅助整理，只有你确认后才作为当前认知；不伪装成原始逐字回答。');
  return { title: COGNITION_EDIT_LABELS[edit.action], lines, beforeRevision: file.revision, afterSummary: after.summary };
}
