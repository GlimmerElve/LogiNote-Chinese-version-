import React, { useState, useCallback, useEffect } from 'react';
import { motion } from 'motion/react';
import { PlanNode, NoteItem, PlanStepperStep, ChatMessage, PlanChatResponse } from '../types';
import {
  Plus, Trash2, Calendar, GripVertical,
  Sparkles, Check, Loader2, Target, X,
  ChevronRight, ChevronLeft, Clock, BookOpen, Brain,
} from 'lucide-react';
import { callLLM } from '../services/llmService';
import { Send, MessageCircle } from 'lucide-react';

interface PlanBuilderProps {
  onBatchCreate: (tree: PlanNode[]) => void;
  allNotes: NoteItem[];
}

let nodeKeyCounter = 0;
const nextKey = (): string => `plan-${Date.now()}-${++nodeKeyCounter}`;

const STICKY_COLORS = ['sticky-yellow', 'sticky-coral', 'sticky-mint', 'sticky-purple', 'sticky-rose', 'sticky-teal'];

const getStickyColor = (index: number): string => STICKY_COLORS[index % STICKY_COLORS.length];

// ===== Individual Sticky Note Component =====
const StickyNote: React.FC<{
  node: PlanNode;
  colorIndex: number;
  index: number;
  total: number;
  onTitleChange: (key: string, title: string) => void;
  onDateChange: (key: string, date: string) => void;
  onPriorityChange: (key: string, p: 'high' | 'medium' | 'low') => void;
  onDelete: (key: string) => void;
  onAddChild: (parentKey: string, childTitle?: string) => void;
  onAddSibling: (key: string) => void;
  onChangeParent: (childKey: string, newParentKey: string) => void;
  allSiblingKeys: string[];
  onDragStart: (e: React.DragEvent, key: string) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent, targetKey: string) => void;
  onChildDragStart: (e: React.DragEvent, parentKey: string, childKey: string) => void;
}> = ({
  node, colorIndex, index, total,
  onTitleChange, onDateChange, onPriorityChange, onDelete, onAddChild, onAddSibling,
  onChangeParent, allSiblingKeys,
  onDragStart, onDragOver, onDrop, onChildDragStart,
}) => {
  const [addingChild, setAddingChild] = useState(false);
  const [childInput, setChildInput] = useState('');

  const colorClass = getStickyColor(colorIndex);

  const handleCommitChild = () => {
    if (!childInput.trim()) { setAddingChild(false); setChildInput(''); return; }
    onAddChild(node.key, childInput.trim());
    setChildInput('');
    setAddingChild(false);
  };

  return (
    <div
      className={`sticky-note ${colorClass}`}
      draggable
      onDragStart={(e) => { e.dataTransfer.setData('text/plain', node.key); onDragStart(e, node.key); }}
      onDragOver={onDragOver}
      onDrop={(e) => { e.preventDefault(); onDrop(e, node.key); }}
    >
      {/* Header with title */}
      <div className="sticky-note-header">
        <GripVertical className="w-4 h-4 text-slate-400 flex-shrink-0 cursor-grab" />
        <input
          type="text"
          className="sticky-note-title"
          value={node.title}
          onChange={(e) => onTitleChange(node.key, e.target.value)}
          placeholder="添加阶段名称..."
        />
        <button onClick={() => onDelete(node.key)} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-slate-500" title="删除便签">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Date & Priority */}
      <div className="px-3 flex items-center gap-2 text-[10px] mb-1">
        <input
          type="date"
          className="bg-white/60 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-600 rounded-md px-1.5 py-0.5 text-[10px] outline-none focus:border-indigo-500 w-[110px]"
          value={node.dueDate || ''}
          onChange={(e) => onDateChange(node.key, e.target.value)}
        />
        <select
          className="bg-white/60 dark:bg-slate-800/60 border border-slate-300 dark:border-slate-600 rounded-md px-1 py-0.5 text-[10px] outline-none"
          value={node.priority || 'medium'}
          onChange={(e) => onPriorityChange(node.key, e.target.value as 'high' | 'medium' | 'low')}
        >
          <option value="high">高</option>
          <option value="medium">中</option>
          <option value="low">低</option>
        </select>
      </div>

      {/* Children (mini sub-notes) */}
      <div className="sticky-note-body">
        {node.children.map((child, ci) => (
          <div
            key={child.key}
            className="sticky-child-row"
            draggable
            onDragStart={(e) => { e.stopPropagation(); onChildDragStart(e, node.key, child.key); }}
          >
            <span className="flex-shrink-0">◦</span>
            <input
              className="sticky-child-input"
              value={child.title}
              onChange={(e) => onTitleChange(child.key, e.target.value)}
              placeholder="子任务..."
            />
            <input
              type="date"
              className="sticky-child-date"
              value={child.dueDate || ''}
              onChange={(e) => onDateChange(child.key, e.target.value)}
            />
            <button
              onClick={() => onDelete(child.key)}
              className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-slate-400 flex-shrink-0"
              title="删除子任务"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        ))}
        {addingChild && (
          <div className="sticky-child-row">
            <span className="flex-shrink-0">◦</span>
            <input
              autoFocus
              className="sticky-child-input"
              value={childInput}
              onChange={(e) => setChildInput(e.target.value)}
              onBlur={handleCommitChild}
              onKeyDown={(e) => { if (e.key === 'Enter') handleCommitChild(); if (e.key === 'Escape') setAddingChild(false); }}
              placeholder="输入子任务名称，回车确认..."
            />
            <input
              type="date"
              className="sticky-child-date"
              onChange={(e) => {/* date will be set after creation via the child node */}}
            />
          </div>
        )}
      </div>

      {/* Footer actions */}
      <div className="sticky-note-actions">
        <button onClick={() => setAddingChild(true)} className="flex items-center gap-0.5 hover:text-indigo-600" title="添加子任务">
          <Plus className="w-3 h-3" /> 子任务
        </button>
        <span className="mx-1 opacity-30">|</span>
        <button onClick={() => onAddSibling(node.key)} className="hover:text-emerald-600" title="添加新便签">
          ✚ 新增
        </button>
      </div>
    </div>
  );
};

