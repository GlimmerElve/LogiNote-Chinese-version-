import React, { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { useDialog, hasActiveDialog, isTextInput } from './useDialog';
import { chooseDocumentFiles, uploadDocuments } from '../services/documentRagClient';
import './progressive/progressiveCourse.css';
import { loadManualPlanDraft, loadConflictingManualPlanDraft, saveManualPlanDraft } from '../services/ui/manualPlanDraft';
import { createUndoHistory, recordUndoHistory, moveUndoHistory, type UndoHistory } from '../services/ui/undoHistory';
import { motion } from 'motion/react';
import type {
  PlanConditions,
  PlanMeta,
  PlanMilestone,
  PlanNode,
  PlanPace,
  PlanStartingLevel,
  PlanStepperStep,
  ChatMessage,
  PlanTaskBlueprint,
  PlanTaskKind,
} from '../types';
import {
  Plus, Trash2, Calendar, GripVertical,
  Sparkles, Check, Loader2, Target, X,
  ChevronRight, ChevronLeft, Clock, BookOpen, Brain,
  AlertTriangle, CalendarRange, Gauge, Settings2, SlidersHorizontal, TimerReset,
  FileCheck2, RotateCcw,
} from 'lucide-react';
import { callLLM } from '../services/llmService';
import { preparePlanResearch, planResearchSubject, planResearchContext, checkPlanResearchCitations, type PlanResearchPreparation } from '../services/planResearch';
import { assertGeneratedPlanCoreScope, PLAN_CORE_SCOPE_RULES } from '../services/planCoreScope';
import { assessPlanConditions } from '../services/planConditionService';
import { Send } from 'lucide-react';
import { PlanDualTrackComposer } from './PlanDualTrackComposer';
import { StudyMinutesInput } from './StudyMinutesInput';
import type { PlanTimelineSettings } from './PlanDualTrackComposer';
import type { PublishedPlanEditorValue } from '../services/publishedPlanEditor';
import { assertPlanStructureGranularity } from '../services/planStructureGranularity';
import './PlanBuilder.css';
import { buildLearningCapacity, cachedCapacitySettings, personalWeeklyBudget, previewDraftCapacity, validStudyMinutes, weekStartDate } from '../services/learningCapacity';
import { homeLocalDate } from '../services/homepage/homeTaskScheduling';

interface PlanBuilderProps {
  capacitySettings?: Partial<import('../types').VaultSettings>;
  allPlanNotes?: import('../types').NoteItem[];
  onOpenLearningSettings?: () => void;
  onBatchCreate: (tree: PlanNode[], planMeta?: Partial<PlanMeta>) => void | Promise<void>;
  initialValue?: PublishedPlanEditorValue | null;
  draftValue?: PlanBuilderDraftValue | null;
  onBatchUpdate?: (rootId: string, tree: PlanNode[], planMeta?: Partial<PlanMeta>, baseValue?: PublishedPlanEditorValue) => void | Promise<void>;
  /** Mirrors the live editor state for crash-safe Agent draft recovery; it never commits notes. */
  onDraftChange?: (value: PlanBuilderDraftValue) => void;
  onCancel?: () => void;
  /** Manual drafts are kept separately from Agent scope/revision locks. */
  draftStorageKey?: string;
  isActive?: boolean;
}

export interface PlanBuilderDraftValue {
  tree: [PlanNode];
  planMeta: Partial<PlanMeta>;
  sourceLabel?: string;
}

let legacyNodeKeyCounter = 0;
const nextKey = (): string => `plan-${Date.now()}-${++legacyNodeKeyCounter}`;

const STICKY_COLORS = ['sticky-yellow', 'sticky-coral', 'sticky-mint', 'sticky-purple', 'sticky-rose', 'sticky-teal'];
const getStickyColor = (index: number): string => STICKY_COLORS[index % STICKY_COLORS.length];

const PLAN_TASK_KINDS = new Set<PlanTaskKind>(['learn', 'practice', 'review', 'assessment']);
const TASK_KIND_LABEL: Record<PlanTaskKind, string> = {
  learn: '学习',
  practice: '练习',
  review: '复习',
  assessment: '测验',
};
const WEEKDAYS = [
  { value: 1, label: '一' }, { value: 2, label: '二' }, { value: 3, label: '三' },
  { value: 4, label: '四' }, { value: 5, label: '五' }, { value: 6, label: '六' },
  { value: 0, label: '日' },
];
const STARTING_LEVEL_LABEL: Record<PlanStartingLevel, string> = {
  new: '从零开始', basic: '了解基础', intermediate: '已有实践', advanced: '进阶提升',
};
const PACE_LABEL: Record<PlanPace, string> = {
  relaxed: '舒缓', balanced: '均衡', intensive: '密集',
};

const asDate = (value: unknown): string | undefined => /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? String(value) : undefined;

function parsePlanTask(value: any, index: number): PlanTaskBlueprint | null {
  const text = String(value?.text || '').trim();
  const dueDate = asDate(value?.dueDate);
  if (!text || !dueDate) return null;
  const kind = PLAN_TASK_KINDS.has(value?.kind) ? value.kind as PlanTaskKind : 'learn';
  const rawMinutes = Number(value?.estimatedMinutes);
  return {
    key: String(value?.key || `task-${index + 1}`).trim(),
    text,
    kind,
    startDate: asDate(value?.startDate),
    dueDate,
    estimatedMinutes: Number.isFinite(rawMinutes) && rawMinutes > 0 ? Math.min(1440, Math.max(5, Math.round(rawMinutes))) : 60,
    priority: ['high', 'medium', 'low'].includes(value?.priority) ? value.priority : 'medium',
    dependencyKeys: Array.isArray(value?.dependencyKeys) ? value.dependencyKeys.map((item: unknown) => String(item || '').trim()).filter(Boolean) : [],
    milestoneId: value?.milestoneId ? String(value.milestoneId).trim() : undefined,
    executionKind: ['todo', 'flow', 'practice', 'review'].includes(value?.executionKind) ? value.executionKind : undefined,
    recurrence: value?.recurrence && ['none', 'daily', 'weekdays', 'weekly', 'custom'].includes(value.recurrence.frequency) ? {
      frequency: value.recurrence.frequency,
      interval: Math.max(1, Number(value.recurrence.interval) || 1),
      weekdays: Array.isArray(value.recurrence.weekdays) ? value.recurrence.weekdays.filter((day: unknown) => Number.isInteger(day) && Number(day) >= 0 && Number(day) <= 6) : undefined,
      timeOfDay: value.recurrence.timeOfDay ? String(value.recurrence.timeOfDay) : undefined,
      endDate: asDate(value.recurrence.endDate),
      missedPolicy: ['skip', 'rollover', 'keep'].includes(value.recurrence.missedPolicy) ? value.recurrence.missedPolicy : 'rollover',
    } : undefined,
    linkedProjectKey: value?.linkedProjectKey ? String(value.linkedProjectKey).trim() : undefined,
    launchMode: ['none', 'flow', 'scene', 'review'].includes(value?.launchMode) ? value.launchMode : undefined,
    reminderMinutes: Number.isFinite(Number(value?.reminderMinutes)) ? Math.max(0, Number(value.reminderMinutes)) : undefined,
    displayRow: Number.isInteger(value?.displayRow) ? Math.max(0, Number(value.displayRow)) : 0,
    source: 'llm',
  };
}

function parsePlanNodes(values: any[]): PlanNode[] {
  return values.map((value, index) => {
    const milestoneDueDate = asDate(value?.milestone?.dueDate);
    return {
      key: String(value?.key || `phase-${index + 1}`).trim(),
      title: String(value?.title || '').trim(),
      startDate: asDate(value?.startDate),
      dueDate: asDate(value?.dueDate),
      priority: ['high', 'medium', 'low'].includes(value?.priority) ? value.priority : 'medium',
      outcome: value?.outcome ? String(value.outcome).trim() : undefined,
      estimatedMinutes: validStudyMinutes(value?.estimatedMinutes) ? value.estimatedMinutes : undefined,
      milestone: milestoneDueDate && value?.milestone?.title ? {
        id: String(value.milestone.id || `milestone-${index + 1}`).trim(),
        title: String(value.milestone.title).trim(),
        dueDate: milestoneDueDate,
        description: value.milestone.description ? String(value.milestone.description).trim() : undefined,
      } : undefined,
      tasks: Array.isArray(value?.tasks)
        ? value.tasks.map(parsePlanTask).filter((task: PlanTaskBlueprint | null): task is PlanTaskBlueprint => Boolean(task))
        : [],
      children: Array.isArray(value?.children) ? parsePlanNodes(value.children) : [],
    };
  }).filter((node) => node.title || node.children.length > 0);
}

function countBlueprint(nodes: PlanNode[]): { phases: number; tasks: number; milestones: number } {
  return nodes.reduce((total, node) => {
    const nested = countBlueprint(node.children);
    return {
      phases: total.phases + 1 + nested.phases,
      tasks: total.tasks + (node.tasks?.length || 0) + nested.tasks,
      milestones: total.milestones + (node.milestone ? 1 : 0) + nested.milestones,
    };
  }, { phases: 0, tasks: 0, milestones: 0 });
}

function collectMilestones(nodes: PlanNode[]): PlanMilestone[] {
  return nodes.flatMap((node) => [
    ...(node.milestone ? [{
      id: node.milestone.id,
      title: node.milestone.title,
      dueDate: node.milestone.dueDate,
      criteria: node.milestone.description ? [node.milestone.description] : undefined,
      projectId: node.key,
      completed: false,
    }] : []),
    ...collectMilestones(node.children || []),
  ]);
}

function withoutNodeMilestones(nodes: PlanNode[]): PlanNode[] {
  return nodes.map((node) => ({
    ...node,
    milestone: undefined,
    children: withoutNodeMilestones(node.children || []),
  }));
}

function extractExecutionTasks(nodes: PlanNode[]): { nodes: PlanNode[]; executionTasks: PlanTaskBlueprint[] } {
  const executionTasks: PlanTaskBlueprint[] = [];
  const walk = (items: PlanNode[]): PlanNode[] => items.map((node) => {
    const structuralTasks: PlanTaskBlueprint[] = [];
    for (const task of node.tasks || []) {
      if (task.recurrence?.frequency && task.recurrence.frequency !== 'none') {
        executionTasks.push({ ...task, linkedProjectKey: task.linkedProjectKey || node.key, displayRow: task.displayRow || 0 });
      } else {
        structuralTasks.push(task);
      }
    }
    return { ...node, tasks: structuralTasks, children: walk(node.children || []) };
  });
  return { nodes: walk(nodes), executionTasks };
}

function reconcileGeneratedProjectKeys(generated: PlanNode[], existing: PlanNode[]): PlanNode[] {
  const projectKeyMap = new Map<string, string>();
  const align = (incoming: PlanNode[], current: PlanNode[]): PlanNode[] => {
    const used = new Set<string>();
    return incoming.map((node) => {
      const match = current.find((candidate) => !used.has(candidate.key) && candidate.title.trim() === node.title.trim());
      if (match) used.add(match.key);
      const key = match?.key || node.key;
      projectKeyMap.set(node.key, key);
      return {
        ...node,
        key,
        children: align(node.children || [], match?.children || []),
      };
    });
  };
  const aligned = align(generated, existing);
  const rewriteReferences = (nodes: PlanNode[]): PlanNode[] => nodes.map((node) => ({
    ...node,
    tasks: (node.tasks || []).map((task) => ({
      ...task,
      linkedProjectKey: task.linkedProjectKey ? projectKeyMap.get(task.linkedProjectKey) || task.linkedProjectKey : undefined,
    })),
    children: rewriteReferences(node.children || []),
  }));
  return rewriteReferences(aligned);
}

interface ImportedPlanDraft {
  importedAt: string;
  previous: {
    rootTitle: string;
    rootDueDate: string;
    planNodes: PlanNode[];
    executionTasks: PlanTaskBlueprint[];
    milestones: PlanMilestone[];
    planMeta: Partial<PlanMeta>;
  };
}

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
        <button onClick={() => onDelete(node.key)} className="p-0.5 rounded hover:bg-black/10 dark:hover:bg-white/10 text-slate-500" title="从当前计划编排移除">
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

      {(node.outcome || node.milestone) && (
        <div className="plan-builder-node-summary">
          {node.outcome && <p><Target />{node.outcome}</p>}
          {node.milestone && <span><Calendar />{node.milestone.title} · {node.milestone.dueDate}</span>}
        </div>
      )}

      {/* Children (mini sub-notes) */}
      <div className="sticky-note-body">
        {(node.tasks || []).length > 0 && (
          <div className="plan-builder-task-preview" aria-label={`${node.title}的计划任务`}>
            {node.tasks!.slice(0, 4).map((task) => (
              <div key={task.key}>
                <span className={`is-${task.kind}`}>{TASK_KIND_LABEL[task.kind]}</span>
                <strong>{task.text}</strong>
                <small>{task.estimatedMinutes} 分钟 · {task.dueDate.slice(5)}</small>
              </div>
            ))}
            {node.tasks!.length > 4 && <em>另有 {node.tasks!.length - 4} 项任务</em>}
          </div>
        )}
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
              title="从当前计划编排移除"
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
export const PlanBuilder: React.FC<PlanBuilderProps> = ({ onBatchCreate, initialValue, draftValue, onBatchUpdate, onDraftChange, onCancel, draftStorageKey, isActive = true, capacitySettings = cachedCapacitySettings(), allPlanNotes = [], onOpenLearningSettings }) => {
  const editorBaseRef = useRef(initialValue || undefined);
  const initialDate = homeLocalDate();
  const draftBase = useRef(initialValue ? JSON.stringify({ tree: initialValue.tree, meta: initialValue.planMeta }) : 'new');
  const [recoveredDraft] = useState(() => loadManualPlanDraft(draftStorageKey, draftBase.current));
  const [conflictingDraft] = useState(() => loadConflictingManualPlanDraft(draftStorageKey, draftBase.current));
  const [conflictDismissed, setConflictDismissed] = useState(false);
  const initialRoot = recoveredDraft?.tree[0] || initialValue?.tree[0] || draftValue?.tree[0];
  const initialMeta = recoveredDraft?.planMeta || initialValue?.planMeta || draftValue?.planMeta;
  const initialConditions = initialMeta?.conditions;
  const [rootTitle, setRootTitle] = useState(initialRoot?.title || '');
  const [rootStartDate, setRootStartDate] = useState(initialMeta?.startDate || initialRoot?.startDate || initialDate);
  const [rootDueDate, setRootDueDate] = useState(initialMeta?.targetDate || initialRoot?.dueDate || '');
  const [rootPriority, setRootPriority] = useState<'high' | 'medium' | 'low'>(initialMeta?.portfolioPriority || initialRoot?.priority || 'medium');
  const [planNodes, setPlanNodes] = useState<PlanNode[]>(() => structuredClone(initialRoot?.children || []));
  const [executionTasks, setExecutionTasks] = useState<PlanTaskBlueprint[]>(() => structuredClone(initialRoot?.tasks || []));
  const [draftMilestones, setDraftMilestones] = useState<PlanMilestone[]>(() => structuredClone(initialMeta?.milestones || []));
  const [generatedPlanMeta, setGeneratedPlanMeta] = useState<Partial<PlanMeta>>(() => structuredClone(initialMeta || {}));
  const [uploadingMaterials, setUploadingMaterials] = useState(false);
  const [materialError, setMaterialError] = useState('');
  const addPlanningMaterials = async () => {
    if (uploadingMaterials) return; setUploadingMaterials(true); setMaterialError('');
    try {
      const paths = await chooseDocumentFiles(); if (!paths.length) return;
      const documents = await uploadDocuments(paths.slice(0, 8));
      setGeneratedPlanMeta(previous => ({ ...previous, preparationDocuments: [...new Map([...(previous.preparationDocuments || []),
        ...documents.map(document => ({ id: document.id, title: document.fileName, indexable: document.indexable }))].map(document => [document.id, document])).values()].slice(0, 8) }));
    } catch (error) { setMaterialError(error instanceof Error ? error.message : '教材未能入库，请重试'); }
    finally { setUploadingMaterials(false); }
  };
  const [conditionsOpen, setConditionsOpen] = useState(false);
  const weeklyBudgetMinutes = personalWeeklyBudget(capacitySettings) || 0;
  const [dailyStudyMinutes, setDailyStudyMinutes] = useState(initialMeta?.dailyStudyMinutes || 120);
  const [activeWeekdays, setActiveWeekdays] = useState<number[]>(initialMeta?.activeWeekdays?.length ? initialMeta.activeWeekdays : [1, 2, 3, 4, 5, 6]);
  const [startingLevel, setStartingLevel] = useState<PlanStartingLevel>(initialConditions?.startingLevel || 'new');
  const [pace, setPace] = useState<PlanPace>(initialConditions?.pace || 'balanced');
  const [preferredSessionMinutes, setPreferredSessionMinutes] = useState(initialConditions?.preferredSessionMinutes || 60);
  const [preferredTimeOfDay, setPreferredTimeOfDay] = useState<NonNullable<PlanConditions['preferredTimeOfDay']>>(initialConditions?.preferredTimeOfDay || 'flexible');
  const [deadlineMode, setDeadlineMode] = useState<NonNullable<PlanConditions['deadlineMode']>>(initialConditions?.deadlineMode || 'flexible');
  const [reviewCadence, setReviewCadence] = useState<NonNullable<PlanConditions['reviewCadence']>>(initialConditions?.reviewCadence || 'standard');
  const [autoAdjustPolicy, setAutoAdjustPolicy] = useState<NonNullable<PlanMeta['autoAdjustPolicy']>>(initialMeta?.autoAdjustPolicy || 'ask');
  const [goalEvidence, setGoalEvidence] = useState(initialConditions?.goalEvidence || '');
  const [constraintNotes, setConstraintNotes] = useState(initialConditions?.constraintNotes || '');

  const [aiStep, setAiStep] = useState<PlanStepperStep>(0);
  const [aiSubject, setAiSubject] = useState('');
  // The wizard and advanced conditions edit the same draft field. Keeping two
  // states lets an older completion criterion mask the wizard's new goal.
  const aiExpectation = goalEvidence;
  const setAiExpectation = setGoalEvidence;
  const aiDailyHours = dailyStudyMinutes / 60;
  const setAiDailyHours = (hours: number) => setDailyStudyMinutes(Math.round(hours * 60));
  const [aiLoading, setAiLoading] = useState(false);
  const [aiError, setAiError] = useState<string | null>(null);
  const [aiInterrupted, setAiInterrupted] = useState(false);
  const [onlineResearch, setOnlineResearch] = useState(true);
  const [publicResearchSubject, setPublicResearchSubject] = useState<string | null>(null);
  const researchCache = useRef<{ subject: string; preparation: PlanResearchPreparation } | undefined>(undefined);
  const planSession = useRef<string | null>(null);
  const [researchNotice, setResearchNotice] = useState<string | undefined>(undefined);
  const planRun = useRef<AbortController | null>(null);
  const lastAttemptReply = useRef<string | undefined>(undefined);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [importedDraft, setImportedDraft] = useState<ImportedPlanDraft | null>(null);
  const [commitConfirmOpen, setCommitConfirmOpen] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [commitSaving, setCommitSaving] = useState(false);
  const commitSavingRef = useRef(false);
  const [draftSaveError, setDraftSaveError] = useState(false);
  const commitDialogRef = useRef<HTMLElement>(null);
  const aiDialogRef = useRef<HTMLDivElement>(null);
  const loadingDialogRef = useRef<HTMLDivElement>(null);
  const conditionsDialogRef = useRef<HTMLElement>(null);
  const builderRef = useRef<HTMLDivElement>(null);
  useDialog(commitConfirmOpen, commitDialogRef, commitSaving ? undefined : () => setCommitConfirmOpen(false), 60);
  useDialog(aiStep > 0, aiDialogRef, aiLoading ? undefined : () => handleCloseStepper(), 55);
  useDialog(aiLoading, loadingDialogRef, undefined, 70);
  useDialog(conditionsOpen, conditionsDialogRef, () => setConditionsOpen(false), 50);
  const onDraftChangeRef = React.useRef(onDraftChange);
  useEffect(() => { onDraftChangeRef.current = onDraftChange; }, [onDraftChange]);
  useEffect(() => () => { planRun.current?.abort(); planRun.current = null; }, []);
  useEffect(() => {
    if (!isActive && planRun.current) {
      planRun.current.abort(); planRun.current = null;
      setAiLoading(false);
      setChatInput(current => current || lastAttemptReply.current || '');
      setAiInterrupted(true);
    }
  }, [isActive]);

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

  const toggleActiveWeekday = (day: number) => {
    setActiveWeekdays((current) => {
      if (current.includes(day)) return current.length === 1 ? current : current.filter((item) => item !== day);
      return [...current, day].sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b));
    });
  };

  const currentConditions: PlanConditions = {
    goalEvidence: goalEvidence.trim() || aiExpectation.trim() || undefined,
    startingLevel,
    pace,
    preferredSessionMinutes,
    preferredTimeOfDay,
    deadlineMode,
    reviewCadence,
    constraintNotes: constraintNotes.trim() || undefined,
  };

  // ===== Generate Project Tree =====
  const handleCreateProjectTree = async () => {
    if (commitSavingRef.current || uploadingMaterials) return;
    if (!rootTitle.trim() && planNodes.length === 0) return;
    if (deadlineMode === 'hard' && capacityWarnings.length) { setCommitError('硬截止排期超过个人容量或本计划每日强度，请先调整草稿。'); return; }

    // Build the full tree with root as a PlanNode
    const rootNode: PlanNode = {
      key: initialValue?.rootId || draftValue?.tree[0].key || 'root',
      title: rootTitle.trim() || '未命名学习计划',
      startDate: rootStartDate,
      dueDate: rootDueDate || undefined,
      priority: rootPriority,
      tasks: executionTasks,
      children: planNodes.filter(n => n.title.trim() || n.children.length > 0),
    };

    try {
      assertPlanStructureGranularity(rootNode);
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : '计划结构粒度不符合要求');
      return;
    }
    setCommitError(null);

    const nextMeta: Partial<PlanMeta> = {
      ...generatedPlanMeta,
      schemaVersion: 2,
      status: initialMeta?.status || 'active',
      shortTitle: generatedPlanMeta.shortTitle || rootNode.title,
      summary: generatedPlanMeta.summary || aiExpectation.trim() || `围绕“${rootNode.title}”形成可验证的阶段成果。`,
      startDate: rootStartDate || generatedPlanMeta.startDate || homeLocalDate(),
      targetDate: rootDueDate || undefined,
      weeklyBudgetMinutes: initialMeta?.weeklyBudgetMinutes,
      dailyStudyMinutes,
      activeWeekdays,
      portfolioPriority: rootPriority,
      autoAdjustPolicy,
      conditions: currentConditions,
      milestones: draftMilestones,
      updatedAt: new Date().toISOString(),
    };
    commitSavingRef.current = true;
    setCommitSaving(true);
    try {
      if (initialValue && onBatchUpdate) await onBatchUpdate(initialValue.rootId, [rootNode], nextMeta, editorBaseRef.current);
      else await onBatchCreate([rootNode], nextMeta);
      setCommitConfirmOpen(false);
    } catch (error) {
      setCommitError(error instanceof Error ? error.message : '计划未能保存，草图已保留，请重试');
    } finally {
      commitSavingRef.current = false;
      setCommitSaving(false);
    }
  };

  const restoreBeforeImportedDraft = () => {
    if (!importedDraft) return;
    const previous = importedDraft.previous;
    setRootTitle(previous.rootTitle);
    setRootDueDate(previous.rootDueDate);
    setPlanNodes(structuredClone(previous.planNodes));
    setExecutionTasks(structuredClone(previous.executionTasks));
    setDraftMilestones(structuredClone(previous.milestones));
    setGeneratedPlanMeta(structuredClone(previous.planMeta));
    setImportedDraft(null);
    setResearchNotice(undefined);
  };

  // ===== AI Stepper =====
  const aiStepperSteps = [
    { step: 1, title: '想学什么？', label: '学习目标', placeholder: '例如：考研数学基础、Python 数据分析、CPA 财务管理...', field: aiSubject, setter: setAiSubject, hint: '描述你想学习的具体领域或技能' },
    { step: 2, title: '期望达到什么效果？', label: '期望效果', placeholder: '例如：数学120分以上、能独立完成数据分析项目、通过六科考试...', field: aiExpectation, setter: setAiExpectation, hint: '描述你希望达成的具体目标或里程碑' },
    { step: 3, title: '每天能花在这个计划上多长时间？', label: '计划每日投入', placeholder: '', field: aiDailyHours, setter: setAiDailyHours, hint: '叶子项目默认继承此时长；所有计划还需共同遵守个人周预算', isTimeSelect: true },
  ];

  const handleCloseStepper = () => {
    planRun.current?.abort(); planRun.current = null;
    setAiLoading(false); researchCache.current = undefined; setPublicResearchSubject(null);
    planSession.current = null; setResearchNotice(undefined);
    setAiInterrupted(false);
    lastAttemptReply.current = undefined;
    setAiStep(0);
    setAiSubject('');
    setAiError(null);
    setChatMessages([]);
    setChatInput('');
  };

  /** 多轮对话控制器：追问 → 回答 → 直到 isComplete → 生成计划 */
  const planChatLoop = async (userReply?: string) => {
    if (planRun.current || !isActive) return;
    // Capture this submission before validating the public search topic, so an
    // early error cannot restore an unrelated reply from the previous attempt.
    lastAttemptReply.current = userReply;
    const controller = new AbortController(); planRun.current = controller;
    setAiLoading(true);
    setAiInterrupted(false);
    setAiError(null);

    const today = homeLocalDate();
    const activeDayText = WEEKDAYS.filter((day) => activeWeekdays.includes(day.value)).map((day) => `周${day.label}`).join('、');
    const loadedDraftContext = initialValue ? JSON.stringify({
      rootTitle,
      planTree: planNodes,
      executionTasks,
      milestones: draftMilestones,
    }) : '';
    const baseUserInput = `学习目标：${aiSubject.trim() || rootTitle.trim()}\n期望效果：${goalEvidence.trim() || aiExpectation.trim() || '未指定'}\n当前基础：${STARTING_LEVEL_LABEL[startingLevel]}\n计划节奏：${PACE_LABEL[pace]}\n开始日期：${rootStartDate}\n目标日期：${rootDueDate || '可弹性建议'}（${deadlineMode === 'hard' ? '硬截止' : '弹性截止'}）\n每周可投入：${weeklyBudgetMinutes}分钟\n学习日：${activeDayText}\n单次学习：约${preferredSessionMinutes}分钟\n偏好时段：${preferredTimeOfDay}\n复习密度：${reviewCadence}\n自动调整：${autoAdjustPolicy}\n其他约束：${constraintNotes.trim() || '无'}\n当前日期：${today}\n请优先输出用于创建结构化项目笔记的多层项目树与里程碑；只有用户明确需要独立、周期性提醒且无需创建项目笔记的事项，才输出带 recurrence 的执行任务。项目层级不设上限，但一天范围的项目必须是叶子项目，只输出简洁标题和单一、可观察的验收结果；不要生成日内动作清单，不要把日内动作写入 outcome 或 tasks。确实具有独立验收产出、值得单独建立项目笔记的同日叶子项目可以并列。${initialValue ? `\n这是对已有计划的草稿再生成。请参考当前草稿并尽量复用未改变项目的 key；生成结果只导入编辑器，不得视为已经写入：${loadedDraftContext}` : '\n生成结果只导入编辑器，不得视为已经创建计划。'}`;
    try {
      const subject = onlineResearch ? planResearchSubject(publicResearchSubject ?? (aiSubject.trim() || rootTitle.trim())) : '';
      const session = JSON.stringify([baseUserInput, dailyStudyMinutes, onlineResearch, subject]);
      const changedSession = planSession.current !== session;
      const reply = changedSession && planSession.current !== null ? undefined : userReply;
      const history = changedSession ? [] : chatMessages;
      if (changedSession) { setChatMessages([]); setChatInput(''); }
      planSession.current = session;
      lastAttemptReply.current = reply;
      setChatInput('');
      const preparation = onlineResearch
        ? researchCache.current?.subject === subject ? researchCache.current.preparation : await preparePlanResearch(subject, controller.signal)
        : {};
      controller.signal.throwIfAborted();
      if (planRun.current !== controller) return;
      const { research, notice } = preparation;
      if (onlineResearch) researchCache.current = { subject, preparation };
      setResearchNotice(notice);
      const response = await callLLM({
        providerId: '', model: '',
        workflow: 'plan-generation',
        userInput: `${reply || baseUserInput}\n本计划每日学习投入 ${dailyStudyMinutes} 分钟，每个叶子项目默认使用此时长；专注单次 ${preferredSessionMinutes} 分钟不是每日投入。个人共享周预算 ${weeklyBudgetMinutes || '待确认'} 分钟，不是本计划独占。排期必须检查其他计划的既有占用，不能自动挤走其他计划。\n${PLAN_CORE_SCOPE_RULES}\n${planResearchContext(research)}`,
        context: {
          planGoal: aiSubject.trim() || rootTitle.trim(),
          expectedOutcome: goalEvidence.trim() || aiExpectation.trim() || '未指定',
          dailyTime: `${aiDailyHours}小时`,
          dailyStudyMinutes: String(dailyStudyMinutes),
          personalCapacity: JSON.stringify(previewDraftCapacity([{ key: 'capacity-window', title: '容量窗口', startDate: rootStartDate || today, dueDate: rootDueDate || today, children: [] }],
            { dailyStudyMinutes }, allPlanNotes, capacitySettings, initialValue?.rootId).map(w => ({ weekStart: w.weekStart, budgetMinutes: w.budgetMinutes,
              existingMinutes: w.byRoot.filter(r => !r.rootId.startsWith('__capacity_preview__')).reduce((s, r) => s + r.scheduledMinutes, 0) }))),
          weeklyBudgetMinutes: String(weeklyBudgetMinutes),
          activeWeekdays: activeDayText,
          startingLevel,
          pace,
          preferredSessionMinutes: String(preferredSessionMinutes),
          deadlineMode,
          reviewCadence,
          autoAdjustPolicy,
          constraintNotes: constraintNotes.trim() || '无',
          requiredPlanFields: 'planMeta, milestone, outcome, nested planTree; optional recurring execution tasks with recurrence/executionKind/linkedProjectKey',
          draftMode: 'import-only; user edits and explicitly confirms before persistence',
          existingDraft: loadedDraftContext || 'none',
          currentDate: today,
        },
        messages: history.length > 0 ? [
          { role: 'user', content: `初始信息：${baseUserInput}` },
          ...history,
          ...(reply ? [{ role: 'user' as const, content: reply }] : []),
        ] : undefined,
      }, { signal: controller.signal });
      controller.signal.throwIfAborted();
      if (planRun.current !== controller) return;

      const parsed = response.parsedJson;

      // 检测是否返回了追问
      if (parsed && parsed.question && !parsed.isComplete) {
        const newMsgs: ChatMessage[] = [
          ...(reply ? [{ role: 'user' as const, content: reply }] : []),
          { role: 'assistant', content: parsed.question },
        ];
        setChatMessages([...history, ...newMsgs]);
        setAiLoading(false);
        return;
      }

      // 对话完成，解析“阶段 + 里程碑 + 可执行任务”的结构化蓝图。
      const generated = Array.isArray(parsed?.planTree) ? parsePlanNodes(parsed.planTree) : [];
      if (generated.length > 0) {
        const reconciled = initialValue ? reconcileGeneratedProjectKeys(generated, planNodes) : generated;
        assertPlanStructureGranularity(reconciled);
        assertGeneratedPlanCoreScope(reconciled);
        checkPlanResearchCitations(JSON.stringify({ planTree: reconciled, summary: parsed?.planMeta?.summary }), research);
        const separated = extractExecutionTasks(reconciled);
        const meta = parsed?.planMeta || {};
        const rawSummary = meta.summary ? String(meta.summary).trim() : aiExpectation.trim();
        const summary = !research && !rawSummary.includes('未联网核实') ? `未联网核实。${rawSummary}` : rawSummary;
        const generatedMilestones = collectMilestones(reconciled);
        const targetDate = rootDueDate || asDate(meta.targetDate) || generated.map((node) => node.dueDate).filter(Boolean).sort().at(-1);
        setImportedDraft({
          importedAt: new Date().toISOString(),
          previous: {
            rootTitle,
            rootDueDate,
            planNodes: structuredClone(planNodes),
            executionTasks: structuredClone(executionTasks),
            milestones: structuredClone(draftMilestones),
            planMeta: structuredClone(generatedPlanMeta),
          },
        });
        setRootTitle(String(parsed.rootTitle || rootTitle || aiSubject.trim().slice(0, 20)).trim());
        setRootDueDate(targetDate || '');
        setGeneratedPlanMeta(previous => ({
          schemaVersion: 2,
          status: 'draft',
          shortTitle: String(parsed.rootTitle || aiSubject.trim()).trim(),
          summary,
          startDate: rootStartDate || asDate(meta.startDate) || today,
          targetDate,
          weeklyBudgetMinutes: initialMeta?.weeklyBudgetMinutes,
          dailyStudyMinutes,
          activeWeekdays,
          portfolioPriority: rootPriority,
          autoAdjustPolicy,
          conditions: currentConditions,
          milestones: generatedMilestones,
          research,
          preparationDocuments: previous.preparationDocuments,
        }));
        setDraftMilestones(generatedMilestones);
        setPlanNodes(withoutNodeMilestones(separated.nodes));
        setExecutionTasks(separated.executionTasks);
      } else {
        throw new Error('模型没有返回可用的计划蓝图，请补充目标或重试。');
      }
      setAiStep(0);
      planSession.current = null;
      setChatMessages([]);
      setChatInput('');
    } catch (err: any) {
      if (!controller.signal.aborted && planRun.current === controller) {
        setAiError(err.message || 'AI 生成失败');
        setChatInput(current => current || lastAttemptReply.current || '');
      }
    } finally {
      if (planRun.current === controller) { planRun.current = null; setAiLoading(false); }
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

  // A saved reply is only a recovery buffer, never a submission source. An
  // empty initial attempt may restart; clearing a previous answer must not send it.
  const retryInputEmpty = lastAttemptReply.current !== undefined && !chatInput.trim();
  const canResumePlan = !aiLoading && isActive && !retryInputEmpty;
  const handleResumePlan = async () => {
    if (!canResumePlan || planRun.current) return;
    await planChatLoop(chatInput.trim() || undefined);
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

  const blueprintStats = countBlueprint(planNodes);
  const capacityWeeks = useMemo(() => previewDraftCapacity([{ key: initialValue?.rootId || 'preview-root', title: rootTitle,
    startDate: rootStartDate, dueDate: rootDueDate || undefined, tasks: executionTasks, children: planNodes }],
    { dailyStudyMinutes, activeWeekdays }, allPlanNotes, capacitySettings, initialValue?.rootId),
    [rootTitle, rootStartDate, rootDueDate, executionTasks, planNodes, dailyStudyMinutes, activeWeekdays, allPlanNotes, capacitySettings, initialValue?.rootId]);
  const capacityWarnings = capacityWeeks.flatMap(w => [
    ...(w.percent !== null && w.percent > 100 ? [`${w.weekStart}：全部计划共 ${w.scheduledMinutes}/${w.budgetMinutes} 分钟，超过个人周预算`] : []),
    ...w.byRoot.filter(r => r.rootId.startsWith('__capacity_preview__')).flatMap(r => r.dailyOverloads.map(d => `${d.date}：本计划安排 ${d.minutes} 分钟，超过每日投入 ${dailyStudyMinutes} 分钟`)),
  ]);
  const hasValidContent = Boolean(rootTitle.trim() && (blueprintStats.phases > 0 || executionTasks.length > 0 || draftMilestones.length > 0));
  const conditionAssessment = useMemo(() => assessPlanConditions(executionTasks.length ? [...planNodes, {
    key: 'execution-assessment',
    title: '执行层',
    tasks: executionTasks,
    children: [],
  }] : planNodes, {
    startDate: rootStartDate,
    targetDate: rootDueDate || undefined,
    weeklyBudgetMinutes,
    dailyStudyMinutes,
    activeWeekdays,
    autoAdjustPolicy,
    conditions: currentConditions,
  }, weeklyBudgetMinutes || null), [
    planNodes,
    executionTasks,
    rootStartDate,
    rootDueDate,
    weeklyBudgetMinutes,
    dailyStudyMinutes,
    activeWeekdays,
    autoAdjustPolicy,
    goalEvidence,
    aiExpectation,
    startingLevel,
    pace,
    preferredSessionMinutes,
    preferredTimeOfDay,
    deadlineMode,
    reviewCadence,
    constraintNotes,
  ]);

  const timelineSettings: PlanTimelineSettings = {
    startDate: rootStartDate,
    targetDate: rootDueDate,
    weeklyBudgetMinutes,
    dailyStudyMinutes,
    activeWeekdays,
    startingLevel,
    pace,
    preferredSessionMinutes,
    preferredTimeOfDay,
    deadlineMode,
    reviewCadence,
    autoAdjustPolicy,
    portfolioPriority: rootPriority,
    goalEvidence,
    constraintNotes,
  };

  const recoverableDraftValue = useMemo<PlanBuilderDraftValue>(() => ({
    tree: [{
      key: initialValue?.rootId || draftValue?.tree[0].key || 'root',
      title: rootTitle,
      startDate: rootStartDate,
      dueDate: rootDueDate || undefined,
      priority: rootPriority,
      tasks: executionTasks,
      children: planNodes,
    }],
    planMeta: {
      ...generatedPlanMeta,
      schemaVersion: 2,
      status: initialMeta?.status || 'active',
      shortTitle: generatedPlanMeta.shortTitle || rootTitle.trim() || '未命名学习计划',
      summary: generatedPlanMeta.summary || aiExpectation.trim() || `围绕“${rootTitle.trim() || '未命名学习计划'}”形成可验证的阶段成果。`,
      startDate: rootStartDate || generatedPlanMeta.startDate,
      targetDate: rootDueDate || undefined,
      weeklyBudgetMinutes: initialMeta?.weeklyBudgetMinutes,
      dailyStudyMinutes,
      activeWeekdays,
      portfolioPriority: rootPriority,
      autoAdjustPolicy,
      conditions: currentConditions,
      milestones: draftMilestones,
    },
    sourceLabel: draftValue?.sourceLabel,
  }), [
    activeWeekdays,
    aiExpectation,
    autoAdjustPolicy,
    deadlineMode,
    draftMilestones,
    draftValue?.sourceLabel,
    draftValue?.tree[0]?.key,
    executionTasks,
    generatedPlanMeta,
    goalEvidence,
    initialMeta?.status,
    initialValue?.rootId,
    pace,
    planNodes,
    preferredSessionMinutes,
    preferredTimeOfDay,
    reviewCadence,
    rootDueDate,
    rootPriority,
    rootStartDate,
    rootTitle,
    startingLevel,
    constraintNotes,
    weeklyBudgetMinutes,
    dailyStudyMinutes,
  ]);

  useEffect(() => {
    onDraftChangeRef.current?.(recoverableDraftValue);
    try { saveManualPlanDraft(draftStorageKey, draftBase.current, recoverableDraftValue); setDraftSaveError(false); }
    catch { setDraftSaveError(true); }
  }, [recoverableDraftValue, draftStorageKey]);

  const [initialHistory] = useState(() => createUndoHistory(recoverableDraftValue));
  const historyRef = useRef<UndoHistory<PlanBuilderDraftValue>>(initialHistory);
  const [historyAvailability, setHistoryAvailability] = useState({ undo: false, redo: false });
  const historyTimeRef = useRef({ time: 0, target: null as Element | null });
  const publishHistoryAvailability = () => setHistoryAvailability({ undo: historyRef.current.past.length > 0, redo: historyRef.current.future.length > 0 });
  useLayoutEffect(() => {
    const previous = historyTimeRef.current;
    const target = document.activeElement;
    const coalesce = isTextInput(target) && target === previous.target && Date.now() - previous.time < 700;
    const next = recordUndoHistory(historyRef.current, recoverableDraftValue, coalesce);
    if (next === historyRef.current) return;
    historyRef.current = next;
    historyTimeRef.current = { time: Date.now(), target };
    publishHistoryAvailability();
  }, [recoverableDraftValue]);
  const applyDraft = (input: PlanBuilderDraftValue) => {
    const value = structuredClone(input);
    const root = value.tree[0];
    const meta = value.planMeta;
    const conditions = meta.conditions;
    setRootTitle(root.title); setRootStartDate(root.startDate || meta.startDate || initialDate);
    setRootDueDate(root.dueDate || meta.targetDate || ''); setRootPriority(root.priority || 'medium');
    setPlanNodes(root.children || []); setExecutionTasks(root.tasks || []); setDraftMilestones(meta.milestones || []);
    setGeneratedPlanMeta(meta); setDailyStudyMinutes(meta.dailyStudyMinutes || dailyStudyMinutes);
    setActiveWeekdays(meta.activeWeekdays || [1, 2, 3, 4, 5, 6]); setAutoAdjustPolicy(meta.autoAdjustPolicy || 'ask');
    setStartingLevel(conditions?.startingLevel || 'new'); setPace(conditions?.pace || 'balanced');
    setPreferredSessionMinutes(conditions?.preferredSessionMinutes || 60); setPreferredTimeOfDay(conditions?.preferredTimeOfDay || 'flexible');
    setDeadlineMode(conditions?.deadlineMode || 'flexible'); setReviewCadence(conditions?.reviewCadence || 'standard');
    setGoalEvidence(conditions?.goalEvidence || ''); setConstraintNotes(conditions?.constraintNotes || '');
    setCommitError(null);
  };
  const moveHistory = (direction: 'undo' | 'redo') => {
    const next = moveUndoHistory(historyRef.current, direction);
    if (next === historyRef.current) return;
    historyRef.current = next;
    historyTimeRef.current = { time: 0, target: null };
    applyDraft(next.present); publishHistoryAvailability();
  };
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!isActive || event.defaultPrevented || hasActiveDialog() || isTextInput(event.target)
        || builderRef.current?.querySelector('.is-pointer-dragging')
        || !builderRef.current?.contains(event.target as Node) || !(event.ctrlKey || event.metaKey) || event.altKey) return;
      const key = event.key.toLowerCase();
      if (key !== 'z' && key !== 'y') return;
      event.preventDefault(); moveHistory(key === 'y' || event.shiftKey ? 'redo' : 'undo');
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  });

  const handleTimelineSettingsChange = (key: keyof PlanTimelineSettings, value: any) => {
    if (key === 'startDate') setRootStartDate(value);
    else if (key === 'targetDate') setRootDueDate(value);
    else if (key === 'weeklyBudgetMinutes') return;
    else if (key === 'dailyStudyMinutes') setDailyStudyMinutes(value);
    else if (key === 'activeWeekdays') setActiveWeekdays(value);
    else if (key === 'startingLevel') setStartingLevel(value);
    else if (key === 'pace') setPace(value);
    else if (key === 'preferredSessionMinutes') setPreferredSessionMinutes(value);
    else if (key === 'preferredTimeOfDay') setPreferredTimeOfDay(value);
    else if (key === 'deadlineMode') setDeadlineMode(value);
    else if (key === 'reviewCadence') setReviewCadence(value);
    else if (key === 'autoAdjustPolicy') setAutoAdjustPolicy(value);
    else if (key === 'portfolioPriority') setRootPriority(value);
    else if (key === 'goalEvidence') setGoalEvidence(value);
    else if (key === 'constraintNotes') setConstraintNotes(value);
  };

  return (
    <div ref={builderRef} className="plan-builder flex-1 h-[calc(100vh-3.5rem)] flex flex-col bg-[#FFFDF7] dark:bg-slate-950 overflow-hidden">
      {/* ===== Title Bar ===== */}
      <div className="plan-builder-header p-4 flex-shrink-0 space-y-3">
        <div className="plan-builder-kicker"><span>{initialValue ? 'PLAN EDITOR' : 'PLAN COMPOSER'}</span><p>{initialValue ? '已载入当前根计划；保存时只覆盖这一计划，其他计划保持不变。' : '先形成可审核蓝图，再写入项目、任务与里程碑。'}</p></div>
        {draftSaveError && <p role="alert">草图暂存失败，请不要关闭页面；可重试本地暂存。<button type="button" onClick={() => { try { saveManualPlanDraft(draftStorageKey, draftBase.current, recoverableDraftValue); setDraftSaveError(false); } catch { setDraftSaveError(true); } }}>重试</button></p>}
        {conflictingDraft && !conflictDismissed && <p className="plan-draft-conflict" role="status">原计划已更新，当前显示最新版本；旧草图已保留。
          <button type="button" onClick={() => { applyDraft(conflictingDraft); setConflictDismissed(true); }}>导入旧草图继续调整</button>
          <button type="button" onClick={() => setConflictDismissed(true)}>使用当前版本</button>
        </p>}
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
          <div className="plan-condition-summary">
            <span><CalendarRange />{rootStartDate} → {rootDueDate || '弹性排期'}</span>
            <span><Clock />个人周预算 {weeklyBudgetMinutes || '待确认'} 分钟 · 本计划每日 {dailyStudyMinutes} 分钟</span>
            <span><TimerReset />单次 {preferredSessionMinutes} 分钟</span>
            <button type="button" aria-expanded={conditionsOpen} onClick={() => setConditionsOpen((open) => !open)}>
              <Settings2 />{conditionsOpen ? '收起条件' : '调整条件'}<ChevronRight className={conditionsOpen ? 'is-open' : ''} />
            </button>
          </div>
        </div>

        <section className="learning-preparation" aria-label="规划教材资料">
          <div className="learning-preparation-summary"><strong>已有教材（可选）</strong><p>上传后随计划绑定到根项目，供各子项目使用；其他公开资源会在保存计划后准备。</p></div>
          <button type="button" disabled={uploadingMaterials || commitSaving} onClick={() => void addPlanningMaterials()}>{uploadingMaterials ? '正在入库…' : '上传教材资料'}</button>
          {!!generatedPlanMeta.preparationDocuments?.length && <ul className="w-full text-sm">{generatedPlanMeta.preparationDocuments.map(document => <li key={document.id}>{document.title} <button type="button" disabled={uploadingMaterials} aria-label={`取消选择教材：${document.title}`} onClick={() => setGeneratedPlanMeta(previous => ({ ...previous, preparationDocuments: previous.preparationDocuments?.filter(item => item.id !== document.id) }))}>取消选择</button></li>)}</ul>}
          {materialError && <p role="alert">{materialError}</p>}
        </section>
        {generatedPlanMeta.research && <details className="plan-scope-details">
          <summary>规划联网依据 · {generatedPlanMeta.research.sources.length} 个来源</summary>
          <small>公开主题：{generatedPlanMeta.research.subject} · 检索于 {generatedPlanMeta.research.retrievedAt.slice(0, 10)}，非发表日期</small>
          {generatedPlanMeta.research.sources.map(source => <article key={source.id}><a href={source.url} target="_blank" rel="noopener noreferrer">[{source.id}] {source.title}</a><small>{source.coverage === 'abstract' ? '摘要' : '网页节选'} · {source.publishedAt || '发表日期未核实'}</small><p>{source.excerpt}</p></article>)}
          {generatedPlanMeta.research.warnings.map(warning => <small key={warning}>{warning}</small>)}
        </details>}

        {conditionsOpen && <div className="plan-condition-backdrop" onMouseDown={() => setConditionsOpen(false)}>
        <section ref={conditionsDialogRef} tabIndex={-1} className="plan-condition-panel is-open" role="dialog" aria-modal="true" aria-label="计划条件" onMouseDown={(event) => event.stopPropagation()}>
          <header>
            <div><SlidersHorizontal /><span><strong>计划条件</strong><small>手动制定和 AI 规划共用这些约束</small></span></div>
            <em>{activeWeekdays.length} 个学习日 · {PACE_LABEL[pace]}节奏 · {deadlineMode === 'hard' ? '硬截止' : '弹性截止'}</em>
            <button type="button" aria-label="关闭计划条件" onClick={() => setConditionsOpen(false)}><X /></button>
          </header>
          {conditionsOpen && <div className="plan-condition-grid">
            <article>
              <h3><CalendarRange />时间边界</h3>
              <div className="plan-condition-fields is-two-column">
                <label><span>开始日期</span><input type="date" value={rootStartDate} onChange={(event) => setRootStartDate(event.target.value)} /></label>
                <label><span>目标日期</span><input type="date" min={rootStartDate} value={rootDueDate} onChange={(event) => setRootDueDate(event.target.value)} /></label>
              </div>
              <div className="plan-condition-segment" aria-label="截止日期性质">
                <button type="button" className={deadlineMode === 'flexible' ? 'is-active' : ''} onClick={() => setDeadlineMode('flexible')}>弹性截止</button>
                <button type="button" className={deadlineMode === 'hard' ? 'is-active' : ''} onClick={() => setDeadlineMode('hard')}>硬截止</button>
              </div>
            </article>

            <article>
              <h3><Gauge />基础与节奏</h3>
              <div className="plan-condition-fields is-three-column">
                <label><span>当前基础</span><select value={startingLevel} onChange={(event) => setStartingLevel(event.target.value as PlanStartingLevel)}>{Object.entries(STARTING_LEVEL_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label><span>学习节奏</span><select value={pace} onChange={(event) => setPace(event.target.value as PlanPace)}>{Object.entries(PACE_LABEL).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                <label><span>组合优先级</span><select value={rootPriority} onChange={(event) => setRootPriority(event.target.value as 'high' | 'medium' | 'low')}><option value="high">高</option><option value="medium">中</option><option value="low">低</option></select></label>
              </div>
            </article>

            <article>
              <h3><TimerReset />时间容量</h3>
              <div className="plan-condition-fields is-two-column">
                <label><span>本计划每日投入（分钟）</span><StudyMinutesInput value={dailyStudyMinutes} onValueChange={value => setDailyStudyMinutes(value!)} /></label>
                <label><span>单次时长</span><select value={preferredSessionMinutes} onChange={(event) => setPreferredSessionMinutes(Number(event.target.value))}>{[5, 10, 15, 25, 30, 45, 60, 90, 120].map((minutes) => <option key={minutes} value={minutes}>{minutes} 分钟</option>)}</select></label>
              </div>
              <div className="plan-weekday-picker" aria-label="每周学习日">
                <span>学习日</span>{WEEKDAYS.map((day) => <button type="button" key={day.value} aria-pressed={activeWeekdays.includes(day.value)} className={activeWeekdays.includes(day.value) ? 'is-active' : ''} onClick={() => toggleActiveWeekday(day.value)}>{day.label}</button>)}
              </div>
            </article>

            <article>
              <h3><Settings2 />执行偏好</h3>
              <div className="plan-condition-fields is-three-column">
                <label><span>偏好时段</span><select value={preferredTimeOfDay} onChange={(event) => setPreferredTimeOfDay(event.target.value as NonNullable<PlanConditions['preferredTimeOfDay']>)}><option value="flexible">灵活</option><option value="morning">上午</option><option value="afternoon">下午</option><option value="evening">晚间</option></select></label>
                <label><span>复习密度</span><select value={reviewCadence} onChange={(event) => setReviewCadence(event.target.value as NonNullable<PlanConditions['reviewCadence']>)}><option value="light">轻量</option><option value="standard">标准</option><option value="intensive">密集</option></select></label>
                <label><span>自动调整</span><select value={autoAdjustPolicy} onChange={(event) => setAutoAdjustPolicy(event.target.value as NonNullable<PlanMeta['autoAdjustPolicy']>)}><option value="ask">调整前询问</option><option value="automatic">自动再平衡</option><option value="off">关闭</option></select></label>
              </div>
            </article>

            <label className="plan-condition-wide"><span>完成证据</span><textarea value={goalEvidence} onChange={(event) => setGoalEvidence(event.target.value)} placeholder="例如：能独立完成一个真实项目，并通过一次限时测验" /></label>
            <label className="plan-condition-wide"><span>其他限制</span><textarea value={constraintNotes} onChange={(event) => setConstraintNotes(event.target.value)} placeholder="例如：周三晚不可安排任务；先使用已有教材；月底前必须完成第一阶段" /></label>
          </div>}
        </section></div>}

        <section className="plan-condition-assessment" aria-label="个人共享学习容量">
          <p>个人周预算：{weeklyBudgetMinutes || '待确认'} 分钟；所有计划共用，不会由当前草稿修改。<button type="button" className="underline min-h-11" onClick={onOpenLearningSettings}>前往学习偏好设置</button></p>
          <p>当前周其他计划已占 {buildLearningCapacity(allPlanNotes, weekStartDate(), capacitySettings).byRoot.filter(r => r.rootId !== initialValue?.rootId).reduce((s, r) => s + r.scheduledMinutes, 0)} 分钟。</p>
          {!weeklyBudgetMinutes && <p role="status">请确认个人周预算；当前不显示虚假的负荷百分比。</p>}
          {initialValue && initialMeta?.dailyStudyMinutes === undefined && <p role="status">旧计划未保存每日投入。当前 {dailyStudyMinutes} 分钟是待确认默认值，正式确认保存后才生效；已完成项目原时长保留。</p>}
          {capacityWarnings.length > 0 && <ul role="alert">{capacityWarnings.slice(0, 8).map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
        </section>
        {conditionAssessment.issues.length > 0 && <div className={`plan-condition-assessment ${conditionAssessment.blocking ? 'is-blocking' : 'is-warning'}`} role={conditionAssessment.blocking ? 'alert' : 'status'} aria-label="计划条件提醒">
          <div>
            <AlertTriangle />
            <span><strong>{conditionAssessment.blocking ? '计划条件存在冲突' : '计划条件需注意'}</strong><small>{conditionAssessment.totalEstimatedMinutes} 分钟任务{conditionAssessment.effectiveCapacityMinutes !== null ? ` / ${conditionAssessment.effectiveCapacityMinutes} 分钟有效容量` : ''}{conditionAssessment.utilizationPercent !== null ? ` · ${conditionAssessment.utilizationPercent}%` : ''}</small></span>
          </div>
          {conditionAssessment.issues.length > 0 && <ul>{conditionAssessment.issues.slice(0, 3).map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul>}
        </div>}

        {/* Action buttons row */}
        <div className="plan-builder-actions flex items-center gap-2">
          <button
            onClick={() => { researchCache.current = undefined; planSession.current = null; setResearchNotice(undefined); setAiInterrupted(false); setChatMessages([]); setChatInput(''); lastAttemptReply.current = undefined; setPublicResearchSubject(null); setAiStep(1); setAiError(null); }}
            className="plan-ai-button px-3 py-1.5 rounded-xl border-2 border-slate-800 dark:border-slate-300 bg-white dark:bg-slate-800 text-slate-800 dark:text-slate-200 text-xs font-bold hover:bg-indigo-50 dark:hover:bg-indigo-950/40 transition flex items-center gap-1 shadow-[2px_2px_0_rgba(45,52,54,0.2)]"
          >
            <Sparkles className="w-3.5 h-3.5" />
            {importedDraft || draftValue ? '重新生成草稿' : 'AI 先生成草案'}
          </button>
          <div className="flex-1" />
          {draftStorageKey && !draftSaveError && <small className="plan-draft-save-status" role="status">{recoveredDraft ? '已恢复草图 · 自动暂存' : '草图自动暂存'}</small>}
          <span className="plan-blueprint-count text-[10px] text-slate-400 mr-1">
            {blueprintStats.phases} 个结构项目 · {executionTasks.length} 条执行规则 · {draftMilestones.length} 个里程碑
          </span>
          {initialValue && onCancel && <button type="button" onClick={onCancel} className="plan-builder-cancel-button">取消编辑</button>}
          {!initialValue && !draftValue && onCancel && <button type="button" onClick={onCancel} className="plan-builder-cancel-button">放弃草图</button>}
          <button
            onClick={() => { setCommitError(null); setCommitConfirmOpen(true); }}
            disabled={!hasValidContent || conditionAssessment.blocking || (deadlineMode === 'hard' && capacityWarnings.length > 0)}
            className="plan-create-tree-button px-4 py-2 rounded-xl bg-indigo-600 text-white text-sm font-black hover:bg-indigo-700 shadow-[3px_3px_0_rgba(79,70,229,0.3)] transition flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed disabled:shadow-none"
          >
            <Check className="w-4 h-4" />
            {initialValue ? '检查并确认覆盖' : '检查并确认写入'}
          </button>
        </div>

        {(importedDraft || draftValue) && <section className="plan-imported-draft" aria-live="polite">
          <div><Sparkles /><span><strong>{draftValue?.sourceLabel || 'AI 草稿已导入，尚未写入'}</strong><small>现在可以在下方时间线上拖拽、增删和修改；只有通过最终确认才会更新笔记。</small></span></div>
          {importedDraft
            ? <button type="button" onClick={restoreBeforeImportedDraft}><RotateCcw />撤销本次导入</button>
            : onCancel && <button type="button" onClick={onCancel}><X />放弃草稿</button>}
        </section>}

        {researchNotice && aiStep === 0 && <p className="plan-commit-notice plan-research-notice" role="status"><AlertTriangle />{researchNotice}</p>}

        {/* ===== AI Stepper Modal ===== */}
        {aiStep > 0 && (
          <div className="plan-ai-modal fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center" onClick={handleCloseStepper}>
            <div ref={aiDialogRef} role="dialog" aria-modal="true" aria-label="AI 计划草图" tabIndex={-1} className="plan-ai-dialog bg-white dark:bg-slate-900 rounded-2xl shadow-2xl border border-slate-200 dark:border-slate-800 w-full max-w-lg mx-4 overflow-hidden" onClick={e => e.stopPropagation()}>
              {/* Header */}
              <div className="plan-ai-dialog-header bg-indigo-600 px-5 py-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Brain className="w-5 h-5 text-white" />
                  <span className="text-white font-black text-sm">AI 计划架构师</span>
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
                        type="button"
                        aria-label={`第 ${s.step} 步：${s.label}`}
                        aria-current={isActive ? 'step' : undefined}
                        disabled={!canClick}
                        onClick={() => { if (canClick) setAiStep(s.step as PlanStepperStep); }}
                        className={`plan-ai-step w-8 h-8 rounded-full flex items-center justify-center text-xs font-black transition-all ${
                          isActive ? 'is-current shadow-lg scale-110' :
                          isDone ? 'is-complete cursor-pointer' : ''
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
                            type="button"
                            aria-pressed={aiDailyHours === h}
                            aria-label={`每天 ${h} 小时`}
                            onClick={() => {
                              setAiDailyHours(h);
                            }}
                            className="plan-ai-hours-option w-16 h-16 rounded-2xl border-2 transition-all flex flex-col items-center justify-center gap-1"
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
                    {s.step === 3 && <div className="plan-research-option">
                      <label><input type="checkbox" checked={onlineResearch} onChange={event => setOnlineResearch(event.target.checked)} />联网补充课程范围与先修要求</label>
                      {onlineResearch && <label>公开检索主题<input type="text" maxLength={120} value={publicResearchSubject ?? (aiSubject.trim() || rootTitle.trim())} onChange={event => setPublicResearchSubject(event.target.value)} /><small>仅此主题发往搜索服务，请勿填私人内容；搜索 API 可能计费。不下载或绑定资料。</small></label>}
                    </div>}
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

                {researchNotice && <p className="plan-commit-notice plan-research-notice" role="status"><AlertTriangle />{researchNotice}</p>}
                {aiInterrupted && <p className="plan-commit-notice plan-research-notice" role="status">
                  <span>{retryInputEmpty ? '回答已清空，请输入新回答后继续。' : '生成已暂停，当前输入与对话已保留。'}</span>
                  <button type="button" className="plan-ai-resume shrink-0" disabled={!canResumePlan} onClick={handleResumePlan}>继续生成</button>
                </p>}
                {aiError && (
                  <div role="alert" className="mt-3 px-3 py-2 rounded-xl bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 text-xs text-red-600 dark:text-red-400">
                    {aiError}
                    {retryInputEmpty && <span className="block">回答已清空，请输入新回答后重试。</span>}
                    <button type="button" className="ml-2 underline disabled:opacity-40 disabled:cursor-not-allowed" disabled={!canResumePlan} onClick={handleResumePlan}>重试</button>
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

      <PlanDualTrackComposer
        isActive={isActive}
        onUndo={() => moveHistory('undo')} onRedo={() => moveHistory('redo')}
        canUndo={historyAvailability.undo} canRedo={historyAvailability.redo}
        nodes={planNodes}
        rootProjectKey={initialValue?.rootId || draftValue?.tree[0].key}
        existingProjects={initialValue?.projectCatalog || []}
        executionTasks={executionTasks}
        milestones={draftMilestones}
        settings={timelineSettings}
        assessment={conditionAssessment}
        onNodesChange={setPlanNodes}
        onExecutionTasksChange={setExecutionTasks}
        onMilestonesChange={setDraftMilestones}
        onSettingsChange={handleTimelineSettingsChange}
      />

      {commitConfirmOpen && <div className="plan-commit-backdrop" role="presentation" onMouseDown={() => { if (!commitSavingRef.current) setCommitConfirmOpen(false); }}>
        <section ref={commitDialogRef} tabIndex={-1} className="plan-commit-dialog" role="dialog" aria-modal="true" aria-busy={commitSaving} aria-labelledby="plan-commit-title" onMouseDown={(event) => event.stopPropagation()}>
          <header><div><span>FINAL REVIEW</span><h2 id="plan-commit-title">确认写入学习计划</h2><p>这是唯一会更新项目笔记与计划数据的步骤。</p></div><button type="button" disabled={commitSaving} aria-label="关闭确认窗口" onClick={() => setCommitConfirmOpen(false)}><X /></button></header>
          <div className="plan-commit-target"><FileCheck2 /><span><small>{initialValue ? '覆盖范围' : '新计划'}</small><strong>{rootTitle}</strong><em>{rootStartDate} — {rootDueDate || '弹性结束'}</em></span></div>
          <div className="plan-commit-stats">
            <span><strong>{blueprintStats.phases}</strong><small>结构项目</small></span>
            <span><strong>{executionTasks.length}</strong><small>执行规则</small></span>
            <span><strong>{draftMilestones.length}</strong><small>里程碑</small></span>
            <span><strong>{dailyStudyMinutes}</strong><small>分钟 / 叶子项目（默认）</small></span>
          </div>
          {initialValue ? <p className="plan-commit-notice"><AlertTriangle />只覆盖当前载入的根计划。被移出轨道的项目笔记会保留，仅清除其计划时限。</p>
            : <p className="plan-commit-notice is-safe"><Check />确认后才会创建结构化项目笔记；当前草稿尚未写入本地数据。</p>}
          {commitError && <p className="plan-commit-notice" role="alert"><AlertTriangle />{commitError}</p>}
          {commitSaving && <p className="plan-commit-notice is-safe" role="status"><Loader2 className="animate-spin" />正在保存，完成后将返回计划视图…</p>}
          {conditionAssessment.issues.length > 0 && <ul>{conditionAssessment.issues.slice(0, 4).map((issue) => <li key={issue.code}>{issue.message}</li>)}</ul>}
          {!!capacityWarnings.length && <ul role="alert">{capacityWarnings.slice(0, 8).map((warning, i) => <li key={i}>{warning}；确认不会自动挪动其他计划。</li>)}</ul>}
          <footer><button type="button" disabled={commitSaving} onClick={() => setCommitConfirmOpen(false)}>返回继续调整</button><button type="button" disabled={commitSaving} className="is-primary" onClick={handleCreateProjectTree}>{commitSaving ? <Loader2 className="animate-spin" /> : <FileCheck2 />}{commitSaving ? '正在保存…' : commitError ? '重试保存' : initialValue ? '确认覆盖当前计划' : '确认并正式写入'}</button></footer>
        </section>
      </div>}

      {/* ===== 生成计划等待弹窗 ===== */}
      {aiLoading && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <motion.div
            ref={loadingDialogRef} role="dialog" aria-modal="true" aria-label="正在生成计划草图" tabIndex={-1}
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
            <button type="button" onClick={handleCloseStepper} className="px-3 py-2 rounded-lg text-xs border border-slate-200 dark:border-slate-700">取消生成</button>
          </motion.div>
        </div>
      )}
    </div>
  );
};
