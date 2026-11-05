import React, { useCallback, useEffect, useRef, useState } from 'react';
import { hasActiveDialog } from './useDialog';
import { allowCognitionLeave } from '../services/ui/cognitionLeave';
import { TextbookProgressCard } from './textbook/TextbookProgressCard';
import { useTextbookProgress } from './textbook/useTextbookProgress';
import { textbookResumeCall } from '../services/textbook/resume';
import { ArrowRight, BarChart3, Bot, Check, CheckCircle2, ChevronDown, Copy, Download, ExternalLink, GitBranch, GripHorizontal, LockKeyhole, LogIn, Maximize2, Minimize2, RotateCcw, ScanSearch, Send, ShieldCheck, Square, ThumbsDown, Trash2, Wrench, X } from 'lucide-react';
import type { AgentCitation, LlmConversationMessage, ResourceItem } from '../types';
import { resolveAgentApproval, resumeAgentTurn, runAgentTurn } from '../services/agent/agentEngine';
import { AgentRunFailure, type AgentRunRecovery } from '../services/agent/runRecovery';
import { agentStopFeedback, agentTraceSummary, buildAgentMessageActionPrompt } from '../services/agent/interactionFeedback';
import { AGENT_SEQUENCE_LABELS, agentSequenceExecution, buildAgentSequenceStepRequest, consumeAgentSequenceOutcome,
  createAgentSkillSequence, currentAgentSequenceStep, recordAgentSequenceResult,
  updateAgentSequenceStep, type AgentSequenceExecution, type AgentSkillSequence } from '../services/agent/skillSequence';
import { persistAgentSequence, restoreAgentSequence, recoveredSequenceNeedsInspection } from '../services/agent/sequencePersistence';
import { agentTaskScope } from '../services/agent/taskStateClient';
import { agentConversationScheduler } from '../services/agent/conversations';
import { getAgentSkill, selectAgentSkill, shouldBypassPersonalizedQa } from '../services/agent/skillRegistry';
import type {
  AgentPendingApproval,
  AgentObservedOutcome,
  AgentActivityUpdate,
  AgentPlanDraftSession,
  AgentResourceDraftSession,
  AgentRole,
  AgentRuntimeContext,
  AgentToolStep,
  AgentWorkflowAction,
  AgentWorkflowHandoff,
} from '../services/agent/types';
import { buildPlanHandoff } from '../services/agent/workflowHandoff';
import { recordAgentHandoffAudit } from '../services/agent/auditStore';
import { agentWorkspaceContextKey, historyForAgentWorkspace } from '../services/agent/workspaceContext';
import {
  clearPendingAgentCheckpoint,
  loadPendingAgentCheckpoint,
  markAgentCheckpointResolving,
  savePendingAgentCheckpoint,
} from '../services/agent/checkpointStore';
import { clearAgentSession, loadAgentSession, saveAgentSession, flushAgentSessionWrites } from '../services/agent/sessionStore';
import { flushAgentTaskStateWrites } from '../services/agent/taskStateClient';
import { rendererExitPreparation, waitForExitCondition } from '../services/ui/applicationExit';
import { AgentAuditView } from './AgentAuditView';
import { AgentPromptReplacement } from './AgentPromptReplacement';
import { AgentClearConfirmation } from './AgentClearConfirmation';
import { ConceptBatchProgress } from './ConceptBatchProgress';
import { BackgroundWorkflowProgress } from './BackgroundWorkflowProgress';
import { backgroundWorkflowResumeCall } from '../services/agent/workflowToolNames';
import { DocumentPreviewDialog,DocumentConfirmationDialog } from './DocumentsView';
import { useDocumentCitationPreview } from './useDocumentCitationPreview';
import { AgentRichMessage } from './AgentRichMessage';
import { agentMessageDisplayContent } from '../services/agent/answerFormat';
import { agentActivityLabel, agentToolLabel } from '../services/agent/toolPresentation';
import { hasActiveAgentDraft } from '../services/agent/activeDraft';
import {
  centerFloatingPanel,
  clampFloatingPanelBounds,
  moveFloatingPanel,
  resizeFloatingPanel,
  type FloatingPanelBounds,
  type FloatingPanelResizeDirection,
} from '../services/ui/floatingPanelGeometry';

const RESOURCE_TYPE_LABELS: Record<NonNullable<ResourceItem['resourceType']>, string> = {
  webpage: '网页', article: '文章', video: '视频', audio: '音频', pdf: 'PDF',
  presentation: '演示文稿', document: '文档', image: '图片', archive: '压缩包', other: '其他',
};

function resourceSizeLabel(bytes?: number): string {
  if (!bytes || bytes < 1) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function comparableResourceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return value.trim();
  }
}

function structurePatchText(patch: AgentPlanDraftSession['structurePatches'][number]): string {
  if (patch.operation === 'add_child') return `在“${patch.parentProjectTitle}”下新增“${patch.title}”`;
  if (patch.operation === 'move') return `将“${patch.projectTitle}”移动到“${patch.newParentProjectTitle}”下`;
  if (patch.operation === 'delete_subtree') return `删除“${patch.projectTitle}”及其子项目`;
  const changes = [
    patch.title ? `改名为“${patch.title}”` : '',
    patch.startDate ? `开始 ${patch.startDate}` : '',
    patch.clearStartDate ? '清除开始日期' : '',
    patch.dueDate ? `结束 ${patch.dueDate}` : '',
    patch.clearDueDate ? '清除结束日期' : '',
    patch.priority ? `优先级 ${patch.priority}` : '',
  ].filter(Boolean);
  return `更新“${patch.projectTitle}”：${changes.join('，') || '无有效字段'}`;
}

function planMetaPatchText(patch: NonNullable<AgentPlanDraftSession['planMetaPatch']>): string {
  return Object.entries(patch).map(([key, value]) => {
    const rendered = Array.isArray(value) ? value.join('、') : typeof value === 'object' ? JSON.stringify(value) : String(value);
    return `${key}=${rendered}`;
  }).join('；');
}

function milestonePatchText(patch: AgentPlanDraftSession['milestonePatches'][number]): string {
  return [patch.operation, patch.title || patch.milestoneId, patch.dueDate, patch.criteria?.length ? `验收：${patch.criteria.join('、')}` : ''].filter(Boolean).join(' · ');
}

function executionPatchText(patch: AgentPlanDraftSession['executionPatches'][number]): string {
  const dates = patch.startDate || patch.dueDate ? `${patch.startDate || '原开始'}→${patch.dueDate || '原结束'}` : '';
  const recurrence = patch.clearRecurrence ? '取消重复' : patch.recurrence?.frequency ? `重复：${patch.recurrence.frequency}` : '';
  const bindings = [
    patch.linkedProjectTitle ? `项目：${patch.linkedProjectTitle}` : '',
    patch.milestoneId ? `里程碑：${patch.milestoneId}` : '',
    patch.linkedKnowledgeTitles?.length ? `知识点：${patch.linkedKnowledgeTitles.join('、')}` : '',
  ].filter(Boolean).join('；');
  return [
    patch.operation,
    patch.taskText || patch.taskId,
    dates,
    patch.estimatedMinutes ? `${patch.estimatedMinutes} 分钟` : '',
    patch.priority ? `优先级 ${patch.priority}` : '',
    recurrence,
    patch.launchMode && patch.launchMode !== 'none' ? `入口 ${patch.launchMode}` : '',
    bindings,
  ].filter(Boolean).join(' · ');
}

interface FailedAgentRequest {
  text: string;
  baseHistory: LlmConversationMessage[];
  requestedSkillId?: string;
  recovery?: AgentRunRecovery;
  observedOutcome?: AgentObservedOutcome;
  sequenceExecution?: AgentSequenceExecution;
}

const AGENT_PANEL_BOUNDS_KEY = 'loginote.agent-panel-bounds.v1';
const AGENT_PANEL_RESIZE_DIRECTIONS: FloatingPanelResizeDirection[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

function currentViewport(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

function loadAgentPanelBounds(): FloatingPanelBounds | null {
  if (typeof window === 'undefined') return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(AGENT_PANEL_BOUNDS_KEY) || 'null') as Partial<FloatingPanelBounds> | null;
    if (!parsed || !['left', 'top', 'width', 'height'].every((key) => Number.isFinite(parsed[key as keyof FloatingPanelBounds]))) return null;
    return clampFloatingPanelBounds(parsed as FloatingPanelBounds, currentViewport());
  } catch {
    return null;
  }
}

function persistAgentPanelBounds(bounds: FloatingPanelBounds): void {
  try {
    window.localStorage.setItem(AGENT_PANEL_BOUNDS_KEY, JSON.stringify(bounds));
  } catch {
    // Local storage may be unavailable in hardened environments; geometry still works for this session.
  }
}

