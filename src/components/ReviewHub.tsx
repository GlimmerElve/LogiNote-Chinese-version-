import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { NoteItem, StudyQuestionCard } from '../types';
import { Folder, Sparkles, BookOpen, ChevronRight, ChevronDown, BrainCircuit, CheckSquare, Square, ArrowLeft, ArrowRight } from 'lucide-react';
import { collectProjectKnowledgeNotes, selectAnchorsAndWeakPoints } from '../services/knowledgePointSelector';

interface ReviewHubProps {
  allNotes: NoteItem[];
  onEnterReview?: (noteId: string, noteTitle: string, question: string, context: string) => void;
  onEnterBubbleMode?: () => void;
}

type ReviewSubMode = 'select' | 'project' | 'questions';

/** 项目层级树节点（仅 project 类型，体现项目间的父子关系） */
interface ProjectTreeNode {
  note: NoteItem;
  children: ProjectTreeNode[];
}

/** 构建项目层级树：根项目 → 子项目（与心流模式一致的父子关系） */
function buildProjectTreeStructure(notes: NoteItem[]): ProjectTreeNode[] {
  const roots = notes.filter(n => n.noteType === 'project' && !n.parentId);
  const buildNode = (note: NoteItem): ProjectTreeNode => {
    const children = notes.filter(n => n.parentId === note.id && n.noteType === 'project');
    return { note, children: children.map(buildNode) };
  };
  return roots.map(buildNode);
}

