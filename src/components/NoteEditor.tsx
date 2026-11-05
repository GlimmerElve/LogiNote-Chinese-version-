import React, { Suspense, lazy, useState, useEffect, useRef, useId } from "react";
import { getNoteEditorContext } from '../services/ui/noteEditorContext';
import { RESOURCE_CATEGORY_LABELS } from '../services/resourceCuration';
import { noteRenameError } from '../services/noteRename';
import { registerPendingCapture } from '../services/agent/dataFreshness';
import { registerEditorInputLeave } from '../services/ui/editorInputLeave';
import { NOTE_AUTOSAVE_IDLE_MS } from '../services/ui/noteAutosave';
import { communityWebsiteUrl } from '../services/community/availability';
import { createNoteEditorMetadataDraft, reconcileNoteEditorMetadataDraft, recordNoteEditorMetadataDraft,
  applyNoteEditorMetadataDraft, sameEditorMetadataList } from '../services/ui/noteEditorMetadataDraft';
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { NoteItem, VaultSettings, AnalysisResult, ResourceItem } from "../types";
import { callLLM } from "../services/llmService";
import {
  Link2,
  Sparkles,
  Zap,
  Tag,
  AlertTriangle,
  Loader2,
  Globe,
  X,
  ExternalLink,
  RefreshCw,
  BookOpen,
  Trash2,
  Edit3,
  ArrowUpRight,
  Plus,
  Sigma,
  ListChecks,
  MoreHorizontal,
  FolderOpen,
  Check,
  GitBranch,
  PanelRightClose,
  PanelRightOpen,
  Clock3,
  CalendarDays,
  FileText,
  Info,
  CircleHelp,
  ChevronDown,
} from "lucide-react";
import type { MdxNoteEditorHandle } from './noteEditorHandle';
import { TextbookReader } from './textbook/TextbookReader';
import { ProgressiveSavedNotice } from './progressive/ProgressiveSavedNotice';
import { hasCompleteLegacyTextbook } from '../services/progressiveLearning/eligibility';
import { LearningPreparationPanel } from './progressive/LearningPreparationPanel';
import { PlainNoteReading } from './textbook/PlainNoteReading';
import { LONG_READING_THRESHOLD } from '../services/textbook/readingDocument';
import { needsBackgroundTextbookReading } from '../services/textbook/readingBudget';
import { useSettledNoteDocument } from './useSettledNoteDocument';
import { appendProjectKnowledgeRows, pendingProjectKnowledgeRows, type ProjectKnowledgeRow } from '../services/progressiveLearning/knowledgeProjection';
import { KnowledgeMasteryStatus } from './KnowledgeMasteryStatus';
import { QuickCheckButton } from './quickCheck';
import type { TextbookReadingPosition, TextbookReadingGetter } from '../services/textbook/readingState';
import type { LearningReviewPatch } from '../services/textbook/types';
import { patchLearningReviewRecord } from '../services/textbook/reviewRecordStore';
import { ArgumentDocEmbed } from "../modules/argumentCanvas/components/ArgumentDocEmbed";
import type { ArgDoc } from "../services/argumentDoc/types";
import { basename, pathToFileUrl, detectLocalFileType } from "../services/localResource";
import { openDocument } from "../services/documentRagClient";
import { KnowledgePreview } from "./KnowledgePreview";
import type { NoteSaveState } from '../services/ui/saveFeedback';
import { NoteReferenceIndexStatus } from './NoteReferenceIndexStatus';
import { ReferenceArgumentStatus } from './ReferenceArgumentStatus';
import { createPortal } from "react-dom";
import { hasActiveDialog, useDialog } from './useDialog';
import { allowCognitionLeave } from '../services/ui/cognitionLeave';
import { resolveNoteByTitleOrAlias, resolveNoteReference, ambiguousNoteReferenceMessage, noteAliasesError, parseWikiLink, parseWikiLinkTarget, matchesTitleOrAlias } from "../services/noteResolver";
import { scrollToNoteHeading, type NoteHeadingRequest } from '../services/ui/noteHeadingNavigation';
import { autoLinkMarkdown } from '../services/markdownAutoLink';
import { isLeafProjectNote } from "../services/knowledgePointSelector";
import { LearningCompletionCard } from './LearningCompletionCard';
import { getProjectCompletionTarget, type LearningCompletionTarget } from '../services/learningCompletion';
import { getScheduledProjectChildren, getScheduledProjectDeadline, getScheduledProjectState } from '../services/planProjectState';
import { prepareLogicCheckSource, readTextbookBody } from '../services/textbook/noteContent';
import {
  checkResourceHealth,
  getResourceStateSnapshot,
  loadResourceState,
  normalizeResourceUrl,
  storeResourceHealth,
  type ResourceHealthStatus,
  type ResourceStateFile,
} from "../services/resourceState";

const RESOURCE_HEALTH_LABELS: Record<ResourceHealthStatus, string> = {
  unchecked: '未检查',
  available: '可访问',
  redirected: '已跳转',
  restricted: '访问受限',
  broken: '链接失效',
  'temporary-error': '暂时无法确认',
};

const MdxNoteEditor = lazy(() => import('./MdxNoteEditor').then(module => ({ default: module.MdxNoteEditor })));
const LongNoteSourceEditor = lazy(() => import('./LongNoteSourceEditor').then(module => ({ default: module.LongNoteSourceEditor })));

interface NoteEditorProps {
  /** Hidden reference branches keep their drafts, but must not own dialogs or focus. */
  isActive?: boolean;
  /** A floating dialog takes keyboard ownership without hiding the document. */
  isVisible?: boolean;
  saveState?: NoteSaveState;
  onRetrySave?: () => void;
  onContinueProgressive?: (noteId: string) => void;
  onSetLearningCompletion?: (target: LearningCompletionTarget, completed: boolean) => Promise<void>;
  hideLearningCompletionControl?: boolean;
  note: NoteItem | null;
  allNotes: NoteItem[];
  onUpdateNote: (updated: NoteItem) => void;
  onEditNote?: (noteId: string, patch: Partial<Pick<NoteItem, 'content' | 'title' | 'tags' | 'aliases'>>) => void;
  onFinishEditing?: () => void;
  onSelectNoteByTitle: (title: string, projectContextId?: string) => void;
  /** 已解析的笔记按身份打开，不再按可能重复或已变更的标题查找。 */
  onOpenNote?: (noteId: string, projectContextId?: string, heading?: string) => void;
  headingRequest?: NoteHeadingRequest;
  /** 从项目笔记进入知识点时，保留根项目的汇总视图上下文 */
  projectContextId?: string | null;
  onOpenConceptFill?: (note: NoteItem) => void;
  /** 论证图块 `<ArgumentBlock id="..."/>` 点击回调 */
  onArgumentBlockEdit?: (docId: string) => void;
  /** 论证图块删除回调 */
  onArgumentBlockDelete?: (docId: string) => void;
  /** 撤回已发布 RAG 快照，但保留结构图草稿。 */
  onArgumentRagWithdraw?: (docId: string) => void;
  /** 论证图块数据解析器（用于正文内嵌只读结构图） */
  getArgumentDoc?: (docId: string) => ArgDoc | undefined;
  onLearningReviewPatch?: (noteId: string, id: string, patch: LearningReviewPatch) => void | Promise<void>;
  onTextbookReadingPosition?: (noteId: string, revisionId: string, position: TextbookReadingPosition) => void;
  getTextbookReadingPosition?: TextbookReadingGetter;
  settings: VaultSettings;
  onRecommendProjectResources?: (note: NoteItem) => Promise<{
    mode: 'review' | 'auto';
    status: 'workbench-opened' | 'written' | 'no-match';
    message: string;
    resources: ResourceItem[];
  }>;
  /** 内容版本号，外部（如 AI 分词应用）更新后自增，用于强制刷新编辑器 */
  contentVersion?: number;
}

