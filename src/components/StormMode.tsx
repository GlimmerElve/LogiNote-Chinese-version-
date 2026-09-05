import React, { useState, useMemo } from 'react';
import { NoteItem } from '../types';
import { Folder, Sparkles, Plus, FileText, Loader2, Check, X, ChevronRight, ChevronDown } from 'lucide-react';
import { runStormPipeline, buildStormNoteTree, makeRootProjectNote, STORM_STEPS, StormStep } from '../services/stormService';

interface StormModeProps {
  allNotes: NoteItem[];
  onUpdateNote: (u: NoteItem) => void;
}

type EntryMode = 'new' | 'existing';

interface ProjectTreeNode {
  note: NoteItem;
  children: ProjectTreeNode[];
}

/** 构建项目层级树（仅 project 类型） */
function buildProjectTreeStructure(notes: NoteItem[]): ProjectTreeNode[] {
  const roots = notes.filter(n => n.noteType === 'project' && !n.parentId);
  const buildNode = (note: NoteItem): ProjectTreeNode => {
    const children = notes.filter(n => n.parentId === note.id && n.noteType === 'project');
    return { note, children: children.map(buildNode) };
  };
  return roots.map(buildNode);
}

/** 展开/收起项目树 */
const ProjectPicker: React.FC<{
  nodes: ProjectTreeNode[];
  expandedIds: Set<string>;
  selectedId: string | null;
  onToggleExpand: (id: string) => void;
  onSelect: (note: NoteItem) => void;
}> = ({ nodes, expandedIds, onToggleExpand, selectedId, onSelect }) => {
  const renderNode = (node: ProjectTreeNode, depth: number): React.ReactNode => (
    <div key={node.note.id}>
      <div
        className={`flow-tree-node ${selectedId === node.note.id ? 'flow-tree-node--active' : ''}`}
        style={{ paddingLeft: `${8 + depth * 16}px` }}
        onClick={() => onSelect(node.note)}
      >
        <button
          className="flow-tree-node-chevron"
          onClick={(e) => { e.stopPropagation(); onToggleExpand(node.note.id); }}
        >
          {node.children.length > 0
            ? (expandedIds.has(node.note.id) ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />)
            : <span className="w-3 h-3" />}
        </button>
        <Folder className="w-3 h-3 text-emerald-500 flex-shrink-0" />
        <span className="flow-tree-node-title">{node.note.title || '未命名项目'}</span>
        {node.children.length > 0 && (
          <span className="text-[10px] text-slate-400 flex-shrink-0 ml-1">{node.children.length} 子项目</span>
        )}
      </div>
      {expandedIds.has(node.note.id) && node.children.map(child => renderNode(child, depth + 1))}
    </div>
  );
  return <div className="flow-tree-panel">{nodes.map(n => renderNode(n, 0))}</div>;
};