/** 递归渲染项目树节点 */
const ProjectTreePanel: React.FC<{
  nodes: ProjectTreeNode[];
  expandedIds: Set<string>;
  onToggleExpand: (id: string) => void;
  onSelect: (note: NoteItem) => void;
}> = ({ nodes, expandedIds, onToggleExpand, onSelect }) => {
  const renderNode = (node: ProjectTreeNode, depth: number): React.ReactNode => (
    <div key={node.note.id}>
      <div
        className="flow-tree-node"
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

/**
 * 构建项目复习的知识点上下文：锚点（掌握较牢）+ 薄弱点（待加强）。
 * 供 review-tutor 在项目复习时「以点带面」使用；无知识点时返回项目标题（降级为默认提问，不输出意图标记）。
 */
function buildReviewKnowledgeContext(project: NoteItem, allNotes: NoteItem[]): string {
  const knowledgeNotes = collectProjectKnowledgeNotes(project.id, allNotes);
  const { anchors, weakPoints } = selectAnchorsAndWeakPoints(knowledgeNotes);

  // 同一笔记不重复：薄弱点排除已作为锚点的笔记
  const anchorIds = new Set(anchors.map((n) => n.id));
  const weakOnly = weakPoints.filter((n) => !anchorIds.has(n.id));

  const anchorNames = anchors.map((n) => n.title);
  const weakNames = weakOnly.map((n) => n.title);

  if (anchorNames.length === 0 && weakNames.length === 0) {
    return project.title;
  }

  const parts: string[] = [`项目：${project.title}`];
  if (anchorNames.length > 0) parts.push(`锚点知识点（掌握较牢）：${anchorNames.join('、')}`);
  if (weakNames.length > 0) parts.push(`薄弱知识点（待加强）：${weakNames.join('、')}`);
  return parts.join('\n');
}

export const ReviewHub: React.FC<ReviewHubProps> = ({ allNotes, onEnterReview, onEnterBubbleMode }) => {
  const [subMode, setSubMode] = useState<ReviewSubMode>('select');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [selectedProject, setSelectedProject] = useState<NoteItem | null>(null);
  const [selectedQuestionIds, setSelectedQuestionIds] = useState<Set<string>>(new Set());

  const projectTree = useMemo(() => buildProjectTreeStructure(allNotes), [allNotes]);

  // 默认展开所有根节点
  useEffect(() => {
    setExpandedIds(new Set(projectTree.map(n => n.note.id)));
  }, [projectTree]);

  const toggleExpand = useCallback((id: string) => {
    setExpandedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  /** 递归收集项目及其子项目、以及挂载在其下的知识笔记 */
  const collectProjectTreeNotes = (note: NoteItem): NoteItem[] => {
    const children = allNotes.filter(n => n.parentId === note.id);
    const result: NoteItem[] = [note];
    children.forEach(child => {
      result.push(...collectProjectTreeNotes(child));
    });
    return result;
  };

  /** 收集项目树下的所有问题卡片 */
  const collectProjectQuestions = (note: NoteItem): StudyQuestionCard[] => {
    const treeNotes = collectProjectTreeNotes(note);
    const cards: StudyQuestionCard[] = [];
    const seen = new Set<string>();
    treeNotes.forEach(n => {
      (n.questions || []).forEach(q => {
        if (!seen.has(q.id)) {
          seen.add(q.id);
          cards.push(q);
        }
      });
    });
    return cards;
  };

  const handleSelectProject = (note: NoteItem) => {
    setSelectedProject(note);
    setSelectedQuestionIds(new Set());
    setSubMode('questions');
  };

  const toggleQuestionSelect = (id: string) => {
    setSelectedQuestionIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleStartQuestionReview = () => {
    if (!selectedProject) return;
    const projectQuestions = collectProjectQuestions(selectedProject);
    const selected = projectQuestions.filter(q => selectedQuestionIds.has(q.id));
    if (selected.length === 0) {
      // 未选中任何问题，保持原有默认流程
      handleStartProjectReview(selectedProject.id, selectedProject.title);
      return;
    }
    const qText = selected.map((q, i) => `${i + 1}. ${q.question}`).join('\n');
    const baseContext = buildReviewKnowledgeContext(selectedProject, allNotes);
    const enrichedContext = `${baseContext}\n\n待复习问题：\n${qText}`;
    const questionText = `关于项目"${selectedProject.title}"，请结合以下问题展开复习`;
    onEnterReview?.(selectedProject.id, selectedProject.title, questionText, enrichedContext);
  };

  const handleStartProjectReview = (noteId: string, noteTitle: string) => {
    const project = allNotes.find(n => n.id === noteId);
    const context = project ? buildReviewKnowledgeContext(project, allNotes) : noteTitle;
    const questionText = `关于项目"${noteTitle}"，你认为其中最重要的核心概念是什么？为什么这些概念对你理解整个项目至关重要？`;
    onEnterReview?.(noteId, noteTitle, questionText, context);
  };

  return (
    <div className="flex-1 h-full overflow-y-auto bg-[#FFFDF7] dark:bg-slate-950">
      {subMode === 'select' && (
        <div className="p-6 space-y-6">
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="review-hub-illustration-icon">
              <BrainCircuit className="w-6 h-6" />
            </div>
            <h2 className="text-lg font-black text-slate-900 dark:text-slate-100">
              今天复习点什么？
            </h2>
            <p className="text-xs text-slate-500">像抽卡一样挑个方式，把该记的稳稳捞回来。</p>
          </div>
          <button onClick={() => setSubMode('project')} className="review-hub-mode-card">
            <div className="review-hub-mode-icon review-hub-mode-icon--emerald">
              <Folder className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <span className="review-hub-mode-title">定向项目复习</span>
              <p className="review-hub-mode-desc">挑一个项目，围绕它的子项目与关联知识点集中提问。</p>
            </div>
            <ArrowRight className="w-4 h-4 review-hub-mode-arrow" />
          </button>
          <button onClick={onEnterBubbleMode} className="review-hub-mode-card">
            <div className="review-hub-mode-icon review-hub-mode-icon--amber">
              <Sparkles className="w-5 h-5" />
            </div>
            <div className="flex-1 min-w-0">
              <span className="review-hub-mode-title">灵光乍现 · 知识气泡</span>
              <p className="review-hub-mode-desc">按遗忘分数排序，像抽盲盒一样抓出最可能被遗忘的知识点。</p>
            </div>
            <ArrowRight className="w-4 h-4 review-hub-mode-arrow" />
          </button>
        </div>
      )}
      {subMode === 'project' && (
        <div className="p-6 space-y-4">
          <button onClick={() => setSubMode('select')} className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline">← 返回</button>
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <Folder className="w-4 h-4 text-emerald-500" />项目结构
          </h3>
          {projectTree.length === 0 ? (
            <div className="text-center py-8 text-slate-400">
              <BookOpen className="w-8 h-8 mx-auto mb-2 opacity-40" />
              <p className="text-xs">暂无项目笔记</p>
            </div>
          ) : (
            <div className="bg-white dark:bg-slate-800 rounded-2xl border border-slate-200 dark:border-slate-700 overflow-hidden">
              <ProjectTreePanel
                nodes={projectTree}
                expandedIds={expandedIds}
                onToggleExpand={toggleExpand}
                onSelect={handleSelectProject}
              />
            </div>
          )}
        </div>
      )}
      {subMode === 'questions' && selectedProject && (
        <div className="p-6 space-y-4">
          <button onClick={() => setSubMode('project')} className="text-xs text-indigo-600 dark:text-indigo-400 hover:underline flex items-center gap-1">
            <ArrowLeft className="w-3.5 h-3.5" /> 返回项目
          </button>
          <h3 className="text-sm font-bold text-slate-900 dark:text-slate-100 flex items-center gap-2">
            <BrainCircuit className="w-4 h-4 text-indigo-500" />{selectedProject.title} · 问题卡片
          </h3>
          <p className="text-xs text-slate-500">勾选要带入苏格拉底式复习上下文的问题卡片，未勾选则使用默认提问。</p>
          {(() => {
            const projectQuestions = collectProjectQuestions(selectedProject);
            return projectQuestions.length === 0 ? (
              <div className="text-center py-8 text-slate-400">
                <BookOpen className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-xs">该项目暂无问题卡片</p>
                <p className="text-xs mt-1">可进入心流模式在提问区添加问题</p>
              </div>
            ) : (
              <div className="space-y-2">
                {projectQuestions.map(q => {
                  const checked = selectedQuestionIds.has(q.id);
                  return (
                    <div
                      key={q.id}
                      className="flex items-start gap-3 p-3 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 cursor-pointer hover:border-indigo-400 dark:hover:border-indigo-600 transition-all"
                      onClick={() => toggleQuestionSelect(q.id)}
                    >
                      <div className="mt-0.5 shrink-0 text-indigo-600 dark:text-indigo-400">
                        {checked ? <CheckSquare className="w-5 h-5" /> : <Square className="w-5 h-5" />}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-slate-800 dark:text-slate-200 leading-snug">{q.question}</p>
                        {q.answer && (
                          <p className="text-xs text-slate-400 mt-1 line-clamp-2">{q.answer}</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          <button
            onClick={handleStartQuestionReview}
            className="w-full px-4 py-2.5 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 transition flex items-center justify-center gap-2"
          >
            <Folder className="w-4 h-4" />
            {selectedQuestionIds.size > 0 ? `开始复习（已选 ${selectedQuestionIds.size} 个问题）` : '开始复习（默认提问）'}
          </button>
        </div>
      )}
    </div>
  );
};