export const NoteEditor: React.FC<NoteEditorProps> = ({
  note,
  allNotes,
  onUpdateNote: onCommitNote,
  onEditNote,
  onFinishEditing,
  onSelectNoteByTitle,
  onOpenNote,
  headingRequest: incomingHeadingRequest,
  projectContextId,
  onOpenConceptFill,
  onArgumentBlockEdit,
  onArgumentBlockDelete,
  onArgumentRagWithdraw,
  getArgumentDoc,
  onLearningReviewPatch,
  onTextbookReadingPosition,
  getTextbookReadingPosition,
  settings,
  onRecommendProjectResources,
  contentVersion,
  saveState, onRetrySave, onContinueProgressive,
  onSetLearningCompletion,
  hideLearningCompletionControl = false,
  isActive = true,
  isVisible = isActive,
}) => {
  const isActiveRef = useRef(isActive);
  isActiveRef.current = isActive;
  const [content, setContent] = useState(note?.content ?? "");
  const [textbookExportBusy, setTextbookExportBusy] = useState(false);
  const legacyTextbookComplete = React.useMemo(() => note ? hasCompleteLegacyTextbook(note) : false,
    [note?.id, note?.content, note?.textbook?.revisionId, note?.textbook?.regionId]);
  const [progressiveAvailableFor, setProgressiveAvailableFor] = useState<string | null>(null);
  const hasProgressiveCourse = progressiveAvailableFor === note?.id && !legacyTextbookComplete;
  const onProgressiveAvailable = React.useCallback((available: boolean) => setProgressiveAvailableFor(available ? note?.id || null : null), [note?.id]);
  const heavyDocument = React.useMemo(() => needsBackgroundTextbookReading(note?.content || '', LONG_READING_THRESHOLD), [note?.content]);
  const supportsReading = hasProgressiveCourse || Boolean(note?.textbook) || heavyDocument;
  const documentReady = useSettledNoteDocument(note?.id, isVisible);
  const [readTextbook, setReadTextbook] = useState(supportsReading);
  // Reading a book must not also import its entire document into a hidden
  // Lexical editor. Once opened, keep that editor mounted to preserve history,
  // caret and IME state across reading/editing toggles.
  const [editorLoadedForId, setEditorLoadedForId] = useState<string | undefined>(supportsReading ? undefined : note?.id);
  const sourcePreferenceRef = useRef({ noteId: note?.id, enabled: heavyDocument });
  if (sourcePreferenceRef.current.noteId !== note?.id) {
    sourcePreferenceRef.current = { noteId: note?.id, enabled: heavyDocument };
  }
  const prefersSourceEditor = sourcePreferenceRef.current.enabled;
  const [longEditMode, setLongEditMode] = useState<'source' | 'rich'>('source');
  const [sourceLoadedForId, setSourceLoadedForId] = useState<string | undefined>();
  const [documentOwner, setDocumentOwner] = useState(note?.id);
  // Reset before children render. An Effect was one commit too late: switching
  // from a textbook to an empty project imported the OLD book into a new MDX
  // editor, then imported the actual new body again.
  if (documentOwner !== note?.id) {
    setDocumentOwner(note?.id);
    setContent(note?.content || '');
    setReadTextbook(supportsReading);
    setEditorLoadedForId(supportsReading ? undefined : note?.id);
    setSourceLoadedForId(undefined);
    setLongEditMode('source');
  }
  const [title, setTitle] = useState(note?.title ?? "");
  const titleInputRef = useRef<HTMLInputElement>(null);
  const titleDraftRef = useRef({ noteId: note?.id ?? null, baseline: note?.title ?? '', value: note?.title ?? '' });
  const titleComposingRef = useRef(false);
  const titleSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitTitleRef = useRef<() => void>(() => {});
  const [tagsText, setTagsText] = useState((note?.tags || []).join(", "));
  const [aliasesText, setAliasesText] = useState((note?.aliases || []).join(", "));
  const [aliasesError, setAliasesError] = useState<string | null>(null);
  const invalidAliasesDraftRef = useRef<string | null>(null);
  const aliasesErrorId = useId();

  const [showAddLinkModal, setShowAddLinkModal] = useState(false);
  const addLinkDialogRef = useRef<HTMLDivElement>(null);
  const linkSearchRef = useRef<HTMLInputElement>(null);
  const focusAfterLinkRef = useRef(false);
  const { restoreFocus: restoreLinkFocus } = useDialog(isActive && showAddLinkModal, addLinkDialogRef, () => setShowAddLinkModal(false), 65);
  const [savedSelectionText, setSavedSelectionText] = useState("");
  const [linkSearchQuery, setLinkSearchQuery] = useState("");
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewingNote, setPreviewingNote] = useState<NoteItem | null>(null);
  const [previewHeading, setPreviewHeading] = useState<string>();
  const [localHeadingRequest, setLocalHeadingRequest] = useState<(NoteHeadingRequest & { noteId: string })>();
  const headingRequest = localHeadingRequest?.noteId === note?.id ? localHeadingRequest : incomingHeadingRequest;
  const headingHost = useRef<HTMLDivElement>(null), appliedHeading = useRef<string | undefined>(undefined);
  const reduceMotion = useReducedMotion();
  const openExistingNote = (target: NoteItem, contextId = projectContextId, heading?: string) => {
    const current = allNotes.find((item) => item.id === target.id);
    if (!current) { showToast('这篇笔记已移除，请重新选择'); return; }
    if (heading && current.id === note?.id) {
      setLocalHeadingRequest({ heading, key: crypto.randomUUID(), noteId: current.id });
      return;
    }
    if (onOpenNote) onOpenNote(current.id, contextId || undefined, heading);
    else onSelectNoteByTitle(`${current.title}${heading ? `#${heading}` : ''}`, contextId || undefined);
  };

  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [logicResult, setLogicResult] = useState<AnalysisResult | null>(null);
  const [logicError, setLogicError] = useState<string | null>(null);
  const [logicScopeNotice, setLogicScopeNotice] = useState<string | null>(null);

  const [isRecommending, setIsRecommending] = useState(false);
  const [isGeneratingTasks, setIsGeneratingTasks] = useState(false);
  const [resources, setResources] = useState<ResourceItem[]>(note?.resources ?? []);
  const [showResourcePanel, setShowResourcePanel] = useState(false);
  const [resourceError, setResourceError] = useState<string | null>(null);
  const [resourceNotice, setResourceNotice] = useState<string | null>(null);
  const [resourceState, setResourceState] = useState<ResourceStateFile>(getResourceStateSnapshot);
  const [isCheckingResources, setIsCheckingResources] = useState(false);
  const [isChoosingResources, setIsChoosingResources] = useState(false);
  const resourceDialogRef = useRef<HTMLElement>(null);
  const resourceDialogId = useId();
  useDialog(isActive && showResourcePanel, resourceDialogRef, () => setShowResourcePanel(false), 70);
  const recommendationRequestRef = useRef<symbol | null>(null);
  const resourceCheckRequestRef = useRef<symbol | null>(null);
  const resourcePickerRequestRef = useRef<symbol | null>(null);
  const resourcesRef = useRef(resources);
  const resourcePanelOpenRef = useRef(showResourcePanel);
  resourcePanelOpenRef.current = isActive && showResourcePanel;
  const [narrowEditor, setNarrowEditor] = useState(() => typeof window !== 'undefined' && window.matchMedia('(max-width: 1080px)').matches);
  const [argumentPanelOpen, setArgumentPanelOpen] = useState(() => !narrowEditor);
  const [inspectorMounted, setInspectorMounted] = useState(() => !narrowEditor);
  const [recordsTarget, setRecordsTarget] = useState<HTMLDivElement | null>(null);
  const [learningToolbarTarget, setLearningToolbarTarget] = useState<HTMLDivElement | null>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const referenceDetailsRef = useRef<HTMLDetailsElement>(null);
  const referenceDetailsId = useId();
  useEffect(() => {
    const details = referenceDetailsRef.current;
    if (details) details.open = false;
    if (!isActive) return;
    const closeOutside = (event: PointerEvent) => {
      const details = referenceDetailsRef.current;
      if (details?.open && !details.contains(event.target as Node)) details.open = false;
    };
    document.addEventListener('pointerdown', closeOutside);
    return () => document.removeEventListener('pointerdown', closeOutside);
  }, [note.id, isActive]);
  useDialog(isActive && argumentPanelOpen && narrowEditor, inspectorRef, () => { if (allowCognitionLeave()) setArgumentPanelOpen(false); }, 55);
  useEffect(() => { if (argumentPanelOpen) setInspectorMounted(true); }, [argumentPanelOpen]);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 1080px)');
    const changed = () => { setNarrowEditor(media.matches); if (media.matches && allowCognitionLeave()) setArgumentPanelOpen(false); };
    media.addEventListener('change', changed);
    return () => media.removeEventListener('change', changed);
  }, []);
  const [inspectorTab, setInspectorTab] = useState<'argument' | 'links' | 'info' | 'records'>('argument');
  const activeInspectorTab = inspectorTab === 'records' && !hasProgressiveCourse ? 'argument' : inspectorTab;
  const inspectorId = useId();
  const actionScopeRef = useRef({ version: 0, mounted: false });
  const logicRequestRef = useRef<AbortController | null>(null);
  const taskRequestRef = useRef<AbortController | null>(null);
  useEffect(() => {
    actionScopeRef.current.mounted = true;
    setIsAnalyzing(false); setIsGeneratingTasks(false);
    setIsRecommending(false); setIsCheckingResources(false); setIsChoosingResources(false);
    setLogicResult(null); setLogicError(null); setLogicScopeNotice(null); setToastMessage(null);
    return () => {
      actionScopeRef.current.mounted = false;
      actionScopeRef.current.version++;
      logicRequestRef.current?.abort(); taskRequestRef.current?.abort();
      logicRequestRef.current = null; taskRequestRef.current = null;
      recommendationRequestRef.current = null; resourceCheckRequestRef.current = null; resourcePickerRequestRef.current = null;
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
      if (localTypingTimeoutRef.current) clearTimeout(localTypingTimeoutRef.current);
      if (titleSaveTimerRef.current) { clearTimeout(titleSaveTimerRef.current); titleSaveTimerRef.current = null; }
    };
  }, [note?.id]);
  const isCurrentAction = (version: number, sourceId: string) => actionScopeRef.current.mounted
    && actionScopeRef.current.version === version && latestNoteRef.current?.id === sourceId
    && allNotesRef.current.some(item => item.id === sourceId);
  const closeLogicalAnalysis = () => {
    logicRequestRef.current?.abort(); logicRequestRef.current = null;
    setIsAnalyzing(false); setLogicResult(null); setLogicError(null); setLogicScopeNotice(null);
    moreBtnRef.current?.focus({ preventScroll: true });
  };
  const stopTaskGeneration = () => {
    taskRequestRef.current?.abort(); taskRequestRef.current = null;
    setIsGeneratingTasks(false);
    moreBtnRef.current?.focus({ preventScroll: true });
  };
  const [selectedArgumentDocId, setSelectedArgumentDocId] = useState<string | null>(
    note?.argumentDocs?.[note.argumentDocs.length - 1]?.doc_id ?? null,
  );

  const mdxEditorRef = useRef<MdxNoteEditorHandle>(null);
  const richEditorRef = useRef<MdxNoteEditorHandle>(null), sourceEditorRef = useRef<MdxNoteEditorHandle>(null);
  const sourceModeRef = useRef(prefersSourceEditor && longEditMode === 'source');
  sourceModeRef.current = prefersSourceEditor && longEditMode === 'source';
  mdxEditorRef.current = sourceModeRef.current ? sourceEditorRef.current : richEditorRef.current;
  const richContentRef = useRef(content);
  if (!prefersSourceEditor || longEditMode === 'rich') richContentRef.current = content;

  // 「更多」扩展菜单状态（收拢 5 个业务功能按钮）
  const [moreOpen, setMoreOpen] = useState(false);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);
  const [moreMenuPos, setMoreMenuPos] = useState<{ top: number; right: number } | null>(null);
  useEffect(() => {
    if (isActive) return;
    setMoreOpen(false); setMoreMenuPos(null);
    setShowResourcePanel(false); setShowAddLinkModal(false); setPreviewingNote(null);
    setToastMessage(null); focusAfterLinkRef.current = false;
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
  }, [isActive]);

  /** 向上遍历 parentId，返回根级 → 直接父级的标题链（不含当前笔记自身） */
  const buildAncestorTitles = (start: NoteItem): string[] => {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur = start;
    while (cur.parentId && !seen.has(cur.parentId)) {
      seen.add(cur.parentId);
      const parent = allNotes.find((n) => n.id === cur.parentId);
      if (!parent) break;
      chain.unshift(parent.title);
      cur = parent;
    }
    return chain;
  };

  /** Capture and immediately return selection text (synchronous, no state dependency) */
  const captureSelectionText = (): string => {
    if (mdxEditorRef.current) {
      const text = mdxEditorRef.current.getSelectionMarkdown().trim();
      if (text) {
        setSavedSelectionText(text);
        return text;
      }
    }
    return '';
  };

  const handleLogicalAnalysis = async () => {
    if (!note || logicRequestRef.current) return;
    const freshSelection = captureSelectionText();
    const source = prepareLogicCheckSource(latestContentRef.current, freshSelection, note.textbook);
    setLogicResult(null);
    setLogicError(null);
    setLogicScopeNotice(source.ok ? source.notice : null);
    if (source.ok === false) { setLogicError(source.message); return; }
    const request = new AbortController(); logicRequestRef.current = request;
    const version = actionScopeRef.current.version, sourceId = note.id;
    const current = () => isCurrentAction(version, sourceId) && logicRequestRef.current === request;
    setIsAnalyzing(true);
    try {
      const resp = await callLLM({
        workflow: 'logic-check',
        userInput: `请分析以下用户笔记正文的逻辑性和认知漏洞。教材内容已由客户端排除，不要推断或补回教材：\n${source.text}`,
        providerId: '',
        model: '',
      }, { signal: request.signal });
      if (!current()) return;
      let parsed: AnalysisResult;
      if (resp.parsedJson) {
        parsed = resp.parsedJson as AnalysisResult;
      } else {
        const raw = (resp.content || '').trim();
        if (!raw) throw new Error('AI 未返回有效内容');
        const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonText = (jsonMatch?.[1] || raw).trim();
        try {
          parsed = JSON.parse(jsonText) as AnalysisResult;
        } catch {
          const start = jsonText.indexOf('{');
          const end = jsonText.lastIndexOf('}');
          if (start === -1 || end === -1 || end <= start) {
            throw new Error('AI 返回格式无法解析，请重试或缩短复盘文本');
          }
          let slice = jsonText.slice(start, end + 1);
          let open = 0;
          for (const ch of slice) { if (ch === '{' || ch === '[') open++; else if (ch === '}' || ch === ']') open--; }
          while (open > 0) { slice += (open === 1 ? '}' : ']'); open--; }
          try {
            parsed = JSON.parse(slice) as AnalysisResult;
          } catch {
            throw new Error('AI 返回内容被截断，请重试');
          }
        }
      }
      setLogicResult(parsed);
    } catch (err: any) {
      if (current()) setLogicError(err?.message || '逻辑分析失败');
    } finally {
      if (logicRequestRef.current === request) { logicRequestRef.current = null; setIsAnalyzing(false); }
    }
  };

  const handleGenerateStudyTasks = async () => {
    if (!note || note.noteType !== 'project' || !isLeafProjectNote(note.id, allNotes) || taskRequestRef.current) return;
    const currentTitle = title.trim() || note.title.trim();
    if (!currentTitle) { showToast('请先填写笔记标题'); return; }
    const request = new AbortController(); taskRequestRef.current = request;
    const version = actionScopeRef.current.version, sourceId = note.id;
    const current = () => isCurrentAction(version, sourceId) && taskRequestRef.current === request;
    setIsGeneratingTasks(true);
    try {
      const ancestorTitles = buildAncestorTitles(note);
      const latestContent = latestContentRef.current.trim();
      const userInput = `【笔记信息】\n笔记标题：${currentTitle}\n所属层级：${note.parentId ? '子项目' : '根项目'}\n祖先链：${ancestorTitles.join(' → ') || '无'}\n笔记正文（可能为空）：\n${latestContent.slice(0, 2000)}`;
      const resp = await callLLM({ providerId: '', model: '', workflow: 'study-task-generation', userInput }, { signal: request.signal });
      if (!current()) return;
      let tasks: string[] = [];
      const extractTasks = (obj: any): string[] => Array.isArray(obj?.tasks) ? obj.tasks.map((t: any) => String(t).trim()).filter(Boolean) : [];
      if (resp.parsedJson) {
        tasks = extractTasks(resp.parsedJson);
      } else {
        const raw = (resp.content || '').trim();
        if (!raw) throw new Error('AI 未返回有效内容');
        const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
        const jsonText = (jsonMatch?.[1] || raw).trim();
        try {
          tasks = extractTasks(JSON.parse(jsonText));
        } catch {
          const start = jsonText.indexOf('{');
          const end = jsonText.lastIndexOf('}');
          if (start === -1 || end === -1 || end <= start) throw new Error('AI 返回格式无法解析，请重试');
          let slice = jsonText.slice(start, end + 1);
          let open = 0;
          for (const ch of slice) { if (ch === '{' || ch === '[') open++; else if (ch === '}' || ch === ']') open--; }
          while (open > 0) { slice += (open === 1 ? '}' : ']'); open--; }
          try {
            tasks = extractTasks(JSON.parse(slice));
          } catch {
            throw new Error('AI 返回内容被截断，请重试');
          }
        }
      }
      if (tasks.length === 0) { showToast('AI 未返回有效任务，请重试'); return; }
      const activeNote = latestNoteRef.current!;
      if (activeNote.noteType !== 'project' || !isLeafProjectNote(sourceId, allNotesRef.current)) {
        showToast('项目结构已变化，未写入任务，请在末级项目重新生成'); return;
      }
      const list = tasks.map(t => `- [ ] ${t}`).join('\n');
      const updatedContent = `${list}\n\n${latestContentRef.current}`;
      onUpdateNote({ ...activeNote, content: updatedContent,
        generatedContentBlocks: [...(activeNote.generatedContentBlocks || []), list], updatedAt: new Date().toISOString() });
      latestContentRef.current = updatedContent;
      setContent(updatedContent);
      if (mdxEditorRef.current) {
        isLocalTypingRef.current = true;
        mdxEditorRef.current.setMarkdown(updatedContent);
      }
      showToast(`已生成 ${tasks.length} 条学习任务`);
    } catch (err: any) {
      if (current()) showToast(err?.message || '学习任务生成失败');
    } finally {
      if (taskRequestRef.current === request) { taskRequestRef.current = null; setIsGeneratingTasks(false); }
    }
  };

  const handleResourceRecommendation = async (forceRefresh: boolean = false) => {
    if (!note || !isActiveRef.current) return;
    setShowResourcePanel(true);
    if (recommendationRequestRef.current) return;
    if (!forceRefresh && resourcesRef.current.length > 0) {
      setResourceError(null); setResourceNotice(null);
      return;
    }
    if (note.noteType !== 'project' || !onRecommendProjectResources) {
      setResourceError('资源推荐仅适用于项目笔记');
      return;
    }
    const request = Symbol('resource-recommendation');
    const version = actionScopeRef.current.version, sourceId = note.id;
    recommendationRequestRef.current = request;
    const ownsRequest = () => recommendationRequestRef.current === request && isCurrentAction(version, sourceId);
    setIsRecommending(true);
    setResourceError(null);
    setResourceNotice(null);
    setShowResourcePanel(true);
    try {
      const outcome = await onRecommendProjectResources(note);
      if (!ownsRequest()) return;
      // App owns recommendation writes; review candidates are not saved resources.
      const saved = latestNoteRef.current?.resources ?? resourcesRef.current;
      resourcesRef.current = saved; setResources(saved);
      setResourceNotice(outcome.message);
      if (resourcePanelOpenRef.current) showToast(outcome.message);
    } catch (err: any) {
      if (!ownsRequest()) return;
      setResourceError(err?.message || '资源推荐失败');
      setResourceNotice(null);
    } finally {
      if (recommendationRequestRef.current === request) { recommendationRequestRef.current = null; setIsRecommending(false); }
    }
  };

  const handleDeleteResource = (resource: ResourceItem) => {
    const activeNote = latestNoteRef.current;
    if (!activeNote || !isCurrentAction(actionScopeRef.current.version, activeNote.id)) return;
    const next = resourcesRef.current.filter(item => !(normalizeResourceUrl(item.url) === normalizeResourceUrl(resource.url)
      && item.documentId === resource.documentId));
    if (next.length === resourcesRef.current.length) return;
    resourcesRef.current = next; setResources(next);
    const updated = { ...activeNote, content: latestContentRef.current, resources: next, updatedAt: new Date().toISOString() };
    latestNoteRef.current = updated; onUpdateNote(updated);
    showToast('已移除资源引用，原文件未删除');
  };

  const handleCheckResources = async () => {
    if (!note || !isActiveRef.current || resourceCheckRequestRef.current) return;
    const online = [...new Map(resourcesRef.current.filter(resource => resource.kind !== 'local' && /^https?:\/\//i.test(resource.url))
      .map(resource => [normalizeResourceUrl(resource.url), resource])).values()];
    if (online.length === 0) return;
    const request = Symbol('resource-check'), version = actionScopeRef.current.version, sourceId = note.id;
    resourceCheckRequestRef.current = request;
    const ownsRequest = () => resourceCheckRequestRef.current === request && isCurrentAction(version, sourceId);
    setIsCheckingResources(true);
    setResourceError(null);
    try {
      let latest = resourceState;
      // ponytail: 小规模资源列表按 3 个一批检查；数量显著增长时再抽成并发队列。
      for (let index = 0; index < online.length; index += 3) {
        if (!ownsRequest()) return;
        const results = await Promise.all(online.slice(index, index + 3).map((resource) => checkResourceHealth(resource.url)));
        for (const result of results) {
          if (!ownsRequest()) return;
          latest = await storeResourceHealth(result);
        }
      }
      if (!ownsRequest()) return;
      setResourceState(latest);
      if (resourcePanelOpenRef.current) showToast(`已复核 ${online.length} 条在线资源`);
    } catch (error) {
      if (!ownsRequest()) return;
      setResourceError(error instanceof Error ? error.message : '链接复核失败');
    } finally {
      if (resourceCheckRequestRef.current === request) { resourceCheckRequestRef.current = null; setIsCheckingResources(false); }
    }
  };

  /** 添加本地学习资源：系统文件选择框（多选）→ 转 file:// URL → 追加到 resources 并持久化 */
  const handleAddLocalResource = async () => {
    if (!note || !isActiveRef.current || resourcePickerRequestRef.current) return;
    const api = (window as any).electronAPI;
    if (!api?.chooseLocalFiles) {
      showToast('本地资源加载仅支持桌面版');
      return;
    }
    const request = Symbol('resource-picker'), version = actionScopeRef.current.version, sourceId = note.id;
    const startedInPanel = resourcePanelOpenRef.current;
    resourcePickerRequestRef.current = request;
    const ownsRequest = () => resourcePickerRequestRef.current === request && isCurrentAction(version, sourceId);
    setIsChoosingResources(true);
    setResourceError(null);
    try {
      const selected = await api.chooseLocalFiles();
      if (!ownsRequest() || !Array.isArray(selected)) return;
      const paths = selected.filter((path): path is string => typeof path === 'string' && path.trim().length > 0);
      if (!paths.length) return;
      const urls = new Set(resourcesRef.current.map(item => normalizeResourceUrl(item.url)));
      const newItems: ResourceItem[] = [];
      for (const path of paths) {
        const url = pathToFileUrl(path), key = normalizeResourceUrl(url);
        if (urls.has(key)) continue;
        urls.add(key);
        newItems.push({ title: basename(path), url, platform: '本地', kind: 'local', fileType: detectLocalFileType(path) });
      }
      if (!newItems.length) { showToast('所选资源已在此笔记中'); return; }
      const activeNote = latestNoteRef.current!;
      const next = [...resourcesRef.current, ...newItems];
      resourcesRef.current = next; setResources(next);
      if (isActiveRef.current && (!startedInPanel || resourcePanelOpenRef.current)) setShowResourcePanel(true);
      const updated = { ...activeNote, content: latestContentRef.current, resources: next, updatedAt: new Date().toISOString() };
      latestNoteRef.current = updated; onUpdateNote(updated);
      showToast(`已添加 ${newItems.length} 个本地资源`);
    } catch (err: any) {
      if (!ownsRequest()) return;
      const message = err?.message || '选择本地资源失败';
      if (resourcePanelOpenRef.current) setResourceError(message);
      else showToast(message);
    } finally {
      if (resourcePickerRequestRef.current === request) { resourcePickerRequestRef.current = null; setIsChoosingResources(false); }
    }
  };

  const showToast = (msg: string) => {
    if (!isActiveRef.current) return;
    setToastMessage(msg);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setToastMessage(null), 4000);
  };
  const headingResolved = (found: boolean) => {
    if (!found && headingRequest) showToast(`未找到章节「${headingRequest.heading}」，已打开笔记。`);
  };
  const handleWikiLink = (rawTitle: string) => {
    const destination = parseWikiLink(rawTitle, allNotesRef.current);
    const targetTitle = destination.noteTitle;
    if (destination.heading !== undefined && !destination.heading) { showToast('章节引用缺少章节名称。'); return; }
    const resolution = resolveNoteReference(targetTitle, allNotesRef.current);
    if (resolution.status === 'ambiguous') { showToast(ambiguousNoteReferenceMessage(targetTitle, resolution.matches)); return; }
    const found = targetTitle && resolution.status === 'unique' ? resolution.note : !targetTitle && destination.heading ? note : undefined;
    if (found) {
      if (found.id === note.id && destination.heading) { openExistingNote(found, projectContextId, destination.heading); return; }
      if (previewingNote?.id === found.id && previewHeading === destination.heading) {
        setPreviewingNote(null); setPreviewHeading(undefined);
        openExistingNote(found, projectContextId, destination.heading);
      } else {
        setPreviewHeading(destination.heading); setPreviewingNote(found);
      }
    } else {
      if (destination.heading !== undefined) showToast('未找到章节引用的目标笔记，请检查笔记名称。');
      else if (targetTitle) onSelectNoteByTitle(targetTitle);
    }
  };
  useEffect(() => {
    if (!isActive || !headingRequest || !note || appliedHeading.current === headingRequest.key) return;
    // Long readers use their complete section index to locate off-screen pages.
    if (readTextbook && supportsReading) return;
    let stopped = false;
    const locate = () => {
      if (stopped) return false;
      const editorBody = headingHost.current?.querySelector<HTMLElement>('.mdxeditor-content-editable');
      const found = sourceModeRef.current ? sourceEditorRef.current?.scrollToHeading?.(headingRequest.heading)
        : editorBody && scrollToNoteHeading(editorBody, headingRequest.heading);
      if (found) { appliedHeading.current = headingRequest.key; stopped = true; return true; }
      return false;
    };
    if (locate()) return;
    const observer = new MutationObserver(locate);
    if (headingHost.current) observer.observe(headingHost.current, { childList: true, subtree: true });
    const timeout = setTimeout(() => { if (!stopped) { appliedHeading.current = headingRequest.key; headingResolved(false); } observer.disconnect(); }, 5000);
    return () => { stopped = true; observer.disconnect(); clearTimeout(timeout); };
  }, [isActive, note?.id, headingRequest?.key, headingRequest?.heading, readTextbook, longEditMode]);

  const prevNoteIdRef = useRef<string | null>(null);
  const previousTaskCompletionRef = useRef('');
  const latestNoteRef = useRef(note);
  const latestContentRef = useRef(content);
  const allNotesRef = useRef(allNotes);
  const isLocalTypingRef = useRef(false);
  const localTypingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editingNoteIdRef = useRef(note?.id ?? null);
  const previousActiveRef = useRef(isActive);
  const metadataDraftRef = useRef(createNoteEditorMetadataDraft(note));
  // Keep a background append in exported drafts without replacing the live
  // editor during typing/IME. A fresh mount or safe external import catches up.
  const pendingKnowledgeRef = useRef<{ noteId?: string; rows: ProjectKnowledgeRow[] }>({ noteId: note?.id, rows: [] });
  if (pendingKnowledgeRef.current.noteId !== note?.id) pendingKnowledgeRef.current = { noteId: note?.id, rows: [] };

  useEffect(() => { editingNoteIdRef.current = note?.id ?? null; }, [note?.id]);
  useEffect(() => {
    let active = true;
    void loadResourceState().then(() => { if (active) setResourceState(getResourceStateSnapshot()); }).catch(() => {});
    return () => { active = false; };
  }, []);
  resourcesRef.current = prevNoteIdRef.current === note?.id ? resources : note?.resources ?? [];
  reconcileNoteEditorMetadataDraft(metadataDraftRef.current, note);
  if (titleDraftRef.current.noteId !== (note?.id ?? null)
    || titleDraftRef.current.baseline !== (note?.title ?? '')) {
    titleDraftRef.current = { noteId: note?.id ?? null, baseline: note?.title ?? '', value: note?.title ?? '' };
    titleComposingRef.current = false;
  }
  if (prevNoteIdRef.current !== note?.id) latestContentRef.current = note?.content ?? '';
  latestNoteRef.current = note && prevNoteIdRef.current === note.id
    ? applyNoteEditorMetadataDraft({ ...note, title, content: latestContentRef.current }, metadataDraftRef.current) : note;
  allNotesRef.current = allNotes;
  const pendingTitleIssueRef = useRef<() => string | null>(() => null);
  pendingTitleIssueRef.current = () => {
    const draft = titleDraftRef.current;
    if (!draft.noteId || draft.value === draft.baseline) return null;
    if (titleComposingRef.current) return '标题仍在中文输入中，请先确认候选词';
    return noteRenameError(allNotesRef.current, draft.noteId, draft.value);
  };
  commitTitleRef.current = () => {
    const draft = titleDraftRef.current;
    if (!draft.noteId || draft.value === draft.baseline) return;
    if (!allNotesRef.current.some(item => item.id === draft.noteId)) return;
    const error = pendingTitleIssueRef.current();
    if (error) { showToast(error); throw new Error(error); }
    const nextTitle = draft.value.trim();
    // Accept the single external body revision containing rewritten self-links.
    // Keystrokes themselves never publish a title or scan the vault.
    isLocalTypingRef.current = false;
    try {
      if (onEditNote) onEditNote(draft.noteId, { title: nextTitle });
      else {
        const current = allNotesRef.current.find(item => item.id === draft.noteId)!;
        onCommitNote(applyNoteEditorMetadataDraft({ ...current, title: nextTitle,
          content: current.id === editingNoteIdRef.current ? latestContentRef.current : current.content,
          updatedAt: new Date().toISOString() }, metadataDraftRef.current));
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : '标题保存失败，请重试');
      throw error;
    }
    draft.baseline = nextTitle; draft.value = nextTitle;
    if (latestNoteRef.current?.id === draft.noteId) latestNoteRef.current = { ...latestNoteRef.current, title: nextTitle };
    setTitle(nextTitle);
    if (titleSaveTimerRef.current) { clearTimeout(titleSaveTimerRef.current); titleSaveTimerRef.current = null; }
  };
  useEffect(() => {
    const capture = registerPendingCapture(() => commitTitleRef.current());
    const protect = registerEditorInputLeave({
      pending: () => pendingTitleIssueRef.current(), element: () => titleInputRef.current,
      notify: message => { showToast(message); titleInputRef.current?.focus(); },
    });
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const draft = titleDraftRef.current;
      if (draft.value === draft.baseline) return;
      event.preventDefault(); event.returnValue = '';
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => { capture(); protect(); window.removeEventListener('beforeunload', beforeUnload); };
  }, []);
  // Whole-note business actions preserve every unpublished editor field.
  const onUpdateNote = (updated: NoteItem) => onCommitNote(updated.id === note?.id ? applyNoteEditorMetadataDraft({
    ...updated,
    content: updated.content === note.content ? latestContentRef.current : updated.content,
    title: updated.title === note.title ? title : updated.title,
  }, metadataDraftRef.current) : updated);
  const finishEditingRef = useRef(onFinishEditing);
  finishEditingRef.current = onFinishEditing;
  useEffect(() => {
    if (!note?.id || !isActive) return;
    return () => { finishEditingRef.current?.(); };
  }, [note?.id, isActive]);

  // 外部内容版本号变化（如 AI 分词应用结果）时，强制刷新编辑器内容，绕过 isLocalTypingRef 拦截
  useEffect(() => {
    if (contentVersion === undefined) return;
    if (!note) return;
    setIsNoteChangedRefForce();
    latestContentRef.current = note.content;
    if (latestNoteRef.current?.id === note.id) latestNoteRef.current = { ...latestNoteRef.current, content: note.content };
    setContent(note.content);
    if (mdxEditorRef.current) {
      mdxEditorRef.current.setMarkdown(note.content);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contentVersion]);

  const setIsNoteChangedRefForce = () => {
    isLocalTypingRef.current = false;
    if (localTypingTimeoutRef.current) { clearTimeout(localTypingTimeoutRef.current); localTypingTimeoutRef.current = null; }
  };

  useEffect(() => {
    if (!note) return;
    const isNoteChanged = prevNoteIdRef.current !== note.id;
    const reactivated = isActive && !previousActiveRef.current;
    previousActiveRef.current = isActive;
    if (reactivated) isLocalTypingRef.current = false;
    const completionVersion = JSON.stringify([note.id, note.dueDates.map((task) => [task.id, task.completed])]);
    const completionChanged = !isNoteChanged && previousTaskCompletionRef.current !== completionVersion;
    previousTaskCompletionRef.current = completionVersion;
    prevNoteIdRef.current = note.id;
    if (isNoteChanged) {
      isLocalTypingRef.current = false;
      if (localTypingTimeoutRef.current) { clearTimeout(localTypingTimeoutRef.current); localTypingTimeoutRef.current = null; }
      setTitle(note.title);
      latestContentRef.current = note.content;
      setContent(note.content);
      setTagsText((note.tags || []).join(", "));
      setAliasesText((note.aliases || []).join(", "));
      invalidAliasesDraftRef.current = null;
      setAliasesError(null);
      setResources(note.resources ?? []);
      setShowResourcePanel(false);
      setResourceError(null);
      setResourceNotice(null);
    } else {
      if (isLocalTypingRef.current && !completionChanged && note.content !== latestContentRef.current) {
        const rows = pendingProjectKnowledgeRows(latestContentRef.current, note.content);
        if (rows.length) {
          pendingKnowledgeRef.current.rows.push(...rows);
          latestContentRef.current = appendProjectKnowledgeRows(latestContentRef.current, rows);
          if (latestNoteRef.current?.id === note.id) latestNoteRef.current = { ...latestNoteRef.current, content: latestContentRef.current };
        }
      }
      // A saved completion updates exact task checkboxes. Its rebased content already
      // contains the latest edits, so do not leave the editor on an old checkbox version.
      if ((note.content !== latestContentRef.current || pendingKnowledgeRef.current.rows.length > 0) && (!isLocalTypingRef.current || completionChanged)) {
        latestContentRef.current = note.content;
        if (latestNoteRef.current?.id === note.id) latestNoteRef.current = { ...latestNoteRef.current, content: note.content };
        // React's snapshot intentionally lags typing. Rolling back to that
        // same string would make setContent bail out while Lexical still owns
        // a different live document. Apply each accepted external update once.
        if (isActive && !readTextbook) mdxEditorRef.current?.setMarkdown(note.content);
        setContent(note.content);
        pendingKnowledgeRef.current.rows = [];
      }
      if (note.title !== title && titleDraftRef.current.value === titleDraftRef.current.baseline) setTitle(note.title);
      // Reflect genuine external changes, but do not normalize separators or
      // move the caret when a just-published field matches the text being typed.
      if (!('tags' in metadataDraftRef.current.patch) && !sameEditorMetadataList(splitAliasTokens(tagsText).map(item => item.replace(/^#/, '')).filter(Boolean), note.tags)) {
        setTagsText((note.tags || []).join(', '));
      }
      if (invalidAliasesDraftRef.current !== note.id && !('aliases' in metadataDraftRef.current.patch) && !sameEditorMetadataList(splitAliasTokens(aliasesText), note.aliases)) {
        setAliasesText((note.aliases || []).join(', '));
      }
      setResources(note.resources ?? []);
    }
  }, [note, isActive]);

  useEffect(() => {
    const docs = note?.argumentDocs || [];
    if (docs.length === 0) {
      setSelectedArgumentDocId(null);
      return;
    }
    if (!selectedArgumentDocId || !docs.some((doc) => doc.doc_id === selectedArgumentDocId)) {
      const latest = [...docs].sort((a, b) => {
        const aTime = new Date(a.updated_at || a.created_at).getTime();
        const bTime = new Date(b.updated_at || b.created_at).getTime();
        return bTime - aTime;
      })[0];
      setSelectedArgumentDocId(latest.doc_id);
    }
  }, [note?.id, note?.argumentDocs, selectedArgumentDocId]);

  // 点击菜单外部关闭（监听 document mousedown）——置于条件返回之前，保证 Hook 数量稳定
  useEffect(() => {
    if (!isActive || !moreOpen) return;
    moreMenuRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (moreBtnRef.current && moreBtnRef.current.contains(t)) return;
      if (moreMenuRef.current?.contains(t)) return;
      setMoreOpen(false);
      setMoreMenuPos(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229 || hasActiveDialog() || e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      setMoreOpen(false);
      setMoreMenuPos(null);
      moreBtnRef.current?.focus({ preventScroll: true });
    };
    const dismiss = () => { setMoreOpen(false); setMoreMenuPos(null); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', dismiss);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', dismiss);
    };
  }, [isActive, moreOpen]);

  useEffect(() => { setMoreOpen(false); setMoreMenuPos(null); setShowAddLinkModal(false); }, [note?.id]);
  useEffect(() => {
    if (!isActive) return;
    if (showAddLinkModal) linkSearchRef.current?.focus({ preventScroll: true });
    else if (focusAfterLinkRef.current) { focusAfterLinkRef.current = false; mdxEditorRef.current?.focus(); }
  }, [isActive, showAddLinkModal]);

  if (!note) {
    return (
      <div className="flex-1 h-full flex flex-col items-center justify-center text-slate-400 bg-white dark:bg-slate-950 p-8">
        <Edit3 className="w-12 h-12 mb-3 opacity-20" />
        <p className="text-sm font-medium">请从左侧选择一篇笔记，或点击"新建笔记"</p>
      </div>
    );
  }

  const handleTitleChange = (newTitle: string) => {
    if (editingNoteIdRef.current !== note?.id) return;
    setTitle(newTitle);
    titleDraftRef.current.value = newTitle;
    if (latestNoteRef.current?.id === note.id) latestNoteRef.current = { ...latestNoteRef.current, title: newTitle };
    if (titleSaveTimerRef.current) clearTimeout(titleSaveTimerRef.current);
    titleSaveTimerRef.current = setTimeout(() => {
      titleSaveTimerRef.current = null;
      if (!titleComposingRef.current) {
        try { commitTitleRef.current(); finishEditingRef.current?.(); } catch { /* Keep the visible draft. */ }
      }
    }, NOTE_AUTOSAVE_IDLE_MS);
  };
  const handleContentChange = (newContent: string) => {
    if (editingNoteIdRef.current !== note?.id) return;    const pending = pendingKnowledgeRef.current;
    if (pending.rows.length) {
      const merged = appendProjectKnowledgeRows(newContent, pending.rows);
      if (merged === newContent) pending.rows = [];
      newContent = merged;
    }

    // Lexical owns the live document; refs and App's authoritative draft update
    // synchronously. Do not rerender the entire note shell on each character.
    // Only a placeholder transition needs immediate surrounding UI feedback.
    if (note.noteType === 'knowledge'
      && (content.trim() === '' || content === '请对该知识点进行定义描述') !== (newContent.trim() === '' || newContent === '请对该知识点进行定义描述')) setContent(newContent);
    latestContentRef.current = newContent;
    if (latestNoteRef.current?.id === note.id) latestNoteRef.current = { ...latestNoteRef.current, content: newContent };
    if (onEditNote) onEditNote(note.id, { content: newContent });
    else onUpdateNote({ ...note, content: newContent, updatedAt: new Date().toISOString() });
  };
  /** 分隔符统一：顿号 、 / 中文逗号 ， / 英文逗号 , / 中文分号 ； / 英文分号 ; */
  const splitAliasTokens = (text: string): string[] =>
    text.split(/[、，,；;]/).map((t) => t.trim()).filter(Boolean);

  const handleTagsChange = (text: string) => {
    if (editingNoteIdRef.current !== note?.id) return;
    setTagsText(text);
    const tagsArray = splitAliasTokens(text).map((t) => t.replace(/^#/, "")).filter(Boolean);
    recordNoteEditorMetadataDraft(metadataDraftRef.current, note, { tags: tagsArray });
    if (latestNoteRef.current?.id === note.id) latestNoteRef.current = applyNoteEditorMetadataDraft({ ...latestNoteRef.current, tags: tagsArray }, metadataDraftRef.current);
    if (onEditNote) onEditNote(note.id, { tags: tagsArray });
    else onUpdateNote({ ...note, tags: tagsArray, updatedAt: new Date().toISOString() });
  };

  const handleAliasesChange = (text: string) => {
    if (editingNoteIdRef.current !== note?.id) return;
    setAliasesText(text);
    const aliasesArray = splitAliasTokens(text);
    const error = noteAliasesError(allNotesRef.current, note.id, aliasesArray);
    if (error) { invalidAliasesDraftRef.current = note.id; setAliasesError(error); return; }
    const previousDraft = { ...metadataDraftRef.current, patch: { ...metadataDraftRef.current.patch } };
    recordNoteEditorMetadataDraft(metadataDraftRef.current, note, { aliases: aliasesArray });
    try {
      if (onEditNote) onEditNote(note.id, { aliases: aliasesArray });
      else onUpdateNote({ ...note, aliases: aliasesArray, updatedAt: new Date().toISOString() });
    } catch (error) {
      Object.assign(metadataDraftRef.current, previousDraft);
      invalidAliasesDraftRef.current = note.id;
      setAliasesError(error instanceof Error ? error.message : '别名未保存，请修正后重试');
      return;
    }
    invalidAliasesDraftRef.current = null;
    setAliasesError(null);
    if (latestNoteRef.current?.id === note.id) latestNoteRef.current = applyNoteEditorMetadataDraft({ ...latestNoteRef.current, aliases: aliasesArray }, metadataDraftRef.current);
  };

  const handleOpenAddLinkModal = () => {
    let selText = "";
    if (mdxEditorRef.current) {
      selText = mdxEditorRef.current.getSelectionMarkdown().trim();
    }
    const initialQuery = selText || savedSelectionText;
    setSavedSelectionText(initialQuery);
    setLinkSearchQuery(initialQuery);
    setShowAddLinkModal(true);
  };

  const handleCreateAndLinkNewNote = (newTitle: string) => {
    const cleanTitle = newTitle.trim(); if (!cleanTitle) return;
    const resolution = resolveNoteReference(cleanTitle, allNotesRef.current);
    if (resolution.status === 'ambiguous') { showToast(ambiguousNoteReferenceMessage(cleanTitle, resolution.matches)); return; }
    const existing = resolution.status === 'unique' ? resolution.note : undefined;
    if (existing) { insertWikiLink(existing.title); showToast(`已关联已有笔记《${existing.title}》`); return; }
    const newId = crypto.randomUUID();
    const titleError = noteRenameError(allNotesRef.current, newId, cleanTitle);
    if (titleError) { showToast(titleError); return; }
    const newNote: NoteItem = { id: newId, title: cleanTitle, content: "请对该知识点进行定义描述", noteType: "knowledge", tags: ["关联知识点"], links: note ? [note.title] : [], backlinks: [], dueDates: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    onUpdateNote(newNote); insertWikiLink(cleanTitle); showToast(`已在目录成功新建笔记《${cleanTitle}》，并关联为知识点。`);
  };

  const insertWikiLink = (targetTitle: string) => {
    const resolution = resolveNoteReference(targetTitle, allNotesRef.current);
    if (resolution.status === 'ambiguous') { showToast(ambiguousNoteReferenceMessage(targetTitle, resolution.matches)); return; }
    restoreLinkFocus();
    focusAfterLinkRef.current = true;
    if (mdxEditorRef.current) {
      mdxEditorRef.current.insertMarkdown(`[[${targetTitle}]]`);
      mdxEditorRef.current.focus();
    }
    setShowAddLinkModal(false);
    setSavedSelectionText("");
  };

  /** 插入行内公式 `$...$`；若已有选区则自动包裹，否则插入空模板（点击公式节点编辑） */
  const insertInlineMath = () => {
    if (!mdxEditorRef.current) return;
    const sel = mdxEditorRef.current.getSelectionMarkdown().trim();
    mdxEditorRef.current.insertMarkdown(sel ? `$${sel}$` : `$ $`);
    mdxEditorRef.current.focus();
  };

  /** 插入块级公式 `$$...$$`（单行）；若已有选区则自动包裹，否则插入空模板 */
  const insertBlockMath = () => {
    if (!mdxEditorRef.current) return;
    const sel = mdxEditorRef.current.getSelectionMarkdown().trim();
    mdxEditorRef.current.insertMarkdown(sel ? `$$${sel}$$` : `$$ $$`);
    mdxEditorRef.current.focus();
  };

  const handleAutoLinkScan = (silent: boolean = false) => {
    const activeNote = latestNoteRef.current;
    const activeContent = latestContentRef.current;
    if (!activeNote || !activeContent) return;
    const currentAllNotes = allNotesRef.current || [];
    const otherNotes = currentAllNotes.filter((n) => n.id !== activeNote.id && n.noteType === "knowledge" && n.title && n.title.trim().length >= 2);
    if (otherNotes.length === 0) { if (!silent) showToast("目录中暂无其他可比对关联的已有笔记"); return; }
    // 标题与别名仍指向同一知识点；只在 Markdown 可读文本中匹配。
    const matchEntries = otherNotes
      .flatMap((n) => {
        const title = n.title.trim();
        const aliases = (n.aliases || []).map((a) => a.trim()).filter(Boolean);
        return [
          { token: title, target: title },
          ...aliases.map((a) => ({ token: a, target: title })),
        ];
      })
      .sort((a, b) => b.token.length - a.token.length);
    let result: ReturnType<typeof autoLinkMarkdown>;
    try { result = autoLinkMarkdown(activeContent, matchEntries, activeNote.generatedContentBlocks); }
    catch { if (!silent) showToast('自动关联未写入：Markdown 解析失败，原文保持不变'); return; }
    const { updatedContent, addedLinks: newLinkedTitles } = result;
    if (updatedContent !== activeContent) {
      const newLinks = [...(activeNote.links || [])];
      for (const t of newLinkedTitles) { if (!newLinks.includes(t)) newLinks.push(t); }
      onUpdateNote({ ...activeNote, content: updatedContent, links: newLinks,
        generatedContentBlocks: result.generatedContentBlocks, updatedAt: new Date().toISOString() });
      latestContentRef.current = updatedContent;
      setContent(updatedContent);
      if (mdxEditorRef.current) {
        isLocalTypingRef.current = true;
        mdxEditorRef.current.setMarkdown(updatedContent);
      }
      if (!silent) showToast(`自动关联扫描完成：已将 ${newLinkedTitles.map((t) => `《${t}》`).join("、")} 转化为关联知识点`);
      else showToast(`自动补全关联：已将 ${newLinkedTitles.map((t) => `《${t}》`).join("、")} 转化为知识点链接`);
    } else if (!silent) showToast("✓ 自动关联扫描完成，文中暂无新的未关联已有笔记名称");
  };

  /** 展开/收起「更多」菜单，并计算定位坐标（右对齐，避免越出屏幕右缘） */
  const toggleMoreMenu = () => {
    if (moreOpen) {
      closeMoreMenu();
      return;
    }
    const rect = moreBtnRef.current?.getBoundingClientRect();
    if (rect) {
      const right = Math.max(8, window.innerWidth - rect.right);
      setMoreMenuPos({ top: rect.bottom + 6, right });
    } else {
      setMoreMenuPos({ top: 40, right: 8 });
    }
    setMoreOpen(true);
  };

  const closeMoreMenu = () => {
    setMoreOpen(false);
    setMoreMenuPos(null);
    moreBtnRef.current?.focus({ preventScroll: true });
  };

  const handleMoreMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || e.altKey || e.ctrlKey || e.metaKey) return;
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const index = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1
      : (current + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
    e.preventDefault();
    buttons[index]?.focus({ preventScroll: true });
  };

  const handleInspectorTabKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.defaultPrevented || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229 || e.altKey || e.ctrlKey || e.metaKey) return;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
    const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
    const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
    if (index < 0) return; // Do not consume keys from the adjacent close button.
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1
      : (index + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    e.preventDefault(); tabs[next]?.focus({ preventScroll: true });
  };

  /** 工具栏尾部注入：公式按钮保持平铺 + 「更多」扩展按钮 */
  const toolbarBusinessButtons = (
    <>
      <button
        onClick={insertInlineMath}
        className="note-editor-tool-action mx-0.5 flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-semibold border transition"
        title="插入行内公式 $...$（选中文本则自动包裹）"
      >
        <Sigma className="h-3 w-3 text-slate-600" />
        <span>行内公式</span>
      </button>
      <button
        onClick={insertBlockMath}
        className="note-editor-tool-action mx-0.5 flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-semibold border transition"
        title="插入块级公式 $$...$$（选中文本则自动包裹）"
      >
        <Sigma className="h-3 w-3 text-slate-600" />
        <span>块级公式</span>
      </button>
      <button
        ref={moreBtnRef}
        type="button"
        aria-expanded={moreOpen}
        onClick={toggleMoreMenu}
        className="note-editor-tool-action mx-0.5 flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md px-2 py-1 text-[11px] font-semibold border transition"
        title="更多功能"
      >
        <MoreHorizontal className="h-3.5 w-3.5" />
        <span>更多</span>
      </button>
    </>
  );

  const { ancestorTitles, argumentDocs, rootProject, directKnowledgeNotes, rootKnowledgeNotes, knowledgeProjectContextId,
    completionTarget, scheduledChildren, childProgress, completedChildren } = getNoteEditorContext(note, allNotes, projectContextId);
  const selectedArgumentDoc = argumentDocs.find((doc) => doc.doc_id === selectedArgumentDocId) || argumentDocs[0];
  const selectedAssessment = selectedArgumentDoc?.rag?.draftAssessment;
  const formatArgumentDate = (value?: string) => {
    if (!value) return '时间未记录';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '时间未记录';
    return date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div ref={headingHost} inert={!isActive} aria-hidden={!isActive} data-knowledge-maintenance-note={note.id} className={`note-editor-shell flex-1 h-full min-h-0 flex flex-col overflow-hidden ${argumentPanelOpen ? 'has-inspector' : ''}`}>
      <div className="note-editor-header">
        <div className="note-editor-breadcrumb" aria-label="笔记层级">
          <span>{note.noteType === 'project' ? '学习项目' : '知识库'}</span>
          {ancestorTitles.map((ancestor) => (
            <React.Fragment key={ancestor}>
              <i aria-hidden="true">›</i>
              <span>{ancestor}</span>
            </React.Fragment>
          ))}
          <span className={`note-editor-save-state is-${titleDraftRef.current.value !== titleDraftRef.current.baseline ? 'pending' : saveState || 'idle'}`} role="status" aria-live="polite">
            {saveState === 'error' ? <AlertTriangle aria-hidden="true" /> : titleDraftRef.current.value !== titleDraftRef.current.baseline || saveState === 'saving' || saveState === 'pending' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Check aria-hidden="true" />}
            {titleDraftRef.current.value !== titleDraftRef.current.baseline ? '标题待保存' : saveState === 'pending' ? '等待保存' : saveState === 'saving' ? '正在保存' : saveState === 'error' ? '保存失败，内容已保留' : saveState === 'saved' ? '已保存' : '自动保存'}
            {saveState === 'error' && onRetrySave && <button type="button" onClick={onRetrySave}>重试保存</button>}
          </span>
        </div>
        <div className="note-editor-title-row">
          <input
            ref={titleInputRef}
            type="text"
          value={title}
          aria-label="笔记标题"
            onChange={(e) => handleTitleChange(e.target.value)}
            onBlur={() => { if (!titleComposingRef.current) { try { commitTitleRef.current(); } catch { /* Correct the retained draft before leaving. */ } } }}
            onCompositionStart={() => { titleComposingRef.current = true; }}
            onCompositionEnd={() => {
              titleComposingRef.current = false;
              if (titleSaveTimerRef.current) clearTimeout(titleSaveTimerRef.current);
              titleSaveTimerRef.current = setTimeout(() => {
                titleSaveTimerRef.current = null;
                try { commitTitleRef.current(); finishEditingRef.current?.(); } catch { /* Keep the visible draft. */ }
              }, document.activeElement === titleInputRef.current ? NOTE_AUTOSAVE_IDLE_MS : 0);
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || titleComposingRef.current) return;
              if (event.key === 'Enter') {
                event.preventDefault();
                try { commitTitleRef.current(); } catch { /* Keep focus on the invalid draft. */ }
              }
            }}
            placeholder="笔记标题 (例如: [[量子力学基础]])"
            className="note-editor-title"
          />
          {note.noteType === 'knowledge' && <QuickCheckButton noteId={note.id} source="knowledge-note" disabled={!isActive || saveState === 'pending' || saveState === 'saving' || saveState === 'error'} />}
          {completionTarget && onSetLearningCompletion && !hideLearningCompletionControl && (
            <LearningCompletionCard target={completionTarget} onSetCompleted={onSetLearningCompletion} variant="compact" context="note" />
          )}
          {!completionTarget && childProgress && (
            <div className="note-editor-project-progress" aria-label={`子项目完成进度：${completedChildren} / ${scheduledChildren.length}，${childProgress.progress}%`}>
              <span><ListChecks aria-hidden="true" />子项目 {completedChildren} / {scheduledChildren.length} 已完成</span>
              <progress value={childProgress.progress} max={100} aria-label="子项目完成百分比" />
            </div>
          )}
        </div>
        <div className="note-editor-meta">
          <span className="note-editor-meta-item"><CalendarDays aria-hidden="true" />{new Date(note.updatedAt).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
          <span className="note-editor-meta-item"><FolderOpen aria-hidden="true" />{ancestorTitles[0] || (note.noteType === 'project' ? '学习项目' : '知识库')}</span>
          <label className="note-editor-meta-input">
            <Tag aria-hidden="true" />
            <input
              type="text"
              value={tagsText}
              aria-label="笔记标签"
              onChange={(e) => handleTagsChange(e.target.value)}
              placeholder="添加标签"
            />
          </label>
          {note.noteType === 'knowledge' && (
            <label className="note-editor-meta-input is-alias">
              <Link2 aria-hidden="true" />
              <input
                type="text"
                value={aliasesText}
                aria-label="笔记别名"
                aria-invalid={Boolean(aliasesError)}
                aria-describedby={aliasesError ? aliasesErrorId : undefined}
                onChange={(e) => handleAliasesChange(e.target.value)}
                placeholder="添加别名"
              />
            </label>
          )}
          {note.noteType === 'knowledge' && <details ref={referenceDetailsRef} className="note-editor-reference-details"
            onKeyDown={event => {
              if (event.key !== 'Escape' || !event.currentTarget.open || !event.currentTarget.contains(event.target as Node)) return;
              event.preventDefault(); event.stopPropagation(); event.currentTarget.open = false;
              event.currentTarget.querySelector('summary')?.focus();
            }}>
            <summary id={referenceDetailsId}><Info aria-hidden="true" />参考与掌握<ChevronDown aria-hidden="true" /></summary>
            <div className="note-editor-reference-panel" role="region" aria-labelledby={referenceDetailsId}>
              <div className="note-editor-reference-section"><h3>参考索引</h3><NoteReferenceIndexStatus note={note} saveState={saveState} /></div>
              <div className="note-editor-reference-section"><h3>知识点掌握情况</h3><KnowledgeMasteryStatus note={note} /></div>
              <div className="note-editor-reference-section"><h3>参考论证</h3><ReferenceArgumentStatus source={{ kind: 'knowledge-note', entityId: note.id }} note={note}
                disabled={saveState === 'pending' || saveState === 'saving' || saveState === 'error'} disabledBehavior="hold" /></div>
            </div>
          </details>}
          <button type="button" className="note-inspector-reopen" style={{ display: argumentPanelOpen ? 'none' : undefined }}
            aria-expanded={argumentPanelOpen} onClick={() => setArgumentPanelOpen(true)} title="打开笔记信息栏">
            <PanelRightOpen aria-hidden="true" />打开信息栏
          </button>
        </div>
        {aliasesError && <p id={aliasesErrorId} role="alert" className="mt-2 text-xs text-red-700 dark:text-red-300">{aliasesError}</p>}
        {note.noteType === 'project' && !legacyTextbookComplete && isLeafProjectNote(note.id, allNotes) && !hasProgressiveCourse && onContinueProgressive && <div className="learning-preparation">
          <div className="learning-preparation-summary"><strong>从这里开始学习</strong><p>进入心流后逐页生成讲解、题目与知识点，可随时保存继续。</p></div>
          <button type="button" onClick={() => onContinueProgressive(note.id)}>进入心流</button>
        </div>}
        {note.planMeta && !note.parentId && <LearningPreparationPanel key={note.id} rootId={note.id} title={note.title} />}
        {isGeneratingTasks && <div className="note-editor-task-wait" aria-label="学习任务生成进度">
          <span role="status" aria-live="polite"><Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" />正在生成学习任务，正文仍可编辑</span>
          <button type="button" onClick={stopTaskGeneration}>停止生成</button>
        </div>}
        {note.noteType === 'knowledge' && onOpenConceptFill && (content.trim() === '' || content === '请对该知识点进行定义描述') && (
          <button
            type="button"
            onClick={() => onOpenConceptFill(note)}
            className="note-concept-fill-action"
          >
            <Sparkles aria-hidden="true" />
            补全概念（证据检索）
          </button>
        )}
      </div>

      <div className="note-editor-body">
        <div className="note-editor-compose">
          {supportsReading && <div className="note-editor-learning-toolbar">
            <div className="note-textbook-mode-tabs" role="group" aria-label="笔记显示模式">
            <button type="button" aria-pressed={!readTextbook} onClick={() => {
              if (!allowCognitionLeave()) return;
              setContent(latestContentRef.current);
              if (prefersSourceEditor && longEditMode === 'source') setSourceLoadedForId(note.id);
              else { richContentRef.current = latestContentRef.current; setEditorLoadedForId(note.id); }
              setReadTextbook(false);
            }}
              className={!readTextbook ? 'is-active' : ''}>编辑笔记与复盘</button>
            <button type="button" aria-pressed={readTextbook} onClick={() => { if (!allowCognitionLeave()) return; setContent(latestContentRef.current); setReadTextbook(true); }}
              className={readTextbook ? 'is-active' : ''}>{note.textbook || hasProgressiveCourse ? '阅读教材' : '阅读笔记'}</button>
            </div>
            <div ref={setLearningToolbarTarget} className="note-editor-learning-tools" />
          {note.textbook && readTextbook && <button type="button" className="note-textbook-export" disabled={textbookExportBusy} title="导出排版 HTML、Markdown 及已生成的交互图附件" onClick={() => {
            const id = note.id, manifest = note.textbook, body = readTextbookBody(latestContentRef.current, manifest);
            if (body === null) { showToast('教材边界不完整，无法导出'); return; }
            setTextbookExportBusy(true);
            void (async () => {
              try {
                const api = window.electronAPI?.interactiveFigure;
                if (!api?.portable) throw Error('当前环境不支持导出交互图附件');
                const { buildInteractiveFigureShare, downloadInteractiveFigureShare } = await import('../services/textbook/interactiveFigureShare');
                const result = await buildInteractiveFigureShare({ noteId: id, title: note.title, body, manifest }, { read: api.read, portable: api.portable });
                downloadInteractiveFigureShare(result.bytes, result.name);
                if (prevNoteIdRef.current === id) showToast(result.htmlError ? `Markdown 已导出；HTML 未生成：${result.htmlError}` : result.assetError || result.missingImages || result.missingVisuals ? `已导出；${result.assetError || `${result.missingImages} 张原图、${result.missingVisuals} 张图示未能导出`}` : '教材 HTML 和 Markdown 已导出');
              } catch (error) { if (prevNoteIdRef.current === id) showToast(error instanceof Error ? error.message : '教材导出失败'); }
              finally { setTextbookExportBusy(false); }
            })();
          }}>{textbookExportBusy ? '正在导出…' : '导出教材'}</button>}
          </div>}
          {note.noteType === 'project' && !legacyTextbookComplete && isLeafProjectNote(note.id, allNotes) && <ProgressiveSavedNotice key={note.id} noteId={note.id} active={isActive && documentReady}
            onAvailable={onProgressiveAvailable} mode={readTextbook ? 'reading' : 'records'} onContinue={onContinueProgressive} recordsTarget={recordsTarget} toolbarTarget={learningToolbarTarget} />}
          {note.textbook && <div className={readTextbook ? 'flex-1 min-h-0 overflow-hidden' : 'hidden'}><TextbookReader
            key={`${note.id}:${note.textbook.revisionId}`} active={readTextbook && isVisible && documentReady}
            interactive={readTextbook && isActive && documentReady}
            note={{ ...note, content }} allNotes={allNotes} className="flex-1 min-h-0 overflow-y-auto"
            onOpenKnowledge={(id) => { const target = allNotes.find((item) => item.id === id && item.noteType === 'knowledge'); if (target) setPreviewingNote(target); }}
            onOpenDocument={openDocument}
            readingPosition={note.textbookReadingState?.revisionId === note.textbook.revisionId ? note.textbookReadingState : undefined}
            getReadingPosition={getTextbookReadingPosition}
            headingRequest={headingRequest} onHeadingResolved={headingResolved}
            onReadingPosition={(position) => onTextbookReadingPosition?.(note.id, note.textbook!.revisionId, position)}
          /></div>}
          {!note.textbook && !hasProgressiveCourse && supportsReading && <div className={readTextbook ? 'flex-1 min-h-0 overflow-hidden' : 'hidden'}>
            <PlainNoteReading key={note.id} noteId={note.id} title={note.title} content={content} active={readTextbook && isVisible && documentReady} interactive={readTextbook && isActive && documentReady} selectionSurface="note" headingRequest={headingRequest} onHeadingResolved={headingResolved} onWikiLink={handleWikiLink} />
          </div>}
          <div
            className={supportsReading && readTextbook ? 'hidden' : 'w-full flex-1 min-h-0 flex flex-col'}
            data-selection-surface="note"
            data-selection-source-id={note.id}
            data-selection-context-id={note.id}
            data-selection-source-title={note.title}
            data-selection-note-id={note.id}
          >
            {!documentReady && <p role="status" className="p-4 text-sm">正在准备当前笔记，可继续切换项目…</p>}
            {documentReady && prefersSourceEditor && sourceLoadedForId === note.id && <div className={longEditMode === 'source' ? 'flex-1 min-h-0 flex flex-col' : 'hidden'}>
              <Suspense fallback={<div role="status" className="p-4 text-sm">正在打开编辑器…</div>}>
                <LongNoteSourceEditor key={note.id} ref={handle => {
                  sourceEditorRef.current = handle;
                  if (sourceModeRef.current) mdxEditorRef.current = handle;
                }} content={latestContentRef.current} active={isActive && !readTextbook && longEditMode === 'source'}
                  darkMode={settings.theme === 'dark'} toolbarExtra={longEditMode === 'source' && !readTextbook ? <>{toolbarBusinessButtons}
                    <button type="button" className="note-editor-mode-switch" aria-label="切换到富文本编辑" onPointerDown={event => { if (!allowCognitionLeave()) { event.preventDefault(); event.stopPropagation(); } }} onMouseDown={event => event.preventDefault()} onClick={() => {
                      if (!allowCognitionLeave()) return; richContentRef.current = latestContentRef.current; setContent(latestContentRef.current); setEditorLoadedForId(note.id); setLongEditMode('rich');
                    }}>富文本</button></> : undefined}
                  onChange={md => {
                    isLocalTypingRef.current = true;
                    if (localTypingTimeoutRef.current) clearTimeout(localTypingTimeoutRef.current);
                    localTypingTimeoutRef.current = setTimeout(() => { isLocalTypingRef.current = false; }, 1000);
                    handleContentChange(md);
                  }} />
              </Suspense>
            </div>}
            {documentReady && (!supportsReading || editorLoadedForId === note.id) && <div className={prefersSourceEditor && longEditMode === 'source' ? 'hidden' : 'flex-1 min-h-0 flex flex-col'}>
            <Suspense fallback={<div role="status" className="p-4 text-sm">正在打开富文本编辑器…</div>}><MdxNoteEditor
              key={note?.id}
              ref={handle => {
                richEditorRef.current = handle;
                if (!sourceModeRef.current) mdxEditorRef.current = handle;
              }}
              active={isActive && !readTextbook && (!prefersSourceEditor || longEditMode === 'rich')}
              content={prefersSourceEditor && longEditMode === 'source' ? richContentRef.current : content}
              textbookManifest={note.textbook}
              mathRecovery={note.noteType === 'knowledge' ? 'all' : 'knowledge-section'}
              allNotes={allNotes}
              onOpenKnowledge={(id) => {
                const target = allNotes.find((item) => item.id === id && item.noteType === 'knowledge');
                if (target) setPreviewingNote(target);
              }}
              onChange={(md) => {
                isLocalTypingRef.current = true;
                if (localTypingTimeoutRef.current) clearTimeout(localTypingTimeoutRef.current);
                localTypingTimeoutRef.current = setTimeout(() => { isLocalTypingRef.current = false; }, 1000);
                handleContentChange(md);
              }}
              darkMode={settings.theme === "dark"}
              className="h-full"
              toolbarExtra={!prefersSourceEditor || longEditMode === 'rich' ? toolbarBusinessButtons : undefined}
              sourceModeSwitch={prefersSourceEditor ? <button type="button" className="note-editor-mode-switch" aria-label="切换到 Markdown 编辑" onPointerDown={event => { if (!allowCognitionLeave()) { event.preventDefault(); event.stopPropagation(); } }} onMouseDown={event => event.preventDefault()} onClick={() => {
                if (!allowCognitionLeave()) return; setContent(latestContentRef.current); setSourceLoadedForId(note.id); setLongEditMode('source');
              }}>Markdown</button> : undefined}
              onArgumentBlockEdit={onArgumentBlockEdit}
              onArgumentBlockDelete={onArgumentBlockDelete}
              getArgumentDoc={getArgumentDoc}
              getLearningReviewRecord={(id) => note.learningReviewRecords?.find((record) => record.id === id)}
              onLearningReviewPatch={(id, patch) => onLearningReviewPatch
                ? onLearningReviewPatch(note.id, id, patch)
                : onUpdateNote(patchLearningReviewRecord({ ...note, content: latestContentRef.current }, id, patch))}
              onWikiLinkClick={handleWikiLink}
            /></Suspense></div>}
          </div>
        </div>

        {isActive && previewingNote && (
          <KnowledgePreview
            note={previewingNote}
            heading={previewHeading}
            darkMode={settings.theme === "dark"}
            onClose={() => { setPreviewingNote(null); setPreviewHeading(undefined); }}
            resolveWikiNote={(title) => resolveNoteByTitleOrAlias(title, allNotes)}
            wikiLinkIssue={(rawTitle) => {
              const target = parseWikiLinkTarget(rawTitle, allNotesRef.current), resolution = resolveNoteReference(target, allNotesRef.current);
              return resolution.status === 'ambiguous' ? ambiguousNoteReferenceMessage(target, resolution.matches) : undefined;
            }}
            onEdit={(target, heading) => { openExistingNote(target, projectContextId, heading); setPreviewingNote(null); setPreviewHeading(undefined); }}
          />
        )}

        {isActive && showResourcePanel && createPortal(
            <>
              <motion.div
                key="resource-overlay"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: reduceMotion ? 0 : 0.2 }}
                className="fixed inset-0 bg-black/25 dark:bg-black/40 z-[90]"
                onClick={() => setShowResourcePanel(false)}
              />
              <motion.aside
                key="resource-panel"
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={reduceMotion ? { duration: 0 } : { type: "spring", stiffness: 320, damping: 32 }}
                ref={resourceDialogRef} role="dialog" aria-modal="true" aria-labelledby={resourceDialogId} tabIndex={-1}
                className="note-resource-panel"
              >
                <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-800">
                  <h3 id={resourceDialogId} className="text-sm font-bold flex items-center gap-2">
                    <BookOpen className="w-4 h-4" />学习资源
                  </h3>
                  <div className="flex items-center gap-1">
                    <button onClick={() => handleAddLocalResource()} disabled={isChoosingResources} aria-label="添加本地资源" className="note-resource-action" title="添加本地资源">
                      <FolderOpen className="w-4 h-4" />
                    </button>
                    {note.noteType === 'project' && (
                      <button onClick={() => handleResourceRecommendation(true)} disabled={isRecommending || !onRecommendProjectResources} aria-label="重新推荐资源" className="note-resource-action" title="重新推荐">
                        <RefreshCw className={`w-4 h-4 ${isRecommending ? "animate-spin" : ""}`} />
                      </button>
                    )}
                    <button onClick={handleCheckResources} disabled={isCheckingResources || !resources.some(r => r.kind !== 'local' && /^https?:\/\//i.test(r.url))} aria-label="复核在线链接" className="note-resource-action" title="复核在线链接">
                      <Globe className={`w-4 h-4 ${isCheckingResources ? "animate-pulse" : ""}`} />
                    </button>
                    <button onClick={() => setShowResourcePanel(false)} aria-label="关闭学习资源" className="note-resource-action" title="关闭">
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {isRecommending && (
                    <div role="status" className="note-resource-notice">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      <p>正在搜索学习资源…关闭面板仅收起显示，不取消已发起的搜索。</p>
                    </div>
                  )}
                  {!isRecommending && resourceError && (
                    <div role="alert" className="note-resource-notice is-error">
                      {resourceError}
                    </div>
                  )}
                  {!isRecommending && !resourceError && resourceNotice && (
                    <div role="status" className="note-resource-notice">
                      {resourceNotice}
                    </div>
                  )}
                  {!isRecommending && !resourceError && !resourceNotice && resources.length === 0 && (
                    <div className="flex flex-col items-center justify-center py-12 text-slate-400 dark:text-slate-500">
                      <BookOpen className="w-8 h-8 mb-3 opacity-30" />
                      <p className="text-sm">暂无资源，可添加本地资料{note.noteType === 'project' && onRecommendProjectResources ? '或推荐在线资源' : ''}</p>
                    </div>
                  )}
                  {(isCheckingResources || isChoosingResources) && <p role="status" className="note-resource-notice">{isChoosingResources ? '等待文件选择，可取消返回' : '正在复核在线链接…'}</p>}
                  {resources.length > 0 && (
                    <>
                      <p className="note-resource-caption">{resources.length} 条资源 · 在线资源打开新标签页，本地资料打开阅读器或文件</p>
                      {resources.map((r, i) => {
                        const health = r.kind === 'local' ? undefined : resourceState.health[normalizeResourceUrl(r.url)];
                        return (
                        <div key={`${r.url}-${i}`} className="note-resource-card group">
                          <a
                            href={r.documentId ? '#' : r.url}
                            target={r.documentId ? undefined : '_blank'}
                            rel={r.documentId ? undefined : 'noopener noreferrer'}
                            onClick={(event) => {
                              if (!r.documentId) return;
                              event.preventDefault();
                              const version = actionScopeRef.current.version, sourceId = note.id;
                              void openDocument(r.documentId).catch((error) => {
                                if (!isCurrentAction(version, sourceId)) return;
                                const message = error instanceof Error ? error.message : '无法打开本地资料';
                                if (resourcePanelOpenRef.current) setResourceError(message);
                                else showToast(message);
                              });
                            }}
                            className="flex-1 min-w-0 flex items-start gap-3"
                          >
                            <div className="flex-1 min-w-0">
                              <p className="note-resource-title">{r.title}</p>
                              {r.searchCategory && <span className="inline-block mt-1.5 mr-1.5 rounded-full bg-[var(--ln-accent-soft)] px-1.5 py-0.5 text-[10px] text-[var(--ln-accent)]">{RESOURCE_CATEGORY_LABELS[r.searchCategory]} · {r.kind === 'local' ? '已入库' : '在线'}</span>}
                              {r.platform && (
                                <span className={`inline-block mt-1.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                                  /知乎/.test(r.platform) ? "bg-blue-100 text-blue-600 dark:bg-blue-900/40 dark:text-blue-300"
                                  : /Bilibili|哔哩/.test(r.platform) ? "bg-pink-100 text-pink-600 dark:bg-pink-900/40 dark:text-pink-300"
                                  : /Bohrium/.test(r.platform) ? "bg-purple-100 text-purple-600 dark:bg-purple-900/40 dark:text-purple-300"
                                  : /MOOC|学堂|公开课|Coursera|高校/.test(r.platform) ? "bg-emerald-100 text-emerald-600 dark:bg-emerald-900/40 dark:text-emerald-300"
                                  : "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400"
                                }`}>{r.platform}</span>
                              )}
                              {r.kind !== 'local' && (
                                <span className={`inline-block mt-1.5 ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                                  health?.status === 'available' || health?.status === 'redirected'
                                    ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'
                                    : health?.status === 'broken'
                                      ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
                                      : 'bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300'
                                }`} title={health?.error || (health?.checkedAt ? `检查于 ${new Date(health.checkedAt).toLocaleString()}` : '尚未检查')}>
                                  {RESOURCE_HEALTH_LABELS[health?.status || 'unchecked']}
                                </span>
                              )}
                            </div>
                            <ExternalLink className="w-4 h-4 shrink-0 mt-0.5" />
                          </a>
                          <button onClick={() => handleDeleteResource(r)} aria-label={`移除引用：${r.title}`} className="note-resource-action is-remove" title="移除引用（不删除原文件）">
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                        );
                      })}
                    </>
                  )}
                </div>
              </motion.aside>
            </>
          , document.body)}

        <AnimatePresence>
          {isActive && toastMessage && (
            <motion.div
              key={toastMessage}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: reduceMotion ? 0 : 0.2 }}
              className="note-editor-toast"
              role="status"
              aria-live="polite"
            >
              <Zap aria-hidden="true" /><span>{toastMessage}</span>
            </motion.div>
          )}
        </AnimatePresence>

        {/* 划词关联弹窗 */}
        {isActive && showAddLinkModal && (
          <div className="note-link-overlay fixed inset-0 z-[80] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4" onClick={() => setShowAddLinkModal(false)}>
            <div ref={addLinkDialogRef} role="dialog" aria-modal="true" aria-label="划词关联知识点" tabIndex={-1}
              className="note-link-dialog rounded-2xl shadow-2xl border w-full max-w-md p-5 overflow-y-auto" style={{ maxHeight: 'calc(100dvh - 32px)' }} onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold flex items-center gap-1.5">
                  <Link2 className="w-4 h-4 text-[var(--ln-accent)]" aria-hidden="true" />划词关联知识点
                </h3>
                <button type="button" aria-label="关闭关联窗口" onClick={() => setShowAddLinkModal(false)} className="rounded-lg text-[var(--ln-text-secondary)]">✕</button>
              </div>
              {savedSelectionText && (
                <div className="mb-3 px-3 py-2 bg-[var(--ln-accent-soft)] rounded-xl border border-[var(--ln-accent-muted)] text-xs text-[var(--ln-text-secondary)]">
                  已选中: <span className="font-semibold">"{savedSelectionText}"</span>
                </div>
              )}
              <input
                type="text"
                ref={linkSearchRef}
                aria-label="搜索或新建关联笔记"
                value={linkSearchQuery}
                onChange={e => setLinkSearchQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.defaultPrevented || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return;
                  if (e.key === 'Enter' && linkSearchQuery.trim()) { e.preventDefault(); handleCreateAndLinkNewNote(linkSearchQuery.trim()); }
                }}
                placeholder="搜索已有笔记，或输入名称创建新笔记..."
                className="w-full px-3 py-2 text-xs rounded-xl mb-2"
              />
              {linkSearchQuery.trim() && (
                <div className="mb-2">
                  <button type="button" onClick={() => handleCreateAndLinkNewNote(linkSearchQuery.trim())} className="w-full text-left px-3 py-2 rounded-xl border border-[var(--ln-accent-muted)] bg-[var(--ln-accent-soft)] text-xs flex items-center gap-2 text-[var(--ln-accent)] transition">
                    <Plus className="w-3.5 h-3.5" /> {resolveNoteByTitleOrAlias(linkSearchQuery.trim(), allNotes) ? '关联已有笔记' : '新建笔记'}「{linkSearchQuery.trim()}」{resolveNoteByTitleOrAlias(linkSearchQuery.trim(), allNotes) ? '' : '并关联'}
                  </button>
                </div>
              )}
              <div className="max-h-48 overflow-y-auto space-y-1">
                {allNotes
                  .filter(n => matchesTitleOrAlias(n, linkSearchQuery))
                  .slice(0, 12)
                  .map(n => (
                    <button type="button" key={n.id} onClick={() => insertWikiLink(n.title)} className="w-full text-left px-3 py-2 rounded-lg flex items-center justify-between text-xs transition">
                      <span className="truncate font-medium">{n.title}</span>
                      <ArrowUpRight className="w-3 h-3 opacity-60 text-[var(--ln-accent)]" aria-hidden="true" />
                    </button>
                  ))}
                {allNotes.filter(n => matchesTitleOrAlias(n, linkSearchQuery)).length === 0 && linkSearchQuery.trim() && (
                  <p className="text-xs text-slate-400 text-center py-2">无匹配笔记，输入名称创建新笔记</p>
                )}
              </div>
            </div>
          </div>
        )}
      </div>

      {(argumentPanelOpen || inspectorMounted) && (
        <aside ref={inspectorRef} className="note-inspector" aria-label="笔记信息栏" hidden={!argumentPanelOpen}
          role={narrowEditor ? 'dialog' : undefined} aria-modal={narrowEditor || undefined} tabIndex={-1}>
          <div className={`note-inspector-tabs${hasProgressiveCourse ? ' has-records' : ''}`} role="tablist" aria-label="笔记信息视图" onKeyDown={handleInspectorTabKey}>
            <button type="button" role="tab" id={`${inspectorId}-argument`} aria-controls={`${inspectorId}-panel`} tabIndex={activeInspectorTab === 'argument' ? 0 : -1} aria-selected={activeInspectorTab === 'argument'} className={activeInspectorTab === 'argument' ? 'is-active' : ''} onClick={() => { if (allowCognitionLeave()) setInspectorTab('argument'); }}>论证结构</button>
            {hasProgressiveCourse && <button type="button" role="tab" id={`${inspectorId}-records`} aria-controls={`${inspectorId}-panel`} tabIndex={activeInspectorTab === 'records' ? 0 : -1} aria-selected={activeInspectorTab === 'records'} className={activeInspectorTab === 'records' ? 'is-active' : ''} onClick={() => { if (allowCognitionLeave()) setInspectorTab('records'); }}>学习记录</button>}
            <button type="button" role="tab" id={`${inspectorId}-links`} aria-controls={`${inspectorId}-panel`} tabIndex={activeInspectorTab === 'links' ? 0 : -1} aria-selected={activeInspectorTab === 'links'} className={activeInspectorTab === 'links' ? 'is-active' : ''} onClick={() => { if (allowCognitionLeave()) setInspectorTab('links'); }}>关联知识点</button>
            <button type="button" role="tab" id={`${inspectorId}-info`} aria-controls={`${inspectorId}-panel`} tabIndex={activeInspectorTab === 'info' ? 0 : -1} aria-selected={activeInspectorTab === 'info'} className={activeInspectorTab === 'info' ? 'is-active' : ''} onClick={() => { if (allowCognitionLeave()) setInspectorTab('info'); }}>笔记信息</button>
            <button type="button" className="note-inspector-close" onClick={() => { if (allowCognitionLeave()) setArgumentPanelOpen(false); }} title="收起信息栏" aria-label="收起信息栏"><PanelRightClose /></button>
          </div>

          <div className="note-inspector-scroll" role="tabpanel" id={`${inspectorId}-panel`} aria-labelledby={`${inspectorId}-${activeInspectorTab}`} tabIndex={0}>
            {hasProgressiveCourse && <div ref={setRecordsTarget} className="note-inspector-records" hidden={activeInspectorTab !== 'records'} />}
            {activeInspectorTab === 'argument' && (
              <>
                <section className="note-inspector-card">
                  <div className="note-inspector-card-head">
                    <h2>论证结构 <CircleHelp aria-hidden="true" /></h2>
                    {selectedArgumentDoc && (
                      <button type="button" onClick={() => onArgumentBlockEdit?.(selectedArgumentDoc.doc_id)} disabled={!onArgumentBlockEdit}>查看详情 <ArrowUpRight /></button>
                    )}
                    {selectedArgumentDoc?.rag?.publishedSnapshot && (
                      <button type="button" onClick={() => onArgumentRagWithdraw?.(selectedArgumentDoc.doc_id)} disabled={!onArgumentRagWithdraw}>撤回 RAG</button>
                    )}
                  </div>

                  {argumentDocs.length > 1 && selectedArgumentDoc && (
                    <label className="note-argument-selector">
                      <span>复盘记录</span>
                      <select value={selectedArgumentDoc.doc_id} onChange={(event) => setSelectedArgumentDocId(event.target.value)}>
                        {argumentDocs.map((doc, index) => (
                          <option key={doc.doc_id} value={doc.doc_id}>{doc.title || `复盘结构 ${argumentDocs.length - index}`} · {formatArgumentDate(doc.updated_at || doc.created_at)}</option>
                        ))}
                      </select>
                    </label>
                  )}

                  {selectedArgumentDoc ? (
                    <div className="note-argument-panel-content">
                      <div className="note-argument-meta" aria-label="结构图信息">
                        <span><Clock3 aria-hidden="true" />{formatArgumentDate(selectedArgumentDoc.updated_at || selectedArgumentDoc.created_at)}</span>
                        <span>{selectedArgumentDoc.nodes.length} 节点</span>
                        <span>{selectedArgumentDoc.edges.length} 关系</span>
                        <span>{selectedArgumentDoc.rag?.publishedSnapshot
                          ? `已发布 · ${selectedArgumentDoc.rag.publishedSnapshot.assessment.admission === 'full' ? '完整准入' : '受限准入'}`
                          : selectedAssessment?.admission === 'review_required' ? '仅草稿 · 待修正' : '仅草稿'}</span>
                      </div>
                      <div className="note-argument-canvas"><ArgumentDocEmbed doc={selectedArgumentDoc} /></div>
                      {(selectedArgumentDoc.scores || selectedAssessment) && (
                        <div className="note-argument-score-grid">
                          {selectedArgumentDoc.scores && (
                            <>
                              <div><span>概念</span><strong>{selectedArgumentDoc.scores.conceptScore}</strong></div>
                              <div><span>判断</span><strong>{selectedArgumentDoc.scores.judgmentScore}</strong></div>
                              <div><span>逻辑</span><strong>{selectedArgumentDoc.scores.logicScore}</strong></div>
                            </>
                          )}
                          {selectedAssessment && <div className="is-assessment"><span>结构</span><strong>{selectedAssessment.score}</strong></div>}
                        </div>
                      )}
                      {selectedArgumentDoc.summary && <div className="note-argument-summary"><span>结构摘要</span><p>{selectedArgumentDoc.summary}</p></div>}
                      <p className="note-argument-footnote">再次提交只重新评价结构，不改写本次口语复盘的表达评分与总结。</p>
                    </div>
                  ) : (
                    <div className="note-argument-empty is-card-empty">
                      <div><GitBranch aria-hidden="true" /></div>
                      <h3>{hasProgressiveCourse ? '在学习记录中查看结构图' : '复盘后生成结构图'}</h3>
                      <p>{hasProgressiveCourse ? '复盘分析完成后，在右侧“学习记录”中查看对应结构图。' : '开启分析并退出心流学习后，每次复盘会独立保存并在此选择。'}</p>
                      {hasProgressiveCourse && <button type="button" onClick={() => { if (allowCognitionLeave()) setInspectorTab('records'); }}>查看学习记录</button>}
                    </div>
                  )}
                </section>

                <section className="note-inspector-card">
                  <div className="note-inspector-card-head"><h2>直接关联知识点</h2><button type="button" onClick={() => setInspectorTab('links')}>查看根项目 <ArrowUpRight /></button></div>
                  <div className="note-related-list">
                    {directKnowledgeNotes.map((relatedNote) => (
                      <button type="button" key={relatedNote.id} onClick={() => openExistingNote(relatedNote, knowledgeProjectContextId)}>
                        <span><FileText /></span>
                        <div><strong>{relatedNote.title}</strong><small>笔记 · {relatedNote.links.length} 个关联</small></div>
                        <ArrowUpRight />
                      </button>
                    ))}
                    {directKnowledgeNotes.length === 0 && <p className="note-inspector-empty-line">当前笔记中明确关联的知识点会显示在这里。</p>}
                  </div>
                </section>
              </>
            )}

            {activeInspectorTab === 'links' && (
              <section className="note-inspector-card is-fill">
                <div className="note-inspector-card-head"><h2>{rootProject ? `${rootProject.title} · 关联知识点` : '关联知识点'}</h2><span>{rootKnowledgeNotes.length} 项</span></div>
                <div className="note-related-list" tabIndex={0} role="region" aria-label="根项目关联知识点列表">
                  {rootKnowledgeNotes.map((relatedNote) => (
                    <button type="button" key={relatedNote.id} onClick={() => openExistingNote(relatedNote, knowledgeProjectContextId)}>
                      <span><FileText /></span><div><strong>{relatedNote.title}</strong><small>{relatedNote.tags.slice(0, 2).join(' · ') || '知识笔记'}</small></div><ArrowUpRight />
                    </button>
                  ))}
                  {rootKnowledgeNotes.length === 0 && <p className="note-inspector-empty-line">{rootProject ? '当前根项目及其子项目暂无关联知识点。' : '请从项目笔记进入，以查看根项目的全部关联知识点。'}</p>}
                </div>
              </section>
            )}

            {activeInspectorTab === 'info' && (
              <section className="note-inspector-card is-fill">
                <div className="note-inspector-card-head"><h2>笔记信息</h2><Info aria-hidden="true" /></div>
                <dl className="note-info-list">
                  <div><dt>类型</dt><dd>{note.noteType === 'project' ? '项目笔记' : '知识笔记'}</dd></div>
                  <div><dt>创建时间</dt><dd>{new Date(note.createdAt).toLocaleString('zh-CN')}</dd></div>
                  <div><dt>更新时间</dt><dd>{new Date(note.updatedAt).toLocaleString('zh-CN')}</dd></div>
                  <div><dt>标签</dt><dd>{note.tags.join('、') || '无'}</dd></div>
                  <div><dt>别名</dt><dd>{note.aliases?.join('、') || '无'}</dd></div>
                  <div><dt>直接关联知识点</dt><dd>{directKnowledgeNotes.length}</dd></div>
                  <div><dt>根项目知识点</dt><dd>{rootKnowledgeNotes.length}</dd></div>
                  <div><dt>学习资源</dt><dd>{resources.length}</dd></div>
                  <div><dt>复盘结构</dt><dd>{argumentDocs.length}</dd></div>
                </dl>
              </section>
            )}
          </div>
        </aside>
      )}

      {(logicResult || logicError || logicScopeNotice || isAnalyzing) && (
        <section className="note-logic-panel" aria-labelledby="note-logic-heading" aria-busy={isAnalyzing}>
          <div className="note-logic-head">
            <h3 id="note-logic-heading">
              <AlertTriangle aria-hidden="true" />逻辑检查
            </h3>
            <button type="button" onClick={closeLogicalAnalysis} aria-label={isAnalyzing ? '停止并关闭逻辑分析' : '关闭逻辑分析'} className="note-logic-close">{isAnalyzing ? '停止分析' : '关闭'}</button>
          </div>
          {logicScopeNotice && <p className="note-logic-progress" role="status">{logicScopeNotice}</p>}
          {isAnalyzing && (
            <div className="note-logic-progress" role="status" aria-live="polite">
              <Loader2 className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> AI 正在分析文本逻辑性…
            </div>
          )}
          {logicError && (
            <div className="note-logic-error" role="alert">
              {logicError}
            </div>
          )}
          {logicResult && (
            <div className="note-logic-results">
              {logicResult.summary && (
                <section className="note-logic-card is-summary">
                  <h4>整体分析</h4>
                  <p>{logicResult.summary}</p>
                </section>
              )}
              {logicResult.logicGaps && logicResult.logicGaps.length > 0 && (
                <section className="note-logic-card is-warning">
                  <h4>逻辑漏洞 <span>{logicResult.logicGaps.length}</span></h4>
                  <div className="note-logic-list">
                    {logicResult.logicGaps.map((g, i) => (
                      <div key={i} className="note-logic-list-item">
                        <div className="note-logic-list-line">
                          <span className={`note-logic-severity ${g.severity === 'critical' ? 'is-critical' : g.severity === 'major' ? 'is-major' : 'is-minor'}`}>{g.severity === 'critical' ? '严重' : g.severity === 'major' ? '重要' : '次要'}</span>
                          <span>{g.description}</span>
                        </div>
                        {g.suggestion && <p className="note-logic-detail">{g.suggestion}</p>}
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {logicResult.originalStatement && (
                <section className="note-logic-card is-source">
                  <h4>原文</h4>
                  <p>{logicResult.originalStatement}</p>
                </section>
              )}
              {logicResult.logicalFallacies && logicResult.logicalFallacies.length > 0 && (
                <section className="note-logic-card is-danger">
                  <h4>逻辑谬误 <span>{logicResult.logicalFallacies.length}</span></h4>
                  <div className="note-logic-list">
                    {logicResult.logicalFallacies.map((f, i) => (
                      <div key={i} className="note-logic-list-item">
                        <strong>{f.type}</strong>
                        {f.explanation && <p>{f.explanation}</p>}
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {logicResult.missingFactors && logicResult.missingFactors.length > 0 && (
                <section className="note-logic-card is-missing">
                  <h4>缺失因素</h4>
                  <ul>
                    {logicResult.missingFactors.map((f, i) => <li key={i}>{f}</li>)}
                  </ul>
                </section>
              )}
              {logicResult.supplementaryKnowledge && logicResult.supplementaryKnowledge.length > 0 && (
                <section className="note-logic-card is-support">
                  <h4>补充知识</h4>
                  <ul>
                    {logicResult.supplementaryKnowledge.map((k, i) => <li key={i}>{k}</li>)}
                  </ul>
                </section>
              )}
              {logicResult.suggestedCorrection && (
                <section className="note-logic-card is-support">
                  <h4>修正建议</h4>
                  <p>{logicResult.suggestedCorrection}</p>
                </section>
              )}
              {logicResult.narrativeErrors && logicResult.narrativeErrors.length > 0 && (
                <section className="note-logic-card is-warning">
                  <h4>叙述错误 <span>{logicResult.narrativeErrors.length}</span></h4>
                  <div className="note-logic-list">
                    {logicResult.narrativeErrors.map((e, i) => (
                      <div key={i} className="note-logic-list-item">
                        <strong>{e.error}</strong>
                        {e.fix && <p className="note-logic-detail">{e.fix}</p>}
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {logicResult.relatedKnowledge && logicResult.relatedKnowledge.length > 0 && (
                <section className="note-logic-card is-related">
                  <h4>关联知识 <span>{logicResult.relatedKnowledge.length}</span></h4>
                  <div className="note-logic-list">
                    {logicResult.relatedKnowledge.map((k, i) => (
                      <div key={i} className="note-logic-list-item">
                        <strong>{k.term}</strong> — {k.relation}
                        {k.suggestedWikiLink && <span className="note-logic-link"> → [[{k.suggestedWikiLink}]]</span>}
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          )}
        </section>
      )}

      {/* 「更多」扩展功能下拉菜单（Portal 到 body，避免被工具栏 overflow 裁剪） */}
      {isActive && moreOpen && moreMenuPos &&
        createPortal(
          <div
            ref={moreMenuRef}
            role="menu" aria-label="笔记更多功能"
            className="note-editor-more-menu fixed z-[100] min-w-[180px] rounded-lg border shadow-xl py-1 overflow-y-auto"
            style={{ top: Math.max(8, Math.min(moreMenuPos.top, window.innerHeight - 280)), right: Math.min(moreMenuPos.right, Math.max(8, window.innerWidth - 188)), maxWidth: 'calc(100vw - 16px)', maxHeight: 'calc(100dvh - 16px)', background: 'var(--ln-bg-elevated)', color: 'var(--ln-text-primary)', borderColor: 'var(--ln-border)' }}
            onKeyDown={handleMoreMenuKey}
            onBlur={(e) => {
              if (e.relatedTarget instanceof Node && (e.currentTarget.contains(e.relatedTarget) || moreBtnRef.current?.contains(e.relatedTarget))) return;
              setMoreOpen(false); setMoreMenuPos(null);
            }}
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
          >
            {communityWebsiteUrl()&&window.electronAPI?.community&&<button type="button" role="menuitem" className="note-editor-more-item" onClick={()=>{closeMoreMenu();onUpdateNote({...note,content:latestContentRef.current});window.dispatchEvent(new CustomEvent('loginote:community-share',{detail:{noteId:note.id}}));}}><span>分享到社区</span></button>}
            <button
              type="button"
              role="menuitem"
              onClick={() => { closeMoreMenu(); handleAutoLinkScan(false); }}
              className="note-editor-more-item"
            >
              <Zap className="note-editor-more-icon" aria-hidden="true" />
              <span>自动关联</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { closeMoreMenu(); handleOpenAddLinkModal(); }}
              className="note-editor-more-item"
            >
              <Link2 className="note-editor-more-icon" aria-hidden="true" />
              <span>关联</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => { closeMoreMenu(); handleLogicalAnalysis(); }}
              disabled={isAnalyzing}
              className="note-editor-more-item"
            >
              {isAnalyzing ? <Loader2 className="note-editor-more-icon animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <AlertTriangle className="note-editor-more-icon is-warning" aria-hidden="true" />}
              <span>{isAnalyzing ? '分析中…' : '逻辑检查'}</span>
            </button>
            {note.noteType === 'project' && legacyTextbookComplete && isLeafProjectNote(note.id, allNotes) && (
              <button
                type="button"
                role="menuitem"
                onClick={() => { closeMoreMenu(); handleGenerateStudyTasks(); }}
                disabled={isGeneratingTasks}
                className="note-editor-more-item"
              >
                {isGeneratingTasks ? <Loader2 className="note-editor-more-icon animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <ListChecks className="note-editor-more-icon" aria-hidden="true" />}
                <span>{isGeneratingTasks ? '生成中…' : '生成学习任务'}</span>
              </button>
            )}
            {(note.noteType === 'project' || resources.length > 0) && (
              <button
                type="button"
                role="menuitem"
                onClick={() => { closeMoreMenu(); handleResourceRecommendation(); }}
                className="note-editor-more-item"
              >
                {isRecommending ? <Loader2 className="note-editor-more-icon animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Globe className="note-editor-more-icon" aria-hidden="true" />}
                <span>{isRecommending
                  ? '查看资源搜索进度'
                  : resources.length > 0
                    ? '查看学习资源'
                    : settings.resourceCollectionMode === 'auto' ? '自动推荐资源' : '筛选学习资源'}</span>
              </button>
            )}
            <button
              type="button"
              role="menuitem"
              onClick={() => { closeMoreMenu(); handleAddLocalResource(); }}
              disabled={isChoosingResources}
              className="note-editor-more-item"
            >
              <FolderOpen className="note-editor-more-icon" aria-hidden="true" />
              <span>{isChoosingResources ? '等待文件选择…' : '添加本地资源'}</span>
            </button>
          </div>,
          document.body
        )}
    </div>
  );
};