// ===== Main PlanBuilder Workbench =====
export const PlanBuilder: React.FC<PlanBuilderProps> = ({ onBatchCreate, allNotes }) => {
  const [rootTitle, setRootTitle] = useState('');
  const [rootDueDate, setRootDueDate] = useState('');
  const [rootPriority, setRootPriority] = useState<'high' | 'medium' | 'low'>('medium');
  const [planNodes, setPlanNodes] = useState<PlanNode[]>([]);

  const [aiStep, setAiStep] = useState<PlanStepperStep>(0);
  const [aiSubject, setAiSubject] = useState('');
  const [aiExpectation, setAiExpectation] = useState('');
  const [aiDailyHours, setAiDailyHours] = useState(2);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');

  // 生成等待弹窗的轮换文案
  const loadingTips = [
    '正在生成学习计划…',
    '正在拆分学习阶段…',
    '正在安排子任务…',
    '正在计算时间节点…',
    '正在优化学习路径…',
  ];
  const [loadingTipIndex, setLoadingTipIndex] = useState(0);

  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dragParentKey, setDragParentKey] = useState<string | null>(null);

  // Recursive helpers
  const updateNodeRecursive = useCallback((nodes: PlanNode[], key: string, updater: (n: PlanNode) => PlanNode): PlanNode[] => {
    return nodes.map(n => {
      if (n.key === key) return updater(n);
      return { ...n, children: updateNodeRecursive(n.children, key, updater) };
    });
  }, []);

  const deleteNodeRecursive = useCallback((nodes: PlanNode[], key: string): PlanNode[] => {
    return nodes.filter(n => n.key !== key).map(n => ({
      ...n,
      children: deleteNodeRecursive(n.children, key)
    }));
  }, []);

  const handleTitleChange = (key: string, title: string) => {
    setPlanNodes(prev => updateNodeRecursive(prev, key, n => ({ ...n, title })));
  };

  const handleDateChange = (key: string, date: string) => {
    setPlanNodes(prev => updateNodeRecursive(prev, key, n => ({ ...n, dueDate: date || undefined })));
  };

  const handlePriorityChange = (key: string, priority: 'high' | 'medium' | 'low') => {
    setPlanNodes(prev => updateNodeRecursive(prev, key, n => ({ ...n, priority })));
  };

  const handleDelete = (key: string) => {
    setPlanNodes(prev => deleteNodeRecursive(prev, key));
  };

  const handleAddSibling = (key: string) => {
    const newSticky: PlanNode = { key: nextKey(), title: '', priority: 'medium', children: [] };
    setPlanNodes(prev => {
      const idx = prev.findIndex(n => n.key === key);
      if (idx !== -1) {
        const updated = [...prev];
        updated.splice(idx + 1, 0, newSticky);
        return updated;
      }
      return [...prev, newSticky];
    });
  };

  const handleAddChild = (parentKey: string, childTitle?: string) => {
    const newChild: PlanNode = { key: nextKey(), title: childTitle || '', priority: 'medium', children: [] };
    setPlanNodes(prev => updateNodeRecursive(prev, parentKey, n => ({
      ...n,
      children: [...n.children, newChild]
    })));
  };

  const handleRemoveChildFromParent = (childKey: string, newParentKey: string) => {
    // Remove from current parent and add to new parent
    setPlanNodes(prev => {
      // First remove the child from wherever it is
      const removeFromAll = (nodes: PlanNode[]): { nodes: PlanNode[]; removed?: PlanNode } => {
        for (let i = 0; i < nodes.length; i++) {
          const childResult = removeFromAll(nodes[i].children);
          if (childResult.removed) {
            return {
              nodes: nodes.map((n, idx) => idx === i ? { ...n, children: childResult.nodes } : n),
              removed: childResult.removed
            };
          }
          if (nodes[i].key === childKey) {
            return { nodes: nodes.filter((_, idx) => idx !== i), removed: nodes[i] };
          }
        }
        return { nodes };
      };
      const { nodes: without, removed } = removeFromAll(prev);
      if (!removed) return prev;
      // Add to new parent
      return updateNodeRecursive(without, newParentKey, n => ({
        ...n,
        children: [...n.children, removed]
      }));
    });
  };

  // ===== Drag & Drop =====
  const handleDragStart = (e: React.DragEvent, key: string) => {
    setDragKey(key);
  };

  const handleChildDragStart = (e: React.DragEvent, parentKey: string, childKey: string) => {
    setDragKey(childKey);
    setDragParentKey(parentKey);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = (e: React.DragEvent, targetKey: string) => {
    e.preventDefault();
    if (!dragKey || dragKey === targetKey) return;

    setPlanNodes(prev => {
      // If dragParentKey was set, it was a child being dragged
      if (dragParentKey) {
        // Move child from old parent to new parent
        let movedNode: PlanNode | undefined;
        const removeFromParent = (nodes: PlanNode[]): PlanNode[] => {
          return nodes.map(n => {
            if (n.key === dragParentKey) {
              const newChildren = n.children.filter(c => {
                if (c.key === dragKey) { movedNode = c; return false; }
                return true;
              });
              return { ...n, children: newChildren };
            }
            return { ...n, children: removeFromParent(n.children) };
          });
        };
        const without = removeFromParent(prev);
        if (!movedNode) return prev;
        // Add to target (as child)
        return updateNodeRecursive(without, targetKey, n => ({
          ...n,
          children: [...n.children, movedNode!]
        }));
      }

      // Top-level reorder
      const fromIdx = prev.findIndex(n => n.key === dragKey);
      const toIdx = prev.findIndex(n => n.key === targetKey);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const updated = [...prev];
      const [moved] = updated.splice(fromIdx, 1);
      updated.splice(toIdx, 0, moved);
      return updated;
    });

    setDragKey(null);
    setDragParentKey(null);
  };

  const handleAddSticky = () => {
    const newSticky: PlanNode = {
      key: nextKey(),
      title: '',
      priority: 'medium',
      children: [],
    };
    setPlanNodes(prev => [...prev, newSticky]);
  };

  // ===== Generate Project Tree =====
  const handleCreateProjectTree = () => {
    if (!rootTitle.trim() && planNodes.length === 0) return;

    // Build the full tree with root as a PlanNode
    const rootNode: PlanNode = {
      key: 'root',
      title: rootTitle.trim() || '未命名学习计划',
      dueDate: rootDueDate || undefined,
      priority: rootPriority,
      children: planNodes.filter(n => n.title.trim() || n.children.length > 0),
    };

    onBatchCreate([rootNode]);
  };

  // ===== AI Stepper =====
  const aiStepperSteps = [
    { step: 1, title: '想学什么？', label: '学习目标', placeholder: '例如：考研数学基础、Python 数据分析、CPA 财务管理...', field: aiSubject, setter: setAiSubject, hint: '描述你想学习的具体领域或技能' },
    { step: 2, title: '期望达到什么效果？', label: '期望效果', placeholder: '例如：数学120分以上、能独立完成数据分析项目、通过六科考试...', field: aiExpectation, setter: setAiExpectation, hint: '描述你希望达成的具体目标或里程碑' },
    { step: 3, title: '每天可以投入多长时间？', label: '每日时间', placeholder: '', field: aiDailyHours, setter: setAiDailyHours, hint: 'AI 将根据时间约束合理安排学习阶段', isTimeSelect: true },
  ];

  const handleCloseStepper = () => {
    setAiStep(0);
    setAiSubject('');
    setAiExpectation('');
    setAiDailyHours(2);
    setAiError(null);
    setChatMessages([]);
    setChatInput('');
  };

  /** 多轮对话控制器：追问 → 回答 → 直到 isComplete → 生成计划 */
  const planChatLoop = async (userReply?: string) => {
    setAiLoading(true);
    setAiError(null);

    const today = new Date().toISOString().slice(0, 10);
    const baseUserInput = `学习目标：${aiSubject.trim()}\n期望效果：${aiExpectation.trim() || '未指定'}\n每日可投入：${aiDailyHours}小时\n当前日期：${today}`;
    const existingNotes = allNotes.map(n => n.title).join(', ');

    try {
      const response = await callLLM({
        providerId: '', model: '',
        workflow: 'plan-generation',
        userInput: userReply || baseUserInput,
        context: { noteTitle: rootTitle || aiSubject.trim().slice(0, 20) || '未命名学习计划', existingNotes },
        messages: chatMessages.length > 0 ? [
          { role: 'assistant', content: `初始信息：${baseUserInput}` },
          ...chatMessages,
          { role: 'user', content: userReply || '' },
        ] : undefined,
      });

      const parsed = response.parsedJson;

      // 检测是否返回了追问
      if (parsed && parsed.question && !parsed.isComplete) {
        const newMsgs: ChatMessage[] = [
          ...(userReply ? [{ role: 'user' as const, content: userReply }] : []),
          { role: 'assistant', content: parsed.question },
        ];
        setChatMessages(prev => [...prev, ...newMsgs]);
        setAiLoading(false);
        return;
      }

      // 对话完成，解析计划树
      if (parsed && parsed.planTree && Array.isArray(parsed.planTree)) {
        const toPlanNodes = (nodes: any[]): PlanNode[] =>
          nodes.map(n => ({
            key: nextKey(),
            title: n.title || '',
            dueDate: n.dueDate || undefined,
            priority: n.priority || 'medium',
            children: n.children ? toPlanNodes(n.children) : [],
          }));
        const generated = toPlanNodes(parsed.planTree);
        if (generated.length > 0) {
          setRootTitle(parsed.rootTitle || rootTitle || aiSubject.trim().slice(0, 20));
          setPlanNodes(generated);
        }
        setAiStep(0);
        setChatMessages([]);
        setChatInput('');
      } else {
        // 未返回追问或计划，按原有逻辑处理
        const toPlanNodes = (nodes: any[]): PlanNode[] =>
          nodes.map(n => ({ key: nextKey(), title: n.title || '', dueDate: n.dueDate || undefined, priority: n.priority || 'medium', children: n.children ? toPlanNodes(n.children) : [] }));
        const generated = toPlanNodes(parsed?.planTree || []);
        if (generated.length > 0) {
          setRootTitle(parsed?.rootTitle || rootTitle || aiSubject.trim().slice(0, 20));
          setPlanNodes(generated);
        }
        setAiStep(0);
        setChatMessages([]);
        setChatInput('');
      }
    } catch (err: any) {
      setAiError(err.message || 'AI 生成失败');
    } finally {
      setAiLoading(false);
    }
  };

  /** 步骤3 → 进入对话阶段（步骤4） */
  const handleEnterChat = async () => {
    setAiStep(4);
    await planChatLoop();
  };

  /** 用户在对话阶段发送回复 */
  const handleChatSend = async () => {
    if (!chatInput.trim() || aiLoading) return;
    const reply = chatInput.trim();
    setChatInput('');
    await planChatLoop(reply);
  };

  // 生成等待时轮换提示文案
  useEffect(() => {
    if (!aiLoading) {
      setLoadingTipIndex(0);
      return;
    }
    const timer = setInterval(() => {
      setLoadingTipIndex((prev) => (prev + 1) % loadingTips.length);
    }, 1400);
    return () => clearInterval(timer);
  }, [aiLoading]);

  const hasValidContent = rootTitle.trim() || planNodes.length > 0;

  return (
    <div className="flex-1 h-[calc(100vh-3.5rem)] flex flex-col bg-[#FFFDF7] dark:bg-slate-950 overflow-hidden">
      {/* ===== Title Bar ===== */}
      <div className="p-4 flex-shrink-0 space-y-3">
        <div className="workbench-title-bar p-4">
          <div className="flex items-center gap-3 mb-3">
            <Target className="w-6 h-6 text-indigo-600 dark:text-indigo-400 flex-shrink-0" />
            <input
              type="text"
              className="flex-1 text-lg font-black text-slate-900 dark:text-slate-100 bg-transparent border-none outline-none placeholder:text-slate-400 placeholder:font-normal"
              placeholder="在这里输入一级目标名称，例如「Python 全栈学习计划」..."
              value={rootTitle}
              onChange={(e) => setRootTitle(e.target.value)}
            />
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-1.5 text-xs">
              <Calendar className="w-3.5 h-3.5 text-slate-500" />
              <input
                type="date"
                className="bg-slate-50 dark:bg-slate-800 border-2 border-slate-300 dark:border-slate-600 rounded-lg px-2 py-1 text-xs outline-none focus:border-indigo-500"
                value={rootDueDate}
                onChange={(e) => setRootDueDate(e.target.value)}
              />
            </div>
            <select
              className="bg-slate-50 dark:bg-slate-800 border-2 border-slate-300 dark:border-slate-600 rounded-lg px-2 py-1 text-xs outline-none focus:border-indigo-500"
              value={rootPriority}
              onChange={(e) => setRootPriority(e.target.value as 'high' | 'medium' | 'low')}
            >
              <option value="high">高优先级</option>
              <option value="medium">中优先级</option>
              <option value="low">低优先级</option>
            </select>
          </div>
        </div>

        {/* Action buttons row */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setAiStep(1); setAiError(null); }}
            className="px-3 py-1.5 rounded-xl border-2 border-slate-800 dark:border-slate-300 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-bold hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition flex items-center gap-1 shadow-[2px_2px_0_rgba(45,52,54,0.2)]"
          >
            <Sparkles className="w-3.5 h-3.5" />
            AI 分析文本导入
          </button>
          <div className="flex-1" />
          <span className="text-[10px] text-slate-400 mr-1">
            {planNodes.length} 个阶段便签
          </span>
          <button
            onClick={handleCreateProjectTree}
            disabled={!hasValidContent}
            className="px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-black hover:bg-indigo-700 shadow-[3px_3px_0_rgba(79,70,229,0.3)] transition flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
          >
            <Check className="w-4 h-4" />
            一键生成项目树!
          </button>
        </div>

        {/* ===== AI Stepper Modal ===== */}
        {aiStep > 0 && (
          <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center" onClick={handleCloseStepper}>
            <div className="bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-lg mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
              {/* Header */}
              <div className="bg-indigo-600 px-5 py-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Brain className="w-5 h-5 text-white" />
                  <span className="text-white font-black text-sm">AI 智能规划</span>
                </div>
                <button onClick={handleCloseStepper} className="p-1 rounded-lg text-white/70 hover:text-white hover:bg-white/20 transition">
                  <X className="w-4 h-4" />
                </button>
              </div>

              {/* Stepper Breadcrumb */}
              <div className="flex items-center justify-center gap-1 px-5 py-4 border-b border-slate-100 dark:border-slate-800">
                {aiStepperSteps.map((s, idx) => {
                  const isActive = aiStep === s.step;
                  const isDone = aiStep > s.step;
                  const canClick = isDone;
                  return (
                    <React.Fragment key={s.step}>
                      {idx > 0 && (
                        <div className={`w-8 h-0.5 rounded-full transition-colors ${isDone ? 'bg-indigo-400' : 'bg-slate-200 dark:bg-slate-700'}`} />
                      )}
                      <button
                        disabled={!canClick}
                        onClick={() => { if (canClick) setAiStep(s.step as PlanStepperStep); }}
                        className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-black transition-all ${
                          isActive ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-200 dark:shadow-indigo-900 scale-110' :
                          isDone ? 'bg-indigo-100 dark:bg-indigo-900/40 text-indigo-600 dark:text-indigo-300 cursor-pointer hover:bg-indigo-200' :
                          'bg-slate-100 dark:bg-slate-800 text-slate-400'
                        }`}
                      >
                        {s.step}
                      </button>
                    </React.Fragment>
                  );
                })}
              </div>

              {/* Step Content */}
              <div className="p-5">
                {aiStepperSteps.filter(s => s.step === aiStep).map(s => (
                  <div key={s.step} className="space-y-4">
                    <div className="text-center">
                      <h3 className="text-lg font-black text-slate-900 dark:text-slate-100 mt-2">{s.title}</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">{s.hint}</p>
                    </div>
                    {s.isTimeSelect ? (
                      <div className="flex justify-center gap-2">
                        {[1, 2, 3, 4, 6, 8].map(h => (
                          <button
                            key={h}
                            onClick={() => setAiDailyHours(h)}
                            className={`w-16 h-16 rounded-2xl border-2 transition-all flex flex-col items-center justify-center gap-1 ${
                              aiDailyHours === h
                                ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/60 text-indigo-700 dark:text-indigo-300 shadow-lg scale-105'
                                : 'border-slate-200 dark:border-slate-700 hover:border-slate-300 dark:hover:border-slate-600 text-slate-600 dark:text-slate-400'
                            }`}
                          >
                            <span className="text-lg font-black">{h}</span>
                            <span className="text-[10px] font-medium">小时/天</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <textarea
                        autoFocus
                        className="w-full min-h-[80px] text-sm bg-slate-50 dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl px-4 py-3 text-slate-800 dark:text-slate-200 placeholder-slate-400 resize-none outline-none focus:border-indigo-400 transition-colors"
                        placeholder={s.placeholder}
                        value={s.field as string}
                        onChange={(e) => (s.setter as (v: string) => void)(e.target.value)}
                      />
                    )}
                    {s.step === 2 && aiExpectation.trim() && (
                      <div className="px-3 py-2 rounded-xl bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 text-[11px] text-amber-700 dark:text-amber-300 flex items-start gap-2">
                        <Sparkles className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                        <span>设定明确目标，AI 会为你规划更精准的学习路径</span>
                      </div>
                    )}
                  </div>
                ))}

                {/* ===== Step 4: AI 对话追问 ===== */}
                {aiStep === 4 && (
                  <div className="space-y-3">
                    <div className="text-center">
                      <h3 className="text-lg font-black text-slate-900 dark:text-slate-100 mt-2">AI 正在了解你的情况</h3>
                      <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">请回答 AI 的问题，帮助生成更精准的学习计划</p>
                    </div>
                    {/* 聊天气泡 */}
                    <div className="max-h-64 overflow-y-auto space-y-2 px-1">
                      {chatMessages.length === 0 && aiLoading && (
                        <div className="flex items-center gap-2 text-xs text-slate-400 py-2">
                          <Loader2 className="w-4 h-4 animate-spin" /> AI 正在分析你的学习需求...
                        </div>
                      )}
                      {chatMessages.map((msg, idx) => (
                        <div
                          key={idx}
                          className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                        >
                          <div
                            className={`max-w-[85%] px-3 py-2 rounded-2xl text-xs leading-relaxed ${
                              msg.role === 'user'
                                ? 'bg-indigo-500 text-white rounded-br-md'
                                : 'bg-slate-100 dark:bg-slate-800 text-slate-800 dark:text-slate-200 rounded-bl-md'
                            }`}
                          >
                            {msg.content}
                          </div>
                        </div>
                      ))}
                      {aiLoading && chatMessages.length > 0 && (
                        <div className="flex justify-start">
                          <div className="px-3 py-2 rounded-2xl bg-slate-100 dark:bg-slate-800 rounded-bl-md">
                            <Loader2 className="w-4 h-4 animate-spin text-indigo-400" />
                          </div>
                        </div>
                      )}
                    </div>
                    {/* 输入框 */}
                    <div className="flex gap-2">
                      <input
                        autoFocus
                        type="text"
                        value={chatInput}
                        onChange={e => setChatInput(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleChatSend(); } }}
                        placeholder="输入你的回答..."
                        disabled={aiLoading}
                        className="flex-1 px-3 py-2 text-xs bg-slate-50 dark:bg-slate-800 border-2 border-slate-200 dark:border-slate-700 rounded-xl outline-none focus:border-indigo-400 text-slate-800 dark:text-slate-200 placeholder-slate-400 disabled:opacity-50"
                      />
                      <button
                        onClick={handleChatSend}
                        disabled={!chatInput.trim() || aiLoading}
                        className="px-3 py-2 rounded-xl bg-indigo-500 text-white hover:bg-indigo-600 transition disabled:opacity-40"
                      >
                        <Send className="w-4 h-4" />
                      </button>
                    </div>
                    {/* 直接生成按钮 */}
                    <div className="text-center pt-2 border-t border-slate-100 dark:border-slate-800">
                      <button
                        onClick={() => planChatLoop('请直接生成最终学习计划，不要再追问')}
                        disabled={aiLoading}
                        className="px-4 py-1.5 rounded-lg text-[10px] font-bold text-slate-400 hover:text-indigo-500 hover:bg-indigo-50 dark:hover:bg-indigo-950/30 transition"
                      >
                        跳过对话，直接生成计划 →
                      </button>
                    </div>
                  </div>
                )}

                {aiError && (
                  <div className="mt-3 px-3 py-2 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400">
                    {aiError}
                  </div>
                )}

                {/* Navigation */}
                <div className="flex items-center justify-between mt-5 pt-4 border-t border-slate-100 dark:border-slate-800">
                  <button
                    onClick={() => setAiStep((prev) => Math.max(1, prev - 1) as PlanStepperStep)}
                    disabled={aiStep === 1}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 disabled:opacity-30 disabled:cursor-not-allowed transition flex items-center gap-1"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    上一步
                  </button>

                  {aiStep < 3 ? (
                    <button
                      onClick={() => setAiStep((prev) => Math.min(3, prev + 1) as PlanStepperStep)}
                      disabled={(aiStep === 1 && !aiSubject.trim())}
                      className="px-4 py-1.5 rounded-lg bg-indigo-500 text-white text-xs font-bold hover:bg-indigo-600 transition flex items-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      下一步
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  ) : aiStep === 3 ? (
                    <button
                      onClick={handleEnterChat}
                      disabled={aiLoading}
                      className="px-5 py-2 rounded-lg bg-indigo-600 text-white text-sm font-black hover:bg-indigo-700 transition flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {aiLoading ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          AI 分析中...
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-4 h-4" />
                          开始对话
                        </>
                      )}
                    </button>
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ===== Sticky Notes Workbench ===== */}
      <div className="flex-1 overflow-y-auto bg-[#F5F0E8] dark:bg-slate-900/50 border-t-2 border-slate-300 dark:border-slate-700">
        <div className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <span className="text-xs font-black text-slate-600 dark:text-slate-400 uppercase tracking-wider">阶段便签工作台</span>
            <span className="text-[10px] text-slate-400">拖拽便签排序，在便签内添加子任务</span>
          </div>
        </div>
        <div className="sticky-notes-grid">
          {planNodes.map((node, idx) => (
            <StickyNote
              key={node.key}
              node={node}
              colorIndex={idx}
              index={idx}
              total={planNodes.length}
              onTitleChange={handleTitleChange}
              onDateChange={handleDateChange}
              onPriorityChange={handlePriorityChange}
              onDelete={handleDelete}
              onAddChild={handleAddChild}
              onAddSibling={handleAddSibling}
              onChangeParent={handleRemoveChildFromParent}
              allSiblingKeys={planNodes.map(n => n.key)}
              onDragStart={handleDragStart}
              onDragOver={handleDragOver}
              onDrop={handleDrop}
              onChildDragStart={handleChildDragStart}
            />
          ))}
          {/* Add new sticky button */}
          <button
            onClick={handleAddSticky}
            className="workbench-add-sticky"
          >
            <div className="flex flex-col items-center gap-1 text-slate-400 hover:text-indigo-600 transition-colors">
              <Plus className="w-8 h-8" />
              <span className="text-xs font-black">添加阶段便签</span>
            </div>
          </button>
        </div>
        {planNodes.length === 0 && (
          <div className="flex-1 flex items-center justify-center py-20">
            <div className="text-center space-y-3">
              <p className="text-sm font-black text-slate-500 dark:text-slate-400">工作台还是空的!</p>
              <p className="text-xs text-slate-400">在上方输入一级目标名称，然后点击「添加阶段便签」开始制定计划</p>
            </div>
          </div>
        )}
      </div>

      {/* ===== 生成计划等待弹窗 ===== */}
      {aiLoading && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <motion.div
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-white dark:bg-slate-900 rounded-2xl border-2 border-indigo-200 dark:border-indigo-800 shadow-2xl px-10 py-8 flex flex-col items-center gap-5"
          >
            <motion.div
              animate={{ y: [0, -10, 0], rotate: [0, -6, 6, 0] }}
              transition={{ duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
              className="w-16 h-16 rounded-xl bg-indigo-600 flex items-center justify-center shadow-lg"
            >
              <Brain className="w-9 h-9 text-white" />
            </motion.div>

            <div className="text-center space-y-2">
              <p className="text-sm font-black text-slate-800 dark:text-slate-100">
                {loadingTips[loadingTipIndex]}
              </p>
              <div className="flex items-center justify-center gap-1.5 pt-1">
                {[0, 1, 2].map((i) => (
                  <motion.span
                    key={i}
                    className="w-2 h-2 rounded-full bg-indigo-500"
                    animate={{ y: [0, -6, 0] }}
                    transition={{ duration: 0.8, repeat: Infinity, delay: i * 0.15 }}
                  />
                ))}
              </div>
            </div>

            <p className="text-[11px] text-slate-400">AI 正在思考，复杂计划可能需要一点时间</p>
          </motion.div>
        </div>
      )}
    </div>
  );
};
