/**
 * 项目结构树（心流模式与场景模拟共用）。
 *
 * 折叠与选择为独立操作；完成标记跟随结构项目状态，不混入周期执行事项。
 */

import React, { useId } from 'react';
import { Folder, ChevronRight, ChevronDown, Check } from 'lucide-react';
import { NoteItem } from '../types';
import { getScheduledProjectState } from '../services/planProjectState';

export interface ProjectTreeNode {
  note: NoteItem;
  children: ProjectTreeNode[];
  fullyCompleted: boolean;
}

/** 某笔记的整棵子树（含自身），用于汇总任务与完成度 */
export function buildProjectTree(note: NoteItem, allNotes: NoteItem[]): NoteItem[] {
  const result: NoteItem[] = [];
  const visited = new Set<string>();
  const visit = (current: NoteItem) => {
    if (visited.has(current.id)) return;
    visited.add(current.id);
    result.push(current);
    allNotes.filter(n => n.parentId === current.id).forEach(visit);
  };
  visit(note);
  return result;
}

/** 子树内所有待办是否全部完成（无待办视为未完成） */
export function isProjectFullyCompleted(note: NoteItem, allNotes: NoteItem[]): boolean {
  if (note.noteType === 'project') {
    const state = getScheduledProjectState(allNotes, note.id);
    return state.hasScheduledWork && state.completed;
  }
  const tree = buildProjectTree(note, allNotes);
  const allDues = tree.flatMap(n => n.dueDates || []).filter(task => !task.recurrence || task.recurrence.frequency === 'none');
  if (allDues.length === 0) return false;
  return allDues.every(d => d.completed);
}

/**
 * 构建项目树。
 * @param opts.projectOnly 为 true 时子节点只保留 project 类型（场景模拟用）；默认保留全部子节点（心流模式原行为）。
 */
export function buildProjectTreeStructure(
  notes: NoteItem[],
  opts?: { projectOnly?: boolean },
): ProjectTreeNode[] {
  const projectOnly = opts?.projectOnly === true;
  const counts = new Map<string, number>();
  notes.forEach(note => counts.set(note.id, (counts.get(note.id) || 0) + 1));
  const unique = notes.filter(note => counts.get(note.id) === 1);
  const ids = new Set(unique.map(note => note.id));
  const roots = unique.filter(n => n.noteType === 'project' && (!n.parentId || !ids.has(n.parentId)));
  const buildNode = (note: NoteItem, ancestors = new Set<string>()): ProjectTreeNode => {
    const path = new Set(ancestors).add(note.id);
    const children = unique.filter(n => n.parentId === note.id && !path.has(n.id) && (!projectOnly || n.noteType === 'project'));
    return { note, children: children.map(child => buildNode(child, path)), fullyCompleted: isProjectFullyCompleted(note, unique) };
  };
  return roots.map(note => buildNode(note));
}

interface ProjectTreePanelProps {
  nodes: ProjectTreeNode[];
  expandedIds: Set<string>;
  selectedTreeId: string | null;
  onToggleExpand: (id: string) => void;
  onSelect: (id: string) => void;
}

export const ProjectTreePanel: React.FC<ProjectTreePanelProps> = ({ nodes, expandedIds, selectedTreeId, onToggleExpand, onSelect }) => {
  const treeId = useId();
  const renderNode = (node: ProjectTreeNode, depth: number): React.ReactNode => (
    <div key={node.note.id}>
      <div className={`flow-tree-node ${selectedTreeId === node.note.id ? 'flow-tree-node--active' : ''}`} style={{ paddingLeft: `${8 + Math.min(depth, 8) * 12}px` }}>
        {node.children.length > 0 ? <button type="button" className="flow-tree-node-chevron"
          aria-label={`${expandedIds.has(node.note.id) ? '收起' : '展开'}${node.note.title || '未命名项目'}`}
          aria-expanded={expandedIds.has(node.note.id)} aria-controls={`${treeId}-${encodeURIComponent(node.note.id)}`}
          onClick={() => onToggleExpand(node.note.id)}>
          {expandedIds.has(node.note.id) ? <ChevronDown className="w-3 h-3" aria-hidden="true" /> : <ChevronRight className="w-3 h-3" aria-hidden="true" />}
        </button> : <span className="flow-tree-node-spacer" aria-hidden="true" />}
        <button type="button" className="flow-tree-node-select" aria-pressed={selectedTreeId === node.note.id}
          title={node.note.title || '未命名项目'} onClick={() => onSelect(node.note.id)}>
          <Folder className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
          <span className="flow-tree-node-title">{node.note.title || '未命名项目'}</span>
          {node.fullyCompleted && <span aria-label="项目已完成"><Check className="w-3 h-3 flex-shrink-0" aria-hidden="true" /></span>}
        </button>
      </div>
      {node.children.length > 0 && <div id={`${treeId}-${encodeURIComponent(node.note.id)}`} hidden={!expandedIds.has(node.note.id)}>
        {expandedIds.has(node.note.id) && node.children.map(child => renderNode(child, depth + 1))}
      </div>}
    </div>
  );
  return <div className="flow-tree-panel">{nodes.map(n => renderNode(n, 0))}</div>;
};