export const AgentPanel: React.FC<{
  open: boolean;
  workflowDraftReady: boolean;
  role: AgentRole;
  ctx: AgentRuntimeContext;
  selectedProjectTitle?: string;
  planDraftSession: AgentPlanDraftSession | null;
  onDiscardPlanDraft: () => void;
  resourceDraftSession: AgentResourceDraftSession | null;
  onDiscardResourceDraft: () => void;
  onOpenResource: (resource: ResourceItem) => void;
  onDownloadResource: (resource: ResourceItem) => Promise<boolean>;
  onScanResourcePage: (resource: ResourceItem) => Promise<number>;
  onAuthorizeResource: (resource: ResourceItem) => Promise<boolean>;
  onSetResourceCandidateDecision: (resource: ResourceItem, decision: 'selected' | 'rejected') => Promise<void>;
  resourceActivity?: { id: string; text: string } | null;
  workflowHandoff: AgentWorkflowHandoff | null;
  onWorkflowHandoffChange: (handoff: AgentWorkflowHandoff | null) => void;
  onContinueLearning?: (rootId: string) => boolean;
  onClose: () => void;
  onBusyChange: (busy: boolean) => void;
  externalRequest?: { id: string; text: string; targetSkillId?: string; observedOutcome?: AgentObservedOutcome } | null;
  onOpen?: () => void;
  conversationChrome?: React.ReactNode;
  conversationScopeAction?: React.ReactNode;
  onConversationState?: (state: { busy: boolean; pending: boolean; queued: boolean; preview: string; sequenceActive: boolean }) => void;
}> = ({ open, workflowDraftReady, role, ctx, selectedProjectTitle, planDraftSession, onDiscardPlanDraft, resourceDraftSession, onDiscardResourceDraft, onOpenResource, onDownloadResource, onScanResourcePage, onAuthorizeResource, onSetResourceCandidateDecision, resourceActivity, workflowHandoff, onWorkflowHandoffChange, onContinueLearning, onClose, onBusyChange, externalRequest, onOpen, conversationChrome, conversationScopeAction, onConversationState }) => {
  const [history, setHistory] = useState<LlmConversationMessage[]>([]);
  // Earlier work objects stay visible, but cannot influence routing, tools,
  // summaries or approval continuations for the current object.
  const [previousHistory, setPreviousHistory] = useState<LlmConversationMessage[]>([]);
  const [input, setInput] = useState('');
  const [pendingInputReplacement, setPendingInputReplacement] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);
  const [error, setError] = useState('');
  const [trace, setTrace] = useState<AgentToolStep[]>([]);
  const [activeSkillId, setActiveSkillId] = useState('');
  const [activeSkillName, setActiveSkillName] = useState('');
  const workspaceContextKey = agentWorkspaceContextKey(ctx);
  const [activeSkillContextKey, setActiveSkillContextKey] = useState(workspaceContextKey);
  const [pendingApproval, setPendingApproval] = useState<AgentPendingApproval | null>(null);
  const conversationPreview = history.find(message => message.role === 'user')?.content.slice(0, 32) || '';
  const [auditOpen, setAuditOpen] = useState(false);
  const [downloadingCandidateId, setDownloadingCandidateId] = useState('');
  const [browserActionCandidateId, setBrowserActionCandidateId] = useState('');
  const [resourceNotice, setResourceNotice] = useState('');
  const documentCitation = useDocumentCitationPreview(`${role.id}:${open}:${auditOpen}`);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [copiedMessageIndex, setCopiedMessageIndex] = useState<number | null>(null);
  const [failedRequest, setFailedRequest] = useState<FailedAgentRequest | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [activity, setActivity] = useState<AgentActivityUpdate | null>(null);
  const textbookProjectId = ctx.getActiveNote?.()?.noteType === 'project' ? ctx.getActiveNote?.()?.id : undefined;
  const { progress: textbookProgress, restoreError: textbookProgressError } = useTextbookProgress(textbookProjectId, open);
  const [cancellable, setCancellable] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [checkpointReady, setCheckpointReady] = useState(false);
  const [panelBounds, setPanelBounds] = useState<FloatingPanelBounds | null>(loadAgentPanelBounds);
  const [panelInteracting, setPanelInteracting] = useState(false);
  const [skillSequence, setSkillSequence] = useState<AgentSkillSequence | null>(null);
  const sequenceActive = !!skillSequence?.steps.some(step => !['complete', 'cancelled'].includes(step.status));
  useEffect(() => { onConversationState?.({ busy, queued, pending: !!pendingApproval, preview: conversationPreview, sequenceActive }); },
    [busy, queued, pendingApproval, conversationPreview, sequenceActive, onConversationState]);
  const skillSequenceRef = useRef(skillSequence);
  const sequenceScopeRef = useRef<string | undefined>(undefined);
  const sequencePersistenceRef = useRef<Promise<void>>(Promise.resolve());
  const clearingConversationRef = useRef(false);
  const changeSkillSequence = useCallback((next: AgentSkillSequence | null) => {
    skillSequenceRef.current = next;
    setSkillSequence(next);
    const scopeId = sequenceScopeRef.current;
    if (scopeId) {
      const write = persistAgentSequence(scopeId, role.id, next);
      sequencePersistenceRef.current = write;
      void write.catch(() => {
        if (sequencePersistenceRef.current !== write) return;
        setResourceNotice('连续任务进度未能持久化；请暂勿关闭应用，检查存储后再继续。已完成产物不会回滚。');
      });
    }
  }, [role.id]);
  const recordSequenceResult = useCallback((result: Awaited<ReturnType<typeof runAgentTurn>>, execution?: AgentSequenceExecution) => {
    const current = skillSequenceRef.current;
    if (!execution || !current || execution.sequenceId !== current.id || execution.stepIndex !== currentAgentSequenceStep(current)?.index) return;
    changeSkillSequence(recordAgentSequenceResult(current, result, ctx));
  }, [changeSkillSequence, ctx]);
  const panelRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const handledExternalRequestRef = useRef('');
  const stickToBottomRef = useRef(true);
  const abortControllerRef = useRef<AbortController | null>(null);
  const requestBusyRef = useRef(false);
  const exitSnapshotRef = useRef({ history, previousHistory, activeSkillId, activeSkillName, activeSkillContextKey });
  exitSnapshotRef.current = { history, previousHistory, activeSkillId, activeSkillName, activeSkillContextKey };
  useEffect(() => rendererExitPreparation.register({
    name: '助手对话、教材与会话保存',
    backgroundTasks: () => requestBusyRef.current ? 1 : 0,
    stop: async () => {
      abortControllerRef.current?.abort();
      await waitForExitCondition(() => !requestBusyRef.current);
      const sequence = skillSequenceRef.current;
      if (sequence && currentAgentSequenceStep(sequence)?.status !== 'cancelled') {
        changeSkillSequence(updateAgentSequenceStep(sequence, 'paused', '应用退出前已保存进度；下次打开后请核对目标再继续。'));
      }
      await sequencePersistenceRef.current;
      const latest = exitSnapshotRef.current;
      if (latest.history.length || latest.previousHistory.length) await saveAgentSession({ roleId: role.id, workspaceContextKey: latest.activeSkillContextKey,
        activeSkillId: latest.activeSkillId, activeSkillName: latest.activeSkillName, history: latest.history, previousHistory: latest.previousHistory });
      await Promise.all([flushAgentSessionWrites(), flushAgentTaskStateWrites()]);
    },
  }), [role.id, changeSkillSequence]);
  const persistedApprovalIdsRef = useRef(new Set<string>());
  const normalPanelBoundsRef = useRef<FloatingPanelBounds | null>(null);
  const interactionCleanupRef = useRef<(() => void) | null>(null);
  const useAcceptancePrompt = useCallback((prompt: string) => {
    setAuditOpen(false);
    setError('');
    if (input.trim() && input !== prompt || requestBusyRef.current || pendingApproval) {
      setPendingInputReplacement(prompt);
      return;
    }
    setPendingInputReplacement(null);
    setInput(prompt);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [input, pendingApproval]);
  const replacePendingInput = () => {
    if (requestBusyRef.current || busy || pendingApproval || pendingInputReplacement === null) return;
    setInput(pendingInputReplacement);
    setPendingInputReplacement(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const scrollToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    const list = listRef.current;
    if (!list) return;
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
    list.scrollTo({ top: list.scrollHeight, behavior });
  }, []);

  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);
  useEffect(() => {
    if (activeSkillContextKey === workspaceContextKey) return;
    // The transcript remains visible, but its operational mode does not follow
    // the user into another note or page.
    setActiveSkillId('');
    setActiveSkillName('');
    setFailedRequest(null);
    onWorkflowHandoffChange(null);
  }, [activeSkillContextKey, workspaceContextKey, onWorkflowHandoffChange]);
  useEffect(() => {
    if (stickToBottomRef.current) requestAnimationFrame(() => scrollToLatest());
    else if (history.length > 0) setShowJumpToLatest(true);
  }, [busy, history, scrollToLatest]);
  useEffect(() => {
    const textarea = inputRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 140)}px`;
  }, [input]);
  useEffect(() => {
    if (resourceActivity?.text) {
      setResourceNotice(resourceActivity.text);
      if (stickToBottomRef.current) requestAnimationFrame(() => scrollToLatest());
      else setShowJumpToLatest(true);
    }
  }, [resourceActivity?.id, resourceActivity?.text, scrollToLatest]);
  useEffect(() => {
    if (!open || auditOpen || busy || pendingApproval) setClearConfirmOpen(false);
  }, [open, auditOpen, busy, pendingApproval]);
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.isComposing || event.keyCode === 229 || event.defaultPrevented || hasActiveDialog()) return;
      if (clearConfirmOpen) setClearConfirmOpen(false);
      else if (auditOpen) setAuditOpen(false);
      else if (allowCognitionLeave(panelRef.current)) onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [auditOpen, clearConfirmOpen, open, onClose]);
  useEffect(() => {
    if (!open) {
      interactionCleanupRef.current?.();
      setPanelInteracting(false);
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const rect = panelRef.current?.getBoundingClientRect();
      if (!rect) return;
      setPanelBounds((current) => current || clampFloatingPanelBounds({
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      }, currentViewport()));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open]);
  useEffect(() => {
    const keepPanelInViewport = () => {
      setPanelBounds((current) => {
        if (!current) return current;
        const next = clampFloatingPanelBounds(current, currentViewport());
        if (!expanded) persistAgentPanelBounds(next);
        return next;
      });
    };
    window.addEventListener('resize', keepPanelInViewport);
    return () => window.removeEventListener('resize', keepPanelInViewport);
  }, [expanded]);
  useEffect(() => () => interactionCleanupRef.current?.(), []);
  useEffect(() => {
    if (!workflowDraftReady) return undefined;
    let cancelled = false;
    persistedApprovalIdsRef.current.clear();
    setCheckpointReady(false);
    sequenceScopeRef.current = undefined;
    skillSequenceRef.current = null;
    setSkillSequence(null);
    void loadPendingAgentCheckpoint(role.id)
      .then(async (loaded) => {
        try {
          const restored = await restoreAgentSequence(role.id);
          if (cancelled) return;
          sequenceScopeRef.current = restored.scopeId;
          skillSequenceRef.current = restored.sequence;
          setSkillSequence(restored.sequence);
        } catch {
          if (!cancelled) setResourceNotice('连续任务恢复不可用，请检查存储或重启更新后的桌面应用；未自动重做任务。');
        }
        if (cancelled) return;
        const restoredSession = await loadAgentSession(role.id);
        if (cancelled) return;
        setPreviousHistory(restoredSession?.previousMessages || []);
        if (loaded.status === 'restored' && loaded.record) {
          const expectedDraft = loaded.record.approval.continuation.checkpoint?.hasActiveDraft;
          const hasRestoredDraft = hasActiveAgentDraft(ctx);
          if (expectedDraft && !hasRestoredDraft) {
            await clearPendingAgentCheckpoint(role.id);
            if (!cancelled) setResourceNotice('上次待确认操作依赖的业务草稿已经失效，已安全作废，请重新发起。');
            return;
          }
          setHistory(loaded.record.history);
          setPendingApproval(loaded.record.approval);
          persistedApprovalIdsRef.current.add(loaded.record.approval.id);
          setActiveSkillId(loaded.record.approval.continuation.checkpoint?.activeSkill?.id || '');
          setActiveSkillName(loaded.record.approval.continuation.checkpoint?.activeSkill?.name || '');
          setResourceNotice('已恢复上次尚未确认的操作。请核对影响范围后确认或取消。');
          return;
        }
        if (loaded.status === 'expired') setResourceNotice('上次待确认操作已超过 24 小时，已安全作废。');
        if (loaded.status === 'invalid') setResourceNotice('上次待确认操作与当前角色或版本不兼容，已安全作废。');
        if (loaded.status === 'interrupted') {
          setResourceNotice('上次操作在确认执行过程中中断。为避免重复写入，系统未自动重试；请先检查数据，再重新发起。');
        }
        if (!restoredSession) return;
        setHistory(restoredSession.messages);
        setActiveSkillContextKey(restoredSession.workspaceContextKey);
        setActiveSkillId(restoredSession.activeSkillId || '');
        setActiveSkillName(restoredSession.activeSkillName || '');
      })
      .catch((cause) => {
        if (!cancelled) console.warn('[agent-checkpoint] restore failed:', cause);
      })
      .finally(() => {
        if (!cancelled) setCheckpointReady(true);
      });
    return () => { cancelled = true; };
    // Context callbacks are read only after workflow draft hydration. Depending
    // on the whole ctx object would reload the checkpoint on every App render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role.id, workflowDraftReady]);

  useEffect(() => {
    if (!checkpointReady || (!history.length && !previousHistory.length)) return undefined;
    const timer = window.setTimeout(() => {
      if (clearingConversationRef.current) return;
      void saveAgentSession({
        roleId: role.id,
        workspaceContextKey: activeSkillContextKey,
        activeSkillId,
        activeSkillName,
        history,
        previousHistory,
      }).catch((cause) => console.warn('[agent-session] persist failed:', cause));
    }, 350);
    return () => window.clearTimeout(timer);
  }, [activeSkillContextKey, activeSkillId, activeSkillName, checkpointReady, history, previousHistory, role.id]);

  const sendText = useCallback(async (rawText: string, launch?: {
    handoff: AgentWorkflowHandoff;
    action: AgentWorkflowAction;
  }, baseHistoryOverride?: LlmConversationMessage[], targetSkillId?: string, recovery?: AgentRunRecovery, preserveInput = false, observedOutcome?: AgentObservedOutcome, sequenceExecution?: AgentSequenceExecution, textbookResumeJobId?: string, backgroundResumeJobId?: string) => {
    const text = rawText.trim();
    if (!text || requestBusyRef.current || busy || pendingApproval || !checkpointReady || rendererExitPreparation.isStopping()) return;
    const requestWorkspaceContextKey = agentWorkspaceContextKey(ctx);
    const sameWorkspaceContext = activeSkillContextKey === requestWorkspaceContextKey;
    if (!sameWorkspaceContext && (recovery || baseHistoryOverride !== undefined)) {
      setError('工作对象已切换，旧请求不会在新对象上重试；请回到原对象核对，或重新发起请求。');
      return;
    }
    requestBusyRef.current = true;
    let execution = sequenceExecution || recovery?.state.sequenceExecution;
    if (!execution && !targetSkillId && !launch && !recovery && !backgroundResumeJobId) {
      const created = createAgentSkillSequence(text, role.id, ctx);
      const current = skillSequenceRef.current;
      const step = current ? currentAgentSequenceStep(current) : undefined;
      if (created) {
        if (!sequenceScopeRef.current) {
          setResourceNotice('任务恢复存储不可用，尚未启动连续任务；请检查存储或重启更新后的桌面应用。');
          requestBusyRef.current = false; return;
        }
        changeSkillSequence(created);
        onWorkflowHandoffChange(null);
        execution = agentSequenceExecution(created);
      } else if (sameWorkspaceContext && current && step?.status === 'waiting-input' && !shouldBypassPersonalizedQa(text)
        && (!selectAgentSkill(text) || selectAgentSkill(text)?.id === step.skillId)) {
        execution = agentSequenceExecution(current);
      } else if (current && step && step.status !== 'cancelled') {
        changeSkillSequence(updateAgentSequenceStep(current, 'paused', '已暂停连续任务，先处理你当前的请求。'));
      }
    } else if (!execution && skillSequenceRef.current && currentAgentSequenceStep(skillSequenceRef.current)?.status !== 'cancelled') {
      changeSkillSequence(updateAgentSequenceStep(skillSequenceRef.current, 'paused', '已暂停连续任务，先处理本次独立请求。'));
    }
    if (execution) {
      const current = skillSequenceRef.current;
      if (!current || current.id !== execution.sequenceId || currentAgentSequenceStep(current)?.index !== execution.stepIndex
        || currentAgentSequenceStep(current)?.status === 'cancelled') { requestBusyRef.current = false; return; }
      changeSkillSequence(updateAgentSequenceStep(current, 'running'));
      try {
        await sequencePersistenceRef.current;
        if (!sequenceScopeRef.current || sequenceScopeRef.current !== await agentTaskScope()) throw new Error('资料库已切换，旧连续任务不会在新资料库执行。');
      } catch (cause) {
        changeSkillSequence(updateAgentSequenceStep(current, 'paused', '进度未能保存或资料库变化，未启动本环节。'));
        setResourceNotice(cause instanceof Error ? cause.message : '任务进度未能保存');
        requestBusyRef.current = false; return;
      }
    }
    // Do not feed another page's operational history (old review questions,
    // job IDs or tool calls) into a new page-scoped request.
    const baseHistory = baseHistoryOverride ?? historyForAgentWorkspace(history, activeSkillContextKey, requestWorkspaceContextKey);
    if (!sameWorkspaceContext && history.length) setPreviousHistory(current => [...current, ...history]);
    const previousSkillId = sameWorkspaceContext ? activeSkillId || undefined : undefined;
    // Only explicit UI/workflow actions may force a Skill. Free-form text is
    // routed semantically in the runtime; preselecting here would let a keyword
    // match bypass intent understanding entirely.
    const explicitRequestedSkillId = execution?.skillId || targetSkillId || launch?.action.targetSkillId;
    const requestedSkill = explicitRequestedSkillId ? getAgentSkill(explicitRequestedSkillId) : undefined;
    if (!preserveInput) setInput('');
    setError('');
    setFailedRequest(null);
    setActivity({ phase: 'syncing' });
    setTrace(recovery?.trace || []);
    setPendingApproval(null);
    setActiveSkillContextKey(requestWorkspaceContextKey);
    setActiveSkillId(requestedSkill?.id || (sameWorkspaceContext ? activeSkillId : ''));
    setActiveSkillName(requestedSkill?.name || (sameWorkspaceContext ? activeSkillName : ''));
    stickToBottomRef.current = true;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setCancellable(true);
    setStopping(false);
    setBusy(true);
    const visiblePending = recovery?.messages || [...baseHistory, { role: 'user' as const, content: text }];
    const observedSteps = [...(recovery?.trace || [])];
    setHistory(visiblePending);
    let releaseSlot: (() => void) | undefined;
    try {
      if (ctx.getConversationId) {
        setQueued(true); releaseSlot = await agentConversationScheduler.acquire(controller.signal); setQueued(false);
      }
      if (agentWorkspaceContextKey(ctx) !== requestWorkspaceContextKey)
        throw new Error('排队期间工作对象发生变化，本次未执行；请核对对象后重新发起。');
      const callbacks = {
        onStep: (step: AgentToolStep) => { observedSteps.push(step); setTrace((current) => [...current, step]); },
        onActivity: (next: AgentActivityUpdate) => {
          setActivity(next);
          if (next.skillId) setActiveSkillId(next.skillId);
          if (next.skillName) setActiveSkillName(next.skillName);
        },
      };
      const result = recovery ? await resumeAgentTurn({ role, recovery, ctx, signal: controller.signal, ...callbacks }) : await runAgentTurn({
        role, userText: text, history: baseHistory, ctx,
        requestedSkillId: requestedSkill?.id,
        preferredSkillId: previousSkillId,
        observedOutcome,
        sequenceExecution: execution,
        enableMultiAgent: !textbookResumeJobId && !backgroundResumeJobId,
        ...(textbookResumeJobId || backgroundResumeJobId ? {
          // Keep the normal role/Skill/binding/approval/audit pipeline, but bypass
          // model planning for this explicit UI action. No model can change its job ID.
          callLlm: async () => ({ content: '从原任务检查点继续，请确认执行。', toolCalls: [backgroundResumeJobId ? backgroundWorkflowResumeCall(backgroundResumeJobId) : textbookResumeCall(textbookResumeJobId!)] }),
          memoryPrefixLoader: async () => '',
        } : {}),
        signal: controller.signal,
        ...callbacks,
      });
      setHistory(result.updatedHistory);
      recordSequenceResult(result, execution);
      setActiveSkillId(result.activeSkill?.id || '');
      setActiveSkillName(result.activeSkill?.name || '');
      const nextApproval = result.pendingApproval || null;
      setPendingApproval(nextApproval);
      if (nextApproval) {
        try {
          await savePendingAgentCheckpoint({ roleId: role.id, approval: nextApproval, history: result.updatedHistory });
          persistedApprovalIdsRef.current.add(nextApproval.id);
        } catch (checkpointError) {
          console.warn('[agent-checkpoint] persist failed:', checkpointError);
          setResourceNotice('该确认请求当前只保存在本次会话；关闭软件后将无法恢复。');
        }
      }
      const handoff = execution ? null : buildPlanHandoff(result);
      if (handoff) onWorkflowHandoffChange(handoff);
      if (launch) {
        const reachedTarget = result.activeSkill?.id === launch.action.targetSkillId;
        recordAgentHandoffAudit({
          handoff: launch.handoff,
          action: launch.action,
          status: reachedTarget ? 'arrived' : 'route-mismatch',
          actualTargetSkillId: result.activeSkill?.id,
          agentRunId: result.auditRunId,
        }).catch((auditError) => console.warn('[agent-handoff] audit route failed:', auditError));
      }
    } catch (cause) {
      const recoveryPoint = cause instanceof AgentRunFailure ? cause.recovery : undefined;
      setHistory(recoveryPoint?.messages || visiblePending);
      const cancelled = controller.signal.aborted || (cause instanceof DOMException && cause.name === 'AbortError');
      setError(cancelled
        ? agentStopFeedback(observedSteps)
        : cause instanceof Error ? cause.message : String(cause));
      setFailedRequest(cancelled ? null : { text, baseHistory, requestedSkillId: requestedSkill?.id, recovery: recoveryPoint || recovery, observedOutcome, sequenceExecution: execution });
      const sequence = skillSequenceRef.current;
      if (execution && sequence?.id === execution.sequenceId && currentAgentSequenceStep(sequence)?.status !== 'cancelled') {
        changeSkillSequence(updateAgentSequenceStep({ ...sequence,
          scopeProjectId: sequence.scopeProjectId || recoveryPoint?.state.sequenceExecution?.scopeProjectId }, 'paused',
        cancelled ? '已停止连续任务，已完成结果保留。' : '当前环节失败，后续环节未执行。'));
      }
      if (launch) {
        recordAgentHandoffAudit({
          handoff: launch.handoff,
          action: launch.action,
          status: 'failed',
          error: cause,
        }).catch((auditError) => console.warn('[agent-handoff] audit failure failed:', auditError));
      }
    } finally {
      releaseSlot?.(); setQueued(false);
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
      setCancellable(false);
      setStopping(false);
      setActivity(null);
      setBusy(false);
      requestBusyRef.current = false;
    }
  }, [activeSkillContextKey, activeSkillId, busy, checkpointReady, ctx, history, onWorkflowHandoffChange, pendingApproval, role, changeSkillSequence, recordSequenceResult, workspaceContextKey]);

  const send = () => { void sendText(input); };

  const resumeSequence = async () => {
    try { await sequencePersistenceRef.current; }
    catch { setResourceNotice('进度尚未保存，未继续执行；请先检查存储。'); return; }
    const current = skillSequenceRef.current;
    const step = current ? currentAgentSequenceStep(current) : undefined;
    if (!current || step?.status !== 'paused' || busy || pendingApproval) return;
    try {
      if (!sequenceScopeRef.current || sequenceScopeRef.current !== await agentTaskScope()) throw new Error('资料库已切换，不能在新资料库继续旧任务。');
    } catch (cause) { setResourceNotice(cause instanceof Error ? cause.message : '任务范围无法核对'); return; }
    if (skillSequenceRef.current !== current || requestBusyRef.current) return;
    if (recoveredSequenceNeedsInspection(current)) {
      changeSkillSequence(updateAgentSequenceStep(current, 'paused', '上次操作中断，无法核对已写回结果或唯一项目；请先检查现有计划/草稿并明确目标，不会直接重新生成。'));
      return;
    }
    // A pause while a dedicated page was open is not permission to recreate it.
    if (step.previewId || step.draftId) {
      const waiting = updateAgentSequenceStep(current, step.previewId ? 'waiting-editor' : 'waiting-workbench');
      const outcome = externalRequest?.observedOutcome;
      const completed = outcome ? consumeAgentSequenceOutcome(waiting, outcome, ctx) : null;
      if (completed) { changeSkillSequence(completed); return; }
      const pageStillActive = step.previewId ? ctx.hasPendingPlanEditorDraft?.()
        : ctx.getResourceDraftSession()?.id === step.draftId;
      changeSkillSequence(pageStillActive ? { ...waiting, notice: step.previewId ? '请在现有计划编辑器中确认，不会重新生成。' : '请在现有资源工作台中确认，不会重新搜索。' }
        : updateAgentSequenceStep(current, 'paused', '未能核对原页面的完成结果，请检查或重新发起；不会直接重做该环节。'));
      return;
    }
    if (!sequenceScopeRef.current) { setResourceNotice('任务存储尚未就绪，未继续执行。'); return; }
    try {
      const restored = await restoreAgentSequence(role.id);
      if (restored.scopeId !== sequenceScopeRef.current) throw new Error('资料库已切换，不能在新资料库继续旧任务。');
    } catch (cause) { setResourceNotice(cause instanceof Error ? cause.message : '任务范围无法核对'); return; }
    if (skillSequenceRef.current !== current || requestBusyRef.current) return;
    changeSkillSequence(updateAgentSequenceStep(current, 'ready', '继续当前未完成环节。'));
  };

  const stopCurrentRequest = useCallback(() => {
    const controller = abortControllerRef.current;
    if (!controller || controller.signal.aborted) return;
    setStopping(true);
    setActivity({ phase: 'stopping' });
    controller.abort();
  }, []);

  useEffect(() => {
    if (!externalRequest || handledExternalRequestRef.current === externalRequest.id) return;
    if (!checkpointReady) {
      return;
    }
    const sequence = skillSequenceRef.current;
    if (sequence && externalRequest.observedOutcome) {
      const completed = consumeAgentSequenceOutcome(sequence, externalRequest.observedOutcome, ctx);
      if (completed) {
        handledExternalRequestRef.current = externalRequest.id;
        changeSkillSequence(completed);
        onWorkflowHandoffChange(null);
        setResourceNotice(completed.notice || '已完成当前环节。');
        if (!currentAgentSequenceStep(completed)) setHistory((current) => [...current, { role: 'assistant', content: '你要求的连续任务已完成，结果已保存。' }]);
        onOpen?.();
        return;
      }
      const step = currentAgentSequenceStep(sequence);
      if (externalRequest.observedOutcome.kind === 'resource-writeback' && step
        && ['paused', 'cancelled'].includes(step.status) && step.draftId === externalRequest.observedOutcome.draftSessionId) {
        handledExternalRequestRef.current = externalRequest.id;
        setResourceNotice('本批资源已确认保存，连续任务仍保持暂停，不会自动执行后续步骤。');
        return;
      }
    }
    // Plan-editor completion is a deterministic event, not another generation request.
    if (externalRequest.observedOutcome?.kind === 'plan-writeback' || externalRequest.observedOutcome?.kind === 'plan-writeback-failed') {
      if (!busy) handledExternalRequestRef.current = externalRequest.id;
      return;
    }
    if (!open) return;
    if (busy || pendingApproval) {
      setResourceNotice('已收到后续任务，将在当前处理或确认结束后继续。');
      return;
    }
    handledExternalRequestRef.current = externalRequest.id;
    void sendText(externalRequest.text, undefined, undefined, externalRequest.targetSkillId, undefined, true, externalRequest.observedOutcome);
  }, [busy, checkpointReady, externalRequest, open, pendingApproval, sendText, skillSequence, ctx, changeSkillSequence, onOpen, onWorkflowHandoffChange]);

  useEffect(() => {
    const current = skillSequenceRef.current;
    const step = current ? currentAgentSequenceStep(current) : undefined;
    if (!current || step?.status !== 'ready' || busy || requestBusyRef.current || pendingApproval || !checkpointReady || !workflowDraftReady || rendererExitPreparation.isStopping()) return;
    if (activeSkillContextKey !== workspaceContextKey && (!current.scopeProjectId || current.scopeProjectId !== ctx.getActiveNote?.()?.id)) {
      changeSkillSequence(updateAgentSequenceStep(current, 'paused', '工作对象已切换，原连续任务已暂停；请回到原项目核对后继续。'));
      return;
    }
    try {
      const text = step.index === 0 ? current.request : buildAgentSequenceStepRequest(current, ctx);
      onOpen?.();
      void sendText(text, undefined, undefined, step.skillId, undefined, true, undefined, agentSequenceExecution(current));
    } catch (cause) {
      changeSkillSequence(updateAgentSequenceStep(current, 'paused', cause instanceof Error ? cause.message : String(cause)));
    }
  }, [activeSkillContextKey, workspaceContextKey, busy, checkpointReady, ctx, pendingApproval, sendText, skillSequence, workflowDraftReady, changeSkillSequence, onOpen]);

  const answerApproval = async (approved: boolean, revise = false) => {
    if (!pendingApproval || busy || requestBusyRef.current) return;
    requestBusyRef.current = true;
    const approval = pendingApproval;
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setCancellable(true);
    setStopping(false);
    const observedSteps: AgentToolStep[] = [];
    let releaseSlot: (() => void) | undefined;
    setError('');
    setBusy(true);
    setActivity({ phase: 'syncing' });
    try {
      if (persistedApprovalIdsRef.current.has(approval.id)) {
        await markAgentCheckpointResolving(approval.id);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setActivity(null);
      setBusy(false);
      requestBusyRef.current = false;
      abortControllerRef.current = null;
      setCancellable(false);
      return;
    }
    persistedApprovalIdsRef.current.delete(approval.id);
    setPendingApproval(null);
    try {
      if (ctx.getConversationId) {
        setQueued(true); releaseSlot = await agentConversationScheduler.acquire(controller.signal); setQueued(false);
      }
      const result = await resolveAgentApproval({
        role, approval, approved, history, ctx, signal: controller.signal,
        onStep: (step) => { observedSteps.push(step); setTrace((current) => [...current, step]); },
        onActivity: (next) => {
          setActivity(next);
          if (next.skillId) setActiveSkillId(next.skillId);
          if (next.skillName) setActiveSkillName(next.skillName);
        },
      });
      if (approved) {
        const textbookStep = result.toolTrace.find((step) => step.ok && step.call.name === 'generate_project_textbook');
        const textbookResult = textbookStep?.result as { status?: string; projectNoteId?: string; jobId?: string } | undefined;
        if (textbookResult?.projectNoteId && ['published', 'existing_textbook_continue_reading'].includes(textbookResult.status || '')) {
          const project = ctx.getNotes().find((note) => note.id === textbookResult.projectNoteId);
          ctx.recordWorkspaceEvent?.({
            id: `textbook:${textbookResult.jobId || textbookStep?.call.arguments.jobId || textbookResult.projectNoteId}`,
            kind: 'background-task-completed', occurredAt: new Date().toISOString(), noteId: textbookResult.projectNoteId,
            title: project?.title || '项目教材', status: textbookResult.status,
            summary: textbookResult.status === 'published' ? '项目教材已在后台生成并安全写入。' : '项目已有可继续阅读的教材。',
          });
        }
      }
      setHistory(result.updatedHistory);
      if (approved) recordSequenceResult(result, approval.continuation.checkpoint?.sequenceExecution);
      else if (skillSequenceRef.current?.id === approval.continuation.checkpoint?.sequenceExecution?.sequenceId) {
        changeSkillSequence(updateAgentSequenceStep(skillSequenceRef.current, revise ? 'waiting-input' : 'paused', '本环节确认已取消，未执行后续环节。'));
      }
      setActiveSkillId(result.activeSkill?.id || '');
      setActiveSkillName(result.activeSkill?.name || '');
      const nextApproval = result.pendingApproval || null;
      setPendingApproval(nextApproval);
      if (nextApproval) {
        try {
          await savePendingAgentCheckpoint({ roleId: role.id, approval: nextApproval, history: result.updatedHistory });
          persistedApprovalIdsRef.current.add(nextApproval.id);
        } catch (checkpointError) {
          console.warn('[agent-checkpoint] persist continuation failed:', checkpointError);
          setResourceNotice('新的确认请求当前只保存在本次会话；关闭软件后将无法恢复。');
        }
      } else {
        persistedApprovalIdsRef.current.clear();
        try { await clearPendingAgentCheckpoint(role.id); }
        catch (checkpointError) { console.warn('[agent-checkpoint] clear after resolution failed:', checkpointError); }
      }
      const ownsSequence = skillSequenceRef.current?.id === approval.continuation.checkpoint?.sequenceExecution?.sequenceId;
      const handoff = ownsSequence ? null : buildPlanHandoff(result);
      if (handoff) onWorkflowHandoffChange(handoff);
      if (revise) {
        setInput('请修改刚才待确认的内容：');
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    } catch (cause) {
      setPendingApproval(null);
      persistedApprovalIdsRef.current.clear();
      try { await clearPendingAgentCheckpoint(role.id); }
      catch (checkpointError) { console.warn('[agent-checkpoint] clear failed resolution failed:', checkpointError); }
      const message = cause instanceof Error ? cause.message : String(cause);
      if (skillSequenceRef.current?.id === approval.continuation.checkpoint?.sequenceExecution?.sequenceId) {
        changeSkillSequence(updateAgentSequenceStep(skillSequenceRef.current, 'paused', '确认执行未完整结束，后续环节未执行，请先检查数据。'));
      }
      setError(controller.signal.aborted ? agentStopFeedback(observedSteps)
        : `${message}。本次确认不会自动重试，以避免重复写入；请检查数据后重新发起。`);
    } finally {
      releaseSlot?.(); setQueued(false);
      setActivity(null);
      setBusy(false);
      requestBusyRef.current = false;
      if (abortControllerRef.current === controller) abortControllerRef.current = null;
      setCancellable(false);
      setStopping(false);
    }
  };

  const acceptWorkflowAction = (action: AgentWorkflowAction) => {
    if (!workflowHandoff || busy || pendingApproval) return;
    if (action.destination === 'learning') {
      if (!workflowHandoff.scopeProjectId || !onContinueLearning?.(workflowHandoff.scopeProjectId)) return;
      void recordAgentHandoffAudit({ handoff: workflowHandoff, action, status: 'accepted' }).catch(() => {});
      onWorkflowHandoffChange(null); return;
    }
    const acceptedHandoff = workflowHandoff;
    recordAgentHandoffAudit({ handoff: acceptedHandoff, action, status: 'accepted' })
      .catch((auditError) => console.warn('[agent-handoff] audit acceptance failed:', auditError));
    onWorkflowHandoffChange(null);
    void sendText(action.prompt, { handoff: acceptedHandoff, action });
  };

  const dismissWorkflowHandoff = () => {
    if (!workflowHandoff) return;
    recordAgentHandoffAudit({ handoff: workflowHandoff, status: 'dismissed' })
      .catch((auditError) => console.warn('[agent-handoff] audit dismissal failed:', auditError));
    onWorkflowHandoffChange(null);
  };

  const clearConversation = async () => {
    if (busy || pendingApproval || requestBusyRef.current) return;
    if (!allowCognitionLeave(panelRef.current)) { setClearConfirmOpen(false); return; }
    requestBusyRef.current = true;
    clearingConversationRef.current = true;
    try {
      if (sequenceScopeRef.current) await persistAgentSequence(sequenceScopeRef.current, role.id, null);
      await clearAgentSession(role.id);
    } catch {
      requestBusyRef.current = false;
      clearingConversationRef.current = false;
      setResourceNotice('聊天或连续任务清理未能保存，未清空当前显示；请检查存储后重试。');
      return;
    }
    if (workflowHandoff) {
      recordAgentHandoffAudit({ handoff: workflowHandoff, status: 'dismissed' })
        .catch((auditError) => console.warn('[agent-handoff] audit clear failed:', auditError));
      onWorkflowHandoffChange(null);
    }
    setHistory([]);
    setPreviousHistory([]);
    skillSequenceRef.current = null;
    setSkillSequence(null);
    setInput('');
    setTrace([]);
    setError('');
    setFailedRequest(null);
    setResourceNotice('');
    setActiveSkillId('');
    setActiveSkillName('');
    setCopiedMessageIndex(null);
    setActivity(null);
    setShowJumpToLatest(false);
    setClearConfirmOpen(false);
    requestBusyRef.current = false;
    clearingConversationRef.current = false;
    stickToBottomRef.current = true;
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const copyMessage = async (content: string, index: number) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopiedMessageIndex(index);
      window.setTimeout(() => setCopiedMessageIndex((current) => current === index ? null : current), 1600);
    } catch {
      setError('复制失败，请选择文本后手动复制。');
    }
  };

  const prepareMessageAction = (kind: 'explain' | 'example' | 'save', content: string) => {
    let prompt: string;
    try { prompt = buildAgentMessageActionPrompt(kind, content); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return; }
    setInput(prompt);
    setError('');
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const openCitation = useCallback(async (citation: AgentCitation) => {
    setError('');
    if (citation.type === 'note') {
      const note = ctx.getNotes().find((item) => item.id === citation.entityId);
      if (!note || !ctx.openNoteByTitle(note.title)) setError(`引用的笔记“${citation.title}”已不存在或无法打开。`);
      return;
    }
    await documentCitation.read(citation.entityId, citation.chunkId, citation.sourceId);
  }, [documentCitation, ctx]);

  const downloadCandidate = async (resource: ResourceItem) => {
    if (!resource.candidateId || downloadingCandidateId) return;
    setError('');
    setResourceNotice('');
    setDownloadingCandidateId(resource.candidateId);
    try {
      const downloaded = await onDownloadResource(resource);
      if (downloaded) setResourceNotice(resource.indexable
        ? `“${resource.title}”已加入资料库，正在后台解析并建立索引。`
        : `“${resource.title}”已保存到资料库；当前格式暂不参与检索。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDownloadingCandidateId('');
    }
  };

  const scanCandidatePage = async (resource: ResourceItem) => {
    if (!resource.candidateId || browserActionCandidateId) return;
    setError('');
    setResourceNotice('');
    setBrowserActionCandidateId(resource.candidateId);
    try {
      const count = await onScanResourcePage(resource);
      setResourceNotice(`已扫描浏览器当前页，登记 ${count} 个安全候选。`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBrowserActionCandidateId('');
    }
  };

  const authorizeCandidate = async (resource: ResourceItem) => {
    if (!resource.candidateId || browserActionCandidateId) return;
    setError('');
    setResourceNotice('');
    setBrowserActionCandidateId(resource.candidateId);
    try {
      const opened = await onAuthorizeResource(resource);
      if (opened) setResourceNotice('隔离登录窗口已打开。完成登录并进入目标页面后，点击“扫描当前页”。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBrowserActionCandidateId('');
    }
  };

  const decideCandidate = async (resource: ResourceItem, decision: 'selected' | 'rejected') => {
    if (browserActionCandidateId) return;
    setError('');
    setBrowserActionCandidateId(resource.candidateId || resource.url);
    try {
      await onSetResourceCandidateDecision(resource, decision);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBrowserActionCandidateId('');
    }
  };

  const toggleExpanded = useCallback(() => {
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewport = currentViewport();
    const current = clampFloatingPanelBounds({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    }, viewport);
    if (!expanded) {
      normalPanelBoundsRef.current = current;
      setPanelBounds(centerFloatingPanel(viewport, Math.min(820, viewport.width - 16), Math.min(760, viewport.height - 16)));
      setExpanded(true);
      return;
    }
    const restored = clampFloatingPanelBounds(
      normalPanelBoundsRef.current || centerFloatingPanel(viewport, 390, 610),
      viewport,
    );
    normalPanelBoundsRef.current = null;
    setPanelBounds(restored);
    persistAgentPanelBounds(restored);
    setExpanded(false);
  }, [expanded]);

  const beginPanelInteraction = useCallback((
    event: React.PointerEvent<HTMLElement>,
    mode: 'drag' | 'resize',
    direction?: FloatingPanelResizeDirection,
  ) => {
    if (event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (mode === 'drag' && target.closest('button, a, input, textarea, select, [role="dialog"]')) return;
    const rect = panelRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    if (mode === 'resize') event.stopPropagation();
    interactionCleanupRef.current?.();

    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const viewport = currentViewport();
    const startBounds = clampFloatingPanelBounds({
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    }, viewport);
    let latestBounds = startBounds;
    let cleaned = false;
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = mode === 'drag' ? 'grabbing' : getComputedStyle(event.currentTarget).cursor;
    setPanelBounds(startBounds);
    setPanelInteracting(true);
    if (expanded) {
      normalPanelBoundsRef.current = null;
      setExpanded(false);
    }

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      moveEvent.preventDefault();
      const deltaX = moveEvent.clientX - startX;
      const deltaY = moveEvent.clientY - startY;
      latestBounds = mode === 'drag'
        ? moveFloatingPanel(startBounds, deltaX, deltaY, currentViewport())
        : resizeFloatingPanel(startBounds, direction || 'se', deltaX, deltaY, currentViewport());
      setPanelBounds(latestBounds);
    };
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', finishInteraction);
      window.removeEventListener('pointercancel', finishInteraction);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      if (interactionCleanupRef.current === cleanup) interactionCleanupRef.current = null;
    };
    const finishInteraction = (finishEvent: PointerEvent) => {
      if (finishEvent.pointerId !== pointerId) return;
      cleanup();
      setPanelInteracting(false);
      persistAgentPanelBounds(latestBounds);
    };
    interactionCleanupRef.current = cleanup;
    window.addEventListener('pointermove', handlePointerMove, { passive: false });
    window.addEventListener('pointerup', finishInteraction);
    window.addEventListener('pointercancel', finishInteraction);
  }, [expanded]);

  if (!open) return null;
  const visibleMessages = [...previousHistory, ...history].filter((message) => message.role !== 'tool' && !(message.role === 'assistant' && message.toolCalls?.length && !message.content))
    .map(message => ({ ...message, content: agentMessageDisplayContent(message) }));
  const canClearConversation = visibleMessages.length > 0 || trace.length > 0 || Boolean(error || resourceNotice || workflowHandoff);
  const starterPrompts = selectedProjectTitle
    ? [`分析“${selectedProjectTitle}”当前的学习进度`, `告诉我“${selectedProjectTitle}”下一步最值得做什么`, `检查“${selectedProjectTitle}”关联知识点的掌握情况`]
    : ['总结我最近的学习状态', '找出我当前掌握较弱的知识点', '告诉我今天最适合完成的学习任务'];
  const panelStyle: React.CSSProperties | undefined = panelBounds ? {
    left: panelBounds.left,
    top: panelBounds.top,
    width: panelBounds.width,
    height: panelBounds.height,
    right: 'auto',
    bottom: 'auto',
  } : undefined;
  const portfolioDraftRoots = planDraftSession?.scopeKind === 'portfolio'
    ? Object.values(planDraftSession.portfolioRoots || {})
    : [];

  return (
    <aside ref={panelRef} style={panelStyle} className={`agent-panel${conversationChrome ? ' has-conversations' : ''}${expanded ? ' is-expanded' : ''}${panelInteracting ? ' is-interacting' : ''}`} aria-label="学习助手"
      {...(ctx.getConversationId ? { id: `agent-conversation-${ctx.getConversationId()}`, role: 'tabpanel', 'aria-labelledby': `agent-tab-${ctx.getConversationId()}` } : {})}>
      {AGENT_PANEL_RESIZE_DIRECTIONS.map((direction) => (
        <span
          key={direction}
          className={`agent-panel-resize-handle is-${direction}`}
          onPointerDown={(event) => beginPanelInteraction(event, 'resize', direction)}
          aria-hidden="true"
        />
      ))}
      <header className="agent-panel-head" onPointerDown={(event) => beginPanelInteraction(event, 'drag')} title="拖动标题栏移动窗口">
        <div className="agent-panel-title"><Bot aria-hidden="true" /><span><strong>{role.name}</strong><small>{activeSkillName ? `当前 Skill：${activeSkillName}` : '学习数据、计划与页面操作'}</small></span><GripHorizontal className="agent-panel-drag-indicator" aria-hidden="true" /></div>
        <div className="agent-panel-head-actions">
          {!auditOpen && <button type="button" onClick={() => { if (allowCognitionLeave(panelRef.current)) setAuditOpen(true); }} aria-label="查看本地运行审计" title="运行记录"><BarChart3 aria-hidden="true" /></button>}
          {!auditOpen && <button type="button" onClick={toggleExpanded} aria-label={expanded ? '恢复上次大小' : '进入宽屏阅读'} aria-pressed={expanded} title={expanded ? '恢复上次大小' : '宽屏阅读'}>{expanded ? <Minimize2 aria-hidden="true" /> : <Maximize2 aria-hidden="true" />}</button>}
          {!auditOpen && <button type="button" onClick={() => setClearConfirmOpen((current) => !current)} disabled={!canClearConversation || busy || Boolean(pendingApproval)} aria-label="清空当前聊天记录" aria-expanded={clearConfirmOpen} title={pendingApproval ? '请先处理当前确认请求' : '清空当前聊天'}><Trash2 aria-hidden="true" /></button>}
          <button type="button" onClick={() => { if (allowCognitionLeave(panelRef.current)) onClose(); }} aria-label="关闭学习助手"><X aria-hidden="true" /></button>
        </div>
      </header>
      {conversationChrome}
      <AgentClearConfirmation open={open && clearConfirmOpen && !auditOpen}
        disabled={busy || Boolean(pendingApproval)} onCancel={() => setClearConfirmOpen(false)} onConfirm={clearConversation} />
      {auditOpen ? <AgentAuditView onBack={() => setAuditOpen(false)} onUseAcceptancePrompt={useAcceptancePrompt} /> : <>
      <section className={`agent-plan-scope${planDraftSession ? ' is-locked' : ''}`} aria-label="计划修改范围">
        <LockKeyhole aria-hidden="true" />
        <div>
          <strong>{planDraftSession ? `${planDraftSession.purpose === 'study-tasks' ? '学习任务' : planDraftSession.purpose === 'plan-layout' ? '计划编排' : '计划结构'}草案范围已锁定` : '当前可选范围'}</strong>
          <span>{planDraftSession?.scopeProjectTitle || selectedProjectTitle || '请先在侧栏选中一个项目板块'}</span>
          {planDraftSession && (
            <>
              <small>
                {portfolioDraftRoots.length > 0 ? `已锁定 ${portfolioDraftRoots.length} 个根计划，${portfolioDraftRoots.reduce((sum, root) => sum + (root.structurePatches?.length || 0), 0)} 个结构时间变更，` : `已暂存 ${planDraftSession.structurePatches.length} 个结构补丁，${planDraftSession.projects.length} 个末级项目，${planDraftSession.projects.reduce((sum, project) => sum + project.tasks.length, 0)} 条正文任务，`}
                {portfolioDraftRoots.filter((root) => root.planMetaPatch).length} 个计划设置变更，
                {planDraftSession.milestonePatches?.length || 0} 个里程碑变更，
                {planDraftSession.executionPatches?.length || 0} 个执行事项变更
              </small>
              <details className="agent-plan-draft-preview">
                <summary>查看完整草案</summary>
                {portfolioDraftRoots.map((root) => (
                  <div className="agent-portfolio-draft-root" key={root.rootProjectId}>
                    <strong>{root.rootProjectTitle}</strong>
                    <small>{root.planMetaPatch ? `计划设置：${planMetaPatchText(root.planMetaPatch)}` : '计划设置未变更'}</small>
                    {(root.structurePatches || []).map((patch, index) => <p key={`portfolio-structure-${root.rootProjectId}-${index}`}>结构时间：{structurePatchText(patch)}</p>)}
                    {root.milestonePatches.map((patch, index) => <p key={`portfolio-milestone-${root.rootProjectId}-${index}`}>里程碑：{milestonePatchText(patch)}</p>)}
                    {root.executionPatches.map((patch, index) => <p key={`portfolio-execution-${root.rootProjectId}-${index}`}>执行事项：{executionPatchText(patch)}</p>)}
                    {!root.planMetaPatch && (root.structurePatches?.length || 0) === 0 && root.milestonePatches.length === 0 && root.executionPatches.length === 0 && <p>暂无修改</p>}
                  </div>
                ))}
                {portfolioDraftRoots.length === 0 && planDraftSession.structurePatches.map((patch, index) => (
                  <div key={`patch-${index}`}>
                    <strong>结构变更 {index + 1}</strong>
                    <p>{structurePatchText(patch)}</p>
                  </div>
                ))}
                {portfolioDraftRoots.length === 0 && planDraftSession.projects.map((project) => (
                  <div key={project.projectTitle}>
                    <strong>{project.projectTitle}</strong>
                    <ul>{project.tasks.map((task) => <li key={task}>{task}</li>)}</ul>
                  </div>
                ))}
                {portfolioDraftRoots.length === 0 && planDraftSession.planMetaPatch && <p>计划设置：{Object.keys(planDraftSession.planMetaPatch).join('、')}</p>}
                {portfolioDraftRoots.length === 0 && (planDraftSession.milestonePatches || []).map((patch, index) => (
                  <p key={`milestone-${index}`}>里程碑：{patch.operation} · {patch.title || patch.milestoneId}</p>
                ))}
                {portfolioDraftRoots.length === 0 && (planDraftSession.executionPatches || []).map((patch, index) => (
                  <p key={`execution-${index}`}>执行事项：{patch.operation} · {patch.taskText || patch.taskId}</p>
                ))}
                {planDraftSession.createKnowledgeNotes.length > 0 && (
                  <p>待创建知识点：{planDraftSession.createKnowledgeNotes.join('、')}</p>
                )}
              </details>
            </>
          )}
        </div>
        {planDraftSession && !busy && !pendingApproval && (
          <button type="button" onClick={onDiscardPlanDraft}>放弃</button>
        )}
        {conversationScopeAction}
      </section>
      {resourceDraftSession && (
        <section className="agent-plan-scope is-locked" aria-label="学习资源草案范围">
          <LockKeyhole aria-hidden="true" />
          <div>
            <strong>资源草案范围已锁定</strong>
            <span>{resourceDraftSession.scopeProjectTitle}</span>
            <small>
              已搜索发现 {resourceDraftSession.discoveredResources.length} 个资源，
              已选 {resourceDraftSession.selectedResourceUrls.length} 个、排除 {resourceDraftSession.rejectedResourceUrls.length} 个，
              暂存 {resourceDraftSession.projects.length} 个末级项目、
              {resourceDraftSession.projects.reduce((sum, project) => sum + project.resources.length, 0)} 个新增/更新、
              {resourceDraftSession.projects.reduce((sum, project) => sum + (project.removeResourceUrls?.length || 0), 0)} 个移除
            </small>
            {resourceDraftSession.discoveredResources.length > 0 && (
              <details className="agent-resource-candidates">
                <summary>查看搜索候选与操作（浏览器内也可右键选择）</summary>
                {resourceDraftSession.discoveredResources.map((resource) => {
                  const candidateUrl = comparableResourceUrl(resource.url);
                  const selected = resourceDraftSession.selectedResourceUrls.some((url) => comparableResourceUrl(url) === candidateUrl);
                  const rejected = resourceDraftSession.rejectedResourceUrls.some((url) => comparableResourceUrl(url) === candidateUrl);
                  return (
                  <div className={`agent-resource-candidate${selected ? ' is-selected' : ''}${rejected ? ' is-rejected' : ''}`} key={resource.candidateId || resource.url}>
                    <span>
                      <strong>{resource.title}</strong>
                      <small>
                        {RESOURCE_TYPE_LABELS[resource.resourceType || 'webpage']} · {resource.platform || resource.url}
                        {resource.authContainerId ? ' · 隔离登录容器' : ''}
                        {resource.accessType === 'authenticated' && !resource.authContainerId ? ' · 可能需要登录' : resource.isFree ? ' · 已确认开放访问' : ' · 免费性待人工确认'}
                        {resourceSizeLabel(resource.contentLength) ? ` · ${resourceSizeLabel(resource.contentLength)}` : ''}
                        {resource.downloadable
                          ? resource.indexable ? ' · 可下载并索引' : ' · 可保存到资料库，暂不索引'
                          : resource.isAttachment ? ' · 可在线查看，暂不支持保存' : ' · 可在线打开'}
                      </small>
                      {resource.description && <small title={resource.description}>{resource.description}</small>}
                    </span>
                    <div>
                      <button
                        type="button"
                        onClick={() => void decideCandidate(resource, 'selected')}
                        disabled={Boolean(browserActionCandidateId) || selected}
                        aria-pressed={selected}
                        title="显式加入本次资源备选，并记录你的选择偏好"
                      >
                        <CheckCircle2 aria-hidden="true" />{selected ? '已加入' : '加入备选'}
                      </button>
                      <button
                        type="button"
                        onClick={() => void decideCandidate(resource, 'rejected')}
                        disabled={Boolean(browserActionCandidateId) || rejected}
                        aria-pressed={rejected}
                        title="从本次整理中排除，并记录你明确表达的不感兴趣"
                      >
                        <ThumbsDown aria-hidden="true" />{rejected ? '已排除' : '不感兴趣'}
                      </button>
                      <button type="button" onClick={() => onOpenResource(resource)} title="在心流模式打开">
                        <ExternalLink aria-hidden="true" />心流打开
                      </button>
                      {resource.browserSessionId && (
                        <button
                          type="button"
                          onClick={() => void scanCandidatePage(resource)}
                          disabled={Boolean(browserActionCandidateId)}
                          title="扫描隔离浏览器当前显示页面中的资源链接"
                        >
                          <ScanSearch aria-hidden="true" />
                          {browserActionCandidateId === resource.candidateId ? '处理中' : '扫描当前页'}
                        </button>
                      )}
                      {resource.accessType === 'authenticated' && !resource.authContainerId && (
                        <button
                          type="button"
                          onClick={() => void authorizeCandidate(resource)}
                          disabled={Boolean(browserActionCandidateId)}
                          title="经确认后为该网站创建独立的持久登录容器"
                        >
                          <LogIn aria-hidden="true" />授权登录
                        </button>
                      )}
                      {resource.downloadable && resource.candidateId && (
                        <button
                          type="button"
                          onClick={() => void downloadCandidate(resource)}
                          disabled={Boolean(downloadingCandidateId)}
                          title={resource.indexable ? '确认后下载、解析并加入本地资料库' : '确认后保存到本地资料库'}
                        >
                          <Download aria-hidden="true" />
                          {downloadingCandidateId === resource.candidateId ? '下载中' : resource.indexable ? '下载并索引' : '保存到资料库'}
                        </button>
                      )}
                    </div>
                  </div>
                  );
                })}
              </details>
            )}
            {resourceDraftSession.selectedResourceUrls.length > 0 && (
              <button
                type="button"
                className="agent-resource-organize"
                onClick={() => useAcceptancePrompt('请优先整理我已加入备选的资源，排除“不感兴趣”的候选；说明每项与任务、知识点和当前学习阶段的匹配理由，先更新资源草案，不要直接提交。')}
              >
                让助手整理已选资源
              </button>
            )}
            <details className="agent-plan-draft-preview">
              <summary>查看完整资源草案</summary>
              {resourceDraftSession.projects.map((project) => (
                <div key={project.projectTitle}>
                  <strong>{project.projectTitle}</strong>
                  <ul>{project.resources.map((resource) => (
                    <li key={`${resource.taskText}-${resource.url}`}>
                      {resource.title} — {resource.taskText}（{resource.knowledgeTitles.join('、')}）
                    </li>
                  ))}</ul>
                  {(project.removeResourceUrls?.length || 0) > 0 && (
                    <ul>{project.removeResourceUrls?.map((url) => <li key={`remove-${url}`}>移除：{url}</li>)}</ul>
                  )}
                </div>
              ))}
            </details>
          </div>
          {!busy && !pendingApproval && (
            <button type="button" onClick={onDiscardResourceDraft}>放弃</button>
          )}
        </section>
      )}
      <div
        className="agent-panel-messages"
        ref={listRef}
        onScroll={(event) => {
          const target = event.currentTarget;
          const nearBottom = target.scrollHeight - target.scrollTop - target.clientHeight < 56;
          stickToBottomRef.current = nearBottom;
          if (nearBottom) setShowJumpToLatest(false);
        }}
      >
        {skillSequence && (
          <section className="agent-handoff" aria-label="连续任务状态">
            <div className="agent-handoff-head">
              <GitBranch aria-hidden="true" />
              <span><strong>连续任务</strong><small aria-live="polite">{skillSequence.notice || '按用户要求依次执行，写入前仍需确认。'}</small></span>
              <button type="button" aria-label="取消连续任务后续环节" disabled={busy} onClick={() => changeSkillSequence(updateAgentSequenceStep(skillSequence, 'cancelled', '已取消后续自动执行，已完成结果保留。'))}><X aria-hidden="true" /></button>
            </div>
            <ol>
              {skillSequence.steps.map((step, index) => <li key={step.skillId} aria-current={currentAgentSequenceStep(skillSequence)?.index === index ? 'step' : undefined}>
                {AGENT_SEQUENCE_LABELS[step.skillId]} · {{ ready: '待执行', running: '处理中', 'waiting-input': '待补充', 'waiting-approval': '待确认', 'waiting-editor': '待编辑器确认', 'waiting-workbench': '待资源筛选', paused: '已暂停', complete: '已完成', cancelled: '已取消' }[step.status]}
              </li>)}
            </ol>
            {currentAgentSequenceStep(skillSequence)?.status === 'paused' && !failedRequest && <div className="agent-handoff-actions"><button type="button" disabled={busy || Boolean(pendingApproval)} onClick={resumeSequence}><ArrowRight aria-hidden="true" />继续当前环节</button></div>}
          </section>
        )}
        {workflowHandoff && (
          <section className="agent-handoff" aria-label="建议的下一步">
            <div className="agent-handoff-head">
              <GitBranch aria-hidden="true" />
              <span><strong>建议的下一步</strong><small>{workflowHandoff.outcome}</small></span>
              <button type="button" onClick={dismissWorkflowHandoff} aria-label="忽略本次建议"><X aria-hidden="true" /></button>
            </div>
            {workflowHandoff.scopeProjectTitle && <div className="agent-handoff-scope">范围：{workflowHandoff.scopeProjectTitle}</div>}
            <div className="agent-handoff-actions">
              {workflowHandoff.actions.map((item) => (
                <button
                  type="button"
                  key={`${workflowHandoff.id}-${item.id}`}
                  onClick={() => acceptWorkflowAction(item)}
                  disabled={busy || Boolean(pendingApproval)}
                >
                  <span><strong>{item.label}</strong><small>{item.description}</small></span>
                  <ArrowRight aria-hidden="true" />
                </button>
              ))}
            </div>
            <p>点击后才会把这一步交给对应 Skill；不会自动修改数据。</p>
          </section>
        )}
        {visibleMessages.length === 0 && !workflowHandoff && (
          <div className="agent-panel-empty">
            <Bot aria-hidden="true" />
            <strong>我可以帮你查看学习状态和使用软件</strong>
            <span>选择一个起步问题，或直接描述你现在想完成的事。</span>
            <div className="agent-starter-prompts">
              {starterPrompts.map((prompt) => (
                <button type="button" key={prompt} onClick={() => {
                  setInput(prompt);
                  requestAnimationFrame(() => inputRef.current?.focus());
                }}>{prompt}</button>
              ))}
            </div>
          </div>
        )}
        {visibleMessages.map((message, index) => (
          <div className={`agent-message-shell is-${message.role}`} key={`${message.role}-${index}`}>
            <div className={`agent-message is-${message.role}`}>
              <AgentRichMessage message={message} onOpenCitation={openCitation} />
            </div>
            <div className="agent-message-meta">
              <span>{message.role === 'assistant' ? role.name : '你'}</span>
              <button type="button" onClick={() => void copyMessage(message.content, index)} aria-label="复制这条消息" title="复制">
                {copiedMessageIndex === index ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                {copiedMessageIndex === index ? '已复制' : '复制'}
              </button>
              {message.role === 'assistant' && (
                <div className="agent-message-followups" aria-label="基于本回答继续">
                  <button type="button" onClick={() => prepareMessageAction('explain', message.content)} disabled={busy || Boolean(pendingApproval)}>解释</button>
                  <button type="button" onClick={() => prepareMessageAction('example', message.content)} disabled={busy || Boolean(pendingApproval)}>举例</button>
                  <button type="button" onClick={() => prepareMessageAction('save', message.content)} disabled={busy || Boolean(pendingApproval)}>存为知识点</button>
                </div>
              )}
            </div>
          </div>
        ))}
        {pendingApproval && (
          <section className="agent-approval" aria-label="敏感操作确认">
            <div className="agent-approval-title"><ShieldCheck aria-hidden="true" /><strong>需要你的确认</strong></div>
            {pendingApproval.items.map((item) => (
              <div className="agent-approval-item" key={item.call.id}>
                <strong>{item.title}</strong>
                <span>{item.description}</span>
                {item.impacts?.length ? <ul>{item.impacts.map((impact) => <li key={impact}>{impact}</li>)}</ul> : null}
                {item.call.name === 'create_knowledge_note' && (
                  <div className="agent-knowledge-draft-preview" aria-label="知识点笔记草案预览">
                    <strong>{String(item.call.arguments.title || '未命名知识点')}</strong>
                    <pre>{String(item.call.arguments.content || '')}</pre>
                    {Array.isArray(item.call.arguments.tags) && item.call.arguments.tags.length > 0 && (
                      <small>标签：{item.call.arguments.tags.map(String).join('、')}</small>
                    )}
                  </div>
                )}
                <details><summary>查看提交参数</summary><pre>{JSON.stringify(item.call.arguments, null, 2)}</pre></details>
              </div>
            ))}
            <div className="agent-approval-actions">
              <button type="button" className="is-cancel" onClick={() => void answerApproval(false)}>取消</button>
              <button type="button" onClick={() => void answerApproval(false, true)}>修改要求</button>
              <button type="button" className="is-confirm" onClick={() => void answerApproval(true)}>确认执行</button>
            </div>
          </section>
        )}
        {textbookProgress && <TextbookProgressCard progress={textbookProgress} restoreError={textbookProgressError} disabled={!checkpointReady || busy || Boolean(pendingApproval)}
          onResume={(jobId) => void sendText(`请从检查点继续教材任务 ${jobId}，使用同一任务请求确认，不重新准备新任务。`, undefined, undefined, 'personalized-textbook', undefined, false, undefined, undefined, jobId)} />}
        {busy && !textbookProgress?.running && (
          <div className="agent-activity" role="status" aria-live="polite">
            <Bot aria-hidden="true" />
            <span>
              <strong>{activity ? agentActivityLabel(activity.phase, activity.toolName) : '正在开始处理'}</strong>
              <small>{stopping ? '正在停止后续步骤，已开始的保存会安全收尾' : queued ? '等待执行空位，可切换标签；停止仅取消本标签的排队' : trace.length > 0 ? agentTraceSummary(trace) : '你可以继续浏览上方内容'}</small>
            </span>
            <span className="agent-thinking-dots" aria-hidden="true"><i /><i /><i /></span>
          </div>
        )}
        {error && (
          <div className="agent-panel-error" role="alert">
            <span>{error}</span>
            <div>
              {failedRequest && <button type="button" onClick={() => void sendText(failedRequest.text, undefined, failedRequest.baseHistory, failedRequest.requestedSkillId, failedRequest.recovery, false, failedRequest.observedOutcome, failedRequest.sequenceExecution)} disabled={busy}><RotateCcw aria-hidden="true" />{failedRequest.recovery ? '继续未完成步骤' : '重试'}</button>}
              <button type="button" onClick={() => { setError(''); setFailedRequest(null); }}>关闭</button>
            </div>
          </div>
        )}
        {resourceNotice && <div className="agent-resource-notice" role="status" aria-live="polite">{resourceNotice}</div>}
        {!documentCitation.preview && documentCitation.operation === 'read' && <div role="status" className="agent-resource-notice">正在读取引用资料…</div>}
        {!documentCitation.preview && documentCitation.error && <div role="alert" className="agent-panel-error"><span>{documentCitation.error}</span></div>}
        {showJumpToLatest && <button type="button" className="agent-jump-latest" onClick={() => scrollToLatest()}><ChevronDown aria-hidden="true" />查看最新消息</button>}
      </div>
      {trace.length > 0 && (
        <details className="agent-tool-trace">
          <summary><Wrench aria-hidden="true" />{agentTraceSummary(trace)}</summary>
          <ul>{trace.map((step, index) => (
            <li key={`${step.call.id}-${index}`} className={step.ok ? '' : 'is-error'} title={step.call.name}>
              {step.ok ? <CheckCircle2 aria-hidden="true" /> : <X aria-hidden="true" />}
              <span><strong>{agentToolLabel(step.call.name)}</strong>{step.reused && <small>沿用已完成结果，未重复执行</small>}{step.error && <small>{step.error}</small>}</span>
            </li>
          ))}</ul>
        </details>
      )}
      <ConceptBatchProgress />
      <BackgroundWorkflowProgress resumeDisabled={busy || Boolean(pendingApproval) || !checkpointReady} onResume={id => { void sendText(`请仅续办原组合任务 ${id}，重新出示整批确认卡，不另建任务或扩大范围。`, undefined, undefined, undefined, undefined, false, undefined, undefined, undefined, id); }} />
      <div className="agent-panel-input">
        <div className="agent-composer-body">
          {pendingInputReplacement !== null && <AgentPromptReplacement prompt={pendingInputReplacement} busy={busy || Boolean(pendingApproval)} onKeep={() => { setPendingInputReplacement(null); requestAnimationFrame(() => inputRef.current?.focus()); }} onReplace={replacePendingInput} />}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
            }}
            placeholder={pendingApproval ? '请先处理上方的确认请求' : '询问学习状态或让助手打开功能…'}
            rows={1}
            disabled={!checkpointReady || busy || Boolean(pendingApproval)}
            aria-describedby="agent-composer-hint"
            aria-label="发送给学习助手的消息"
          />
          <div className="agent-composer-meta" id="agent-composer-hint">
            <span>Enter 发送 · Shift+Enter 换行</span>
            {input.length >= 500 && <span>{input.length} 字</span>}
          </div>
        </div>
        {busy && cancellable ? (
          <button type="button" className="is-stop" onClick={stopCurrentRequest} disabled={stopping} aria-label="停止本次生成" title="停止本次生成"><Square aria-hidden="true" /></button>
        ) : (
          <button type="button" onClick={() => void send()} disabled={!checkpointReady || busy || Boolean(pendingApproval) || !input.trim()} aria-label="发送"><Send aria-hidden="true" /></button>
        )}
      </div>
      </>}
      {documentCitation.preview && (
        <DocumentPreviewDialog
          preview={documentCitation.preview}
          onClose={documentCitation.close}
          onOpen={() => void documentCitation.open()}
          onReindex={() => void documentCitation.reindex()}
          busy={documentCitation.operation !== null}
          error={documentCitation.error}
          notice={documentCitation.notice}
          backgroundInert={documentCitation.confirmBody}
        />
      )}
      {documentCitation.preview&&documentCitation.confirmBody&&<DocumentConfirmationDialog confirmation={{kind:'body',document:documentCitation.preview.document}}
        busy={documentCitation.operation!==null} error={documentCitation.error} onClose={documentCitation.cancelReindex} onConfirm={()=>void documentCitation.confirmReindex()}/>}
    </aside>
  );
};