export const StormMode: React.FC<StormModeProps> = ({ allNotes, onUpdateNote }) => {
  const [entryMode, setEntryMode] = useState<EntryMode>('new');
  const [newTitle, setNewTitle] = useState('');
  const [selectedProject, setSelectedProject] = useState<NoteItem | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [pipelineStage, setPipelineStage] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [currentStep, setCurrentStep] = useState<StormStep | null>(null);
  const [completedSteps, setCompletedSteps] = useState<Set<StormStep>>(new Set());
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [generatedNotes, setGeneratedNotes] = useState<NoteItem[]>([]);

  const projectTree = useMemo(() => buildProjectTreeStructure(allNotes), [allNotes]);

  // 展开/收起项目节点
  const toggleExpand = (id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleStart = async () => {
    let parentProject: NoteItem;
    let subject: string;

    if (entryMode === 'new') {
      const title = newTitle.trim();
      if (!title) return;
      parentProject = makeRootProjectNote(title);
      onUpdateNote(parentProject); // 创建根项目
      subject = title;
    } else {
      if (!selectedProject) return;
      parentProject = selectedProject;
      subject = selectedProject.title;
    }

    setPipelineStage('running');
    setErrorMsg(null);
    setCurrentStep(null);
    setCompletedSteps(new Set());
    setGeneratedNotes([]);

    try {
      await runStormPipeline({
        subject,
        parentProject,
        onUpdateNote,
        onProgress: (status) => {
          setCurrentStep(status.current);
          if (status.state === 'done') {
            setCompletedSteps(prev => new Set(prev).add(status.current));
          }
        },
      });
      setGeneratedNotes(buildStormNoteTree(parentProject));
      setPipelineStage('done');
    } catch (err: any) {
      setErrorMsg(err?.message || 'STORM 流水线执行失败');
      setPipelineStage('error');
    }
  };

  const canStart = entryMode === 'new' ? newTitle.trim().length > 0 : !!selectedProject;

  // 结果态：只展示已生成笔记
  if (pipelineStage === 'done') {
    return (
      <div className="w-full max-w-xl mx-auto p-6 space-y-4">
        <div className="flex items-center gap-2 text-emerald-600">
          <Check className="w-5 h-5" />
          <h3 className="text-sm font-bold">STORM 报告已生成</h3>
        </div>
        <div className="space-y-2">
          {generatedNotes.map(n => (
            <div key={n.id} className="flex items-center gap-2 px-3 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-sm text-slate-700 dark:text-slate-200">
              <FileText className="w-4 h-4 text-indigo-400 flex-shrink-0" />
              <span>{n.title}</span>
            </div>
          ))}
        </div>
        <button
          onClick={() => { setPipelineStage('idle'); setGeneratedNotes([]); setSelectedProject(null); setNewTitle(''); }}
          className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 transition"
        >
          再来一次
        </button>
      </div>
    );
  }

  // 错误态
  if (pipelineStage === 'error') {
    return (
      <div className="w-full max-w-xl mx-auto p-6 space-y-4">
        <div className="flex items-center gap-2 text-red-500">
          <X className="w-5 h-5" />
          <h3 className="text-sm font-bold">STORM 执行失败</h3>
        </div>
        <p className="text-xs text-red-400">{errorMsg}</p>
        <button
          onClick={() => setPipelineStage('idle')}
          className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 transition"
        >
          返回重试
        </button>
      </div>
    );
  }

  // 运行态
  if (pipelineStage === 'running') {
    return (
      <div className="w-full max-w-xl mx-auto p-6 space-y-4">
        <div className="flex items-center gap-2 text-indigo-500">
          <Loader2 className="w-4 h-4 animate-spin" />
          <h3 className="text-sm font-bold">正在生成 STORM 报告...</h3>
        </div>
        <div className="space-y-2">
          {STORM_STEPS.map(step => {
            const isDone = completedSteps.has(step.key);
            const isCurrent = currentStep === step.key && !isDone;
            return (
              <div key={step.key} className="flex items-center gap-2 text-sm">
                {isDone ? (
                  <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                ) : isCurrent ? (
                  <Loader2 className="w-4 h-4 text-indigo-500 animate-spin flex-shrink-0" />
                ) : (
                  <span className="w-4 h-4 rounded-full border border-slate-300 dark:border-slate-600 flex-shrink-0" />
                )}
                <span className={isDone ? 'text-slate-400' : isCurrent ? 'text-slate-800 dark:text-slate-100 font-bold' : 'text-slate-400'}>
                  {step.title}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // 空闲态：入口选择
  return (
    <div className="w-full max-w-2xl mx-auto p-6 space-y-4">
      <div className="flex items-center gap-2">
        <Sparkles className="w-5 h-5 text-amber-500" />
        <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100">STORM · 拓宽视野</h3>
      </div>
      <p className="text-xs text-slate-500">
        围绕一个主题，通过多视角扫描、矛盾图谱、综合简报与同行评审四步，自动生成一份完整的研究文档。
      </p>

      {/* 模式切换 */}
      <div className="flex gap-2">
        <button
          onClick={() => setEntryMode('new')}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${entryMode === 'new' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'}`}
        >
          新建研究项目
        </button>
        <button
          onClick={() => setEntryMode('existing')}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${entryMode === 'existing' ? 'bg-indigo-600 text-white' : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300'}`}
        >
          从已有项目中选择
        </button>
      </div>

      {entryMode === 'new' ? (
        <div className="space-y-2">
          <label className="text-[10px] font-semibold text-slate-500 block">研究主题</label>
          <input
            type="text"
            className="w-full px-3 py-2 text-sm rounded-lg border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-900 text-slate-800 dark:text-slate-200 outline-none focus:ring-2 focus:ring-indigo-500/30"
            placeholder="例如：人工智能对教育的影响"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
          />
        </div>
      ) : (
        <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-y-auto max-h-[50vh]">
          {projectTree.length === 0 ? (
            <div className="text-center py-8 text-slate-400 text-xs">暂无项目笔记</div>
          ) : (
            <ProjectPicker
              nodes={projectTree}
              expandedIds={expandedIds}
              selectedId={selectedProject?.id || null}
              onToggleExpand={toggleExpand}
              onSelect={(note) => setSelectedProject(note)}
            />
          )}
        </div>
      )}

      <button
        onClick={handleStart}
        disabled={!canStart}
        className="w-full px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-40 flex items-center justify-center gap-2 transition"
      >
        <Plus className="w-4 h-4" />
        开始 STORM
      </button>
    </div>
  );
};